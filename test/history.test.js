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
import {
  afterEach, beforeEach, describe, it,
} from 'node:test';
import { runImport, slackImportKey } from '../src/history.js';
import { sweepLabels } from '../src/label.js';
import { resetSlackDomains } from '../src/lookup.js';
import { consume, processKey } from '../src/normalizer.js';
import { readState, unreadInYours, waitingOn } from '../src/threads.js';
import { sweepVectors } from '../src/vectors.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up ids, names and texts only.
const RULES = [
  {
    id: 1, target: 'org', priority: 100, source: null, field: 'name', pattern: '^aem-(.+)$', value: '$1',
  },
  {
    id: 2, target: 'team', priority: 100, source: null, field: 'name', pattern: '^(aem|alerts)-', value: 'helix',
  },
  {
    id: 3, target: 'kind', priority: 100, source: null, field: 'name', pattern: '^alerts-', value: 'alert',
  },
];
const PEOPLE = [{
  id: 7, email: 'ada@staff.example', name: 'Ada Staff', staff: 1, teams: ['helix'],
}];
const USERS = {
  U1: {
    id: 'U1', real_name: 'Ada', profile: { email: 'ada@staff.example' }, team_id: 'T1',
  },
  U2: {
    id: 'U2', real_name: 'Cy', profile: { email: 'cy@customer.example' }, team_id: 'T9',
  },
};
const SINCE = '2026-08-01T00:00:00.000Z';
const RUN = '2026-11-20T12:00:00.000Z';
const NOW = new Date(RUN);
const ts = (iso) => (Date.parse(iso) / 1000).toFixed(6);

function env() {
  const queued = [];
  const DB = d1({ rules: RULES, people: PEOPLE, teams: [{ slug: 'helix', name: 'Helix' }] });
  DB.sqlite.exec(`INSERT INTO channels (source, tenant, channel_id, name, group_id, fetched_at) VALUES
    ('slack', 'E1', 'C1', 'aem-acme', 'T1', '2099-01-01T00:00:00Z'),
    ('slack', 'E1', 'C9', 'alerts-acme', 'T1', '2099-01-01T00:00:00Z'),
    ('teams', 'TN', '19:a@thread.tacv2', 'aem-acme', 'G1', '2099-01-01T00:00:00Z')`);
  return {
    queued,
    DB,
    RAW: fakeBucket(),
    CHANNELS: fakeBucket(),
    NORMALIZE: {
      send: async (body, options) => queued.push({ body, options }),
      sendBatch: async (list) => queued.push(...list),
    },
    SLACK_BOT_TOKEN: 'xoxb-made-up',
    STAFF_DOMAINS: 'staff.example',
    AI: {},
    VECTORS: {},
    CONTENT: {},
  };
}

const slackJob = (extra = {}) => ({
  source: 'slack', tenant: 'E1', channelId: 'C1', since: SINCE, run: RUN, ...extra,
});
const row = (e) => e.DB.rows('SELECT * FROM history_imports')[0];
const keys = (e) => e.queued.filter((q) => q.body.key).map((q) => q.body.key);
const next = (e) => e.queued.filter((q) => q.body.import).map((q) => q.body.import);

describe('history import, Slack', () => {
  const realFetch = globalThis.fetch;
  let pages;
  let asked;
  beforeEach(() => {
    asked = [];
    resetSlackDomains();
    // Two pages of roots, newest first: a thread with a reply, one on its own, one the inbox has.
    pages = {
      '': {
        messages: [
          {
            user: 'U2', ts: ts('2026-10-01T10:00:00Z'), text: 'site down?', reply_count: 1, thread_ts: ts('2026-10-01T10:00:00Z'),
          },
          {
            user: 'U1', ts: ts('2026-10-01T11:00:00Z'), text: 'broadcast', thread_ts: ts('2026-10-01T10:00:00Z'), subtype: 'thread_broadcast',
          },
          { user: 'U2', ts: ts('2026-09-15T10:00:00Z'), text: 'a question on its own' },
        ],
        response_metadata: { next_cursor: 'c2' },
      },
      c2: { messages: [{ user: 'U2', ts: ts('2026-08-15T10:00:00Z'), text: 'known already' }] },
    };
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      asked.push(`${u.pathname}?${u.searchParams}`);
      if (u.pathname === '/api/conversations.history') {
        return Response.json({ ok: true, ...pages[u.searchParams.get('cursor') || ''] });
      }
      if (u.pathname === '/api/conversations.replies') {
        const root = u.searchParams.get('ts');
        return Response.json({
          ok: true,
          messages: [
            {
              user: 'U2', ts: root, text: 'site down?', thread_ts: root, reply_count: 1,
            },
            {
              user: 'U1', ts: ts('2026-10-01T10:05:00Z'), text: 'looking, Cy', thread_ts: root,
            },
          ],
        });
      }
      if (u.pathname === '/api/users.info') {
        const user = USERS[u.searchParams.get('user')];
        return Response.json(user ? { ok: true, user } : { ok: false, error: 'user_not_found' });
      }
      if (u.pathname === '/api/conversations.info') {
        return Response.json({ ok: true, channel: { id: 'C1', name: 'aem-acme', context_team_id: 'T1' } });
      }
      if (u.pathname === '/api/team.info') {
        return Response.json({ ok: true, team: { id: 'T1', domain: 'acme-support' } });
      }
      throw new Error(`unexpected ${url}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('stores the threads the inbox does not have, as imported, page by page', async () => {
    const e = env();
    e.DB.sqlite.exec(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      path, updated_at) VALUES ('slack:E1:C1:${ts('2026-08-15T10:00:00Z')}', 'slack', 'E1', 'C1',
      '${ts('2026-08-15T10:00:00Z')}', 'acme', 'helix', 'p/', '${RUN}')`);
    const r = await runImport(e, slackJob(), { now: NOW });
    assert.deepEqual([r.result, r.threads, r.messages, r.done], ['imported', 2, 3, false]);
    assert.match(asked[0], new RegExp(`oldest=${Date.parse(SINCE) / 1000}&`));
    const root = slackImportKey('E1', 'C1', { ts: ts('2026-10-01T10:00:00Z') });
    assert.equal(root, `slack/E1/C1/2026/10/01/${ts('2026-10-01T10:00:00Z')}-import.json`);
    assert.equal(e.RAW.objects.get(root).options.customMetadata.via, 'import');
    assert.equal(keys(e).length, 3);
    assert.deepEqual(next(e), [{ ...slackJob(), cursor: 'c2', skip: 0 }]);
    assert.deepEqual(
      [row(e).cursor, row(e).pages, row(e).threads, row(e).messages, row(e).done_at],
      ['c2', 1, 2, 3, null],
    );
    // The second page has only a thread the inbox heard of live: done.
    e.queued.length = 0;
    const r2 = await runImport(e, slackJob({ cursor: 'c2', skip: 0 }), { now: NOW });
    assert.deepEqual([r2.threads, r2.done, keys(e).length, next(e).length], [0, true, 0, 0]);
    assert.ok(row(e).done_at);
  });

  it('moves on once for a page delivered twice, and stops for a newer import', async () => {
    const e = env();
    await runImport(e, slackJob(), { now: NOW });
    e.queued.length = 0;
    assert.equal((await runImport(e, slackJob(), { now: NOW })).reason, 'moved on');
    assert.deepEqual(next(e), []);
    // A newer import of the channel: the older one's next page stops.
    await runImport(e, slackJob({ run: '2026-11-21T00:00:00.000Z' }), { now: NOW });
    assert.equal((await runImport(e, slackJob({ cursor: 'c2', skip: 0 }), { now: NOW })).reason, 'superseded');
  });

  it('leaves out alert channels unless asked, and channels it does not know', async () => {
    const e = env();
    const alert = slackJob({ channelId: 'C9' });
    assert.deepEqual(await runImport(e, alert, { now: NOW }), { result: 'skip', reason: 'alert channel' });
    assert.equal(row(e).error, 'alert channel');
    assert.ok(row(e).done_at);
    assert.equal((await runImport(e, { ...alert, alerts: true, run: '2026-11-21T00:00:00.000Z' }, { now: NOW })).result, 'imported');
    assert.equal((await runImport(e, slackJob({ channelId: 'C0' }), { now: NOW })).reason, 'unknown channel');
  });

  it('ends on an error that stays, and keeps the page for a retry on one that may pass', async () => {
    const e = env();
    globalThis.fetch = async () => Response.json({ ok: false, error: 'ratelimited' });
    await assert.rejects(runImport(e, slackJob(), { now: NOW }), /ratelimited/);
    assert.deepEqual([row(e).done_at, row(e).error], [null, 'slack conversations.history: ratelimited']);
    // The queue backs off as for any rate limit.
    const msg = {
      body: { import: slackJob() }, attempts: 1, ack() {}, retry(o) { this.options = o; },
    };
    await quiet(() => consume({ messages: [msg] }, e));
    assert.ok(msg.options.delaySeconds >= 60);
    globalThis.fetch = async () => Response.json({ ok: false, error: 'team_access_not_granted' });
    assert.equal((await runImport(e, slackJob(), { now: NOW })).result, 'import-ended');
    assert.match(row(e).error, /team_access_not_granted/);
    e.DB.sqlite.exec('UPDATE history_imports SET done_at = NULL, error = NULL');
    globalThis.fetch = async () => Response.json({ ok: false, error: 'not_in_channel' });
    assert.equal((await runImport(e, slackJob(), { now: NOW })).result, 'import-ended');
    assert.ok(row(e).done_at);
    assert.match(row(e).error, /not_in_channel/);
  });

  it('files an imported thread without waking anyone, and as read and waiting on nobody', async () => {
    const e = env();
    await runImport(e, slackJob(), { now: NOW });
    const stored = keys(e);
    e.queued.length = 0;
    // The reply first: the import has its root, so no backfill is asked for.
    for (const key of [...stored].reverse()) {
      // eslint-disable-next-line no-await-in-loop
      await processKey(e, key);
    }
    assert.deepEqual(e.queued, []);
    assert.deepEqual(e.DB.rows('SELECT COUNT(*) AS n FROM backfills'), [{ n: 0 }]);
    const threads = e.DB.rows('SELECT thread, imported, last_staff, last_at, kind FROM threads ORDER BY thread');
    assert.deepEqual(threads.map((t) => t.imported), [1, 1]);
    assert.deepEqual(e.DB.rows('SELECT DISTINCT imported FROM messages'), [{ imported: 1 }]);
    // A mention of Ada, and Cy spoke last: still read, waiting on nobody, nothing new.
    const mention = { thread: threads[0].thread, person: 7, at: threads[0].last_at };
    const states = readState(threads, [], [mention], 7);
    assert.deepEqual(states.map((s) => [s.unread, s.unseen, s.unseenByAdobe, s.mentionedMe]), [
      [false, false, false, false], [false, false, false, false]]);
    assert.deepEqual(threads.map((t) => waitingOn(t)), ['nobody', 'nobody']);
    assert.equal((await unreadInYours(e.DB, threads.map((t) => t.thread), 7)).size, 0);
    // The cron's sweeps leave them be, and would not if they were live.
    const later = new Date('2026-10-02T00:05:00Z');
    assert.deepEqual(await sweepVectors(e, later), { queued: 0 });
    assert.deepEqual(await sweepLabels(e, later), { queued: 0 });
    e.DB.sqlite.exec('UPDATE threads SET imported = 0');
    assert.deepEqual(await sweepVectors(e, later), { queued: 2 });
    // Labels: only the recent one (the sweep's two weeks).
    assert.deepEqual(await sweepLabels(e, later), { queued: 1 });
  });

  it('is a live thread once any of its messages is heard of otherwise, in either order', async () => {
    const e = env();
    await runImport(e, slackJob(), { now: NOW });
    const [root] = keys(e);
    const live = 'slack/E1/C1/2026/10/01/live.json';
    const { message } = JSON.parse(e.RAW.objects.get(root).body);
    await e.RAW.put(live, JSON.stringify({
      type: 'event_callback', enterprise_id: 'E1', team_id: 'T1', event: { ...message, type: 'message', channel: 'C1' },
    }), { customMetadata: { source: 'slack', via: 'events' } });
    const imported = (thread) => e.DB.rows('SELECT imported FROM threads WHERE thread = ?', thread)[0].imported;
    const thread = `slack:E1:C1:${message.ts}`;
    await processKey(e, root);
    assert.equal(imported(thread), 1);
    await processKey(e, live);
    assert.equal(imported(thread), 0);
    await processKey(e, root);
    assert.equal(imported(thread), 0);
  });

  it('continues a page that passes its budget where it stopped', async () => {
    const e = env();
    pages[''].messages = Array.from({ length: 50 }, (_, i) => ({
      user: 'U2', ts: ts(new Date(Date.parse('2026-10-01T00:00:00Z') - i * 60000).toISOString()), text: `q${i}`, reply_count: 9,
    }));
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/conversations.history') {
        return Response.json({ ok: true, ...pages[u.searchParams.get('cursor') || ''] });
      }
      const root = u.searchParams.get('ts');
      return Response.json({
        ok: true,
        messages: Array.from({ length: 10 }, (_, i) => ({ user: 'U2', ts: `${root.split('.')[0]}.00000${i}`, thread_ts: root })),
      });
    };
    const r = await runImport(e, slackJob(), { now: NOW });
    assert.deepEqual([r.threads, r.messages], [30, 300]);
    assert.deepEqual(next(e), [{ ...slackJob(), cursor: null, skip: 30 }]);
    assert.deepEqual([row(e).cursor, row(e).skip, row(e).pages], [null, 30, 0]);
    e.queued.length = 0;
    const r2 = await runImport(e, { ...slackJob(), cursor: null, skip: 30 }, { now: NOW });
    assert.deepEqual([r2.threads, row(e).pages], [20, 1]);
    assert.deepEqual(next(e), [{ ...slackJob(), cursor: 'c2', skip: 0 }]);
  });
});

describe('history import, Teams', () => {
  const job = {
    source: 'teams', tenant: 'TN', groupId: 'G1', channelId: '19:a@thread.tacv2', since: SINCE, run: RUN,
  };
  const msg = (id, created, extra = {}) => ({
    id, createdDateTime: created, lastModifiedDateTime: created, messageType: 'message', ...extra,
  });

  it('lists threads by their latest activity, imports those started since, and stops at the first quiet one', async () => {
    const e = env();
    e.DB.sqlite.exec(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      path, updated_at) VALUES ('teams:TN:G1:19:a@thread.tacv2:300', 'teams', 'TN', '19:a@thread.tacv2',
      '300', 'acme', 'helix', 'p/', '${RUN}')`);
    const asked = [];
    const graph = async (path) => {
      asked.push(decodeURIComponent(path));
      if (path.includes('/replies')) {
        return Response.json({ value: [msg('101', '2026-10-02T10:00:00Z', { replyToId: '100' })] });
      }
      return Response.json({
        value: [
          // Live already.
          msg('300', '2026-11-01T10:00:00Z'),
          msg('100', '2026-10-01T10:00:00Z', {
            replies: [msg('102', '2026-10-03T10:00:00Z', { replyToId: '100' })],
            'replies@odata.nextLink': 'https://graph.example/more/replies',
          }),
          // Started before, active since: not this import's.
          msg('90', '2026-07-01T10:00:00Z', { replies: [msg('91', '2026-08-10T10:00:00Z')] }),
          // Quiet since before: the listing ends here.
          msg('80', '2026-07-01T10:00:00Z'),
          msg('70', '2026-10-01T10:00:00Z'),
        ],
        '@odata.nextLink': 'https://graph.example/next',
      });
    };
    const r = await runImport(e, job, { graph, now: NOW });
    assert.deepEqual([r.threads, r.messages, r.done], [1, 3, true]);
    assert.ok(asked[0].includes('/messages?$top=20&$expand=replies'));
    const stored = [...e.RAW.objects.keys()].sort();
    assert.equal(stored.length, 3);
    assert.ok(stored.every((k) => k.startsWith('teams/TN/G1/')));
    const root = [...e.RAW.objects.values()].map((o) => JSON.parse(o.body)).find((m) => m.id === '100');
    assert.equal(root.replies, undefined);
    assert.equal(root['replies@odata.nextLink'], undefined);
    assert.deepEqual(next(e), []);
    assert.ok(row(e).done_at);
  });

  it('ends where Graph refuses the channel, or says it is gone', async () => {
    for (const status of [403, 410]) {
      const e = env();
      const graph = async () => new Response('{}', { status });
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await runImport(e, job, { graph, now: NOW })).result, 'import-ended');
      assert.match(row(e).error, new RegExp(`graph ${status}`));
    }
  });
});
