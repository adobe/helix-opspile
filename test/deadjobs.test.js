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
import {
  listDead, pruneDead, recordDead, redrive,
} from '../src/deadjobs.js';
import { sweepLabels } from '../src/label.js';
import { consume } from '../src/normalizer.js';
import { sweepRethreads } from '../src/rethread.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

const KEY = 'slack:E1:C1:1.1';
const NOW = new Date('2026-11-01T12:00:00.000Z');
const ago = (hours) => new Date(NOW.getTime() - hours * 3600 * 1000).toISOString();

function env(extra = {}) {
  const queued = [];
  return {
    queued,
    DB: d1(),
    NORMALIZE: { send: async (body) => queued.push(body) },
    ...extra,
  };
}

function thread(e, {
  key = KEY, kind = 'channel', root = ago(2), last = ago(2), hash = null, decided = null, deleted = 0,
  authorKind = 'person',
} = {}) {
  e.DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
    kind, path, root_at, last_at, any_at, skeleton_hash, rethreaded_at, updated_at)
    VALUES (?, 'slack', 'E1', 'C1', '1.1', 'acme', 'helix', ?, 'p/', ?, ?, ?, ?, ?, ?)`)
    .run(key, kind, root, last, last, hash, decided, last);
  e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, counted,
    deleted, author_kind) VALUES ('slack', 'E1', 'C1', ?, ?, ?, 1, ?, ?)`)
    .run(`1.1-${key}`, key, root, deleted, authorKind);
  e.DB.sqlite.prepare('UPDATE threads SET root_id = ? WHERE thread = ?').run(`1.1-${key}`, key);
}

describe('a job that used up its retries', () => {
  const job = (body, attempts) => ({
    body,
    attempts,
    retry() {
      this.retried = true;
    },
    ack() {},
  });

  it('is recorded on its last delivery only, and still goes to the queue\'s retry', async () => {
    const { DB } = env();
    // Whatever the job reads fails; the record is read back through `DB`.
    const failing = {
      AI: {},
      NORMALIZE: { send: async () => {} },
      DB: {
        prepare(sql) {
          if (/dead_jobs/.test(sql)) {
            return DB.prepare(sql);
          }
          throw new Error('D1 is down');
        },
      },
    };
    const first = job({ label: KEY }, 1);
    const last = job({ label: KEY }, 6);
    await quiet(() => consume({ messages: [first] }, failing));
    assert.deepEqual((await listDead({ DB })).jobs, []);
    await quiet(() => consume({ messages: [last] }, failing));
    assert.ok(first.retried && last.retried);
    const { jobs, kinds } = await listDead({ DB });
    assert.deepEqual(jobs.map((j) => [j.job, j.error]), [[`label:${KEY}`, 'D1 is down']]);
    assert.deepEqual(kinds, [{ kind: 'label', n: 1 }]);
  });

  it('never fails for being recorded', async () => {
    await quiet(() => recordDead({
      DB: {
        prepare() {
          throw new Error('D1 is down');
        },
      },
    }, 'x', {}, 'y'));
  });

  it('is sent out again, and leaves the list', async () => {
    const e = env();
    await recordDead(e, `label:${KEY}`, { label: KEY }, 'down');
    await recordDead(e, 'refile:slack:C1', { refile: { channelId: 'C1' } }, 'down');
    const [{ id }] = (await listDead(e)).jobs;
    assert.deepEqual(await redrive(e, { ids: [id] }), { sent: 1 });
    assert.deepEqual(e.queued, [{ refile: { channelId: 'C1' } }]);
    assert.deepEqual(await redrive(e), { sent: 1 });
    assert.deepEqual(e.queued[1], { label: KEY });
    assert.deepEqual((await listDead(e)).jobs, []);
  });

  it('is forgotten after a month', async () => {
    const e = env();
    await recordDead(e, 'x', {}, 'y');
    assert.deepEqual(await pruneDead(e, new Date()), { deleted: 0 });
    assert.deepEqual(await pruneDead(e, new Date(Date.now() + 31 * 86400 * 1000)), { deleted: 1 });
  });
});

describe('sweeping up after dead jobs', () => {
  const live = { VECTORS: {}, AI: {} };

  it('sends out roots whose job died, and leaves skipped and decided ones alone', async () => {
    const e = env(live);
    thread(e, { key: 'died', hash: 'h' });
    thread(e, { key: 'skipped' });
    thread(e, { key: 'decided', hash: 'h', decided: ago(1) });
    thread(e, { key: 'running', hash: 'h', root: ago(0.5) });
    thread(e, { key: 'ancient', hash: 'h', root: ago(24 * 20) });
    thread(e, {
      key: 'deleted', hash: 'h', deleted: 1,
    });
    thread(e, { key: 'notice', hash: 'h', authorKind: 'system' });
    assert.deepEqual(await sweepRethreads(e, NOW), { queued: 1 });
    assert.deepEqual(e.queued, [{ rethread: 'died' }]);
    assert.ok((await sweepRethreads({ DB: e.DB }, NOW)).skipped);
  });

  it('sweeps once an hour, so that a job still retrying is not sent out twice', async () => {
    const e = env(live);
    thread(e, { key: 'died', hash: 'h' });
    for (const minute of [20, 40]) {
      const at = new Date(NOW.getTime() + minute * 60000);
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await sweepRethreads(e, at), { skipped: 'not this run' });
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await sweepLabels(e, at), { skipped: 'not this run' });
    }
    assert.equal(e.queued.length, 0);
    assert.deepEqual(await sweepRethreads(e, NOW), { queued: 1 });
  });

  it('spreads a batch out, so that it does not run into a rate limit', async () => {
    const sent = [];
    const e = env({
      ...live,
      NORMALIZE: {
        send: async (body, options) => sent.push([body.rethread, options.delaySeconds]),
      },
    });
    thread(e, { key: 'a', hash: 'h', root: ago(3) });
    thread(e, { key: 'b', hash: 'h', root: ago(2) });
    thread(e, { key: 'c', hash: 'h', root: ago(1.5) });
    await sweepRethreads(e, NOW);
    assert.deepEqual(sent, [['a', 0], ['b', 5], ['c', 10]]);
  });

  it('sends what keeps failing once a day, not with every cron run', async () => {
    const e = env(live);
    thread(e, { key: 'died', hash: 'h' });
    const dead = e.DB.sqlite.prepare(`INSERT INTO dead_jobs (job, body, error, at)
      VALUES ('rethread:died', '{}', 'down', ?)`);
    dead.run(ago(1));
    assert.deepEqual(await sweepRethreads(e, NOW), { queued: 0 });
    e.DB.sqlite.prepare('DELETE FROM dead_jobs').run();
    dead.run(ago(25));
    assert.deepEqual(await sweepRethreads(e, NOW), { queued: 1 });

    thread(e, { key: 'never' });
    e.DB.sqlite.prepare(`INSERT INTO dead_jobs (job, body, error, at)
      VALUES ('label:never', '{}', 'down', ?)`).run(ago(1));
    assert.equal((await sweepLabels(e, NOW)).queued, 1, 'only the one without a recent dead job');
    e.queued.length = 0;
  });

  it('labels threads whose label job died, and leaves the rest alone', async () => {
    const e = env(live);
    const label = (key, through) => e.DB.sqlite.prepare(`INSERT INTO labels (thread, labeled_through,
      model, labeled_at) VALUES (?, ?, 'clef', ?)`).run(key, through, through);
    thread(e, { key: 'never' });
    thread(e, { key: 'stale' });
    label('stale', ago(3));
    thread(e, { key: 'current' });
    label('current', ago(2));
    thread(e, { key: 'settling', last: ago(0.5) });
    thread(e, { key: 'old', last: ago(24 * 20) });
    thread(e, { key: 'alert', kind: 'alert' });
    thread(e, { key: 'empty', deleted: 1 });
    assert.deepEqual(await sweepLabels(e, NOW), { queued: 2 });
    assert.deepEqual(e.queued.map((q) => q.label).sort(), ['never', 'stale']);
    assert.ok((await sweepLabels({ DB: e.DB }, NOW)).skipped);
  });
});
