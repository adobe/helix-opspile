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
import { beforeEach, describe, it } from 'node:test';
import { api } from '../src/api.js';
import { nameWords, productWords, suggestFor } from '../src/orgassign.js';
import { forgetFacts } from '../src/orgmerge.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

// Made-up people, channels and slugs only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: [{ slug: 'admin' }],
};
const RULES = [{
  id: 1, target: 'org', priority: 100, source: null, field: 'name', pattern: '^(?:aem|aem\\-live|workfront)-(.+)$', value: '$1',
}];

beforeEach(() => forgetFacts());

describe('an org for an unassigned channel', () => {
  const org = (slug, more = {}) => ({
    slug, name: null, domains: [], channels: [], ...more,
  });
  const ctx = (orgs) => ({
    orgs: new Map(orgs.map((o) => [o.slug, o])),
    places: new Map(),
    byDomain: new Map(orgs.filter((o) => o.domains[0]).map((o) => [o.domains[0], [o.slug]])),
    products: productWords(RULES),
  });

  it('reads the products the rules know out of their patterns, and leaves them out of a name', () => {
    assert.deepEqual([...productWords(RULES)].sort(), ['aem', 'live', 'workfront']);
    assert.deepEqual(nameWords('workfront-acme-adobe-alerts-2026', productWords(RULES)), ['acme']);
  });

  it('suggests the orgs it shares a team, a mail domain or a name with', () => {
    const orgs = [
      org('hooli', { domains: ['hooli.example'] }),
      org('home-depot'),
      org('initech', { channels: [{ places: ['connect:T9'] }] }),
    ];
    const one = (channel) => suggestFor({ places: [], domains: [], ...channel }, ctx(orgs));
    assert.deepEqual(one({ name: 'hooli-adobe' }).orgs.map((o) => o.org), ['hooli']);
    assert.deepEqual(one({ name: 'home-depot-sync' }).orgs.map((o) => o.org), ['home-depot']);
    assert.deepEqual(one({ name: 'x-shared', domains: ['hooli.example'] }).orgs.map((o) => o.org), ['hooli']);
    assert.deepEqual(one({ name: 'random', places: ['connect:T9'] }).orgs.map((o) => o.org), ['initech']);
    // None fits: a new org, by its people's mail domain, else by its name.
    assert.deepEqual(
      one({ name: 'umbrella-and-adobe', domains: ['mail.umbrella.example'] }).fresh,
      { slug: 'umbrella', name: 'Umbrella', why: 'its people write from mail.umbrella.example' },
    );
    assert.equal(one({ name: 'globex-adobe' }).fresh.slug, 'globex');
    assert.equal(one({ name: 'dd-autom-t1' }).fresh, null);
  });
});

describe('admin: unassigned channels', () => {
  it('lists them with suggestions, and counts them in the org list', async () => {
    const DB = d1({ rules: RULES, people: [{ ...ADA, teams: ['admin'] }], teams: [{ slug: 'admin', name: 'Admin' }] });
    const channel = (id, name, org) => {
      DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
        VALUES ('slack', 'E1', ?, ?, '2026-10-22T00:00:00Z')`).run(id, name);
      DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind,
          channel_name, path, root_at, last_at, any_at, messages, updated_at)
        VALUES (?, 'slack', 'E1', ?, '1.1', ?, 'admin', 'channel', ?, ?, '2026-10-22T00:00:00Z',
          '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z', 1, '2026-10-22T00:00:00Z')`)
        .run(`slack:E1:${id}:1.1`, id, org, name, `channels/${org}/admin/slack-${id}/1.1/`);
    };
    channel('C1', 'aem-acme', 'acme');
    channel('C2', 'acme-adobe-sync', '_unassigned');
    channel('C3', 'globex-and-adobe', '_unassigned');
    const e = { DB, CHANNELS: fakeBucket(), STAFF_DOMAINS: 'staff.example' };
    const call = async (path) => {
      const url = new URL(`https://opspile.example${path}`);
      const res = await api(new Request(url), e, url, { viewer: ADA });
      return res.json();
    };
    const list = await call('/api/admin/orgs');
    assert.deepEqual(list.unassigned, { channels: 2, threads: 2 });
    assert.ok(!list.orgs.some((o) => o.slug === '_unassigned'));
    const r = await call('/api/admin/org?slug=_unassigned');
    assert.equal(r.unassigned, true);
    assert.deepEqual(r.channels.map((c) => c.channelId).sort(), ['C2', 'C3']);
    assert.deepEqual(r.suggestions.C2.orgs.map((o) => o.org), ['acme']);
    assert.equal(r.suggestions.C3.fresh.slug, 'globex');
  });
});
