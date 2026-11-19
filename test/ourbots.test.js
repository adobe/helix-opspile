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
import { api, botAuthor } from '../src/api.js';
import { render } from '../src/channels.js';
import { toAuthor } from '../src/lookup.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, bots, ids and messages only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'admin' }, { slug: 'helix' }],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', teams: [{ slug: 'helix' }],
};
const THREAD = 'teams:T:19:c:5';
const AT = '2026-10-21T10:00:00Z';
const HELPER = 'teams:T:bot-helper';
const OTHER = 'teams:T:bot-other';
const ENV = { STAFF_DOMAINS: 'staff.example' };

function env() {
  const DB = d1({
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix' }],
    people: [
      {
        id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin', 'helix'],
      },
      {
        id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
      },
    ],
  });
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      channel_name, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, 'teams', 'T', '19:c', '5', 'acme', 'helix', 'acme support', 'q/5/', ?, ?, ?, 3, ?)`)
    .run(THREAD, AT, AT, AT, AT);
  const account = (id, kind, name, handle = null) => DB.sqlite.prepare(`INSERT INTO identities
      (source, tenant, user_id, kind, name, handle, email, fetched_at)
    VALUES ('teams', 'T', ?, ?, ?, ?, ?, ?)`)
    .run(id, kind, name, handle, kind === 'person' ? `${id}@customer.example` : null, AT);
  account('u-cy', 'person', 'Cy');
  account('bot-helper', 'bot', 'helper-agent', 'helper');
  account('bot-other', 'bot', 'Their Deploy Bot');
  // Mentioned only: it never posted.
  account('bot-quiet', 'bot', null, 'quiet');
  const message = (id, at, author, authorKey) => DB.sqlite.prepare(`INSERT INTO messages (source,
      tenant, channel_id, id, thread, at, staff, counted, author_key, author_kind)
    VALUES ('teams', 'T', '19:c', ?, ?, ?, 0, ?, ?, ?)`)
    .run(id, THREAD, at, Number(author === 'person'), authorKey, author);
  message('5', '2026-10-21T10:00:00Z', 'person', 'teams:T:u-cy');
  message('6', '2026-10-21T10:01:00Z', 'bot', HELPER);
  message('7', '2026-10-21T10:02:00Z', 'bot', OTHER);
  const CHANNELS = fakeBucket();
  const file = (id, at, author) => CHANNELS.put(`q/5/${id}.md`, render({
    source: 'teams', thread: THREAD, id, at, author,
  }, `message ${id}`));
  file('5', '2026-10-21T10:00:00Z', {
    kind: 'person', name: 'Cy', org: 'customer.example', staff: false,
  });
  // Written before anyone said the bot is Adobe's.
  file('6', '2026-10-21T10:01:00Z', {
    kind: 'bot', name: 'helper-agent', org: null, staff: false,
  });
  file('7', '2026-10-21T10:02:00Z', {
    kind: 'bot', name: 'Their Deploy Bot', org: null, staff: false,
  });
  return {
    DB, CHANNELS, ...ENV, MS_TENANT_ID: 'T',
  };
}

const call = async (e, who, method, path, body) => {
  const res = await api(
    new Request(`https://opspile.test${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
    e,
    new URL(`https://opspile.test${path}`),
    { viewer: who },
  );
  return { status: res.status, body: await res.json() };
};
const sides = async (e) => Object.fromEntries((await call(e, ADA, 'GET', `/api/thread?thread=${THREAD}`))
  .body.messages.map((m) => [m.id, m.author.staff]));

describe('Adobe\'s bots', () => {
  it('count as staff, with no mail address to say so', () => {
    assert.equal(toAuthor(ENV, { kind: 'bot', name: 'b' }).staff, false);
    assert.equal(toAuthor(ENV, { kind: 'bot', name: 'b', ours: 1 }).staff, true);
    assert.equal(toAuthor(ENV, { kind: 'bot', name: 'b', ours: 0 }).staff, false);
    // A Discord bot with a staff role stays staff, whatever an admin said.
    assert.equal(toAuthor(ENV, {
      kind: 'bot', name: 'b', staff: 1, ours: 0,
    }).staff, true);
  });

  it('move the messages a bot wrote before to the side an admin said, and leave the rest', () => {
    const bot = { kind: 'bot', name: 'b', staff: false };
    const account = (ours, extra = {}) => ({ account_kind: 'bot', ours, ...extra });
    assert.deepEqual(botAuthor(ENV, bot, account(1)), { ...bot, staff: true });
    assert.deepEqual(botAuthor(ENV, { ...bot, staff: true }, account(0)), bot);
    // Nobody decided: as its frontmatter says.
    assert.equal(botAuthor(ENV, bot, account(null)), bot);
    assert.equal(botAuthor(ENV, { ...bot, staff: true }, account(null)).staff, true);
    // A person's message, or a bot's without an account, is not a bot's to move.
    const person = { kind: 'person', name: 'p', staff: false };
    assert.equal(botAuthor(ENV, person, { account_kind: 'person', ours: 1 }), person);
    assert.equal(botAuthor(ENV, bot, {}), bot);
  });

  it('are listed for the admin team, those that posted last first', async () => {
    const e = env();
    assert.equal((await call(e, BO, 'GET', '/api/admin/bots')).status, 403);
    const { status, body } = await call(e, ADA, 'GET', '/api/admin/bots');
    assert.equal(status, 200);
    const rows = body.bots.map((b) => [b.name, b.source, b.messages, b.threads, b.ours, b.staff]);
    assert.deepEqual(rows, [
      ['Their Deploy Bot', 'teams', 1, 1, null, false],
      ['helper-agent', 'teams', 1, 1, null, false],
      [null, 'teams', 0, 0, null, false],
    ]);
    const helper = body.bots.find((b) => b.key === HELPER);
    assert.deepEqual([helper.id, helper.handle, helper.channel, helper.org, helper.latest], [
      'bot-helper', 'helper', 'acme support', 'acme', '2026-10-21T10:01:00Z',
    ]);
    // People are not bots.
    assert.ok(!body.bots.some((b) => b.key === 'teams:T:u-cy'));
  });

  it('are said to be Adobe\'s by the admin team, which moves their messages to Adobe\'s side', async () => {
    const e = env();
    assert.deepEqual(await sides(e), { 5: false, 6: false, 7: false });
    assert.equal((await call(e, BO, 'PUT', '/api/admin/bots', { key: HELPER, ours: true })).status, 403);
    assert.equal((await call(e, ADA, 'PUT', '/api/admin/bots', { key: HELPER })).status, 400);
    assert.equal((await call(e, ADA, 'PUT', '/api/admin/bots', { key: 'nope', ours: true })).status, 400);
    // A person is not a bot to flag.
    assert.equal((await call(e, ADA, 'PUT', '/api/admin/bots', { key: 'teams:T:u-cy', ours: true })).status, 404);
    const r = await quiet(() => call(e, ADA, 'PUT', '/api/admin/bots', { key: HELPER, ours: true }));
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.bot.ours, r.body.bot.staff, r.body.bot.oursBy], [true, true, 'ada@staff.example']);
    assert.deepEqual(await sides(e), { 5: false, 6: true, 7: false });
    assert.deepEqual(e.DB.rows('SELECT id, staff, counted FROM messages ORDER BY id'), [
      { id: '5', staff: 0, counted: 1 },
      { id: '6', staff: 1, counted: 0 },
      { id: '7', staff: 0, counted: 0 },
    ]);
    // Taken back: on the customer's side again, the messages it wrote meanwhile too.
    await e.CHANNELS.put('q/5/6.md', render({
      source: 'teams',
      thread: THREAD,
      id: '6',
      at: '2026-10-21T10:01:00Z',
      author: {
        kind: 'bot', name: 'helper-agent', org: null, staff: true,
      },
    }, 'message 6'));
    const back = await quiet(() => call(e, ADA, 'PUT', '/api/admin/bots', { key: HELPER, ours: false }));
    assert.deepEqual([back.body.bot.ours, back.body.bot.staff], [false, false]);
    assert.deepEqual(await sides(e), { 5: false, 6: false, 7: false });
    assert.deepEqual(e.DB.rows("SELECT staff FROM messages WHERE id = '6'"), [{ staff: 0 }]);
    // Kept, with who said it.
    assert.deepEqual(e.DB.rows("SELECT ours, ours_by FROM identities WHERE user_id = 'bot-helper'"), [
      { ours: 0, ours_by: 'ada@staff.example' },
    ]);
  });
});
