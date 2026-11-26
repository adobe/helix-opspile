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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

// As the page loads them: a person's parts (ui/person.js), what the overviews are drawn with
// (ui/overview.js), then the customer's overview.
// eslint-disable-next-line no-new-func
const CustomerView = new Function('globalThis', `${SCRIPTS['person.js']}\nconst { Person } = globalThis;\n${SCRIPTS['overview.js']}\nconst { Overview } = globalThis;\n${SCRIPTS['customer.js']}\nreturn globalThis.CustomerView;`)({});

// Made-up people, customers and technologies only.
const weeks = ['2026-11-16', '2026-11-23'];
const person = (over) => ({
  id: 5,
  name: 'Sam <Reyes>',
  avatar: null,
  title: 'Web lead',
  partner: null,
  messages: 7,
  threads: 2,
  weekly: [3, 4],
  last: '2026-11-24T00:00:00Z',
  areas: [{
    id: 'cdn', name: 'Caching', n: 5, threads: 2,
  }],
  tech: [{
    id: 'fastly', name: 'Fastly', n: 5, threads: 2,
  }],
  profile: { path: 'contacts/sam-reyes.md', description: 'Owns the <launch> date.' },
  ...over,
});
const profile = {
  org: {
    slug: 'acme', name: 'ACME', type: 'customer', icon: null, domain: null, channels: 1,
  },
  weeks,
  layers: [{ id: 'edge', name: 'Edge' }],
  activity: { messages: [3, 4], staff: [2, 2], threads: [1, 2] },
  breakdowns: {
    who: [{
      id: 'theirs', name: 'Their people', weekly: [1, 2], n: 3,
    }, {
      id: 'adobe', name: 'Adobe', weekly: [2, 2], n: 4,
    }],
    people: [{
      id: 'p:5', name: 'Sam <Reyes>', weekly: [1, 2], n: 3,
    }],
    teams: [{
      id: 'edge', name: 'Edge ops', weekly: [2, 0], n: 2,
    }, {
      id: null, name: 'Other', weekly: [1, 4], n: 5,
    }],
    areas: [],
    tech: [],
    channels: [],
  },
  threadCount: 2,
  answers: { asked: 2, answered: 2, median: 75 },
  people: [person(), person({
    id: null, name: 'Pat', partner: 'Agency Co', profile: { path: 'contacts/pat.md', description: null }, areas: [], tech: [],
  })],
  peopleCount: 2,
  partnerCount: 1,
  staff: [],
  staffCount: 0,
  teams: [],
  teamCount: 0,
  areas: [],
  channels: [],
  channelCount: 0,
  tech: [{
    tech: 'fastly', name: 'Fastly', vendor: 'Fastly', kind: 'Product', layer: 'edge', stack: true, threads: 2, weekly: [1, 1],
  }, {
    tech: null, name: 'Their ERP', vendor: null, kind: null, layer: 'edge', stack: true, threads: 0, weekly: [0, 0],
  }],
  stack: true,
  kb: null,
};
const ctx = {
  teamHref: (slug) => `/team/${slug}`,
  teamName: (slug) => slug,
  kbHref: (path) => `/kb/${path}`,
  topicHref: (id) => `/inbox/topics?${new URLSearchParams({ sel: id })}`,
};

describe('a customer\'s overview, drawn', () => {
  it('links its people\'s areas, products and names to the Topics page, with their profile', () => {
    const html = CustomerView.html(profile, ctx);
    const card = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    assert.match(card, /<a href="\/inbox\/topics\?sel=tag%3Acdn" class="ps-chip"[^>]*>Caching<\/a>/);
    assert.match(card, /<a href="\/inbox\/topics\?sel=product%3Atech%3Afastly" class="ps-chip tech"/);
    assert.match(card, /<b><a href="\/inbox\/topics\?sel=person%3A5"[^>]*>Sam &lt;Reyes&gt;<\/a><\/b>/);
    // Their profile (their Contact in its knowledge base) after what every card has, as a team
    // member's.
    assert.match(card, /<div class="ps-profile">\s*<p>Owns the &lt;launch&gt; date\.<\/p><a href="\/kb\/contacts\/sam-reyes\.md" class="ps-src"[^>]*>Profile on ACME<\/a><\/div>/);
    assert.ok(card.indexOf('ps-freq') < card.indexOf('ps-profile'));
    assert.ok(!card.includes('ps-keys'));
    assert.match(card, /<dt>Asks about<\/dt>/);
  });

  it('marks a partner\'s person, and leaves a name without a person unlinked', () => {
    const html = CustomerView.html(profile, ctx);
    const card = html.slice(html.lastIndexOf('<article'));
    assert.match(card, /<b><span>Pat<\/span><\/b><span class="tag tv-partner"[^>]*>Agency Co<\/span>/);
    // A Contact without a description: a link at the card's foot.
    assert.match(card, /<dl class="ps-keys"><dt>Contact<\/dt><dd><a class="tv-contact" href="\/kb\/contacts\/pat\.md"/);
  });

  it('lists its stack\'s parts by layer, those Clef knows linked to the Topics page', () => {
    const html = CustomerView.html(profile, ctx);
    assert.match(html, /<a href="\/inbox\/topics\?sel=product%3Atech%3Afastly"[^>]*>Fastly<\/a>/);
    assert.match(html, /<span class="tv-line">Their ERP<\/span><span class="sub">in their stack<\/span>/);
    assert.match(html, /data-tab="stack" aria-selected="false"/);
  });

  it('stacks its weeks by who said it, and offers the breakdowns that have more than one part', () => {
    const html = CustomerView.html(profile, ctx);
    const tabs = [...html.matchAll(/data-focus="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(tabs, ['who', 'teams']);
    assert.match(html, /data-focus="who" aria-selected="true"/);
    // A bar a week, their people at the bottom, Adobe on them.
    const week = html.slice(html.indexOf('data-week="1"'), html.indexOf('</g>', html.indexOf('data-week="1"')));
    assert.deepEqual([...week.matchAll(/data-series="(\w+)"/g)].map((m) => m[1]), ['theirs', 'adobe']);
    assert.match(html, /<li data-part="1"[^>]*><span class="dot" data-series="adobe"><\/span><span class="nm">Adobe<\/span><span class="sub">4<\/span><\/li>/);
  });
});

describe('a vendor\'s overview, drawn', () => {
  const thread = (over) => ({
    thread: 't:1', org: 'cdnco', title: 'Purge <leaves> stale objects', channel: 'cdnco-support', urgency: 'high', kind: 'incident', waiting: 'vendor', third: false, last: '2026-11-24T00:00:00Z', team: 'edge', shared: [], inbox: '/inbox?team=edge&t=t%3A1', ...over,
  });
  const vendor = {
    ...profile,
    org: {
      ...profile.org, slug: 'cdnco', name: 'CDN Co', type: 'vendor',
    },
    answers: {
      by: 'them', asked: 3, answered: 2, median: 90,
    },
    vendor: {
      cases: {
        open: 2, them: 1, us: 1, list: [thread(), thread({ thread: 't:2', title: 'Send logs', waiting: 'us' })], hidden: 1,
      },
      status: {
        total: 1,
        weekly: [0, 1],
        list: [{
          thread: 't:s', title: 'Maintenance in FRA', at: '2026-11-23T00:00:00Z', inbox: '/inbox?team=edge&t=t%3As',
        }],
        hidden: 0,
      },
      dependents: {
        threads: 4,
        customerCount: 1,
        customers: [{
          slug: 'acme', name: 'ACME', type: 'customer', icon: null, threads: 4, waiting: 1, last: '2026-11-24T00:00:00Z',
        }],
        products: [{ tech: 'cdnco/cdn', name: 'CDN Co CDN', threads: 4 }],
        waiting: 1,
        list: [thread({
          thread: 't:c', org: 'acme', title: 'Stale pages', third: true, inbox: '/inbox?team=edge&t=t%3Ac',
        })],
        hidden: 0,
      },
    },
  };
  const vctx = { ...ctx, orgHref: (slug) => `/org/${slug}`, orgIcon: () => '' };

  it('counts its cases and how soon it answers, the other way round', () => {
    const html = CustomerView.html(vendor, vctx);
    assert.match(html, /<b>2<\/b><span>open cases<\/span><small>1 waiting on them, 1 on Adobe<\/small>/);
    assert.match(html, /title="Median time to the vendor&#39;s first answer[^"]*"><b>1\.5 h<\/b><span>first answer<\/span><small>typically; 2 of the 3 cases Adobe opened<\/small>/);
    assert.match(html, /<h2 id="tvAreas">What the cases are about<\/h2>/);
  });

  it('lists its open cases, status posts and the customers on its products, titles escaped', () => {
    const html = CustomerView.html(vendor, vctx);
    const cases = html.slice(html.indexOf('id="cvCases"'), html.indexOf('id="cvStatus"'));
    assert.match(cases, /<a href="\/inbox\?team=edge&amp;t=t%3A1" title="Open in the inbox">Purge &lt;leaves&gt; stale objects<\/a><span class="sub">#cdnco-support, high urgency, incident, [^<]+<\/span><\/span><span class="tag tv-them"[^>]*>Waiting on them<\/span>/);
    assert.match(cases, /<span class="tag tv-us"[^>]*>Waiting on Adobe<\/span>/);
    assert.match(cases, /And 1 more thread in channels of teams you are not on\./);
    assert.match(html, /Maintenance in FRA/);
    assert.match(html, /<a href="\/org\/acme">ACME<\/a>/);
    assert.match(html, /<span class="tag tv-them"[^>]*>1 waits on a third party<\/span>/);
    const third = html.slice(html.indexOf('id="cvThird"'));
    assert.match(third, /<span class="sub">ACME, #cdnco-support/);
    assert.match(third, /<span class="tag tv-them"[^>]*>Waiting on a third party<\/span>/);
  });

  it('is a customer\'s for a customer', () => {
    const html = CustomerView.html(profile, ctx);
    assert.ok(!html.includes('id="cvCases"'));
    assert.match(html, /Median time to Adobe&#39;s first answer/);
  });
});

describe('a partner\'s overview, and a customer\'s partners, drawn', () => {
  const thread = (over) => ({
    thread: 't:1', org: 'agency', title: 'Stale <code>', channel: 'agency-aem', urgency: 'high', kind: 'question', waiting: 'us', third: true, last: '2026-11-24T00:00:00Z', team: 'edge', shared: [], inbox: '/inbox?team=edge&t=t%3A1', ...over,
  });
  const customer = (over) => ({
    slug: 'acme', name: 'ACME <Corp>', type: 'customer', icon: null, linked: true, confirmed: false, p: 0.9, signals: { posters: 9, owners: 1 }, theirs: 9, people: 2, messages: 13, ours: 1, waiting: 1, last: '2026-11-24T00:00:00Z', ...over,
  });
  const partner = {
    ...profile,
    org: {
      ...profile.org, slug: 'agency', name: 'Agency Co', type: 'partner',
    },
    partner: {
      domains: 1,
      customers: {
        count: 3,
        linked: 2,
        confirmed: 1,
        list: [customer({
          slug: 'hooli', name: 'Hooli', confirmed: true, p: null, signals: { members: 2 }, ours: 0, waiting: 0,
        }), customer(), customer({
          slug: 'wonka', name: 'Wonka', linked: false, p: null, signals: {}, theirs: 1, ours: 0, waiting: 0,
        })],
      },
      people: {
        count: 1,
        inCustomers: 1,
        list: [{
          id: 7, account: null, name: 'Pia <B>', avatar: null, title: 'Developer', messages: 10, own: 4, customers: 6, threads: 5, orgs: [{ slug: 'acme', name: 'ACME <Corp>', threads: 3 }], orgCount: 2, weekly: [4, 6], last: '2026-11-24T00:00:00Z',
        }],
      },
      posts: {
        own: 4,
        customers: 6,
        ownThreads: 2,
        customerThreads: 3,
        weekly: { own: [2, 2], customers: [3, 3] },
      },
      waiting: {
        count: 3, own: 1, customers: 2, list: [thread(), thread({ thread: 't:2', org: 'acme', title: 'Forms' })], hidden: 1,
      },
      answers: {
        own: { asked: 2, answered: 1, median: 60 },
        customers: { asked: 4, answered: 3, median: 120 },
      },
    },
  };
  const pctx = { ...ctx, orgHref: (slug) => `/org/${slug}`, orgIcon: () => '' };

  it('counts its customers, people, what waits on Adobe and how soon Adobe answers', () => {
    const html = CustomerView.html(partner, pctx);
    assert.match(html, /<b>2<\/b><span>customers<\/span><small>1 confirmed, 1 likely, its people post for 1 more<\/small>/);
    assert.match(html, /<b>3<\/b><span>waiting on Adobe<\/span><small>1 in its channels, 2 in customers&#39;<\/small>/);
    assert.match(html, /<b>1 h<\/b><span>first answer<\/span>/);
    assert.match(html, /<b>2 h<\/b><span>first answer for customers<\/span><small>typically; 3 of the 4 threads its people started in customers&#39; channels<\/small>/);
    assert.match(html, /<b>10<\/b><span>messages<\/span><small>by its people, 60% in customers&#39; threads<\/small>/);
  });

  it('lists its customers, each a link, with what links them and whether it is confirmed', () => {
    const html = CustomerView.html(partner, pctx);
    const list = html.slice(html.indexOf('id="cvCustomers"'), html.indexOf('id="cvWaiting"'));
    assert.match(list, /<a href="\/org\/hooli">Hooli<\/a>/);
    assert.match(list, /2 of its people in their channels/);
    assert.match(list, /<span class="tag tv-confirmed"[^>]*>Confirmed<\/span>/);
    // ACME: likely, Clef's 90%; the threads with its people are the meter's, not the words'.
    assert.match(list, /<a href="\/org\/acme">ACME &lt;Corp&gt;<\/a><span class="sub">a site owner in common, their people in 1 of its threads, /);
    assert.match(list, /<span class="tag tv-likely" title="90% likely, says Clef">Likely<\/span><span class="tag tv-us">1 waiting on Adobe<\/span>/);
    assert.match(list, /9 threads with its people/);
    assert.match(list, /its people post there; not linked yet/);
  });

  it('lists what waits on Adobe, titles escaped, and its people with where they post', () => {
    const html = CustomerView.html(partner, pctx);
    const waiting = html.slice(html.indexOf('id="cvWaiting"'), html.indexOf('id="cvWhere"'));
    assert.match(waiting, /Stale &lt;code&gt;<\/a><span class="sub">Agency Co, #agency-aem/);
    assert.match(waiting, /<span class="sub">ACME &lt;Corp&gt;, #agency-aem/);
    assert.match(waiting, /And 1 more thread in channels of teams you are not on\./);
    const where = html.slice(html.indexOf('id="cvWhere"'), html.indexOf('id="tvPeople"'));
    assert.match(where, /Pia &lt;B&gt;/);
    assert.match(where, /Developer, 4 in its channels, 6 in customers&#39;/);
    assert.match(where, /<a class="ps-chip" href="\/org\/acme"[^>]*>ACME &lt;Corp&gt;<\/a><span class="sub">and 1 more<\/span>/);
    assert.match(html, /<h2 id="tvPeople">People in its channels/);
    assert.ok(!html.includes('id="cvPartners"'));
  });

  it('lists a customer\'s partners, each a link to its page', () => {
    const html = CustomerView.html({
      ...profile,
      partners: [{
        slug: 'agency', name: 'Agency <Co>', type: 'partner', icon: null, linked: true, confirmed: true, p: 0.8, signals: { posters: 4, kb: 2, place: 1 }, threads: 4, people: 2,
      }, {
        slug: 'other', name: 'Other Partner', type: 'partner', icon: null, linked: false, confirmed: false, p: null, signals: {}, threads: 1, people: 1,
      }],
    }, pctx);
    const list = html.slice(html.indexOf('id="cvPartners"'));
    assert.match(list, /<a href="\/org\/agency">Agency &lt;Co&gt;<\/a><span class="sub">named in 2 entries of their knowledge base, a Slack Connect or Teams team in common, 2 people of theirs posted in these weeks<\/span>/);
    assert.match(list, /<span class="tag tv-confirmed"[^>]*>Confirmed<\/span>/);
    assert.match(list, /4 threads with their people/);
    assert.match(list, /<a href="\/org\/other">Other Partner<\/a><span class="sub">1 person of theirs posted in these weeks, not linked yet<\/span>/);
    assert.ok(!html.includes('id="cvCustomers"'));
  });

  it('links the admin team to a pair nothing links yet, or to the review list', () => {
    const review = (c, pt, pair) => (pair ? { href: `/pair/${c}:${pt}`, list: false } : { href: '/here', list: true });
    const row = (over) => ({
      slug: 'agency', name: 'Agency', type: 'partner', icon: null, linked: false, confirmed: false, p: null, signals: {}, threads: 2, people: 1, ...over,
    });
    const html = CustomerView.html({
      ...profile, partners: [row({ pair: true }), row({ slug: 'other', pair: false }), row({ slug: 'mine', linked: true, pair: true })],
    }, { ...pctx, review });
    assert.match(html, /<a class="tv-review" href="\/pair\/acme:agency" title="Open the pair in Likely partners">Review<\/a>/);
    assert.match(html, /<a class="tv-review" href="\/here" data-review-list[^>]*>Review list<\/a>/);
    assert.equal([...html.matchAll(/class="tv-review"/g)].length, 2);
    // A partner's page: the pair is its customer's and its own.
    const page = CustomerView.html(partner, { ...pctx, review });
    assert.ok(!page.includes('tv-review'));
    const loose = {
      ...partner,
      partner: {
        ...partner.partner,
        customers: {
          ...partner.partner.customers, list: [customer({ linked: false, pair: true })],
        },
      },
    };
    assert.match(CustomerView.html(loose, { ...pctx, review }), /href="\/pair\/acme:agency"/);
    // Nobody else gets `pair`, so no link.
    assert.ok(!CustomerView.html({ ...profile, partners: [row()] }, { ...pctx, review }).includes('tv-review'));
  });

  it('says so when no partner is known to work for a customer', () => {
    const html = CustomerView.html({ ...profile, partners: [] }, pctx);
    assert.match(html, /No agency or system integrator is known to work for ACME\./);
  });
});
