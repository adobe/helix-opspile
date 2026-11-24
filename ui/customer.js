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
 * A customer's overview, the first section of its page in Customers (ui/admin.js draws the page
 * around it), as the global `CustomerView`: what GET /api/customers/profile says
 * (src/orgprofile.js) of the customer's last half year, for everyone at Adobe, drawn with
 * ui/overview.js (`Overview`) as a team's is (ui/team.js).
 *
 * - Its threads, week by week: a stacked bar chart of what was said, broken down by the focus
 *   picked above it (who said it, which of its people, the team a thread is filed under, its
 *   area, its product or its channel), beside its numbers: how many people it has, and how soon
 *   Adobe answers what they start.
 * - Its people: a card each, with their picture and title, a partner's marked, how often they
 *   post, what they ask about (Clef's areas and technologies of their threads) and their Contact
 *   in its knowledge base.
 * - Adobe's people in its threads, with their teams, and the teams that work it: whose people
 *   post there, which have its channels, and which follow it.
 * - What its threads are about (Clef's areas), and its channels, each ranked, with a line of
 *   their weeks.
 * - Its products and technologies, by the layer of a stack: those of its stack drawing and those
 *   Clef sees in its threads, which the tabs above them pick. Then its knowledge base by type,
 *   and its stack drawing where it has one.
 *
 * Everything in it is a name, a number or a picture, written escaped.
 */
globalThis.CustomerView = (() => {
  const {
    esc, face, plural, ago, link, spark, bar, chip, ranked,
  } = Overview;
  const sum = (list) => list.reduce((s, v) => s + v, 0);
  const PLATFORM = {
    slack: 'Slack', teams: 'Microsoft Teams', discord: 'Discord', portal: 'the portal',
  };

  // ---- the parts ----------------------------------------------------------------------------

  /**
   * The chart's breakdowns (`p.breakdowns`, src/orgprofile.js), which the tabs above it pick; the
   * one picked stays picked from one customer to the next. `who` has a color of its own per part.
   */
  const FOCUS = [
    { id: 'who', label: 'Who', hint: 'Who said it: their people, partners\' people in their threads, or Adobe\'s.' },
    { id: 'people', label: 'Their people', hint: 'What each of their people (and the partners\') said; Adobe\'s is left out.' },
    { id: 'teams', label: 'Teams', hint: 'Each thread under the team it is filed under.' },
    { id: 'areas', label: 'Topics', hint: 'Each thread under the likeliest of Clef\'s areas of it.' },
    { id: 'tech', label: 'Products', hint: 'Each thread under the technology Clef is surest it shows.' },
    { id: 'channels', label: 'Channels', hint: 'Each thread under its channel.' },
  ];
  let focus = 'who';
  const focusOf = (p) => FOCUS.filter((f) => f.id === 'who' || (p.breakdowns?.[f.id] || []).length > 1);
  const partsOf = (p, id) => (p.breakdowns && p.breakdowns[id]) || [];
  const barsOf = (p, id) => {
    const f = FOCUS.find((x) => x.id === id) || FOCUS[0];
    return `${Overview.bars(p.weeks, partsOf(p, id), {
      label: `Messages in ${nameOf(p)}'s threads, by ${f.label.toLowerCase()}`,
      key: id === 'who' ? (x) => x.id : undefined,
    })}<p class="hint">Messages a week. ${esc(f.hint)}</p>`;
  };

  function activity(p) {
    const shown = focusOf(p);
    const on = shown.some((f) => f.id === focus) ? focus : 'who';
    return `<div class="cv-activity">
      <div class="cv-head"><h2 id="cvActivity">What was said, week by week</h2>
        ${Overview.tabs(shown, on, { label: 'Broken down by', attr: 'data-focus' })}</div>
      <div id="cvBars">${barsOf(p, on)}</div>
    </div>`;
  }

  /** `p`'s name, as the page shows it: the one the admin team gave it, else its slug. */
  const nameOf = (p) => p.org.name || p.org.slug;

  function stats(p) {
    const total = sum(p.activity.messages);
    const ours = sum(p.activity.staff);
    const threads = sum(p.activity.threads);
    const a = p.answers;
    const answered = a.asked ? `${a.answered} of the ${plural(a.asked, 'thread')} they started` : 'no thread of theirs started in these weeks';
    return Overview.stats([
      [p.peopleCount, p.peopleCount === 1 ? 'person' : 'people', p.partnerCount ? `posted, ${p.partnerCount} of them from ${p.partnerCount === 1 ? 'a partner' : 'partners'}` : `posted in the last ${p.weeks.length} weeks`],
      [total, total === 1 ? 'message' : 'messages', total ? `${Math.round((100 * ours) / total)}% by Adobe` : ''],
      [p.threadCount, p.threadCount === 1 ? 'thread' : 'threads', `${Math.round(threads / p.weeks.length)} active in a week`],
      [Overview.wait(a.median), 'first answer', a.answered ? `typically; ${answered}` : answered,
        'How long Adobe\'s first post took in the threads its people started, the middle of them'],
      [p.staffCount, p.staffCount === 1 ? 'person from Adobe' : 'people from Adobe', `on ${plural(p.teamCount, 'team')}`],
    ]);
  }

  function person(m, p, ctx) {
    const partner = m.partner ? `<span class="tag tv-partner" title="${esc(`Of ${m.partner}, a partner`)}">${esc(m.partner)}</span>` : '';
    // Drawn as a team's members are, and the inbox's profile card (ui/person.js): an area is
    // `tag:<id>` on the Topics page, a technology `product:tech:<id>`, a person `person:<id>`.
    const knows = [
      m.areas.length ? `<dt>Asks about</dt><dd>${m.areas.map((a) => chip(a.name, a.threads, { href: ctx.topicHref(`tag:${a.id}`) })).join('')}</dd>` : '',
      m.tech.length ? `<dt>Products</dt><dd>${m.tech.map((t) => chip(t.name, t.threads, { cls: 'tech', href: ctx.topicHref(`product:tech:${t.id}`) })).join('')}</dd>` : '',
    ].join('');
    // Their profile in its knowledge base (their Contact) under who they are, as a team member's
    // is on the team's; a Contact without a description is a link at the card's foot.
    const href = m.profile && ctx.kbHref(m.profile.path);
    const profile = m.profile ? Person.profile([{
      team: p.org.slug, teamName: nameOf(p), description: m.profile.description, href,
    }]) : '';
    const keys = href && !m.profile.description ? `<dl class="ps-keys"><dt>Contact</dt><dd><a class="tv-contact" href="${esc(href)}" title="Their Contact in the knowledge base">In the knowledge base</a></dd></dl>` : '';
    const name = link(m.id ? ctx.topicHref(`person:${m.id}`) : null, esc(m.name || 'Someone'), { title: m.id ? 'Their topics and products on the Topics page' : '' });
    return `<article class="tv-person ps-card">
      <header>${face(m.name, m.avatar, 'big')}<div class="who"><b>${name}</b>${partner}${m.title ? `<span class="sub">${esc(m.title)}</span>` : ''}</div></header>
      ${profile}
      ${Person.freq(m.name, m, p.weeks.length)}
      ${knows ? `<dl class="ps-knows">${knows}</dl>` : '<p class="sub tv-none">Nothing Clef tagged in their threads yet.</p>'}
      ${keys}
    </article>`;
  }

  function people(p, ctx) {
    const more = p.peopleCount - p.people.length;
    return `<section class="tv-sec" aria-labelledby="tvPeople"><h2 id="tvPeople">Their people <span class="sub">${esc(plural(p.peopleCount, 'person', 'people'))} posted, the busiest first</span></h2>
      ${p.people.length ? `<div class="tv-people">${p.people.map((m) => person(m, p, ctx)).join('')}</div>` : `<div class="empty">Nobody of ${esc(nameOf(p))} posted in these weeks.</div>`}
      ${more > 0 ? `<p class="sub tv-more">And ${esc(plural(more, 'more person', 'more people'))} who posted less.</p>` : ''}
      <p class="hint">Its people and the partners' who posted in its threads, the last ${p.weeks.length} weeks. What they ask about is Clef's areas and technologies of their threads, those they have more of than the rest of them first.</p></section>`;
  }

  function staff(p, ctx) {
    const rows = p.staff.map((c) => ({
      n: c.messages,
      lead: face(c.name, c.avatar),
      name: `<b>${esc(c.name || 'Someone')}</b>`,
      sub: [c.title ? esc(c.title) : '', c.last ? esc(`last ${ago(c.last)}`) : ''].filter(Boolean).join(' · '),
      weekly: c.weekly,
      tail: Overview.teamChips(c.teams, ctx.teamHref),
    }));
    return `<section class="tv-sec" aria-labelledby="tvStaff"><h2 id="tvStaff">Adobe's people <span class="sub">${p.staffCount > p.staff.length ? `${p.staff.length} of ${p.staffCount}` : esc(plural(p.staffCount, 'person', 'people'))}</span></h2>
      ${rows.length ? ranked(rows, p.weeks.length) : '<div class="empty">Nobody of Adobe posted in its threads in these weeks.</div>'}
      <p class="hint">Who of Adobe posted in its threads, by what they said there, with the teams they are on.</p></section>`;
  }

  function teams(p, ctx) {
    const rows = p.teams.map((t) => ({
      n: t.messages,
      name: link(ctx.teamHref(t.slug), esc(t.name)),
      sub: esc([
        t.people ? plural(t.people, 'person', 'people') : '',
        t.filed ? `${plural(t.filed, 'channel')} filed` : '',
        t.shared ? `${t.shared} shared` : '',
      ].filter(Boolean).join(' · ') || 'no post in these weeks'),
      weekly: t.weekly,
      tail: t.follows ? '<span class="tag tv-follow" title="Every channel of the customer is in the team\'s inbox, shared, now and later">Follows it</span>' : '',
    }));
    return `<section class="tv-sec" aria-labelledby="tvTeams"><h2 id="tvTeams">Teams <span class="sub">${p.teamCount > p.teams.length ? `${p.teams.length} of ${p.teamCount}` : esc(plural(p.teamCount, 'team'))}</span></h2>
      ${rows.length ? ranked(rows, p.weeks.length) : '<div class="empty">No team works with it yet.</div>'}
      <p class="hint">The ops teams whose people post in its threads, by what they said there, and those its channels are filed under or shared with, or that follow it.</p></section>`;
  }

  function areas(p) {
    const rows = p.areas.map((a) => ({
      n: a.threads,
      count: plural(a.threads, 'thread'),
      name: esc(a.name),
      weekly: a.weekly,
    }));
    return `<section class="tv-sec" aria-labelledby="tvAreas"><h2 id="tvAreas">What they ask about</h2>
      ${rows.length ? ranked(rows, p.weeks.length) : '<div class="empty">Clef has not tagged its threads of these weeks yet.</div>'}
      <p class="hint">Clef's areas of its threads, by how many of them are about one; the line is what was said in them week by week.</p></section>`;
  }

  function channels(p) {
    const rows = p.channels.map((c) => ({
      n: c.messages,
      of: null,
      name: `<span>${esc(c.name ? `#${c.name}` : 'A channel')}</span>`,
      sub: esc([
        PLATFORM[c.source] || c.source,
        `filed under ${c.teamName}`,
        c.shared.length ? `shared with ${c.sharedNames.join(', ')}` : '',
        c.last ? ago(c.last) : '',
      ].filter(Boolean).join(' · ')),
      weekly: c.weekly,
      tail: c.archived ? '<span class="tag">Archived</span>' : '',
    }));
    return `<section class="tv-sec" aria-labelledby="tvChannels"><h2 id="tvChannels">Channels <span class="sub">${p.channelCount > p.channels.length ? `${p.channels.length} of ${p.channelCount}` : esc(plural(p.channelCount, 'channel'))}</span></h2>
      ${rows.length ? ranked(rows, p.weeks.length) : '<div class="empty">No channel is filed under it.</div>'}
      <p class="hint">By what was said in them in these weeks, with the team each is filed under.</p></section>`;
  }

  const TECH_TABS = [
    { id: 'all', label: 'All' },
    { id: 'stack', label: 'Their stack', hint: 'The parts of its stack drawing, in its knowledge base' },
    { id: 'seen', label: 'In their threads', hint: 'What else Clef sees most in its threads' },
  ];
  const techIn = (t, tab) => tab === 'all' || (tab === 'stack' && t.stack) || (tab === 'seen' && !t.stack);

  function techRows(p, ctx, tab) {
    const most = Math.max(...p.tech.map((t) => t.threads), 1);
    const row = (t) => {
      // What it is, and that its stack drawing has it, under its name.
      const sub = [t.vendor !== t.name && t.vendor, t.kind && t.kind !== 'Product' ? t.kind.toLowerCase() : '',
        t.stack ? 'in their stack' : ''].filter(Boolean).join(' · ');
      const href = t.tech ? ctx.topicHref(`product:tech:${t.tech}`) : null;
      const name = href ? `<a href="${esc(href)}" title="Open it on the Topics page">${esc(t.name)}</a>` : esc(t.name);
      return `<li><span class="tv-name"><span class="tv-line">${name}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
        <span class="tv-meter">${bar(t.threads / most)}<span class="sub">${esc(plural(t.threads, 'thread'))}</span></span>${spark(t.weekly, { cls: 'tech', label: 'messages in its threads, week by week' })}</li>`;
    };
    return Overview.layers(p.tech.filter((t) => techIn(t, tab)), p.layers, row);
  }

  function tech(p, ctx, tab) {
    // Without a stack drawing (or one the viewer may read), the tabs would pick nothing.
    const list = TECH_TABS.map((t) => ({ ...t, n: p.tech.filter((x) => techIn(x, t.id)).length }));
    return `<section class="tv-sec" aria-labelledby="tvTech"><h2 id="tvTech">Products and technologies</h2>
      ${p.stack ? Overview.tabs(list, tab, { label: 'Which technologies' }) : ''}
      <div class="tv-stack" id="tvTechRows">${techRows(p, ctx, tab)}</div>
      <p class="hint">By the layer of its stack they are in. The count is its threads Clef sees one in, the line what was said in them week by week.</p></section>`;
  }

  // ---- the page -----------------------------------------------------------------------------

  /**
   * The overview of profile `p` (GET /api/customers/profile), as HTML. `ctx` links and names
   * what is elsewhere: `teamHref(slug)`, `teamName(slug)`, `kbHref(path)`, null where the
   * viewer may not open the knowledge base, and `topicHref(id)`, a node of the Topics page.
   */
  function html(p, ctx) {
    const shown = {
      ...p,
      channels: p.channels.map((c) => ({ ...c, teamName: ctx.teamName(c.team), sharedNames: c.shared.map(ctx.teamName) })),
    };
    return `<div class="tv">
      <section class="tv-sec tv-hero cv-hero" aria-labelledby="cvActivity">${stats(p)}${activity(p)}</section>
      ${people(p, ctx)}
      <div class="tv-two">${staff(p, ctx)}${teams(p, ctx)}</div>
      <div class="tv-two">${areas(p)}${channels(shown)}</div>
      ${tech(p, ctx, 'all')}
      ${Overview.knowledge(p.kb, {
    name: nameOf(p),
    kbHref: ctx.kbHref,
    readers: 'The teams that work with it read the entries themselves.',
  })}
    </div>`;
  }

  /** What the overview does in `el`: the chart's weeks under the pointer, the tabs of the technologies. */
  function wire(el, p, ctx) {
    Overview.wire(el, p, { onTab: (b) => { el.querySelector('#tvTechRows').innerHTML = techRows(p, ctx, b.dataset.tab); } });
    const on = focusOf(p).some((f) => f.id === focus) ? focus : 'who';
    Overview.wireBars(el.querySelector('#cvBars'), p.weeks, partsOf(p, on));
    const pick = (b) => {
      focus = b.dataset.focus;
      for (const x of el.querySelectorAll('[data-focus]')) x.setAttribute('aria-selected', String(x === b));
      const slot = el.querySelector('#cvBars');
      slot.innerHTML = barsOf(p, b.dataset.focus);
      Overview.wireBars(slot, p.weeks, partsOf(p, b.dataset.focus));
    };
    for (const b of el.querySelectorAll('[data-focus]')) b.onclick = () => pick(b);
  }

  return { html, wire };
})();
