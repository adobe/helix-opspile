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
  after, before, beforeEach, describe, it,
} from 'node:test';
import { AgentMcp } from '../src/agent/mcp.js';
import {
  freshToken, grantState, keepOAuthAlive, KEEP_ALIVE_MS,
} from '../src/agent/mcpoauth.js';
import { api, personById } from '../src/api.js';
import { mcp } from '../src/mcp.js';
import { oauth } from '../src/oauth.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// The MCP server here is opspile's own `/mcp`, with its own OAuth: opspile connecting to itself.
// Made-up origin, people, teams and orgs only.
const ORIGIN = 'https://opspile.example';
const KEY = Buffer.alloc(32, 9).toString('base64url');
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin', 'helix'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
};
const asMe = (p, roles = {}) => ({ ...p, teams: p.teams.map((slug) => ({ slug, role: roles[slug] || 'member' })) });
const admin = asMe(ADA);
const manager = asMe(BO, { helix: 'manager' });

function env() {
  const DB = d1({
    people: [ADA, BO],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }],
  });
  DB.sqlite.prepare(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
    VALUES ('kb-team-helix', 'team', 'helix', 'test', '2026-10-22T00:00:00Z')`).run();
  return { DB, TOKEN_KEY: KEY, PUBLIC_ORIGIN: ORIGIN };
}

// Every request to ORIGIN goes to the Worker's own handlers; `seen` records the token requests.
let current;
let seen = [];
let consenting = ADA.id;
const realFetch = globalThis.fetch;
async function worker(input, init) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== ORIGIN) {
    return realFetch(input, init);
  }
  if (url.pathname === '/oauth/token') {
    seen.push(Object.fromEntries(new URLSearchParams(await request.clone().text())).grant_type);
  }
  if (url.pathname === '/mcp') {
    return mcp(request, current);
  }
  const who = async () => personById(current, consenting);
  const res = await oauth(request, current, url, { who });
  return res || new Response('not found', { status: 404 });
}
before(() => {
  globalThis.fetch = worker;
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  current = env();
  seen = [];
  consenting = ADA.id;
});

async function call(me, method, path, body) {
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const res = await quiet(() => api(request, current, new URL(request.url), { viewer: me }));
  const type = res.headers.get('content-type') || '';
  return {
    status: res.status,
    location: res.headers.get('location'),
    body: type.includes('json') ? await res.json() : await res.text(),
  };
}

/** The browser at opspile's consent page: approves, and is sent back to the callback. */
async function approve(authorizationUrl) {
  const start = await worker(authorizationUrl);
  assert.equal(start.status, 302);
  const page = await worker(start.headers.get('location'));
  const html = await page.text();
  assert.equal(page.status, 200, html);
  const fields = Object.fromEntries([...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)]
    .map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));
  const res = await worker(`${ORIGIN}/api/oauth/authorize`, {
    method: 'POST',
    headers: { origin: ORIGIN },
    body: new URLSearchParams({ ...fields, decision: 'approve' }),
  });
  assert.equal(res.status, 302);
  return new URL(res.headers.get('location'));
}

async function added(body = {}) {
  const res = await call(admin, 'POST', '/api/kb/mcp', {
    repo: 'kb-team-helix', name: 'pile', url: `${ORIGIN}/mcp`, auth: 'oauth', ...body,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.server;
}

/** Adds the server and connects it, as Ada. */
async function connected() {
  const server = await added();
  const started = await call(admin, 'POST', '/api/kb/mcp/oauth/start', { id: server.id });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const back = await approve(started.body.authorizationUrl);
  const done = await call(admin, 'GET', `${back.pathname}${back.search}`);
  return {
    server, started, back, done,
  };
}

const row = (id) => current.DB.sqlite.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);

describe('MCP servers that sign in with OAuth', () => {
  it('adds a server that is not connected yet, and sends no headers', async () => {
    const server = await added({ headers: [{ name: 'Authorization', value: 'Bearer x' }] });
    assert.equal(server.auth, 'oauth');
    assert.deepEqual(server.headerNames, []);
    assert.equal(server.oauth.connected, false);
    assert.equal(server.checkError, null);
    // An agent is told why it cannot use it.
    const agent = new AgentMcp(current, { get: async () => undefined, put: async () => {} });
    const { catalog } = await agent.refresh({ team: 'helix' });
    assert.match(catalog.servers[0].error, /not connected yet/);
  });

  it('connects through discovery, registration and PKCE, and the agents use it as the person who connected', async () => {
    const {
      server, started, back, done,
    } = await connected();
    const auth = new URL(started.body.authorizationUrl);
    assert.equal(auth.origin + auth.pathname, `${ORIGIN}/oauth/authorize`);
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('redirect_uri'), `${ORIGIN}/api/kb/mcp/oauth/callback`);
    assert.equal(auth.searchParams.get('resource'), `${ORIGIN}/mcp`);
    assert.equal(auth.searchParams.get('scope'), 'opspile');
    assert.equal(back.pathname, '/api/kb/mcp/oauth/callback');
    assert.equal(done.status, 302);
    const to = new URL(done.location, ORIGIN);
    assert.equal(to.pathname, '/inbox/kb');
    assert.deepEqual(Object.fromEntries(to.searchParams), { repo: 'kb-team-helix', view: 'mcp', mcp_connected: String(server.id) });

    const listed = await call(admin, 'GET', '/api/kb/mcp?repo=kb-team-helix');
    const shown = listed.body.servers[0];
    assert.equal(shown.oauth.connected, true);
    assert.equal(shown.oauth.by, ADA.email);
    assert.equal(shown.oauth.issuer, ORIGIN);
    assert.ok(shown.tools.some((t) => t.name === 'whoami'), JSON.stringify(shown));
    // No token reaches the page, and D1 holds them sealed.
    const r = row(server.id);
    const tokens = current.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE kind = 'access'").get();
    assert.equal(tokens.n, 1);
    assert.ok(!/access_token|refresh_token/.test(JSON.stringify(listed.body)));
    assert.ok(!/access_token/.test(r.oauth), 'sealed');
    assert.equal(r.oauth_pending, null);

    const agent = new AgentMcp(current, { get: async () => undefined, put: async () => {} });
    const { catalog } = await agent.refresh({ team: 'helix' });
    assert.equal(catalog.servers[0].error, null);
    const res = await agent.call(catalog.servers[0], 'whoami', {});
    assert.equal(res.structuredContent.name, 'Ada');
  });

  it('refreshes an expiring token once, however many agents ask at the same time', async () => {
    const { server } = await connected();
    const was = row(server.id);
    current.DB.sqlite.prepare("UPDATE mcp_servers SET oauth_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(server.id);
    seen = [];
    const got = await Promise.all([1, 2, 3, 4, 5].map(() => freshToken(current, server.id)));
    assert.deepEqual(seen, ['refresh_token'], 'one refresh');
    assert.equal(new Set(got.map((g) => g.token)).size, 1);
    const now = row(server.id);
    assert.notEqual(now.oauth, was.oauth);
    assert.ok(Date.parse(now.oauth_expires_at) > Date.now());
    assert.equal(now.oauth_lock, null);
    // The refreshed token works.
    const agent = new AgentMcp(current, { get: async () => undefined, put: async () => {} });
    const { catalog } = await agent.refresh({ team: 'helix' });
    assert.equal((await agent.call(catalog.servers[0], 'whoami', {})).structuredContent.name, 'Ada');
  });

  /** A fetch that runs `meanwhile` once the token endpoint answered, while the refresh is out. */
  const during = (meanwhile) => async (input, init) => {
    const res = await worker(input, init);
    if (new URL(String(input.url || input)).pathname === '/oauth/token') {
      await meanwhile();
    }
    return res;
  };

  it('does not bring a grant back that was disconnected while it was refreshed', async () => {
    const { server } = await connected();
    current.DB.sqlite.prepare("UPDATE mcp_servers SET oauth_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?")
      .run(server.id);
    await assert.rejects(freshToken(current, server.id, {
      fetch: during(() => call(admin, 'POST', '/api/kb/mcp/oauth/disconnect', { id: server.id })),
    }), /not connected|connect/i);
    const now = row(server.id);
    assert.equal(now.oauth_by, null);
    assert.equal(now.oauth_expires_at, null);
    assert.equal(now.oauth_lock, null);
    await assert.rejects(freshToken(current, server.id), /not connected|connect/i);
    // Nothing outlives the grant: the tokens that refresh got are revoked too.
    assert.equal(current.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get().n, 0);
  });

  it('keeps the sign-in made while an old refresh was out', async () => {
    const { server } = await connected();
    current.DB.sqlite.prepare("UPDATE mcp_servers SET oauth_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?")
      .run(server.id);
    const replace = () => {
      current.DB.sqlite.prepare("UPDATE mcp_servers SET oauth = 'someone else', oauth_by = 'Bo' WHERE id = ?")
        .run(server.id);
    };
    await assert.rejects(freshToken(current, server.id, { fetch: during(replace) }));
    assert.equal(row(server.id).oauth, 'someone else');
    assert.equal(row(server.id).oauth_by, 'Bo');
  });

  it('does not drop a grant made while an old refresh was refused', async () => {
    const { server } = await connected();
    current.DB.sqlite.prepare("UPDATE mcp_servers SET oauth_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?")
      .run(server.id);
    current.DB.sqlite.prepare("DELETE FROM oauth_tokens WHERE kind = 'refresh'").run();
    const replace = () => {
      current.DB.sqlite.prepare("UPDATE mcp_servers SET oauth = 'someone else', oauth_by = 'Bo' WHERE id = ?")
        .run(server.id);
    };
    await assert.rejects(quiet(() => freshToken(current, server.id, { fetch: during(replace) })));
    assert.equal(row(server.id).oauth, 'someone else');
    assert.equal(row(server.id).oauth_error, null);
  });

  it('hands out the new grant when an old refresh is refused after someone connected again', async () => {
    const { server } = await connected();
    const fresh = row(server.id);
    current.DB.sqlite.prepare(`UPDATE mcp_servers SET oauth_expires_at = '2000-01-01T00:00:00Z'
      WHERE id = ?`).run(server.id);
    const stale = row(server.id).oauth;
    const made = await freshToken(current, server.id);
    const good = row(server.id);
    // The row as it was before that refresh: an old grant, with a token that is gone.
    current.DB.sqlite.prepare(`UPDATE mcp_servers SET oauth = ?, oauth_expires_at = '2000-01-01T00:00:00Z'
      WHERE id = ?`).run(stale, server.id);
    const replace = () => {
      current.DB.sqlite.prepare('UPDATE mcp_servers SET oauth = ?, oauth_expires_at = ? WHERE id = ?')
        .run(good.oauth, good.oauth_expires_at, server.id);
    };
    const got = await quiet(() => freshToken(current, server.id, { fetch: during(replace) }));
    assert.equal(got.token, made.token);
    assert.equal(row(server.id).oauth_error, null);
    assert.ok(fresh.oauth_by);
  });

  it('does not revoke what a takeover of its lease stored for the same grant', async () => {
    const { server } = await connected();
    current.DB.sqlite.prepare("UPDATE mcp_servers SET oauth_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?")
      .run(server.id);
    const revoked = [];
    const fetching = during(() => {
      // Same grant (same oauth_at), written by whoever took over.
      current.DB.sqlite.prepare("UPDATE mcp_servers SET oauth = oauth || '.' WHERE id = ?").run(server.id);
    });
    await assert.rejects(freshToken(current, server.id, {
      fetch: async (input, init) => {
        if (new URL(String(input.url || input)).pathname.endsWith('/revoke')) {
          revoked.push('revoke');
        }
        return fetching(input, init);
      },
    }));
    assert.deepEqual(revoked, []);
  });

  it('gives back only its own lease', async () => {
    const { server } = await connected();
    current.DB.sqlite.prepare("UPDATE mcp_servers SET oauth_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?")
      .run(server.id);
    const theirs = '2999-01-01T00:00:00.000Z';
    const steal = () => {
      current.DB.sqlite.prepare('UPDATE mcp_servers SET oauth_lock = ? WHERE id = ?').run(theirs, server.id);
    };
    await freshToken(current, server.id, { fetch: during(steal) });
    assert.equal(row(server.id).oauth_lock, theirs);
  });

  it('says in one word where a grant stands', () => {
    assert.equal(grantState({}), 'none');
    assert.equal(grantState({ oauth_state: 'h' }), 'signing in');
    assert.equal(grantState({ oauth_by: 'Ada' }), 'connected');
    assert.equal(grantState({ oauth_by: 'Ada', oauth_lock: 'x' }), 'connected');
    assert.equal(grantState({ oauth_by: 'Ada', oauth_error: 'gone' }), 'rejected');
    assert.equal(grantState({ oauth_error: 'gone', oauth_state: 'h' }), 'rejected');
  });

  it('refreshes when the server refuses the token, and drops a grant the server no longer accepts', async () => {
    const { server } = await connected();
    const agent = new AgentMcp(current, { get: async () => undefined, put: async () => {} });
    const { catalog } = await agent.refresh({ team: 'helix' });
    // opspile forgets the access token: the next call gets 401, refreshes, and goes through.
    current.DB.sqlite.prepare("DELETE FROM oauth_tokens WHERE kind = 'access'").run();
    seen = [];
    assert.equal((await agent.call(catalog.servers[0], 'whoami', {})).structuredContent.name, 'Ada');
    assert.deepEqual(seen, ['refresh_token']);
    // Now it forgets everything (revoked, or the refresh token expired).
    current.DB.sqlite.prepare('DELETE FROM oauth_tokens').run();
    await assert.rejects(quiet(() => agent.call(catalog.servers[0], 'whoami', {})));
    const listed = await call(admin, 'GET', '/api/kb/mcp?repo=kb-team-helix');
    assert.equal(listed.body.servers[0].oauth.connected, false);
    assert.match(listed.body.servers[0].oauth.error, /invalid_grant.*connect it again/);
    // Connecting again fixes it, with the client registered the first time.
    const clients = current.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n;
    const started = await call(admin, 'POST', '/api/kb/mcp/oauth/start', { id: server.id });
    const back = await approve(started.body.authorizationUrl);
    await call(admin, 'GET', `${back.pathname}${back.search}`);
    assert.equal(current.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n, clients);
    assert.equal((await call(admin, 'GET', '/api/kb/mcp?repo=kb-team-helix')).body.servers[0].oauth.connected, true);
  });

  it('lets only the person who started finish, and says when the server said no', async () => {
    const server = await added();
    const started = await call(admin, 'POST', '/api/kb/mcp/oauth/start', { id: server.id });
    const back = await approve(started.body.authorizationUrl);
    const other = await call(manager, 'GET', `${back.pathname}${back.search}`);
    assert.equal(other.status, 302);
    assert.match(new URL(other.location, ORIGIN).searchParams.get('mcp_error'), /someone else/);
    // The sign-in was used up.
    assert.equal((await call(admin, 'GET', `${back.pathname}${back.search}`)).status, 400);
    assert.equal(row(server.id).oauth_by, null);

    const again = await call(admin, 'POST', '/api/kb/mcp/oauth/start', { id: server.id });
    const state = new URL(again.body.authorizationUrl).searchParams.get('state');
    const denied = await call(admin, 'GET', `/api/kb/mcp/oauth/callback?${new URLSearchParams({ state, error: 'access_denied', error_description: 'the person declined' })}`);
    assert.match(new URL(denied.location, ORIGIN).searchParams.get('mcp_error'), /did not grant access: the person declined/);
    assert.equal((await call(admin, 'GET', '/api/kb/mcp/oauth/callback?state=made-up&code=x')).status, 400);
  });

  it('signs in as a client registered at the server, when staff give its id', async () => {
    const reg = await worker(`${ORIGIN}/oauth/register`, {
      method: 'POST',
      body: JSON.stringify({ client_name: 'Registered by hand', redirect_uris: [`${ORIGIN}/api/kb/mcp/oauth/callback`] }),
    });
    const { client_id: clientId } = await reg.json();
    const server = await added({ oauth: { clientId, scope: 'opspile' } });
    assert.equal(server.oauth.clientId, clientId);
    const clients = current.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n;
    const started = await call(admin, 'POST', '/api/kb/mcp/oauth/start', { id: server.id });
    assert.equal(new URL(started.body.authorizationUrl).searchParams.get('client_id'), clientId);
    const back = await approve(started.body.authorizationUrl);
    await call(admin, 'GET', `${back.pathname}${back.search}`);
    assert.equal(current.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n, clients, 'no registration');
    assert.equal(row(server.id).oauth_error, null);
    assert.ok(row(server.id).oauth_by);
  });

  it('forgets the grant when the URL or the client changes, or on disconnect, which revokes it', async () => {
    const { server } = await connected();
    const changed = await call(admin, 'PUT', '/api/kb/mcp', { id: server.id, description: 'The inbox' });
    assert.equal(changed.body.server.oauth.connected, true, 'a description is not a new sign-in');
    const scoped = await call(admin, 'PUT', '/api/kb/mcp', { id: server.id, oauth: { scope: 'other' } });
    assert.equal(scoped.body.server.oauth.connected, false);
    assert.deepEqual(scoped.body.server.tools, []);

    const started = await call(admin, 'POST', '/api/kb/mcp/oauth/start', { id: server.id });
    assert.equal(new URL(started.body.authorizationUrl).searchParams.get('scope'), 'other');
    await call(admin, 'PUT', '/api/kb/mcp', { id: server.id, oauth: {} });
    const again = await call(admin, 'POST', '/api/kb/mcp/oauth/start', { id: server.id });
    const back = await approve(again.body.authorizationUrl);
    await call(admin, 'GET', `${back.pathname}${back.search}`);
    assert.equal(current.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get().n, 2);
    const gone = await call(admin, 'POST', '/api/kb/mcp/oauth/disconnect', { id: server.id });
    assert.equal(gone.body.server.oauth.connected, false);
    assert.equal(current.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE kind = 'refresh'").get().n, 0, 'revoked');
    // Back to headers: nothing of the grant stays.
    const headers = await call(admin, 'PUT', '/api/kb/mcp', { id: server.id, auth: 'headers', headers: { Authorization: 'Bearer y' } });
    assert.equal(headers.body.server.auth, 'headers');
    assert.equal(headers.body.server.oauth, null);
    assert.equal(row(server.id).oauth, null);
  });

  it('keeps grants alive that nobody used for a week', async () => {
    const { server } = await connected();
    assert.deepEqual(await keepOAuthAlive(current), {});
    seen = [];
    const later = Date.now() + KEEP_ALIVE_MS + 60_000;
    assert.deepEqual(await keepOAuthAlive(current, { now: later }), { [server.id]: 'refreshed' });
    assert.deepEqual(seen, ['refresh_token']);
  });

  it('refuses what cannot sign in', async () => {
    const bad = await call(admin, 'POST', '/api/kb/mcp', {
      repo: 'kb-team-helix', name: 'x', url: `${ORIGIN}/mcp`, auth: 'oauth', oauth: { clientSecret: 's' },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /client id/);
    assert.equal((await call(admin, 'POST', '/api/kb/mcp', {
      repo: 'kb-team-helix', name: 'x', url: `${ORIGIN}/mcp`, auth: 'magic',
    })).status, 400);
    const headers = await call(admin, 'POST', '/api/kb/mcp', {
      repo: 'kb-team-helix', name: 'y', url: `${ORIGIN}/mcp`,
    });
    assert.equal((await call(admin, 'POST', '/api/kb/mcp/oauth/start', { id: headers.body.server.id })).status, 400);
    assert.equal((await call(manager, 'POST', '/api/kb/mcp/oauth/start', { id: 999 })).status, 404);
  });
});
