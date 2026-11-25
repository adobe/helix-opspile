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
 * A customer's card (ui/inbox.js, "customer cards"): the person's card for a customer, on its
 * icon and its name wherever the inbox shows them (`data-org`). First what the inbox has of it,
 * its threads on the list, then its overview's numbers (GET /api/customers/profile), asked once
 * and kept a while; at its foot its profile in Customers, and the filter to its threads.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];
const css = SCRIPTS['spectrum-inbox.css'];
// eslint-disable-next-line no-new-func
new Function(SCRIPTS['person.js'])();
const { Person } = globalThis;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** A piece of the page's script, from `from` up to `to`, run in Node with these globals. */
function piece(from, to, expose, globals = {}) {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${js.slice(a, b)}\nreturn { ${expose} };`)(
    ...Object.values(globals),
  );
}

const NOW = Date.parse('2026-11-16T12:00:00Z');
const thread = (key, org, more = {}) => ({
  thread: key, org, org_name: 'ACME Corporation', customerDomain: 'acme.example', last_at: '2026-11-16T10:00:00Z', ...more,
});

/** The overview of ACME, as GET /api/customers/profile says it (src/orgprofile.js). */
const PROFILE = {
  org: {
    slug: 'acme', name: 'ACME Corporation', type: 'customer', icon: 'acme.example', domain: 'acme.example',
  },
  weeks: ['2026-10-26', '2026-11-02', '2026-11-09'],
  activity: { messages: [10, 20, 30], staff: [5, 10, 15], threads: [2, 3, 4] },
  threadCount: 9,
  answers: {
    by: 'adobe', asked: 6, answered: 6, median: 90,
  },
  people: [
    { name: 'Sam Reyes', avatar: null, title: 'Web lead' },
    { name: 'Jordan Pike', avatar: 'https://pics.example/jp.png', title: null },
  ],
  peopleCount: 4,
  teams: [{ slug: 'platform', name: 'Platform ops' }],
  areas: [{ id: 'cdn', name: 'Caching and delivery', threads: 5 }],
  tech: [
    { tech: 'fastly/cdn', name: 'Fastly', threads: 4 },
    { tech: 'akamai/cdn', name: 'Akamai', threads: 0 },
  ],
  channels: [{ name: 'aem-acme', last: '2026-11-16T09:00:00Z' }],
  channelCount: 2,
};

/** The card's script, over a page with `threads` listed; `answer` is what the API says. */
function page({ threads = [], answer = async () => PROFILE, open = null } = {}) {
  const asked = [];
  const calls = [];
  const state = {
    data: { threads }, cache: new Map(), sel: {}, not: {}, open,
  };
  const parts = piece('// ---------------------------------------------------------------- customer cards', '\nconst card = { el: null', 'cardOrg, orgHref, withOrg, orgOverview, orgOfDomain, orgLocal, waitWords, orgCardOverview, orgCardHtml, onlyOrg', {
    esc,
    state,
    Person,
    // Its Follow (ui/follow.js), as a stand-in that says what it was asked for.
    Follow: { button: ({ kind, id, name }) => `<span class="fo" data-fo="${kind}" data-fo-id="${id}">${esc(name)}</span>` },
    get: (path) => {
      asked.push(path);
      return answer(path);
    },
    orgName: (t) => t.org_name || t.org,
    orgIcon: (t) => t.org_icon || t.customerDomain || null,
    waitingOn: (t) => ({ us: 'Us', customer: 'Customer' }[t.waiting_on] || 'Nobody'),
    activityOf: (t) => String(t.last_at || ''),
    tile: (name) => `<span class="ico av">${esc(name[0])}</span>`,
    favImg: (d) => `<img src="/fav/${d}">`,
    hideCard: () => calls.push('hideCard'),
    render: () => calls.push('render'),
    toUrl: () => calls.push('toUrl'),
  });
  return {
    ...parts, state, asked, calls,
  };
}

/** After what the page does next. */
const settled = () => new Promise((r) => {
  setTimeout(r, 0);
});

describe('customer card', () => {
  it('is for a customer of its own, and its link is its overview in Customers', () => {
    const { cardOrg, orgHref, withOrg } = page();
    assert.equal(cardOrg('acme'), true);
    assert.equal(cardOrg('_unassigned'), false);
    assert.equal(cardOrg(null), false);
    assert.equal(orgHref('acme'), '/inbox/admin?tab=orgs&org=acme');
    // The first element shows the card, with an empty title so the row's tooltip does not cover it.
    assert.equal(withOrg('<span class="logo">A</span>', 'acme'), '<span data-org="acme" title="" class="logo">A</span>');
    assert.equal(withOrg('<span class="logo">A</span>', '_unassigned'), '<span class="logo">A</span>');
    assert.equal(withOrg('', 'acme'), '');
  });

  it('asks for the overview once, keeps it a while, and asks again after', async () => {
    const p = page();
    const first = p.orgOverview('acme', NOW);
    assert.equal(first.pending, true);
    assert.equal(p.orgOverview('acme', NOW + 10), first);
    await settled();
    const kept = p.orgOverview('acme', NOW + 1000);
    assert.deepEqual(kept.p, PROFILE);
    assert.deepEqual(p.asked, ['/api/customers/profile?org=acme']);
    p.orgOverview('acme', Date.now() + 6 * 60 * 1000);
    assert.equal(p.asked.length, 2);
  });

  it('shows what the inbox has when the overview cannot be read', async () => {
    const refused = async () => {
      throw new Error('the customers are for Adobe\'s people');
    };
    const p = page({ threads: [thread('t1', 'acme')], answer: refused });
    p.orgOverview('acme', NOW);
    await settled();
    const found = p.orgOverview('acme', NOW + 1);
    assert.equal(found.failed, true);
    const html = p.orgCardHtml('acme', p.orgLocal('acme'), found);
    assert.match(html, /<div class="nm">ACME Corporation<\/div>/);
    assert.match(html, /<dt>Here<\/dt><dd>1 thread<\/dd>/);
    assert.doesNotMatch(html, /ps-part|pending/);
    assert.match(html, /<a class="oc-act primary" href="\/inbox\/admin\?tab=orgs&amp;org=acme"[^>]*>Open profile<\/a>/);
  });

  it('finds the customer of a mail domain: the thread\'s, else one on the list whose icon it is', () => {
    const p = page({
      threads: [
        thread('t1', 'acme'),
        thread('t2', 'globex', { org_name: 'Globex', customerDomain: null, org_icon: 'globex.example' }),
        thread('t3', '_unassigned', { customerDomain: 'nobody.example' }),
        thread('t4', 'icon', { customerDomain: null, org_icon: 'https://icons.example/i.png' }),
      ],
    });
    assert.equal(p.orgOfDomain('ACME.example', 't1'), 'acme');
    assert.equal(p.orgOfDomain('globex.example', 't1'), 'globex');
    p.state.cache.set('t9', { data: { thread: { org: 'soylent', customerDomain: 'soylent.example' } } });
    assert.equal(p.orgOfDomain('soylent.example', 't9'), 'soylent');
    assert.equal(p.orgOfDomain('soylent.example', 't1'), null);
    assert.equal(p.orgOfDomain('nobody.example', 't1'), null);
    assert.equal(p.orgOfDomain('https://icons.example/i.png', 't1'), null);
    assert.equal(p.orgOfDomain('', 't1'), null);
    assert.equal(p.orgOfDomain('partner.example', 't1'), null);
    // Another thread's usual domain is no customer's: it may be a partner's who posts there most.
    assert.equal(p.orgOfDomain('acme.example', 't2'), null);
    assert.equal(p.orgOfDomain('acme.example', 't3'), null);
  });

  it('counts its threads on the list: waiting on Adobe, unread, and the latest', () => {
    const p = page({
      threads: [
        thread('t1', 'acme', { waiting_on: 'us', unread: true, last_at: '2026-11-16T08:00:00Z' }),
        thread('t2', 'acme', { waiting_on: 'customer', last_at: '2026-11-16T11:00:00Z' }),
        thread('t3', 'globex', { waiting_on: 'us', unread: true }),
      ],
    });
    assert.deepEqual(p.orgLocal('acme'), {
      name: 'ACME Corporation', icon: 'acme.example', type: null, threads: 2, us: 1, unread: 1, latest: '2026-11-16T11:00:00Z',
    });
    // A customer only the open thread has: its name and icon, no threads on the list.
    const open = {
      org: 'soylent', org_name: 'Soylent', org_icon: 'soylent.example', org_type: 'partner',
    };
    assert.deepEqual(p.orgLocal('soylent', open), {
      name: 'Soylent', icon: 'soylent.example', type: 'partner', threads: 0, us: 0, unread: 0, latest: null,
    });
    assert.equal(p.orgLocal('nobody').name, null);
  });

  it('says a wait as its overview does', () => {
    const { waitWords } = page();
    assert.equal(waitWords(null), null);
    assert.equal(waitWords(undefined), null);
    assert.equal(waitWords(0.2), '1 min');
    assert.equal(waitWords(42), '42 min');
    assert.equal(waitWords(90), '1.5 h');
    assert.equal(waitWords(120), '2 h');
    assert.equal(waitWords(15 * 60), '15 h');
    assert.equal(waitWords(72 * 60), '3 days');
  });

  it('draws the overview\'s part: how much, how soon, who and what about', () => {
    const { orgCardOverview } = page();
    assert.equal(orgCardOverview('ACME', null), '');
    assert.equal(orgCardOverview('ACME', { failed: true }), '');
    assert.equal(orgCardOverview('ACME', { pending: true }), '<div class="kb pending">Looking up its overview…</div>');
    const html = orgCardOverview('ACME', { p: PROFILE });
    assert.match(html, /^<div class="ps-part"><div class="ps-freq">/);
    assert.match(html, /60 messages in 9 threads/);
    assert.match(html, /<dt>Answered<\/dt><dd>by Adobe in 1\.5 h, typically<\/dd>/);
    assert.match(html, /<span class="av ps-av small" data-hue="\d" role="img" aria-label="Sam Reyes" title="Sam Reyes · Web lead">SR<\/span>/);
    assert.match(html, /aria-label="Jordan Pike" title="Jordan Pike">JP<img src="https:\/\/pics\.example\/jp\.png"/);
    assert.match(html, /<span class="oc-more">\+2<\/span>/);
    assert.match(html, /<a href="\/inbox\/admin\?tab=teams&amp;team=platform" title="Platform ops&#39;s overview in Teams">Platform ops<\/a>/);
    assert.match(html, /<dl class="ps-knows"><dt>Topics<\/dt><dd><a href="\/inbox\/topics\?sel=tag%3Acdn" class="ps-chip"/);
    assert.match(html, /<dt>Products<\/dt><dd><a href="\/inbox\/topics\?sel=product%3Atech%3Afastly%2Fcdn" class="ps-chip tech"/);
    // A technology in none of its threads is only in its drawing: not the card's.
    assert.doesNotMatch(html, /Akamai/);
  });

  it('says a vendor answers Adobe, and leaves out what its overview does not have', () => {
    const { orgCardOverview } = page();
    const vendor = {
      ...PROFILE, answers: { by: 'them', median: 30 }, people: [], teams: [], areas: [], tech: [],
    };
    const html = orgCardOverview('Initech', { p: vendor });
    assert.match(html, /<dt>Answers<\/dt><dd>Adobe in 30 min, typically<\/dd>/);
    assert.doesNotMatch(html, /People|Teams|ps-knows/);
    const quiet = {
      ...vendor, activity: { messages: [0, 0, 0] }, answers: {}, channels: [],
    };
    assert.equal(orgCardOverview('Initech', { p: quiet }), '');
    const bare = { org: {}, activity: {} };
    assert.equal(orgCardOverview('Initech', { p: bare }), '');
  });

  it('heads the card with its icon, name, channels and type, and where this thread is', () => {
    const p = page({ threads: [thread('t1', 'acme', { waiting_on: 'us', unread: true })] });
    const local = p.orgLocal('acme');
    const html = p.orgCardHtml('acme', local, { p: PROFILE }, { slug: 'acme', channel: 'aem-acme' }, { href: 'https://slack.example/t1', platform: 'Slack' });
    assert.match(html, /^<div class="top"><span class="logo oc-logo"><span class="ico av">A<\/span><img src="\/fav\/acme\.example"><\/span>/);
    assert.match(html, /<div class="ttl">2 channels · acme\.example<\/div>/);
    assert.match(html, /<span class="rel customer">Customer<\/span><span class="fo" data-fo="org" data-fo-id="acme">ACME Corporation<\/span>/);
    assert.match(html, /<dt>Here<\/dt><dd>1 thread · 1 waiting on us · 1 unread<\/dd>/);
    assert.match(html, /<dt>Channel<\/dt><dd>aem-acme <a href="https:\/\/slack\.example\/t1" target="_blank" rel="noopener" title="Open the thread in Slack">Open in Slack<\/a><\/dd>/);
    assert.match(html, /<dt>Active<\/dt><dd>/);
    assert.match(html, /<button type="button" class="oc-act" data-org-only="acme" title="Only ACME Corporation&#39;s threads in the inbox">Only its threads<\/button>/);
    // Another customer's thread says nothing of its channel; a vendor and a partner say so.
    const other = p.orgCardHtml('acme', local, null, { slug: 'globex', channel: 'aem-globex' });
    assert.doesNotMatch(other, /Channel|Open in/);
    assert.match(p.orgCardHtml('initech', { type: 'vendor', threads: 0 }, null), /<div class="nm">initech<\/div>(?!<div class="ttl">)[\s\S]*<span class="rel vendor">Vendor<\/span>/);
    assert.match(p.orgCardHtml('x', { type: 'partner', threads: 0 }, null), /<span class="rel partner">Partner<\/span>/);
    assert.match(p.orgCardHtml('x', { type: 'internal', threads: 0 }, null), /<span class="rel adobe">Internal<\/span>/);
    assert.doesNotMatch(p.orgCardHtml('x', { threads: 0 }, null, { slug: 'x', channel: 'aem-x' }), /Open in/);
  });

  it('picks only its threads in the filters, and all customers again once picked', () => {
    const p = page();
    p.state.not.customer = new Set(['acme', 'globex']);
    p.onlyOrg('acme');
    assert.deepEqual([...p.state.sel.customer], ['acme']);
    assert.deepEqual([...p.state.not.customer], ['globex']);
    assert.deepEqual(p.calls, ['hideCard', 'render', 'toUrl']);
    assert.match(p.orgCardHtml('acme', { threads: 0 }, null), /data-org-only="" title="Every customer&#39;s threads again">All customers<\/button>/);
    p.state.not.customer = new Set(['acme']);
    p.onlyOrg('acme');
    assert.equal(p.state.not.customer, undefined);
    p.onlyOrg('');
    assert.equal(p.state.sel.customer, undefined);
  });
});

describe('where the customer card shows', () => {
  it('shows on the header\'s icon, which keeps its link and drops its tooltip', () => {
    const src = js.slice(js.indexOf('function headSource('), js.indexOf('\n}\n', js.indexOf('function headSource(')));
    assert.match(src, /const org = cardOrg\(thread\.org\) \? ` data-org="\$\{esc\(thread\.org\)\}"` : '';/);
    assert.match(src, /<a class="src" href="\$\{esc\(link\)\}" target="_blank" rel="noopener"\$\{tip\}\$\{org\}/);
  });

  it('is the person\'s card: one element, the same timing, also by keyboard and touch', () => {
    assert.match(js, /const CARD_ON = '\[data-p\], \[data-org\]';/);
    assert.equal(js.match(/e\.target\.closest\(CARD_ON\)/g).length, 3);
    assert.match(js, /e\.target\.closest\?\.\(CARD_ON\)/);
    // Enter on the header's link opens it; on a row's customer it shows the card.
    assert.match(js, /e\.target\.closest\?\.\('\[data-p\], \[data-org\]\[role="button"\]'\)/);
    // A tap on a customer's icon in the filters still filters, on the header's still opens it.
    assert.match(js, /const taps = t && !\(t\.dataset\.org && t\.closest\('\.fr, a\[href\]'\)\);/);
    // A click on a picture asks the agent about its person, not on a customer's tile.
    assert.match(js, /t\?\.matches\('\.av\[data-p\]'\)/);
  });

  it('is over the filters, which stay out while it shows beside them', () => {
    assert.match(css, /\.pcard\.ocard \{ z-index: 31; \}/);
    assert.match(css, /#filters \{ position: fixed; z-index: 30;/);
    assert.match(js, /main\.classList\.add\('railopen'\);\n {4}card\.rail = true;/);
    assert.match(js, /if \(card\.rail\) document\.querySelector\('main'\)\?\.classList\.remove\('railopen'\);/);
  });

  it('leads from a person\'s card to their customer\'s profile', () => {
    const body = js.slice(js.indexOf('function cardHtml('), js.indexOf('// ---------------------------------------------------------------- customer cards'));
    assert.match(body, /cardOrg\(ctx\.slug\) \? `<a href="\$\{esc\(orgHref\(ctx\.slug\)\)\}" title="\$\{esc\(`\$\{ctx\.org\}'s profile in Customers`\)\}">/);
    assert.match(js, /thread: key \|\| null, slug: t\.org \|\| th\.org \|\| null,/);
  });
});
