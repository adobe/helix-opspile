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
 * The Topics page's Trends (ui/topics.js shows it for `view=trends`): how much the channels talk
 * about something, week by week, compared as Google Trends compares search terms, and what is
 * trending, declining or peaked (ui/trends.js counts, src/trends.js sends what it counts from).
 *
 * The terms, separated by commas: a topic of the trend map, an area or a technology (picked, or
 * typed as its name), words (in a thread's title or messages), `~a phrase` (the threads about
 * it, from their vectors), or `kind:`, `src:`, `org:` and `team:` with a value. The words and
 * phrases are asked of GET /api/topics/trends/match; the rest is counted in the page. A click on
 * a week lists its threads (GET /api/topics/trends/threads), a click on a term all of its own.
 * The terms, filters and lists are the page's address (`t…` parameters, beside the map's).
 *
 * Its global `TrendView`: `show(body, ctx)` draws it into `body`, `params()` is its part of the
 * address.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const COLORS = 8;
  const MAX_TERMS = 8;
  const LISTED = 30;
  const MOVING = 12;
  const LISTS = [
    { id: 'trending', label: 'Trending', title: 'Up on the 12 weeks before, surely and often enough, and not falling again: the faster it rises, the higher' },
    { id: 'declining', label: 'Declining', title: 'Down on the 12 weeks before, surely, from often enough' },
    { id: 'peaked', label: 'Peaked', title: 'Had a peak well above what is usual for it, more than four weeks ago, and is far below it now' },
  ];
  const KINDS = [
    { id: 'topic', label: 'Topics' }, { id: 'area', label: 'Areas' }, { id: 'tech', label: 'Tech' },
  ];
  const UNIT = {
    channels: { label: 'Channels', what: 'channels talking about it', of: 'of the channels with any messages that week' },
    messages: { label: 'Messages', what: 'messages', of: 'of all messages that week' },
    threads: { label: 'Conversations', what: 'conversations started', of: 'of all conversations started that week' },
  };
  const DEFAULT_TERMS = 'area:cdn, area:auth';

  const st = {
    ctx: null,
    data: null,
    error: '',
    loading: false,
    building: false,
    matches: new Map(),
    q: {},
    list: null,
    hidden: new Set(),
  };

  // ---- the address ------------------------------------------------------------------------

  function fromUrl() {
    const p = new URLSearchParams(location.search);
    st.q = {
      terms: p.has('tq') ? p.get('tq') : null,
      src: p.get('tsrc') || '',
      team: p.get('tteam') || '',
      aud: p.get('taud') === 'customer' ? 'customer' : '',
      unit: Trends.UNITS.includes(p.get('tunit')) ? p.get('tunit') : 'channels',
      y: ['count', 'index'].includes(p.get('ty')) ? p.get('ty') : 'share',
      smooth: ['0', '2'].includes(p.get('tsm')) ? Number(p.get('tsm')) : 1,
      kind: KINDS.some((k) => k.id === p.get('tk')) ? p.get('tk') : 'topic',
      list: LISTS.some((l) => l.id === p.get('tl')) ? p.get('tl') : 'trending',
    };
  }

  function params() {
    // Asked for before it was shown (the page writes its address first): from the address.
    if (!st.q.unit) fromUrl();
    const { q } = st;
    const out = [];
    if (q.terms !== null && q.terms !== undefined) out.push(['tq', q.terms]);
    if (q.src) out.push(['tsrc', q.src]);
    if (q.team) out.push(['tteam', q.team]);
    if (q.aud) out.push(['taud', q.aud]);
    if (q.unit !== 'channels') out.push(['tunit', q.unit]);
    if (q.y !== 'share') out.push(['ty', q.y]);
    if (q.smooth !== 1) out.push(['tsm', String(q.smooth)]);
    if (q.kind !== 'topic') out.push(['tk', q.kind]);
    if (q.list !== 'trending') out.push(['tl', q.list]);
    return out;
  }

  // ---- the terms --------------------------------------------------------------------------

  const { I } = Trends;
  const esc = (s) => st.ctx.esc(s);
  const topicName = (id) => st.data?.map?.topics?.[id]?.label || `Topic ${Number(id) + 1}`;
  const indexOf = (list, v) => list.indexOf(v);

  /** A term as the page counts it: `{ term, label, test }`, `server` for words and phrases. */
  function termOf(raw) {
    const d = st.data;
    const t = raw.trim();
    const byName = (list, kind) => list.findIndex((x) => x.name.toLowerCase() === t.toLowerCase()
      || `${kind}:${x.id}` === t);
    const [, prefix, rest] = t.match(/^(topic|area|tech|kind|src|org|team):(.+)$/) || [];
    if (prefix === 'topic' || (!prefix && d.map && d.map.topics.some((x) => x.label.toLowerCase() === t.toLowerCase()))) {
      const id = prefix ? Number(rest) : d.map.topics.findIndex((x) => x.label.toLowerCase() === t.toLowerCase());
      return { term: `topic:${id}`, label: topicName(id), test: (r) => r[I.topic] === id };
    }
    const area = byName(d.areas, 'area');
    if (prefix === 'area' || (!prefix && area >= 0)) {
      const i = prefix ? d.areas.findIndex((x) => x.id === rest) : area;
      return { term: `area:${d.areas[i]?.id || rest}`, label: d.areas[i]?.name || rest, test: (r) => r[I.areas].includes(i) };
    }
    const tech = byName(d.tech, 'tech');
    if (prefix === 'tech' || (!prefix && tech >= 0)) {
      const i = prefix ? d.tech.findIndex((x) => x.id === rest) : tech;
      return { term: `tech:${d.tech[i]?.id || rest}`, label: d.tech[i]?.name || rest, test: (r) => r[I.tech].includes(i) };
    }
    const fields = {
      kind: [I.kind, d.kinds], src: [I.source, d.sources], team: [I.team, d.teams], org: [I.org, d.orgs.map((o) => o.slug)],
    };
    if (fields[prefix]) {
      const [col, list] = fields[prefix];
      const i = indexOf(list, rest);
      const name = prefix === 'org' ? d.orgs[i]?.name || rest : rest;
      return { term: t, label: `${prefix === 'src' ? 'on ' : ''}${name}`, test: (r) => r[col] === i };
    }
    const m = st.matches.get(t);
    return {
      term: t, label: t, server: true, test: (r) => Boolean(m && m.ids && m.ids.has(r[I.id])),
    };
  }

  /** A term as the field shows it: a topic, area or technology by its name, if it has no comma. */
  function shownTerm(raw) {
    const t = termOf(raw);
    return /^(topic|area|tech):/.test(t.term) && !t.label.includes(',') ? t.label : raw;
  }

  const termsOf = () => (st.q.terms ?? (st.data?.map ? topTopics() : DEFAULT_TERMS))
    .split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_TERMS);

  /** With no terms asked for: the three most trending topics. */
  function topTopics() {
    const m = movingOf('topic');
    const picked = [...m.trending, ...m.peaked].slice(0, 3).map((x) => x.key);
    return picked.length ? picked.join(', ') : DEFAULT_TERMS;
  }

  function keep() {
    const d = st.data;
    const src = st.q.src ? d.sources.indexOf(st.q.src) : -1;
    const team = st.q.team ? d.teams.indexOf(st.q.team) : -1;
    const customer = new Set(d.orgs.map((o, i) => (o.type === 'customer' ? i : -1)));
    return (r) => (src < 0 || r[I.source] === src) && (team < 0 || r[I.team] === team)
      && (st.q.aud !== 'customer' || customer.has(r[I.org]));
  }

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

  // ---- the series ---------------------------------------------------------------------------

  function seriesOf() {
    const k = keep();
    const totals = Trends.weekly(st.data, k, st.q.unit).counts;
    const { last, partial } = Trends.lastFull(st.data);
    const first = Trends.firstOf(totals);
    const series = termsOf().map((raw, i) => {
      const t = termOf(raw);
      const counts = Trends.weekly(st.data, (r) => k(r) && t.test(r), st.q.unit).counts;
      return {
        ...t, color: i % COLORS, counts, match: st.matches.get(t.term),
        total: counts.reduce((a, b) => a + b, 0),
      };
    });
    return {
      totals, series, first, last, partial,
    };
  }

  function values(s, { totals, partial }) {
    const n = s.counts.length;
    let v = st.q.y === 'count'
      // The week under way, as a whole week would be at its pace.
      ? s.counts.map((c, i) => (i === n - 1 ? c / Math.max(partial, 0.15) : c))
      : s.counts.map((c, i) => (totals[i] ? (100 * c) / totals[i] : 0));
    v = Trends.smooth(v, st.q.smooth);
    if (st.q.y === 'index') {
      const m = Math.max(...v) || 1;
      v = v.map((x) => (100 * x) / m);
    }
    return v;
  }

  const movingCache = new Map();
  function movingOf(kind) {
    const key = `${kind}|${st.q.src}|${st.q.team}|${st.q.aud}|${st.q.unit}`;
    if (!movingCache.has(key)) {
      const keysOf = {
        topic: (r) => (r[I.topic] >= 0 ? [`topic:${r[I.topic]}`] : []),
        area: (r) => r[I.areas].map((i) => `area:${st.data.areas[i].id}`),
        tech: (r) => r[I.tech].map((i) => `tech:${st.data.tech[i].id}`),
      }[kind];
      movingCache.set(key, Trends.moving(st.data, { keep: keep(), keysOf, unit: st.q.unit }));
    }
    return movingCache.get(key);
  }

  // ---- drawing ------------------------------------------------------------------------------

  function el(name, attrs = {}) {
    const e = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  const monthOf = (w) => new Date(`${w}T00:00:00Z`).toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  const fmt = (v) => {
    if (st.q.y === 'share') return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
    return String(Math.round(v));
  };

  function drawChart() {
    const all = seriesOf();
    const { series, first, totals } = all;
    const svg = $('tsvg');
    svg.textContent = '';
    const box = svg.getBoundingClientRect();
    const W = Math.max(320, box.width || 800);
    const H = Math.max(200, box.height || 320);
    const L = 44;
    const R = 12;
    const T = 10;
    const B = 24;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const weeks = st.data.weeks.slice(first);
    const n = weeks.length;
    const shown = series.filter((s) => !st.hidden.has(s.term));
    const vals = new Map(series.map((s) => [s.term, values(s, all).slice(first)]));
    const max = Math.max(1e-9, ...shown.flatMap((s) => vals.get(s.term))) * 1.08;
    const x = (i) => L + ((W - L - R) * i) / Math.max(1, n - 1);
    const y = (v) => T + (H - T - B) * (1 - v / max);
    for (let k = 0; k <= 4; k += 1) {
      const v = (max / 1.08) * (k / 4);
      svg.append(el('line', {
        class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v),
      }));
      const t = el('text', { class: 'axis', x: L - 6, y: y(v) + 4, 'text-anchor': 'end' });
      t.textContent = fmt(v);
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
      svg.append(el('polyline', { class: `line s${s.color}`, points: pts.slice(0, -1).join(' ') }));
      // The week under way: dashed, it is not over.
      svg.append(el('polyline', { class: `line s${s.color} partial`, points: pts.slice(-2).join(' ') }));
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
      const u = UNIT[st.q.unit];
      tip.innerHTML = `<b>Week of ${esc(weeks[i])}${i === n - 1 ? ' (so far)' : ''}</b>
        ${shown.map((s) => `<span class="row"><span class="swatch s${s.color}"></span>${esc(s.label)}: ${s.counts[first + i]} · ${totals[first + i] ? ((100 * s.counts[first + i]) / totals[first + i]).toFixed(1) : 0}%</span>`).join('')}
        <span class="sub">${totals[first + i]} ${esc(u.label.toLowerCase())} that week · click for its threads</span>`;
      tip.hidden = false;
      const card = $('tchart').getBoundingClientRect();
      tip.style.left = `${Math.min(ev.clientX - card.left + 14, card.width - tip.offsetWidth - 8)}px`;
      tip.style.top = `${ev.clientY - card.top + 14}px`;
    };
    hit.onpointerleave = () => {
      tip.hidden = true;
      cursor.setAttribute('visibility', 'hidden');
    };
    hit.onclick = (ev) => listThreads(shown.map((s) => s.term), first + at(ev));

    const u = UNIT[st.q.unit];
    $('twhat').textContent = st.q.y === 'index' ? `${u.label}, against each term's peak`
      : `${u.label === 'Channels' ? 'Channels talking about it' : u.label} per week`;
    $('tsub').textContent = st.q.y === 'share' ? `In % ${u.of}.` : st.q.y === 'count'
      ? `The number of ${u.what}; the week under way as a whole week would be at its pace.`
      : 'Each term against its own highest week, as 100.';
    $('tlegend').innerHTML = series.map((s) => {
      const m = s.match;
      const note = (m && m.pending && 'looking…') || (m && m.error) || (m && m.capped && 'some months have more than shown')
        || (m && m.semantic && 'by meaning') || '';
      return `<li${st.hidden.has(s.term) ? ' class="off"' : ''}><button class="term" data-term="${esc(s.term)}" title="Its threads; shift-click hides it">
        <span class="swatch s${s.color}"></span>${esc(s.label)} <span class="sub">${s.total}${note ? ` · ${esc(note)}` : ''}</span></button>
        <button class="x" data-drop="${esc(s.term)}" aria-label="Remove ${esc(s.label)}">×</button></li>`;
    }).join('');
  }

  function spark(points, first) {
    const m = Math.max(...points, 1e-9);
    const n = points.length;
    const pts = points.map((v, i) => `${((i * 60) / Math.max(1, n - 1)).toFixed(1)},${(17 - (15 * v) / m).toFixed(1)}`).join(' ');
    const split = n - Trends.RECENT;
    return `<svg class="spark" viewBox="0 0 60 18" aria-hidden="true"><line class="grid" x1="${((split * 60) / Math.max(1, n - 1)).toFixed(1)}" x2="${((split * 60) / Math.max(1, n - 1)).toFixed(1)}" y1="0" y2="18"></line><polyline points="${pts}" data-first="${first}"></polyline></svg>`;
  }

  function labelOfKey(key) {
    const [p, r] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (p === 'topic') return topicName(Number(r));
    if (p === 'area') return st.data.areas.find((a) => a.id === r)?.name || r;
    return st.data.tech.find((a) => a.id === r)?.name || r;
  }

  function drawMoving() {
    const d = st.data;
    const kind = st.q.kind === 'topic' && !d.map ? 'area' : st.q.kind;
    const m = movingOf(kind);
    const items = m[st.q.list].slice(0, MOVING);
    const per = st.q.unit === 'channels' ? 'channels a week' : `${UNIT[st.q.unit].what} a week`;
    const row = (it) => {
      const s = it.stats;
      const lift = Math.round((s.lift - 1) * 100);
      let what;
      if (st.q.list === 'peaked') {
        what = `Peaked in the week of ${d.weeks[s.peak.week]}; now ${Math.round((100 * s.now) / (s.peak.share || 1))}% of that`;
      } else {
        const pace = s.accel > 0.05 ? ', speeding up' : s.accel < -0.05 ? ', slowing' : '';
        what = `${s.perWeek.toFixed(1)} ${per}, ${lift >= 0 ? '+' : ''}${lift}% on before${pace}`;
      }
      return `<li><button class="mv" data-add="${esc(it.key)}" title="Compare it on the chart">
        <span class="nm">${esc(labelOfKey(it.key))}</span>
        <span class="sub">${esc(what)} · ${it.orgs} customer${it.orgs === 1 ? '' : 's'}${it.top > Trends.MOSTLY_ONE ? ' · <span class="one">mostly one</span>' : ''}</span>
        ${spark(it.spark, it.first)}</button></li>`;
    };
    const map = d.map;
    const assigned = map && d.threads.filter((r) => r[I.topic] >= 0).length;
    $('tmoving').innerHTML = `<h2>What is moving</h2>
      <p class="hint">The last ${Trends.RECENT} full weeks, to ${esc(d.weeks[m.last])}, against the ${Trends.BASE} before: how often it comes up, how much more or less than before, and whether that is speeding up.</p>
      <div class="seg" role="group" aria-label="List">${LISTS.map((l) => `<button data-list="${l.id}" aria-pressed="${st.q.list === l.id}" title="${esc(l.title)}">${l.label}</button>`).join('')}</div>
      <div class="seg" role="group" aria-label="Of">${KINDS.map((k) => `<button data-kind="${k.id}" aria-pressed="${kind === k.id}"${k.id === 'topic' && !map ? ' disabled title="No trend map yet"' : ''}>${k.label}</button>`).join('')}</div>
      <ol class="moving">${items.map(row).join('') || `<li class="sub">Nothing ${esc(st.q.list)} now.</li>`}</ol>
      ${kind === 'topic' && map ? `<h3>Topics <span class="sub">${map.topics.length}</span></h3>
        <ul class="tlist">${map.topics.map((t) => `<li><button class="link" data-add="topic:${t.id}" title="${esc(t.theme)}">${esc(t.label)}</button></li>`).join('')}</ul>` : ''}
      <p class="hint">${map ? `Topics found ${esc(st.ctx.ago(map.built_at))} by ${esc(map.built_by === 'cron' ? 'the cron' : map.built_by)}, from ${map.threads} threads of every month${assigned < d.threads.length ? `; ${assigned} of ${d.threads.length} threads have one yet` : ''}.`
    : (d.available ? 'No trend map yet: the cron finds the topics once every four weeks, or Build does now.' : 'Topics need the CONTENT index and Workers AI, which this inbox does not have.')}
      ${st.ctx.may.rebuild && d.available ? ` <button id="tbuild"${st.building ? ' disabled' : ''}>${st.building ? 'Finding topics…' : (map ? 'Find the topics again' : 'Build')}</button>` : ''}</p>`;
  }

  async function listThreads(terms, week) {
    const box = $('tthreads');
    const k = keep();
    const tests = terms.map((t) => termOf(t));
    const inWeek = (r) => {
      if (week < 0) return 1;
      if (st.q.unit === 'threads') return r[I.week] === week ? 1 : 0;
      const w = r[I.weeks];
      for (let i = 0; i < w.length; i += 2) if (w[i] === week) return w[i + 1];
      return 0;
    };
    const lists = tests.map((t) => st.data.threads.filter((r) => k(r) && t.test(r) && inWeek(r))
      .sort((a, b) => inWeek(b) - inWeek(a) || b[I.week] - a[I.week]));
    box.innerHTML = '<div class="sub">Loading…</div>';
    const ids = [...new Set(lists.flatMap((l) => l.slice(0, LISTED).map((r) => r[I.id])))];
    let found = [];
    try {
      const res = await fetch(`/api/topics/trends/threads?ids=${ids.join(',')}`, { credentials: 'same-origin', redirect: 'manual' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
      found = body.threads;
    } catch (e) {
      box.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
      return;
    }
    const byId = new Map(found.map((t) => [t.id, t]));
    const orgName = (slug) => st.data.orgs.find((o) => o.slug === slug)?.name || slug;
    const link = (x) => `/inbox?team=${encodeURIComponent(x.team)}&t=${encodeURIComponent(x.key)}`;
    const colorOf = (term) => Math.max(0, termsOf().map((x) => termOf(x).term).indexOf(term)) % COLORS;
    box.innerHTML = `<h2>${week < 0 ? 'Threads' : `Threads of the week of ${esc(st.data.weeks[week])}`}</h2>
      ${tests.map((t, i) => `<h3><span class="swatch s${colorOf(t.term)}"></span>${esc(t.label)} <span class="sub">${lists[i].length}</span></h3>
        <ol class="threads">${lists[i].slice(0, LISTED).map((r) => byId.get(r[I.id])).filter(Boolean).map((x) => `<li><a href="${esc(link(x))}" target="_blank" rel="noopener">${esc(x.title || '(no title)')}</a>
          <div class="sub">${esc(orgName(x.org))} · ${esc(x.team)} · ${esc(x.source)} · ${esc(String(x.at).slice(0, 10))} · ${x.messages} message${x.messages === 1 ? '' : 's'}</div></li>`).join('') || '<li class="sub">None</li>'}</ol>`).join('')}`;
  }

  function drawBar() {
    const d = st.data;
    const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
    const teamName = (slug) => st.ctx.me.teams?.find((t) => t.slug === slug)?.name || slug;
    $('tsrc').innerHTML = opt('', 'All platforms', !st.q.src) + d.sources.map((s) => opt(s, s, s === st.q.src)).join('');
    $('tteam').innerHTML = opt('', 'All teams', !st.q.team) + [...d.teams].sort().map((t) => opt(t, teamName(t), t === st.q.team)).join('');
    $('taud').innerHTML = opt('', 'Customers, partners and vendors', !st.q.aud) + opt('customer', 'Customers', st.q.aud === 'customer');
    $('tunit').innerHTML = Object.entries(UNIT).map(([id, u]) => opt(id, u.label, id === st.q.unit)).join('');
    $('ty').innerHTML = opt('share', 'Share', st.q.y === 'share') + opt('count', 'Number', st.q.y === 'count') + opt('index', 'Index', st.q.y === 'index');
    $('tsm').innerHTML = opt('0', 'None', st.q.smooth === 0) + opt('1', '3 weeks', st.q.smooth === 1) + opt('2', '5 weeks', st.q.smooth === 2);
    $('tq').value = termsOf().map(shownTerm).join(', ');
    $('tnames').innerHTML = [
      ...(d.map ? d.map.topics.map((t) => t.label) : []), ...d.areas.map((a) => a.name), ...d.tech.map((t) => t.name),
    ].map((n) => `<option value="${esc(n)}"></option>`).join('');
  }

  async function draw() {
    const pending = termsOf().map(termOf).filter((t) => t.server && !st.matches.has(t.term));
    drawChart();
    drawMoving();
    if (pending.length) {
      await Promise.all(pending.map((t) => ask(t.term)));
      if (st.data) drawChart();
    }
  }

  function skeleton(body) {
    body.innerHTML = `<div class="trends">
      <div class="tqrow"><label class="s2-search"><input class="search" id="tq" type="search" list="tnames" autocomplete="off" aria-label="Compare, separated by commas: a topic, an area or a technology, words, or ~a phrase"></label><datalist id="tnames"></datalist>
        <button class="primary" id="tgo">Compare</button></div>
      <div class="bar tbar">
        <div class="group"><label class="lbl" for="tsrc">Platform</label><select id="tsrc"></select></div>
        <div class="group"><label class="lbl" for="tteam">Team</label><select id="tteam"></select></div>
        <div class="group"><label class="lbl" for="taud">Who</label><select id="taud"></select></div>
        <div class="group"><label class="lbl" for="tunit" title="Channels: of the channels with messages in a week, those where a matching thread had one. Messages: every message of a matching thread. Conversations: each once, in the week it started">Count</label><select id="tunit"></select></div>
        <div class="group"><label class="lbl" for="ty">As</label><select id="ty"></select></div>
        <div class="group"><label class="lbl" for="tsm">Smoothing</label><select id="tsm"></select></div>
      </div>
      <div class="split">
        <div class="col">
          <section class="card tchart" id="tchart"><h2 id="twhat"></h2><p class="hint" id="tsub"></p>
            <svg id="tsvg" role="img" aria-label="The terms, week by week"></svg><ul class="legend tlegend" id="tlegend"></ul>
            <div class="tip" id="ttip" hidden></div></section>
          <section class="card" id="tthreads"><h2>Threads</h2><p class="hint">A click on a week lists its threads; on a term, all of its own.</p></section>
        </div>
        <aside class="card panel" id="tmoving"></aside>
      </div></div>`;
  }

  function change(fn, { reask = false } = {}) {
    fn(st.q);
    if (reask) movingCache.clear();
    st.ctx.toUrl();
    drawBar();
    draw();
  }

  function setTerms(list) {
    change((q) => { q.terms = list.slice(0, MAX_TERMS).join(', '); });
  }

  function wire() {
    const compare = () => setTerms($('tq').value.split(',').map((s) => s.trim()).filter(Boolean)
      .map((raw) => (/^(topic|area|tech):/.test(termOf(raw).term) ? termOf(raw).term : raw)));
    $('tgo').onclick = compare;
    $('tq').onkeydown = (ev) => { if (ev.key === 'Enter') compare(); };
    for (const [id, key] of [['tsrc', 'src'], ['tteam', 'team'], ['taud', 'aud'], ['tunit', 'unit']]) {
      $(id).onchange = (ev) => change((q) => { q[key] = ev.target.value; }, { reask: true });
    }
    $('ty').onchange = (ev) => change((q) => { q.y = ev.target.value; });
    $('tsm').onchange = (ev) => change((q) => { q.smooth = Number(ev.target.value); });
    $('tlegend').onclick = (ev) => {
      const drop = ev.target.closest('[data-drop]');
      if (drop) {
        setTerms(termsOf().filter((t) => termOf(t).term !== drop.dataset.drop));
        return;
      }
      const b = ev.target.closest('[data-term]');
      if (!b) return;
      if (ev.shiftKey) {
        const t = b.dataset.term;
        if (st.hidden.has(t)) st.hidden.delete(t); else st.hidden.add(t);
        drawChart();
      } else {
        listThreads([b.dataset.term], -1);
      }
    };
    $('tmoving').onclick = (ev) => {
      const add = ev.target.closest('[data-add]');
      if (add) {
        const now = termsOf().map((t) => termOf(t).term);
        if (!now.includes(add.dataset.add)) setTerms([...now, add.dataset.add].slice(-MAX_TERMS));
      }
      const list = ev.target.closest('[data-list]');
      if (list) change((q) => { q.list = list.dataset.list; });
      const kind = ev.target.closest('[data-kind]');
      if (kind) change((q) => { q.kind = kind.dataset.kind; });
      if (ev.target.closest('#tbuild')) build();
    };
  }

  async function load({ fresh = false } = {}) {
    st.loading = true;
    try {
      const res = await fetch(`/api/topics/trends${fresh ? '?fresh=1' : ''}`, { credentials: 'same-origin', redirect: 'manual' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
      st.data = body;
      st.error = '';
      movingCache.clear();
    } catch (e) {
      st.error = e.message;
    }
    st.loading = false;
  }

  async function build() {
    st.building = true;
    drawMoving();
    try {
      const res = await fetch('/api/topics/trends', { method: 'POST', credentials: 'same-origin', redirect: 'manual' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
      await load({ fresh: true });
    } catch (e) {
      st.error = `Could not find the topics: ${e.message}`;
    }
    st.building = false;
    if (st.data) {
      drawBar();
      draw();
    }
    if (st.error) $('tmoving').insertAdjacentHTML('beforeend', `<p class="hint err">${esc(st.error)}</p>`);
  }

  let resizing = 0;
  window.addEventListener('resize', () => {
    if (!$('tsvg') || !st.data) return;
    cancelAnimationFrame(resizing);
    resizing = requestAnimationFrame(drawChart);
  });

  async function show(body, ctx) {
    st.ctx = ctx;
    fromUrl();
    if (!$('tchart')) {
      skeleton(body);
      wire();
    }
    if (!st.data && !st.loading) {
      $('tmoving').innerHTML = '<div class="empty">Loading…</div>';
      await load();
    }
    if (!st.data) {
      body.innerHTML = `<div class="empty err">${esc(st.error)}</div>`;
      return;
    }
    drawBar();
    draw();
  }

  globalThis.TrendView = { show, params, fromUrl };
})();
