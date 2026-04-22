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
const MEMORY_HARVEST_MAX_EVENTS = Math.max(1, Math.min(2000, parseInt(process.env.MEMORY_HARVEST_MAX_EVENTS || '2000', 10)));
const HUGGING_FACE_TIMEOUT_MS = Math.max(1000, parseInt(process.env.HUGGING_FACE_TIMEOUT_MS || '15000', 10));
const SSH_BIN = process.env.SSH_BIN || '/usr/bin/ssh';
const DEFAULT_PLATFORM_ID = process.env.DEFAULT_MODEL_PLATFORM || 'hopper';
const HOPPER_HOST = process.env.HOPPER_HOST || 'mcglothi@hopper.home.timmcg.net';
const HOPPER_POOL_TARGETS = [...new Set(String(process.env.HOPPER_POOL_TARGETS || HOPPER_HOST).split(',').map((item) => item.trim()).filter(Boolean))];
const HOPPER_DOCKER_BIN = process.env.HOPPER_DOCKER_BIN || 'docker';
const HOPPER_OLLAMA_CONTAINER = process.env.HOPPER_OLLAMA_CONTAINER || 'ollama';
const HOPPER_MODEL_DATA_PATH = process.env.HOPPER_MODEL_DATA_PATH || '/opt/containers/ollama/data';
const HOPPER_MODEL_METADATA_PATH = process.env.HOPPER_MODEL_METADATA_PATH || path.join(__dirname, 'data', 'hopper-model-metadata.json');
const HOPPER_MEMORY_RESERVE_BYTES = Math.max(2 * 1024 ** 3, parseInt(process.env.HOPPER_MEMORY_RESERVE_BYTES || String(8 * 1024 ** 3), 10));
const NEWTON_HOST = process.env.NEWTON_HOST || 'svc_ansible@newton.home.timmcg.net';
const NEWTON_POOL_TARGETS = [...new Set(String(process.env.NEWTON_POOL_TARGETS || NEWTON_HOST).split(',').map((item) => item.trim()).filter(Boolean))];
const NEWTON_DOCKER_BIN = process.env.NEWTON_DOCKER_BIN || 'docker';
const NEWTON_OLLAMA_CONTAINER = process.env.NEWTON_OLLAMA_CONTAINER || 'ollama';
const NEWTON_MODEL_DATA_PATH = process.env.NEWTON_MODEL_DATA_PATH || '/opt/containers/ollama/data';
const NEWTON_MODEL_METADATA_PATH = process.env.NEWTON_MODEL_METADATA_PATH || path.join(__dirname, 'data', 'newton-model-metadata.json');
const NEWTON_MEMORY_RESERVE_BYTES = Math.max(2 * 1024 ** 3, parseInt(process.env.NEWTON_MEMORY_RESERVE_BYTES || String(8 * 1024 ** 3), 10));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const PLATFORM_CONFIGS = {
  hopper: {
    id: 'hopper',
    label: 'Hopper',
    host: HOPPER_HOST,
    profile: 'Gigabyte AI Top Atom / DGX Spark variant',
    memoryLabel: '128 GB unified memory',
    poolTargets: HOPPER_POOL_TARGETS,
    dockerBin: HOPPER_DOCKER_BIN,
    ollamaContainer: HOPPER_OLLAMA_CONTAINER,
    modelDataPath: HOPPER_MODEL_DATA_PATH,
    metadataPath: HOPPER_MODEL_METADATA_PATH,
    memoryReserveBytes: HOPPER_MEMORY_RESERVE_BYTES,
    laptimeHardwareId: 'dgx-spark-gb10',
    speedLabel: 'DGX Spark / GB10',
    hostMemoryCommand: 'free -b',
    gpuCommand: 'nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits && nvidia-smi',
  },
  newton: {
    id: 'newton',
    label: 'Newton',
    host: NEWTON_HOST,
    profile: 'MacBook Pro M5 Max',
    memoryLabel: '128 GB unified memory',
    poolTargets: NEWTON_POOL_TARGETS,
    dockerBin: NEWTON_DOCKER_BIN,
    ollamaContainer: NEWTON_OLLAMA_CONTAINER,
    modelDataPath: NEWTON_MODEL_DATA_PATH,
    metadataPath: NEWTON_MODEL_METADATA_PATH,
    memoryReserveBytes: NEWTON_MEMORY_RESERVE_BYTES,
    laptimeHardwareId: process.env.NEWTON_LAPTIME_HARDWARE_ID || 'dgx-spark-gb10',
    speedLabel: process.env.NEWTON_SPEED_LABEL || 'DGX Spark / GB10',
    hostMemoryCommand: 'top -l 1 | grep "PhysMem:"',
    gpuCommand: '', // Newton is M5 Max unified memory, separate GPU metrics are complex without external tools
  },
};

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

function eventLooksSuppressedSessionArtifact(event) {
  const filePath = String(event?.metadata?.file_path || '').toLowerCase();
  const filename = String(event?.metadata?.filename || '').toLowerCase();
  return (
    filePath.includes('rollout-') ||
    filename.includes('rollout-') ||
    filePath.endsWith('failed-events.jsonl') ||
    filename === 'failed-events.jsonl'
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
  const sessionArtifact = eventLooksSuppressedSessionArtifact(event);
  let score = 0;
  let matchedTokens = 0;

  if (['agent_message', 'gemini_chat_message', 'gemini_chat_user', 'message'].includes(eventType)) score += 8;
  if (eventType === 'agent_reasoning' || info.title === 'reasoning') score += 5;
  if (provider === 'gemini' || provider === 'codex' || provider === 'claude') score += 2;
  if (source === 'ai-memory-sync' && !sessionArtifact) score += 1;
  if (info.summary.length >= 48) score += 2;
  if (info.summary.length <= 12) score -= 2;

  if (eventType === 'response_item') score -= 4;
  if (eventType === 'turn_context') score -= 8;
  if (info.category === 'function_call_output') score -= 7;
  if (info.category === 'function_call' || info.category === 'custom_tool_call') score -= 5;
  if (eventLooksNoisy(info.summary)) score -= 8;
  if (sessionArtifact) score -= 16;

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

async function searchAikbHits(query, limit = 8) {
  const tokens = extractQueryTokens(query);
  if (!tokens.length) return [];

  try {
    await fs.access(AIKB_PATH);
  } catch {
    return [];
  }

  const args = ['-n', '-i', '--no-heading', '--max-count', '3', '--hidden'];
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

  const rgOutput = await runRg(args, { timeoutMs: 1600, maxBytes: 420000 });
  if (!rgOutput.trim()) return [];

  const lineHits = rgOutput
    .split('\n')
    .map((line) => {
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (!m) return null;
      const absPath = m[1];
      const relPath = absPath.startsWith(`${AIKB_PATH}/`) ? absPath.slice(AIKB_PATH.length + 1) : absPath;
      return {
        path: relPath,
        line: parseInt(m[2], 10),
        snippet: m[3].trim(),
      };
    })
    .filter(Boolean);

  const deduped = [];
  const seen = new Set();
  for (const hit of lineHits) {
    const key = `${hit.path}:${hit.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(hit);
    if (deduped.length >= limit) break;
  }

  return deduped;
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

function getPlatformConfig(platformId = DEFAULT_PLATFORM_ID) {
  return PLATFORM_CONFIGS[platformId] || PLATFORM_CONFIGS[DEFAULT_PLATFORM_ID] || PLATFORM_CONFIGS.hopper;
}

function listPlatformDescriptors() {
  return Object.values(PLATFORM_CONFIGS).map((platform) => ({
    id: platform.id,
    label: platform.label,
    host: platform.host,
    profile: platform.profile || '',
    memory_label: platform.memoryLabel || '',
    pool_targets: platform.poolTargets,
    laptime_hardware_id: platform.laptimeHardwareId,
    speed_label: platform.speedLabel,
  }));
}

async function readPlatformModelMetadata(platform) {
  try {
    const raw = await fs.readFile(platform.metadataPath, 'utf8');
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

async function writePlatformModelMetadata(platform, payload) {
  const safePayload = payload && typeof payload === 'object' ? payload : { models: {} };
  await fs.mkdir(path.dirname(platform.metadataPath), { recursive: true });
  await fs.writeFile(platform.metadataPath, JSON.stringify(safePayload, null, 2), 'utf8');
}

function ensureSafeModelName(name) {
  const model = String(name || '').trim();
  if (!model) throw new Error('model name required');
  if (!/^[a-zA-Z0-9._:/+-]+$/.test(model)) {
    throw new Error('model name contains unsupported characters');
  }
  return model;
}

function parseParamsFromName(value) {
  const normalized = String(value || '');
  const activeMatch = normalized.match(/A(\d+(?:\.\d+)?)B/i);
  const totalMatch = normalized.match(/(\d+(?:\.\d+)?)B(?![A-Za-z])/i);
  return {
    paramsB: totalMatch ? Number(totalMatch[1]) : null,
    scalingParamsB: activeMatch ? Number(activeMatch[1]) : null,
  };
}

function getQuantBits(quant) {
  const normalized = String(quant || '');
  const match = normalized.match(/q(\d+(?:\.\d+)?)/i);
  if (match) return Number(match[1]);
  if (/mxfp4/i.test(normalized)) return 4;
  if (/\bbf16\b|\bfp16\b|\bf16\b/i.test(normalized)) return 16;
  if (/fp8|int8|q8/i.test(normalized)) return 8;
  return 4;
}

function estimateModelMemoryBytes({ paramsB = 8, quant = 'Q4_K_M', knownBytes = null } = {}) {
  if (Number.isFinite(knownBytes) && knownBytes > 0) {
    return knownBytes;
  }
  const safeParamsB = Math.max(Number(paramsB) || 8, 0.5);
  const quantBits = getQuantBits(quant);
  const baseWeightGb = safeParamsB * (quantBits / 8);
  const overheadMultiplier = safeParamsB >= 30 ? 1.2 : 1.12;
  return Math.round(baseWeightGb * overheadMultiplier * 1024 ** 3);
}

function estimateKvBytesPerToken({ paramsB = null, scalingParamsB = null } = {}) {
  const activeParamsB = Math.max(Number(scalingParamsB) || Number(paramsB) || 8, 0.5);
  return Math.round(activeParamsB * 32768);
}

function calculatePlatformSpeedEstimate(platform, { paramsB = 8, scalingParamsB = null, promptTokens = 1200 } = {}) {
  const effectiveParamsB = Math.max(Number(scalingParamsB) || Number(paramsB) || 8, 0.5);
  const sizeRatio = effectiveParamsB / 8;
  const prefillFactor = Math.max(0.2, sizeRatio ** 0.92);
  const decodeFactor = Math.max(0.22, sizeRatio ** 0.88);
  const ttftFactor = Math.max(0.3, sizeRatio ** 0.72);
  const prefillTps = 2027 / prefillFactor;
  const decodeTps = 34.9 / decodeFactor;
  const ttftMs = 681 * ttftFactor + Math.max(Number(promptTokens) || 0, 0) * 0.16;
  return {
    hardware: platform.laptimeHardwareId,
    source: `LapTime-style modeled estimate from the ${platform.speedLabel} baseline`,
    coverage: 'modeled',
    prefill_tps: Number(prefillTps.toFixed(1)),
    decode_tps: Number(decodeTps.toFixed(1)),
    ttft_ms: Number(ttftMs.toFixed(0)),
  };
}

function normalizeHuggingFaceRepo(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    if (!parsed.hostname.includes('huggingface.co')) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return null;
  } catch {
    const match = normalized.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
    return match ? `${match[1]}/${match[2]}` : null;
  }
}

function extractQuantLabel(value) {
  const normalized = String(value || '');
  const patterns = [
    /MXFP4(?:[_-]MOE)?/i,
    /IQ\d+(?:[_-][A-Z0-9]+)?/i,
    /Q\d+(?:\.\d+)?(?:[_-][A-Z0-9]+)*/i,
    /BF16/i,
    /FP16/i,
    /\bF16\b/i,
    /FP8/i,
    /INT8/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return match[0].replace(/-/g, '_').toUpperCase();
    }
  }

  return null;
}

function isLikelyGgufRepo(payload) {
  const id = String(payload?.id || payload?.modelId || '');
  const tags = Array.isArray(payload?.tags) ? payload.tags : [];
  return /\bgguf\b/i.test(id) || tags.some((tag) => /\bgguf\b/i.test(String(tag)));
}

function getHuggingFaceSearchRank(payload, query) {
  const normalizedQuery = String(query || '').toLowerCase();
  const id = String(payload?.id || payload?.modelId || '').toLowerCase();
  let score = 0;

  if (normalizedQuery && id.startsWith(`${normalizedQuery}/`)) score += 80;
  if (normalizedQuery && id.includes(`/${normalizedQuery}`)) score += 25;
  if (normalizedQuery && id.includes(normalizedQuery)) score += 10;
  if (isLikelyGgufRepo(payload)) score += 35;
  if (typeof payload?.downloads === 'number') score += Math.min(payload.downloads / 50000, 20);
  if (typeof payload?.likes === 'number') score += Math.min(payload.likes / 200, 10);

  return score;
}

function compactHuggingFaceSearchResult(payload) {
  const tags = Array.isArray(payload?.tags) ? payload.tags : [];
  const gguf = extractHuggingFaceGgufFiles(payload);
  return {
    id: payload?.id ?? payload?.modelId,
    pipelineTag: payload?.pipeline_tag ?? null,
    familyLabel: payload?.config?.model_type ?? payload?.library_name ?? 'Model',
    likes: typeof payload?.likes === 'number' ? payload.likes : null,
    downloads: typeof payload?.downloads === 'number' ? payload.downloads : null,
    gguf: isLikelyGgufRepo(payload),
    quantLabels: gguf.quantLabels,
    tags: tags.filter((tag) => ['gguf', 'text-generation', 'conversational', 'safetensors'].includes(String(tag))).slice(0, 4),
  };
}

function extractHuggingFaceGgufFiles(payload) {
  const siblings = Array.isArray(payload?.siblings) ? payload.siblings : [];
  const quants = new Set();
  const files = [];

  for (const sibling of siblings) {
    const filename = String(sibling?.rfilename || sibling?.path || '').trim();
    if (!filename || !filename.toLowerCase().endsWith('.gguf')) continue;
    const quant = extractQuantLabel(filename);
    if (quant) quants.add(quant);
    files.push({
      name: filename.split('/').pop(),
      path: filename,
      quant,
    });
  }

  return {
    files,
    quantLabels: [...quants],
  };
}

function pickPreferredQuantLabel(labels) {
  const priority = ['Q4_K_M', 'Q4_K_S', 'Q5_K_M', 'Q6_K', 'Q8_0', 'IQ4_XS', 'BF16', 'FP16', 'FP8'];
  for (const preferred of priority) {
    if (labels.includes(preferred)) return preferred;
  }
  return labels[0] || '';
}

async function fetchJsonWithTimeout(url, { timeoutMs = 15000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `request failed with ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchContentLength(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: {
        'user-agent': 'AI Hub Platform Fit Probe',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`request failed with ${response.status}`);
    }
    const length = Number(response.headers.get('content-length'));
    return Number.isFinite(length) && length > 0 ? length : null;
  } finally {
    clearTimeout(timer);
  }
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

async function runRemoteCommand(target, command, { timeoutMs = 20000 } = {}) {
  return spawnAndCollect(
    SSH_BIN,
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, command],
    { timeoutMs }
  );
}

async function runPlatformCommand(platform, command, { timeoutMs = 20000 } = {}) {
  return runRemoteCommand(platform.host, command, { timeoutMs });
}

async function runRemoteDocker(target, args, { timeoutMs = 20000, dockerBin = 'docker' } = {}) {
  const command = [dockerBin, ...args].map(shellQuote).join(' ');
  return runRemoteCommand(target, command, { timeoutMs });
}

async function runPlatformDocker(platform, args, { timeoutMs = 20000 } = {}) {
  const command = [platform.dockerBin, ...args].map(shellQuote).join(' ');
  return runRemoteCommand(platform.host, command, { timeoutMs });
}

function parseFreeBytes(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const memLine = lines.find((line) => /^Mem:/i.test(line));
  if (!memLine) return null;
  const parts = memLine.split(/\s+/);
  if (parts.length < 7) return null;
  return {
    total_bytes: Number(parts[1]) || null,
    used_bytes: Number(parts[2]) || null,
    free_bytes: Number(parts[3]) || null,
    available_bytes: Number(parts[6]) || null,
  };
}

function parseRdmaDevices(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines
    .filter((line) => !line.toLowerCase().startsWith('device') && !line.toLowerCase().startsWith('------'))
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

async function getRemoteHostCapacity(target, platform) {
  const [hostnameOut, freeOut, rdmaOut, listOut, psOut] = await Promise.all([
    runRemoteCommand(target, 'hostname', { timeoutMs: 8000 }),
    runRemoteCommand(target, 'free -b', { timeoutMs: 8000 }),
    runRemoteCommand(target, 'if command -v ibv_devices >/dev/null 2>&1; then ibv_devices; fi', { timeoutMs: 8000 }),
    runRemoteDocker(target, ['exec', platform.ollamaContainer, 'ollama', 'list'], { timeoutMs: 25000, dockerBin: platform.dockerBin }).catch(() => ({ stdout: '' })),
    runRemoteDocker(target, ['exec', platform.ollamaContainer, 'ollama', 'ps'], { timeoutMs: 15000, dockerBin: platform.dockerBin }).catch(() => ({ stdout: '' })),
  ]);

  const memory = parseFreeBytes(freeOut.stdout);
  const allModels = parseTable(listOut.stdout);
  const loaded = new Set(parseTable(psOut.stdout).map((row) => row.name).filter(Boolean));
  const loadedModelEntries = allModels
    .filter((row) => loaded.has(row.name || ''))
    .map((row) => ({
      name: row.name || '',
      size_bytes: parseHumanSizeToBytes(row.size || ''),
      size: row.size || '',
    }));
  const loadedModelBytes = loadedModelEntries.reduce((sum, item) => sum + (item.size_bytes || 0), 0);

  return {
    target,
    host: hostnameOut.stdout.trim() || target,
    memory,
    rdma_devices: parseRdmaDevices(rdmaOut.stdout),
    loaded_models: loadedModelEntries,
    loaded_model_bytes: loadedModelBytes,
  };
}

async function getPlatformPoolCapacity(platform) {
  const hosts = await Promise.all(platform.poolTargets.map((target) => getRemoteHostCapacity(target, platform)));
  const totalBytes = hosts.reduce((sum, host) => sum + (host.memory?.total_bytes || 0), 0);
  const availableBytes = hosts.reduce((sum, host) => sum + (host.memory?.available_bytes || 0), 0);
  const loadedModelBytes = hosts.reduce((sum, host) => sum + (host.loaded_model_bytes || 0), 0);
  const rdmaDevices = hosts.flatMap((host) => host.rdma_devices || []);

  return {
    hosts,
    summary: {
      host_count: hosts.length,
      total_bytes: totalBytes,
      available_bytes: availableBytes,
      reserve_bytes: platform.memoryReserveBytes,
      safe_budget_bytes: Math.max(totalBytes - platform.memoryReserveBytes, 0),
      live_usable_bytes: Math.max(availableBytes - platform.memoryReserveBytes, 0),
      loaded_model_bytes: loadedModelBytes,
      rdma_device_count: rdmaDevices.length,
      fabric_enabled: rdmaDevices.length > 0,
    },
  };
}

async function fetchHuggingFaceModel(repo) {
  const [owner, model] = repo.split('/');
  const upstreamUrl = `https://huggingface.co/api/models/${encodeURIComponent(owner)}/${encodeURIComponent(model)}`;
  return fetchJsonWithTimeout(upstreamUrl, {
    timeoutMs: HUGGING_FACE_TIMEOUT_MS,
    headers: {
      accept: 'application/json',
      'user-agent': 'AI Hub Platform Import Proxy',
    },
  });
}

function findGgufFileForQuant(payload, quantLabel = '') {
  const siblings = Array.isArray(payload?.siblings) ? payload.siblings : [];
  const desired = String(quantLabel || '').trim().toUpperCase();
  const ggufFiles = siblings
    .map((sibling) => String(sibling?.rfilename || sibling?.path || '').trim())
    .filter((filename) => filename.toLowerCase().endsWith('.gguf'));
  if (!desired) return ggufFiles[0] || '';
  return ggufFiles.find((filename) => extractQuantLabel(filename) === desired) || '';
}

async function resolveCandidateModelProfile(platform, { model = '', repo = '', quant = '', installedModels = [] } = {}) {
  const safeModel = String(model || '').trim();
  const safeRepo = normalizeHuggingFaceRepo(repo) || (safeModel.startsWith('hf.co/') ? normalizeHuggingFaceRepo(safeModel.replace(/^hf\.co\//i, '').split(':')[0]) : null);
  const inferredQuant = String(quant || '').trim() || (safeModel.includes(':') ? safeModel.split(':').slice(1).join(':') : '');

  const installedRecord = installedModels.find((item) => item.name === safeModel);
  if (installedRecord) {
    const params = parseParamsFromName(installedRecord.name);
    return {
      source: 'installed',
      display_name: installedRecord.name,
      model_ref: installedRecord.name,
      repo: null,
      quant: extractQuantLabel(installedRecord.name) || inferredQuant || '',
      file_size_bytes: installedRecord.size_bytes || null,
      paramsB: params.paramsB,
      scalingParamsB: params.scalingParamsB,
      context_length: null,
      estimate_quality: installedRecord.size_bytes ? 'high' : 'medium',
    };
  }

  if (safeRepo) {
    const payload = await fetchHuggingFaceModel(safeRepo);
    const gguf = extractHuggingFaceGgufFiles(payload);
    const selectedQuant = inferredQuant || pickPreferredQuantLabel(gguf.quantLabels);
    const ggufFile = findGgufFileForQuant(payload, selectedQuant);
    const fileSizeBytes = ggufFile
      ? await fetchContentLength(`https://huggingface.co/${safeRepo}/resolve/main/${ggufFile}`, { timeoutMs: HUGGING_FACE_TIMEOUT_MS }).catch(() => null)
      : null;
    const params = parseParamsFromName(payload.id || payload.modelId || safeRepo);

    return {
      source: 'huggingface',
      display_name: payload.id || payload.modelId || safeRepo,
      model_ref: selectedQuant ? `hf.co/${safeRepo}:${selectedQuant}` : `hf.co/${safeRepo}`,
      repo: safeRepo,
      quant: selectedQuant,
      gguf_file: ggufFile || null,
      file_size_bytes: fileSizeBytes,
      paramsB: params.paramsB,
      scalingParamsB: params.scalingParamsB,
      context_length: Number(payload?.gguf?.context_length) || null,
      estimate_quality: fileSizeBytes ? 'high' : 'medium',
      laptime_link: `https://laptime.run/?hw=${encodeURIComponent(platform.laptimeHardwareId)}&hf=${encodeURIComponent(safeRepo)}${selectedQuant ? `&hfq=${encodeURIComponent(selectedQuant)}` : ''}`,
    };
  }

  const guessedParams = parseParamsFromName(safeModel);
  return {
    source: 'heuristic',
    display_name: safeModel || 'unknown model',
    model_ref: safeModel || '',
    repo: null,
    quant: extractQuantLabel(safeModel) || inferredQuant || '',
    file_size_bytes: null,
    paramsB: guessedParams.paramsB,
    scalingParamsB: guessedParams.scalingParamsB,
    context_length: null,
    estimate_quality: 'low',
    laptime_link: `https://laptime.run/?hw=${encodeURIComponent(platform.laptimeHardwareId)}`,
  };
}

function parseHostMemory(stdout, platformId) {
  if (!stdout) return null;
  if (platformId === 'newton' || stdout.includes('PhysMem:')) {
    // macOS: PhysMem: 40G used (10G wired), 88G unused.
    const usedMatch = stdout.match(/PhysMem:\s+(\d+)([GMBK])\s+used/i);
    const unusedMatch = stdout.match(/(\d+)([GMBK])\s+unused/i);
    if (usedMatch && unusedMatch) {
      const used = parseHumanSizeToBytes(`${usedMatch[1]}${usedMatch[2]}`);
      const free = parseHumanSizeToBytes(`${unusedMatch[1]}${unusedMatch[2]}`);
      return { total_bytes: used + free, used_bytes: used, free_bytes: free };
    }
    return null;
  }
  // Linux (free -b)
  const lines = stdout.trim().split('\n');
  const memLine = lines.find((l) => l.startsWith('Mem:'));
  if (memLine) {
    const parts = memLine.split(/\s+/);
    return {
      total_bytes: parseInt(parts[1], 10),
      used_bytes: parseInt(parts[2], 10),
      free_bytes: parseInt(parts[3], 10) + parseInt(parts[5], 10) + parseInt(parts[6], 10), // free + buffers + cache
    };
  }
  return null;
}

function parseGpuMetrics(stdout, platformId) {
  if (!stdout || platformId !== 'hopper') return null;
  const lines = stdout.trim().split('\n');
  const util = parseInt(lines[0], 10);
  
  // Parse processes to estimate used memory
  const procLines = lines.filter(l => l.includes('MiB') && (l.includes(' C ') || l.includes(' G ')));
  let usedMiB = 0;
  for (const line of procLines) {
    const match = line.match(/(\d+)MiB/);
    if (match) usedMiB += parseInt(match[1], 10);
  }
  
  return {
    utilization_percent: isNaN(util) ? null : util,
    used_bytes: usedMiB * 1024 * 1024,
    total_bytes: 128 * 1024 * 1024 * 1024, // Assumed for GB10 in this lab context
  };
}

async function getPlatformModelInventory(platform) {
  const metadata = await readPlatformModelMetadata(platform);
  const [hostnameOut, dockerPsOut, listOut, psOut, diskOut, hostMemOut, gpuOut] = await Promise.all([
    runPlatformCommand(platform, 'hostname', { timeoutMs: 8000 }),
    runPlatformDocker(platform, ['ps', '--format', 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']),
    runPlatformDocker(platform, ['exec', platform.ollamaContainer, 'ollama', 'list'], { timeoutMs: 25000 }),
    runPlatformDocker(platform, ['exec', platform.ollamaContainer, 'ollama', 'ps'], { timeoutMs: 15000 }),
    runPlatformCommand(platform, `df -B1 ${shellQuote(platform.modelDataPath)}`, { timeoutMs: 8000 }),
    platform.hostMemoryCommand ? runPlatformCommand(platform, platform.hostMemoryCommand, { timeoutMs: 8000 }) : Promise.resolve({ stdout: '' }),
    platform.gpuCommand ? runPlatformCommand(platform, platform.gpuCommand, { timeoutMs: 12000 }) : Promise.resolve({ stdout: '' }),
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
    platform: platform.id,
    platform_label: platform.label,
    host: hostnameOut.stdout.trim() || platform.host,
    target: platform.host,
    ollama_container: platform.ollamaContainer,
    model_data_path: platform.modelDataPath,
    host_memory: parseHostMemory(hostMemOut.stdout, platform.id),
    gpu: parseGpuMetrics(gpuOut.stdout, platform.id),
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

app.post('/memory/proposals/bulk-review', async (req, res) => {
  try {
    const actions = Array.isArray(req.body?.actions) ? req.body.actions.slice(0, 250) : [];
    if (!actions.length) {
      return res.status(400).json({ error: 'actions array required' });
    }

    const allowedStatuses = new Set(['new', 'approved', 'rejected', 'applied']);
    const results = [];

    for (const action of actions) {
      const proposalId = String(action?.proposal_id || '').trim();
      const status = String(action?.status || '').trim();
      const reviewNotes = action?.review_notes == null ? null : String(action.review_notes);
      const appliedFile = action?.applied_file == null ? null : String(action.applied_file);

      if (!proposalId || !allowedStatuses.has(status)) {
        results.push({
          proposal_id: proposalId || null,
          ok: false,
          error: 'invalid proposal_id or status',
        });
        continue;
      }

      try {
        const out = await memoryRequest('PATCH', `/api/v1/proposals/${encodeURIComponent(proposalId)}`, {
          body: {
            status,
            review_notes: reviewNotes,
            applied_file: appliedFile,
          },
        });
        results.push({
          proposal_id: proposalId,
          ok: true,
          proposal: out.proposal || null,
        });
      } catch (err) {
        results.push({
          proposal_id: proposalId,
          ok: false,
          error: err.message,
        });
      }
    }

    const updated = results.filter((item) => item.ok).length;
    const failed = results.length - updated;
    res.json({
      requested: actions.length,
      updated,
      failed,
      results,
    });
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
    const query = String(req.query.q || '');
    const [out, localAikb] = await Promise.all([
      memoryRequest('GET', '/api/v1/search', {
        params: {
          q: query,
          limit: safeLimit,
        },
      }),
      searchAikbHits(query, 8),
    ]);
    const reranked = rerankSearchResults(out, query);
    const mergedAikb = [...(Array.isArray(reranked?.aikb) ? reranked.aikb : []), ...localAikb];
    const dedupedAikb = [];
    const seen = new Set();
    for (const hit of mergedAikb) {
      const key = `${String(hit?.path || '')}:${Number(hit?.line || 0)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedupedAikb.push(hit);
    }
    res.json({
      ...reranked,
      aikb: dedupedAikb.slice(0, 8),
      counts: {
        ...(reranked?.counts || {}),
        aikb: dedupedAikb.slice(0, 8).length,
      },
    });
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
    const requestedMaxEvents = Number(req.body.max_events || MEMORY_HARVEST_MAX_EVENTS);
    const maxEvents = Math.max(1, Math.min(2000, Number.isFinite(requestedMaxEvents) ? requestedMaxEvents : MEMORY_HARVEST_MAX_EVENTS));
    const out = await memoryRequest('POST', '/api/v1/proposals/harvest', {
      body: {
        max_events: maxEvents,
        state_name: String(req.body.state_name || 'default'),
      },
    });
    const cursorTs = Number(out?.cursor?.last_event_ts || 0);
    res.json({
      ...out,
      max_events: maxEvents,
      cursor_iso: cursorTs ? new Date(cursorTs * 1000).toISOString() : null,
    });
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

app.get('/models/platforms', async (_req, res) => {
  res.json({
    default_platform: getPlatformConfig(DEFAULT_PLATFORM_ID).id,
    platforms: listPlatformDescriptors(),
  });
});

app.get(['/models/hopper', '/models/:platform'], async (req, res) => {
  try {
    const platform = getPlatformConfig(req.params.platform || 'hopper');
    const out = await getPlatformModelInventory(platform);
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.patch(['/models/hopper/metadata', '/models/:platform/metadata'], async (req, res) => {
  try {
    const platform = getPlatformConfig(req.params.platform || 'hopper');
    const model = ensureSafeModelName(req.body?.model);
    const next = normalizeModelMetadataRecord({
      pinned: req.body?.pinned,
      stage: req.body?.stage,
      note: req.body?.note,
      hidden: req.body?.hidden,
      updated_at: new Date().toISOString(),
    });
    const metadata = await readPlatformModelMetadata(platform);
    metadata.models[model] = next;
    await writePlatformModelMetadata(platform, metadata);
    res.json({ ok: true, platform: platform.id, model, metadata: next });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post(['/models/hopper/remove', '/models/:platform/remove'], async (req, res) => {
  try {
    const platform = getPlatformConfig(req.params.platform || 'hopper');
    const model = ensureSafeModelName(req.body?.model);
    const force = req.body?.force === true;
    const inventory = await getPlatformModelInventory(platform);
    const record = inventory.models.find((item) => item.name === model);
    if (!record) {
      return res.status(404).json({ error: `model not found on ${platform.label.toLowerCase()}` });
    }
    if (record.loaded) {
      return res.status(409).json({ error: 'cannot remove a model that is currently loaded' });
    }
    if ((record.metadata.pinned || record.metadata.stage === 'keeper') && !force) {
      return res.status(409).json({ error: 'model is protected; unpin it or move it out of keeper stage first' });
    }

    await runPlatformDocker(platform, ['exec', platform.ollamaContainer, 'ollama', 'rm', model], { timeoutMs: 45000 });
    const metadata = await readPlatformModelMetadata(platform);
    delete metadata.models[model];
    await writePlatformModelMetadata(platform, metadata);
    const refreshed = await getPlatformModelInventory(platform);
    res.json({
      ok: true,
      platform: platform.id,
      removed: model,
      summary: refreshed.summary,
      disk: refreshed.disk,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post(['/models/hopper/pull', '/models/:platform/pull'], async (req, res) => {
  try {
    const platform = getPlatformConfig(req.params.platform || 'hopper');
    const model = ensureSafeModelName(req.body?.model);
    await runPlatformDocker(platform, ['exec', platform.ollamaContainer, 'ollama', 'pull', model], { timeoutMs: 30 * 60 * 1000 });
    const refreshed = await getPlatformModelInventory(platform);
    res.json({
      ok: true,
      platform: platform.id,
      pulled: model,
      summary: refreshed.summary,
      disk: refreshed.disk,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post(['/models/hopper/load', '/models/:platform/load'], async (req, res) => {
  try {
    const platform = getPlatformConfig(req.params.platform || 'hopper');
    const model = ensureSafeModelName(req.body?.model);
    const keepAlive = String(req.body?.keep_alive || '1h');
    
    // Use 'ollama run --keepalive <duration> <model> ""' to trigger a load without producing output
    await runPlatformDocker(platform, [
      'exec', 
      platform.ollamaContainer, 
      'ollama', 
      'run', 
      '--keepalive', 
      keepAlive, 
      model, 
      ''
    ], { timeoutMs: 60000 });
    
    const refreshed = await getPlatformModelInventory(platform);
    res.json({
      ok: true,
      platform: platform.id,
      loaded: model,
      keep_alive: keepAlive,
      summary: refreshed.summary,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get(['/models/hopper/huggingface/search', '/models/:platform/huggingface/search'], async (req, res) => {
  try {
    const platform = getPlatformConfig(req.params.platform || 'hopper');
    const query = String(req.query?.q || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'Expected q=<search terms>.' });
    }

    const upstreamUrl = new URL('https://huggingface.co/api/models');
    upstreamUrl.searchParams.set('search', query);
    upstreamUrl.searchParams.set('limit', '12');
    upstreamUrl.searchParams.set('full', 'true');
    upstreamUrl.searchParams.set('config', 'true');

    const payload = await fetchJsonWithTimeout(upstreamUrl, {
      timeoutMs: HUGGING_FACE_TIMEOUT_MS,
      headers: {
        accept: 'application/json',
        'user-agent': `AI Hub ${platform.label} Search Proxy`,
      },
    });

    const results = Array.isArray(payload)
      ? payload
          .filter((entry) => entry?.id && !entry.private && !entry.gated && !entry.disabled)
          .sort((left, right) => getHuggingFaceSearchRank(right, query) - getHuggingFaceSearchRank(left, query))
          .slice(0, 8)
          .map(compactHuggingFaceSearchResult)
      : [];

    res.json({ platform: platform.id, query, results });
  } catch (err) {
    res.status(502).json({ error: `Unable to search Hugging Face right now: ${err.message}` });
  }
});

app.get(['/models/hopper/huggingface/model', '/models/:platform/huggingface/model'], async (req, res) => {
  try {
    const platform = getPlatformConfig(req.params.platform || 'hopper');
    const repo = normalizeHuggingFaceRepo(req.query?.repo);
    if (!repo) {
      return res.status(400).json({ error: 'Expected repo=<owner>/<model>.' });
    }

    const [owner, model] = repo.split('/');
    const upstreamUrl = `https://huggingface.co/api/models/${encodeURIComponent(owner)}/${encodeURIComponent(model)}`;
    const payload = await fetchJsonWithTimeout(upstreamUrl, {
      timeoutMs: HUGGING_FACE_TIMEOUT_MS,
      headers: {
        accept: 'application/json',
        'user-agent': `AI Hub ${platform.label} Import Proxy`,
      },
    });

    const gguf = extractHuggingFaceGgufFiles(payload);
    const suggestedQuant = pickPreferredQuantLabel(gguf.quantLabels);
    const defaultImportRef = suggestedQuant ? `hf.co/${repo}:${suggestedQuant}` : `hf.co/${repo}`;

    res.json({
      platform: platform.id,
      id: payload.id ?? payload.modelId,
      modelId: payload.modelId ?? payload.id,
      pipelineTag: payload.pipeline_tag ?? null,
      private: Boolean(payload.private),
      gated: Boolean(payload.gated),
      disabled: Boolean(payload.disabled),
      tags: Array.isArray(payload.tags) ? payload.tags : [],
      config: payload.config ?? {},
      cardData: payload.cardData ?? {},
      likes: typeof payload.likes === 'number' ? payload.likes : null,
      downloads: typeof payload.downloads === 'number' ? payload.downloads : null,
      ggufFiles: gguf.files,
      quantLabels: gguf.quantLabels,
      suggestedQuant,
      defaultImportRef,
    });
  } catch (err) {
    res.status(502).json({ error: `Unable to reach Hugging Face right now: ${err.message}` });
  }
});

app.post(['/models/hopper/fit', '/models/:platform/fit'], async (req, res) => {
  try {
    const platform = getPlatformConfig(req.params.platform || 'hopper');
    const inventory = await getPlatformModelInventory(platform);
    const candidate = await resolveCandidateModelProfile(platform, {
      model: req.body?.model,
      repo: req.body?.repo,
      quant: req.body?.quant,
      installedModels: inventory.models,
    });
    const pool = await getPlatformPoolCapacity(platform);
    const promptTokens = Math.max(0, parseInt(req.body?.promptTokens || '1200', 10) || 1200);
    const responseTokens = Math.max(0, parseInt(req.body?.responseTokens || '220', 10) || 220);
    const candidateBytes = estimateModelMemoryBytes({
      paramsB: candidate.paramsB,
      quant: candidate.quant,
      knownBytes: candidate.file_size_bytes,
    });
    const kvBytesPerToken = estimateKvBytesPerToken({
      paramsB: candidate.paramsB,
      scalingParamsB: candidate.scalingParamsB,
    });
    const speed = calculatePlatformSpeedEstimate(platform, {
      paramsB: candidate.paramsB,
      scalingParamsB: candidate.scalingParamsB,
      promptTokens,
    });

    const safeBudgetBytes = pool.summary.safe_budget_bytes;
    const availableNowBytes = pool.summary.live_usable_bytes;
    const loadedBytes = pool.summary.loaded_model_bytes;
    const projectedBytes = loadedBytes + candidateBytes;
    const remainingAfterLoadBytes = Math.max(safeBudgetBytes - projectedBytes, 0);
    const additionalSameModelCount = candidateBytes > 0 ? Math.floor(remainingAfterLoadBytes / candidateBytes) : 0;
    const estimatedContextCapacityTokens = kvBytesPerToken > 0 ? Math.floor(remainingAfterLoadBytes / kvBytesPerToken) : null;
    const advertisedContextTokens = candidate.context_length;
    const fullAdvertisedContextFits = advertisedContextTokens == null
      ? null
      : estimatedContextCapacityTokens != null && estimatedContextCapacityTokens >= advertisedContextTokens;
    const status = projectedBytes > safeBudgetBytes
      ? 'unfit'
      : projectedBytes > safeBudgetBytes * 0.9
        ? 'tight'
        : 'fit';

    res.json({
      ok: true,
      platform: platform.id,
      platform_label: platform.label,
      candidate: {
        ...candidate,
        footprint_bytes: candidateBytes,
        footprint: formatBytes(candidateBytes),
      },
      pool: {
        ...pool.summary,
        total: formatBytes(pool.summary.total_bytes),
        available_now: formatBytes(availableNowBytes),
        safe_budget: formatBytes(safeBudgetBytes),
        reserve: formatBytes(pool.summary.reserve_bytes),
        loaded_models: formatBytes(loadedBytes),
      },
      hosts: pool.hosts.map((host) => ({
        target: host.target,
        host: host.host,
        total_bytes: host.memory?.total_bytes || null,
        total: formatBytes(host.memory?.total_bytes),
        available_bytes: host.memory?.available_bytes || null,
        available: formatBytes(host.memory?.available_bytes),
        rdma_devices: host.rdma_devices || [],
        loaded_model_count: host.loaded_models?.length || 0,
        loaded_model_bytes: host.loaded_model_bytes || 0,
        loaded_models: formatBytes(host.loaded_model_bytes || 0),
      })),
      fit: {
        status,
        fits_now: projectedBytes <= safeBudgetBytes,
        currently_safe: candidateBytes <= availableNowBytes,
        projected_bytes: projectedBytes,
        projected: formatBytes(projectedBytes),
        remaining_after_load_bytes: remainingAfterLoadBytes,
        remaining_after_load: formatBytes(remainingAfterLoadBytes),
        additional_same_model_count: additionalSameModelCount,
        estimate_quality: candidate.estimate_quality,
        message: projectedBytes > safeBudgetBytes
          ? `This looks unsafe right now. Estimated footprint is ${formatBytes(projectedBytes)} against a guarded pool budget of ${formatBytes(safeBudgetBytes)}.`
          : projectedBytes > safeBudgetBytes * 0.9
            ? `This is a tight fit. Estimated post-load usage is ${formatBytes(projectedBytes)} with about ${formatBytes(remainingAfterLoadBytes)} left for cache and runtime breathing room.`
            : `This looks safe to try. Estimated post-load usage is ${formatBytes(projectedBytes)} with about ${formatBytes(remainingAfterLoadBytes)} left for cache and concurrency.`,
      },
      context: {
        advertised_tokens: advertisedContextTokens,
        estimated_capacity_tokens: estimatedContextCapacityTokens,
        full_advertised_context_fits: fullAdvertisedContextFits,
        kv_bytes_per_token: kvBytesPerToken,
        kv_per_1k_tokens: formatBytes(kvBytesPerToken * 1000),
      },
      speed,
      simulation: {
        laptime_url: candidate.laptime_link || `https://laptime.run/?hw=${encodeURIComponent(platform.laptimeHardwareId)}`,
        prompt_tokens: promptTokens,
        response_tokens: responseTokens,
      },
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
