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
import { getChannel, resetSlackDomains, updateChannelName } from '../src/lookup.js';
import { isRenameNotice } from '../src/normalize.js';
import { consume } from '../src/normalizer.js';
import { followChange, refile } from '../src/refile.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up ids, names and slugs only.
const RULES = [
  {
    id: 1, target: 'org', priority: 100, source: null, field: 'name', pattern: '^aem-(.+)$', value: '$1',
  },
  {
    id: 2, target: 'team', priority: 100, source: null, field: 'name', pattern: '^aem-', value: 'helix',
  },
];
const TEAMS = [{ slug: 'helix', name: 'Helix' }, { slug: 'edge', name: 'Edge' }];
const KEY = (ts, tag = 'a') => `slack/E1/C0TEST1/2026/10/21/${ts}-${tag}.json`;
const event = (e, time) => ({
  type: 'event_callback',
  enterprise_id: 'E1',
  team_id: 'T1',
  event_id: `Ev${e.ts || time}`,
  ...(time ? { event_time: time } : {}),
  event: e,
});
const message = (ts, extra = {}) => event({
  type: 'message', channel: 'C0TEST1', user: 'U1', ts, text: `message ${ts}`, ...extra,
});
const rename = (name, time) => event({
  type: 'channel_rename', channel: { id: 'C0TEST1', name, created: 1 },
}, time);

function env({ rules = RULES } = {}) {
  const queued = [];
  const notified = [];
  const RAW = fakeBucket();
  return {
    queued,
    notified,
    RAW,
    CHANNELS: fakeBucket(),
    DB: d1({ rules, teams: TEAMS }),
    NORMALIZE: { send: async (body) => queued.push(body) },
    ROOMS: {
      idFromName: (team) => team,
      get: (team) => ({
        fetch: async (url, init) => {
          notified.push([team, JSON.parse(init.body)]);
          return new Response('ok');
        },
      }),
    },
    SLACK_BOT_TOKEN: 'xoxb-made-up',
    STAFF_DOMAINS: 'staff.example',
  };
}

/** Puts pile-1 objects in place and runs them through the queue consumer. */
async function ingest(e, objects) {
  const messages = Object.entries(objects).map(([key, body]) => {
    e.RAW.objects.set(key, { body: JSON.stringify(body), options: {} });
    return { body: { key }, ack() {}, retry() {} };
  });
  await quiet(() => consume({ messages }, e));
}

/** Runs the queued `refile` jobs (and drops the others), as the queue consumer would. */
async function drainRefiles(e) {
  for (;;) {
    const jobs = e.queued.splice(0).filter((b) => b.refile);
    if (!jobs.length) {
      return;
    }
    const messages = jobs.map((body) => ({ body, ack() {}, retry() {} }));
    // eslint-disable-next-line no-await-in-loop
    await quiet(() => consume({ messages }, e));
  }
}

const files = (e) => [...e.CHANNELS.objects.keys()]
  .filter((k) => k.startsWith('channels/') && k.endsWith('.md')).sort();
const filed = (e) => e.DB.sqlite.prepare(`SELECT thread, org, team, kind, path FROM threads
  ORDER BY thread`).all().map((r) => ({ ...r }));
const setName = (e, name, fetchedAt) => e.DB.sqlite.prepare(`UPDATE channels SET name = ?,
  fetched_at = ? WHERE channel_id = 'C0TEST1'`).run(name, fetchedAt);

describe('a renamed channel', () => {
  const realFetch = globalThis.fetch;
  let channelName;
  beforeEach(() => {
    channelName = 'random-chat';
    resetSlackDomains();
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/conversations.info') {
        return Response.json({
          ok: true, channel: { id: 'C0TEST1', name: channelName, context_team_id: 'T1' },
        });
      }
      if (u.pathname === '/api/team.info') {
        return Response.json({ ok: true, team: { id: 'T1', domain: 'example-support' } });
      }
      if (u.pathname === '/api/users.info') {
        return Response.json({
          ok: true,
          user: {
            id: 'U1', name: 'ada', real_name: 'Ada', profile: { email: 'ada@staff.example' }, team_id: 'T1',
          },
        });
      }
      if (u.pathname === '/api/conversations.replies') {
        return Response.json({ ok: true, messages: [] });
      }
      throw new Error(`unexpected ${url}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('re-files the threads filed before a rename event, files and rows', async () => {
    const e = env();
    await ingest(e, {
      [KEY('1.1')]: message('1.1'),
      [KEY('1.2')]: message('1.2', { thread_ts: '1.1' }),
      [KEY('2.1')]: message('2.1'),
    });
    assert.deepEqual(filed(e).map((t) => [t.org, t.team]), [
      ['_unassigned', '_unassigned'], ['_unassigned', '_unassigned'],
    ]);
    e.queued.length = 0;

    // Renamed to a name the rules give an org and a team: the threads go with it.
    const later = Date.now() / 1000 + 60;
    await ingest(e, { [KEY('9.0', 'rename')]: rename('aem-acme', later) });
    assert.equal(e.queued.filter((b) => b.refile).length, 1);
    await drainRefiles(e);
    assert.deepEqual(filed(e), [
      {
        thread: 'slack:E1:C0TEST1:1.1',
        org: 'acme',
        team: 'helix',
        kind: 'channel',
        path: 'channels/acme/helix/slack-C0TEST1/1.1/',
      },
      {
        thread: 'slack:E1:C0TEST1:2.1',
        org: 'acme',
        team: 'helix',
        kind: 'channel',
        path: 'channels/acme/helix/slack-C0TEST1/2.1/',
      },
    ]);
    assert.deepEqual(files(e), [
      'channels/acme/helix/slack-C0TEST1/1.1/1.1.md',
      'channels/acme/helix/slack-C0TEST1/1.1/1.2.md',
      'channels/acme/helix/slack-C0TEST1/2.1/2.1.md',
    ]);
    // The inboxes of the team it left and of the team it is in now hear of it.
    assert.deepEqual([...new Set(e.notified.map(([team]) => team))].sort(), ['_unassigned', 'helix']);

    // A message after the rename is filed there too, and the channel stays in one place.
    await ingest(e, { [KEY('3.1')]: message('3.1') });
    assert.deepEqual([...new Set(filed(e).map((t) => t.org))], ['acme']);
  });

  it('queues nothing for a rename the rules do not file elsewhere', async () => {
    const e = env();
    channelName = 'aem-acme';
    await ingest(e, { [KEY('1.1')]: message('1.1') });
    e.queued.length = 0;
    const later = Date.now() / 1000 + 60;
    // Same org and team: `aem-Acme` is `acme` too.
    await ingest(e, { [KEY('9.0', 'rename')]: rename('aem-Acme', later) });
    assert.deepEqual(e.queued.filter((b) => b.refile), []);
    assert.equal(e.DB.sqlite.prepare('SELECT name FROM channels').get().name, 'aem-Acme');
    // Nor for one that is not a rename (the same name again, or a channel D1 does not know yet).
    await ingest(e, { [KEY('9.1', 'rename')]: rename('aem-Acme', later + 1) });
    assert.equal(await updateChannelName(e, {
      source: 'slack', tenant: 'E1', channelId: 'C0TEST9', name: 'aem-globex',
    }, undefined, { onChange: () => assert.fail('not a rename') }), false);
    assert.deepEqual(e.queued.filter((b) => b.refile), []);
  });

  it('leaves out a rename older than what D1 knows (out of order, or a replay)', async () => {
    const e = env();
    channelName = 'aem-acme';
    await ingest(e, { [KEY('1.1')]: message('1.1') });
    e.queued.length = 0;
    // The channel was looked up after this rename happened: the lookup's name is the later one.
    await ingest(e, { [KEY('9.0', 'rename')]: rename('random-chat', Date.parse('2026-01-01') / 1000) });
    assert.equal(e.DB.sqlite.prepare('SELECT name FROM channels').get().name, 'aem-acme');
    assert.deepEqual(e.queued.filter((b) => b.refile), []);
    assert.deepEqual([...new Set(filed(e).map((t) => t.org))], ['acme']);
  });

  it('keeps a manual team assignment, and moves the org only', async () => {
    const e = env({
      rules: [...RULES, {
        id: 3, target: 'team', priority: 10, source: null, field: 'channel_id', pattern: '^C0TEST1$', value: 'edge',
      }],
    });
    await ingest(e, { [KEY('1.1')]: message('1.1') });
    assert.deepEqual(filed(e).map((t) => [t.org, t.team]), [['_unassigned', 'edge']]);
    e.queued.length = 0;
    await ingest(e, { [KEY('9.0', 'rename')]: rename('aem-acme', Date.now() / 1000 + 60) });
    await drainRefiles(e);
    assert.deepEqual(filed(e).map((t) => [t.org, t.team, t.path]), [
      ['acme', 'edge', 'channels/acme/edge/slack-C0TEST1/1.1/'],
    ]);
    assert.deepEqual(files(e), ['channels/acme/edge/slack-C0TEST1/1.1/1.1.md']);
  });

  it('keeps the teams it is shared with, and tells their inboxes', async () => {
    const e = env();
    await ingest(e, { [KEY('1.1')]: message('1.1') });
    e.DB.sqlite.prepare(`INSERT INTO channel_teams (source, channel_id, team, added_at)
      VALUES ('slack', 'C0TEST1', 'edge', '2026-10-21T00:00:00Z')`).run();
    e.queued.length = 0;
    await ingest(e, { [KEY('9.0', 'rename')]: rename('aem-acme', Date.now() / 1000 + 60) });
    await drainRefiles(e);
    assert.deepEqual(filed(e).map((t) => [t.org, t.team]), [['acme', 'helix']]);
    assert.deepEqual(e.DB.sqlite.prepare('SELECT team FROM channel_teams').all().map((r) => r.team), ['edge']);
    assert.deepEqual([...new Set(e.notified.map(([team]) => team))].sort(), ['_unassigned', 'edge', 'helix']);
  });

  it('re-files when a lookup finds the new name, the thread of the message that found it too', async () => {
    const e = env();
    await ingest(e, {
      [KEY('1.1')]: message('1.1'),
      [KEY('2.1')]: message('2.1'),
    });
    e.queued.length = 0;
    // No event (a Teams or Discord channel, or a missed one): the next lookup finds it, a day on.
    setName(e, 'random-chat', '2026-01-01T00:00:00Z');
    channelName = 'aem-acme';
    await ingest(e, { [KEY('1.3')]: message('1.3', { thread_ts: '1.1' }) });
    // The reply is filed where the rules say now and points its thread's row there; the files
    // before it are still where the job found them, and move all the same.
    assert.equal(filed(e)[0].path, 'channels/acme/helix/slack-C0TEST1/1.1/');
    assert.ok(files(e).includes('channels/_unassigned/_unassigned/slack-C0TEST1/1.1/1.1.md'));
    await drainRefiles(e);
    assert.deepEqual(files(e), [
      'channels/acme/helix/slack-C0TEST1/1.1/1.1.md',
      'channels/acme/helix/slack-C0TEST1/1.1/1.3.md',
      'channels/acme/helix/slack-C0TEST1/2.1/2.1.md',
    ]);
    assert.deepEqual(filed(e).map((t) => [t.org, t.team]), [['acme', 'helix'], ['acme', 'helix']]);
    // Run again (a retry, or a second job), it changes nothing.
    const again = await quiet(() => refile(e, {
      source: 'slack',
      tenant: 'E1',
      channelId: 'C0TEST1',
      threads: [['slack:E1:C0TEST1:1.1', 'channels/_unassigned/_unassigned/slack-C0TEST1/1.1/']],
    }));
    assert.equal(again.objects, 0);
    assert.equal(files(e).length, 3);
  });

  it('asks the platform again on a Teams notice of a rename, and says what changed', async () => {
    const e = env();
    const ref = { source: 'slack', tenant: 'E1', channelId: 'C0TEST1' };
    const now = Date.parse('2026-10-21T12:00:00Z');
    const changes = [];
    const onChange = async (before, after) => changes.push([before.name, after.name]);
    await getChannel(e, ref, now, { onChange });
    assert.deepEqual(changes, []);
    channelName = 'aem-acme';
    // Fresh: not asked again, unless something says it changed.
    assert.equal((await getChannel(e, ref, now, { onChange })).name, 'random-chat');
    assert.equal((await getChannel(e, { ...ref, refresh: true }, now, { onChange })).name, 'aem-acme');
    assert.deepEqual(changes, [['random-chat', 'aem-acme']]);
    // Asked again with nothing new: nothing changed.
    await getChannel(e, { ...ref, refresh: true }, now, { onChange });
    assert.equal(changes.length, 1);

    const notice = (type) => ({ event: { '@odata.type': `#microsoft.graph.${type}EventMessageDetail` } });
    assert.equal(isRenameNotice(notice('channelRenamed')), true);
    assert.equal(isRenameNotice(notice('teamRenamed')), true);
    assert.equal(isRenameNotice(notice('membersAdded')), false);
    assert.equal(isRenameNotice({}), false);
  });

  it('keeps the old name when the moves cannot be queued, so a retry queues them', async () => {
    const e = env();
    await ingest(e, { [KEY('1.1')]: message('1.1') });
    e.queued.length = 0;
    const { send } = e.NORMALIZE;
    const down = async () => {
      throw new Error('the queue is down');
    };
    e.NORMALIZE.send = down;
    const later = Date.now() / 1000 + 60;
    const failed = [];
    const key = KEY('9.0', 'rename');
    e.RAW.objects.set(key, { body: JSON.stringify(rename('aem-acme', later)), options: {} });
    await quiet(() => consume({
      messages: [{ body: { key }, ack() {}, retry() { failed.push(key); } }],
    }, e));
    assert.deepEqual(failed, [key]);
    assert.equal(e.DB.sqlite.prepare('SELECT name FROM channels').get().name, 'random-chat');

    // The queue retries the event: the change is still there to find.
    e.NORMALIZE.send = send;
    await ingest(e, { [key]: rename('aem-acme', later) });
    assert.equal(e.DB.sqlite.prepare('SELECT name FROM channels').get().name, 'aem-acme');
    await drainRefiles(e);
    assert.deepEqual(filed(e).map((t) => [t.org, t.team]), [['acme', 'helix']]);

    // Found by a lookup, the same: the lookup fails with the row as it was.
    const e2 = env();
    channelName = 'random-chat';
    await ingest(e2, { [KEY('1.1')]: message('1.1') });
    setName(e2, 'random-chat', '2026-01-01T00:00:00Z');
    channelName = 'aem-acme';
    e2.NORMALIZE.send = down;
    const ref = { source: 'slack', tenant: 'E1', channelId: 'C0TEST1' };
    const onChange = (before, after) => followChange(e2, ref, { before, after }, RULES);
    await assert.rejects(quiet(() => getChannel(e2, ref, Date.now(), { onChange })), /the queue is down/);
    assert.equal(e2.DB.sqlite.prepare('SELECT name FROM channels').get().name, 'random-chat');
  });
});
