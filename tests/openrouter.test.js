import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSSEParser, streamChat } from '../assets/js/openrouter.js';

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
