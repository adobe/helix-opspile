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
// (ui/overview.js), then the team's overview.
// eslint-disable-next-line no-new-func
const TeamView = new Function('globalThis', `${SCRIPTS['person.js']}\nconst { Person } = globalThis;\n${SCRIPTS['overview.js']}\nconst { Overview } = globalThis;\n${SCRIPTS['team.js']}\nreturn globalThis.TeamView;`)({});
// eslint-disable-next-line no-new-func
const Person = new Function('globalThis', `${SCRIPTS['person.js']}\nreturn globalThis.Person;`)({});

// Made-up people, customers and technologies only.
const weeks = ['2026-11-16', '2026-11-23'];
const profile = {
  team: {
    slug: 'edge', name: 'Edge ops', self_managed: false, channels: 1, shared: 0,
  },
  weeks,
  layers: [{ id: 'edge', name: 'Edge' }],
  activity: { messages: [3, 4], staff: [2, 2], threads: [1, 2] },
  threadCount: 2,
  members: [{
    id: 7,
    name: 'Ada <Ops>',
    role: 'manager',
    avatar: null,
    title: null,
    messages: 7,
    threads: 2,
    weekly: [3, 4],
    last: '2026-11-24T00:00:00Z',
    areas: [{
      id: 'cdn', name: 'Caching', n: 5, threads: 2,
    }],
    tech: [{
      id: 'fastly/cdn', name: 'Fastly', n: 5, threads: 2,
    }],
    customers: [{
      slug: 'acme', n: 5, threads: 2, name: 'ACME', icon: null,
    }],
    profile: { path: 'contacts/ada-ops.md', description: 'Runs the <CDN> setups.' },
  }],
  customers: [],
  customerCount: 0,
  collaborators: [],
  collaboratorCount: 0,
  tech: [],
  kb: null,
};
const ctx = {
  orgHref: (slug) => `/org/${slug}`,
  orgName: (slug, name) => name || slug,
  orgIcon: () => '',
  teamHref: (slug) => `/team/${slug}`,
  kbHref: (path) => `/kb/${path}`,
  topicHref: (id) => `/inbox/topics?${new URLSearchParams({ sel: id })}`,
};

describe('a team\'s overview, drawn', () => {
  it('links a person\'s areas, products and name to the Topics page, and ends their card with their customers', () => {
    const html = TeamView.html(profile, ctx);
    const card = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    assert.match(card, /<a href="\/inbox\/topics\?sel=tag%3Acdn" class="ps-chip" title="Caching: 2 threads">Caching<\/a>/);
    assert.match(card, /<a href="\/inbox\/topics\?sel=product%3Atech%3Afastly%2Fcdn" class="ps-chip tech"/);
    assert.match(card, /<b><a href="\/inbox\/topics\?sel=person%3A7"[^>]*>Ada &lt;Ops&gt;<\/a><\/b>/);
    // Expertise and products, then the key customers at the foot.
    assert.ok(card.indexOf('class="ps-knows"') < card.indexOf('class="ps-keys"'));
    assert.match(card, /<dl class="ps-keys"><dt>Key customers<\/dt><dd><a href="\/org\/acme" class="ps-org"[^>]*>/);
    assert.ok(card.trimEnd().endsWith('</dd></dl></div>'));
    // Her profile on the team, after what every card has, as on the inbox's card (ui/person.js).
    assert.match(card, /<div class="ps-profile">\s*<p>Runs the &lt;CDN&gt; setups\.<\/p><a href="\/kb\/contacts\/ada-ops\.md" class="ps-src"[^>]*>Profile on Edge ops<\/a><\/div>/);
    assert.ok(card.indexOf('ps-freq') < card.indexOf('ps-profile'));
  });

  it('draws every card in the same parts, in the same order, whatever is missing', () => {
    const parts = (card) => [...card.matchAll(/<div class="ps-s (ps-s-[a-z]+)">/g)].map((m) => m[1]);
    const order = ['ps-s-act', 'ps-s-areas', 'ps-s-tech', 'ps-s-prof', 'ps-s-foot'];
    const full = Person.card({
      name: 'Ada',
      messages: 9,
      threads: 3,
      weekly: [4, 5],
      last: null,
      areas: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id.toUpperCase(), threads: 1 })),
      tech: [],
    }, {
      face: '', name: 'Ada', weeks: 2, ctx,
    });
    assert.deepEqual(parts(full), order);
    // The first three tags, and a count of the rest that names them.
    assert.equal((full.match(/class="ps-chip"/g) || []).length, 3);
    assert.match(full, /<span class="ps-chip ps-more" title="Also D, E">\+2<\/span>/);
    // No technologies, no profile, no title: each says so where it would be.
    assert.match(full, /<dt>Products<\/dt><dd><span class="sub">None yet<\/span><\/dd>/);
    assert.match(full, /class="sub ps-noprof">No profile in the knowledge base yet\./);
    assert.match(full, /<span class="sub ps-ttl"><\/span>/);
    assert.match(full, /<span class="sub ps-last">none lately<\/span>/);
    const bare = Person.card({
      name: 'Bo', messages: 1, threads: 1, weekly: [1], areas: [], tech: [],
    }, {
      face: '', name: 'Bo', weeks: 1, ctx,
    });
    assert.deepEqual(parts(bare), order);
  });

  it('leaves a tag unlinked where there is nowhere to go', () => {
    const html = TeamView.html(profile, { ...ctx, topicHref: () => null });
    assert.match(html, /<span class="ps-chip" title="Caching: 2 threads">Caching<\/span>/);
  });

  it('draws a person\'s line in the color of their initials, a customer\'s gray until its icon is read', () => {
    const p = {
      ...profile,
      customers: [{
        slug: 'acme', name: 'ACME', type: 'customer', icon: null, messages: 4, staff: 2, threads: 1, weekly: [1, 3], members: [],
      }],
      customerCount: 1,
      collaborators: [{
        id: 8, name: 'Grace', avatar: null, title: null, messages: 2, weekly: [1, 1], teams: [],
      }],
      collaboratorCount: 1,
    };
    const html = TeamView.html(p, { ...ctx, orgIcon: () => '<img class="ico" src="/api/favicon?domain=acme.example" alt="">' });
    const hue = (name) => ['cinnamon', 'seafoam', 'purple', 'magenta', 'blue', 'green', 'brown', 'cyan'][Person.hueOf(name)];
    const card = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    assert.match(card, new RegExp(`<div class="ps-freq"><svg class="ps-spark" data-tint="${hue('Ada <Ops>')}"`));
    const collab = html.slice(html.indexOf('id="tvCollab"'));
    assert.match(collab, new RegExp(`<svg class="ps-spark" data-tint="${hue('Grace')}"`));
    const customers = html.slice(html.indexOf('id="tvCustomers"'), html.indexOf('id="tvCollab"'));
    assert.match(customers, /<svg class="ps-spark" viewBox=/);
  });
});

describe('a team\'s vendors, drawn', () => {
  const p = {
    team: { slug: 'edge', name: 'Edge ops' },
    weeks,
    vendors: [{
      slug: 'cdnco', name: 'CDN <Co>', icon: null, filed: 1, shared: 0, follows: false, inInbox: true, channels: 1, posted: 4, people: 1, products: 2, threads: 3, cases: { open: 2, them: 1, us: 1 }, answers: { asked: 3, answered: 3, median: 60 }, last: '2026-11-24T00:00:00Z',
    }, {
      slug: 'xlate', name: null, icon: null, filed: 0, shared: 0, follows: false, inInbox: false, channels: 1, posted: 0, people: 0, products: 3, threads: 1, cases: { open: 0, them: 0, us: 0 }, answers: { asked: 0, answered: 0, median: null }, last: null,
    }, {
      slug: 'nochan', name: 'No Channel', icon: null, filed: 0, shared: 0, follows: false, inInbox: false, channels: 0, posted: 0, people: 0, products: 1, threads: 0, cases: { open: 0, them: 0, us: 0 }, answers: { asked: 0, answered: 0, median: null }, last: null,
    }],
    waiting: [{
      thread: 't:c', org: 'acme', title: 'Stale <pages>', channel: 'aem-acme', urgency: 'normal', kind: 'incident', waiting: 'vendor', third: true, last: '2026-11-24T00:00:00Z', inbox: '/inbox?team=edge&t=t%3Ac',
    }],
    waitingCount: 2,
    waitingHidden: 1,
    ours: [],
    oursCount: 0,
    oursHidden: 0,
    may: { follow: true },
  };

  it('lists its vendors, their cases and answers, and a Follow where its channels are not in the inbox', () => {
    const html = TeamView.vendors(p, ctx);
    assert.match(html, /<a href="\/org\/cdnco">CDN &lt;Co&gt;<\/a><span class="sub">1 channel filed here, the team posted 4 messages there, in 2 customer threads/);
    assert.match(html, /<span class="tag tv-them"[^>]*>1 waits on them<\/span><span class="tag tv-us"[^>]*>1 waits on Adobe<\/span>/);
    assert.match(html, /<b>1 h<\/b><span class="sub">first answer<\/span>/);
    assert.match(html, /<span class="fo"><span class="fo-follow"><button type="button" class="fo-b" aria-pressed="false" data-follow="xlate"/);
    // One without a channel has nothing to follow; nobody but a manager follows.
    assert.equal([...html.matchAll(/data-follow=/g)].length, 1);
    assert.match(html, /no channel/);
    assert.doesNotMatch(TeamView.vendors({ ...p, may: { follow: false } }, ctx), /data-follow=/);
  });

  it('lists what waits on a vendor, a customer\'s thread as waiting on a third party', () => {
    const html = TeamView.vendors(p, ctx);
    const waiting = html.slice(html.indexOf('id="tvWaiting"'), html.indexOf('id="tvOurs"'));
    assert.match(waiting, /<a href="\/inbox\?team=edge&amp;t=t%3Ac" title="Open in the inbox">Stale &lt;pages&gt;<\/a><span class="sub">acme, #aem-acme, normal urgency, incident, /);
    assert.match(waiting, />Waiting on a third party<\/span>/);
    assert.match(waiting, /And 1 more thread in channels of teams you are not on\./);
    assert.match(html, /No vendor waits on Adobe\./);
  });
});
