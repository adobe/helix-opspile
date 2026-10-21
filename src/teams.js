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
import {
  dayPath, putRaw, segment, sha256,
} from './raw.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

const RESOURCE = /^\/?teams\('([^']+)'\)\/channels\('([^']+)'\)\/messages\('([^']+)'\)(?:\/replies\('([^']+)'\))?$/;

/**
 * Parses a channel-message resource path from a change notification, for example
 * `teams('…')/channels('…')/messages('…')` or `…/messages('…')/replies('…')`.
 */
export function parseResource(resource) {
  const m = RESOURCE.exec(resource || '');
  if (!m) {
    return null;
  }
  const [, teamId, channelId, rootId, replyId] = m;
  const reply = replyId ? `/replies/${encodeURIComponent(replyId)}` : '';
  const path = `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}`
    + `/messages/${encodeURIComponent(rootId)}${reply}`;
  return {
    teamId, channelId, rootId, messageId: replyId || rootId, path,
  };
}

/**
 * Pile-1 key of one notification:
 * `teams/<tenant>/<team>/<channel>/<yyyy>/<mm>/<dd>/notification-<hash>.json`.
 *
 * Graph notifications carry no event id, so the key is the hash of the notification
 * itself: a redelivery overwrites its own object. Lifecycle notifications, and any
 * resource that is not a channel message, use `_lifecycle` or `_` for team and channel.
 */
export async function notificationKey(tenantId, item, json, received, lifecycle) {
  const res = parseResource(item.resource);
  const team = lifecycle ? '_lifecycle' : segment(res && res.teamId);
  const channel = lifecycle ? '_' : segment(res && res.channelId);
  const hash = (await sha256(json)).slice(0, 32);
  return `teams/${segment(tenantId)}/${team}/${channel}/${dayPath(received)}/notification-${hash}.json`;
}

/**
 * Pile-1 key of a fetched message version:
 * `teams/<tenant>/<team>/<channel>/<yyyy>/<mm>/<dd>/<lastModified ms>-<messageId>.json`.
 * Two fetches of the same version share a key.
 */
export function messageKey(tenantId, res, message) {
  const modified = new Date(message.lastModifiedDateTime || message.createdDateTime);
  return `teams/${segment(tenantId)}/${segment(res.teamId)}/${segment(res.channelId)}/`
    + `${dayPath(modified)}/${modified.getTime()}-${segment(message.id || res.messageId)}.json`;
}

let cachedToken = null;

async function cachedGraph(env) {
  if (!cachedToken || cachedToken.until < Date.now()) {
    // eslint-disable-next-line no-use-before-define
    const { token, expiresIn } = await graphToken(env);
    cachedToken = { token, until: Date.now() + (Number(expiresIn) - 300) * 1000 };
  }
  // eslint-disable-next-line no-use-before-define
  return graphClient(cachedToken.token);
}

/**
 * Fetches the message a notification points to and stores it next to the notification.
 * A message that is gone (404) leaves only the notification; the deletion is then
 * known from its `changeType`.
 */
export async function fetchAndStore(env, tenantId, item, notification) {
  const res = parseResource(item.resource);
  if (!res) {
    return null;
  }
  const graph = await cachedGraph(env);
  const response = await graph(res.path);
  if (response.status === 404) {
    console.log(JSON.stringify({ route: 'teams', changeType: item.changeType, fetched: 404 }));
    return null;
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`graph ${response.status}`);
  }
  const message = JSON.parse(body);
  const key = messageKey(tenantId, res, message);
  await putRaw(env, key, body, {
    source: 'teams', via: 'fetch', notification, changeType: item.changeType,
  });
  console.log(JSON.stringify({
    route: 'teams', changeType: item.changeType, reply: Boolean(message.replyToId), key,
  }));
  return key;
}

/**
 * Microsoft Graph change-notification and lifecycle endpoint.
 *
 * Graph validates a subscription's URLs by POSTing `?validationToken=…` and expects the
 * token echoed back as text/plain within 10 seconds.
 *
 * A notification counts only if its `clientState` equals the GRAPH_CLIENT_STATE secret
 * (the value our subscriptions are created with, #5); anything else is dropped. Each
 * accepted notification is stored before the 202, without its `clientState`. The
 * message it points to is fetched after the response, because Graph expects an answer
 * within 3 seconds.
 */
export async function teamsNotify(request, url, env, ctx) {
  const token = url.searchParams.get('validationToken');
  if (token) {
    return text(token);
  }
  const lifecycle = url.pathname === '/teams/lifecycle';
  const route = lifecycle ? 'teams-lifecycle' : 'teams';
  const body = await request.json().catch(() => null);
  const items = (body && Array.isArray(body.value)) ? body.value : [];
  const secret = env.GRAPH_CLIENT_STATE;
  const accepted = secret ? items.filter((n) => n && n.clientState === secret) : [];
  const log = {
    route,
    count: items.length,
    rejected: items.length - accepted.length,
    changeTypes: [...new Set(accepted.map((n) => n.changeType).filter(Boolean))],
    lifecycleEvents: [...new Set(accepted.map((n) => n.lifecycleEvent).filter(Boolean))],
  };

  const received = new Date();
  try {
    for (const item of accepted) {
      const json = JSON.stringify({ ...item, clientState: undefined });
      const tenantId = item.tenantId || env.MS_TENANT_ID;
      // eslint-disable-next-line no-await-in-loop
      const key = await notificationKey(tenantId, item, json, received, lifecycle);
      // eslint-disable-next-line no-await-in-loop
      await putRaw(env, key, json, {
        source: 'teams', via: lifecycle ? 'lifecycle' : 'notification', resource: item.resource,
      });
      if (!lifecycle) {
        ctx.waitUntil(fetchAndStore(env, tenantId, item, key).catch((e) => {
          console.error(JSON.stringify({ route, error: e.message }));
        }));
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ ...log, error: e.message }));
    return text('storage error\n', 500);
  }
  console.log(JSON.stringify(log));
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
