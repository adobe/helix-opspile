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
 * A team's overview, the first section of its page in Teams (ui/admin.js draws the page around
 * it), as the global `TeamView`: what GET /api/teams/profile says (src/teamprofile.js) of the
 * team's last half year, for everyone at Adobe.
 *
 * - The team's threads, week by week: a chart of what Adobe's people and the customers said, and
 *   how much there is of each part below.
 * - Its people: a card each, with their picture, title and role, how often they post (a line of
 *   their weeks), what sets them apart (Clef's areas and technologies of their threads) and their
 *   key customers. Those who did not post are listed after the cards.
 * - Its customers and its collaborators (Adobe's people on other teams in its threads), ranked by
 *   what was said, each with a bar, a line of their weeks and who of the team works them.
 * - Its products and technologies, by the layer of a stack they are in: what it follows, what its
 *   catalog has (its knowledge base's products/) and what else Clef sees in its threads, which the
 *   tabs above them pick. Then its knowledge base by type, and its stack drawing where it has one.
 *
 * Everything in it is a name, a number or a picture, written escaped.
 */
globalThis.TeamView = (() => {
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
   * The chart of the team's weeks: what customers said over what Adobe's people said, the
   * months under it, the most in a week beside it. A week under the pointer says its numbers.
   */
  function chart(p) {
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
    // Customers' on top of Adobe's: the whole is everything said.
    const months = p.weeks.map((w, i) => [w, i]).filter(([w], i) => i === 0 || w.slice(5, 7) !== p.weeks[i - 1].slice(5, 7));
    const grid = [0.5, 1].map((f) => `<line class="grid" x1="0" x2="${W}" y1="${y(m * f)}" y2="${y(m * f)}"></line>`).join('');
    return `<div class="tv-chart" data-chart>
      <div class="tv-axis"><span>${m.toLocaleString('en')}</span><span>${Math.round(m / 2).toLocaleString('en')}</span><span>0</span></div>
      <div class="tv-plot">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`Messages in ${p.team.name}'s threads, week by week, the last ${n} weeks`)}">
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
      <div class="tv-legend"><span class="staff">Adobe</span><span class="all">Customers and partners</span></div>
    </div>`;
  }

  // ---- the parts ----------------------------------------------------------------------------

  function stats(p) {
    const total = p.activity.messages.reduce((s, v) => s + v, 0);
    const staff = p.activity.staff.reduce((s, v) => s + v, 0);
    const threads = p.activity.threads.reduce((s, v) => s + v, 0);
    const active = p.members.filter((m) => m.messages).length;
    const tile = (n, what, sub) => `<div class="tv-stat"><b>${typeof n === 'number' ? n.toLocaleString('en') : esc(n)}</b><span>${esc(what)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
    return `<div class="tv-stats">
      ${tile(p.members.length, p.members.length === 1 ? 'person' : 'people', `${active} posted in the last ${p.weeks.length} weeks`)}
      ${tile(p.customerCount, p.customerCount === 1 ? 'customer' : 'customers', 'in its threads')}
      ${tile(total, total === 1 ? 'message' : 'messages', total ? `${Math.round((100 * staff) / total)}% by Adobe` : '')}
      ${tile(p.threadCount, p.threadCount === 1 ? 'thread' : 'threads', `${Math.round(threads / p.weeks.length)} active in a week`)}
      ${tile(p.collaboratorCount, p.collaboratorCount === 1 ? 'collaborator' : 'collaborators', 'from Adobe, not on the team')}
    </div>`;
  }

  /** A chip of a tag: what it is, how many threads of theirs it was in. */
  const chip = (name, threads, cls = '') => `<span class="tv-chip${cls ? ` ${cls}` : ''}" title="${esc(`${name}: ${plural(threads, 'thread')} of theirs`)}">${esc(name)}</span>`;

  function person(m, p, ctx) {
    const role = m.role === 'manager' ? '<span class="tag tv-manager">Manager</span>' : '';
    const freq = `<div class="tv-freq">${spark(m.weekly, { label: `${m.name || 'Their'} messages, week by week` })}<div><b>${esc(often(m.messages, p.weeks.length))}</b><span class="sub">${esc(plural(m.messages, 'message'))} in ${esc(plural(m.threads, 'thread'))}${m.last ? ` · last ${esc(ago(m.last))}` : ''}</span></div></div>`;
    const facts = [
      m.areas.length ? `<dt>Expertise</dt><dd>${m.areas.map((a) => chip(a.name, a.threads)).join('')}</dd>` : '',
      m.tech.length ? `<dt>Products</dt><dd>${m.tech.map((t) => chip(t.name, t.threads, 'tech')).join('')}</dd>` : '',
      m.customers.length ? `<dt>Key customers</dt><dd>${m.customers.map((c) => link(ctx.orgHref(c.slug), `${ctx.orgIcon(c.slug, c.icon)}<span>${esc(ctx.orgName(c.slug, c.name))}</span>`, {
        cls: 'tv-org', title: `${ctx.orgName(c.slug, c.name)}: ${plural(c.n, 'message')} of theirs in ${plural(c.threads, 'thread')}`,
      })).join('')}</dd>` : '',
    ].join('');
    return `<article class="tv-person" data-person="${m.id}">
      <header>${face(m.name, m.avatar, 'big')}<div class="who"><b>${esc(m.name || 'Someone')}</b>${role}${m.title ? `<span class="sub">${esc(m.title)}</span>` : ''}</div></header>
      ${freq}
      ${facts ? `<dl>${facts}</dl>` : '<p class="sub tv-none">Nothing Clef tagged in their threads yet.</p>'}
    </article>`;
  }

  function people(p, ctx) {
    const busy = p.members.filter((m) => m.messages);
    const quiet = p.members.filter((m) => !m.messages);
    const cards = busy.map((m) => person(m, p, ctx)).join('');
    const rest = quiet.length ? `<div class="tv-quiet"><span class="sub">${busy.length ? 'No posts in these weeks' : 'Nobody on the team posted in these weeks'}</span>${quiet.map((m) => `<span class="tv-q" title="${esc(m.title || '')}">${face(m.name, m.avatar)}<span>${esc(m.name || 'Someone')}</span>${m.role === 'manager' ? '<span class="tag tv-manager">Manager</span>' : ''}</span>`).join('')}</div>` : '';
    return `<section class="tv-sec" aria-labelledby="tvPeople"><h2 id="tvPeople">People <span class="sub">${esc(plural(p.members.length, 'member'))}, the busiest first</span></h2>
      ${p.members.length ? `${cards ? `<div class="tv-people">${cards}</div>` : ''}${rest}` : '<div class="empty">Nobody is on this team yet.</div>'}
      <p class="hint">What they posted anywhere in the inbox, the last ${p.weeks.length} weeks. Expertise and products are Clef's areas and technologies of their threads, those they have more of than the rest of the team first; key customers the ones they posted the most for.</p></section>`;
  }

  /** A ranked list: `rows` of `{ n, of, lead, name, sub, weekly, tail }`. */
  function ranked(rows, weeks) {
    const most = Math.max(...rows.map((r) => r.n), 1);
    return `<ol class="tv-rank">${rows.map((r, i) => `<li>
      <span class="tv-i">${i + 1}</span>${r.lead}
      <span class="tv-name">${r.name}${r.sub ? `<span class="sub">${r.sub}</span>` : ''}</span>
      <span class="tv-meter">${bar(r.n / most, r.of)}<span class="sub">${esc(plural(r.n, 'message'))}</span></span>
      ${spark(r.weekly, { label: `week by week, the last ${weeks} weeks` })}
      <span class="tv-tail">${r.tail || ''}</span></li>`).join('')}</ol>`;
  }

  function customers(p, ctx) {
    const byId = new Map(p.members.map((m) => [m.id, m]));
    const rows = p.customers.map((c) => ({
      n: c.messages,
      of: c.messages ? c.staff / c.messages : 0,
      lead: ctx.orgIcon(c.slug, c.icon),
      name: link(ctx.orgHref(c.slug), esc(ctx.orgName(c.slug, c.name))),
      sub: `${c.type !== 'customer' ? `${esc(c.type)} · ` : ''}${esc(`${plural(c.threads, 'thread')} · ${c.messages ? Math.round((100 * c.staff) / c.messages) : 0}% by Adobe`)}${c.last ? ` · ${esc(ago(c.last))}` : ''}`,
      weekly: c.weekly,
      tail: `<span class="tv-faces">${c.members.map((id) => byId.get(id)).filter(Boolean).map((m) => `<span title="${esc(m.name)}">${face(m.name, m.avatar, 'small')}</span>`).join('')}</span>`,
    }));
    return `<section class="tv-sec" aria-labelledby="tvCustomers"><h2 id="tvCustomers">Top customers <span class="sub">${p.customerCount > p.customers.length ? `${p.customers.length} of ${p.customerCount}` : esc(plural(p.customerCount, 'customer'))}</span></h2>
      ${rows.length ? ranked(rows, p.weeks.length) : '<div class="empty">No customer in its threads in these weeks.</div>'}
      <p class="hint">By what was said in the team's threads (its channels, those shared with it, and the threads of what it follows); a bar's first part is what Adobe said, as in the chart. The faces are who of the team posts the most for them.</p></section>`;
  }

  function collaborators(p, ctx) {
    const rows = p.collaborators.map((c) => ({
      n: c.messages,
      of: null,
      lead: face(c.name, c.avatar),
      name: `<b>${esc(c.name || 'Someone')}</b>`,
      sub: [c.title ? esc(c.title) : '', c.last ? esc(`last ${ago(c.last)}`) : ''].filter(Boolean).join(' · '),
      weekly: c.weekly,
      tail: c.teams.length ? c.teams.map((t) => `<a class="tv-chip team" href="${esc(ctx.teamHref(t.slug))}">${esc(t.name)}</a>`).join('') : '<span class="sub">on no team</span>',
    }));
    return `<section class="tv-sec" aria-labelledby="tvCollab"><h2 id="tvCollab">Top collaborators <span class="sub">${p.collaboratorCount > p.collaborators.length ? `${p.collaborators.length} of ${p.collaboratorCount}` : esc(plural(p.collaboratorCount, 'person', 'people'))}</span></h2>
      ${rows.length ? ranked(rows, p.weeks.length) : '<div class="empty">Nobody from outside the team posted in its threads in these weeks.</div>'}
      <p class="hint">Adobe's people who are not on the team, by what they said in its threads, with the teams they are on.</p></section>`;
  }

  const TECH_TABS = [
    { id: 'all', label: 'All' },
    { id: 'followed', label: 'Followed', hint: 'The threads that show one are in the team\'s inbox, in any team\'s channels' },
    { id: 'catalog', label: 'Its catalog', hint: 'The products of its knowledge base (products/): what Clef asks about' },
    { id: 'seen', label: 'In its threads', hint: 'What else Clef sees most in the team\'s threads' },
  ];
  const techIn = (t, tab) => tab === 'all' || (tab === 'followed' && t.followed)
    || (tab === 'catalog' && t.catalog) || (tab === 'seen' && !t.followed && !t.catalog);

  function techRows(p, ctx, tab) {
    const shown = p.tech.filter((t) => techIn(t, tab));
    if (!shown.length) return '<div class="empty">None.</div>';
    const most = Math.max(...p.tech.map((t) => t.threads), 1);
    const layers = (p.layers || []).map((l) => ({ ...l, tech: shown.filter((t) => (t.layer || 'other') === l.id) }))
      .filter((l) => l.tech.length);
    const known = new Set((p.layers || []).map((l) => l.id));
    const loose = shown.filter((t) => !known.has(t.layer || 'other'));
    if (loose.length) layers.push({ id: 'other', name: 'Other', tech: loose });
    const row = (t) => {
      const href = t.path ? ctx.kbHref(t.path) : null;
      const name = href ? `<a href="${esc(href)}">${esc(t.name)}</a>` : esc(t.name);
      // Followed is a badge beside the name; what it is, and that the catalog has it, under it.
      const follow = t.followed ? ' <span class="tag tv-follow" title="Followed: its threads are in the team\'s inbox">Followed</span>' : '';
      const sub = [t.vendor !== t.name && t.vendor, t.kind && t.kind !== 'Product' ? t.kind.toLowerCase() : '',
        t.catalog ? 'in its catalog' : ''].filter(Boolean).join(' · ');
      return `<li><span class="tv-name"><span class="tv-line">${name}${follow}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
        <span class="tv-meter">${bar(t.threads / most)}<span class="sub">${esc(plural(t.threads, 'thread'))}</span></span>${spark(t.weekly, { cls: 'tech', label: 'messages in its threads, week by week' })}</li>`;
    };
    return layers.map((l) => `<div class="tv-layer" data-layer="${esc(l.id)}"><h3>${esc(l.name)}</h3><ul>${l.tech.map(row).join('')}</ul></div>`).join('');
  }

  function tech(p, ctx, tab) {
    const count = (id) => p.tech.filter((t) => techIn(t, id)).length;
    return `<section class="tv-sec" aria-labelledby="tvTech"><h2 id="tvTech">Products and technologies</h2>
      <div class="tv-tabs" role="tablist" aria-label="Which technologies">${TECH_TABS.map((t) => `<button type="button" role="tab" data-tech-tab="${t.id}" aria-selected="${t.id === tab}"${t.hint ? ` title="${esc(t.hint)}"` : ''}>${esc(t.label)} <span class="sub">${count(t.id)}</span></button>`).join('')}</div>
      <div class="tv-stack" id="tvTechRows">${techRows(p, ctx, tab)}</div>
      <p class="hint">By the layer of a customer's stack they are in. The count is the team's threads Clef sees one in, the line what was said in them week by week.</p></section>`;
  }

  function knowledge(p, ctx) {
    const { kb } = p;
    if (!kb) return `<section class="tv-sec" aria-labelledby="tvKb"><h2 id="tvKb">Knowledge base</h2><div class="empty">${esc(p.team.name)} has no knowledge base yet: its thread agents start one.</div></section>`;
    const total = kb.types.reduce((s, t) => s + t.n, 0);
    const tiles = kb.types.map((t) => `<div class="tv-kbtype"><h3><b>${t.n.toLocaleString('en')}</b> ${esc(`${t.type.toLowerCase()}${t.n === 1 ? '' : 's'}`)}</h3>
      ${t.entries.length ? `<ul>${t.entries.map((e) => `<li>${ctx.kbHref(e.path) ? `<a href="${esc(ctx.kbHref(e.path))}"${e.description ? ` title="${esc(e.description)}"` : ''}>${esc(e.title)}</a>` : esc(e.title)}</li>`).join('')}${t.n > t.entries.length ? `<li class="sub">and ${t.n - t.entries.length} more</li>` : ''}</ul>` : ''}</div>`).join('');
    return `<section class="tv-sec" aria-labelledby="tvKb"><h2 id="tvKb">Knowledge base <span class="sub">${esc(plural(total, 'entry', 'entries'))}</span></h2>
      ${tiles ? `<div class="tv-kb">${tiles}</div>` : '<div class="empty">Nothing in it yet but its catalog: its thread agents add what they learn.</div>'}
      <div id="tvStack"></div>
      ${kb.readable ? '' : '<p class="hint">The members of the ops teams read the entries themselves.</p>'}</section>`;
  }

  // ---- the page -----------------------------------------------------------------------------

  /**
   * The overview of profile `p` (GET /api/teams/profile), as HTML. `ctx` links and names what is
   * elsewhere: `orgHref(slug)`, `orgName(slug, name)`, `orgIcon(slug, icon)` (HTML), `teamHref(slug)`
   * and `kbHref(path)`, null where the viewer may not open the knowledge base.
   */
  function html(p, ctx) {
    return `<div class="tv">
      <section class="tv-sec tv-hero" aria-label="Activity">${stats(p)}${chart(p)}</section>
      ${people(p, ctx)}
      <div class="tv-two">${customers(p, ctx)}${collaborators(p, ctx)}</div>
      ${tech(p, ctx, 'all')}
      ${knowledge(p, ctx)}
    </div>`;
  }

  /** What the overview does in `el`: the chart's weeks under the pointer, the tabs of the technologies. */
  function wire(el, p, ctx) {
    const plot = el.querySelector('[data-chart] .tv-plot');
    if (plot) {
      const tip = plot.querySelector('.tv-tip');
      const guide = plot.querySelector('.guide');
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
        tip.innerHTML = `<b>Week of ${esc(dayOf(p.weeks[i]))}</b><span>${esc(plural(all, 'message'))} in ${esc(plural(p.activity.threads[i], 'thread'))}</span><span>${esc(`${staff.toLocaleString('en')} by Adobe, ${(all - staff).toLocaleString('en')} by customers and partners`)}</span>`;
        tip.hidden = false;
        tip.classList.toggle('left', f > 0.6);
        tip.dataset.at = f.toFixed(3);
        tip.style.setProperty('--at', f.toFixed(3));
      };
      plot.addEventListener('pointermove', show);
      plot.addEventListener('pointerleave', () => { tip.hidden = true; guide.hidden = true; });
    }
    for (const b of el.querySelectorAll('[data-tech-tab]')) {
      b.onclick = () => {
        for (const x of el.querySelectorAll('[data-tech-tab]')) x.setAttribute('aria-selected', String(x === b));
        el.querySelector('#tvTechRows').innerHTML = techRows(p, ctx, b.dataset.techTab);
      };
    }
    // The months, where their weeks are.
    for (const m of el.querySelectorAll('.tv-months [data-at]')) m.style.setProperty('--at', m.dataset.at);
  }

  return {
    html, wire, spark, face,
  };
})();
