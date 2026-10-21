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
import { ruleFacts } from '../src/facts.js';
import { labelThread, QUESTIONS } from '../src/label.js';
import { consume, processKey } from '../src/normalizer.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

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
    id: 'U1', real_name: 'Ada', profile: { email: 'ada@staff.example' }, team_id: 'T1',
  },
  U2: {
    id: 'U2', real_name: 'Cy', profile: { email: 'cy@customer.example' }, team_id: 'T9',
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
  beforeEach(() => {
    calls = [];
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      calls.push(u.pathname);
      if (u.pathname === '/api/conversations.info') {
        return Response.json({ ok: true, channel: { id: 'C1', name: 'aem-acme', context_team_id: 'T1' } });
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
    assert.deepEqual(calls, ['/api/conversations.info', '/api/users.info']);
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
    assert.deepEqual([t.org, t.team, t.title, t.last_author, t.last_staff, t.channel_name], [
      'acme', 'helix', 'help', 'Cy', 0, 'aem-acme',
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
        type: 'reaction_added', user: 'U2', event_ts: '1.4', item: { type: 'message', channel: 'C1', ts: '1.1' },
      }),
    });
    await processKey(e, root);
    assert.equal((await processKey(e, react)).reason, 'reaction by someone outside the teams');
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
    const r = await labelThread(e, 'slack:E1:C1:1.1', new Date(NOW_ISO));
    assert.deepEqual([r.result, r.next_actor, r.kind, r.facts], ['labeled', 'us', 'incident', 1]);
    assert.deepEqual(Object.keys(calls[0].input.questions), Object.keys(QUESTIONS));
    assert.match(calls[0].input.state, /Cy \(customer, customer\.example\):\nsite down/);
    assert.equal(calls[1].input.reference_date, '2026-10-21');
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
    assert.equal(calls.length, 2);
  });
});

describe('ruleFacts', () => {
  it('finds CVEs, tickets, Edge Delivery sites, repos and URLs', () => {
    const facts = ruleFacts([
      'see https://main--my-site--acme-corp.aem.page/x and site--org.aem.live',
      'CVE-2026-12345, ticket SITES-1234, https://jira.example.com/browse/ABC-99, github.com/acme/repo.git.',
      'ABC-1 alone is not a ticket',
    ]);
    const by = (f) => facts.filter((x) => x.field === f).map((x) => x.value);
    assert.deepEqual(by('cve'), ['CVE-2026-12345']);
    assert.deepEqual(by('ticket'), ['ABC-99', 'SITES-1234']);
    assert.deepEqual(by('site'), ['acme-corp/my-site', 'org/site']);
    assert.deepEqual(by('repo'), ['acme/repo']);
    assert.equal(by('url').length, 2);
  });
});
