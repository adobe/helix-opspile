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
import { Meter } from '../src/cogs/meter.js';
import { underlying } from '../src/d1batch.js';
import {
  BOOKMARK_HEADER, bookmarkOf, constraintFor, isBookmark, primaryBookmark, sessionDatabase,
  withBookmark,
} from '../src/d1session.js';
import { notifyRoom } from '../src/notify.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

const OLD = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
const NEW = '00000085-0000024d-00000001-0123456789abcdef0123456789abcdef';

/** `db` with D1's `withSession`: each session's queries are `db`'s, its bookmark `NEW`. */
function replicated(db) {
  const sessions = [];
  return {
    sessions,
    db: new Proxy(db, {
      get(target, prop) {
        if (prop === 'withSession') {
          return (constraint) => {
            const s = {
              constraint,
              asked: 0,
              prepare: (sql) => {
                s.asked += 1;
                return target.prepare(sql);
              },
              batch: (stmts) => target.batch(stmts),
              getBookmark: () => (s.asked ? NEW : null),
            };
            sessions.push(s);
            return s;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }),
  };
}

const get = (headers = {}) => new Request('https://opspile.example/api/inbox', { headers });

describe('D1 sessions', () => {
  it('know a bookmark, and pass nothing else to D1', () => {
    assert.equal(isBookmark(OLD), true);
    for (const bad of ['', 'first-primary', 'x'.repeat(40), `${OLD}'; --`, null, 42]) {
      assert.equal(isBookmark(bad), false, String(bad));
    }
  });

  it('start a read from the bookmark the page sent, anywhere without one, a write at the primary', () => {
    assert.equal(constraintFor(get({ [BOOKMARK_HEADER]: OLD })), OLD);
    assert.equal(constraintFor(get()), 'first-unconstrained');
    assert.equal(constraintFor(get({ [BOOKMARK_HEADER]: 'nonsense' })), 'first-unconstrained');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const req = new Request('https://opspile.example/api/post', {
        method, headers: { [BOOKMARK_HEADER]: OLD },
      });
      assert.equal(constraintFor(req), 'first-primary', method);
    }
  });

  it('are the binding\'s for what is kept across requests, and leave a binding without them alone', () => {
    const { db } = replicated(d1());
    const s = sessionDatabase(db, 'first-unconstrained');
    assert.equal(underlying(s), underlying(db));
    assert.ok(s.sqlite && s.sqlite === db.sqlite, 'what a session does not have is the binding\'s');
    assert.equal(sessionDatabase(d1(), 'first-unconstrained'), null);
    assert.equal(sessionDatabase(null, 'first-primary'), null);
    assert.equal(bookmarkOf({ getBookmark: () => 'not one' }), null);
    const gone = () => {
      throw new Error('gone');
    };
    assert.equal(bookmarkOf({ getBookmark: gone }), null);
  });

  it('say their bookmark on the answer, a copy where its headers cannot change, not on a WebSocket', () => {
    assert.equal(withBookmark(new Response('x'), NEW).headers.get(BOOKMARK_HEADER), NEW);
    const fixed = Response.redirect('https://opspile.example/inbox', 302);
    assert.equal(withBookmark(fixed, NEW).headers.get(BOOKMARK_HEADER), NEW);
    const ws = { status: 101, webSocket: {}, headers: new Headers() };
    assert.equal(withBookmark(ws, NEW), ws);
    const plain = new Response('x');
    assert.equal(withBookmark(plain, null).headers.has(BOOKMARK_HEADER), false);
  });

  it('run every query of an /api request, and say where it got to', async () => {
    const { db, sessions } = replicated(d1({
      teams: [{ slug: 'helix', name: 'Helix' }],
      people: [{
        id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
      }],
    }));
    const me = {
      id: 1, name: 'Ada', email: 'ada@staff.example', teams: [{ slug: 'helix', name: 'Helix' }],
    };
    const url = new URL('https://opspile.example/api/inbox?team=helix');
    const req = new Request(url, { headers: { [BOOKMARK_HEADER]: OLD } });
    const res = await api(req, { DB: db, CHANNELS: fakeBucket() }, url, { viewer: me });
    assert.equal(res.status, 200);
    assert.deepEqual(sessions.map((s) => s.constraint), [OLD]);
    assert.ok(sessions[0].asked > 0, 'the queries went through the session');
    assert.equal(res.headers.get(BOOKMARK_HEADER), NEW);
    // Without sessions (local, tests): as before, and no bookmark.
    const local = { DB: d1(), CHANNELS: fakeBucket() };
    const plain = await api(new Request(url), local, url, { viewer: me });
    assert.equal(plain.headers.has(BOOKMARK_HEADER), false);
  });

  it('are counted for COGS as the database is', async () => {
    const { db } = replicated(d1());
    const meter = new Meter({ DB: db, USAGE: { writeDataPoint() {} } });
    const env = meter.env({});
    const s = env.DB.withSession('first-primary');
    await s.prepare('SELECT 1 AS x').first();
    const counted = [...meter.scopes.flatMap((x) => [...x.counts.keys()])];
    assert.ok(counted.some((k) => k.includes('d1') && k.includes('rows_read')), counted.join());
  });

  it('give a room event the primary\'s bookmark, so the reads it sets off see what changed', async () => {
    const { db, sessions } = replicated(d1());
    assert.equal(await primaryBookmark({ DB: db }), NEW);
    assert.equal(sessions.at(-1).constraint, 'first-primary');
    assert.equal(await primaryBookmark({ DB: d1() }), null);
    assert.equal(await primaryBookmark({}), null);

    const told = [];
    const ROOMS = {
      idFromName: (n) => n,
      get: (team) => ({
        fetch: async (u, init) => told.push([team, JSON.parse(init.body)]),
      }),
    };
    await notifyRoom({ DB: db, ROOMS }, ['a', 'b', 'a'], { type: 'thread', thread: 't' });
    assert.deepEqual(told, [
      ['a', { type: 'thread', thread: 't', bookmark: NEW }],
      ['b', { type: 'thread', thread: 't', bookmark: NEW }],
    ]);
    assert.equal(sessions.filter((s) => s.constraint === 'first-primary').length, 2, 'asked once per event');
    // Without sessions, the event goes as it was.
    told.length = 0;
    await notifyRoom({ DB: d1(), ROOMS }, 'a', { type: 'draft', thread: 't' });
    assert.deepEqual(told, [['a', { type: 'draft', thread: 't' }]]);
  });
});
