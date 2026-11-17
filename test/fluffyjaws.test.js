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
import { createHash } from 'node:crypto';
import {
  after, before, beforeEach, describe, it,
} from 'node:test';
import { api } from '../src/api.js';
import { refreshGlobalTools } from '../src/mcpadmin.js';
import { AgentMcp } from '../src/agent/mcp.js';
import { serversFor, serverWithHeaders } from '../src/agent/mcpclient.js';
import { FLUFFYJAWS_MCP_URL, forgetFluffyjaws, freshGrantToken } from '../src/agent/fluffyjaws.js';
import { d1 } from './d1.js';
import { fakeMcpServers } from './mcp-server.js';

// FluffyJaws' MCP server and its Okta authorization server, in memory. Made-up people, teams,
// orgs, channels, issuer, client ids, secrets and tokens only.
const KEY = Buffer.alloc(32, 7).toString('base64url');
const ORIGIN = 'https://opspile.example';
const ISSUER = 'https://okta.example/oauth2/aus-made-up';
const CLIENT_ID = 'made-up-public-client';
const SERVICE_ID = 'made-up-service-client';
const SERVICE_SECRET = 'made-up-service-secret';
const CALLBACK = `${ORIGIN}/api/kb/mcp/oauth/callback`;

const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin', 'helix'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
};
const CY = {
  id: 3, email: 'cy@staff.example', name: 'Cy', staff: 1, teams: ['admin'],
};
const asMe = (p, roles = {}) => ({ ...p, teams: p.teams.map((slug) => ({ slug, role: roles[slug] || 'member' })) });
const admin = asMe(ADA);
const otherAdmin = asMe(CY);
const manager = asMe(BO, { helix: 'manager' });

const b64url = (s) => Buffer.from(s).toString('base64url');
const idToken = (claims) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.made-up-signature`;
const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url');

/** Okta, as far as opspile asks it: the token and revocation endpoints. */
const OKTA = {
  codes: new Map(), // code → its authorization request's params
  refresh: new Set(), // refresh tokens it still accepts (rotated on use)
  access: new Set(), // access tokens FluffyJaws accepts
  grants: [], // the grant_type of every token request
  revoked: [],
  issued: 0,
  expiresIn: 3600,
};

function issue({ refresh = true, scope = 'openid profile email offline_access' } = {}) {
  OKTA.issued += 1;
  const n = OKTA.issued;
  const access = `made-up-access-${n}`;
  OKTA.access.add(access);
  const body = {
    token_type: 'Bearer', expires_in: OKTA.expiresIn, access_token: access, scope,
  };
  if (refresh) {
    const r = `made-up-refresh-${n}`;
    OKTA.refresh.add(r);
    body.refresh_token = r;
    body.id_token = idToken({
      iss: ISSUER, aud: CLIENT_ID, sub: '00u-made-up', email: 'ada.okta@corp.example', name: 'Ada Okta',
    });
  }
  return body;
}

async function okta(request) {
  const url = new URL(request.url);
  const reply = (body, status = 200) => Response.json(body, { status });
  const form = Object.fromEntries(new URLSearchParams(await request.text()));
  if (url.pathname === '/oauth2/aus-made-up/v1/revoke') {
    OKTA.revoked.push(form.token);
    OKTA.refresh.delete(form.token);
    OKTA.access.delete(form.token);
    return new Response(null, { status: 200 });
  }
  if (url.pathname !== '/oauth2/aus-made-up/v1/token' || request.method !== 'POST') {
    return reply({ errorCode: 'E0000022' }, 404);
  }
  OKTA.grants.push(form.grant_type);
  if (form.grant_type === 'authorization_code') {
    const asked = OKTA.codes.get(form.code);
    OKTA.codes.delete(form.code);
    if (!asked || form.client_id !== CLIENT_ID || form.redirect_uri !== asked.redirect_uri
      || challengeOf(form.code_verifier || '') !== asked.code_challenge) {
      return reply({ error: 'invalid_grant', error_description: 'The authorization code is invalid or has expired.' }, 400);
    }
    return reply(issue());
  }
  if (form.grant_type === 'refresh_token') {
    if (form.client_id !== CLIENT_ID || !OKTA.refresh.has(form.refresh_token)) {
      return reply({ error: 'invalid_grant', error_description: 'The refresh token is invalid or expired.' }, 400);
    }
    OKTA.refresh.delete(form.refresh_token);
    return reply(issue());
  }
  if (form.grant_type === 'client_credentials') {
    const basic = `Basic ${Buffer.from(`${SERVICE_ID}:${SERVICE_SECRET}`).toString('base64')}`;
    if (request.headers.get('authorization') !== basic) {
      return reply({ error: 'invalid_client' }, 401);
    }
    if (form.scope !== 'fluffyjaws') {
      return reply({ error: 'invalid_scope' }, 400);
    }
    return reply(issue({ refresh: false, scope: 'fluffyjaws' }));
  }
  return reply({ error: 'unsupported_grant_type' }, 400);
}

/** The browser at Okta's sign-in: signs in, and Okta sends it back with a code. */
function signIn(authorizationUrl, code = 'good-code') {
  const u = new URL(authorizationUrl);
  OKTA.codes.set(code, Object.fromEntries(u.searchParams));
  return `/api/kb/mcp/oauth/callback?code=${code}&state=${encodeURIComponent(u.searchParams.get('state'))}`;
}

const TOOLS = ['fluffyjaws_chat', 'search_fluffypack', 'jira_search', 'content_compass_recommend'];
const FLUFFY = fakeMcpServers([{
  url: FLUFFYJAWS_MCP_URL,
  name: 'FluffyJaws 3.0',
  tools: TOOLS.map((name) => ({
    name,
    description: `${name}, made up`,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    readOnly: name !== 'content_compass_recommend',
    run: ({ query }) => `${name}: ${query}`,
  })),
}]);
const seen = [];

/** FluffyJaws' MCP server: a bearer Okta issued, else 401. */
function fluffyjaws(request) {
  seen.push(Object.fromEntries(request.headers));
  const token = String(request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!OKTA.access.has(token)) {
    return new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } });
  }
  return FLUFFY.fetch(request);
}

// Everything logged, to check that no token is.
const logs = [];
const realFetch = globalThis.fetch;
const realLog = console.log;
before(() => {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith('https://okta.example/')) {
      return okta(request);
    }
    if (FLUFFY.handles(request.url)) {
      return fluffyjaws(request);
    }
    return realFetch(input, init);
  };
  console.log = (...args) => logs.push(args.join(' '));
});
after(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  const all = logs.join('\n');
  assert.ok(!/made-up-(access|refresh)|made-up-service-secret/.test(all), 'no token in the logs');
});
beforeEach(() => {
  forgetFluffyjaws();
  OKTA.codes.clear();
  OKTA.refresh.clear();
  OKTA.access.clear();
  OKTA.grants.length = 0;
  OKTA.revoked.length = 0;
  OKTA.issued = 0;
  OKTA.expiresIn = 3600;
  seen.length = 0;
});

function env({ grant = true, service = false, issuer = true } = {}) {
  const DB = d1({
    people: [ADA, BO, CY],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }],
  });
  DB.sqlite.prepare(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
    VALUES ('kb-team-helix', 'team', 'helix', 'test', '2026-10-22T00:00:00Z')`).run();
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      kind, channel_name, path, last_at, updated_at) VALUES ('slack:E1:C1:1.0', 'slack', 'E1', 'C1',
      '1.0', 'acme', 'helix', 'channel', 'aem-acme', 'p/', '2026-10-25T10:00:00Z',
      '2026-10-25T10:00:00Z')`).run();
  return {
    DB,
    TOKEN_KEY: KEY,
    PUBLIC_ORIGIN: ORIGIN,
    ...(issuer ? { FLUFFYJAWS_ISSUER: ISSUER } : {}),
    ...(grant ? { FLUFFYJAWS_CLIENT_ID: CLIENT_ID } : {}),
    ...(service ? {
      FLUFFYJAWS_SERVICE_CLIENT_ID: SERVICE_ID, FLUFFYJAWS_SERVICE_SECRET: SERVICE_SECRET,
    } : {}),
  };
}

async function call(e, me, method, path, body) {
  const url = `${ORIGIN}${path}`;
  const request = new Request(url, {
    method,
    redirect: 'manual',
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const res = await api(request, e, new URL(url), { viewer: me });
  const type = res.headers.get('content-type') || '';
  return {
    status: res.status,
    location: res.headers.get('location'),
    body: type.includes('json') ? await res.json() : await res.text(),
  };
}

const fluffyOf = async (e, me = admin) => (await call(e, me, 'GET', '/api/kb/mcp?repo=kb-team-helix'))
  .body.globals.find((g) => g.server === 'fluffyjaws');

function memoryStorage() {
  const m = new Map();
  return {
    get: async (k) => structuredClone(m.get(k)),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
  };
}

/** Connects FluffyJaws as the admin team's Ada, through Okta: the callback's response. */
async function connect(e, me = admin) {
  const started = await call(e, me, 'POST', '/api/kb/mcp/global/connect', { server: 'fluffyjaws', repo: 'kb-team-helix' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return call(e, me, 'GET', signIn(started.body.authorizationUrl));
}

describe('the global FluffyJaws server, set up', () => {
  it('is listed, off and not set up until the deployment names its Okta', async () => {
    const g = await fluffyOf(env({ issuer: false, grant: false }));
    assert.equal(g.title, 'FluffyJaws');
    assert.equal(g.available, false);
    assert.match(g.problem, /FLUFFYJAWS_ISSUER/);
    assert.deepEqual(g.team, { enabled: false }, 'off for new and old teams alike');
  });

  it('waits for the admin team to connect it, and only the admin team may', async () => {
    const e = env();
    const g = await fluffyOf(e);
    assert.equal(g.available, false);
    assert.match(g.problem, /Nobody connected FluffyJaws yet/);
    assert.equal(g.fluffyjaws.mode, 'grant');
    assert.equal(g.fluffyjaws.connected, false);
    assert.equal(g.fluffyjaws.mayConnect, true);
    assert.equal((await fluffyOf(e, manager)).fluffyjaws.mayConnect, false);
    const refused = await call(e, manager, 'POST', '/api/kb/mcp/global/connect', { server: 'fluffyjaws', repo: 'kb-team-helix' });
    assert.equal(refused.status, 403);
    assert.equal((await call(e, admin, 'POST', '/api/kb/mcp/global/connect', { server: 'browser' })).status, 400);
  });

  it('signs in at FluffyJaws\' Okta with opspile\'s client and PKCE, never registering one', async () => {
    const e = env();
    const started = await call(e, admin, 'POST', '/api/kb/mcp/global/connect', { server: 'fluffyjaws', repo: 'kb-team-helix' });
    const u = new URL(started.body.authorizationUrl);
    assert.equal(`${u.origin}${u.pathname}`, `${ISSUER}/v1/authorize`);
    const q = Object.fromEntries(u.searchParams);
    assert.equal(q.client_id, CLIENT_ID);
    assert.equal(q.response_type, 'code');
    assert.equal(q.redirect_uri, CALLBACK);
    assert.equal(q.scope, 'openid profile email offline_access');
    assert.equal(q.code_challenge_method, 'S256');
    assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(q.state.length >= 32);
    const [row] = e.DB.rows('SELECT * FROM mcp_global_grants');
    assert.equal(row.server, 'fluffyjaws');
    assert.equal(row.tokens, null);
    assert.ok(!row.pending.includes(q.state) && row.pending_state !== q.state, 'the state is kept hashed');
  });

  it('keeps the grant sealed, says whose identity agents use, and lists the tools but the writing one', async () => {
    const e = env();
    const back = await connect(e);
    assert.equal(back.status, 302);
    assert.equal(back.location, '/inbox/kb?repo=kb-team-helix&view=mcp&mcp_global_connected=fluffyjaws');
    assert.deepEqual(OKTA.grants, ['authorization_code']);
    const [row] = e.DB.rows('SELECT * FROM mcp_global_grants');
    assert.ok(!JSON.stringify(row).includes('made-up-'), 'no token in the clear');
    assert.equal(row.pending, null);
    assert.equal(row.acts_as, 'ada.okta@corp.example');
    assert.equal(row.connected_by, 'ada@staff.example');

    const g = await fluffyOf(e, manager);
    assert.equal(g.available, true);
    assert.equal(g.problem, null);
    assert.deepEqual(g.instances.map((i) => i.name), ['fluffyjaws']);
    assert.deepEqual(g.instances[0].tools.map((t) => t.name), ['fluffyjaws_chat', 'search_fluffypack', 'jira_search']);
    assert.equal(g.instances[0].checkError, null);
    assert.deepEqual(
      { ...g.fluffyjaws, at: null },
      {
        mode: 'grant',
        connected: true,
        actsAs: 'ada.okta@corp.example',
        actsAsName: 'Ada Okta',
        by: 'ada@staff.example',
        at: null,
        error: null,
        mayConnect: false,
      },
    );
  });

  it('is finished only by whoever started it, from the admin team', async () => {
    const e = env();
    const started = await call(e, admin, 'POST', '/api/kb/mcp/global/connect', { server: 'fluffyjaws', repo: 'kb-team-helix' });
    const path = signIn(started.body.authorizationUrl);
    assert.equal((await call(e, manager, 'GET', path)).status, 400);
    const stranger = await call(e, otherAdmin, 'GET', path);
    assert.equal(stranger.status, 302);
    assert.match(new URL(stranger.location, ORIGIN).searchParams.get('mcp_error'), /started by someone else/);
    assert.deepEqual(OKTA.grants, [], 'the code was never redeemed');
    assert.equal((await call(e, admin, 'GET', path)).status, 400, 'used up');
    assert.equal((await fluffyOf(e)).available, false);

    const denied = await call(e, admin, 'POST', '/api/kb/mcp/global/connect', { server: 'fluffyjaws', repo: 'kb-team-helix' });
    const state = new URL(denied.body.authorizationUrl).searchParams.get('state');
    const no = await call(e, admin, 'GET', `/api/kb/mcp/oauth/callback?error=access_denied&error_description=User+is+not+assigned&state=${state}`);
    assert.match(new URL(no.location, ORIGIN).searchParams.get('mcp_error'), /User is not assigned/);
  });
});

describe('the global FluffyJaws server in thread agents', () => {
  it('calls FluffyJaws as the person who connected it, with a token refreshed before five minutes are left', async () => {
    const e = env();
    await connect(e);
    await call(e, admin, 'PUT', '/api/kb/mcp/global', { server: 'fluffyjaws', team: 'helix', enabled: true });
    assert.deepEqual((await serversFor(e, { team: 'helix', channelId: 'C1' })).map((s) => s.id), ['global:fluffyjaws']);
    const mcp = new AgentMcp(e, memoryStorage());
    const { catalog } = await mcp.refresh({ team: 'helix', org: 'acme', channelId: 'C1' });
    const [server] = catalog.servers;
    assert.equal(server.ns, 'fluffyjaws');
    assert.deepEqual(server.tools.map((t) => t.name), ['fluffyjaws_chat', 'search_fluffypack', 'jira_search']);
    assert.match(server.instructions, /as the person who connected it/);
    assert.ok(!JSON.stringify(catalog).includes('made-up-'), 'no token in the catalog');

    seen.length = 0;
    const res = await mcp.call(server, 'search_fluffypack', { query: 'dispatcher' });
    assert.equal(res.content[0].text, 'search_fluffypack: dispatcher');
    assert.ok(seen.every((h) => h.authorization === 'Bearer made-up-access-1'));
    assert.ok(seen.every((h) => !('x-fluffyjaws-end-user' in h)), 'a person, not an automation');

    // Four minutes left: FluffyJaws would refuse it, so the next connection gets a fresh one.
    e.DB.sqlite.prepare('UPDATE mcp_global_grants SET expires_at = ?').run(new Date(Date.now() + 4 * 60_000).toISOString());
    mcp.drop(server.id);
    seen.length = 0;
    await mcp.call(server, 'jira_search', { query: 'SITES-1' });
    assert.deepEqual(OKTA.grants, ['authorization_code', 'refresh_token']);
    assert.ok(seen.every((h) => h.authorization === 'Bearer made-up-access-2'));
    assert.ok(!OKTA.refresh.has('made-up-refresh-1'), 'Okta rotated the refresh token');
    const conn = await serverWithHeaders(e, 'global:fluffyjaws');
    assert.equal(conn.url, FLUFFYJAWS_MCP_URL);
    assert.equal(await conn.authProvider.token(), 'made-up-access-2', 'the rotated one is kept');
  });

  it('refreshes once for every agent at a time', async () => {
    const e = env();
    await connect(e);
    e.DB.sqlite.prepare('UPDATE mcp_global_grants SET expires_at = ?').run(new Date(Date.now() + 60_000).toISOString());
    const got = await Promise.all([freshGrantToken(e), freshGrantToken(e), freshGrantToken(e)]);
    assert.deepEqual(got.map((g) => g.token), ['made-up-access-2', 'made-up-access-2', 'made-up-access-2']);
    assert.deepEqual(OKTA.grants, ['authorization_code', 'refresh_token']);
  });

  it('refreshes when FluffyJaws refuses the token, and drops a grant Okta no longer accepts', async () => {
    const e = env();
    await connect(e);
    // Revoked at Okta behind opspile's back: FluffyJaws says 401, the provider refreshes.
    OKTA.access.delete('made-up-access-1');
    const conn = await serverWithHeaders(e, 'global:fluffyjaws');
    await conn.authProvider.token();
    await conn.authProvider.onUnauthorized();
    assert.equal(await conn.authProvider.token(), 'made-up-access-2');

    OKTA.refresh.clear();
    e.DB.sqlite.prepare('UPDATE mcp_global_grants SET expires_at = ?').run(new Date(Date.now() + 60_000).toISOString());
    await assert.rejects(freshGrantToken(e), /no longer accepts the sign-in \(invalid_grant\)/);
    const g = await fluffyOf(e);
    assert.equal(g.available, false);
    assert.match(g.problem, /invalid_grant/);
    assert.equal(g.fluffyjaws.connected, false);
    assert.match(g.fluffyjaws.error, /connects FluffyJaws again/);
  });

  it('is disconnected by the admin team: revoked at Okta and forgotten', async () => {
    const e = env();
    await connect(e);
    assert.equal((await call(e, manager, 'POST', '/api/kb/mcp/global/disconnect', { server: 'fluffyjaws' })).status, 403);
    const off = await call(e, admin, 'POST', '/api/kb/mcp/global/disconnect', { server: 'fluffyjaws', repo: 'kb-team-helix' });
    assert.equal(off.status, 200);
    assert.deepEqual(OKTA.revoked.sort(), ['made-up-access-1', 'made-up-refresh-1']);
    assert.equal(off.body.global.available, false);
    assert.equal(off.body.global.fluffyjaws.connected, false);
    assert.equal(off.body.global.fluffyjaws.actsAs, null);
    assert.equal(await serverWithHeaders(e, 'global:fluffyjaws'), null);
  });

  it('is checked by the cron once a day, which keeps the refresh token in use', async () => {
    const e = env();
    await connect(e);
    assert.deepEqual(await refreshGlobalTools(e), {}, 'checked when it was connected');
    // A day later the access token has long expired: the check refreshes it, and so uses the
    // refresh token before Okta lets it expire unused.
    e.DB.sqlite.prepare('UPDATE mcp_global_grants SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    const later = await refreshGlobalTools(e, { now: Date.now() + 2 * 86400_000 });
    assert.deepEqual(later.fluffyjaws, ['fluffyjaws: 4 tools']);
    assert.deepEqual(OKTA.grants, ['authorization_code', 'refresh_token']);
  });
});

describe('the global FluffyJaws server with a service app', () => {
  it('uses the service token instead of anyone\'s, as an automation', async () => {
    const e = env({ service: true });
    const g = await fluffyOf(e);
    assert.equal(g.available, true);
    assert.equal(g.fluffyjaws.mode, 'service');
    assert.equal(g.fluffyjaws.mayConnect, false, 'nobody to connect');
    const checked = await call(e, admin, 'POST', '/api/kb/mcp/global/check', { server: 'fluffyjaws' });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.checked[0].tools, 4);
    assert.equal(checked.body.checked[0].server.name, 'FluffyJaws 3.0');
    assert.ok(seen.length && seen.every((h) => h.authorization === 'Bearer made-up-access-1'
      && h['x-fluffyjaws-end-user'] === 'automation'));

    const conn = await serverWithHeaders(e, 'global:fluffyjaws');
    assert.equal(await conn.authProvider.token(), 'made-up-access-1');
    assert.deepEqual(OKTA.grants, ['client_credentials'], 'kept until it is about to expire');
    await conn.authProvider.onUnauthorized();
    assert.equal(await conn.authProvider.token(), 'made-up-access-2');
    assert.deepEqual(OKTA.grants, ['client_credentials', 'client_credentials']);
  });
});
