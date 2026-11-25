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
 * A person's card is drawn with what the inbox's profile card is (ui/person.js). A person and a
 * technology have their Follow where the page gives one (`ctx.follow`, ui/follow.js). Everything
 * in it is a name, a number or a picture, written escaped.
 *
 * Its second section, Vendors (`vendors`, GET /api/teams/vendors, src/vendors.js): the vendors
 * the team works with, each with its open cases and how soon it answers, a Follow for the team's
 * managers where its channels are not in the team's inbox; and what waits on a vendor in the
 * team's inbox, and the vendors' cases that wait on Adobe, titles only of the threads you work.
 */
globalThis.TeamView = (() => {
  const {
    esc, face, plural, ago, link, spark, bar, ranked,
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
    // As the inbox's profile card draws them (ui/person.js): an area is `tag:<id>` on the Topics
    // page, a technology `product:tech:<id>`, a person `person:<id>`; key customers at the foot.
    const { keys } = Person.work(m, ctx);
    // Their profile on the team, from its knowledge base.
    const profile = m.profile ? Person.profile([{
      team: p.team.slug, teamName: p.team.name, description: m.profile.description, href: ctx.kbHref(m.profile.path),
    }]) : '';
    return Person.card(m, {
      face: face(m.name, m.avatar, 'big'),
      name: link(ctx.topicHref(`person:${m.id}`), esc(m.name || 'Someone'), { title: 'Their topics, customers and products on the Topics page' }),
      badge: m.role === 'manager' ? '<span class="tag tv-manager">Manager</span>' : '',
      title: m.title,
      weeks: p.weeks.length,
      profile,
      foot: keys,
      // Their Follow (ui/follow.js), where the page gives one.
      action: ctx.follow?.({ kind: 'person', id: m.id, name: m.name }) || '',
      ctx,
      attrs: ` data-person="${esc(m.id)}"`,
    });
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
      tint: Person.tintOf(c.name),
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
      // What it is, and that the catalog has it, under the name.
      const sub = [t.vendor !== t.name && t.vendor, t.kind && t.kind !== 'Product' ? t.kind.toLowerCase() : '',
        t.catalog ? 'in its catalog' : ''].filter(Boolean).join(' · ');
      // And its Follow (ui/follow.js), with the team in its chevron (its count says whether the
      // team follows it) for whoever is on it or manages it.
      const button = ctx.follow?.({ kind: 'tech', id: t.tech, name: t.name }) || '';
      return `<li><span class="tv-name"><span class="tv-line">${name}${button}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
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

  // ---- its vendors ---------------------------------------------------------------------------

  /** How a vendor and the team meet, in words. */
  function relation(v) {
    return [
      v.filed ? `${plural(v.filed, 'channel')} filed here` : '',
      v.shared ? `${plural(v.shared, 'channel')} shared` : '',
      v.posted ? `the team posted ${plural(v.posted, 'message')} there` : '',
      v.products ? `in ${plural(v.products, 'customer thread')}` : '',
    ].filter(Boolean).join(' · ');
  }

  function vendorRow(v, p, ctx) {
    const cases = v.cases.open ? [
      v.cases.them ? `<span class="tag tv-them" title="Its cases that wait on it">${esc(plural(v.cases.them, 'waits', 'wait'))} on them</span>` : '',
      v.cases.us ? `<span class="tag tv-us" title="Its cases that wait on Adobe">${esc(plural(v.cases.us, 'waits', 'wait'))} on Adobe</span>` : '',
    ].join('') : '<span class="sub">no open case</span>';
    const a = v.answers;
    const answer = a.answered ? `<span class="tv-answer" title="How long its first answer took in the threads Adobe started there, the middle of them"><b>${esc(Overview.wait(a.median))}</b><span class="sub">first answer</span></span>`
      : '<span class="tv-answer"><span class="sub">no answer yet</span></span>';
    let inbox = '';
    if (v.follows) inbox = '<span class="tag tv-follow" title="Every channel of it is in the team\'s inbox, shared, now and later">Followed</span>';
    else if (!v.inInbox && !v.channels) inbox = '<span class="sub" title="It has no channel the inbox knows of: nothing to follow yet">no channel</span>';
    // The team's own Follow, in Follow's look (ui/follow.js); ui/admin.js sends it as Follow does.
    else if (!v.inInbox && p.may.follow) inbox = `<span class="fo"><span class="fo-follow"><button type="button" class="fo-b" aria-pressed="false" data-follow="${esc(v.slug)}" title="Follow it with the team: every channel of it goes into the team's inbox, shared, now and later">Follow</button></span></span>`;
    else if (!v.inInbox) inbox = '<span class="sub" title="Its channels are not in the team\'s inbox; the team\'s managers can follow it">not in the inbox</span>';
    return `<li>${ctx.orgIcon(v.slug, v.icon)}
      <span class="tv-name"><a href="${esc(ctx.orgHref(v.slug))}">${esc(ctx.orgName(v.slug, v.name))}</a><span class="sub">${esc(relation(v) || 'none of its channels is here')}${v.last ? ` · ${esc(ago(v.last))}` : ''}</span></span>
      ${answer}<span class="tv-act">${inbox}</span><span class="tv-cases">${cases}</span></li>`;
  }

  /**
   * The team's Vendors section, from GET /api/teams/vendors (`p`), as HTML: `ctx` as for `html`.
   */
  function vendors(p, ctx) {
    const inInbox = p.vendors.filter((v) => v.inInbox).length;
    const open = p.vendors.reduce((s, v) => s + v.cases.open, 0);
    const them = p.vendors.reduce((s, v) => s + v.cases.them, 0);
    const numbers = Overview.stats([
      [p.vendors.length, p.vendors.length === 1 ? 'vendor' : 'vendors', `${inInbox} in its inbox`],
      [open, open === 1 ? 'open case' : 'open cases', `${them} waiting on the vendor`],
      [p.waitingCount, 'waiting on a vendor', 'in its inbox: cases and customers\' threads'],
      [p.oursCount, 'waiting on Adobe', 'vendors\' cases where Adobe has the next move'],
    ]);
    const list = p.vendors.length ? `<ol class="tv-vendors">${p.vendors.map((v) => vendorRow(v, p, ctx)).join('')}</ol>`
      : '<div class="empty">The team works with no vendor yet: none of its channels is a vendor\'s, its people posted in none, and its customers\' threads show no vendor\'s product.</div>';
    const orgName = (slug) => ctx.orgName(slug, null);
    return `<div class="tv">
      <section class="tv-sec tv-hero" aria-label="Vendors">${numbers}</section>
      <div class="tv-two">
        <section class="tv-sec" aria-labelledby="tvWaiting"><h2 id="tvWaiting">Waiting on a vendor <span class="sub">${esc(plural(p.waitingCount, 'thread'))}</span></h2>
          ${Overview.threads(p.waiting, {
    hidden: p.waitingHidden, withOrg: true, orgName, empty: 'Nothing in the team\'s inbox waits on a vendor.',
  })}
          <p class="hint">The vendors' cases in the team's inbox that wait on the vendor, and its customers' threads that Clef says wait on a third party, the latest first. Chase the vendor where one waits too long.</p></section>
        <section class="tv-sec" aria-labelledby="tvOurs"><h2 id="tvOurs">Waiting on Adobe <span class="sub">${esc(plural(p.oursCount, 'case'))}</span></h2>
          ${Overview.threads(p.ours, {
    hidden: p.oursHidden, withOrg: true, orgName, empty: 'No vendor waits on Adobe.',
  })}
          <p class="hint">The cases of these vendors where Adobe has the next move: the vendor asked for logs, a test or a decision.</p></section>
      </div>
      <section class="tv-sec" aria-labelledby="tvVendors"><h2 id="tvVendors">Vendors <span class="sub">${esc(plural(p.vendors.length, 'vendor'))}, those in its inbox first</span></h2>
        ${list}
        <p class="hint">The vendors whose channels are filed under the team, shared with it or followed by it, those its people post in, and those whose products its customers' threads show (the last ${p.weeks.length} weeks). A vendor whose channels are not in the team's inbox can be followed: every channel of it is then shared with the team.</p></section>
    </div>`;
  }

  return { html, wire, vendors };
})();
