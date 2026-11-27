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
import { before, describe, it } from 'node:test';
import { api as inboxApi } from '../src/api.js';
import { processKey } from '../src/normalizer.js';
import { receive } from '../src/portalsource.js';
import { fakeBucket } from './fakes.js';
import { api } from '../src/portal/api.js';
import { integration } from '../src/portal/integration.js';
import { BASE, pruneIntegration, WEEK } from '../src/portal/integration-auth.js';
import * as platform from '../src/portal/platform.js';
import { deleteMessage, ensureUser } from '../src/portal/store.js';
import { deliver } from '../src/portal/events.js';
import { d1, PORTAL } from './d1.js';

const issuer = 'https://access.example';
const origin = 'https://portal.example';
const scopes = ['threads:create', 'threads:read', 'threads:reply', 'changes:read'];
const now = Date.now();
const sec = Math.floor(now / 1000);
const keys = {};
before(async () => {
  await Promise.all(['access', 'console', 'desk'].map(async (label) => {
    const pair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256',
    }, true, ['sign', 'verify']);
    keys[label] = {
      jwk: { kid: 'first', ...await crypto.subtle.exportKey('jwk', pair.publicKey) },
      sign: async (claims) => {
        const part = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
        const unsigned = `${part({ alg: 'RS256', kid: 'first' })}.${part(claims)}`;
        const sig = await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          pair.privateKey,
          new TextEncoder().encode(unsigned),
        );
        return `${unsigned}.${Buffer.from(sig).toString('base64url')}`;
      },
    };
  }));
});

function fixture() {
  const db = d1({ migrations: PORTAL });
  for (const host of ['console', 'desk']) {
    db.sqlite.prepare(`INSERT INTO integration_hosts(id, service_id, issuer, jwks, scopes)
      VALUES (?, ?, ?, ?, ?)`)
      .run(host, `${host}.access`, host, JSON.stringify({ keys: [keys[host].jwk] }), JSON.stringify(scopes));
    for (const tenant of ['one', 'two']) {
      const { channel } = db.sqlite.prepare(`INSERT INTO integration_customers
        (host, tenant, customer, name, enabled) VALUES (?, ?, ?, 'Support', 1) RETURNING channel`)
        .get(host, tenant, tenant);
      for (const person of ['ada', 'bo']) {
        const { actor } = db.sqlite.prepare(`INSERT INTO integration_actors(channel, name)
          VALUES (?, 'Member') RETURNING actor`).get(channel);
        db.sqlite.prepare('INSERT INTO integration_members(channel, subject, actor) VALUES (?, ?, ?)')
          .run(channel, person, actor);
      }
    }
  }
  const env = {
    DB: db, PORTAL_INTEGRATION_AUD: 'integration', ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: 'web',
  };
  async function call(method, path, {
    host = 'console', tenant = 'one', sub = 'ada', key = 'request', claims, service, body,
    signedBy = host, headers = {}, clock = now,
  } = {}) {
    const url = new URL(`${origin}${BASE}${path}`);
    let scope = 'threads:read';
    if (method === 'POST') {
      scope = path === '/threads' ? 'threads:create' : 'threads:reply';
    }
    if (path.startsWith('/changes')) {
      scope = 'changes:read';
    }
    const seconds = Math.floor(clock / 1000);
    const req = new Request(url, {
      method,
      headers: {
        'cf-access-jwt-assertion': await keys.access.sign({
          type: 'app',
          common_name: `${host}.access`,
          sub: '',
          aud: ['integration'],
          iss: issuer,
          exp: seconds + 100,
          ...service,
        }),
        authorization: `Bearer ${await keys[signedBy].sign({
          iss: host,
          aud: 'integration',
          exp: seconds + 45,
          iat: seconds,
          jti: crypto.randomUUID(),
          tenant,
          sub,
          method,
          path: url.pathname,
          scope,
          ...claims,
        })}`,
        'content-type': 'application/json',
        'idempotency-key': key,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await integration(req, env, {
      now: clock, fetchImpl: async () => Response.json({ keys: [keys.access.jwk] }),
    });
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    return { status: res.status, ...await res.json() };
  }
  const create = (opts) => call('POST', '/threads', { body: { title: 'Preview', body: 'Please check.' }, ...opts });
  const list = (opts) => call('GET', '/threads', opts);
  const changes = (after, opts) => call('GET', `/changes?after=${after}`, opts);
  return {
    env, db, call, create, list, changes,
  };
}

describe('registered portal hosts', () => {
  it('requires both verified backend credentials, a fresh scoped assertion and current membership', async () => {
    const { db, list, create } = fixture();
    for (const opts of [
      { headers: { 'cf-access-jwt-assertion': '', 'cf-access-client-id': 'console.access' } },
      { service: { type: 'org' } }, { service: { sub: 'user', email: 'ada@example.test' } },
      { service: { aud: 'web' } }, { service: { exp: sec - 1 } }, { service: { iss: 'other' } },
      { service: { common_name: 'unregistered' } }, { headers: { authorization: '' } },
      { signedBy: 'desk' }, { claims: { aud: 'web' } }, { claims: { iss: 'desk' } },
      { claims: { path: '/' } }, { claims: { method: 'PUT' } }, { claims: { exp: sec } },
      { claims: { exp: sec + 61 } }, { claims: { iat: sec + 1 } }, { claims: { tenant: null } },
      { claims: { jti: '' } }, { claims: { sub: '' } },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await list(opts)).status, 401);
    }
    assert.equal((await list({ sub: 'unknown' })).status, 403);
    assert.equal((await list({ tenant: 'unknown' })).status, 403);
    assert.equal((await list({ claims: { scope: 'threads:create' } })).status, 403);
    assert.equal((await list({ claims: { jti: 'used' } })).status, 200);
    assert.equal((await list({ claims: { jti: 'used' } })).status, 401);
    db.sqlite.exec(`UPDATE integration_actors SET verified_email = 'ada@example.test'
      WHERE actor IN (SELECT actor FROM integration_members WHERE subject = 'ada')`);
    assert.equal((await list()).status, 403);
    assert.equal((await list({ claims: { email: 'ada@example.test' } })).status, 403);
    const claims = { email: 'Ada@example.test', email_verified: true };
    assert.equal((await create({ claims })).status, 201);
    db.sqlite.exec('UPDATE integration_members SET active = 0 WHERE subject = \'ada\'');
    assert.equal((await create({ claims })).status, 403); // even to replay the receipt
    db.sqlite.exec('UPDATE integration_hosts SET scopes = \'[]\'');
    assert.equal((await list({ sub: 'bo' })).status, 403);
  });

  it('isolates hosts, customers, ordinary Access callers and viewer cursors', async () => {
    const {
      env, db, call, create, list, changes,
    } = fixture();
    const empty = await list();
    assert.deepEqual([empty.items, empty.unreadThreads], [[], 0]);
    assert.equal(db.rows('SELECT * FROM channels').length, 0);
    const first = await create();
    assert.equal(first.status, 201);
    for (const other of [{ host: 'desk' }, { tenant: 'two' }]) {
      // eslint-disable-next-line no-await-in-loop
      const second = await create(other);
      assert.equal(second.status, 201);
      assert.notEqual(first.channelId, second.channelId);
      assert.notEqual(first.threadId, second.threadId);
      // eslint-disable-next-line no-await-in-loop
      const [mine, foreign, reply, read, feed] = await Promise.all([
        list(other), call('GET', `/threads/${first.threadId}`, other),
        call('POST', `/threads/${first.threadId}/replies`, { body: { body: 'Wrong' }, ...other }),
        call('PUT', `/threads/${first.threadId}/read`, { body: { through: first.threadId }, ...other }),
        changes(empty.changeCursor, other),
      ]);
      assert.deepEqual(mine.items.map((i) => i.id), [second.threadId]);
      assert.deepEqual([foreign, reply, read, feed].map((r) => r.status), [404, 404, 404, 400]);
    }
    assert.equal((await changes(empty.changeCursor, { sub: 'bo' })).status, 400);
    assert.equal((await changes(`${empty.changeCursor}1`)).status, 400);
    assert.equal((await changes(empty.changeCursor)).events.length, 1);
    const lobby = `${first.channelId}.embed.invalid`;
    env.PORTAL_DOMAINS = `ordinary.example,${lobby}`;
    const get = (email, path) => {
      const url = new URL(path, origin);
      return api(new Request(url), env, url, { email });
    };
    assert.equal((await get(`ada@${lobby}`, '/api/me')).status, 403);
    assert.equal((await get('ada@ordinary.example', `/api/thread?channel=${first.channelId}&thread=${first.threadId}`)).status, 404);
    assert.equal((await platform.open(env, { domain: lobby, name: 'second' })).status, 409);
    const ordinary = await platform.open(env, { domain: 'ordinary.example', name: 'test' });
    const { id } = await platform.post(env, {
      domain: 'ordinary.example',
      channel: ordinary.channel.id,
      author: { bot: true },
      text: 'Standalone',
    });
    assert.equal((await call('GET', `/threads/${id}`)).status, 404);
  });

  it('files the first request using pre-enrolled inbox rules and reads the staff API reply', async () => {
    const {
      env, db, create, call, list, changes,
    } = fixture();
    const [{ channel }] = db.rows("SELECT channel FROM integration_customers WHERE host = 'console' AND tenant = 'one'");
    const viewer = {
      id: 1,
      name: 'Support',
      email: 'agent@support.example',
      staff: true,
      teams: [{ slug: 'ops', role: 'member' }],
    };
    const jobs = [];
    const inbox = {
      DB: d1({
        teams: [{ slug: 'ops', name: 'Ops' }],
        people: [{ ...viewer, staff: 1, teams: ['ops'] }],
        rules: [['org', 'mill'], ['team', 'ops']].map(([target, value]) => ({
          target, value, priority: 10, source: 'portal', field: 'channel_id', pattern: `^${channel}$`,
        })),
      }),
      RAW: fakeBucket(),
      CHANNELS: fakeBucket(),
      NORMALIZE: { send: (job) => jobs.push(job) },
      STAFF_DOMAINS: 'support.example',
      PORTAL: { post: (args) => platform.post(env, args) },
    };
    const { threadId } = await create();
    env.OPSPILE = { events: (events) => receive(inbox, events) };
    assert.equal((await deliver(env)).sent, 2);
    for (const { key } of jobs.filter((j) => j.key)) {
      // eslint-disable-next-line no-await-in-loop
      await processKey(inbox, key, {});
    }
    const [filed] = inbox.DB.rows('SELECT thread, org, team FROM threads');
    assert.deepEqual([filed.org, filed.team], ['mill', 'ops']);
    const beforeReply = await list();
    const url = new URL('/api/post', 'https://inbox.example');
    const sent = await inboxApi(new Request(url, {
      method: 'POST',
      body: JSON.stringify({ thread: filed.thread, text: 'Checked the preview.' }),
    }), inbox, url, { viewer });
    assert.equal(sent.status, 200);
    const view = await call('GET', `/threads/${threadId}`);
    assert.equal(view.messages.at(-1).body, 'Checked the preview.');
    assert.deepEqual((await changes(beforeReply.changeCursor)).events.map((e) => e.reason), ['reply']);
  });

  it('races first requests and retries, including after an uncertain commit', async () => {
    const { db, create, call } = fixture();
    const made = await Promise.all([create(), create(), create({ key: 'another' })]);
    assert.deepEqual(made.map((r) => r.status).sort(), [200, 201, 201]);
    const [{ threadId }] = made;
    assert.equal(made[1].threadId, threadId);
    assert.notEqual(made[2].threadId, threadId);
    assert.equal(db.rows('SELECT * FROM channels').length, 1);
    assert.equal((await create()).threadId, threadId);
    assert.equal((await create({ body: { title: 'Other', body: 'Different' } })).status, 409);
    const reply = (opts) => call('POST', `/threads/${threadId}/replies`, { body: { body: 'Hello' }, ...opts });
    const [a, b] = await Promise.all([reply(), reply()]);
    assert.equal(a.id, b.id);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal((await reply({ body: { body: 'Changed' } })).status, 409);
    assert.equal((await reply({ sub: 'bo' })).status, 201);
    assert.deepEqual(
      db.rows('SELECT json_extract(body, \'$.type\') AS type FROM events ORDER BY seq').map((r) => r.type),
      ['channel', 'message', 'message', 'message', 'message'],
    );
    assert.equal(db.rows('SELECT * FROM integration_changes').length, 4);
    assert.equal((await create({ body: { body: 'hi', title: 'Hello', diagnostics: 'private' } })).status, 400);
    assert.equal((await create({ key: 'topic', body: { body: 'hi', title: 'Hello', topic: 'not registered' } })).status, 400);
  });

  it('pages and resumes only the snapshot, viewer and collection that issued the cursor', async () => {
    const {
      env, create, call, changes,
    } = fixture();
    const one = await create();
    const two = await create({ key: 'next' });
    const args = {
      channel: one.channelId,
      domain: `${one.channelId}.embed.invalid`,
      root: one.threadId,
      author: { bot: true },
      text: 'Update',
    };
    const first = await call('GET', '/threads?limit=1');
    const more = `/threads?limit=1&cursor=${first.next}`;
    const second = await call('GET', more);
    assert.equal(second.next, null);
    const ids = [first.items[0].id, second.items[0].id].sort();
    assert.deepEqual(ids, [one.threadId, two.threadId].sort());
    assert.equal((await call('GET', more, { tenant: 'two' })).status, 400);
    assert.equal((await call('GET', more, { sub: 'bo' })).status, 400);
    assert.equal((await changes(first.next)).status, 400);
    // More than one feed page while the embedding app is offline.
    for (let i = 0; i < 101; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await platform.post(env, args, now + i);
    }
    assert.equal((await call('GET', more)).status, 410);
    const batch = await changes(first.changeCursor);
    assert.deepEqual([batch.events.length, batch.hasMore], [100, true]);
    const last = await changes(batch.next);
    assert.deepEqual([last.events.length, last.hasMore], [1, false]);
    assert.equal(new Set([...batch.events, ...last.events].map((e) => e.id)).size, 101);
    const thread = await call('GET', `/threads/${one.threadId}?limit=100`);
    const rest = await call('GET', `/threads/${one.threadId}?cursor=${thread.next}`);
    assert.deepEqual([thread.messages.length, rest.messages.length, rest.next], [100, 2, null]);
    assert.equal((await call('GET', `/threads/${two.threadId}?cursor=${thread.next}`)).status, 400);
  });

  it('rolls back the receipt, content and feed together if the inbox event cannot commit', async () => {
    const { db, create } = fixture();
    db.sqlite.exec(`CREATE TRIGGER reject_message BEFORE INSERT ON events
      WHEN json_extract(NEW.body, '$.type') = 'message' BEGIN SELECT RAISE(ABORT, 'test'); END`);
    assert.equal((await create()).status, 503);
    for (const table of ['channels', 'events', 'messages', 'integration_changes', 'integration_receipts']) {
      assert.equal(db.rows(`SELECT * FROM ${table}`).length, 0);
    }
    db.sqlite.exec('DROP TRIGGER reject_message');
    assert.equal((await create()).status, 201);
    assert.equal(db.rows('SELECT * FROM channels').length, 1);
  });

  it('limits a viewer without starving the other host with the same identifiers', async () => {
    const { list } = fixture();
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await list()).status, 200);
    }
    assert.equal((await list()).status, 429);
    assert.equal((await list({ host: 'desk' })).status, 200);
    assert.equal((await list({ clock: now + 60000 })).status, 200);
  });

  it('catches up missed staff mutations without exposing inbox data or acknowledging later replies', async () => {
    const {
      env, db, create, call, list, changes,
    } = fixture();
    const { changeCursor } = await list();
    const peer = await list({ sub: 'bo' });
    const { threadId, channelId } = await create();
    const args = {
      channel: channelId,
      domain: `${channelId}.embed.invalid`,
      root: threadId,
      author: { email: 'staff@support.example', name: 'Internal Name', avatar: 'https://staff.example/photo' },
    };
    const r = await platform.post(env, { ...args, text: 'On it' }, now);
    await platform.edit(env, { ...args, id: r.id, text: 'Found it' }, now);
    await platform.react(env, { ...args, id: threadId, emoji: '✅' }, now);
    const late = await platform.post(env, { ...args, text: 'Ready' }, now);
    const snapshot = await call('GET', `/threads/${threadId}`);
    assert.equal(snapshot.resolved, true);
    assert.deepEqual(snapshot.messages[1], {
      id: r.id,
      kind: 'staff',
      name: 'Adobe Support',
      at: new Date(now).toISOString(),
      rev: 1,
      deleted: false,
      body: 'Found it',
    });
    assert.equal((await list()).items[0].unread, 2);
    const read = (through) => call('PUT', `/threads/${threadId}/read`, { body: { through } });
    assert.equal((await read(r.id)).unreadThreads, 1);
    assert.equal((await read(threadId)).unreadThreads, 1);
    assert.equal((await list()).items[0].unread, 1);
    assert.equal((await read(late.id)).unreadThreads, 0);
    await platform.react(env, {
      ...args, id: threadId, emoji: '✅', removed: true,
    }, now);
    await deleteMessage(
      env,
      { id: channelId, lobby: args.domain },
      await ensureUser(env, { ...args.author, kind: 'staff' }),
      { id: late.id },
      now,
    );
    await platform.again(env, args);
    env.OPSPILE = { events: async () => {} };
    await deliver(env);
    const caught = await changes(changeCursor);
    assert.deepEqual(caught.events.map((e) => e.reason), ['created', 'reply', 'edited', 'resolution',
      'reply', 'read', 'read', 'resolution', 'deleted']);
    assert.ok(caught.events.every((e) => e.threadId === threadId
      && Object.keys(e).sort().join(',') === 'id,reason,threadId,type'));
    const peerEvents = (await changes(peer.changeCursor, { sub: 'bo' })).events;
    assert.deepEqual(peerEvents, caught.events.filter((e) => e.reason !== 'read'));
    assert.deepEqual((await changes(changeCursor)).events, caught.events);
    assert.deepEqual((await changes(caught.next)).events, []);
    const view = await call('GET', `/threads/${threadId}`);
    assert.equal(view.resolved, false);
    assert.equal(view.messages.at(-1).deleted, true);
    assert.equal(view.messages.at(-1).body, '');
    assert.doesNotMatch(JSON.stringify(view), /Internal Name|staff\.example|@|avatar|draft|typing/);
    assert.equal((await list({ sub: 'bo' })).unreadThreads, 1);
    db.sqlite.exec('UPDATE integration_changes SET at = 0');
    await pruneIntegration(env);
    assert.equal((await changes(changeCursor)).status, 410);
    const fresh = await list();
    assert.deepEqual((await changes(fresh.changeCursor)).events, []);
    assert.equal((await changes(fresh.changeCursor, { clock: now + WEEK * 1000 })).status, 410);
  });
});
