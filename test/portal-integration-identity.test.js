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
import { integration } from '../src/portal/integration.js';
import { BASE } from '../src/portal/integration-auth.js';
import { IMS, resetIdentityCache } from '../src/portal/integration-identity.js';
import { d1, PORTAL } from './d1.js';

// Every identifier here is made up.
const access = 'https://access.example';
const origin = 'https://portal.example';
const scopes = ['threads:create', 'threads:read', 'threads:reply', 'changes:read'];
const now = Date.now();
const sec = Math.floor(now / 1000);
const ORG = '0123456789ABCDEF01234567@AdobeOrg';
const OTHER_ORG = '76543210FEDCBA9876543210@AdobeOrg';
const USER = 'A1B2C3D4E5F6A7B8C9D0E1F2@AdobeID';
const keys = {};

async function keyPair(kid) {
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  return {
    jwk: { kid, ...await crypto.subtle.exportKey('jwk', pair.publicKey) },
    sign: async (claims, header = {}) => {
      const part = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
      const unsigned = `${part({ alg: 'RS256', kid, ...header })}.${part(claims)}`;
      const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(unsigned),
      );
      return `${unsigned}.${Buffer.from(sig).toString('base64url')}`;
    },
  };
}

before(async () => {
  Object.assign(keys, {
    access: await keyPair('first'),
    console: await keyPair('first'),
    prod: await keyPair('ims_na1-key-at-1'),
    rotated: await keyPair('ims_na1-key-at-2'),
    stg1: await keyPair('ims_na1-stg1-key-at-1'),
    // The legacy key both environments publish: it must select neither.
    shared: await keyPair('ims'),
    rogue: await keyPair('ims_na1-key-at-1'),
  });
});
beforeEach(() => resetIdentityCache());

const identity = (environment, clientIds, extra = {}) => JSON.stringify({
  provider: 'adobe-ims',
  environment,
  issuer: IMS[environment].issuer,
  keys: `${IMS[environment].issuer}/ims/keys`,
  clientIds,
  tenant: 'profile.ownerOrg',
  subject: 'token.user_id',
  email: 'profile.email',
  ...extra,
});

function fixture() {
  const db = d1({ migrations: PORTAL });
  const host = (id, environment, clientIds) => db.sqlite.prepare(`INSERT INTO integration_hosts
    (id, service_id, issuer, jwks, scopes, identity) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id,
    `${id}.access`,
    environment ? IMS[environment].issuer : id,
    JSON.stringify({ keys: environment ? [] : [keys.console.jwk] }),
    JSON.stringify(scopes),
    environment ? identity(environment, clientIds) : null,
  );
  host('panel', 'prod', ['panel-web']);
  host('desk', 'prod', ['panel-web']); // another host of the same IMS client
  host('kiosk', 'prod', ['kiosk-web']);
  host('stage', 'stg1', ['panel-web']);
  host('console'); // signs its own assertions
  const enroll = (h, tenant, subject) => {
    const { channel } = db.sqlite.prepare(`INSERT INTO integration_customers
      (host, tenant, customer, name, enabled) VALUES (?, ?, ?, 'Support', 1) RETURNING channel`)
      .get(h, tenant, `mill-${tenant}`);
    const { actor } = db.sqlite.prepare(`INSERT INTO integration_actors(channel, name)
      VALUES (?, 'Member') RETURNING actor`).get(channel);
    db.sqlite.prepare('INSERT INTO integration_members(channel, subject, actor) VALUES (?, ?, ?)')
      .run(channel, subject, actor);
    return channel;
  };
  for (const h of ['panel', 'desk', 'kiosk', 'stage', 'console']) {
    enroll(h, ORG, USER);
  }
  enroll('console', 'account-1', 'ada');
  const env = {
    DB: db, PORTAL_INTEGRATION_AUD: 'integration', ACCESS_TEAM_DOMAIN: access, ACCESS_AUD: 'web',
  };

  // What IMS says of each token; a test changes it to make the provider fail.
  const profiles = new Map();
  const upstream = {
    profile: 0, keys: 0, fail: null, rotated: false,
  };
  async function fetchImpl(url, init) {
    const u = new URL(url);
    if (u.origin === access) {
      return Response.json({ keys: [keys.access.jwk] });
    }
    const environment = Object.keys(IMS).find((e) => IMS[e].issuer === u.origin);
    assert.ok(environment, `no request to ${u.origin}`);
    assert.equal(init.redirect, 'manual');
    if (u.pathname === '/ims/keys') {
      upstream.keys += 1;
      if (upstream.fail === 'keys') {
        return new Response('', { status: 502 });
      }
      const published = [keys[environment].jwk, keys.shared.jwk];
      return Response.json({ keys: [...published, ...upstream.rotated ? [keys.rotated.jwk] : []] });
    }
    if (u.pathname === '/ims/organizations/v6') {
      // Signed in without `read_organizations`: an access request has no organization name.
      return Response.json({ error: 'insufficient_scope' }, { status: 403 });
    }
    assert.equal(u.pathname, '/ims/profile/v1');
    upstream.profile += 1;
    if (upstream.fail === 'network') {
      throw new TypeError('fetch failed');
    }
    if (upstream.fail === 'status') {
      return new Response('', { status: 500 });
    }
    if (upstream.fail === 'html') {
      return new Response('<html>', { status: 200 });
    }
    const sent = /^Bearer (.+)$/.exec(init.headers.authorization)?.[1];
    const profile = profiles.get(sent);
    if (!profile || upstream.fail === 'revoked') {
      return Response.json({ error: 'invalid_token' }, { status: 401 });
    }
    return Response.json(profile);
  }

  async function token({
    signer = 'prod', environment = 'prod', header, claims, profile,
  } = {}) {
    const t = await keys[signer].sign({
      id: crypto.randomUUID(),
      type: 'access_token',
      client_id: 'panel-web',
      user_id: USER,
      as: IMS[environment].as,
      created_at: String(now - 60000),
      expires_in: '86400000',
      scope: 'AdobeID,openid,additional_info.ownerOrg',
      ...claims,
    }, header);
    profiles.set(t, {
      userId: USER,
      ownerOrg: ORG,
      email: 'ada@mill.example',
      emailVerified: 'true',
      displayName: 'Ada Example',
      ...profile,
    });
    return t;
  }

  async function call(method, path, {
    host: via = 'panel', bearer, service, headers = {}, body, key = 'request', clock = now,
  } = {}) {
    const seconds = Math.floor(clock / 1000);
    const req = new Request(new URL(`${origin}${BASE}${path}`), {
      method,
      headers: {
        'cf-access-jwt-assertion': await keys.access.sign({
          type: 'app',
          common_name: `${via}.access`,
          sub: '',
          aud: ['integration'],
          iss: access,
          exp: seconds + 100,
          ...service,
        }),
        authorization: `Bearer ${bearer ?? await token()}`,
        'content-type': 'application/json',
        'idempotency-key': key,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await integration(req, env, { now: clock, fetchImpl });
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    return { status: res.status, ...await res.json() };
  }
  const create = (opts) => call('POST', '/threads', { body: { title: 'Preview', body: 'Please check.' }, ...opts });
  const list = (opts) => call('GET', '/threads', opts);
  return {
    db, env, call, create, list, token, profiles, upstream, enroll,
  };
}

describe('registered portal hosts with a trusted identity provider', () => {
  it('takes the tenant and subject from the verified IMS user, never from the host', async () => {
    const {
      db, create, list, call, token,
    } = fixture();
    const bearer = await token();
    const first = await create({
      bearer,
      headers: { 'x-tenant': OTHER_ORG, 'x-subject': 'someone@AdobeID', 'x-portal-identity': 'ims' },
    });
    assert.equal(first.status, 201);
    const [{ channel }] = db.rows("SELECT channel FROM integration_customers WHERE host = 'panel'");
    assert.equal(first.channelId, channel);
    assert.equal((await create({ bearer })).status, 200); // the same request, again
    assert.equal((await create({ bearer, body: { title: 'Other', body: 'Different' } })).status, 409);
    const page = await list({ bearer });
    assert.deepEqual(page.items.map((i) => i.id), [first.threadId]);
    const reply = await call('POST', `/threads/${first.threadId}/replies`, { bearer, body: { body: 'More' } });
    assert.equal(reply.status, 201);
    assert.equal((await call('GET', `/changes?after=${page.changeCursor}`, { bearer })).events.length, 1);
    // A token of the same user that IMS issued for another organization's profile.
    const elsewhere = await token({ profile: { ownerOrg: OTHER_ORG } });
    assert.equal((await list({ bearer: elsewhere })).status, 403);
  });

  it('refuses tokens of another issuer, environment or client, and expired or malformed ones', async () => {
    const { list, token, profiles } = fixture();
    const good = await token();
    const [h, p] = good.split('.');
    const unsigned = Buffer.from(JSON.stringify({ alg: 'none', kid: 'ims_na1-key-at-1' })).toString('base64url');
    const expired = { created_at: String(now - 86400000), expires_in: '86400000' };
    for (const bearer of [
      await token({ environment: 'stg1' }), // stg1's `as` on a prod key
      await token({ signer: 'stg1', environment: 'stg1' }), // a stg1 token at a prod host
      await token({ signer: 'shared' }), // the key both environments publish
      await token({ signer: 'rogue' }), // the right kid, not IMS's key
      await token({ claims: { iss: 'https://ims.example' } }),
      await token({ claims: { as: undefined } }),
      await token({ claims: { client_id: 'kiosk-web' } }),
      await token({ claims: { client_id: undefined } }),
      await token({ claims: expired }),
      await token({ claims: { created_at: String(now + 120000) } }),
      await token({ claims: { created_at: undefined } }),
      await token({ claims: { expires_in: '-1' } }),
      await token({ claims: { expires_in: 86400.5 } }),
      await token({ claims: { type: 'refresh_token' } }),
      await token({ claims: { type: 'id_token' } }),
      await token({ claims: { user_id: '' } }),
      await token({ header: { alg: 'HS256' } }),
      await token({ header: { kid: 'ims_na1-key-1' } }),
      `${unsigned}.${p}.`, `${h}.${p}`, 'not-a-token', `${h}.${p}.${'A'.repeat(342)}`,
      `${'a'.repeat(16385)}`,
    ]) {
      if (!profiles.has(bearer)) {
        profiles.set(bearer, { userId: USER, ownerOrg: ORG });
      }
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await list({ bearer })).status, 401);
    }
    assert.equal((await list({ bearer: good })).status, 200);
    // Valid until created_at + expires_in, then not, also when its verification is cached.
    const short = await token({ claims: { created_at: String(now), expires_in: '1000' } });
    assert.equal((await list({ bearer: short })).status, 200);
    assert.equal((await list({ bearer: short, clock: now + 1000 })).status, 401);
    assert.equal((await list({ host: 'stage', bearer: await token({ signer: 'stg1', environment: 'stg1' }) })).status, 200);
  });

  it('needs Access service auth and a host that opted in to this provider and client', async () => {
    const { list, token, call } = fixture();
    const bearer = await token();
    for (const opts of [
      { headers: { 'cf-access-jwt-assertion': '' } },
      { service: { common_name: 'unregistered' } },
      { service: { type: 'org', sub: USER, email: 'ada@mill.example' } },
      { service: { aud: 'web' } },
      { host: 'console' }, // no provider: an IMS token is not an assertion
      { host: 'kiosk' }, // another client
      { host: 'stage' }, // another environment
    ]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await list({ bearer, ...opts })).status, 401);
    }
    assert.equal((await call('GET', '/threads', { bearer: '' })).status, 401);
    assert.equal((await list({ bearer, host: 'kiosk' })).status, 401);
    assert.equal((await list({ bearer: await token({ claims: { client_id: 'kiosk-web' } }), host: 'kiosk' })).status, 200);
  });

  it('keeps two hosts of the same IMS user and organization apart', async () => {
    const {
      create, list, call, token,
    } = fixture();
    const bearer = await token();
    const mine = await create({ bearer });
    const theirs = await create({ bearer, host: 'desk' });
    assert.deepEqual([mine.status, theirs.status], [201, 201]);
    assert.notEqual(mine.channelId, theirs.channelId);
    assert.deepEqual((await list({ bearer })).items.map((i) => i.id), [mine.threadId]);
    assert.deepEqual((await list({ bearer, host: 'desk' })).items.map((i) => i.id), [theirs.threadId]);
    for (const [method, path, body] of [
      ['GET', `/threads/${mine.threadId}`],
      ['POST', `/threads/${mine.threadId}/replies`, { body: 'Wrong' }],
      ['PUT', `/threads/${mine.threadId}/read`, { through: mine.threadId }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await call(method, path, { bearer, body, host: 'desk' })).status, 404);
    }
    const { changeCursor } = await list({ bearer });
    assert.equal((await call('GET', `/changes?after=${changeCursor}`, { bearer, host: 'desk' })).status, 400);
  });

  it('answers 503 when IMS cannot be asked, and 401 when it rejects the token', async () => {
    const {
      list, token, upstream,
    } = fixture();
    const bearer = await token();
    const warned = [];
    const { warn } = console;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      for (const fail of ['network', 'status', 'html']) {
        upstream.fail = fail;
        // eslint-disable-next-line no-await-in-loop
        assert.equal((await list({ bearer })).status, 503);
      }
      upstream.fail = null;
      assert.equal((await list({ bearer })).status, 200); // a failure is not kept
      resetIdentityCache();
      upstream.fail = 'keys';
      assert.equal((await list({ bearer })).status, 503);
      upstream.fail = null;
      resetIdentityCache();
      upstream.fail = 'revoked';
      assert.equal((await list({ bearer })).status, 401);
    } finally {
      console.warn = warn;
    }
    assert.ok(warned.length > 0);
    assert.ok(warned.every((w) => !w.includes(bearer) && !w.includes(bearer.split('.')[1])));
  });

  it('caches verification and profiles briefly, and rechecks enrollment on every call', async () => {
    const {
      db, list, token, upstream,
    } = fixture();
    const bearer = await token();
    assert.equal((await list({ bearer })).status, 200);
    assert.equal((await list({ bearer, clock: now + 59000 })).status, 200);
    assert.deepEqual([upstream.keys, upstream.profile], [1, 1]);
    assert.equal((await list({ bearer, clock: now + 61000 })).status, 200);
    assert.equal(upstream.profile, 2);
    upstream.fail = 'revoked';
    assert.equal((await list({ bearer, clock: now + 122000 })).status, 401);
    upstream.fail = null;
    // A key IMS rotated in is fetched, at most once a minute.
    upstream.rotated = true;
    const rotated = await token({ signer: 'rotated' });
    assert.equal((await list({ bearer: rotated, clock: now + 30000 })).status, 401);
    assert.equal((await list({ bearer: rotated, clock: now + 130000 })).status, 200);
    assert.equal((await list({ bearer: rotated, clock: now + 140000 })).status, 200);
    assert.equal(upstream.keys, 2);
    db.sqlite.exec(`UPDATE integration_members SET active = 0 WHERE channel IN
      (SELECT channel FROM integration_customers WHERE host = 'panel')`);
    assert.equal((await list({ bearer: rotated, clock: now + 141000 })).status, 403);
  });

  it('enrolls and limits exactly as with assertions', async () => {
    const {
      db, list, token, create,
    } = fixture();
    const status = async (t) => (await list({ bearer: await token(t) })).status;
    assert.equal(await status({ profile: { ownerOrg: null } }), 403);
    assert.equal(await status({ profile: { ownerOrg: 'not an org' } }), 403);
    const stranger = 'FFFFFFFFFFFFFFFFFFFFFFFF@AdobeID';
    const unknown = { claims: { user_id: stranger }, profile: { userId: stranger } };
    assert.equal(await status(unknown), 403);
    // Recorded as an access request for the admin team (test/portal-integration-requests.test.js).
    assert.deepEqual((await list({ bearer: await token(unknown) })).error, { code: 'not_enrolled', request: 'pending' });
    assert.equal(db.rows('SELECT org_name FROM integration_requests')[0].org_name, null);
    assert.equal(await status({ profile: { userId: stranger } }), 401);
    // An alias enrollment takes only the verified email of the IMS profile.
    db.sqlite.exec(`UPDATE integration_actors SET verified_email = 'ada@mill.example'
      WHERE channel IN (SELECT channel FROM integration_customers WHERE host = 'panel')`);
    assert.equal((await list({ bearer: await token({ profile: { emailVerified: 'false' } }) })).status, 403);
    assert.equal((await list({ bearer: await token({ profile: { email: 'bo@mill.example' } }) })).status, 403);
    assert.equal((await create({ bearer: await token({ profile: { email: 'Ada@Mill.example' } }) })).status, 201);
    const bearer = await token();
    for (let i = 1; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await list({ bearer })).status, 200);
    }
    assert.equal((await list({ bearer })).status, 429);
    assert.equal((await list({ bearer, host: 'desk' })).status, 200);
    db.sqlite.exec("UPDATE integration_hosts SET scopes = '[\"threads:create\"]' WHERE id = 'desk'");
    assert.equal((await list({ bearer, host: 'desk' })).status, 403);
  });

  it('keeps one mode per host: assertions still pass, and never for a provider host', async () => {
    const { db, call } = fixture();
    const assertion = async (host, claims = {}) => keys.console.sign({
      iss: host === 'console' ? 'console' : IMS.prod.issuer,
      aud: 'integration',
      iat: sec,
      exp: sec + 45,
      jti: crypto.randomUUID(),
      tenant: 'account-1',
      sub: 'ada',
      method: 'GET',
      path: `${BASE}/threads`,
      scope: 'threads:read',
      ...claims,
    });
    assert.equal((await call('GET', '/threads', { host: 'console', bearer: await assertion('console') })).status, 200);
    assert.equal((await call('GET', '/threads', { host: 'panel', bearer: await assertion('panel') })).status, 401);
    assert.throws(() => db.sqlite.exec(`UPDATE integration_hosts
      SET jwks = '${JSON.stringify({ keys: [keys.console.jwk] })}' WHERE id = 'panel'`), /no assertion keys/);
    assert.throws(() => db.sqlite.exec(`UPDATE integration_hosts
      SET identity = '${identity('prod', ['panel-web'])}' WHERE id = 'console'`), /no assertion keys/);
    assert.throws(() => db.sqlite.exec("UPDATE integration_hosts SET identity = '{' WHERE id = 'panel'"));
  });

  it('authorizes nobody through a provider configuration it does not know', async () => {
    const { db, list, token } = fixture();
    const bearer = await token();
    const { warn } = console;
    console.warn = () => {};
    try {
      for (const extra of [
        { environment: 'dev' }, { provider: 'other' }, { issuer: IMS.stg1.issuer },
        { keys: 'https://keys.example/ims/keys' }, { clientIds: [] }, { clientIds: 'panel-web' },
        { tenant: 'token.org' }, { subject: 'profile.email' }, { email: 'token.email' },
        { audience: 'anything' },
      ]) {
        db.sqlite.prepare("UPDATE integration_hosts SET identity = ? WHERE id = 'panel'")
          .run(identity('prod', ['panel-web'], extra));
        // eslint-disable-next-line no-await-in-loop
        assert.equal((await list({ bearer })).status, 401);
      }
      db.sqlite.prepare("UPDATE integration_hosts SET identity = ?, issuer = 'panel' WHERE id = 'panel'")
        .run(identity('prod', ['panel-web']));
      assert.equal((await list({ bearer })).status, 401);
    } finally {
      console.warn = warn;
    }
  });
});
