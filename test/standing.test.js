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
import {
  customerStanding, mutedOf, regularsOf, setMark, standingOf,
} from '../src/standing.js';
import { indexMessage, recordMentions } from '../src/threads.js';
import { d1 } from './d1.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-30T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();

describe('regularsOf', () => {
  it('takes the fewest customers that have four in five of the messages', () => {
    assert.deepEqual(regularsOf([
      { org: 'c', n: 6 }, { org: 'a', n: 60 }, { org: 'b', n: 30 }, { org: 'd', n: 4 },
      ...Array.from({ length: 6 }, (_, i) => ({ org: `x${i}`, n: 1 })),
    ]), ['a', 'b']);
  });

  it('takes no more than a fifth of the customers, and always one', () => {
    const flat = Array.from({ length: 10 }, (_, i) => ({ org: `o${i}`, n: 10 }));
    assert.deepEqual(regularsOf(flat), ['o0', 'o1']);
    assert.deepEqual(regularsOf([{ org: 'a', n: 2 }, { org: 'b', n: 1 }]), ['a']);
  });

  it('takes none with less than one in twenty of the messages', () => {
    const rows = [{ org: 'a', n: 40 }, { org: 'b', n: 4 },
      ...Array.from({ length: 30 }, (_, i) => ({ org: `x${i}`, n: 2 }))];
    assert.deepEqual(regularsOf(rows), ['a']);
  });

  it('has none without messages', () => {
    assert.deepEqual(regularsOf([]), []);
    assert.deepEqual(regularsOf([{ org: 'a', n: 0 }]), []);
  });
});

describe('standingOf', () => {
  it('is active where you posted or were mentioned in two weeks', () => {
    const s = standingOf([
      { org: 'a', n: 20, last: ago(1) },
      { org: 'b', n: 5, last: ago(20) },
      { org: 'c', n: 1, last: ago(3) },
    ], ['d', null], NOW);
    assert.deepEqual(s, { regular: ['a'], active: ['a', 'c', 'd'] });
  });
});

describe('customerStanding', () => {
  it('counts your messages of the last 90 days by customer, and your mentions of two weeks', async () => {
    const db = d1({ people: [{ id: 1, name: 'Dana' }, { id: 2, name: 'Sam' }] });
    const thread = (key, org) => db.sqlite.prepare(`INSERT INTO threads (thread, source, tenant,
      channel_id, root_id, team, org, kind, path, updated_at)
      VALUES (?, 'slack', 'T', ?, '1', 'edge', ?, 'channel', ?, ?)`)
      .run(key, `C-${org}`, org, `${org}/${key}`, ago(0));
    let id = 0;
    const message = (key, person, at, deleted = 0) => {
      id += 1;
      db.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person,
        deleted) VALUES ('slack', 'T', ?, ?, ?, ?, ?, ?)`)
        .run(`C-${key.split(':')[0]}`, String(id), key, at, person, deleted);
    };
    thread('a:1', 'a');
    thread('b:1', 'b');
    thread('c:1', 'c');
    thread('d:1', 'd');
    for (let i = 0; i < 9; i += 1) {
      message('a:1', 1, ago(2));
    }
    // Deleted, someone else's, or too old: not counted.
    for (let i = 0; i < 20; i += 1) {
      message('b:1', 1, ago(2), 1);
    }
    for (let i = 0; i < 20; i += 1) {
      message('b:1', 2, ago(2));
    }
    for (let i = 0; i < 20; i += 1) {
      message('c:1', 1, ago(120));
    }
    message('b:1', 1, ago(30));
    message('c:1', 1, ago(30));
    db.sqlite.prepare(`INSERT INTO mentions (thread, message, person, at, via)
      VALUES ('d:1', 'm', 1, ?, 'id'), ('c:1', 'n', 1, ?, 'id')`).run(ago(5), ago(40));
    const s = await customerStanding(db, 1, NOW);
    assert.deepEqual(s, { regular: ['a'], active: ['a', 'd'] });
  });
});

describe('customer marks', () => {
  /** Dana (1) posts in `a`'s channel 9 times two days ago, in `b`'s once; a mention in `c`. */
  async function marked() {
    const db = d1({ people: [{ id: 1, name: 'Dana' }] });
    db.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, team, org,
      kind, path, updated_at) VALUES ('a:1', 'slack', 'T', 'CA', '1', 'edge', 'a', 'channel', 'a/',
      ?), ('c:1', 'slack', 'T', 'CC', '1', 'edge', 'c', 'channel', 'c/', ?)`).run(ago(0), ago(0));
    for (let i = 0; i < 9; i += 1) {
      db.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person)
        VALUES ('slack', 'T', 'CA', ?, 'a:1', ?, 1)`).run(String(i), ago(2));
    }
    db.sqlite.prepare(`INSERT INTO mentions (thread, message, person, at, via)
      VALUES ('c:1', 'm', 1, ?, 'id')`).run(ago(3));
    return db;
  }

  it('leaves out of your regulars what you posted before you took a customer out of them', async () => {
    const db = await marked();
    assert.deepEqual((await customerStanding(db, 1, NOW)).regular, ['a']);
    assert.deepEqual(await setMark(db, 1, { org: 'a', mark: 'unstar' }, ago(1)), { was: null });
    const s = await customerStanding(db, 1, NOW);
    // Still active: you posted there lately.
    assert.deepEqual(s, { regular: [], active: ['a', 'c'] });
    // Undone, the row goes.
    assert.deepEqual(await setMark(db, 1, { org: 'a', mark: 'unstar', at: null }, ago(0)), { was: ago(1) });
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM customer_marks').get().n, 0);
    assert.deepEqual((await customerStanding(db, 1, NOW)).regular, ['a']);
  });

  it('leaves out what came before you muted a customer, for regulars and for being active', async () => {
    const db = await marked();
    await setMark(db, 1, { org: 'a', mark: 'mute' }, ago(1));
    await setMark(db, 1, { org: 'c', mark: 'mute' }, ago(1));
    assert.deepEqual(await customerStanding(db, 1, NOW), { regular: [], active: [] });
  });

  it('takes a mark of unstar or mute, and a time before now to undo it', async () => {
    const db = d1({ people: [{ id: 1, name: 'Dana' }] });
    assert.equal((await setMark(db, 1, { org: 'a', mark: 'star' })).status, 400);
    assert.equal((await setMark(db, 1, { org: '', mark: 'mute' })).status, 400);
    assert.equal((await setMark(db, 1, { org: 'a', mark: 'mute', at: 'later' })).status, 400);
    assert.equal((await setMark(db, 1, { org: 'a', mark: 'mute', at: '2999-01-01T00:00:00Z' })).status, 400);
  });
});

describe('a muted customer in the personal view', () => {
  const me = {
    id: 2, email: 'dana@staff.example', name: 'Dana', teams: [],
  };
  let n = 0;
  const minute = (m) => `2026-10-21T10:${String(m).padStart(2, '0')}:00.000Z`;
  const say = (DB, {
    thread, channelId, org = 'acme', person = null, at,
  }) => {
    n += 1;
    return indexMessage(DB, {
      source: 'slack',
      tenant: 'E1',
      channelId,
      org,
      team: 'helix',
      kind: 'channel',
      counted: true,
      staff: Boolean(person),
      person,
      rootId: thread,
      id: `${thread}.${n}`,
      thread,
      at: minute(at),
      title: thread,
      path: `${thread}/`,
    }).then(() => `slack:E1:${channelId}:${thread}.${n}`);
  };
  const listed = async (DB) => (await inbox({ DB }, me, null, { personal: true })).threads
    .map((t) => t.thread).sort();

  it('leaves it until you post in one of its threads again, then all of it is back', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix' }], people: [{ id: 1, name: 'Sam' }, { id: 2, name: 'Dana', staff: 1 }] });
    await say(DB, {
      thread: 'a1', channelId: 'C1', person: 2, at: 1,
    });
    await say(DB, {
      thread: 'b1', channelId: 'C2', person: 2, at: 2,
    });
    await say(DB, {
      thread: 'o1', channelId: 'C3', org: 'other', person: 2, at: 3,
    });
    assert.deepEqual(await listed(DB), ['a1', 'b1', 'o1']);
    await setMark(DB, 2, { org: 'acme', mark: 'mute' }, minute(10));
    assert.deepEqual(await listed(DB), ['o1']);
    assert.deepEqual(await mutedOf(DB, 2), ['acme']);
    // Someone else posting does not bring it back, nor does a mention of you: you did not act.
    await say(DB, {
      thread: 'a2', channelId: 'C1', person: 1, at: 11,
    });
    const m = await say(DB, {
      thread: 'b2', channelId: 'C2', person: 1, at: 12,
    });
    await recordMentions(DB, { thread: 'b2', message: m, at: minute(13) }, [{ person: 2, via: 'id' }]);
    assert.deepEqual(await listed(DB), ['o1']);
    // Posting in C1 lifts the mute: every channel of the customer is back.
    await say(DB, {
      thread: 'a3', channelId: 'C1', person: 2, at: 14,
    });
    assert.deepEqual(await listed(DB), ['a1', 'a2', 'a3', 'b1', 'b2', 'o1']);
    assert.deepEqual(await mutedOf(DB, 2), []);
  });

  it('leaves what you follow of it out too, whatever its activity, until you act on it', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix' }], people: [{ id: 1, name: 'Sam' }, { id: 2, name: 'Dana', staff: 1 }] });
    DB.sqlite.prepare(`INSERT INTO person_follows (person, tech, added_at)
      VALUES (2, 'xw', ?)`).run(minute(0));
    await say(DB, {
      thread: 'f1', channelId: 'C1', person: 1, at: 1,
    });
    await say(DB, {
      thread: 'f2', channelId: 'C1', person: 1, at: 2,
    });
    for (const t of ['f1', 'f2']) {
      DB.sqlite.prepare('INSERT INTO thread_tech (thread, tech, p) VALUES (?, \'xw\', 1)').run(t);
    }
    assert.deepEqual(await listed(DB), ['f1', 'f2']);
    await setMark(DB, 2, { org: 'acme', mark: 'mute' }, minute(10));
    assert.deepEqual(await listed(DB), []);
    await say(DB, {
      thread: 'f2', channelId: 'C1', person: 1, at: 11,
    });
    assert.deepEqual(await listed(DB), []);
    await say(DB, {
      thread: 'f2', channelId: 'C1', person: 2, at: 12,
    });
    assert.deepEqual(await listed(DB), ['f1', 'f2']);
  });
});
