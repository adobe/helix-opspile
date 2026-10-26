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

import { cachedGraph } from './graph.js';

/** One tenant-wide subscription for every channel message, roots and replies. */
export const RESOURCE = '/teams/getAllMessages';

/**
 * Graph allows at most 60 minutes for channel-message subscriptions; the cron renews
 * every 20 minutes, so one missed run is harmless.
 */
export const LIFETIME_MINUTES = 55;

const normalize = (resource) => `/${String(resource || '').replace(/^\/+/, '')}`.toLowerCase();

/** Origins this Worker answered on before (comma-separated `RETIRED_ORIGINS`), without `/`. */
export function retiredOrigins(env) {
  return String(env.RETIRED_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o.startsWith('https://'));
}

function urls(env) {
  const origin = String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  if (!origin.startsWith('https://')) {
    throw new Error('PUBLIC_ORIGIN must be the https origin of this Worker');
  }
  return {
    notificationUrl: `${origin}/teams/notify`,
    lifecycleNotificationUrl: `${origin}/teams/lifecycle`,
  };
}

async function body(res) {
  const data = await res.json().catch(() => ({}));
  return data;
}

async function fail(what, res) {
  const data = await body(res);
  const reason = data.error ? `${data.error.code}: ${data.error.message}` : '';
  return new Error(`${what} ${res.status} ${reason}`.trim());
}

/**
 * Makes sure exactly one subscription of ours exists and expires LIFETIME_MINUTES from
 * now: renews the newest one, deletes duplicates, creates one if there is none.
 *
 * Graph's own subscription list is the record, so no id has to be stored. A
 * subscription counts as ours when its resource is RESOURCE and its notification URL is
 * this Worker's `/teams/notify`; it then carries GRAPH_CLIENT_STATE, because only this
 * function creates subscriptions with that URL (the diag probe uses `?probe=1`).
 */
export async function ensureSubscription(env, { graph, now = Date.now() } = {}) {
  const g = graph || await cachedGraph(env);
  const { notificationUrl, lifecycleNotificationUrl } = urls(env);
  const expirationDateTime = new Date(now + LIFETIME_MINUTES * 60 * 1000).toISOString();

  const list = await g('/subscriptions');
  if (!list.ok) {
    throw await fail('list', list);
  }
  const all = (await body(list)).value || [];
  const ours = all
    .filter((s) => normalize(s.resource) === normalize(RESOURCE)
      && s.notificationUrl === notificationUrl)
    .sort((a, b) => Date.parse(b.expirationDateTime) - Date.parse(a.expirationDateTime));
  const [newest, ...duplicates] = ours;

  // Subscriptions that still point at an origin this Worker moved away from (RETIRED_ORIGINS)
  // go once the current one exists: they would deliver every message a second time.
  const retired = retiredOrigins(env);
  let stale = all.filter((s) => normalize(s.resource) === normalize(RESOURCE)
    && retired.some((o) => s.notificationUrl === `${o}/teams/notify`));
  // After the current subscription is renewed, moved or created: deletes the retired ones.
  const retire = async () => {
    let n = 0;
    const gone = stale;
    stale = [];
    for (const old of gone) {
      // eslint-disable-next-line no-await-in-loop
      const del = await g(`/subscriptions/${old.id}`, { method: 'DELETE' });
      n += del.ok || del.status === 404 ? 1 : 0;
    }
    return n;
  };

  let removed = 0;
  for (const dup of duplicates) {
    // eslint-disable-next-line no-await-in-loop
    const del = await g(`/subscriptions/${dup.id}`, { method: 'DELETE' });
    if (del.ok || del.status === 404) {
      removed += 1;
    }
  }

  // Graph allows one getAllMessages subscription per app and tenant, so after a move the
  // retired one is moved to the new URL in place (no gap in which messages are missed).
  // Its lifecycle URL stays on the retired origin, which keeps answering /teams/*.
  const move = !newest && stale.find((x) => Date.parse(x.expirationDateTime) > now);
  if (move) {
    stale = stale.filter((x) => x.id !== move.id);
    const res = await g(`/subscriptions/${move.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ notificationUrl, expirationDateTime }),
    });
    if (res.ok) {
      const data = await body(res);
      return {
        action: 'moved', id: move.id, expires: data.expirationDateTime, removed, retired: await retire(),
      };
    }
    if (res.status !== 404) {
      throw await fail('move', res);
    }
  }
  // Before creating one: Graph allows a single subscription, so the retired ones go first.
  const retiredBefore = newest ? 0 : await retire();

  if (newest && Date.parse(newest.expirationDateTime) > now) {
    const res = await g(`/subscriptions/${newest.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expirationDateTime }),
    });
    if (res.ok) {
      const data = await body(res);
      return {
        action: 'renewed', id: newest.id, expires: data.expirationDateTime, removed, retired: await retire(),
      };
    }
    if (res.status !== 404) {
      throw await fail('renew', res);
    }
    // Gone between list and renew: create a new one below.
  }

  if (!env.GRAPH_CLIENT_STATE) {
    throw new Error('GRAPH_CLIENT_STATE is not set');
  }
  const res = await g('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      changeType: 'created,updated,deleted',
      notificationUrl,
      lifecycleNotificationUrl,
      resource: RESOURCE,
      includeResourceData: false,
      expirationDateTime,
      clientState: env.GRAPH_CLIENT_STATE,
    }),
  });
  if (!res.ok) {
    throw await fail('create', res);
  }
  const data = await body(res);
  return {
    action: 'created', id: data.id, expires: data.expirationDateTime, removed, retired: retiredBefore,
  };
}

/**
 * Acts on one accepted lifecycle notification. `reauthorizationRequired` and
 * `subscriptionRemoved` are both answered by ensureSubscription (renew or recreate).
 * `missed` means notifications were dropped; the catch-up from the history APIs is #8,
 * so for now it is only logged.
 */
export async function handleLifecycle(env, item, options) {
  const event = item.lifecycleEvent;
  if (event === 'reauthorizationRequired' || event === 'subscriptionRemoved') {
    return { event, ...await ensureSubscription(env, options) };
  }
  return { event, action: 'none' };
}
