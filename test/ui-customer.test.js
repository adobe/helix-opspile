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

// As the page loads them: what it is drawn with (ui/overview.js), then the customer's overview.
// eslint-disable-next-line no-new-func
const CustomerView = new Function('globalThis', `${SCRIPTS['overview.js']}\nconst { Overview } = globalThis;\n${SCRIPTS['customer.js']}\nreturn globalThis.CustomerView;`)({});

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
  contact: 'contacts/sam-reyes.md',
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
    id: null, name: 'Pat', partner: 'Agency Co', contact: null, areas: [], tech: [],
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
  it('links its people\'s areas, products and names to the Topics page, their Contact at the foot', () => {
    const html = CustomerView.html(profile, ctx);
    const card = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    assert.match(card, /<a href="\/inbox\/topics\?sel=tag%3Acdn" class="tv-chip"[^>]*>Caching<\/a>/);
    assert.match(card, /<a href="\/inbox\/topics\?sel=product%3Atech%3Afastly" class="tv-chip tech"/);
    assert.match(card, /<b><a href="\/inbox\/topics\?sel=person%3A5"[^>]*>Sam &lt;Reyes&gt;<\/a><\/b>/);
    assert.ok(card.indexOf('class="tv-knows"') < card.indexOf('class="tv-keys"'));
    assert.match(card, /<dl class="tv-keys"><dt>Contact<\/dt><dd><a class="tv-contact" href="\/kb\/contacts\/sam-reyes\.md"/);
  });

  it('marks a partner\'s person, and leaves a name without a person unlinked', () => {
    const html = CustomerView.html(profile, ctx);
    const card = html.slice(html.lastIndexOf('<article'));
    assert.match(card, /<b><span>Pat<\/span><\/b><span class="tag tv-partner"[^>]*>Agency Co<\/span>/);
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
