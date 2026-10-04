import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ANSWER_MARKER,
  buildMessages,
  buildSystemPrompt,
  buildUserPrompt,
  splitAnswers,
  extractTitle,
} from '../assets/js/prompts.js';

const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');

test('system prompt embeds the whole skill reference and the answer marker rule', () => {
  const sys = buildSystemPrompt(skill);
  assert.ok(sys.includes('## 7. Evaluation (E marks): Stand + ATMS'));
  assert.ok(sys.includes('## 12. Reference: 2024 prelim questions'));
  assert.ok(sys.includes(ANSWER_MARKER));
  assert.ok(sys.includes('```chart'));
});

test('case study prompt asks for 30 marks and answers after the marker', () => {
  const p = buildUserPrompt({ type: 'case-study', output: 'answers' });
  assert.match(p, /totalling exactly 30 marks/);
  assert.ok(p.includes(`write the line "${ANSWER_MARKER}"`));
  assert.match(p, /Choose the syllabus areas yourself/);
});

test('questions-only prompt forbids answers', () => {
  const p = buildUserPrompt({ type: 'essay', output: 'questions', essayCount: 2, essaySection: 'B' });
  assert.match(p, /Set 2 Paper 2 essay questions from Section B/);
  assert.match(p, /Write the questions only/);
  assert.ok(!p.includes(ANSWER_MARKER));
});

test('topics, context and notes are passed through; counts are clamped', () => {
  const p = buildUserPrompt({
    type: 'short-questions',
    shortCount: 99,
    shortMarks: '4',
    topics: ['2.3.2', '3.2.3', 'bogus'],
    context: 'singapore',
    customContext: 'MAS policy band',
    output: 'full',
    notes: 'Use 2025 data',
  });
  assert.match(p, /practice set of 8 /);
  assert.match(p, /4-mark part-questions/);
  assert.match(p, /- 2\.3\.2 Market failure/);
  assert.match(p, /- 3\.2\.3 Fiscal/);
  assert.ok(!p.includes('bogus'));
  assert.match(p, /Singapore context/);
  assert.match(p, /MAS policy band/);
  assert.match(p, /point-by-point allocation/);
  assert.match(p, /Use 2025 data/);
});

test('anthropic models get a cacheable system block; others a plain string', () => {
  const a = buildMessages(skill, {}, 'anthropic/claude-sonnet-5.5');
  assert.equal(a[0].role, 'system');
  assert.deepEqual(a[0].content[0].cache_control, { type: 'ephemeral' });
  const o = buildMessages(skill, {}, 'openai/gpt-5.5');
  assert.equal(typeof o[0].content, 'string');
  assert.equal(o[1].role, 'user');
});

test('splitAnswers separates questions from answers', () => {
  const md = `# Paper\n\n1. Explain [4]\n\n${ANSWER_MARKER}\n\n## Answer 1\nBecause.`;
  const r = splitAnswers(md);
  assert.equal(r.hasAnswers, true);
  assert.equal(r.questions, '# Paper\n\n1. Explain [4]');
  assert.equal(r.answers, '## Answer 1\nBecause.');
});

test('splitAnswers tolerates marker variations and hides a half-written marker while streaming', () => {
  assert.equal(splitAnswers('Q\n  ====  answers ====  \nA').answers, 'A');
  const partial = splitAnswers('Q text\n=== ANSW', { streaming: true });
  assert.equal(partial.hasAnswers, false);
  assert.equal(partial.questions, 'Q text');
  assert.equal(splitAnswers('Q text\n=== ANSW').questions, 'Q text\n=== ANSW');
});

test('extractTitle reads the first H1', () => {
  assert.equal(extractTitle('intro\n# **Food** prices\n## x'), 'Food prices');
  assert.equal(extractTitle('no heading', 'Fallback'), 'Fallback');
});
