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
import { customerStanding, regularsOf, standingOf } from '../src/standing.js';
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
