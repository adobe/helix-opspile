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
 * The Topics page's trends (ui/topics.js draws the page): how much the channels talk about a
 * topic, an area, a product or a feature week by week, as Google Trends shows a search term, and
 * whether it is trending, declining or peaked (ui/trends.js counts; src/trends.js sends what it
 * counts from, GET /api/topics/trends).
 *
 * Everything is the map's: its nodes' ids (`topic:3`, `tag:cdn`, `product:tech:…`,
 * `product:group:…`, ui/topicgraph.js), its areas and products, its team filter. A week counts the
 * channels with a message in a matching thread, of the channels with any (ui/trends.js), as a
 * share, on a three-week mean. The chart under the map shows what is picked and the terms
 * compared, separated by commas: what the map has, by its name, words (in a title or a message)
 * or `~a phrase` (the threads about it), the last two asked of GET /api/topics/trends/match. The
 * terms are the page's address (`tq`).
 *
 * Its global `TrendView`.
 */
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const COLORS = 8;
  /** The shades of one color, for lines of the same kind. */
  const SHADES = 3;
  const MAX_TERMS = 6;
  const LISTED = 30;
  const SMOOTH = 1;
  const { I } = Trends;

  const st = {
    data: null,
    error: '',
    loading: null,
    matches: new Map(),
    terms: null,
    hidden: new Set(),
    cache: new Map(),
  };
  const $ = (id) => document.getElementById(id);
  let esc = (s) => String(s ?? '');

  // ---- the data -----------------------------------------------------------------------------

  function load() {
    st.loading ||= (async () => {
      try {
        const res = await fetch('/api/topics/trends', { credentials: 'same-origin', redirect: 'manual' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
        st.data = body;
        st.error = '';
        st.cache.clear();
      } catch (e) {
        st.error = e.message;
      }
    })();
    return st.loading;
  }

  /** Again, after the map was built again: the threads have its topics. */
  function reload() {
    st.loading = null;
    st.data = null;
    return load();
  }

  function keep(ctx) {
    const team = ctx.team ? st.data.teams.indexOf(ctx.team) : -1;
    return (r) => team < 0 || r[I.team] === team;
  }

  /** The product each technology is part of, as the map groups them (`product:group:…`). */
  function productOf(ctx, i) {
    const t = st.data.tech[i];
    const p = ctx.map.products?.[`tech:${t.id}`]?.product || t.product;
    return p ? `product:group:${p}` : null;
  }

  /** The map's nodes a thread counts for: its topic and its area, its features and products. */
  function keysOf(ctx) {
    const areas = ctx.graph.areas || [];
    return (r) => {
      const out = [];
      if (r[I.topic] >= 0) {
        out.push(`topic:${r[I.topic]}`, `tag:${areas[r[I.topic]] || TopicGraph.NONE}`);
      }
      for (const i of r[I.tech]) {
        out.push(`product:tech:${st.data.tech[i].id}`);
        const g = productOf(ctx, i);
        if (g) out.push(g);
      }
      return [...new Set(out)];
    };
  }

  /** Every node's trend (ui/trends.js `moving`), for the map and team on screen. */
  function moving(ctx) {
    if (!st.data) return null;
    const key = `${ctx.mapId}|${ctx.team}`;
    if (!st.cache.has(key)) {
      st.cache.set(key, Trends.moving(st.data, { keep: keep(ctx), keysOf: keysOf(ctx) }));
    }
    return st.cache.get(key);
  }

  // ---- the terms ----------------------------------------------------------------------------

  function fromUrl() {
    const p = new URLSearchParams(location.search);
    st.terms = p.get('tq');
  }

  const params = () => (st.terms ? [['tq', st.terms]] : []);

  /** A term: `{ term, label, id }` for one of the map's nodes, `{ term, label, server }` else. */
  function termOf(raw, ctx) {
    const t = raw.trim();
    const node = ctx.graph.all.get(t)
      || [...ctx.graph.all.values()].find((n) => ['topic', 'tag', 'product'].includes(n.type)
        && n.label.toLowerCase() === t.toLowerCase());
    if (node) return { term: node.id, label: node.label, id: node.id };
    return { term: t, label: t, server: true };
  }

  const termsOf = (ctx) => (st.terms || '').split(',').map((s) => s.trim()).filter(Boolean)
    .slice(0, MAX_TERMS).map((t) => termOf(t, ctx));

  async function ask(term) {
    if (st.matches.has(term)) return;
    st.matches.set(term, { pending: true });
    try {
      const res = await fetch(`/api/topics/trends/match?term=${encodeURIComponent(term)}`, { credentials: 'same-origin', redirect: 'manual' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
      st.matches.set(term, { ids: new Set(body.ids), semantic: body.semantic, capped: body.capped });
    } catch (e) {
      st.matches.set(term, { error: e.message });
    }
  }

  /** What the chart shows: the pick, then the terms; with neither, the most trending topics. */
  function seriesOf(ctx) {
    const m = moving(ctx);
    const list = [];
    const add = (t) => {
      if (t && !list.some((x) => x.term === t.term)) list.push(t);
    };
    if (ctx.sel && m.items.has(ctx.sel)) add({ term: ctx.sel, label: ctx.graph.all.get(ctx.sel)?.label || ctx.sel, id: ctx.sel, picked: true });
    termsOf(ctx).forEach(add);
    if (!list.length) {
      m.trending.filter((x) => x.key.startsWith('topic:')).slice(0, 3)
        .forEach((x) => add({ term: x.key, label: ctx.graph.all.get(x.key)?.label || x.key, id: x.key }));
    }
    // What is pointed at on the map, beside the rest, to see it against them.
    if (ctx.hover && m.items.has(ctx.hover)) {
      add({
        term: ctx.hover, label: ctx.graph.all.get(ctx.hover)?.label || ctx.hover, id: ctx.hover, hovered: true,
      });
    }
    const k = keep(ctx);
    // A line of the map's in the color of its bubble (TopicSpace.colorKey), another shade for a
    // second of the same color; words and phrases in the chart's own palette.
    const seen = new Map();
    const paintOf = (t, i) => {
      const node = t.id && ctx.graph.all.get(t.id);
      if (!node || !globalThis.TopicSpace) return `s${i % COLORS}`;
      const kind = globalThis.TopicSpace.colorKey(node);
      const n = seen.get(kind) || 0;
      seen.set(kind, n + 1);
      return `k-${kind} v${n % SHADES}`;
    };
    return list.map((t, i) => {
      let counts;
      if (t.id) {
        counts = m.items.get(t.id)?.counts || new Array(st.data.weeks.length).fill(0);
      } else {
        const match = st.matches.get(t.term);
        counts = Trends.weekly(st.data, (r) => k(r) && Boolean(match?.ids?.has(r[I.id]))).counts;
      }
      return {
        ...t, color: i % COLORS, paint: paintOf(t, i), counts, match: st.matches.get(t.term), total: counts.reduce((a, b) => a + b, 0),
      };
    });
  }

  // ---- drawing ------------------------------------------------------------------------------

  function el(name, attrs = {}) {
    const e = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  const monthOf = (w) => new Date(`${w}T00:00:00Z`).toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  const pctOf = (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;

  /** A line of a node's share, over its weeks; the last RECENT behind a rule. */
  function spark(item) {
    if (!item) return '<svg class="spark" viewBox="0 0 60 18" aria-hidden="true"></svg>';
    const points = Trends.smooth(item.spark, SMOOTH);
    const m = Math.max(...points, 1e-9);
    const n = points.length;
    const x = (i) => ((i * 60) / Math.max(1, n - 1)).toFixed(1);
    const pts = points.map((v, i) => `${x(i)},${(17 - (15 * v) / m).toFixed(1)}`).join(' ');
    const split = x(n - Trends.RECENT);
    return `<svg class="spark${item.list ? ` ${item.list}` : ''}" viewBox="0 0 60 18" aria-hidden="true"><line class="grid" x1="${split}" x2="${split}" y1="0" y2="18"></line><polyline points="${pts}"></polyline></svg>`;
  }

  /** What a node is doing, in a few words: trending, declining or peaked, and by how much. */
  function badge(item) {
    if (!item || !item.list) return '';
    const s = item.stats;
    const lift = Math.round((s.lift - 1) * 100);
    const text = {
      trending: `↑ ${lift}%`,
      declining: `↓ ${Math.abs(lift)}%`,
      peaked: `peaked ${monthOf(st.data.weeks[s.peak.week])}`,
    }[item.list];
    const pace = item.list === 'trending' && s.accel > 0.05 ? ', speeding up' : '';
    const title = item.list === 'peaked'
      ? `Peaked in the week of ${st.data.weeks[s.peak.week]}; now ${Math.round((100 * s.now) / (s.peak.share || 1))}% of that`
      : `${s.perWeek.toFixed(1)} channels a week, ${lift >= 0 ? '+' : ''}${lift}% on the 12 weeks before${pace}`;
    return `<span class="badge ${item.list}${item.top > Trends.MOSTLY_ONE ? ' one' : ''}" title="${esc(title)}${item.top > Trends.MOSTLY_ONE ? ' · mostly one customer' : ''}">${esc(text)}</span>`;
  }

  /** A sentence on a node's trend, for its details. */
  function summary(item) {
    if (!item) return '';
    const s = item.stats;
    const lift = Math.round((s.lift - 1) * 100);
    const what = {
      trending: 'Trending',
      declining: 'Declining',
      peaked: `Peaked in the week of ${st.data.weeks[s.peak.week]}, now at ${Math.round((100 * s.now) / (s.peak.share || 1))}% of that`,
    }[item.list] || 'Steady';
    return `<p class="trend">${spark(item)}<span>${esc(what)}: ${s.perWeek.toFixed(1)} channels a week in the last ${Trends.RECENT} weeks, ${lift >= 0 ? '+' : ''}${lift}% on the ${Trends.BASE} before${item.list === 'trending' && s.accel > 0.05 ? ', speeding up' : ''} · ${item.orgs} customer${item.orgs === 1 ? '' : 's'}${item.top > Trends.MOSTLY_ONE ? ', mostly one' : ''}</span></p>`;
  }

  function drawChart(ctx) {
    const svg = $('tsvg');
    if (!svg || !st.data) return;
    const m = moving(ctx);
    const series = seriesOf(ctx);
    const { totals, first } = m;
    svg.textContent = '';
    const box = svg.getBoundingClientRect();
    const W = Math.max(320, box.width || 800);
    const H = Math.max(140, box.height || 240);
    const L = 44;
    const R = 12;
    const T = 10;
    const B = 22;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const weeks = st.data.weeks.slice(first);
    const n = weeks.length;
    const shown = series.filter((s) => !st.hidden.has(s.term));
    const vals = new Map(series.map((s) => [s.term, Trends.smooth(s.counts.map((c, i) => (totals[i] ? (100 * c) / totals[i] : 0)), SMOOTH).slice(first)]));
    const max = Math.max(1e-9, ...shown.flatMap((s) => vals.get(s.term))) * 1.08;
    const x = (i) => L + ((W - L - R) * i) / Math.max(1, n - 1);
    const y = (v) => T + (H - T - B) * (1 - v / max);
    for (let k = 0; k <= 3; k += 1) {
      const v = (max / 1.08) * (k / 3);
      svg.append(el('line', {
        class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v),
      }));
      const t = el('text', {
        class: 'axis', x: L - 6, y: y(v) + 4, 'text-anchor': 'end',
      });
      t.textContent = pctOf(v);
      svg.append(t);
    }
    weeks.forEach((w, i) => {
      if (Number(w.slice(8, 10)) <= 7) {
        svg.append(el('line', {
          class: 'grid month', x1: x(i), x2: x(i), y1: T, y2: H - B,
        }));
        const t = el('text', {
          class: 'axis', x: x(i), y: H - 6, 'text-anchor': 'middle',
        });
        t.textContent = monthOf(w);
        svg.append(t);
      }
    });
    for (const s of shown) {
      const pts = vals.get(s.term).map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      svg.append(el('polyline', { class: `line ${s.paint}${s.picked || s.hovered ? ' picked' : ''}`, points: pts.slice(0, -1).join(' ') }));
      // The week under way: dashed, it is not over.
      svg.append(el('polyline', { class: `line ${s.paint} partial`, points: pts.slice(-2).join(' ') }));
    }
    const cursor = el('line', {
      class: 'cursor', y1: T, y2: H - B, visibility: 'hidden',
    });
    svg.append(cursor);
    const hit = el('rect', {
      class: 'hit', x: L, y: T, width: W - L - R, height: H - T - B,
    });
    svg.append(hit);
    const at = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      return Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1))));
    };
    const tip = $('ttip');
    hit.onpointermove = (ev) => {
      const i = at(ev);
      cursor.setAttribute('x1', x(i));
      cursor.setAttribute('x2', x(i));
      cursor.setAttribute('visibility', 'visible');
      tip.innerHTML = `<b>Week of ${esc(weeks[i])}${i === n - 1 ? ' (so far)' : ''}</b>
        ${shown.map((s) => `<span class="row"><span class="swatch ${s.paint}"></span>${esc(s.label)}: ${s.counts[first + i]} channels, ${totals[first + i] ? pctOf((100 * s.counts[first + i]) / totals[first + i]) : '0%'}</span>`).join('')}
        <span class="sub">${totals[first + i]} channels with messages that week · click for its threads</span>`;
      tip.hidden = false;
      const box2 = $('tchart').getBoundingClientRect();
      tip.style.left = `${Math.min(ev.clientX - box2.left + 14, box2.width - tip.offsetWidth - 8)}px`;
      tip.style.top = `${Math.max(0, ev.clientY - box2.top - tip.offsetHeight - 10)}px`;
    };
    hit.onpointerleave = () => {
      tip.hidden = true;
      cursor.setAttribute('visibility', 'hidden');
    };
    hit.onclick = (ev) => ctx.onWeek(first + at(ev), shown.map((s) => s.term));
    $('tlegend').innerHTML = series.map((s) => {
      const mt = s.match;
      const note = (mt && mt.pending && 'looking…') || (mt && mt.error) || (mt && mt.capped && 'some months have more than shown')
        || (mt && mt.semantic && 'by meaning') || (s.picked && 'picked') || (s.hovered && 'pointed at') || '';
      return `<li${st.hidden.has(s.term) ? ' class="off"' : ''}><button class="term" data-term="${esc(s.term)}" title="Shift-click hides it">
        <span class="swatch ${s.paint}"></span>${esc(s.label)}${note ? ` <span class="sub">${esc(note)}</span>` : ''}</button>
        ${s.picked ? '' : `<button class="x" data-drop="${esc(s.term)}" aria-label="Remove ${esc(s.label)}">×</button>`}</li>`;
    }).join('');
    const names = [...ctx.graph.all.values()].filter((nd) => ['topic', 'tag', 'product'].includes(nd.type)).map((nd) => nd.label);
    $('tnames').innerHTML = [...new Set(names)].map((nm) => `<option value="${esc(nm)}"></option>`).join('');
    if (document.activeElement !== $('tq')) {
      $('tq').value = termsOf(ctx).map((t) => (t.id && !t.label.includes(',') ? t.label : t.term)).join(', ');
    }
  }

  /** Draws the chart, asking for the words and phrases it does not have yet. */
  async function chart(ctx) {
    if (!st.data) return;
    drawChart(ctx);
    const pending = termsOf(ctx).filter((t) => t.server && !st.matches.has(t.term));
    if (pending.length) {
      await Promise.all(pending.map((t) => ask(t.term)));
      drawChart(ctx);
    }
  }

  /** The chart's card, under the map. */
  function card() {
    return `<section class="card tchart" id="tchart">
      <div class="thead"><h2>Channels talking about it <span class="sub">% of the channels with messages, week by week</span></h2>
        <div class="tqrow"><label class="s2-search"><input class="search" id="tq" type="search" list="tnames" autocomplete="off" aria-label="Compare, separated by commas: a topic, an area or a product, words, or ~a phrase"></label><datalist id="tnames"></datalist>
          <button id="tgo">Compare</button></div></div>
      <svg id="tsvg" role="img" aria-label="Week by week"></svg><ul class="legend tlegend" id="tlegend"></ul>
      <div class="tip" id="ttip" hidden></div></section>`;
  }

  /** Wires the card: compare, remove a term, hide one. `ctx()` is the page as it is now. */
  function wire(ctx) {
    const compare = () => {
      const c = ctx();
      st.terms = $('tq').value.split(',').map((s) => s.trim()).filter(Boolean)
        .map((raw) => termOf(raw, c).term).slice(0, MAX_TERMS).join(', ');
      c.toUrl();
      $('tq').blur();
      chart(c);
    };
    $('tgo').onclick = compare;
    $('tq').onkeydown = (ev) => {
      if (ev.key === 'Enter') compare();
    };
    $('tlegend').onclick = (ev) => {
      const c = ctx();
      const drop = ev.target.closest('[data-drop]');
      if (drop) {
        st.terms = termsOf(c).filter((t) => t.term !== drop.dataset.drop).map((t) => t.term).join(', ');
        c.toUrl();
        chart(c);
        return;
      }
      const b = ev.target.closest('[data-term]');
      if (b && ev.shiftKey) {
        if (st.hidden.has(b.dataset.term)) st.hidden.delete(b.dataset.term);
        else st.hidden.add(b.dataset.term);
        drawChart(c);
      } else if (b && c.graph.all.has(b.dataset.term)) {
        c.pick(b.dataset.term);
      }
    };
  }

  /** Adds `id` to the terms compared. */
  function compareWith(id, ctx) {
    const now = termsOf(ctx).map((t) => t.term);
    if (!now.includes(id)) st.terms = [...now, id].slice(-MAX_TERMS).join(', ');
    ctx.toUrl();
    chart(ctx);
  }

  /** The threads of week `week` for `terms` (as the chart has them), for the panel. */
  async function weekThreads(week, terms, ctx) {
    const k = keep(ctx);
    const keys = keysOf(ctx);
    const series = seriesOf(ctx).filter((s) => terms.includes(s.term));
    const inWeek = (r) => {
      const w = r[I.weeks];
      for (let i = 0; i < w.length; i += 2) if (w[i] === week) return w[i + 1];
      return 0;
    };
    const lists = series.map((s) => st.data.threads.filter((r) => k(r) && inWeek(r) && (s.id ? keys(r).includes(s.id) : Boolean(s.match?.ids?.has(r[I.id]))))
      .sort((a, b) => inWeek(b) - inWeek(a)));
    const ids = [...new Set(lists.flatMap((l) => l.slice(0, LISTED).map((r) => r[I.id])))];
    const res = await fetch(`/api/topics/trends/threads?ids=${ids.join(',')}`, { credentials: 'same-origin', redirect: 'manual' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
    const byId = new Map(body.threads.map((t) => [t.id, t]));
    const orgName = (slug) => st.data.orgs.find((o) => o.slug === slug)?.name || slug;
    const link = (x) => `/inbox?team=${encodeURIComponent(x.team)}&t=${encodeURIComponent(x.key)}`;
    return `<div class="head"><div><div class="sub">Threads</div><h2>The week of ${esc(st.data.weeks[week])}</h2></div>
        <button class="close" id="unweek" aria-label="Back" title="Back">✕</button></div>
      ${series.map((s, i) => `<section><h3><span class="swatch ${s.paint}"></span>${esc(s.label)} <span class="sub">${lists[i].length}</span></h3>
        <ol class="threads">${lists[i].slice(0, LISTED).map((r) => byId.get(r[I.id])).filter(Boolean).map((x) => `<li><a href="${esc(link(x))}" target="_blank" rel="noopener">${esc(x.title || '(no title)')}</a>
          <div class="sub">${esc(orgName(x.org))} · ${esc(x.team)} · ${esc(x.source)} · ${esc(String(x.at).slice(0, 10))} · ${x.messages} message${x.messages === 1 ? '' : 's'}</div></li>`).join('') || '<li class="sub">None</li>'}</ol></section>`).join('')}`;
  }

  globalThis.TrendView = {
    load,
    reload,
    get data() { return st.data; },
    get error() { return st.error; },
    setEsc(fn) { esc = fn; },
    moving,
    spark,
    badge,
    summary,
    card,
    wire,
    chart,
    drawChart,
    compareWith,
    weekThreads,
    fromUrl,
    params,
  };
})();
