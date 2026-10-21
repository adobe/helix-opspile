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
 * Cloudflare Access in front of the inbox (`/inbox`, `/api/*`). Access signs in the user
 * and adds a `Cf-Access-Jwt-Assertion` header; the Worker verifies that JWT itself
 * (signature, audience, issuer, expiry), so a request that bypasses Access gets nothing.
 *
 * Vars: ACCESS_TEAM_DOMAIN (`https://<team>.cloudflareaccess.com`), ACCESS_AUD (the
 * application's audience tag).
 */

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

let keyCache = { at: 0, keys: [] };

async function signingKeys(teamDomain, fetchImpl, now) {
  if (keyCache.domain !== teamDomain || now - keyCache.at > 60 * 60 * 1000) {
    const res = await fetchImpl(`${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) {
      throw new Error(`access certs ${res.status}`);
    }
    const { keys } = await res.json();
    keyCache = { domain: teamDomain, at: now, keys };
  }
  return keyCache.keys;
}

export function resetKeyCache() {
  keyCache = { at: 0, keys: [] };
}

/**
 * @returns {Promise<string|null>} the verified email, or null
 */
export async function accessEmail(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const jwt = request.headers.get('cf-access-jwt-assertion');
  const teamDomain = String(env.ACCESS_TEAM_DOMAIN || '').replace(/\/+$/, '');
  if (!jwt || !teamDomain || !env.ACCESS_AUD) {
    return null;
  }
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    return null;
  }
  let header;
  let claims;
  try {
    header = json(parts[0]);
    claims = json(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') {
    return null;
  }
  const jwk = (await signingKeys(teamDomain, fetchImpl, now)).find((k) => k.kid === header.kid);
  if (!jwk) {
    return null;
  }
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const seconds = now / 1000;
  if (!ok || !aud.includes(env.ACCESS_AUD) || claims.iss !== teamDomain
    || !(claims.exp > seconds) || (claims.nbf && claims.nbf > seconds + 60)) {
    return null;
  }
  return typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
}
