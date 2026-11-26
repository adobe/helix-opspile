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
import {
  batchable, batchedDatabase, overloaded, patientDatabase, underlying,
} from '../src/d1batch.js';
import { Meter } from '../src/cogs/meter.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

/** A D1 that counts its calls: `calls.batch` (each a list of SQL), `calls.one` (SQL). */
function counting() {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }],
    people: [
      {
        id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
      },
      {
        id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1,
      },
    ],
  });
  const calls = { batch: [], one: [] };
  const prepare = DB.prepare.bind(DB);
  const batch = DB.batch.bind(DB);
  DB.prepare = (sql) => {
    const wrap = (stmt) => ({
      sql,
      bind: (...a) => wrap(stmt.bind(...a)),
      all: () => calls.one.push(sql) && stmt.all(),
      first: (...c) => calls.one.push(sql) && stmt.first(...c),
      run: () => calls.one.push(sql) && stmt.run(),
      inner: stmt,
    });
    return wrap(prepare(sql));
  };
  DB.batch = (stmts) => {
    calls.batch.push(stmts.map((s) => s.sql));
    return batch(stmts.map((s) => s.inner));
  };
  return { DB, calls };
}

describe('d1 batch', () => {
  it('tells reads from writes', () => {
    assert.ok(batchable('SELECT 1'));
    assert.ok(batchable('  -- a note\n  WITH x AS (SELECT 1) SELECT * FROM x'));
    assert.ok(batchable('SELECT updated_at, deleted, created_at FROM threads'));
    assert.ok(!batchable('INSERT INTO people (name) VALUES (?)'));
    assert.ok(!batchable('WITH x AS (SELECT 1) DELETE FROM people WHERE id IN x'));
    assert.ok(!batchable('UPDATE people SET name = ?'));
    assert.ok(!batchable('PRAGMA table_info(people)'));
  });

  it('sends the reads asked for at once as one batch, with the answers each would get', async () => {
    const { DB, calls } = counting();
    const db = batchedDatabase(DB);
    const [all, first, name, none, missing] = await Promise.all([
      db.prepare('SELECT id, name FROM people ORDER BY id').all(),
      db.prepare('SELECT id, name FROM people WHERE id = ?').bind(2).first(),
      db.prepare('SELECT name FROM people WHERE id = ?').bind(1).first('name'),
      db.prepare('SELECT name FROM people WHERE id = ?').bind(9).first('name'),
      // Asked a moment later, by code that waited for something else first: the same batch.
      Promise.resolve().then(() => db.prepare('SELECT COUNT(*) AS n FROM people').first()),
    ]);
    assert.deepEqual(all.results, [{ id: 1, name: 'Ada' }, { id: 2, name: 'Bo' }]);
    assert.deepEqual(first, { id: 2, name: 'Bo' });
    assert.equal(name, 'Ada');
    assert.equal(none, null);
    assert.deepEqual(missing, { n: 2 });
    assert.equal(calls.batch.length, 1);
    assert.equal(calls.batch[0].length, 5);
    assert.deepEqual(calls.one, []);
  });

  it('sends writes at once, and a read alone on its own', async () => {
    const { DB, calls } = counting();
    const db = batchedDatabase(DB);
    await db.prepare("UPDATE people SET name = 'Ada L' WHERE id = 1").run();
    assert.deepEqual(calls.one, ["UPDATE people SET name = 'Ada L' WHERE id = 1"]);
    assert.equal((await db.prepare('SELECT name FROM people WHERE id = 1').first()).name, 'Ada L');
    assert.deepEqual(calls.batch, []);
    // A write asked for with reads is not held back for them.
    const [, read] = await Promise.all([
      db.prepare("UPDATE people SET name = 'Bo B' WHERE id = 2").run(),
      db.prepare('SELECT name FROM people WHERE id = 2').first('name'),
      db.prepare('SELECT name FROM people WHERE id = 1').first('name'),
    ]);
    assert.equal(read, 'Bo B');
    assert.deepEqual(calls.batch.length, 1);
  });

  it('fails only the query that fails, as it would on its own', async () => {
    const { DB, calls } = counting();
    const db = batchedDatabase(DB);
    const [ok, bad, col] = await Promise.allSettled([
      db.prepare('SELECT name FROM people WHERE id = 1').first('name'),
      db.prepare('SELECT nope FROM people').all(),
      db.prepare('SELECT name FROM people WHERE id = 1').first('nope'),
    ]);
    assert.equal(ok.value, 'Ada');
    assert.equal(bad.status, 'rejected');
    assert.equal(col.status, 'rejected');
    assert.match(col.reason.message, /D1_COLUMN_NOTFOUND/);
    // The batch, then each query on its own.
    assert.equal(calls.batch.length, 1);
    assert.equal(calls.one.length, 3);
  });

  it('passes statements of its own to batch()', async () => {
    const { DB } = counting();
    const db = batchedDatabase(DB);
    const [a, b] = await db.batch([
      db.prepare('SELECT name FROM people WHERE id = ?').bind(1),
      db.prepare("UPDATE people SET name = 'Bo C' WHERE id = 2"),
    ]);
    assert.deepEqual(a.results, [{ name: 'Ada' }]);
    assert.equal(b.meta.changes, 1);
  });

  it('leaves a database without batch() as it is', () => {
    const plain = { prepare: () => null };
    assert.equal(batchedDatabase(plain), plain);
    assert.equal(batchedDatabase(undefined), undefined);
  });

  describe('when D1 is overloaded', () => {
    const BUSY = 'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.';
    /**
     * `counting()`, whose first `n` calls (batch or one) D1 turns away as overloaded, in
     * `wrapper` (`batchedDatabase`, `patientDatabase`).
     */
    function busy(n, wrapper = batchedDatabase) {
      const { DB, calls } = counting();
      let left = n;
      const turnAway = (fn) => (...a) => {
        if (left > 0) {
          left -= 1;
          return Promise.reject(new Error(BUSY));
        }
        return fn(...a);
      };
      DB.batch = turnAway(DB.batch);
      const { prepare } = DB;
      DB.prepare = (sql) => {
        const wrap = (stmt) => ({
          ...stmt,
          bind: (...a) => wrap(stmt.bind(...a)),
          all: turnAway(stmt.all),
          first: turnAway(stmt.first),
          run: turnAway(stmt.run),
        });
        return wrap(prepare(sql));
      };
      const waits = [];
      const db = wrapper(DB, { pause: async (ms) => waits.push(ms) });
      return { db, calls, waits };
    }
    const reads = (db) => Promise.allSettled([
      db.prepare('SELECT name FROM people WHERE id = 1').first('name'),
      db.prepare('SELECT COUNT(*) AS n FROM people').first('n'),
    ]);

    it('knows the error, in each of its forms', () => {
      assert.ok(overloaded(new Error(BUSY)));
      assert.ok(overloaded(new Error('D1_ERROR: D1 DB is overloaded. Too many requests queued.')));
      assert.ok(overloaded(new Error('D1_ERROR', { cause: new Error('D1 DB is overloaded.') })));
      assert.ok(!overloaded(new Error('D1_ERROR: no such column: nope')));
      assert.ok(!overloaded(undefined));
    });

    it('asks the batch again once, after a moment, not each query on its own', async () => {
      const { db, calls, waits } = busy(1);
      const [name, n] = await reads(db);
      assert.equal(name.value, 'Ada');
      assert.equal(n.value, 2);
      assert.equal(calls.batch.length, 1); // the one that ran
      assert.deepEqual(calls.one, []);
      assert.equal(waits.length, 1);
      assert.ok(waits[0] >= 500 && waits[0] <= 1500, `waited ${waits[0]} ms`);
    });

    it('fails each read with it when D1 is still overloaded', async () => {
      const { db, calls, waits } = busy(2);
      const results = await reads(db);
      assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
      assert.ok(results.every((r) => overloaded(r.reason)));
      assert.deepEqual(calls.batch, []);
      assert.deepEqual(calls.one, []);
      assert.equal(waits.length, 1);
    });

    it('asks a read alone again once, and never a write', async () => {
      const alone = busy(1);
      assert.equal(await alone.db.prepare('SELECT name FROM people WHERE id = 2').first('name'), 'Bo');
      assert.equal(alone.waits.length, 1);
      const write = busy(1);
      await assert.rejects(write.db.prepare("UPDATE people SET name = 'X' WHERE id = 1").run(), /overloaded/);
      assert.deepEqual(write.waits, []);
      assert.deepEqual(write.calls.one, []);
    });

    describe('for the thread agents, without batches (patientDatabase)', () => {
      const patient = (n) => busy(n, patientDatabase);

      it('sends each query when it is asked, on its own, as the binding does', async () => {
        const { db, calls } = patient(0);
        const [name, n] = await reads(db);
        assert.deepEqual([name.value, n.value], ['Ada', 2]);
        assert.deepEqual(calls.batch, []);
        assert.equal(calls.one.length, 2);
      });

      it('asks a read again once, after a moment, however it is asked', async () => {
        for (const ask of [
          (db) => db.prepare('SELECT name FROM people WHERE id = ?').bind(2).first('name'),
          async (db) => (await db.prepare('SELECT name FROM people WHERE id = 2').all())
            .results[0].name,
          async (db) => (await db.prepare('SELECT name FROM people WHERE id = 2').run())
            .results[0].name,
        ]) {
          const { db, calls, waits } = patient(1);
          // eslint-disable-next-line no-await-in-loop
          assert.equal(await ask(db), 'Bo');
          assert.equal(calls.one.length, 1); // the one that ran
          assert.equal(waits.length, 1);
          assert.ok(waits[0] >= 500 && waits[0] <= 1500, `waited ${waits[0]} ms`);
        }
      });

      it('fails with it when D1 is still overloaded, and at once with any other error', async () => {
        const still = patient(2);
        await assert.rejects(still.db.prepare('SELECT name FROM people').all(), overloaded);
        assert.equal(still.waits.length, 1);
        assert.deepEqual(still.calls.one, []);
        const wrong = patient(0);
        await assert.rejects(wrong.db.prepare('SELECT nope FROM people').all(), /nope/);
        assert.deepEqual(wrong.waits, []);
      });

      it('never asks a write again, nor a batch with one', async () => {
        const write = patient(1);
        await assert.rejects(write.db.prepare("UPDATE people SET name = 'X' WHERE id = 1").run(), overloaded);
        const both = patient(1);
        await assert.rejects(both.db.batch([
          both.db.prepare('SELECT name FROM people WHERE id = 1'),
          both.db.prepare("UPDATE people SET name = 'X' WHERE id = 1"),
        ]), overloaded);
        for (const { waits, calls } of [write, both]) {
          assert.deepEqual(waits, []);
          assert.deepEqual([calls.one, calls.batch], [[], []]);
        }
      });

      it('asks a batch of reads again once, with D1\'s own statements', async () => {
        const { db, calls, waits } = patient(1);
        const [a, b] = await db.batch([
          db.prepare('SELECT name FROM people WHERE id = ?').bind(1),
          db.prepare('SELECT COUNT(*) AS n FROM people'),
        ]);
        assert.deepEqual([a.results, b.results], [[{ name: 'Ada' }], [{ n: 2 }]]);
        assert.equal(calls.batch.length, 1);
        assert.equal(waits.length, 1);
      });

      it('asks a session\'s reads again too', async () => {
        const { DB } = counting();
        let turned = false;
        const session = {
          prepare: (sql) => {
            const stmt = DB.prepare(sql);
            return {
              ...stmt,
              first: (...c) => {
                if (turned) {
                  return stmt.first(...c);
                }
                turned = true;
                return Promise.reject(new Error(BUSY));
              },
            };
          },
          batch: DB.batch,
        };
        const waits = [];
        const db = patientDatabase({ ...DB, withSession: () => session }, {
          pause: async (ms) => waits.push(ms),
        });
        const name = await db.withSession('first-primary').prepare('SELECT name FROM people WHERE id = 1').first('name');
        assert.equal(name, 'Ada');
        assert.equal(waits.length, 1);
      });

      it('keeps the binding under it, which what is kept by the database is keyed by', () => {
        const { DB } = counting();
        assert.equal(underlying(patientDatabase(DB)), DB);
        assert.equal(underlying(patientDatabase(batchedDatabase(DB))), DB);
        // In a Durable Object metered for COGS (src/cogs/meter.js): what the meter answers.
        const metered = new Meter({ DB, USAGE: { writeDataPoint() {} } }).env({}).DB;
        assert.equal(underlying(patientDatabase(metered)), underlying(metered));
        const plain = { batch: () => null };
        assert.equal(patientDatabase(plain), plain);
        assert.equal(patientDatabase(undefined), undefined);
      });
    });

    it('answers /api with 503 and Retry-After, not an exception', async () => {
      const DB = {
        prepare: () => {
          const stmt = {
            bind: () => stmt,
            all: () => Promise.reject(new Error(BUSY)),
            first: () => Promise.reject(new Error(BUSY)),
            run: () => Promise.reject(new Error(BUSY)),
          };
          return stmt;
        },
        batch: () => Promise.reject(new Error(BUSY)),
      };
      const me = {
        id: 1, name: 'Ada', email: 'ada@staff.example', teams: [{ slug: 'helix', name: 'Helix' }],
      };
      const url = new URL('https://opspile.example/api/inbox?team=helix');
      const res = await api(new Request(url), { DB, CHANNELS: fakeBucket() }, url, { viewer: me });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('retry-after'), '2');
      assert.ok(res.headers.get('server-timing'));
      assert.equal((await res.json()).busy, true);
    });
  });

  it('loads the inbox and opens a thread in a few D1 calls', async () => {
    const { DB } = counting();
    DB.sqlite.exec(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, path, root_at, last_at, any_at, messages, updated_at)
      VALUES ('slack:E1:C1:1.1', 'slack', 'E1', 'C1', '1.1', 'acme', 'helix', 'channel',
        'channels/acme/helix/slack-C1/1.1/', '2026-01-01', '2026-01-01', '2026-01-01', 1, '2026-01-01');
      INSERT INTO messages (source, tenant, channel_id, id, thread, at, author, person, staff,
        counted) VALUES ('slack', 'E1', 'C1', '1.1', 'slack:E1:C1:1.1', '2026-01-01', 'Ada', 1, 1, 1)`);
    const me = {
      id: 1, name: 'Ada', email: 'ada@staff.example', teams: [{ slug: 'helix', name: 'Helix' }],
    };
    const env = { DB, CHANNELS: fakeBucket() };
    for (const path of ['/api/inbox?team=helix', '/api/thread?thread=slack:E1:C1:1.1&team=helix']) {
      const url = new URL(`https://opspile.example${path}`);
      // eslint-disable-next-line no-await-in-loop
      const res = await api(new Request(url), env, url, { viewer: me });
      assert.equal(res.status, 200, path);
      const [, calls, rounds] = /d1;dur=[\d.]+;desc="(\d+) calls? in (\d+) rounds?"/
        .exec(res.headers.get('server-timing'));
      // Each round of reads one call: before, the inbox took 25 and a thread some 35.
      assert.ok(Number(calls) <= Number(rounds) + 2, `${path}: ${calls} calls in ${rounds} rounds`);
    }
  });

  it('reads a team\'s and a customer\'s Manage section and agent in a few rounds of D1', async () => {
    const { DB } = counting();
    DB.sqlite.exec(`INSERT INTO teams (slug, name) VALUES ('admin', 'Admin');
      INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
        VALUES ('kb-team-helix', 'team', 'helix', 'r', '2026-01-01');
      INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
        VALUES ('slack', 'E1', 'C1', 'aem-acme', '2026-01-01');
      INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, path, root_at, last_at, any_at, messages, updated_at)
      VALUES ('slack:E1:C1:1.1', 'slack', 'E1', 'C1', '1.1', 'acme', 'helix', 'channel',
        'channels/acme/helix/slack-C1/1.1/', '2026-01-01', '2026-01-01', '2026-01-01', 1, '2026-01-01')`);
    const me = {
      id: 1, name: 'Ada', email: 'ada@staff.example', teams: [{ slug: 'admin', name: 'Admin', role: 'manager' }],
    };
    const env = { DB, CHANNELS: fakeBucket() };
    // Before, they asked one query after the other: the team's page took 20 rounds.
    for (const [path, most] of [['/api/admin/team?slug=helix', 4], ['/api/admin/org?slug=acme', 4],
      ['/api/kb/channels?repo=kb-team-helix', 4], ['/api/kb/tools?repo=kb-team-helix', 4],
      ['/api/kb/extraction?repo=kb-team-helix', 4]]) {
      const url = new URL(`https://opspile.example${path}`);
      // eslint-disable-next-line no-await-in-loop
      const res = await api(new Request(url), env, url, { viewer: me });
      assert.equal(res.status, 200, path);
      const [, rounds] = /d1;dur=[\d.]+;desc="\d+ calls? in (\d+) rounds?"/
        .exec(res.headers.get('server-timing'));
      assert.ok(Number(rounds) <= most, `${path}: ${rounds} rounds`);
    }
  });
});
