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

import { accessClaims, signedClaims } from '../access.js';
import { hostIdentity, tokenUser, UpstreamError } from './integration-identity.js';
import { captureAccess, pruneAccess } from './integration-requests.js';
import { autoEnroll } from './integration-auto.js';

export const BASE = '/integrations/portal/v1';
export const WEEK = 7 * 24 * 60 * 60;
const id = (s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 256;

export class IntegrationError extends Error {
  constructor(status, code, detail = null) {
    super(code);
    this.status = status;
    // More of the error body: an access request's state (`{ request, reason? }`).
    this.detail = detail;
  }
}

export function fail(status, code, detail = null) {
  throw new IntegrationError(status, code, detail);
}

/** A host-signed assertion: short-lived, single-use, bound to the request's method and path. */
async function assertion(request, host, aud, jwt, scope, now, invalid) {
  const c = await signedClaims(jwt, () => JSON.parse(host.jwks).keys).catch(() => null);
  if (!c || c.iss !== host.issuer || c.aud !== aud || c.method !== request.method
      || c.path !== new URL(request.url).pathname || !id(c.tenant) || !id(c.sub) || !id(c.jti)
      || !Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp) || c.iat > now
      || c.exp <= now || c.exp - c.iat > 60
      || (c.nbf !== undefined && (!Number.isSafeInteger(c.nbf) || c.nbf > now))) {
    invalid();
  }
  if (c.scope !== scope || !JSON.parse(host.scopes).includes(scope)) {
    fail(403, 'not_enrolled');
  }
  return c;
}

/**
 * The user's own token, for a host whose registration names its identity provider: the tenant,
 * subject and email are the provider's, the scope the route's. The token is not single-use, so
 * each admitted operation gets its own nonce for the rate limits.
 */
async function userToken(identity, host, jwt, scope, options, invalid) {
  const unavailable = (e) => {
    if (e instanceof UpstreamError) {
      console.warn(`portal integration: identity provider unavailable (${e.message})`);
      fail(503, 'unavailable');
    }
    throw e;
  };
  const user = await tokenUser(identity, jwt, options).catch(unavailable);
  if (!user) {
    invalid();
  }
  if (!JSON.parse(host.scopes).includes(scope)) {
    fail(403, 'not_enrolled');
  }
  const c = await user.profile().catch(unavailable);
  if (!c) {
    invalid();
  }
  // A profile without an organization (a personal Adobe ID) is let through to enrollment: only
  // a member placed by a caught mail domain, with that verified address, can be one.
  return {
    ...c, tenant: id(c.tenant) ? c.tenant : null, jti: `token:${crypto.randomUUID()}`, organization: user.organization,
  };
}

/** Only Access's signed service identity selects the host and therefore how it names users. */
export async function authorize(request, env, scope, options = {}) {
  const aud = env.PORTAL_INTEGRATION_AUD;
  const invalid = () => fail(401, 'invalid_assertion');
  if (!aud || aud === env.ACCESS_AUD) {
    invalid();
  }
  const service = await accessClaims(request, {
    ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN, ACCESS_AUD: aud,
  }, options).catch(() => null);
  if (service?.type !== 'app' || service.sub !== '' || !id(service.common_name)) {
    invalid();
  }
  const host = await env.DB.prepare('SELECT * FROM integration_hosts WHERE service_id = ?')
    .bind(service.common_name).first();
  if (!host) {
    invalid();
  }
  const jwt = /^Bearer ([^ ]+)$/i.exec(request.headers.get('Authorization') || '')?.[1];
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  let identity;
  try {
    identity = hostIdentity(host);
  } catch {
    console.warn('portal integration: host identity provider misconfigured');
    invalid();
  }
  const c = identity
    ? await userToken(identity, host, jwt, scope, options, invalid)
    : await assertion(request, host, aud, jwt, scope, now, invalid);

  // A provider's subject is its user ID, one per host (portal migration 0007): it resolves to its
  // channel when its tenant is the channel's or one it lists, or, for a member a caught domain
  // placed, with its verified address (checked below). An assertion's subject is the tenant's.
  const find = () => env.DB.prepare(`SELECT c.channel, c.name AS channelName,
      m.actor, m.cursor_key, a.verified_email, u.name FROM integration_customers c
    JOIN integration_members m ON m.channel = c.channel
    JOIN integration_actors a ON a.channel = m.channel AND a.actor = m.actor
    JOIN users u ON u.id = m.actor
    WHERE c.host = ?1 AND c.enabled = 1 AND m.subject = ?3 AND m.active = 1
      AND u.kind = 'customer' AND u.email IS NULL AND (c.tenant = ?2 ${identity ? `
        OR m.via = 'org:' || ?2 OR EXISTS (SELECT 1 FROM integration_catches k WHERE k.host = ?1
          AND k.channel = c.channel AND k.kind = 'tenant' AND k.value = ?2)
        OR (m.via LIKE 'domain:%' AND a.verified_email IS NOT NULL)` : ''})
    LIMIT 1`).bind(host.id, c.tenant || '', c.sub).first();
  const admitted = (m) => m && (m.verified_email === null || (c.email_verified === true
    && id(c.email) && c.email.trim().toLowerCase() === m.verified_email));
  const announce = (what) => {
    const told = Promise.resolve()
      .then(() => env.OPSPILE?.accessRequested?.(what))
      .catch(() => console.warn('portal integration: access request not announced'));
    options.waitUntil?.(told);
  };
  let member = await find();
  if (!member && identity) {
    // An organization the admin team onboarded: enrolled on their first call.
    const enrolled = await autoEnroll(env, host, c, {
      now: options.now ?? Date.now(), notify: announce,
    })
      .catch(() => {
        console.warn('portal integration: auto-approval failed');
        return false;
      });
    member = enrolled ? await find() : null;
  }
  if (!admitted(member)) {
    // A verified caller of a provider host asks for access by calling: recorded for the admin
    // team, and the body says how it stands. An assertion host enrolls its users by hand.
    const detail = identity ? await captureAccess(env, host, c, {
      now: options.now ?? Date.now(),
      organization: c.organization,
      notify: (requestId) => announce({ id: requestId }),
    }).catch(() => {
      console.warn('portal integration: access request not recorded');
      return null;
    }) : null;
    fail(403, 'not_enrolled', detail);
  }
  // One atomic admission: count only authenticated operations in the last minute. The nonce
  // lives at least the full assertion lifetime, including for a host that issues shorter JWTs.
  const { meta } = await env.DB.prepare(`INSERT INTO integration_nonces(host, channel, actor,
      jti, used_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM integration_nonces
      WHERE host = ?1 AND used_at > ?5 - 60 LIMIT 1 OFFSET 5999)
    AND NOT EXISTS (SELECT 1 FROM integration_nonces WHERE channel = ?2 AND used_at > ?5 - 60
      LIMIT 1 OFFSET 599)
    AND NOT EXISTS (SELECT 1 FROM integration_nonces WHERE actor = ?3 AND used_at > ?5 - 60
      LIMIT 1 OFFSET 59) ON CONFLICT DO NOTHING`)
    .bind(host.id, member.channel, member.actor, c.jti, now).run();
  if (!meta.changes) {
    if (await env.DB.prepare('SELECT 1 FROM integration_nonces WHERE host = ? AND jti = ?')
      .bind(host.id, c.jti).first()) {
      invalid();
    }
    fail(429, 'rate_limited');
  }
  return { ...member, topics: JSON.parse(host.topics) };
}

/** Opaque, authenticated continuation of one collection for one enrolled viewer. */
export async function cursorCodec(member, collection, now) {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(member.cursor_key, 'hex'),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
  const additionalData = new TextEncoder().encode(JSON.stringify([member.channel, member.actor,
    collection]));
  return {
    async seal(position) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const bytes = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData },
        key,
        new TextEncoder().encode(JSON.stringify({ exp: now + WEEK * 1000, position })),
      );
      return Buffer.concat([iv, new Uint8Array(bytes)]).toString('base64url');
    },
    async open(token) {
      if (!token || token.length > 512 || !/^[a-zA-Z0-9_-]+$/.test(token)) {
        fail(400, 'invalid_cursor');
      }
      let decoded;
      try {
        const bytes = Buffer.from(token, 'base64url');
        decoded = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({
          name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData,
        }, key, bytes.subarray(12))));
      } catch {
        fail(400, 'invalid_cursor');
      }
      if (decoded.exp <= now) {
        fail(410, 'cursor_expired');
      }
      return decoded.position;
    },
  };
}

export async function pruneIntegration(env, now = Date.now()) {
  const sec = Math.floor(now / 1000);
  // Bounded work per tick. The floor moves transactionally with each deleted change.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM integration_changes WHERE seq IN (SELECT seq FROM integration_changes
      WHERE at < ? ORDER BY at LIMIT 5000)`).bind(sec - WEEK),
    env.DB.prepare(`DELETE FROM integration_nonces WHERE rowid IN (SELECT rowid FROM integration_nonces
      WHERE used_at <= ? LIMIT 20000)`).bind(sec - 60),
    pruneAccess(env.DB, sec),
  ]);
}
