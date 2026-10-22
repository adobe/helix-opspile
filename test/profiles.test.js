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
import { inbox } from '../src/api.js';
import { partnerOf, profiles, relationOf } from '../src/profiles.js';
import { indexMessage } from '../src/threads.js';
import { d1 } from './d1.js';

// Made-up people, domains and ids.
const env = { STAFF_DOMAINS: 'staff.example' };
const partners = new Map([['agency.example', 'Agency']]);

describe('relationOf', () => {
  it('tells staff, partners, customers and bots apart', () => {
    assert.equal(relationOf(env, { kind: 'bot' }, partners), 'bot');
    assert.equal(relationOf(env, { kind: 'person', staff: 1 }, partners), 'adobe');
    assert.equal(relationOf(env, { kind: 'person', email: 'a@staff.example' }, partners), 'adobe');
    assert.equal(relationOf(env, { kind: 'person', email: 'p@agency.example' }, partners), 'partner');
    assert.equal(relationOf(env, { kind: 'person', email: 'p@eu.agency.example' }, partners), 'partner');
    assert.equal(relationOf(env, { kind: 'person', email: 'c@acme.example' }, partners), 'customer');
    assert.equal(relationOf(env, { kind: 'person', email: null }, partners), 'customer');
  });

  it('matches partner domains and their subdomains only', () => {
    assert.deepEqual(partnerOf('eu.agency.example', partners), { domain: 'agency.example', name: 'Agency' });
    assert.equal(partnerOf('notagency.example', partners), null);
    assert.equal(partnerOf('example', partners), null);
    assert.equal(partnerOf(null, partners), null);
  });
});

describe('profiles', () => {
  const fresh = () => {
    const DB = d1({
      teams: [{ slug: 'helix', name: 'Helix' }],
      people: [{
        id: 1, email: 'a@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
      }],
    });
    DB.sqlite.exec(`INSERT INTO partner_domains (domain, name) VALUES ('agency.example', 'Agency');
      INSERT INTO identities (source, tenant, user_id, kind, name, email, person, fetched_at, avatar,
        title, company) VALUES
      ('slack', 'E1', 'U1', 'person', 'ada', 'a@staff.example', 1, '2026-10-21', 'https://img/1', 'SRE', NULL),
      ('slack', 'E1', 'U2', 'person', 'Pat', 'pat@agency.example', NULL, '2026-10-21', '', NULL, NULL),
      ('teams', 'T1', 'g-3', 'person', 'Cy', 'cy@acme.example', NULL, '2026-10-21', '', 'CTO', 'Acme'),
      ('slack', 'E1', 'B1', 'bot', 'Alerts', NULL, NULL, '2026-10-21', '', NULL, NULL)`);
    return DB;
  };

  it('builds a card per identity without emails', async () => {
    const DB = fresh();
    const cards = await profiles({ ...env, DB }, [
      'slack:E1:U1', 'slack:E1:U2', 'teams:T1:g-3', 'slack:E1:B1', 'slack:E1:U9', null, 'slack:E1:U1',
    ]);
    assert.deepEqual(Object.keys(cards).sort(), ['slack:E1:B1', 'slack:E1:U1', 'slack:E1:U2', 'teams:T1:g-3']);
    assert.deepEqual(cards['slack:E1:U1'], {
      name: 'Ada',
      avatar: 'https://img/1',
      platform: 'slack',
      kind: 'person',
      title: 'SRE',
      company: null,
      domain: 'staff.example',
      relation: 'adobe',
      partner: null,
      teams: ['Helix'],
    });
    assert.equal(cards['slack:E1:U2'].relation, 'partner');
    assert.equal(cards['slack:E1:U2'].partner, 'Agency');
    assert.equal(cards['teams:T1:g-3'].relation, 'customer');
    assert.equal(cards['teams:T1:g-3'].company, 'Acme');
    assert.equal(cards['slack:E1:B1'].relation, 'bot');
    assert.ok(!JSON.stringify(cards).includes('@'));
    assert.deepEqual(await profiles({ ...env, DB }, []), {});
  });

  it('comes with the inbox, keyed from the avatar stack', async () => {
    const DB = fresh();
    const base = {
      source: 'slack', tenant: 'E1', channelId: 'C1', org: 'acme', team: 'helix', kind: 'channel', counted: true, path: 'p/',
    };
    await indexMessage(DB, {
      ...base, rootId: '1', id: '1', thread: 't1', at: '2026-10-21T10:00:00Z', title: 'one', authorKey: 'slack:E1:U2', author: 'Pat',
    });
    await indexMessage(DB, {
      ...base, rootId: '1', id: '2', thread: 't1', at: '2026-10-21T10:05:00Z', authorKey: 'slack:E1:U1', author: 'Ada', person: 1, staff: true,
    });
    const { threads, profiles: cards } = await inbox({ ...env, DB }, { id: 1 }, 'helix');
    assert.deepEqual(threads[0].participants.map((p) => p.key), ['slack:E1:U2', 'slack:E1:U1']);
    assert.deepEqual(Object.keys(cards).sort(), ['slack:E1:U1', 'slack:E1:U2']);
    assert.equal(cards['slack:E1:U2'].relation, 'partner');
  });
});
