#!/usr/bin/env python3
"""AI session log sync agent (push local logs to AIKB Memory Core)."""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import random
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path


DEFAULT_GLOBS = [
    "~/.codex/history.jsonl",
    "~/.codex/sessions/**/*.jsonl",
    "~/.claude/projects/**/*.jsonl",
    "~/.gemini/**/*.jsonl",
    "~/.local/share/ai-hub-sessions/logs/*.jsonl",
]


class PermanentSyncError(Exception):
    """Raised when a batch cannot succeed without operator intervention."""


def log(level: str, message: str, **fields: object) -> None:
    record = {
        "ts": int(time.time()),
        "level": level,
        "message": message,
    }
    record.update(fields)
    print(json.dumps(record, sort_keys=True))


def post_json(url: str, payload: dict, api_key: str) -> dict:
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "X-API-Key": api_key}
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = resp.read().decode("utf-8", errors="ignore")
    if not body:
        return {}
    try:
        return json.loads(body)
    except Exception:
        return {}


def send_with_retry(
    *,
    endpoint: str,
    payload: dict,
    api_key: str,
    max_retries: int,
    backoff_base: float,
) -> dict:
    for attempt in range(1, max_retries + 1):
        try:
            return post_json(endpoint, payload, api_key)
        except urllib.error.HTTPError as exc:
            status = getattr(exc, "code", 0)
            if 400 <= status < 500 and status != 429:
                raise PermanentSyncError(f"HTTP {status}") from exc
            delay = backoff_base * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
            log(
                "warn",
                "Transient HTTP error; retrying",
                status=status,
                attempt=attempt,
                max_retries=max_retries,
                delay_s=round(delay, 2),
            )
            if attempt == max_retries:
                raise
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError) as exc:
            delay = backoff_base * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
            log(
                "warn",
                "Network error; retrying",
                error=str(exc),
                attempt=attempt,
                max_retries=max_retries,
                delay_s=round(delay, 2),
            )
            if attempt == max_retries:
                raise
            time.sleep(delay)
    return {}


def _normalize_state(data: object) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    if not isinstance(data, dict):
        return out
    for k, v in data.items():
        if not isinstance(k, str):
            continue
        if isinstance(v, int) and v >= 0:
            out[k] = {"offset": v, "inode": 0}
            continue
        if isinstance(v, dict):
            offset = v.get("offset")
            inode = v.get("inode", 0)
            if isinstance(offset, int) and offset >= 0 and isinstance(inode, int) and inode >= 0:
                out[k] = {"offset": offset, "inode": inode}
    return out


def load_state(path: Path) -> dict[str, dict[str, int]]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return _normalize_state(data)


def save_state(path: Path, state: dict[str, dict[str, int]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    os.chmod(temp_path, 0o600)
    os.replace(temp_path, path)


def append_dlq(path: Path, events: list[dict], reason: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for event in events:
            f.write(
                json.dumps(
                    {
                        "failed_at": int(time.time()),
                        "reason": reason,
                        "event": event,
                    },
                    sort_keys=True,
                )
            )
            f.write("\n")
    os.chmod(path, 0o600)


def _count_dlq_entries(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def write_metrics_file(
    *,
    path: Path,
    now_ts: int,
    files_touched: int,
    files_failed: int,
    events_sent: int,
    dlq_entries: int,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# HELP ai_memory_sync_last_run_ts Unix timestamp of latest sync run",
        "# TYPE ai_memory_sync_last_run_ts gauge",
        f"ai_memory_sync_last_run_ts {now_ts}",
        "# HELP ai_memory_sync_files_touched Number of files ingested in last run",
        "# TYPE ai_memory_sync_files_touched gauge",
        f"ai_memory_sync_files_touched {files_touched}",
        "# HELP ai_memory_sync_files_failed Number of files failed in last run",
        "# TYPE ai_memory_sync_files_failed gauge",
        f"ai_memory_sync_files_failed {files_failed}",
        "# HELP ai_memory_sync_events_sent Number of events sent in last run",
        "# TYPE ai_memory_sync_events_sent gauge",
        f"ai_memory_sync_events_sent {events_sent}",
        "# HELP ai_memory_sync_dlq_entries Current DLQ line count",
        "# TYPE ai_memory_sync_dlq_entries gauge",
        f"ai_memory_sync_dlq_entries {dlq_entries}",
    ]
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def resolve_api_key(arg_api_key: str) -> str:
    if arg_api_key:
        return arg_api_key
    env_key = os.environ.get("MMC_API_KEY", "")
    if env_key:
        return env_key
    bw_session_path = Path.home() / ".bw_session"
    if not bw_session_path.exists():
        return ""
    try:
        bw_session = bw_session_path.read_text(encoding="utf-8").strip()
        if not bw_session:
            return ""
        item_name = os.environ.get("MMC_API_KEY_ITEM", "PAT/AIKB Memory Core/API Key")
        result = subprocess.run(
            ["bw", "get", "password", item_name, "--session", bw_session],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return ""
        return result.stdout.strip()
    except Exception:
        return ""


def discover_files(globs_in: list[str], logs_dir: str | None) -> list[Path]:
    patterns = list(globs_in)
    if logs_dir:
        patterns.append(str(Path(logs_dir).expanduser() / "*.jsonl"))
    if not patterns:
        patterns = list(DEFAULT_GLOBS)

    files: dict[str, Path] = {}
    for pattern in patterns:
        expanded = os.path.expanduser(pattern)
        for match in glob.glob(expanded, recursive=True):
            p = Path(match)
            if p.is_file() and p.suffix == ".jsonl":
                files[str(p.resolve())] = p.resolve()
    return [files[k] for k in sorted(files)]


def infer_provider(path: Path) -> str:
    p = str(path)
    if "/.codex/" in p:
        return "codex"
    if "/.claude/" in p:
        return "claude"
    if "/.gemini/" in p:
        return "gemini"
    return path.name.split("__", 1)[0] if "__" in path.name else "unknown"


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync local AI session logs to AIKB Memory Core.")
    parser.add_argument(
        "--server",
        default=os.environ.get("MEMORY_SYNC_SERVER", "https://memory.home.timmcg.net"),
        help="Base URL, e.g. https://memory.home.timmcg.net",
    )
    parser.add_argument("--device", default=socket.gethostname(), help="Device name (feynman/tesla/turing)")
    parser.add_argument("--source", default="ai-memory-sync", help="Source label for ingested events")
    parser.add_argument(
        "--glob",
        action="append",
        default=[],
        help="File glob to include (repeatable). If omitted, built-in globs are used.",
    )
    parser.add_argument("--logs", default="", help="Legacy logs directory (adds '<dir>/*.jsonl')")
    parser.add_argument("--state-file", default=str(Path.home() / ".local/share/ai-hub-sessions/memory-sync-state.json"))
    parser.add_argument("--dlq-file", default=str(Path.home() / ".local/share/ai-hub-sessions/failed-events.jsonl"))
    parser.add_argument("--api-key", default="")
    parser.add_argument("--max-retries", type=int, default=5)
    parser.add_argument("--backoff-base", type=float, default=1.0)
    parser.add_argument(
        "--metrics-file",
        default=os.environ.get(
            "MMC_SYNC_METRICS_FILE",
            str(Path.home() / ".local/share/ai-hub-sessions/metrics.prom"),
        ),
    )
    parser.add_argument("--from-now", action="store_true", help="Initialize offsets to EOF and exit if state file doesn't exist")
    args = parser.parse_args()

    files = discover_files(args.glob, args.logs or None)
    dlq_path = Path(args.dlq_file).expanduser()
    metrics_path = Path(args.metrics_file).expanduser()
    if not files:
        log("info", "No matching log files; nothing to sync")
        write_metrics_file(
            path=metrics_path,
            now_ts=int(time.time()),
            files_touched=0,
            files_failed=0,
            events_sent=0,
            dlq_entries=_count_dlq_entries(dlq_path),
        )
        return

    state_path = Path(args.state_file).expanduser()
    state = load_state(state_path)

    if args.from_now and not state_path.exists():
        for p in files:
            try:
                stat = p.stat()
            except OSError:
                continue
            state[str(p.resolve())] = {"offset": stat.st_size, "inode": int(getattr(stat, "st_ino", 0))}
        save_state(state_path, state)
        log("info", "Initialized state from current EOF", files=len(state), state_file=str(state_path))
        write_metrics_file(
            path=metrics_path,
            now_ts=int(time.time()),
            files_touched=0,
            files_failed=0,
            events_sent=0,
            dlq_entries=_count_dlq_entries(dlq_path),
        )
        return

    api_key = resolve_api_key(args.api_key)
    if not api_key:
        log("error", "No API key found", hint="--api-key or MMC_API_KEY or ~/.bw_session + Vault item")
        write_metrics_file(
            path=metrics_path,
            now_ts=int(time.time()),
            files_touched=0,
            files_failed=1,
            events_sent=0,
            dlq_entries=_count_dlq_entries(dlq_path),
        )
        return

    endpoint = f"{args.server.rstrip('/')}/api/v1/events"
    total_sent = 0
    files_touched = 0
    files_failed = 0

    for path in files:
        abs_path = str(path.resolve())
        try:
            stat = path.stat()
        except OSError:
            continue

        file_size = stat.st_size
        inode = int(getattr(stat, "st_ino", 0))
        entry = state.get(abs_path, {"offset": 0, "inode": inode})
        offset = int(entry.get("offset", 0))
        previous_inode = int(entry.get("inode", 0))

        if previous_inode and inode and previous_inode != inode:
            log("warn", "Log rotation detected; resetting offset", file=path.name, previous_inode=previous_inode, inode=inode)
            offset = 0

        if offset > file_size:
            log("warn", "File truncation detected; resetting offset", file=path.name, offset=offset, file_size=file_size)
            offset = 0

        if offset == file_size:
            state[abs_path] = {"offset": file_size, "inode": inode}
            continue

        try:
            with path.open("rb") as f:
                f.seek(offset)
                raw = f.read()
        except OSError:
            continue

        if not raw:
            state[abs_path] = {"offset": file_size, "inode": inode}
            continue

        text = raw.decode("utf-8", errors="ignore")
        lines = [ln for ln in text.splitlines() if ln.strip()]
        events: list[dict] = []
        provider = infer_provider(path)
        for idx, line in enumerate(lines):
            try:
                parsed = json.loads(line)
            except Exception:
                parsed = None

            if isinstance(parsed, dict):
                event_type = str(parsed.get("event") or parsed.get("type") or "session_log_line")
                content = str(parsed.get("data") or parsed.get("content") or parsed.get("message") or line)[:4000]
                ts = parsed.get("ts") or parsed.get("timestamp")
                ts_val = int(ts) if isinstance(ts, int) else None
            else:
                event_type = "session_log_line"
                content = line[:4000]
                ts_val = None

            event_key = f"{args.device}|{abs_path}|{offset}|{idx}|{content}"
            event_id = hashlib.sha256(event_key.encode("utf-8")).hexdigest()[:32]
            events.append(
                {
                    "event_id": event_id,
                    "ts": ts_val,
                    "source": args.source,
                    "event_type": event_type,
                    "content": content,
                    "metadata": {
                        "device": args.device,
                        "file_path": abs_path,
                        "filename": path.name,
                        "provider": provider,
                        "byte_offset": offset,
                        "line_index": idx,
                    },
                    "redact": True,
                }
            )

        if not events:
            state[abs_path] = {"offset": file_size, "inode": inode}
            continue

        try:
            result = send_with_retry(
                endpoint=endpoint,
                payload={"events": events},
                api_key=api_key,
                max_retries=max(1, args.max_retries),
                backoff_base=max(0.1, args.backoff_base),
            )
            state[abs_path] = {"offset": file_size, "inode": inode}
            total_sent += len(events)
            files_touched += 1
            log(
                "info",
                "Ingested session events",
                file=path.name,
                provider=provider,
                events=len(events),
                inserted=result.get("inserted"),
                duplicates=result.get("duplicates"),
            )
        except PermanentSyncError as exc:
            files_failed += 1
            append_dlq(dlq_path, events, f"permanent_error:{exc}")
            state[abs_path] = {"offset": file_size, "inode": inode}
            log("error", "Permanent ingest failure; moved to DLQ", file=path.name, events=len(events), dlq=str(dlq_path), reason=str(exc))
        except Exception as exc:
            files_failed += 1
            append_dlq(dlq_path, events, f"transient_exhausted:{exc}")
            state[abs_path] = {"offset": file_size, "inode": inode}
            log("error", "Retries exhausted; moved to DLQ", file=path.name, events=len(events), dlq=str(dlq_path), reason=str(exc))

    save_state(state_path, state)
    log("info", "Sync complete", files_touched=files_touched, files_failed=files_failed, events_sent=total_sent, state_file=str(state_path))
    write_metrics_file(
        path=metrics_path,
        now_ts=int(time.time()),
        files_touched=files_touched,
        files_failed=files_failed,
        events_sent=total_sent,
        dlq_entries=_count_dlq_entries(dlq_path),
    )


if __name__ == "__main__":
    main()
