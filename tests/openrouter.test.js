import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSSEParser, streamChat, reasoningFor } from '../assets/js/openrouter.js';

test('SSE parser handles split chunks, comments, CRLF and [DONE]', () => {
  const got = [];
  const p = createSSEParser((j) => got.push(j));
  assert.equal(p.feed(': OPENROUTER PROCESSING\n\n'), false);
  p.feed('data: {"a":');
  p.feed('1}\r\n\ndata: {"a":2}\n');
  p.feed('data: not json\n');
  assert.equal(p.feed('data: [DONE]\n'), true);
  p.feed('data: {"a":3}\n');
  assert.deepEqual(got, [{ a: 1 }, { a: 2 }]);
});

function sseResponse(events, status = 200) {
  const body = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(body);
  // deliver in awkward 7-byte slices to exercise buffering
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

test('streamChat accumulates content, usage and finish reason', async (t) => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent = { url, init };
    return sseResponse([
      { model: 'm/x', choices: [{ delta: { reasoning: 'hmm' } }] },
      { choices: [{ delta: { content: 'Hello ' } }] },
      { choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] },
      { choices: [], usage: { total_tokens: 42, cost: 0.001 } },
      '[DONE]',
    ]);
  });
  const deltas = [];
  let reasoning = '';
  const r = await streamChat({
    endpoint: 'https://example.test/chat',
    apiKey: 'k',
    body: { model: 'm/x', messages: [] },
    onDelta: (d) => deltas.push(d),
    onReasoning: (d) => (reasoning += d),
  });
  assert.equal(r.content, 'Hello world');
  assert.deepEqual(deltas, ['Hello ', 'world']);
  assert.equal(reasoning, 'hmm');
  assert.equal(r.finishReason, 'stop');
  assert.equal(r.usage.total_tokens, 42);
  assert.equal(r.model, 'm/x');
  assert.equal(sent.init.headers.Authorization, 'Bearer k');
  assert.equal(JSON.parse(sent.init.body).stream, true);
});

test('streamChat surfaces HTTP and mid-stream errors', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ error: { message: 'No auth credentials found' } }), { status: 401 }),
  );
  await assert.rejects(
    streamChat({ endpoint: 'x', body: {}, onDelta() {} }),
    (e) => e.status === 401 && /Invalid or missing API key/.test(e.message),
  );
  fetchMock.mock.mockImplementation(async () =>
    sseResponse([{ choices: [{ delta: { content: 'partial' } }] }, { error: { message: 'Provider overloaded', code: 502 } }]),
  );
  await assert.rejects(streamChat({ endpoint: 'x', body: {}, onDelta() {} }), /Provider overloaded/);
});

test('reasoningFor picks a supported effort, preferring the lower neighbour', () => {
  const sonnet = { reasoning: { supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'] } };
  const gemini = { reasoning: { supported_efforts: ['high', 'medium', 'low', 'minimal'] } };
  const deepseek = { reasoning: { supported_efforts: ['xhigh', 'high'] } };
  const plain = { reasoning: null };
  assert.deepEqual(reasoningFor('low', sonnet), { effort: 'low' });
  assert.deepEqual(reasoningFor('low', gemini), { effort: 'low' });
  assert.deepEqual(reasoningFor('low', deepseek), { effort: 'high' });
  assert.deepEqual(reasoningFor('medium', { reasoning: { supported_efforts: ['low', 'high'] } }), { effort: 'low' });
  assert.equal(reasoningFor('low', plain), undefined); // model doesn't reason
  assert.deepEqual(reasoningFor('low', undefined), { effort: 'low' }); // catalogue not loaded
  assert.equal(reasoningFor('default', sonnet), undefined);
});

test('streamChat reports reasoning_details and stops a stalled stream', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.summary', summary: 'Plan' }] } }] })}\n\n`));
        // then never send anything else, until aborted
        init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return new Response(stream, { status: 200 });
  });
  let reasoning = '';
  await assert.rejects(
    streamChat({ endpoint: 'x', body: {}, onDelta() {}, onReasoning: (r) => (reasoning += r), idleTimeoutMs: 50 }),
    /No data from OpenRouter/,
  );
  assert.equal(reasoning, 'Plan');
});

test('a user abort is reported as AbortError, not a stall', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
  );
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(streamChat({ endpoint: 'x', body: {}, signal: ac.signal, onDelta() {}, idleTimeoutMs: 5000 }), {
    name: 'AbortError',
  });
});
