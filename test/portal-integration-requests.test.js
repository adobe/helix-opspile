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
  before, beforeEach, describe, it,
} from 'node:test';
import { api } from '../src/api.js';
import { channelName, customerPart, mailCompany } from '../src/integrationrequests.js';
import { integration } from '../src/portal/integration.js';
import { BASE } from '../src/portal/integration-auth.js';
import { IMS, resetIdentityCache } from '../src/portal/integration-identity.js';
import { DECLINE_TTL } from '../src/portal/integration-requests.js';
import * as platform from '../src/portal/platform.js';
import { d1, PORTAL } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Every identifier, name and address here is made up.
const access = 'https://access.example';
const origin = 'https://portal.example';
const scopes = ['threads:create', 'threads:read', 'threads:reply', 'changes:read'];
const now = Date.now();
const ORG = '0123456789ABCDEF01234567@AdobeOrg';
const OTHER_ORG = '76543210FEDCBA9876543210@AdobeOrg';
const ADA = 'A1B2C3D4E5F6A7B8C9D0E1F2@AdobeID';
const BO = 'B1B2C3D4E5F6A7B8C9D0E1F2@AdobeID';
const ADMIN = {
  id: 1, email: 'ada.admin@staff.example', name: 'Ada Admin', staff: 1, teams: ['admin'],
};
const MANAGER = {
  id: 2, email: 'max@staff.example', name: 'Max Manager', staff: 1, teams: ['agents'],
};
const viewer = (p, role = 'member') => ({ ...p, teams: p.teams.map((slug) => ({ slug, role })) });
const keys = {};

async function keyPair(kid) {
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  return {
    jwk: { kid, ...await crypto.subtle.exportKey('jwk', pair.publicKey) },
    sign: async (claims) => {
      const part = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
      const unsigned = `${part({ alg: 'RS256', kid })}.${part(claims)}`;
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(unsigned));
      return `${unsigned}.${Buffer.from(sig).toString('base64url')}`;
    },
  };
}

before(async () => {
  Object.assign(keys, {
    access: await keyPair('first'),
    console: await keyPair('first'),
    prod: await keyPair('ims_na1-key-at-1'),
  });
});
beforeEach(() => resetIdentityCache());

const identity = JSON.stringify({
  provider: 'adobe-ims',
  environment: 'prod',
  issuer: IMS.prod.issuer,
  keys: `${IMS.prod.issuer}/ims/keys`,
  clientIds: ['panel-web'],
  tenant: 'profile.ownerOrg',
  subject: 'token.user_id',
  email: 'profile.email',
});

/**
 * The inbox and the portal, each with its own database, bound as their Workers are: the inbox's
 * `PORTAL` is the portal's platform, the portal's `OPSPILE` announces requests. Two IMS hosts
 * (`panel`, `desk`, product `agents`) and one that signs its own assertions (`console`).
 */
function world() {
  const announced = [];
  const inbox = {
    DB: d1({
      people: [ADMIN, MANAGER],
      teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'agents', name: 'Agents' }, { slug: 'edge', name: 'Edge ops' }],
    }),
    RAW: fakeBucket(),
    CHANNELS: fakeBucket(),
    NORMALIZE: { send: async () => {} },
    STAFF_DOMAINS: 'staff.example',
  };
  inbox.DB.sqlite.prepare("UPDATE team_members SET role = 'manager' WHERE person = 2").run();
  const db = d1({ migrations: PORTAL });
  const portal = {
    DB: db,
    PORTAL_INTEGRATION_AUD: 'integration',
    ACCESS_TEAM_DOMAIN: access,
    ACCESS_AUD: 'web',
    OPSPILE: {
      accessRequested: async ({ id }) => {
        announced.push(id);
        return { ok: true };
      },
    },
  };
  inbox.PORTAL = {
    accessRequests: (a) => platform.accessRequests(portal, a),
    reserveAccess: (a) => platform.reserve(portal, a),
    enrollAccess: (a) => platform.enroll(portal, a),
    declineAccess: (a) => platform.declineRequest(portal, a),
  };
  for (const id of ['panel', 'desk']) {
    db.sqlite.prepare(`INSERT INTO integration_hosts (id, service_id, issuer, jwks, scopes, identity,
      product) VALUES (?, ?, ?, '{"keys":[]}', ?, ?, 'agents')`)
      .run(id, `${id}.access`, IMS.prod.issuer, JSON.stringify(scopes), identity);
  }
  db.sqlite.prepare(`INSERT INTO integration_hosts (id, service_id, issuer, jwks, scopes)
    VALUES ('console', 'console.access', 'console', ?, ?)`)
    .run(JSON.stringify({ keys: [keys.console.jwk] }), JSON.stringify(scopes));

  const profiles = new Map();
  const upstream = { orgs: 0, scope: true };
  async function fetchImpl(url, init) {
    const u = new URL(url);
    if (u.origin === access) {
      return Response.json({ keys: [keys.access.jwk] });
    }
    if (u.pathname === '/ims/keys') {
      return Response.json({ keys: [keys.prod.jwk] });
    }
    const sent = /^Bearer (.+)$/.exec(init.headers.authorization)?.[1];
    const profile = profiles.get(sent);
    if (u.pathname === '/ims/organizations/v6') {
      upstream.orgs += 1;
      if (!upstream.scope) {
        return Response.json({ error: 'insufficient_scope' }, { status: 403 });
      }
      // What the user is a member of; only the entry of the profile's organization names it.
      return Response.json([
        { orgName: 'Somebody Else Corp', orgRef: { ident: '1111', authSrc: 'AdobeOrg' } },
        { orgName: 'Mill Paper Products International Inc. - Marketing (Prod)', orgRef: { ident: ORG.split('@')[0], authSrc: 'AdobeOrg' } },
        { orgName: 'Other Mill GmbH', orgRef: { ident: OTHER_ORG.split('@')[0], authSrc: 'AdobeOrg' } },
      ]);
    }
    assert.equal(u.pathname, '/ims/profile/v1');
    return profile ? Response.json(profile) : Response.json({}, { status: 401 });
  }

  async function token({ user = ADA, profile, at = now } = {}) {
    const t = await keys.prod.sign({
      id: crypto.randomUUID(),
      type: 'access_token',
      client_id: 'panel-web',
      user_id: user,
      as: 'ims-na1',
      created_at: String(at - 60000),
      expires_in: '86400000',
    });
    profiles.set(t, {
      userId: user,
      ownerOrg: ORG,
      email: user === ADA ? 'ada@mill.example' : 'bo@mill.example',
      emailVerified: 'true',
      displayName: user === ADA ? 'Ada Example' : 'Bo Example',
      ...profile,
    });
    return t;
  }

  const told = [];
  async function call(method, path, {
    host = 'panel', bearer, body, clock = now, key = crypto.randomUUID(),
  } = {}) {
    const seconds = Math.floor(clock / 1000);
    const req = new Request(new URL(`${origin}${BASE}${path}`), {
      method,
      headers: {
        'cf-access-jwt-assertion': await keys.access.sign({
          type: 'app', common_name: `${host}.access`, sub: '', aud: ['integration'], iss: access, exp: seconds + 100,
        }),
        authorization: `Bearer ${bearer ?? await token()}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await integration(req, portal, {
      now: clock, fetchImpl, waitUntil: (p) => told.push(p),
    });
    await Promise.all(told.splice(0));
    return { status: res.status, body: await res.json() };
  }
  const list = (opts) => call('GET', '/threads', opts);

  async function staff(me, method, path, body) {
    const url = new URL(`https://opspile.example${path}`);
    const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    const res = await api(request, inbox, url, { viewer: me });
    return { status: res.status, body: await res.json() };
  }
  const admin = viewer(ADMIN);

  /** An enabled mapping made by hand, as an operator did, with one member. */
  function handMade(host, tenant, name, subject) {
    const { channel } = db.sqlite.prepare(`INSERT INTO integration_customers (host, tenant, customer,
      name, enabled) VALUES (?, ?, ?, ?, 1) RETURNING channel`).get(host, tenant, name, name);
    const { actor } = db.sqlite.prepare(`INSERT INTO integration_actors (channel, name)
      VALUES (?, 'Member') RETURNING actor`).get(channel);
    db.sqlite.prepare('INSERT INTO integration_members (channel, subject, actor) VALUES (?, ?, ?)')
      .run(channel, subject, actor);
    for (const [target, value] of [['team', 'agents'], ['org', 'mill']]) {
      inbox.DB.sqlite.prepare(`INSERT INTO rules (target, priority, source, field, pattern, value, note)
        VALUES (?, 10, 'portal', 'channel_id', ?, ?, 'manual assignment')`).run(target, `^${channel}$`, value);
    }
    return channel;
  }

  return {
    inbox, portal, db, call, list, token, staff, admin, announced, upstream, handMade,
  };
}

const requests = (w) => w.db.rows('SELECT * FROM integration_requests ORDER BY id');

describe('integration access requests', () => {
  it('records one pending request per host, tenant and subject, and says so in the error', async () => {
    const w = world();
    const bearer = await w.token();
    const first = await w.list({ bearer });
    assert.equal(first.status, 403);
    assert.deepEqual(first.body, { error: { code: 'not_enrolled', request: 'pending' } });
    assert.deepEqual(w.announced, [1]);
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual((await w.list({ bearer: await w.token(), clock: now + i * 1000 })).body.error.request, 'pending');
    }
    let [row] = requests(w);
    assert.equal(requests(w).length, 1);
    assert.deepEqual([row.host, row.tenant, row.subject, row.status], ['panel', ORG, ADA, 'pending']);
    assert.deepEqual([row.name, row.email], ['Ada Example', 'ada@mill.example']);
    assert.equal(row.org_name, 'Mill Paper Products International Inc. - Marketing (Prod)');
    // Refreshed at most every 15 minutes; the organization's name asked once a day.
    assert.equal(row.attempts, 1);
    assert.equal(w.upstream.orgs, 1);
    await w.list({ bearer, clock: now + 16 * 60 * 1000 });
    [row] = requests(w);
    assert.equal(row.attempts, 2);
    assert.equal(w.upstream.orgs, 1);
    assert.deepEqual(w.announced, [1]);
    // No token is kept anywhere in the portal's database.
    const everything = JSON.stringify(w.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map(({ name }) => w.db.rows(`SELECT * FROM "${name}"`)));
    assert.ok(!everything.includes(bearer) && !everything.includes(bearer.split('.')[1]));
  });

  it('keeps only a verified mail address, and no organization name without the scope', async () => {
    const w = world();
    w.upstream.scope = false;
    await w.list({ bearer: await w.token({ profile: { emailVerified: 'false' } }) });
    const [row] = requests(w);
    assert.equal(row.email, null);
    assert.equal(row.org_name, null);
    assert.equal(row.name, 'Ada Example');
  });

  it('records nothing for an assertion host, a refused scope, no organization or a member row', async () => {
    const w = world();
    const plain = { error: { code: 'not_enrolled' } };
    const sec = Math.floor(now / 1000);
    const assertion = await keys.console.sign({
      iss: 'console', aud: 'integration', iat: sec, exp: sec + 45, jti: crypto.randomUUID(), tenant: 'account-1', sub: 'ada', method: 'GET', path: `${BASE}/threads`, scope: 'threads:read',
    });
    assert.deepEqual((await w.list({ host: 'console', bearer: assertion })).body, plain);
    const personal = await w.token({ profile: { ownerOrg: null } });
    assert.deepEqual((await w.list({ bearer: personal })).body, plain);
    w.db.sqlite.exec("UPDATE integration_hosts SET scopes = '[\"threads:create\"]' WHERE id = 'desk'");
    assert.deepEqual((await w.list({ host: 'desk' })).body, plain);
    // A revoked member is the operator's to decide.
    const channel = w.handMade('panel', ORG, 'agents-mill', ADA);
    w.db.sqlite.prepare('UPDATE integration_members SET active = 0 WHERE channel = ?').run(channel);
    assert.deepEqual((await w.list()).body, plain);
    assert.equal(requests(w).length, 0);
  });

  it('bounds the pending requests of a tenant and a host, and the new ones of an hour', async () => {
    const w = world();
    const insert = w.db.sqlite.prepare(`INSERT INTO integration_requests (host, tenant, subject,
      requested_at, seen_at) VALUES ('panel', ?, ?, ?, ?)`);
    const old = Math.floor(now / 1000) - 7200;
    for (let i = 0; i < 100; i += 1) {
      insert.run(ORG, `user-${i}@AdobeID`, old, old);
    }
    assert.deepEqual((await w.list()).body, { error: { code: 'not_enrolled' } });
    // Another tenant of the host still asks; then the hour's new requests are spent.
    const elsewhere = await w.token({ user: BO, profile: { ownerOrg: OTHER_ORG } });
    assert.equal((await w.list({ bearer: elsewhere })).body.error.request, 'pending');
    for (let i = 0; i < 119; i += 1) {
      insert.run(`T${i}@AdobeOrg`, `x-${i}@AdobeID`, Math.floor(now / 1000), Math.floor(now / 1000));
    }
    const third = await w.token({ user: 'C1B2C3D4E5F6A7B8C9D0E1F2@AdobeID', profile: { ownerOrg: OTHER_ORG } });
    assert.deepEqual((await w.list({ bearer: third })).body, { error: { code: 'not_enrolled' } });
  });

  it('approves a new organization: its channel, routed by hand, then the person, enabled', async () => {
    const w = world();
    await w.list();
    const { body } = await w.staff(w.admin, 'GET', '/api/admin/requests');
    const [r] = body.integration;
    assert.equal(body.open, 1);
    assert.deepEqual([r.host, r.product, r.tenant, r.status, r.mapping], ['panel', 'agents', ORG, 'pending', null]);
    assert.deepEqual(r.suggest, {
      name: 'agents-mill', org: 'mill', orgName: r.orgName, known: false, team: 'agents', person: 'Ada Example',
    });
    assert.equal((await w.staff(w.admin, 'GET', '/api/admin/requests?count=1')).body.open, 1);

    // Decided in the admin team's inbox, where it is a thread.
    const key = 'request:integration:1';
    const entries = (await w.staff(w.admin, 'GET', '/api/requests')).body.threads;
    assert.ok(entries.some((e) => e.thread === key && e.request.open));
    const thread = (await w.staff(w.admin, 'GET', `/api/thread?thread=${encodeURIComponent(key)}`)).body;
    const approve = thread.request.actions.find((a) => a.id === 'approve');
    assert.deepEqual(approve.fields.map((f) => f.name), ['name', 'org', 'team', 'person']);
    const done = await quiet(() => w.staff(w.admin, 'POST', '/api/requests/resolve', {
      key,
      action: 'approve',
      values: {
        name: 'agents-mill', org: 'mill', team: 'agents', person: 'Ada E.',
      },
    }));
    assert.equal(done.status, 200, JSON.stringify(done.body));

    const [mapping] = w.db.rows("SELECT * FROM integration_customers WHERE host = 'panel'");
    assert.deepEqual(
      [mapping.tenant, mapping.customer, mapping.name, mapping.enabled, mapping.approved_by],
      [ORG, 'agents-mill', 'agents-mill', 1, ADMIN.email],
    );
    assert.ok(mapping.enabled_at > 0);
    const [member] = w.db.rows('SELECT * FROM integration_members WHERE channel = ?', mapping.channel);
    assert.deepEqual([member.subject, member.active, member.approved_by], [ADA, 1, ADMIN.email]);
    const [user] = w.db.rows('SELECT * FROM users WHERE id = ?', member.actor);
    assert.deepEqual([user.name, user.kind, user.email], ['Ada E.', 'customer', null]);
    const rules = w.inbox.DB.rows(`SELECT target, source, field, pattern, value, priority FROM rules
      WHERE field = 'channel_id' ORDER BY target`);
    assert.deepEqual(rules, [
      {
        target: 'org', source: 'portal', field: 'channel_id', pattern: `^${mapping.channel}$`, value: 'mill', priority: 10,
      },
      {
        target: 'team', source: 'portal', field: 'channel_id', pattern: `^${mapping.channel}$`, value: 'agents', priority: 10,
      },
    ]);
    assert.equal(w.inbox.DB.rows("SELECT name FROM orgs WHERE slug = 'mill'")[0].name, r.orgName);
    const [row] = requests(w);
    assert.deepEqual([row.status, row.decided_by, row.channel, row.actor], ['approved', ADMIN.email, mapping.channel, member.actor]);

    // In: the person reads and writes, and a one-line request is said once.
    assert.equal((await w.list()).status, 200);
    const created = await w.call('POST', '/threads', { body: { title: 'Exports time out.', body: 'Exports time out.' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.channelId, mapping.channel);
    assert.equal(w.db.rows('SELECT body FROM messages WHERE id = ?', created.body.threadId)[0].body, 'Exports time out.');
    assert.equal((await w.staff(w.admin, 'GET', '/api/admin/requests?count=1')).body.open, 0);
    assert.equal((await w.staff(w.admin, 'POST', '/api/admin/portal/integration/approve', { id: 1 })).status, 409);
  });

  it('approves into the channel an organization has on the host already, and nothing else', async () => {
    const w = world();
    const channel = w.handMade('desk', ORG, 'agents-mill', BO);
    const rulesBefore = w.inbox.DB.rows('SELECT * FROM rules');
    assert.equal((await w.list({ host: 'desk' })).body.error.request, 'pending');
    const [r] = (await w.staff(w.admin, 'GET', '/api/admin/requests')).body.integration;
    assert.deepEqual(r.mapping, {
      channel, name: 'agents-mill', customer: 'agents-mill', enabled: true, resumable: false, route: { team: 'agents', org: 'mill' },
    });
    const thread = (await w.staff(w.admin, 'GET', '/api/thread?thread=request%3Aintegration%3A1')).body;
    const approve = thread.request.actions.find((a) => a.id === 'approve');
    assert.equal(approve.label, '#agents-mill'.replace(/^/, 'Add to '));
    assert.deepEqual(approve.fields.map((f) => f.name), ['person']);
    const res = await quiet(() => w.staff(w.admin, 'POST', '/api/admin/portal/integration/approve', { id: r.id, team: 'edge', org: 'elsewhere' }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.channel.channelId, res.body.channel.existing, res.body.channel.team], [channel, true, 'agents']);
    assert.deepEqual(w.inbox.DB.rows('SELECT * FROM rules'), rulesBefore);
    assert.equal(w.db.rows("SELECT COUNT(*) AS n FROM integration_customers WHERE host = 'desk'")[0].n, 1);
    assert.equal(w.db.rows('SELECT COUNT(*) AS n FROM integration_members WHERE channel = ?', channel)[0].n, 2);
    assert.equal((await w.list({ host: 'desk' })).status, 200);
    // The hand-made member is as it was.
    assert.equal((await w.list({ host: 'desk', bearer: await w.token({ user: BO }) })).status, 200);
  });

  it('keeps hosts and tenants apart: an approval admits only its own host and organization', async () => {
    const w = world();
    await w.list();
    await w.list({ host: 'desk' });
    const other = await w.token({ user: BO, profile: { ownerOrg: OTHER_ORG } });
    await w.list({ bearer: other });
    assert.deepEqual(requests(w).map((r) => [r.id, r.host, r.tenant, r.subject]), [
      [1, 'panel', ORG, ADA], [2, 'desk', ORG, ADA], [3, 'panel', OTHER_ORG, BO],
    ]);
    await quiet(() => w.staff(w.admin, 'POST', '/api/admin/portal/integration/approve', {
      id: 1, team: 'agents', org: 'mill', name: 'agents-mill',
    }));
    assert.equal((await w.list()).status, 200);
    assert.deepEqual((await w.list({ host: 'desk' })).body.error, { code: 'not_enrolled', request: 'pending' });
    assert.deepEqual((await w.list({ bearer: other })).body.error, { code: 'not_enrolled', request: 'pending' });
    // The other organization gets its own channel, and sees none of the first's threads.
    const thread = await w.call('POST', '/threads', { body: { title: 'Mine', body: 'Only ours.' } });
    const second = await quiet(() => w.staff(w.admin, 'POST', '/api/admin/portal/integration/approve', {
      id: 3, team: 'agents', org: 'other-mill', name: 'agents-other-mill',
    }));
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.notEqual(second.body.channel.channelId, thread.body.channelId);
    assert.deepEqual((await w.list({ bearer: other })).body.items, []);
    assert.equal((await w.call('GET', `/threads/${thread.body.threadId}`, { bearer: other })).status, 404);
    // A second organization cannot take a customer name the host has.
    await w.list({ host: 'desk', bearer: await w.token({ user: BO, profile: { ownerOrg: OTHER_ORG } }) });
    await quiet(() => w.staff(w.admin, 'POST', '/api/admin/portal/integration/approve', {
      id: 2, team: 'agents', org: 'mill', name: 'agents-mill',
    }));
    const clash = await quiet(() => w.staff(w.admin, 'POST', '/api/admin/portal/integration/approve', {
      id: 4, team: 'agents', org: 'other-mill', name: 'agents-mill',
    }));
    assert.equal(clash.status, 409);
  });

  it('declines with a reason the person is told, and asks again after 30 days', async () => {
    const w = world();
    await w.list();
    const res = await quiet(() => w.staff(w.admin, 'POST', '/api/admin/portal/integration/decline', {
      id: 1, reason: 'Use your partner channel.',
    }));
    assert.equal(res.status, 200);
    assert.equal(res.body.request.status, 'declined');
    assert.deepEqual(res.body.request.decidedBy, { email: ADMIN.email, name: ADMIN.name });
    assert.deepEqual((await w.list()).body, {
      error: { code: 'not_enrolled', request: 'declined', reason: 'Use your partner channel.' },
    });
    assert.equal((await w.staff(w.admin, 'POST', '/api/admin/portal/integration/approve', { id: 1, team: 'agents' })).status, 409);
    assert.equal((await w.staff(w.admin, 'POST', '/api/admin/portal/integration/decline', { id: 1 })).status, 409);
    const later = now + (DECLINE_TTL + 60) * 1000;
    assert.deepEqual((await w.list({ clock: later, bearer: await w.token({ at: later }) })).body, { error: { code: 'not_enrolled', request: 'pending' } });
    assert.deepEqual(w.announced, [1, 1]);
    const [row] = requests(w);
    assert.deepEqual([row.status, row.reason, row.decided_by], ['pending', null, null]);
  });

  it('is for the admin team only', async () => {
    const w = world();
    await w.list();
    const manager = viewer(MANAGER, 'manager');
    for (const path of ['approve', 'decline']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await w.staff(manager, 'POST', `/api/admin/portal/integration/${path}`, { id: 1, team: 'agents' });
      assert.equal(res.status, 403);
    }
    const listed = await w.staff(manager, 'GET', '/api/admin/requests');
    assert.deepEqual(listed.body.integration, []);
    assert.equal(listed.body.open, 0);
    const entries = (await w.staff(manager, 'GET', '/api/requests')).body.threads;
    assert.ok(!entries.some((e) => e.thread.startsWith('request:integration:')));
    const resolve = await w.staff(manager, 'POST', '/api/requests/resolve', { key: 'request:integration:1', action: 'approve' });
    assert.equal(resolve.status, 404);
    assert.equal(requests(w)[0].status, 'pending');
  });

  it('finishes an approval whose routing failed, and leaves a suspended channel to an operator', async () => {
    const w = world();
    await w.list();
    // The first attempt reserved the channel, then failed before anyone was enrolled.
    const reserved = await platform.reserve(w.portal, {
      id: 1, customer: 'agents-mill', name: 'agents-mill', by: { email: ADMIN.email },
    });
    assert.equal(reserved.ok, true);
    assert.equal((await w.list()).body.error.request, 'pending');
    const [r] = (await w.staff(w.admin, 'GET', '/api/admin/requests')).body.integration;
    assert.deepEqual([r.mapping.enabled, r.mapping.resumable], [false, true]);
    const res = await quiet(() => w.staff(w.admin, 'POST', '/api/admin/portal/integration/approve', { id: 1, team: 'agents', org: 'mill' }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.channel.channelId, reserved.channel.id);
    assert.equal((await w.list()).status, 200);

    // Suspended after it was enabled: a new person's request cannot re-enable it.
    w.db.sqlite.exec('UPDATE integration_customers SET enabled = 0');
    const bo = await w.token({ user: BO });
    assert.equal((await w.list({ bearer: bo })).body.error.request, 'pending');
    const thread = (await w.staff(w.admin, 'GET', '/api/thread?thread=request%3Aintegration%3A2')).body;
    assert.match(thread.request.actions.find((a) => a.id === 'approve').off, /suspended/);
    const refused = await w.staff(w.admin, 'POST', '/api/admin/portal/integration/approve', { id: 2, team: 'agents' });
    assert.equal(refused.status, 409);
    assert.equal(w.db.rows('SELECT enabled FROM integration_customers')[0].enabled, 0);
  });

  it('never claims a subject that has a member row, nor reassigns one', async () => {
    const w = world();
    await w.list();
    const channel = w.handMade('panel', ORG, 'agents-mill', BO);
    // Enrolled by hand meanwhile: the approval stops, and changes nothing.
    w.db.sqlite.prepare('INSERT INTO integration_actors (channel, actor, name) VALUES (?, \'pmanual\', \'Ada\')').run(channel);
    w.db.sqlite.prepare('INSERT INTO integration_members (channel, subject, actor) VALUES (?, ?, \'pmanual\')').run(channel, ADA);
    const res = await w.staff(w.admin, 'POST', '/api/admin/portal/integration/approve', { id: 1 });
    assert.equal(res.status, 409);
    assert.equal(w.db.rows('SELECT COUNT(*) AS n FROM integration_members WHERE subject = ?', ADA)[0].n, 1);
    assert.equal(requests(w)[0].status, 'pending');
  });
});

describe('channel names for integration requests', () => {
  it('suggests <product>-<customer>, short, from the verified mail domain or the organization', () => {
    assert.equal(channelName('agents', customerPart('Adobe Inc.', 'someone@adobe.com')), 'agents-adobe');
    assert.equal(customerPart('Mill Paper Products International Inc. - Marketing (Prod)', null), 'mill-paper-products');
    assert.equal(customerPart('Mill Paper Products International Inc.', 'ada@mill.example'), 'mill');
    assert.equal(customerPart('Mill Paper Products', 'ada@gmail.com'), 'mill-paper-products');
    assert.equal(customerPart(null, 'ada@yahoo.co.uk'), 'customer');
    assert.equal(mailCompany('ada@eu.mill.co.uk'), 'mill');
    assert.equal(channelName(null, 'mill'), 'mill');
    assert.ok(channelName('agents', customerPart('A Really Very Extraordinarily Long Organization Name', null)).length <= 27);
  });
});
