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

// messageKey (the catch-up and backfill use it too) and parseResource (the normalizer reads a
// deletion's notification with it) live in raw.js; parseResource is kept exported here.
import { cachedGraph } from './graph.js';
import { text } from './http.js';
import { handleLifecycle } from './subscription.js';
import {
  dayPath, messageKey, parseResource, putRaw, segment, sha256, writeRaw,
} from './raw.js';

export { parseResource };

// How long one step of storing a notification may take before it is logged as slow: Graph
// cancels a notification it has had no answer to within a few seconds, and retries it later.
const SLOW_STEP_MS = 1500;

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
 * Fetches the message a notification points to and stores it next to the notification.
 * A message that is gone (404, as a deleted channel message is) leaves only the notification:
 * the normalizer files a `deleted` one as the message's tombstone (`normalizeTeams`).
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
 * within 3 seconds. Lifecycle notifications renew or recreate the subscription.
 *
 * Its log line says how long each step took (`steps`: body, hash, r2, queue, in ms) and in all
 * (`ms`); a step that takes longer than `slowMs` is logged while it runs (`slow`, with the
 * notification's `changeType` and `resource`), since Graph may cancel the request first.
 */
export async function teamsNotify(request, url, env, ctx, { slowMs = SLOW_STEP_MS } = {}) {
  const token = url.searchParams.get('validationToken');
  if (token) {
    return text(token);
  }
  const lifecycle = url.pathname === '/teams/lifecycle';
  const route = lifecycle ? 'teams-lifecycle' : 'teams';
  const started = Date.now();
  const steps = {};
  // Graph gives up after a few seconds; a step that hangs is logged while it hangs, since the
  // request may be cancelled before the line at the end.
  const step = async (name, fn, info = {}) => {
    const at = Date.now();
    const watch = setTimeout(() => console.warn(JSON.stringify({
      route, slow: name, ms: Date.now() - started, ...info,
    })), slowMs);
    try {
      return await fn();
    } finally {
      clearTimeout(watch);
      steps[name] = (steps[name] || 0) + Date.now() - at;
    }
  };
  const body = await step('body', () => request.json().catch(() => null));
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
      const info = { changeType: item.changeType, resource: item.resource };
      // eslint-disable-next-line no-await-in-loop
      const key = await step('hash', () => notificationKey(tenantId, item, json, received, lifecycle), info);
      // As putRaw, a step at a time: which of the two hangs, when one does.
      // eslint-disable-next-line no-await-in-loop
      await step('r2', () => writeRaw(env, key, json, {
        source: 'teams', via: lifecycle ? 'lifecycle' : 'notification', resource: item.resource,
      }), info);
      // eslint-disable-next-line no-await-in-loop
      await step('queue', () => env.NORMALIZE.send({ key }), info);
      if (!lifecycle) {
        ctx.waitUntil(fetchAndStore(env, tenantId, item, key).catch((e) => {
          console.error(JSON.stringify({ route, error: e.message }));
        }));
      }
    }
  } catch (e) {
    console.error(JSON.stringify({
      ...log, error: e.message, steps, ms: Date.now() - started,
    }));
    return text('storage error\n', 500);
  }
  Object.assign(log, { steps, ms: Date.now() - started });
  console.log(JSON.stringify(log));
  if (lifecycle) {
    // One renewal or re-creation answers every lifecycle event in the batch.
    const item = accepted.find((n) => n.lifecycleEvent !== 'missed') || accepted[0];
    if (item) {
      ctx.waitUntil(handleLifecycle(env, item)
        .then((r) => console.log(JSON.stringify({ route, ...r })))
        .catch((e) => console.error(JSON.stringify({ route, error: e.message }))));
    }
  }
  return text('', 202);
}

export { messageKey };
