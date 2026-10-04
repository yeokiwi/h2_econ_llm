import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChartSpec, chartToMarkdownTable, chartsToTables } from '../assets/js/charts.js';
import { CHART_SPEC } from '../assets/js/prompts.js';

test('the example chart in the system prompt is itself valid', () => {
  const body = CHART_SPEC.replace(/^```chart\n/, '').replace(/```$/, '');
  const r = parseChartSpec(body);
  assert.equal(r.ok, true);
  assert.equal(r.spec.series.length, 2);
});

test('parseChartSpec normalises data to the label count and coerces numbers', () => {
  const r = parseChartSpec(
    JSON.stringify({ type: 'pie', labels: [2020, 2021, 2022], series: [{ name: 'GDP', data: ['1,200', '3.5%'] }] }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.spec.type, 'line');
  assert.deepEqual(r.spec.labels, ['2020', '2021', '2022']);
  assert.deepEqual(r.spec.series[0].data, [1200, 3.5, null]);
});

test('parseChartSpec rejects bad input', () => {
  assert.equal(parseChartSpec('{"labels": [').ok, false);
  assert.equal(parseChartSpec('{"labels": [], "series": []}').ok, false);
  assert.equal(parseChartSpec('{"labels": ["a"]}').ok, false);
});

test('chart blocks become Markdown tables for downloads', () => {
  const md = `Intro\n\n\`\`\`chart\n${JSON.stringify({
    title: 'Figure 1: Unemployment',
    xLabel: 'Year',
    yLabel: '%',
    labels: ['2022', '2023'],
    series: [{ name: 'Serbia', data: [9.4, 9.1] }, { name: 'Singapore', data: [2.1, 1.9] }],
    source: 'ILO',
  })}\n\`\`\`\n\nOutro`;
  const out = chartsToTables(md);
  assert.ok(!out.includes('```chart'));
  assert.ok(out.includes('| Year | Serbia | Singapore |'));
  assert.ok(out.includes('| 2022 | 9.4 | 2.1 |'));
  assert.ok(out.includes('_Source: ILO_'));
  assert.ok(out.startsWith('Intro') && out.endsWith('Outro'));
  assert.ok(chartToMarkdownTable(parseChartSpec(JSON.stringify({ labels: ['a'], series: [{ name: 's', data: [null] }] })).spec).includes('| a | – |'));
});
