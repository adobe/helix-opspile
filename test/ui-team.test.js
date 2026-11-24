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

// As the page loads them: what it is drawn with (ui/overview.js), then the team's overview.
// eslint-disable-next-line no-new-func
const TeamView = new Function('globalThis', `${SCRIPTS['overview.js']}\nconst { Overview } = globalThis;\n${SCRIPTS['team.js']}\nreturn globalThis.TeamView;`)({});

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
  kbHref: () => null,
  topicHref: (id) => `/inbox/topics?${new URLSearchParams({ sel: id })}`,
};

describe('a team\'s overview, drawn', () => {
  it('links a person\'s areas, products and name to the Topics page, and ends their card with their customers', () => {
    const html = TeamView.html(profile, ctx);
    const card = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    assert.match(card, /<a href="\/inbox\/topics\?sel=tag%3Acdn" class="tv-chip" title="Caching: 2 threads of theirs\. Open it on the Topics page">Caching<\/a>/);
    assert.match(card, /<a href="\/inbox\/topics\?sel=product%3Atech%3Afastly%2Fcdn" class="tv-chip tech"/);
    assert.match(card, /<b><a href="\/inbox\/topics\?sel=person%3A7"[^>]*>Ada &lt;Ops&gt;<\/a><\/b>/);
    // Expertise and products, then the key customers at the foot.
    assert.ok(card.indexOf('class="tv-knows"') < card.indexOf('class="tv-keys"'));
    assert.match(card, /<dl class="tv-keys"><dt>Key customers<\/dt><dd><a href="\/org\/acme" class="tv-org"[^>]*>/);
    assert.ok(card.trimEnd().endsWith('</dd></dl>'));
  });

  it('leaves a tag unlinked where there is nowhere to go', () => {
    const html = TeamView.html(profile, { ...ctx, topicHref: () => null });
    assert.match(html, /<span class="tv-chip" title="Caching: 2 threads of theirs">Caching<\/span>/);
  });
});
