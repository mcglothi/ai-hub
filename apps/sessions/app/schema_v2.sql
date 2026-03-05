CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    root_dir TEXT NOT NULL,
    tmux_socket TEXT NOT NULL,
    default_provider TEXT NOT NULL,
    allowed_providers TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_configs (
    provider TEXT PRIMARY KEY,
    launch_cmd TEXT NOT NULL,
    env TEXT NOT NULL,
    requires_oauth INTEGER NOT NULL,
    credential_path TEXT NOT NULL,
    enabled INTEGER NOT NULL
);

-- Add new columns to existing sessions table
ALTER TABLE sessions ADD COLUMN workspace_id TEXT;
ALTER TABLE sessions ADD COLUMN tmux_socket TEXT;
ALTER TABLE sessions ADD COLUMN tmux_session TEXT;
ALTER TABLE sessions ADD COLUMN tmux_window TEXT;
ALTER TABLE sessions ADD COLUMN tmux_pane TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, last_active);
CREATE INDEX IF NOT EXISTS idx_sessions_provider_status ON sessions(provider, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_ws_session ON sessions(workspace_id, session_id);
