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
import {
  afterEach, beforeEach, describe, it,
} from 'node:test';
import { better } from '../src/accounts.js';
import { accountAuthor, api } from '../src/api.js';
import { render } from '../src/channels.js';
import {
  getIdentity, graphName, isHostAdmin, toAuthor,
} from '../src/lookup.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, accounts, ids, domains and messages only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'admin' }, { slug: 'helix' }],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo Ops', teams: [{ slug: 'helix' }],
};
const THREAD = 'teams:T:19:c:5';
const AT = '2026-10-21T10:00:00Z';
const HOST = 'host-tenant.example';
const OWNER = 'teams:T:u-owner';
const CY = 'teams:T:u-cy';
const ENV = { STAFF_DOMAINS: 'staff.example' };

function env() {
  const DB = d1({
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix' }],
    people: [
      {
        id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin', 'helix'],
      },
      {
        id: 2, email: 'bo@staff.example', name: 'Bo Ops', staff: 1, teams: ['helix'],
      },
      // Outside Adobe.
      { id: 3, email: 'cy@customer.example', name: 'Cy' },
    ],
  });
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      channel_name, path, root_at, last_at, any_at, messages, updated_at, last_author, last_staff)
    VALUES (?, 'teams', 'T', '19:c', '5', 'acme', 'helix', 'Main', 'q/5/', ?, ?, ?, 2, ?, 'BO', 1)`)
    .run(THREAD, AT, AT, AT, AT);
  const account = (id, name, email, { staff = null, guest = 1 } = {}) => DB.sqlite.prepare(`INSERT
      INTO identities (source, tenant, user_id, kind, name, email, fetched_at, avatar, staff, guest)
    VALUES ('teams', 'T', ?, 'person', ?, ?, ?, '', ?, ?)`)
    .run(id, name, email, AT, staff, guest);
  // The host tenant's admin account, already seen as staff (the lookup, or migration 0097).
  account('u-owner', 'BO', `owner_bo@${HOST}`, { staff: 1, guest: 0 });
  account('u-cy', 'Cy', 'cy@customer.example');
  const message = (id, at, key, name, staff) => DB.sqlite.prepare(`INSERT INTO messages (source,
      tenant, channel_id, id, thread, at, author, staff, counted, author_key, author_kind)
    VALUES ('teams', 'T', '19:c', ?, ?, ?, ?, ?, 1, ?, 'person')`)
    .run(id, THREAD, at, name, staff, key);
  message('5', '2026-10-21T10:00:00Z', CY, 'Cy', 0);
  message('6', '2026-10-21T10:01:00Z', OWNER, 'BO', 1);
  const CHANNELS = fakeBucket();
  const file = (id, at, author) => CHANNELS.put(`q/5/${id}.md`, render({
    source: 'teams', thread: THREAD, id, at, author,
  }, `message ${id}`));
  file('5', '2026-10-21T10:00:00Z', {
    kind: 'person', name: 'Cy', org: 'customer.example', staff: false,
  });
  // Written before the account was known to be Adobe's.
  file('6', '2026-10-21T10:01:00Z', {
    kind: 'person', name: 'BO', org: HOST, staff: false,
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
const authors = async (e) => Object.fromEntries((await call(e, ADA, 'GET', `/api/thread?thread=${THREAD}`))
  .body.messages.map((m) => [m.id, [m.author.name, m.author.staff]]));

describe('the host tenant\'s admin accounts', () => {
  it('are its members named owner_, never a guest', () => {
    assert.equal(isHostAdmin({ userType: 'Member', userPrincipalName: `owner_ab@${HOST}` }), true);
    assert.equal(isHostAdmin({ userType: 'Member', userPrincipalName: `OWNER_AB@${HOST}` }), true);
    assert.equal(isHostAdmin({ userType: 'Member', mailNickname: 'owner_ab', userPrincipalName: `ab@${HOST}` }), true);
    // A guest whose own address begins so is a customer's account.
    assert.equal(isHostAdmin({
      userType: 'Guest', mailNickname: 'owner_ab', userPrincipalName: 'owner_ab_customer.example#EXT#@x',
    }), false);
    assert.equal(isHostAdmin({ userType: 'Member', userPrincipalName: `someone@${HOST}` }), false);
    assert.equal(isHostAdmin({ userPrincipalName: `owner_ab@${HOST}` }), false);
    assert.equal(isHostAdmin(null), false);
  });

  it('go by their given name and surname where their display name is only initials', () => {
    assert.equal(graphName({ displayName: 'AB', givenName: 'Ann', surname: 'Bee' }), 'Ann Bee');
    assert.equal(graphName({ displayName: 'AB' }, 'x'), 'AB');
    assert.equal(graphName({ displayName: 'Ann Bee', givenName: 'A', surname: 'B' }), 'Ann Bee');
    assert.equal(graphName({ displayName: 'Abe', givenName: 'Abe', surname: 'Lin' }), 'Abe');
    assert.equal(graphName({}, 'From the message'), 'From the message');
  });

  describe('looked up in Graph', () => {
    const real = globalThis.fetch;
    let users;
    beforeEach(() => {
      users = {};
      globalThis.fetch = async (url) => {
        const u = new URL(url);
        if (u.hostname === 'login.microsoftonline.com') {
          return Response.json({ access_token: `x.${btoa(JSON.stringify({ roles: [] }))}.y`, expires_in: 3600 });
        }
        const id = /^\/v1\.0\/users\/([^/?]+)/.exec(u.pathname);
        if (id && users[decodeURIComponent(id[1])]) {
          return Response.json(users[decodeURIComponent(id[1])]);
        }
        if (id) {
          return Response.json({ error: { code: 'Request_ResourceNotFound' } }, { status: 404 });
        }
        if (u.hostname.includes('gravatar')) {
          return new Response('', { status: 404 });
        }
        throw new Error(`unexpected ${url}`);
      };
    });
    afterEach(() => {
      globalThis.fetch = real;
    });

    it('are staff, and a customer\'s guest account is not', async () => {
      const e = env();
      users['u-new'] = {
        displayName: 'DE', userPrincipalName: `owner_de@${HOST}`, userType: 'Member', companyName: 'Adobe',
      };
      users['u-guest'] = {
        displayName: 'Eve', mail: 'owner_eve@customer.example', userPrincipalName: 'owner_eve_customer.example#EXT#@x', userType: 'Guest',
      };
      const admin = await getIdentity(e, { source: 'teams', tenant: 'T', userId: 'u-new' });
      assert.deepEqual(toAuthor(e, admin), {
        kind: 'person', name: 'DE', org: HOST, staff: true,
      });
      const guest = await getIdentity(e, { source: 'teams', tenant: 'T', userId: 'u-guest' });
      assert.equal(toAuthor(e, guest).staff, false);
      assert.deepEqual(e.DB.rows(`SELECT user_id, staff, guest FROM identities
        WHERE user_id IN ('u-new', 'u-guest') ORDER BY user_id`), [
        { user_id: 'u-guest', staff: null, guest: 1 },
        { user_id: 'u-new', staff: 1, guest: 0 },
      ]);
    });

    it('move the messages they wrote before to Adobe\'s side once they are seen as one', async () => {
      const e = env();
      // Seen before as a customer's: not staff, its message and the thread on the customer's side.
      e.DB.sqlite.prepare("UPDATE identities SET staff = NULL, fetched_at = '2026-01-01T00:00:00Z' WHERE user_id = 'u-owner'").run();
      e.DB.sqlite.prepare("UPDATE messages SET staff = 0 WHERE id = '6'").run();
      e.DB.sqlite.prepare('UPDATE threads SET last_staff = 0').run();
      users['u-owner'] = { displayName: 'BO', userPrincipalName: `owner_bo@${HOST}`, userType: 'Member' };
      await getIdentity(e, { source: 'teams', tenant: 'T', userId: 'u-owner' });
      assert.deepEqual(e.DB.rows('SELECT id, staff FROM messages ORDER BY id'), [
        { id: '5', staff: 0 }, { id: '6', staff: 1 },
      ]);
      assert.deepEqual(e.DB.rows('SELECT last_staff, last_author FROM threads'), [{ last_staff: 1, last_author: 'BO' }]);
    });

    it('keep what was known of them when Graph cannot read them', async () => {
      const e = env();
      e.DB.sqlite.prepare("UPDATE identities SET fetched_at = '2026-01-01T00:00:00Z' WHERE user_id = 'u-owner'").run();
      const again = await getIdentity(e, { source: 'teams', tenant: 'T', userId: 'u-owner' });
      assert.deepEqual([again.name, again.email, again.staff, again.guest], ['BO', `owner_bo@${HOST}`, 1, false]);
      assert.deepEqual(e.DB.rows('SELECT id, staff FROM messages ORDER BY id'), [
        { id: '5', staff: 0 }, { id: '6', staff: 1 },
      ]);
    });

    it('stay linked to their person when they are looked up again', async () => {
      const e = env();
      await quiet(() => call(e, ADA, 'PUT', '/api/admin/accounts', { key: OWNER, email: 'bo@staff.example' }));
      e.DB.sqlite.prepare("UPDATE identities SET fetched_at = '2026-01-01T00:00:00Z' WHERE user_id = 'u-owner'").run();
      users['u-owner'] = { displayName: 'BO', userPrincipalName: `owner_bo@${HOST}`, userType: 'Member' };
      const again = await getIdentity(e, { source: 'teams', tenant: 'T', userId: 'u-owner' });
      assert.deepEqual([again.person, again.person_name], [2, 'Bo Ops']);
      assert.equal(toAuthor(e, again).name, 'Bo Ops');
      assert.deepEqual(e.DB.rows("SELECT person FROM identities WHERE user_id = 'u-owner'"), [{ person: 2 }]);
    });
  });

  it('show on Adobe\'s side in the thread view, the messages written before too', async () => {
    const e = env();
    assert.deepEqual(await authors(e), { 5: ['Cy', false], 6: ['BO', true] });
  });

  it('are listed for the admin team, those nobody said whose they are first', async () => {
    const e = env();
    assert.equal((await call(e, BO, 'GET', '/api/admin/accounts')).status, 403);
    const { status, body } = await call(e, ADA, 'GET', '/api/admin/accounts');
    assert.equal(status, 200);
    assert.deepEqual(body.accounts.map((a) => [a.key, a.name, a.email, a.person, a.messages]), [
      [OWNER, 'BO', `owner_bo@${HOST}`, null, 1],
    ]);
  });

  it('are linked by the admin team to the Adobe person who uses one, and shown as them', async () => {
    const e = env();
    const put = (body, who = ADA) => quiet(() => call(e, who, 'PUT', '/api/admin/accounts', body));
    assert.equal((await put({ key: OWNER, email: 'bo@staff.example' }, BO)).status, 403);
    assert.equal((await put({ key: OWNER, email: 'not an address' })).status, 400);
    assert.equal((await put({ key: 'teams:T:nobody', email: 'bo@staff.example' })).status, 404);
    // A customer's account is never made Adobe's, nor an Adobe account a customer's.
    assert.equal((await put({ key: CY, email: 'bo@staff.example' })).status, 409);
    assert.equal((await put({ key: OWNER, email: 'cy@customer.example' })).status, 409);
    assert.equal((await put({ key: OWNER, email: 'zed@elsewhere.example' })).status, 409);
    const r = await put({ key: OWNER, email: 'BO@staff.example' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.account.person, { id: 2, name: 'Bo Ops', email: 'bo@staff.example' });
    assert.equal(r.body.account.linkedBy, 'ada@staff.example');
    assert.deepEqual(e.DB.rows("SELECT id, person, staff, author FROM messages WHERE id = '6'"), [
      {
        id: '6', person: 2, staff: 1, author: 'Bo Ops',
      },
    ]);
    assert.deepEqual(e.DB.rows('SELECT last_author, last_staff FROM threads'), [{ last_author: 'Bo Ops', last_staff: 1 }]);
    assert.deepEqual(await authors(e), { 5: ['Cy', false], 6: ['Bo Ops', true] });
    // Their profile card, too.
    const { body } = await call(e, ADA, 'GET', `/api/thread?thread=${THREAD}`);
    assert.equal(body.profiles[OWNER].name, 'Bo Ops');
    assert.equal(body.profiles[OWNER].relation, 'adobe');
    // Nobody's again: the account's own name, still Adobe's.
    const back = await put({ key: OWNER, email: null });
    assert.equal(back.status, 200);
    assert.equal(back.body.account.person, null);
    assert.deepEqual(e.DB.rows("SELECT person, staff, author FROM messages WHERE id = '6'"), [
      { person: null, staff: 1, author: 'BO' },
    ]);
    assert.deepEqual(await authors(e), { 5: ['Cy', false], 6: ['BO', true] });
  });

  it('link to a colleague of a staff domain not seen yet', async () => {
    const e = env();
    const r = await quiet(() => call(e, ADA, 'PUT', '/api/admin/accounts', { key: OWNER, email: 'dee@staff.example' }));
    assert.equal(r.status, 200);
    assert.deepEqual(e.DB.rows("SELECT email, staff FROM people WHERE email = 'dee@staff.example'"), [
      { email: 'dee@staff.example', staff: 1 },
    ]);
  });

  it('come after their person\'s own account wherever one account is offered', () => {
    const own = {
      id: 'u-bo', here: 1, own: 1, linked: 0, guest: 1, posts: 1,
    };
    const admin = {
      id: 'u-owner', here: 1, own: 1, linked: 1, guest: 0, posts: 9,
    };
    assert.ok(better(own, admin) < 0);
    // In the channel, the admin account still reaches them where their own is not.
    assert.ok(better({ ...own, here: 0 }, admin) > 0);
  });

  it('take the side and name of their account in the thread view', () => {
    const author = {
      kind: 'person', name: 'BO', org: HOST, staff: false,
    };
    assert.deepEqual(accountAuthor(ENV, author, { account_kind: 'person', account_staff: 1 }), { ...author, staff: true });
    assert.deepEqual(accountAuthor(ENV, author, {
      account_kind: 'person', account_staff: 1, linked_at: AT, account_person_name: 'Bo Ops', account_person_staff: 1,
    }), { ...author, staff: true, name: 'Bo Ops' });
    // A person's own name, by their mail address, is what the frontmatter says already.
    assert.equal(accountAuthor(ENV, author, { account_kind: 'person', account_person_name: 'Other' }), author);
    assert.equal(accountAuthor(ENV, author, { account_kind: 'person' }), author);
  });

  it('are seen as staff before migration 0097 by the migration itself', () => {
    const e = env();
    const db = e.DB.sqlite;
    db.prepare("UPDATE identities SET staff = NULL WHERE user_id = 'u-owner'").run();
    db.prepare("UPDATE messages SET staff = 0 WHERE id = '6'").run();
    db.prepare('UPDATE threads SET last_staff = 0').run();
    // A guest of the tenant with such an address stays a customer's.
    db.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, email, fetched_at, guest)
      VALUES ('teams', 'T', 'u-eve', 'person', 'Eve', 'owner_eve@customer.example', ?, 1)`).run(AT);
    const sql = readFileSync(new URL('../migrations/0097_host_admins.sql', import.meta.url), 'utf8');
    db.exec(sql.slice(0, sql.indexOf('ALTER TABLE')));
    assert.deepEqual(e.DB.rows("SELECT user_id, staff FROM identities WHERE user_id IN ('u-owner', 'u-eve') ORDER BY user_id"), [
      { user_id: 'u-eve', staff: null }, { user_id: 'u-owner', staff: 1 },
    ]);
    assert.deepEqual(e.DB.rows('SELECT id, staff FROM messages ORDER BY id'), [
      { id: '5', staff: 0 }, { id: '6', staff: 1 },
    ]);
    assert.deepEqual(e.DB.rows('SELECT last_staff FROM threads'), [{ last_staff: 1 }]);
  });
});
