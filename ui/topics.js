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
 * Topics: the topic map (src/topicmap.js) for every internal user (on an ops team, or `staff`
 * on none, who find what to follow here), over GET /api/topics
 * (src/topicsapi.js), with the areas (src/areas.js) the teams author and what the viewer follows:
 * a Follow on a person, customer, area or product puts its threads in their personal view, and
 * the admin team and team managers add, rename, describe and delete areas in the panel. What
 * the channel threads are about, found from what was said in them (the topics), drawn in three
 * dimensions (ui/topicview.js) as three kinds of bubbles, each a hierarchy (ui/topicgraph.js):
 * the topics in their areas, the people in their teams (Adobe's) or their customers (the
 * others'), and the features of the tech stack in their products (Adobe's) or vendors (the
 * others'). The topics are where the map put them, by what their threads say once who said it,
 * about what and for whom is taken out; the people and products are pulled to the topics and to
 * each other by the threads they share (ui/topicspace.js). A bubble is as big as its threads.
 *
 * A click picks a bubble, and the panel beside the map says what it is: a topic's theme, a
 * group's children, the people, customers, areas and products of its threads, its threads (each
 * a link into the inbox), and how many of them Clef gave a tag at all, which is where Clef's
 * areas miss what the threads are about. Holding a group pops it into its children; holding its
 * shell or a child folds it back. A double-click shows only a bubble's threads (`only`), and on
 * nothing all of them again. Without a pick the panel lists the areas and the topics. The
 * filters (a team, the kinds shown, the threads a bubble needs), the groups opened, `only` and
 * the pick are the page's address; the header brings it back as it was left. Rebuild clusters
 * the threads again (POST /api/admin/topics).
 *
 * Under the graph, how much the channels talk about what is picked, week by week, and what else is
 * compared (ui/trendview.js, its global `TrendView`); in the panel, without a pick, the areas with
 * their topics and the products with their features as trees that fold and open as the graph's
 * bubbles do (the same `open`), each with its trend: trending, declining or peaked.
 *
 * The graph's data is ui/topicgraph.js (its global `TopicGraph`), its places ui/topicspace.js
 * (`TopicSpace`), its drawing ui/topicview.js (`TopicView`).
 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

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
/** The threads a bubble needs to be drawn. */
const MIN = 5;
// What the trees show: everything, or only what is trending, declining or peaked (ui/trends.js).
const LISTS = [
  { id: '', label: 'All', title: 'The areas with their topics, the products with their features' },
  { id: 'trending', label: 'Trending', title: 'Up on the 12 weeks before, surely and often enough, and not falling again: the faster it rises, the higher' },
  { id: 'declining', label: 'Declining', title: 'Down on the 12 weeks before, surely, from often enough' },
  { id: 'peaked', label: 'Peaked', title: 'Had a peak well above what is usual for it, more than four weeks ago, and is far below it now' },
];
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
    team: '', hide: [], sel: '', open: [], tl: '', only: '',
  },
  // The week of the chart whose threads the panel lists, and the terms they are for.
  week: null,
  find: '',
  hover: '',
  graph: null,
  // The graph of the team, of all its threads (`only` aside).
  whole: null,
  more: false,
};

// ---- the address ------------------------------------------------------------------------

function fromUrl() {
  const p = new URLSearchParams(location.search);
  state.q = {
    team: p.get('team') || '',
    tl: LISTS.some((l) => l.id === p.get('tl')) ? p.get('tl') : '',
    hide: (p.get('hide') || '').split(',').filter((t) => TYPE[t]),
    sel: p.get('sel') || '',
    // The groups opened (ui/topicgraph.js), as their ids.
    open: p.getAll('open'),
    // Only the threads of this node (a double-click on it).
    only: p.get('only') || '',
  };
  TrendView.fromUrl();
}

function toUrl({ push = true } = {}) {
  const p = new URLSearchParams();
  const { q } = state;
  if (q.team) p.set('team', q.team);
  if (q.tl) p.set('tl', q.tl);
  for (const [k, v] of TrendView.params()) p.set(k, v);
  if (q.hide.length) p.set('hide', q.hide.join(','));
  if (q.sel) p.set('sel', q.sel);
  if (q.only) p.set('only', q.only);
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
  const build = (threads) => TopicGraph.build({ ...m, threads }, {
    team: q.team, shown: shownTypes(), min: MIN, open: q.open, teamName: teamLabel, members: state.members,
  });
  const all = build(m.threads);
  // The trends name what they compare from it, which may be outside what is shown.
  state.whole = all;
  // Only the threads of one bubble (a double-click on it), with all that they are about.
  const of = q.only && all.all.get(q.only);
  if (!of) {
    // What only its threads were shown of is not in the team's.
    q.only = '';
    return all;
  }
  const keys = new Set(of.threads.map((t) => t.key));
  return build(m.threads.filter((t) => keys.has(t.key)));
}

/** A team's name, for the bubbles of the teams. */
const teamLabel = (slug) => state.teams[slug] || state.me.teams?.find((t) => t.slug === slug)?.name || slug;

// ---- the map: bubbles in a space (ui/topicspace.js), drawn in 3D (ui/topicview.js) ------

/**
 * Every node's place (TopicSpace.places), of the whole map: the same whatever the filters, so a
 * bubble is where it was when a team is picked or only some threads are shown.
 */
const space = { of: null, pos: null };
function places() {
  if (space.of !== state.latest || !space.pos) {
    const whole = TopicGraph.build(map(), {
      shown: TYPES.map((t) => t.id), min: 1, teamName: teamLabel, members: state.members,
    });
    space.of = state.latest;
    space.pos = TopicSpace.places(map(), whole);
  }
  return space.pos;
}

/** Draws the graph of the filters; `refit` flies to show all of it. */
async function drawGraph({ refit = false } = {}) {
  const host = $('graph');
  if (!host) return;
  const g = graphOf();
  state.graph = g;
  const shown = TopicSpace.drawn(g, { open: new Set(state.q.open), shown: shownTypes(), min: MIN });
  $('graphEmpty').hidden = shown.items.length > 0;
  const ok = await TopicView.mount(host, {
    onPick: clickNode, onFold: holdNode, onOnly: only, onHover: tip,
  });
  if (!ok) {
    $('graphEmpty').hidden = false;
    $('graphEmpty').textContent = 'This browser cannot draw the map (it needs WebGL). The panel has all of it.';
    return;
  }
  // A later draw may have taken its place while three.js loaded.
  if (state.graph !== g) return;
  TopicView.draw({
    graph: g, pos: places(), open: new Set(state.q.open), shown: shownTypes(), min: MIN, glow: trending(), refit,
  });
  focus();
}

/** What is trending (ui/trends.js), which glows on the map: their ids, once the trends are in. */
function trending() {
  const moving = TrendView.moving(trendCtx());
  return new Set((moving?.trending || []).map((x) => x.key));
}

/** Marks what is picked, and what it shares threads with, or what Find finds. */
function focus() {
  TopicView.focus({ sel: state.q.sel, find: state.find.trim() });
}

/** The tooltip of what is pointed at (`id`), with what holding it does (`hold`). */
let hovering = 0;
function tip(id, ev, hold) {
  const t = $('tip');
  const n = id && state.graph?.all.get(id);
  // What is pointed at, on the chart beside what is there, a moment after; gone after it.
  if ((n ? id : '') !== state.hover) {
    clearTimeout(hovering);
    hovering = setTimeout(() => TrendView.chart({ ...trendCtx(), hover: state.hover }), 150);
  }
  state.hover = n ? id : '';
  if (!n) {
    t.hidden = true;
    return;
  }
  const acts = [
    hold?.act === 'pop' && `Hold to open its ${n.children.length}`,
    hold?.act === 'fold' && `Hold to fold into ${hold.group.label}`,
    `Double-click for only its threads${state.q.only === id ? ' (shown)' : ''}`,
  ].filter(Boolean);
  t.innerHTML = `<b>${esc(n.label)}</b><span class="sub">${esc(n.one)}${n.gap ? ', not in the tech stack' : ''} · ${n.threads.length} thread${n.threads.length === 1 ? '' : 's'}</span><span class="sub">${esc(acts.join(' · '))}</span>`;
  t.hidden = false;
  const box = $('graph').getBoundingClientRect();
  t.style.left = `${Math.min(ev.clientX - box.left + 14, box.width - t.offsetWidth - 8)}px`;
  t.style.top = `${ev.clientY - box.top + 14}px`;
}

// ---- the panel --------------------------------------------------------------------------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '–');
const tagged = (threads) => threads.filter((t) => t.tags && t.tags.length).length;

/** The color of node `n`'s dot: the one it is drawn in on the map and the chart. */
const dotType = (n) => TopicSpace.colorKey(n);

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
      <span class="dot" data-type="${dotType(r.node)}"></span><span class="nm">${esc(r.node.label)}</span>
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

/** The page as ui/trendview.js sees it. */
function trendCtx() {
  return {
    graph: state.whole || state.graph,
    map: map(),
    mapId: state.latest?.id,
    team: state.q.team,
    sel: state.q.sel,
    toUrl: () => toUrl(),
    pick,
    onWeek: showWeek,
  };
}

/**
 * The areas with their topics and the products with their features, as the graph has them: a
 * group of one is that one, and a group opens and folds as its bubble does (`open`). Each with
 * its trend; filtered, only what is trending, declining or peaked, the strongest first.
 */
function trees() {
  const g = state.graph;
  const moving = TrendView.moving(trendCtx());
  if (!moving) {
    return `<p class="hint">${TrendView.error ? `Trends: ${esc(TrendView.error)}` : 'Loading the trends…'}</p>`;
  }
  const item = (n) => moving.items.get(n.id);
  const recent = (n) => item(n)?.stats.recent || 0;
  const shows = (n) => n.children && n.children.length > 1;
  const row = (n, depth, sub = '') => {
    const it = item(n);
    const few = n.type === 'topic' && n.threads.length && tagged(n.threads) / n.threads.length < 0.25;
    return `<li class="tr d${depth}">${shows(n) ? `<button class="chev" data-fold="${esc(n.id)}" aria-expanded="${Boolean(n.open)}" aria-label="${n.open ? 'Fold' : 'Open'} ${esc(n.label)}"></button>` : '<span class="chev"></span>'}
      <button class="pickr" data-sel="${esc(n.id)}"><span class="dot" data-type="${dotType(n)}"${n.gap ? ' data-gap' : ''}></span><span class="nm">${esc(n.label)}${sub ? ` <span class="sub">${esc(sub)}</span>` : ''}${few ? ' <span class="untagged" title="Clef tags few of its threads">·</span>' : ''}</span>
      ${TrendView.badge(it)}${TrendView.spark(it)}<span class="n" title="Its share of the active channels, the last ${Trends.RECENT} weeks${it ? ` (${it.stats.perWeek.toFixed(1)} channels a week)` : ''}">${it ? TrendView.pct(100 * it.stats.share) : '–'}</span></button></li>`;
  };
  const tree = (roots) => roots.sort((a, b) => recent(b) - recent(a) || a.label.localeCompare(b.label))
    .map((n) => row(n, 0) + (shows(n) && n.open ? n.children.map((id) => g.all.get(id)).filter(Boolean)
      .sort((a, b) => recent(b) - recent(a)).map((c) => row(c, 1))
      .join('') : '')).join('');
  const all = [...g.all.values()];
  // The groups of more than one, and what is in none (a group of one is its one).
  const rootsOf = (group, leaf) => all.filter((n) => (n.type === group && shows(n))
    || (n.type === leaf && !n.parent && !n.children));
  const areas = rootsOf('tag', 'topic').filter((n) => n.type !== 'tag' || n.children.length);
  const made = rootsOf('product', 'product');
  let body;
  if (state.q.tl) {
    // A group of one is its one, listed once (ui/topicgraph.js `distinct`).
    const listed = TopicGraph.distinct(g, moving[state.q.tl].map((x) => x.key))
      .filter((n) => ['tag', 'topic', 'product'].includes(n.type));
    // What it is in, or what is in it: two of the same name (the product Commerce, its feature
    // Commerce) are told apart.
    const what = { tag: 'topics', product: 'features' };
    const parentOf = (n) => (n.parent ? `in ${g.all.get(n.parent)?.label || ''}`
      : (n.children?.length ? `${n.children.length} ${what[n.type] || ''}` : ''));
    body = `<ul class="tree">${listed.map((n) => row(n, 0, parentOf(n))).join('') || `<li class="sub">Nothing ${esc(state.q.tl)} now.</li>`}</ul>`;
  } else {
    body = `<h3>Areas and topics</h3><ul class="tree">${tree(areas)}</ul>
      <h3>Products and features</h3><ul class="tree">${tree(made) || '<li class="sub">No products yet.</li>'}</ul>`;
  }
  return `<div class="seg" role="group" aria-label="Show">${LISTS.map((l) => `<button data-tl="${l.id}" aria-pressed="${state.q.tl === l.id}" title="${esc(l.title)}">${l.label}</button>`).join('')}</div>
    <p class="hint">Each line is the share of the active channels (those with a message that week) that talk about it, week by week; trending, declining and peaked are said of the last ${Trends.RECENT} full weeks, to ${esc(TrendView.data.weeks[moving.last])}, against the ${Trends.BASE} before. A click picks it on the map and adds its line to the chart, which keeps it until × takes it off.</p>
    ${body}`;
}

function overview() {
  const g = state.graph;
  const m = map();
  const { threads } = g;
  const topics = [...g.all.values()].filter((n) => n.type === 'topic');
  const none = threads.length - tagged(threads);
  return `<h2>${plural(topics.length, 'topic')} <span class="sub">${plural(threads.length, 'thread')}</span></h2>
    <p class="hint">Found from what was said in the threads with ${m.min_messages} messages or more (not meetings or
      people's comings and goings), named all at once from their most typical threads, Clef topics and products. <b>${none} of them (${pct(none, threads.length)})
      have no tag from Clef</b>: the topics Clef rarely tags are what its topic questions miss.</p>
    ${trees()}
    ${gaps()}
    ${areasSection()}`;
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
      <span class="dot" data-type="${dotType(c)}"${c.gap ? ' data-gap' : ''}></span><span class="nm">${esc(c.label)}</span>
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
  // A person of D1 (an id); someone known only by their account (`a:…`) cannot be followed.
  if (n.type === 'person') return /^\d+$/.test(n.key) ? { kind: 'person', target: n.key } : null;
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

const followButton = (f, label, { strong = false } = {}) => (f && (state.me.teams?.length || state.me.staff)
  ? `<button class="follow${strong && !follows(f) ? ' primary' : ''}" data-follow="${esc(f.kind)}" data-target="${esc(f.target)}" aria-pressed="${follows(f)}"
      title="${follows(f) ? `Stop following ${esc(label)}: its threads leave your personal view` : `Follow ${esc(label)}: its threads are in your personal view`}">${follows(f) ? 'Unfollow' : 'Follow'}</button>`
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
  return `<div class="head"><span class="dot" data-type="${dotType(n)}"></span><div><div class="sub">${esc(n.one)}${parent ? ` in ${esc(parent.label)}` : ''}</div>
      <h2>${esc(n.label)}</h2></div><button class="close" id="unpick" aria-label="Back to the topics" title="Back to the topics">✕</button></div>
    ${followButton(followOf(n), n.label) || foldButton(n) || team ? `<div class="acts">${followButton(followOf(n), n.label, { strong: true })}${foldButton(n)}${team ? `<button data-edit-area="${esc(team)}|${esc(area.id)}">Change</button>` : ''}</div>` : ''}
    ${area && state.editArea && !state.editArea.new && state.editArea.id === area.id ? areaForm() : ''}
    ${area?.what ? `<p class="theme">Clef is asked: is this thread about ${esc(area.what)}?</p>` : ''}
    ${topic && topic.theme ? `<p class="theme">${esc(topic.theme)}</p>` : ''}
    <p class="sub facts">${facts.map(esc).join(' · ')}</p>
    ${TrendView.summary(TrendView.moving(trendCtx())?.items.get(n.id))}

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
  if (state.week) {
    panel.innerHTML = state.week.html || '<div class="empty">Loading…</div>';
    return;
  }
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
  state.week = null;
  // Its line joins the chart's, and stays when another is picked (ui/trendview.js).
  if (id && TrendView.data) TrendView.add(id, trendCtx());
  toUrl();
  if (opened) drawGraph();
  renderPanel();
  focus();
  TrendView.chart(trendCtx());
}

/** The threads of a week of the chart, in the panel; Back or a pick ends it. */
async function showWeek(week, terms) {
  state.week = { week };
  renderPanel();
  try {
    const html = await TrendView.weekThreads(week, terms, trendCtx());
    if (state.week?.week === week) state.week.html = html;
  } catch (e) {
    if (state.week?.week === week) state.week.html = `<div class="hint err">${esc(e.message)}</div>`;
  }
  renderPanel();
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

/** A click on the map: a bubble is picked, or unpicked; nothing unpicks. */
function clickNode(id) {
  pick(id && id !== state.q.sel ? id : '');
}

/** A bubble held: a group opens (and is picked), or an opened one folds (TopicView). */
function holdNode(id, act) {
  if (act === 'pop') {
    state.q.sel = id;
    if (TrendView.data) TrendView.add(id, trendCtx());
  }
  fold(id);
  if (act === 'pop') TrendView.chart(trendCtx());
}

/**
 * A double-click: only the threads of node `id`, with all they are about (a group opened, to show
 * what is in it); none, all of them again.
 */
function only(id) {
  const { q } = state;
  if (!id && !q.only) return;
  q.only = id;
  const n = id && state.graph.all.get(id);
  if (n && TopicSpace.opens(n) && !q.open.includes(id)) q.open = [...q.open, id];
  if (id) q.sel = id;
  state.week = null;
  toUrl();
  render({ refit: true });
}

function renderBar() {
  const m = map();
  $('bar').hidden = !m && !state.available;
  const teams = m ? [...new Set(m.threads.map((t) => t.team))].sort() : [];
  $('team').innerHTML = `<option value="">All teams</option>${teams.map((t) => `<option value="${esc(t)}"${t === state.q.team ? ' selected' : ''}>${esc(teamLabel(t))}</option>`).join('')}`;
  $('team').disabled = !m;
  $('types').innerHTML = TYPES.map((t) => `<button data-type="${t.id}" aria-pressed="${!state.q.hide.includes(t.id)}" title="${esc(t.title)}"${m ? '' : ' disabled'}>
    <span class="dot" data-type="${t.id}"></span>${esc(t.label)}</button>`).join('');
  const of = state.q.only && state.graph?.all.get(state.q.only);
  $('only').hidden = !of;
  $('only').innerHTML = of ? `<span class="dot" data-type="${dotType(of)}"></span>Only ${esc(of.label)}<span class="s2-cross" aria-hidden="true"></span>` : '';
  $('only').title = 'Show all the threads again (or double-click on nothing in the map)';
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
      <div class="col"><div class="card graph" id="graph"><div class="empty" id="graphEmpty" hidden>Nothing to draw: show more kinds, or fewer shared threads.</div>
        <p class="sub how">Drag to turn, scroll to zoom. Click to pick; hold a bubble to open it, or its shell to fold it; double-click for only its threads, and on nothing for all again.</p>
        <div class="tip" id="tip" hidden></div>
        ${TrendView.card()}</div></div>
      <aside class="card panel" id="panel"></aside></div>
      ${state.error ? `<div class="hint err">${esc(state.error)}</div>` : ''}`;
    TrendView.wire(trendCtx);
  }
  drawGraph({ refit });
  if (state.q.sel && !state.graph.all.has(state.q.sel)) state.q.sel = '';
  renderBar();
  renderPanel();
  TrendView.chart(trendCtx());
}

async function load() {
  // The trends come along; the map is drawn without waiting for them.
  TrendView.load().then(() => {
    if (map() && $('panel')) {
      renderPanel();
      TrendView.chart(trendCtx());
      TopicView.trending(trending());
    }
  });
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
    // Its threads have other topics now.
    TrendView.reload().then(() => render());
    // A new map: its topics are other ones, so are the places.
    space.pos = null;
    if (state.q.sel.startsWith('topic:')) state.q.sel = '';
    if (state.q.only.startsWith('topic:')) state.q.only = '';
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
  $('types').onclick = (ev) => {
    const b = ev.target.closest('button[data-type]');
    if (!b) return;
    change((q) => {
      const t = b.dataset.type;
      q.hide = q.hide.includes(t) ? q.hide.filter((x) => x !== t) : [...q.hide, t];
      if (q.hide.length === TYPES.length) q.hide = q.hide.filter((x) => x !== t);
    });
  };
  // One search: what it names lights up on the map as you type, a name picked from the list is
  // picked, and Enter puts it on the chart (words, ~a phrase, names, separated by commas).
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
  $('find').onkeydown = (ev) => {
    if (ev.key !== 'Enter' || !ev.target.value.trim()) return;
    TrendView.compare(ev.target.value, trendCtx());
    state.find = '';
    ev.target.value = '';
    focus();
  };
  $('rebuild').onclick = rebuild;
  $('only').onclick = () => only('');

  $('body').addEventListener('click', (ev) => {
    const target = ev.target.closest('[data-sel]');
    if (target && !target.closest('svg')) pick(target.dataset.sel);
    if (ev.target.closest('#unpick')) pick('');
    if (ev.target.closest('#unweek')) {
      state.week = null;
      renderPanel();
    }
    const tl = ev.target.closest('button[data-tl]');
    if (tl) {
      state.q.tl = tl.dataset.tl;
      toUrl();
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
    resizing = requestAnimationFrame(() => {
      if (map()) TrendView.drawChart(trendCtx());
    });
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
  if (!me.teams?.length && !me.staff) {
    $('body').innerHTML = `<div class="empty">The topic map is for Adobe's people. <a href="${esc(Header.href('inbox'))}">Back to the inbox</a></div>`;
    return;
  }
  TrendView.setEsc(esc);
  fromUrl();
  toUrl({ push: false });
  wire();
  renderBar();
  load();
})();
