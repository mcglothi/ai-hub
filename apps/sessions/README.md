---
tags: [ai-hub, turing, sessions, fastapi, tmux, xterm]
last_updated: 2026-03-05
---

# AI Hub Sessions (Host-Level)
**Last Updated:** 2026-03-05
**Summary:** Host-level ChatGPT-style session manager for Claude/Gemini/Codex on turing. Uses tmux as source of truth and FastAPI + xterm.js for the UI.

## Goals
- Unified sessions across providers
- Shared history across devices
- Terminal-in-web UI
- Search, tags, pinned sessions

## Layout
- `app/` — FastAPI server + session registry
- `ui/` — Web UI (xterm.js + sessions panel)
- `data/` — local dev data (logs + SQLite)

## Run (local dev)
```bash
cd apps/sessions
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
- Put behind NPM + Authentik (`sessions.home` and `/sessions/` on `ai.home`)

## Environment
- `AIHUB_DATA_DIR` (default: `apps/sessions/data`)
- `AIHUB_HOST` (default: `127.0.0.1`)
- `AIHUB_PORT` (default: `8090`)
- `AIHUB_PROVIDER_CMD_CLAUDE`
- `AIHUB_PROVIDER_CMD_GEMINI`
- `AIHUB_PROVIDER_CMD_CODEX`
- `AIHUB_DEFAULT_WORKDIR` (default: `/home/mcglothi/Code`)
- `AIHUB_SYNC_KEY` (optional legacy key for `/api/sync` endpoint)

## Notes
- tmux sessions are the single source of truth.
- Requires `tmux` on host.
- Logs stored as JSONL per session.
- Input/output chunks are captured (truncated to 2000 chars per event).

## Sync Agent (hub/feynman/tesla -> AIKB Memory Core)
Use the sync agent to ingest local AI logs into `https://memory.home.timmcg.net/api/v1/events`.

```bash
python3 apps/sessions/sync_agent.py --device "$(hostname)" --from-now
python3 apps/sessions/sync_agent.py --device "$(hostname)"
```

API key resolution order:
1. `--api-key <token>`
2. `MMC_API_KEY` environment variable
3. Vaultwarden via `~/.bw_session` + item `PAT/AIKB Memory Core/API Key`

Behavior:
- Default discovery globs: `~/.codex/history.jsonl`, `~/.codex/sessions/**/*.jsonl`, `~/.claude/projects/**/*.jsonl`, `~/.gemini/**/*.jsonl`, `~/.local/share/ai-hub-sessions/logs/*.jsonl`
- Incremental ingest with byte-offset state file: `~/.local/share/ai-hub-sessions/memory-sync-state.json`
- Handles truncation/rotation using offset + inode tracking
- Retries with exponential backoff on transient failures
- Stores hard failures in DLQ: `~/.local/share/ai-hub-sessions/failed-events.jsonl`

Suggested schedule:
- Linux (`cron`): every 10 minutes
- macOS (`LaunchAgent`): every 15 minutes

### Linux systemd user timer (recommended)
```bash
bash infra/systemd/install-ai-memory-sync.sh
```

- Installs `ai-memory-sync.service` + `ai-memory-sync.timer` under `~/.config/systemd/user/`
- Creates `~/.config/ai-memory-sync.env` (0600) from example if missing
- Service runs `sync_agent.py` every 10 minutes

### macOS LaunchAgent (recommended)
```bash
bash infra/launchd/install-ai-memory-sync-macos.sh
```

- Installs `~/.local/bin/ai-memory-sync.sh`
- Installs `~/Library/LaunchAgents/com.timmcg.ai-memory-sync.plist`
- Uses `~/.config/ai-memory-sync.env` for `MMC_API_KEY`
