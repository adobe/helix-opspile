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
 * The OAuth 2.1 authorization server for MCP clients (`/mcp`).
 *
 * Any client may register itself (RFC 7591), with any https redirect URI (or a localhost /
 * loopback one): there is no list of allowed vendors. Instead the person decides: the
 * consent page, behind Cloudflare Access like the inbox, shows who asks and, in large
 * type, the host the grant is sent to. Codes are single-use, bound to the client, the
 * redirect URI and a PKCE S256 challenge, and live five minutes.
 *
 * Tokens are random; D1 stores only their SHA-256. An access token lives an hour, a
 * refresh token 30 days and is rotated on use. A token is worth what its person is worth
 * now: the person and their teams are looked up on every request.
 */

import { json } from './http.js';

const CODE_TTL = 5 * 60;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;
const MAX_URIS = 10;
export const SCOPE = 'opspile';

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const iso = (now, s) => new Date(now + s * 1000).toISOString();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const originOf = (request, env) => String(env.PUBLIC_ORIGIN || new URL(request.url).origin)
  .replace(/\/+$/, '');

const oauthError = (error, description, status = 400) => json({
  error, error_description: description,
}, status);

const cors = (res) => {
  res.headers.set('access-control-allow-origin', '*');
  res.headers.set('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version');
  res.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.headers.set('cache-control', 'no-store');
  return res;
};

/**
 * Whether a client may register this redirect URI: https anywhere, or http on the user's
 * own machine (localhost, 127.0.0.1, [::1]); no fragments, no credentials.
 */
export function redirectAllowed(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) {
    return false;
  }
  if (u.protocol === 'https:') {
    return true;
  }
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

/** Loopback redirect URIs match on any port (RFC 8252 7.3); others exactly. */
export function redirectMatches(registered, given) {
  if (registered === given) {
    return true;
  }
  try {
    const a = new URL(registered);
    const b = new URL(given);
    const loop = ['localhost', '127.0.0.1', '[::1]'];
    return a.protocol === 'http:' && loop.includes(a.hostname) && a.hostname === b.hostname
      && a.pathname === b.pathname && a.search === b.search && b.protocol === 'http:';
  } catch {
    return false;
  }
}

function metadata(request, env) {
  const origin = originOf(request, env);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };
}

async function register(request, env, now) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return oauthError('invalid_client_metadata', 'expected a JSON object');
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > MAX_URIS || !uris.every(redirectAllowed)) {
    return oauthError('invalid_redirect_uri', 'redirect_uris: 1 to 10 https URIs, or http on localhost');
  }
  const name = String(body.client_name || new URL(uris[0]).host).slice(0, 100);
  const id = random(18);
  await env.DB.prepare(`INSERT INTO oauth_clients (id, name, uri, redirect_uris, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(
      id,
      name,
      body.client_uri ? String(body.client_uri).slice(0, 300) : null,
      JSON.stringify(uris),
      new Date(now).toISOString(),
    ).run();
  return json({
    client_id: id,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201);
}

async function clientOf(env, id) {
  const c = id && await env.DB.prepare('SELECT * FROM oauth_clients WHERE id = ?').bind(id).first();
  return c ? { ...c, redirect_uris: JSON.parse(c.redirect_uris) } : null;
}

function consentPage({
  client, redirect, person, params, nonce,
}) {
  const { host } = new URL(redirect);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect an agent to Enterprise Support</title><link rel="icon" href="/favicon.ico">
<style>
  body { font: 15px/1.5 system-ui, sans-serif; background: #f4f5f7; color: #1d1d1f; margin: 0;
    display: grid; place-items: center; min-height: 100vh; }
  main { background: #fff; border-radius: 14px; box-shadow: 0 6px 30px rgba(0,0,0,.12); padding: 28px 32px;
    max-width: 460px; }
  h1 { font-size: 19px; margin: 0 0 14px; }
  .host { font: 600 20px ui-monospace, monospace; padding: 10px 12px; background: #fff7e0;
    border: 1px solid #e8c45c; border-radius: 8px; word-break: break-all; margin: 6px 0 14px; }
  .mute { color: #6b6b70; font-size: 13px; }
  .row { display: flex; gap: 10px; margin-top: 20px; }
  button { font: inherit; padding: 8px 18px; border-radius: 18px; border: 1px solid #c9c9ce; background: #fff; cursor: pointer; }
  button.ok { background: #2f6fed; border-color: #2f6fed; color: #fff; }
</style></head><body><main>
<h1>Connect <q>${esc(client.name)}</q> to Enterprise Support?</h1>
<p>It will act as <b>${esc(person.name || person.email)}</b>: read the inbox of your teams, and
reply, react and resolve as you.</p>
<p>After you approve, the inbox sends the key to:</p>
<div class="host">${esc(host)}</div>
<p class="mute">${local ? 'That is a program on your own computer.' : 'Only approve if you know this site and started connecting it just now.'}
The client named itself; the address above is what counts.</p>
<form method="post" action="/api/oauth/authorize">${hidden}<input type="hidden" name="nonce" value="${esc(nonce)}">
<div class="row"><button class="ok" name="decision" value="approve">Approve</button>
<button name="decision" value="deny">Deny</button></div></form>
</main></body></html>`;
}

const back = (redirect, params) => {
  const u = new URL(redirect);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) {
      u.searchParams.set(k, v);
    }
  }
  return new Response(null, { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } });
};

/**
 * GET/POST /api/oauth/authorize: behind Access, so the person is known. GET shows the
 * consent page; POST (same origin, with the page's nonce) issues the code.
 */
// The authorize request is carried through the sign-in in the path, not the query: Access
// returns to the path after a Slack (or Microsoft) login but drops the query string.
const CARRY_TTL = 10 * 60 * 1000;
const CONSENT = '/api/oauth/consent/';
const hmac = async (env, data) => b64url(await crypto.subtle.sign(
  'HMAC',
  await crypto.subtle.importKey('raw', enc.encode(`oauth-carry|${env.TOKEN_KEY || ''}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  enc.encode(data),
));
async function carry(env, params, now) {
  const data = b64url(enc.encode(JSON.stringify({ ...params, exp: now + CARRY_TTL })));
  return `${data}.${await hmac(env, data)}`;
}
async function uncarry(env, carried, now) {
  const [data, mac] = String(carried || '').split('.');
  if (!data || !mac || mac !== await hmac(env, data)) {
    return null;
  }
  try {
    const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return p.exp > now ? p : null;
  } catch {
    return null;
  }
}

/**
 * GET /oauth/authorize: public, so the client's parameters arrive intact. Checks the client
 * and redirect URI, then sends the browser to the consent page under /api (behind Access)
 * with the parameters signed into the path.
 */
async function startAuthorize(request, env, url, now) {
  const p = Object.fromEntries(url.searchParams);
  const client = await clientOf(env, p.client_id);
  const known = client && p.redirect_uri
    && client.redirect_uris.some((r) => redirectMatches(r, p.redirect_uri));
  if (!known) {
    return new Response('Unknown client or redirect URI.\n', { status: 400 });
  }
  const keep = [
    'client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method',
    'state', 'scope', 'resource',
  ];
  const params = Object.fromEntries(keep.filter((k) => p[k] != null).map((k) => [k, String(p[k])]));
  return new Response(null, {
    status: 302,
    headers: {
      location: `${originOf(request, env)}${CONSENT}${await carry(env, params, now)}`,
      'cache-control': 'no-store',
    },
  });
}

async function authorize(request, env, url, now, who) {
  const form = request.method === 'POST' ? Object.fromEntries(await request.formData()) : null;
  let p = form || Object.fromEntries(url.searchParams);
  if (!form && url.pathname.startsWith(CONSENT)) {
    p = await uncarry(env, url.pathname.slice(CONSENT.length), now);
    if (!p) {
      return new Response('This sign-in link has expired. Start connecting again from your app.\n', { status: 400 });
    }
  } else if (!form && !url.searchParams.has('client_id')) {
    return new Response('The sign-in lost its parameters. Start connecting again from your app.\n', { status: 400 });
  }
  const client = await clientOf(env, p.client_id);
  // Without a known client and redirect URI, nothing may be sent anywhere.
  const known = client && p.redirect_uri
    && client.redirect_uris.some((r) => redirectMatches(r, p.redirect_uri));
  if (!known) {
    return new Response('Unknown client or redirect URI.\n', { status: 400 });
  }
  const redirect = p.redirect_uri;
  const fail = (error, description) => back(redirect, {
    error, error_description: description, state: p.state,
  });
  if (p.response_type !== 'code') {
    return fail('unsupported_response_type', 'only code');
  }
  if (!p.code_challenge || p.code_challenge_method !== 'S256') {
    return fail('invalid_request', 'PKCE with S256 is required');
  }
  const person = await who(request);
  if (!person) {
    return fail('access_denied', 'not a member of any ops team');
  }
  const params = {
    client_id: p.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    code_challenge: p.code_challenge,
    code_challenge_method: 'S256',
    state: p.state || '',
    scope: p.scope || SCOPE,
    resource: p.resource || '',
  };
  if (!form) {
    // The nonce ties the POST to this page, for this person: no cross-site approval.
    const nonce = `${now}.${await sha256(`${env.TOKEN_KEY || ''}|${person.id}|${p.client_id}|${now}`)}`;
    return new Response(consentPage({
      client, redirect, person, params, nonce,
    }), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // form-action also governs where the POST redirects: the client's callback.
        'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' ${new URL(redirect).origin}; frame-ancestors 'none'`,
        'x-frame-options': 'DENY',
      },
    });
  }
  const [t, mac] = String(form.nonce || '').split('.');
  const fresh = Number(t) > now - 10 * 60 * 1000 && Number(t) <= now;
  const sameOrigin = request.headers.get('origin') === originOf(request, env);
  if (!fresh || !sameOrigin
    || mac !== await sha256(`${env.TOKEN_KEY || ''}|${person.id}|${p.client_id}|${t}`)) {
    return new Response('This approval page has expired. Start connecting again.\n', { status: 400 });
  }
  if (form.decision !== 'approve') {
    return fail('access_denied', 'the person declined');
  }
  const code = random();
  await env.DB.prepare(`INSERT INTO oauth_codes (hash, client, person, redirect_uri, challenge,
      scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      await sha256(code),
      client.id,
      person.id,
      redirect,
      p.code_challenge,
      params.scope,
      params.resource || null,
      iso(now, CODE_TTL),
    ).run();
  return back(redirect, { code, state: p.state, iss: originOf(request, env) });
}

async function issue(env, client, person, scope, now) {
  const access = random();
  const refresh = random();
  await env.DB.prepare(`INSERT INTO oauth_tokens (hash, kind, client, person, scope,
      expires_at, created_at) VALUES (?, 'access', ?, ?, ?, ?, ?), (?, 'refresh', ?, ?, ?, ?, ?)`)
    .bind(...[
      await sha256(access), client, person, scope, iso(now, ACCESS_TTL), iso(now, 0),
      await sha256(refresh), client, person, scope, iso(now, REFRESH_TTL), iso(now, 0),
    ]).run();
  return json({
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: refresh,
    scope,
  });
}

async function token(request, env, now) {
  const type = request.headers.get('content-type') || '';
  const p = type.includes('json') ? await request.json().catch(() => ({}))
    : Object.fromEntries(await request.formData().catch(() => new FormData()));
  const client = await clientOf(env, p.client_id);
  if (!client) {
    return oauthError('invalid_client', 'unknown client', 401);
  }
  if (p.grant_type === 'authorization_code') {
    const hash = await sha256(String(p.code || ''));
    // Single use: the code is gone whatever happens next.
    const row = await env.DB.prepare('DELETE FROM oauth_codes WHERE hash = ? RETURNING *')
      .bind(hash).first();
    if (!row || row.client !== client.id || row.expires_at < iso(now, 0)
      || row.redirect_uri !== p.redirect_uri) {
      return oauthError('invalid_grant', 'unknown, used or expired code');
    }
    if (!p.code_verifier || await sha256(String(p.code_verifier)) !== row.challenge) {
      return oauthError('invalid_grant', 'PKCE verification failed');
    }
    return issue(env, client.id, row.person, row.scope, now);
  }
  if (p.grant_type === 'refresh_token') {
    const row = await env.DB.prepare(`DELETE FROM oauth_tokens WHERE hash = ? AND kind = 'refresh'
      RETURNING *`).bind(await sha256(String(p.refresh_token || ''))).first();
    if (!row || row.client !== client.id || row.expires_at < iso(now, 0)) {
      return oauthError('invalid_grant', 'unknown or expired refresh token');
    }
    return issue(env, client.id, row.person, row.scope, now);
  }
  return oauthError('unsupported_grant_type', 'authorization_code or refresh_token');
}

async function revoke(request, env) {
  const p = Object.fromEntries(await request.formData().catch(() => new FormData()));
  if (p.token) {
    await env.DB.prepare('DELETE FROM oauth_tokens WHERE hash = ?').bind(await sha256(String(p.token))).run();
  }
  return new Response(null, { status: 200 });
}

/**
 * The person an MCP request's bearer token belongs to, or null.
 *
 * @returns {Promise<number|null>} person id
 */
export async function bearerPerson(request, env, now = Date.now()) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '');
  if (!m) {
    return null;
  }
  const row = await env.DB.prepare(`SELECT person FROM oauth_tokens
    WHERE hash = ? AND kind = 'access' AND expires_at > ?`)
    .bind(await sha256(m[1]), iso(now, 0)).first();
  return row ? row.person : null;
}

/** The `WWW-Authenticate` challenge for `/mcp`. */
export const challenge = (request, env) => `Bearer resource_metadata="${originOf(request, env)}/.well-known/oauth-protected-resource"`;

/**
 * Routes the OAuth endpoints; null for any other path.
 *
 * @param {(request: Request) => Promise<object|null>} who the signed-in person (Access)
 */
export async function oauth(request, env, url, { now = Date.now(), who } = {}) {
  const { pathname } = url;
  const publicPaths = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token', '/oauth/revoke'];
  if (publicPaths.includes(pathname) && request.method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }));
  }
  if (pathname.startsWith('/.well-known/oauth-protected-resource')) {
    const origin = originOf(request, env);
    return cors(json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
    }));
  }
  if (pathname === '/.well-known/oauth-authorization-server') {
    return cors(json(metadata(request, env)));
  }
  if (pathname === '/oauth/register' && request.method === 'POST') {
    return cors(await register(request, env, now));
  }
  if (pathname === '/oauth/token' && request.method === 'POST') {
    return cors(await token(request, env, now));
  }
  if (pathname === '/oauth/revoke' && request.method === 'POST') {
    return cors(await revoke(request, env));
  }
  if (pathname === '/oauth/authorize' && request.method === 'GET') {
    return startAuthorize(request, env, url, now);
  }
  if (pathname.startsWith(CONSENT) && request.method === 'GET') {
    return authorize(request, env, url, now, who);
  }
  if (pathname === '/api/oauth/authorize' && ['GET', 'POST'].includes(request.method)) {
    return authorize(request, env, url, now, who);
  }
  return null;
}

/** Cron: codes and tokens that ran out. They can never be redeemed, and only pile up. */
export async function pruneOauth(env, now = new Date()) {
  const at = now.toISOString();
  const codes = await env.DB.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(at).run();
  const tokens = await env.DB.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').bind(at).run();
  return { codes: codes.meta.changes, tokens: tokens.meta.changes };
}
