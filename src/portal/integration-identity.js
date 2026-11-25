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
 * A registered host's trusted identity provider (`integration_hosts.identity`): instead of
 * signing its own assertion, the host forwards the token its user signed in with, and the tenant,
 * subject and email come from that provider, never from the host. Adobe IMS is the only one.
 * Nothing here logs, keeps or returns a token: caches are keyed by its SHA-256.
 */

import { signedClaims } from '../access.js';

/**
 * IMS environments. Every one serves its keys at `/ims/keys`, and the legacy `ims` key is in
 * every set, so an access token is only taken from its own environment's `ims_na1…-key-` keys
 * and with its own `as` (authorization server) claim.
 */
export const IMS = {
  prod: { issuer: 'https://ims-na1.adobelogin.com', as: 'ims-na1', kid: 'ims_na1-key-' },
  stg1: {
    issuer: 'https://ims-na1-stg1.adobelogin.com', as: 'ims-na1-stg1', kid: 'ims_na1-stg1-key-',
  },
};
const FIELDS = ['provider', 'environment', 'issuer', 'keys', 'clientIds', 'tenant', 'subject',
  'email'];
const KEYS_TTL = 60 * 60 * 1000;
const KEYS_REFETCH = 60 * 1000; // at most this often for a key it does not have yet
const TOKEN_TTL = 5 * 60 * 1000;
const PROFILE_TTL = 60 * 1000;
const MAX = 1000;
const id = (s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 256;

/** A provider that cannot answer: the request is retried, the token is not wrong. */
export class UpstreamError extends Error {}

/**
 * The host's provider, or null for a host that signs assertions. A configuration that is not
 * exactly one this file knows throws: such a host authorizes nobody.
 */
export function hostIdentity(host) {
  if (host.identity === null || host.identity === undefined) {
    return null;
  }
  const c = JSON.parse(host.identity);
  const ims = IMS[c?.environment];
  if (!c || typeof c !== 'object' || Array.isArray(c) || !ims
    || Object.keys(c).some((k) => !FIELDS.includes(k)) || c.provider !== 'adobe-ims'
    || c.issuer !== ims.issuer || host.issuer !== ims.issuer || c.keys !== `${ims.issuer}/ims/keys`
    || !Array.isArray(c.clientIds) || c.clientIds.length === 0 || c.clientIds.length > 20
    || !c.clientIds.every(id) || c.tenant !== 'profile.ownerOrg' || c.subject !== 'token.user_id'
    || (c.email !== 'profile.email' && c.email !== null)) {
    throw new Error('unsupported host identity');
  }
  return { ...c, ims };
}

/** Insertion-ordered, so the first key is the oldest: a bounded cache drops it. */
function remember(map, key, value) {
  map.delete(key);
  if (map.size >= MAX) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
  return value;
}

let keySets = new Map();
let tokens = new Map();
let profiles = new Map();

export function resetIdentityCache() {
  keySets = new Map();
  tokens = new Map();
  profiles = new Map();
}

async function upstream(fetchImpl, url, init) {
  let res;
  try {
    res = await fetchImpl(url, {
      redirect: 'manual', signal: AbortSignal.timeout(5000), ...init,
    });
  } catch {
    throw new UpstreamError('unreachable');
  }
  return res;
}

async function imsKeys(c, kid, fetchImpl, now) {
  const cached = keySets.get(c.environment);
  if (cached && now - cached.at < KEYS_TTL
    && (cached.keys.some((k) => k.kid === kid) || now - cached.at < KEYS_REFETCH)) {
    return cached.keys;
  }
  const res = await upstream(fetchImpl, c.keys);
  let keys;
  try {
    keys = res.ok ? (await res.json()).keys : null;
  } catch {
    keys = null;
  }
  if (!Array.isArray(keys)) {
    throw new UpstreamError(`keys ${res.status}`);
  }
  // Only the environment's own signing keys; a key in every set never selects an environment.
  const own = keys.filter((k) => k?.kid?.startsWith(c.ims.kid));
  remember(keySets, c.environment, { at: now, keys: own });
  return own;
}

const digest = async (token) => Buffer.from(await crypto.subtle.digest(
  'SHA-256',
  new TextEncoder().encode(token),
)).toString('hex');
const millis = (v) => ((typeof v === 'string' && /^\d{1,15}$/.test(v))
  || (Number.isSafeInteger(v) && v >= 0) ? Number(v) : NaN);

/**
 * The verified claims of an IMS access token of this environment, or null. `exp` (ms) is
 * `created_at + expires_in`: IMS access tokens carry no `exp`, `iat` or `aud`. The client is
 * the host's to check: the cache is the same for every host.
 */
async function imsToken(c, token, fetchImpl, now) {
  const hash = `${c.environment}:${await digest(token)}`;
  const hit = tokens.get(hash);
  if (hit && hit.until > now) {
    return hit.claims.exp > now ? hit.claims : null;
  }
  let kid;
  try {
    kid = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))?.kid;
  } catch {
    return null;
  }
  if (typeof kid !== 'string' || !kid.startsWith(c.ims.kid)) {
    return null;
  }
  const t = await signedClaims(token, () => imsKeys(c, kid, fetchImpl, now))
    .catch((e) => {
      if (e instanceof UpstreamError) {
        throw e;
      }
      return null;
    });
  const created = millis(t?.created_at);
  const exp = created + millis(t?.expires_in);
  if (!t || t.type !== 'access_token' || t.as !== c.ims.as
    || (t.iss !== undefined && t.iss !== c.issuer) || !id(t.client_id) || !id(t.user_id)
    || !(created <= now + 60 * 1000) || !(exp > now)) {
    return null;
  }
  const claims = { clientId: t.client_id, userId: t.user_id, exp };
  remember(tokens, hash, { claims, until: Math.min(now + TOKEN_TTL, exp) });
  return claims;
}

/** What the provider's profile says of the token's user, or null if it rejects the token. */
function imsProfile(c, token, hash, fetchImpl, now) {
  const hit = profiles.get(hash);
  if (hit && hit.until > now) {
    return hit.profile;
  }
  const profile = (async () => {
    const res = await upstream(fetchImpl, `${c.issuer}/ims/profile/v1`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      return null;
    }
    let p;
    try {
      p = res.ok ? await res.json() : null;
    } catch {
      p = null;
    }
    if (!p || typeof p !== 'object') {
      throw new UpstreamError(`profile ${res.status}`);
    }
    // Only what maps; the rest of the profile is never kept.
    return {
      userId: p.userId,
      ownerOrg: p.ownerOrg,
      email: p.email,
      emailVerified: p.emailVerified === true || p.emailVerified === 'true',
    };
  })();
  remember(profiles, hash, { profile, until: now + PROFILE_TTL });
  // A failure is not kept: the next request asks again.
  profile.catch(() => profiles.get(hash)?.profile === profile && profiles.delete(hash));
  return profile;
}

/**
 * The caller of a host with a provider, from its user token alone: `{ tenant, sub, email,
 * email_verified }`, the same names as an assertion's. Null when the token is not one this host
 * takes, `{ tenant: null }` when it is but names no organization. Throws UpstreamError when the
 * provider cannot be asked.
 */
export async function tokenUser(c, token, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!token || token.length > 16384) {
    return null;
  }
  const claims = await imsToken(c, token, fetchImpl, now);
  if (!claims || !c.clientIds.includes(claims.clientId)) {
    return null;
  }
  return {
    claims,
    async profile() {
      const hash = `${c.environment}:${await digest(token)}`;
      const p = await imsProfile(c, token, hash, fetchImpl, now);
      if (!p || p.userId !== claims.userId) {
        return null;
      }
      const owner = typeof p.ownerOrg === 'string' && /^[A-Za-z0-9]{1,64}@AdobeOrg$/.test(p.ownerOrg);
      return {
        tenant: owner ? p.ownerOrg : null,
        sub: claims.userId,
        email: c.email && id(p.email) ? p.email : undefined,
        email_verified: c.email ? p.emailVerified : undefined,
      };
    },
  };
}
