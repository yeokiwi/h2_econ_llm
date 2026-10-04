// Zero-dependency server for the H2 Econs Question Lab.
//
// - Reads settings from .env (see .env.example); real environment variables win.
// - Serves index.html, SKILL.md and assets/.
// - Tells the page which OpenRouter model to use (OPENROUTER_MODEL).
// - If OPENROUTER_API_KEY is set, exposes POST /api/chat, which forwards the
//   request to OpenRouter with the server's key so users don't need their own.
//   Set ACCESS_CODE to stop strangers spending your credits.
//
// Usage: cp .env.example .env, edit it, then: node server.js

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader: KEY=value lines, # comments, optional quotes and
// "export " prefix. Variables already set in the environment are kept.
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    out[m[1]] = value;
  }
  return out;
}

const envFile = process.env.ENV_FILE || path.join(ROOT, '.env');
try {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    if (!(k in process.env)) process.env[k] = v;
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.warn(`Could not read ${envFile}: ${e.message}`);
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.OPENROUTER_API_KEY || '';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-5.5';
const MAX_BODY = 2 * 1024 * 1024;
const UPSTREAM = process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Only these paths are public; everything else (e.g. .git, server.js) is not.
function resolveStatic(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p === '/' || p === '') p = '/index.html';
  if (p !== '/index.html' && p !== '/SKILL.md' && !p.startsWith('/assets/')) return null;
  const full = path.normalize(path.join(ROOT, p));
  if (!full.startsWith(path.join(ROOT, path.sep)) || full.split(path.sep).some((s) => s.startsWith('.'))) {
    return null;
  }
  return full;
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(data);
}

function codeMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(ACCESS_CODE);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleChat(req, res) {
  if (!API_KEY) return send(res, 404, { error: { message: 'The server has no OpenRouter key configured.' } });
  if (ACCESS_CODE && !codeMatches(req.headers['x-access-code'])) {
    return send(res, 401, { error: { message: 'Wrong or missing access code.' } });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return send(res, e.status || 400, { error: { message: e.status ? e.message : 'Invalid JSON body' } });
  }
  if (!body || !Array.isArray(body.messages)) {
    return send(res, 400, { error: { message: 'Body needs "messages".' } });
  }
  body.model = MODEL; // the model is fixed by the server's .env, whatever the page sends

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': req.headers.origin || `http://${req.headers.host}`,
        'X-Title': 'H2 Economics Question Generator',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) return;
    return send(res, 502, { error: { message: `Could not reach OpenRouter: ${e.message}` } });
  }

  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body)
    .on('error', () => res.destroy())
    .pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/config') {
      return send(res, 200, { proxy: Boolean(API_KEY), requiresAccessCode: Boolean(API_KEY && ACCESS_CODE), model: MODEL });
    }
    if (url.pathname === '/api/chat') {
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed', { Allow: 'POST' });
      return await handleChat(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    const file = resolveStatic(url.pathname);
    if (!file) return send(res, 404, 'Not found');
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) return send(res, 404, 'Not found');
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: { message: e.message } });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const mode = API_KEY
    ? `proxy mode (server key${ACCESS_CODE ? ', access code required' : ''})`
    : 'browser mode (users enter their own OpenRouter key)';
  console.log(`H2 Econs Question Lab on http://localhost:${server.address().port} — ${mode}, model ${MODEL}`);
});
