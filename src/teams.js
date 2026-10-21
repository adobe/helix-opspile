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

import { text } from './http.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Microsoft Graph change-notification and lifecycle endpoint.
 *
 * Graph validates a subscription's URLs by POSTing `?validationToken=…` and expects the
 * token echoed back as text/plain within 10 seconds. Anything else is acknowledged with
 * 202 and, for now, dropped.
 */
export function teamsNotify(url) {
  const token = url.searchParams.get('validationToken');
  if (token) return text(token);
  return text('', 202);
}

function decodeClaims(jwt) {
  const payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(payload));
}

/**
 * Client-credentials token for Microsoft Graph.
 *
 * This must run server-side: Entra rejects confidential-client token redemption from any
 * request carrying a browser `Origin` header (AADSTS9002326).
 */
export async function graphToken(env) {
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    client_secret: env.MS_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const url = `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`;
  const res = await fetch(url, { method: 'POST', body });
  const data = await res.json();
  if (!data.access_token) {
    const reason = (data.error_description || '').split('\r\n')[0];
    throw new Error(`token ${res.status} ${data.error}: ${reason}`);
  }
  const claims = decodeClaims(data.access_token);
  return {
    token: data.access_token,
    roles: (claims.roles || []).sort(),
    expiresIn: data.expires_in,
  };
}

/**
 * Returns a fetch wrapper bound to one Graph access token.
 */
export function graphClient(token) {
  return (path, init = {}) => {
    const target = path.startsWith('https://') ? path : `${GRAPH}${path}`;
    return fetch(target, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    });
  };
}
