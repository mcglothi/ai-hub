const state = {
  sessions: [],
  current: null,
  term: null,
  fit: null,
  socket: null,
  resizeObserver: null,
};

const els = {
  list: document.getElementById("sessionList"),
  tabbar: document.getElementById("tabbar"),
  search: document.getElementById("search"),
  providerFilter: document.getElementById("providerFilter"),
  newSession: document.getElementById("newSession"),
  modal: document.getElementById("modal"),
  createSession: document.getElementById("createSession"),
  cancelModal: document.getElementById("cancelModal"),
  providerInput: document.getElementById("providerInput"),
  titleInput: document.getElementById("titleInput"),
  tagsInput: document.getElementById("tagsInput"),
  dirInput: document.getElementById("dirInput"),
  presetInput: document.getElementById("presetInput"),
  terminal: document.getElementById("terminal"),
  sessionTitle: document.getElementById("sessionTitle"),
  sessionMeta: document.getElementById("sessionMeta"),
  renameSession: document.getElementById("renameSession"),
  pinSession: document.getElementById("pinSession"),
  archiveSession: document.getElementById("archiveSession"),
  deleteSession: document.getElementById("deleteSession"),
  terminateSession: document.getElementById("terminateSession"),
  workingDir: document.getElementById("workingDir"),
  updateDir: document.getElementById("updateDir"),
  gitStatus: document.getElementById("gitStatus"),
  refreshGit: document.getElementById("refreshGit"),
  exportSession: document.getElementById("exportSession"),
  history: document.getElementById("history"),
  historySearch: document.getElementById("historySearch"),
  fontFamily: document.getElementById("fontFamily"),
  fontSize: document.getElementById("fontSize"),
  fontSizeValue: document.getElementById("fontSizeValue"),
};

const PREFS_KEY = "aihub.terminal.prefs";
const DEFAULT_PREFS = {
  fontFamily:
    "JetBrains Mono, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace",
  fontSize: 13,
};

function loadPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return { ...DEFAULT_PREFS, ...stored };
  } catch (err) {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function applyPrefs() {
  const prefs = loadPrefs();
  if (state.term) {
    state.term.options.fontFamily = prefs.fontFamily;
    state.term.options.fontSize = prefs.fontSize;
    if (state.fit) state.fit.fit();
  }
  if (els.fontFamily) els.fontFamily.value = prefs.fontFamily;
  if (els.fontSize) els.fontSize.value = prefs.fontSize;
  if (els.fontSizeValue) els.fontSizeValue.textContent = `${prefs.fontSize}px`;
}

if (location.pathname === "/sessions") {
  location.replace("/sessions/");
}

const basePath = location.pathname.startsWith("/sessions") ? "/sessions" : "";

async function api(path, options = {}) {
  const res = await fetch(`${basePath}${path}`, options);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json();
}

function filterSessions() {
  const query = els.search.value.toLowerCase().trim();
  const provider = els.providerFilter.value;
  return state.sessions.filter((s) => {
    if (provider && s.provider !== provider) return false;
    if (!query) return true;
    const hay = `${s.title} ${s.tags.join(" ")} ${s.provider}`.toLowerCase();
    return hay.includes(query);
  });
}

function renderSessions() {
  els.list.innerHTML = "";
  const sessions = filterSessions();
  if (!sessions.length) {
    els.list.innerHTML = '<div class="session-item">No sessions</div>';
    return;
  }
  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = `session-item ${state.current?.session_id === session.session_id ? "active" : ""}`;
    item.innerHTML = `
      <div class="name">${session.title}</div>
      <div class="meta">${session.provider} • ${session.tags.join(", ") || "no tags"}</div>
    `;
    item.addEventListener("click", () => selectSession(session));
    els.list.appendChild(item);
  }
}

function renderTabs() {
  els.tabbar.innerHTML = "";
  const sessions = [...state.sessions]
    .filter((s) => s.status !== "archived")
    .sort((a, b) => (b.pinned === a.pinned ? b.last_active - a.last_active : b.pinned - a.pinned));
  if (!sessions.length) return;
  for (const session of sessions) {
    const tab = document.createElement("div");
    tab.className = `tab ${state.current?.session_id === session.session_id ? "active" : ""}`;
    const label = `${session.title}`.slice(0, 26);
    tab.textContent = `${label} (${session.provider})`;
    tab.addEventListener("click", () => selectSession(session));
    els.tabbar.appendChild(tab);
  }
}

function openModal() {
  els.modal.classList.remove("hidden");
}

function closeModal() {
  els.modal.classList.add("hidden");
  els.titleInput.value = "";
  els.tagsInput.value = "";
  els.dirInput.value = "/home/mcglothi/Code";
}

async function loadSessions() {
  state.sessions = await api("/api/sessions");
  renderSessions();
  renderTabs();
}

function initTerminal() {
  if (state.term) return;
  const prefs = loadPrefs();
  state.term = new Terminal({
    fontFamily: prefs.fontFamily,
    fontSize: prefs.fontSize,
    theme: { background: "#0b0f15" },
  });
  state.fit = new FitAddon.FitAddon();
  state.term.loadAddon(state.fit);
  state.term.open(els.terminal);
  const notifyResize = () => {
    state.fit.fit();
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      const dims = state.fit.proposeDimensions();
      state.socket.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
    }
  };
  notifyResize();
  window.addEventListener("resize", notifyResize);
  if ("ResizeObserver" in window && !state.resizeObserver) {
    state.resizeObserver = new ResizeObserver(() => {
      notifyResize();
    });
    state.resizeObserver.observe(els.terminal);
    const panel = document.querySelector(".terminal-panel");
    if (panel) state.resizeObserver.observe(panel);
  }
  applyPrefs();
}

els.terminal.addEventListener("click", () => {
  if (state.term) state.term.focus();
});

function connectTerminal(sessionId) {
  if (!state.term) initTerminal();
  if (state.socket) {
    state.socket.close();
  }
  state.term.reset();

  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}${basePath}/ws/terminal/${sessionId}`);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.term.focus();
    const dims = state.fit.proposeDimensions();
    socket.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
    setTimeout(() => state.fit.fit(), 50);
  });

  socket.addEventListener("message", (event) => {
    state.term.write(event.data);
  });

  socket.addEventListener("close", () => {
    setTimeout(() => {
      if (state.current && state.current.session_id === sessionId) {
        connectTerminal(sessionId);
      }
    }, 1500);
  });

  state.term.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    }
  });
}

async function selectSession(session) {
  state.current = session;
  els.sessionTitle.textContent = session.title;
  els.sessionMeta.textContent = `${session.provider} • ${session.tags.join(", ") || "no tags"} • ${new Date(session.created_at * 1000).toLocaleString()}`;
  els.pinSession.textContent = session.pinned ? "Unpin" : "Pin";
  els.workingDir.value = session.working_dir || "/home/mcglothi/Code";
  connectTerminal(session.session_id);
  renderSessions();
  renderTabs();
  await loadHistory(session.session_id);
  await refreshGitStatus();
}

async function loadHistory(sessionId) {
  try {
    const query = els.historySearch.value.trim();
    const url = query ? `/api/history/${sessionId}?q=${encodeURIComponent(query)}` : `/api/history/${sessionId}`;
    const data = await api(url);
    els.history.innerHTML = "";
    if (!data.events.length) {
      els.history.innerHTML = '<div class="meta">No history yet.</div>';
      return;
    }
    for (const event of data.events.slice(-50)) {
      const row = document.createElement("div");
      const detail = event.data ? `: ${event.data}` : "";
      row.textContent = `${new Date(event.ts * 1000).toLocaleTimeString()} — ${event.event}${detail}`;
      els.history.appendChild(row);
    }
  } catch (err) {
    els.history.innerHTML = '<div class="meta">History unavailable.</div>';
  }
}

async function createSession() {
  const title = els.titleInput.value.trim();
  const tags = els.tagsInput.value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const workingDir = els.dirInput.value.trim() || "/home/mcglothi/Code";
  const provider = els.providerInput.value;

  const session = await api("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, title: title || null, tags, working_dir: workingDir }),
  });
  closeModal();
  await loadSessions();
  await selectSession(session);
}

async function togglePin() {
  if (!state.current) return;
  const updated = await api(`/api/sessions/${state.current.session_id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned: !state.current.pinned }),
  });
  state.current = updated;
  await loadSessions();
  await selectSession(updated);
}

async function archiveSession() {
  if (!state.current) return;
  await api(`/api/sessions/${state.current.session_id}`, { method: "DELETE" });
  state.current = null;
  els.sessionTitle.textContent = "No session selected";
  els.sessionMeta.textContent = "";
  if (state.term) state.term.reset();
  await loadSessions();
}

async function deleteSession() {
  if (!state.current) return;
  if (!confirm("Delete this session permanently?")) return;
  await api(`/api/sessions/${state.current.session_id}/hard`, { method: "DELETE" });
  state.current = null;
  els.sessionTitle.textContent = "No session selected";
  els.sessionMeta.textContent = "";
  if (state.term) state.term.reset();
  await loadSessions();
}

async function terminateSession() {
  if (!state.current) return;
  if (!confirm("Terminate tmux session (leave record intact)?")) return;
  await api(`/api/sessions/${state.current.session_id}/terminate`, { method: "POST" });
  await loadSessions();
}

async function renameSession() {
  if (!state.current) return;
  const next = prompt("Rename session", state.current.title);
  if (!next) return;
  const updated = await api(`/api/sessions/${state.current.session_id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: next }),
  });
  state.current = updated;
  await loadSessions();
  await selectSession(updated);
}

async function updateWorkingDir() {
  if (!state.current) return;
  const dir = els.workingDir.value.trim();
  if (!dir) return;
  const updated = await api(`/api/sessions/${state.current.session_id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ working_dir: dir }),
  });
  state.current = updated;
  await loadSessions();
  await selectSession(updated);
}

async function refreshGitStatus() {
  if (!state.current || !state.current.working_dir) return;
  const res = await api(`/api/git-status?dir=${encodeURIComponent(state.current.working_dir)}`);
  els.gitStatus.textContent = res.output || res.status;
}

async function exportSession() {
  if (!state.current) return;
  const res = await fetch(`${basePath}/api/export/${state.current.session_id}`);
  if (!res.ok) return;
  const text = await res.text();
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.current.title || "session"}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

els.newSession.addEventListener("click", openModal);
els.cancelModal.addEventListener("click", closeModal);
els.createSession.addEventListener("click", createSession);
els.search.addEventListener("input", renderSessions);
els.providerFilter.addEventListener("change", renderSessions);
els.presetInput.addEventListener("change", () => {
  const value = els.presetInput.value;
  if (!value) return;
  const [dir, tag] = value.split("|");
  els.dirInput.value = dir;
  if (tag && !els.tagsInput.value.includes(tag)) {
    els.tagsInput.value = [els.tagsInput.value, tag].filter(Boolean).join(", ");
  }
});
els.pinSession.addEventListener("click", togglePin);
els.archiveSession.addEventListener("click", archiveSession);
els.renameSession.addEventListener("click", renameSession);
els.updateDir.addEventListener("click", updateWorkingDir);
els.refreshGit.addEventListener("click", refreshGitStatus);
els.exportSession.addEventListener("click", exportSession);
els.deleteSession.addEventListener("click", deleteSession);
els.terminateSession.addEventListener("click", terminateSession);
if (els.fontFamily) {
  els.fontFamily.addEventListener("change", () => {
    const prefs = loadPrefs();
    prefs.fontFamily = els.fontFamily.value;
    savePrefs(prefs);
    applyPrefs();
  });
}
if (els.fontSize) {
  els.fontSize.addEventListener("input", () => {
    const prefs = loadPrefs();
    prefs.fontSize = Number(els.fontSize.value || 13);
    savePrefs(prefs);
    applyPrefs();
  });
}
els.historySearch.addEventListener("input", () => {
  if (state.current) loadHistory(state.current.session_id);
});

document.querySelectorAll("[data-tmux]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    const sequence = btn.dataset.tmux || "";
    if (!sequence) return;
    state.socket.send(`\x02${sequence}`);
    const confirmKey = btn.dataset.tmuxConfirm;
    if (confirmKey) {
      setTimeout(() => {
        if (state.socket && state.socket.readyState === WebSocket.OPEN) {
          state.socket.send(confirmKey);
        }
      }, 120);
    }
  });
});

applyPrefs();
loadSessions();
