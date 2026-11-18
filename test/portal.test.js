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
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { api } from '../src/portal/api.js';
import { deliver, pruneEvents } from '../src/portal/events.js';
import { pruneFiles, rangeOf } from '../src/portal/files.js';
import { PORTAL_FILES, portalPage } from '../src/portal/page.js';
import {
  CHANNEL_ID, domainOf, FILE_ID, filePath, MESSAGE_ID, messageId, portalBotId, portalFileRef,
  portalUserId,
} from '../src/portal/ids.js';
import * as platform from '../src/portal/platform.js';
import { MAX_HTML, richMarkdown } from '../src/portal/richtext.js';
import {
  companyFromDomain, mentionsIn, nameFromMail, titleOf,
} from '../src/portal/store.js';
import { DEFAULT_TECH, listTech, refreshTech } from '../src/portal/tech.js';
import { d1, PORTAL } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';
import { PAGES, SCRIPTS } from './ui.js';

// Made-up people and domains only.
const ADA = 'ada@customer.example';
const BO = 'bo@customer.example';
const EVE = 'eve@other.example';
const STAFF = { email: 'sam@staff.example', name: 'Sam Staff' };

/** The portal with its own database, and what its events would reach (`got`). */
function portal({ bound = true } = {}) {
  const got = [];
  const env = {
    DB: d1({ migrations: PORTAL }),
    FILES: fakeBucket(),
    PORTAL_DOMAINS: 'customer.example, Other.Example',
    PUBLIC_ORIGIN: 'https://portal.example/',
    PORTAL_NAME: 'test',
    got,
  };
  if (bound) {
    env.OPSPILE = {
      events: async (list) => { got.push(...list); },
      technologies: async () => [
        { tech: 'eds', name: 'Edge Delivery', product: 'Sites' },
        { tech: 'da', name: 'Document Authoring', product: 'Sites' },
      ],
    };
  }
  return env;
}

/** One call of the portal's API as `email`; what it does behind its answer is awaited. */
async function call(env, email, method, path, body, headers = {}) {
  const url = new URL(`https://portal.example${path}`);
  const request = new Request(url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const pending = [];
  const res = await api(request, env, url, { email, waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return { status: res.status, body: await res.json() };
}

/** One call of the portal's API as `email` whose body, or answer, is bytes: the response. */
async function raw(env, email, method, path, { bytes, type, origin = 'https://portal.example' } = {}) {
  const url = new URL(`https://portal.example${path}`);
  return api(new Request(url, {
    method,
    headers: { ...(origin ? { origin } : {}), ...(type ? { 'content-type': type } : {}) },
    body: bytes,
  }), env, url, { email });
}

/** The start of a PNG of `w` by `h`: enough for its size to be read. */
function pngOf(w, h) {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
const text = (t) => new TextEncoder().encode(t);

/** A lobby with a channel, as the inbox opens one: `{ env, channel }`. */
async function opened() {
  const env = portal();
  await call(env, ADA, 'GET', '/api/me');
  await call(env, ADA, 'POST', '/api/invite', { email: BO });
  await call(env, BO, 'GET', '/api/me');
  await call(env, ADA, 'POST', '/api/lobby/request', {});
  const res = await platform.open(env, { domain: 'customer.example', name: 'customer', by: STAFF });
  await deliver(env);
  return { env, channel: res.channel.id };
}

describe('the customer portal: ids', () => {
  it('names an account by its mail address, the same in both Workers', async () => {
    assert.equal(await portalUserId(' Ada@Customer.Example '), await portalUserId(ADA));
    assert.match(await portalUserId(ADA), /^u[0-9a-f]{20}$/);
    assert.notEqual(await portalUserId(ADA), await portalUserId(BO));
    assert.match(await portalBotId('Enterprise Support'), /^b[0-9a-f]{20}$/);
    assert.equal(domainOf('Ada@Customer.Example'), 'customer.example');
    assert.equal(domainOf('not a mail address'), null);
    assert.equal(domainOf('ada@localhost'), null);
  });

  it('makes message ids that sort by time, and channel ids that say nothing', () => {
    const a = messageId(Date.parse('2026-11-17T10:00:00Z'));
    const b = messageId(Date.parse('2026-11-17T10:00:01Z'));
    assert.match(a, MESSAGE_ID);
    assert.ok(a < b);
    const { channel } = { channel: 'c0123456789ab' };
    assert.match(channel, CHANNEL_ID);
  });

  it('names people and companies until they say', () => {
    assert.equal(nameFromMail('ada.lovelace+test@customer.example'), 'Ada Lovelace');
    assert.equal(companyFromDomain('acme-corp.example'), 'Acme Corp');
    assert.equal(titleOf('\n## Our **site** is `down`\nsince noon'), 'Our site is down');
    assert.equal(titleOf('x'.repeat(300)).length, 118);
  });
});

describe('the customer portal: the lobby', () => {
  it('is closed to every mail domain it is not open to, and to nobody', async () => {
    const env = portal();
    assert.equal((await call(env, null, 'GET', '/api/me')).status, 401);
    const res = await call(env, 'mallory@elsewhere.example', 'GET', '/api/me');
    assert.equal(res.status, 403);
    assert.equal(res.body.closed, true);
    assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM users')[0].n, 0);
    // Nothing is open while PORTAL_DOMAINS is empty.
    assert.equal((await call({ ...env, PORTAL_DOMAINS: '' }, ADA, 'GET', '/api/me')).status, 403);
  });

  it('is founded by the first of a domain, who invites colleagues of the same domain', async () => {
    const env = portal();
    const me = await call(env, ADA, 'GET', '/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.member, true);
    assert.deepEqual(me.body.me.name, 'Ada');
    assert.equal(me.body.lobby.status, 'draft');
    assert.equal(me.body.lobby.company, 'Customer');
    assert.deepEqual(me.body.channels, []);
    // Until the inbox has told its technologies, the list that stands in.
    assert.equal(me.body.tech.length, DEFAULT_TECH.length);

    // A colleague nobody invited is not in it, and is told whom to ask.
    const bo = await call(env, BO, 'GET', '/api/me');
    assert.equal(bo.body.member, false);
    assert.deepEqual(bo.body.colleagues, [{ name: 'Ada', email: ADA }]);
    assert.equal(bo.body.lobby, undefined);
    assert.equal((await call(env, BO, 'PUT', '/api/lobby', { note: 'x' })).status, 403);
    assert.equal((await call(env, BO, 'POST', '/api/invite', { email: 'cy@customer.example' })).status, 403);

    // Only colleagues of the same domain are invited.
    const no = await call(env, ADA, 'POST', '/api/invite', { email: EVE });
    assert.equal(no.status, 400);
    assert.match(no.body.error, /@customer\.example/);
    const yes = await call(env, ADA, 'POST', '/api/invite', { email: BO.toUpperCase() });
    assert.equal(yes.body.added, true);
    assert.deepEqual(yes.body.members.map((m) => [m.email, m.joined]), [[ADA, true], [BO, false]]);
    assert.equal((await call(env, ADA, 'POST', '/api/invite', { email: BO })).body.added, false);
    // Inviting someone again does not rename them: the name given is for a new account.
    const again = await call(env, ADA, 'POST', '/api/invite', { email: BO, name: 'Somebody Else' });
    assert.deepEqual(again.body.members.map((m) => m.name), ['Ada', 'Bo']);

    // Invited, Bo is in it the next time he signs in.
    const joined = await call(env, BO, 'GET', '/api/me');
    assert.equal(joined.body.member, true);
    assert.deepEqual(joined.body.members.map((m) => m.joined), [true, true]);
    // An invitation nobody used can be taken back; someone who signed in stays.
    const cy = await call(env, ADA, 'POST', '/api/invite', { email: 'cy@customer.example', name: 'Cy Customer' });
    const cyId = cy.body.members.find((m) => m.email === 'cy@customer.example').id;
    assert.equal((await call(env, BO, 'DELETE', '/api/invite', { user: cyId })).body.members.length, 2);
    const boId = joined.body.me.id;
    assert.equal((await call(env, ADA, 'DELETE', '/api/invite', { user: boId })).status, 404);
  });

  it('keeps each domain to its own lobby', async () => {
    const env = portal();
    await call(env, ADA, 'GET', '/api/me');
    const eve = await call(env, EVE, 'GET', '/api/me');
    assert.equal(eve.body.member, true);
    assert.equal(eve.body.domain, 'other.example');
    assert.deepEqual(eve.body.members.map((m) => m.email), [EVE]);
  });

  it('says what it uses and asks for a channel, which the inbox hears of', async () => {
    const env = portal();
    await call(env, ADA, 'GET', '/api/me');
    await refreshTech(env);
    assert.deepEqual((await listTech(env)).map((t) => t.tech), ['eds', 'da']);
    const saved = await call(env, ADA, 'PUT', '/api/lobby', {
      company: 'Customer Inc', tech: ['da', 'nope', 'da'], note: ' We migrate. ',
    });
    assert.deepEqual(saved.body.lobby.tech, ['da']);
    assert.equal(saved.body.lobby.note, 'We migrate.');
    // Nothing is told of a lobby that has not asked yet.
    assert.deepEqual(env.got, []);
    assert.equal((await call(env, ADA, 'PUT', '/api/profile', { name: 'Ada Lovelace' })).body.name, 'Ada Lovelace');

    const asked = await call(env, ADA, 'POST', '/api/lobby/request', {});
    assert.equal(asked.body.lobby.status, 'requested');
    assert.equal(env.got.length, 1);
    const [event] = env.got;
    assert.equal(event.type, 'lobby');
    assert.equal(event.portal, 'test');
    assert.equal(event.domain, 'customer.example');
    assert.equal(event.seq, 1);
    assert.deepEqual(event.lobby.tech, ['da']);
    assert.equal(event.lobby.company, 'Customer Inc');
    assert.equal(event.lobby.status, 'requested');
    assert.deepEqual(event.lobby.requestedBy.email, ADA);
    assert.deepEqual(event.lobby.members.map((m) => [m.name, m.email, m.joined]), [['Ada Lovelace', ADA, true]]);
    // Asking twice asks once; a change after it is told again, as the lobby is now.
    assert.equal((await call(env, ADA, 'POST', '/api/lobby/request', {})).body.changed, false);
    await call(env, ADA, 'PUT', '/api/lobby', { tech: ['eds', 'da'] });
    assert.deepEqual(env.got.map((e) => e.seq), [1, 2]);
    assert.deepEqual(env.got[1].lobby.tech, ['eds', 'da']);

    // Declined, with a reason they read; they may ask again.
    assert.deepEqual(await platform.decline(env, { domain: 'customer.example', reason: 'Use your Slack channel.' }), { ok: true });
    const declined = await call(env, ADA, 'GET', '/api/me');
    assert.equal(declined.body.lobby.status, 'declined');
    assert.equal(declined.body.lobby.reason, 'Use your Slack channel.');
    assert.equal((await platform.decline(env, { domain: 'customer.example' })).status, 409);
    assert.equal((await call(env, ADA, 'POST', '/api/lobby/request', {})).body.lobby.status, 'requested');
  });

  it('takes writes as JSON from its own page only', async () => {
    const env = portal();
    await call(env, ADA, 'GET', '/api/me');
    const form = await call(env, ADA, 'PUT', '/api/lobby', { note: 'x' }, { 'content-type': 'text/plain' });
    assert.equal(form.status, 400);
    const elsewhere = await call(env, ADA, 'PUT', '/api/lobby', { note: 'x' }, { origin: 'https://evil.example' });
    assert.equal(elsewhere.status, 400);
    assert.equal((await call(env, ADA, 'PUT', '/api/lobby', { note: 'x' }, { origin: 'https://portal.example' })).status, 200);
    assert.equal(await api(new Request('https://portal.example/'), env, new URL('https://portal.example/')), null);
  });
});

describe('the customer portal: a channel', () => {
  it('is opened by the inbox, for every member of the lobby', async () => {
    const { env, channel } = await opened();
    assert.match(channel, CHANNEL_ID);
    for (const who of [ADA, BO]) {
      // eslint-disable-next-line no-await-in-loop
      const me = await call(env, who, 'GET', '/api/me');
      assert.equal(me.body.lobby.status, 'open');
      assert.deepEqual(me.body.channels.map((c) => [c.id, c.name]), [[channel, 'customer']]);
    }
    // The inbox hears of the channel, and of the lobby as it is now.
    assert.deepEqual(env.got.slice(-2).map((e) => [e.type, e.lobby?.status || e.channel.name]), [['channel', 'customer'], ['lobby', 'open']]);
    assert.equal((await platform.open(env, { domain: 'nobody.example', name: 'x' })).status, 404);
  });

  it('is nobody else\'s', async () => {
    const { env, channel } = await opened();
    await platform.post(env, {
      domain: 'customer.example', channel, text: 'Welcome!', author: STAFF,
    });
    await call(env, EVE, 'GET', '/api/me');
    assert.equal((await call(env, EVE, 'GET', `/api/threads?channel=${channel}`)).status, 404);
    assert.equal((await call(env, EVE, 'POST', '/api/post', { channel, text: 'hi' })).status, 404);
    // Nor does the inbox reach a channel through another lobby.
    assert.equal((await platform.post(env, {
      domain: 'other.example', channel, text: 'x', author: STAFF,
    })).status, 404);
    // Someone of the domain who was not invited reads nothing either.
    assert.equal((await call(env, 'cy@customer.example', 'GET', `/api/threads?channel=${channel}`)).status, 403);
  });

  it('holds threads: Adobe and the customer write, read, react, edit and delete', async () => {
    const { env, channel } = await opened();
    const welcome = await platform.post(env, {
      domain: 'customer.example', channel, text: 'Welcome!\nAsk us anything.', author: STAFF,
    });
    assert.match(welcome.id, MESSAGE_ID);
    assert.equal(welcome.root, welcome.id);

    let { body: { threads } } = await call(env, ADA, 'GET', `/api/threads?channel=${channel}`);
    assert.deepEqual(threads.map((t) => [t.title, t.replies, t.unread, t.author.kind, t.resolved]), [['Welcome!', 0, 1, 'staff', false]]);

    const reply = await call(env, ADA, 'POST', '/api/post', { channel, thread: welcome.id, text: ' Thank you. ' });
    assert.equal(reply.body.root, welcome.id);
    // A reply to a reply is a reply in its thread; an unknown thread is none.
    const nested = await call(env, BO, 'POST', '/api/post', { channel, thread: reply.body.id, text: 'Same here' });
    assert.equal(nested.body.root, welcome.id);
    assert.equal((await call(env, BO, 'POST', '/api/post', { channel, thread: 'm000000000000000', text: 'x' })).status, 404);
    assert.equal((await call(env, BO, 'POST', '/api/post', { channel, text: '  ' })).status, 400);
    assert.equal((await call(env, BO, 'POST', '/api/post', { channel, text: 'x'.repeat(8001) })).status, 400);

    // Reading a thread marks it read, for the reader.
    const read = await call(env, ADA, 'GET', `/api/thread?channel=${channel}&thread=${welcome.id}`);
    const shown = read.body.thread.messages
      .map((m) => [m.body, m.mine, m.author.name, m.author.kind]);
    assert.deepEqual(shown, [
      ['Welcome!\nAsk us anything.', false, 'Sam Staff', 'staff'],
      ['Thank you.', true, 'Ada', 'customer'],
      ['Same here', false, 'Bo', 'customer'],
    ]);
    ({ body: { threads } } = await call(env, ADA, 'GET', `/api/threads?channel=${channel}`));
    assert.deepEqual([threads[0].replies, threads[0].unread], [2, 0]);
    // Whoever writes has read up to there; what others write after it is new to them.
    ({ body: { threads } } = await call(env, BO, 'GET', `/api/threads?channel=${channel}`));
    assert.equal(threads[0].unread, 0);
    await platform.post(env, {
      domain: 'customer.example', channel, root: welcome.id, text: 'Anything else?', author: STAFF,
    }, Date.now() + 1000);
    ({ body: { threads } } = await call(env, BO, 'GET', `/api/threads?channel=${channel}`));
    assert.deepEqual([threads[0].replies, threads[0].unread], [3, 1]);

    // Reactions: Adobe's ✅ on the first message says the thread is resolved.
    const thumbs = await call(env, ADA, 'POST', '/api/react', { channel, id: welcome.id, emoji: '👍' });
    assert.equal(thumbs.body.changed, true);
    assert.equal((await call(env, ADA, 'POST', '/api/react', { channel, id: welcome.id, emoji: '👍' })).body.changed, false);
    assert.equal((await call(env, ADA, 'POST', '/api/react', { channel, id: welcome.id, emoji: 'thumbsup' })).status, 400);
    assert.equal((await call(env, ADA, 'POST', '/api/react', { channel, id: welcome.id, emoji: '✅' })).status, 200);
    let { thread } = (await call(env, BO, 'GET', `/api/thread?channel=${channel}&thread=${welcome.id}`)).body;
    assert.equal(thread.resolved, false);
    await platform.react(env, {
      domain: 'customer.example', channel, id: welcome.id, emoji: '✅', author: STAFF,
    });
    thread = (await call(env, BO, 'GET', `/api/thread?channel=${channel}&thread=${welcome.id}`)).body.thread;
    assert.equal(thread.resolved, true);
    assert.deepEqual(thread.messages[0].reactions, [
      {
        emoji: '👍', count: 1, mine: false, names: ['Ada'],
      },
      {
        emoji: '✅', count: 2, mine: false, names: ['Ada', 'Sam Staff'],
      },
    ]);
    await call(env, ADA, 'POST', '/api/react', {
      channel, id: welcome.id, emoji: '👍', remove: true,
    });

    // Only its author changes or deletes a message; a deleted one stays, without its text.
    assert.equal((await call(env, BO, 'POST', '/api/edit', { channel, id: reply.body.id, text: 'no' })).status, 403);
    assert.equal((await call(env, ADA, 'POST', '/api/edit', { channel, id: reply.body.id, text: 'Thanks a lot.' })).status, 200);
    assert.equal((await call(env, BO, 'POST', '/api/delete', { channel, id: reply.body.id })).status, 403);
    assert.equal((await call(env, BO, 'POST', '/api/delete', { channel, id: nested.body.id })).status, 200);
    assert.equal((await call(env, BO, 'POST', '/api/delete', { channel, id: nested.body.id })).status, 404);
    thread = (await call(env, ADA, 'GET', `/api/thread?channel=${channel}&thread=${welcome.id}`)).body.thread;
    assert.deepEqual(thread.messages.map((m) => [m.body, m.deleted, Boolean(m.editedAt)]), [
      ['Welcome!\nAsk us anything.', false, false], ['Thanks a lot.', false, true], ['', true, false],
      ['Anything else?', false, false],
    ]);
    // The inbox edits what its people wrote, and nothing of anybody else's.
    assert.equal((await platform.edit(env, {
      domain: 'customer.example', channel, id: welcome.id, text: 'Welcome, all!', author: STAFF,
    })).ok, true);
    assert.equal((await platform.edit(env, {
      domain: 'customer.example', channel, id: reply.body.id, text: 'x', author: STAFF,
    })).status, 403);

    // What the inbox heard: each as it is now, with its channel and author.
    await deliver(env);
    const messages = env.got.filter((e) => e.type === 'message');
    const told = messages.map(({ message: m, author }) => [
      m.text, author.kind, Boolean(m.editedAt), Boolean(m.deletedAt),
    ]);
    assert.deepEqual(told, [
      ['Welcome!\nAsk us anything.', 'staff', false, false],
      ['Thank you.', 'customer', false, false],
      ['Same here', 'customer', false, false],
      ['Anything else?', 'staff', false, false],
      ['Thanks a lot.', 'customer', true, false],
      ['', 'customer', false, true],
      ['Welcome, all!', 'staff', true, false],
    ]);
    assert.deepEqual(messages[1].channel, {
      id: channel, name: 'customer', topic: null, company: 'Customer',
    });
    assert.deepEqual(messages[1].author, {
      id: await portalUserId(ADA), name: 'Ada', email: ADA, kind: 'customer',
    });
    assert.equal(messages[1].message.permalink, `https://portal.example/?c=${channel}&t=${welcome.id}#${reply.body.id}`);
    assert.equal(messages[0].author.email, STAFF.email);
    assert.deepEqual(env.got.filter((e) => e.type === 'reaction').map((e) => [e.reaction.emoji, e.reaction.removed, e.author.kind]), [
      ['👍', false, 'customer'], ['✅', false, 'customer'], ['✅', false, 'staff'], ['👍', true, 'customer'],
    ]);
    // Events are numbered in order, each once.
    assert.deepEqual(env.got.map((e) => e.seq), env.got.map((_, i) => i + 1));
  });

  it('posts for the inbox\'s app as a bot, and for nobody without a name', async () => {
    const { env, channel } = await opened();
    const res = await platform.post(env, {
      domain: 'customer.example', channel, text: 'An answer.', author: { bot: true, name: 'Enterprise Support' },
    });
    assert.equal(res.ok, true);
    await deliver(env);
    const event = env.got.at(-1);
    assert.deepEqual(event.author, {
      id: await portalBotId('Enterprise Support'), name: 'Enterprise Support', email: null, kind: 'bot',
    });
    assert.match((await platform.post(env, { domain: 'customer.example', channel, text: 'x' })).error, /who posts/);
    assert.match((await platform.post(env, {
      domain: 'customer.example', channel, text: 'x', author: { email: 'nobody' },
    })).error, /who posts/);
  });

  it('tells of a thread again when the inbox asks', async () => {
    const { env, channel } = await opened();
    const a = await platform.post(env, {
      domain: 'customer.example', channel, text: 'One', author: STAFF,
    });
    await platform.post(env, {
      domain: 'customer.example', channel, text: 'Two', author: STAFF,
    });
    await call(env, ADA, 'POST', '/api/post', { channel, thread: a.id, text: 'Reply' });
    await deliver(env);
    const before = env.got.length;
    assert.deepEqual(await platform.again(env, { domain: 'customer.example', channel, root: a.id }), { ok: true, messages: 2 });
    await deliver(env);
    assert.deepEqual(env.got.slice(before).map((e) => [e.message.text, e.via]), [['One', 'resend'], ['Reply', 'resend']]);
  });
});

describe('the customer portal: its outbox', () => {
  it('keeps what happened until the inbox is bound, and has it once', async () => {
    const env = portal({ bound: false });
    await call(env, ADA, 'GET', '/api/me');
    await call(env, ADA, 'POST', '/api/lobby/request', {});
    assert.deepEqual(await deliver(env), { result: 'unbound', sent: 0 });
    assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM events WHERE delivered_at IS NULL')[0].n, 1);

    // The inbox fails: the events are tried again, and say why.
    let fail = true;
    env.OPSPILE = {
      events: async (list) => {
        if (fail) {
          throw new Error('inbox down');
        }
        env.got.push(...list);
      },
    };
    const failed = await quiet(() => deliver(env));
    assert.equal(failed.result, 'failed');
    assert.deepEqual(env.DB.rows('SELECT attempts, error FROM events'), [{ attempts: 1, error: 'inbox down' }]);
    fail = false;
    assert.deepEqual(await deliver(env), { result: 'delivered', sent: 1 });
    assert.deepEqual(await deliver(env), { result: 'delivered', sent: 0 });
    assert.equal(env.got.length, 1);

    // Delivered events go after a week; what waits stays.
    await call(env, ADA, 'PUT', '/api/lobby', { note: 'more' });
    env.DB.sqlite.prepare("UPDATE events SET delivered_at = NULL, at = '2026-01-01T00:00:00Z' WHERE seq = 2").run();
    assert.deepEqual(await pruneEvents(env, Date.now() + 8 * 24 * 60 * 60 * 1000), { deleted: 1 });
    assert.deepEqual(env.DB.rows('SELECT seq FROM events'), [{ seq: 2 }]);
  });

  it('lists the inbox\'s technologies once it has told them, and keeps its list otherwise', async () => {
    const env = portal({ bound: false });
    assert.deepEqual(await refreshTech(env), { result: 'unbound' });
    assert.equal((await listTech(env)).length, DEFAULT_TECH.length);
    env.OPSPILE = { technologies: async () => [] };
    assert.deepEqual(await refreshTech(env), { result: 'empty' });
    env.OPSPILE = { technologies: async () => [{ tech: 'eds', name: 'Edge Delivery', product: 'Sites' }, { tech: '', name: 'x' }] };
    assert.deepEqual(await refreshTech(env), { result: 'refreshed', tech: 1 });
    assert.deepEqual(await listTech(env), [{ tech: 'eds', name: 'Edge Delivery', product: 'Sites' }]);
  });
});

describe('the customer portal: files', () => {
  const upload = async (env, email, channel, name, type, bytes) => {
    const res = await raw(env, email, 'POST', `/api/upload?channel=${channel}&name=${encodeURIComponent(name)}`, { bytes, type });
    return { status: res.status, ...await res.json() };
  };

  it('names a file by an id nobody guesses, and finds it in a link to the portal', () => {
    assert.equal(filePath('f0123456789abcdef', 'a (1)\'s.png'), '/api/file/f0123456789abcdef/a%20%281%29%27s.png');
    assert.deepEqual(portalFileRef('https://portal.example/api/file/f0123456789abcdef/a%20%281%29.png'), { id: 'f0123456789abcdef', name: 'a (1).png' });
    for (const no of ['http://portal.example/api/file/f0123456789abcdef/a.png', 'https://portal.example/api/file/f012/a.png', 'https://portal.example/api/file/f0123456789abcdef/a/b', 'https://portal.example/api/file/f0123456789abcdef/a.png?x=1']) {
      assert.equal(portalFileRef(no), null, no);
    }
    assert.deepEqual(rangeOf('bytes=0-9'), { offset: 0, length: 10 });
    assert.deepEqual(rangeOf('bytes=5-'), { offset: 5 });
    assert.deepEqual(rangeOf('bytes=-4'), { suffix: 4 });
    assert.equal(rangeOf('lines=1-2'), undefined);
  });

  it('keeps what is uploaded for a message, and the message carries it', async () => {
    const { env, channel } = await opened();
    const shot = await upload(env, ADA, channel, '../../shot.png', 'image/png; charset=x', pngOf(800, 600));
    assert.equal(shot.status, 200);
    assert.match(shot.file.id, FILE_ID);
    // Its name is its last segment, its size is read from its bytes, whatever was said.
    assert.deepEqual([shot.file.name, shot.file.type, shot.file.width, shot.file.height, shot.file.url], ['shot.png', 'image/png', 800, 600, `/api/file/${shot.file.id}/shot.png`]);
    const page = await upload(env, ADA, channel, 'page.html', 'text/html', text('<script>alert(1)</script>'));
    assert.equal((await upload(env, ADA, channel, 'empty.txt', 'text/plain', new Uint8Array(0))).status, 400);
    // An upload is a write of the portal's own page: it says where it is from.
    assert.equal((await raw(env, ADA, 'POST', `/api/upload?channel=${channel}&name=x.txt`, { bytes: text('x'), type: 'text/plain', origin: null })).status, 400);
    assert.equal((await raw(env, ADA, 'POST', `/api/upload?channel=${channel}&name=x.txt`, { bytes: text('x'), type: 'text/plain', origin: 'https://evil.example' })).status, 400);
    assert.equal((await upload(env, EVE, channel, 'x.txt', 'text/plain', text('x'))).status, 404);

    // Only its uploader attaches it, once; a message with files needs no text.
    assert.equal((await call(env, BO, 'POST', '/api/post', { channel, files: [shot.file.id] })).status, 400);
    const sent = await call(env, ADA, 'POST', '/api/post', { channel, files: [shot.file.id, page.file.id] });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal((await call(env, ADA, 'POST', '/api/post', { channel, text: 'again', files: [shot.file.id] })).status, 400);
    const { thread } = (await call(env, BO, 'GET', `/api/thread?channel=${channel}&thread=${sent.body.id}`)).body;
    assert.deepEqual(thread.messages[0].files.map((f) => f.name), ['shot.png', 'page.html']);
    assert.equal(thread.messages[0].body, '');
    // The inbox hears of them, by their address in the portal.
    await deliver(env);
    const event = env.got.at(-1);
    assert.deepEqual(event.message.files.map((f) => [f.name, f.type, f.url]), [
      ['shot.png', 'image/png', `https://portal.example/api/file/${shot.file.id}/shot.png`],
      ['page.html', 'text/html', `https://portal.example/api/file/${page.file.id}/page.html`],
    ]);

    // Served so that a browser runs none of it: an image is shown, a page is a download.
    const image = await raw(env, BO, 'GET', shot.file.url);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.match(image.headers.get('content-disposition'), /^inline; /);
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.match(image.headers.get('content-security-policy'), /default-src 'none'; sandbox/);
    const html = await raw(env, BO, 'GET', page.file.url);
    assert.equal(html.headers.get('content-type'), 'application/octet-stream');
    assert.match(html.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''page\.html$/);
    const part = await api(new Request(`https://portal.example${shot.file.url}`, { headers: { range: 'bytes=0-7' } }), env, new URL(`https://portal.example${shot.file.url}`), { email: BO });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 0-7/40');
    assert.equal((await part.arrayBuffer()).byteLength, 8);
    // Nobody of another customer reads it, and the inbox only for the channel it is in.
    await call(env, EVE, 'GET', '/api/me');
    assert.equal((await raw(env, EVE, 'GET', shot.file.url)).status, 404);
    assert.equal((await platform.file(env, { domain: 'customer.example', channel, id: shot.file.id })).status, 200);
    assert.equal((await platform.file(env, { domain: 'customer.example', channel: 'c000000000000', id: shot.file.id })).status, 404);
    assert.equal((await platform.file(env, { domain: 'other.example', channel, id: shot.file.id })).status, 404);

    // Deleted with its message.
    await call(env, ADA, 'POST', '/api/delete', { channel, id: sent.body.id });
    assert.equal((await raw(env, BO, 'GET', shot.file.url)).status, 404);
    assert.equal(env.FILES.objects.size, 0);
  });

  it('deletes what no message took within a day', async () => {
    const { env, channel } = await opened();
    const kept = await upload(env, ADA, channel, 'kept.txt', 'text/plain', text('kept'));
    await upload(env, ADA, channel, 'left.txt', 'text/plain', text('left'));
    await call(env, ADA, 'POST', '/api/post', { channel, text: 'With one.', files: [kept.file.id] });
    assert.deepEqual(await pruneFiles(env), { deleted: 0 });
    assert.deepEqual(await pruneFiles(env, Date.now() + 25 * 60 * 60 * 1000), { deleted: 1 });
    assert.deepEqual(env.DB.rows('SELECT name FROM files'), [{ name: 'kept.txt' }]);
    assert.equal(env.FILES.objects.size, 1);
  });

  it('keeps a person\'s picture and a customer\'s logo, for those who may see them', async () => {
    const { env } = await opened();
    // A picture is a small raster image.
    assert.equal((await raw(env, ADA, 'PUT', '/api/avatar', { bytes: text('<svg/>'), type: 'image/svg+xml' })).status, 415);
    assert.equal((await raw(env, ADA, 'PUT', '/api/avatar', { bytes: new Uint8Array(600 * 1024), type: 'image/png' })).status, 413);
    const put = await (await raw(env, ADA, 'PUT', '/api/avatar', { bytes: pngOf(256, 256), type: 'image/png' })).json();
    assert.equal(put.picture, true);
    const { me } = (await call(env, ADA, 'GET', '/api/me')).body;
    assert.deepEqual([me.avatar, me.picture], [put.avatar, true]);
    // Her colleagues see it; another customer's people do not.
    assert.equal((await raw(env, BO, 'GET', put.avatar)).headers.get('content-type'), 'image/png');
    await call(env, EVE, 'GET', '/api/me');
    assert.equal((await raw(env, EVE, 'GET', put.avatar)).status, 404);
    // A new one replaces it, and its address changes.
    const next = await (await raw(env, ADA, 'PUT', '/api/avatar', { bytes: pngOf(64, 64), type: 'image/png' })).json();
    assert.notEqual(next.avatar, put.avatar);
    assert.equal([...env.FILES.objects.keys()].filter((k) => k.startsWith('avatars/')).length, 1);
    assert.equal((await call(env, ADA, 'DELETE', '/api/avatar', {})).body.picture, false);
    assert.equal(env.FILES.objects.size, 0);

    // The logo is the lobby's: any member sets it, and the inbox hears of it.
    const logo = await (await raw(env, BO, 'PUT', '/api/logo', { bytes: pngOf(128, 64), type: 'image/png' })).json();
    assert.match(logo.lobby.logo, /^\/api\/logo\?v=\w+$/);
    assert.equal((await raw(env, ADA, 'GET', '/api/logo')).headers.get('content-type'), 'image/png');
    assert.equal((await raw(env, EVE, 'GET', '/api/logo')).status, 404);
    await deliver(env);
    assert.equal(env.got.at(-1).lobby.logo, logo.lobby.logo.split('?v=')[1]);
    assert.equal((await platform.logo(env, { domain: 'customer.example' })).status, 200);
    assert.equal((await call(env, ADA, 'DELETE', '/api/logo', {})).body.lobby.logo, null);
  });

  it('finds whom a message mentions by their name', () => {
    const people = [{ id: 'u1', name: 'Ada Lovelace' }, { id: 'u2', name: 'Bo' }, { id: 'u3', name: 'Bob' }];
    assert.deepEqual(mentionsIn('Thanks @ada lovelace, and @Bo!', people), ['u1', 'u2']);
    assert.deepEqual(mentionsIn('@Bob only', people), ['u3']);
    assert.deepEqual(mentionsIn('mail bo@Bo.example or a@@Bo', people), []);
    assert.deepEqual(mentionsIn('No one here', people), []);
  });
});

describe('the customer portal: its page', () => {
  it('is served with its scripts, the markdown renderer and the emoji it suggests', () => {
    const html = portalPage(PAGES['portal.html'], Object.fromEntries(PORTAL_FILES.map((f) => [f, SCRIPTS[f]])));
    assert.doesNotMatch(html, /<script[^>]* src=|<link rel="stylesheet"/);
    assert.ok(html.includes('globalThis.Writing = '));
    assert.ok(html.includes('globalThis.RichText = '));
    assert.ok(html.includes('var Markdown='));
    assert.doesNotMatch(html, /PORTAL_EMOJI \*\/ \{ names: \{\}/);
    assert.match(html, /const EMOJI = \{"names":\{"100":"💯"/);
    assert.throws(() => portalPage('<p>no script</p>', {}), /PORTAL_EMOJI/);
  });

  it('is put together by the Worker from every file it names', () => {
    // The Worker imports `cloudflare:workers`, so Node reads it as text: a file the page
    // names and the Worker does not hand over fails only when the Worker is deployed.
    const worker = readFileSync(new URL('../src/portal/worker.js', import.meta.url), 'utf8');
    for (const name of PORTAL_FILES) {
      assert.match(worker, new RegExp(`from '../../ui/${name.replace('.', '\\.')}' with \\{ type: 'text' \\}`), name);
      assert.match(worker, new RegExp(`'${name.replace('.', '\\.')}': \\w+,`), name);
    }
  });

  it('writes rich text with the inbox\'s shortcuts, and checks its files first', () => {
    const js = SCRIPTS['portal.js'];
    // The inbox's shortcuts (ui/writing.js), on a rich text box (ui/richtext.js): what is
    // sent is the box's HTML, which the portal makes markdown of.
    assert.match(js, /const kind = Writing\.formatKind\(e\);/);
    assert.match(js, /formatBox\(box, kind\);/);
    assert.match(js, /html: RichText\.html\(box\), files: list\.map/);
    assert.doesNotMatch(js, /<textarea[^>]* id="text"|form\.querySelector\('textarea'\)/);
    // Enter sends where there is a keyboard, Shift+Enter is a new line; Ctrl or ⌘ always sends.
    assert.match(js, /const ENTER_SENDS = matchMedia\('\(hover: hover\)'\)\.matches;/);
    assert.match(js, /if \(e\.metaKey \|\| e\.ctrlKey \|\| \(ENTER_SENDS && !e\.shiftKey\)\) box\.closest\('form'\)\.requestSubmit\(\);\n\s+else RichText\.newline\(box\);/);
    // A suggestion that is open takes Enter first.
    assert.ok(js.indexOf("if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); takeSuggestion(s.at); return; }") < js.indexOf('ENTER_SENDS && !e.shiftKey'));
    assert.match(js, /Markdown\.suggestMentions\(/);
    assert.match(js, /Markdown\.matchEmoji\(EMOJI\.names, EMOJI\.aliases/);
    // Nothing is sent while a file is still on its way, or did not arrive.
    assert.match(js, /if \(list\.some\(\(u\) => u\.status === 'error'\)\)/);
    assert.match(js, /if \(list\.some\(\(u\) => u\.status === 'uploading'\)\) return;/);
  });

  it('shows the customer\'s own people on the right, Adobe on the left, and what Adobe does now', () => {
    const js = SCRIPTS['portal.js'];
    const css = SCRIPTS['spectrum-portal.css'];
    assert.match(js, /const side = ours \? 'ours' : 'adobe';/);
    assert.match(js, /<div class="body\$\{ours \? ' bubble' : ''\}">/);
    assert.match(css, /\.msg\.ours \{ flex-direction: row-reverse; \}/);
    assert.match(css, /\.msg \.bubble \{ width: fit-content; \}/);
    // Who listens and the usual wait over the text box; who writes, the agent, a draft under
    // the messages, the first of them that is so.
    assert.match(js, /people at Adobe are`\} listening/);
    assert.match(js, /Usually answered in \$\{about\(e\.minutes\)\}/);
    assert.match(js, /if \(names\.length\) text = .* writing`;\n\s+else if \(s\.working\) text = 'Adobe\\'s agent is working on an answer';\n\s+else if \(s\.draft\) text = /);
    // The thread is loaded again when its stamp changes, not on every look.
    assert.match(js, /if \(before && res\.body\.stamp !== before && !state\.editing\) await refresh\(\);/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.dots i \{ animation: none; \} \}/);
  });
});

describe('the customer portal: rich text', () => {
  it('becomes the markdown that shows what the box showed', () => {
    assert.equal(richMarkdown('<p>Hello <strong>bold</strong>, <em>it</em>, <s>gone</s> and <code>x_y</code></p>'), 'Hello **bold**, *it*, ~~gone~~ and `x_y`');
    assert.equal(richMarkdown('Intro<ul><li>one</li><li>two<ol><li>deep</li></ol></li></ul>'), 'Intro\n\n- one\n- two\n  1. deep');
    assert.equal(richMarkdown('<blockquote>quoted<br>more</blockquote><p>after</p>'), '> quoted\n> more\n\nafter');
    assert.equal(richMarkdown('<pre>const a = 1;<br>  b();</pre>'), '```\nconst a = 1;\n  b();\n```');
    assert.equal(richMarkdown('<p>see <a href="https://a.example/x">this</a></p>'), 'see [this](https://a.example/x)');
    // A mention is its name, which the portal finds among the channel's people.
    assert.equal(richMarkdown('<p><span class="mention" contenteditable="false">@Sam Staff</span>&nbsp;hi</p>'), '@Sam Staff hi');
    // What the browser writes for spaces and an empty element's caret was not typed.
    assert.equal(richMarkdown('<p>a&nbsp;b\u200b&nbsp;</p><p><br></p>'), 'a b');
    assert.equal(richMarkdown('<p><br></p>'), '');
    assert.equal(richMarkdown(undefined), '');
  });

  it('keeps what was typed as typed: markdown\'s marks are text', () => {
    assert.equal(richMarkdown('<p>2 * 3 * 4 and _not_ italic</p>'), '2 \\* 3 \\* 4 and \\_not\\_ italic');
    assert.equal(richMarkdown('<p># no heading</p>'), '\\# no heading');
    assert.equal(richMarkdown('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'), '\\<script>alert(1)\\</script>');
  });

  it('keeps nothing that loads or runs', () => {
    const md = richMarkdown(`<p onclick="x()">a <img src="https://tracker.example/p.png" onerror="x()"> b</p>
      <script>alert(1)</script><style>p { color: red }</style><iframe src="https://evil.example"></iframe>
      <p><a href="javascript:alert(1)">click</a> <a href="data:text/html,x">data</a> <a href="mailto:a@b.example">mail</a></p>`);
    assert.doesNotMatch(md, /tracker|script|alert|color|evil|javascript|data:|onclick|onerror|!\[/);
    assert.match(md, /click data \[mail\]\(mailto:a@b\.example\)/);
    // Too long to read is refused, not cut.
    assert.equal(richMarkdown('x'.repeat(MAX_HTML + 1)), null);
  });

  it('is what a message is written and changed in', async () => {
    const { env, channel } = await opened();
    const post = await call(env, ADA, 'POST', '/api/post', {
      channel, html: '<p>The <strong>cache</strong> is stale</p><ul><li>since <em>Monday</em></li></ul><img src="https://tracker.example/p.png">',
    });
    assert.equal(post.status, 200, JSON.stringify(post.body));
    const read = async () => (await call(env, ADA, 'GET', `/api/thread?channel=${channel}&thread=${post.body.root}`)).body.thread;
    let thread = await read();
    assert.equal(thread.messages[0].body, 'The **cache** is stale\n\n- since *Monday*');
    // The first line is the thread's title, without its formatting.
    assert.equal(thread.title, 'The cache is stale');
    const edit = await call(env, ADA, 'POST', '/api/edit', { channel, id: post.body.id, html: '<p>The cache is <code>stale</code></p>' });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    thread = await read();
    assert.equal(thread.messages[0].body, 'The cache is `stale`');
    // Nothing typed is nothing to send, and markdown as text still is (the inbox's side).
    assert.equal((await call(env, ADA, 'POST', '/api/post', { channel, html: '<p><br></p>' })).status, 400);
    assert.equal((await call(env, ADA, 'POST', '/api/post', { channel, html: 'x'.repeat(MAX_HTML + 1) })).status, 400);
    const plain = await call(env, ADA, 'POST', '/api/post', { channel, thread: post.body.root, text: 'Plain **markdown**' });
    assert.equal((await read()).messages.find((m) => m.id === plain.body.id).body, 'Plain **markdown**');
  });
});
