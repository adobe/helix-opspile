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
 * Topics: the topic map (src/topicmap.js) for the admin team, over GET /api/admin/topics. What
 * the channel threads are about, found from what was said in them (the topics), drawn as one
 * force-directed graph with the Adobe people who posted in them, Clef's topics on them (the
 * tags, as the inbox's Topic filter has them) and the customers they are for. A line joins two
 * that share threads, thicker the more; the topics are the hubs, so with them shown a line joins
 * a topic to the others, and a person to a customer, and without them any two kinds. A node is as
 * big as its threads.
 *
 * Pointing at a node shows what it is joined to; a click picks it, and the panel beside the graph
 * says what it is: a topic's theme, its people, customers and tags, its threads (each a link into
 * the inbox), and how many of them Clef gave a tag at all, which is where Clef's topics miss what
 * the threads are about. Without a pick the panel lists the topics. The filters (a team, the
 * kinds shown, the threads a line needs) and the pick are the page's address; the header brings
 * it back as it was left. Rebuild clusters the threads again (POST /api/admin/topics).
 *
 * The layout is the page's own: d3-force's model (many-body repulsion, links as springs, a pull
 * to the centre, collision), in a loop of animation frames; it settles before it is first drawn,
 * and keeps where every node was when the filters change.
 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const SVG = 'http://www.w3.org/2000/svg';

const TYPES = [
  { id: 'person', label: 'People', one: 'Person', title: 'Adobe people who posted in the threads' },
  { id: 'topic', label: 'Topics', one: 'Topic', title: 'What the threads are about, found from what was said in them' },
  { id: 'tag', label: 'Tags', one: 'Tag', title: 'Clef\'s topics on the threads, as the inbox\'s Topic filter has them' },
  { id: 'org', label: 'Customers', one: 'Customer', title: 'Who the threads are for: customers, partners and vendors' },
];
const TYPE = Object.fromEntries(TYPES.map((t) => [t.id, t]));
const MINS = [1, 2, 3, 5, 8];
/** People and customers with a name on the graph, the most threads first; the rest on pointing. */
const NAMED = 12;
const THREADS_SHOWN = 30;

const state = {
  me: null,
  latest: null,
  available: false,
  error: '',
  building: false,
  q: {
    team: '', hide: [], min: 2, sel: '',
  },
  find: '',
  hover: '',
  graph: null,
  more: false,
  // The topics' table: by their threads, or the least tagged first.
  sort: 'threads',
};

// ---- the address ------------------------------------------------------------------------

function fromUrl() {
  const p = new URLSearchParams(location.search);
  const min = Number(p.get('min'));
  state.q = {
    team: p.get('team') || '',
    hide: (p.get('hide') || '').split(',').filter((t) => TYPE[t]),
    min: MINS.includes(min) ? min : 2,
    sel: p.get('sel') || '',
  };
}

function toUrl({ push = true } = {}) {
  const p = new URLSearchParams();
  const { q } = state;
  if (q.team) p.set('team', q.team);
  if (q.hide.length) p.set('hide', q.hide.join(','));
  if (q.min !== 2) p.set('min', String(q.min));
  if (q.sel) p.set('sel', q.sel);
  const url = `${location.pathname}${p.size ? `?${p}` : ''}`;
  if (url !== `${location.pathname}${location.search}`) {
    history[push ? 'pushState' : 'replaceState'](null, '', url);
  }
  Header.remember();
}

// ---- the graph's data -------------------------------------------------------------------

const map = () => state.latest?.map;
const isCustomer = (slug) => slug && !slug.startsWith('_') && map().orgs[slug]?.type !== 'internal';
const orgName = (slug) => map().orgs[slug]?.name || slug;
const shownTypes = () => TYPES.map((t) => t.id).filter((id) => !state.q.hide.includes(id));

/**
 * The nodes and lines for the filters: every person, topic, tag and customer of the team's
 * threads (`all`, for the panel), those of the kinds shown with a line (`nodes`; topics even
 * without one), the lines of at least `min` threads, and who is joined to whom.
 */
function graphOf() {
  const m = map();
  const { q } = state;
  const shown = shownTypes();
  const threads = m.threads.filter((t) => !q.team || t.team === q.team);
  const all = new Map();
  const node = (type, key, label) => {
    const id = `${type}:${key}`;
    let n = all.get(id);
    if (!n) {
      n = {
        id, type, key: String(key), label, threads: [],
      };
      all.set(id, n);
    }
    return n;
  };
  const hub = shown.includes('topic');
  const joined = (a, b) => a !== b && (!hub || a === 'topic' || b === 'topic'
    || (a === 'person' && b === 'org') || (a === 'org' && b === 'person'));
  const weights = new Map();
  for (const t of threads) {
    const on = [node('topic', t.topic, m.topics[t.topic]?.label || `Topic ${t.topic + 1}`)];
    for (const p of Object.keys(t.staff || {})) on.push(node('person', p, m.people[p] || `#${p}`));
    for (const g of t.tags || []) on.push(node('tag', g, m.tags[g] || g));
    if (isCustomer(t.org)) on.push(node('org', t.org, orgName(t.org)));
    for (const n of on) n.threads.push(t);
    const vis = on.filter((n) => shown.includes(n.type));
    for (let i = 0; i < vis.length; i += 1) {
      for (let j = i + 1; j < vis.length; j += 1) {
        if (joined(vis[i].type, vis[j].type)) {
          const key = [vis[i].id, vis[j].id].sort().join('|');
          weights.set(key, (weights.get(key) || 0) + 1);
        }
      }
    }
  }
  const edges = [...weights].filter(([, w]) => w >= q.min).map(([key, w]) => {
    const [a, b] = key.split('|');
    return { a: all.get(a), b: all.get(b), w };
  });
  const neighbors = new Map();
  for (const e of edges) {
    if (!neighbors.has(e.a.id)) neighbors.set(e.a.id, new Set());
    if (!neighbors.has(e.b.id)) neighbors.set(e.b.id, new Set());
    neighbors.get(e.a.id).add(e.b.id);
    neighbors.get(e.b.id).add(e.a.id);
  }
  const nodes = [...all.values()].filter((n) => shown.includes(n.type)
    && (neighbors.has(n.id) || n.type === 'topic' || shown.length === 1));
  // The people and customers with a name on the graph: those of the most threads.
  for (const type of ['person', 'org']) {
    nodes.filter((n) => n.type === type).sort((a, b) => b.threads.length - a.threads.length)
      .slice(0, NAMED).forEach((n) => { n.named = true; });
  }
  return {
    all, nodes, edges, neighbors, threads,
  };
}

// ---- the layout: d3-force's model -------------------------------------------------------

const sim = {
  nodes: [], edges: [], alpha: 0, target: 0, frame: 0, pos: new Map(),
};
const radius = (n) => ({
  topic: 6, tag: 5, person: 3, org: 3,
}[n.type] + Math.sqrt(n.threads.length) * 1.7);

/** Starts the layout of `graph`, each node where it was, a new one beside a neighbour. */
function layout(graph) {
  const degree = new Map();
  for (const e of graph.edges) {
    degree.set(e.a.id, (degree.get(e.a.id) || 0) + 1);
    degree.set(e.b.id, (degree.get(e.b.id) || 0) + 1);
  }
  const maxW = Math.max(1, ...graph.edges.map((e) => e.w));
  const fresh = graph.nodes.filter((n) => !sim.pos.has(n.id)).length;
  graph.nodes.forEach((n, i) => {
    const old = sim.pos.get(n.id);
    Object.assign(n, { vx: 0, vy: 0, r: radius(n) });
    if (old) {
      n.x = old.x;
      n.y = old.y;
      return;
    }
    const near = [...(graph.neighbors.get(n.id) || [])].map((id) => sim.pos.get(id)).find(Boolean);
    // Phyllotaxis, as d3 places nodes: evenly spread, the first ones in the middle.
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const dist = near ? 12 : 10 * Math.sqrt(i + 0.5);
    n.x = (near ? near.x : 0) + Math.cos(angle) * dist;
    n.y = (near ? near.y : 0) + Math.sin(angle) * dist;
  });
  sim.nodes = graph.nodes;
  sim.edges = graph.edges.map((e) => ({
    ...e,
    strength: (0.25 + 0.75 * (e.w / maxW)) / Math.sqrt(Math.min(degree.get(e.a.id), degree.get(e.b.id))),
    length: 22 + e.a.r + e.b.r,
  }));
  for (const e of sim.edges) {
    const da = degree.get(e.a.id);
    const db = degree.get(e.b.id);
    e.bias = da / (da + db);
  }
  sim.alpha = fresh > graph.nodes.length / 2 ? 1 : Math.max(sim.alpha, 0.4);
}

function tick() {
  const { nodes, edges } = sim;
  sim.alpha += (sim.target - sim.alpha) * 0.0228;
  const a = sim.alpha;
  // Links: springs to their length, the less connected end moving more.
  for (const e of edges) {
    let x = e.b.x + e.b.vx - e.a.x - e.a.vx || 1e-6;
    let y = e.b.y + e.b.vy - e.a.y - e.a.vy || 1e-6;
    let l = Math.sqrt(x * x + y * y);
    l = ((l - e.length) / l) * a * e.strength;
    x *= l;
    y *= l;
    e.b.vx -= x * e.bias;
    e.b.vy -= y * e.bias;
    e.a.vx += x * (1 - e.bias);
    e.a.vy += y * (1 - e.bias);
  }
  // Many-body repulsion, stronger for bigger nodes, and nodes that overlap pushed apart.
  for (let i = 0; i < nodes.length; i += 1) {
    const p = nodes[i];
    for (let j = i + 1; j < nodes.length; j += 1) {
      const q = nodes[j];
      let dx = q.x - p.x;
      let dy = q.y - p.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1e-6) {
        dx = (i - j) * 1e-3;
        dy = 1e-3;
        d2 = dx * dx + dy * dy;
      }
      if (d2 < 250000) {
        const wp = (-(14 + q.r * 7) * a) / d2;
        const wq = (-(14 + p.r * 7) * a) / d2;
        p.vx += dx * wp;
        p.vy += dy * wp;
        q.vx -= dx * wq;
        q.vy -= dy * wq;
      }
      const min = p.r + q.r + 2;
      if (d2 < min * min) {
        const d = Math.sqrt(d2);
        const push = ((min - d) / d) * 0.5;
        p.vx -= dx * push * 0.5;
        p.vy -= dy * push * 0.5;
        q.vx += dx * push * 0.5;
        q.vy += dy * push * 0.5;
      }
    }
  }
  for (const n of nodes) {
    // A pull to the centre, so the parts that are not joined stay near.
    n.vx -= n.x * 0.04 * a;
    n.vy -= n.y * 0.04 * a;
    if (n.fx !== undefined) {
      n.x = n.fx;
      n.y = n.fy;
      n.vx = 0;
      n.vy = 0;
    } else {
      n.vx *= 0.6;
      n.vy *= 0.6;
      n.x += n.vx;
      n.y += n.vy;
    }
    sim.pos.set(n.id, { x: n.x, y: n.y });
  }
}

function run() {
  cancelAnimationFrame(sim.frame);
  const step = () => {
    tick();
    place();
    if (sim.alpha > 0.004 || sim.target) sim.frame = requestAnimationFrame(step);
  };
  sim.frame = requestAnimationFrame(step);
}

// ---- drawing ----------------------------------------------------------------------------

const view = { x: 0, y: 0, k: 1 };
let svg = null;

function el(name, attrs = {}) {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function place() {
  for (const e of sim.edges) {
    e.el.setAttribute('x1', e.a.x.toFixed(1));
    e.el.setAttribute('y1', e.a.y.toFixed(1));
    e.el.setAttribute('x2', e.b.x.toFixed(1));
    e.el.setAttribute('y2', e.b.y.toFixed(1));
  }
  for (const n of sim.nodes) n.el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
}

function transform() {
  svg.querySelector('.view').setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  // The names stay as big on screen at any zoom (ui/spectrum-topics.css).
  svg.style.setProperty('--zoom', view.k.toFixed(3));
}

/** Zooms and pans so that every node is in sight. */
function fit() {
  if (!svg || !sim.nodes.length) return;
  const box = svg.getBoundingClientRect();
  const xs = sim.nodes.map((n) => [n.x - n.r, n.x + n.r]).flat();
  const ys = sim.nodes.map((n) => [n.y - n.r, n.y + n.r]).flat();
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 40;
  view.k = Math.min(1.5, (box.width - pad * 2) / Math.max(1, x1 - x0), (box.height - pad * 2) / Math.max(1, y1 - y0));
  view.x = box.width / 2 - ((x0 + x1) / 2) * view.k;
  view.y = box.height / 2 - ((y0 + y1) / 2) * view.k;
  transform();
}

function drawGraph({ refit: asked = false } = {}) {
  let refit = asked;
  const host = $('graph');
  if (!host) return;
  const g = graphOf();
  state.graph = g;
  if (!svg || !host.contains(svg)) {
    svg = el('svg', { role: 'img', 'aria-label': 'People, topics, tags and customers, joined by the threads they share' });
    svg.append(el('g', { class: 'view' }));
    host.append(svg);
    wireGraph();
    refit = true;
  }
  const v = svg.querySelector('.view');
  v.replaceChildren();
  layout(g);
  const lines = el('g', { class: 'edges' });
  const maxW = Math.max(1, ...g.edges.map((e) => e.w));
  for (const e of sim.edges) {
    e.el = el('line', { class: 'edge', 'stroke-width': (0.5 + 3 * (e.w / maxW)).toFixed(2) });
    lines.append(e.el);
  }
  const dots = el('g', { class: 'nodes' });
  for (const n of sim.nodes) {
    n.el = el('g', {
      class: `node${n.named || n.type === 'topic' || n.type === 'tag' ? ' named' : ''}`,
      'data-type': n.type,
      'data-id': n.id,
      tabindex: '0',
      role: 'button',
      'aria-label': `${TYPE[n.type].one} ${n.label}, ${n.threads.length} threads`,
    });
    n.el.append(el('circle', { r: n.r.toFixed(1) }));
    const label = el('text', { class: 'lbl', dy: '1em' });
    label.setAttribute('y', n.r.toFixed(1));
    label.textContent = n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label;
    n.el.append(label);
    dots.append(n.el);
  }
  v.append(lines, dots);
  $('graphEmpty').hidden = sim.nodes.length > 0;
  // Settled before it is drawn when most of it is new; otherwise it moves to where it goes.
  if (sim.alpha >= 1) {
    for (let i = 0; i < 300; i += 1) tick();
  }
  place();
  if (refit || sim.alpha >= 1) fit();
  focus();
  run();
}

/** Marks what is pointed at, or picked, or found, and what it is joined to. */
function focus() {
  if (!svg) return;
  const g = state.graph;
  const id = state.hover || state.q.sel;
  const find = state.find.trim().toLowerCase();
  let on = null;
  if (id && g.all.has(id)) {
    on = new Set([id, ...(g.neighbors.get(id) || [])]);
  } else if (find) {
    on = new Set(sim.nodes.filter((n) => n.label.toLowerCase().includes(find)).map((n) => n.id));
  }
  svg.classList.toggle('focus', Boolean(on));
  for (const n of sim.nodes) {
    n.el.classList.toggle('hi', Boolean(on && on.has(n.id)));
    n.el.classList.toggle('sel', n.id === state.q.sel);
  }
  for (const e of sim.edges) {
    e.el.classList.toggle('hi', Boolean(on && (id ? (e.a.id === id || e.b.id === id) : (on.has(e.a.id) && on.has(e.b.id)))));
  }
}

function tip(n, ev) {
  const t = $('tip');
  if (!n) {
    t.hidden = true;
    return;
  }
  t.innerHTML = `<b>${esc(n.label)}</b><span class="sub">${esc(TYPE[n.type].one)} · ${n.threads.length} thread${n.threads.length === 1 ? '' : 's'}</span>`;
  t.hidden = false;
  const box = $('graph').getBoundingClientRect();
  t.style.left = `${Math.min(ev.clientX - box.left + 14, box.width - t.offsetWidth - 8)}px`;
  t.style.top = `${ev.clientY - box.top + 14}px`;
}

function wireGraph() {
  const nodeOf = (target) => {
    const g = target.closest?.('.node');
    return g ? sim.nodes.find((n) => n.id === g.dataset.id) : null;
  };
  let drag = null;
  svg.addEventListener('pointerdown', (ev) => {
    const n = nodeOf(ev.target);
    drag = {
      n, x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false,
    };
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) {
      const n = nodeOf(ev.target);
      const id = n ? n.id : '';
      if (id !== state.hover) {
        state.hover = id;
        focus();
      }
      tip(n, ev);
      return;
    }
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    tip(null);
    if (drag.n) {
      const box = svg.getBoundingClientRect();
      drag.n.fx = (ev.clientX - box.left - view.x) / view.k;
      drag.n.fy = (ev.clientY - box.top - view.y) / view.k;
      if (!sim.target) {
        sim.target = 0.25;
        run();
      }
    } else {
      view.x = drag.vx + dx;
      view.y = drag.vy + dy;
      transform();
    }
  });
  const end = (ev) => {
    if (!drag) return;
    const { n, moved } = drag;
    drag = null;
    if (n) {
      delete n.fx;
      delete n.fy;
      sim.target = 0;
    }
    if (!moved && ev.type === 'pointerup') pick(n ? (n.id === state.q.sel ? '' : n.id) : '');
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('pointerleave', () => {
    if (state.hover) {
      state.hover = '';
      focus();
    }
    tip(null);
  });
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const box = svg.getBoundingClientRect();
    const k = Math.min(8, Math.max(0.15, view.k * Math.exp(-ev.deltaY * 0.0015)));
    const px = ev.clientX - box.left;
    const py = ev.clientY - box.top;
    view.x = px - ((px - view.x) / view.k) * k;
    view.y = py - ((py - view.y) / view.k) * k;
    view.k = k;
    transform();
  }, { passive: false });
  svg.addEventListener('keydown', (ev) => {
    const n = nodeOf(ev.target);
    if (n && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      pick(n.id === state.q.sel ? '' : n.id);
    }
  });
}

// ---- the panel --------------------------------------------------------------------------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '–');
const tagged = (threads) => threads.filter((t) => t.tags && t.tags.length).length;

/** What the threads are joined to, of one kind, the most threads first. */
function related(threads, type) {
  const counts = new Map();
  const add = (key) => counts.set(key, (counts.get(key) || 0) + 1);
  for (const t of threads) {
    if (type === 'topic') add(String(t.topic));
    if (type === 'person') Object.keys(t.staff || {}).forEach(add);
    if (type === 'tag') (t.tags || []).forEach(add);
    if (type === 'org' && isCustomer(t.org)) add(t.org);
  }
  const g = state.graph;
  return [...counts].map(([key, n]) => ({ id: `${type}:${key}`, node: g.all.get(`${type}:${key}`), n }))
    .filter((r) => r.node).sort((a, b) => b.n - a.n || a.node.label.localeCompare(b.node.label));
}

function relatedList(sel, type) {
  const rows = related(sel.threads, type).filter((r) => r.id !== sel.id);
  if (!rows.length) return '';
  const max = rows[0].n;
  // A topic's share of its own threads (the team's), so a tag says how much of a topic it covers.
  const of = (r) => (type === 'topic' ? ` <span class="sub">of ${r.node.threads.length}</span>` : '');
  const shown = rows.slice(0, 12);
  return `<section><h3>${esc(TYPE[type].label)} <span class="sub">${rows.length}</span></h3>
    <ul class="rel">${shown.map((r) => `<li><button class="pickr" data-sel="${esc(r.id)}" data-type="${type}">
      <span class="dot" data-type="${type}"></span><span class="nm">${esc(r.node.label)}</span>
      <span class="meter"><span class="fill" data-w="${Math.round((100 * r.n) / max)}"></span></span>
      <span class="n">${r.n}${of(r)}</span></button></li>`).join('')}</ul>
    ${rows.length > shown.length ? `<div class="sub more">and ${rows.length - shown.length} more</div>` : ''}</section>`;
}

function threadList(threads) {
  const m = map();
  const list = [...threads].sort((a, b) => b.sim - a.sim);
  const shown = state.more ? list : list.slice(0, THREADS_SHOWN);
  const link = (t) => `/inbox?team=${encodeURIComponent(t.team)}&t=${encodeURIComponent(t.key)}`;
  return `<section><h3>Threads <span class="sub">${list.length}</span></h3>
    <ol class="threads">${shown.map((t) => `<li><a href="${esc(link(t))}" target="_blank" rel="noopener">${esc(t.title || '(no title)')}</a>
      <div class="sub">${esc(orgName(t.org))} · ${esc(t.team)} · ${plural(t.messages, 'message')}${state.q.sel.startsWith('topic:') ? '' : ` · ${esc(m.topics[t.topic]?.label || '')}`}${(t.tags || []).length ? '' : ' · <span class="untagged">no tag</span>'}</div></li>`).join('')}</ol>
    ${list.length > shown.length ? `<button class="link" id="moreThreads">Show all ${list.length}</button>` : ''}</section>`;
}

function overview() {
  const g = state.graph;
  const m = map();
  const { threads } = g;
  const share = (n) => tagged(n.threads) / n.threads.length;
  const topics = [...g.all.values()].filter((n) => n.type === 'topic')
    .sort((a, b) => (state.sort === 'tagged' ? share(a) - share(b) : 0) || b.threads.length - a.threads.length);
  const sortBy = (id, label, title) => `<button class="sort" data-sort="${id}" title="${esc(title)}"${state.sort === id ? ' data-on' : ''}>${label}</button>`;
  const none = threads.length - tagged(threads);
  return `<h2>${plural(topics.length, 'topic')} <span class="sub">${plural(threads.length, 'thread')}</span></h2>
    <p class="hint">Found from what was said in the threads with ${m.min_messages} messages or more (not meetings or
      people's comings and goings), each named from its most typical threads. <b>${none} of them (${pct(none, threads.length)})
      have no tag from Clef</b>: the topics Clef rarely tags are what its topic questions miss.</p>
    <table class="topics"><thead><tr><th>Topic</th><th class="n">${sortBy('threads', 'Threads', 'The most threads first')}</th>
      <th class="n">${sortBy('tagged', 'Tagged', 'Threads with a tag from Clef: the fewest first')}</th><th>Tags</th></tr></thead>
    <tbody>${topics.map((n) => {
    const tags = related(n.threads, 'tag').slice(0, 3);
    return `<tr class="pick" data-sel="${esc(n.id)}"><td><div class="name"><span class="dot" data-type="topic"></span><span>${esc(n.label)}</span></div></td>
      <td class="n">${n.threads.length}</td><td class="n${share(n) < 0.25 ? ' low' : ''}">${pct(tagged(n.threads), n.threads.length)}</td>
      <td class="m">${tags.map((t) => esc(t.node.label)).join(', ') || '–'}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function details(n) {
  const m = map();
  const topic = n.type === 'topic' ? m.topics[Number(n.key)] : null;
  const org = n.type === 'org' ? m.orgs[n.key] : null;
  const facts = [
    plural(n.threads.length, 'thread'),
    ...(topic ? [`cohesion ${topic.cohesion}`] : []),
    ...(org ? [org.type] : []),
    ...(n.type === 'tag' ? [] : [`${pct(tagged(n.threads), n.threads.length)} tagged by Clef`]),
  ];
  const others = TYPES.map((t) => t.id).filter((t) => t !== n.type || t === 'person');
  return `<div class="head"><span class="dot" data-type="${n.type}"></span><div><div class="sub">${esc(TYPE[n.type].one)}</div>
      <h2>${esc(n.label)}</h2></div><button class="close" id="unpick" aria-label="Back to the topics" title="Back to the topics">✕</button></div>
    ${topic && topic.theme ? `<p class="theme">${esc(topic.theme)}</p>` : ''}
    <p class="sub facts">${facts.map(esc).join(' · ')}</p>
    ${n.type === 'topic' && !tagged(n.threads) ? '<p class="hint gap">Clef gave none of these threads a tag: a topic its questions miss.</p>' : ''}
    ${others.map((t) => relatedList(n, t)).join('')}
    ${threadList(n.threads)}`;
}

function renderPanel() {
  const panel = $('panel');
  if (!panel) return;
  const n = state.q.sel && state.graph.all.get(state.q.sel);
  panel.innerHTML = n ? details(n) : overview();
  // The meters' fill, as wide as its share: a class per tenth (ui/spectrum-topics.css).
  for (const f of panel.querySelectorAll('.fill[data-w]')) f.classList.add(`w${Math.max(1, Math.round(Number(f.dataset.w) / 10))}`);
  panel.scrollTop = 0;
}

// ---- the page ---------------------------------------------------------------------------

function pick(id) {
  state.q.sel = id;
  state.more = false;
  toUrl();
  renderPanel();
  focus();
}

function renderBar() {
  const m = map();
  $('bar').hidden = !m && !state.available;
  const teams = m ? [...new Set(m.threads.map((t) => t.team))].sort() : [];
  const teamName = (slug) => state.me.teams?.find((t) => t.slug === slug)?.name || slug;
  $('team').innerHTML = `<option value="">All teams</option>${teams.map((t) => `<option value="${esc(t)}"${t === state.q.team ? ' selected' : ''}>${esc(teamName(t))}</option>`).join('')}`;
  $('team').disabled = !m;
  $('types').innerHTML = TYPES.map((t) => `<button data-type="${t.id}" aria-pressed="${!state.q.hide.includes(t.id)}" title="${esc(t.title)}"${m ? '' : ' disabled'}>
    <span class="dot" data-type="${t.id}"></span>${esc(t.label)}</button>`).join('');
  $('min').innerHTML = MINS.map((n) => `<option value="${n}"${n === state.q.min ? ' selected' : ''}>${n}+</option>`).join('');
  $('min').disabled = !m;
  $('find').disabled = !m;
  $('names').innerHTML = m && state.graph ? [...state.graph.all.values()].map((n) => `<option value="${esc(n.label)}">${esc(TYPE[n.type].one)}</option>`).join('') : '';
  const built = state.latest;
  $('built').textContent = built ? `Built ${ago(built.built_at)} by ${built.built_by === 'cron' ? 'the cron' : built.built_by}` : '';
  $('rebuild').disabled = state.building || !state.available;
  $('rebuild').title = state.available
    ? 'Cluster the threads again, from their vectors as they are now (takes about half a minute)'
    : 'A topic map needs the CONTENT index and Workers AI';
  $('rebuild').textContent = state.building ? 'Building…' : (built ? 'Rebuild' : 'Build');
  $('rebuild').classList.toggle('primary', !built);
}

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function render({ refit = false } = {}) {
  const body = $('body');
  if (state.error && !map()) {
    body.innerHTML = `<div class="empty err">${esc(state.error)}</div>`;
    renderBar();
    return;
  }
  if (!map()) {
    body.innerHTML = state.available
      ? '<div class="empty">No topic map yet: the cron builds one once a week, or Build makes one now.</div>'
      : '<div class="empty">A topic map needs the CONTENT index and Workers AI, which this inbox does not have.</div>';
    renderBar();
    return;
  }
  if (!$('graph')) {
    body.innerHTML = `<div class="split">
      <div class="card graph" id="graph"><div class="empty" id="graphEmpty" hidden>Nothing to draw: show more kinds, or fewer shared threads.</div>
        <div class="tools"><button id="fit" title="Show the whole graph">Fit</button></div>
        <div class="tip" id="tip" hidden></div></div>
      <aside class="card panel" id="panel"></aside></div>
      ${state.error ? `<div class="hint err">${esc(state.error)}</div>` : ''}`;
    svg = null;
    $('fit').onclick = fit;
  }
  drawGraph({ refit });
  if (state.q.sel && !state.graph.all.has(state.q.sel)) state.q.sel = '';
  renderBar();
  renderPanel();
}

async function load() {
  try {
    const res = await fetch('/api/admin/topics', { credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
    state.latest = body.latest;
    state.available = body.available;
    state.error = '';
  } catch (e) {
    state.error = e.message;
  }
  render({ refit: true });
}

async function rebuild() {
  state.building = true;
  renderBar();
  $('body').classList.add('busy');
  try {
    const res = await fetch('/api/admin/topics', { method: 'POST', credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
    state.latest = body.latest;
    state.error = '';
    // A new map: its topics are other ones, so is the layout.
    sim.pos.clear();
    if (state.q.sel.startsWith('topic:')) state.q.sel = '';
    toUrl({ push: false });
  } catch (e) {
    state.error = `Could not build it: ${e.message}`;
  }
  state.building = false;
  $('body').classList.remove('busy');
  $('body').innerHTML = '';
  render({ refit: true });
}

function change(fn) {
  fn(state.q);
  toUrl();
  render();
}

function wire() {
  $('team').onchange = (ev) => change((q) => { q.team = ev.target.value; });
  $('min').onchange = (ev) => change((q) => { q.min = Number(ev.target.value); });
  $('types').onclick = (ev) => {
    const b = ev.target.closest('button[data-type]');
    if (!b) return;
    change((q) => {
      const t = b.dataset.type;
      q.hide = q.hide.includes(t) ? q.hide.filter((x) => x !== t) : [...q.hide, t];
      if (q.hide.length === TYPES.length) q.hide = q.hide.filter((x) => x !== t);
    });
  };
  $('find').oninput = (ev) => {
    state.find = ev.target.value;
    const exact = state.graph && [...state.graph.all.values()].find((n) => n.label === state.find);
    if (exact) {
      state.find = '';
      ev.target.value = '';
      pick(exact.id);
    } else {
      focus();
    }
  };
  $('rebuild').onclick = rebuild;
  $('body').addEventListener('click', (ev) => {
    const target = ev.target.closest('[data-sel]');
    if (target && !target.closest('svg')) pick(target.dataset.sel);
    if (ev.target.closest('#unpick')) pick('');
    const sort = ev.target.closest('button[data-sort]');
    if (sort) {
      state.sort = sort.dataset.sort;
      renderPanel();
    }
    if (ev.target.closest('#moreThreads')) {
      state.more = true;
      renderPanel();
    }
  });
  window.addEventListener('popstate', () => {
    fromUrl();
    render();
  });
  let resizing = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizing);
    resizing = requestAnimationFrame(fit);
  });
  window.addEventListener('opspile:signedin', () => load());
}

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
    $('body').innerHTML = `<div class="empty">The topic map is for the admin team. <a href="${esc(Header.href('inbox'))}">Back to the inbox</a></div>`;
    return;
  }
  fromUrl();
  toUrl({ push: false });
  wire();
  renderBar();
  load();
})();
