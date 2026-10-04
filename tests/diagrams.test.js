import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiagramSpec, intersectPolylines, diagramsToText, smoothPolyline, placeLabel } from '../assets/js/diagrams.js';
import { DIAGRAM_SPEC, buildSystemPrompt } from '../assets/js/prompts.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);
const exampleBody = DIAGRAM_SPEC.replace(/^```diagram\n/, '').replace(/```$/, '');

test('the example diagram in the system prompt parses with no warnings', () => {
  const r = parseDiagramSpec(exampleBody);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.spec.curves.length, 3);
  assert.equal(r.spec.points.length, 2);
  // demand rises along a fixed supply curve: higher price and quantity
  const [e0, e1] = r.spec.points;
  assert.ok(e1.at[0] > e0.at[0] && e1.at[1] > e0.at[1]);
  assert.equal(r.spec.areas[0].polygon.length, 6);
  assert.ok(buildSystemPrompt('skill').includes('```diagram'));
  assert.ok(!buildSystemPrompt('skill').includes('ASCII sketch in'));
});

test('intersections are exact, including on multi-segment curves', () => {
  near(intersectPolylines([[0, 0], [10, 10]], [[0, 10], [10, 0]])[0], 5);
  // kinked (Keynesian-style) AS crossed by a downward AD
  const as = [[0, 2], [6, 2], [8, 4], [8, 10]];
  const hit = intersectPolylines(as, [[0, 9], [10, 1]]);
  near(hit[0], 13 / 1.8); // y = x - 4 meets y = 9 - 0.8x
  near(hit[1], 13 / 1.8 - 4);
  assert.equal(intersectPolylines([[0, 0], [1, 1]], [[0, 1], [1, 2]]), null); // parallel
  assert.equal(intersectPolylines([[0, 0], [1, 1]], [[5, 0], [6, -1]]), null); // apart
});

test('area vertices resolve point references and axis feet', () => {
  const r = parseDiagramSpec(
    JSON.stringify({
      curves: [
        { label: 'S', points: [[0, 0], [10, 10]] },
        { label: 'D', points: [[0, 10], [10, 0]] },
      ],
      points: [{ label: 'e', intersect: ['S', 'D'], xTick: 'Q*', yTick: 'P*' }],
      areas: [{ label: 'CS', polygon: ['e@y', 'e', [0, 10]], tone: 'green' }, { polygon: ['e', 'nope', [0, 0]] }],
      arrows: [{ from: 'e', to: [7, 7] }, { from: 'missing', to: [1, 1] }],
    }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec.areas[0].polygon, [[0, 5], [5, 5], [0, 10]]);
  assert.equal(r.spec.areas[0].tone, 'green');
  assert.equal(r.spec.areas.length, 1);
  assert.match(r.warnings.join(' '), /unknown or missing vertex/);
  assert.deepEqual(r.spec.arrows, [{ from: [5, 5], to: [7, 7] }]);
});

test('bad specs are rejected or degrade with warnings', () => {
  assert.equal(parseDiagramSpec('{"curves": [').ok, false);
  assert.equal(parseDiagramSpec('{"curves": []}').ok, false);
  assert.equal(parseDiagramSpec('{"curves": [{"label": "S", "points": [[1, 1]]}]}').ok, false);
  const r = parseDiagramSpec(
    JSON.stringify({
      curves: [
        { label: 'A', points: [[0, 0], [1, 1]] },
        { label: 'B', points: [[0, 5], [1, 6]] },
      ],
      points: [{ label: 'x', intersect: ['A', 'B'] }],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.spec.points.length, 0);
  assert.match(r.warnings[0], /do not cross/);
});

test('diagram blocks become text for downloads', () => {
  const out = diagramsToText(`Before\n\n\`\`\`diagram\n${exampleBody}\`\`\`\n\nAfter`);
  assert.ok(!out.includes('```diagram'));
  assert.match(out, /\*\*Figure 1: Increase in demand for hotel rooms\*\*/);
  assert.match(out, /Curves: S0, D0, D1/);
  assert.match(out, /Point e1 at \([\d.]+, [\d.]+\): Q1, P1/);
});

test('smooth curves pass through their control points and intersect where drawn', () => {
  const ppc = [[0, 9], [5, 7], [8, 4], [9, 0]];
  const line = smoothPolyline(ppc);
  for (const p of ppc) assert.ok(line.some(([x, y]) => Math.abs(x - p[0]) < 1e-9 && Math.abs(y - p[1]) < 1e-9));
  const r = parseDiagramSpec(
    JSON.stringify({
      curves: [
        { label: 'PPC', points: ppc, smooth: true },
        { label: 'ray', points: [[0, 0], [10, 10]] },
      ],
      points: [{ label: 'A', intersect: ['PPC', 'ray'] }],
    }),
  );
  const [x, y] = r.spec.points[0].at;
  near(x, y); // on the 45° ray
  assert.ok(x > 5 && x < 8); // between the control points it bends through
});

test('areas can follow a curve and points can hide their marker', () => {
  const r = parseDiagramSpec(
    JSON.stringify({
      curves: [
        { label: 'Equality', points: [[0, 0], [10, 10]] },
        { label: 'Lorenz', points: [[0, 0], [5, 2], [10, 10]] },
      ],
      points: [{ at: [8, 0], xTick: 'Yf', marker: false, guides: false }],
      areas: [{ label: 'A', polygon: ['curve:Equality', 'curve:Lorenz:rev'] }],
    }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec.areas[0].polygon, [[0, 0], [10, 10], [10, 10], [5, 2], [0, 0]]);
  assert.equal(r.spec.points[0].marker, false);
  assert.equal(parseDiagramSpec(JSON.stringify({ curves: [{ label: 'X', points: [[0, 0], [1, 1]] }], areas: [{ polygon: ['curve:Nope', [0, 1], [1, 0]] }] })).spec.areas.length, 0);
});

test('labels at the top edge are moved clear of each other, not clamped back on top', () => {
  const ctx = { measureText: (t) => ({ width: t.length * 7 }), fillText() {} };
  const placed = [];
  const bounds = { left: 2, right: 484, top: 2, bottom: 358 };
  placeLabel(ctx, placed, 'Line of equality', 448, 11, { bounds });
  placeLabel(ctx, placed, 'Lorenz', 443, 8, { bounds });
  const [a, b] = placed;
  const overlap = a.left < b.left + b.w && b.left < a.left + a.w && a.top < b.top + b.h && b.top < a.top + a.h;
  assert.equal(overlap, false);
  assert.ok(placed.every((r) => r.top >= bounds.top && r.left + r.w <= bounds.right));
});
