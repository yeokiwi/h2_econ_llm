// Builds the OpenRouter chat messages from SKILL.md plus the user's settings.
// Pure functions only, so they can be unit-tested under Node.

import { topicByCode } from './syllabus.js';

// The model writes this line between the questions and the answers so the UI
// can hide the answers until the student chooses to reveal them.
export const ANSWER_MARKER = '=== ANSWERS ===';
const MARKER_RE = /^[ \t]*={3,}[ \t]*ANSWERS[ \t]*={3,}[ \t]*$/im;

export const DEFAULT_SETTINGS = {
  type: 'case-study', // 'case-study' | 'essay' | 'short-questions'
  topics: [], // syllabus codes; empty = examiner's choice
  context: 'mixed', // 'singapore' | 'international' | 'mixed'
  customContext: '',
  output: 'answers', // 'questions' | 'answers' | 'full'
  answerStyle: 'model', // 'model' | 'outline'
  difficulty: 'standard', // 'standard' | 'challenging'
  essaySection: 'auto', // 'auto' | 'A' | 'B'
  essayCount: 1,
  shortCount: 4,
  shortMarks: 'mixed', // 'mixed' | '2' | '4' | '8' | '10'
  notes: '',
};

export const CHART_SPEC = `\`\`\`chart
{"type": "line", "title": "Figure 1: Consumer price index, 2019–2023 (2019 = 100)",
 "xLabel": "Year", "yLabel": "Index (2019 = 100)",
 "labels": ["2019", "2020", "2021", "2022", "2023"],
 "series": [{"name": "Food", "data": [100, 102.1, 104.0, 110.2, 115.8]},
            {"name": "Clothing", "data": [100, 99.4, 100.2, 101.0, 101.9]}],
 "source": "Adapted from Department of Statistics"}
\`\`\``;

export const DIAGRAM_SPEC = `\`\`\`diagram
{"title": "Figure 1: Increase in demand for hotel rooms", "xLabel": "Quantity of hotel rooms", "yLabel": "Price",
 "curves": [{"label": "S0", "points": [[1, 1.5], [8.5, 9]]},
            {"label": "D0", "points": [[1, 8], [8, 1]]},
            {"label": "D1", "points": [[2.5, 9.5], [9.5, 2.5]], "emphasis": "new"}],
 "points": [{"label": "e0", "intersect": ["S0", "D0"], "xTick": "Q0", "yTick": "P0"},
            {"label": "e1", "intersect": ["S0", "D1"], "xTick": "Q1", "yTick": "P1"}],
 "areas": [{"label": "ΔTR", "polygon": ["e0@y", "e1@y", "e1", "e1@x", "e0@x", "e0"], "tone": "blue"}],
 "arrows": [{"from": [6.2, 3], "to": [7.4, 4.2]}]}
\`\`\``;

export function buildSystemPrompt(skill) {
  return `You are an experienced Singapore JC economics tutor and Cambridge examiner who sets and marks Singapore-Cambridge A-Level H2 Economics (9570) papers. You follow the skill reference below exactly: its syllabus scope limits, command-word conventions, mark schemes, analytical chains, evaluation (Stand + ATMS) and answer style. Use Singapore/British spelling.

<skill_reference>
${skill.trim()}
</skill_reference>

## Output rules for this website
- Write in GitHub-flavoured Markdown. Start with a level-1 heading (# ...) that is a short title for the paper or question set.
- Put marks in square brackets at the end of each question, e.g. "[4]".
- Present tables of data as Markdown tables, labelled "Table 1: ..." and with a source line.
- Present any line or bar chart data (e.g. "Figure 1") as a fenced \`chart\` block containing only valid JSON, which the website draws as a chart. "type" is "line" or "bar"; every series must have one number (or null) per label; use at most 4 series. A chart has one y-axis, so series with different units or very different scales go in separate figures (or are indexed to a common base year). Example:
${CHART_SPEC}
- Draw every economics diagram (D&S, tax/subsidy, price controls, externality, firm cost/revenue, PPC, AD/AS, tariff, Lorenz curve) as a fenced \`diagram\` block containing only valid JSON, which the website draws. Never use ASCII sketches. Rules:
  - Coordinates run from 0 to 10 on both axes (set "xMax"/"yMax" only if you need more room). Keep curves inside the plot and leave space at their ends for labels.
  - Each curve has a "label" (S0, D1, MSC, MPB, AD0, AS, LRAS, PPC0, AR, MR, MC, AC, Pw, Pw+t, Line of equality, ...) and two or more "points"; give a curve "smooth": true for curved shapes (PPC, MC, AC, Keynesian AS, Lorenz). Give shifted or new curves "emphasis": "new" and the original ones no emphasis.
  - Mark equilibria and other key points with "points": use "intersect": ["S0", "D1"] so the point sits exactly where the curves cross (or "at": [x, y]), plus "xTick"/"yTick" labels such as "Q1"/"P1" for the dashed guides to the axes.
  - Shade areas (DWL, CS, PS, tax revenue, change in revenue, supernormal profit, Lorenz area A) with "areas": a "polygon" whose vertices are [x, y] pairs or point labels, where "e1" is the point itself, "e1@x" its foot on the x-axis and "e1@y" its foot on the y-axis; "curve:NAME" splices in a whole curve (and "curve:NAME:rev" the same curve in reverse) so the area follows it. Name every corner you need as a point first, so vertices sit exactly on the curves. "tone" is "blue", "orange", "green", "red" or "violet".
  - A point with "marker": false draws no dot, e.g. {"at": [8, 0], "xTick": "Yf", "marker": false, "guides": false} for a full-employment tick.
  - Show shifts with "arrows": {"from": [x, y], "to": [x, y]}.
  - Give the diagram a title such as "Figure 1: ..." and refer to it in the text ("As shown in Figure 1, P rises from P0 to P1").
  Example (an increase in demand):
${DIAGRAM_SPEC}
- When answers are requested, write the questions first, then a line containing exactly "${ANSWER_MARKER}" on its own, then the answers. Never put answers, hints or mark allocations before that line. Do not write that line when answers are not requested.
- Do not add any preamble or closing remarks outside the paper itself.`;
}

function topicText(codes) {
  if (!codes || codes.length === 0) {
    return 'Choose the syllabus areas yourself, varying themes and favouring recurring exam favourites (section 12 of the skill reference).';
  }
  const lines = codes
    .map(topicByCode)
    .filter(Boolean)
    .map((t) => `- ${t.code} ${t.label}`);
  return `Focus on these syllabus areas (stay within their scope limits):\n${lines.join('\n')}`;
}

function contextText({ context, customContext }) {
  const custom = customContext && customContext.trim();
  const base = {
    singapore: 'Set the questions in a Singapore context (use the Singapore context bank).',
    international:
      'Set the questions in a non-Singapore context: another economy, region or global market.',
    mixed: 'Use a realistic contemporary context; it may compare Singapore with another economy.',
  }[context] || '';
  return custom ? `${base}\nSpecific context or issue to build the questions around: ${custom}` : base;
}

function difficultyText(difficulty) {
  return difficulty === 'challenging'
    ? 'Pitch the difficulty at a demanding top-JC prelim level: subtle command words ("necessarily", "combined effects", "best"), data requiring careful inference, and questions where evaluation hinges on context.'
    : 'Pitch the difficulty at a typical A-Level / JC prelim standard.';
}

function answerText({ output, answerStyle, type }) {
  if (output === 'questions') {
    return 'Write the questions only. Do not provide answers, hints or mark schemes.';
  }
  const style =
    answerStyle === 'outline'
      ? 'For each question give a concise suggested-answer outline: the Command / Content / Context grid, then bullet-point key analytical points (KA1, KA2, ...), the diagrams needed, and for higher-order questions the stand and ATMS evaluation points.'
      : 'For each question write a full model answer in the JC suggested-answer style: open with the Command / Content / Context grid, then the answer itself with labelled KAs, diagrams described per the output rules, rigorous chains of reasoning and explicit use of the case material, and for higher-order questions an evaluative conclusion with a Stand and labelled ATMS angles. Match the depth to the marks.';
  const scheme =
    output === 'full'
      ? type === 'essay'
        ? 'After each model answer, add the mark scheme: level descriptors (L3/L2/L1 and, for part (b), E3/E2/E1) with the indicative content expected at the top level.'
        : 'After each answer, add the mark scheme: a point-by-point allocation for data-response questions, and for higher-order questions the level descriptors (L2/L1 + E) with indicative content.'
      : '';
  return `After the questions, write the line "${ANSWER_MARKER}" and then the suggested answers. ${style} ${scheme}`.trim();
}

function taskText(s) {
  if (s.type === 'essay') {
    const count = clamp(Number(s.essayCount) || 1, 1, 3);
    const section =
      s.essaySection === 'A'
        ? 'Section A (mainly micro)'
        : s.essaySection === 'B'
          ? 'Section B (mainly macro)'
          : 'whichever section best fits the topics (Section A is mainly micro, Section B mainly macro); label each question with its section';
    return `Set ${count} Paper 2 essay question${count > 1 ? 's' : ''} from ${section}, following workflow C in the skill reference. Each question has a short real-world preamble, then part (a) [10] that asks for explanation only, and part (b) [15] that requires analysis and a reasoned judgement and cannot be answered from (a) alone.${count > 1 ? ' Number the questions 1, 2, 3 and make them cover different syllabus areas.' : ''}`;
  }
  if (s.type === 'short-questions') {
    const count = clamp(Number(s.shortCount) || 4, 1, 8);
    const marks =
      s.shortMarks === 'mixed'
        ? 'a mix of data-response (2–4 marks) and higher-order (8 or 10 marks) part-questions'
        : `${s.shortMarks}-mark part-questions`;
    return `Set a practice set of ${count} stand-alone case-study style questions: ${marks}. Before each question give a short stimulus (a brief extract of a few sentences, and a small table or chart where the question needs data), labelled "Extract 1", "Table 1" and so on, so that every question requires use of the data. Number the questions 1, 2, 3, ...`;
  }
  return 'Set one complete Paper 1 case study following workflow C in the skill reference: a title, an introductory line, 1–2 figures or tables and 3–5 extracts (each a substantial paragraph or two with a plausible source line), then 6–7 part-questions totalling exactly 30 marks (about 12 data-response and about 18 higher-order), typically ordered 2, 2/4, 4, 4, 8, 10 and labelled (a), (b)(i) and so on. Every question must require use of the case material. Put a "## Questions" heading before the part-questions and finish with the total "[Total: 30]".';
}

export function buildUserPrompt(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const parts = [
    taskText(s),
    topicText(s.topics),
    contextText(s),
    difficultyText(s.difficulty),
    answerText(s),
  ];
  if (s.notes && s.notes.trim()) parts.push(`Additional instructions from the teacher: ${s.notes.trim()}`);
  return parts.join('\n\n');
}

export function buildMessages(skill, settings, model = '') {
  const system = buildSystemPrompt(skill);
  // Anthropic models on OpenRouter support explicit prompt caching. The skill
  // reference is long and identical across requests, so cache it.
  const systemMessage = model.startsWith('anthropic/')
    ? {
        role: 'system',
        content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      }
    : { role: 'system', content: system };
  return [systemMessage, { role: 'user', content: buildUserPrompt(settings) }];
}

export const REVEAL_ANSWERS_PROMPT = `Now write the suggested answers to every question above. Begin your reply with the line "${ANSWER_MARKER}" and then follow the answer conventions in the skill reference: the Command / Content / Context grid, labelled KAs, diagrams described per the output rules, and a Stand + ATMS conclusion for higher-order questions. Add the mark scheme after each answer.`;

// Splits generated Markdown into the question part and the answer part.
// While streaming, a half-written marker line at the end is hidden.
export function splitAnswers(markdown, { streaming = false } = {}) {
  const match = MARKER_RE.exec(markdown);
  if (match) {
    return {
      questions: markdown.slice(0, match.index).trimEnd(),
      answers: markdown.slice(match.index + match[0].length).trim(),
      hasAnswers: true,
    };
  }
  let questions = markdown;
  if (streaming) {
    questions = questions.replace(/\n[ \t]*={1,}[ \t]*[A-Z]{0,7}[ \t]*=*[ \t]*$/, '');
  }
  return { questions, answers: '', hasAnswers: false };
}

export function extractTitle(markdown, fallback = 'Untitled') {
  const m = /^#\s+(.+)$/m.exec(markdown);
  return m ? m[1].replace(/[*_`]/g, '').trim().slice(0, 120) : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
