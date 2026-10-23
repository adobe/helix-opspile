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
 * Channels shared by several ops teams (migration 0024). A channel is filed under one team,
 * its first (`threads.team`, chosen by the rules): its pile-2 folders, knowledge base and
 * agents are that team's. The teams in `channel_teams` follow it as well: its threads are in
 * their inboxes, and their members read, reply, react, resolve and draft there.
 */

import { ADMIN_TEAM } from './review.js';
import { UNASSIGNED } from './rules.js';

/**
 * Teams that hold a channel only until a real team takes it: adding a team to a channel one
 * of these holds moves it there, adding one to any other channel shares it.
 */
export const HOLDING = [ADMIN_TEAM, UNASSIGNED];
export const isHolding = (team) => !team || HOLDING.includes(team);

/**
 * SQL: the thread row `alias` is in a channel shared with team `param`. A row-value IN, not
 * EXISTS, so that `team = ? OR …` still searches threads by index (both terms are indexed).
 */
export const sharedWith = (alias, param) => `(${alias}.source, ${alias}.channel_id) IN (
  SELECT source, channel_id FROM channel_teams WHERE team = ${param})`;

/** The teams a channel is shared with (besides the team it is filed under), by slug. */
export async function sharesOf(env, source, channelId) {
  if (!env.DB || !source || !channelId) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT team FROM channel_teams
    WHERE source = ? AND channel_id = ? ORDER BY added_at, team`).bind(source, String(channelId)).all();
  return (results || []).map((r) => r.team);
}

/**
 * Every team whose inbox has a thread (a row with `team`, `source` and `channel_id`): the
 * team it is filed under first, then the teams its channel is shared with.
 */
export async function teamsOf(env, row) {
  if (!row) {
    return [];
  }
  const shares = await sharesOf(env, row.source, row.channel_id);
  return [...new Set([row.team, ...shares].filter(Boolean))];
}

/**
 * The shares of many channels at once: `Map<"source:channelId", team[]>`.
 */
export async function sharesByChannel(env) {
  const { results } = await env.DB.prepare(`SELECT source, channel_id, team FROM channel_teams
    ORDER BY added_at, team`).all();
  const out = new Map();
  for (const r of results || []) {
    const k = `${r.source}:${r.channel_id}`;
    out.set(k, [...(out.get(k) || []), r.team]);
  }
  return out;
}

/** Whether `me` is in one of `teams` (a slug or a list of them). */
export const memberOf = (me) => (teams) => [].concat(teams || [])
  .some((team) => (me.teams || []).some((t) => t.slug === team));

/**
 * The team a viewer sees a thread as: `wanted` if the thread is in its inbox and the viewer is
 * in it, else the first of the thread's teams the viewer is in, else the team it is filed
 * under.
 */
export function viewTeam(me, teams, wanted) {
  const mine = teams.filter((t) => memberOf(me)(t));
  if (wanted && mine.includes(wanted)) {
    return wanted;
  }
  return mine[0] || teams[0] || null;
}

/** Shares a channel with a team, as `by`. Returns whether it was not shared with it yet. */
export async function share(env, {
  source, channelId, team, by,
}) {
  const { meta } = await env.DB.prepare(`INSERT INTO channel_teams (source, channel_id, team,
      added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(source, String(channelId), team, by || null, new Date().toISOString()).run();
  return Boolean(meta.changes);
}

/** Stops sharing a channel with a team. Returns whether it was shared with it. */
export async function unshare(env, { source, channelId, team }) {
  const { meta } = await env.DB.prepare(`DELETE FROM channel_teams
    WHERE source = ? AND channel_id = ? AND team = ?`).bind(source, String(channelId), team).run();
  return Boolean(meta.changes);
}
