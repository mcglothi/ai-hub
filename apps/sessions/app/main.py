#!/usr/bin/env python3
"""AI Hub Sessions — FastAPI server (host-level)."""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, AliasChoices
from pydantic_settings import BaseSettings

APP_ROOT = Path(__file__).resolve().parents[1]
UI_DIR = APP_ROOT / "ui"


class Settings(BaseSettings):
    aihub_data_dir: Path = Field(
        default=APP_ROOT / "data",
        validation_alias=AliasChoices("AIHUB_DATA_DIR", "AIHUB_AIHUB_DATA_DIR"),
    )
    aihub_host: str = Field(
        default="127.0.0.1",
        validation_alias=AliasChoices("AIHUB_HOST", "AIHUB_AIHUB_HOST"),
    )
    aihub_port: int = Field(
        default=8090,
        validation_alias=AliasChoices("AIHUB_PORT", "AIHUB_AIHUB_PORT"),
    )
    aihub_provider_cmd_claude: str = Field(
        default="claude",
        validation_alias=AliasChoices(
            "AIHUB_PROVIDER_CMD_CLAUDE", "AIHUB_AIHUB_PROVIDER_CMD_CLAUDE"
        ),
    )
    aihub_provider_cmd_gemini: str = Field(
        default="gemini",
        validation_alias=AliasChoices(
            "AIHUB_PROVIDER_CMD_GEMINI", "AIHUB_AIHUB_PROVIDER_CMD_GEMINI"
        ),
    )
    aihub_provider_cmd_codex: str = Field(
        default="codex",
        validation_alias=AliasChoices(
            "AIHUB_PROVIDER_CMD_CODEX", "AIHUB_AIHUB_PROVIDER_CMD_CODEX"
        ),
    )
    aihub_default_workdir: Path = Field(
        default=Path("/home/mcglothi/Code"),
        validation_alias=AliasChoices(
            "AIHUB_DEFAULT_WORKDIR", "AIHUB_AIHUB_DEFAULT_WORKDIR"
        ),
    )
    aihub_sync_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("AIHUB_SYNC_KEY", "AIHUB_AIHUB_SYNC_KEY"),
    )

    class Config:
        env_prefix = ""
        case_sensitive = False


settings = Settings()
DATA_DIR = Path(settings.aihub_data_dir)
DB_PATH = DATA_DIR / "sessions.db"
LOG_DIR = DATA_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="AI Hub Sessions")
app.mount("/static", StaticFiles(directory=UI_DIR), name="static")


@dataclass
class SessionRecord:
    session_id: str
    provider: str
    title: str
    tags: str
    pinned: int
    status: str
    created_at: int
    last_active: int


class SessionCreate(BaseModel):
    provider: str
    title: str | None = None
    tags: list[str] = []
    working_dir: str | None = None


class SessionUpdate(BaseModel):
    title: str | None = None
    tags: list[str] | None = None
    pinned: bool | None = None
    status: str | None = None
    working_dir: str | None = None


class SessionResponse(BaseModel):
    session_id: str
    provider: str
    title: str
    tags: list[str]
    pinned: bool
    status: str
    created_at: int
    last_active: int
    working_dir: str | None = None


PROVIDERS = {
    "claude": settings.aihub_provider_cmd_claude,
    "gemini": settings.aihub_provider_cmd_gemini,
    "codex": settings.aihub_provider_cmd_codex,
}


def _conn() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db() -> None:
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                title TEXT NOT NULL,
                tags TEXT NOT NULL,
                pinned INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_active INTEGER NOT NULL,
                working_dir TEXT
            )
            """
        )
        # Backfill column if upgrading from earlier schema
        cols = [row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()]
        if "working_dir" not in cols:
            conn.execute("ALTER TABLE sessions ADD COLUMN working_dir TEXT")
        conn.commit()


def _row_to_session(row: sqlite3.Row) -> SessionResponse:
    return SessionResponse(
        session_id=row["session_id"],
        provider=row["provider"],
        title=row["title"],
        tags=[t for t in row["tags"].split(",") if t],
        pinned=bool(row["pinned"]),
        status=row["status"],
        created_at=row["created_at"],
        last_active=row["last_active"],
        working_dir=row["working_dir"],
    )


def _ensure_tmux_session(session_id: str, provider: str, working_dir: str | None) -> None:
    cmd = PROVIDERS.get(provider)
    if not cmd:
        raise ValueError(f"Unknown provider: {provider}")

    check = subprocess.run(
        ["tmux", "has-session", "-t", session_id],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if check.returncode == 0:
        return

    workdir = working_dir or str(settings.aihub_default_workdir)
    base = [
        "tmux",
        "new-session",
        "-d",
        "-s",
        session_id,
        "-c",
        workdir,
        "-e",
        "TERM=xterm-256color",
        "-e",
        "COLORTERM=truecolor",
        "-e",
        "SHELL=/bin/zsh",
    ]
    if provider == "codex":
        launch = base + [cmd, "exec", "--skip-git-repo-check"]
    else:
        launch = base + [cmd]

    subprocess.check_call(launch)


def _log_event(session_id: str, payload: dict[str, Any]) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"{session_id}.jsonl"
    payload["ts"] = int(time.time())
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload) + "\n")


def _maybe_autotitle(session_id: str, input_text: str) -> None:
    cleaned = " ".join(input_text.strip().split())
    if not cleaned:
        return
    candidate = cleaned[:60]
    with _conn() as conn:
        row = conn.execute(
            "SELECT title, created_at FROM sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if not row:
            return
        created_at = int(row["created_at"])
        default_title = time.strftime("%Y-%m-%d %H:%M", time.localtime(created_at))
        if row["title"] != default_title:
            return
        conn.execute(
            "UPDATE sessions SET title = ?, last_active = ? WHERE session_id = ?",
            (candidate, int(time.time()), session_id),
        )
        conn.commit()


def _maybe_autosummary(session_id: str) -> None:
    log_path = LOG_DIR / f"{session_id}.jsonl"
    if not log_path.exists():
        return
    with log_path.open("r", encoding="utf-8") as f:
        events = [json.loads(line) for line in f if line.strip()]
    # Heuristic: first 5 input events become summary
    inputs = [e.get("data", "") for e in events if e.get("event") == "input"]
    if len(inputs) < 3:
        return
    summary = " / ".join(s.strip() for s in inputs[:3] if s.strip())
    if not summary:
        return
    with _conn() as conn:
        row = conn.execute(
            "SELECT title, created_at FROM sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if not row:
            return
        created_at = int(row["created_at"])
        default_title = time.strftime("%Y-%m-%d %H:%M", time.localtime(created_at))
        if row["title"] != default_title:
            return
        conn.execute(
            "UPDATE sessions SET title = ?, last_active = ? WHERE session_id = ?",
            (summary[:60], int(time.time()), session_id),
        )
        conn.commit()


@app.on_event("startup")
async def startup() -> None:
    _init_db()


@app.get("/")
def index() -> HTMLResponse:
    return FileResponse(UI_DIR / "index.html")


@app.get("/api/sessions", response_model=list[SessionResponse])
def list_sessions() -> list[SessionResponse]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM sessions ORDER BY pinned DESC, last_active DESC"
        ).fetchall()
    return [_row_to_session(r) for r in rows]


@app.post("/api/sessions", response_model=SessionResponse)
def create_session(body: SessionCreate) -> SessionResponse:
    if body.provider not in PROVIDERS:
        raise ValueError("Invalid provider")

    session_id = uuid.uuid4().hex[:10]
    now = int(time.time())
    default_title = time.strftime("%Y-%m-%d %H:%M", time.localtime(now))
    title = (body.title or "").strip() or default_title
    working_dir = body.working_dir or str(settings.aihub_default_workdir)
    tags = ",".join(body.tags)
    with _conn() as conn:
        conn.execute(
            """
            INSERT INTO sessions (session_id, provider, title, tags, pinned, status, created_at, last_active, working_dir)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (session_id, body.provider, title, tags, 0, "active", now, now, working_dir),
        )
        conn.commit()

    _ensure_tmux_session(session_id, body.provider, working_dir)
    _log_event(session_id, {"event": "session_created", "provider": body.provider})

    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
    return _row_to_session(row)


@app.patch("/api/sessions/{session_id}", response_model=SessionResponse)
def update_session(session_id: str, body: SessionUpdate) -> SessionResponse:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        if not row:
            raise ValueError("Session not found")

        title = body.title or row["title"]
        tags = ",".join(body.tags) if body.tags is not None else row["tags"]
        pinned = int(body.pinned) if body.pinned is not None else row["pinned"]
        status = body.status or row["status"]
        working_dir = body.working_dir or row["working_dir"]
        last_active = int(time.time())

        conn.execute(
            """
            UPDATE sessions
            SET title = ?, tags = ?, pinned = ?, status = ?, last_active = ?, working_dir = ?
            WHERE session_id = ?
            """,
            (title, tags, pinned, status, last_active, working_dir, session_id),
        )
        conn.commit()

        updated = conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()

    _log_event(session_id, {"event": "session_updated"})
    return _row_to_session(updated)


@app.delete("/api/sessions/{session_id}")
def archive_session(session_id: str) -> dict[str, str]:
    with _conn() as conn:
        conn.execute(
            "UPDATE sessions SET status = 'archived' WHERE session_id = ?",
            (session_id,),
        )
        conn.commit()

    _log_event(session_id, {"event": "session_archived"})
    return {"status": "ok"}


@app.delete("/api/sessions/{session_id}/hard")
def delete_session(session_id: str) -> dict[str, str]:
    # Kill tmux session if exists
    subprocess.run(
        ["tmux", "kill-session", "-t", session_id],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    # Remove db row
    with _conn() as conn:
        conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
        conn.commit()
    # Remove logs
    log_path = LOG_DIR / f"{session_id}.jsonl"
    if log_path.exists():
        log_path.unlink()
    _log_event(session_id, {"event": "session_deleted"})
    return {"status": "ok"}


@app.post("/api/sessions/{session_id}/terminate")
def terminate_session(session_id: str) -> dict[str, str]:
    subprocess.run(
        ["tmux", "kill-session", "-t", session_id],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    _log_event(session_id, {"event": "session_terminated"})
    return {"status": "ok"}


@app.websocket("/ws/terminal/{session_id}")
async def terminal_ws(ws: WebSocket, session_id: str) -> None:
    await ws.accept()

    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
    if not row:
        await ws.close()
        return

    provider = row["provider"]
    _ensure_tmux_session(session_id, provider, row["working_dir"])

    pid, fd = os.forkpty()
    if pid == 0:
        os.environ.setdefault("TERM", "xterm-256color")
        os.environ.setdefault("COLORTERM", "truecolor")
        os.execvp("tmux", ["tmux", "attach", "-t", session_id])

    async def read_pty() -> None:
        try:
            while True:
                data = await asyncio.to_thread(os.read, fd, 4096)
                if not data:
                    break
                text = data.decode(errors="ignore")
                await ws.send_text(text)
                _log_event(
                    session_id,
                    {"event": "output", "data": text[:2000]},
                )
        except Exception:
            pass

    reader = asyncio.create_task(read_pty())

    try:
        while True:
            data = await ws.receive_text()
            if not data:
                continue
            if data.startswith("{") and "\"type\":\"resize\"" in data:
                try:
                    payload = json.loads(data)
                    cols = int(payload.get("cols", 120))
                    rows = int(payload.get("rows", 40))
                    subprocess.run(
                        ["tmux", "resize-window", "-t", session_id, "-x", str(cols), "-y", str(rows)],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                except Exception:
                    pass
                continue
            os.write(fd, data.encode())
            _log_event(session_id, {"event": "input", "data": data[:2000]})
            _maybe_autotitle(session_id, data)
            if data.strip().endswith("\n"):
                _maybe_autosummary(session_id)
    except WebSocketDisconnect:
        pass
    finally:
        reader.cancel()
        try:
            os.close(fd)
        except OSError:
            pass


@app.get("/api/history/{session_id}")
def get_history(session_id: str, q: str | None = None) -> dict[str, Any]:
    log_path = LOG_DIR / f"{session_id}.jsonl"
    if not log_path.exists():
        return {"events": []}
    with log_path.open("r", encoding="utf-8") as f:
        events = [json.loads(line) for line in f if line.strip()]
    if q:
        q_lower = q.lower()
        events = [e for e in events if q_lower in str(e.get("data", "")).lower()]
    return {"events": events[-200:]}


@app.get("/api/export/{session_id}")
def export_session(session_id: str) -> PlainTextResponse:
    log_path = LOG_DIR / f"{session_id}.jsonl"
    if not log_path.exists():
        return PlainTextResponse("No history found.", status_code=404)
    with log_path.open("r", encoding="utf-8") as f:
        events = [json.loads(line) for line in f if line.strip()]
    lines = [f"# Session {session_id}", ""]
    for e in events:
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(e.get("ts", 0)))
        event = e.get("event", "event")
        data = e.get("data", "")
        lines.append(f"## {ts} — {event}")
        if data:
            lines.append(data)
        lines.append("")
    return PlainTextResponse("\n".join(lines))


@app.post("/api/sync")
def sync_logs(payload: dict[str, Any]) -> dict[str, str]:
    if settings.aihub_sync_key:
        if payload.get("sync_key") != settings.aihub_sync_key:
            return {"status": "unauthorized"}

    device = payload.get("device") or "unknown"
    filename = payload.get("filename") or "session.jsonl"
    content = payload.get("content") or ""
    if not content:
        return {"status": "empty"}

    device_dir = DATA_DIR / "sync" / device
    device_dir.mkdir(parents=True, exist_ok=True)
    out_path = device_dir / filename
    out_path.write_text(content, encoding="utf-8")
    return {"status": "ok"}


@app.get("/api/git-status")
def git_status(dir: str) -> dict[str, str]:
    base = Path("/home/mcglothi/Code").resolve()
    target = Path(dir).expanduser().resolve()
    if base not in target.parents and target != base:
        return {"status": "error", "output": "Path not allowed"}
    try:
        output = subprocess.check_output(
            ["git", "-C", str(target), "status", "-sb"],
            stderr=subprocess.STDOUT,
            text=True,
        )
        return {"status": "ok", "output": output.strip()}
    except subprocess.CalledProcessError as exc:
        return {"status": "error", "output": exc.output.strip()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.aihub_host, port=settings.aihub_port)
