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
import { describe, it } from 'node:test';
import { personById } from '../src/api.js';
import { mcp, PROTOCOL } from '../src/mcp.js';
import {
  bearerPerson, oauth, pruneOauth, redirectAllowed, redirectMatches,
} from '../src/oauth.js';
import { d1 } from './d1.js';

// Made-up origin, people and clients only.
const ORIGIN = 'https://inbox.example';
const NOW = Date.now();
const env = () => ({
  PUBLIC_ORIGIN: ORIGIN,
  TOKEN_KEY: 'k',
  DB: d1({
    teams: [{ slug: 'helix', name: 'Helix' }],
    people: [{
      id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
    }],
  }),
});
const b64url = (b) => b.toString('base64url');
const VERIFIER = 'a-long-random-verifier-made-up-for-this-test-0123456789';
const CHALLENGE = b64url(createHash('sha256').update(VERIFIER).digest());

async function call(e, path, init = {}, { who = async () => null, now = NOW } = {}) {
  const request = new Request(`${ORIGIN}${path}`, init);
  return oauth(request, e, new URL(request.url), { now, who });
}
const form = (o) => new URLSearchParams(o);
const ada = (e) => async () => personById(e, 1);

async function registered(e, uri = 'https://agent.example/callback') {
  const res = await call(e, '/oauth/register', {
    method: 'POST', body: JSON.stringify({ client_name: 'Some agent', redirect_uris: [uri] }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).client_id;
}

async function approve(e, client, uri = 'https://agent.example/callback') {
  const q = form({
    client_id: client, redirect_uri: uri, response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 'xyz',
  });
  // The public endpoint moves the request into the consent page's path: it survives a
  // sign-in that drops the query string.
  const start = await call(e, `/oauth/authorize?${q}`);
  assert.equal(start.status, 302);
  const consent = new URL(start.headers.get('location'));
  assert.match(consent.pathname, /^\/api\/oauth\/consent\//);
  assert.equal(consent.search, '');
  const page = await call(e, consent.pathname, {}, { who: ada(e) });
  const html = await page.text();
  assert.equal(page.status, 200);
  const fields = Object.fromEntries([...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));
  const res = await call(e, '/api/oauth/authorize', {
    method: 'POST', headers: { origin: ORIGIN }, body: form({ ...fields, decision: 'approve' }),
  }, { who: ada(e) });
  return { html, res };
}

describe('oauth for mcp clients', () => {
  it('forgets codes and tokens that ran out, and only those', async () => {
    const e = env();
    const client = await registered(e);
    const at = (ms) => new Date(NOW + ms).toISOString();
    const token = e.DB.sqlite.prepare(`INSERT INTO oauth_tokens (hash, kind, client, person,
      expires_at, created_at) VALUES (?, 'access', ?, 1, ?, ?)`);
    token.run('gone', client, at(-1000), at(-2000));
    token.run('good', client, at(1000), at(-2000));
    const code = e.DB.sqlite.prepare(`INSERT INTO oauth_codes (hash, client, person, redirect_uri,
      challenge, expires_at) VALUES (?, ?, 1, 'https://agent.example/callback', 'c', ?)`);
    code.run('gone', client, at(-1000));
    code.run('good', client, at(1000));
    assert.deepEqual(await pruneOauth(e, new Date(NOW)), { codes: 1, tokens: 1 });
    assert.deepEqual(e.DB.rows('SELECT hash FROM oauth_tokens').map((r) => r.hash), ['good']);
    assert.deepEqual(e.DB.rows('SELECT hash FROM oauth_codes').map((r) => r.hash), ['good']);
  });

  it('lets any https or local redirect URI register, nothing else', () => {
    assert.ok(redirectAllowed('https://anything.example/cb'));
    assert.ok(redirectAllowed('http://localhost:3000/cb'));
    assert.ok(redirectAllowed('http://127.0.0.1/cb'));
    assert.ok(!redirectAllowed('http://agent.example/cb'));
    assert.ok(!redirectAllowed('https://agent.example/cb#x'));
    assert.ok(!redirectAllowed(['javascript', 'alert(1)'].join(':')));
    assert.ok(redirectMatches('http://127.0.0.1/cb', 'http://127.0.0.1:5555/cb'));
    assert.ok(!redirectMatches('https://agent.example/cb', 'https://agent.example/other'));
  });

  it('publishes discovery documents', async () => {
    const e = env();
    const pr = await (await call(e, '/.well-known/oauth-protected-resource/mcp')).json();
    assert.deepEqual([pr.resource, pr.authorization_servers], [`${ORIGIN}/mcp`, [ORIGIN]]);
    const as = await (await call(e, '/.well-known/oauth-authorization-server')).json();
    assert.equal(as.registration_endpoint, `${ORIGIN}/oauth/register`);
    assert.equal(as.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  });

  it('shows the callback host, issues a code, a token that works on /mcp, and rotates refresh', async () => {
    const e = env();
    const client = await registered(e);
    const { html, res } = await approve(e, client);
    assert.match(html, /<div class="host">agent\.example<\/div>/);
    // The approval's redirect to the client must be allowed by the page's CSP.
    const page = await call(e, `/api/oauth/authorize?${form({
      client_id: client, redirect_uri: 'https://agent.example/callback', response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256',
    })}`, {}, { who: ada(e) });
    assert.match(page.headers.get('content-security-policy'), /form-action 'self' https:\/\/agent\.example;/);
    assert.match(html, /Some agent/);
    assert.equal(res.status, 302);
    const back = new URL(res.headers.get('location'));
    assert.equal(back.origin + back.pathname, 'https://agent.example/callback');
    assert.equal(back.searchParams.get('state'), 'xyz');
    const code = back.searchParams.get('code');

    const bad = await call(e, '/oauth/token', {
      method: 'POST',
      body: form({
        grant_type: 'authorization_code', client_id: client, code, redirect_uri: 'https://agent.example/callback', code_verifier: 'wrong',
      }),
    });
    assert.equal(bad.status, 400);
    // The failed try used the code up.
    const again = await call(e, '/oauth/token', {
      method: 'POST',
      body: form({
        grant_type: 'authorization_code', client_id: client, code, redirect_uri: 'https://agent.example/callback', code_verifier: VERIFIER,
      }),
    });
    assert.equal((await again.json()).error, 'invalid_grant');

    const { res: res2 } = await approve(e, client);
    const code2 = new URL(res2.headers.get('location')).searchParams.get('code');
    const tok = await (await call(e, '/oauth/token', {
      method: 'POST',
      body: form({
        grant_type: 'authorization_code', client_id: client, code: code2, redirect_uri: 'https://agent.example/callback', code_verifier: VERIFIER,
      }),
    })).json();
    assert.equal(tok.token_type, 'Bearer');
    const bearer = new Request(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${tok.access_token}` } });
    assert.equal(await bearerPerson(bearer, e, NOW), 1);
    assert.equal(await bearerPerson(bearer, e, NOW + 2 * 3600 * 1000), null);

    const rpc = await mcp(new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json', 'mcp-protocol-version': PROTOCOL, 'mcp-method': 'tools/call', 'mcp-name': 'whoami',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'whoami',
          arguments: {},
          _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {} },
        },
      }),
    }), e);
    assert.equal(rpc.status, 200);
    assert.match(JSON.stringify(await rpc.json()), /Ada/);

    const refreshed = await (await call(e, '/oauth/token', {
      method: 'POST', body: form({ grant_type: 'refresh_token', client_id: client, refresh_token: tok.refresh_token }),
    })).json();
    assert.ok(refreshed.access_token);
    const reused = await call(e, '/oauth/token', {
      method: 'POST', body: form({ grant_type: 'refresh_token', client_id: client, refresh_token: tok.refresh_token }),
    });
    assert.equal(reused.status, 400);
  });

  it('refuses unknown redirect URIs, no PKCE, cross-site approval and strangers', async () => {
    const e = env();
    const client = await registered(e);
    const q = (o) => `/api/oauth/authorize?${form({
      client_id: client, redirect_uri: 'https://agent.example/callback', response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256', ...o,
    })}`;
    assert.equal((await call(e, q({ redirect_uri: 'https://evil.example/cb' }), {}, { who: ada(e) })).status, 400);
    const plain = await call(e, q({ code_challenge_method: 'plain' }), {}, { who: ada(e) });
    assert.equal(new URL(plain.headers.get('location')).searchParams.get('error'), 'invalid_request');
    const stranger = await call(e, q({}), {}, { who: async () => null });
    assert.equal(new URL(stranger.headers.get('location')).searchParams.get('error'), 'access_denied');
    const page = await (await call(e, q({}), {}, { who: ada(e) })).text();
    const fields = Object.fromEntries([...page.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const cross = await call(e, '/api/oauth/authorize', {
      method: 'POST', headers: { origin: 'https://evil.example' }, body: form({ ...fields, decision: 'approve' }),
    }, { who: ada(e) });
    assert.equal(cross.status, 400);
  });

  it('refuses a tampered or expired consent path, and a consent page that lost its query', async () => {
    const e = env();
    const client = await registered(e);
    const q = form({
      client_id: client, redirect_uri: 'https://agent.example/callback', response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256',
    });
    const path = new URL((await call(e, `/oauth/authorize?${q}`)).headers.get('location')).pathname;
    const [data, mac] = path.split('/').pop().split('.');
    const forged = `/api/oauth/consent/${data.slice(0, -2)}AA.${mac}`;
    assert.equal((await call(e, forged, {}, { who: ada(e) })).status, 400);
    const later = await call(e, path, {}, { who: ada(e), now: NOW + 11 * 60 * 1000 });
    assert.equal(later.status, 400);
    assert.match(await (await call(e, '/api/oauth/authorize', {}, { who: ada(e) })).text(), /lost its parameters/);
    assert.equal((await call(e, `/oauth/authorize?${form({ client_id: 'nope', redirect_uri: 'https://agent.example/callback' })}`)).status, 400);
  });

  it('answers /mcp without a token with the challenge pointing at our metadata', async () => {
    const res = await mcp(new Request(`${ORIGIN}/mcp`, { method: 'POST', body: '{}' }), env());
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /resource_metadata="https:\/\/inbox\.example\/\.well-known\/oauth-protected-resource"/);
  });
});
