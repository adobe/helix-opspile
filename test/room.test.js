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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Outside workerd, a Durable Object's base class is a plain one.
registerHooks({
  resolve: (specifier, context, next) => (specifier === 'cloudflare:workers'
    ? { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true }
    : next(specifier, context)),
});
const { TeamRoom } = await import('../src/room.js');

function fakeCtx(sockets = []) {
  const kept = new Map();
  let alarm = null;
  return {
    kept,
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
      },
    },
    clearAlarm() {
      alarm = null;
    },
  };
}

/**
 * D1 as the room uses it: a watermark write, with `during` running while it is on its way, and
 * for scoped sockets the place of a thread and who is in its channel (`channels`: thread to
 * channel, `people`: channel to people).
 */
function fakeDb(during = async () => {}, { channels = {}, people = {} } = {}) {
  const writes = [];
  return {
    writes,
    prepare: (sql) => ({
      bind: (...args) => ({
        async run() {
          writes.push(args[2]);
          await during();
        },
        first: async () => (channels[args[0]] ? { source: 'slack', channel_id: channels[args[0]] } : null),
        all: async () => ({
          // Who follows what a thread shows (src/follows.js): nobody here.
          results: sql.includes('json_each') && !sql.includes('person_follows')
            ? JSON.parse(args[0]).filter((p) => (people[args[2]] || []).includes(p))
              .map((person) => ({ person }))
            : [],
        }),
      }),
    }),
  };
}

/** A socket of the room's, of `person`, that keeps what it hears. */
function fakeSocket(person, scope = 'team') {
  const heard = [];
  return { heard, tags: [String(person), 'readwrite', scope], send: (d) => heard.push(JSON.parse(d)) };
}

describe('the room\'s read flush', () => {
  it('writes the reads to D1 and forgets them', async () => {
    const DB = fakeDb();
    const ctx = fakeCtx();
    const room = new TeamRoom(ctx, { DB });
    await room.read(1, 't', '2026-10-21T10:00:00Z');
    ctx.clearAlarm();
    await room.alarm();
    assert.deepEqual(DB.writes, ['2026-10-21T10:00:00Z']);
    assert.equal(ctx.kept.size, 0);
  });

  it('keeps a newer read that comes in during the write, and writes it next', async () => {
    const ctx = fakeCtx();
    const env = {};
    const room = new TeamRoom(ctx, env);
    env.DB = fakeDb(async () => {
      if (env.DB.writes.length === 1) {
        await room.read(1, 't', '2026-10-21T10:05:00Z');
      }
    });
    await room.read(1, 't', '2026-10-21T10:00:00Z');
    ctx.clearAlarm();
    await room.alarm();
    assert.equal(ctx.kept.get('read:1:t').at, '2026-10-21T10:05:00Z');
    assert.ok(await ctx.storage.getAlarm());
    ctx.clearAlarm();
    await room.alarm();
    assert.deepEqual(env.DB.writes, ['2026-10-21T10:00:00Z', '2026-10-21T10:05:00Z']);
    assert.equal(ctx.kept.size, 0);
  });

  it('announces the reads once they are in D1, not before', async () => {
    const ws = fakeSocket(2);
    const ctx = fakeCtx([ws]);
    const env = {};
    const room = new TeamRoom(ctx, env);
    // What the socket had heard by the time D1 had the write.
    let before;
    env.DB = fakeDb(async () => {
      before = ws.heard.map((e) => e.type);
    });
    await room.read(1, 't', '2026-10-21T10:00:00Z');
    assert.deepEqual(ws.heard.map((e) => e.type), ['read']);
    assert.deepEqual(env.DB.writes, []);
    ctx.clearAlarm();
    await room.alarm();
    assert.deepEqual(before, ['read']);
    assert.deepEqual(ws.heard.at(-1), {
      type: 'reads', reads: [{ person: 1, thread: 't', at: '2026-10-21T10:00:00Z' }],
    });
    // Nothing left: the next alarm (there is none) would announce nothing.
    ws.heard.length = 0;
    await room.alarm();
    assert.deepEqual(ws.heard, []);
  });

  it('tells a scoped socket only of the threads of its channels', async () => {
    const team = fakeSocket(2);
    const guest = fakeSocket(3, 'scoped');
    const ctx = fakeCtx([team, guest]);
    const DB = fakeDb(async () => {}, { channels: { t: 'C1', u: 'C2' }, people: { C1: [3] } });
    const room = new TeamRoom(ctx, { DB });
    await room.read(1, 't', '2026-10-21T10:00:00Z');
    await room.read(1, 'u', '2026-10-21T10:01:00Z');
    ctx.clearAlarm();
    await room.alarm();
    const reads = (ws) => ws.heard.filter((e) => e.type === 'reads').map((e) => e.reads.map((r) => r.thread));
    assert.deepEqual(reads(team), [['t', 'u']]);
    assert.deepEqual(reads(guest), [['t']]);
  });
});

describe('the room\'s ping', () => {
  it('answers `ping` with `pong` in the runtime, so the inbox can ask without waking it', () => {
    const was = globalThis.WebSocketRequestResponsePair;
    globalThis.WebSocketRequestResponsePair = class {
      constructor(request, response) {
        this.request = request;
        this.response = response;
      }
    };
    try {
      const ctx = fakeCtx();
      let pair = null;
      ctx.setWebSocketAutoResponse = (p) => {
        pair = p;
      };
      // eslint-disable-next-line no-new
      new TeamRoom(ctx, {});
      assert.deepEqual({ ...pair }, { request: 'ping', response: 'pong' });
    } finally {
      globalThis.WebSocketRequestResponsePair = was;
    }
  });
});
