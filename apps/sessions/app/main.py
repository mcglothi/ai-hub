#!/usr/bin/env python3
"""AI Hub Sessions v2.0 — FastAPI server (Unified Mobile IDE backend)."""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, AliasChoices
from pydantic_settings import BaseSettings

from .api_v2 import router as v2_router
from .tmux_manager import launch_session, terminate_session, ensure_workspace_tmux_session

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

app = FastAPI(title="AI Hub Sessions v2.0")
app.include_router(v2_router)
app.mount("/static", StaticFiles(directory=UI_DIR), name="static")

def _conn() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def _log_event(session_id: str, payload: dict[str, Any]) -> None:
    log_path = LOG_DIR / f"{session_id}.jsonl"
    payload["ts"] = int(time.time())
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload) + "\n")

@app.on_event("startup")
async def startup() -> None:
    pass

@app.get("/")
def index() -> HTMLResponse:
    return FileResponse(UI_DIR / "index.html")

@app.websocket("/ws/terminal/{session_id}")
async def terminal_ws(ws: WebSocket, session_id: str) -> None:
    print(f'WebSocket connection attempt for session: {session_id}')
    await ws.accept()

    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
    if not row:
        await ws.close()
        return

    workspace_id = row["workspace_id"]
    tmux_socket = row["tmux_socket"]
    tmux_window = row["tmux_window"]
    provider = row["provider"]
    working_dir = row["working_dir"]

    # Ensure tmux session and window exist
    prov_row = _conn().execute("SELECT * FROM provider_configs WHERE provider = ?", (provider,)).fetchone()
    if not prov_row:
        await ws.close()
        return
    
    provider_config = dict(prov_row)
    provider_config['launch_cmd'] = json.loads(provider_config['launch_cmd'])
    provider_config['env'] = json.loads(provider_config['env'])

    # Re-launch if window is missing (idempotent)
    launch_session(workspace_id, tmux_socket, session_id, working_dir, provider_config)

    pid, fd = os.forkpty()
    if pid == 0:
        os.environ.setdefault("TERM", "xterm-256color")
        os.environ.setdefault("COLORTERM", "truecolor")
        # Use workspace socket
        os.execv("/usr/bin/tmux", ["tmux", "-S", tmux_socket, "attach", "-t", f"{workspace_id}:{session_id}"])

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
                        ["tmux", "-S", tmux_socket, "resize-window", "-t", f"{workspace_id}:{session_id}", "-x", str(cols), "-y", str(rows)],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                except Exception:
                    pass
                continue
            os.write(fd, data.encode())
            _log_event(session_id, {"event": "input", "data": data[:2000]})
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
        lines.append(f"## {ts} \u2014 {event}")
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

@app.get("/api/health")
def health():
    return {"status": "ok", "version": "2.0"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=settings.aihub_host, port=settings.aihub_port)
