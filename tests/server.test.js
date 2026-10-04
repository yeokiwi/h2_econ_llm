import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', OPENROUTER_API_KEY: '', ACCESS_CODE: '', ...env },
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
  assert.deepEqual(cfg, { proxy: false });
  const chat = await fetch(`${plain.base}/api/chat`, { method: 'POST', body: '{}' });
  assert.equal(chat.status, 404);
});

test('with a server key, config is advertised and the access code is enforced', async () => {
  const cfg = await (await fetch(`${proxied.base}/api/config`)).json();
  assert.deepEqual(cfg, { proxy: true, requiresAccessCode: true, defaultModel: '' });
  const denied = await fetch(`${proxied.base}/api/chat`, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);
  const bad = await fetch(`${proxied.base}/api/chat`, {
    method: 'POST',
    headers: { 'X-Access-Code': 'secret' },
    body: '{"model": "x"}',
  });
  assert.equal(bad.status, 400);
  const get = await fetch(`${proxied.base}/api/chat`);
  assert.equal(get.status, 405);
});
