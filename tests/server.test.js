import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));

const tmp = mkdtempSync(path.join(tmpdir(), 'h2econ-'));
const { OPENROUTER_MODEL, OPENROUTER_URL, ...cleanEnv } = process.env;

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...cleanEnv,
        HOST: '127.0.0.1',
        PORT: '0',
        OPENROUTER_API_KEY: '',
        ACCESS_CODE: '',
        ENV_FILE: path.join(tmp, 'missing.env'), // never read the developer's real .env
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => {
      const m = /localhost:(\d+)/.exec(String(d));
      if (m) resolve({ child, base: `http://127.0.0.1:${m[1]}` });
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}

let plain;
let proxied;

before(async () => {
  plain = await startServer({});
  proxied = await startServer({ OPENROUTER_API_KEY: 'sk-test', ACCESS_CODE: 'secret' });
});

after(() => {
  plain.child.kill();
  proxied.child.kill();
});

test('serves the site and the skill file', async () => {
  const index = await fetch(`${plain.base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const skill = await fetch(`${plain.base}/SKILL.md`);
  assert.equal(skill.status, 200);
  assert.match(await skill.text(), /H2 Economics/);
  const js = await fetch(`${plain.base}/assets/js/app.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('does not serve files outside the allow-list', async () => {
  for (const p of ['/server.js', '/package.json', '/.git/config', '/assets/../server.js', '/assets/%2e%2e/server.js', '/%E0%A4%A']) {
    const res = await fetch(`${plain.base}${p}`);
    assert.equal(res.status, 404, p);
  }
});

test('without a server key, the proxy is off', async () => {
  const cfg = await (await fetch(`${plain.base}/api/config`)).json();
  assert.deepEqual(cfg, { proxy: false, requiresAccessCode: false, model: 'anthropic/claude-sonnet-5.5' });
  const chat = await fetch(`${plain.base}/api/chat`, { method: 'POST', body: '{}' });
  assert.equal(chat.status, 404);
});

test('with a server key, config is advertised and the access code is enforced', async () => {
  const cfg = await (await fetch(`${proxied.base}/api/config`)).json();
  assert.deepEqual(cfg, { proxy: true, requiresAccessCode: true, model: 'anthropic/claude-sonnet-5.5' });
  const denied = await fetch(`${proxied.base}/api/chat`, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);
  const bad = await fetch(`${proxied.base}/api/chat`, {
    method: 'POST',
    headers: { 'X-Access-Code': 'secret' },
    body: '{"model": "x"}', // no messages
  });
  assert.equal(bad.status, 400);
  const get = await fetch(`${proxied.base}/api/chat`);
  assert.equal(get.status, 405);
});

test('.env sets the model; shell variables take precedence', async () => {
  const envFile = path.join(tmp, 'test.env');
  writeFileSync(
    envFile,
    ['# comment', 'export OPENROUTER_MODEL="openai/gpt-5.5"  ', 'ACCESS_CODE=abc # trailing comment', 'BROKEN LINE'].join('\n'),
  );
  const fromFile = await startServer({ ENV_FILE: envFile });
  const fromShell = await startServer({ ENV_FILE: envFile, OPENROUTER_MODEL: 'google/gemini-3.5-flash' });
  try {
    assert.equal((await (await fetch(`${fromFile.base}/api/config`)).json()).model, 'openai/gpt-5.5');
    assert.equal((await (await fetch(`${fromShell.base}/api/config`)).json()).model, 'google/gemini-3.5-flash');
  } finally {
    fromFile.child.kill();
    fromShell.child.kill();
  }
});

test('the proxy always sends the .env model upstream, whatever the page asks for', async () => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    received = { auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const envFile = path.join(tmp, 'proxy.env');
  writeFileSync(envFile, 'OPENROUTER_MODEL=deepseek/deepseek-v4-pro\n');
  const srv = await startServer({
    ENV_FILE: envFile,
    OPENROUTER_API_KEY: 'sk-server',
    OPENROUTER_URL: `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,
  });
  try {
    const res = await fetch(`${srv.base}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ model: 'openai/gpt-5.5-pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /\[DONE\]/);
    assert.equal(received.body.model, 'deepseek/deepseek-v4-pro');
    assert.equal(received.auth, 'Bearer sk-server');
  } finally {
    srv.child.kill();
    upstream.close();
  }
});
