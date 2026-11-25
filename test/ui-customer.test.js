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
    assert.match(html, /title="How long its first answer took in the threads Adobe started[^"]*"><b>1\.5 h<\/b><span>first answer<\/span><small>typically; 2 of the 3 cases Adobe opened<\/small>/);
    assert.match(html, /<h2 id="tvAreas">What the cases are about<\/h2>/);
  });

  it('lists its open cases, status posts and the customers on its products, titles escaped', () => {
    const html = CustomerView.html(vendor, vctx);
    const cases = html.slice(html.indexOf('id="cvCases"'), html.indexOf('id="cvStatus"'));
    assert.match(cases, /<a href="\/inbox\?team=edge&amp;t=t%3A1" title="Open it in the inbox">Purge &lt;leaves&gt; stale objects<\/a><span class="sub">#cdnco-support · high urgency · incident · [^<]+<\/span><\/span><span class="tag tv-them"[^>]*>Waiting on them<\/span>/);
    assert.match(cases, /<span class="tag tv-us"[^>]*>Waiting on Adobe<\/span>/);
    assert.match(cases, /And 1 more thread in channels of teams you are not on\./);
    assert.match(html, /Maintenance in FRA/);
    assert.match(html, /<a href="\/org\/acme">ACME<\/a>/);
    assert.match(html, /<span class="tag tv-them"[^>]*>1 waits on a third party<\/span>/);
    const third = html.slice(html.indexOf('id="cvThird"'));
    assert.match(third, /<span class="sub">ACME · #cdnco-support/);
    assert.match(third, /<span class="tag tv-them"[^>]*>Waiting on a third party<\/span>/);
  });

  it('is a customer\'s for a customer', () => {
    const html = CustomerView.html(profile, ctx);
    assert.ok(!html.includes('id="cvCases"'));
    assert.match(html, /How long Adobe&#39;s first post took/);
  });
});
