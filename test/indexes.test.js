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
import { inbox, thread } from '../src/api.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

/** The plans of every query `fn` asks D1, as SQLite would run them. */
async function plans(fn) {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }],
    people: [{
      id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
    }],
  });
  DB.sqlite.exec(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind,
      path, root_at, last_at, any_at, messages, updated_at)
    VALUES ('slack:E1:C1:1.1', 'slack', 'E1', 'C1', '1.1', 'acme', 'helix', 'channel',
      'channels/acme/helix/slack-C1/1.1/', '2026-01-01', '2026-01-01', '2026-01-01', 1, '2026-01-01')`);
  const asked = [];
  const prepare = DB.prepare.bind(DB);
  DB.prepare = (sql) => {
    asked.push(sql);
    return prepare(sql);
  };
  await fn({ DB, CHANNELS: fakeBucket() });
  return asked.map((sql) => {
    // `?` and `?N` parameters: the highest number, and one more for every plain `?`.
    const numbered = (sql.match(/\?\d+/g) || []).map((p) => Number(p.slice(1)));
    const plain = (sql.match(/\?(?!\d)/g) || []).length;
    const args = Array(Math.max(0, ...numbered) + plain).fill('[]');
    return {
      sql: sql.replace(/\s+/g, ' ').slice(0, 80),
      plan: DB.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail),
    };
  });
}

// Identities and messages are the big tables: joined by their composite keys, they must be
// searched by index (migration 0020), never scanned per row.
const scans = (ps) => ps.filter((p) => p.plan.some((d) => /^SCAN (identities|messages|i|x)\b/.test(d)));

describe('inbox queries', () => {
  const me = { id: 1, name: 'Ada', teams: [{ slug: 'helix', name: 'Helix' }] };

  it('search identities and messages by index when loading the inbox', async () => {
    assert.deepEqual(scans(await plans((env) => inbox(env, me, 'helix'))), []);
  });

  it('search threads by team, or by the channels shared with it, when loading the inbox', async () => {
    // `team = ? OR <shared channel>` must stay a multi-index OR (migration 0024).
    const threadScans = (await plans((env) => inbox(env, me, 'helix')))
      .filter((p) => p.plan.some((d) => /^SCAN (threads|t)\b/.test(d)));
    assert.deepEqual(threadScans, []);
  });

  it('search identities and messages by index when opening a thread', async () => {
    assert.deepEqual(scans(await plans((env) => thread(env, me, 'slack:E1:C1:1.1'))), []);
  });
});
