// Economics diagrams (D&S, AD/AS, PPC, externalities, firms, tariffs, Lorenz).
// The model emits ```diagram JSON blocks in a 0–10 coordinate space; we
// resolve labelled points (e.g. the intersection of S0 and D1) and draw the
// result with Chart.js plus a small plugin for guides, labels, areas and arrows.

import { cssVar, el } from './charts.js';

const MAX_CURVES = 10;
const TONES = { blue: 1, orange: 2, green: 3, red: 8, violet: 7 };
const EMPHASIS = { original: 'ink', new: 1, secondary: 2 };

const isPair = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(Number(n)));
const toPair = (p) => [Number(p[0]), Number(p[1])];

// Intersection of two polylines (first hit), or null.
export function intersectPolylines(a, b) {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      const hit = intersectSegments(a[i], a[i + 1], b[j], b[j + 1]);
      if (hit) return hit;
    }
  }
  return null;
}

function intersectSegments([x1, y1], [x2, y2], [x3, y3], [x4, y4]) {
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-12) return null; // parallel
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

// Samples a Catmull-Rom spline through the points, so a smooth curve is drawn
// as the same polyline that intersections are computed on.
export function smoothPolyline(pts, steps = 16) {
  if (pts.length < 3) return pts;
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(i + 2, pts.length - 1)];
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        [0, 1].map(
          (d) =>
            0.5 *
            (2 * p1[d] +
              (-p0[d] + p2[d]) * t +
              (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 +
              (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3),
        ),
      );
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Validates a diagram spec and resolves every point to coordinates.
 * Point positions: "at": [x, y], or "intersect": ["S0", "D1"].
 * Area/arrow vertices: [x, y], "e1" (a named point), "e1@x" (its foot on the
 * x-axis) or "e1@y" (its foot on the y-axis).
 */
export function parseDiagramSpec(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid diagram JSON: ${e.message}` };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Diagram spec must be an object.' };

  const xMax = Number(raw.xMax) > 0 ? Number(raw.xMax) : 10;
  const yMax = Number(raw.yMax) > 0 ? Number(raw.yMax) : 10;
  const warnings = [];

  const curves = (Array.isArray(raw.curves) ? raw.curves : []).slice(0, MAX_CURVES).flatMap((c, i) => {
    const pts = Array.isArray(c?.points) ? c.points.filter(isPair).map(toPair) : [];
    if (pts.length < 2) {
      warnings.push(`Curve ${c?.label || i + 1} needs at least two points.`);
      return [];
    }
    const smooth = Boolean(c.smooth) && pts.length > 2;
    return [
      {
        label: String(c.label ?? ''),
        points: smooth ? smoothPolyline(pts) : pts,
        smooth,
        dashed: Boolean(c.dashed),
        emphasis: EMPHASIS[c.emphasis] !== undefined ? c.emphasis : 'original',
      },
    ];
  });
  if (curves.length === 0) return { ok: false, error: 'Diagram needs at least one curve with two or more points.' };
  const byLabel = new Map(curves.map((c) => [c.label, c]));

  const points = [];
  const pointByLabel = new Map();
  for (const p of Array.isArray(raw.points) ? raw.points : []) {
    let at = null;
    if (Array.isArray(p?.intersect) && p.intersect.length === 2) {
      const [a, b] = p.intersect.map((l) => byLabel.get(String(l)));
      if (a && b) at = intersectPolylines(a.points, b.points);
      if (!at) warnings.push(`${p.intersect.join(' and ')} do not cross, so point ${p.label || ''} was skipped.`);
    } else if (isPair(p?.at)) {
      at = toPair(p.at);
    }
    if (!at) continue;
    const point = {
      label: p.label ? String(p.label) : '',
      at,
      guides: p.guides !== false,
      marker: p.marker !== false,
      xTick: p.xTick ? String(p.xTick) : '',
      yTick: p.yTick ? String(p.yTick) : '',
    };
    points.push(point);
    if (point.label) pointByLabel.set(point.label, point);
  }

  const resolve = (v) => {
    if (isPair(v)) return toPair(v);
    if (typeof v !== 'string') return null;
    const [name, axis] = v.split('@');
    const pt = pointByLabel.get(name);
    if (!pt) return null;
    if (axis === 'x') return [pt.at[0], 0];
    if (axis === 'y') return [0, pt.at[1]];
    return pt.at;
  };

  // "curve:Lorenz" splices in a curve's points; "curve:Lorenz:rev" in reverse order.
  const expand = (v) => {
    if (typeof v === 'string' && v.startsWith('curve:')) {
      const [, name, dir] = v.split(':');
      const c = byLabel.get(name);
      if (!c) return [null];
      return dir === 'rev' ? [...c.points].reverse() : c.points;
    }
    return [resolve(v)];
  };
  const areas = (Array.isArray(raw.areas) ? raw.areas : []).flatMap((a) => {
    const poly = (Array.isArray(a?.polygon) ? a.polygon : []).flatMap(expand);
    if (poly.length < 3 || poly.some((v) => !v)) {
      warnings.push(`Area ${a?.label || ''} has an unknown or missing vertex.`);
      return [];
    }
    return [{ label: a.label ? String(a.label) : '', polygon: poly, tone: TONES[a.tone] ? a.tone : 'blue' }];
  });

  const arrows = (Array.isArray(raw.arrows) ? raw.arrows : []).flatMap((a) => {
    const from = resolve(a?.from);
    const to = resolve(a?.to);
    return from && to ? [{ from, to }] : [];
  });

  return {
    ok: true,
    warnings,
    spec: {
      title: raw.title ? String(raw.title) : '',
      xLabel: raw.xLabel ? String(raw.xLabel) : '',
      yLabel: raw.yLabel ? String(raw.yLabel) : '',
      xMax,
      yMax,
      curves,
      points,
      areas,
      arrows,
    },
  };
}

// Plain-text version for Markdown downloads.
export function diagramToMarkdown(spec) {
  const r = (n) => Math.round(n * 10) / 10;
  const lines = [`**${spec.title || 'Diagram'}** (${spec.yLabel || 'y'} against ${spec.xLabel || 'x'})`, ''];
  lines.push(`- Curves: ${spec.curves.map((c) => c.label || 'unlabelled').join(', ')}`);
  spec.points.forEach((p) => {
    const ticks = [p.xTick, p.yTick].filter(Boolean).join(', ');
    lines.push(`- Point ${p.label || ''} at (${r(p.at[0])}, ${r(p.at[1])})${ticks ? `: ${ticks}` : ''}`);
  });
  spec.areas.forEach((a) => lines.push(`- Shaded area${a.label ? ` ${a.label}` : ''}`));
  return lines.join('\n');
}

export function diagramsToText(markdown) {
  return markdown.replace(/```diagram[^\n]*\n([\s\S]*?)```/g, (block, body) => {
    const parsed = parseDiagramSpec(body);
    return parsed.ok ? diagramToMarkdown(parsed.spec) : block;
  });
}

// ---------- rendering ----------

function colourFor(emphasis) {
  const slot = EMPHASIS[emphasis];
  return slot === 'ink' ? cssVar('--text-primary') : cssVar(`--series-${slot}`);
}

function withAlpha(color, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Places a text label, nudging it down/up until it clears labels already placed.
export function placeLabel(ctx, placed, text, x, y, { align = 'left', bounds }) {
  const w = ctx.measureText(text).width;
  const h = 14;
  let left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  if (bounds) left = Math.min(Math.max(left, bounds.left), bounds.right - w);
  const overlaps = (top) =>
    placed.some((r) => left < r.left + r.w + 2 && left + w + 2 > r.left && top < r.top + r.h && top + h > r.top);
  const clampTop = (t) => (bounds ? Math.min(Math.max(t, bounds.top), bounds.bottom - h) : t);
  let top = clampTop(y - h / 2);
  for (const step of [0, 1, -1, 2, -2, 3, -3]) {
    const t = clampTop(y - h / 2 + step * (h + 2));
    if (!overlaps(t)) {
      top = t;
      break;
    }
  }
  placed.push({ left, top, w, h });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left, top + h / 2);
}

// Draws areas under the curves, and guides, labels and arrows over them.
const econPlugin = {
  id: 'econDiagram',
  beforeDatasetsDraw(chart) {
    const spec = chart.config.options.plugins.econDiagram?.spec;
    if (!spec) return;
    const { ctx, scales } = chart;
    const px = ([x, y]) => [scales.x.getPixelForValue(x), scales.y.getPixelForValue(y)];
    ctx.save();
    for (const area of spec.areas) {
      const color = cssVar(`--series-${TONES[area.tone]}`);
      ctx.beginPath();
      area.polygon.map(px).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = withAlpha(color, 0.22);
      ctx.fill();
    }
    ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const spec = chart.config.options.plugins.econDiagram?.spec;
    if (!spec) return;
    const { ctx, scales, chartArea } = chart;
    const px = ([x, y]) => [scales.x.getPixelForValue(x), scales.y.getPixelForValue(y)];
    const ink = cssVar('--text-primary');
    const ink2 = cssVar('--text-secondary');
    const muted = cssVar('--text-muted');
    const surface = cssVar('--surface');
    const family = getComputedStyle(document.body).fontFamily;
    const font = (size, weight = 400) => `${weight} ${size}px ${family}`;
    const [ox, oy] = px([0, 0]);
    const placed = [];
    const bounds = { left: 2, right: chart.width - 2, top: 2, bottom: chart.height - 2 };

    ctx.save();
    ctx.lineWidth = 1;

    // dashed guides from each point to the axes, with P0/Q0 style ticks
    ctx.font = font(12);
    for (const p of spec.points) {
      const [x, y] = px(p.at);
      if (p.guides) {
        ctx.strokeStyle = muted;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, oy);
        ctx.moveTo(x, y);
        ctx.lineTo(ox, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = ink2;
      if (p.xTick) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(p.xTick, x, oy + 4);
      }
      if (p.yTick) {
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.yTick, ox - 5, y);
      }
    }

    // area labels at the polygon's centroid
    ctx.font = font(12, 600);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const area of spec.areas) {
      if (!area.label) continue;
      const pts = area.polygon.map(px);
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      ctx.fillStyle = ink;
      placeLabel(ctx, placed, area.label, cx, cy, { align: 'center', bounds });
    }

    // shift arrows
    ctx.strokeStyle = ink2;
    ctx.fillStyle = ink2;
    ctx.lineWidth = 1.5;
    for (const a of spec.arrows) {
      const [x1, y1] = px(a.from);
      const [x2, y2] = px(a.to);
      const ang = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2 - 6 * Math.cos(ang), y2 - 6 * Math.sin(ang));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - 9 * Math.cos(ang - 0.4), y2 - 9 * Math.sin(ang - 0.4));
      ctx.lineTo(x2 - 9 * Math.cos(ang + 0.4), y2 - 9 * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
    }

    // equilibrium points: dot with a surface ring, label up and to the right
    ctx.lineWidth = 2;
    for (const p of spec.points) {
      const [x, y] = px(p.at);
      if (p.marker) {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = ink;
        ctx.strokeStyle = surface;
        ctx.fill();
        ctx.stroke();
      }
      if (p.label) {
        ctx.font = font(12, 600);
        ctx.fillStyle = ink;
        placeLabel(ctx, placed, p.label, x + 6, y - 10, { bounds });
      }
    }

    // curve labels just beyond each curve's last point, kept inside the canvas
    ctx.font = font(13, 600);
    ctx.textBaseline = 'middle';
    for (const c of spec.curves) {
      if (!c.label) continue;
      const last = px(c.points[c.points.length - 1]);
      const prev = px(c.points[c.points.length - 2]);
      const ang = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
      const x = last[0] + 8 * Math.cos(ang);
      const y = last[1] + 8 * Math.sin(ang);
      ctx.fillStyle = ink;
      placeLabel(ctx, placed, c.label, x, y, { bounds: { ...bounds, left: chartArea.left + 2 } });
    }
    ctx.restore();
  },
};

export function createDiagramFigure(spec, warnings = []) {
  const figure = el('figure', { class: 'chart-figure diagram-figure' });
  if (spec.title) figure.append(el('figcaption', { class: 'chart-title', text: spec.title }));
  const wrap = el('div', { class: 'chart-canvas diagram-canvas' });
  const canvas = el('canvas', { role: 'img', 'aria-label': describe(spec) });
  wrap.append(canvas);
  figure.append(wrap);
  if (warnings.length) figure.append(el('p', { class: 'chart-foot', text: warnings.join(' ') }));
  figure._draw = () => drawDiagram(figure, canvas, spec);
  return figure;
}

function describe(spec) {
  const pts = spec.points.map((p) => [p.label, p.xTick, p.yTick].filter(Boolean).join(' ')).join('; ');
  return `${spec.title || 'Diagram'}: ${spec.yLabel} against ${spec.xLabel}. Curves ${spec.curves
    .map((c) => c.label)
    .join(', ')}.${pts ? ` Points: ${pts}.` : ''}`;
}

function drawDiagram(figure, canvas, spec) {
  const Chart = window.Chart;
  if (!Chart) return;
  if (figure._chart) figure._chart.destroy();
  const axis = cssVar('--text-secondary');
  const font = { family: getComputedStyle(document.body).fontFamily, size: 12 };

  const datasets = spec.curves.map((c) => ({
    label: c.label,
    data: c.points.map(([x, y]) => ({ x, y })),
    showLine: true,
    borderColor: colourFor(c.emphasis),
    borderWidth: 2,
    borderDash: c.dashed ? [6, 5] : [],
    borderCapStyle: 'round',
    borderJoinStyle: 'round',
    pointRadius: 0,
    pointHoverRadius: 0,
    tension: 0, // smooth curves were already sampled into a fine polyline
    fill: false,
    clip: false,
  }));

  figure._chart = new Chart(canvas, {
    type: 'scatter',
    data: { datasets },
    plugins: [econPlugin],
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      events: [],
      layout: { padding: { top: 16, right: 44, left: 4, bottom: 4 } },
      plugins: { legend: { display: false }, tooltip: { enabled: false }, econDiagram: { spec } },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: spec.xMax,
          grid: { display: false },
          border: { color: axis, width: 1.5 },
          ticks: { display: false },
          title: { display: !!spec.xLabel, text: spec.xLabel, color: axis, font, padding: { top: 20 } },
        },
        y: {
          type: 'linear',
          min: 0,
          max: spec.yMax,
          grid: { display: false },
          border: { color: axis, width: 1.5 },
          ticks: { display: false },
          afterFit: (scale) => {
            scale.width += 28; // room for P0-style tick labels
          },
          title: { display: !!spec.yLabel, text: spec.yLabel, color: axis, font },
        },
      },
    },
  });
}
