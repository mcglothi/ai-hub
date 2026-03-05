'use strict';

const express = require('express');
const http = require('http');
const { spawn } = require('child_process');
const { createProxyServer } = require('http-proxy');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLAUDE_BIN = process.env.CLAUDE_BIN || '/usr/bin/claude';
const GEMINI_BIN = process.env.GEMINI_BIN || '/usr/bin/gemini';
const CODEX_BIN = process.env.CODEX_BIN || '/usr/bin/codex';
const CLI_HOME = process.env.CLI_HOME || '/home/svc_ansible';
const TERMINAL_TARGET = process.env.TERMINAL_TARGET || 'http://127.0.0.1:7681';
const STT_URL = process.env.STT_URL || 'http://10.10.10.10:8008/v1/audio/transcriptions';
const STT_AUTH_TOKEN = process.env.STT_AUTH_TOKEN || '';
const AIKB_PATH = process.env.AIKB_PATH || '/home/svc_ansible/AIKB';
const AIKB_ENABLED_DEFAULT = process.env.AIKB_ENABLED_DEFAULT === '1';
const AIKB_MAX_SNIPPETS = Math.max(1, Math.min(6, parseInt(process.env.AIKB_MAX_SNIPPETS || '4', 10)));
const MEMORY_CORE_URL = (process.env.MEMORY_CORE_URL || 'https://memory.home.timmcg.net').replace(/\/+$/, '');
const MEMORY_CORE_API_KEY = process.env.MEMORY_CORE_API_KEY || '';
const MEMORY_CORE_TIMEOUT_MS = Math.max(1000, parseInt(process.env.MEMORY_CORE_TIMEOUT_MS || '20000', 10));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const terminalProxy = createProxyServer({
  target: TERMINAL_TARGET,
  changeOrigin: true,
  ws: true,
  xfwd: true,
});

terminalProxy.on('error', (err, req, res) => {
  if (res && !res.headersSent) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  }
  if (res && !res.writableEnded) {
    res.end(`terminal proxy error: ${err.message}`);
  }
});

function stripPrefix(url, prefix) {
  const stripped = url.slice(prefix.length);
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

function isSafeSessionId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

async function memoryRequest(method, path, { params = null, body = null, expectJson = true } = {}) {
  const url = new URL(`${MEMORY_CORE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers = {};
  if (MEMORY_CORE_API_KEY) headers['X-API-Key'] = MEMORY_CORE_API_KEY;
  if (body !== null) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEMORY_CORE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`memory core ${response.status}: ${text.slice(0, 400)}`);
    }
    if (!expectJson) return await response.text();
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function extractQueryTokens(text) {
  const stopwords = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which',
    'have', 'been', 'into', 'about', 'your', 'there', 'their', 'them', 'they', 'then', 'than',
    'will', 'would', 'could', 'should', 'just', 'also', 'like', 'need', 'want', 'today', 'next',
  ]);
  const matches = (text || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || [];
  const tokens = [];
  const seen = new Set();
  for (const token of matches) {
    if (stopwords.has(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= 8) break;
  }
  return tokens;
}

function runRg(args, { timeoutMs = 1200, maxBytes = 320000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('rg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > maxBytes) {
        output = output.slice(0, maxBytes);
        proc.kill('SIGKILL');
      }
    });

    proc.on('error', () => {
      clearTimeout(timer);
      done = true;
      resolve('');
    });

    proc.on('close', () => {
      clearTimeout(timer);
      done = true;
      resolve(output);
    });
  });
}

async function buildAikbContext(userMessage) {
  const tokens = extractQueryTokens(userMessage);
  if (!tokens.length) return null;

  try {
    await fs.access(AIKB_PATH);
  } catch {
    return null;
  }

  const args = ['-n', '-i', '--no-heading', '--max-count', '2', '--hidden'];
  for (const token of tokens) args.push('-e', token);
  args.push(
    '--glob', '*.md',
    '--glob', '*.yaml',
    '--glob', '*.yml',
    '--glob', '*.txt',
    '--glob', '*.json',
    '--glob', '!**/.git/**',
    '--glob', '!**/node_modules/**',
    '--glob', '!**/_tools/aikb-search/**',
    AIKB_PATH
  );

  const rgOutput = await runRg(args);
  if (!rgOutput.trim()) return null;

  const lineHits = rgOutput
    .split('\n')
    .map((line) => {
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (!m) return null;
      return { file: m[1], line: parseInt(m[2], 10), match: m[3].trim() };
    })
    .filter(Boolean);

  if (!lineHits.length) return null;

  const byFile = new Map();
  for (const hit of lineHits) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, []);
    byFile.get(hit.file).push(hit);
  }

  const topFiles = [...byFile.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, AIKB_MAX_SNIPPETS);

  const snippets = [];
  for (const [filePath, hits] of topFiles) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 1024 * 1024) continue;
      const text = await fs.readFile(filePath, 'utf8');
      const lines = text.split('\n');
      const lineNo = Math.max(1, hits[0].line);
      const start = Math.max(1, lineNo - 2);
      const end = Math.min(lines.length, lineNo + 2);
      const excerpt = lines.slice(start - 1, end).join('\n').trim();
      if (!excerpt) continue;
      const rel = filePath.startsWith(`${AIKB_PATH}/`) ? filePath.slice(AIKB_PATH.length + 1) : filePath;
      snippets.push(`Source: ${rel}:${lineNo}\n${excerpt}`);
    } catch {
      // Skip unreadable files and continue.
    }
  }

  if (!snippets.length) return null;
  return snippets.join('\n\n---\n\n');
}

function createProviderProcess(provider, message, sessionId) {
  if (provider === 'claude') {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
    ];
    if (isSafeSessionId(sessionId)) args.push('--resume', sessionId);
    return spawn(CLAUDE_BIN, args, {
      cwd: CLI_HOME,
      env: { ...process.env, HOME: CLI_HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  if (provider === 'gemini') {
    const args = ['-p', message];
    if (isSafeSessionId(sessionId)) args.push('--resume', sessionId);
    return spawn(GEMINI_BIN, args, {
      cwd: CLI_HOME,
      env: { ...process.env, HOME: CLI_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  if (provider === 'codex') {
    const args = ['exec', '--skip-git-repo-check', '--json', message];
    return spawn(CODEX_BIN, args, {
      cwd: CLI_HOME,
      env: { ...process.env, HOME: CLI_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

function handleClaudeStream(proc, send, onResultSession) {
  let buffer = '';

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (event.type === 'system' && event.subtype === 'init' && event.model) {
        send({ type: 'system', model: event.model });
      } else if (event.type === 'assistant') {
        const blocks = event.message?.content ?? [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            send({ type: 'text', text: block.text });
          }
        }
      } else if (event.type === 'result') {
        if (event.session_id) onResultSession(event.session_id);
      }
    }
  });
}

function handleGeminiStream(proc, send) {
  send({ type: 'system', model: 'gemini' });

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    if (text) send({ type: 'text', text });
  });
}

function handleCodexStream(proc, send, onThreadStarted) {
  send({ type: 'system', model: 'codex' });

  let buffer = '';

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (event.type === 'thread.started' && event.thread_id) {
        onThreadStarted(event.thread_id);
      }

      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
        send({ type: 'text', text: event.item.text });
      }
    }
  });

}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'ai-hub' });
});

app.use('/terminal', (req, res) => {
  req.url = stripPrefix(req.originalUrl, '/terminal');
  if (req.url === '') req.url = '/';
  terminalProxy.web(req, res);
});

app.post('/transcribe', upload.single('file'), async (req, res) => {
  if (!req.file || !req.file.buffer || req.file.size === 0) {
    return res.status(400).json({ error: 'audio file required' });
  }

  const form = new FormData();
  const mimeType = req.file.mimetype || 'audio/webm';
  const blob = new Blob([req.file.buffer], { type: mimeType });
  form.append('file', blob, req.file.originalname || 'audio.webm');
  form.append('model', req.body.model || 'whisper-1');
  form.append('language', req.body.language || 'en');
  form.append('response_format', 'json');

  const headers = {};
  if (STT_AUTH_TOKEN) headers.Authorization = `Bearer ${STT_AUTH_TOKEN}`;

  try {
    const response = await fetch(STT_URL, {
      method: 'POST',
      headers,
      body: form,
    });

    if (!response.ok) {
      const details = await response.text();
      return res.status(502).json({
        error: `stt upstream failed (${response.status})`,
        details: details.slice(0, 700),
      });
    }

    const payload = await response.json();
    const text = (payload && payload.text ? String(payload.text) : '').trim();
    return res.json({ text });
  } catch (err) {
    return res.status(502).json({ error: `stt request failed: ${err.message}` });
  }
});

app.get('/memory/health', async (_req, res) => {
  try {
    const out = await memoryRequest('GET', '/health');
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/memory/stats', async (_req, res) => {
  try {
    const out = await memoryRequest('GET', '/api/v1/stats');
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/memory/metrics', async (_req, res) => {
  try {
    const out = await memoryRequest('GET', '/metrics', { expectJson: false });
    res.type('text/plain').send(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/memory/proposals', async (req, res) => {
  try {
    const out = await memoryRequest('GET', '/api/v1/proposals', {
      params: {
        status: req.query.status || 'new',
        kind: req.query.kind || '',
        limit: req.query.limit || 50,
      },
    });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/memory/search', async (req, res) => {
  if (!req.query.q) {
    return res.status(400).json({ error: 'q query param required' });
  }
  try {
    const out = await memoryRequest('GET', '/api/v1/search', {
      params: {
        q: req.query.q,
        limit: req.query.limit || 20,
      },
    });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/memory/harvest', async (req, res) => {
  try {
    const out = await memoryRequest('POST', '/api/v1/proposals/harvest', {
      body: {
        max_events: Number(req.body.max_events || 250),
        state_name: String(req.body.state_name || 'default'),
      },
    });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/chat', (req, res) => {
  const { message, sessionId } = req.body;
  const provider = (req.body.provider || 'claude').toLowerCase();
  const aikbEnabled = toBool(req.body.aikbEnabled, AIKB_ENABLED_DEFAULT);

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message string required' });
  }

  if (!['claude', 'gemini', 'codex'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be one of: claude, gemini, codex' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let ended = false;
  let proc;
  let promptMessage = message;
  let finalSessionId = null;

  function send(obj) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  }

  function finish(session = null) {
    if (ended) return;
    ended = true;
    clearInterval(keepAlive);
    send({ type: 'done', session_id: session });
    res.end();
  }

  function fail(messageText) {
    if (ended) return;
    send({ type: 'error', message: messageText });
    ended = true;
    clearInterval(keepAlive);
    res.end();
  }

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 20000);

  (async () => {
    try {
      if (aikbEnabled) {
        const aikbContext = await buildAikbContext(message);
        if (aikbContext) {
          promptMessage = [
            'Use the AIKB context below only when relevant and accurate for the user request.',
            'If it is not relevant, ignore it.',
            '',
            'AIKB Context:',
            aikbContext,
            '',
            'User request:',
            message,
          ].join('\n');
        }
      }

      proc = createProviderProcess(provider, promptMessage, sessionId);
    } catch (err) {
      fail(err.message);
      return;
    }

    proc.stderr.on('data', (data) => {
      process.stderr.write(`[${provider}] ${data}`);
    });

    proc.on('error', (err) => {
      fail(err.message);
    });

    proc.on('close', (code, signal) => {
      if (ended) return;
      if (code !== 0 || signal) {
        fail(`${provider} exited (code=${code} signal=${signal})`);
        return;
      }

      finish(finalSessionId);
    });

    if (provider === 'claude') {
      handleClaudeStream(proc, send, (session) => {
        finalSessionId = session;
      });
      proc.stdin.write(promptMessage);
      proc.stdin.end();
    } else if (provider === 'gemini') {
      handleGeminiStream(proc, send);
    } else {
      handleCodexStream(proc, send, (threadId) => {
        finalSessionId = threadId;
      });
    }

    res.on('close', () => {
      if (!ended) {
        ended = true;
        clearInterval(keepAlive);
      }
      if (proc && !proc.killed) proc.kill();
    });
  })();

});

const port = parseInt(process.env.PORT || '3000', 10);
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/terminal')) {
    req.url = stripPrefix(req.url, '/terminal');
    if (req.url === '') req.url = '/';
    terminalProxy.ws(req, socket, head);
    return;
  }
  socket.destroy();
});

server.listen(port, '0.0.0.0', () => {
  console.log(`ai-hub listening on port ${port}`);
  console.log(`terminal proxy target: ${TERMINAL_TARGET}`);
  console.log(`aikb path: ${AIKB_PATH}`);
  console.log(`aikb default enabled: ${AIKB_ENABLED_DEFAULT ? 'yes' : 'no'}`);
});
