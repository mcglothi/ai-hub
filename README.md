# AI Hub

Unified project for AI Hub surfaces and services.

## Apps

- `apps/chat-wrapper` — web UI + backend proxy for chat/terminal/code (Claude/Gemini/Codex, voice input, AIKB context toggle).
- `apps/sessions` — AI Hub Sessions service (FastAPI + tmux) currently running on port `8090` on turing.

## Current Deployment Notes

- `chat-wrapper` is currently deployed from Ansible templates.
- `sessions` currently runs from `AIKB/_tools/ai-hub-sessions` on hosts and is being migrated here.

## Next Steps

1. Move turing systemd units to run from this repo path.
2. Add deployment automation for both apps.
3. Keep AIKB for docs/runbooks; keep app code in this repo.
