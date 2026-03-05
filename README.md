<p align="center">
  <img src="assets/ai-hub-logo.svg" alt="AI Hub" width="860" />
</p>

<p align="center">
  <strong>AI Hub</strong><br/>
  A unified, self-hosted workspace for AI chat, terminal workflows, and persistent session orchestration.
</p>

## Overview

AI Hub combines two operational surfaces into one project:

- `apps/chat-wrapper`: Browser-based chat and workspace hub for Claude, Gemini, and Codex, with terminal and code surfaces.
- `apps/sessions`: Session lifecycle API and UI for persistent, resumable AI workflows.

This repository is now the source of truth for application code. AIKB remains the source of truth for operational documentation and runbooks.

## Core Capabilities

- Multi-provider chat routing for Claude, Gemini, and Codex.
- Voice input pipeline with transcription proxy support.
- Optional AIKB context augmentation for chat requests.
- Embedded terminal and code workspace access patterns.
- Session inventory and state management service on `:8090`.
- Service-friendly structure for systemd and Ansible automation.

## Repository Layout

```text
ai-hub/
├── apps/
│   ├── chat-wrapper/
│   │   ├── public/
│   │   ├── package.json
│   │   └── server.js
│   └── sessions/
│       ├── app/
│       ├── ui/
│       ├── requirements.txt
│       └── sync_agent.py
├── assets/
│   └── ai-hub-logo.svg
└── infra/
    └── systemd/
```

## Runtime Model

```text
Browser
  -> AI Hub Chat Wrapper (:3000)
    -> Claude / Gemini / Codex CLIs
    -> Local STT proxy (:8008)
    -> AIKB context lookup (optional)

Browser
  -> AI Hub Sessions (:8090)
    -> FastAPI + tmux-backed session orchestration
```

## Deployment Status

- `ai-hub-sessions` is currently running on `turing` from this repository path.
- `chat-wrapper` remains active and is in migration toward direct repo-backed deployment.
- Historical sessions snapshots were captured on both `turing` and `feynman` before migration.

## Development Workflow

1. Create a feature branch.
2. Make changes under `apps/chat-wrapper` or `apps/sessions`.
3. Validate locally or in staging.
4. Open a PR and merge to `main`.
5. Deploy via Ansible/systemd rollout.

## Roadmap

- Add first-class deployment playbooks for both apps from this repo.
- Add CI checks for JavaScript and Python lint/syntax validation.
- Add versioned releases and rollback notes.
- Add operational dashboards and health probes for both services.

## License

Private internal project. Add explicit license terms if distribution scope changes.
