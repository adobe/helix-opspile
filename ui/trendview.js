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
 * channels with a message in a matching thread, of the active channels (those with a message
 * that week, ui/trends.js), as a share, on a three-week mean. The chart under the map compares terms, separated by commas: what
 * the map has, by its name, a doc or a link the threads have (`docs/limits`, a URL: one of the
 * data's `facts`, else asked of the server as the rest), words (in a title or a message) or
 * `~a phrase` (the threads about it), the last two asked of GET /api/topics/trends/match. The
 * docs and links rising fastest, or that spiked across customers, are `rising`. What is picked on the map or in the
 * panel joins them (`add`), so a line stays until it is taken off; with none, the chart shows the
 * most trending topics, and the first pick joins those. The terms are the page's address (`tq`).
 *
 * Its global `TrendView`.
 */
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const COLORS = 8;
  /** The shades of one color, for lines of the same kind. */
  const SHADES = 3;
  const MAX_TERMS = 8;
  const LISTED = 30;
  /** The docs and links `rising` lists, at most. */
  const RISING = 8;
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

  /** A thread's docs and links, as series keys (`fact:<index>`). */
  const factKeys = (r) => (r[I.facts] || []).map((i) => `fact:${i}`);

  /** The docs' and links' trends (ui/trends.js `moving`), for the team on screen. */
  function factMoving(ctx) {
    const key = `facts|${ctx.team}`;
    if (!st.cache.has(key)) st.cache.set(key, Trends.moving(st.data, { keep: keep(ctx), keysOf: factKeys }));
    return st.cache.get(key);
  }

  /**
   * The docs and links rising fastest, for the team on screen: trending (ui/trends.js `moving`)
   * across customers, or a spike (`spikes`), each once, the strongest first. Each `{ fact, item,
   * spike, score }`, `fact` the data's, `item` its trend, `spike` its week, if it had one.
   */
  function rising(ctx) {
    if (!st.data || !st.data.facts?.length) return st.data ? [] : null;
    const key = `rising|${ctx.team}`;
    if (!st.cache.has(key)) {
      const k = keep(ctx);
      const m = factMoving(ctx);
      const by = new Map();
      for (const it of m.trending) {
        // One customer's own page climbing is their project, not a trend.
        if (it.orgs >= 2 && it.top <= Trends.MOSTLY_ONE) by.set(it.key, { item: it, score: it.score });
      }
      for (const sp of Trends.spikes(st.data, { keep: k, keysOf: factKeys })) {
        const was = by.get(sp.key);
        by.set(sp.key, { item: m.items.get(sp.key), spike: sp, score: Math.max(sp.score, was?.score || 0) });
      }
      st.cache.set(key, [...by].map(([k2, x]) => ({ ...x, fact: st.data.facts[Number(k2.slice(5))], i: Number(k2.slice(5)) }))
        .sort((a, b) => b.score - a.score).slice(0, RISING));
    }
    return st.cache.get(key);
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

  /**
   * The terms in the address: none (`tq` absent) shows the defaults; an empty `tq` is a chart that
   * was cleared, with no line until one is added.
   */
  const params = () => (st.terms === null || st.terms === undefined ? [] : [['tq', st.terms]]);

  /**
   * A term: `{ term, label, id }` for one of the map's nodes (a group of one as its one, as the
   * graph draws it), `{ term, label, fact }` for a doc or a link of the data's (by its label or
   * its key), `{ term, label, server }` else.
   */
  function termOf(raw, ctx) {
    const t = raw.trim();
    const named = ctx.graph.all.get(t)
      || [...ctx.graph.all.values()].find((n) => ['topic', 'tag', 'product'].includes(n.type)
        && n.label.toLowerCase() === t.toLowerCase());
    const node = named && TopicGraph.standsFor(ctx.graph, named.id);
    if (node) return { term: node.id, label: node.label, id: node.id };
    const lower = t.toLowerCase().replace(/^https?:\/\/(?:www\.)?/, '').replace(/\/+$/, '');
    const fact = (st.data?.facts || []).findIndex((f) => f.key === t || f.label.toLowerCase() === lower);
    if (fact >= 0) return { term: st.data.facts[fact].label, label: st.data.facts[fact].label, fact };
    return { term: t, label: t, server: true };
  }

  const termsOf = (ctx) => (st.terms || '').split(',').map((s) => s.trim()).filter(Boolean)
    .slice(0, MAX_TERMS).map((t) => termOf(t, ctx));
  /** Whether the chart was cleared, or had its last line taken off: then it has no defaults. */
  const cleared = () => typeof st.terms === 'string';
  /** What is on the chart before the pick and what is pointed at: the terms, or the defaults. */
  const base = (ctx) => (cleared() ? termsOf(ctx) : defaults(ctx));

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

  /** With no terms: the most trending topics, as terms. */
  function defaults(ctx) {
    const m = moving(ctx);
    return TopicGraph.distinct(ctx.graph, m.trending.filter((x) => x.key.startsWith('topic:'))
      .map((x) => x.key)).slice(0, 3).map((n) => ({ term: n.id, label: n.label, id: n.id }));
  }

  /** What the chart shows: the terms (or the defaults), the pick among them marked. */
  function seriesOf(ctx) {
    const m = moving(ctx);
    const picked = ctx.sel && TopicGraph.standsFor(ctx.graph, ctx.sel);
    const list = [];
    for (const t of base(ctx)) {
      if (!list.some((x) => x.term === t.term)) list.push({ ...t, picked: Boolean(picked && t.term === picked.id) });
    }
    // A pick the terms do not have yet (they are added on a pick, `add`): shown too.
    if (picked && m.items.has(picked.id) && !list.some((x) => x.term === picked.id)) {
      list.push({
        term: picked.id, label: picked.label, id: picked.id, picked: true,
      });
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
      } else if (t.fact !== undefined) {
        counts = Trends.weekly(st.data, (r) => k(r) && (r[I.facts] || []).includes(t.fact)).counts;
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
      : `${pctOf(100 * s.share)} of the active channels (${s.perWeek.toFixed(1)} a week), ${lift >= 0 ? '+' : ''}${lift}% against the ${Trends.BASE} weeks before${pace}`;
    return `<span class="badge ${item.list}${item.top > Trends.MOSTLY_ONE ? ' one' : ''}" title="${esc(title)}${item.top > Trends.MOSTLY_ONE ? ', mostly one customer' : ''}">${esc(text)}</span>`;
  }

  /** A sentence on a node's trend, for its details. */
  function summary(item) {
    if (!item) return '';
    const s = item.stats;
    const what = {
      trending: 'Trending',
      declining: 'Declining',
      peaked: `Peaked in the week of ${st.data.weeks[s.peak.week]}, now at ${Math.round((100 * s.now) / (s.peak.share || 1))}% of that`,
    }[item.list] || 'Steady';
    return `<p class="trend">${spark(item)}<span>${esc(what)}: ${pctOf(100 * s.share)} of the active channels in the last ${Trends.RECENT} weeks (${s.perWeek.toFixed(1)} a week), against ${pctOf(100 * s.baseShare)} in the ${Trends.BASE} before${item.list === 'trending' && s.accel > 0.05 ? ', speeding up' : ''}; ${item.orgs} customer${item.orgs === 1 ? '' : 's'}${item.top > Trends.MOSTLY_ONE ? ', mostly one' : ''}</span></p>`;
  }

  /** A spike's badge: how many customers had it in which week, against a usual one. */
  function spikeBadge(sp) {
    const week = st.data.weeks[sp.week];
    const day = new Date(`${week}T00:00:00Z`).toLocaleString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const title = `${sp.orgs} customers in the week of ${week}${sp.week === st.data.weeks.length - 1 ? ' (so far)' : ''}, against ${sp.usual.toFixed(1)} in a usual week of the ${Trends.BASE} before`;
    return `<span class="badge spike" title="${esc(title)}">${esc(`${sp.orgs} customers, ${day}`)}</span>`;
  }

  /** What the inbox calls a fact's field (src/trends.js `fields`), else the field as it is. */
  const fieldName = (f) => st.data?.fields?.[f.field] || f.field;

  /**
   * A doc or a link (`f`: `{ label, href, field }`): a button that puts it on the chart, a link to
   * its page, its line and what it is doing, and `sub` under it.
   */
  function factRow(f, { item = null, spike = null, sub = '' } = {}) {
    return `<li><button class="link nm" data-term="${esc(f.label)}" title="Put it on the chart">${esc(f.label)}</button>
      ${f.href ? `<a class="out" href="${esc(f.href)}" target="_blank" rel="noopener" title="Open" aria-label="Open ${esc(f.label)}">↗</a>` : '<span></span>'}
      ${item ? spark(item) : '<span></span>'}${(spike && item?.list !== 'trending' ? spikeBadge(spike) : badge(item)) || '<span></span>'}
      <span class="sub">${esc([fieldName(f), sub].filter(Boolean).join(' · '))}</span></li>`;
  }

  /**
   * The panel's docs and links rising fastest across customers (`rising`), each a row that puts it
   * on the chart; nothing before the trends are in.
   */
  function risingSection(ctx) {
    const list = rising(ctx);
    if (!list) return '';
    const rows = list.map((x) => factRow(x.fact, {
      item: x.item,
      spike: x.spike,
      sub: `${x.fact.threads} threads, ${x.fact.orgs} customers`,
    }));
    return `<section class="rising"><h3>Rising docs and links</h3>
      <p class="hint">Docs, pull requests, endpoints and other links more customers' threads have now than before, or many at once in one week.</p>
      ${rows.length ? `<ol class="docs">${rows.join('')}</ol>` : '<p class="hint">None is rising across customers now.</p>'}</section>`;
  }

  /** A topic's docs and links (`topics[].facts`, src/topicmap.js `topicFacts`), for its details. */
  function factsSection(facts, ctx) {
    if (!facts || !facts.length) return '';
    const up = st.data ? rising(ctx) : null;
    const items = st.data?.facts?.length ? factMoving(ctx).items : null;
    const rows = facts.map((f) => {
      const i = (st.data?.facts || []).findIndex((x) => x.key === f.key);
      const spike = up && up.find((x) => x.i === i)?.spike;
      return factRow(f, {
        item: i >= 0 && items ? items.get(`fact:${i}`) : null,
        spike,
        sub: `${f.threads} of its threads, ${f.orgs} customers`,
      });
    });
    return `<section><h3>Docs and links</h3><ol class="docs">${rows.join('')}</ol></section>`;
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
      // A wash of its color under the line, down to the axis.
      svg.append(el('polygon', {
        class: `area ${s.paint}`, points: `${x(0).toFixed(1)},${y(0).toFixed(1)} ${pts.join(' ')} ${x(n - 1).toFixed(1)},${y(0).toFixed(1)}`,
      }));
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
        ${shown.map((s) => `<span class="row"><span class="swatch ${s.paint}"></span>${esc(s.label)}: ${totals[first + i] ? pctOf((100 * s.counts[first + i]) / totals[first + i]) : '0%'} (${s.counts[first + i]} of ${totals[first + i]} active channels)</span>`).join('')}
        <span class="sub">Click to see the threads</span>`;
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
    $('tlegend').innerHTML = `${series.map((s) => {
      const mt = s.match;
      const note = (mt && mt.pending && 'looking…') || (mt && mt.error) || (mt && mt.capped && 'some months have more than shown')
        || (mt && mt.semantic && 'by meaning') || ((s.fact !== undefined || mt?.fact) && 'as a fact') || (s.picked && 'picked') || (s.hovered && 'pointed at') || '';
      return `<li${st.hidden.has(s.term) ? ' class="off"' : ''}><button class="term" data-term="${esc(s.term)}" title="Shift-click to hide">
        <span class="swatch ${s.paint}"></span>${esc(s.label)}${note ? ` <span class="sub">${esc(note)}</span>` : ''}</button>
        <button class="x" data-drop="${esc(s.term)}" aria-label="Take ${esc(s.label)} off the chart">×</button></li>`;
    }).join('')}${series.some((s) => !s.hovered) ? '<li><button class="clear" data-clear>Clear</button></li>'
      : '<li class="sub">Pick a bubble or search to add a line.</li>'}`;
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

  /**
   * The chart, over the bottom of the map: the share of the channels with messages that talk about
   * each line, week by week. What it compares comes from the page's search (`compare`).
   */
  function card() {
    return `<section class="tchart" id="tchart" aria-label="Share of active channels, week by week">
      <svg id="tsvg" role="img" aria-label="Week by week"></svg><ul class="legend tlegend" id="tlegend"></ul>
      <div class="tip" id="ttip" hidden></div></section>`;
  }

  /** Adds `text` to what the chart compares: terms separated by commas, at most MAX_TERMS. */
  function compare(text, c) {
    const old = base(c).map((t) => t.term);
    const added = String(text).split(',').map((s) => s.trim()).filter(Boolean)
      .map((raw) => termOf(raw, c).term);
    st.terms = [...new Set([...old, ...added])].slice(-MAX_TERMS).join(', ');
    c.toUrl();
    chart(c);
  }

  /** Wires the chart: remove a term, hide one. `ctx()` is the page as it is now. */
  function wire(ctx) {
    $('tlegend').onclick = (ev) => {
      const c = ctx();
      if (ev.target.closest('[data-clear]')) {
        clear(c);
        return;
      }
      const drop = ev.target.closest('[data-drop]');
      if (drop) {
        const shown = seriesOf(c).map((t) => t.term).filter((t) => t !== drop.dataset.drop);
        st.terms = shown.join(', ');
        // The pick's line goes with it: it is unpicked.
        if (c.sel && TopicGraph.standsFor(c.graph, c.sel)?.id === drop.dataset.drop) {
          c.pick('');
          return;
        }
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

  /**
   * Adds node `id` to the terms compared (to the defaults, when there are no terms yet), unless
   * it has no line (a person, a customer); the oldest goes when there are MAX_TERMS.
   */
  function add(id, ctx) {
    const n = id && TopicGraph.standsFor(ctx.graph, id);
    const m = moving(ctx);
    if (!n || !m || !m.items.has(n.id)) return;
    const now = base(ctx).map((t) => t.term);
    if (!now.includes(n.id)) st.terms = [...now, n.id].slice(-MAX_TERMS).join(', ');
    else st.terms = now.join(', ');
  }

  /**
   * Takes every line off, the pick's too (it is unpicked): the chart is empty until a line is added
   * (a pick, a search), and stays so in the address (an empty `tq`).
   */
  function clear(ctx) {
    // Empty, not the defaults again: what is added next is all there is.
    st.terms = '';
    if (ctx.sel) {
      ctx.pick('');
      return;
    }
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
    const has = (s, r) => {
      if (s.id) return keys(r).includes(s.id);
      if (s.fact !== undefined) return (r[I.facts] || []).includes(s.fact);
      return Boolean(s.match?.ids?.has(r[I.id]));
    };
    const lists = series.map((s) => st.data.threads.filter((r) => k(r) && inWeek(r) && has(s, r))
      .sort((a, b) => inWeek(b) - inWeek(a)));
    const ids = [...new Set(lists.flatMap((l) => l.slice(0, LISTED).map((r) => r[I.id])))];
    const res = await fetch(`/api/topics/trends/threads?ids=${ids.join(',')}`, { credentials: 'same-origin', redirect: 'manual' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
    const byId = new Map(body.threads.map((t) => [t.id, t]));
    const orgName = (slug) => st.data.orgs.find((o) => o.slug === slug)?.name || slug;
    const link = (x) => `/inbox?team=${encodeURIComponent(x.team)}&t=${encodeURIComponent(x.key)}`;
    return `<div class="head"><div><h2>Threads in the week of ${esc(st.data.weeks[week])}</h2></div>
        <button class="close" id="unweek" aria-label="Back" title="Back">✕</button></div>
      ${series.map((s, i) => `<section><h3><span class="swatch ${s.paint}"></span>${esc(s.label)} <span class="sub">${lists[i].length}</span></h3>
        <ol class="threads">${lists[i].slice(0, LISTED).map((r) => byId.get(r[I.id])).filter(Boolean).map((x) => `<li><a href="${esc(link(x))}" target="_blank" rel="noopener">${esc(x.title || '(no title)')}</a>
          <div class="sub">${esc(orgName(x.org))}, ${esc(x.team)}, ${esc(x.source)}, ${esc(String(x.at).slice(0, 10))}, ${x.messages} message${x.messages === 1 ? '' : 's'}</div></li>`).join('') || '<li class="sub">None</li>'}</ol></section>`).join('')}`;
  }

  globalThis.TrendView = {
    load,
    reload,
    get data() { return st.data; },
    get error() { return st.error; },
    setEsc(fn) { esc = fn; },
    moving,
    rising,
    risingSection,
    factsSection,
    spark,
    badge,
    summary,
    pct: (v) => pctOf(v),
    card,
    wire,
    compare,
    chart,
    drawChart,
    add,
    clear,
    weekThreads,
    fromUrl,
    params,
  };
})();
