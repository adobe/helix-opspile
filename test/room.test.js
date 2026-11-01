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

function fakeCtx() {
  const kept = new Map();
  let alarm = null;
  return {
    kept,
    getWebSockets: () => [],
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

/** D1 as the room uses it: a watermark write, with `during` running while it is on its way. */
function fakeDb(during = async () => {}) {
  const writes = [];
  return {
    writes,
    prepare: () => ({
      bind: (...args) => ({
        async run() {
          writes.push(args[2]);
          await during();
        },
      }),
    }),
  };
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
});
