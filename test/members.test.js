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
import { deliveryText } from '../src/agent/deliver.js';
import { findMember, mentionedOutside } from '../src/agent/members.js';
import { d1 } from './d1.js';

// Made-up people, channels and teams only.
const NOW = Date.parse('2026-10-30T12:00:00Z');
const RECENT = '2026-10-30T11:30:00.000Z';
const OLD = '2026-10-30T09:00:00.000Z';
const ENTRY = {
  source: 'teams', tenant: 'X1', channelId: 'C1',
};
const THREAD = 'teams:X1:G1:C1:100';
const key = (id) => `teams:X1:C1:${id}`;

/** A Teams channel with the given members, listed at `at`, and Ada, Bo and Cy as accounts. */
function env({
  members = [], at = RECENT, error = null, shared = 0, source = 'teams',
} = {}) {
  const DB = d1({
    people: [
      {
        id: 1, email: 'ada@staff.example', name: 'Ada Lovelace', staff: 1,
      },
      {
        id: 2, email: 'bo@staff.example', name: 'Bo Diddley', staff: 1,
      },
      {
        id: 3, email: 'cy@staff.example', name: 'Cy Twombly', staff: 1,
      },
    ],
  });
  const db = DB.sqlite;
  db.prepare(`INSERT INTO channels (source, tenant, channel_id, name, group_id, shared, members_at,
      members_error, fetched_at) VALUES (?, 'X1', 'C1', 'Main', 'G1', ?, ?, ?, ?)`)
    .run(source, shared, at, error, RECENT);
  for (const [person, id] of [[1, 'U-ADA'], [2, 'U-BO'], [3, 'U-CY']]) {
    db.prepare(`INSERT INTO identities (source, tenant, user_id, kind, person, fetched_at)
      VALUES (?, 'X1', ?, 'person', ?, ?)`).run(source, id, person, RECENT);
  }
  for (const m of members) {
    db.prepare(`INSERT INTO channel_members (source, tenant, channel_id, user_id, email, name)
      VALUES (?, 'X1', 'C1', ?, ?, ?)`).run(source, m.userId, m.email || null, m.name || null);
  }
  return { DB };
}

const mention = (e, id, person, via = 'id') => e.DB.sqlite.prepare(`INSERT INTO mentions
  (thread, message, person, at, via) VALUES (?, ?, ?, ?, ?)`).run(THREAD, key(id), person, RECENT, via);

/** Graph answering `/teams/G1/members` with `value`, or `status`; counts the calls. */
function graph(value = [], status = 200) {
  const fake = async () => {
    fake.calls += 1;
    return new Response(JSON.stringify(status === 200 ? { value } : { error: { code: 'Forbidden' } }), { status });
  };
  fake.calls = 0;
  return fake;
}

const ADA = { userId: 'U-ADA', email: 'ada@staff.example', name: 'Ada Lovelace' };
const BO = { userId: 'U-BO', email: 'bo@staff.example', name: 'Bo Diddley' };

describe('who is in a channel, for the agent', () => {
  it('calls out a mention of someone who is not in, after listing the members again', async () => {
    const e = env({ members: [ADA], at: OLD });
    mention(e, 100, 2);
    const g = graph([{ userId: 'U-ADA', email: ADA.email, displayName: ADA.name }]);
    const out = await mentionedOutside(e, ENTRY, [{ id: '100' }], { now: NOW, graph: g });
    assert.equal(g.calls, 1);
    assert.deepEqual(out, {
      names: ['Bo Diddley'], at: new Date(NOW).toISOString(), place: 'Teams team',
    });
    const text = deliveryText({}, [{ id: '100', at: RECENT, body: 'hi' }], new Map(), { first: false, outside: out });
    assert.match(text, /Mentioned above but not a member of this Teams team \(members listed [^)]+\): Bo Diddley\.$/);
  });

  it('does not call out someone added since the list was made', async () => {
    const e = env({ members: [ADA], at: OLD });
    mention(e, 100, 2);
    const g = graph([{ userId: 'U-BO', email: BO.email, displayName: BO.name }]);
    assert.equal(await mentionedOutside(e, ENTRY, [{ id: '100' }], { now: NOW, graph: g }), null);
  });

  it('asks the platform only when someone seems to be out, and at most once an hour', async () => {
    const e = env({ members: [ADA, BO], at: OLD });
    mention(e, 100, 1);
    mention(e, 100, 2);
    const g = graph();
    assert.equal(await mentionedOutside(e, ENTRY, [{ id: '100' }], { now: NOW, graph: g }), null);
    assert.equal(g.calls, 0);
    const recent = env({ members: [ADA] });
    mention(recent, 100, 2);
    const out = await mentionedOutside(recent, ENTRY, [{ id: '100' }], { now: NOW, graph: g });
    assert.deepEqual(out.names, ['Bo Diddley']);
    assert.equal(g.calls, 0);
  });

  it('knows a member by any of their accounts, or by mail address', async () => {
    const e = env({ members: [{ userId: 'U-OTHER', email: 'BO@staff.example' }, ADA] });
    mention(e, 100, 2);
    assert.equal(await mentionedOutside(e, ENTRY, [{ id: '100' }], { now: NOW, graph: graph() }), null);
  });

  it('says nothing when the members cannot be listed', async () => {
    // What the Graph permission missing looks like: the failure, and nobody listed.
    const denied = env({ at: OLD });
    mention(denied, 100, 2);
    const g = graph([], 403);
    assert.equal(await mentionedOutside(denied, ENTRY, [{ id: '100' }], { now: NOW, graph: g }), null);
    assert.equal(g.calls, 1);
    assert.match((await findMember(denied, ENTRY, 'bo', { now: NOW, graph: g })).why, /could not be listed \(graph members 403 Forbidden\)/);
    // An earlier list stays in D1 after a failure, and does not count.
    const stale = env({ members: [ADA], at: RECENT, error: 'graph members 403 Forbidden' });
    mention(stale, 100, 2);
    assert.equal(await mentionedOutside(stale, ENTRY, [{ id: '100' }], { now: NOW, graph: g }), null);
    // Nor is the platform asked again within the hour.
    assert.equal(g.calls, 1);
  });

  it('says nothing about a shared channel, where the team is not who is in', async () => {
    const e = env({ members: [ADA], shared: 1 });
    mention(e, 100, 2);
    assert.equal(await mentionedOutside(e, ENTRY, [{ id: '100' }], { now: NOW, graph: graph() }), null);
    assert.match((await findMember(e, ENTRY, 'ada', { now: NOW })).why, /shared channel/);
  });

  it('counts platform mentions in the given messages only', async () => {
    const e = env({ members: [ADA] });
    mention(e, 100, 2, 'name');
    mention(e, 101, 3);
    const none = await mentionedOutside(e, ENTRY, [{ id: '100' }], { now: NOW, graph: graph() });
    assert.equal(none, null);
    assert.equal(await mentionedOutside(e, ENTRY, [], { now: NOW, graph: graph() }), null);
  });

  it('finds members by name and mail address, and says when nobody matches', async () => {
    const e = env({
      members: [ADA, BO, { userId: 'U-D', email: 'dee.dee@customer.example', name: 'Ramone, Dee Dee -ND' }],
    });
    const find = (q) => findMember(e, ENTRY, q, { now: NOW, graph: graph() });
    assert.deepEqual((await find('lovelace')).matches.map((m) => m.user_id), ['U-ADA']);
    assert.deepEqual((await find('Dee Dee')).matches.map((m) => m.user_id), ['U-D']);
    assert.deepEqual((await find('Dee.Dee@customer.example')).matches.map((m) => m.user_id), ['U-D']);
    assert.deepEqual((await find('dee.dum@customer.example')).matches, []);
    const none = await find('nobody');
    assert.deepEqual([none.matches, none.members.length, none.place], [[], 3, 'Teams team']);
  });

  it('counts the members it cannot match by name', async () => {
    // Slack lists ids: a member opspile has not seen has no name or mail address yet.
    const e = env({ members: [ADA, { userId: 'U-NEW' }], source: 'slack' });
    const where = { ...ENTRY, source: 'slack' };
    const found = await findMember(e, where, 'nobody', { now: NOW });
    assert.deepEqual([found.matches, found.unnamed], [[], 1]);
    assert.equal((await findMember(e, where, 'new@customer.example', { now: NOW })).unnamed, 1);
  });

  it('calls a Slack channel a channel', async () => {
    const e = env({ members: [{ userId: 'U-ADA' }], source: 'slack' });
    const res = await findMember(e, { ...ENTRY, source: 'slack' }, 'ada', { now: NOW });
    assert.equal(res.place, 'channel');
  });
});
