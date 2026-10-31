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
import { d1 } from './d1.js';
import {
  cleanExpertEvent, expertEvents, pruneExpertEvents, recordExpertEvent, recordList,
} from '../src/expertevents.js';

// Made-up ids and names only.
const PEOPLE = [1, 2].map((id) => ({
  id, email: `p${id}@staff.example`, name: `P${id}`, staff: 1,
}));
const THREAD = 'slack:E1:C1:1.1';
const candidates = [
  { id: 'U3', person: 3, features: { channel: 1, meaning: 1 / 3, member: -1 } },
  { id: 'U4', person: 4, features: { channel: 0.5, words: Infinity, note: 'text' } },
];

describe('what is done with the expert finder\'s lists (src/expertevents.js)', () => {
  const env = () => ({ DB: d1({ people: PEOPLE }) });
  const me = { id: 1 };

  it('records a list with its candidates\' numbers, and only the numbers', async () => {
    const e = env();
    const list = await recordList(e, me, THREAD, { finder: 'f1', candidates });
    assert.ok(list > 0);
    const [ev] = (await expertEvents(e)).events;
    assert.equal(ev.action, 'list');
    assert.equal(ev.finder, 'f1');
    assert.deepEqual(ev.candidates.map((c) => [c.id, c.person, c.pos]), [['U3', 3, 0], ['U4', 4, 1]]);
    assert.deepEqual(ev.candidates[0].features, { channel: 1, meaning: 0.3333, member: -1 });
    assert.deepEqual(ev.candidates[1].features, { channel: 0.5 });
  });

  it('records nothing while viewing as someone else, or for an empty list', async () => {
    const e = env();
    assert.equal(await recordList(e, { id: 1, readonly: true }, THREAD, { candidates }), null);
    assert.equal(await recordList(e, me, THREAD, { candidates: [] }), null);
    assert.equal((await expertEvents(e)).events.length, 0);
  });

  it('refuses events it cannot learn from', () => {
    const bad = (body) => assert.ok(cleanExpertEvent(body).error, JSON.stringify(body));
    bad(null);
    bad({ list: 1 });
    bad({ list: 0, action: 'shown' });
    bad({ list: '1', action: 'shown' });
    bad({ list: 1, action: 'like' });
    bad({ list: 1, action: 'pick' });
    bad({ list: 1, action: 'reject' });
    assert.deepEqual(cleanExpertEvent({ list: 1, action: 'shown', account: 'U3' }), { list: 1, action: 'shown' });
  });

  it('records the page\'s events about one\'s own lists, a pick at its place in the list', async () => {
    const e = env();
    const list = await recordList(e, me, THREAD, { finder: 'f1', candidates });
    for (const action of ['shown', 'open', 'dismiss', 'open']) {
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await recordExpertEvent(e, me, { list, action }), { ok: true });
    }
    assert.deepEqual(await recordExpertEvent(e, me, { list, action: 'pick', account: 'U4' }), { ok: true });
    assert.match((await recordExpertEvent(e, me, { list, action: 'pick', account: 'U9' })).error, /not on/);
    assert.match((await recordExpertEvent(e, { id: 2 }, { list, action: 'shown' })).error, /no such list/);
    assert.match((await recordExpertEvent(e, me, { list: list + 9, action: 'shown' })).error, /no such list/);
    const { events } = await expertEvents(e);
    assert.deepEqual(events.map((x) => x.action), ['list', 'shown', 'open', 'dismiss', 'open', 'pick']);
    const pick = events[events.length - 1];
    assert.deepEqual([pick.list, pick.thread, pick.account, pick.pos], [list, THREAD, 'U4', 1]);
    assert.equal('data' in pick, false);
  });

  it('gives events back page by page, and prunes the old ones', async () => {
    const e = env();
    const old = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-10-30T00:00:00Z');
    const list = await recordList(e, me, THREAD, { candidates }, old);
    await recordExpertEvent(e, me, { list, action: 'shown' }, old);
    await recordList(e, me, THREAD, { candidates }, now);
    const first = await expertEvents(e, 0, 2);
    assert.equal(first.events.length, 2);
    const rest = await expertEvents(e, first.next, 2);
    assert.equal(rest.events.length, 1);
    assert.equal(rest.next, null);
    assert.equal((await pruneExpertEvents(e, now)).deleted, 2);
    assert.equal((await expertEvents(e)).events.length, 1);
  });
});
