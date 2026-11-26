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

// Individual channels (portal migration 0008): two members of one channel never see each
// other's threads, on any read path of the integration or of the standalone portal, and Adobe's
// team sees all of them. Every identifier, name and address here is made up.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { processKey } from '../src/normalizer.js';
import { receive } from '../src/portalsource.js';
import { api } from '../src/portal/api.js';
import { deliver } from '../src/portal/events.js';
import * as platform from '../src/portal/platform.js';
import { d1, PORTAL } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';
import {
  ADA, BO, MANAGER, ORG, setup, viewer, world,
} from './integration-world.js';

setup();

const STAFF = { email: 'sam@staff.example', name: 'Sam Staff' };

/** An enabled channel of `panel` for `ORG` with Ada and Bo as members: `{ w, channel }`. */
async function individualWorld() {
  const w = world();
  const channel = w.handMade('panel', ORG, 'agents-mill', ADA);
  const { actor } = w.db.sqlite.prepare(`INSERT INTO integration_actors (channel, name)
    VALUES (?, 'Bo') RETURNING actor`).get(channel);
  w.db.sqlite.prepare('INSERT INTO integration_members (channel, subject, actor) VALUES (?, ?, ?)')
    .run(channel, BO, actor);
  const set = await quiet(() => w.staff(w.admin, 'PUT', '/api/admin/portal/integration/audience', {
    channel, audience: 'individual',
  }));
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual([set.body.audience, set.body.channel.audience], ['individual', 'individual']);
  const as = async (user) => ({ bearer: await w.token({ user }) });
  return {
    w, channel, ada: await as(ADA), bo: await as(BO),
  };
}

const create = (w, who, title) => w.call('POST', '/threads', { ...who, body: { title, body: `${title}, please.` } });

describe('individual integration channels', () => {
  it('lists, reads, counts and feeds a member their own threads only', async () => {
    const {
      w, channel, ada, bo,
    } = await individualWorld();
    const adaStart = await w.list(ada);
    assert.equal(adaStart.body.audience, 'individual');
    const mine = (await create(w, ada, 'Ada one')).body.threadId;
    const mine2 = (await create(w, ada, 'Ada two')).body.threadId;
    const theirs = (await create(w, bo, 'Bo secret')).body.threadId;
    const managed = `${channel}.embed.invalid`;
    // Adobe answers both: Bo's reply is no unread, no change and no count of Ada's.
    for (const root of [mine, theirs]) {
      // eslint-disable-next-line no-await-in-loop
      await platform.post(w.portal, {
        domain: managed, channel, root, author: STAFF, text: 'Looking.',
      });
    }
    const adaList = await w.list(ada);
    assert.deepEqual(adaList.body.items.map((i) => i.id).sort(), [mine, mine2].sort());
    assert.equal(adaList.body.unreadThreads, 1);
    assert.doesNotMatch(JSON.stringify(adaList.body), /Bo secret/);
    const boList = await w.list(bo);
    assert.deepEqual(boList.body.items.map((i) => i.id), [theirs]);
    assert.equal(boList.body.unreadThreads, 1);

    // A colleague's thread is not there, whatever is asked of it.
    const detail = await w.call('GET', `/threads/${theirs}`, ada);
    const reply = await w.call('POST', `/threads/${theirs}/replies`, { ...ada, body: { body: 'Me too' } });
    const read = await w.call('PUT', `/threads/${theirs}/read`, { ...ada, body: { through: theirs } });
    assert.deepEqual([detail.status, reply.status, read.status], [404, 404, 404]);
    assert.equal(w.db.rows('SELECT * FROM messages WHERE root = ?', theirs).length, 2);
    assert.equal((await w.call('GET', `/threads/${mine}`, ada)).body.messages.length, 2);

    // The feed: every change of Ada's threads, none of Bo's, and Bo's own.
    const adaFeed = await w.call('GET', `/changes?after=${adaStart.body.changeCursor}`, ada);
    assert.ok(adaFeed.body.events.length >= 3);
    assert.ok(adaFeed.body.events.every((e) => e.threadId !== theirs));
    assert.equal(adaFeed.body.unreadThreads, 1);
    const boFeed = await w.call('GET', `/changes?after=${boList.body.changeCursor}`, bo);
    assert.deepEqual(boFeed.body.events, []);

    // A page of Ada's list stays good while Bo's thread changes: its head is Ada's alone.
    const page = await w.call('GET', '/threads?limit=1', ada);
    await platform.post(w.portal, {
      domain: managed, channel, root: theirs, author: STAFF, text: 'Fixed.',
    });
    const after = await w.call('POST', `/threads/${theirs}/replies`, { ...bo, body: { body: 'Thanks' } });
    assert.equal(after.status, 201);
    const next = await w.call('GET', `/threads?limit=1&cursor=${page.body.next}`, ada);
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.deepEqual((await w.call('GET', `/changes?after=${adaFeed.body.next}`, ada)).body.events, []);
    assert.equal((await w.list(ada)).body.unreadThreads, 1);
  });

  it('shows a thread to whom Adobe adds, and every thread again once shared', async () => {
    const {
      w, channel, ada, bo,
    } = await individualWorld();
    const start = await w.list(ada);
    const theirs = (await create(w, bo, 'Bo asks')).body.threadId;
    const [adaActor] = w.db.rows('SELECT actor FROM integration_members WHERE subject = ?', ADA);
    const managed = `${channel}.embed.invalid`;
    const added = await platform.addThreadMember(w.portal, {
      domain: managed, channel, root: theirs, account: adaActor.actor, by: STAFF,
    });
    assert.deepEqual(added, { ok: true, added: true });
    assert.deepEqual((await w.list(ada)).body.items.map((i) => i.id), [theirs]);
    const feed = await w.call('GET', `/changes?after=${start.body.changeCursor}`, ada);
    assert.deepEqual(feed.body.events.map((e) => e.reason), ['created', 'added']);
    assert.equal((await w.call('POST', `/threads/${theirs}/replies`, { ...ada, body: { body: 'Same here' } })).status, 201);
    // Only a customer of this channel can be added, and nobody to another channel's thread.
    assert.equal((await platform.addThreadMember(w.portal, {
      domain: managed, channel, root: theirs, account: 'u0000000000000000000a', by: STAFF,
    })).status, 404);

    const mine = (await create(w, ada, 'Ada asks')).body.threadId;
    assert.deepEqual((await w.list(bo)).body.items.map((i) => i.id), [theirs]);
    const shared = await quiet(() => w.staff(w.admin, 'PUT', '/api/admin/portal/integration/audience', {
      channel, audience: 'shared',
    }));
    assert.equal(shared.body.audience, 'shared');
    const both = await w.list(bo);
    assert.equal(both.body.audience, 'shared');
    assert.deepEqual(both.body.items.map((i) => i.id).sort(), [mine, theirs].sort());
    assert.equal((await w.call('GET', `/threads/${mine}`, bo)).status, 200);
  });

  it('is the admin team\'s to set, and the team still files and sees every thread', async () => {
    const {
      w, channel, ada, bo,
    } = await individualWorld();
    const manager = viewer(MANAGER, 'manager');
    const refused = await w.staff(manager, 'PUT', '/api/admin/portal/integration/audience', {
      channel, audience: 'shared',
    });
    assert.equal(refused.status, 403);
    assert.equal((await w.staff(w.admin, 'PUT', '/api/admin/portal/integration/audience', {
      channel, audience: 'nobody',
    })).status, 400);
    const thread = (await w.staff(w.admin, 'GET', `/api/thread?thread=${encodeURIComponent(`request:embed:${channel}`)}`)).body;
    const action = thread.request.actions.find((a) => a.id === 'audience');
    assert.equal(action.fields[0].value, true);
    assert.ok(thread.messages.some((m) => /Individual customers/.test(m.body)));

    const a = (await create(w, ada, 'Ada files')).body.threadId;
    const b = (await create(w, bo, 'Bo files')).body.threadId;
    const jobs = [];
    w.inbox.NORMALIZE = { send: (job) => jobs.push(job) };
    w.portal.OPSPILE = { ...w.portal.OPSPILE, events: (events) => receive(w.inbox, events) };
    await deliver(w.portal);
    for (const { key } of jobs.filter((j) => j.key)) {
      // eslint-disable-next-line no-await-in-loop
      await quiet(() => processKey(w.inbox, key, {}));
    }
    const filed = w.inbox.DB.rows('SELECT thread, team, org FROM threads ORDER BY thread');
    assert.deepEqual(filed.map((t) => t.thread.split(':').pop()).sort(), [a, b].sort());
    assert.ok(filed.every((t) => t.team === 'agents' && t.org === 'mill'));
    for (const t of filed) {
      // eslint-disable-next-line no-await-in-loop
      const seen = await w.staff(manager, 'GET', `/api/thread?thread=${encodeURIComponent(t.thread)}`);
      assert.equal(seen.status, 200);
    }
  });

  it('makes a new organization\'s channel individual before its first message', async () => {
    const w = world();
    await w.list();
    const key = 'request:integration:1';
    const thread = (await w.staff(w.admin, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`)).body;
    const approve = thread.request.actions.find((x) => x.id === 'approve');
    assert.equal(approve.fields.find((f) => f.name === 'individual').value, false);
    const done = await quiet(() => w.staff(w.admin, 'POST', '/api/requests/resolve', {
      key,
      action: 'approve',
      values: {
        name: 'agents-mill', org: 'mill', team: 'agents', person: 'Ada', individual: true,
      },
    }));
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const [mapping] = w.db.rows("SELECT channel, enabled FROM integration_customers WHERE host = 'panel'");
    const [row] = w.db.rows('SELECT audience, set_by FROM channel_audiences WHERE channel = ?', mapping.channel);
    assert.deepEqual([mapping.enabled, row.audience, row.set_by], [1, 'individual', w.admin.email]);
    assert.equal((await w.list()).body.audience, 'individual');
  });

  it('finishes an individual reservation as the admin says now, shared too', async () => {
    const w = world();
    await w.list();
    // A first approval reserved it individual, then failed before anyone was enrolled.
    const reserved = await platform.reserve(w.portal, {
      id: 1, customer: 'agents-mill', name: 'agents-mill', by: { email: w.admin.email }, audience: 'individual',
    });
    const audience = () => w.db.rows('SELECT audience FROM channel_audiences WHERE channel = ?', reserved.channel.id)[0].audience;
    assert.equal(audience(), 'individual');
    const key = 'request:integration:1';
    const thread = (await w.staff(w.admin, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`)).body;
    const field = thread.request.actions.find((x) => x.id === 'approve').fields.find((f) => f.name === 'individual');
    assert.equal(field.value, true);
    // Unchecked this time: the channel is shared, as the admin now sees it.
    const done = await quiet(() => w.staff(w.admin, 'POST', '/api/requests/resolve', {
      key,
      action: 'approve',
      values: {
        name: 'agents-mill', org: 'mill', team: 'agents', person: 'Ada', individual: false,
      },
    }));
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(audience(), 'shared');
    assert.equal((await w.list()).body.audience, 'shared');
  });

  it('lets no one at Adobe start a thread nobody of the channel would see', async () => {
    const { w, channel, ada } = await individualWorld();
    const managed = `${channel}.embed.invalid`;
    const mine = (await create(w, ada, 'Ada asks')).body.threadId;
    const started = await platform.post(w.portal, {
      domain: managed, channel, author: STAFF, text: 'Hello everyone',
    });
    assert.equal(started.status, 409);
    const bot = await platform.post(w.portal, {
      domain: managed, channel, author: { bot: true, name: 'Enterprise Support' }, text: 'Hello',
    });
    assert.equal(bot.status, 409);
    assert.equal(w.db.rows('SELECT * FROM messages WHERE id = root').length, 1);
    // An answer in a customer's thread is as ever.
    assert.equal((await platform.post(w.portal, {
      domain: managed, channel, root: mine, author: STAFF, text: 'Looking.',
    })).ok, true);
  });

  it('keeps every channel shared that nobody set, as it was', async () => {
    const w = world();
    const channel = w.handMade('panel', ORG, 'agents-mill', ADA);
    const { actor } = w.db.sqlite.prepare(`INSERT INTO integration_actors (channel, name)
      VALUES (?, 'Bo') RETURNING actor`).get(channel);
    w.db.sqlite.prepare('INSERT INTO integration_members (channel, subject, actor) VALUES (?, ?, ?)')
      .run(channel, BO, actor);
    const ada = { bearer: await w.token({ user: ADA }) };
    const bo = { bearer: await w.token({ user: BO }) };
    const one = (await create(w, ada, 'Ada shares')).body.threadId;
    const list = await w.list(bo);
    assert.equal(list.body.audience, 'shared');
    assert.deepEqual(list.body.items.map((i) => i.id), [one]);
    assert.equal(list.body.unreadThreads, 1);
    assert.equal((await w.call('POST', `/threads/${one}/replies`, { ...bo, body: { body: 'Same' } })).status, 201);
    assert.equal(w.db.rows('SELECT * FROM channel_audiences').length, 0);
  });
});

// The standalone portal, its page's API: a lobby's channel made individual.
const MAIL_ADA = 'ada@customer.example';
const MAIL_BO = 'bo@customer.example';

async function call(env, email, method, path, body) {
  const url = new URL(`https://portal.example${path}`);
  const res = await api(new Request(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }), env, url, { email, waitUntil: () => {} });
  return { status: res.status, body: await res.json() };
}

async function statusOf(env, email, path) {
  const url = new URL(`https://portal.example${path}`);
  const res = await api(new Request(url), env, url, { email, waitUntil: () => {} });
  await res.body?.cancel();
  return res.status;
}

async function lobby() {
  const env = {
    DB: d1({ migrations: PORTAL }),
    FILES: fakeBucket(),
    PORTAL_DOMAINS: 'customer.example',
    PUBLIC_ORIGIN: 'https://portal.example/',
  };
  await call(env, MAIL_ADA, 'GET', '/api/me');
  await call(env, MAIL_ADA, 'POST', '/api/invite', { email: MAIL_BO });
  await call(env, MAIL_BO, 'GET', '/api/me');
  await call(env, MAIL_ADA, 'POST', '/api/lobby/request', {});
  const opened = await platform.open(env, { domain: 'customer.example', name: 'customer', by: STAFF });
  return { env, channel: opened.channel.id };
}

describe('individual channels of the standalone portal', () => {
  it('shows each person only their own threads, people, status and files', async () => {
    const { env, channel } = await lobby();
    const set = await platform.setChannelAudience(env, { channel, audience: 'individual', by: STAFF });
    assert.equal(set.channel.audience, 'individual');
    const me = await call(env, MAIL_ADA, 'GET', '/api/me');
    assert.equal(me.body.channels[0].audience, 'individual');
    const ada = await call(env, MAIL_ADA, 'POST', '/api/post', { channel, text: 'Ada asks' });
    const upload = await platform.upload(env, {
      domain: 'customer.example', channel, name: 'bo.txt', type: 'text/plain', bytes: new TextEncoder().encode('private'), author: STAFF,
    });
    const bo = await call(env, MAIL_BO, 'POST', '/api/post', { channel, text: 'Bo asks @Ada' });
    await platform.post(env, {
      domain: 'customer.example', channel, root: bo.body.root, author: STAFF, text: 'Here it is', files: [upload.file.id],
    });
    await platform.typing(env, {
      domain: 'customer.example', channel, root: bo.body.root, author: STAFF,
    });
    const q = `channel=${channel}`;
    const threads = await call(env, MAIL_ADA, 'GET', `/api/threads?${q}`);
    assert.deepEqual(threads.body.threads.map((t) => t.id), [ada.body.root]);
    assert.doesNotMatch(JSON.stringify(threads.body), /Bo asks/);
    for (const path of [`/api/thread?${q}&thread=${bo.body.root}`, `/api/status?${q}&thread=${bo.body.root}`,
      `/api/file/${upload.file.id}/bo.txt`]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await statusOf(env, MAIL_ADA, path), 404, path);
    }
    assert.equal((await call(env, MAIL_BO, 'GET', `/api/status?${q}&thread=${bo.body.root}`)).body.typing[0], 'Sam Staff');
    const people = await call(env, MAIL_ADA, 'GET', `/api/people?${q}`);
    assert.deepEqual(people.body.people.map((p) => p.name), ['Ada']);
    const reply = await call(env, MAIL_ADA, 'POST', '/api/post', { channel, thread: bo.body.root, text: 'Me too' });
    const react = await call(env, MAIL_ADA, 'POST', '/api/react', { channel, id: bo.body.root, emoji: '👍' });
    assert.deepEqual([reply.status, react.status], [404, 404]);
    // Bo's @Ada names nobody: a colleague is no one to mention here.
    assert.equal(env.DB.rows('SELECT mentions FROM messages WHERE id = ?', bo.body.id)[0].mentions, null);
    // Bo has his own, with Adobe's answer, its file, and Adobe's people to mention.
    const his = await call(env, MAIL_BO, 'GET', `/api/thread?${q}&thread=${bo.body.root}`);
    assert.equal(his.body.thread.messages.length, 2);
    assert.equal(await statusOf(env, MAIL_BO, `/api/file/${upload.file.id}/bo.txt`), 200);
    assert.deepEqual((await call(env, MAIL_BO, 'GET', `/api/people?${q}`)).body.people.map((p) => p.name).sort(), ['Bo', 'Sam Staff']);

    // Shared again: both see both, as before.
    await platform.setChannelAudience(env, { channel, audience: 'shared', by: STAFF });
    const all = await call(env, MAIL_ADA, 'GET', `/api/threads?${q}`);
    assert.equal(all.body.threads.length, 2);
    assert.equal((await call(env, MAIL_ADA, 'POST', '/api/react', { channel, id: bo.body.root, emoji: '👍' })).status, 200);
  });

  it('tells the inbox a channel is individual, and only then', async () => {
    const { env, channel } = await lobby();
    const got = [];
    env.OPSPILE = {
      events: async (list) => {
        got.push(...list);
      },
    };
    await call(env, MAIL_ADA, 'POST', '/api/post', { channel, text: 'Shared' });
    await platform.setChannelAudience(env, { channel, audience: 'individual', by: STAFF });
    await call(env, MAIL_ADA, 'POST', '/api/post', { channel, text: 'Individual' });
    await deliver(env);
    const told = got.filter((e) => e.channel && e.channel.id === channel);
    assert.deepEqual(told.map((e) => [e.type, e.channel.audience]).slice(-3), [
      ['message', undefined], ['channel', 'individual'], ['message', 'individual'],
    ]);
    // Shared again: its channel event says so, which no message of a shared channel does.
    const back = await platform.setChannelAudience(env, { channel, audience: 'shared', by: STAFF });
    await deliver(env);
    assert.deepEqual([got.at(-1).type, got.at(-1).channel.audience, got.at(-1).seq], ['channel', 'shared', back.seq]);
    assert.equal((await platform.setChannelAudience(env, { channel, audience: 'x', by: STAFF })).status, 400);
    assert.equal((await platform.setChannelAudience(env, { channel: 'cnope', audience: 'shared', by: STAFF })).status, 404);
    assert.equal((await platform.setChannelAudience(env, { channel, audience: 'shared' })).status, 400);
  });
});
