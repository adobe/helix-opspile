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

import { getChannel, loadRules } from './lookup.js';
import { followChange } from './refile.js';

/** Channels asked about per cron run. */
export const SWEEP_BATCH = 25;

/** A channel nobody looked up for this long is asked about again. */
export const RECHECK_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cron: looks up again the channels whose row is a week old, oldest first, so that what only the
 * platform knows reaches D1 without a message: that a channel was archived (or restored), which
 * the admin pages read (src/admin.js), or renamed. A channel gets no messages once it is archived,
 * so the normalizer's lookup never sees it. `checked_at` is written after each attempt, answered or
 * not, so a channel the platform no longer shows does not stay at the head of the sweep; it is
 * asked again a week later.
 */
export async function sweepChannels(env, { limit = SWEEP_BATCH, now = Date.now() } = {}) {
  const before = new Date(now - RECHECK_AFTER_MS).toISOString();
  const { results: due = [] } = await env.DB.prepare(`SELECT * FROM channels
    WHERE source != 'portal' AND MAX(fetched_at, COALESCE(checked_at, '')) < ?1
    ORDER BY MAX(fetched_at, COALESCE(checked_at, '')) LIMIT ?2`).bind(before, limit + 1).all();
  const cache = {};
  let checked = 0;
  for (const ch of due.slice(0, limit)) {
    // eslint-disable-next-line no-await-in-loop
    await getChannel(env, {
      source: ch.source,
      tenant: ch.tenant,
      channelId: ch.channel_id,
      groupId: ch.group_id,
      refresh: true,
    }, now, {
      // Renamed since its last lookup: its threads follow, as from the normalizer.
      onChange: async (was, after) => {
        cache.rules = cache.rules || await loadRules(env);
        return followChange(env, ch, { before: was, after }, cache.rules);
      },
    }).catch(() => null);
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare(`UPDATE channels SET checked_at = ?
      WHERE source = ? AND tenant = ? AND channel_id = ?`)
      .bind(new Date(now).toISOString(), ch.source, ch.tenant, ch.channel_id).run();
    checked += 1;
  }
  return { checked, more: due.length > limit };
}
