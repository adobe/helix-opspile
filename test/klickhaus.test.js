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
import { api } from '../src/api.js';
import { statsFor } from '../src/klickhaus.js';
import { indexMessage } from '../src/threads.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

// Stats on klickhaus (src/klickhaus.js). Made-up teams, people and origin.
const people = [
  {
    id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['stats'],
  },
  {
    id: 2, email: 'b@staff.example', name: 'B', staff: 1, teams: ['other'],
  },
  {
    id: 3, email: 'c@staff.example', name: 'C', staff: 1, teams: ['admin'],
  },
];
const fresh = () => d1({
  teams: [{ slug: 'stats', name: 'Stats' }, { slug: 'other', name: 'Other' },
    { slug: 'admin', name: 'Admin' }],
  people,
});
const who = (id) => {
  const p = people.find((x) => x.id === id);
  return {
    id: p.id,
    email: p.email,
    name: p.name,
    teams: p.teams.map((slug) => ({ slug, name: slug })),
    admin: p.teams.includes('admin'),
  };
};
const A = who(1);
const B = who(2);
const ADMIN = who(3);
const ON = { KLICKHAUS_URL: 'https://klickhaus.example', KLICKHAUS_TEAMS: 'nope, stats' };
const PAGE = 'https://klickhaus.example/opspile.html';

const call = (env, path, me) => {
  const url = new URL(`https://opspile.test${path}`);
  return api(new Request(url), env, url, { viewer: me });
};
const me = async (env, viewer) => (await (await call(env, '/api/me', viewer)).json()).stats;

describe('Stats', () => {
  it('links klickhaus only with both vars, and only for members of those teams', () => {
    assert.deepEqual(statsFor(ON, A), { url: PAGE });
    assert.deepEqual(statsFor({ ...ON, KLICKHAUS_URL: 'https://klickhaus.example/' }, A), { url: PAGE });
    assert.deepEqual(statsFor({ ...ON, KLICKHAUS_URL: 'https://example.com/k' }, A), { url: 'https://example.com/k/opspile.html' });
    assert.equal(statsFor({ KLICKHAUS_URL: ON.KLICKHAUS_URL }, A), null);
    assert.equal(statsFor({ KLICKHAUS_TEAMS: 'stats' }, A), null);
    assert.equal(statsFor({ ...ON, KLICKHAUS_URL: 'not a url' }, A), null);
    assert.equal(statsFor({ ...ON, KLICKHAUS_URL: 'ftp://klickhaus.example' }, A), null);
    assert.equal(statsFor(ON, B), null);
    assert.equal(statsFor(ON, { teams: [] }), null);
  });

  it('is in /api/me for a member of those teams, not for an admin outside them', async () => {
    const DB = fresh();
    assert.deepEqual(await me({ DB, ...ON }, A), { url: PAGE });
    assert.equal(await me({ DB }, A), undefined);
    assert.equal(await me({ DB, ...ON }, B), undefined);
    assert.equal(await me({ DB, ...ON }, ADMIN), undefined);
  });

  it('follows whom an admin views the inbox as', async () => {
    const DB = fresh();
    const viewing = (them) => ({
      ...them, admin: false, viewer: { id: ADMIN.id, name: ADMIN.name }, readonly: true,
    });
    assert.deepEqual(await me({ DB, ...ON }, viewing(A)), { url: PAGE });
    assert.equal(await me({ DB, ...ON }, viewing(B)), undefined);
    // An admin on one of the teams has it, and loses it viewing as someone outside them.
    const both = { ...ADMIN, teams: [...ADMIN.teams, { slug: 'stats', name: 'stats' }] };
    assert.deepEqual(await me({ DB, ...ON }, both), { url: PAGE });
    assert.equal(await me({ DB, ...ON }, { ...viewing(B), viewer: { id: both.id } }), undefined);
  });

  it('links back to a thread the person may see, not in their personal view', async () => {
    // klickhaus' rows open /inbox?view=personal&t=<thread>: the inbox asks for the thread
    // without a team. A never posted in the channel, but it is filed under their team.
    const DB = fresh();
    await indexMessage(DB, {
      source: 'slack',
      tenant: 'E1',
      channelId: 'C1',
      org: 'acme',
      team: 'stats',
      kind: 'channel',
      counted: true,
      staff: false,
      person: null,
      rootId: '1.1',
      id: '1.1',
      thread: 'slack:E1:C1:1.1',
      at: '2026-10-21T10:00:00Z',
      title: 'A customer question',
      path: 'slack/E1/C1/1.1/',
    });
    const env = { DB, CHANNELS: fakeBucket() };
    const key = encodeURIComponent('slack:E1:C1:1.1');
    const res = await call(env, `/api/thread?thread=${key}`, A);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).thread.thread, 'slack:E1:C1:1.1');
    assert.equal((await call(env, `/api/thread?thread=${key}`, ADMIN)).status, 200);
    assert.equal((await call(env, `/api/thread?thread=${key}`, B)).status, 404);
  });
});
