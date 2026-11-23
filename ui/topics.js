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
 * Topics: the topic map (src/topicmap.js) for every member of an ops team, over GET /api/topics
 * (src/topicsapi.js), with the areas (src/areas.js) the teams author and what the viewer follows:
 * a Follow on a person, customer, area or product puts its threads in their personal view, and
 * the admin team and team managers add, rename, describe and delete areas in the panel. What
 * the channel threads are about, found from what was said in them (the topics), drawn as one
 * force-directed graph of three kinds of bubbles, each a hierarchy (ui/topicgraph.js): the
 * topics in their areas, the people in their teams (Adobe's) or their customers (the others'),
 * and the features of the tech stack in their products (Adobe's) or vendors (the others'). A
 * click on a group bursts it into its children where it was; a click on the child picked folds
 * them back into it. A line joins two that share threads, thicker the more; the topics are the
 * hubs, so with them shown a line joins a topic or an area to the others, and without them any
 * two kinds. A node is as big as its threads.
 *
 * Pointing at a node shows what it is joined to; a click picks it, and the panel beside the graph
 * says what it is: a topic's theme, a group's children, the people, customers, areas and products
 * of its threads, its threads (each a link into the inbox), and how many of them Clef gave a tag
 * at all, which is where Clef's areas miss what the threads are about. Without a pick the panel
 * lists the areas and the topics. The filters (a team, the kinds shown, the threads a line
 * needs), the groups opened and the pick are the page's address; the header brings it back as
 * it was left. Rebuild clusters the threads again (POST /api/admin/topics).
 *
 * The graph's data is ui/topicgraph.js (its global `TopicGraph`). The layout is the page's own:
 * d3-force's model (many-body repulsion, links as springs, a pull to the centre, collision), in a
 * loop of animation frames; it settles before it is first drawn, and keeps where every node was
 * when the filters change.
 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const SVG = 'http://www.w3.org/2000/svg';

// The kinds shown, each a hierarchy (ui/topicgraph.js).
const TYPES = [
  { id: 'topic', label: 'Topics', title: 'What the threads are about, found from what was said in them, in the areas Clef puts them in (the teams author those)' },
  { id: 'person', label: 'People', title: 'Who posted in the threads: Adobe\'s people in their teams, the others in the customers they are of' },
  { id: 'product', label: 'Products', title: 'The technologies of the tech stack Clef says the threads are about: features in their products, or the vendor\'s (on maps from before, outlined ones were not in the tech stack)' },
];
const TYPE = Object.fromEntries(TYPES.map((t) => [t.id, t]));
// The lists of the panel: what a node's threads are joined to.
const RELATED = [
  { id: 'tag', label: 'Areas' }, { id: 'topic', label: 'Topics' }, { id: 'person', label: 'People' },
  { id: 'org', label: 'Customers' }, { id: 'product', label: 'Products' },
];
const MINS = [1, 2, 3, 5, 8];
const THREADS_SHOWN = 30;

const state = {
  me: null,
  latest: null,
  available: false,
  // Every team's areas (src/areas.js), what the viewer follows, and what they may change.
  areas: [],
  follows: { me: [], teams: {}, by: { org: [], person: [], area: [] } },
  may: { areas: [], rebuild: false },
  // The area being added (`{ new: true }`) or changed (`{ team, id }`), and the answer to it.
  editArea: null,
  note: null,
  error: '',
  building: false,
  // Every team's name (GET /api/topics), for the bubbles of the teams.
  teams: {},
  // The teams each Adobe person is on (GET /api/topics), for their team bubbles.
  members: null,
  q: {
    team: '', hide: [], min: 2, sel: '', open: [],
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
    // The groups opened (ui/topicgraph.js), as their ids.
    open: p.getAll('open'),
  };
}

function toUrl({ push = true } = {}) {
  const p = new URLSearchParams();
  const { q } = state;
  if (q.team) p.set('team', q.team);
  if (q.hide.length) p.set('hide', q.hide.join(','));
  if (q.min !== 2) p.set('min', String(q.min));
  if (q.sel) p.set('sel', q.sel);
  for (const id of q.open) p.append('open', id);
  const url = `${location.pathname}${p.size ? `?${p}` : ''}`;
  if (url !== `${location.pathname}${location.search}`) {
    history[push ? 'pushState' : 'replaceState'](null, '', url);
  }
  Header.remember();
}

// ---- the graph's data -------------------------------------------------------------------

const map = () => state.latest?.map;
/** The map's products (maps from before them have none). */
const products = () => map().products || {};
/** A thread's product id as the graph has it: the product its entry is part of, or itself. */
const productOf = (id) => TopicGraph.productOf(map(), id);
const isCustomer = (slug) => TopicGraph.isCustomer(map(), slug);
const orgName = (slug) => map().orgs[slug]?.name || slug;
const shownTypes = () => TYPES.map((t) => t.id).filter((id) => !state.q.hide.includes(id));

/**
 * The graph for the filters (ui/topicgraph.js). An area's name is what its file says now
 * (`state.areas`), not what it was when the map was built: a rename shows at once.
 */
function graphOf() {
  const { q } = state;
  const names = Object.fromEntries(areaList().map((a) => [a.id, a.name]));
  const m = { ...map(), tags: { ...(map().tags || {}), ...names } };
  const teamName = (slug) => state.teams[slug] || state.me.teams?.find((t) => t.slug === slug)?.name || slug;
  return TopicGraph.build(m, {
    team: q.team, shown: shownTypes(), min: q.min, open: q.open, teamName, members: state.members,
  });
}

// ---- the layout: d3-force's model -------------------------------------------------------

const sim = {
  nodes: [], edges: [], alpha: 0, target: 0, frame: 0, pos: new Map(),
};
const radius = (n) => ({
  topic: 6, tag: 7, product: 4, person: 3, team: 5, org: 4,
}[n.type] + Math.sqrt(n.threads.length) * 1.7);
/** Whether `n` is a group that opens: drawn, with children (ui/topicgraph.js). */
const opens = (n) => Boolean(n.children?.length) && !n.open;

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
    // Where it was; a child where its group was, burst around it; a group where its children
    // were, folded back.
    const kids = (n.children || []).map((id) => sim.pos.get(id)).filter(Boolean);
    const parent = n.parent && sim.pos.get(n.parent);
    const turn = i * Math.PI * (3 - Math.sqrt(5));
    const old = sim.pos.get(n.id)
      || (parent && { x: parent.x + Math.cos(turn) * 8, y: parent.y + Math.sin(turn) * 8 })
      || (kids.length && {
        x: kids.reduce((s, k) => s + k.x, 0) / kids.length,
        y: kids.reduce((s, k) => s + k.y, 0) / kids.length,
      });
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
  // A line from outline to outline, not from centre to centre: none across a bubble; none at
  // all where two touch.
  for (const e of sim.edges) {
    const dx = e.b.x - e.a.x;
    const dy = e.b.y - e.a.y;
    const d = Math.hypot(dx, dy);
    const gap = d > e.a.r + e.b.r;
    const ua = gap ? e.a.r / d : 0;
    const ub = gap ? 1 - e.b.r / d : 0;
    e.el.setAttribute('x1', (e.a.x + dx * ua).toFixed(1));
    e.el.setAttribute('y1', (e.a.y + dy * ua).toFixed(1));
    e.el.setAttribute('x2', (e.a.x + dx * ub).toFixed(1));
    e.el.setAttribute('y2', (e.a.y + dy * ub).toFixed(1));
  }
  for (const n of sim.nodes) n.el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
}

function transform() {
  svg.querySelector('.view').setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  // The names stay as big on screen at any zoom (ui/spectrum-topics.css).
  svg.style.setProperty('--zoom', view.k.toFixed(3));
}

/** The most children drawn inside a closed group. */
const KIDS = 30;

/**
 * The children of closed group `n`, drawn inside it as small circles: the most threads in the
 * middle, on a sunflower spiral (the same as the layout's first places), each as big as its
 * share of the biggest, so a team shows its people and an area its topics before it opens.
 */
function inside(n) {
  const g = el('g', { class: 'kids', 'aria-hidden': 'true' });
  const all = state.graph.all;
  const list = n.children.map((id) => all.get(id)).filter(Boolean)
    .sort((a, b) => b.threads.length - a.threads.length).slice(0, KIDS);
  const max = Math.max(1, ...list.map((c) => c.threads.length));
  // Spacing so the spiral of `list.length` fills four fifths of the group.
  const step = (n.r * 0.8) / Math.sqrt(list.length);
  list.forEach((c, i) => {
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const dist = step * Math.sqrt(i + 0.5);
    const r = step * 0.45 * Math.max(0.4, Math.sqrt(c.threads.length / max));
    g.append(el('circle', {
      class: 'kid',
      'data-type': c.type,
      cx: (Math.cos(angle) * dist).toFixed(1),
      cy: (Math.sin(angle) * dist).toFixed(1),
      r: r.toFixed(1),
    }));
  });
  return g;
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
    svg = el('svg', { role: 'img', 'aria-label': 'Topics in their areas, people in their teams and customers, and products, joined by the threads they share' });
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
      class: `node${n.named ? ' named' : ''}`,
      'data-type': n.type,
      'data-id': n.id,
      ...(n.gap ? { 'data-gap': '' } : {}),
      ...(opens(n) ? { 'data-group': '' } : {}),
      tabindex: '0',
      role: 'button',
      'aria-label': `${n.one} ${n.label}${n.gap ? ', not in the tech stack' : ''}, ${n.threads.length} threads${opens(n) ? `, ${n.children.length} in it: opens` : ''}`,
    });
    n.el.append(el('circle', { r: n.r.toFixed(1) }));
    if (opens(n)) n.el.append(inside(n));
    const label = el('text', { class: 'lbl', dy: '1em' });
    label.setAttribute('y', n.r.toFixed(1));
    label.textContent = n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label;
    // A closed group says how many it holds: an area its topics, a team its people.
    if (opens(n)) {
      const count = el('tspan', { class: 'count' });
      count.textContent = ` ${n.children.length}`;
      label.append(count);
    }
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
  const picked = id && g.all.get(id);
  if (picked && picked.open) {
    // A group opened: its children.
    on = new Set([id, ...picked.children]);
  } else if (picked) {
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
  const parent = n.parent && state.graph.all.get(n.parent);
  const act = (opens(n) && `Click to open its ${n.children.length}`)
    || (parent && n.id === state.q.sel && `Click to fold into ${parent.label}`) || '';
  t.innerHTML = `<b>${esc(n.label)}</b><span class="sub">${esc(n.one)}${n.gap ? ', not in the tech stack' : ''} · ${n.threads.length} thread${n.threads.length === 1 ? '' : 's'}</span>${act ? `<span class="sub">${esc(act)}</span>` : ''}`;
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
    if (!moved && ev.type === 'pointerup') clickNode(n);
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
      clickNode(n);
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
  const g = state.graph;
  for (const t of threads) {
    if (type === 'topic') add(String(t.topic));
    if (type === 'person') Object.keys({ ...t.staff, ...t.customers }).forEach(add);
    // The area of its topic (ui/topicgraph.js).
    if (type === 'tag') add(g.areas[t.topic] || TopicGraph.NONE);
    if (type === 'product') new Set((t.products || []).map(productOf)).forEach(add);
    if (type === 'org' && isCustomer(t.org)) add(t.org);
  }
  return [...counts].map(([key, n]) => ({ id: `${type}:${key}`, node: g.all.get(`${type}:${key}`), n }))
    .filter((r) => r.node).sort((a, b) => b.n - a.n || a.node.label.localeCompare(b.node.label));
}

function relatedList(sel, type) {
  const rows = related(sel.threads, type).filter((r) => r.id !== sel.id
    && !(sel.children || []).includes(r.id) && r.id !== sel.parent);
  if (!rows.length) return '';
  const max = rows[0].n;
  // A topic's share of its own threads (the team's), so a tag says how much of a topic it covers.
  const of = (r) => (type === 'topic' ? ` <span class="sub">of ${r.node.threads.length}</span>` : '');
  const shown = rows.slice(0, 12);
  return `<section><h3>${esc(RELATED.find((r) => r.id === type).label)} <span class="sub">${rows.length}</span></h3>
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
      people's comings and goings), named all at once from their most typical threads, Clef topics and products. <b>${none} of them (${pct(none, threads.length)})
      have no tag from Clef</b>: the topics Clef rarely tags are what its topic questions miss.</p>
    ${gaps()}
    ${areasSection()}
    <h3>Topics</h3>
    <table class="topics"><thead><tr><th>Topic</th><th class="n">${sortBy('threads', 'Threads', 'The most threads first')}</th>
      <th class="n">${sortBy('tagged', 'Tagged', 'Threads with a tag from Clef: the fewest first')}</th><th>Area</th></tr></thead>
    <tbody>${topics.map((n) => {
    const area = g.all.get(`tag:${g.areas[Number(n.key)] || TopicGraph.NONE}`);
    return `<tr class="pick" data-sel="${esc(n.id)}"><td><div class="name"><span class="dot" data-type="topic"></span><span>${esc(n.label)}</span></div></td>
      <td class="n">${n.threads.length}</td><td class="n${share(n) < 0.25 ? ' low' : ''}">${pct(tagged(n.threads), n.threads.length)}</td>
      <td class="m">${esc(area?.label || '–')}</td></tr>`;
  }).join('')}</tbody></table>`;
}

/** The products no tech stack entry names, by their threads: what to add to it. */
function gaps() {
  const all = [...state.graph.all.values()].filter((n) => n.type === 'product');
  if (!all.length) {
    return '<h3>Products</h3><p class="hint">No products yet: Clef says which technologies a thread is about when it labels it.</p>';
  }
  const list = all.filter((n) => n.gap).sort((a, b) => b.threads.length - a.threads.length
    || a.label.localeCompare(b.label));
  // Maps built from Clef's answers name only technologies of the tech stack: no gaps. Maps built
  // before, from Clairic's product names, have them.
  if (!list.length) return '';
  const named = all.reduce((s, n) => s + (n.gap ? 0 : n.threads.length), 0);
  const missed = list.reduce((s, n) => s + n.threads.length, 0);
  // Named in two threads or more: by two customers or more first, as products to add; by one
  // customer, folded, as those are as likely a brand or a system of theirs. Names of one thread
  // only are counted.
  const customers = (n) => new Set(n.threads.map((t) => t.org).filter(isCustomer)).size;
  const several = list.filter((n) => n.threads.length > 1);
  const shown = several.filter((n) => customers(n) > 1).slice(0, 20);
  const one = several.filter((n) => customers(n) <= 1).slice(0, 30);
  const once = list.length - several.length;
  const past = several.length - shown.length - one.length;
  const max = Math.max(1, ...[...shown, ...one].map((n) => n.threads.length));
  const rows = (nodes) => `<ul class="rel">${nodes.map((n) => `<li><button class="pickr" data-sel="${esc(n.id)}" data-type="product">
      <span class="dot" data-type="product" data-gap></span><span class="nm">${esc(n.label)}</span>
      <span class="meter"><span class="fill" data-w="${Math.round((100 * n.threads.length) / max)}"></span></span>
      <span class="n" title="${plural(customers(n), 'customer')}">${n.threads.length}</span></button></li>`).join('')}</ul>`;
  return `<h3>Not in the tech stack <span class="sub">${list.length}</span></h3>
    <p class="hint">Products the threads are about that no technology of the tech stack names
      (${pct(missed, missed + named)} of the products found). Add them, or their names to an
      entry's aliases, on the Agents page, and Clef asks about them.</p>
    ${shown.length ? rows(shown) : '<p class="sub">None that two customers name.</p>'}
    ${one.length ? `<details class="gaps"><summary>Named by one customer <span class="sub">${one.length}</span></summary>${rows(one)}</details>` : ''}
    ${past ? `<div class="sub more">and ${past} more named in several threads (Find shows them)</div>` : ''}
    ${once ? `<div class="sub more">and ${once} named in one thread each (Find shows them)</div>` : ''}`;
}

/** A group's children (its topics, people or features), by their threads; a click picks one. */
function childList(n) {
  const g = state.graph;
  const rows = (n.children || []).map((id) => g.all.get(id)).filter(Boolean)
    .sort((a, b) => b.threads.length - a.threads.length || a.label.localeCompare(b.label));
  if (!rows.length) return '';
  const max = rows[0].threads.length;
  const what = { tag: 'Its topics', team: 'Its people', org: 'Its people' }[n.type] || 'Its features';
  return `<section><h3>${what} <span class="sub">${rows.length}</span></h3>
    <ul class="rel">${rows.map((c) => `<li><button class="pickr" data-sel="${esc(c.id)}" data-type="${c.type}">
      <span class="dot" data-type="${c.type}"${c.gap ? ' data-gap' : ''}></span><span class="nm">${esc(c.label)}</span>
      <span class="meter"><span class="fill" data-w="${Math.round((100 * c.threads.length) / max)}"></span></span>
      <span class="n">${c.threads.length}</span></button></li>`).join('')}</ul></section>`;
}

/** Open or fold: a group drawn opens, one opened folds, a child folds into its group. */
function foldButton(n) {
  const g = state.graph;
  const parent = n.parent && g.all.get(n.parent);
  if (n.children?.length && (n.type === 'org' || n.children.length > 1)) {
    return `<button class="fold" data-fold="${esc(n.id)}">${n.open ? 'Fold' : `Open its ${n.children.length}`}</button>`;
  }
  if (parent && parent.open) {
    return `<button class="fold" data-fold="${esc(parent.id)}" title="Fold back into ${esc(parent.label)}">Fold into ${esc(parent.label)}</button>`;
  }
  return '';
}

// ---- following and areas ---------------------------------------------------------------

/** What following node `n` is (PUT /api/follows): `{ kind, target }`, or null for a topic. */
function followOf(n) {
  if (n.type === 'person') return { kind: 'person', target: n.key };
  if (n.type === 'org') return { kind: 'org', target: n.key };
  if (n.type === 'tag' && n.key !== TopicGraph.NONE) return { kind: 'area', target: n.key };
  if (n.type === 'product' && n.key.startsWith('tech:')) return { kind: 'tech', target: n.key.slice(5) };
  return null;
}

/** Whether the viewer follows `f` (followOf). */
function follows(f) {
  if (!f) return false;
  if (f.kind === 'tech') return (state.follows.me || []).includes(f.target);
  return (state.follows.by?.[f.kind] || []).map(String).includes(String(f.target));
}

const followButton = (f, label) => (f && state.me.teams?.length
  ? `<button class="follow" data-follow="${esc(f.kind)}" data-target="${esc(f.target)}" aria-pressed="${follows(f)}"
      title="${follows(f) ? `Stop following ${esc(label)}` : `Follow ${esc(label)}: its threads are in your personal view`}">${follows(f) ? 'Following' : 'Follow'}</button>`
  : '');

async function toggleFollow(kind, target) {
  const f = { kind, target };
  const body = kind === 'tech' ? { tech: target, follow: !follows(f) } : { kind, target, follow: !follows(f) };
  const res = await fetch('/api/follows', {
    method: 'PUT', credentials: 'same-origin', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => null);
  const out = res ? await res.json().catch(() => ({})) : {};
  if (res && res.ok) state.follows = { ...state.follows, ...out };
  else state.note = { err: true, text: out.error || 'Could not change what you follow.' };
  renderPanel();
}

/** Every area once, as Clef asks it: the admin team's, else the first team's, that is on. */
function areaList() {
  const by = new Map();
  for (const a of state.areas) {
    const had = by.get(a.id);
    if (!had || (!had.enabled && a.enabled)) by.set(a.id, { ...a, teams: [...(had?.teams || []), a.team] });
    else had.teams.push(a.team);
  }
  return [...by.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** May the viewer change team `team`'s areas. */
const mayArea = (team) => (state.may.areas || []).includes(team);

function areaForm() {
  const e = state.editArea;
  if (!e) return '';
  const def = e.new ? {} : state.areas.find((a) => a.team === e.team && a.id === e.id) || {};
  const teams = state.may.areas || [];
  const teamName = (slug) => state.me.teams?.find((t) => t.slug === slug)?.name || slug;
  return `<form class="areaform" id="areaForm" autocomplete="off">
    <h3>${e.new ? 'New area' : `Change ${esc(def.name || e.id)}`}</h3>
    ${e.new ? `<label class="fld"><span>In the knowledge base of</span><select id="afTeam">${teams.map((t) => `<option value="${esc(t)}">${esc(teamName(t))}</option>`).join('')}</select></label>
      <label class="fld"><span>Id (lower case, digits and -; it stays when the area is renamed)</span><input id="afId" required pattern="[a-z][a-z0-9-]*" maxlength="40"></label>` : ''}
    <label class="fld"><span>Name</span><input id="afTitle" required maxlength="80" value="${esc(def.name || '')}"></label>
    <label class="fld"><span>Clef is asked: “Is this thread about …?”</span><textarea id="afWhat" rows="3" required maxlength="500">${esc(def.what || '')}</textarea></label>
    ${e.new ? '' : `<label class="only"><input type="checkbox" id="afOn"${def.enabled === false ? '' : ' checked'}> Asked in every label</label>`}
    <p class="hint">Every area is one more question Clef answers for every thread. A change shows on the threads as they are labeled again.</p>
    <div class="acts"><button class="primary" type="submit">${e.new ? 'Add' : 'Save'}</button>
      <button type="button" id="afCancel">Cancel</button>
      ${e.new ? '' : `<button type="button" class="danger" id="afDelete"${e.confirm ? ' data-confirm' : ''}>${e.confirm ? 'Delete it, for good' : 'Delete'}</button>`}</div>
  </form>`;
}

async function saveArea(method, body) {
  const res = await fetch('/api/areas', {
    method, credentials: 'same-origin', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => null);
  const out = res ? await res.json().catch(() => ({})) : {};
  if (res && res.ok) {
    state.areas = out.areas || state.areas;
    state.editArea = null;
    state.note = { text: method === 'DELETE' ? 'Deleted. Clef stops asking it from the next labels.' : 'Saved. Clef asks it from the next labels.' };
    // The bubbles take the areas' names as they are now: drawn again.
    render();
    return;
  }
  state.note = { err: true, text: out.error || 'That did not work.' };
  renderPanel();
}

/** The areas: their threads on this map, whether the viewer follows them, and changing them. */
function areasSection() {
  const g = state.graph;
  const count = (id) => g.all.get(`tag:${id}`)?.threads.length || 0;
  const topics = (id) => g.all.get(`tag:${id}`)?.children?.length || 0;
  const list = areaList();
  const may = (state.may.areas || []).length;
  const note = state.note ? `<p class="hint${state.note.err ? ' err' : ''}">${esc(state.note.text)}</p>` : '';
  return `<h3>Areas <span class="sub">${list.length}</span></h3>
    <p class="hint">What Clef puts the threads in: each area is a question it answers for every thread. The teams author them${may ? '; you change those of the teams you manage' : ''}. Follow one and its threads are in your personal view.</p>
    ${note}${areaForm()}
    <table class="topics areas"><thead><tr><th>Area</th><th class="n">Topics</th><th class="n">Threads</th><th></th></tr></thead><tbody>${list.map((a) => {
    const team = a.teams.find(mayArea);
    return `<tr${a.enabled ? '' : ' class="off"'}><td><button class="link pickr-a" data-sel="tag:${esc(a.id)}" title="${esc(a.what)}">${esc(a.name)}</button>${a.enabled ? '' : ' <span class="sub">off</span>'}</td>
      <td class="n">${topics(a.id) || '–'}</td>
      <td class="n"${count(a.id) ? '' : ' title="None on this map: it was built before the area, or Clef put no thread in it"'}>${count(a.id) || '–'}</td>
      <td class="acts">${followButton({ kind: 'area', target: a.id }, a.name)}${team ? `<button data-edit-area="${esc(team)}|${esc(a.id)}">Change</button>` : ''}</td></tr>`;
  }).join('')}</tbody></table>
    ${may && !state.editArea ? '<button id="newArea">New area</button>' : ''}`;
}

function details(n) {
  const m = map();
  const topic = n.type === 'topic' ? m.topics[Number(n.key)] : null;
  const org = n.type === 'org' ? m.orgs[n.key] : null;
  const facts = [
    plural(n.threads.length, 'thread'),
    ...(topic ? [`cohesion ${topic.cohesion}`] : []),
    ...(org ? [org.type] : []),
    ...(n.type === 'product' && n.gap ? ['not in the tech stack'] : []),
    ...(n.type === 'product' && !n.gap && !n.key.startsWith('group:') ? [`tech stack: ${products()[n.key]?.name}`] : []),
    ...(n.type === 'tag' ? [] : [`${pct(tagged(n.threads), n.threads.length)} tagged by Clef`]),
  ];
  const others = RELATED.map((t) => t.id).filter((t) => t !== n.type || t === 'person');
  const area = n.type === 'tag' ? areaList().find((a) => a.id === n.key) : null;
  const team = area && area.teams.find(mayArea);
  const parent = n.parent && map() && state.graph.all.get(n.parent);
  return `<div class="head"><span class="dot" data-type="${n.type}"></span><div><div class="sub">${esc(n.one)}${parent ? ` in ${esc(parent.label)}` : ''}</div>
      <h2>${esc(n.label)}</h2></div>${followButton(followOf(n), n.label)}<button class="close" id="unpick" aria-label="Back to the topics" title="Back to the topics">✕</button></div>
    ${foldButton(n) || team ? `<div class="acts">${foldButton(n)}${team ? `<button data-edit-area="${esc(team)}|${esc(area.id)}">Change</button>` : ''}</div>` : ''}
    ${area && state.editArea && !state.editArea.new && state.editArea.id === area.id ? areaForm() : ''}
    ${area?.what ? `<p class="theme">Clef is asked: is this thread about ${esc(area.what)}?</p>` : ''}
    ${topic && topic.theme ? `<p class="theme">${esc(topic.theme)}</p>` : ''}
    <p class="sub facts">${facts.map(esc).join(' · ')}</p>
    ${n.type === 'topic' && !tagged(n.threads) ? '<p class="hint gap">Clef gave none of these threads a tag: a topic its questions miss.</p>' : ''}
    ${childList(n)}
    ${others.map((t) => relatedList(n, t)).join('')}
    ${threadList(n.threads)}`;
}

function renderPanel() {
  const panel = $('panel');
  if (!panel) return;
  // Another pick fades in (ui/app.js); the panel is made again with the page's body.
  Swap.watch(panel, () => state.q.sel);
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
  // A child picked in the panel or found shows: its group opens.
  const n = id && state.graph?.all.get(id);
  const parent = n?.parent && state.graph.all.get(n.parent);
  const opened = parent && !parent.open;
  if (opened) state.q.open = [...state.q.open, parent.id];
  toUrl();
  if (opened) drawGraph();
  renderPanel();
  focus();
}

/** Opens group `id`, or folds it back. */
function fold(id) {
  const { q } = state;
  q.open = q.open.includes(id) ? q.open.filter((x) => x !== id) : [...q.open, id];
  // What was in it folds with it.
  if (!q.open.includes(id)) {
    const kids = new Set(state.graph.all.get(id)?.children || []);
    if (kids.has(q.sel)) q.sel = id;
  }
  toUrl();
  drawGraph();
  renderPanel();
}

/**
 * A click on the graph: a group bursts into its children (and is picked); the child picked folds
 * back into its group; any other node is picked, or unpicked; the background unpicks.
 */
function clickNode(n) {
  if (!n) {
    pick('');
    return;
  }
  if (opens(n)) {
    state.q.sel = n.id;
    fold(n.id);
    return;
  }
  if (n.parent && n.id === state.q.sel) {
    fold(n.parent);
    return;
  }
  pick(n.id === state.q.sel ? '' : n.id);
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
  const [only] = shownTypes();
  $('min').title = shownTypes().length === 1 && only === 'topic'
    ? `Join two ${TYPE[only].label.toLowerCase()} when this many people have this many threads in both`
    : 'Draw a line between two only when this many threads have both';
  $('find').disabled = !m;
  $('names').innerHTML = m && state.graph ? [...state.graph.all.values()].map((n) => `<option value="${esc(n.label)}">${esc(n.one)}</option>`).join('') : '';
  const built = state.latest;
  $('built').textContent = built ? `Built ${ago(built.built_at)} by ${built.built_by === 'cron' ? 'the cron' : built.built_by}` : '';
  $('rebuild').hidden = !state.may.rebuild;
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
    const res = await fetch('/api/topics', { credentials: 'same-origin', redirect: 'manual' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
    state.latest = body.latest;
    state.available = body.available;
    state.areas = body.areas || [];
    state.follows = body.follows || state.follows;
    state.may = body.may || state.may;
    state.teams = body.teams || {};
    state.members = body.members || null;
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
    const res = await fetch('/api/topics', { method: 'POST', credentials: 'same-origin', redirect: 'manual' });
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
    const folding = ev.target.closest('button[data-fold]');
    if (folding) fold(folding.dataset.fold);
    const follow = ev.target.closest('button[data-follow]');
    if (follow) toggleFollow(follow.dataset.follow, follow.dataset.target);
    const edit = ev.target.closest('button[data-edit-area]');
    if (edit) {
      const [team, id] = edit.dataset.editArea.split('|');
      state.editArea = { team, id };
      state.note = null;
      renderPanel();
    }
    if (ev.target.closest('#newArea')) {
      state.editArea = { new: true };
      state.note = null;
      renderPanel();
    }
    if (ev.target.closest('#afCancel')) {
      state.editArea = null;
      renderPanel();
    }
    if (ev.target.closest('#afDelete')) {
      const e = state.editArea;
      // Asked in the page, not a native dialog: a second click deletes.
      if (!e.confirm) {
        e.confirm = true;
        renderPanel();
      } else {
        saveArea('DELETE', { team: e.team, id: e.id });
      }
    }
  });
  $('body').addEventListener('submit', (ev) => {
    if (ev.target.id !== 'areaForm') return;
    ev.preventDefault();
    const e = state.editArea;
    const title = $('afTitle').value.trim();
    const what = $('afWhat').value.trim();
    if (e.new) saveArea('POST', { team: $('afTeam').value, id: $('afId').value.trim(), title, what });
    else {
      saveArea('PUT', {
        team: e.team, id: e.id, title, what, enabled: $('afOn').checked,
      });
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
  if (!me.teams?.length) {
    $('body').innerHTML = `<div class="empty">The topic map is for the members of the ops teams. <a href="${esc(Header.href('inbox'))}">Back to the inbox</a></div>`;
    return;
  }
  fromUrl();
  toUrl({ push: false });
  wire();
  renderBar();
  load();
})();
