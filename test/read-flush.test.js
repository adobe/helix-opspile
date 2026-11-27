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
 * A read from the room to the inbox on screen: the room (src/room.js) announces a read at once
 * and writes it to D1 FLUSH_MS later, in its alarm; the inbox (ui/inbox.js) reloads from D1 half
 * a second after an announcement. Here both run on one clock, with D1 as the room writes it and
 * the inbox as `/api/inbox` reads it, so a reload before the flush gets the old unread state, as
 * in production (the dev server writes before it announces, which hides this).
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { SCRIPTS } from './ui.js';

registerHooks({
  resolve: (specifier, context, next) => (specifier === 'cloudflare:workers'
    ? { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true }
    : next(specifier, context)),
});
const { TeamRoom, FLUSH_MS } = await import('../src/room.js');

const ME = 7;
const MATE = 8;
const AT = '2026-11-05T10:00Z';

let clock;
let timers;
let busy;
let watermarks;
let room;
let state;
let page;
let reloads;
let latest;

/** Runs what is due in the next `ms`, in order, waiting for what each started. */
async function later(ms) {
  const end = clock + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(busy.splice(0));
    timers.sort((a, b) => a.at - b.at);
    if (!timers.length || timers[0].at > end) {
      break;
    }
    const t = timers.shift();
    clock = t.at;
    // eslint-disable-next-line no-await-in-loop
    await t.fn();
  }
  clock = end;
}

/** `watermarks` as the room writes them (advanceWatermark in src/threads.js). */
const DB = {
  prepare: () => ({
    bind: (person, thread, at) => ({
      async run() {
        const key = `${person}:${thread}`;
        if (!watermarks.has(key) || at > watermarks.get(key)) {
          watermarks.set(key, at);
        }
      },
    }),
  }),
};

/** `/api/inbox` for ME: thread `a`, unread up to what D1 has, and who read it to its end. */
function inbox() {
  const read = (p) => (watermarks.get(`${p}:a`) || '') >= latest;
  return [{
    thread: 'a',
    last_at: AT,
    any_at: latest,
    unread: !read(ME),
    unseen: !read(ME),
    unseenByAdobe: true,
    mentionedMe: false,
    unreadMentions: 0,
    mentionedTeam: [],
    readers: [ME, MATE].filter(read),
    attention: read(ME) ? null : 'team',
  }];
}

/** A WebSocket of the room's: what the room sends it goes to `heard`. */
function socket(person, heard = () => {}) {
  return { tags: [String(person), 'readwrite', 'team'], send: (data) => heard(JSON.parse(data)) };
}

beforeEach(() => {
  clock = 1_000_000;
  timers = [];
  busy = [];
  watermarks = new Map();
  reloads = 0;
  latest = AT;
  const kept = new Map();
  let alarm = null;
  const sockets = [];
  const ctx = {
    getWebSockets: () => sockets,
    getTags: (ws) => ws.tags,
    storage: {
      get: async (k) => kept.get(k),
      put: async (k, v) => {
        kept.set(k, v);
      },
      delete: async (k) => kept.delete(k),
      list: async ({ prefix }) => new Map([...kept].filter(([k]) => k.startsWith(prefix))),
      getAlarm: async () => alarm,
      setAlarm: async (t) => {
        alarm = t;
        // The room sets it by the real clock.
        timers.push({
          at: clock + Math.round(t - Date.now()),
          fn: async () => {
            alarm = null;
            await room.alarm();
          },
        });
      },
    },
  };
  room = new TeamRoom(ctx, { DB });

  // The inbox on screen, ME's, in the team's view: thread `a` unread.
  state = {
    me: { id: ME }, sockets: [], team: 'ops', as: null, data: { me: {}, threads: inbox() },
  };
  let reload = null;
  const reloadSoon = () => {
    if (reload) {
      timers.splice(timers.indexOf(reload), 1);
    }
    reload = {
      at: clock + 500,
      fn: () => {
        reload = null;
        reloads += 1;
        state.data.threads = inbox();
        page.keepReads(state.data.threads);
      },
    };
    timers.push(reload);
  };
  const js = SCRIPTS['inbox.js'];
  const a = js.indexOf('const memberLast =');
  const b = js.indexOf('// Live updates reload the inbox', a);
  assert.ok(a >= 0 && b > a);
  // eslint-disable-next-line no-new-func
  page = new Function('state', 'personal', 'fetch', 'lastOf', 'render', 'Date', 'reloadSoon', `${js.slice(a, b)}\nreturn { markRead, keepReads, heardRead };`)(
    state,
    () => false,
    () => assert.fail('the page has a socket'),
    () => true,
    () => {},
    { now: () => clock },
    reloadSoon,
  );
  const mine = socket(ME, (ev) => page.heardRead(ev));
  sockets.push(mine, socket(ME), socket(MATE));
  state.sockets.push({
    team: 'ops',
    readyState: 1,
    send: (data) => busy.push(room.webSocketMessage(mine, data)),
  });
});

/** A read sent over another socket of the room's (another tab or device, or a teammate's). */
const readOn = (ws, at = AT) => busy.push(room.webSocketMessage(ws, JSON.stringify({ type: 'read', thread: 'a', at })));

describe('a read, from the room\'s announcement to its flush', () => {
  it('shows your read from another tab or device once the room has written it', async () => {
    readOn(room.ctx.getWebSockets()[1]);
    await later(FLUSH_MS + 1000);
    assert.equal(watermarks.get(`${ME}:a`), AT);
    assert.equal(state.data.threads[0].unread, false);
    assert.deepEqual(state.data.threads[0].readers, [ME]);
  });

  it('shows a teammate\'s read once the room has written it', async () => {
    readOn(room.ctx.getWebSockets()[2]);
    await later(FLUSH_MS + 1000);
    assert.deepEqual(state.data.threads[0].readers, [MATE]);
    assert.equal(state.data.threads[0].unread, true);
  });

  it('keeps your read from this tab read, and reloads nothing for it', async () => {
    page.markRead(state.data.threads[0]);
    for (let ms = 0; ms < FLUSH_MS + 1000; ms += 250) {
      // eslint-disable-next-line no-await-in-loop
      await later(250);
      assert.equal(state.data.threads[0].unread, false);
    }
    assert.equal(watermarks.get(`${ME}:a`), AT);
    assert.equal(reloads, 0);
  });

  it('persists the bot reply shown after an already-read post, even with a stale list', async () => {
    watermarks.set(`${ME}:a`, AT);
    const [stale] = inbox();
    latest = '2026-11-05T10:02Z';
    // The pane fetched the conversation after the list was loaded.
    page.markRead(stale, {
      messages: [
        { thread: 'a', at: AT }, { thread: 'a', at: latest, author: { kind: 'bot' } },
      ],
    });
    await later(31_000);
    assert.equal(watermarks.get(`${ME}:a`), latest);
    assert.equal(inbox()[0].unread, false, 'still read on a fresh page');
  });

  it('does not reload for a read that leaves a newer message unread', async () => {
    readOn(room.ctx.getWebSockets()[1], '2026-11-05T09:00Z');
    await later(FLUSH_MS + 1000);
    assert.equal(reloads, 0);
    assert.equal(state.data.threads[0].unread, true);
  });
});
