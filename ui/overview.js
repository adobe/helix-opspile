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
 * What a team's overview (ui/team.js) and a customer's (ui/customer.js) are drawn with, as the
 * global `Overview`: the first section of their pages in Teams and Customers, everyone's at Adobe,
 * in the look of ui/spectrum-overview.css.
 *
 * - `face`, `spark` and `bar`: a person's picture over their initials, a line of weeks, a meter.
 * - `stats` and `chart`: the big numbers at the top, and the weeks as an area chart of what
 *   Adobe's people said under what the others did (a team's); a week under the pointer says its
 *   numbers. `bars` and `wireBars`: the weeks as stacked bars of any breakdown (a customer's).
 * - `ranked`: a ranking, each row with its rank, a face or an icon, a meter and a line.
 * - `tabs` and `layers`: tabs over a list, and a list of technologies by the layer of a stack.
 * - `knowledge`: a knowledge base's entries by type, a tile each.
 * - `wire`: what the chart and the tabs do.
 *
 * Everything in them is a name, a number or a picture, written escaped.
 */
globalThis.Overview = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const COLORS = 8;
  /** A name's hue, as ui/inbox.js and ui/header.js have it (`data-hue`, ui/spectrum.css). */
  const hueOf = (name) => {
    let h = 0;
    for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h % COLORS;
  };
  const initials = (name) => String(name || '?').replace(/\(.*?\)/g, '').split(/[\s,]+/).filter(Boolean)
    .map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  /** A person's face: their picture over their initials, which show while it loads or when it fails. */
  const face = (name, url, cls = '') => `<span class="av tv-av ${cls}" data-hue="${hueOf(name || '?')}" aria-hidden="true">${esc(initials(name))}${url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>`;
  const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
  const monthOf = (w) => new Date(`${w}T00:00:00Z`).toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  const dayOf = (w) => new Date(`${w}T00:00:00Z`).toLocaleString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const ago = (at) => {
    if (!at) return '';
    const d = (Date.now() - Date.parse(at)) / 86400000;
    if (d < 1) return 'today';
    if (d < 2) return 'yesterday';
    if (d < 14) return `${Math.round(d)} days ago`;
    if (d < 60) return `${Math.round(d / 7)} weeks ago`;
    return `${Math.round(d / 30)} months ago`;
  };
  /** How often, in words: "12 a week", "3 a month", "now and then". */
  const often = (n, weeks) => {
    const w = n / weeks;
    if (w >= 1) return `${w < 10 ? w.toFixed(1).replace(/\.0$/, '') : Math.round(w)} a week`;
    if (w * 4.3 >= 1) return `${Math.round(w * 4.3)} a month`;
    return n ? 'now and then' : 'not lately';
  };
  /** A wait in minutes, in words: "12 min", "3.5 h", "2 days". */
  const wait = (min) => {
    if (min === null || min === undefined) return '–';
    if (min < 60) return `${Math.max(1, Math.round(min))} min`;
    const h = min / 60;
    if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
    return `${Math.round(h / 24)} days`;
  };

  /** `inner` as a link to `href`, or as it is where there is none to go to. */
  const link = (href, inner, { cls = '', title = '' } = {}) => {
    const attrs = `${cls ? ` class="${cls}"` : ''}${title ? ` title="${esc(title)}"` : ''}`;
    return href ? `<a href="${esc(href)}"${attrs}>${inner}</a>` : `<span${attrs}>${inner}</span>`;
  };

  // ---- small drawings -----------------------------------------------------------------------

  /** A line of `values` (one a week), its area under it; `cls` colors it. */
  function spark(values, { cls = '', w = 96, h = 24, label = '' } = {}) {
    const m = Math.max(...values, 1);
    const n = values.length;
    const x = (i) => ((i * w) / Math.max(1, n - 1)).toFixed(1);
    const y = (v) => (h - 1 - ((h - 3) * v) / m).toFixed(1);
    const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    return `<svg class="tv-spark${cls ? ` ${cls}` : ''}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"${label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"'}>`
      + `<polygon class="area" points="0,${h} ${pts} ${w},${h}"></polygon><polyline points="${pts}"></polyline></svg>`;
  }
  /** A bar of `share` (0 to 1) of its track, `of` the second part of it (Adobe's, say). */
  function bar(share, of = null) {
    const w = Math.max(1, Math.round(100 * share));
    const part = of === null ? '' : `<rect class="part" width="${Math.round(w * of)}" height="6" rx="3"></rect>`;
    return `<svg class="tv-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="6" rx="3"></rect><rect class="fill" width="${w}" height="6" rx="3"></rect>${part}</svg>`;
  }

  /**
   * The chart of the weeks (`p.weeks`, `p.activity`): what the others said over what Adobe's
   * people said, the months under it, the most in a week beside it. `label` says what it is,
   * `others` names the others in its legend.
   */
  function chart(p, { label, others = 'Customers and partners' }) {
    const W = 600;
    const H = 140;
    const { messages, staff } = p.activity;
    const n = messages.length;
    const m = Math.max(...messages, 1);
    const x = (i) => ((i * W) / Math.max(1, n - 1)).toFixed(1);
    const y = (v) => (H - (H - 6) * (v / m)).toFixed(1);
    const line = (vals) => vals.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    // The band between two lines: along the top one, and back along the bottom one.
    const area = (top, bottom) => `${line(top)} ${bottom.map((v, i) => `${x(i)},${y(v)}`).reverse().join(' ')}`;
    const zero = messages.map(() => 0);
    // The others' on top of Adobe's: the whole is everything said.
    const months = p.weeks.map((w, i) => [w, i]).filter(([w], i) => i === 0 || w.slice(5, 7) !== p.weeks[i - 1].slice(5, 7));
    const grid = [0.5, 1].map((f) => `<line class="grid" x1="0" x2="${W}" y1="${y(m * f)}" y2="${y(m * f)}"></line>`).join('');
    return `<div class="tv-chart" data-chart data-others="${esc(others)}">
      <div class="tv-axis"><span>${m.toLocaleString('en')}</span><span>${Math.round(m / 2).toLocaleString('en')}</span><span>0</span></div>
      <div class="tv-plot">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`${label}, week by week, the last ${n} weeks`)}">
          ${grid}
          <polygon class="all" points="${area(messages, staff)}"></polygon>
          <polygon class="staff" points="${area(staff, zero)}"></polygon>
          <polyline class="all" points="${line(messages)}"></polyline>
          <polyline class="staff" points="${line(staff)}"></polyline>
          <line class="guide" x1="0" x2="0" y1="0" y2="${H}" hidden></line>
        </svg>
        <div class="tv-months">${months.map(([w, i]) => `<span data-at="${(i / Math.max(1, n - 1)).toFixed(3)}">${esc(monthOf(w))}</span>`).join('')}</div>
        <div class="tv-tip" hidden></div>
      </div>
      <div class="tv-legend"><span class="staff">Adobe</span><span class="all">${esc(others)}</span></div>
    </div>`;
  }

  /**
   * A stacked bar chart of the weeks: `parts` (`[{ id, name, weekly, n }]`, biggest first, the
   * rest last with id null) a bar each week, one on the other, the first at the bottom; the most
   * in a week beside it, the months under it, and a legend of the parts with their totals. `key`
   * names a part's color (`data-series`), `unit` what a bar counts. A week under the pointer says
   * its numbers (`wireBars`).
   */
  function bars(weeks, parts, { label, unit = 'message', key = (x, i) => `s${i}` }) {
    const W = 600;
    const H = 140;
    const n = weeks.length;
    const totals = weeks.map((w, i) => parts.reduce((s, x) => s + x.weekly[i], 0));
    const m = Math.max(...totals, 1);
    const slot = W / Math.max(1, n);
    const gap = Math.min(4, slot * 0.25);
    const y = (v) => (H * v) / m;
    const series = parts.map((x, i) => (x.id === null ? 'other' : key(x, i)));
    const cols = weeks.map((w, i) => {
      let at = H;
      const segs = parts.map((x, j) => {
        const h = y(x.weekly[i]);
        if (!h) return '';
        at -= h;
        return `<rect class="seg" data-series="${esc(series[j])}" data-part="${j}" x="${(i * slot + gap / 2).toFixed(1)}" y="${at.toFixed(1)}" width="${(slot - gap).toFixed(1)}" height="${h.toFixed(1)}"></rect>`;
      }).join('');
      return `<g class="col" data-week="${i}">${segs}</g>`;
    }).join('');
    const months = weeks.map((w, i) => [w, i]).filter(([w], i) => i === 0 || w.slice(5, 7) !== weeks[i - 1].slice(5, 7));
    const grid = [0.5, 1].map((f) => `<line class="grid" x1="0" x2="${W}" y1="${(H - y(m * f)).toFixed(1)}" y2="${(H - y(m * f)).toFixed(1)}"></line>`).join('');
    const all = parts.reduce((s, x) => s + x.n, 0);
    const legend = parts.map((x, j) => `<li data-part="${j}" tabindex="0" title="${esc(`${x.name}: ${plural(x.n, unit)}${all ? `, ${Math.round((100 * x.n) / all)}%` : ''}`)}"><span class="dot" data-series="${esc(series[j])}"></span><span class="nm">${esc(x.name)}</span><span class="sub">${esc(x.n.toLocaleString('en'))}</span></li>`).join('');
    return `<div class="tv-chart tv-bars" data-bars data-unit="${esc(unit)}">
      <div class="tv-axis"><span>${m.toLocaleString('en')}</span><span>${Math.round(m / 2).toLocaleString('en')}</span><span>0</span></div>
      <div class="tv-plot">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`${label}, week by week, the last ${n} weeks`)}">${grid}${cols}</svg>
        <div class="tv-months">${months.map(([w, i]) => `<span data-at="${((i + 0.5) / Math.max(1, n)).toFixed(3)}">${esc(monthOf(w))}</span>`).join('')}</div>
        <div class="tv-tip" hidden></div>
      </div>
      <ul class="tv-parts">${legend || '<li class="sub">Nothing said in these weeks.</li>'}</ul>
    </div>`;
  }

  /**
   * What a bar chart (`bars`) in `el` does: the week under the pointer says its parts' numbers,
   * and a part under the pointer in the chart or its legend lights its bars.
   */
  function wireBars(el, weeks, parts) {
    const box = el.querySelector('[data-bars]');
    if (!box) return;
    const plot = box.querySelector('.tv-plot');
    const svg = plot.querySelector('svg');
    const tip = plot.querySelector('.tv-tip');
    const { unit } = box.dataset;
    const n = weeks.length;
    const seriesOf = (j) => box.querySelector(`.tv-parts [data-part="${j}"] .dot`)?.dataset.series || 'other';
    const light = (part) => {
      box.classList.toggle('lit', part !== null);
      for (const r of box.querySelectorAll('[data-part]')) r.classList.toggle('on', part !== null && r.dataset.part === String(part));
    };
    const week = (i, part) => {
      for (const g of svg.querySelectorAll('.col')) g.classList.toggle('on', g.dataset.week === String(i));
      const total = parts.reduce((s, x) => s + x.weekly[i], 0);
      const rows = parts.map((x, j) => [x, j]).filter(([x]) => x.weekly[i]).reverse();
      tip.innerHTML = `<b>Week of ${esc(dayOf(weeks[i]))} \u00b7 ${esc(plural(total, unit))}</b>${rows.map(([x, j]) => `<span class="tv-tr${String(j) === String(part) ? ' on' : ''}"><span class="dot" data-series="${esc(seriesOf(j))}"></span><span>${esc(x.name)}</span><span>${esc(x.weekly[i].toLocaleString('en'))}</span></span>`).join('')}`;
      tip.hidden = false;
      const f = (i + 0.5) / n;
      tip.classList.toggle('left', f > 0.6);
      tip.style.setProperty('--at', f.toFixed(3));
    };
    plot.addEventListener('pointermove', (e) => {
      const r = plot.getBoundingClientRect();
      const i = Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n)));
      const seg = e.target.closest && e.target.closest('.seg');
      const part = seg ? seg.dataset.part : null;
      light(part);
      week(i, part);
    });
    plot.addEventListener('pointerleave', () => {
      tip.hidden = true;
      light(null);
      for (const g of svg.querySelectorAll('.col.on')) g.classList.remove('on');
    });
    for (const li of box.querySelectorAll('.tv-parts [data-part]')) {
      li.onpointerenter = () => light(li.dataset.part);
      li.onfocus = li.onpointerenter;
      li.onpointerleave = () => light(null);
      li.onblur = li.onpointerleave;
    }
    for (const s of box.querySelectorAll('.tv-months [data-at]')) s.style.setProperty('--at', s.dataset.at);
  }

  /** The big numbers: `tiles` of `[n, what, sub]` (n a number, or words). */
  function stats(tiles) {
    const tile = ([n, what, sub, title]) => `<div class="tv-stat"${title ? ` title="${esc(title)}"` : ''}><b>${typeof n === 'number' ? n.toLocaleString('en') : esc(n)}</b><span>${esc(what)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
    return `<div class="tv-stats">${tiles.map(tile).join('')}</div>`;
  }

  /**
   * A chip of a tag: what it is, how many threads of theirs it was in; a link to it on the Topics
   * page (`href`, its node's), where there is one.
   */
  const chip = (name, threads, { cls = '', href = null } = {}) => link(href, esc(name), {
    cls: `tv-chip${cls ? ` ${cls}` : ''}`,
    title: `${name}: ${plural(threads, 'thread')} of theirs${href ? '. Open it on the Topics page' : ''}`,
  });
  /** The teams of a person, a chip each that opens its overview. */
  const teamChips = (teams, href) => (teams.length
    ? teams.map((t) => `<a class="tv-chip team" href="${esc(href(t.slug))}">${esc(t.name)}</a>`).join('')
    : '<span class="sub">on no team</span>');

  /**
   * A ranked list: `rows` of `{ n, of, lead, name, sub, weekly, tail, count }`, `count` the words
   * under the meter ("12 messages" without it), `of` the second part of its bar.
   */
  function ranked(rows, weeks) {
    const most = Math.max(...rows.map((r) => r.n), 1);
    return `<ol class="tv-rank">${rows.map((r, i) => `<li>
      <span class="tv-i">${i + 1}</span>${r.lead || '<span class="tv-lead"></span>'}
      <span class="tv-name">${r.name}${r.sub ? `<span class="sub">${r.sub}</span>` : ''}</span>
      <span class="tv-meter">${bar(r.n / most, r.of ?? null)}<span class="sub">${esc(r.count || plural(r.n, 'message'))}</span></span>
      ${spark(r.weekly, { label: `week by week, the last ${weeks} weeks` })}
      <span class="tv-tail">${r.tail || ''}</span></li>`).join('')}</ol>`;
  }

  /** Tabs (quiet buttons) over a list: `[{ id, label, hint, n }]` (`n` optional), `on` the picked one. */
  function tabs(list, on, { label, attr = 'data-tab' } = {}) {
    return `<div class="tv-tabs" role="tablist" aria-label="${esc(label)}">${list.map((t) => `<button type="button" role="tab" ${attr}="${t.id}" aria-selected="${t.id === on}"${t.hint ? ` title="${esc(t.hint)}"` : ''}>${esc(t.label)}${t.n === undefined ? '' : ` <span class="sub">${t.n}</span>`}</button>`).join('')}</div>`;
  }

  /**
   * Technologies by the layer of a stack they are in: `shown` (each with its `layer`), `layers`
   * (`[{ id, name }]`, src/stack.js), `row(t)` a technology's `<li>`. The others last.
   */
  function layers(shown, all, row) {
    if (!shown.length) return '<div class="empty">None.</div>';
    const list = (all || []).map((l) => ({ ...l, tech: shown.filter((t) => (t.layer || 'other') === l.id) }))
      .filter((l) => l.tech.length);
    const known = new Set((all || []).map((l) => l.id));
    const loose = shown.filter((t) => !known.has(t.layer || 'other'));
    if (loose.length) list.push({ id: 'other', name: 'Other', tech: loose });
    return list.map((l) => `<div class="tv-layer" data-layer="${esc(l.id)}"><h3>${esc(l.name)}</h3><ul>${l.tech.map(row).join('')}</ul></div>`).join('');
  }

  /**
   * A knowledge base's entries by type (`kb`: `{ types: [{ type, n, entries }], readable }`, null
   * for none), a tile each; its stack drawing goes into `#tvStack` under them. `name` is whose it
   * is, `kbHref(path)` an entry's link (null where the viewer may not open it).
   */
  function knowledge(kb, { name, kbHref, readers = 'The members of the ops teams read the entries themselves.' }) {
    if (!kb) return `<section class="tv-sec" aria-labelledby="tvKb"><h2 id="tvKb">Knowledge base</h2><div class="empty">${esc(name)} has no knowledge base yet: its thread agents start one.</div></section>`;
    const total = kb.types.reduce((s, t) => s + t.n, 0);
    const tiles = kb.types.map((t) => `<div class="tv-kbtype"><h3><b>${t.n.toLocaleString('en')}</b> ${esc(`${t.type.toLowerCase()}${t.n === 1 ? '' : 's'}`)}</h3>
      ${t.entries.length ? `<ul>${t.entries.map((e) => `<li>${kbHref(e.path) ? `<a href="${esc(kbHref(e.path))}"${e.description ? ` title="${esc(e.description)}"` : ''}>${esc(e.title)}</a>` : esc(e.title)}</li>`).join('')}${t.n > t.entries.length ? `<li class="sub">and ${t.n - t.entries.length} more</li>` : ''}</ul>` : ''}</div>`).join('');
    return `<section class="tv-sec" aria-labelledby="tvKb"><h2 id="tvKb">Knowledge base <span class="sub">${esc(plural(total, 'entry', 'entries'))}</span></h2>
      ${tiles ? `<div class="tv-kb">${tiles}</div>` : '<div class="empty">Nothing in it yet but its catalog: its thread agents add what they learn.</div>'}
      <div id="tvStack"></div>
      ${kb.readable ? '' : `<p class="hint">${esc(readers)}</p>`}</section>`;
  }

  /**
   * What an overview does in `el`: the chart's weeks under the pointer (`p.weeks`, `p.activity`),
   * and its tabs: `onTab(button)` for a click on one (`[data-tab]`), after it is picked.
   */
  function wire(el, p, { onTab = null } = {}) {
    const plot = el.querySelector('[data-chart] .tv-plot');
    if (plot) {
      const tip = plot.querySelector('.tv-tip');
      const guide = plot.querySelector('.guide');
      const others = plot.closest('[data-chart]').dataset.others.toLowerCase();
      const n = p.weeks.length;
      const show = (e) => {
        const r = plot.getBoundingClientRect();
        const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        const i = Math.round(f * (n - 1));
        const at = (600 * i) / Math.max(1, n - 1);
        guide.setAttribute('x1', at);
        guide.setAttribute('x2', at);
        guide.hidden = false;
        const all = p.activity.messages[i];
        const staff = p.activity.staff[i];
        tip.innerHTML = `<b>Week of ${esc(dayOf(p.weeks[i]))}</b><span>${esc(plural(all, 'message'))} in ${esc(plural(p.activity.threads[i], 'thread'))}</span><span>${esc(`${staff.toLocaleString('en')} by Adobe, ${(all - staff).toLocaleString('en')} by ${others}`)}</span>`;
        tip.hidden = false;
        tip.classList.toggle('left', f > 0.6);
        tip.style.setProperty('--at', f.toFixed(3));
      };
      plot.addEventListener('pointermove', show);
      plot.addEventListener('pointerleave', () => { tip.hidden = true; guide.hidden = true; });
    }
    for (const b of el.querySelectorAll('[data-tab]')) {
      b.onclick = () => {
        for (const x of b.parentElement.querySelectorAll('[data-tab]')) x.setAttribute('aria-selected', String(x === b));
        if (onTab) onTab(b);
      };
    }
    // The months, where their weeks are.
    for (const m of el.querySelectorAll('.tv-months [data-at]')) m.style.setProperty('--at', m.dataset.at);
  }

  return {
    esc, face, plural, ago, often, wait, link, spark, bar, chart, bars, wireBars, stats, chip, teamChips, ranked, tabs,
    layers, knowledge, wire,
  };
})();
