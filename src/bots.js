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
 * The bots installed in each Teams team opspile knows, so a reply can mention a bot before
 * anyone has mentioned it there. Messages teach opspile bots too (`recordBots` in the
 * normalizer); this fills in the ones nobody has used yet.
 */

import { cachedGraph } from './graph.js';

const APPS = 'installedApps?$expand=teamsAppDefinition($expand=bot)';

/**
 * The bots among the apps installed in one Teams team, `{ id, name }` by the bot's app id
 * (the id a mention carries) and the app's name (what Teams writes when someone mentions it).
 * A failed request gives `{ status, error }` instead.
 */
export async function installedBots(graph, groupId) {
  const bots = new Map();
  let next = `/teams/${encodeURIComponent(groupId)}/${APPS}`;
  while (next) {
    // eslint-disable-next-line no-await-in-loop
    const res = await graph(next);
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { status: res.status, error: data.error ? `${data.error.code}: ${data.error.message}` : '' };
    }
    for (const { teamsAppDefinition: def } of data.value || []) {
      const id = def && def.bot && def.bot.id;
      if (id) {
        bots.set(id, { id, name: def.displayName || null });
      }
    }
    next = data['@odata.nextLink'] || null;
  }
  return { bots: [...bots.values()] };
}

/**
 * Lists the installed apps of every Teams team that has a channel in D1 and keeps
 * `bot_teams` in step: each installed bot gets a row (`installed` set, `at = ''` unless a
 * message showed it there), and a row only the list created goes when the bot is no longer
 * installed. Rows learned from messages stay, without `installed`.
 *
 * Stops at the first 401 or 403: the app lacks the Graph permission, and every other team
 * would fail the same way.
 */
export async function syncInstalledBots(env, { graph, now = Date.now() } = {}) {
  const tenant = env.MS_TENANT_ID;
  const { results } = await env.DB.prepare(`SELECT DISTINCT group_id FROM channels
    WHERE source = 'teams' AND tenant = ? AND group_id IS NOT NULL ORDER BY group_id`)
    .bind(tenant).all();
  const groups = (results || []).map((r) => r.group_id);
  const out = {
    teams: 0, bots: 0, removed: 0, failed: 0,
  };
  if (!groups.length) {
    return out;
  }
  const g = graph || await cachedGraph(env);
  const at = new Date(now).toISOString();
  const named = new Set();
  for (const groupId of groups) {
    // eslint-disable-next-line no-await-in-loop
    const { bots, status, error } = await installedBots(g, groupId);
    if (!bots) {
      if (status === 401 || status === 403) {
        throw new Error(`installedApps ${status} ${error}`.trim());
      }
      out.failed += 1;
      // eslint-disable-next-line no-continue
      continue;
    }
    for (const b of bots) {
      if (!named.has(b.id)) {
        named.add(b.id);
        // The app's name is how Teams mentions the bot; the name it posts under stays.
        // eslint-disable-next-line no-await-in-loop
        await env.DB.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, handle,
            fetched_at) VALUES ('teams', ?, ?, 'bot', ?, ?, ?)
          ON CONFLICT (source, tenant, user_id) DO UPDATE SET
            name = COALESCE(identities.name, excluded.name),
            handle = COALESCE(excluded.handle, identities.handle)`)
          .bind(tenant, b.id, b.name, b.name, at).run();
      }
      // eslint-disable-next-line no-await-in-loop
      await env.DB.prepare(`INSERT INTO bot_teams (source, tenant, bot_id, group_id, at, installed)
          VALUES ('teams', ?, ?, ?, '', ?)
        ON CONFLICT (source, tenant, bot_id, group_id) DO UPDATE SET installed = excluded.installed`)
        .bind(tenant, b.id, groupId, at).run();
    }
    // Bots no longer installed: gone if only the list knew them, otherwise just not installed.
    // eslint-disable-next-line no-await-in-loop
    const { meta } = await env.DB.prepare(`DELETE FROM bot_teams
      WHERE source = 'teams' AND tenant = ? AND group_id = ? AND at = ''
        AND (installed IS NULL OR installed < ?)`).bind(tenant, groupId, at).run();
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare(`UPDATE bot_teams SET installed = NULL
      WHERE source = 'teams' AND tenant = ? AND group_id = ? AND installed < ?`)
      .bind(tenant, groupId, at).run();
    out.teams += 1;
    out.bots += bots.length;
    out.removed += (meta && meta.changes) || 0;
  }
  return out;
}
