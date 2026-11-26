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
 * - Its numbers, each over a drawing of its own: its people's faces (a partner's ringed), who
 *   carries the conversation (its side against Adobe's), its threads' weeks as cells, every first
 *   answer of Adobe's a dot (the median a line), and Adobe's people by the team of theirs that
 *   works it most.
 * - Its threads, week by week, under them: a stacked bar chart of what was said, broken down by
 *   the focus picked above it (who said it, which of its people, the team a thread is filed
 *   under, its area, its product or its channel).
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
 * A vendor's (`p.vendor`, src/vendors.js) is the other way round: Adobe is its customer. Its
 * numbers are its open cases (as tags, in the color of who has the next move), how soon it answers
 * what Adobe starts (a dot each), its status posts (a status page's weeks), the customers on its
 * products (the products, then their icons) and Adobe's people; under them its open cases
 * and its status posts, then the customers whose threads show its products, and those of their
 * threads that wait on a third party. Titles only of the threads the viewer works.
 *
 * A partner's (`p.partner`, src/partners.js `partnerNumbers`), an agency's or a system
 * integrator's, works for customers: its numbers are its customers (their icons, a confirmed one
 * ringed), its people (their faces), where they post (its channels against customers'), what
 * waits on Adobe (as tags) and how soon Adobe answers (a dot each), in its channels and in the
 * customers'; under them the
 * customers it works for (confirmed, likely, or where its people post) with what links them, what
 * waits on Adobe, and its people with where they post. A customer's lists its partners
 * (`p.partners`), each a link to its page, with what links them, and the public channels its
 * people posted in (`p.public`).
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
    { id: 'who', label: 'Who' },
    { id: 'people', label: 'Their people', hint: 'Without Adobe\'s messages' },
    { id: 'teams', label: 'Teams' },
    { id: 'areas', label: 'Topics' },
    { id: 'tech', label: 'Products' },
    { id: 'channels', label: 'Channels' },
  ];
  let focus = 'who';
  const focusOf = (p) => FOCUS.filter((f) => f.id === 'who' || (p.breakdowns?.[f.id] || []).length > 1);
  const partsOf = (p, id) => (p.breakdowns && p.breakdowns[id]) || [];
  const barsOf = (p, id) => {
    const f = FOCUS.find((x) => x.id === id) || FOCUS[0];
    return `${Overview.bars(p.weeks, partsOf(p, id), {
      label: `Messages in ${nameOf(p)}'s threads, by ${f.label.toLowerCase()}`,
      key: id === 'who' ? (x) => x.id : undefined,
    })}`;
  };

  function activity(p) {
    const shown = focusOf(p);
    const on = shown.some((f) => f.id === focus) ? focus : 'who';
    return `<div class="cv-activity">
      <div class="cv-head"><h2 id="cvActivity">Messages per week</h2>
        ${Overview.tabs(shown, on, { label: 'Broken down by', attr: 'data-focus' })}</div>
      <div id="cvBars">${barsOf(p, on)}</div>
    </div>`;
  }

  /** `p`'s name, as the page shows it: the one the admin team gave it, else its slug. */
  const nameOf = (p) => p.org.name || p.org.slug;
  const { num } = Overview;

  // ---- the numbers, each with a drawing of its own ------------------------------------------

  /** Who carries the conversation: the customer's side (partners too) against Adobe's. */
  function messagesTile(p) {
    const total = sum(p.activity.messages);
    const ours = sum(p.activity.staff);
    return {
      label: `${num(total)} ${total === 1 ? 'message' : 'messages'}`,
      pic: total ? Overview.balance([nameOf(p), total - ours], ['Adobe', ours]) : '',
      note: total ? '' : 'none in these weeks',
    };
  }

  /** How soon the first answer comes, every one a dot: Adobe's, or a vendor's to Adobe. */
  function answerTile(p) {
    const a = p.answers;
    const who = p.vendor ? nameOf(p) : 'Adobe';
    const what = p.vendor ? 'case' : 'thread';
    const started = p.vendor ? 'Adobe opened' : 'they started';
    if (!a.asked) {
      return {
        label: 'No first answer to time',
        note: esc(`no ${what} ${started} in these weeks`),
      };
    }
    const open = a.asked - a.answered;
    if (!a.answered) {
      return {
        cls: p.vendor ? '' : 'w3',
        label: `No first answer of ${esc(who)}'s yet`,
        note: esc(`in the ${plural(a.asked, what)} ${started}`),
      };
    }
    return {
      cls: p.vendor ? '' : 'w3',
      label: `${num(Overview.wait(a.median))} to ${esc(who)}'s first answer`,
      title: p.vendor ? 'Median time to the vendor\'s first answer, in cases Adobe opened'
        : 'Median time to Adobe\'s first answer, in threads the customer started',
      pic: a.answered ? Overview.waitDots(a.waits || [], a.median, { who }) : '',
      note: esc(`typically, in the ${plural(a.asked, what)} ${started}${open ? `; ${open} not answered yet` : ''}`),
    };
  }

  /**
   * Adobe's people in its threads, by team: each in the team of theirs that works the customer
   * most (`p.teams`), those on none last.
   */
  function staffTile(p, ctx) {
    const rank = new Map(p.teams.map((t, i) => [t.slug, i]));
    const groups = new Map();
    for (const c of p.staff) {
      const best = [...c.teams].sort((x, y) => (rank.get(x.slug) ?? 99) - (rank.get(y.slug) ?? 99))[0] || null;
      const key = best ? best.slug : '';
      if (!groups.has(key)) {
        groups.set(key, {
          name: best ? best.name : null, href: best ? ctx.teamHref(best.slug) : null, people: [], at: best ? rank.get(best.slug) ?? 98 : 99,
        });
      }
      groups.get(key).people.push({ name: c.name, avatar: c.avatar });
    }
    const list = [...groups.values()].sort((x, y) => x.at - y.at);
    const more = p.staffCount - p.staff.length;
    if (!p.staffCount) return { cls: p.vendor ? '' : 'w3', label: 'Nobody from Adobe posted', note: 'in these weeks' };
    return {
      cls: p.vendor ? '' : 'w3',
      label: `${num(p.staffCount)} from Adobe, on ${esc(plural(p.teamCount, 'team'))}`,
      pic: list.length ? Overview.crews(list) : '',
      note: more > 0 ? esc(`and ${plural(more, 'more person', 'more people')} who posted less`) : '',
    };
  }

  /** A vendor's numbers: its cases, how soon it answers, what of the customers' depends on it. */
  function vendorStats(p, ctx) {
    const { cases: c, status, dependents: d } = p.vendor;
    const latest = status.list[0];
    const icons = d.customers.slice(0, 8).map((x) => link(ctx.orgHref(x.slug), ctx.orgIcon(x.slug, x.icon), { cls: 'tv-icon', title: x.name || x.slug })).join('');
    const moreCustomers = d.customerCount - Math.min(8, d.customers.length);
    const products = d.products.slice(0, 3).map((t) => chip(t.name, t.threads, { cls: 'tech', href: ctx.topicHref(`product:tech:${t.tech}`) })).join('');
    return Overview.stats([
      {
        label: `${num(c.open)} open ${c.open === 1 ? 'case' : 'cases'}`,
        pic: c.list.length ? Overview.caseTags(c.list) : '',
        note: esc(c.open ? `${c.them} waiting on them, ${c.us} on Adobe${c.hidden ? `, ${c.hidden} in channels of teams you are not on` : ''}` : `Nothing is open with ${nameOf(p)}.`),
      },
      answerTile(p),
      messagesTile(p),
      {
        label: `${num(status.total)} status ${status.total === 1 ? 'post' : 'posts'}`,
        pic: Overview.statusWeeks(status.weekly, p.weeks),
        note: esc(latest ? `the latest ${ago(latest.at)}: ${latest.title || 'a status post'}` : 'none in these weeks'),
      },
      {
        label: `${num(d.customerCount)} ${d.customerCount === 1 ? 'customer' : 'customers'} on its products`,
        pic: d.customerCount ? `<span class="tv-flow">${products}${products && icons ? '<span class="tv-to" aria-hidden="true">→</span>' : ''}${icons}${moreCustomers > 0 ? `<span class="tv-pmore">+${moreCustomers}</span>` : ''}</span>` : '',
        note: esc(d.customerCount ? `in ${plural(d.threads, 'thread')}${d.waiting ? `, ${d.waiting} waiting on a third party` : ''}` : `no customer's thread shows a product of ${nameOf(p)}`),
      },
      staffTile(p, ctx),
    ]);
  }

  /** A partner's numbers: its customers and people, what waits on Adobe, how soon it answers. */
  function partnerStats(p, ctx) {
    const {
      customers: c, people: who, posts, waiting: w, answers: a,
    } = p.partner;
    const all = posts.own + posts.customers;
    const likely = c.linked - c.confirmed;
    const linked = c.list.filter((x) => x.linked);
    const icons = linked.slice(0, 8).map((x) => link(ctx.orgHref(x.slug), ctx.orgIcon(x.slug, x.icon), { cls: `tv-icon${x.confirmed ? ' confirmed' : ''}`, title: `${x.name || x.slug}, ${x.confirmed ? 'confirmed' : 'likely'}` })).join('');
    const answer = (x, { where, title }) => {
      if (!x.asked) return { label: `No first answer ${esc(where)} to time`, note: 'no thread started there in these weeks' };
      if (!x.answered) return { label: `No first answer of Adobe's ${esc(where)} yet`, note: esc(`in the ${plural(x.asked, 'thread')} started there`) };
      return {
        label: `${num(Overview.wait(x.median))} to Adobe's first answer ${esc(where)}`,
        title,
        pic: Overview.waitDots(x.waits || [], x.median),
        note: esc(`typically, in the ${plural(x.asked, 'thread')} started there${x.asked > x.answered ? `; ${x.asked - x.answered} not answered yet` : ''}`),
      };
    };
    return Overview.stats([
      {
        label: `${num(c.linked)} ${c.linked === 1 ? 'customer' : 'customers'}`,
        pic: icons ? `<span class="tv-flow">${icons}${linked.length > 8 ? `<span class="tv-pmore">+${linked.length - 8}</span>` : ''}</span>` : '',
        note: esc([c.confirmed ? `${c.confirmed} confirmed` : '', likely ? `${likely} likely` : '', c.count > c.linked ? `its people post for ${c.count - c.linked} more` : ''].filter(Boolean).join(', ') || 'none found yet'),
      },
      {
        label: `${num(who.count)} ${who.count === 1 ? 'person' : 'people'}`,
        pic: who.list.length ? Overview.faces(who.list.map((m) => ({ name: m.name, avatar: m.avatar })), { more: who.count - who.list.length }) : '',
        note: esc(who.count ? `${who.inCustomers} of them in customers' threads` : 'none known by their mail domain'),
      },
      {
        label: `${num(all)} ${all === 1 ? 'message' : 'messages'} by its people`,
        pic: all ? Overview.partsBar([
          { name: 'Its channels', n: posts.own, series: 's0' },
          { name: 'Customers\'', n: posts.customers, series: 's1' },
        ]) : '',
        note: esc(all ? `${Math.round((100 * posts.customers) / all)}% in customers' threads` : `none in the last ${p.weeks.length} weeks`),
      },
      {
        label: `${num(w.count)} waiting on Adobe`,
        pic: w.list.length ? Overview.caseTags(w.list) : '',
        note: esc(`${w.own} in its channels, ${w.customers} in customers'${w.hidden ? `, ${w.hidden} in channels of teams you are not on` : ''}`),
      },
      answer(a.own, { where: 'in its channels', title: 'Median time to Adobe\'s first answer, in threads started outside Adobe in its channels' }),
      answer(a.customers, { where: 'for customers', title: 'Median time to Adobe\'s first answer, in threads its people started in customers\' channels' }),
    ]);
  }

  function stats(p, ctx) {
    if (p.vendor) return vendorStats(p, ctx);
    if (p.partner) return partnerStats(p, ctx);
    const t = p.activity.threads;
    const partners = [...new Set(p.people.map((m) => m.partner).filter(Boolean))];
    let partnerNote = '';
    if (p.partnerCount) {
      const from = partners.length === 1 ? partners[0] : `${plural(partners.length || p.partnerCount, 'partner')}`;
      partnerNote = `<span class="tv-partner-k">${esc(`${p.partnerCount} from ${from}`)}</span>`;
    }
    const low = Math.min(...t);
    const high = Math.max(...t);
    return Overview.stats([
      {
        label: `${num(p.peopleCount)} ${p.peopleCount === 1 ? 'person' : 'people'} posted`,
        pic: p.people.length ? Overview.faces(p.people.map((m) => ({
          name: m.name, avatar: m.avatar, cls: m.partner ? 'partner' : '', title: m.partner ? `${m.name || 'Someone'}, of ${m.partner}` : m.name,
        })), { more: p.peopleCount - p.people.length }) : '',
        note: partnerNote || esc(`in the last ${p.weeks.length} weeks`),
      },
      messagesTile(p),
      {
        label: `${num(p.threadCount)} ${p.threadCount === 1 ? 'thread' : 'threads'}`,
        pic: Overview.strip(t, p.weeks),
        note: esc(`${Math.round(sum(t) / t.length)} active in a week${high > low ? `, from ${low} to ${high}` : ''}`),
      },
      answerTile(p),
      staffTile(p, ctx),
    ]);
  }

  function person(m, p, ctx) {
    const partner = m.partner ? `<span class="tag tv-partner" title="${esc(`Of ${m.partner}, a partner`)}">${esc(m.partner)}</span>` : '';
    // Drawn as a team's members are, and the inbox's profile card (ui/person.js): an area is
    // `tag:<id>` on the Topics page, a technology `product:tech:<id>`, a person `person:<id>`.
    // Their profile in its knowledge base (their Contact), as a team member's is on the team's; a
    // Contact without a description is a link at the card's foot.
    const href = m.profile && ctx.kbHref(m.profile.path);
    const profile = m.profile ? Person.profile([{
      team: p.org.slug, teamName: nameOf(p), description: m.profile.description, href,
    }]) : '';
    // Their Follow (ui/follow.js): a person of D1 by their id, a customer's by their account.
    let follow = null;
    if (m.id) follow = { kind: 'person', id: m.id, name: m.name };
    else if (m.account) follow = { kind: 'account', id: m.account, name: m.name || 'Someone' };
    const foot = href && !m.profile.description ? `<dl class="ps-keys"><dt>Contact</dt><dd><a class="tv-contact" href="${esc(href)}" title="Open their contact page">In the knowledge base</a></dd></dl>` : '';
    return Person.card(m, {
      face: face(m.name, m.avatar, 'big'),
      name: link(m.id ? ctx.topicHref(`person:${m.id}`) : null, esc(m.name || 'Someone'), { title: m.id ? 'Open on the Topics page' : '' }),
      badge: partner,
      title: m.title,
      weeks: p.weeks.length,
      label: 'Asks about',
      profile,
      foot,
      action: (follow && ctx.follow?.(follow)) || '',
      ctx,
    });
  }

  // ---- a vendor's ----------------------------------------------------------------------------

  function cases(p) {
    const c = p.vendor.cases;
    return `<section class="tv-sec" aria-labelledby="cvCases"><h2 id="cvCases">Open cases <span class="sub">${esc(`${c.them} waiting on them, ${c.us} on Adobe`)}</span></h2>
      ${Overview.threads(c.list, { hidden: c.hidden, empty: `Nothing is open with ${nameOf(p)}.` })}</section>`;
  }

  function statusPosts(p) {
    const s = p.vendor.status;
    const rows = s.list.map((x) => ({ ...x, last: x.at }));
    return `<section class="tv-sec" aria-labelledby="cvStatus"><h2 id="cvStatus">Status posts <span class="sub">${esc(plural(s.total, 'post'))}</span></h2>
      ${s.total ? `<div class="cv-status">${spark(s.weekly, { cls: 'status', label: 'status posts, week by week' })}<span class="sub">week by week, the last ${p.weeks.length} weeks</span></div>` : ''}
      ${Overview.threads(rows, { hidden: s.hidden, empty: 'No status post in these weeks.' })}</section>`;
  }

  function dependents(p, ctx) {
    const d = p.vendor.dependents;
    const rows = d.customers.map((c) => ({
      n: c.threads,
      count: plural(c.threads, 'thread'),
      lead: ctx.orgIcon(c.slug, c.icon),
      name: link(ctx.orgHref(c.slug), esc(c.name || c.slug)),
      sub: esc([c.type !== 'customer' ? c.type : '', c.last ? ago(c.last) : ''].filter(Boolean).join(', ')),
      tail: c.waiting ? `<span class="tag tv-them">${esc(plural(c.waiting, 'waits', 'wait'))} on a third party</span>` : '',
    }));
    const products = d.products.length ? `<p class="sub">${d.products.map((t) => chip(t.name, t.threads, { cls: 'tech', href: ctx.topicHref(`product:tech:${t.tech}`) })).join('')}</p>` : '';
    return `<section class="tv-sec" aria-labelledby="cvDepends"><h2 id="cvDepends">Customers using ${esc(nameOf(p))} <span class="sub">${d.customers.length < d.customerCount ? `${d.customers.length} of ${d.customerCount}` : esc(plural(d.customerCount, 'customer'))}</span></h2>
      ${products}
      ${rows.length ? ranked(rows, p.weeks.length) : `<div class="empty">No customer's thread shows a product of ${esc(nameOf(p))} in these weeks.</div>`}</section>`;
  }

  function thirdParty(p) {
    const d = p.vendor.dependents;
    return `<section class="tv-sec" aria-labelledby="cvThird"><h2 id="cvThird">Customers waiting on a third party <span class="sub">${esc(plural(d.waiting, 'thread'))}</span></h2>
      ${Overview.threads(d.list, {
    hidden: d.hidden, withOrg: true, orgName: (slug) => d.customers.find((c) => c.slug === slug)?.name || slug, empty: 'None of them waits on a third party.',
  })}</section>`;
  }

  // ---- partners: a partner's customers, a customer's partners --------------------------------

  /**
   * What links a customer and a partner, in words (src/orgpartners.js `partnerSignals`): the
   * count of each signal, as `GET /api/customers/partners` and the pages have them. `P` and `C`
   * are the partner's and the customer's possessive as the page says them ("its", "their").
   */
  const SIGNAL = {
    posters: (n, P, C) => `${P} people in ${n} of ${C} threads`,
    guests: (n, P, C) => `${C} people in ${n} of ${P} threads`,
    members: (n, P, C) => `${n} of ${P} people in ${C} channels`,
    owners: (n) => (n === 1 ? 'a site owner in common' : `${n} site owners in common`),
    kb: (n, P) => `named in ${plural(n, 'entry', 'entries')} of ${P} knowledge base`,
    place: () => 'a Slack Connect or Teams team in common',
    channel: (n) => (n === 1 ? 'a channel named for both' : `${n} channels named for both`),
  };
  /**
   * The words of `signals`, on a partner's page (`partner`) or a customer's; `posters` not where
   * the row's meter already counts its threads of these weeks with the partner's people.
   */
  const linkWords = (signals, { partner = false, counted = false } = {}) => {
    const [P, C] = partner ? ['its', 'their'] : ['their', 'its'];
    return Object.entries(signals || {}).filter(([k]) => SIGNAL[k] && !(counted && k === 'posters'))
      .map(([k, n]) => SIGNAL[k](n, P, C));
  };

  /** Whether the two work together: confirmed, likely as Clef says, or neither yet. */
  function linkTag(x) {
    if (x.confirmed) return '<span class="tag tv-confirmed" title="The admin team confirmed it">Confirmed</span>';
    if (x.linked) return `<span class="tag tv-likely" title="${esc(x.p === null ? 'Likely, from what links them' : `${Math.round(x.p * 100)}% likely, says Clef`)}">Likely</span>`;
    return '';
  }

  /**
   * For the admin team, a pair nothing links yet: its page in Likely partners (`ctx.review`), which
   * shows the evidence of any two orgs and confirms or dismisses them.
   */
  function review(x, customer, partner, ctx) {
    if (x.linked || !ctx.review) return '';
    return `<a class="tv-review" href="${esc(ctx.review(customer, partner))}" title="Open the pair in Likely partners: the evidence, Confirm and Dismiss">Review</a>`;
  }

  /** A partner's customers: those it works for, then those whose threads its people are in. */
  function partnerCustomers(p, ctx) {
    const c = p.partner.customers;
    const rows = c.list.map((x) => ({
      n: x.theirs,
      count: `${plural(x.theirs, 'thread')} with its people`,
      lead: ctx.orgIcon(x.slug, x.icon),
      name: link(ctx.orgHref(x.slug), esc(x.name || x.slug)),
      sub: esc([
        ...linkWords(x.signals, { partner: true, counted: x.theirs > 0 }),
        x.ours ? `their people in ${x.ours} of its threads` : '',
        !x.linked ? 'its people post there; not linked yet' : '',
        x.last ? ago(x.last) : '',
      ].filter(Boolean).join(', ')),
      tail: `${linkTag(x)}${x.waiting ? `<span class="tag tv-us">${esc(`${x.waiting} waiting on Adobe`)}</span>` : ''}${review(x, x.slug, p.org.slug, ctx)}`,
    }));
    const shown = c.list.length < c.count ? `${c.list.length} of ${c.count}` : plural(c.count, 'customer');
    return `<section class="tv-sec" aria-labelledby="cvCustomers"><h2 id="cvCustomers">Customers <span class="sub">${esc(shown)}</span></h2>
      ${rows.length ? ranked(rows, p.weeks.length) : `<div class="empty">No customer of ${esc(nameOf(p))} is known yet.</div>`}</section>`;
  }

  /** What waits on Adobe in a partner's channels and the customers' threads its people are in. */
  function partnerWaiting(p) {
    const w = p.partner.waiting;
    const names = new Map(p.partner.customers.list.map((c) => [c.slug, c.name || c.slug]));
    names.set(p.org.slug, nameOf(p));
    return `<section class="tv-sec" aria-labelledby="cvWaiting"><h2 id="cvWaiting">Waiting on Adobe <span class="sub">${esc(`${w.own} in its channels, ${w.customers} in customers'`)}</span></h2>
      ${Overview.threads(w.list, {
    hidden: w.hidden, withOrg: true, orgName: (slug) => names.get(slug) || slug, empty: `Nothing of ${nameOf(p)}'s waits on Adobe.`,
  })}</section>`;
  }

  /** A partner's people, wherever they post: in its channels, and in which customers'. */
  function partnerPeople(p, ctx) {
    const who = p.partner.people;
    const rows = who.list.map((m) => ({
      n: m.messages,
      of: m.messages ? m.customers / m.messages : null,
      lead: face(m.name, m.avatar),
      tint: Person.tintOf(m.name),
      name: link(m.id ? ctx.topicHref(`person:${m.id}`) : null, esc(m.name || 'Someone'), { title: m.id ? 'Open on the Topics page' : '' }),
      sub: esc([m.title, `${m.own} in its channels, ${m.customers} in customers'`, m.last ? `last ${ago(m.last)}` : ''].filter(Boolean).join(', ')),
      weekly: m.weekly,
      tail: m.orgs.map((o) => `<a class="ps-chip" href="${esc(ctx.orgHref(o.slug))}" title="${esc(plural(o.threads, 'thread'))}">${esc(o.name || o.slug)}</a>`).join('')
        + (m.orgCount > m.orgs.length ? `<span class="sub">${esc(`and ${m.orgCount - m.orgs.length} more`)}</span>` : ''),
    }));
    const shown = who.list.length < who.count ? `${who.list.length} of ${who.count}` : plural(who.count, 'person', 'people');
    return `<section class="tv-sec" aria-labelledby="cvWhere"><h2 id="cvWhere">Where its people post <span class="sub">${esc(shown)}</span></h2>
      <p class="sub">The people of its mail domains, in its channels and in customers' (a bar's left part).</p>
      ${rows.length ? ranked(rows, p.weeks.length) : `<div class="empty">Nobody of ${esc(nameOf(p))}'s mail domains posted in these weeks.</div>`}</section>`;
  }

  /** A customer's partners: those that work for it, and those whose people post in its threads. */
  function customerPartners(p, ctx) {
    const list = p.partners;
    const rows = list.map((x) => ({
      n: x.threads,
      count: `${plural(x.threads, 'thread')} with their people`,
      lead: ctx.orgIcon(x.slug, x.icon),
      name: link(ctx.orgHref(x.slug), esc(x.name || x.slug)),
      sub: esc([
        ...linkWords(x.signals, { counted: x.threads > 0 }),
        x.people ? `${plural(x.people, 'person', 'people')} of theirs posted in these weeks` : '',
        !x.linked ? 'not linked yet' : '',
      ].filter(Boolean).join(', ')),
      tail: `${linkTag(x)}${review(x, p.org.slug, x.slug, ctx)}`,
    }));
    return `<section class="tv-sec" aria-labelledby="cvPartners"><h2 id="cvPartners">Partners <span class="sub">${esc(plural(list.length, 'partner'))}</span></h2>
      ${rows.length ? ranked(rows, p.weeks.length) : `<div class="empty">No agency or system integrator is known to work for ${esc(nameOf(p))}.</div>`}</section>`;
  }

  /**
   * The public channels a customer's people posted in (`p.public`: a community's, an event's;
   * src/orgprofile.js), by their mail domain; none where they posted in none.
   */
  function publicChannels(p) {
    const rows = (p.public || []).map((c) => ({
      n: c.threads,
      count: `${plural(c.threads, 'thread')} with their people`,
      name: `<span>${esc(c.name ? `#${c.name}` : 'A channel')}</span>`,
      sub: esc([PLATFORM[c.source] || c.source, c.last ? ago(c.last) : ''].filter(Boolean).join(', ')),
    }));
    if (!rows.length) return '';
    return `<section class="tv-sec" aria-labelledby="cvPublic"><h2 id="cvPublic">In public channels <span class="sub">${esc(plural(rows.length, 'channel'))}</span></h2>
      <p class="sub">Community and event channels where people of ${esc(nameOf(p))}'s mail domains posted in these weeks. Their threads are in the inbox of whoever follows ${esc(nameOf(p))}.</p>
      ${ranked(rows, p.weeks.length)}</section>`;
  }

  function people(p, ctx) {
    const more = p.peopleCount - p.people.length;
    return `<section class="tv-sec" aria-labelledby="tvPeople"><h2 id="tvPeople">${p.partner ? 'People in its channels' : 'Their people'} <span class="sub">${esc(plural(p.peopleCount, 'person', 'people'))}</span></h2>
      ${p.people.length ? `<div class="tv-people">${p.people.map((m) => person(m, p, ctx)).join('')}</div>` : `<div class="empty">Nobody of ${esc(nameOf(p))} posted in these weeks.</div>`}
      ${more > 0 ? `<p class="sub tv-more">And ${esc(plural(more, 'more person', 'more people'))} who posted less.</p>` : ''}</section>`;
  }

  function staff(p, ctx) {
    const rows = p.staff.map((c) => ({
      n: c.messages,
      lead: face(c.name, c.avatar),
      tint: Person.tintOf(c.name),
      name: `<b>${esc(c.name || 'Someone')}</b>`,
      sub: [c.title ? esc(c.title) : '', c.last ? esc(`last ${ago(c.last)}`) : ''].filter(Boolean).join(', '),
      weekly: c.weekly,
      tail: Overview.teamChips(c.teams, ctx.teamHref),
    }));
    return `<section class="tv-sec" aria-labelledby="tvStaff"><h2 id="tvStaff">Adobe's people <span class="sub">${p.staffCount > p.staff.length ? `${p.staff.length} of ${p.staffCount}` : esc(plural(p.staffCount, 'person', 'people'))}</span></h2>
      ${rows.length ? ranked(rows, p.weeks.length) : '<div class="empty">Nobody from Adobe posted in these weeks.</div>'}</section>`;
  }

  function teams(p, ctx) {
    const rows = p.teams.map((t) => ({
      n: t.messages,
      name: link(ctx.teamHref(t.slug), esc(t.name)),
      sub: esc([
        t.people ? plural(t.people, 'person', 'people') : '',
        t.filed ? `${plural(t.filed, 'channel')} filed` : '',
        t.shared ? `${t.shared} shared` : '',
      ].filter(Boolean).join(', ') || 'no posts in these weeks'),
      weekly: t.weekly,
      tail: t.follows ? '<span class="tag tv-follow">Following</span>' : '',
    }));
    return `<section class="tv-sec" aria-labelledby="tvTeams"><h2 id="tvTeams">Teams <span class="sub">${p.teamCount > p.teams.length ? `${p.teams.length} of ${p.teamCount}` : esc(plural(p.teamCount, 'team'))}</span></h2>
      ${rows.length ? ranked(rows, p.weeks.length) : '<div class="empty">No teams yet.</div>'}</section>`;
  }

  function areas(p, ctx) {
    // Each a link to it on the Topics page, with its Follow (ui/follow.js).
    const rows = p.areas.map((a) => ({
      n: a.threads,
      count: plural(a.threads, 'thread'),
      name: `<span class="tv-line">${link(ctx.topicHref(`tag:${a.id}`), esc(a.name), { title: 'Open on the Topics page' })}${ctx.follow?.({ kind: 'area', id: a.id, name: a.name }) || ''}</span>`,
      weekly: a.weekly,
    }));
    return `<section class="tv-sec" aria-labelledby="tvAreas"><h2 id="tvAreas">${p.vendor ? 'What the cases are about' : 'What they ask about'}</h2>
      ${rows.length ? ranked(rows, p.weeks.length) : '<div class="empty">No topics yet.</div>'}</section>`;
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
      ].filter(Boolean).join(', ')),
      weekly: c.weekly,
      tail: c.archived ? '<span class="tag">Archived</span>' : '',
    }));
    return `<section class="tv-sec" aria-labelledby="tvChannels"><h2 id="tvChannels">Channels <span class="sub">${p.channelCount > p.channels.length ? `${p.channels.length} of ${p.channelCount}` : esc(plural(p.channelCount, 'channel'))}</span></h2>
      ${rows.length ? ranked(rows, p.weeks.length) : '<div class="empty">No channels yet.</div>'}</section>`;
  }

  const TECH_TABS = [
    { id: 'all', label: 'All' },
    { id: 'stack', label: 'Their stack', hint: 'From the stack diagram in the knowledge base' },
    { id: 'seen', label: 'Other', hint: 'Seen in their threads, not in the stack diagram' },
  ];
  const techIn = (t, tab) => tab === 'all' || (tab === 'stack' && t.stack) || (tab === 'seen' && !t.stack);

  function techRows(p, ctx, tab) {
    const most = Math.max(...p.tech.map((t) => t.threads), 1);
    const row = (t) => {
      // What it is, and that its stack drawing has it, under its name.
      const sub = [t.vendor !== t.name && t.vendor, t.kind && t.kind !== 'Product' ? t.kind.toLowerCase() : '',
        t.stack ? 'in their stack' : ''].filter(Boolean).join(', ');
      const href = t.tech ? ctx.topicHref(`product:tech:${t.tech}`) : null;
      const name = href ? `<a href="${esc(href)}" title="Open on the Topics page">${esc(t.name)}</a>` : esc(t.name);
      const button = (t.tech && ctx.follow?.({ kind: 'tech', id: t.tech, name: t.name })) || '';
      return `<li><span class="tv-name"><span class="tv-line">${name}${button}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
        <span class="tv-meter">${bar(t.threads / most)}<span class="sub">${esc(plural(t.threads, 'thread'))}</span></span>${spark(t.weekly, { cls: 'tech', label: `messages about ${t.name}, week by week` })}</li>`;
    };
    return Overview.layers(p.tech.filter((t) => techIn(t, tab)), p.layers, row);
  }

  function tech(p, ctx, tab) {
    // Without a stack drawing (or one the viewer may read), the tabs would pick nothing.
    const list = TECH_TABS.map((t) => ({ ...t, n: p.tech.filter((x) => techIn(x, t.id)).length }));
    return `<section class="tv-sec" aria-labelledby="tvTech"><h2 id="tvTech">Products and technologies</h2>
      ${p.stack ? Overview.tabs(list, tab, { label: 'Which technologies' }) : ''}
      <div class="tv-stack" id="tvTechRows">${techRows(p, ctx, tab)}</div></section>`;
  }

  // ---- the page -----------------------------------------------------------------------------

  /**
   * The overview of profile `p` (GET /api/customers/profile), as HTML. `ctx` links and names
   * what is elsewhere: `teamHref(slug)`, `teamName(slug)`, `kbHref(path)`, null where the
   * viewer may not open the knowledge base, `topicHref(id)`, a node of the Topics page, and for a
   * vendor's, a partner's and a customer's partners `orgHref(slug)` and `orgIcon(slug, icon)`
   * (HTML), another org's page and icon; for the admin team `review(customer, partner)`, the
   * address of a pair nothing links yet in Likely partners.
   */
  function html(p, ctx) {
    const shown = {
      ...p,
      channels: p.channels.map((c) => ({ ...c, teamName: ctx.teamName(c.team), sharedNames: c.shared.map(ctx.teamName) })),
    };
    return `<div class="tv">
      <section class="tv-sec tv-hero cv-hero" aria-labelledby="cvActivity">${stats(p, ctx)}${activity(p)}</section>
      ${p.vendor ? `<div class="tv-two">${cases(p)}${statusPosts(p)}</div>
      <div class="tv-two">${dependents(p, ctx)}${thirdParty(p)}</div>` : ''}
      ${p.partner ? `<div class="tv-two">${partnerCustomers(p, ctx)}${partnerWaiting(p)}</div>
      ${partnerPeople(p, ctx)}` : ''}
      ${people(p, ctx)}
      ${p.partners ? customerPartners(p, ctx) : ''}
      ${publicChannels(p)}
      <div class="tv-two">${staff(p, ctx)}${teams(p, ctx)}</div>
      <div class="tv-two">${areas(p, ctx)}${channels(shown)}</div>
      ${tech(p, ctx, 'all')}
      ${Overview.knowledge(p.kb, {
    name: nameOf(p),
    kbHref: ctx.kbHref,
    readers: 'Only the teams that work with this customer can read the entries.',
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
