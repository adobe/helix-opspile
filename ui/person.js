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
 * A person, as both their cards show them, the global `Person`: the profile card on a name or a
 * picture in the inbox (ui/inbox.js) and a member's card on their team's overview (ui/team.js).
 * Both are drawn from one person (src/person.js `personCard`, and src/teamprofile.js for the
 * overview's members), and their parts are drawn here, so that they look and say the same:
 *
 * - `face`: their picture over their initials, on the hue of their name (`data-hue`), which shows
 *   while the picture loads or when it fails (Gravatar's 404);
 * - `freq`: how often they post, a line of their weeks beside it, in the color of their hue
 *   (`tintOf`, as the overviews' rankings draw a person's line);
 * - `work`: what sets them apart, Clef's areas and technologies of their threads, each a link to
 *   it on the Topics page, and the customers they post for the most;
 * - `profile`: their profile on their team, the description of their Contact in its knowledge
 *   base (docs/ARCHITECTURE.md, "Layout"), with a link to it.
 * - `card`: a person's card on an overview, all of the above in the same parts, in the same order
 *   and at the same size for everyone, so that nothing a card has moves from one card to the next.
 *
 * Everything in them is a name, a number or a picture, written escaped.
 */
globalThis.Person = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const COLORS = 8;
  /** A name's hue, as ui/header.js has it: an index of the hues ui/spectrum.css colors by. */
  const hueOf = (name) => {
    let h = 0;
    for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h % COLORS;
  };
  /**
   * The Spectrum 2 color of each hue (ui/spectrum.css colors `.av[data-hue]` by them), as the
   * name a sparkline is tinted with (`data-tint`): a person's line is in their initials' color.
   */
  const TINTS = ['cinnamon', 'seafoam', 'purple', 'magenta', 'blue', 'green', 'brown', 'cyan'];
  const tintOf = (name) => TINTS[hueOf(name || '?')];
  const initials = (name) => String(name || '?').replace(/\(.*?\)/g, '').split(/[\s,]+/).filter(Boolean)
    .map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString('en')} ${n === 1 ? one : many}`;
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
  const link = (href, inner, { cls = '', title = '', attrs = '' } = {}) => {
    const at = `${cls ? ` class="${cls}"` : ''}${title ? ` title="${esc(title)}"` : ''}${attrs}`;
    return href ? `<a href="${esc(href)}"${at}>${inner}</a>` : `<span${at}>${inner}</span>`;
  };

  /**
   * Their face: the picture over the initials. `attrs` adds to it (a profile key, a role); without
   * them it is a picture beside their name, hidden from assistive technology.
   */
  const face = (name, url, { cls = '', attrs = ' aria-hidden="true"' } = {}) => `<span class="av ps-av${cls ? ` ${cls}` : ''}" data-hue="${hueOf(name || '?')}"${attrs}>${esc(initials(name))}${url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>`;

  /** A line of `values` (one a week), its area under it; `cls` or `tint` (a color's name) colors it. */
  function spark(values, {
    cls = '', w = 96, h = 24, label = '', tint = '',
  } = {}) {
    const m = Math.max(...values, 1);
    const n = values.length;
    const x = (i) => ((i * w) / Math.max(1, n - 1)).toFixed(1);
    const y = (v) => (h - 1 - ((h - 3) * v) / m).toFixed(1);
    const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    return `<svg class="ps-spark${cls ? ` ${cls}` : ''}"${tint ? ` data-tint="${esc(tint)}"` : ''} viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"${label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"'}>`
      + `<polygon class="area" points="0,${h} ${pts} ${w},${h}"></polygon><polyline points="${pts}"></polyline></svg>`;
  }

  /**
   * How often they post: `w` is `{ messages, threads, weekly, last }`, over `weeks` weeks; the
   * line in their color. The rate, how much and when last are three parts of their own, on lines
   * of their own, so that a long "last" never wraps the line and pushes what is under it.
   */
  const freq = (name, w, weeks = w.weekly.length) => `<div class="ps-freq">${spark(w.weekly, { label: `${name || 'Their'} messages, week by week`, tint: tintOf(name) })}<div><b>${esc(often(w.messages, weeks))}</b><span class="sub ps-n">${esc(plural(w.messages, 'message'))} in ${esc(plural(w.threads, 'thread'))}</span><span class="sub ps-last">${w.last ? `last ${esc(ago(w.last))}` : 'none lately'}</span></div></div>`;

  /** A tag of theirs, linked to it on the Topics page where there is one (`href`). */
  const chip = (name, threads, { cls = '', href = null } = {}) => link(href, esc(name), {
    cls: `ps-chip${cls ? ` ${cls}` : ''}`,
    title: `${name}: ${plural(threads, 'thread')} of theirs${href ? '. Open it on the Topics page' : ''}`,
  });

  /** Tags past the first `most`, as a count of them that names them all when pointed at. */
  const rest = (list, most) => (list.length > most ? `<span class="ps-chip ps-more" title="${esc(`Also ${list.slice(most).map((x) => x.name).join(', ')}`)}">+${list.length - most}</span>` : '');

  /**
   * What sets them apart and for whom: `w` is `{ areas, tech, customers }`. `ctx` links and names
   * what is elsewhere: `topicHref(id)` (a node of the Topics page: `tag:<area>`,
   * `product:tech:<id>`), `orgHref(slug)`, `orgName(slug, name)` and `orgIcon(slug, icon)` (HTML).
   * `most` keeps the first of each, `more` adds a count of the rest; `label` names the areas. The
   * areas and the technologies are a list each (`areas`, `tech`), and both together (`knows`); the
   * key customers a list of their own (`ps-keys`), which a card puts at its foot.
   */
  function work(w, ctx, { most = Infinity, more = false, label = 'Expertise' } = {}) {
    const all = { areas: w.areas || [], tech: w.tech || [] };
    const dl = (title, list, html) => (list.length ? `<dt>${title}</dt><dd>${list.slice(0, most).map(html).join('')}${more ? rest(list, most) : ''}</dd>` : '');
    const areas = dl(label, all.areas, (a) => chip(a.name, a.threads, { href: ctx.topicHref(`tag:${a.id}`) }));
    const tech = dl('Products', all.tech, (t) => chip(t.name, t.threads, { cls: 'tech', href: ctx.topicHref(`product:tech:${t.id}`) }));
    const keys = (w.customers || []).length ? `<dl class="ps-keys"><dt>Key customers</dt><dd>${w.customers.map((c) => link(ctx.orgHref(c.slug), `${ctx.orgIcon(c.slug, c.icon)}<span>${esc(ctx.orgName(c.slug, c.name))}</span>`, {
      cls: 'ps-org', title: `${ctx.orgName(c.slug, c.name)}: ${plural(c.n, 'message')} of theirs in ${plural(c.threads, 'thread')}`,
    })).join('')}</dd></dl>` : '';
    return {
      knows: areas || tech ? `<dl class="ps-knows">${areas}${tech}</dl>` : '',
      areas: areas && `<dl class="ps-knows">${areas}</dl>`,
      tech: tech && `<dl class="ps-knows">${tech}</dl>`,
      keys,
    };
  }

  /**
   * Their profile on a team: `{ team, teamName, description, href }` each, where `href` opens it
   * in the knowledge base (null: the viewer may not).
   */
  const profile = (list) => (list || []).filter((x) => x.description).map((x) => `<div class="ps-profile">
      <p>${esc(x.description)}</p>${link(x.href, esc(`Profile on ${x.teamName || x.team}`), { cls: 'ps-src', title: x.href ? 'Their Contact in the team\'s knowledge base' : '' })}</div>`).join('');

  /**
   * A person's card on an overview (ui/team.js, ui/customer.js), the same size whoever it is: six
   * parts in the same order, each there even when it is empty, so that what every card has is
   * where it is on the others. Who they are (`face`, `name` and `badge` HTML, `title`, its line
   * there without one), how often they post (`w`, over `weeks`) in its corner, the areas (named
   * `label`) and the technologies, two lines of tags each (the first three and a count of the
   * rest), their profile (`profile`, HTML; its first two lines) and the foot (`foot`, HTML: their
   * key customers, or their Contact) at the bottom. `attrs` adds to it.
   */
  function card(w, {
    face: pic, name, badge = '', title = '', weeks, label = 'Expertise', profile: about = '', foot = '', ctx, attrs = '',
  }) {
    const { areas, tech } = work(w, ctx, { label, most: 3, more: true });
    // Where Clef has nothing, the card says so where the tags would be.
    const none = (kind) => `<dl class="ps-knows"><dt>${kind}</dt><dd><span class="sub">None yet</span></dd></dl>`;
    return `<article class="tv-person ps-card"${attrs}>`
      + `<header>${pic}<div class="who"><span class="ps-nm"><b>${name}</b>${badge}</span><span class="sub ps-ttl">${esc(title)}</span></div></header>`
      + `<div class="ps-s ps-s-act">${freq(w.name, w, weeks)}</div>`
      + `<div class="ps-s ps-s-areas">${areas || none(label)}</div>`
      + `<div class="ps-s ps-s-tech">${tech || none('Products')}</div>`
      + `<div class="ps-s ps-s-prof">${about || '<p class="sub ps-noprof">No profile in the knowledge base yet.</p>'}</div>`
      + `<div class="ps-s ps-s-foot">${foot}</div>`
      + '</article>';
  }

  return {
    esc, hueOf, tintOf, initials, plural, ago, often, link, face, spark, freq, chip, work, profile, card,
  };
})();
