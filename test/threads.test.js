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
  advanceWatermark, indexMessage, mentionedByName, readState, titleOf,
} from '../src/threads.js';
import { d1 } from './d1.js';

// Made-up ids and names only.
const PEOPLE = [
  {
    id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['helix'],
  },
  {
    id: 2, email: 'b@staff.example', name: 'B', staff: 1, teams: ['helix'],
  },
];
const db = () => d1({ teams: [{ slug: 'helix', name: 'Helix' }], people: PEOPLE });
const T = 'slack:E1:C1:1.1';
const msg = (id, at, extra = {}) => ({
  source: 'slack',
  tenant: 'E1',
  channelId: 'C1',
  rootId: '1.1',
  id,
  thread: T,
  at,
  author: 'Cy',
  person: null,
  staff: false,
  counted: true,
  deleted: false,
  title: `title ${id}`,
  org: 'acme',
  team: 'helix',
  kind: 'channel',
  channelName: 'aem-acme',
  path: 'channels/acme/helix/slack-C1/1.1/',
  ...extra,
});
const thread = (D) => D.rows('SELECT * FROM threads WHERE thread = ?', T)[0];

describe('indexMessage', () => {
  it('derives the same thread row in any order', async () => {
    const msgs = [
      msg('1.1', '2026-10-21T10:00:00Z'),
      msg('1.2', '2026-10-21T10:05:00Z', { author: 'A', person: 1, staff: true }),
      msg('1.3', '2026-10-21T10:09:00Z', { author: 'bot', counted: false }),
    ];
    const forward = db();
    for (const m of msgs) {
      // eslint-disable-next-line no-await-in-loop
      await indexMessage(forward, m);
    }
    const backward = db();
    for (const m of [...msgs].reverse()) {
      // eslint-disable-next-line no-await-in-loop
      await indexMessage(backward, m);
    }
    for (const D of [forward, backward]) {
      const t = thread(D);
      assert.equal(t.title, 'title 1.1');
      assert.equal(t.root_at, '2026-10-21T10:00:00Z');
      assert.equal(t.last_at, '2026-10-21T10:05:00Z'); // the bot does not count
      assert.equal(t.last_author, 'A');
      assert.equal(t.last_staff, 1);
      assert.equal(t.any_at, '2026-10-21T10:09:00Z');
      assert.equal(t.messages, 3);
    }
  });

  it('titles a thread by its earliest known message until the root arrives', async () => {
    const D = db();
    await indexMessage(D, msg('1.3', '2026-10-21T10:09:00Z'));
    await indexMessage(D, msg('1.2', '2026-10-21T10:05:00Z'));
    assert.deepEqual([thread(D).title, thread(D).root_at], ['title 1.2', null]);
    await indexMessage(D, msg('1.1', '2026-10-21T10:00:00Z'));
    assert.deepEqual([thread(D).title, thread(D).root_at], ['title 1.1', '2026-10-21T10:00:00Z']);
  });

  it('follows a rule change: org, team and the pile-2 folder move together', async () => {
    const D = db();
    await indexMessage(D, msg('1.1', '2026-10-21T10:00:00Z'));
    await indexMessage(D, msg('1.1', '2026-10-21T10:00:00Z', { org: 'adobe', path: 'channels/adobe/helix/slack-C1/1.1/' }));
    assert.deepEqual([thread(D).org, thread(D).path], ['adobe', 'channels/adobe/helix/slack-C1/1.1/']);
  });

  it('drops a deleted message from the thread, and the deletion is final', async () => {
    const D = db();
    await indexMessage(D, msg('1.1', '2026-10-21T10:00:00Z'));
    await indexMessage(D, msg('1.2', '2026-10-21T10:05:00Z'));
    await indexMessage(D, msg('1.2', '2026-10-21T10:05:00Z', { deleted: true }));
    await indexMessage(D, msg('1.2', '2026-10-21T10:05:00Z')); // replayed original
    assert.equal(thread(D).last_at, '2026-10-21T10:00:00Z');
    assert.equal(thread(D).messages, 1);
  });

  it('moves the author\'s watermark when a team member posts', async () => {
    const D = db();
    await indexMessage(D, msg('1.2', '2026-10-21T10:05:00Z', { person: 2, staff: true }));
    assert.deepEqual(D.rows('SELECT person, read_at, via FROM watermarks'), [
      { person: 2, read_at: '2026-10-21T10:05:00Z', via: 'post' },
    ]);
  });
});

describe('advanceWatermark', () => {
  it('only moves forward', async () => {
    const D = db();
    await advanceWatermark(D, 1, T, '2026-10-21T10:05:00Z', 'open');
    await advanceWatermark(D, 1, T, '2026-10-21T10:01:00Z', 'react');
    assert.equal(D.rows('SELECT read_at FROM watermarks')[0].read_at, '2026-10-21T10:05:00Z');
    await advanceWatermark(D, 1, T, '2026-10-21T10:07:00Z', 'react');
    assert.deepEqual(D.rows('SELECT read_at, via FROM watermarks')[0], {
      read_at: '2026-10-21T10:07:00Z', via: 'react',
    });
  });
});

describe('readState', () => {
  const t = (key, last, extra = {}) => ({
    thread: key, kind: 'channel', last_at: last, any_at: last, ...extra,
  });
  const LAST = '2026-10-21T10:05:00Z';
  const EARLY = '2026-10-21T10:00:00Z';
  // 1 = me, 2 = teammate, 9 = staff outside the team
  const w = (person, key, readAt, staff = 1, inTeam = person !== 9) => ({
    person, thread: key, read_at: readAt, staff, in_team: inTeam ? 1 : 0,
  });

  it('tells unread, seen by others and unseen apart', () => {
    const [a, b, c, d] = readState([t('a', LAST), t('b', LAST), t('c', LAST), t('d', null)], [
      w(1, 'a', LAST),
      w(2, 'b', LAST),
      w(1, 'c', EARLY),
    ], [], 1);
    assert.deepEqual([a.unread, a.seenByOthers, a.unseen], [false, false, false]);
    assert.deepEqual([b.unread, b.seenByOthers, b.unseen, b.readers], [true, true, false, [2]]);
    // c: read, but before the last message
    assert.deepEqual([c.unread, c.seenByOthers, c.unseen], [true, false, true]);
    assert.deepEqual([d.unread, d.unseen, d.attention], [false, false, null]); // bots only
  });

  it('ranks attention: adobe, mentioned me, mentioned team, team, me', () => {
    const rows = readState([
      t('nobody', LAST),
      t('staff-elsewhere', LAST),
      t('mentioned-me', LAST),
      t('mentioned-team', LAST),
      t('teammate-read', LAST),
      t('all-read', LAST),
    ], [
      w(9, 'staff-elsewhere', LAST),
      w(9, 'mentioned-me', LAST),
      w(9, 'mentioned-team', LAST),
      w(1, 'mentioned-team', LAST),
      w(2, 'mentioned-team', EARLY),
      w(2, 'teammate-read', LAST),
      w(1, 'all-read', LAST),
      w(2, 'all-read', LAST),
    ], [
      { thread: 'mentioned-me', person: 1, at: LAST },
      { thread: 'mentioned-team', person: 2, at: LAST },
      { thread: 'all-read', person: 2, at: EARLY }, // read since: no longer asks for attention
    ], 1);
    assert.deepEqual(rows.map((r) => [r.thread, r.attention]), [
      ['nobody', 'adobe'],
      ['staff-elsewhere', 'team'],
      ['mentioned-me', 'mentioned-me'],
      ['mentioned-team', 'mentioned-team'],
      ['teammate-read', 'me'],
      ['all-read', null],
    ]);
    assert.deepEqual(rows[3].mentionedTeam, [2]);
    assert.equal(rows[1].unseenByAdobe, false); // staff outside the team saw it
    assert.deepEqual(rows[1].readers, []); // but they are not readers on this team
  });

  it('uses any message for alert threads, and never asks Adobe to look at them', () => {
    const [alert] = readState([t('x', null, { kind: 'alert', any_at: LAST })], [], [], 1);
    assert.deepEqual([alert.unread, alert.unseenByAdobe, alert.attention], [true, false, 'team']);
  });
});

describe('mentionedByName', () => {
  const people = [{ id: 1, name: 'Ada Lovelace' }, { id: 2, name: 'Bob Lovelace' }, { id: 3, name: 'Adam Smith' }, { id: 4, name: 'Cher' }];
  it('finds full names, including "Last, First", as whole words', () => {
    const hits = mentionedByName('hi Ada Lovelace and Lovelace, Bob; adam smithers and Cher', people);
    assert.deepEqual(hits.map((p) => p.id), [1, 2]);
  });
});

describe('titleOf', () => {
  it('prefers the subject, then the first line, without markdown', () => {
    assert.equal(titleOf('Outage', 'body'), 'Outage');
    assert.equal(titleOf(undefined, '\n> **Site down** since 9\nmore'), 'Site down since 9');
    assert.equal(titleOf(undefined, 'x'.repeat(200)).length, 140);
  });
});
