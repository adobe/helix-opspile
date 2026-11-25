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
 * - `face`, `spark` and `chip` (ui/person.js's, as the people cards have them) and `bar`: a
 *   person's picture over their initials, a line of weeks, a tag, a meter.
 * - `stats` and `chart`: the big numbers at the top, and the weeks as an area chart of what
 *   Adobe's people said under what the others did (a team's); a week under the pointer says its
 *   numbers. `bars` and `wireBars`: the weeks as stacked bars of any breakdown (a customer's).
 * - `ranked`: a ranking, each row with its rank, a face or an icon, a meter and a line in the
 *   color of its face (`tint`) or icon (`tintIcons`, in `wire`).
 * - `tabs` and `layers`: tabs over a list, and a list of technologies by the layer of a stack.
 * - `knowledge`: a knowledge base's entries by type, a tile each.
 * - `threads` and `waitTag`: a list of threads (a vendor's cases, what waits on a vendor), each
 *   with who has the next move.
 * - `wire`: what the chart and the tabs do, and the icons' colors.
 *
 * Everything in them is a name, a number or a picture, written escaped.
 */
globalThis.Overview = (() => {
  // A person's parts, as the people cards draw them (ui/person.js): one face, line and tag.
  const {
    esc, plural, ago, often, link, spark, chip,
  } = Person;
  const face = (name, url, cls = '') => Person.face(name, url, { cls });
  const monthOf = (w) => new Date(`${w}T00:00:00Z`).toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  const dayOf = (w) => new Date(`${w}T00:00:00Z`).toLocaleString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  /** A wait in minutes, in words: "12 min", "3.5 h", "2 days". */
  const wait = (min) => {
    if (min === null || min === undefined) return '–';
    if (min < 60) return `${Math.max(1, Math.round(min))} min`;
    const h = min / 60;
    if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
    return `${Math.round(h / 24)} days`;
  };

  // ---- small drawings -----------------------------------------------------------------------

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

  /** The teams of a person, a chip each that opens its overview. */
  const teamChips = (teams, href) => (teams.length
    ? teams.map((t) => `<a class="ps-chip team" href="${esc(href(t.slug))}">${esc(t.name)}</a>`).join('')
    : '<span class="sub">on no team</span>');

  /**
   * A ranked list: `rows` of `{ n, of, lead, name, sub, weekly, tail, count, tint }`, `count` the
   * words under the meter ("12 messages" without it), `of` the second part of its bar, `tint` the
   * color of its line (a person's, `Person.tintOf`); a row without `weekly` has no line. A row led
   * by an org's icon (`img.ico`) gets its color from the icon (`tintIcons`).
   */
  function ranked(rows, weeks) {
    const most = Math.max(...rows.map((r) => r.n), 1);
    return `<ol class="tv-rank">${rows.map((r, i) => `<li>
      <span class="tv-i">${i + 1}</span>${r.lead || '<span class="tv-lead"></span>'}
      <span class="tv-name">${r.name}${r.sub ? `<span class="sub">${r.sub}</span>` : ''}</span>
      <span class="tv-meter">${bar(r.n / most, r.of ?? null)}<span class="sub">${esc(r.count || plural(r.n, 'message'))}</span></span>
      ${r.weekly ? spark(r.weekly, { label: `week by week, the last ${weeks} weeks`, tint: r.tint || '' }) : ''}
      <span class="tv-tail">${r.tail || ''}</span></li>`).join('')}</ol>`;
  }

  /** Who has a thread's next move (`waiting`, src/threads.js), as a tag; null for nobody. */
  const WAIT = {
    vendor: ['tv-them', 'Waiting on them', 'The vendor has the next move: chase them if it takes too long'],
    third: ['tv-them', 'Waiting on a third party', 'Someone who is neither Adobe nor the customer has the next move: a vendor, a partner or an agency'],
    customer: ['tv-them', 'Waiting on them', 'The customer has the next move'],
    us: ['tv-us', 'Waiting on Adobe', 'Adobe has the next move'],
  };
  const waitTag = (waiting, third = false) => {
    const w = WAIT[third && waiting === 'vendor' ? 'third' : waiting];
    return w ? `<span class="tag ${w[0]}" title="${esc(w[2])}">${esc(w[1])}</span>` : '';
  };

  /**
   * A list of threads (src/vendors.js): `rows` of `{ title, inbox, org, channel, urgency, kind,
   * waiting, third, last }` (`third`: a customer's thread, which waits on a third party), each its title (a link into the inbox) over its customer, channel and
   * latest activity, who has the next move at the right. `orgName(slug)` names a row's org where
   * `withOrg`. `hidden` more of them are in channels of teams the viewer is not on: counted, not
   * listed. `empty` is what an empty list says.
   */
  function threads(rows, {
    hidden = 0, empty, withOrg = false, orgName = (x) => x,
  } = {}) {
    const item = (r) => {
      const title = esc(r.title || 'A thread without a title');
      const sub = [
        withOrg && r.org ? orgName(r.org) : '',
        r.channel ? `#${r.channel}` : '',
        r.urgency && r.urgency !== 'low' ? `${r.urgency} urgency` : '',
        r.kind && r.kind !== 'other' ? r.kind : '',
        r.last ? ago(r.last) : '',
      ].filter(Boolean).join(' · ');
      return `<li><span class="tv-name">${r.inbox ? `<a href="${esc(r.inbox)}" title="Open it in the inbox">${title}</a>` : `<span>${title}</span>`}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>${waitTag(r.waiting, r.third)}</li>`;
    };
    const more = hidden ? `<p class="sub tv-more">And ${esc(plural(hidden, 'more thread'))} in channels of teams you are not on.</p>` : '';
    if (!rows.length) return `${hidden ? '' : `<div class="empty">${esc(empty || 'None.')}</div>`}${more}`;
    return `<ul class="tv-threads">${rows.map(item).join('')}</ul>${more}`;
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

  // ---- an icon's color ---------------------------------------------------------------------

  /** The Spectrum 2 colors an org's line can be in (ui/spectrum.css, `.ps-spark[data-tint]`). */
  const PALETTE = ['red', 'orange', 'yellow', 'chartreuse', 'celery', 'green', 'seafoam', 'cyan',
    'turquoise', 'blue', 'indigo', 'purple', 'fuchsia', 'magenta', 'pink', 'cinnamon', 'brown'];

  /** sRGB (0 to 255) in OKLab, where a distance is about as large as two colors look apart. */
  function oklab([r, g, b]) {
    const lin = (c) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const [R, G, B] = [lin(r), lin(g), lin(b)];
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
  }

  /** The palette's colors as the page has them (light or dark), in OKLab: read once, from `el`. */
  let palette = null;
  function paletteIn(el) {
    if (palette) return palette;
    const probe = document.createElement('span');
    probe.className = 'ps-spark';
    probe.hidden = true;
    probe.style.color = 'var(--tint)';
    el.append(probe);
    palette = PALETTE.map((name) => {
      probe.dataset.tint = name;
      const rgb = (getComputedStyle(probe).color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      return { name, lab: rgb.length === 3 ? oklab(rgb) : null };
    }).filter((c) => c.lab);
    probe.remove();
    return palette;
  }

  /** The palette's color nearest `rgb`; lightness counts half, as the palette's are all mid-tones. */
  function nearest(rgb, el) {
    const [L, a, b] = oklab(rgb);
    let best = null;
    let least = Infinity;
    for (const c of paletteIn(el)) {
      const d = (0.5 * (L - c.lab[0])) ** 2 + (a - c.lab[1]) ** 2 + (b - c.lab[2]) ** 2;
      if (d < least) {
        least = d;
        best = c.name;
      }
    }
    return best;
  }

  /**
   * An image's main color, in sRGB: the average of its most common hue (by 20°) among its
   * colorful pixels, null where too few are (a gray, black or white logo). Throws for an image of
   * another origin that does not allow it (a tainted canvas).
   */
  function dominant(img) {
    const n = 24;
    const canvas = document.createElement('canvas');
    canvas.width = n;
    canvas.height = n;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, n, n);
    const { data } = g.getImageData(0, 0, n, n);
    const bins = Array.from({ length: 18 }, () => ({ n: 0, w: 0, rgb: [0, 0, 0] }));
    let seen = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] >= 128) {
        seen += 1;
        const px = [data[i], data[i + 1], data[i + 2]];
        const max = Math.max(...px);
        const d = max - Math.min(...px);
        const sat = max ? d / max : 0;
        if (sat >= 0.3 && max >= 64) {
          let h;
          if (max === px[0]) h = (px[1] - px[2]) / d;
          else if (max === px[1]) h = (px[2] - px[0]) / d + 2;
          else h = (px[0] - px[1]) / d + 4;
          const bin = bins[Math.round(((h * 60 + 360) % 360) / 20) % 18];
          const w = sat * (max / 255);
          bin.n += 1;
          bin.w += w;
          bin.rgb = bin.rgb.map((v, k) => v + w * px[k]);
        }
      }
    }
    const best = bins.reduce((x, y) => (y.w > x.w ? y : x));
    if (!seen || best.n < 0.08 * seen) return null;
    return best.rgb.map((v) => v / best.w);
  }

  /** The tint of the icon at `src` (a color of PALETTE, or null), once per icon. */
  const iconTints = new Map();
  function iconTint(src, el) {
    if (!iconTints.has(src)) {
      iconTints.set(src, new Promise((resolve) => {
        const img = new Image();
        if (new URL(src, location.href).origin !== location.origin) img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            const rgb = dominant(img);
            resolve(rgb ? nearest(rgb, el) : null);
          } catch {
            resolve(null);
          }
        };
        img.onerror = () => resolve(null);
        img.src = src;
      }));
    }
    return iconTints.get(src);
  }

  /**
   * The lines of the rankings in `el` led by an org's icon, in the icon's color: the Spectrum 2
   * color nearest its main one. A gray logo, or one of another origin that does not allow it to be
   * read, keeps the gray line.
   */
  function tintIcons(el) {
    for (const li of el.querySelectorAll('.tv-rank li')) {
      const icon = li.querySelector('img.ico, img[data-fav]');
      const line = li.querySelector('.ps-spark:not([data-tint])');
      if (icon && line) {
        iconTint(icon.getAttribute('src'), el).then((tint) => {
          if (tint) line.dataset.tint = tint;
        });
      }
    }
  }

  /**
   * What an overview does in `el`: the chart's weeks under the pointer (`p.weeks`, `p.activity`),
   * and its tabs: `onTab(button)` for a click on one (`[data-tab]`), after it is picked.
   */
  function wire(el, p, { onTab = null } = {}) {
    tintIcons(el);
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
    layers, knowledge, wire, threads, waitTag,
  };
})();
