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
import { keptAccounts } from '../src/accounts.js';
import { inbox, searchInbox, thread } from '../src/api.js';
import { inChannel } from '../src/shares.js';
import { followersOf, followingTeams } from '../src/follows.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';
import { rollupCogs } from '../src/cogs/rollup.js';
import { pruneExpertEvents } from '../src/expertevents.js';
import { pruneRankEvents } from '../src/rankevents.js';
import { teamOptions } from '../src/suggest.js';

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

  it('count a team inbox\'s entries from an index, in order, when loading the inbox', async () => {
    // An alert channel files tens of thousands of threads under its team (migration 0069).
    for (const asked of [
      await plans((env) => inbox(env, me, 'helix')),
      await plans((env) => inbox(env, me, 'helix', { groups: ['slack:E1:C1:1.1'] })),
    ]) {
      const [p] = asked.filter((q) => q.sql.startsWith('SELECT g, n, total, latest'));
      assert.ok(p.plan.some((d) => /SEARCH t USING COVERING INDEX threads_inbox \(team=\?/.test(d)), p.plan.join('\n'));
      // The team's own threads come grouped: no sort before the shared channels' (UNION ALL).
      const own = p.plan.slice(p.plan.indexOf('LEFT-MOST SUBQUERY'), p.plan.indexOf('UNION ALL'));
      assert.ok(own.length && !own.some((d) => /TEMP B-TREE/.test(d)), p.plan.join('\n'));
    }
  });

  it('search threads by team, and identities and messages by index, when searching', async () => {
    const asked = await plans((env) => searchInbox(env, me, 'helix', 'acme'));
    // The words (titles, facts), then the entries found, as the inbox has them.
    assert.ok(asked.some((p) => p.sql.startsWith('SELECT f.thread')));
    assert.ok(asked.some((p) => p.sql.startsWith('SELECT g, n, total, latest')));
    assert.deepEqual(scans(asked), []);
    assert.deepEqual(asked.filter((p) => p.plan.some((d) => /^SCAN (threads|t)\b/.test(d))), []);
  });

  it('search identities, messages and threads by index when loading the personal view', async () => {
    const ps = await plans((env) => inbox(env, me, null, { personal: true }));
    assert.deepEqual(scans(ps), []);
    assert.deepEqual(ps.filter((p) => p.plan.some((d) => /^SCAN (threads|t)\b/.test(d))), []);
  });

  it('read the latest members of each entry by index when loading the inbox', async () => {
    // Not every thread of the inbox ranked to find them (migration 0068): an alert channel
    // folds thousands of posts into one entry.
    for (const asked of [
      await plans((env) => inbox(env, me, 'helix')),
      await plans((env) => inbox(env, me, null, { personal: true })),
    ]) {
      const [p] = asked.filter((q) => q.sql.startsWith('WITH g(k) AS'));
      assert.ok(p, 'the members query');
      assert.ok(p.plan.some((d) => /SEARCH y USING INDEX threads_group_latest \(logical_thread=\?\)/.test(d)), p.plan.join('\n'));
    }
  });

  it('search identities and messages by index when opening a thread', async () => {
    assert.deepEqual(scans(await plans((env) => thread(env, me, 'slack:E1:C1:1.1'))), []);
  });

  it('find who is in a channel by their mentions, not by the channel\'s threads', async () => {
    // Asked for every event of a channel that someone off its team hears about (src/room.js),
    // and whenever they open one of its threads: an alert channel has tens of thousands.
    const [p] = await plans((env) => inChannel(env, [1], { source: 'slack', channel_id: 'C1' }));
    assert.ok(p.plan.some((d) => /SEARCH n USING (COVERING )?INDEX mentions_person/.test(d)), p.plan.join('\n'));
    assert.ok(!p.plan.some((d) => /threads_channel/.test(d)), p.plan.join('\n'));
  });

  it('find who follows a thread by its entry\'s posts and what they show, by index', async () => {
    // Asked whenever a thread is opened, worked or announced (src/follows.js).
    for (const [p] of [
      await plans((env) => followingTeams(env, 'slack:E1:C1:1.1')),
      await plans((env) => followersOf(env, [1], 'slack:E1:C1:1.1')),
    ]) {
      assert.deepEqual(p.plan.filter((d) => /^SCAN (threads|thread_tech|team_follows|person_follows|x|g)\b/.test(d)), [], p.plan.join('\n'));
    }
  });

  it('search the messages and channels of a person\'s accounts by index', async () => {
    // Asked for everyone's on every typed @ (src/post.js `mentionable`): migration 0061.
    const t = { source: 'slack', tenant: 'E1', channel_id: 'C1' };
    const [p] = await plans((env) => keptAccounts(env, t));
    assert.deepEqual(p.plan.filter((d) => /^SCAN (identities|messages|channel_members|[iowxm])\b/.test(d)), []);
    assert.ok(p.plan.some((d) => /USING (COVERING )?INDEX messages_author/.test(d)), p.plan.join('\n'));
    assert.ok(p.plan.some((d) => /USING (COVERING )?INDEX channel_members_user/.test(d)), p.plan.join('\n'));
  });
});

describe('cron queries', () => {
  it('find the old events and picks to delete by when they were, not by reading them all', async () => {
    for (const prune of [pruneExpertEvents, pruneRankEvents]) {
      // eslint-disable-next-line no-await-in-loop
      const ps = await plans((env) => prune(env));
      assert.deepEqual(ps.filter((p) => p.plan.some((d) => /^SCAN (expert_events|rank_events)\b/.test(d))), []);
      assert.ok(ps.some((p) => p.plan.some((d) => /USING (COVERING )?INDEX (expert_events|rank_events)_at/.test(d))), JSON.stringify(ps));
    }
  });

  it('search a team\'s channels by team and by share for the channel suggestions', async () => {
    const ps = await plans((env) => teamOptions(env));
    const [p] = ps.filter((q) => q.sql.startsWith('SELECT COALESCE(c.group_name'));
    assert.ok(p, 'the channels query');
    assert.ok(!p.plan.some((d) => /^SCAN t\b/.test(d)), p.plan.join('\n'));
    assert.ok(p.plan.some((d) => /SEARCH t USING INDEX threads_team/.test(d)), p.plan.join('\n'));
  });

  it('look up each day of the COGS backfill by the primary key', async () => {
    const ps = await plans((env) => rollupCogs(env, { now: Date.parse('2026-11-02T12:00:00Z') }));
    const days = ps.filter((p) => p.sql.startsWith('WITH RECURSIVE d(day)'));
    assert.ok(days.length, 'the missing days query');
    for (const p of days) {
      assert.ok(p.plan.some((d) => /SEARCH t .*USING PRIMARY KEY \(day=\?/.test(d)), p.plan.join('\n'));
    }
  });
});
