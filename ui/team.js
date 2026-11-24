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
 * team's last half year, for everyone at Adobe, drawn with ui/overview.js (`Overview`), as a
 * customer's is (ui/customer.js).
 *
 * - The team's threads, week by week: a chart of what Adobe's people and the customers said, and
 *   how much there is of each part below.
 * - Its people: a card each, with their picture, title and role, how often they post (a line of
 *   their weeks), what sets them apart (Clef's areas and technologies of their threads, each a
 *   link to it on the Topics page, as their name is to them) and, at the card's foot, their key
 *   customers. Those who did not post are listed after the cards.
 * - Its customers and its collaborators (Adobe's people on other teams in its threads), ranked by
 *   what was said, each with a bar, a line of their weeks and who of the team works them.
 * - Its products and technologies, by the layer of a stack they are in: what it follows, what its
 *   catalog has (its knowledge base's products/) and what else Clef sees in its threads, which the
 *   tabs above them pick. Then its knowledge base by type, and its stack drawing where it has one.
 *
 * Everything in it is a name, a number or a picture, written escaped.
 */
globalThis.TeamView = (() => {
  const {
    esc, face, plural, ago, often, link, spark, bar, chip, ranked,
  } = Overview;

  // ---- the parts ----------------------------------------------------------------------------

  function stats(p) {
    const total = p.activity.messages.reduce((s, v) => s + v, 0);
    const staff = p.activity.staff.reduce((s, v) => s + v, 0);
    const threads = p.activity.threads.reduce((s, v) => s + v, 0);
    const active = p.members.filter((m) => m.messages).length;
    return Overview.stats([
      [p.members.length, p.members.length === 1 ? 'person' : 'people', `${active} posted in the last ${p.weeks.length} weeks`],
      [p.customerCount, p.customerCount === 1 ? 'customer' : 'customers', 'in its threads'],
      [total, total === 1 ? 'message' : 'messages', total ? `${Math.round((100 * staff) / total)}% by Adobe` : ''],
      [p.threadCount, p.threadCount === 1 ? 'thread' : 'threads', `${Math.round(threads / p.weeks.length)} active in a week`],
      [p.collaboratorCount, p.collaboratorCount === 1 ? 'collaborator' : 'collaborators', 'from Adobe, not on the team'],
    ]);
  }

  function person(m, p, ctx) {
    const role = m.role === 'manager' ? '<span class="tag tv-manager">Manager</span>' : '';
    const freq = `<div class="tv-freq">${spark(m.weekly, { label: `${m.name || 'Their'} messages, week by week` })}<div><b>${esc(often(m.messages, p.weeks.length))}</b><span class="sub">${esc(plural(m.messages, 'message'))} in ${esc(plural(m.threads, 'thread'))}${m.last ? ` · last ${esc(ago(m.last))}` : ''}</span></div></div>`;
    // An area is `tag:<id>` on the Topics page, a technology `product:tech:<id>`, a person `person:<id>`.
    const knows = [
      m.areas.length ? `<dt>Expertise</dt><dd>${m.areas.map((a) => chip(a.name, a.threads, { href: ctx.topicHref(`tag:${a.id}`) })).join('')}</dd>` : '',
      m.tech.length ? `<dt>Products</dt><dd>${m.tech.map((t) => chip(t.name, t.threads, { cls: 'tech', href: ctx.topicHref(`product:tech:${t.id}`) })).join('')}</dd>` : '',
    ].join('');
    // Key customers at the foot of the card, level with the next card's.
    const keys = m.customers.length ? `<dl class="tv-keys"><dt>Key customers</dt><dd>${m.customers.map((c) => link(ctx.orgHref(c.slug), `${ctx.orgIcon(c.slug, c.icon)}<span>${esc(ctx.orgName(c.slug, c.name))}</span>`, {
      cls: 'tv-org', title: `${ctx.orgName(c.slug, c.name)}: ${plural(c.n, 'message')} of theirs in ${plural(c.threads, 'thread')}`,
    })).join('')}</dd></dl>` : '';
    const name = link(ctx.topicHref(`person:${m.id}`), esc(m.name || 'Someone'), { title: 'Their topics, customers and products on the Topics page' });
    return `<article class="tv-person" data-person="${m.id}">
      <header>${face(m.name, m.avatar, 'big')}<div class="who"><b>${name}</b>${role}${m.title ? `<span class="sub">${esc(m.title)}</span>` : ''}</div></header>
      ${freq}
      ${knows ? `<dl class="tv-knows">${knows}</dl>` : '<p class="sub tv-none">Nothing Clef tagged in their threads yet.</p>'}
      ${keys}
    </article>`;
  }

  function people(p, ctx) {
    const busy = p.members.filter((m) => m.messages);
    const quiet = p.members.filter((m) => !m.messages);
    const cards = busy.map((m) => person(m, p, ctx)).join('');
    const rest = quiet.length ? `<div class="tv-quiet"><span class="sub">${busy.length ? 'No posts in these weeks' : 'Nobody on the team posted in these weeks'}</span>${quiet.map((m) => `<span class="tv-q" title="${esc(m.title || '')}">${face(m.name, m.avatar)}<span>${esc(m.name || 'Someone')}</span>${m.role === 'manager' ? '<span class="tag tv-manager">Manager</span>' : ''}</span>`).join('')}</div>` : '';
    return `<section class="tv-sec" aria-labelledby="tvPeople"><h2 id="tvPeople">People <span class="sub">${esc(plural(p.members.length, 'member'))}, the busiest first</span></h2>
      ${p.members.length ? `${cards ? `<div class="tv-people">${cards}</div>` : ''}${rest}` : '<div class="empty">Nobody is on this team yet.</div>'}
      <p class="hint">What they posted anywhere in the inbox, the last ${p.weeks.length} weeks. Expertise and products are Clef's areas and technologies of their threads, those they have more of than the rest of the team first, each a link to it on the Topics page (a name, to the person there); key customers the ones they posted the most for.</p></section>`;
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
      tail: Overview.teamChips(c.teams, ctx.teamHref),
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
    const most = Math.max(...p.tech.map((t) => t.threads), 1);
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
    return Overview.layers(p.tech.filter((t) => techIn(t, tab)), p.layers, row);
  }

  function tech(p, ctx, tab) {
    const list = TECH_TABS.map((t) => ({ ...t, n: p.tech.filter((x) => techIn(x, t.id)).length }));
    return `<section class="tv-sec" aria-labelledby="tvTech"><h2 id="tvTech">Products and technologies</h2>
      ${Overview.tabs(list, tab, { label: 'Which technologies' })}
      <div class="tv-stack" id="tvTechRows">${techRows(p, ctx, tab)}</div>
      <p class="hint">By the layer of a customer's stack they are in. The count is the team's threads Clef sees one in, the line what was said in them week by week.</p></section>`;
  }

  // ---- the page -----------------------------------------------------------------------------

  /**
   * The overview of profile `p` (GET /api/teams/profile), as HTML. `ctx` links and names what is
   * elsewhere: `orgHref(slug)`, `orgName(slug, name)`, `orgIcon(slug, icon)` (HTML), `teamHref(slug)`,
   * `kbHref(path)`, null where the viewer may not open the knowledge base, and `topicHref(id)`, a
   * node of the Topics page.
   */
  function html(p, ctx) {
    return `<div class="tv">
      <section class="tv-sec tv-hero" aria-label="Activity">${stats(p)}${Overview.chart(p, { label: `Messages in ${p.team.name}'s threads` })}</section>
      ${people(p, ctx)}
      <div class="tv-two">${customers(p, ctx)}${collaborators(p, ctx)}</div>
      ${tech(p, ctx, 'all')}
      ${Overview.knowledge(p.kb, { name: p.team.name, kbHref: ctx.kbHref })}
    </div>`;
  }

  /** What the overview does in `el`: the chart's weeks under the pointer, the tabs of the technologies. */
  function wire(el, p, ctx) {
    Overview.wire(el, p, { onTab: (b) => { el.querySelector('#tvTechRows').innerHTML = techRows(p, ctx, b.dataset.tab); } });
  }

  return { html, wire };
})();
