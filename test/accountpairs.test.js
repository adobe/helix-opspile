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
import { beforeEach, describe, it } from 'node:test';
import { api } from '../src/api.js';
import {
  listAccountPairs, nameKey, pairId, sameAccounts, undecidedPairCount,
} from '../src/accountpairs.js';
import { orgNumbers, resetOrgProfiles } from '../src/orgprofile.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up people, customers and accounts only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada Admin', staff: 1, teams: ['admin'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo Ops', staff: 1, teams: ['edge'],
};
const viewer = (p) => ({
  id: p.id, email: p.email, name: p.name, teams: p.teams.map((slug) => ({ slug, role: 'member' })),
});
const NOW = new Date('2026-11-25T12:00:00Z');
const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

/**
 * Acme's people: Lu Wen with the agency's address and Acme's, both posting for Acme; Lu's guest
 * account of Acme's address too; Kai Moreau posting for Acme from one account and for Globex
 * from another; Rae Stone, whose second account never posted; Jo Diaz, two accounts of one mail
 * address; and a colleague at Adobe named like Lu.
 */
function env() {
  const DB = d1({
    people: [ADA, BO].map((p) => ({
      id: p.id, email: p.email, name: p.name, staff: p.staff, teams: p.teams,
    })),
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'edge', name: 'Edge ops' }],
  });
  const db = DB.sqlite;
  const id = db.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, email, person,
    staff, fetched_at) VALUES (?, 'T', ?, 'person', ?, ?, ?, ?, '${day(0)}')`);
  id.run('slack', 'A1', 'Lu Wen', 'lu.wen@agency.example', null, 0);
  id.run('slack', 'A2', 'Lu  Wén', 'lu@acme.example', null, 0);
  id.run('slack', 'A3', 'Lu W', 'LU@acme.example', null, 0);
  id.run('teams', 'K1', 'Kai Moreau', 'kai@acme.example', null, 0);
  id.run('slack', 'K2', 'kai moreau', 'kai@globex.example', null, 0);
  id.run('slack', 'R1', 'Rae Stone', 'rae@acme.example', null, 0);
  id.run('slack', 'R2', 'Rae Stone', null, null, 0);
  id.run('slack', 'J1', 'Jo Diaz', 'jo@acme.example', null, 0);
  id.run('slack', 'J2', 'Jo Diaz', 'JO@acme.example', null, 0);
  id.run('slack', 'S1', 'Lu Wen', 'lu.wen@staff.example', 1, 1);
  id.run('slack', 'Q1', 'Quin', 'quin@acme.example', null, 0);
  id.run('slack', 'Q2', 'Quin', 'quin@globex.example', null, 0);
  db.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES
      ('acme', 'ACME Corp', 'customer', '${day(0)}'), ('globex', 'Globex', 'customer', '${day(0)}');`);
  const thread = db.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org,
    team, kind, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, 'slack', 'T', ?, ?, ?, 'edge', 'channel', 'p/', ?, ?, ?, 1, ?)`);
  thread.run('t:a1', 'C1', 't:a1', 'acme', day(3), day(3), day(3), day(3));
  thread.run('t:a2', 'C1', 't:a2', 'acme', day(2), day(2), day(2), day(2));
  thread.run('t:g1', 'C2', 't:g1', 'globex', day(2), day(2), day(2), day(2));
  const msg = db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person,
    staff, counted, deleted, author_key) VALUES ('slack', 'T', 'C1', ?, ?, ?, NULL, 0, 1, 0, ?)`);
  let n = 0;
  const post = (thr, key, ago) => {
    n += 1;
    msg.run(`m${n}`, thr, day(ago), key);
  };
  post('t:a1', 'slack:T:A1', 3);
  post('t:a1', 'slack:T:A1', 3);
  post('t:a2', 'slack:T:A2', 2);
  post('t:a2', 'slack:T:A3', 2);
  post('t:a1', 'teams:T:K1', 3);
  post('t:a2', 'teams:T:K1', 2);
  post('t:g1', 'slack:T:K2', 2);
  post('t:a1', 'slack:T:R1', 3);
  post('t:a2', 'slack:T:J1', 2);
  post('t:a2', 'slack:T:J2', 2);
  post('t:a2', 'slack:T:Q1', 2);
  post('t:g1', 'slack:T:Q2', 2);
  return { DB, STAFF_DOMAINS: 'staff.example' };
}

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

const LU = pairId('slack:T:A1', 'slack:T:A2');
const KAI = pairId('slack:T:K2', 'teams:T:K1');

describe('a customer\'s two accounts that may be one person', () => {
  beforeEach(() => resetOrgProfiles());

  it('writes names alike, and counts the accounts of one address or said to be one as one', () => {
    assert.equal(nameKey('  Lu  Wén, Jr. '), 'lu wen jr');
    assert.equal(nameKey(null), '');
    assert.equal(pairId('b', 'a'), 'a|b');
    const same = sameAccounts([
      { key: 'c', mail: 'x@acme.example' },
      { key: 'b', mail: 'x@acme.example' },
      { key: 'c', mail: 'x@acme.example' },
      { key: 'd', mail: null },
      { key: 'e', mail: 'e@acme.example' },
      { key: 'a', mail: null },
    ], [{ a: 'd', b: 'b' }, { a: 'a', b: 'e' }, { a: 'd', b: 'gone' }, { a: 'b', b: 'c' }]);
    assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f'].map(same), ['a', 'b', 'b', 'b', 'a', 'f']);
  });

  it('lists the pairs named alike whose accounts both posted, the ones sharing a customer first', async () => {
    const e = env();
    const pairs = await listAccountPairs(e);
    assert.deepEqual(pairs.map((p) => [p.id, p.orgs, p.same]), [
      [LU, ['acme'], null],
      [KAI, [], null],
    ]);
    const [lu] = pairs;
    assert.deepEqual(lu.a, {
      key: 'slack:T:A1',
      name: 'Lu Wen',
      source: 'slack',
      mails: ['lu.wen@agency.example'],
      keys: ['slack:T:A1'],
      messages: 2,
      last: day(3),
      orgs: [{ org: 'acme', n: 2 }],
    });
    assert.deepEqual([lu.b.keys, lu.b.mails, lu.b.messages, lu.b.name], [
      ['slack:T:A2', 'slack:T:A3'], ['lu@acme.example'], 2, 'Lu  Wén',
    ]);
    assert.equal(await undecidedPairCount(e), 2);
  });

  it('is a thread of the admin team\'s inbox, decided there; a customer\'s overview follows', async () => {
    const e = env();
    const before = await orgNumbers(e, 'acme', { now: NOW });
    assert.deepEqual(before.people.map((p) => p.name).sort(), ['Jo Diaz', 'Kai Moreau', 'Lu  Wén', 'Lu Wen', 'Quin', 'Rae Stone']);
    const count = await call(e, ADA, 'GET', '/api/admin/requests?count=1');
    assert.equal(count.body.open, 2);
    const list = await quiet(() => call(e, ADA, 'GET', '/api/requests'));
    const key = `request:person:${LU}`;
    const t = list.body.threads.find((x) => x.thread === key);
    assert.equal(t.title, 'Lu Wen: one person?');
    assert.equal(t.org_name, 'Two accounts, one person?');
    assert.equal(t.waiting_on, 'us');
    const kai = list.body.threads.find((x) => x.thread === `request:person:${KAI}`);
    assert.equal(kai.title, 'Kai Moreau: one person?');
    const { body } = await quiet(() => call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`));
    assert.match(body.messages[0].body, /Both posted for ACME Corp\./);
    assert.match(body.messages[0].body, /\*\*Lu Wen\*\*, Slack, `lu\.wen@agency\.example`\n {2}2 messages, for ACME Corp \(2\), the latest /);
    assert.match(body.messages[0].body, /, 2 accounts\n/);
    assert.deepEqual(body.request.actions.map((a) => [a.id, a.pressed]), [['same', false], ['apart', false]]);
    const kaiThread = await quiet(() => call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(`request:person:${KAI}`)}`));
    assert.match(kaiThread.body.messages[0].body, /They posted for different customers\./);
    assert.match(kaiThread.body.messages[0].body, /, Teams,/);

    const said = await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key, action: 'same' }));
    assert.equal(said.status, 200);
    assert.equal(said.body.done, 'Lu Wen: one person.');
    assert.equal(said.body.thread.request.open, false);
    assert.equal(said.body.thread.request.status, 'one person');
    assert.deepEqual(said.body.thread.request.actions.map((a) => [a.id, a.pressed]), [
      ['same', true], ['apart', false], ['undo', undefined],
    ]);
    assert.ok(said.body.thread.messages.some((m) => m.body === '**Ada Admin**: Lu Wen: one person.'));
    const after = await orgNumbers(e, 'acme', { now: NOW });
    const lu = after.people.find((p) => p.name === 'Lu Wen');
    assert.deepEqual([lu.messages, lu.threads], [4, 2]);
    assert.equal(after.peopleCount, 5);
    assert.equal((await call(e, ADA, 'GET', '/api/admin/requests?count=1')).body.open, 1);

    const apart = await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key, action: 'apart' }));
    assert.equal(apart.body.thread.request.status, 'two people');
    assert.match(apart.body.thread.messages[apart.body.thread.messages.length - 1].body, /two people/);
    const again = await quiet(() => call(e, ADA, 'POST', '/api/requests/resolve', { key, action: 'undo' }));
    assert.equal(again.body.done, 'Lu Wen: asked again.');
    assert.equal(again.body.thread.request.open, true);
  });

  it('keeps what the admin team said of two accounts no longer named alike', async () => {
    const e = env();
    await call(e, ADA, 'PUT', '/api/admin/account-pairs', { a: 'slack:T:K2', b: 'teams:T:K1', same: false });
    e.DB.sqlite.exec("UPDATE identities SET name = 'Kai M' WHERE user_id = 'K2'");
    const pairs = await listAccountPairs(e);
    assert.deepEqual(pairs.map((p) => [p.id, p.same, p.decidedBy]), [
      [LU, null, null],
      [KAI, false, 'ada@staff.example'],
    ]);
    const { body } = await quiet(() => call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(`request:person:${KAI}`)}`));
    assert.match(body.messages[0].body, /^Two accounts outside Adobe are named \*\*Kai Moreau\*\*, .*\n- \*\*Kai M\*\*, Slack/s);
    // Said of a pair that is not asked about: one of them never posted.
    await call(e, ADA, 'PUT', '/api/admin/account-pairs', { a: 'slack:T:R1', b: 'slack:T:R2', same: true });
    const rae = pairId('slack:T:R1', 'slack:T:R2');
    assert.deepEqual((await listAccountPairs(e)).map((p) => [p.id, p.same]), [
      [LU, null], [KAI, false], [rae, true],
    ]);
    const shown = await quiet(() => call(e, ADA, 'GET', `/api/thread?thread=${encodeURIComponent(`request:person:${rae}`)}`));
    assert.match(shown.body.messages[0].body, /\*\*Rae Stone\*\*, Slack, no mail address\n {2}No messages/);
    assert.equal(shown.body.request.status, 'one person');
    // An account that is somebody's in the inbox since is not asked about.
    e.DB.sqlite.exec("UPDATE identities SET person = 2 WHERE user_id = 'K1'");
    assert.deepEqual((await listAccountPairs(e)).map((p) => p.id), [LU, rae]);
  });

  it('is decided by the admin team only, of two accounts outside Adobe', async () => {
    const e = env();
    const put = (who, b) => call(e, who, 'PUT', '/api/admin/account-pairs', b);
    assert.equal((await put(BO, { a: 'slack:T:A1', b: 'slack:T:A2', same: true })).status, 403);
    assert.equal((await put(ADA, { a: 'slack:T:A1', b: 'slack:T:A1', same: true })).status, 400);
    assert.equal((await put(ADA, { a: 'slack:T:A1|x', b: 'slack:T:A2', same: true })).status, 400);
    assert.equal((await put(ADA, { a: 'slack:T:A1' })).status, 400);
    assert.equal((await call(e, ADA, 'PUT', '/api/admin/account-pairs')).status, 400);
    assert.equal((await put(ADA, { a: 'slack:T:A1', b: 'slack:T:S1', same: true })).status, 404);
    const ok = await quiet(() => put(ADA, { a: 'slack:T:A2', b: 'slack:T:A1', same: 1 }));
    assert.deepEqual(ok.body, { ok: true, same: true });
    assert.deepEqual(e.DB.sqlite.prepare('SELECT a, b, same FROM account_pairs').all().map((r) => ({ ...r })), [
      { a: 'slack:T:A1', b: 'slack:T:A2', same: 1 },
    ]);
    const undone = await quiet(() => put(ADA, { a: 'slack:T:A1', b: 'slack:T:A2', same: null }));
    assert.deepEqual(undone.body, { ok: true, same: null });
    assert.equal(e.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM account_pairs').get().n, 0);
  });
});
