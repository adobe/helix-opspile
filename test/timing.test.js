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
import { api } from '../src/api.js';
import { Timing, withTiming } from '../src/timing.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

/** A clock that moves only when told to, as a Worker's does between I/O. */
function clock() {
  let t = 0;
  const now = () => t;
  now.tick = (ms) => {
    t += ms;
  };
  return now;
}

const later = (now, ms, value) => new Promise((resolve) => {
  setTimeout(() => {
    now.tick(ms);
    resolve(value);
  }, 1);
});

describe('Server-Timing', () => {
  it('counts parallel calls once in the busy time, and every call in the count', async () => {
    const now = clock();
    const timing = new Timing(now);
    now.tick(5);
    timing.mark('auth');
    // Two D1 calls at once (10 ms of D1 time), then one R2 call alone.
    await Promise.all([
      timing.time('d1', () => later(now, 10)),
      timing.time('d1', async () => 'ok'),
    ]);
    await timing.time('r2', () => later(now, 4));
    assert.equal(
      timing.header(),
      'auth;dur=5, d1;dur=10;desc="2 calls in 1 round", r2;dur=4;desc="1 call in 1 round", total;dur=19',
    );
  });

  it('times D1 statements and batches, and R2 reads with their bodies', async () => {
    const made = [];
    const DB = {
      prepare(sql) {
        const stmt = {
          sql,
          args: [],
          bind(...args) {
            const bound = { ...stmt, args };
            made.push(bound);
            return bound;
          },
          first: async () => ({ sql, args: stmt.args }),
        };
        return stmt;
      },
      // D1 only takes its own statements.
      batch: async (stmts) => stmts.map((s) => ({ results: [made.includes(s)] })),
    };
    const CHANNELS = fakeBucket({ 'a/1.md': 'one' });
    const timing = new Timing();
    const env = timing.wrap({ DB, CHANNELS, OTHER: 1 });
    assert.equal(env.OTHER, 1);
    assert.equal(timing.wrap(env), env);
    const one = env.DB.prepare('SELECT ?').bind(1);
    assert.equal((await one.first()).sql, 'SELECT ?');
    assert.deepEqual(await env.DB.batch([env.DB.prepare('SELECT ?').bind(2)]), [{ results: [true] }]);
    const listed = await env.CHANNELS.list({ prefix: 'a/' });
    assert.equal(await (await env.CHANNELS.get(listed.objects[0].key)).text(), 'one');
    assert.match(timing.header(), /^d1;dur=[\d.]+;desc="2 calls in 2 rounds", r2;dur=[\d.]+;desc="3 calls in 3 rounds", total;dur=[\d.]+$/);
  });

  it('is on every API answer, with durations and counts only', async () => {
    const DB = d1({
      teams: [{ slug: 'helix', name: 'Helix' }],
      people: [{
        id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
      }],
    });
    const me = {
      id: 1, name: 'Ada', email: 'ada@staff.example', teams: [{ slug: 'helix', name: 'Helix' }],
    };
    const url = new URL('https://opspile.example/api/inbox?team=helix');
    const res = await api(new Request(url), { DB, CHANNELS: fakeBucket() }, url, { viewer: me });
    assert.equal(res.status, 200);
    const header = res.headers.get('server-timing');
    assert.match(header, /^auth;dur=[\d.]+, d1;dur=[\d.]+;desc="\d+ calls in \d+ rounds", total;dur=[\d.]+$/);
    assert.doesNotMatch(header, /helix|ada/i);
  });

  it('copies a response whose headers cannot change', async () => {
    const timing = new Timing();
    const frozen = new Response('x');
    // As fetch() answers: headers that cannot change.
    class Immutable extends Headers {
      // eslint-disable-next-line class-methods-use-this
      set() {
        throw new TypeError('immutable');
      }
    }
    Object.defineProperty(frozen, 'headers', { value: new Immutable({ 'content-type': 'text/plain' }) });
    const res = withTiming(frozen, timing);
    assert.notEqual(res, frozen);
    assert.match(res.headers.get('server-timing'), /^total;dur=/);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(await res.text(), 'x');
  });
});
