'use strict';

const express = require('express');
const http = require('http');
const { spawn } = require('child_process');
const { createProxyServer } = require('http-proxy');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
const APP_BUILD = process.env.APP_BUILD || new Date().toISOString();
const APP_STARTED_AT = new Date().toISOString();

app.get(['/','/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/build-info', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json({
    app: 'operator-console',
    build: APP_BUILD,
    started_at: APP_STARTED_AT,
  });
});

app.use(express.static(path.join(__dirname, 'public'), {
  cacheControl: false,
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

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
const SSH_BIN = process.env.SSH_BIN || '/usr/bin/ssh';
const HOPPER_HOST = process.env.HOPPER_HOST || 'mcglothi@hopper.home.timmcg.net';
const HOPPER_DOCKER_BIN = process.env.HOPPER_DOCKER_BIN || 'docker';
const HOPPER_OLLAMA_CONTAINER = process.env.HOPPER_OLLAMA_CONTAINER || 'ollama';
const HOPPER_MODEL_DATA_PATH = process.env.HOPPER_MODEL_DATA_PATH || '/opt/containers/ollama/data';
const HOPPER_MODEL_METADATA_PATH = process.env.HOPPER_MODEL_METADATA_PATH || path.join(__dirname, 'data', 'hopper-model-metadata.json');
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

function normalizeRelPath(input, fallback = '_runtime/memory-proposals-applied.md') {
  const raw = String(input || '').trim();
  const candidate = raw || fallback;
  const normalized = path.posix.normalize(candidate.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return fallback;
  }
  return normalized;
}

function isAllowedContextPath(absPath) {
  const roots = [
    path.resolve(AIKB_PATH),
    path.resolve(CLI_HOME, '.codex', 'sessions'),
    path.resolve('/home/mcglothi/.codex/sessions'),
    path.resolve('/home/svc_ansible/.codex/sessions'),
  ];
  return roots.some((root) => absPath === root || absPath.startsWith(`${root}${path.sep}`));
}

function proposalToMarkdownBlock(proposal) {
  const payloadPretty = JSON.stringify(proposal.payload || {}, null, 2);
  const lines = [
    '',
    `### Memory Proposal Applied — ${new Date().toISOString()}`,
    `- Proposal ID: \`${proposal.proposal_id}\``,
    `- Kind: \`${proposal.kind}\``,
    `- Confidence: \`${Number(proposal.confidence || 0).toFixed(2)}\``,
    `- Summary: ${String(proposal.summary || '').trim() || '(none)'}`,
  ];

  const evidence = proposal.evidence && typeof proposal.evidence === 'object' ? proposal.evidence : {};
  if (evidence.event_id) lines.push(`- Event: \`${evidence.event_id}\``);
  if (evidence.source) lines.push(`- Source: \`${evidence.source}\``);
  if (evidence.event_type) lines.push(`- Event Type: \`${evidence.event_type}\``);
  if (evidence.ts) lines.push(`- Event TS: \`${evidence.ts}\``);

  lines.push('', '```json', payloadPretty, '```', '');
  return lines.join('\n');
}

async function ensureTargetFile(absPath, relPath) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  try {
    await fs.access(absPath);
  } catch {
    const header = [
      '# Memory Proposal Applications',
      '',
      'Auto-appended proposal applications from AI Hub review flow.',
      '',
    ].join('\n');
    await fs.writeFile(absPath, header, 'utf8');
  }
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

function normalizeProposalKind(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['fact', 'preference', 'task', 'runbook_update'].includes(raw)) return raw;
  return 'task';
}

function summarizeForProposal(text, fallback = 'Operator-created proposal candidate') {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\u0000/g, '')
    .trim();
  if (!clean) return fallback;
  return clean.slice(0, 320);
}

function parseSearchSnippet(event) {
  const raw = String(event?.snippet || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function firstMeaningfulText(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || '';
}

function summarizeSearchEvent(event) {
  const parsed = parseSearchSnippet(event);
  const payload = parsed?.payload || {};
  const snippet = String(event?.snippet || '').trim();

  let title = String(event?.event_type || 'event');
  let summary = snippet;
  let category = String(event?.event_type || 'event');

  if (parsed?.type === 'event_msg') {
    category = String(payload?.type || event?.event_type || 'event_msg');
    title = firstMeaningfulText(payload?.type, event?.event_type, 'event message');
    summary = firstMeaningfulText(payload?.message, payload?.text, payload?.summary, snippet);
  } else if (parsed?.type === 'response_item') {
    category = String(payload?.type || event?.event_type || 'response_item');
    if (payload?.type === 'message') {
      const text = payload?.content?.find?.((item) => item?.type === 'output_text')?.text;
      title = firstMeaningfulText(payload?.role ? `${payload.role} message` : '', payload?.type, event?.event_type);
      summary = firstMeaningfulText(text, snippet);
    } else if (payload?.type === 'reasoning') {
      const text = payload?.summary?.map?.((item) => item?.text).find(Boolean);
      title = 'reasoning';
      summary = firstMeaningfulText(text, snippet);
    } else if (payload?.type === 'function_call') {
      title = `function_call ${String(payload?.name || 'unknown')}`;
      summary = firstMeaningfulText(payload?.arguments, payload?.name, snippet);
    } else if (payload?.type === 'function_call_output') {
      title = `function_output ${String(payload?.call_id || '').slice(0, 8) || 'tool'}`;
      summary = firstMeaningfulText(payload?.output, snippet);
    } else if (payload?.type === 'custom_tool_call') {
      title = `tool ${String(payload?.name || 'custom')}`;
      summary = firstMeaningfulText(payload?.input, snippet);
    } else {
      title = firstMeaningfulText(payload?.type, event?.event_type, 'response');
      summary = firstMeaningfulText(payload?.text, snippet);
    }
  }

  const compact = String(summary || '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title,
    summary: compact,
    category,
    parsed,
  };
}

function eventLooksNoisy(summary) {
  const text = String(summary || '').trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  return (
    lower.startsWith('chunk id:') ||
    lower.includes('process exited with code') ||
    lower.includes('"type":"function_call_output"') ||
    lower.includes('"type":"custom_tool_call"') ||
    lower.includes('original token count') ||
    lower.startsWith('{"timestamp":"') ||
    lower === 'response_item' ||
    lower === 'turn_context'
  );
}

function rankSearchEvent(event, queryTokens) {
  const info = summarizeSearchEvent(event);
  const provider = String(event?.metadata?.provider || '').toLowerCase();
  const source = String(event?.source || '').toLowerCase();
  const eventType = String(event?.event_type || '').toLowerCase();
  const pathBits = `${String(event?.metadata?.file_path || '')} ${String(event?.metadata?.filename || '')}`.toLowerCase();
  const haystack = `${info.title} ${info.summary}`.toLowerCase();
  const relevantHaystack = `${haystack} ${pathBits}`;
  let score = 0;
  let matchedTokens = 0;

  if (['agent_message', 'gemini_chat_message', 'gemini_chat_user', 'message'].includes(eventType)) score += 8;
  if (eventType === 'agent_reasoning' || info.title === 'reasoning') score += 5;
  if (provider === 'gemini' || provider === 'codex' || provider === 'claude') score += 2;
  if (source === 'ai-memory-sync') score += 1;
  if (info.summary.length >= 48) score += 2;
  if (info.summary.length <= 12) score -= 2;

  if (eventType === 'response_item') score -= 4;
  if (eventType === 'turn_context') score -= 8;
  if (info.category === 'function_call_output') score -= 7;
  if (info.category === 'function_call' || info.category === 'custom_tool_call') score -= 5;
  if (eventLooksNoisy(info.summary)) score -= 8;

  for (const token of queryTokens) {
    if (relevantHaystack.includes(token)) {
      matchedTokens += 1;
      score += haystack.includes(token) ? 3 : 1;
    }
  }

  if (queryTokens.length && matchedTokens === 0) score -= 10;
  if (queryTokens.length && matchedTokens < Math.min(2, queryTokens.length) && eventType === 'response_item') score -= 4;

  return { ...event, _summary: info, _score: score, _matchedTokens: matchedTokens };
}

function rerankSearchResults(out, query) {
  const queryTokens = extractQueryTokens(query);
  const events = Array.isArray(out?.events) ? out.events : [];
  const ranked = events
    .map((event) => rankSearchEvent(event, queryTokens))
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return Number(b.ts || 0) - Number(a.ts || 0);
    });

  const filtered = ranked.filter((event) => event._score >= 1 && (!queryTokens.length || event._matchedTokens > 0));
  const finalEvents = filtered
    .map(({ _summary, _score, ...event }) => event);
  const suppressed = Math.max(0, ranked.length - finalEvents.length);

  return {
    ...out,
    events: finalEvents,
    counts: {
      ...(out?.counts || {}),
      events: finalEvents.length,
      suppressed_events: suppressed,
    },
  };
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function parseTable(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = lines[0].trim().split(/\s{2,}/).map((item) => item.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const values = line.trim().split(/\s{2,}/);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    return row;
  });
}

function parseHumanSizeToBytes(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^([\d.]+)\s*([KMGT]?B)?$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] || 'B').toUpperCase();
  const scale = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  }[unit];
  return scale ? Math.round(value * scale) : null;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value;
  let unit = 'B';
  for (const next of units) {
    scaled /= 1024;
    unit = next;
    if (scaled < 1024) break;
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${unit}`;
}

function relativeTimeFromText(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'now' || text === 'just now') return 0;
  const match = text.match(/^(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks|month|months)\s+ago$/);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit.startsWith('minute')
    ? 60
    : unit.startsWith('hour')
      ? 3600
      : unit.startsWith('day')
        ? 86400
        : unit.startsWith('week')
          ? 604800
          : 2629800;
  return value * multiplier;
}

function normalizeModelMetadataRecord(record = {}) {
  return {
    pinned: record.pinned === true,
    stage: typeof record.stage === 'string' && record.stage.trim() ? record.stage.trim() : 'testing',
    note: typeof record.note === 'string' ? record.note.trim() : '',
    hidden: record.hidden === true,
    updated_at: typeof record.updated_at === 'string' && record.updated_at.trim() ? record.updated_at : new Date().toISOString(),
  };
}

async function readHopperModelMetadata() {
  try {
    const raw = await fs.readFile(HOPPER_MODEL_METADATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const models = parsed && typeof parsed.models === 'object' && parsed.models ? parsed.models : {};
    const normalized = {};
    for (const [name, record] of Object.entries(models)) {
      normalized[name] = normalizeModelMetadataRecord(record);
    }
    return { models: normalized };
  } catch {
    return { models: {} };
  }
}

async function writeHopperModelMetadata(payload) {
  const safePayload = payload && typeof payload === 'object' ? payload : { models: {} };
  await fs.mkdir(path.dirname(HOPPER_MODEL_METADATA_PATH), { recursive: true });
  await fs.writeFile(HOPPER_MODEL_METADATA_PATH, JSON.stringify(safePayload, null, 2), 'utf8');
}

function ensureSafeModelName(name) {
  const model = String(name || '').trim();
  if (!model) throw new Error('model name required');
  if (!/^[a-zA-Z0-9._:/+-]+$/.test(model)) {
    throw new Error('model name contains unsupported characters');
  }
  return model;
}

function spawnAndCollect(bin, args, { timeoutMs = 20000, cwd = undefined, env = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      proc.kill('SIGKILL');
      reject(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error((stderr || stdout || `command exited ${code}`).trim()));
      }
    });
  });
}

async function runHopperCommand(command, { timeoutMs = 20000 } = {}) {
  return spawnAndCollect(
    SSH_BIN,
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOPPER_HOST, command],
    { timeoutMs }
  );
}

async function runHopperDocker(args, { timeoutMs = 20000 } = {}) {
  const command = [HOPPER_DOCKER_BIN, ...args].map(shellQuote).join(' ');
  return runHopperCommand(command, { timeoutMs });
}

async function getHopperModelInventory() {
  const metadata = await readHopperModelMetadata();
  const [hostnameOut, dockerPsOut, listOut, psOut, diskOut] = await Promise.all([
    runHopperCommand('hostname', { timeoutMs: 8000 }),
    runHopperDocker(['ps', '--format', 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']),
    runHopperDocker(['exec', HOPPER_OLLAMA_CONTAINER, 'ollama', 'list'], { timeoutMs: 25000 }),
    runHopperDocker(['exec', HOPPER_OLLAMA_CONTAINER, 'ollama', 'ps'], { timeoutMs: 15000 }),
    runHopperCommand(`df -B1 ${shellQuote(HOPPER_MODEL_DATA_PATH)}`, { timeoutMs: 8000 }),
  ]);

  const loadedNames = new Set(
    parseTable(psOut.stdout)
      .map((row) => row.name)
      .filter(Boolean)
  );

  const models = parseTable(listOut.stdout).map((row) => {
    const name = row.name || '';
    const metadataRecord = metadata.models[name] || normalizeModelMetadataRecord({});
    const modifiedText = row.modified || '';
    const ageSeconds = relativeTimeFromText(modifiedText);
    const sizeBytes = parseHumanSizeToBytes(row.size || '');
    const loaded = loadedNames.has(name);
    const cleanupCandidate = !loaded && !metadataRecord.pinned && metadataRecord.stage !== 'keeper';
    return {
      name,
      id: row.id || '',
      size: row.size || '',
      size_bytes: sizeBytes,
      modified: modifiedText,
      age_seconds: ageSeconds,
      loaded,
      metadata: metadataRecord,
      cleanup_candidate: cleanupCandidate,
      weight: (cleanupCandidate ? 1 : 0) * (sizeBytes || 0) + (ageSeconds || 0),
    };
  }).sort((a, b) => (b.size_bytes || 0) - (a.size_bytes || 0));

  const diskLines = String(diskOut.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const diskParts = (diskLines[1] || '').split(/\s+/);
  const disk = diskParts.length >= 6 ? {
    filesystem: diskParts[0],
    total_bytes: Number(diskParts[1]) || null,
    used_bytes: Number(diskParts[2]) || null,
    available_bytes: Number(diskParts[3]) || null,
    used_percent: diskParts[4] || '',
    mountpoint: diskParts[5] || '',
  } : null;

  const containers = parseTable(dockerPsOut.stdout).map((row) => ({
    name: row.names || '',
    image: row.image || '',
    status: row.status || '',
    ports: row.ports || '',
  }));

  const cleanupCandidates = [...models]
    .filter((model) => model.cleanup_candidate)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 6)
    .map((model) => ({
      name: model.name,
      size: model.size,
      size_bytes: model.size_bytes,
      modified: model.modified,
      reason: model.metadata.stage === 'testing'
        ? 'testing lane, not pinned, not loaded'
        : 'not pinned and not loaded',
    }));

  return {
    host: hostnameOut.stdout.trim() || HOPPER_HOST,
    target: HOPPER_HOST,
    ollama_container: HOPPER_OLLAMA_CONTAINER,
    model_data_path: HOPPER_MODEL_DATA_PATH,
    disk: disk ? {
      ...disk,
      total: formatBytes(disk.total_bytes),
      used: formatBytes(disk.used_bytes),
      available: formatBytes(disk.available_bytes),
    } : null,
    containers,
    loaded_models: [...loadedNames],
    models,
    cleanup_candidates: cleanupCandidates,
    summary: {
      model_count: models.length,
      loaded_count: loadedNames.size,
      pinned_count: models.filter((model) => model.metadata.pinned).length,
      keeper_count: models.filter((model) => model.metadata.stage === 'keeper').length,
      testing_count: models.filter((model) => model.metadata.stage === 'testing').length,
      cleanup_candidate_bytes: cleanupCandidates.reduce((sum, model) => sum + (model.size_bytes || 0), 0),
    },
  };
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
    const hasStatus = Object.prototype.hasOwnProperty.call(req.query, 'status');
    let status = hasStatus ? String(req.query.status ?? '') : 'new';
    if (status.toLowerCase() === 'all') status = '';
    const out = await memoryRequest('GET', '/api/v1/proposals', {
      params: {
        status,
        kind: req.query.kind || '',
        limit: req.query.limit || 50,
      },
    });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/memory/proposals/:proposalId', async (req, res) => {
  try {
    const out = await memoryRequest('GET', `/api/v1/proposals/${encodeURIComponent(req.params.proposalId)}`);
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.patch('/memory/proposals/:proposalId', async (req, res) => {
  try {
    const out = await memoryRequest('PATCH', `/api/v1/proposals/${encodeURIComponent(req.params.proposalId)}`, {
      body: {
        status: String(req.body.status || ''),
        review_notes: req.body.review_notes == null ? null : String(req.body.review_notes),
        applied_file: req.body.applied_file == null ? null : String(req.body.applied_file),
      },
    });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.put('/memory/proposals/:proposalId', async (req, res) => {
  try {
    const out = await memoryRequest('PUT', `/api/v1/proposals/${encodeURIComponent(req.params.proposalId)}`, {
      body: {
        summary: String(req.body.summary || ''),
        payload: req.body.payload && typeof req.body.payload === 'object' ? req.body.payload : {},
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
  const requestedLimit = Number(req.query.limit || 20);
  const safeLimit = Math.max(1, Math.min(50, Number.isFinite(requestedLimit) ? requestedLimit : 20));
  try {
    const out = await memoryRequest('GET', '/api/v1/search', {
      params: {
        q: req.query.q,
        limit: safeLimit,
      },
    });
    res.json(rerankSearchResults(out, String(req.query.q || '')));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/memory/source-context', async (req, res) => {
  const filePath = String(req.query.path || '').trim();
  const requestedLine = Number(req.query.line || 1);
  const requestedRadius = Number(req.query.radius || 3);
  if (!filePath) return res.status(400).json({ error: 'path query param required' });
  const absPath = path.resolve(filePath);
  if (!isAllowedContextPath(absPath)) {
    return res.status(403).json({ error: 'path not allowed' });
  }

  try {
    const text = await fs.readFile(absPath, 'utf8');
    const lines = text.split(/\r?\n/);
    const lineNumber = Math.max(1, requestedLine || 1);
    const radius = Math.max(1, Math.min(10, requestedRadius || 3));
    const start = Math.max(1, lineNumber - radius);
    const end = Math.min(lines.length, lineNumber + radius);
    const excerpt = [];
    for (let i = start; i <= end; i++) {
      excerpt.push({
        line: i,
        text: lines[i - 1] ?? '',
        selected: i === lineNumber,
      });
    }
    res.json({
      path: absPath,
      line: lineNumber,
      start,
      end,
      excerpt,
    });
  } catch (err) {
    res.status(404).json({ error: err.message });
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

app.post('/memory/proposals/from-event', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const event = body.event && typeof body.event === 'object' ? body.event : {};
    const kind = normalizeProposalKind(body.kind);
    const stateName = String(body.state_name || 'default').trim() || 'default';
    const maxEvents = Math.max(1, Math.min(2000, Number(body.max_events || 2000)));
    const summary = summarizeForProposal(
      body.summary || event.preview || event.title || event.snippet || event.rawSnippet || ''
    );

    const manualId = `manual-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const signalText = `[proposal:${kind}] ${summary} [manual:${manualId}]`;
    const envelope = {
      timestamp: new Date().toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: signalText }],
      },
    };
    const content = JSON.stringify(envelope);
    const ingestEvent = {
      event_id: crypto.createHash('sha256').update(`${manualId}|${content}`).digest('hex').slice(0, 32),
      ts: Math.floor(Date.now() / 1000),
      source: 'ai-memory-sync',
      event_type: 'response_item',
      content,
      metadata: {
        device: String(event.device || 'ai-home'),
        provider: String(event.provider || 'manual'),
        role: 'user',
        file_path: String(event.file_path || '/manual/ai-home'),
        filename: String(event.filename || 'manual-proposal.jsonl'),
        line_index: Number.isFinite(Number(event.line_index)) ? Number(event.line_index) : 0,
        proposal_intent: true,
        proposal_kind_hint: kind,
        proposal_keywords: ['manual-create'],
        manual_proposal_id: manualId,
        evidence_event_id: event.event_id || event.eventId || null,
        evidence_event_type: event.event_type || event.eventType || null,
        evidence_source: event.source || event.src || null,
        evidence_snippet: summarizeForProposal(event.snippet || event.rawSnippet || event.preview || '', ''),
      },
      redact: true,
    };

    await memoryRequest('POST', '/api/v1/events', { body: { events: [ingestEvent] } });
    const harvest = await memoryRequest('POST', '/api/v1/proposals/harvest', {
      body: { max_events: maxEvents, state_name: stateName },
    });
    const proposalsOut = await memoryRequest('GET', '/api/v1/proposals', {
      params: { status: 'new', limit: 80 },
    });
    const proposals = Array.isArray(proposalsOut?.proposals) ? proposalsOut.proposals : [];
    let created = proposals.filter((p) => {
      const payload = p && typeof p.payload === 'object' ? p.payload : {};
      const marker = String(payload?.manual_proposal_id || '');
      if (marker === manualId) return true;
      return String(p?.summary || '').includes(summary.slice(0, 48));
    });
    const harvestCreated = Number(harvest?.created || 0);
    if (!created.length && harvestCreated > 0) {
      created = [...proposals]
        .sort((a, b) => Number(b?.created_ts || 0) - Number(a?.created_ts || 0))
        .slice(0, Math.min(harvestCreated, 5));
    }

    res.json({
      status: 'ok',
      manual_id: manualId,
      harvest,
      created,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/memory/proposals/:proposalId/apply-preview', async (req, res) => {
  try {
    const proposalOut = await memoryRequest('GET', `/api/v1/proposals/${encodeURIComponent(req.params.proposalId)}`);
    const proposal = proposalOut.proposal || proposalOut;
    if (!proposal || !proposal.proposal_id) {
      return res.status(404).json({ error: 'proposal not found' });
    }

    const suggested = proposal.payload && typeof proposal.payload === 'object' ? proposal.payload.suggested_file : '';
    const relPath = normalizeRelPath(req.body?.file || suggested || '');
    const absPath = path.resolve(AIKB_PATH, relPath);
    const aikbRoot = path.resolve(AIKB_PATH);
    if (!absPath.startsWith(`${aikbRoot}${path.sep}`) && absPath !== aikbRoot) {
      return res.status(400).json({ error: 'target path must stay within AIKB_PATH' });
    }

    let existing = '';
    try {
      existing = await fs.readFile(absPath, 'utf8');
    } catch {
      existing = '';
    }

    const appendBlock = proposalToMarkdownBlock(proposal);
    const existingLines = existing ? existing.split('\n') : [];
    const tail = existingLines.slice(Math.max(0, existingLines.length - 40)).join('\n');

    res.json({
      proposal_id: proposal.proposal_id,
      file: relPath,
      preview: {
        existing_tail: tail,
        append_block: appendBlock,
      },
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/memory/proposals/:proposalId/apply', async (req, res) => {
  try {
    const proposalOut = await memoryRequest('GET', `/api/v1/proposals/${encodeURIComponent(req.params.proposalId)}`);
    const proposal = proposalOut.proposal || proposalOut;
    if (!proposal || !proposal.proposal_id) {
      return res.status(404).json({ error: 'proposal not found' });
    }

    const suggested = proposal.payload && typeof proposal.payload === 'object' ? proposal.payload.suggested_file : '';
    const relPath = normalizeRelPath(req.body?.file || suggested || '');
    const absPath = path.resolve(AIKB_PATH, relPath);
    const aikbRoot = path.resolve(AIKB_PATH);
    if (!absPath.startsWith(`${aikbRoot}${path.sep}`) && absPath !== aikbRoot) {
      return res.status(400).json({ error: 'target path must stay within AIKB_PATH' });
    }

    await ensureTargetFile(absPath, relPath);
    const block = proposalToMarkdownBlock(proposal);
    await fs.appendFile(absPath, block, 'utf8');

    const patchOut = await memoryRequest('PATCH', `/api/v1/proposals/${encodeURIComponent(req.params.proposalId)}`, {
      body: {
        status: 'applied',
        review_notes: req.body?.review_notes == null ? null : String(req.body.review_notes),
        applied_file: relPath,
      },
    });

    res.json({
      status: 'ok',
      file: relPath,
      proposal: patchOut.proposal || null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/models/hopper', async (_req, res) => {
  try {
    const out = await getHopperModelInventory();
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.patch('/models/hopper/metadata', async (req, res) => {
  try {
    const model = ensureSafeModelName(req.body?.model);
    const next = normalizeModelMetadataRecord({
      pinned: req.body?.pinned,
      stage: req.body?.stage,
      note: req.body?.note,
      hidden: req.body?.hidden,
      updated_at: new Date().toISOString(),
    });
    const metadata = await readHopperModelMetadata();
    metadata.models[model] = next;
    await writeHopperModelMetadata(metadata);
    res.json({ ok: true, model, metadata: next });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/models/hopper/remove', async (req, res) => {
  try {
    const model = ensureSafeModelName(req.body?.model);
    const force = req.body?.force === true;
    const inventory = await getHopperModelInventory();
    const record = inventory.models.find((item) => item.name === model);
    if (!record) {
      return res.status(404).json({ error: 'model not found on hopper' });
    }
    if (record.loaded) {
      return res.status(409).json({ error: 'cannot remove a model that is currently loaded' });
    }
    if ((record.metadata.pinned || record.metadata.stage === 'keeper') && !force) {
      return res.status(409).json({ error: 'model is protected; unpin it or move it out of keeper stage first' });
    }

    await runHopperDocker(['exec', HOPPER_OLLAMA_CONTAINER, 'ollama', 'rm', model], { timeoutMs: 45000 });
    const metadata = await readHopperModelMetadata();
    delete metadata.models[model];
    await writeHopperModelMetadata(metadata);
    const refreshed = await getHopperModelInventory();
    res.json({
      ok: true,
      removed: model,
      summary: refreshed.summary,
      disk: refreshed.disk,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/models/hopper/pull', async (req, res) => {
  try {
    const model = ensureSafeModelName(req.body?.model);
    await runHopperDocker(['exec', HOPPER_OLLAMA_CONTAINER, 'ollama', 'pull', model], { timeoutMs: 30 * 60 * 1000 });
    const refreshed = await getHopperModelInventory();
    res.json({
      ok: true,
      pulled: model,
      summary: refreshed.summary,
      disk: refreshed.disk,
    });
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
