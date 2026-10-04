import { THEMES } from './syllabus.js';
import {
  DEFAULT_SETTINGS,
  ANSWER_MARKER,
  REVEAL_ANSWERS_PROMPT,
  buildMessages,
  buildSystemPrompt,
  buildUserPrompt,
  splitAnswers,
  extractTitle,
} from './prompts.js';
import { OPENROUTER_URL, streamChat, fetchModels } from './openrouter.js';
import { parseChartSpec, createChartFigure, chartsToTables } from './charts.js';

const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';
const SUGGESTED_MODELS = [
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-opus-5.5',
  'openai/gpt-5.5',
  'google/gemini-3.5-flash',
  'deepseek/deepseek-v4-pro',
];
const HISTORY_LIMIT = 25;

const $ = (sel) => document.querySelector(sel);
const form = $('#genForm');

// ---------- storage helpers (storage can be unavailable; never let it break the page) ----------
const store = {
  get(key, fallback = null, area = 'localStorage') {
    try {
      const v = window[area].getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value, area = 'localStorage') {
    try {
      window[area].setItem(key, JSON.stringify(value));
    } catch {
      /* quota or privacy mode */
    }
  },
  remove(key, area = 'localStorage') {
    try {
      window[area].removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

// ---------- app state ----------
const state = {
  skill: '',
  proxy: null, // { requiresAccessCode, defaultModel } when served by server.js
  apiKey: store.get('h2econ.apiKey') || store.get('h2econ.apiKey', null, 'sessionStorage') || '',
  accessCode: store.get('h2econ.accessCode', null, 'sessionStorage') || '',
  session: null, // { id, createdAt, settings, model, title, turns: [{role, content, kind, usage, model, finishReason}] }
  answersRevealed: false,
  controller: null,
  busy: false,
};

// ---------- Markdown rendering ----------
const chartCache = new Map(); // spec text -> figure element, so streaming re-renders don't redraw charts

function renderMarkdown(target, markdown, { streaming = false } = {}) {
  if (!window.marked || !window.DOMPurify) {
    target.textContent = markdown;
    return;
  }
  const html = window.marked.parse(markdown, { gfm: true, breaks: false });
  target.innerHTML = window.DOMPurify.sanitize(html);

  target.querySelectorAll('pre > code.language-chart').forEach((code) => {
    const text = code.textContent;
    const pre = code.parentElement;
    let figure = chartCache.get(text);
    if (!figure) {
      const parsed = parseChartSpec(text);
      if (!parsed.ok) {
        if (streaming) {
          const ph = document.createElement('div');
          ph.className = 'chart-placeholder';
          ph.textContent = 'Drawing figure…';
          pre.replaceWith(ph);
        } else {
          const note = document.createElement('p');
          note.className = 'muted small';
          note.textContent = `Could not draw this figure (${parsed.error}). Raw data:`;
          pre.before(note);
        }
        return;
      }
      figure = createChartFigure(parsed.spec);
      chartCache.set(text, figure);
      pre.replaceWith(figure);
      figure._draw();
      return;
    }
    pre.replaceWith(figure);
  });

  target.querySelectorAll('table').forEach((t) => {
    if (t.closest('.chart-figure') || t.parentElement.classList.contains('table-scroll')) return;
    const wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    t.replaceWith(wrap);
    wrap.append(t);
  });
}

function redrawCharts() {
  chartCache.forEach((figure) => {
    if (figure.isConnected) figure._draw();
  });
}

// ---------- form ----------
function buildTopicPicker() {
  const container = $('#topics');
  for (const theme of THEMES) {
    const details = document.createElement('details');
    details.className = 'topic-group';
    details.open = theme.id === 'T2';
    const summary = document.createElement('summary');
    summary.innerHTML = `<span></span><small class="group-count"></small>`;
    summary.firstChild.textContent = theme.title;
    details.append(summary);
    for (const t of theme.topics) {
      const label = document.createElement('label');
      label.className = 'check';
      label.innerHTML = `<input type="checkbox" name="topics"> <span><b></b> </span>`;
      label.querySelector('input').value = t.code;
      label.querySelector('b').textContent = t.code;
      label.querySelector('span').append(t.label);
      details.append(label);
    }
    container.append(details);
  }
  container.addEventListener('change', updateTopicCount);
  $('#clearTopics').addEventListener('click', () => {
    form.querySelectorAll('input[name="topics"]').forEach((i) => (i.checked = false));
    updateTopicCount();
  });
}

function updateTopicCount() {
  const checked = form.querySelectorAll('input[name="topics"]:checked').length;
  $('#topicCount').textContent = checked ? `${checked} selected` : "Examiner's choice";
  document.querySelectorAll('.topic-group').forEach((g) => {
    const n = g.querySelectorAll('input:checked').length;
    g.querySelector('.group-count').textContent = n ? `${n} selected` : '';
  });
}

function readSettings() {
  const fd = new FormData(form);
  return {
    type: fd.get('type'),
    topics: fd.getAll('topics'),
    context: fd.get('context'),
    customContext: fd.get('customContext') || '',
    output: fd.get('output'),
    answerStyle: fd.get('answerStyle'),
    difficulty: fd.get('difficulty'),
    essaySection: fd.get('essaySection'),
    essayCount: Number(fd.get('essayCount')),
    shortCount: Number(fd.get('shortCount')),
    shortMarks: fd.get('shortMarks'),
    notes: fd.get('notes') || '',
  };
}

function readModelOptions() {
  const fd = new FormData(form);
  const model = String(fd.get('model') || '').trim() || state.proxy?.defaultModel || DEFAULT_MODEL;
  const temperature = Number(fd.get('temperature'));
  const maxTokens = Number(fd.get('maxTokens')) || 16000;
  return { model, temperature, maxTokens };
}

function writeSettings(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const setVal = (name, value) => {
    const fields = form.elements[name];
    if (!fields) return;
    if (fields instanceof RadioNodeList) {
      fields.forEach((f) => {
        if (f.type === 'checkbox') f.checked = Array.isArray(value) && value.includes(f.value);
        else f.checked = f.value === String(value);
      });
    } else if (fields.type === 'checkbox') {
      fields.checked = Array.isArray(value) && value.includes(fields.value);
    } else {
      fields.value = value;
    }
  };
  for (const [k, v] of Object.entries(s)) setVal(k, v);
  syncFormVisibility();
  updateTopicCount();
}

function syncFormVisibility() {
  const type = form.elements.type.value;
  document.querySelectorAll('[data-show-for]').forEach((el) => {
    el.hidden = el.dataset.showFor !== type;
  });
  const questionsOnly = form.elements.output.value === 'questions';
  form.elements.answerStyle.disabled = questionsOnly;
  $('#answerStyleField').classList.toggle('disabled', questionsOnly);
}

function persistForm() {
  store.set('h2econ.form', { settings: readSettings(), ...readModelOptions() });
}

function restoreForm() {
  const saved = store.get('h2econ.form');
  if (saved) {
    writeSettings(saved.settings || {});
    if (saved.model) form.elements.model.value = saved.model;
    if (saved.temperature !== undefined) form.elements.temperature.value = saved.temperature;
    if (saved.maxTokens) form.elements.maxTokens.value = saved.maxTokens;
  }
  $('#tempOut').textContent = form.elements.temperature.value;
  syncFormVisibility();
}

// ---------- connection ----------
function hasCredentials() {
  return Boolean(state.apiKey || state.proxy);
}

function connection() {
  if (state.apiKey) return { endpoint: OPENROUTER_URL, apiKey: state.apiKey };
  if (state.proxy) return { endpoint: 'api/chat', accessCode: state.accessCode };
  return null;
}

function updateKeyDot() {
  const dot = $('#keyDot');
  dot.classList.toggle('ok', hasCredentials());
  $('#settingsBtn').title = state.apiKey
    ? 'Using your OpenRouter key'
    : state.proxy
      ? "Using the server's OpenRouter key"
      : 'No API key set';
}

async function detectProxy() {
  try {
    const res = await fetch('api/config', { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const json = await res.json();
    if (json && json.proxy) {
      state.proxy = { requiresAccessCode: !!json.requiresAccessCode, defaultModel: json.defaultModel || '' };
      $('#proxyNote').textContent =
        "This server already holds an OpenRouter key, so you don't need your own. If you enter a key here, requests go straight to OpenRouter with it instead.";
      $('#accessCodeField').hidden = !state.proxy.requiresAccessCode;
      if (state.proxy.defaultModel) form.elements.model.placeholder = state.proxy.defaultModel;
    }
  } catch {
    /* static hosting: no proxy */
  }
  updateKeyDot();
}

async function loadSkill() {
  try {
    const res = await fetch('SKILL.md', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    state.skill = text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  } catch (e) {
    showBanner(
      `Could not load SKILL.md (${e.message}). Open the site through a web server, e.g. <code>npm start</code> or <code>python3 -m http.server</code>, not by double-clicking the file.`,
      'error',
    );
  }
}

async function loadModels() {
  const list = $('#modelList');
  const add = (id, label) => {
    const opt = document.createElement('option');
    opt.value = id;
    if (label) opt.label = label;
    list.append(opt);
  };
  SUGGESTED_MODELS.forEach((id) => add(id, 'Suggested'));
  try {
    const models = await fetchModels();
    const known = new Set(SUGGESTED_MODELS);
    models
      .filter((m) => !known.has(m.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach((m) => add(m.id, m.name));
    $('#modelHint').textContent = `${models.length} models available. Type to search, e.g. "claude", "gpt", "gemini".`;
  } catch {
    /* offline or blocked: the suggested list is enough */
  }
}

// ---------- UI helpers ----------
function showBanner(html, kind = 'info') {
  const b = $('#banner');
  b.className = `banner banner-${kind}`;
  b.innerHTML = html;
  b.hidden = false;
}

function hideBanner() {
  $('#banner').hidden = true;
}

function setStatus(text, kind = 'info') {
  const s = $('#status');
  if (!text) {
    s.hidden = true;
    return;
  }
  s.className = `status status-${kind}`;
  s.textContent = text;
  s.hidden = false;
}

function setBusy(busy) {
  state.busy = busy;
  $('#generateBtn').disabled = busy;
  $('#generateBtn').textContent = busy ? 'Generating…' : 'Generate';
  $('#stopBtn').hidden = !busy;
  for (const id of ['#regenBtn', '#followupBtn', '#genAnswersBtn', '#continueBtn']) $(id).disabled = busy;
  document.body.classList.toggle('is-busy', busy);
}

function formatUsage(turn) {
  const bits = [];
  if (turn.model) bits.push(turn.model);
  const u = turn.usage;
  if (u) {
    if (u.total_tokens) bits.push(`${u.total_tokens.toLocaleString('en-GB')} tokens`);
    if (typeof u.cost === 'number') bits.push(`US$${u.cost.toFixed(u.cost < 0.01 ? 4 : 3)}`);
  }
  return bits.join(' · ');
}

// ---------- rendering the session ----------
function firstAssistantIndex(turns) {
  return turns.findIndex((t) => t.role === 'assistant');
}

// The paper is the first reply; a later "answers" turn supplies its hidden answers.
function paperParts(session, streaming = false) {
  const idx = firstAssistantIndex(session.turns);
  const first = idx >= 0 ? session.turns[idx].content : '';
  const split = splitAnswers(first, { streaming });
  const answersTurn = session.turns.find((t) => t.role === 'assistant' && t.kind === 'answers');
  if (!split.hasAnswers && answersTurn) {
    const extra = splitAnswers(answersTurn.content, { streaming });
    return { questions: split.questions, answers: extra.hasAnswers ? extra.answers : extra.questions, hasAnswers: true };
  }
  return split;
}

function renderSession({ streaming = false } = {}) {
  const session = state.session;
  $('#emptyState').hidden = !!session;
  $('#doc').hidden = !session;
  if (!session) return;

  const parts = paperParts(session, streaming);
  renderMarkdown($('#questions'), parts.questions || '', { streaming });

  const answersBlock = $('#answersBlock');
  answersBlock.hidden = !parts.hasAnswers;
  if (parts.hasAnswers) {
    renderMarkdown($('#answers'), parts.answers || '', { streaming });
    $('#answers').hidden = !state.answersRevealed;
    $('#revealBtn').textContent = state.answersRevealed ? 'Hide answers' : 'Reveal answers';
    const words = (parts.answers.match(/\S+/g) || []).length;
    $('#answersNote').textContent = state.answersRevealed
      ? ''
      : streaming
        ? `Writing answers… ${words.toLocaleString('en-GB')} words so far. Try the questions first.`
        : `Hidden so you can attempt the questions first (${words.toLocaleString('en-GB')} words).`;
  }

  const firstIdx = firstAssistantIndex(session.turns);
  const first = session.turns[firstIdx];
  const wantedAnswers = session.settings.output !== 'questions';
  $('#answerActions').hidden = streaming || !first || parts.hasAnswers || wantedAnswers || state.busy;

  const last = session.turns[session.turns.length - 1];
  $('#continueActions').hidden =
    streaming || !last || last.role !== 'assistant' || last.finishReason !== 'length';

  // follow-up thread (everything after the paper, except a generated-answers turn)
  const thread = $('#thread');
  thread.innerHTML = '';
  session.turns.forEach((t, i) => {
    if (i <= firstIdx || t.kind === 'answers') return;
    if (t.role === 'user') {
      if (t.kind !== 'followup') return;
      const bubble = document.createElement('div');
      bubble.className = 'turn turn-user';
      bubble.textContent = t.content;
      thread.append(bubble);
    } else {
      const reply = document.createElement('div');
      reply.className = 'turn turn-assistant md';
      renderMarkdown(reply, t.content || '…', { streaming });
      thread.append(reply);
    }
  });

  $('#docMeta').textContent = first ? formatUsage(first) : '';
}

// ---------- generation ----------
function requestMessages(session, extraTurns = []) {
  const turns = [...session.turns, ...extraTurns];
  const [firstUser, ...rest] = turns;
  const messages = buildMessages(state.skill, session.settings, session.model);
  messages[1].content = firstUser.content; // keep the original prompt
  for (const t of rest) messages.push({ role: t.role, content: t.content });
  return messages;
}

async function runTurn(userTurn, { appendTo = null } = {}) {
  const session = state.session;
  const conn = connection();
  if (!conn) {
    openSettings();
    return;
  }
  if (state.proxy?.requiresAccessCode && !state.apiKey && !state.accessCode) {
    openSettings();
    return;
  }

  // appendTo: continue a reply that was cut off at the token limit
  const assistant = appendTo || { role: 'assistant', content: '', kind: userTurn?.kind || 'paper' };
  const prior = appendTo ? appendTo.content : '';
  let messages;
  if (appendTo) {
    const idx = session.turns.indexOf(appendTo);
    messages = requestMessages({ ...session, turns: session.turns.slice(0, idx + 1) }, [
      { role: 'user', content: 'Continue exactly where you stopped. Do not repeat anything already written.' },
    ]);
  } else {
    if (userTurn) session.turns.push(userTurn);
    messages = requestMessages(session);
    session.turns.push(assistant);
  }

  const { model, temperature, maxTokens } = { ...readModelOptions(), model: session.model };
  state.controller = new AbortController();
  setBusy(true);
  setStatus('Waiting for the model…');
  renderSession({ streaming: true });

  let renderTimer = null;
  const scheduleRender = () => {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderSession({ streaming: true });
    }, 120);
  };

  let sawReasoning = false;
  try {
    const result = await streamChat({
      ...conn,
      signal: state.controller.signal,
      body: { model, messages, temperature, max_tokens: maxTokens },
      onDelta: (text) => {
        if (!assistant.content && !prior) setStatus('');
        assistant.content += text;
        scheduleRender();
      },
      onReasoning: () => {
        if (!sawReasoning && !assistant.content) setStatus('The model is thinking…');
        sawReasoning = true;
      },
    });
    assistant.model = result.model || model;
    assistant.usage = mergeUsage(appendTo ? assistant.usage : null, result.usage);
    assistant.finishReason = result.finishReason;
    if (!assistant.content.trim()) {
      setStatus('The model returned an empty reply. Try again or choose another model.', 'error');
    } else {
      setStatus('');
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      setStatus('Stopped.', 'info');
    } else {
      setStatus(`Error: ${e.message}`, 'error');
      if (e.status === 401) openSettings();
    }
    if (!assistant.content && !appendTo) {
      // drop the empty reply (and its prompt) so a retry starts cleanly
      session.turns.splice(session.turns.indexOf(assistant), 1);
      if (userTurn && session.turns.length > 1) session.turns.splice(session.turns.indexOf(userTurn), 1);
      if (userTurn?.kind === 'followup' && !$('#followupInput').value) $('#followupInput').value = userTurn.content;
    }
  } finally {
    clearTimeout(renderTimer);
    state.controller = null;
    setBusy(false);
    if (session.turns.some((t) => t.role === 'assistant')) {
      session.title = extractTitle(session.turns.find((t) => t.role === 'assistant').content, session.title);
      saveToHistory(session);
    }
    renderSession();
    if (!session.turns.some((t) => t.role === 'assistant')) {
      // nothing came back for a brand-new paper
      $('#questions').innerHTML = '';
    }
  }
}

function mergeUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    ...b,
    total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0),
    cost: (a.cost || 0) + (b.cost || 0),
  };
}

async function generate() {
  if (state.busy) return;
  if (!state.skill) await loadSkill();
  if (!state.skill) return;
  if (!hasCredentials()) {
    openSettings();
    return;
  }
  hideBanner();
  persistForm();
  const settings = readSettings();
  const { model } = readModelOptions();
  state.answersRevealed = false;
  chartCache.clear();
  state.session = {
    id: `s${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    settings,
    model,
    title: 'Generating…',
    turns: [],
  };
  await runTurn({ role: 'user', content: buildUserPrompt(settings), kind: 'paper' });
  if (window.matchMedia('(max-width: 900px)').matches) $('#output').scrollIntoView({ behavior: 'smooth' });
}

// ---------- history ----------
function saveToHistory(session) {
  const list = store.get('h2econ.history', []);
  const entry = {
    id: session.id,
    createdAt: session.createdAt,
    title: session.title,
    settings: session.settings,
    model: session.model,
    turns: session.turns.map(({ role, content, kind, usage, model, finishReason }) => ({
      role,
      content,
      kind,
      usage,
      model,
      finishReason,
    })),
  };
  const next = [entry, ...list.filter((e) => e.id !== session.id)].slice(0, HISTORY_LIMIT);
  store.set('h2econ.history', next);
}

const TYPE_LABEL = { 'case-study': 'Case study', essay: 'Essay', 'short-questions': 'Practice set' };

function renderHistory() {
  const list = $('#historyList');
  const items = store.get('h2econ.history', []);
  list.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Nothing yet. Generated papers appear here.';
    list.append(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'history-item';
    const title = document.createElement('strong');
    title.textContent = item.title || 'Untitled';
    const meta = document.createElement('small');
    meta.textContent = `${TYPE_LABEL[item.settings?.type] || ''} · ${new Date(item.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · ${item.model}`;
    open.append(title, meta);
    open.addEventListener('click', () => {
      state.session = structuredClone(item);
      state.answersRevealed = false;
      chartCache.clear();
      writeSettings(item.settings);
      form.elements.model.value = item.model;
      setStatus('');
      renderSession();
      $('#historyDialog').close();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost btn-small';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete ${item.title}`);
    del.addEventListener('click', () => {
      store.set(
        'h2econ.history',
        store.get('h2econ.history', []).filter((e) => e.id !== item.id),
      );
      renderHistory();
    });
    li.append(open, del);
    list.append(li);
  }
}

// ---------- export ----------
function sessionMarkdown(includeAnswers) {
  const parts = paperParts(state.session);
  let md = parts.questions;
  if (includeAnswers && parts.hasAnswers) md += `\n\n---\n\n# Suggested answers\n\n${parts.answers}`;
  if (includeAnswers) {
    const firstIdx = firstAssistantIndex(state.session.turns);
    state.session.turns.forEach((t, i) => {
      if (i <= firstIdx || t.kind === 'answers') return;
      if (t.role === 'user' && t.kind === 'followup') md += `\n\n---\n\n> **Follow-up:** ${t.content.replace(/\n/g, '\n> ')}`;
      if (t.role === 'assistant') md += `\n\n${t.content}`;
    });
  }
  return chartsToTables(md);
}

function download(includeAnswers) {
  const md = sessionMarkdown(includeAnswers);
  const name = (state.session.title || 'h2-economics')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name || 'h2-economics'}${includeAnswers ? '-with-answers' : ''}.md`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- settings dialog ----------
function openSettings() {
  $('#apiKeyInput').value = state.apiKey;
  $('#rememberKey').checked = !!store.get('h2econ.apiKey');
  $('#accessCodeInput').value = state.accessCode;
  $('#settingsDialog').showModal();
  $('#apiKeyInput').focus();
}

function saveSettings() {
  state.apiKey = $('#apiKeyInput').value.trim();
  state.accessCode = $('#accessCodeInput').value.trim();
  store.remove('h2econ.apiKey');
  store.remove('h2econ.apiKey', 'sessionStorage');
  if (state.apiKey) {
    store.set('h2econ.apiKey', state.apiKey, $('#rememberKey').checked ? 'localStorage' : 'sessionStorage');
  }
  if (state.accessCode) store.set('h2econ.accessCode', state.accessCode, 'sessionStorage');
  else store.remove('h2econ.accessCode', 'sessionStorage');
  updateKeyDot();
}

// ---------- theme ----------
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  requestAnimationFrame(redrawCharts);
}

function currentTheme() {
  return (
    document.documentElement.dataset.theme ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
}

// ---------- wiring ----------
function wire() {
  form.addEventListener('change', (e) => {
    if (['type', 'output'].includes(e.target.name)) syncFormVisibility();
    persistForm();
  });
  form.elements.temperature.addEventListener('input', (e) => {
    $('#tempOut').textContent = e.target.value;
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    generate();
  });
  $('#stopBtn').addEventListener('click', () => state.controller?.abort());

  $('#revealBtn').addEventListener('click', () => {
    state.answersRevealed = !state.answersRevealed;
    renderSession({ streaming: state.busy });
    if (state.answersRevealed) $('#answersBlock').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#genAnswersBtn').addEventListener('click', () => {
    state.answersRevealed = false;
    runTurn({ role: 'user', content: REVEAL_ANSWERS_PROMPT, kind: 'answers' });
  });
  $('#continueBtn').addEventListener('click', () => {
    const last = state.session.turns[state.session.turns.length - 1];
    runTurn(null, { appendTo: last });
  });
  $('#regenBtn').addEventListener('click', () => {
    if (!state.session) return;
    writeSettings(state.session.settings);
    form.elements.model.value = state.session.model;
    generate();
  });

  $('#copyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(sessionMarkdown(state.answersRevealed));
      $('#copyBtn').textContent = 'Copied';
    } catch {
      $('#copyBtn').textContent = 'Copy failed';
    }
    setTimeout(() => ($('#copyBtn').textContent = 'Copy'), 1500);
  });
  const menu = $('#downloadMenu');
  $('#downloadBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    $('#downloadBtn').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', () => {
    menu.hidden = true;
    $('#downloadBtn').setAttribute('aria-expanded', 'false');
  });
  menu.querySelectorAll('[data-download]').forEach((b) =>
    b.addEventListener('click', () => download(b.dataset.download === 'all')),
  );
  $('#printBtn').addEventListener('click', () => window.print());

  $('#followupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#followupInput');
    const text = input.value.trim();
    if (!text || state.busy || !state.session) return;
    input.value = '';
    runTurn({ role: 'user', content: text, kind: 'followup' });
  });
  $('#followupInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#followupForm').requestSubmit();
  });
  $('#chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-prompt]');
    if (!chip) return;
    const input = $('#followupInput');
    input.value = chip.dataset.prompt;
    input.focus();
    const blank = input.value.indexOf('___');
    if (blank >= 0) input.setSelectionRange(blank, blank + 3);
  });

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#clearKeyBtn').addEventListener('click', () => {
    $('#apiKeyInput').value = '';
    $('#rememberKey').checked = false;
  });

  $('#historyBtn').addEventListener('click', () => {
    renderHistory();
    $('#historyDialog').showModal();
  });
  $('#closeHistoryBtn').addEventListener('click', () => $('#historyDialog').close());
  $('#clearHistoryBtn').addEventListener('click', () => {
    if (confirm('Delete all saved papers from this browser?')) {
      store.remove('h2econ.history');
      renderHistory();
    }
  });

  $('#themeBtn').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    store.set('h2econ.theme', next);
    applyTheme(next);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) requestAnimationFrame(redrawCharts);
  });
  window.addEventListener('beforeprint', redrawCharts);
}

async function init() {
  applyTheme(store.get('h2econ.theme'));
  buildTopicPicker();
  restoreForm();
  wire();
  updateKeyDot();
  await Promise.all([loadSkill(), detectProxy(), loadModels()]);
  if (!hasCredentials() && state.skill) {
    showBanner(
      'Add your <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">OpenRouter API key</a> to start generating. <button type="button" class="link-button" id="bannerKeyBtn">Add key</button>',
    );
    $('#bannerKeyBtn').addEventListener('click', () => {
      openSettings();
    });
  }
  $('#settingsDialog').addEventListener('close', () => {
    if (hasCredentials() && $('#banner').textContent.includes('API key')) hideBanner();
  });
}

// Expose for debugging and tests in the browser console.
window.h2econ = { state, buildSystemPrompt, ANSWER_MARKER };

init();
