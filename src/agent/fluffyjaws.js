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

import { seal, unseal } from '../post.js';
import { CALLBACK_PATH, NotConnectedError } from './mcpoauth.js';

/**
 * The credential of the global `fluffyjaws` server (src/agent/globals.js): FluffyJaws' MCP
 * server takes an Okta access token of its own authorization server (FLUFFYJAWS_ISSUER) as
 * `Authorization: Bearer`, and refuses one with less than five minutes left. Two ways to get one,
 * the first that is set up wins:
 *
 * - **A service app** (FLUFFYJAWS_SERVICE_CLIENT_ID, FLUFFYJAWS_SERVICE_SECRET): an Okta service
 *   app registered with FluffyJaws, client credentials with the scope `fluffyjaws`. Its calls say
 *   `X-FluffyJaws-End-User: automation`, since no person is behind them. Kept per isolate until
 *   shortly before it expires.
 * - **An admin's grant** (FLUFFYJAWS_CLIENT_ID, opspile's public Okta client: authorization code
 *   with PKCE and refresh tokens; no client registration, which FluffyJaws' Okta refuses). A
 *   member of the admin team connects it once in the knowledge-base editor; the browser comes
 *   back to CALLBACK_PATH, as for the agents' OAuth servers (src/agent/mcpoauth.js), and the
 *   grant is kept in `mcp_global_grants`, sealed with TOKEN_KEY, with whose identity it is
 *   (from the ID token). **Every agent then acts as that person** at FluffyJaws. A token with
 *   less than seven minutes left is refreshed, one refresh at a time across every agent (Okta
 *   may rotate refresh tokens): whoever takes the lease (`refresh_lock`) refreshes, the others
 *   wait and read the result. A grant Okta no longer accepts is dropped, with the reason,
 *   until someone connects again. The daily check of the global servers refreshes it too, so
 *   the refresh token does not expire unused.
 */

export const FLUFFYJAWS_MCP_URL = 'https://api.fluffyjaws.adobe.com/api/v1/mcp';
export const SIGN_IN_SCOPE = 'openid profile email offline_access';
export const SERVICE_SCOPE = 'fluffyjaws';
export const END_USER = 'automation';
const SERVER = 'fluffyjaws';
// FluffyJaws refuses a token with less than five minutes left; two more for the request.
const MIN_LIFE_MS = 7 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const LOCK_MS = 30_000;
const WAITS_MS = [150, 300, 600, 900, 1200, 1500, 2000, 2500];
const TIMEOUT_MS = 10_000;
const GONE = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);
export const NOT_CONNECTED = 'Nobody connected FluffyJaws yet: a member of the admin team connects it.';

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async (s) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const issuer = (env) => String(env.FLUFFYJAWS_ISSUER || '').replace(/\/+$/, '');
/** An endpoint of FluffyJaws' Okta authorization server: `authorize`, `token`, `revoke`. */
export const oktaEndpoint = (env, name) => `${issuer(env)}/v1/${name}`;
const redirectUri = (env) => `${String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '')}${CALLBACK_PATH}`;

/** How this deployment gets FluffyJaws tokens: 'service', 'grant', or null (not set up). */
export function fluffyMode(env) {
  // https, but for the UI preview's made-up Okta (scripts/dev-ui-admin.mjs).
  if (!/^(https:\/\/|http:\/\/localhost[:/])/.test(issuer(env))) {
    return null;
  }
  if (env.FLUFFYJAWS_SERVICE_CLIENT_ID && env.FLUFFYJAWS_SERVICE_SECRET) {
    return 'service';
  }
  return env.FLUFFYJAWS_CLIENT_ID && env.TOKEN_KEY && env.PUBLIC_ORIGIN ? 'grant' : null;
}

/** An Okta error, with its OAuth `code` (invalid_grant and so on). */
class OktaError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** A request to the token endpoint: the token response, or an OktaError. */
async function tokenRequest(env, params, { basic, fetch: fetchFn = globalThis.fetch } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (basic) {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(basic.id)}:${encodeURIComponent(basic.secret)}`)}`;
  }
  const res = await fetchFn(oktaEndpoint(env, 'token'), {
    method: 'POST', headers, body: new URLSearchParams(params), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new OktaError(`Okta: ${body.error_description || body.error || `HTTP ${res.status}`}`, body.error);
  }
  return body;
}

// ---- the service app -----------------------------------------------------------------------

let service = null;

/** Forgets the service token this isolate keeps (tests, and a token FluffyJaws refused). */
export function forgetFluffyjaws() {
  service = null;
}

/** A service token, `{ token, expiresAt }`: the one kept, unless it is about to expire. */
async function serviceToken(env, { rejected = null, fetch: fetchFn } = {}) {
  const id = env.FLUFFYJAWS_SERVICE_CLIENT_ID;
  if (service && service.id === id && service.token !== rejected
    && service.expiresAt - MIN_LIFE_MS > Date.now()) {
    return service;
  }
  const t = await tokenRequest(env, { grant_type: 'client_credentials', scope: SERVICE_SCOPE }, {
    basic: { id, secret: env.FLUFFYJAWS_SERVICE_SECRET }, fetch: fetchFn,
  });
  const expiresAt = Date.now() + Number(t.expires_in || 3600) * 1000;
  service = { id, token: t.access_token, expiresAt };
  return service;
}

// ---- the admin's grant ---------------------------------------------------------------------

/** The grant's row; null before anyone started connecting. */
export const grantRow = (env) => env.DB.prepare('SELECT * FROM mcp_global_grants WHERE server = ?')
  .bind(SERVER).first();

/**
 * What the grant's row comes to: none → signing in → connected → rejected → signing in →
 * connected. Disconnecting goes back to none.
 */
export function grantState(row) {
  if (row && row.error) {
    return 'rejected';
  }
  if (row && row.tokens) {
    return 'connected';
  }
  return row && row.pending_state ? 'signing in' : 'none';
}

/** The claims of a JWT, unverified: an ID token straight from Okta's token endpoint, over TLS. */
function claimsOf(jwt) {
  try {
    const part = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(part), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
}

/** Whose the tokens are: `{ actsAs, name }`, from the ID token, else the access token. */
function identityOf(t) {
  const id = t.id_token ? claimsOf(t.id_token) : {};
  const access = claimsOf(t.access_token);
  return {
    actsAs: id.email || id.preferred_username || access.sub || id.sub || null,
    name: id.name || null,
  };
}

const kept = (t) => ({
  access_token: t.access_token,
  token_type: t.token_type || 'Bearer',
  ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
  ...(t.scope ? { scope: t.scope } : {}),
});
const expiry = (t, now) => iso(now + Number(t.expires_in || 3600) * 1000);

/**
 * Starts connecting FluffyJaws for `person` (an id), who comes back to knowledge base `repo`:
 * the URL of Okta's sign-in. What the callback needs is kept with the grant, sealed.
 */
export async function beginConnect(env, person, { repo = null, now = Date.now() } = {}) {
  if (fluffyMode(env) !== 'grant') {
    throw new Error('FLUFFYJAWS_ISSUER, FLUFFYJAWS_CLIENT_ID, TOKEN_KEY and PUBLIC_ORIGIN must be set to connect FluffyJaws');
  }
  const state = random(24);
  const verifier = random(32);
  const pending = await seal(env, JSON.stringify({
    person, repo, verifier, exp: now + PENDING_TTL_MS,
  }));
  await env.DB.prepare(`INSERT INTO mcp_global_grants (server, pending, pending_state)
    VALUES (?, ?, ?) ON CONFLICT (server) DO UPDATE SET pending = excluded.pending,
      pending_state = excluded.pending_state`).bind(SERVER, pending, await sha256(state)).run();
  const url = new URL(oktaEndpoint(env, 'authorize'));
  url.search = new URLSearchParams({
    client_id: env.FLUFFYJAWS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(env),
    scope: SIGN_IN_SCOPE,
    state,
    code_challenge: await sha256(verifier),
    code_challenge_method: 'S256',
  });
  return url.href;
}

/** The grant whose sign-in `state` belongs to; null when there is none. */
export async function grantForState(env, state) {
  return state ? env.DB.prepare('SELECT * FROM mcp_global_grants WHERE pending_state = ?')
    .bind(await sha256(String(state))).first() : null;
}

/** Revokes tokens at Okta (RFC 7009): the refresh token, then the access token. Quietly. */
async function revoke(env, tokens, fetchFn = globalThis.fetch) {
  if (!tokens || !env.FLUFFYJAWS_CLIENT_ID) {
    return;
  }
  const hints = [['refresh_token', tokens.refresh_token], ['access_token', tokens.access_token]];
  for (const [hint, token] of hints.filter(([, t]) => t)) {
    // eslint-disable-next-line no-await-in-loop
    await fetchFn(oktaEndpoint(env, 'revoke'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token, token_type_hint: hint, client_id: env.FLUFFYJAWS_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).then((r) => r.body?.cancel()).catch(() => {});
  }
}

const opened = async (env, sealed) => (sealed ? JSON.parse(await unseal(env, sealed)) : null);

/**
 * Finishes the sign-in that came back with `params` (`code`, or `error`): redeems the code and
 * keeps the tokens, for `person` (`{ id, label }`). Resolves to the knowledge base to go back to;
 * throws with what to tell the person when it cannot. The sign-in under way is used up either way,
 * and a grant from before is revoked once the new one is kept.
 */
export async function finishConnect(env, row, person, params, options = {}) {
  const { fetch: fetchFn = globalThis.fetch, now = Date.now() } = options;
  const p = await opened(env, row.pending).catch(() => null) || {};
  await env.DB.prepare(`UPDATE mcp_global_grants SET pending = NULL, pending_state = NULL
    WHERE server = ?`).bind(SERVER).run();
  if (p.person !== person.id || !(p.exp > now)) {
    throw Object.assign(new Error('this sign-in expired, or was started by someone else: connect again'), { repo: p.repo });
  }
  if (params.error) {
    throw Object.assign(new Error(`Okta did not grant access: ${params.error_description || params.error}`), { repo: p.repo });
  }
  if (!params.code) {
    throw Object.assign(new Error('Okta sent no authorization code back'), { repo: p.repo });
  }
  let t;
  try {
    t = await tokenRequest(env, {
      grant_type: 'authorization_code',
      code: String(params.code),
      redirect_uri: redirectUri(env),
      client_id: env.FLUFFYJAWS_CLIENT_ID,
      code_verifier: p.verifier,
    }, { fetch: fetchFn });
  } catch (e) {
    throw Object.assign(e, { repo: p.repo });
  }
  const before = await opened(env, row.tokens).catch(() => null);
  const who = identityOf(t);
  await env.DB.prepare(`UPDATE mcp_global_grants SET tokens = ?, acts_as = ?, acts_as_name = ?,
      connected_by = ?, connected_at = ?, expires_at = ?, refreshed_at = ?, refresh_lock = NULL,
      error = NULL WHERE server = ?`).bind(
    await seal(env, JSON.stringify(kept(t))),
    who.actsAs,
    who.name,
    person.label,
    iso(now),
    expiry(t, now),
    iso(now),
    SERVER,
  ).run();
  await revoke(env, before, fetchFn);
  return p.repo;
}

/** Disconnects FluffyJaws: revokes the grant at Okta, and forgets it. */
export async function disconnectGrant(env, { fetch: fetchFn = globalThis.fetch } = {}) {
  const row = await grantRow(env);
  await revoke(env, row && await opened(env, row.tokens).catch(() => null), fetchFn);
  await env.DB.prepare('DELETE FROM mcp_global_grants WHERE server = ?').bind(SERVER).run();
}

async function load(env) {
  const row = await grantRow(env);
  const tokens = row && row.tokens ? await opened(env, row.tokens) : null;
  if (!tokens) {
    throw new NotConnectedError((row && row.error) || NOT_CONNECTED);
  }
  return {
    tokens, sealed: row.tokens, at: row.connected_at, expiresAt: Date.parse(row.expires_at) || 0,
  };
}

const usable = (cur, rejected, now) => cur.tokens.access_token !== rejected
  && cur.expiresAt - MIN_LIFE_MS > now;
const answer = (cur) => ({ token: cur.tokens.access_token, expiresAt: cur.expiresAt });

/** Drops grant `cur`, which Okta no longer accepts (unless it changed meanwhile); throws why. */
async function drop(env, cur, why) {
  const { meta } = await env.DB.prepare(`UPDATE mcp_global_grants SET tokens = NULL, error = ?,
      expires_at = NULL WHERE server = ? AND tokens = ?`).bind(why, SERVER, cur.sealed).run();
  if (!meta.changes) {
    return null;
  }
  console.log(JSON.stringify({ route: 'agent', mcp: 'global grant dropped', server: SERVER }));
  throw new NotConnectedError(why);
}

/**
 * Refreshes grant `cur`: the new token, or null when the grant changed meanwhile (a disconnect,
 * or someone connecting again); then the tokens just issued are revoked, unless it is the same
 * grant, refreshed by whoever took over a lease that ran out.
 */
async function refresh(env, cur, fetchFn) {
  if (!cur.tokens.refresh_token) {
    return drop(env, cur, 'the sign-in expired, and Okta gave no refresh token: a member of the admin team connects FluffyJaws again');
  }
  let t;
  try {
    t = await tokenRequest(env, {
      grant_type: 'refresh_token',
      refresh_token: cur.tokens.refresh_token,
      client_id: env.FLUFFYJAWS_CLIENT_ID,
      scope: SIGN_IN_SCOPE,
    }, { fetch: fetchFn });
  } catch (e) {
    if (GONE.has(e.code)) {
      return drop(env, cur, `Okta no longer accepts the sign-in (${e.code}): a member of the admin team connects FluffyJaws again`);
    }
    throw e;
  }
  const now = Date.now();
  const next = { ...cur.tokens, ...kept(t) };
  const expiresAt = expiry(t, now);
  const { meta } = await env.DB.prepare(`UPDATE mcp_global_grants SET tokens = ?, expires_at = ?,
      refreshed_at = ?, error = NULL WHERE server = ? AND tokens = ?`)
    .bind(await seal(env, JSON.stringify(next)), expiresAt, iso(now), SERVER, cur.sealed).run();
  if (!meta.changes) {
    const row = await grantRow(env);
    if (!row || row.connected_at !== cur.at) {
      await revoke(env, next, fetchFn);
    }
    return null;
  }
  return { token: next.access_token, expiresAt: Date.parse(expiresAt) };
}

/** Refreshes under the lease, if this caller gets it: the token, or null for the others. */
async function underLease(env, rejected, fetchFn) {
  const now = Date.now();
  const until = iso(now + LOCK_MS);
  const { meta } = await env.DB.prepare(`UPDATE mcp_global_grants SET refresh_lock = ?
    WHERE server = ? AND (refresh_lock IS NULL OR refresh_lock < ?)`).bind(until, SERVER, iso(now)).run();
  if (!meta.changes) {
    return null;
  }
  try {
    // Someone may have refreshed between the caller's read and the lease.
    const again = await load(env);
    return usable(again, rejected, Date.now()) ? answer(again) : await refresh(env, again, fetchFn);
  } finally {
    await env.DB.prepare(`UPDATE mcp_global_grants SET refresh_lock = NULL
      WHERE server = ? AND refresh_lock = ?`).bind(SERVER, until).run().catch(() => {});
  }
}

/**
 * An access token of the admin's grant, `{ token, expiresAt }`: the stored one, unless it has
 * less than seven minutes left or is `rejected` (the one FluffyJaws just refused); then
 * refreshed, one refresh at a time across every agent.
 */
export async function freshGrantToken(env, options = {}) {
  const { rejected = null, fetch: fetchFn = globalThis.fetch } = options;
  for (const wait of [...WAITS_MS, null]) {
    // eslint-disable-next-line no-await-in-loop
    const cur = await load(env);
    if (usable(cur, rejected, Date.now())) {
      return answer(cur);
    }
    // eslint-disable-next-line no-await-in-loop
    const got = await underLease(env, rejected, fetchFn);
    if (got) {
      return got;
    }
    if (wait === null) {
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(wait);
  }
  throw new Error('the FluffyJaws sign-in is being refreshed by another agent: try again in a moment');
}

// ---- the server ----------------------------------------------------------------------------

/**
 * The transport's AuthProvider: the token before each request, kept in memory until it is about
 * to expire; another one when FluffyJaws answers 401.
 */
function authProvider(env, mode, options) {
  const fresh = mode === 'service' ? serviceToken : freshGrantToken;
  let current = null;
  return {
    async token() {
      if (!current || current.expiresAt - MIN_LIFE_MS <= Date.now()) {
        current = await fresh(env, options);
      }
      return current.token;
    },
    async onUnauthorized() {
      current = await fresh(env, { ...options, rejected: current && current.token });
    },
  };
}

/** The instances of the global server: one, or none and why. */
export async function fluffyInstances(env) {
  const mode = fluffyMode(env);
  if (!mode) {
    return {
      instances: [],
      problem: 'FLUFFYJAWS_ISSUER and FLUFFYJAWS_CLIENT_ID (or a FluffyJaws service app) are not set in this deployment.',
    };
  }
  const row = mode === 'grant' ? await grantRow(env) : null;
  if (mode === 'grant' && grantState(row) !== 'connected') {
    return { instances: [], problem: (row && row.error) || NOT_CONNECTED };
  }
  return { instances: [{ key: SERVER, name: SERVER }], problem: null };
}

/**
 * The server to connect to: `{ id, name, url, headers, authProvider }`, null when it is not set
 * up or nobody connected it.
 */
export async function fluffyConnection(env, id, options = {}) {
  const mode = fluffyMode(env);
  if (!mode || (mode === 'grant' && grantState(await grantRow(env)) !== 'connected')) {
    return null;
  }
  return {
    id,
    name: SERVER,
    url: FLUFFYJAWS_MCP_URL,
    headers: mode === 'service' ? { 'X-FluffyJaws-End-User': END_USER } : {},
    authProvider: authProvider(env, mode, options),
  };
}

/**
 * How FluffyJaws is reached, as the editor shows it: the mode, and for a grant whose identity
 * the agents use, who connected it and when, and why it stopped working. `mayConnect` is for the
 * admin team, where connecting is how it is set up.
 */
export async function fluffyView(env, { admin = false } = {}) {
  const mode = fluffyMode(env);
  const row = mode === 'grant' ? await grantRow(env) : null;
  const connected = grantState(row) === 'connected';
  return {
    mode,
    connected: mode === 'service' || connected,
    actsAs: (connected && row.acts_as) || null,
    actsAsName: (connected && row.acts_as_name) || null,
    by: (connected && row.connected_by) || null,
    at: (connected && row.connected_at) || null,
    error: (row && row.error) || null,
    mayConnect: admin && mode === 'grant',
  };
}
