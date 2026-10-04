// Case-study figures: the model emits ```chart JSON blocks; we validate them
// and draw them with Chart.js (loaded globally as window.Chart).

const MAX_SERIES = 8; // the categorical palette has 8 fixed slots

export function parseChartSpec(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid chart JSON: ${e.message}` };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Chart spec must be an object.' };
  const labels = Array.isArray(raw.labels) ? raw.labels.map((l) => String(l)) : null;
  if (!labels || labels.length === 0) return { ok: false, error: 'Chart spec needs a non-empty "labels" array.' };
  const series = Array.isArray(raw.series) ? raw.series : null;
  if (!series || series.length === 0) return { ok: false, error: 'Chart spec needs a non-empty "series" array.' };

  const cleanSeries = series.slice(0, MAX_SERIES).map((s, i) => {
    const data = Array.isArray(s?.data) ? s.data : [];
    return {
      name: String(s?.name ?? `Series ${i + 1}`),
      data: labels.map((_, j) => {
        const v = data[j];
        if (v === null || v === undefined || v === '') return null;
        const n = typeof v === 'number' ? v : Number(String(v).replace(/[,%\s]/g, ''));
        return Number.isFinite(n) ? n : null;
      }),
    };
  });

  return {
    ok: true,
    spec: {
      type: raw.type === 'bar' ? 'bar' : 'line',
      title: raw.title ? String(raw.title) : '',
      xLabel: raw.xLabel ? String(raw.xLabel) : '',
      yLabel: raw.yLabel ? String(raw.yLabel) : '',
      source: raw.source ? String(raw.source) : '',
      labels,
      series: cleanSeries,
    },
  };
}

function fmt(v) {
  if (v === null || v === undefined) return '–';
  return Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toLocaleString('en-GB', { maximumFractionDigits: 2 });
}

// Markdown fallback used for downloads and for the accessible table view.
export function chartToMarkdownTable(spec) {
  const head = [spec.xLabel || '', ...spec.series.map((s) => s.name)];
  const rows = spec.labels.map((label, i) => [label, ...spec.series.map((s) => fmt(s.data[i]))]);
  const line = (cells) => `| ${cells.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`;
  const out = [];
  if (spec.title) out.push(`**${spec.title}**${spec.yLabel ? ` (${spec.yLabel})` : ''}`, '');
  out.push(line(head), line(head.map(() => '---')), ...rows.map(line));
  if (spec.source) out.push('', `_Source: ${spec.source}_`);
  return out.join('\n');
}

// Replace every ```chart block in a Markdown string with a Markdown table.
export function chartsToTables(markdown) {
  return markdown.replace(/```chart[^\n]*\n([\s\S]*?)```/g, (block, body) => {
    const parsed = parseChartSpec(body);
    return parsed.ok ? chartToMarkdownTable(parsed.spec) : block;
  });
}

function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function buildTable(spec) {
  const table = el('table', { class: 'chart-table' });
  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', { scope: 'col', text: spec.xLabel || '' }));
  spec.series.forEach((s) => hr.append(el('th', { scope: 'col', text: s.name })));
  thead.append(hr);
  const tbody = el('tbody');
  spec.labels.forEach((label, i) => {
    const tr = el('tr');
    tr.append(el('th', { scope: 'row', text: label }));
    spec.series.forEach((s) => tr.append(el('td', { text: fmt(s.data[i]) })));
    tbody.append(tr);
  });
  table.append(thead, tbody);
  return table;
}

/** Builds a <figure> with the chart, a legend (2+ series) and a data-table toggle. */
export function createChartFigure(spec) {
  const figure = el('figure', { class: 'chart-figure' });
  if (spec.title) figure.append(el('figcaption', { class: 'chart-title', text: spec.title }));

  const multi = spec.series.length > 1;
  if (multi) {
    const legend = el('ul', { class: 'chart-legend' });
    spec.series.forEach((s, i) => {
      const key = el('span', { class: `chart-key chart-key-${spec.type}`, style: `--key: var(--series-${i + 1})` });
      legend.append(el('li', {}, [key, document.createTextNode(s.name)]));
    });
    figure.append(legend);
  }

  const wrap = el('div', { class: 'chart-canvas' });
  const canvas = el('canvas', { role: 'img', 'aria-label': spec.title || 'Chart' });
  wrap.append(canvas);
  figure.append(wrap);

  const tableWrap = el('div', { class: 'chart-table-wrap', hidden: '' }, [buildTable(spec)]);
  const toggle = el('button', { type: 'button', class: 'link-button chart-toggle', text: 'Show data table' });
  toggle.addEventListener('click', () => {
    const show = tableWrap.hasAttribute('hidden');
    tableWrap.toggleAttribute('hidden', !show);
    toggle.textContent = show ? 'Hide data table' : 'Show data table';
  });

  const foot = el('div', { class: 'chart-foot' });
  if (spec.source) foot.append(el('span', { class: 'chart-source', text: `Source: ${spec.source}` }));
  foot.append(toggle);
  figure.append(foot, tableWrap);

  figure._draw = () => drawChart(figure, canvas, spec);
  return figure;
}

function drawChart(figure, canvas, spec) {
  const Chart = window.Chart;
  if (!Chart) return;
  if (figure._chart) figure._chart.destroy();

  const ink2 = cssVar('--text-secondary');
  const muted = cssVar('--text-muted');
  const grid = cssVar('--grid');
  const axis = cssVar('--axis');
  const surface = cssVar('--surface');
  const color = (i) => cssVar(`--series-${i + 1}`);
  const isLine = spec.type === 'line';

  const datasets = spec.series.map((s, i) =>
    isLine
      ? {
          label: s.name,
          data: s.data,
          borderColor: color(i),
          backgroundColor: color(i),
          borderWidth: 2,
          borderCapStyle: 'round',
          borderJoinStyle: 'round',
          pointRadius: 4,
          pointHoverRadius: 5,
          pointBorderColor: surface,
          pointBorderWidth: 2,
          spanGaps: true,
          tension: 0,
        }
      : {
          label: s.name,
          data: s.data,
          backgroundColor: color(i),
          borderColor: surface,
          borderWidth: { top: 0, left: 1, right: 1, bottom: 0 },
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: 'bottom',
          maxBarThickness: 24,
        },
  );

  const font = { family: getComputedStyle(document.body).fontFamily, size: 12 };
  figure._chart = new Chart(canvas, {
    type: spec.type,
    data: { labels: spec.labels, datasets },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false }, // HTML legend above the chart
        tooltip: {
          backgroundColor: cssVar('--tooltip-bg'),
          titleColor: cssVar('--text-primary'),
          bodyColor: ink2,
          borderColor: cssVar('--border'),
          borderWidth: 1,
          padding: 10,
          boxPadding: 4,
          usePointStyle: true,
          titleFont: { ...font, weight: '600' },
          bodyFont: font,
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: axis },
          ticks: { color: muted, font },
          title: { display: !!spec.xLabel, text: spec.xLabel, color: ink2, font },
        },
        y: {
          grid: { color: grid, lineWidth: 1 },
          border: { display: false },
          ticks: { color: muted, font, callback: (v) => fmt(v) },
          title: { display: !!spec.yLabel, text: spec.yLabel, color: ink2, font },
          beginAtZero: !isLine,
        },
      },
    },
  });
}
