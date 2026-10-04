// Minimal OpenRouter chat-completions client with SSE streaming.

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const MODELS_URL = 'https://openrouter.ai/api/v1/models';

// Incremental parser for a text/event-stream body. Calls onData with each
// parsed JSON payload, and returns true from feed() once [DONE] is seen.
export function createSSEParser(onData) {
  let buffer = '';
  let done = false;

  function handleLine(line) {
    if (done || !line.startsWith('data:')) return; // comments (": ...") and other fields
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return; // ignore malformed keep-alive fragments
    }
    onData(json);
  }

  return {
    feed(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
      return done;
    },
    flush() {
      if (buffer) handleLine(buffer.replace(/\r$/, ''));
      buffer = '';
      return done;
    },
  };
}

export class OpenRouterError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
  }
}

async function errorFromResponse(res) {
  let message = `${res.status} ${res.statusText}`;
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      message = json?.error?.message || json?.message || text || message;
    } catch {
      if (text) message = text.slice(0, 500);
    }
  } catch {
    /* keep the status line */
  }
  if (res.status === 401) message = `Invalid or missing API key (${message})`;
  if (res.status === 402) message = `Insufficient OpenRouter credits (${message})`;
  return new OpenRouterError(message, res.status);
}

/**
 * Streams a chat completion.
 * @param {object} opts
 * @param {string} opts.endpoint  OpenRouter URL, or the local proxy ("api/chat")
 * @param {string} [opts.apiKey]  user's OpenRouter key (omit when using the proxy)
 * @param {string} [opts.accessCode]  access code for the proxy, if it requires one
 * @param {object} opts.body      chat-completions request body (stream is forced on)
 * @param {AbortSignal} [opts.signal]
 * @param {(text: string) => void} opts.onDelta      content tokens
 * @param {(text: string) => void} [opts.onReasoning] reasoning tokens, if the model emits them
 * @returns {Promise<{content: string, usage: object|null, model: string|null, finishReason: string|null}>}
 */
export async function streamChat({ endpoint, apiKey, accessCode, body, signal, onDelta, onReasoning }) {
  const headers = { 'Content-Type': 'application/json', 'X-Title': 'H2 Economics Question Generator' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (accessCode) headers['X-Access-Code'] = accessCode;
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
    headers['HTTP-Referer'] = location.origin;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, stream: true, usage: { include: true } }),
    signal,
  });
  if (!res.ok) throw await errorFromResponse(res);
  if (!res.body) throw new OpenRouterError('The response had no body to stream.', res.status);

  let content = '';
  let usage = null;
  let model = null;
  let finishReason = null;
  let streamError = null;

  const parser = createSSEParser((json) => {
    if (json.error) {
      streamError = new OpenRouterError(json.error.message || 'Streaming error', json.error.code);
      return;
    }
    if (json.model) model = json.model;
    if (json.usage) usage = json.usage;
    const choice = json.choices && json.choices[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.reasoning && onReasoning) onReasoning(delta.reasoning);
    if (delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (parser.feed(decoder.decode(value, { stream: true }))) break;
    if (streamError) break;
  }
  parser.feed(decoder.decode());
  parser.flush();
  reader.cancel().catch(() => {});

  if (streamError) throw streamError;
  if (finishReason === 'error') throw new OpenRouterError('The model stopped with an error.', null);
  return { content, usage, model, finishReason };
}

export async function fetchModels(signal) {
  const res = await fetch(MODELS_URL, { signal });
  if (!res.ok) throw await errorFromResponse(res);
  const json = await res.json();
  return (json.data || [])
    .filter((m) => !m.id.endsWith(':batch'))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      context: m.context_length || 0,
      promptPrice: Number(m.pricing?.prompt) || 0,
      completionPrice: Number(m.pricing?.completion) || 0,
    }));
}
