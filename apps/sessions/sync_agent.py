#!/usr/bin/env python3
"""AI Hub Sessions sync agent (push local logs to turing)."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import urllib.request


def post_json(url: str, payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        resp.read()


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync local session logs to turing.")
    parser.add_argument("--server", required=True, help="Base URL, e.g. https://sessions.home.timmcg.net")
    parser.add_argument("--device", required=True, help="Device name (feynman/tesla)")
    parser.add_argument("--logs", default=str(Path.home() / ".local/share/ai-hub-sessions/logs"))
    parser.add_argument("--sync-key", default=os.environ.get("AIHUB_SYNC_KEY", ""))
    args = parser.parse_args()

    logs_dir = Path(args.logs)
    if not logs_dir.exists():
        print(f"No logs directory: {logs_dir}")
        return

    for path in logs_dir.glob("*.jsonl"):
        content = path.read_text(encoding="utf-8", errors="ignore")
        payload = {
            "device": args.device,
            "filename": path.name,
            "content": content,
            "sync_key": args.sync_key,
        }
        post_json(f"{args.server.rstrip('/')}/api/sync", payload)
        print(f"Synced {path.name}")


if __name__ == "__main__":
    main()
