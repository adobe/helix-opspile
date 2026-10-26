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

import { backfillTeams } from './backfill.js';
import { cachedGraph } from './graph.js';
import { messageKey, putRaw } from './raw.js';

/**
 * Teams catch-up: after a gap in change notifications (the subscription was recreated, or
 * Graph reports `missed`), every known Teams channel is read from the history APIs for what
 * changed since then, and stored in pile 1 like a backfill; the normalizer merges it with what
 * already arrived, so overlap is harmless.
 *
 * Per channel: the root messages changed since `since` (`messages/delta`), each with its
 * replies, and the threads that were active in the days before, whose replies may have come in
 * the gap.
 */

const MAX_PAGES = 20;
const RECENT_DAYS = 3;
const MARGIN_MS = 10 * 60 * 1000;

/** Queues one catch-up job per known Teams channel. Returns how many. */
export async function startCatchUp(env, sinceMs, why) {
  const since = new Date(sinceMs - MARGIN_MS).toISOString();
  const { results } = await env.DB.prepare(`SELECT tenant, channel_id, group_id FROM channels
    WHERE source = 'teams' AND group_id IS NOT NULL`).all();
  const jobs = (results || []).map((c) => ({
    body: {
      catchup: {
        tenant: c.tenant, groupId: c.group_id, channelId: c.channel_id, since,
      },
    },
  }));
  for (let i = 0; i < jobs.length; i += 100) {
    // eslint-disable-next-line no-await-in-loop
    await env.NORMALIZE.sendBatch(jobs.slice(i, i + 100));
  }
  console.log(JSON.stringify({
    route: 'catchup', why, since, channels: jobs.length,
  }));
  return jobs.length;
}

/** One channel: roots changed since `since`, with replies, and recent threads' replies. */
export async function runCatchUp(env, job, { graph: injected } = {}) {
  const graph = injected || await cachedGraph(env);
  const {
    tenant, groupId, channelId, since,
  } = job;
  const roots = new Set();
  let next = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}`
    + `/messages/delta?$filter=${encodeURIComponent(`lastModifiedDateTime gt ${since}`)}`;
  let stored = 0;
  for (let page = 0; next && page < MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await graph(next);
    if (!res.ok) {
      return { result: 'catchup-failed', error: `graph ${res.status} delta`, stored };
    }
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json();
    for (const message of data.value || []) {
      roots.add(message.id);
      // eslint-disable-next-line no-await-in-loop
      const ref = { teamId: groupId, channelId, messageId: message.id };
      const key = messageKey(tenant, ref, message);
      // eslint-disable-next-line no-await-in-loop
      await putRaw(env, key, JSON.stringify(message), { source: 'teams', via: 'catchup' });
      stored += 1;
    }
    next = data['@odata.nextLink'] || null;
  }
  const recent = new Date(Date.parse(since) - RECENT_DAYS * 24 * 3600 * 1000).toISOString();
  const { results } = await env.DB.prepare(`SELECT DISTINCT root_id FROM threads
    WHERE source = 'teams' AND channel_id = ? AND COALESCE(last_at, any_at) > ?`)
    .bind(channelId, recent).all();
  for (const r of results || []) {
    roots.add(r.root_id);
  }
  let replies = 0;
  for (const rootId of roots) {
    // eslint-disable-next-line no-await-in-loop
    replies += await backfillTeams(env, {
      tenant, groupId, channelId, rootId,
    }, { graph }).catch(() => 0);
  }
  return {
    result: 'caught-up', changed: stored, threads: roots.size, messages: replies,
  };
}
