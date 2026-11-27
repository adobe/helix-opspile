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
import { hasInitials, initialsOf, linkCandidates } from '../src/accountlinks.js';
import { api } from '../src/api.js';
import { getIdentity, toAuthor } from '../src/lookup.js';
import { personOf } from '../src/agent/memberrequest.js';
import { opspileExtension } from '../src/agent/tools.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, accounts, guilds, ids and messages only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada Admin', staff: 1, teams: ['admin'],
};
const ANN = {
  id: 2, email: 'ann@staff.example', name: 'Ann Bee', staff: 1, teams: ['helix'],
};
const ABE = {
  id: 3, email: 'abe@staff.example', name: 'Abe Brook', staff: 1, teams: ['helix'],
};
// Outside Adobe, with the same initials.
const AMY = { id: 4, email: 'amy@customer.example', name: 'Amy Bell' };
const GUILD = 'G1';
const OTHER = 'G2';
const AB = `discord:${GUILD}:u-ab`;
const CUSTOMER = `discord:${GUILD}:u-cu`;
const QUIET = `discord:${GUILD}:u-quiet`;
const THREAD = `discord:${GUILD}:c1:100`;
const AT = '2026-10-21T10:00:00Z';
const REQUEST = `request:account:${AB}`;

function env() {
  const DB = d1({
    people: [ADA, ANN, ABE, AMY].map((p) => ({
      id: p.id, email: p.email, name: p.name, staff: p.staff || 0, teams: p.teams || [],
    })),
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }],
  });
  const db = DB.sqlite;
  db.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind,
      channel_name, path, root_at, last_at, any_at, messages, updated_at, last_author, last_staff)
    VALUES (?, 'discord', ?, 'c1', '100', 'acme', 'helix', 'channel', 'help', 'd/100/', ?, ?, ?, 2,
      ?, 'AB', 1)`).run(THREAD, GUILD, AT, AT, AT, AT);
  const account = (tenant, id, name, { staff = 1, aliases = null } = {}) => db.prepare(`INSERT
      INTO identities (source, tenant, user_id, kind, name, fetched_at, avatar, staff, aliases)
    VALUES ('discord', ?, ?, 'person', ?, ?, '', ?, ?)`)
    .run(tenant, id, name, AT, staff, aliases && JSON.stringify(aliases));
  // Staff by its role, in both guilds; nobody connected it.
  account(GUILD, 'u-ab', 'AB', { aliases: ['ab_99'] });
  account(OTHER, 'u-ab', 'AB', { aliases: ['ab_99'] });
  // A customer's account; and a staff one that never wrote.
  account(GUILD, 'u-cu', 'AB', { staff: null });
  account(GUILD, 'u-quiet', 'QZ');
  const message = (id, key, author, staff) => db.prepare(`INSERT INTO messages (source, tenant,
      channel_id, id, thread, at, author, staff, counted, author_key, author_kind)
    VALUES ('discord', ?, 'c1', ?, ?, ?, ?, ?, 1, ?, 'person')`)
    .run(GUILD, id, THREAD, AT, author, staff, key);
  message('101', AB, 'AB', 1);
  message('102', CUSTOMER, 'AB', 0);
  return {
    DB, CHANNELS: fakeBucket(), STAFF_DOMAINS: 'staff.example', DISCORD_STAFF_ROLES: 'r-staff',
  };
}

const viewer = (p) => ({
  id: p.id, email: p.email, name: p.name, teams: (p.teams || []).map((slug) => ({ slug, role: 'member' })),
});
const call = async (e, who, method, path, body) => {
  const url = new URL(`https://opspile.test${path}`);
  const res = await api(
    new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
    e,
    url,
    { viewer: viewer(who) },
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const thread = async (e, key = REQUEST) => (await call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`)).body;
const resolve = (e, action, values) => quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key: REQUEST, action, values }));

/** The thread agent's tools of THREAD, answering sidebar message `sidebar` (null: on its own). */
function agentTools(e, sidebar = null) {
  const target = {
    key: THREAD, team: 'helix', org: 'acme', kind: 'channel', source: 'discord', tenant: GUILD, channelId: 'c1', channelName: 'help', threads: [THREAD],
  };
  const tools = Object.fromEntries(opspileExtension({
    env: e,
    hasThread: true,
    target: async () => target,
    verdicts: async () => new Map(),
    sidebarMessage: async () => sidebar,
  }).tools.map((t) => [t.name, t]));
  return async (name, args = {}) => {
    const res = await quiet(() => tools[name].execute(args, {}));
    return { text: res.output.map((o) => o.text).join(''), error: Boolean(res.isError) };
  };
}

describe('initials', () => {
  it('are two to four letters, not a word', () => {
    assert.equal(initialsOf('AB'), 'ab');
    assert.equal(initialsOf('a.b.'), 'ab');
    assert.equal(initialsOf('abc'), 'abc');
    assert.equal(initialsOf('Ann'), null);
    assert.equal(initialsOf('A'), null);
    assert.equal(initialsOf('ab_99'), null);
    assert.equal(initialsOf('Ann Bee'), null);
  });

  it('are every word\'s first letter, or the first and the last name\'s', () => {
    assert.equal(hasInitials('Ann Bee', 'ab'), true);
    assert.equal(hasInitials('Bee, Ann', 'ab'), true);
    assert.equal(hasInitials('Ann Cleo Bee', 'ab'), true);
    assert.equal(hasInitials('Ann Cleo Bee', 'acb'), true);
    assert.equal(hasInitials('Ann', 'a'), false);
    assert.equal(hasInitials('Ann Bee', 'ba'), false);
  });
});

describe('a Discord account with a staff role that nobody connected', () => {
  it('waits for the admin team once it wrote something, counted on Inbox', async () => {
    const e = env();
    const { body } = await call(e, ADA, 'GET', '/api/admin/accounts');
    // Where it wrote: not its row of the other guild, the customer's account, nor the staff one
    // that never wrote.
    assert.deepEqual(body.accounts.map((a) => [a.key, a.name, a.person]), [[AB, 'AB', null]]);
    assert.equal((await call(e, ADA, 'GET', '/api/admin/requests?count=1')).body.open, 1);
    const t = await thread(e);
    assert.equal(t.thread.title, 'AB, Discord staff account');
    assert.equal(t.thread.channel_name, 'Staff accounts');
    assert.match(t.messages[0].body, /Discord account with a staff role/);
    assert.match(t.messages[0].body, /Also goes by `ab_99`/);
  });

  it('is offered the staff people it may be, never a customer, and none links by itself', async () => {
    const e = env();
    // Ann's Contact in Helix ops' knowledge base names the account among its aliases.
    e.DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, created_at)
        VALUES ('kb-team-helix', 'team', 'helix', '${AT}');
      INSERT INTO kb_concepts (repo, path, hash, type, title, aliases)
        VALUES ('kb-team-helix', 'contacts/ann-bee.md', 'h1', 'Contact', 'Ann Bee', 'Annie, ab_99')`);
    const candidates = await linkCandidates(e, {
      key: AB, name: 'AB', aliases: ['ab_99'], person: null,
    });
    assert.deepEqual(candidates.map((c) => [c.person.id, c.why.map((w) => w.kind)]), [
      [ANN.id, ['contact', 'initials']],
      [ABE.id, ['initials']],
    ]);
    const t = await thread(e);
    assert.match(t.messages[0].body, /It may be \(a suggestion links nobody\)/);
    assert.match(t.messages[0].body, /\*\*Ann Bee\*\*, `ann@staff\.example`: their Contact in Helix ops goes by `ab_99`; AB are the initials/);
    assert.doesNotMatch(t.messages[0].body, /Amy/);
    assert.deepEqual(t.request.actions.map((a) => [a.id, a.label]), [
      [`link:${ANN.id}`, 'Ann Bee\'s'], [`link:${ABE.id}`, 'Abe Brook\'s'], ['link', 'Someone else\'s'],
    ]);
    // Each asks first: a hint, so the inbox opens it before it decides.
    assert.ok(t.request.actions.every((a) => a.hint));
    assert.deepEqual(e.DB.rows("SELECT person FROM identities WHERE user_id = 'u-ab'"), [{ person: null }, { person: null }]);
  });

  it('is linked by the admin team, in every guild, and shows as its person', async () => {
    const e = env();
    const r = await resolve(e, `link:${ANN.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.done, 'AB is Ann Bee\'s.');
    assert.deepEqual(e.DB.rows(`SELECT tenant, person, linked_by FROM identities WHERE user_id = 'u-ab'
      ORDER BY tenant`), [
      { tenant: GUILD, person: ANN.id, linked_by: ADA.email },
      { tenant: OTHER, person: ANN.id, linked_by: ADA.email },
    ]);
    assert.deepEqual(e.DB.rows('SELECT id, person, author, staff FROM messages ORDER BY id'), [
      {
        id: '101', person: ANN.id, author: 'Ann Bee', staff: 1,
      },
      // The customer's account of the same name is left alone.
      {
        id: '102', person: null, author: 'AB', staff: 0,
      },
    ]);
    assert.equal((await call(e, ADA, 'GET', '/api/admin/requests?count=1')).body.open, 0);
    // One thread still: the other guild's row, linked with it, wrote nothing.
    assert.deepEqual((await call(e, ADA, 'GET', '/api/admin/accounts')).body.accounts
      .map((a) => [a.key, a.person && a.person.id]), [[AB, ANN.id]]);
    const t = await thread(e);
    assert.equal(t.request.status, 'linked');
    assert.deepEqual(t.request.actions.map((a) => a.id), ['link', 'unlink']);
    // Nobody's again: the account's own name, still Adobe's by its role.
    assert.equal((await resolve(e, 'unlink')).status, 200);
    assert.deepEqual(e.DB.rows("SELECT person, linked_at FROM identities WHERE user_id = 'u-ab'"), [
      { person: null, linked_at: null }, { person: null, linked_at: null },
    ]);
    assert.deepEqual(e.DB.rows("SELECT person, author, staff FROM messages WHERE id = '101'"), [
      { person: null, author: 'AB', staff: 1 },
    ]);
  });

  it('is linked only if it is Adobe\'s by itself, and only to an Adobe person', async () => {
    const e = env();
    const put = (key, email) => quiet(() => call(e, ADA, 'PUT', '/api/admin/accounts', { key, email }));
    assert.equal((await put(CUSTOMER, ANN.email)).status, 409);
    assert.equal((await put(AB, AMY.email)).status, 409);
    assert.equal((await put(AB, 'zed@elsewhere.example')).status, 409);
    // Connected by its person: theirs, not the admin team's to say.
    e.DB.sqlite.exec("UPDATE identities SET person = 3 WHERE user_id = 'u-quiet'");
    assert.equal((await put(QUIET, ANN.email)).status, 409);
    assert.equal((await call(e, ANN, 'PUT', '/api/admin/accounts', { key: AB, email: ANN.email })).status, 403);
  });

  it('stays linked when it is looked up again, and when its person disconnects Discord', async () => {
    const e = env();
    await resolve(e, `link:${ANN.id}`);
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes(`/guilds/${GUILD}/members/u-ab`)) {
        return Response.json({ nick: 'AB', roles: ['r-staff'], user: { id: 'u-ab', username: 'ab_99' } });
      }
      throw new Error(`unexpected ${url}`);
    };
    try {
      e.DB.sqlite.exec("UPDATE identities SET fetched_at = '2026-01-01T00:00:00Z'");
      const again = await getIdentity(e, { source: 'discord', tenant: GUILD, userId: 'u-ab' });
      assert.deepEqual([again.person, again.person_name], [ANN.id, 'Ann Bee']);
      assert.equal(toAuthor(e, again).name, 'Ann Bee');
    } finally {
      globalThis.fetch = real;
    }
    e.DB.sqlite.exec(`INSERT INTO user_tokens (person, platform, user_id, access_token, updated_at)
      VALUES (2, 'discord', 'u-ab', 'x', '${AT}')`);
    assert.equal((await call(e, ANN, 'DELETE', '/api/auth/discord')).status, 200);
    assert.deepEqual(e.DB.rows(`SELECT person FROM identities WHERE user_id = 'u-ab' AND tenant = '${GUILD}'`), [{ person: ANN.id }]);
  });

  it('is who its handle is for ask_teammate once linked, and says why not before', async () => {
    const e = env();
    const before = await personOf(e, { email: '', name: '' }, { name: 'AB' });
    assert.match(before.error, /nobody linked to a colleague yet.*request_account_link/);
    await resolve(e, `link:${ANN.id}`);
    assert.deepEqual(await personOf(e, { email: '', name: '' }, { name: 'ab' }), {
      email: ANN.email, name: 'Ann Bee',
    });
  });
});

describe('agent: request_account_link', () => {
  let e;
  beforeEach(() => {
    e = env();
  });
  afterEach(() => {
    e = null;
  });

  it('proposes a link that the admin team confirms, and links nothing itself', async () => {
    const run = agentTools(e);
    const r = await run('request_account_link', {
      account: 'AB', email: 'Abe@staff.example', note: 'Signed a message as Abe',
    });
    assert.equal(r.error, false, r.text);
    assert.match(r.text, /^proposed: AB is Abe Brook's\. The admin team confirms or declines it in its inbox; nothing is linked yet\.$/);
    assert.deepEqual(e.DB.rows("SELECT person FROM identities WHERE user_id = 'u-ab' ORDER BY tenant"), [{ person: null }, { person: null }]);
    const t = await thread(e);
    const note = t.messages.find((m) => /Proposes/.test(m.body));
    assert.equal(note.author.name, 'The agent of a thread in #help');
    assert.match(note.body, /Proposes that it is \*\*Abe Brook\*\*'s \(abe@staff\.example\): Signed a message as Abe/);
    // The proposal first, then the suggestions it is not.
    assert.deepEqual(t.request.actions.map((a) => a.id), [
      `link:${ABE.id}`, `link:${ANN.id}`, 'link', `decline:${ABE.id}`,
    ]);
    assert.match(t.request.actions[0].hint, /^Proposed by The agent of a thread in #help: Signed a message as Abe/);
    // Once per account and colleague.
    assert.match((await run('request_account_link', { account: 'AB', email: ABE.email, note: 'again' })).text, /proposed as Abe Brook's already/);
    assert.equal((await resolve(e, `link:${ABE.id}`)).status, 200);
    assert.deepEqual(e.DB.rows('SELECT COUNT(*) AS n FROM account_proposals'), [{ n: 0 }]);
  });

  it('is declined by the admin team, and not proposed nor suggested again', async () => {
    const run = agentTools(e);
    await run('request_account_link', { account: 'AB', email: ANN.email, note: 'Looks like Ann' });
    const d = await resolve(e, `decline:${ANN.id}`);
    assert.equal(d.status, 200);
    assert.equal(d.body.done, 'AB is not Ann Bee\'s.');
    assert.match((await run('request_account_link', { account: 'AB', email: ANN.email, note: 'x' })).text, /the admin team said AB is not Ann Bee's/);
    const t = await thread(e);
    assert.deepEqual(t.request.actions.map((a) => a.id), [`link:${ABE.id}`, 'link']);
  });

  it('is refused for a customer, a customer\'s account, and without a reason', async () => {
    const run = agentTools(e);
    assert.match((await run('request_account_link', { account: 'AB', email: AMY.email, note: 'x' })).text, /not an Adobe person/);
    assert.match((await run('request_account_link', { account: 'Nobody', email: ANN.email, note: 'x' })).text, /no account called Nobody waits to be linked/);
    assert.match((await run('request_account_link', { account: 'AB', email: ANN.email, note: ' ' })).text, /say why/);
    // Only the staff account of that name, not the customer's that posted in the thread too.
    await run('request_account_link', { account: 'AB', email: ANN.email, note: 'x' });
    assert.deepEqual(e.DB.rows('SELECT account FROM account_proposals'), [{ account: AB }]);
  });

  it('is filed for the person in the sidebar who said so', async () => {
    e.DB.sqlite.exec(`INSERT INTO sidebar_messages (id, thread, role, person, body, at)
      VALUES ('sb_1', '${THREAD}', 'person', 3, 'AB is Ann', '${AT}')`);
    const r = await agentTools(e, 'sb_1')('request_account_link', { account: 'AB', email: ANN.email, note: 'Abe says so' });
    assert.match(r.text, /^proposed for Abe Brook: AB is Ann Bee's\..*Tell Abe Brook so\.$/);
    assert.deepEqual(e.DB.rows('SELECT by_email, by_name FROM account_proposals'), [{ by_email: ABE.email, by_name: 'Abe Brook' }]);
  });
});
