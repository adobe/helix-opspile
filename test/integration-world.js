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

/**
 * The inbox and the portal of the integration tests (test/portal-integration-requests.test.js,
 * test/portal-integration-auto.test.js), each with its own database, wired as their Workers are.
 * Not a test itself: it registers the key pairs' `before` and the caches' `beforeEach` of the
 * file that imports it.
 */

import assert from 'node:assert/strict';
import { before, beforeEach } from 'node:test';
import { api } from '../src/api.js';
import { integration } from '../src/portal/integration.js';
import { BASE } from '../src/portal/integration-auth.js';
import { IMS, resetIdentityCache } from '../src/portal/integration-identity.js';
import * as platform from '../src/portal/platform.js';
import { d1, PORTAL } from './d1.js';
import { fakeBucket } from './fakes.js';

// Every identifier, name and address here is made up.
export const access = 'https://access.example';
const origin = 'https://portal.example';
const scopes = ['threads:create', 'threads:read', 'threads:reply', 'changes:read'];
export const now = Date.now();
export const ORG = '0123456789ABCDEF01234567@AdobeOrg';
export const OTHER_ORG = '76543210FEDCBA9876543210@AdobeOrg';
export const ADA = 'A1B2C3D4E5F6A7B8C9D0E1F2@AdobeID';
export const BO = 'B1B2C3D4E5F6A7B8C9D0E1F2@AdobeID';
export const ADMIN = {
  id: 1, email: 'ada.admin@staff.example', name: 'Ada Admin', staff: 1, teams: ['admin'],
};
export const MANAGER = {
  id: 2, email: 'max@staff.example', name: 'Max Manager', staff: 1, teams: ['agents'],
};
export const viewer = (p, role = 'member') => ({ ...p, teams: p.teams.map((slug) => ({ slug, role })) });
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

/** Registers the key pairs and the caches' reset with the importing test file. */
export function setup() {
  before(async () => {
    Object.assign(keys, {
      access: await keyPair('first'),
      console: await keyPair('first'),
      prod: await keyPair('ims_na1-key-at-1'),
    });
  });
  beforeEach(() => resetIdentityCache());
}

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
export function world() {
  const announced = [];
  // The time the portal's platform calls see (`time.now`).
  const time = { now };
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
      accessRequested: async ({ id, channel }) => {
        announced.push(id ?? channel);
        return { ok: true };
      },
    },
  };
  inbox.PORTAL = {
    accessRequests: (a) => platform.accessRequests(portal, a),
    reserveAccess: (a) => platform.reserve(portal, a),
    enrollAccess: (a) => platform.enroll(portal, a),
    declineAccess: (a) => platform.declineRequest(portal, a),
    accessChannels: (a) => platform.accessChannels(portal, a, time.now),
    setAutoApprove: (a) => platform.autoApprove(portal, a, time.now),
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

  /** An enabled mapping made by hand, as an operator did, with one member (`subject`, if any). */
  function handMade(host, tenant, name, subject) {
    const { channel } = db.sqlite.prepare(`INSERT INTO integration_customers (host, tenant, customer,
      name, enabled) VALUES (?, ?, ?, ?, 1) RETURNING channel`).get(host, tenant, name, name);
    if (subject) {
      const { actor } = db.sqlite.prepare(`INSERT INTO integration_actors (channel, name)
        VALUES (?, 'Member') RETURNING actor`).get(channel);
      db.sqlite.prepare('INSERT INTO integration_members (channel, subject, actor) VALUES (?, ?, ?)')
        .run(channel, subject, actor);
    }
    for (const [target, value] of [['team', 'agents'], ['org', 'mill']]) {
      inbox.DB.sqlite.prepare(`INSERT INTO rules (target, priority, source, field, pattern, value, note)
        VALUES (?, 10, 'portal', 'channel_id', ?, ?, 'manual assignment')`).run(target, `^${channel}$`, value);
    }
    return channel;
  }

  return {
    inbox, portal, db, call, list, token, staff, admin, announced, upstream, handMade, time,
  };
}

/** A signed assertion of the `console` host (which signs its own), for `GET /threads`. */
export const consoleAssertion = (claims = {}) => {
  const sec = Math.floor(now / 1000);
  return keys.console.sign({
    iss: 'console', aud: 'integration', iat: sec, exp: sec + 45, jti: crypto.randomUUID(), tenant: 'account-1', sub: 'ada', method: 'GET', path: `${BASE}/threads`, scope: 'threads:read', ...claims,
  });
};
