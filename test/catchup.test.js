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
import { runCatchUp, startCatchUp } from '../src/catchup.js';
import { d1 } from './d1.js';

// Made-up teams, channels and messages only.
function env() {
  const DB = d1({ teams: [{ slug: 'helix', name: 'Helix' }], people: [] });
  const sql = (q, ...a) => DB.sqlite.prepare(q).run(...a);
  sql(`INSERT INTO channels (source, tenant, channel_id, group_id, fetched_at)
    VALUES ('teams', 'T', '19:a', 'G1', '2099-01-01T00:00:00Z'),
      ('teams', 'T', '19:b', 'G2', '2099-01-01T00:00:00Z'),
      ('slack', 'E', 'C1', NULL, '2099-01-01T00:00:00Z')`);
  sql(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, path, root_at, last_at, any_at, updated_at)
    VALUES ('t-recent', 'teams', 'T', '19:a', '100', 'acme', 'helix', 'p/', '2026-10-25T10:00:00Z', '2026-10-25T10:00:00Z', '2026-10-25T10:00:00Z', '2026-10-25T10:00:00Z'),
    ('t-old', 'teams', 'T', '19:a', '50', 'acme', 'helix', 'q/', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z')`);
  const sent = [];
  const put = [];
  return {
    DB,
    sent,
    put,
    NORMALIZE: {
      sendBatch: async (b) => sent.push(...b),
      send: async (b) => sent.push({ body: b }),
    },
    RAW: { put: async (k) => put.push(k) },
  };
}

describe('teams catch-up', () => {
  it('queues one job per known Teams channel, from a little before the gap', async () => {
    const e = env();
    assert.equal(await startCatchUp(e, Date.parse('2026-10-26T10:00:00Z'), 'test'), 2);
    assert.deepEqual(e.sent.map((s) => [s.body.catchup.channelId, s.body.catchup.since]).sort(), [
      ['19:a', '2026-10-26T09:50:00.000Z'], ['19:b', '2026-10-26T09:50:00.000Z']]);
  });

  it('stores what changed since, and the replies of changed and recently active threads', async () => {
    const e = env();
    const asked = [];
    const graph = async (path) => {
      asked.push(decodeURIComponent(path));
      if (path.includes('/messages/delta')) {
        return Response.json({ value: [{ id: '200', createdDateTime: '2026-10-26T09:55:00Z' }] });
      }
      if (path.endsWith('/replies?$top=50')) {
        return Response.json({ value: [{ id: `r-${path.split('/')[6]}`, createdDateTime: '2026-10-26T09:56:00Z' }] });
      }
      return Response.json({ id: path.split('/').pop(), createdDateTime: '2026-10-26T09:00:00Z' });
    };
    const r = await runCatchUp(e, {
      tenant: 'T', groupId: 'G1', channelId: '19:a', since: '2026-10-26T09:50:00.000Z',
    }, { graph });
    assert.deepEqual([r.result, r.changed, r.threads], ['caught-up', 1, 2]);
    assert.ok(asked[0].includes('messages/delta?$filter=lastModifiedDateTime gt 2026-10-26T09:50:00.000Z'));
    // The changed root (200) and the thread active three days before (100), not the old one.
    const threads = asked.filter((p) => p.endsWith('/replies?$top=50')).map((p) => p.split('/')[6]).sort();
    assert.deepEqual(threads, ['100', '200']);
    assert.ok(e.put.length >= 3);
  });
});
