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

import {
  discoverOAuthServerInfo, exchangeAuthorization, extractWWWAuthenticateParams,
  refreshAuthorization, registerClient, selectResourceURL, startAuthorization,
} from '@modelcontextprotocol/client';
import { seal, unseal } from '../post.js';

/**
 * OAuth for the agents' MCP servers (`mcp_servers.auth` 'oauth', migration 0034): opspile is
 * the OAuth client, the MCP server's authorization server grants it access.
 *
 * - **Connecting** (the knowledge-base editor, someone who manages the server): discovery as
 *   MCP clients do it (the server's 401 and RFC 9728 protected resource metadata, then RFC 8414
 *   or OpenID metadata of its authorization server), the client registered on its own (RFC
 *   7591) unless staff gave a client id, then authorization code with PKCE (S256) and the
 *   resource indicator (RFC 8707). The browser goes to the authorization server and comes back
 *   to CALLBACK_PATH, behind Access: only the person who started may finish, within ten minutes.
 * - **Using it** (agents, the editor's check): the transport asks `token()` before each request;
 *   a token about to expire, or one the server refused (401), is refreshed. Refresh tokens may
 *   be single-use (opspile's own are), and many agents share one grant, so one refresh at a
 *   time: whoever takes the lease in D1 (`oauth_lock`) refreshes, the others wait and read the
 *   result. A grant the server no longer accepts is dropped, with the reason, until someone
 *   connects again.
 * - **Keeping it**: the cron refreshes grants that were not refreshed for a week, so a refresh
 *   token that expires when unused (opspile's own after 30 days) stays alive while nobody calls.
 *
 * Everything but the person, the time and the expiry is sealed with TOKEN_KEY. The agents act
 * as whoever connected the server.
 */

export const CALLBACK_PATH = '/api/kb/mcp/oauth/callback';
export const KEEP_ALIVE_MS = 7 * 24 * 3600_000;
const PENDING_TTL_MS = 10 * 60_000;
const EXPIRY_MARGIN_MS = 2 * 60_000;
const LOCK_MS = 30_000;
const WAITS_MS = [150, 300, 600, 900, 1200, 1500, 2000, 2500];
const REVOKE_TIMEOUT_MS = 5000;
const CLIENT_NAME = 'opspile agents';
// What the authorization server says when a grant or a client is gone for good.
const GONE = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async (s) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const iso = (ms) => new Date(ms).toISOString();
const origin = (env) => String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** Where the authorization server sends the browser back. */
export const redirectUri = (env) => `${origin(env)}${CALLBACK_PATH}`;

/** A server that is not (or no longer) connected: someone has to connect it. */
export class NotConnectedError extends Error {}

export const NOT_CONNECTED = 'not connected yet: someone who manages it has to Connect it in the knowledge-base editor';

/** The sealed `oauth` column, opened: `{ config, server, client, tokens }`. */
export async function openOauth(env, sealed) {
  return sealed ? JSON.parse(await unseal(env, sealed)) : {};
}

const sealOauth = (env, o) => seal(env, JSON.stringify(o));

/**
 * Finds the authorization server of the MCP server at `url`: `{ authorizationServerUrl,
 * metadata, resource, scope }`, `scope` being what the server asks for.
 */
export async function discover(url, fetchFn = globalThis.fetch) {
  let challenge = {};
  // Asked without credentials, a server that wants a sign-in answers 401, and its
  // WWW-Authenticate says where its metadata is and which scope it wants.
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: CLIENT_NAME, version: '1.0.0' } },
    }),
  }).catch(() => null);
  if (res) {
    if (res.status === 401 || res.status === 403) {
      challenge = extractWWWAuthenticateParams(res);
    }
    await res.body?.cancel().catch(() => {});
  }
  const info = await discoverOAuthServerInfo(url, {
    resourceMetadataUrl: challenge.resourceMetadataUrl, fetchFn,
  });
  const metadata = info.authorizationServerMetadata;
  if (!metadata) {
    throw new Error('the server publishes no OAuth metadata, so it does not take an OAuth sign-in: give it request headers instead');
  }
  const resource = await selectResourceURL(url, {}, info.resourceMetadata);
  const asked = challenge.scope || (info.resourceMetadata?.scopes_supported || []).join(' ');
  return {
    authorizationServerUrl: info.authorizationServerUrl,
    metadata,
    // Sent as the metadata says it, not as a parsed URL (a trailing slash would differ).
    resource: resource ? info.resourceMetadata.resource : undefined,
    scope: asked || undefined,
  };
}

/** The scope to ask for: staff's, else the server's, with offline_access where it is known. */
function scopeFor(config, server) {
  const scopes = String(config.scope || server.scope || '').split(/\s+/).filter(Boolean);
  if ((server.metadata.scopes_supported || []).includes('offline_access') && !scopes.includes('offline_access')) {
    scopes.push('offline_access');
  }
  return scopes.join(' ') || undefined;
}

/**
 * The client to sign in as: the one staff gave, the one registered before at the same
 * authorization server, or a new registration.
 */
async function clientFor(env, o, server, scope, fetchFn) {
  const config = o.config || {};
  if (config.clientId) {
    return {
      client: {
        client_id: config.clientId,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      },
      clientIssuer: server.metadata.issuer,
    };
  }
  const redirect = redirectUri(env);
  if (o.client && o.clientIssuer === server.metadata.issuer && !o.client.given
    && (o.client.redirect_uris || []).includes(redirect)) {
    return { client: o.client, clientIssuer: o.clientIssuer };
  }
  if (!server.metadata.registration_endpoint) {
    throw new Error('the server does not let clients register themselves: register one there (redirect URI '
      + `${redirect}) and give its client id`);
  }
  const methods = server.metadata.token_endpoint_auth_methods_supported || [];
  const method = ['client_secret_basic', 'client_secret_post'].find((m) => methods.includes(m)) || 'none';
  const client = await registerClient(server.authorizationServerUrl, {
    metadata: server.metadata,
    clientMetadata: {
      client_name: CLIENT_NAME,
      client_uri: origin(env),
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
    },
    scope,
    fetchFn,
  });
  return { client, clientIssuer: server.metadata.issuer };
}

/**
 * Starts connecting server `row` (an `mcp_servers` row) for person `person`: the URL to send
 * the browser to. What the callback needs is kept with the row, sealed.
 */
export async function beginSignIn(env, row, person, options = {}) {
  const { fetch: fetchFn = globalThis.fetch, now = Date.now() } = options;
  if (!env.PUBLIC_ORIGIN || !env.TOKEN_KEY) {
    throw new Error('PUBLIC_ORIGIN and TOKEN_KEY must be set to connect with OAuth');
  }
  const o = await openOauth(env, row.oauth);
  const server = await discover(row.url, fetchFn);
  const scope = scopeFor(o.config || {}, server);
  const { client, clientIssuer } = await clientFor(env, o, server, scope, fetchFn);
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const started = await startAuthorization(server.authorizationServerUrl, {
    metadata: server.metadata,
    clientInformation: client,
    redirectUrl: redirectUri(env),
    scope,
    state,
    resource: server.resource,
  });
  const pending = await seal(env, JSON.stringify({
    person,
    url: row.url,
    exp: now + PENDING_TTL_MS,
    verifier: started.codeVerifier,
    server: { ...server, scope },
    client: { ...client, given: Boolean((o.config || {}).clientId) },
    clientIssuer,
  }));
  await env.DB.prepare('UPDATE mcp_servers SET oauth_pending = ?, oauth_state = ? WHERE id = ?')
    .bind(pending, await sha256(state), row.id).run();
  return started.authorizationUrl.href;
}

/** The server whose sign-in `state` belongs to; null when there is none. */
export async function serverForState(env, state) {
  return state ? env.DB.prepare('SELECT * FROM mcp_servers WHERE oauth_state = ?')
    .bind(await sha256(String(state))).first() : null;
}

/** The tokens as kept: no `expires_in`, the expiry is a column. */
const kept = (t) => ({
  access_token: t.access_token,
  token_type: t.token_type || 'Bearer',
  ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
  ...(t.scope ? { scope: t.scope } : {}),
});

const expiry = (t, now) => (t.expires_in ? iso(now + Number(t.expires_in) * 1000) : null);

/**
 * Finishes the sign-in of `row` that came back with `params` (`code`, `iss`, or `error`):
 * redeems the code and keeps the tokens, for `person` (`{ id, label }`). Throws with what to
 * tell the person when it cannot. The sign-in under way is used up either way.
 */
export async function finishSignIn(env, row, person, params, options = {}) {
  const { fetch: fetchFn = globalThis.fetch, now = Date.now() } = options;
  const p = await openOauth(env, row.oauth_pending).catch(() => ({}));
  await env.DB.prepare(`UPDATE mcp_servers SET oauth_pending = NULL, oauth_state = NULL
    WHERE id = ?`).bind(row.id).run();
  if (p.person !== person.id || !(p.exp > now) || p.url !== row.url) {
    throw new Error('this sign-in expired, or was started by someone else or for another URL: connect again');
  }
  if (params.error) {
    throw new Error(`the server did not grant access: ${params.error_description || params.error}`);
  }
  if (!params.code) {
    throw new Error('the server sent no authorization code back');
  }
  const tokens = await exchangeAuthorization(p.server.authorizationServerUrl, {
    metadata: p.server.metadata,
    clientInformation: p.client,
    authorizationCode: String(params.code),
    iss: params.iss ? String(params.iss) : undefined,
    codeVerifier: p.verifier,
    redirectUri: redirectUri(env),
    resource: p.server.resource,
    fetchFn,
  });
  const o = await openOauth(env, row.oauth);
  const next = {
    config: o.config || {},
    server: p.server,
    client: p.client,
    clientIssuer: p.clientIssuer,
    tokens: kept(tokens),
  };
  await env.DB.prepare(`UPDATE mcp_servers SET oauth = ?, oauth_by = ?, oauth_at = ?,
      oauth_expires_at = ?, oauth_refreshed_at = ?, oauth_error = NULL, oauth_lock = NULL,
      updated_by = ?, updated_at = ? WHERE id = ?`)
    .bind(
      await sealOauth(env, next),
      person.label,
      iso(now),
      expiry(tokens, now),
      iso(now),
      person.label,
      iso(now),
      row.id,
    ).run();
}

/**
 * What the `oauth_*` columns of an `mcp_servers` row come to:
 *
 *   none → signing in → connected → rejected → signing in → connected
 *
 * `connected` includes a refresh under way (`oauth_lock`), which agents wait out. Disconnecting,
 * and a change of URL or client, go back to `none`, and may leave a sign-in under way behind.
 */
export function grantState(row) {
  if (row.oauth_error) {
    return 'rejected';
  }
  if (row.oauth_by) {
    return 'connected';
  }
  return row.oauth_state ? 'signing in' : 'none';
}

async function load(env, id) {
  const row = await env.DB.prepare(`SELECT oauth, oauth_at, oauth_expires_at, oauth_error
    FROM mcp_servers WHERE id = ? AND auth = 'oauth'`).bind(id).first();
  const o = row && row.oauth ? await openOauth(env, row.oauth) : null;
  if (!o || !o.tokens) {
    throw new NotConnectedError((row && row.oauth_error) || NOT_CONNECTED);
  }
  return {
    o,
    sealed: row.oauth,
    at: row.oauth_at,
    expiresAt: row.oauth_expires_at ? Date.parse(row.oauth_expires_at) : null,
  };
}

const usable = (cur, rejected, now) => cur.o.tokens.access_token !== rejected
  && (!cur.expiresAt || cur.expiresAt - EXPIRY_MARGIN_MS > now);

const answer = (cur) => ({ token: cur.o.tokens.access_token, expiresAt: cur.expiresAt });

/**
 * Revokes the grant at the authorization server (RFC 7009), if it has a revocation endpoint:
 * the refresh token, and the access token for servers that do not revoke both at once. Quietly.
 */
async function revoke(o, fetchFn) {
  const endpoint = o.server && o.server.metadata && o.server.metadata.revocation_endpoint;
  if (!endpoint || !o.tokens || !o.client) {
    return;
  }
  const hints = [['refresh_token', o.tokens.refresh_token], ['access_token', o.tokens.access_token]];
  for (const [hint, token] of hints.filter(([, t]) => t)) {
    const body = new URLSearchParams({
      token,
      token_type_hint: hint,
      client_id: o.client.client_id,
      ...(o.client.client_secret ? { client_secret: o.client.client_secret } : {}),
    });
    // eslint-disable-next-line no-await-in-loop
    await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    }).then((r) => r.body?.cancel()).catch(() => {});
  }
}

/**
 * Drops the tokens of grant `cur`, which the server no longer accepts, and throws why. Only that
 * grant: when someone connected again meanwhile, this is null, as for a refresh that lost.
 */
async function drop(env, id, cur, why) {
  const { meta } = await env.DB.prepare(`UPDATE mcp_servers SET oauth = ?, oauth_error = ?,
      oauth_expires_at = NULL, updated_at = ? WHERE id = ? AND oauth = ?`)
    .bind(await sealOauth(env, { ...cur.o, tokens: null }), why, iso(Date.now()), id, cur.sealed)
    .run();
  if (!meta.changes) {
    return null;
  }
  console.log(JSON.stringify({ route: 'agent', mcp: 'oauth dropped', id }));
  throw new NotConnectedError(why);
}

/**
 * Refreshes grant `cur`: the new token, or null when the grant changed meanwhile (a disconnect,
 * or someone connecting again). Those writes do not wait for the lease, and a refresh that comes
 * back after them must not bring the old grant back: the row stays as it is, and the tokens just
 * issued are revoked, so nothing outlives the grant.
 */
async function refresh(env, id, cur, fetchFn) {
  const { o } = cur;
  if (!o.tokens.refresh_token) {
    return drop(env, id, cur, 'the sign-in expired, and the server gave no refresh token: connect it again');
  }
  let tokens;
  try {
    tokens = await refreshAuthorization(o.server.authorizationServerUrl, {
      metadata: o.server.metadata,
      clientInformation: o.client,
      refreshToken: o.tokens.refresh_token,
      resource: o.server.resource,
      fetchFn,
    });
  } catch (e) {
    if (GONE.has(e.code)) {
      return drop(env, id, cur, `the server no longer accepts the sign-in (${e.code}): connect it again`);
    }
    throw e;
  }
  const now = Date.now();
  const next = { ...o, tokens: kept(tokens) };
  const expiresAt = expiry(tokens, now);
  const { meta } = await env.DB.prepare(`UPDATE mcp_servers SET oauth = ?, oauth_expires_at = ?,
      oauth_refreshed_at = ?, oauth_error = NULL WHERE id = ? AND oauth = ?`)
    .bind(await sealOauth(env, next), expiresAt, iso(now), id, cur.sealed).run();
  if (!meta.changes) {
    // Unless it is the same grant, refreshed by whoever took over a lease that ran out: a server
    // that hands out the same refresh token twice would lose the one now stored.
    const row = await env.DB.prepare('SELECT oauth_at FROM mcp_servers WHERE id = ?').bind(id).first();
    if (!row || row.oauth_at !== cur.at) {
      await revoke(next, fetchFn);
    }
    return null;
  }
  return { token: next.tokens.access_token, expiresAt: expiresAt ? Date.parse(expiresAt) : null };
}

/** Takes the refresh lease of server `id`: its time, or null while someone else holds it. */
async function lease(env, id) {
  const now = Date.now();
  const until = iso(now + LOCK_MS);
  const res = await env.DB.prepare(`UPDATE mcp_servers SET oauth_lock = ?
    WHERE id = ? AND (oauth_lock IS NULL OR oauth_lock < ?)`).bind(until, id, iso(now)).run();
  return res.meta && res.meta.changes ? until : null;
}

/** Gives lease `until` back, unless it ran out and someone else holds the lock now. */
const release = (env, id, until) => env.DB.prepare(`UPDATE mcp_servers SET oauth_lock = NULL
  WHERE id = ? AND oauth_lock = ?`).bind(id, until).run().catch(() => {});

/** Refreshes under the lease, if this caller gets it: the token, or null for the others. */
async function underLease(env, id, rejected, fetchFn) {
  const until = await lease(env, id);
  if (!until) {
    return null;
  }
  try {
    // Someone may have refreshed between the caller's read and the lease.
    const again = await load(env, id);
    return usable(again, rejected, Date.now()) ? answer(again)
      : await refresh(env, id, again, fetchFn);
  } finally {
    await release(env, id, until);
  }
}

/**
 * An access token for server `id`, `{ token, expiresAt }`: the stored one, unless it is about to
 * expire or is `rejected` (the one the server just refused); then refreshed, one refresh at a
 * time across every agent.
 */
export async function freshToken(env, id, options = {}) {
  const { rejected = null, fetch: fetchFn = globalThis.fetch } = options;
  for (const wait of [...WAITS_MS, null]) {
    // eslint-disable-next-line no-await-in-loop
    const cur = await load(env, id);
    if (usable(cur, rejected, Date.now())) {
      return answer(cur);
    }
    // eslint-disable-next-line no-await-in-loop
    const got = await underLease(env, id, rejected, fetchFn);
    if (got) {
      return got;
    }
    if (wait === null) {
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(wait);
  }
  throw new Error('the sign-in is being refreshed by another agent: try again in a moment');
}

/**
 * The transport's AuthProvider for server `id`: the token before each request, kept in memory
 * until it is about to expire; a refresh when the server answers 401.
 */
export function oauthAuthProvider(env, id, options = {}) {
  let current = null;
  return {
    async token() {
      if (!current || (current.expiresAt && current.expiresAt - EXPIRY_MARGIN_MS <= Date.now())) {
        current = await freshToken(env, id, options);
      }
      return current.token;
    },
    async onUnauthorized() {
      current = await freshToken(env, id, { ...options, rejected: current && current.token });
    },
  };
}

/** Revokes the grant of server `row` where the server can; quietly. */
export async function revokeGrant(env, row, { fetch: fetchFn = globalThis.fetch } = {}) {
  const o = await openOauth(env, row.oauth).catch(() => ({}));
  await revoke(o, fetchFn);
}

/** Disconnects server `row`: revokes its grant where the server can, and forgets it. */
export async function disconnect(env, row, by, { fetch: fetchFn = globalThis.fetch } = {}) {
  const o = await openOauth(env, row.oauth).catch(() => ({}));
  await revoke(o, fetchFn);
  await env.DB.prepare(`UPDATE mcp_servers SET oauth = ?, oauth_by = NULL, oauth_at = NULL,
      oauth_expires_at = NULL, oauth_refreshed_at = NULL, oauth_error = NULL, oauth_lock = NULL,
      oauth_pending = NULL, oauth_state = NULL, tools = NULL, checked_at = NULL,
      check_error = NULL, updated_by = ?, updated_at = ? WHERE id = ?`)
    .bind(
      await sealOauth(env, {
        config: o.config || {}, client: o.client, clientIssuer: o.clientIssuer,
      }),
      by,
      iso(Date.now()),
      row.id,
    ).run();
}

/**
 * Cron: refreshes the grants nobody refreshed for KEEP_ALIVE_MS, so that refresh tokens that
 * expire unused stay alive. Resolves to what happened, per server id.
 */
export async function keepOAuthAlive(env, options = {}) {
  const { now = Date.now(), fetch: fetchFn = globalThis.fetch } = options;
  const { results } = await env.DB.prepare(`SELECT id, name FROM mcp_servers
    WHERE auth = 'oauth' AND enabled = 1 AND oauth_by IS NOT NULL AND oauth_error IS NULL
      AND (oauth_refreshed_at IS NULL OR oauth_refreshed_at < ?)
    ORDER BY oauth_refreshed_at LIMIT 20`).bind(iso(now - KEEP_ALIVE_MS)).all();
  const out = {};
  for (const s of results || []) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const cur = await load(env, s.id);
      if (cur.o.tokens.refresh_token) {
        // eslint-disable-next-line no-await-in-loop
        await freshToken(env, s.id, { rejected: cur.o.tokens.access_token, fetch: fetchFn });
        out[`${s.id}`] = 'refreshed';
      } else {
        out[`${s.id}`] = 'no refresh token';
      }
    } catch (e) {
      out[`${s.id}`] = String(e.message || e).slice(0, 200);
    }
  }
  return out;
}
