# AI Hub Repo Model

## Purpose

This repo should separate stable runtime surfaces from active iteration without creating ambiguity about what is canonical, what is experimental, and what is deployed.

## Canonical App Layout

- `apps/chat-wrapper/`
  Legacy stable app. Keep this running only as long as the old surface still matters.
- `apps/operator-console/`
  Canonical next-gen operator workspace. New review, memory, provenance, and control-surface work belongs here.
- `apps/sessions/`
  Session lifecycle and shared orchestration service.

## Git Workflow

- `main` must stay deployable.
- Start every non-trivial change on a feature branch.
- Prefer one feature branch per concern:
  - `feat/operator-console-review-flow`
  - `feat/operator-console-search-ranking`
  - `feat/sessions-sync-hygiene`
- Merge small, cohesive changes instead of stacking many unrelated edits in one dirty tree.

## Deployment Model

- `ai-hub` is the source of truth for app code.
- `ansible` deploys named apps from canonical source paths.
- Runtime names should match repo names:
  - app dir: `apps/operator-console`
  - deploy playbook: `deploy_operator_console.yml`
  - service: `operator-console.service`
  - host path: `/opt/operator-console`

## Anti-Patterns To Avoid

- Editing the same app in both `ai-hub` and copied `ansible/files/...` paths as if both are canonical.
- Leaving scratch variants like `server.js.new`, `server.js.v2`, `server.js.v3` in active tracked locations.
- Doing large feature work directly on `main` in a dirty tree.
- Naming a mature app after an early implementation detail like “wrapper”.

## Scratch Workspace Rule

- If a local experiment is worth keeping temporarily but is not canonical source, move it under `.scratch/` instead of leaving it beside runtime files.
- Treat `.scratch/` as intentionally ignored local workspace, not shared project history.
- If an experiment turns into a real feature, promote it by applying the change to the canonical file on a feature branch instead of renaming the scratch file into place.

## Recommended Cleanup Direction

- Retire scratch variants by turning surviving ideas into branches or deleting them.
- Keep the legacy `chat-wrapper` alive only until the operator console fully replaces it.
- When cutover is complete, retire the legacy app cleanly rather than keeping two half-canonical surfaces forever.
