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
    assert.match(card, /<a href="\/inbox\/topics\?sel=tag%3Acdn" class="ps-chip" title="Caching: 2 threads of theirs\. Open it on the Topics page">Caching<\/a>/);
    assert.match(card, /<a href="\/inbox\/topics\?sel=product%3Atech%3Afastly%2Fcdn" class="ps-chip tech"/);
    assert.match(card, /<b><a href="\/inbox\/topics\?sel=person%3A7"[^>]*>Ada &lt;Ops&gt;<\/a><\/b>/);
    // Expertise and products, then the key customers at the foot.
    assert.ok(card.indexOf('class="ps-knows"') < card.indexOf('class="ps-keys"'));
    assert.match(card, /<dl class="ps-keys"><dt>Key customers<\/dt><dd><a href="\/org\/acme" class="ps-org"[^>]*>/);
    assert.ok(card.trimEnd().endsWith('</dd></dl>'));
    // Her profile on the team, under who she is, as the inbox's card has it (ui/person.js).
    assert.match(card, /<div class="ps-profile">\s*<p>Runs the &lt;CDN&gt; setups\.<\/p><a href="\/kb\/contacts\/ada-ops\.md" class="ps-src"[^>]*>Profile on Edge ops<\/a><\/div>/);
    assert.ok(card.indexOf('ps-profile') < card.indexOf('ps-freq'));
  });

  it('leaves a tag unlinked where there is nowhere to go', () => {
    const html = TeamView.html(profile, { ...ctx, topicHref: () => null });
    assert.match(html, /<span class="ps-chip" title="Caching: 2 threads of theirs">Caching<\/span>/);
  });
});
