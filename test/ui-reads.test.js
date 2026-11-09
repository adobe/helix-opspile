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

/*
 * Your reads in flight (ui/inbox.js, `markRead` and `keepReads`): the room writes a read to D1
 * a few seconds after it, so an inbox loaded meanwhile still has the thread unread. The page
 * keeps it read, unless something came in since, and only for a while.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];

const ME = 7;
let state;
let page;
let clock;
let posted;

/** An inbox entry as the server sends it: unread, up to `at`. */
const entry = (thread, at, more = {}) => ({
  thread,
  last_at: at,
  any_at: at,
  unread: true,
  unseen: true,
  unseenByAdobe: true,
  mentionedMe: false,
  unreadMentions: 0,
  mentionedTeam: [],
  readers: [],
  attention: 'team',
  ...more,
});

beforeEach(() => {
  clock = 1_000_000;
  posted = [];
  state = {
    me: { id: ME }, sockets: [], team: 'ops', as: null, data: { me: {}, threads: [] },
  };
  const a = js.indexOf('function markRead(t)');
  const b = js.indexOf('// Live updates reload the inbox', a);
  assert.ok(a >= 0 && b > a);
  const memberLast = (m, kind) => (kind === 'alert' ? m.any_at : m.last_at) || m.any_at;
  // eslint-disable-next-line no-new-func
  page = new Function('state', 'memberLast', 'personal', 'fetch', 'lastOf', 'render', 'Date', `${js.slice(a, b)}\nreturn { markRead, keepReads };`)(
    state,
    memberLast,
    () => true,
    (url, init) => posted.push(JSON.parse(init.body)),
    () => true,
    () => {},
    { now: () => clock },
  );
});

describe('reads in flight', () => {
  it('keeps a thread read when a reload brings it before the room has written the read', () => {
    const t = entry('a', '2026-11-05T10:00Z');
    state.data.threads = [t];
    page.markRead(t);
    assert.equal(t.unread, false);
    assert.deepEqual(posted.map((p) => [p.thread, p.at]), [['a', '2026-11-05T10:00Z']]);
    // The reload a second later: the server has it unread still.
    const again = entry('a', '2026-11-05T10:00Z');
    page.keepReads([again]);
    assert.equal(again.unread, false);
    assert.equal(again.unseen, false);
    assert.equal(again.attention, null);
    assert.deepEqual(again.readers, [ME]);
  });

  it('shows what came in after the read', () => {
    const t = entry('a', '2026-11-05T10:00Z');
    page.markRead(t);
    const newer = entry('a', '2026-11-05T10:05Z');
    page.keepReads([newer]);
    assert.equal(newer.unread, true);
  });

  it('leaves the threads it did not read alone', () => {
    page.markRead(entry('a', '2026-11-05T10:00Z'));
    const other = entry('b', '2026-11-05T09:00Z');
    page.keepReads([other]);
    assert.equal(other.unread, true);
  });

  it('keeps a group read only while every member of it is read to its end', () => {
    const members = [
      { thread: 'a', last_at: '2026-11-05T10:00Z', any_at: '2026-11-05T10:00Z' },
      { thread: 'b', last_at: '2026-11-05T09:00Z', any_at: '2026-11-05T09:00Z' },
    ];
    page.markRead(entry('a', '2026-11-05T10:00Z', { members }));
    const same = entry('a', '2026-11-05T10:00Z', { members });
    page.keepReads([same]);
    assert.equal(same.unread, false);
    const moved = [members[0], { ...members[1], last_at: '2026-11-05T10:01Z' }];
    const grown = entry('a', '2026-11-05T10:01Z', { members: moved });
    page.keepReads([grown]);
    assert.equal(grown.unread, true);
  });

  it('holds a read for a while only, and not for someone you view as', () => {
    page.markRead(entry('a', '2026-11-05T10:00Z'));
    state.as = 'someone';
    const theirs = entry('a', '2026-11-05T10:00Z');
    page.keepReads([theirs]);
    assert.equal(theirs.unread, true);
    state.as = null;
    clock += 31 * 1000;
    const late = entry('a', '2026-11-05T10:00Z');
    page.keepReads([late]);
    assert.equal(late.unread, true);
  });
});
