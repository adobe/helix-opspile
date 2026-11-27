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
import { AUTO_HOURLY } from '../src/portal/integration-auto.js';
import { quiet } from './fakes.js';
import {
  ADA, ADMIN, BO, MANAGER, now, ORG, OTHER_ORG, setup, viewer, world,
} from './integration-world.js';

setup();

// Made up, as everything here.
const CY = 'C1C2C3D4E5F6A7B8C9D0E1F2@AdobeID';
const THIRD_ORG = 'AAAAAAAAAAAAAAAAAAAAAAAA@AdobeOrg';
const pending = { error: { code: 'not_enrolled', request: 'pending' } };
const plain = { error: { code: 'not_enrolled' } };

const auto = (w, body, me = w.admin) => quiet(() => w.staff(me, 'PUT', '/api/admin/portal/integration/auto', body));
const members = (w, channel) => w.db.rows(`SELECT m.subject, m.via, m.auto, m.approved_by, a.verified_email, u.name
  FROM integration_members m JOIN integration_actors a ON a.channel = m.channel AND a.actor = m.actor
  JOIN users u ON u.id = m.actor WHERE m.channel = ? ORDER BY m.rowid`, channel);

describe('auto-approval of an onboarded organization', () => {
  it('enrolls a verified caller of the channel\'s organization on their first call', async () => {
    const w = world();
    const channel = w.handMade('panel', ORG, 'agents-mill', BO);
    const res = await auto(w, { channel, on: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.channel.autoApprove, res.body.channel.autoBy], [true, ADMIN.email]);
    const first = await w.list();
    assert.equal(first.status, 200);
    const [, ada] = members(w, channel);
    assert.deepEqual(ada, {
      subject: ADA, via: null, auto: 1, approved_by: ADMIN.email, verified_email: null, name: 'Ada Example',
    });
    assert.equal(w.db.rows('SELECT COUNT(*) AS n FROM integration_requests')[0].n, 0);
    assert.deepEqual(w.announced, [channel]);
    // The call went on as a member's: they write, and the next call is a member's too.
    assert.equal((await w.call('POST', '/threads', { body: { title: 'Hi', body: 'Exports fail.' } })).status, 201);
    assert.equal(members(w, channel).length, 2);

    // The admin team sees who joined: on the channel, and as a thread of its inbox.
    const [listed] = (await w.staff(w.admin, 'GET', '/api/admin/portal/integration/channels')).body.channels;
    assert.deepEqual([listed.members, listed.autoMembers, listed.autoApproved[0].name, listed.autoApproved[0].via], [2, 1, 'Ada Example', 'tenant']);
    const key = `request:embed:${channel}`;
    const thread = (await w.staff(w.admin, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`)).body;
    assert.ok(thread.messages.some((m) => /Auto-approved\*\* Ada Example by the channel's organization/.test(m.body)));
    assert.ok((await w.staff(w.admin, 'GET', '/api/requests')).body.threads.some((e) => e.thread === key));
  });

  it('is turned on when the first request is approved, for the organization\'s next members', async () => {
    const w = world();
    await w.list();
    const res = await quiet(() => w.staff(w.admin, 'POST', '/api/requests/resolve', {
      key: 'request:integration:1',
      action: 'approve',
      values: {
        name: 'agents-mill', org: 'mill', team: 'agents', person: 'Ada', auto: true,
      },
    }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.done, /next members are auto-approved/);
    const bo = await w.token({ user: BO });
    assert.equal((await w.list({ bearer: bo })).status, 200);
    const [{ channel }] = w.db.rows('SELECT channel FROM integration_customers');
    assert.deepEqual(
      members(w, channel).map((m) => [m.subject, m.auto, m.approved_by]),
      [[ADA, 0, ADMIN.email], [BO, 1, ADMIN.email]],
    );
  });

  it('lands another organization ID in the channel', async () => {
    const w = world();
    const channel = w.handMade('panel', ORG, 'agents-mill', null);
    assert.equal((await auto(w, { channel, on: true, tenants: [OTHER_ORG, ORG] })).status, 200);
    const bo = await w.token({ user: BO, profile: { ownerOrg: OTHER_ORG } });
    assert.equal((await w.list({ bearer: bo })).status, 200);
    assert.deepEqual(members(w, channel).map((m) => [m.subject, m.via, m.auto]), [[BO, `org:${OTHER_ORG}`, 1]]);
    // The channel's own tenant is not a catch of its own.
    assert.deepEqual(w.db.rows('SELECT kind, value FROM integration_catches'), [{ kind: 'tenant', value: OTHER_ORG }]);
    assert.equal((await auto(w, { channel, tenants: ['not-an-org'] })).status, 400);
  });

  it('catches a verified address at a listed domain, exactly, and never free mail', async () => {
    const w = world();
    const channel = w.handMade('panel', ORG, 'agents-mill', null);
    assert.equal((await auto(w, { channel, on: true, domains: 'mill.example, eu.mill.example' })).status, 200);
    for (const domain of ['gmail.com', 'yahoo.co.uk', 'outlook.de', 'not a domain']) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await auto(w, { channel, domains: [domain] });
      assert.equal(refused.status, 400, domain);
    }
    const personal = (user, email, extra = {}) => w.token({
      user, profile: { ownerOrg: null, email, ...extra },
    });
    // A personal profile with a verified company address.
    assert.equal((await w.list({ bearer: await personal(ADA, 'ada@mill.example') })).status, 200);
    // Unverified, a subdomain not listed, or a lookalike: nobody is caught, nothing recorded.
    assert.deepEqual((await w.list({ bearer: await personal(BO, 'bo@mill.example', { emailVerified: 'false' }) })).body, plain);
    assert.deepEqual((await w.list({ bearer: await personal(BO, 'bo@us.mill.example') })).body, plain);
    assert.deepEqual((await w.list({ bearer: await personal(BO, 'bo@notmill.example') })).body, plain);
    // A listed subdomain catches; another organization's profile with that address does too.
    assert.equal((await w.list({ bearer: await personal(BO, 'bo@eu.mill.example') })).status, 200);
    const cy = await w.token({ user: CY, profile: { ownerOrg: THIRD_ORG, email: 'cy@mill.example' } });
    assert.equal((await w.list({ bearer: cy })).status, 200);
    assert.deepEqual(members(w, channel).map((m) => [m.subject, m.via, m.verified_email]), [
      [ADA, 'domain:mill.example', 'ada@mill.example'],
      [BO, 'domain:eu.mill.example', 'bo@eu.mill.example'],
      [CY, 'domain:mill.example', 'cy@mill.example'],
    ]);
    // Bound to that verified address: another one, or an unverified one, is not them any more.
    assert.deepEqual((await w.list({ bearer: await personal(ADA, 'ada@elsewhere.example') })).body, plain);
    assert.deepEqual((await w.list({ bearer: await personal(ADA, 'ada@mill.example', { emailVerified: 'false' }) })).body, plain);
  });

  it('resolves a domain-caught member on reads, writes and changes', async () => {
    const w = world();
    const channel = w.handMade('panel', ORG, 'agents-mill', null);
    await auto(w, { channel, on: true, domains: ['mill.example'] });
    const bearer = await w.token({ profile: { ownerOrg: null, email: 'ada@mill.example' } });
    const created = await w.call('POST', '/threads', { bearer, body: { title: 'Exports', body: 'They time out.' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.channelId, channel);
    const page = await w.list({ bearer });
    assert.deepEqual(page.body.items.map((i) => i.id), [created.body.threadId]);
    const root = created.body.threadId;
    assert.equal((await w.call('GET', `/threads/${root}`, { bearer })).status, 200);
    const reply = await w.call('POST', `/threads/${root}/replies`, { bearer, body: { body: 'Still.' } });
    assert.equal(reply.status, 201);
    assert.equal((await w.call('PUT', `/threads/${root}/read`, { bearer, body: { through: reply.body.id } })).status, 200);
    const changes = await w.call('GET', `/changes?after=${page.body.changeCursor}`, { bearer });
    assert.equal(changes.status, 200);
    assert.ok(changes.body.events.length >= 1);
    // Someone of the channel's own organization sees the same channel.
    w.db.sqlite.exec('UPDATE integration_customers SET auto_approve = 1');
    const bo = await w.token({ user: BO });
    assert.deepEqual((await w.list({ bearer: bo })).body.items.map((i) => i.id), [root]);
  });

  it('takes the tenant\'s channel first: a domain catches only who has no channel of their organization', async () => {
    const w = world();
    const caught = w.handMade('panel', ORG, 'agents-mill', null);
    const theirs = w.handMade('panel', OTHER_ORG, 'agents-other', null);
    await auto(w, { channel: caught, on: true, domains: ['mill.example'] });
    const bo = await w.token({ user: BO, profile: { ownerOrg: OTHER_ORG, email: 'bo@mill.example' } });
    assert.deepEqual((await w.list({ bearer: bo })).body, pending);
    assert.equal(members(w, caught).length, 0);
    const [r] = (await w.staff(w.admin, 'GET', '/api/admin/requests')).body.integration;
    assert.deepEqual([r.mapping.channel, r.mapping.via], [theirs, null]);
  });

  it('refuses an org ID or domain another channel of the host holds, and says which', async () => {
    const w = world();
    const a = w.handMade('panel', ORG, 'agents-mill', null);
    const b = w.handMade('panel', OTHER_ORG, 'agents-other', null);
    const c = w.handMade('desk', OTHER_ORG, 'agents-other-desk', null);
    assert.equal((await auto(w, { channel: a, domains: ['mill.example'], tenants: [THIRD_ORG] })).status, 200);
    for (const body of [{ domains: ['mill.example'] }, { tenants: [THIRD_ORG] }, { tenants: [ORG] }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await auto(w, { channel: b, ...body });
      assert.equal(res.status, 409, JSON.stringify(body));
      assert.match(res.body.error, new RegExp(`#agents-mill \\(${a}\\)`));
      assert.equal(res.body.conflict.channel, a);
    }
    // Another host's channel may: catches are per host.
    assert.equal((await auto(w, { channel: c, domains: ['mill.example'], tenants: [THIRD_ORG] })).status, 200);
    // A channel whose tenant another channel catches cannot be made by hand either.
    assert.throws(() => w.db.sqlite.prepare(`INSERT INTO integration_customers (host, tenant, customer, name)
      VALUES ('panel', ?, 'x', 'x')`).run(THIRD_ORG), /caught/);
    assert.equal((await auto(w, { channel: a, domains: [] })).status, 200);
    assert.equal((await auto(w, { channel: b, domains: ['mill.example'] })).status, 200);
  });

  it('keeps hosts apart: one host\'s auto-approval admits nobody through another', async () => {
    const w = world();
    const channel = w.handMade('panel', ORG, 'agents-mill', null);
    await auto(w, { channel, on: true, domains: ['mill.example'] });
    assert.deepEqual((await w.list({ host: 'desk' })).body, pending);
    const personal = await w.token({ user: BO, profile: { ownerOrg: null, email: 'bo@mill.example' } });
    assert.deepEqual((await w.list({ host: 'desk', bearer: personal })).body, plain);
    assert.equal(members(w, channel).length, 0);
    // Enrolled on one host, a subject is not a member of another host's channel.
    assert.equal((await w.list()).status, 200);
    const desk = w.handMade('desk', ORG, 'agents-mill-desk', null);
    assert.deepEqual((await w.list({ host: 'desk' })).body, pending);
    assert.equal(members(w, desk).length, 0);
  });

  it('falls back to a pending request beyond the hour\'s cap', async () => {
    const w = world();
    const channel = w.handMade('panel', ORG, 'agents-mill', null);
    await auto(w, { channel, on: true });
    const sec = Math.floor(now / 1000);
    for (let i = 0; i < AUTO_HOURLY; i += 1) {
      const { actor } = w.db.sqlite.prepare(`INSERT INTO integration_actors (channel, name)
        VALUES (?, 'Someone') RETURNING actor`).get(channel);
      w.db.sqlite.prepare(`INSERT INTO integration_members (channel, subject, actor, approved_by,
        approved_at, auto) VALUES (?, ?, ?, 'x', ?, 1)`).run(channel, `S${i}@AdobeID`, actor, sec - 60);
    }
    assert.deepEqual((await w.list()).body, pending);
    const [listed] = (await w.staff(w.admin, 'GET', '/api/admin/portal/integration/channels')).body.channels;
    assert.equal(listed.autoLastHour, AUTO_HOURLY);
    // An hour on, the next one is auto-approved again, and their request with it.
    const later = now + 3600 * 1000;
    const bearer = await w.token({ at: later });
    assert.equal((await w.list({ bearer, clock: later })).status, 200);
    assert.deepEqual(w.db.rows('SELECT status, decided_name FROM integration_requests')[0], { status: 'approved', decided_name: 'auto-approved' });
  });

  it('asks for a person a domain places while auto-approval is off, and binds the approval to it', async () => {
    const w = world();
    const channel = w.handMade('panel', ORG, 'agents-mill', null);
    await auto(w, { channel, domains: ['mill.example'] });
    const bearer = await w.token({ profile: { ownerOrg: null, email: 'ada@mill.example' } });
    assert.deepEqual((await w.list({ bearer })).body, pending);
    const [r] = (await w.staff(w.admin, 'GET', '/api/admin/requests')).body.integration;
    assert.deepEqual([r.tenant, r.mapping.channel, r.mapping.via], [null, channel, 'domain:mill.example']);
    const res = await quiet(() => w.staff(w.admin, 'POST', '/api/admin/portal/integration/approve', { id: r.id }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(members(w, channel).map((m) => [m.via, m.auto, m.verified_email]), [['domain:mill.example', 0, 'ada@mill.example']]);
    assert.equal((await w.list({ bearer })).status, 200);
  });

  it('stops new auto-enrollments when turned off, and keeps the members', async () => {
    const w = world();
    const channel = w.handMade('panel', ORG, 'agents-mill', null);
    await auto(w, { channel, on: true });
    assert.equal((await w.list()).status, 200);
    const off = await auto(w, { channel, on: false });
    assert.equal(off.body.channel.autoApprove, false);
    assert.deepEqual((await w.list({ bearer: await w.token({ user: BO }) })).body, pending);
    assert.equal((await w.list()).status, 200);
  });

  it('never auto-approves into a disabled channel, nor a subject with a member row', async () => {
    const w = world();
    const channel = w.handMade('panel', ORG, 'agents-mill', null);
    await auto(w, { channel, on: true });
    w.db.sqlite.exec('UPDATE integration_customers SET enabled = 0');
    assert.deepEqual((await w.list()).body, pending);
    assert.equal(members(w, channel).length, 0);
    w.db.sqlite.exec('UPDATE integration_customers SET enabled = 1');
    const { actor } = w.db.sqlite.prepare(`INSERT INTO integration_actors (channel, name)
      VALUES (?, 'Bo') RETURNING actor`).get(channel);
    w.db.sqlite.prepare(`INSERT INTO integration_members (channel, subject, actor, active)
      VALUES (?, ?, ?, 0)`).run(channel, BO, actor);
    assert.deepEqual((await w.list({ bearer: await w.token({ user: BO }) })).body, plain);
    // A provider's subject is a member of one channel of a host.
    const other = w.handMade('panel', OTHER_ORG, 'agents-other', null);
    const { actor: second } = w.db.sqlite.prepare(`INSERT INTO integration_actors (channel, name)
      VALUES (?, 'Bo') RETURNING actor`).get(other);
    assert.throws(() => w.db.sqlite.prepare(`INSERT INTO integration_members (channel, subject, actor)
      VALUES (?, ?, ?)`).run(other, BO, second), /enrolled on this host/);
  });

  it('is for the admin team, and for user-token hosts only', async () => {
    const w = world();
    const channel = w.handMade('panel', ORG, 'agents-mill', null);
    const manager = viewer(MANAGER, 'manager');
    assert.equal((await w.staff(manager, 'PUT', '/api/admin/portal/integration/auto', { channel, on: true, team: 'agents' })).status, 403);
    assert.equal((await w.staff(manager, 'GET', '/api/admin/portal/integration/channels')).status, 403);
    const assertionChannel = w.handMade('console', 'account-1', 'console-mill', null);
    assert.equal((await auto(w, { channel: assertionChannel, on: true })).status, 409);
    assert.equal(w.db.rows('SELECT auto_approve FROM integration_customers WHERE channel = ?', channel)[0].auto_approve, 0);
  });
});
