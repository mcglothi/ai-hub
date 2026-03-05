import json
import sqlite3
import time
import uuid
import os
from typing import List
from fastapi import APIRouter, HTTPException, Depends
from .models import WorkspaceCreate, WorkspaceUpdate, WorkspaceResponse, ProviderConfigCreate, ProviderConfigUpdate, ProviderConfigResponse

router = APIRouter(prefix="/api")

def get_db():
    conn = sqlite3.connect('/opt/containers/ai-hub/sessions/sessions.db')
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

# --- Workspaces ---

@router.post("/workspaces", response_model=WorkspaceResponse)
def create_workspace(ws: WorkspaceCreate, db: sqlite3.Connection = Depends(get_db)):
    ws_id = f"ws_{uuid.uuid4().hex[:10]}"
    now = int(time.time())
    
    # Ensure slug uniqueness
    existing = db.execute("SELECT slug FROM workspaces WHERE slug = ?", (ws.slug,)).fetchone()
    if existing:
        raise HTTPException(status_code=400, detail="Slug already exists")
        
    uid = os.getuid()
    tmux_socket = f"/run/user/{uid}/turing/{ws_id}.sock"
    os.makedirs(os.path.dirname(tmux_socket), exist_ok=True)
    
    allowed_providers = ",".join(ws.allowed_providers)
    
    db.execute(
        """
        INSERT INTO workspaces (workspace_id, slug, name, root_dir, tmux_socket, default_provider, allowed_providers, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        """,
        (ws_id, ws.slug, ws.name, ws.root_dir, tmux_socket, ws.default_provider, allowed_providers, now, now)
    )
    db.commit()
    
    row = db.execute("SELECT * FROM workspaces WHERE workspace_id = ?", (ws_id,)).fetchone()
    return dict(row)

@router.get("/workspaces", response_model=List[WorkspaceResponse])
def list_workspaces(db: sqlite3.Connection = Depends(get_db)):
    rows = db.execute("SELECT * FROM workspaces WHERE status != 'deleted' ORDER BY updated_at DESC").fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d['allowed_providers'] = d['allowed_providers'].split(',')
        result.append(d)
    return result

# --- Provider Configs ---

@router.post("/providers", response_model=ProviderConfigResponse)
def create_provider(p: ProviderConfigCreate, db: sqlite3.Connection = Depends(get_db)):
    existing = db.execute("SELECT provider FROM provider_configs WHERE provider = ?", (p.provider,)).fetchone()
    if existing:
        raise HTTPException(status_code=400, detail="Provider already exists")
        
    db.execute(
        """
        INSERT INTO provider_configs (provider, launch_cmd, env, requires_oauth, credential_path, enabled)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (p.provider, json.dumps(p.launch_cmd), json.dumps(p.env), int(p.requires_oauth), p.credential_path, int(p.enabled))
    )
    db.commit()
    return p.dict()

@router.get("/providers", response_model=List[ProviderConfigResponse])
def list_providers(db: sqlite3.Connection = Depends(get_db)):
    rows = db.execute("SELECT * FROM provider_configs").fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d['launch_cmd'] = json.loads(d['launch_cmd'])
        d['env'] = json.loads(d['env'])
        d['requires_oauth'] = bool(d['requires_oauth'])
        d['enabled'] = bool(d['enabled'])
        result.append(d)
    return result

# --- Sessions (v2 overrides) ---
@router.get("/sessions/v2")
def list_sessions_v2(workspace_id: str, db: sqlite3.Connection = Depends(get_db)):
    rows = db.execute("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY last_active DESC", (workspace_id,)).fetchall()
    return [dict(r) for r in rows]

from pydantic import BaseModel as Base
class SessionCreateV2(Base):
    workspace_id: str
    provider: str
    title: str = None
    tags: list[str] = []

import subprocess
from .tmux_manager import launch_session

@router.post("/sessions/v2")
def create_session_v2(s: SessionCreateV2, db: sqlite3.Connection = Depends(get_db)):
    ws = db.execute("SELECT * FROM workspaces WHERE workspace_id = ?", (s.workspace_id,)).fetchone()
    if not ws: raise HTTPException(404, "Workspace not found")
    
    prov = db.execute("SELECT * FROM provider_configs WHERE provider = ?", (s.provider,)).fetchone()
    if not prov: raise HTTPException(404, "Provider config not found")
    
    sess_id = f"s_{uuid.uuid4().hex[:10]}"
    now = int(time.time())
    title = s.title or f"{s.provider} session"
    
    db.execute(
        """
        INSERT INTO sessions (
            session_id, workspace_id, provider, title, tags, pinned, status, 
            created_at, last_active, working_dir, tmux_socket, tmux_session, tmux_window
        ) VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?, ?, ?)
        """,
        (sess_id, ws['workspace_id'], s.provider, title, ",".join(s.tags), now, now, ws['root_dir'], ws['tmux_socket'], ws['workspace_id'], sess_id)
    )
    db.commit()
    
    provider_dict = dict(prov)
    provider_dict['launch_cmd'] = json.loads(provider_dict['launch_cmd'])
    provider_dict['env'] = json.loads(provider_dict['env'])
    
    launch_session(ws['workspace_id'], ws['tmux_socket'], sess_id, ws['root_dir'], provider_dict)
    
    return dict(db.execute("SELECT * FROM sessions WHERE session_id = ?", (sess_id,)).fetchone())
