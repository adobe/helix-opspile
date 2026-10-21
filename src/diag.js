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

import { graphClient, graphToken } from './teams.js';

async function countTeams(graph) {
  let count = 0;
  let next = '/teams?$select=id&$top=999';
  while (next) {
    // eslint-disable-next-line no-await-in-loop
    const res = await graph(next);
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json();
    if (!res.ok) {
      return { status: res.status, error: data.error && data.error.message };
    }
    count += (data.value || []).length;
    next = data['@odata.nextLink'] || null;
  }
  return { count };
}

/**
 * Creates a short-lived tenant-wide channel-message subscription and deletes it again.
 * Proves the app may subscribe to /teams/getAllMessages and that Graph can validate the
 * notification URLs.
 */
async function probeSubscription(graph, origin) {
  const res = await graph('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      changeType: 'created,updated,deleted',
      notificationUrl: `${origin}/teams/notify`,
      lifecycleNotificationUrl: `${origin}/teams/lifecycle`,
      resource: '/teams/getAllMessages',
      expirationDateTime: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      clientState: crypto.randomUUID(),
    }),
  });
  const data = await res.json().catch(() => ({}));
  const result = {
    status: res.status,
    id: data.id,
    expires: data.expirationDateTime,
    error: data.error && `${data.error.code}: ${data.error.message}`,
  };
  if (data.id) {
    const del = await graph(`/subscriptions/${data.id}`, { method: 'DELETE' });
    result.deleted = del.status;
  }
  return result;
}

/**
 * GET /diag/teams — checks the Microsoft side end to end without exposing a token:
 * the granted application roles, how many teams the app can see, and (with `?sub=1`)
 * whether a /teams/getAllMessages subscription can be created.
 */
export async function diagTeams(url, env) {
  const { token, roles, expiresIn } = await graphToken(env);
  const graph = graphClient(token);
  const out = { token: { ok: true, roles, expiresIn } };
  out.teams = await countTeams(graph);
  if (url.searchParams.get('sub') === '1') {
    out.subscription = await probeSubscription(graph, url.origin);
  }
  return out;
}
