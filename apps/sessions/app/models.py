from pydantic import BaseModel
from typing import List, Optional

class WorkspaceCreate(BaseModel):
    name: str
    slug: str
    root_dir: str
    default_provider: str = 'codex'
    allowed_providers: List[str] = ['claude', 'gemini', 'codex']

class WorkspaceUpdate(BaseModel):
    name: Optional[str] = None
    root_dir: Optional[str] = None
    default_provider: Optional[str] = None
    allowed_providers: Optional[List[str]] = None
    status: Optional[str] = None

class WorkspaceResponse(BaseModel):
    workspace_id: str
    slug: str
    name: str
    root_dir: str
    tmux_socket: str
    default_provider: str
    allowed_providers: List[str]
    status: str
    created_at: int
    updated_at: int

class ProviderConfigCreate(BaseModel):
    provider: str
    launch_cmd: List[str]
    env: dict
    requires_oauth: bool
    credential_path: str
    enabled: bool

class ProviderConfigUpdate(BaseModel):
    launch_cmd: Optional[List[str]] = None
    env: Optional[dict] = None
    requires_oauth: Optional[bool] = None
    credential_path: Optional[str] = None
    enabled: Optional[bool] = None

class ProviderConfigResponse(BaseModel):
    provider: str
    launch_cmd: List[str]
    env: dict
    requires_oauth: bool
    credential_path: str
    enabled: bool
