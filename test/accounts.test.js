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
import {
  better, kept, keptAccounts, keptOf,
} from '../src/accounts.js';
import { d1 } from './d1.js';

// Made-up people, accounts, workspaces and channels only.
const NOW = Date.parse('2026-10-30T12:00:00Z');
const ago = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
const T = { source: 'slack', tenant: 'E1', channel_id: 'C1' };

function env() {
  const DB = d1({
    people: [{
      id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1,
    }, {
      id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1,
    }],
  });
  const db = DB.sqlite;
  // The thread's channel lives in workspace W1 of the grid E1.
  db.prepare(`INSERT INTO channels (source, tenant, channel_id, group_id, fetched_at)
    VALUES ('slack', 'E1', 'C1', 'W1', ?)`).run(ago(0));
  const account = (id, {
    person = null, email = null, home = null, guest = null, name = 'Someone', kind = 'person',
  } = {}) => db.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, email, home,
      person, guest, fetched_at) VALUES ('slack', 'E1', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, kind, name, email, home, person, guest, ago(0));
  const member = (id, channel = 'C1') => db.prepare(`INSERT INTO channel_members (source, tenant,
      channel_id, user_id) VALUES ('slack', 'E1', ?, ?)`).run(channel, id);
  let n = 0;
  const post = (id, days, channel = 'C9') => {
    n += 1;
    db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, counted,
        author_key) VALUES ('slack', 'E1', ?, ?, ?, ?, 1, ?)`)
      .run(channel, `${n}.0`, `slack:E1:${channel}:${n}.0`, ago(days), `slack:E1:${id}`);
  };
  return {
    DB, account, member, post,
  };
}

const keptFor = async (e, opts = {}) => keptAccounts(e, T, { now: NOW, ...opts });

describe('one account a person', () => {
  it('orders a person\'s accounts for a thread', () => {
    const acct = (id, standing = {}) => ({
      id, here: false, own: false, guest: false, last: null, posts: 0, channels: 0, ...standing,
    });
    const order = (list) => [...list].sort((a, b) => better(a, b, NOW)).map((a) => a.id);
    // Of the thread's own workspace and in its channel, before in its channel, before its own.
    assert.deepEqual(order([
      acct('own', { own: true }), acct('here', { here: true }),
      acct('both', { here: true, own: true }),
    ]), ['both', 'here', 'own']);
    // A full member before a guest; then who posted lately, then the most active.
    assert.deepEqual(order([
      acct('guest', { guest: true, posts: 99 }), acct('quiet'),
      acct('recent', { last: ago(3), posts: 1 }), acct('busy', { last: ago(5), posts: 40 }),
      acct('long-ago', { last: ago(400) }),
    ]), ['busy', 'recent', 'long-ago', 'quiet', 'guest']);
    // Then in more channels, then by id.
    assert.deepEqual(order([acct('b'), acct('a'), acct('c', { channels: 2 })]), ['c', 'a', 'b']);
    const map = keptOf([
      acct('x', { owner: 'p1' }), acct('y', { owner: 'p1', here: true }), acct('z', { owner: 'p2' }),
    ], NOW);
    assert.deepEqual([...map], [['x', 'y'], ['y', 'y'], ['z', 'z']]);
    assert.equal(kept(map, 'x'), 'y');
    assert.equal(kept(map, 'alone'), 'alone');
  });

  it('keeps the account of the thread\'s own workspace that is in its channel', async () => {
    const e = env();
    // Ada: her grid account (no other home), one of her own workspace seen through Slack
    // Connect, and one in another workspace of the grid.
    e.account('U1', { person: 1 });
    e.account('U1c', { person: 1, home: 'T-OTHER' });
    e.account('U1w', { person: 1, home: 'W1' });
    e.account('U2', { person: 2 });
    // Only the Connect one is listed anywhere, and it posted the most.
    e.member('U1c', 'C5');
    e.post('U1c', 1);
    e.post('U1c', 2);
    let map = await keptFor(e);
    // In no channel, the grid's own accounts first: the busier, else by id.
    assert.equal(kept(map, 'U1c'), 'U1');
    assert.equal(kept(map, 'U2'), 'U2');
    e.post('U1w', 1);
    map = await keptFor(e);
    assert.deepEqual(['U1', 'U1c', 'U1w'].map((id) => kept(map, id)), ['U1w', 'U1w', 'U1w']);
    // The Connect account in the channel: the one in it wins.
    e.member('U1c');
    assert.equal(kept(await keptFor(e), 'U1'), 'U1c');
    // Posting in the channel puts one there too, and of its own workspace it wins.
    e.post('U1', 30, 'C1');
    assert.equal(kept(await keptFor(e), 'U1c'), 'U1');
    // Asked for one account or one person, the same answer.
    assert.equal(kept(await keptFor(e, { ids: ['U1c'] }), 'U1c'), 'U1');
    assert.equal(kept(await keptFor(e, { people: [1] }), 'U1w'), 'U1');
    assert.deepEqual([...await keptFor(e, { people: [2] })], []);
    assert.deepEqual([...await keptFor(e, { ids: [] })], []);
  });

  it('takes a full member over a guest, and one mail address for one person', async () => {
    const e = env();
    // Someone outside Adobe (no person in D1): a guest account in the grid and a full one.
    e.account('UG', { email: 'cy@customer.example', guest: 1 });
    e.account('UF', { email: 'CY@customer.example', guest: 0 });
    // Another one of the same name, with another mail address, is someone else.
    e.account('UO', { email: 'cy@elsewhere.example' });
    // Bots, and accounts with no name, are no one's.
    e.account('UB', { email: 'cy@customer.example', kind: 'bot' });
    const map = await keptFor(e);
    assert.equal(kept(map, 'UG'), 'UF');
    assert.equal(kept(map, 'UO'), 'UO');
    assert.equal(map.has('UB'), false);
  });
});
