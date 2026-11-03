/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/*
 * COGS: what opspile costs at list prices, for the admin team, over GET /api/admin/cogs
 * (src/cogs/report.js). Flow (requests, rows, tokens) is what the period used, also per message
 * and per new thread; stock (storage, the plan) what keeping it costs a month. The filters are
 * the period, the services and the customers and teams; they are the page's address, so a view
 * can be linked, and the header brings it back as it was left. A click on a service in the legend
 * picks it, on a customer or a team picks them; a service's row opens its metrics. Under the
 * chart, a treemap shows where the period's flow went: by service (and its metrics), customer or
 * team; a click on a tile picks it too.
 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const DAY_MS = 86400000;
const RANGES = [
  { id: '7d', label: '7 days', title: 'The last 7 days, today included' },
  { id: '30d', label: '30 days', title: 'The last 30 days, today included' },
  { id: '90d', label: '90 days', title: 'The last 90 days, today included' },
  { id: 'mtd', label: 'This month', title: 'Since the first of this month (UTC)' },
  { id: 'last', label: 'Last month', title: 'The whole of last month (UTC)' },
];
// A colour per service, the same in the chart, the legend and the tables. What shows one also
// names it (`data-series`), for the Spectrum 2 look's palette (ui/spectrum-cogs.css).
const COLORS = {
  bedrock: '#d97757',
  workers_ai: '#f2b93b',
  ai_search: '#a371f7',
  durable_objects: '#2f9e8f',
  workers: '#4c8dff',
  workers_logs: '#8b929b',
  r2: '#9bd35a',
  d1: '#3fb950',
  vectorize: '#e36fb4',
  queues: '#56d4dd',
  artifacts: '#c9a2ff',
  browser_run: '#e5534b',
  analytics_engine: '#b9c7d8',
};
const color = (id) => COLORS[id] || '#8b929b';

const state = {
  me: null,
  q: {
    range: '30d', from: '', to: '', service: [], org: [], team: [], allocate: true,
  },
  data: null,
  error: '',
  open: new Set(),
  sort: { orgs: 'flow', teams: 'flow' },
  all: { orgs: false },
  // What the treemap is of: services, orgs or teams.
  tm: 'services',
  loading: 0,
};

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const today = () => day(Date.now());

/** The days of a preset, both included (UTC, as the rollup counts them). */
function rangeDays(id) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (id === 'mtd') return { from: day(Date.UTC(y, m, 1)), to: today() };
  if (id === 'last') return { from: day(Date.UTC(y, m - 1, 1)), to: day(Date.UTC(y, m, 0)) };
  const n = Number.parseInt(id, 10) || 30;
  return { from: day(Date.now() - (n - 1) * DAY_MS), to: today() };
}

// ---- formatting ---------------------------------------------------------------------------

/** Dollars, with as many digits as a small amount needs. */
function usd(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  if (v === 0) return '$0';
  const a = Math.abs(v);
  if (a >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (a >= 1) return `$${v.toFixed(2)}`;
  if (a >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toPrecision(2)}`;
}
const num = (v) => {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
  if (a >= 1000) return `${(v / 1e3).toFixed(1)}k`;
  return a >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
};
/** A quantity in its unit: bytes as GB or MB, milliseconds as hours, the rest counted. */
function quantity(q, unit) {
  if (unit === 'bytes') {
    if (q >= 1e9) return `${(q / 1e9).toFixed(2)} GB`;
    if (q >= 1e6) return `${(q / 1e6).toFixed(1)} MB`;
    return `${(q / 1e3).toFixed(0)} kB`;
  }
  if (unit === 'ms') {
    if (q >= 3.6e6) return `${(q / 3.6e6).toFixed(1)} h`;
    if (q >= 6e4) return `${(q / 6e4).toFixed(0)} min`;
    return `${(q / 1e3).toFixed(0)} s`;
  }
  if (unit === 'USD') return usd(q);
  return `${num(q)} ${unit}`;
}
/** A unit price: "$0.30 / M requests". */
function price(p, per, unit) {
  if (p === null || p === undefined) return 'not priced';
  if (p === 0) return 'free';
  // A price as it is listed: $4.50, $0.0105.
  const listed = (v) => (v >= 1 ? `$${v.toFixed(2)}` : `$${Number(v.toPrecision(3))}`);
  if (unit === 'USD') return 'as the catalog says';
  const units = {
    1: '', 1e3: 'k ', 1e6: 'M ', 1e9: 'G',
  };
  if (unit === 'bytes') return `${listed(p)} / ${per === 1e9 ? 'GB' : `${num(per)} bytes`}`;
  if (unit === 'ms' && per === 3.6e6) return `${listed(p)} / hour`;
  if (per === 1) return `${listed(p)} / ${unit.replace(/s$/, '')}`;
  return `${listed(p)} / ${units[per] ?? `${num(per)} `}${unit}`;
}

// ---- the address --------------------------------------------------------------------------

function fromUrl() {
  const u = new URL(location.href);
  const list = (k) => (u.searchParams.get(k) || '').split(',').filter(Boolean);
  const q = {
    range: u.searchParams.get('range') || '',
    from: u.searchParams.get('from') || '',
    to: u.searchParams.get('to') || '',
    service: list('service'),
    org: list('org'),
    team: list('team'),
    allocate: u.searchParams.get('allocate') !== 'none',
  };
  if (!q.range && !q.from) q.range = '30d';
  if (q.range && q.range !== 'custom') Object.assign(q, rangeDays(q.range));
  else q.range = 'custom';
  state.q = q;
}

function toUrl({ push = true } = {}) {
  const q = state.q;
  const u = new URL(location.pathname, location.origin);
  if (q.range === 'custom') {
    u.searchParams.set('from', q.from);
    u.searchParams.set('to', q.to);
  } else if (q.range !== '30d') {
    u.searchParams.set('range', q.range);
  }
  for (const k of ['service', 'org', 'team']) if (q[k].length) u.searchParams.set(k, q[k].join(','));
  if (!q.allocate) u.searchParams.set('allocate', 'none');
  const next = `${u.pathname}${u.search}`;
  if (next !== `${location.pathname}${location.search}`) history[push ? 'pushState' : 'replaceState'](null, '', next);
}

function apiUrl() {
  const q = state.q;
  const p = new URLSearchParams({ from: q.from, to: q.to });
  for (const k of ['service', 'org', 'team']) if (q[k].length) p.set(k, q[k].join(','));
  if (!q.allocate) p.set('allocate', 'none');
  return `/api/admin/cogs?${p}`;
}

async function load() {
  const ticket = state.loading + 1;
  state.loading = ticket;
  $('body').classList.add('busy');
  try {
    const res = await fetch(apiUrl(), { credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (ticket !== state.loading) return;
    if (!res.ok) {
      state.error = body.error || `failed (${res.status})`;
    } else {
      state.error = '';
      state.data = body;
    }
  } catch (e) {
    if (ticket !== state.loading) return;
    state.error = e.message;
  }
  $('body').classList.remove('busy');
  render();
}

/** A change of the filters: the address, then the numbers. */
function change(fn, { push = true } = {}) {
  fn(state.q);
  toUrl({ push });
  renderBar();
  load();
}
const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

// ---- the filters --------------------------------------------------------------------------

function serviceName(id) {
  return state.data?.prices.services.find((s) => s.id === id)?.name || id;
}
const SHARED_ORG = '(shared)';
const NO_TEAM = '(none)';
function orgName(slug) {
  if (slug === '' || slug === SHARED_ORG) return 'Shared';
  return state.data?.orgs.find((o) => o.org === slug)?.name || slug;
}
function teamName(slug) {
  if (slug === '' || slug === NO_TEAM) return 'No team';
  return state.data?.teams.find((t) => t.team === slug)?.name || slug;
}

function renderBar() {
  const q = state.q;
  $('bar').hidden = false;
  $('ranges').innerHTML = RANGES.map((r) => `<button type="button" data-range="${r.id}" title="${esc(r.title)}" aria-pressed="${q.range === r.id}">${r.label}</button>`).join('');
  $('from').value = q.from;
  $('to').value = q.to;
  $('from').max = today();
  $('to').max = today();
  $('allocate').checked = q.allocate;
  const services = state.data?.prices.services || [];
  $('servicesBtn').textContent = `${q.service.length ? (q.service.length === 1 ? serviceName(q.service[0]) : `${q.service.length} services`) : 'All services'} ▾`;
  $('servicesMenu').innerHTML = `${services.map((s) => `<label><input type="checkbox" value="${esc(s.id)}"${q.service.includes(s.id) ? ' checked' : ''}><span class="dot" data-series="${esc(s.id)}" style="background:${color(s.id)}"></span>${esc(s.name)}</label>`).join('')}
    <div class="actions"><button type="button" class="link" data-services="all">All</button><button type="button" class="link" data-services="none">None picked</button></div>`;
  const orgs = (state.data?.orgs || []).filter((o) => o.org !== '');
  $('orgList').innerHTML = orgs.map((o) => `<option value="${esc(o.name)}">${esc(o.org)}</option>`).join('');
  const teams = state.data?.teams || [];
  $('team').innerHTML = `<option value="">All teams</option>${teams.map((t) => {
    const v = t.team || NO_TEAM;
    return `<option value="${esc(v)}"${q.team.length === 1 && q.team[0] === v ? ' selected' : ''}>${esc(t.name)}</option>`;
  }).join('')}`;
  const chips = [
    ...q.org.map((o) => ({ k: 'org', v: o, label: orgName(o) })),
    ...q.team.map((t) => ({ k: 'team', v: t, label: teamName(t) })),
    ...q.service.map((s) => ({ k: 'service', v: s, label: serviceName(s), dot: color(s) })),
  ];
  $('chips').innerHTML = chips.map((c) => `<span class="chip">${c.dot ? `<span class="dot" data-series="${esc(c.v)}" style="background:${c.dot}"></span>` : ''}${esc(c.label)}<button type="button" data-drop="${c.k}" data-value="${esc(c.v)}" aria-label="Remove ${esc(c.label)}">×</button></span>`).join('')
    + (chips.length > 1 ? '<button type="button" class="link" data-drop="all">Clear</button>' : '');
}

// ---- the numbers --------------------------------------------------------------------------

function kpis(d) {
  const t = d.totals;
  const days = `${d.days} day${d.days === 1 ? '' : 's'}`;
  return `<div class="kpis">
    <div class="kpi" title="What the work of the period cost at list prices: requests, rows, tokens, operations"><div class="k">Flow, ${days}</div><div class="v">${usd(t.flow)}</div><div class="s">${usd(t.flowMonthly)} a month at this rate</div></div>
    <div class="kpi" title="The flow divided by the messages of the period"><div class="k">Per message</div><div class="v">${usd(t.perMessage)}</div><div class="s">${num(t.messages)} messages</div></div>
    <div class="kpi" title="The flow divided by the threads started in the period"><div class="k">Per thread</div><div class="v">${usd(t.perThread)}</div><div class="s">${num(t.threads)} new threads</div></div>
    <div class="kpi" title="What keeping it costs a month: storage, vectors, the plan"><div class="k">Stock, a month</div><div class="v">${usd(t.stock)}</div><div class="s">storage and the plan</div></div>
    <div class="kpi" title="Flow at this rate plus stock"><div class="k">A month, all in</div><div class="v">${usd(t.flowMonthly + t.stock)}</div><div class="s">flow at this rate + stock</div></div>
  </div>`;
}

/** The top of a chart's scale: 1, 2, 2.5 or 5 times a power of ten, at or above `v`. */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((f) => f * p).find((x) => x >= v);
}

/** What a column of the chart is, per its unit: "hour", "day" or "week". */
const UNITS = { hour: 'hour', day: 'day', week: 'week' };

/** A column's time, for its tooltip: an hour, a day, or a week's first and last day (UTC). */
function when(unit, x) {
  if (unit === 'hour') {
    const h = Number(x.at.slice(11, 13));
    return `${x.at.slice(0, 10)} ${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00 UTC`;
  }
  if (unit === 'week') return x.until && x.until !== x.at ? `${x.at} – ${x.until}` : x.at;
  return x.at;
}

/**
 * Which columns have a label under them, at `bw` pixels a column: by the hour, every few hours
 * (the date at midnight); else every few columns.
 */
function labelled(unit, cols, bw) {
  const fits = (k) => k * bw >= 48;
  if (unit === 'hour') {
    const step = [1, 2, 3, 6, 12, 24].find(fits) || 24;
    return (x) => {
      const h = Number(x.at.slice(11, 13));
      if (h % step) return '';
      return h ? `${x.at.slice(11, 13)}:00` : x.at.slice(5, 10);
    };
  }
  const every = Math.max(1, Math.ceil(cols.length / Math.max(2, Math.floor((bw * cols.length) / 60))));
  return (x, i) => (i % every === 0 ? x.at.slice(5, 10) : '');
}

/**
 * Stacked bars, an hour, a day or a week each (as many columns, roughly, whatever the period), a
 * colour per service, biggest at the bottom; drawn at the width it has (`width`, in CSS pixels),
 * so the text is not stretched.
 */
function chart(d, width) {
  const order = d.services.filter((s) => s.flow > 0).map((s) => s.id);
  const { unit, columns } = d.chart;
  const totals = columns.map((x) => order.reduce((n, id) => n + (x.services[id] || 0), 0));
  const top = Math.max(...totals, 0);
  if (!top) return '<div class="empty">Nothing counted in this period yet.</div>';
  const max = niceMax(top);
  const W = Math.max(320, Math.round(width));
  const H = 220;
  const L = 56;
  const B = 20;
  const n = columns.length;
  const bw = (W - L) / n;
  const gap = Math.max(Math.min(4, bw * 0.2), bw - 56);
  const y = (v) => H - B - (v / max) * (H - B - 8);
  const steps = [0, 0.25, 0.5, 0.75, 1];
  const grid = steps.map((f) => `<line x1="${L}" x2="${W}" y1="${y(max * f)}" y2="${y(max * f)}"/>`).join('');
  // Labels on the halves: a quarter of 2.5 or 5 is not a round number.
  const ticks = [0, 0.5, 1].map((f) => `<text x="${L - 8}" y="${y(max * f) + 4}" text-anchor="end">${usd(max * f)}</text>`).join('');
  const label = labelled(unit, columns, bw);
  // By the hour, a line at each midnight.
  const days = unit === 'hour' ? columns.map((x, i) => (i && x.at.slice(11, 13) === '00' ? `<line x1="${L + i * bw}" x2="${L + i * bw}" y1="8" y2="${H - B}"/>` : '')).join('') : '';
  const cols = columns.map((x, i) => {
    const x0 = L + i * bw;
    let acc = 0;
    const rects = order.map((id) => {
      const v = x.services[id] || 0;
      if (!v) return '';
      const t = y(acc + v);
      const r = `<rect x="${x0 + gap / 2}" y="${t}" width="${Math.max(1, bw - gap)}" height="${Math.max(0.5, y(acc) - t)}" fill="${color(id)}" data-series="${esc(id)}"/>`;
      acc += v;
      return r;
    }).join('');
    const text = label(x, i);
    const tick = text ? `<text x="${x0 + bw / 2}" y="${H - 5}" text-anchor="middle">${text}</text>` : '';
    return `<g class="col" data-i="${i}"><rect class="hover" x="${x0}" y="0" width="${bw}" height="${H - B}"/>${rects}<g class="axis">${tick}</g></g>`;
  }).join('');
  const legend = order.map((id) => `<button type="button" data-service="${esc(id)}" aria-pressed="${state.q.service.includes(id)}" title="Only ${esc(serviceName(id))} (again: all)"><span class="dot" data-series="${esc(id)}" style="background:${color(id)}"></span>${esc(serviceName(id))}</button>`).join('');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Flow cost per ${UNITS[unit]}, by service">
    <g class="grid">${grid}${days}</g><g class="axis">${ticks}</g>${cols}</svg><div class="tip" id="tip" hidden></div>
    <div class="legend">${legend}</div>`;
}

/** The chart again, at the width its card has now. */
function drawChart() {
  const box = $('chart');
  if (box && state.data) box.innerHTML = chart(state.data, box.clientWidth);
}

// ---- the treemap --------------------------------------------------------------------------

/** How far a row of tiles of areas `row` along a side `side` is from square: 1 is square. */
function worst(row, side) {
  const total = row.reduce((n, r) => n + r.area, 0);
  const max = Math.max(...row.map((r) => r.area));
  const min = Math.min(...row.map((r) => r.area));
  return Math.max((side * side * max) / (total * total), (total * total) / (side * side * min));
}

/**
 * Tiles for `items` (`{ value }`, biggest first) in the box `x, y, w, h`, as square as they go
 * (Bruls, Huizing and van Wijk's squarified treemap): each item with its `x, y, w, h`.
 */
function squarify(items, box) {
  let {
    x, y, w, h,
  } = box;
  const total = items.reduce((n, it) => n + it.value, 0);
  if (!(total > 0) || w <= 0 || h <= 0) return [];
  let rest = items.filter((it) => it.value > 0).map((it) => ({ it, area: (it.value / total) * w * h }));
  const out = [];
  while (rest.length) {
    const side = Math.min(w, h);
    const row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) {
      row.push(rest[i]);
      i += 1;
    }
    const thick = row.reduce((n, r) => n + r.area, 0) / side;
    let off = 0;
    for (const r of row) {
      const len = r.area / thick;
      out.push(w >= h ? {
        ...r.it, x, y: y + off, w: thick, h: len,
      } : {
        ...r.it, x: x + off, y, w: len, h: thick,
      });
      off += len;
    }
    if (w >= h) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      h -= thick;
    }
    rest = rest.slice(i);
  }
  return out;
}

/** A label cut to what fits in `w` pixels at about 6.5 pixels a character. */
const fit = (text, w) => {
  const n = Math.floor((w - 10) / 6.5);
  if (n < 3) return '';
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

/** What the treemap is of, with the names its switch shows. */
const TM = { services: 'Services', orgs: 'Customers', teams: 'Teams' };

/**
 * The tiles of the treemap, `{ value, name, color, series, pick, children }`: the services' flow (and their
 * metrics' inside), or the customers' or teams' (the shared rows grey).
 */
function tmItems(d, by) {
  if (by === 'services') {
    return d.services.filter((s) => s.flow > 0).map((s) => ({
      value: s.flow,
      name: s.name,
      color: color(s.id),
      series: s.id,
      pick: `data-service="${esc(s.id)}"`,
      children: s.metrics.filter((m) => !m.stock && m.usd > 0)
        .map((m) => ({ value: m.usd, name: m.detail ? `${m.label}, ${m.detail}` : m.label })),
    }));
  }
  const key = by === 'orgs' ? 'org' : 'team';
  return [...d[by]].filter((g) => g.flow > 0).sort((a, b) => b.flow - a.flow).map((g, i) => ({
    value: g.flow,
    name: g.name,
    // The biggest the strongest, the shared rows grey.
    color: g[key] === '' ? '#8b929b' : `color-mix(in srgb, var(--accent) ${Math.max(35, 100 - i * 8)}%, var(--card))`,
    series: g[key] === '' ? 'shared' : null,
    pick: `data-pick="${key}" data-value="${esc(g[key])}"`,
    picked: state.q[key].includes(g[key] || (key === 'org' ? SHARED_ORG : NO_TEAM)),
  }));
}

/** The treemap of what `state.tm` says, at the width it has (`width`, in CSS pixels). */
function treemap(d, width) {
  const items = tmItems(d, state.tm);
  const total = items.reduce((n, it) => n + it.value, 0);
  if (!total) return '<div class="empty">Nothing counted in this period yet.</div>';
  const W = Math.max(320, Math.round(width));
  const H = 280;
  const share = (v) => `${((v / total) * 100).toFixed(v / total < 0.1 ? 1 : 0)}%`;
  const label = (t, name, v, light) => {
    if (t.w < 44 || t.h < 20) return '';
    const head = fit(name, t.w);
    const sub = t.h >= 36 ? fit(`${usd(v)} · ${share(v)}`, t.w) : '';
    const cls = light ? 'tl light' : 'tl';
    return `<text class="${cls}" x="${t.x + 6}" y="${t.y + 15}">${esc(head)}</text>${sub ? `<text class="${cls} v" x="${t.x + 6}" y="${t.y + 30}">${esc(sub)}</text>` : ''}`;
  };
  const tiles = squarify(items, {
    x: 0, y: 0, w: W, h: H,
  }).map((t, i) => {
    const tip = `data-tm="${i}"`;
    // A service's metrics inside it, under its name, when there is room.
    let inner = '';
    if (t.children?.length > 1 && t.w > 90 && t.h > 70) {
      const kids = squarify([...t.children].sort((a, b) => b.value - a.value), {
        x: t.x + 2, y: t.y + 36, w: t.w - 4, h: t.h - 38,
      });
      inner = kids.map((k, j) => `<g class="tile" ${t.pick} ${tip} data-kid="${j}"><rect x="${k.x}" y="${k.y}" width="${Math.max(0, k.w)}" height="${Math.max(0, k.h)}" fill="${t.color}"${t.series ? ` data-series="${esc(t.series)}"` : ''} fill-opacity="${j % 2 ? 0.55 : 0.75}"/>${k.w >= 60 && k.h >= 20 ? `<text class="tl" x="${k.x + 5}" y="${k.y + 14}">${esc(fit(k.name, k.w))}</text>` : ''}</g>`).join('');
      t.kids = kids;
    }
    return `<g class="tile${t.picked ? ' on' : ''}" ${t.pick} ${tip}><rect x="${t.x}" y="${t.y}" width="${Math.max(0, t.w)}" height="${Math.max(0, t.h)}" fill="${t.color}"${t.series ? ` data-series="${esc(t.series)}"` : ''}/>${label(t, t.name, t.value, state.tm !== 'services')}</g>${inner}`;
  }).join('');
  state.tmTiles = { items, total };
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Where the flow goes, by ${esc(TM[state.tm].toLowerCase())}">${tiles}</svg><div class="tip" id="tmtip" hidden></div>`;
}

/** The treemap again, at the width its card has now. */
function drawTreemap() {
  const box = $('treemap');
  if (box && state.data) box.innerHTML = treemap(state.data, box.clientWidth);
}

function servicesTable(d) {
  if (!d.services.length) return '<div class="empty">No service counted anything in this period.</div>';
  const rows = d.services.map((s) => {
    const open = state.open.has(s.id);
    const metrics = open ? s.metrics.map((m) => `<tr class="metric"><td>${esc(m.label)}${m.detail ? ` <span class="sub">${esc(m.detail)}</span>` : ''}</td>
      <td class="n" colspan="2">${quantity(m.quantity, m.unit)}${m.stock ? ' <span class="sub">on average</span>' : ''}</td>
      <td class="n m">${price(m.price, m.per, m.unit)}${m.stock ? ' a month' : ''}</td>
      <td class="n">${m.stock ? '' : usd(m.usd)}</td><td class="n">${m.stock ? usd(m.usd) : ''}</td></tr>`).join('') : '';
    return `<tr class="pick" data-open="${esc(s.id)}" aria-expanded="${open}"><td><span class="name"><span class="twist">${open ? '▾' : '▸'}</span><span class="dot" data-series="${esc(s.id)}" style="background:${color(s.id)}"></span><span>${esc(s.name)}</span></span></td>
      <td class="n">${usd(s.perMessage)}</td><td class="n">${usd(s.perThread)}</td><td></td>
      <td class="n">${usd(s.flow)}</td><td class="n">${usd(s.stock)}</td></tr>${metrics}`;
  }).join('');
  const t = d.totals;
  return `<div class="scroll"><table>
    <thead><tr><th>Service</th><th class="n">Per message</th><th class="n">Per thread</th><th class="n">Unit price</th><th class="n">Flow</th><th class="n">Stock / month</th></tr></thead>
    <tbody>${rows}<tr class="total"><td>All</td><td class="n">${usd(t.perMessage)}</td><td class="n">${usd(t.perThread)}</td><td></td><td class="n">${usd(t.flow)}</td><td class="n">${usd(t.stock)}</td></tr></tbody>
  </table></div>`;
}

const SORTS = {
  flow: (a, b) => b.flow - a.flow,
  messages: (a, b) => b.messages - a.messages,
  threads: (a, b) => b.threads - a.threads,
  perMessage: (a, b) => (b.perMessage ?? -1) - (a.perMessage ?? -1),
  perThread: (a, b) => (b.perThread ?? -1) - (a.perThread ?? -1),
  stock: (a, b) => b.stock - a.stock,
};

/** Customers or teams (`kind`), sortable; a click picks one. */
function whoTable(kind, list) {
  const key = kind === 'orgs' ? 'org' : 'team';
  const sorted = [...list].filter((g) => g.flow || g.messages || g.stock).sort(SORTS[state.sort[kind]]);
  if (!sorted.length) return '<div class="empty">Nothing in this period.</div>';
  const limit = kind === 'orgs' && !state.all.orgs ? 25 : Infinity;
  const top = Math.max(...sorted.map((g) => g.flow), 0);
  const head = (id, label, title) => `<th class="n"><button type="button" class="sort" data-sort="${kind}" data-by="${id}" title="${esc(title)}"${state.sort[kind] === id ? ' data-on' : ''}>${label}</button></th>`;
  const rows = sorted.slice(0, limit).map((g) => {
    const picked = state.q[key].includes(g[key] || (key === 'org' ? SHARED_ORG : NO_TEAM));
    const type = kind === 'orgs' && g.type && !['customer', 'shared'].includes(g.type) ? ` <span class="tag">${esc(g.type)}</span>` : '';
    const shared = g.shared > 0 ? `<div class="sub">${usd(g.shared)} shared out</div>` : '';
    return `<tr class="pick${picked ? ' on' : ''}" data-pick="${key}" data-value="${esc(g[key])}" title="${picked ? 'Picked: click to drop' : 'Only this one'}">
      <td><div class="name"><span>${esc(g.name)}</span>${type}</div><div class="bar-in" style="width:${top ? Math.max(1, (g.flow / top) * 100) : 0}%"></div></td>
      <td class="n">${num(g.messages)}</td><td class="n">${num(g.threads)}</td>
      <td class="n">${usd(g.flow)}${shared}</td><td class="n">${usd(g.perMessage)}</td><td class="n">${usd(g.perThread)}</td><td class="n">${usd(g.stock)}</td></tr>`;
  }).join('');
  const more = sorted.length > limit ? `<div class="more"><button type="button" class="link" data-all="${kind}">Show all ${sorted.length}</button></div>` : '';
  return `<div class="scroll"><table>
    <thead><tr><th>${kind === 'orgs' ? 'Customer' : 'Team'}</th>${head('messages', 'Messages', 'Messages in the period')}${head('threads', 'Threads', 'Threads started in the period')}${head('flow', 'Flow', 'What their work cost in the period')}${head('perMessage', 'Per message', 'Flow per message')}${head('perThread', 'Per thread', 'Flow per new thread')}${head('stock', 'Stock / month', 'What keeping theirs costs a month')}</tr></thead>
    <tbody>${rows}</tbody></table></div>${more}`;
}

function prices(d) {
  const p = d.prices;
  const rows = p.services.map((s) => {
    const metrics = s.metrics.map((m) => {
      let what = price(m.usd, m.per, m.unit);
      if (m.usd === null) {
        const key = { input_tokens: 'input', output_tokens: 'output', cache_read_tokens: 'cache_read', cache_write_tokens: 'cache_write', cache_write_1h_tokens: 'cache_write_1h' }[m.id];
        what = s.models.map((x) => `${esc(x.id)}: ${usd(x[key] ?? 0)}`).join(', ');
        what = what ? `per M ${esc(m.unit)}: ${what}` : 'per model';
      } else {
        what = esc(what);
      }
      return `<tr><td>${esc(m.label)}${m.stock ? ' <span class="sub">a month</span>' : ''}</td><td>${what}</td><td class="m">${esc(m.included || '')}</td></tr>`;
    }).join('');
    return `<tr><td colspan="3"><span class="name"><span class="dot" data-series="${esc(s.id)}" style="background:${color(s.id)}"></span><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>${s.about ? ` <span class="sub">${esc(s.about)}</span>` : ''}${s.included ? ` <span class="sub">· included: ${esc(s.included)}</span>` : ''}</span></td></tr>${metrics}`;
  }).join('');
  return `<details class="card prices"><summary>List prices, as of ${esc(p.asOf)}</summary>
    <p class="hint">Costs are list prices at the margin: what a plan includes is listed, not taken off, so a customer's cost does not depend on who came first in the month.</p>
    <div class="scroll"><table><thead><tr><th>Metric</th><th>Price</th><th>Included in the plan</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function notes(d) {
  const since = Object.entries(d.since || {}).map(([src, at]) => `${{ meter: 'the Worker\'s own counts', account: 'Cloudflare\'s analytics', d1: 'messages and storage' }[src] || src} since ${at}`);
  const parts = [
    'Flow is counted where the work happens and in Cloudflare\'s analytics, and rolled up every 20 minutes; storage once a day.',
    d.allocate === 'messages' ? 'Common costs (work for no customer in particular) are shared out by each customer\'s messages.' : 'Common costs are shown as Shared.',
    since.length ? `Data: ${since.join(', ')}.` : 'No data rolled up yet.',
  ];
  const unpriced = d.unpriced?.length ? `<p class="hint">Counted, but without a price here: ${d.unpriced.map(esc).join(', ')}.</p>` : '';
  return `<p class="hint">${parts.map(esc).join(' ')}</p>${unpriced}`;
}

function render() {
  renderBar();
  const d = state.data;
  if (state.error && !d) {
    $('body').innerHTML = `<div class="empty err">${esc(state.error)}</div>`;
    return;
  }
  if (!d) return;
  $('body').innerHTML = `${state.error ? `<p class="hint err">${esc(state.error)}</p>` : ''}
    ${kpis(d)}
    <div class="card"><h2>Flow per ${UNITS[d.chart.unit]} <span class="sub">${esc(d.from)} – ${esc(d.to)}</span></h2><div class="chart" id="chart"></div></div>
    <div class="card"><h2 class="split"><span>Where the flow goes</span><span class="seg" id="tmBy">${Object.entries(TM).map(([id, name]) => `<button type="button" data-tm-by="${id}" aria-pressed="${state.tm === id}">${name}</button>`).join('')}</span></h2><div class="treemap" id="treemap"></div></div>
    <div class="cols">
      <div class="card"><h2>Services</h2>${servicesTable(d)}</div>
      <div class="card"><h2>Customers</h2>${whoTable('orgs', d.orgs)}</div>
    </div>
    <div class="card"><h2>Teams</h2>${whoTable('teams', d.teams)}</div>
    ${prices(d)}
    ${notes(d)}`;
  drawChart();
  drawTreemap();
}

// ---- events -------------------------------------------------------------------------------

/** A tile's name, flow and share of the treemap, and its metric's when it is one. */
function tmTooltip(e, g) {
  const tip = $('tmtip');
  if (!tip) return;
  if (!g || !state.tmTiles) { tip.hidden = true; return; }
  const { items, total } = state.tmTiles;
  const t = items[Number(g.dataset.tm)];
  const k = g.dataset.kid !== undefined ? [...t.children].sort((a, b) => b.value - a.value)[Number(g.dataset.kid)] : null;
  const pct = (v) => `${((v / total) * 100).toFixed(1)}%`;
  tip.innerHTML = `<div class="t">${esc(t.name)} · ${usd(t.value)} · ${pct(t.value)}</div>${k ? `<div class="row"><span class="dot" style="background:${t.color}"></span><span>${esc(k.name)}</span><span>${usd(k.value)}</span></div>` : ''}<div class="sub">${t.picked ? 'Picked: click to drop' : 'Click: only this one'}</div>`;
  tip.hidden = false;
  const box = $('treemap').getBoundingClientRect();
  const left = Math.min(e.clientX - box.left + 12, box.width - tip.offsetWidth - 4);
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, e.clientY - box.top - tip.offsetHeight - 10)}px`;
}

function tooltip(e) {
  tmTooltip(e, e.target.closest?.('#treemap g.tile'));
  const g = e.target.closest?.('g.col');
  const tip = $('tip');
  if (!tip) return;
  if (!g || !state.data) { tip.hidden = true; return; }
  const { unit, columns } = state.data.chart;
  const x = columns[Number(g.dataset.i)];
  const items = Object.entries(x.services).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = items.reduce((n, [, v]) => n + v, 0);
  tip.innerHTML = `<div class="t">${esc(when(unit, x))} · ${usd(total)}</div>${items.map(([id, v]) => `<div class="row"><span class="dot" data-series="${esc(id)}" style="background:${color(id)}"></span><span>${esc(serviceName(id))}</span><span>${usd(v)}</span></div>`).join('') || '<div class="sub">Nothing counted</div>'}`;
  tip.hidden = false;
  const box = $('chart').getBoundingClientRect();
  const left = Math.min(e.clientX - box.left + 12, box.width - tip.offsetWidth - 4);
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, e.clientY - box.top - tip.offsetHeight - 10)}px`;
}

function wire() {
  $('ranges').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (b) change((q) => Object.assign(q, { range: b.dataset.range }, rangeDays(b.dataset.range)));
  });
  const dates = () => {
    const from = $('from').value;
    const to = $('to').value;
    if (!from || !to) return;
    change((q) => Object.assign(q, { range: 'custom', from: from <= to ? from : to, to: from <= to ? to : from }));
  };
  $('from').addEventListener('change', dates);
  $('to').addEventListener('change', dates);
  $('allocate').addEventListener('change', () => change((q) => { q.allocate = $('allocate').checked; }));
  $('servicesMenu').addEventListener('change', () => {
    const picked = [...$('servicesMenu').querySelectorAll('input:checked')].map((i) => i.value);
    change((q) => { q.service = picked; }, { push: false });
  });
  $('servicesMenu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-services]');
    if (!b) return;
    change((q) => { q.service = []; });
    $('servicesMenu').hidePopover();
  });
  $('team').addEventListener('change', () => change((q) => { q.team = $('team').value ? [$('team').value] : []; }));
  const pickOrg = () => {
    const v = $('orgSearch').value.trim().toLowerCase();
    if (!v) return;
    const o = (state.data?.orgs || []).find((x) => x.org !== '' && (x.name.toLowerCase() === v || x.org === v));
    if (!o) return;
    $('orgSearch').value = '';
    change((q) => { q.org = q.org.includes(o.org) ? q.org : [...q.org, o.org]; });
  };
  $('orgSearch').addEventListener('change', pickOrg);
  $('orgSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') pickOrg(); });
  $('chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-drop]');
    if (!b) return;
    if (b.dataset.drop === 'all') change((q) => Object.assign(q, { service: [], org: [], team: [] }));
    else change((q) => { q[b.dataset.drop] = q[b.dataset.drop].filter((x) => x !== b.dataset.value); });
  });
  $('body').addEventListener('click', (e) => {
    const by = e.target.closest('[data-tm-by]');
    if (by) {
      state.tm = by.dataset.tmBy;
      $('tmBy').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === by)));
      drawTreemap();
      return;
    }
    const svc = e.target.closest('[data-service]');
    if (svc) {
      const id = svc.dataset.service;
      change((q) => { q.service = q.service.length === 1 && q.service[0] === id ? [] : [id]; });
      return;
    }
    const sort = e.target.closest('[data-sort]');
    if (sort) {
      state.sort[sort.dataset.sort] = sort.dataset.by;
      render();
      return;
    }
    const all = e.target.closest('[data-all]');
    if (all) {
      state.all[all.dataset.all] = true;
      render();
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      const id = open.dataset.open;
      if (state.open.has(id)) state.open.delete(id);
      else state.open.add(id);
      render();
      return;
    }
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const k = pick.dataset.pick;
      // The shared rows, in the address: (shared) for a customer, (none) for a team.
      const v = pick.dataset.value || (k === 'org' ? SHARED_ORG : NO_TEAM);
      change((q) => { q[k] = toggle(q[k], v); });
    }
  });
  $('body').addEventListener('pointermove', tooltip);
  $('body').addEventListener('pointerleave', () => { if ($('tip')) $('tip').hidden = true; });
  window.addEventListener('popstate', () => { fromUrl(); renderBar(); load(); });
  let resizing = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizing);
    resizing = requestAnimationFrame(() => {
      drawChart();
      drawTreemap();
    });
  });
  window.addEventListener('opspile:signedin', () => load());
}

// ---- start --------------------------------------------------------------------------------

(async () => {
  const res = await fetch('/api/me', { credentials: 'same-origin' }).catch(() => null);
  const me = res && res.ok ? await res.json().catch(() => null) : null;
  if (!me) {
    $('body').innerHTML = '<div class="empty">Not signed in.</div>';
    return;
  }
  state.me = me;
  Header.user(me, Header.role(me));
  Header.init(me);
  if (!me.admin) {
    $('body').innerHTML = `<div class="empty">What opspile costs is for the admin team. <a href="${esc(Header.href('inbox'))}">Back to the inbox</a></div>`;
    return;
  }
  fromUrl();
  toUrl({ push: false });
  wire();
  renderBar();
  load();
})();
