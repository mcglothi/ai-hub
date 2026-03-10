<p align="center">
  <img src="assets/ai-hub-logo.svg" alt="AI Hub" width="860" />
</p>

<p align="center">
  <strong>AI Hub</strong><br/>
  A unified, self-hosted workspace for AI chat, terminal workflows, and persistent session orchestration.
</p>

## Overview

AI Hub now spans three related surfaces inside one repo:

- `apps/chat-wrapper`: Legacy stable chat-centric surface currently serving the original AI Hub app on Turing.
- `apps/operator-console`: Memory-first operator workspace for review, search, provenance, terminal access, and code adjacency. This is the next-gen track.
- `apps/sessions`: Session lifecycle API and UI for persistent, resumable AI workflows.

This repository is now the source of truth for application code. AIKB remains the source of truth for operational documentation and runbooks.

## Core Capabilities

- Multi-provider chat routing for Claude, Gemini, and Codex.
- Voice input pipeline with transcription proxy support.
- Optional AIKB context augmentation for chat requests.
- Memory-native operator review and apply workflows.
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
│   ├── operator-console/
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
  -> AI Hub Operator Console (:3001)
    -> Memory Core search + proposal APIs
    -> ttyd terminal proxy
    -> code-server adjacency
    -> AIKB apply-preview/apply flows

Browser
  -> AI Hub Sessions (:8090)
    -> FastAPI + tmux-backed session orchestration
```

## Deployment Status

- `ai-hub-sessions` is currently running on `turing` from this repository path.
- `chat-wrapper` remains the legacy stable app on `:3000`.
- `operator-console` is the active next-gen UI track on `:3001`.
- Historical sessions snapshots were captured on both `turing` and `feynman` before migration.

## Development Workflow

1. Create a feature branch immediately from `main`.
2. Keep `main` deployable at all times.
3. Make changes under the single canonical app directory that owns the feature.
4. Validate locally or in staging before merging.
5. Merge small, focused feature branches back to `main`.
6. Deploy via Ansible/systemd rollout from the repo-backed source tree.

## Repo Model

- `apps/chat-wrapper` is legacy/stable until explicitly retired.
- `apps/operator-console` is the canonical next-gen workspace and should receive new operator-surface features.
- `ansible` should deploy code from the canonical app name and avoid scratch duplicates.
- Scratch variants like `.new`, `.v2`, `.v3`, and ad hoc verification files should be replaced by branches, not accumulated in tracked paths.

## Branch Model

- `main`: deployable, trusted, production-ready
- `feat/*`: one feature or focused cleanup
- `release/*`: optional stabilization branch for bigger cutovers

Examples:
- `feat/operator-console-review-flow`
- `feat/operator-console-search-ranking`
- `release/operator-console-cutover`

## Roadmap

- Add first-class deployment playbooks for both apps from this repo.
- Add CI checks for JavaScript and Python lint/syntax validation.
- Add versioned releases and rollback notes.
- Add operational dashboards and health probes for both services.

## License

Private internal project. Add explicit license terms if distribution scope changes.
