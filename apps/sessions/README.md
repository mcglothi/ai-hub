---
tags: [ai-hub, turing, sessions, fastapi, tmux, xterm]
last_updated: 2026-03-04
---

# AI Hub Sessions (Host-Level)
**Last Updated:** 2026-03-04
**Summary:** Host-level ChatGPT-style session manager for Claude/Gemini/Codex on turing. Uses tmux as source of truth and FastAPI + xterm.js for the UI.

## Goals
- Unified sessions across providers
- Shared history across devices (central store on turing)
- Terminal-in-web UI
- Search, tags, pinned sessions

## Layout
- `app/` — FastAPI server + session registry
- `ui/` — Web UI (xterm.js + sessions panel)
- `data/` — local dev data (logs + SQLite)

## Run (local dev)
```bash
cd _tools/ai-hub-sessions
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python3 -m app.main
```

Open:
- `http://localhost:8090`

## Turing Deployment (host-level)
- Place data at `/opt/containers/ai-hub/sessions/`
- Run with: `AIHUB_DATA_DIR=/opt/containers/ai-hub/sessions` and `AIHUB_HOST=0.0.0.0`
- Put behind NPM + Authentik (ai.home)

## Environment
- `AIHUB_DATA_DIR` (default: `_tools/ai-hub-sessions/data`)
- `AIHUB_HOST` (default: `127.0.0.1`)
- `AIHUB_PORT` (default: `8090`)
- `AIHUB_PROVIDER_CMD_CLAUDE`
- `AIHUB_PROVIDER_CMD_GEMINI`
- `AIHUB_PROVIDER_CMD_CODEX`
- `AIHUB_DEFAULT_WORKDIR` (default: `/home/mcglothi/Code`)
- `AIHUB_SYNC_KEY` (optional shared secret for sync agent)

## Notes
- tmux sessions are the single source of truth.
- Requires `tmux` on host.
- Logs stored as JSONL per session.
- Avoid syncing logs to Git unless encrypted.
- Input/output chunks are captured (truncated to 2000 chars per event).

## Sync Agent (Feynman/Tesla → Turing)
```bash
python3 _tools/ai-hub-sessions/sync_agent.py \\
  --server https://sessions.home.timmcg.net \\
  --device feynman \\
  --logs ~/.local/share/ai-hub-sessions/logs
```

- Set `AIHUB_SYNC_KEY` if the server requires it.
- Sync endpoint writes files to `data/sync/<device>/`.
- Suggested schedule:
  - macOS: LaunchAgent (every 15 min)
  - Linux: cron (every 10 min)
