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
 * - Its numbers, each over a drawing of its own: its people as faces as big as what each said,
 *   its customers' shares of what was said, who carries the conversation (the customers against
 *   Adobe), its threads day by day (a contribution graph) and its collaborators by team.
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

  const { num } = Overview;
  const sum = (list) => list.reduce((s, v) => s + v, 0);
  const firstName = (name) => String(name || 'Someone').split(/\s+/)[0];
  const WEEKDAYS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

  /**
   * Collaborators by a team of theirs (the first; those on none last), as `Overview.crews` has
   * them.
   */
  function crewsOf(list, ctx) {
    const groups = new Map();
    for (const c of list) {
      const t = c.teams[0] || null;
      const key = t ? t.slug : '';
      if (!groups.has(key)) {
        groups.set(key, {
          name: t ? t.name : null, href: t ? ctx.teamHref(t.slug) : null, people: [], n: 0,
        });
      }
      const g = groups.get(key);
      g.people.push({ name: c.name, avatar: c.avatar });
      g.n += c.messages;
    }
    return [...groups.values()].sort((a, b) => Boolean(b.name) - Boolean(a.name) || b.n - a.n);
  }

  function stats(p, ctx) {
    const total = sum(p.activity.messages);
    const staff = sum(p.activity.staff);
    const posted = p.members.filter((m) => m.messages);
    const said = sum(p.members.map((m) => m.messages));
    const top = posted[0];
    const t = p.activity.threads;
    // The weekday most threads are active on: the team's busy days.
    const byDay = [0, 1, 2, 3, 4, 5, 6].map((d) => sum((p.activity.days || []).filter((v, i) => i % 7 === d)));
    const busiest = byDay.indexOf(Math.max(...byDay));
    let who = '';
    if (!p.members.length) who = 'nobody on it yet';
    else if (posted.length === p.members.length) who = p.members.length === 1 ? 'posted' : 'all posted';
    else who = `${posted.length} posted`;
    const shares = p.customers.slice(0, 5).map((c, i) => ({
      name: ctx.orgName(c.slug, c.name), n: c.messages, href: ctx.orgHref(c.slug), series: `s${i}`,
    }));
    const others = sum(p.customers.slice(5).map((c) => c.messages));
    if (others) shares.push({ name: 'Others', n: others, series: 'other' });
    const morePeople = p.collaboratorCount - p.collaborators.length;
    return Overview.stats([
      {
        label: `${num(p.members.length)} ${p.members.length === 1 ? 'person' : 'people'}, ${esc(who)}`,
        pic: p.members.length ? Overview.bubbles(p.members.map((m) => ({
          name: m.name, avatar: m.avatar, n: m.messages, href: ctx.topicHref(`person:${m.id}`),
        }))) : '',
        note: top && posted.length > 1 ? esc(`${firstName(top.name)} posts the most: ${Math.round((100 * top.messages) / Math.max(1, said))}%`) : '',
      },
      {
        label: `${num(p.customerCount)} ${p.customerCount === 1 ? 'customer' : 'customers'}`,
        pic: shares.length ? Overview.partsBar(shares) : '',
        note: shares.length ? 'by what was said in the team\'s threads' : 'none in these weeks',
      },
      {
        label: `${num(total)} ${total === 1 ? 'message' : 'messages'}`,
        pic: total ? Overview.balance(['Customers', total - staff], ['Adobe', staff]) : '',
        note: total ? '' : 'none in these weeks',
      },
      {
        cls: 'wide',
        label: `${num(p.threadCount)} ${p.threadCount === 1 ? 'thread' : 'threads'}`,
        pic: p.activity.days ? Overview.days(p.activity.days, p.weeks) : Overview.strip(t, p.weeks),
        note: esc(`${Math.round(sum(t) / t.length)} active in a week${byDay[busiest] ? `, the most on ${WEEKDAYS[busiest]}` : ''}`),
      },
      {
        label: `${num(p.collaboratorCount)} ${p.collaboratorCount === 1 ? 'collaborator' : 'collaborators'}`,
        pic: p.collaborators.length ? Overview.crews(crewsOf(p.collaborators, ctx), { most: 3 }) : '',
        note: esc(`from Adobe, not on the team${morePeople > 0 ? `; ${morePeople} more posted less` : ''}`),
      },
    ], { cls: 'tv-team' });
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
      name: link(ctx.topicHref(`person:${m.id}`), esc(m.name || 'Someone'), { title: 'Open on the Topics page' }),
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
    return `<section class="tv-sec" aria-labelledby="tvPeople"><h2 id="tvPeople">People <span class="sub">${esc(plural(p.members.length, 'member'))}</span></h2>
      ${p.members.length ? `${cards ? `<div class="tv-people">${cards}</div>` : ''}${rest}` : '<div class="empty">Nobody is on this team yet.</div>'}</section>`;
  }

  function customers(p, ctx) {
    const byId = new Map(p.members.map((m) => [m.id, m]));
    const rows = p.customers.map((c) => ({
      n: c.messages,
      of: c.messages ? c.staff / c.messages : 0,
      lead: ctx.orgIcon(c.slug, c.icon),
      name: link(ctx.orgHref(c.slug), esc(ctx.orgName(c.slug, c.name))),
      sub: `${c.type !== 'customer' ? `${esc(c.type)}, ` : ''}${esc(`${plural(c.threads, 'thread')}, ${c.messages ? Math.round((100 * c.staff) / c.messages) : 0}% by Adobe`)}${c.last ? `, ${esc(ago(c.last))}` : ''}`,
      weekly: c.weekly,
      tail: `<span class="tv-faces">${c.members.map((id) => byId.get(id)).filter(Boolean).map((m) => `<span title="${esc(m.name)}">${face(m.name, m.avatar, 'small')}</span>`).join('')}</span>`,
    }));
    return `<section class="tv-sec" aria-labelledby="tvCustomers"><h2 id="tvCustomers">Top customers <span class="sub">${p.customerCount > p.customers.length ? `${p.customers.length} of ${p.customerCount}` : esc(plural(p.customerCount, 'customer'))}</span></h2>
      ${rows.length ? ranked(rows, p.weeks.length) : '<div class="empty">No customers in these weeks.</div>'}</section>`;
  }

  function collaborators(p, ctx) {
    const rows = p.collaborators.map((c) => ({
      n: c.messages,
      of: null,
      lead: face(c.name, c.avatar),
      tint: Person.tintOf(c.name),
      name: `<b>${esc(c.name || 'Someone')}</b>`,
      sub: [c.title ? esc(c.title) : '', c.last ? esc(`last ${ago(c.last)}`) : ''].filter(Boolean).join(', '),
      weekly: c.weekly,
      tail: Overview.teamChips(c.teams, ctx.teamHref),
    }));
    return `<section class="tv-sec" aria-labelledby="tvCollab"><h2 id="tvCollab">Top collaborators <span class="sub">${p.collaboratorCount > p.collaborators.length ? `${p.collaborators.length} of ${p.collaboratorCount}` : esc(plural(p.collaboratorCount, 'person', 'people'))}</span></h2>
      ${rows.length ? ranked(rows, p.weeks.length) : '<div class="empty">Nobody from outside the team posted in these weeks.</div>'}</section>`;
  }

  const TECH_TABS = [
    { id: 'all', label: 'All' },
    { id: 'followed', label: 'Followed' },
    { id: 'catalog', label: 'Catalog', hint: 'Products in the team\'s knowledge base' },
    { id: 'seen', label: 'Other', hint: 'Seen in the team\'s threads, not followed or in the catalog' },
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
        t.catalog ? 'in the catalog' : ''].filter(Boolean).join(', ');
      // And its Follow (ui/follow.js), with the team in its chevron (its count says whether the
      // team follows it) for whoever is on it or manages it.
      const button = ctx.follow?.({ kind: 'tech', id: t.tech, name: t.name }) || '';
      return `<li><span class="tv-name"><span class="tv-line">${name}${button}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
        <span class="tv-meter">${bar(t.threads / most)}<span class="sub">${esc(plural(t.threads, 'thread'))}</span></span>${spark(t.weekly, { cls: 'tech', label: `messages about ${t.name}, week by week` })}</li>`;
    };
    return Overview.layers(p.tech.filter((t) => techIn(t, tab)), p.layers, row);
  }

  function tech(p, ctx, tab) {
    const list = TECH_TABS.map((t) => ({ ...t, n: p.tech.filter((x) => techIn(x, t.id)).length }));
    return `<section class="tv-sec" aria-labelledby="tvTech"><h2 id="tvTech">Products and technologies</h2>
      ${Overview.tabs(list, tab, { label: 'Which technologies' })}
      <div class="tv-stack" id="tvTechRows">${techRows(p, ctx, tab)}</div></section>`;
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
      <section class="tv-sec tv-hero" aria-label="Activity">${stats(p, ctx)}${Overview.chart(p, { label: `Messages in ${p.team.name}'s threads` })}</section>
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
    ].filter(Boolean).join(', ');
  }

  function vendorRow(v, p, ctx) {
    const cases = v.cases.open ? [
      v.cases.them ? `<span class="tag tv-them" title="Open cases waiting on the vendor">${esc(plural(v.cases.them, 'waits', 'wait'))} on them</span>` : '',
      v.cases.us ? `<span class="tag tv-us" title="Open cases waiting on Adobe">${esc(plural(v.cases.us, 'waits', 'wait'))} on Adobe</span>` : '',
    ].join('') : '<span class="sub">no open case</span>';
    const a = v.answers;
    const answer = a.answered ? `<span class="tv-answer" title="Median time to the vendor's first answer"><b>${esc(Overview.wait(a.median))}</b><span class="sub">first answer</span></span>`
      : '<span class="tv-answer"><span class="sub">no answer yet</span></span>';
    let inbox = '';
    if (v.follows) inbox = '<span class="tag tv-follow" title="The vendor\'s channels are in the team\'s inbox">Followed</span>';
    else if (!v.inInbox && !v.channels) inbox = '<span class="sub" title="No channels in the inbox yet">no channel</span>';
    // The team's own Follow, in Follow's look (ui/follow.js); ui/admin.js sends it as Follow does.
    else if (!v.inInbox && p.may.follow) inbox = `<span class="fo"><span class="fo-follow"><button type="button" class="fo-b" aria-pressed="false" data-follow="${esc(v.slug)}" title="Add the vendor's channels to the team's inbox">Follow</button></span></span>`;
    else if (!v.inInbox) inbox = '<span class="sub" title="The team\'s managers can follow this vendor">not in the inbox</span>';
    return `<li>${ctx.orgIcon(v.slug, v.icon)}
      <span class="tv-name"><a href="${esc(ctx.orgHref(v.slug))}">${esc(ctx.orgName(v.slug, v.name))}</a><span class="sub">${esc(relation(v) || 'no channels here')}${v.last ? `, ${esc(ago(v.last))}` : ''}</span></span>
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
      { label: `${num(p.vendors.length)} ${p.vendors.length === 1 ? 'vendor' : 'vendors'}`, note: esc(`${inInbox} in the inbox`) },
      { label: `${num(open)} open ${open === 1 ? 'case' : 'cases'}`, note: esc(`${them} waiting on the vendor`) },
      { label: `${num(p.waitingCount)} waiting on a vendor` },
      { label: `${num(p.oursCount)} waiting on Adobe` },
    ]);
    const list = p.vendors.length ? `<ol class="tv-vendors">${p.vendors.map((v) => vendorRow(v, p, ctx)).join('')}</ol>`
      : '<div class="empty">No vendors yet.</div>';
    const orgName = (slug) => ctx.orgName(slug, null);
    return `<div class="tv">
      <section class="tv-sec tv-hero" aria-label="Vendors">${numbers}</section>
      <div class="tv-two">
        <section class="tv-sec" aria-labelledby="tvWaiting"><h2 id="tvWaiting">Waiting on a vendor <span class="sub">${esc(plural(p.waitingCount, 'thread'))}</span></h2>
          ${Overview.threads(p.waiting, {
    hidden: p.waitingHidden, withOrg: true, orgName, empty: 'Nothing in the team\'s inbox waits on a vendor.',
  })}</section>
        <section class="tv-sec" aria-labelledby="tvOurs"><h2 id="tvOurs">Waiting on Adobe <span class="sub">${esc(plural(p.oursCount, 'case'))}</span></h2>
          ${Overview.threads(p.ours, {
    hidden: p.oursHidden, withOrg: true, orgName, empty: 'No vendor waits on Adobe.',
  })}</section>
      </div>
      <section class="tv-sec" aria-labelledby="tvVendors"><h2 id="tvVendors">Vendors <span class="sub">${esc(plural(p.vendors.length, 'vendor'))}</span></h2>
        ${list}</section>
    </div>`;
  }

  return { html, wire, vendors };
})();
