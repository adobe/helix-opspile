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
import { parse } from '../src/channels.js';
import { runBackfill, slackBackfillKey } from '../src/backfill.js';
import { labelThread, MAX_QUESTIONS, QUESTIONS } from '../src/label.js';
import { getChannel, resetSlackDomains } from '../src/lookup.js';
import { consume, processKey, recordBots } from '../src/normalizer.js';
import { d1 } from './d1.js';
import { fakeArtifacts, fakeBucket, quiet } from './fakes.js';

// Made-up ids, names and domains only.
const RULES = [
  {
    id: 1, target: 'org', priority: 100, source: null, field: 'name', pattern: '^aem-(.+)$', value: '$1',
  },
  {
    id: 2, target: 'team', priority: 100, source: null, field: 'name', pattern: '^aem-', value: 'helix',
  },
];
const PEOPLE = [{
  id: 7, email: 'ada@staff.example', name: 'Ada Staff', staff: 1, teams: ['helix'],
}];
const USERS = {
  U1: {
    id: 'U1',
    name: 'alove',
    real_name: 'Ada',
    profile: { email: 'ada@staff.example', display_name: 'Countess' },
    team_id: 'T1',
  },
  U2: {
    id: 'U2', real_name: 'Cy', profile: { email: 'cy@customer.example', title: 'CTO' }, team_id: 'T9',
  },
};

function env(raw, extra = {}) {
  const queued = [];
  return {
    queued,
    NORMALIZE: { send: async (body, options) => queued.push({ body, options }) },
    ...extra,
    RAW: fakeBucket(Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, JSON.stringify(v)]),
    )),
    CHANNELS: fakeBucket(),
    DB: d1({ rules: RULES, people: PEOPLE, teams: [{ slug: 'helix', name: 'Helix' }] }),
    SLACK_BOT_TOKEN: 'xoxb-made-up',
    STAFF_DOMAINS: 'staff.example',
  };
}

const NOW_ISO = '2026-10-21T12:00:00Z';
const event = (e) => ({
  type: 'event_callback', enterprise_id: 'E1', team_id: 'T1', event_id: 'Ev', event: e,
});

describe('processKey', () => {
  const realFetch = globalThis.fetch;
  let calls;
  let channelInfo;
  let teamDown;
  beforeEach(() => {
    calls = [];
    teamDown = false;
    channelInfo = { id: 'C1', name: 'aem-acme', context_team_id: 'T1' };
    resetSlackDomains();
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      calls.push(u.pathname);
      if (u.pathname === '/api/conversations.info') {
        return Response.json({ ok: true, channel: channelInfo });
      }
      if (u.pathname === '/api/team.info') {
        if (teamDown) {
          return Response.json({ ok: false, error: 'internal_error' });
        }
        const domains = { T1: 'acme-support', T2: 'acme-internal' };
        const domain = domains[u.searchParams.get('team')];
        return Response.json(domain ? { ok: true, team: { id: u.searchParams.get('team'), domain } }
          : { ok: false, error: 'team_not_found' });
      }
      if (u.pathname === '/api/conversations.replies') {
        return Response.json({
          ok: true,
          messages: [
            { user: 'U2', ts: '1.1', text: 'root from history' },
            {
              user: 'U2', ts: '1.2', text: 'a reply', thread_ts: '1.1',
            },
          ],
        });
      }
      if (u.pathname === '/api/files.info') {
        const id = u.searchParams.get('file');
        return Response.json(id === 'F1' ? {
          ok: true,
          file: {
            id: 'F1',
            name: 'flow.pdf',
            title: 'Quiz flow',
            mimetype: 'application/pdf',
            filetype: 'pdf',
            permalink: 'https://example.slack.com/files/U2/F1/flow.pdf',
            url_private: 'https://files.slack.com/files-pri/T1-F1/flow.pdf',
            shares: { private: { C9: [{ preview: 'another channel' }] } },
          },
        } : { ok: false, error: 'file_not_found' });
      }
      if (u.pathname === '/api/users.info') {
        const user = USERS[u.searchParams.get('user')];
        return Response.json(user ? { ok: true, user } : { ok: false, error: 'user_not_found' });
      }
      throw new Error(`unexpected ${url}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('writes a Slack message as markdown with a normalized author', async () => {
    const key = 'slack/E1/C1/2026/10/21/1792584000.000100-Ev1.json';
    const e = env({
      [key]: event({
        type: 'message', channel: 'C1', user: 'U2', ts: '1792584000.000100', text: '*help* <@U1>',
      }),
    });
    const r = await processKey(e, key);
    assert.deepEqual([r.result, r.org, r.team], ['upsert', 'acme', 'helix']);
    const path = 'channels/acme/helix/slack-C1/1792584000.000100/1792584000.000100.md';
    const { meta, body } = parse(e.CHANNELS.objects.get(path).body);
    assert.equal(body, '**help** @Ada Staff');
    assert.deepEqual(meta.author, {
      kind: 'person', name: 'Cy', org: 'customer.example', staff: false,
    });
    assert.deepEqual(meta.raw, [key]);
    const [who] = e.DB.rows("SELECT title FROM identities WHERE user_id = 'U2'");
    assert.equal(who.title, 'CTO');
  });

  it('puts a message the Slack message quotes below its text, as a quote of its author', async () => {
    const key = 'slack/E1/C1/2026/10/21/1792584000.000100-Ev1.json';
    const from = 'https://example.slack.com/archives/C1/p1792583000000100?thread_ts=1792582000.000100&cid=C1';
    const e = env({
      [key]: event({
        type: 'message',
        channel: 'C1',
        user: 'U2',
        ts: '1792584000.000100',
        text: 'First step in that direction',
        attachments: [
          {
            is_share: true,
            is_msg_unfurl: true,
            author_id: 'U2',
            author_subname: 'cy',
            ts: '1792583000.000100',
            from_url: from,
            text: '*Pages* for <@U1> &amp; friends',
          },
          // A link's preview is not a quote.
          { from_url: 'https://docs.example/a', title: 'Docs', text: 'About' },
        ],
        files: [{ name: 'a.txt', permalink: 'https://files.example/a' }],
      }),
    });
    await processKey(e, key);
    const path = 'channels/acme/helix/slack-C1/1792584000.000100/1792584000.000100.md';
    const { body } = parse(e.CHANNELS.objects.get(path).body);
    assert.equal(body, [
      'First step in that direction',
      '',
      `> [Cy](${from} "Quoted message, 2026-10-21T11:43:20.000Z")`,
      '>',
      '> **Pages** for @Ada Staff & friends',
      '',
      'Attachments:',
      '- [a.txt](https://files.example/a)',
    ].join('\n'));
    // Whom the quoted message mentions, this one does not.
    assert.equal(e.DB.rows('SELECT COUNT(*) AS n FROM mentions')[0].n, 0);
    const [row] = e.DB.rows('SELECT title, last_text FROM threads');
    assert.deepEqual(row, {
      title: 'First step in that direction',
      last_text: 'First step in that direction Cy wrote: Pages for @Ada Staff & friends Attachments: a.txt',
    });
  });

  it('looks up Slack Connect file stubs once, keeps the answer in pile 1, and skips it', async () => {
    const key = 'slack/E1/C1/2026/10/21/1792584000.000100-Ev1.json';
    const stub = (id) => ({
      id, file_access: 'check_file_info', filetype: 'pdf', created: 0, user: '',
    });
    const e = env({
      [key]: event({
        type: 'message', subtype: 'file_share', channel: 'C1', user: 'U2', ts: '1792584000.000100', text: 'See attached', files: [stub('F1'), stub('F2')],
      }),
    });
    await quiet(() => processKey(e, key));
    const path = 'channels/acme/helix/slack-C1/1792584000.000100/1792584000.000100.md';
    const { body } = parse(e.CHANNELS.objects.get(path).body);
    assert.match(body, /- \[Quiz flow\]\(https:\/\/example\.slack\.com\/files\/U2\/F1\/flow\.pdf\)/);
    assert.match(body, /- PDF file \(shared from another workspace; opspile cannot see it\)/);
    const kept = JSON.parse(e.RAW.objects.get('slack/E1/C1/files/F1.json').body);
    assert.deepEqual([kept.type, kept.file.name, 'shares' in kept.file], ['file_info', 'flow.pdf', false]);
    // Refused files are not kept, so a later pass asks again.
    assert.equal(e.RAW.objects.has('slack/E1/C1/files/F2.json'), false);
    assert.equal(calls.filter((c) => c === '/api/files.info').length, 2);
    // The kept answer is a pile-1 object a replay lists: it is skipped, and the next pass
    // uses it instead of asking Slack.
    assert.equal((await processKey(e, 'slack/E1/C1/files/F1.json')).result, 'skip');
    await quiet(() => processKey(e, key));
    assert.equal(calls.filter((c) => c === '/api/files.info').length, 3);
  });

  it('creates the knowledge bases of a channel\'s org and team when it is discovered', async () => {
    const key = 'slack/E1/C1/2026/10/21/1.1-a.json';
    const ARTIFACTS = fakeArtifacts();
    const e = env({
      [key]: event({
        type: 'message', channel: 'C1', user: 'U2', ts: '1.1', text: 'hello',
      }),
    }, { ARTIFACTS });
    await processKey(e, key, {});
    await processKey(e, key, {});
    assert.deepEqual(ARTIFACTS.calls.map((c) => c[1]), ['kb-org-acme', 'kb-team-helix']);
    assert.deepEqual(e.DB.rows('SELECT repo FROM knowledge_bases ORDER BY repo').map((r) => r.repo), [
      'kb-org-acme', 'kb-team-helix',
    ]);
  });

  it('pokes the thread agent in the channels that have one, and only there', async () => {
    const key = 'slack/E1/C1/2026/10/21/1792584000.000100-Ev1.json';
    const raw = {
      [key]: event({
        type: 'message', channel: 'C1', user: 'U2', ts: '1792584000.000100', text: 'hello',
      }),
    };
    const off = env(raw, { AGENTS: {}, AGENT_CHANNELS: 'C9' });
    await processKey(off, key);
    assert.equal(off.queued.filter((q) => q.body.agent).length, 0);
    const on = env(raw, { AGENTS: {}, AGENT_CHANNELS: 'C9, C1' });
    await processKey(on, key);
    assert.deepEqual(on.queued.filter((q) => q.body.agent), [{
      body: { agent: 'slack:E1:C1:1792584000.000100' }, options: { delaySeconds: 15 },
    }]);
    // Seen again (a redelivered event): nothing new for the agent.
    await processKey(on, key);
    assert.equal(on.queued.filter((q) => q.body.agent).length, 1);
  });

  it('pokes a new root\'s agent after re-threading it, so it is the group\'s', async () => {
    const key = 'slack/E1/C1/2026/10/21/1792584000.000100-Ev1.json';
    const e = env({
      [key]: event({
        type: 'message', channel: 'C1', user: 'U2', ts: '1792584000.000100', text: 'hello',
      }),
    }, {
      AGENTS: {}, AGENT_CHANNELS: 'C1', VECTORS: {}, AI: {},
    });
    await processKey(e, key);
    const thread = 'slack:E1:C1:1792584000.000100';
    assert.equal(e.queued.filter((q) => q.body.agent).length, 0);
    assert.deepEqual(e.queued.filter((q) => q.body.rethread), [{
      body: { rethread: thread, poke: true }, options: { delaySeconds: 30 },
    }]);
    // The re-threading job pokes the agent when it is done (and when it is given up).
    const job = (body, attempts = 1) => {
      const m = { body, attempts };
      m.ack = () => Object.assign(m, { acked: true });
      m.retry = () => Object.assign(m, { retried: true });
      return m;
    };
    e.queued.length = 0;
    await quiet(() => consume({ messages: [job({ rethread: 'slack:E1:C1:404.1', poke: true })] }, e));
    assert.deepEqual(e.queued, [{ body: { agent: 'slack:E1:C1:404.1' }, options: undefined }]);
    e.queued.length = 0;
    const failing = {
      ...e,
      DB: {
        prepare() {
          throw new Error('down');
        },
      },
    };
    const first = job({ rethread: thread, poke: true });
    const last = job({ rethread: thread, poke: true }, 6);
    await quiet(() => consume({ messages: [first, last] }, failing));
    assert.equal(first.retried && last.retried, true);
    assert.deepEqual(e.queued, [{ body: { agent: thread }, options: undefined }]);
  });

  it('links to the message in its channel\'s workspace, not whichever was used last', async () => {
    const key = 'slack/E1/C1/2026/10/21/1.2-a.json';
    const e = env({
      [key]: event({
        type: 'message', channel: 'C1', user: 'U1', ts: '1.2', text: 'a', thread_ts: '1.1',
      }),
    });
    await processKey(e, key);
    const { permalink } = e.DB.sqlite.prepare("SELECT permalink FROM messages WHERE id = '1.2'").get();
    assert.equal(permalink, 'https://acme-support.slack.com/archives/C1/p12?thread_ts=1.1&cid=C1');
    const path = 'channels/acme/helix/slack-C1/1.1/1.2.md';
    assert.equal(parse(e.CHANNELS.objects.get(path).body).meta.permalink, permalink);
  });

  it('links a channel of the whole org to the workspace most channels live in', async () => {
    channelInfo = {
      id: 'C1', name: 'aem-acme', context_team_id: 'E1', shared_team_ids: ['T2', 'T1', 'T8'],
    };
    const key = 'slack/E1/C1/2026/10/21/1.1-a.json';
    const e = env({
      [key]: event({
        type: 'message', channel: 'C1', user: 'U1', ts: '1.1', text: 'a',
      }),
    });
    e.DB.sqlite.exec(`INSERT INTO channels (source, tenant, channel_id, name, group_id, fetched_at)
      VALUES ('slack', 'E1', 'C7', 'aem-x', 'T1', '2026-10-21T00:00:00Z'),
        ('slack', 'E1', 'C8', 'aem-y', 'T1', '2026-10-21T00:00:00Z'),
        ('slack', 'E1', 'C9', 'aem-z', 'T2', '2026-10-21T00:00:00Z')`);
    await processKey(e, key);
    const { permalink } = e.DB.sqlite.prepare("SELECT permalink FROM messages WHERE id = '1.1'").get();
    assert.equal(permalink, 'https://acme-support.slack.com/archives/C1/p11');
  });

  it('points the links filed before the workspace was known at it, and keeps going without', async () => {
    const k1 = 'slack/E1/C1/2026/10/21/1.1-a.json';
    const k2 = 'slack/E1/C1/2026/10/21/1.2-b.json';
    const e = env({
      [k1]: event({
        type: 'message', channel: 'C1', user: 'U1', ts: '1.1', text: 'a',
      }),
      [k2]: event({
        type: 'message', channel: 'C1', user: 'U1', ts: '1.2', text: 'b', thread_ts: '1.1',
      }),
    });
    // Looked up while team.info failed: the link stays a bare slack.com one.
    channelInfo = { ...channelInfo, context_team_id: 'T5' };
    await quiet(() => processKey(e, k1));
    const link = () => e.DB.sqlite.prepare("SELECT permalink FROM messages WHERE id = '1.1'").get()
      .permalink;
    assert.equal(link(), 'https://slack.com/archives/C1/p11');
    assert.equal(e.DB.sqlite.prepare("SELECT domain FROM channels WHERE channel_id = 'C1'").get()
      .domain, '');
    // A row from before the domain column: looked up again, and its old links follow.
    e.DB.sqlite.exec("UPDATE channels SET domain = NULL WHERE channel_id = 'C1'");
    channelInfo = { ...channelInfo, context_team_id: 'T1' };
    await processKey(e, k2);
    assert.equal(link(), 'https://acme-support.slack.com/archives/C1/p11');
  });

  it('asks for a workspace again a day after its lookup failed, and keeps one that answered', async () => {
    const e = env({});
    const t0 = Date.parse(NOW_ISO);
    const hours = (h) => t0 + h * 60 * 60 * 1000;
    const ch = (channelId, now) => getChannel(e, { source: 'slack', tenant: 'E1', channelId }, now);
    teamDown = true;
    assert.equal((await quiet(() => ch('C1', t0))).domain, null);
    teamDown = false;
    // Within the day the row is fresh; after it, the lookup is made again and now answers.
    assert.equal((await ch('C1', hours(1))).domain, null);
    assert.equal((await ch('C1', hours(25))).domain, 'acme-support');
    // Another channel of the same workspace, the same day: no second team.info.
    assert.equal((await ch('C2', hours(26))).domain, 'acme-support');
    assert.equal(calls.filter((c) => c === '/api/team.info').length, 2);
  });

  it('caches channels and people in D1', async () => {
    const k1 = 'slack/E1/C1/2026/10/21/1.1-a.json';
    const k2 = 'slack/E1/C1/2026/10/21/1.2-b.json';
    const e = env({
      [k1]: event({
        type: 'message', channel: 'C1', user: 'U1', ts: '1.1', text: 'a',
      }),
      [k2]: event({
        type: 'message', channel: 'C1', user: 'U1', ts: '1.2', text: 'b', thread_ts: '1.1',
      }),
    });
    await processKey(e, k1);
    await processKey(e, k2);
    assert.deepEqual(calls, ['/api/conversations.info', '/api/team.info', '/api/users.info']);
    // The login and the display name, which people type after @ to mention her.
    const { aliases } = e.DB.sqlite.prepare("SELECT aliases FROM identities WHERE user_id = 'U1'").get();
    assert.deepEqual(JSON.parse(aliases), ['alove', 'Countess']);
    const reply = parse(e.CHANNELS.objects.get('channels/acme/helix/slack-C1/1.1/1.2.md').body);
    assert.deepEqual(reply.meta.author, {
      kind: 'person', name: 'Ada Staff', org: 'staff.example', staff: true,
    });
  });

  it('gives the same result in any order: edit before original, delete first', async () => {
    const orig = 'slack/E1/C1/2026/10/21/1.1-a.json';
    const edit = 'slack/E1/C1/2026/10/21/1.5-b.json';
    const del = 'slack/E1/C1/2026/10/21/1.9-c.json';
    const raw = {
      [orig]: event({
        type: 'message', channel: 'C1', user: 'U1', ts: '1.1', text: 'v1',
      }),
      [edit]: event({
        type: 'message',
        subtype: 'message_changed',
        channel: 'C1',
        event_ts: '1.5',
        message: {
          user: 'U1', ts: '1.1', text: 'v2', edited: { ts: '1.5' },
        },
      }),
      [del]: event({
        type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: '1.1', event_ts: '1.9',
      }),
    };
    const path = 'channels/acme/helix/slack-C1/1.1/1.1.md';

    const forward = env(raw);
    await processKey(forward, orig);
    await processKey(forward, edit);
    assert.equal(parse(forward.CHANNELS.objects.get(path).body).body, 'v2');

    const backward = env(raw);
    await processKey(backward, edit);
    await processKey(backward, orig);
    assert.equal(parse(backward.CHANNELS.objects.get(path).body).body, 'v2');

    const deleteFirst = env(raw);
    for (const k of [del, orig, edit]) {
      // eslint-disable-next-line no-await-in-loop
      await processKey(deleteFirst, k);
    }
    const tomb = parse(deleteFirst.CHANNELS.objects.get(path).body);
    assert.equal(tomb.body, '');
    assert.ok(tomb.meta.deletedAt);
    assert.deepEqual(tomb.meta.raw, [orig, edit, del].sort());
  });

  it('indexes the thread and moves a reactor\'s watermark', async () => {
    const root = 'slack/E1/C1/2026/10/21/1.1-a.json';
    const react = 'slack/E1/C1/2026/10/21/1.4-r.json';
    const e = env({
      [root]: event({
        type: 'message', channel: 'C1', user: 'U2', ts: '1792584000.000100', text: 'help',
      }),
      [react]: event({
        type: 'reaction_added',
        user: 'U1',
        event_ts: '1792584100.000000',
        item: { type: 'message', channel: 'C1', ts: '1792584000.000100' },
      }),
    });
    assert.equal((await processKey(e, react)).result, 'skip'); // message not known yet
    await processKey(e, root);
    const [t] = e.DB.rows('SELECT * FROM threads');
    assert.deepEqual([
      t.org, t.team, t.title, t.last_author, t.last_staff, t.last_text, t.channel_name,
    ], [
      'acme', 'helix', 'help', 'Cy', 0, 'help', 'aem-acme',
    ]);
    assert.equal((await processKey(e, react)).result, 'reaction');
    assert.deepEqual(e.DB.rows('SELECT person, read_at, via FROM watermarks'), [
      { person: 7, read_at: '2026-10-21T12:00:00.000Z', via: 'react' },
    ]);
  });

  it('skips missing objects and reactions by outsiders', async () => {
    const root = 'slack/E1/C1/2026/10/21/1.1-a.json';
    const react = 'slack/E1/C1/2026/10/21/1.4-r.json';
    const e = env({
      [root]: event({
        type: 'message', channel: 'C1', user: 'U2', ts: '1.1', text: 'x',
      }),
      [react]: event({
        type: 'reaction_added', user: 'U2', reaction: 'eyes', event_ts: '1.4', item: { type: 'message', channel: 'C1', ts: '1.1' },
      }),
    });
    await processKey(e, root);
    // Shown in the thread, but it says nothing about anyone's read state.
    assert.equal((await processKey(e, react)).result, 'reaction');
    assert.deepEqual(e.DB.rows('SELECT emoji, user_key FROM reactions'), [
      { emoji: 'eyes', user_key: 'slack:E1:U2' },
    ]);
    assert.deepEqual(e.DB.rows('SELECT * FROM watermarks'), []);
    assert.equal((await processKey(e, 'slack/none.json')).result, 'missing');
  });
});

describe('consume', () => {
  it('acks processed messages and retries failures', async () => {
    const e = env({});
    e.RAW.get = async (key) => {
      if (key === 'boom') {
        throw new Error('r2 down');
      }
      return null;
    };
    const acked = [];
    const retried = [];
    const msg = (key) => ({
      body: { key }, ack: () => acked.push(key), retry: () => retried.push(key),
    });
    await quiet(() => consume({ messages: [msg('ok'), msg('boom')] }, e));
    assert.deepEqual(acked, ['ok']);
    assert.deepEqual(retried, ['boom']);
  });
});

describe('backfill, mentions and labels', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/conversations.info') {
        return Response.json({ ok: true, channel: { id: 'C1', name: 'aem-acme', context_team_id: 'T1' } });
      }
      if (u.pathname === '/api/conversations.replies') {
        return Response.json({
          ok: true,
          messages: [
            { user: 'U2', ts: '1.1', text: 'site down on https://main--web--acme.aem.live' },
            {
              user: 'U2', ts: '1.2', text: 'still down', thread_ts: '1.1',
            },
          ],
        });
      }
      if (u.pathname === '/api/users.info') {
        const user = USERS[u.searchParams.get('user')];
        return Response.json(user ? { ok: true, user } : { ok: false, error: 'user_not_found' });
      }
      throw new Error(`unexpected ${url}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const reply = 'slack/E1/C1/2026/10/21/1.2-r.json';
  const replyEvent = event({
    type: 'message', channel: 'C1', user: 'U2', ts: '1.2', thread_ts: '1.1', text: 'still down, Ada Staff?',
  });

  it('requests the history of a thread once, when a reply arrives before its root', async () => {
    const e = env({ [reply]: replyEvent });
    await processKey(e, reply);
    await processKey(e, reply);
    const backfills = e.queued.filter((q) => q.body.backfill);
    assert.equal(backfills.length, 1);
    assert.deepEqual(backfills[0].body.backfill, {
      source: 'slack', tenant: 'E1', channelId: 'C1', groupId: undefined, rootId: '1.1', thread: 'slack:E1:C1:1.1',
    });
  });

  it('stores the backfilled thread in pile 1 and normalizes it like events', async () => {
    const e = env({ [reply]: replyEvent });
    e.RAW.put = async (key, body, options) => e.RAW.objects.set(key, { body, options });
    await processKey(e, reply);
    const { backfill } = e.queued.find((q) => q.body.backfill).body;
    const r = await runBackfill(e, backfill);
    assert.deepEqual([r.result, r.messages], ['backfilled', 2]);
    const rootKey = slackBackfillKey('E1', 'C1', { ts: '1.1' });
    assert.equal(rootKey, 'slack/E1/C1/1970/01/01/1.1-backfill.json');
    assert.equal(e.RAW.objects.get(rootKey).options.customMetadata.via, 'backfill');
    await processKey(e, rootKey);
    const [t] = e.DB.rows('SELECT title, root_at, messages FROM threads');
    assert.equal(t.title, 'site down on https://main--web--acme.aem.live');
    assert.ok(t.root_at);
    assert.deepEqual(e.DB.rows('SELECT done_at IS NOT NULL AS done, messages, error FROM backfills'), [
      { done: 1, messages: 2, error: null },
    ]);
  });

  it('tells the room whom a message just posted newly mentions, once', async () => {
    const notified = [];
    const ROOMS = {
      idFromName: (n) => n,
      get: (team) => ({
        fetch: async (u, init) => {
          notified.push({ team, ...JSON.parse(init.body) });
          return new Response(null, { status: 204 });
        },
      }),
    };
    const ts = (Date.now() / 1000).toFixed(6);
    const live = `slack/E1/C1/2026/10/21/${ts}-l.json`;
    const e = env({
      [live]: event({
        type: 'message', channel: 'C1', user: 'U2', ts, thread_ts: '1.1', text: 'Ada Staff, can you look?',
      }),
      [reply]: replyEvent,
    }, { ROOMS });
    await processKey(e, live);
    const threads = notified.filter((n) => n.type === 'thread');
    assert.deepEqual(threads.map((n) => [n.team, n.mentions, n.author]), [['helix', [7], 'Cy']]);
    // Delivered again: nobody is newly mentioned.
    notified.length = 0;
    await processKey(e, live);
    assert.deepEqual(notified.filter((n) => n.type === 'thread').map((n) => n.mentions), [undefined]);
    // An old message (a backfill, a replay) mentions Ada too, but is not announced as one.
    await processKey(e, reply);
    assert.deepEqual(notified.filter((n) => n.type === 'thread').map((n) => n.mentions), [undefined, undefined]);
    assert.equal(e.DB.rows('SELECT COUNT(*) AS n FROM mentions')[0].n, 2);
  });

  it('tells the room whose thread a new message is in, and only for a new message', async () => {
    const notified = [];
    const ROOMS = {
      idFromName: (n) => n,
      get: (team) => ({
        fetch: async (u, init) => {
          notified.push({ team, ...JSON.parse(init.body) });
          return new Response(null, { status: 204 });
        },
      }),
    };
    const announced = () => notified.splice(0).filter((n) => n.type === 'thread').map((n) => n.involved);
    const at = (s) => (Date.now() / 1000 - s).toFixed(6);
    const message = (user, ts, extra = {}) => event({
      type: 'message', channel: 'C1', user, ts, thread_ts: '1.1', text: 'Still broken', ...extra,
    });
    const first = `slack/E1/C1/2026/10/21/${at(30)}-a.json`;
    const second = `slack/E1/C1/2026/10/21/${at(20)}-b.json`;
    const ts = at(10);
    const third = `slack/E1/C1/2026/10/21/${ts}-c.json`;
    const unfurl = `slack/E1/C1/2026/10/21/${at(5)}-d.json`;
    const e = env({
      [first]: message('U2', at(30)),
      [second]: message('U1', at(20)),
      [third]: message('U2', ts),
      [unfurl]: event({
        type: 'message',
        subtype: 'message_changed',
        channel: 'C1',
        ts: at(5),
        event_ts: at(5),
        message: {
          type: 'message', user: 'U2', ts, thread_ts: '1.1', text: 'Still broken',
        },
        previous_message: { text: 'Still broken' },
      }),
    }, { ROOMS });

    await processKey(e, first);
    assert.deepEqual(announced(), [undefined], 'nobody known is in the thread yet');
    await processKey(e, second);
    assert.deepEqual(announced(), [[7]]);
    // A reply from someone else: Ada posted in the thread, so they are told.
    await processKey(e, third);
    assert.deepEqual(announced(), [[7]]);
    // An unfurl rewrites that message: nothing new to tell anyone.
    await processKey(e, unfurl);
    assert.deepEqual(announced(), [undefined]);
  });

  it('counts 👀 on a thread, and the threads of its group, as someone\'s thread', async () => {
    const notified = [];
    const ROOMS = {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (u, init) => {
          notified.push(JSON.parse(init.body));
          return new Response(null, { status: 204 });
        },
      }),
    };
    const announced = () => notified.splice(0).filter((n) => n.type === 'thread').at(-1).involved;
    const at = (s) => (Date.now() / 1000 - s).toFixed(6);
    const message = (user, ts, root, n) => [`slack/E1/C1/2026/10/21/${ts}-${n}.json`, event({
      type: 'message', channel: 'C1', user, ts, thread_ts: root, text: 'Still broken',
    })];
    const rootTs = at(40);
    const [root, rootEvent] = message('U2', rootTs, rootTs, 'a');
    const eyes = 'slack/E1/C1/2026/10/21/eyes.json';
    const [watched, watchedEvent] = message('U2', at(30), rootTs, 'b');
    const otherTs = at(20);
    const [other, otherEvent] = message('U2', otherTs, otherTs, 'c');
    const [follow, followEvent] = message('U2', at(10), otherTs, 'd');
    const e = env({
      [root]: rootEvent,
      [eyes]: event({
        type: 'reaction_added',
        user: 'U1',
        reaction: 'eyes',
        item: { type: 'message', channel: 'C1', ts: rootTs },
        event_ts: at(35),
      }),
      [watched]: watchedEvent,
      [other]: otherEvent,
      [follow]: followEvent,
    }, { ROOMS });
    await processKey(e, root);
    await processKey(e, eyes);
    notified.length = 0;
    await processKey(e, watched);
    assert.deepEqual(announced(), [7]);
    // A thread of its own at first, then folded into the one Ada is watching.
    await processKey(e, other);
    assert.equal(announced(), undefined);
    const [a, b] = e.DB.rows('SELECT thread FROM threads ORDER BY root_at').map((r) => r.thread);
    await e.DB.prepare('UPDATE threads SET logical_thread = ? WHERE thread = ?').bind(a, b).run();
    await processKey(e, follow);
    assert.deepEqual(announced(), [7]);
  });

  it('records mentions by name, and a staff author becomes a person', async () => {
    const e = env({ [reply]: replyEvent });
    await processKey(e, reply);
    assert.deepEqual(e.DB.rows('SELECT person, via FROM mentions'), [{ person: 7, via: 'name' }]);
    const staff = 'slack/E1/C1/2026/10/21/1.3-s.json';
    const e2 = env({
      [staff]: event({
        type: 'message', channel: 'C1', user: 'U3', ts: '1.3', text: 'on it',
      }),
    });
    USERS.U3 = {
      id: 'U3', real_name: 'Zed', profile: { email: 'zed@staff.example' }, team_id: 'T1',
    };
    await processKey(e2, staff);
    assert.deepEqual(e2.DB.rows("SELECT name, staff FROM people WHERE email = 'zed@staff.example'"), [
      { name: 'Zed', staff: 1 },
    ]);
    assert.deepEqual(e2.DB.rows('SELECT via FROM watermarks'), [{ via: 'post' }]);
  });

  it('keeps what the klickhaus export needs in D1, and queues the export', async () => {
    const root = 'slack/E1/C1/2026/10/21/1.1-a.json';
    const edit = 'slack/E1/C1/2026/10/21/1.5-b.json';
    const file = {
      id: 'F3',
      name: 'a.png',
      mimetype: 'image/png',
      url_private: 'https://files.slack.com/files-pri/T1-F3/a.png',
      permalink: 'https://acme-support.slack.com/files/U2/F3/a.png',
    };
    const e = env({
      [root]: event({
        type: 'message', channel: 'C1', user: 'U2', ts: '1.1', text: 'see this', files: [file],
      }),
      [edit]: event({
        type: 'message',
        subtype: 'message_changed',
        channel: 'C1',
        event_ts: '1.5',
        message: {
          user: 'U2', ts: '1.1', text: 'see this, please', edited: { ts: '1.5' }, files: [file],
        },
      }),
    }, {
      CLICKHOUSE_URL: 'https://clickhouse.example',
      CLICKHOUSE_DATABASE: 'logs',
      CLICKHOUSE_USER: 'writer',
      CLICKHOUSE_PASSWORD: 'made-up',
    });
    await processKey(e, root);
    assert.deepEqual(e.DB.rows('SELECT author_kind, edited, attachments FROM messages'), [
      { author_kind: 'person', edited: 0, attachments: 1 },
    ]);
    await processKey(e, edit);
    assert.deepEqual(e.DB.rows('SELECT author_kind, edited, attachments FROM messages'), [
      { author_kind: 'person', edited: 1, attachments: 1 },
    ]);
    const jobs = e.queued.filter((q) => q.body.export);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].body.export, 'slack:E1:C1:1.1');
    assert.deepEqual(jobs[0].options, { delaySeconds: 180 });
  });

  it('vectorizes a thread a person posted in, through the queue', async () => {
    const stored = new Map();
    const AI = { run: async (model, { text }) => ({ data: text.map((t) => [t.length, 1]) }) };
    const CONTENT = {
      upsert: async (items) => items.forEach((i) => stored.set(i.id, i)),
      deleteByIds: async (ids) => ids.forEach((id) => stored.delete(id)),
    };
    const root = 'slack/E1/C1/2026/10/21/1.1-a.json';
    const e = env({
      [root]: event({
        type: 'message', channel: 'C1', user: 'U2', ts: '1.1', text: 'site down on https://main--web--acme.aem.live',
      }),
    }, { AI, CONTENT });
    await processKey(e, root);
    const jobs = e.queued.filter((q) => q.body.vectorize);
    assert.deepEqual(jobs, [{ body: { vectorize: 'slack:E1:C1:1.1' }, options: { delaySeconds: 120 } }]);
    await quiet(() => consume({ messages: [{ body: jobs[0].body, ack() {}, retry() {} }] }, e));
    assert.deepEqual([...stored.values()].map((v) => v.metadata.type).sort(), ['message', 'thread']);
  });

  it('labels a thread with Clef and keeps confident Clairic facts', async () => {
    const calls = [];
    const AI = {
      async run(model, input) {
        calls.push({ model, input });
        if (model.endsWith('/clef')) {
          return {
            model: 'clef',
            answers: {
              next_actor: {
                type: 'choice', choice: 'us', probabilities: { us: 0.9 }, confidence: 0.8,
              },
              kind: {
                type: 'choice', choice: 'incident', probabilities: { incident: 0.95 }, confidence: 0.9,
              },
              urgency: { type: 'score', score: 2.6 },
              resolved: { type: 'noul', noul: 0.05 },
              'topic.cdn': { type: 'noul', noul: 0.9 },
              'topic.seo': { type: 'noul', noul: 0.2 },
            },
          };
        }
        return {
          model: 'clairic',
          answers: {
            problem: { type: 'text', value: 'site down', confidence: 0.97 },
            error: { type: 'text', value: 'maybe a 503', confidence: 0.4 },
            deadline: { type: 'date', value: null, confidence: 0.99 },
          },
        };
      },
    };
    const root = 'slack/E1/C1/2026/10/21/1.1-a.json';
    const e = env({
      [root]: event({
        type: 'message', channel: 'C1', user: 'U2', ts: '1.1', text: 'site down on https://main--web--acme.aem.live, see CVE-2026-1234',
      }),
    }, { AI });
    await processKey(e, root);
    const labelJobs = e.queued.filter((q) => q.body.label).map((q) => q.options);
    assert.deepEqual(labelJobs, [{ delaySeconds: 120 }]);
    // No CONTENT index bound: no vector jobs.
    assert.deepEqual(e.queued.filter((q) => q.body.vectorize), []);
    const r = await labelThread(e, 'slack:E1:C1:1.1', new Date(NOW_ISO));
    assert.deepEqual([r.result, r.next_actor, r.kind, r.facts], ['labeled', 'us', 'incident', 1]);
    // Clef is asked in calls of at most MAX_QUESTIONS: the labels first, then topics and the
    // tech stack the admin team configured (migration 0043).
    const clef = calls.filter((c) => c.model.endsWith('/clef'));
    const sizes = clef.map((c) => Object.keys(c.input.questions).length);
    assert.ok(sizes.length > 1 && sizes.every((n) => n <= MAX_QUESTIONS));
    const asked = clef.flatMap((c) => Object.keys(c.input.questions));
    assert.deepEqual(asked.slice(0, 4), Object.keys(QUESTIONS));
    assert.ok(asked.includes('tech.eds'));
    assert.ok(asked.includes('topic.cdn'));
    // The rules detected Edge Delivery, as sure as can be; Clef said nothing about it.
    assert.deepEqual(e.DB.rows('SELECT tech, p FROM channel_tech'), [{ tech: 'eds', p: 1 }]);
    assert.deepEqual(r.topics, ['cdn']);
    assert.deepEqual(e.DB.rows('SELECT topics FROM labels'), [{ topics: '{"cdn":0.9}' }]);
    assert.match(calls[0].input.state, /Cy \(customer, customer\.example\):\nsite down/);
    assert.equal(calls.find((c) => c.model.endsWith('/clairic')).input.reference_date, '2026-10-21');
    const [label] = e.DB.rows('SELECT next_actor, kind, urgency, resolved_p FROM labels');
    assert.deepEqual(label, {
      next_actor: 'us', kind: 'incident', urgency: 2.6, resolved_p: 0.05,
    });
    assert.deepEqual(e.DB.rows("SELECT field, value FROM facts WHERE source = 'clairic'"), [
      { field: 'problem', value: 'site down' },
    ]);
    assert.deepEqual(
      e.DB.rows("SELECT field, value FROM facts WHERE source = 'rule' ORDER BY field").map((f) => f.field),
      ['cve', 'site', 'url'],
    );
    assert.equal((await labelThread(e, 'slack:E1:C1:1.1')).result, 'unchanged');
    assert.equal(calls.length, clef.length + 2); // Clef, Clairic and the title, once
  });
});

describe('recordBots', () => {
  const teamsMessage = (extra) => ({
    source: 'teams', tenant: 'T', groupId: 'G1', at: '2026-10-21T12:00:00Z', authorRef: {}, ...extra,
  });

  it('keeps a Teams bot\'s name and handle, and the Teams teams it was seen in', async () => {
    const e = env({});
    // Mentioned first (by its handle), then it answers (under its own name), in two teams.
    await recordBots(e, teamsMessage({ botMentions: [{ id: 'b-1', name: 'helper' }] }));
    await recordBots(e, teamsMessage({
      at: '2026-10-21T12:01:00Z',
      authorRef: { kind: 'bot', name: 'helper-agent', botId: 'b-1' },
    }));
    await recordBots(e, teamsMessage({ groupId: 'G2', botMentions: [{ id: 'b-1', name: 'helper' }] }));
    // An older message, replayed late, does not move the time back.
    await recordBots(e, teamsMessage({ at: '2026-10-20T08:00:00Z', botMentions: [{ id: 'b-1' }] }));
    assert.deepEqual(e.DB.rows(`SELECT kind, name, handle FROM identities
      WHERE source = 'teams' AND user_id = 'b-1'`), [{ kind: 'bot', name: 'helper-agent', handle: 'helper' }]);
    assert.deepEqual(e.DB.rows('SELECT group_id, at FROM bot_teams ORDER BY group_id'), [
      { group_id: 'G1', at: '2026-10-21T12:01:00Z' },
      { group_id: 'G2', at: '2026-10-21T12:00:00Z' },
    ]);
  });

  it('ignores Slack and messages without a Teams team', async () => {
    const e = env({});
    await recordBots(e, { ...teamsMessage({ botMentions: [{ id: 'b-1', name: 'x' }] }), source: 'slack' });
    await recordBots(e, teamsMessage({ groupId: undefined, botMentions: [{ id: 'b-1', name: 'x' }] }));
    assert.deepEqual(e.DB.rows('SELECT * FROM bot_teams'), []);
  });
});
