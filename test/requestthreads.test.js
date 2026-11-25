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
import { parseRequestKey, requestKey } from '../src/requestkeys.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, channels, bots and slugs only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada Admin', staff: 1, teams: ['admin'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo Manager', staff: 1, teams: ['helix'], role: 'manager',
};
const viewer = (p) => ({
  id: p.id, email: p.email, name: p.name, teams: p.teams.map((slug) => ({ slug, role: p.role || 'member' })),
});
const RULES = [
  {
    id: 2, target: 'team', priority: 100, source: null, field: 'name', pattern: '^shop-a', value: 'helix',
  },
  {
    id: 4, target: 'team', priority: 100, source: null, field: 'name', pattern: '^shop-', value: 'edge',
  },
];
const AT = '2026-10-22T00:00:00Z';
const KEY = 'slack:E1:C1:1.1';
const BOT = 'slack:E1:B1';

function env() {
  const DB = d1({
    rules: RULES,
    people: [ADA, BO].map((p) => ({
      id: p.id, email: p.email, name: p.name, staff: p.staff, teams: p.teams,
    })),
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }, { slug: 'edge', name: 'Edge ops' }],
  });
  DB.sqlite.exec(`UPDATE team_members SET role = 'manager' WHERE person = 2;
    INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
      VALUES ('slack', 'E1', 'C1', 'shop-acme', '${AT}');
    INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind, channel_name,
      path, root_at, last_at, any_at, messages, updated_at)
    VALUES ('${KEY}', 'slack', 'E1', 'C1', '1.1', 'acme', 'edge', 'channel', 'shop-acme',
      'channels/acme/edge/slack-C1/1.1/', '${AT}', '${AT}', '${AT}', 1, '${AT}');
    INSERT INTO identities (source, tenant, user_id, kind, name, fetched_at)
      VALUES ('slack', 'E1', 'B1', 'bot', 'deploy-bot', '${AT}');
    INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff, counted, author_key,
      author_kind, preview) VALUES ('slack', 'E1', 'C1', '1.2', '${KEY}', '${AT}', 0, 0, '${BOT}',
      'bot', 'Deployed main to production')`);
  return {
    DB, CHANNELS: fakeBucket(), STAFF_DOMAINS: 'staff.example', NORMALIZE: { send: async () => {} },
  };
}

const call = async (e, who, method, path, body) => {
  const res = await api(
    new Request(`https://opspile.test${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
    e,
    new URL(`https://opspile.test${path}`),
    { viewer: viewer(who) },
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

/** Bo, Helix ops' manager, asks for the channel; Ada decides. */
async function asked(e) {
  const r = await quiet(() => call(e, BO, 'POST', '/api/admin/requests', {
    team: 'helix', source: 'slack', channelId: 'C1', note: 'Our customer, our channel',
  }));
  assert.equal(r.status, 200);
  return requestKey('channel', r.body.request.id);
}

describe('request keys', () => {
  it('name the kind and the id, colons and all', () => {
    assert.deepEqual(parseRequestKey('request:bot:slack:E1:B1'), { kind: 'bot', id: 'slack:E1:B1' });
    assert.deepEqual(parseRequestKey(requestKey('rule', 'rule:2|rule:4')), { kind: 'rule', id: 'rule:2|rule:4' });
    assert.equal(parseRequestKey('request:nothing:1'), null);
    assert.equal(parseRequestKey('slack:E1:C1:1.1'), null);
    assert.equal(parseRequestKey('request:channel:'), null);
  });
});

describe('the admin team\'s requests as threads', () => {
  it('are entries of its inbox, the ones that wait unresolved, for the admin team only', async () => {
    const e = env();
    const key = await asked(e);
    // Anyone else has only the questions thread agents asked them (none here).
    const theirs = await quiet(() => call(e, BO, 'GET', '/api/requests'));
    assert.equal(theirs.status, 200);
    assert.deepEqual(theirs.body.threads, []);
    const { status, body } = await quiet(() => call(e, ADA, 'GET', '/api/requests'));
    assert.equal(status, 200);
    const byKey = new Map(body.threads.map((t) => [t.thread, t]));
    const t = byKey.get(key);
    assert.equal(t.title, 'Add #shop-acme → Helix ops');
    assert.equal(t.source, 'request');
    assert.equal(t.team, 'admin');
    assert.equal(t.org_name, 'Channel requests');
    assert.equal(t.resolution.verdict, 'open');
    assert.equal(t.waiting_on, 'us');
    assert.equal(t.unread, true);
    assert.deepEqual(t.participants.map((p) => p.name), ['Bo Manager']);
    // The bot that posted and nobody said whose it is waits too.
    const bot = byKey.get(`request:bot:${BOT}`);
    assert.equal(bot.title, 'deploy-bot');
    assert.equal(bot.resolution.verdict, 'open');
    // As does the conflict between Helix ops' and Edge ops' rules on the channel.
    assert.ok(body.threads.some((x) => x.thread.startsWith('request:rule:')));
  });

  it('show the request, the notes of the log and what can be decided', async () => {
    const e = env();
    const key = await asked(e);
    assert.equal((await call(e, BO, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`)).status, 404);
    const note = await quiet(() => call(e, ADA, 'POST', '/api/requests/note', { key, text: 'Asked Edge ops: fine with them.' }));
    assert.equal(note.status, 200);
    const { body } = await quiet(() => call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`));
    assert.deepEqual(body.messages.map((m) => m.author.name), ['Bo Manager', 'Ada Admin']);
    assert.match(body.messages[0].body, /Our customer, our channel/);
    assert.equal(body.messages[1].mine, true);
    assert.deepEqual(body.request.actions.map((a) => a.id), ['confirm', 'decline']);
    assert.equal(body.request.actions[0].run, undefined);
    // Written there, it is read by her up to it.
    const list = await quiet(() => call(e, ADA, 'GET', '/api/requests'));
    assert.equal(list.body.threads.find((t) => t.thread === key).unread, false);
  });

  it('are decided from the thread, by the routes of the admin pages', async () => {
    const e = env();
    const key = await asked(e);
    const tried = await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key, action: 'confirm', dryRun: true }));
    assert.equal(tried.status, 200);
    assert.match(tried.body.preview, /Files #shop-acme under Helix ops by hand.*\n\n- #shop-acme: 1 thread from Edge ops to Helix ops/s);
    // Only what the thread offers.
    assert.equal((await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key, action: 'merge' }))).status, 409);
    assert.equal((await quiet(() => call(e, BO, 'POST', '/api/requests/resolve', { key, action: 'decline' }))).status, 404);
    const declined = await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', {
      key, action: 'decline', values: { reason: 'Edge ops works it' },
    }));
    assert.equal(declined.status, 200);
    const shown = declined.body.thread;
    assert.equal(shown.request.open, false);
    assert.deepEqual(shown.request.actions, []);
    const decision = shown.messages.find((m) => m.author.kind === 'system');
    assert.match(decision.body, /\*\*Declined\*\* by Ada Admin: Edge ops works it/);
    const list = await quiet(() => call(e, ADA, 'GET', '/api/requests'));
    assert.equal(list.body.threads.find((t) => t.thread === key).resolution.verdict, 'resolved');
  });

  it('keep what is decided of a bot in the log', async () => {
    const e = env();
    const key = `request:bot:${BOT}`;
    const said = await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key, action: 'ours' }));
    assert.equal(said.status, 200);
    assert.equal(said.body.thread.request.open, false);
    const log = said.body.thread.messages.filter((m) => m.author.kind === 'system');
    assert.equal(log.length, 1);
    assert.equal(log[0].body, '**Ada Admin**: deploy-bot is Adobe\'s.');
    // Still offered: it can be changed.
    assert.ok(said.body.thread.request.actions.some((a) => a.id === 'external'));
  });

  it('keep a conflict that is gone, with its log, as a resolved thread', async () => {
    const e = env();
    const first = await quiet(() => call(e, ADA, 'GET', '/api/requests'));
    const rule = first.body.threads.find((t) => t.thread.startsWith('request:rule:'));
    await quiet(() => call(e, ADA, 'POST', '/api/requests/note', { key: rule.thread, text: 'Edge ops should file these.' }));
    // The rule of Helix ops goes: no conflict.
    e.DB.sqlite.exec('DELETE FROM rules WHERE id = 2');
    const after = await quiet(() => call(e, ADA, 'GET', '/api/requests'));
    const gone = after.body.threads.find((t) => t.thread === rule.thread);
    assert.equal(gone.resolution.verdict, 'resolved');
    assert.equal(gone.title, rule.title);
    const { body } = await quiet(() => call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(rule.thread)}`));
    assert.deepEqual(body.messages.map((m) => m.id.replace(/\d+$/, '')), ['request', 'log-', 'gone']);
    assert.deepEqual(body.request.actions, []);
  });

  it('are read in the admin team\'s room', async () => {
    const e = env();
    const key = await asked(e);
    const reads = [];
    e.ROOMS = {
      idFromName: (name) => name,
      get: (name) => ({
        fetch: async (url, init) => {
          reads.push([name, url, JSON.parse(init.body)]);
          return new Response(null, { status: 204 });
        },
      }),
    };
    assert.equal((await call(e, BO, 'POST', '/api/read', { thread: key, at: AT })).status, 404);
    assert.equal((await call(e, ADA, 'POST', '/api/read', { thread: key, at: AT })).status, 204);
    assert.deepEqual(reads, [['admin', 'https://room/read', { person: 1, thread: key, at: AT }]]);
  });
});
