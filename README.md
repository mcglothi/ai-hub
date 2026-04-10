<p align="center">
  <img src="assets/ai-hub-logo.svg" alt="AI Hub" width="860" />
</p>

<p align="center">
  <strong>AI Hub</strong><br/>
  A self-hosted operator workspace for local LLM routing, memory operations, model stewardship, and persistent agent sessions.
</p>

## Why AI Hub Exists

AI Hub is the control surface for a broader local AI ecosystem:

- `AI Hub` handles operator workflows, model inventory, import/pull flows, terminal/code adjacency, and session orchestration.
- `AIKB` is the durable memory and runbook system behind the scenes.
- `LapTime` provides model fit, hardware, and performance context for practical deployment choices.

Together they form a home-lab-native stack for running local models and agent workflows with real operational context instead of isolated demos.

## Product Surfaces

### Explore Memory

Search memory, inspect graph relationships, review provenance, and keep nearby evidence visible while navigating AIKB-backed results.

![Explore Memory](assets/screenshots/memory-explorer.png)

### Review Proposals

Harvest runtime memory proposals, review queue recommendations, and apply durable knowledge into AIKB with a cleaner operator workflow.

![Review Proposals](assets/screenshots/review-harvest.png)

### Model Stewardship

Manage the model fleet on real hardware, inspect Hugging Face repos, choose GGUF quants, stage cleanup safely, and pull models directly into the selected platform.

![Model Stewardship](assets/screenshots/models-stewardship.png)

## Core Capabilities

- Memory-first operator console with graph exploration, provenance, and review/apply flows
- Hugging Face search, repo inspection, quant-aware import prep, and Ollama pull workflows
- Per-platform model inventory with notes, stages, cleanup cues, and loaded-state visibility
- Embedded terminal and code adjacency for fast operational edits
- Session inventory and tmux-backed orchestration through the sessions service
- Multi-provider chat support and voice/transcription plumbing retained in the repo

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
│   ├── ai-hub-logo.svg
│   └── screenshots/
└── infra/
    └── systemd/
```

## Architecture Snapshot

```text
Browser
  -> AI Hub Operator Console (:3001)
    -> Memory Core search + proposal APIs
    -> AIKB preview/apply flows
    -> Hugging Face search + model fit estimation
    -> Ollama platform inventory / pull / cleanup workflows
    -> ttyd terminal proxy
    -> code-server adjacency

Browser
  -> AI Hub Sessions (:8090)
    -> FastAPI + tmux-backed session orchestration

Browser
  -> Legacy Chat Wrapper (:3000, fallback only)
    -> Claude / Gemini / Codex CLIs
    -> Local STT proxy (:8008)
    -> optional AIKB context lookup
```

## Deployment Status

- `apps/operator-console` is the primary AI Hub surface and active operator entrypoint.
- `apps/sessions` is the repo-backed session service for persistent workflows.
- `apps/chat-wrapper` remains in-tree as a fallback path, not the main product surface.
- Operational deployment details live in AIKB and the companion Ansible repo.

## Development Model

1. Branch from `main` for each focused feature or cleanup pass.
2. Keep `main` deployable.
3. Add new product-facing work to `apps/operator-console` first unless the feature is explicitly session-specific.
4. Prefer real screenshots, concrete runbooks, and small deployable commits over scratch variants.
5. Treat AIKB as the documentation and operating-memory source of truth.

## Near-Term Direction

- Bring platform/device configuration into a first-class settings surface
- Continue improving model grouping, visual hierarchy, and operator ergonomics
- Add stronger CI checks for JavaScript and Python services
- Capture more product documentation and architecture notes directly in this repo

## License

Private internal project. Add explicit license terms if the distribution scope changes.
