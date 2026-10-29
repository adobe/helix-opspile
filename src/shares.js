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
 * Whether `me` is on no ops team: someone who signed in from one of SIGNIN_DOMAINS (see
 * `personByEmail` in src/api.js). They have the personal view only.
 */
export const teamless = (me) => Boolean(me) && !(me.teams || []).length;

/**
 * SQL: the channels person `param` (an SQL parameter) posted or was mentioned in, as rows of
 * `(source, channel_id)`: the channels of their personal view, whichever team they are filed
 * under. Both by index (migrations 0004, 0030).
 */
export const personalChannels = (param) => `SELECT source, channel_id FROM messages
    WHERE person = ${param}
  UNION SELECT c.source, c.channel_id FROM mentions n JOIN threads c ON c.thread = n.thread
    WHERE n.person = ${param}`;

/**
 * SQL: thread row `alias` is in a channel of person `param`'s personal view. The channel id
 * first, so that threads are searched by it (`threads_channel`, migration 0021), not scanned.
 */
export const inPersonalView = (alias, param) => `${alias}.channel_id IN (
    SELECT channel_id FROM (${personalChannels(param)}))
  AND (${alias}.source, ${alias}.channel_id) IN (${personalChannels(param)})`;

/**
 * Which of `people` (ids) posted or were mentioned in channel `place` (`source`, `channel_id`):
 * whose personal view has it. A Set of ids.
 */
export async function inChannel(env, people, place) {
  const ids = [...new Set([].concat(people || []).filter(Boolean))];
  if (!ids.length || !place || !place.source || place.channel_id == null) {
    return new Set();
  }
  const { results } = await env.DB.prepare(`SELECT person FROM messages
      WHERE person IN (SELECT value FROM json_each(?1)) AND source = ?2 AND channel_id = ?3
    UNION SELECT n.person FROM mentions n JOIN threads c ON c.thread = n.thread
      WHERE n.person IN (SELECT value FROM json_each(?1)) AND c.source = ?2 AND c.channel_id = ?3`)
    .bind(JSON.stringify(ids), place.source, String(place.channel_id)).all();
  return new Set((results || []).map((r) => r.person));
}

/** Whether person `person` posted or was mentioned in channel `place`. */
export async function inPersonalChannel(env, person, place) {
  return (await inChannel(env, [person], place)).has(person);
}

/**
 * Who may work a thread (read, reply, react, resolve, draft): `(teams, place) => Promise<bool>`
 * for a thread whose inbox teams are `teams` and whose channel is `place` (a row with `source`
 * and `channel_id`). A member of one of the teams may, and so may anyone in the channels of
 * their personal view (posted or mentioned there), whichever team they are filed under.
 */
export const mayWork = (env, me) => async (teams, place) => memberOf(me)(teams)
  || (Boolean(me) && inPersonalChannel(env, me.id, place));

/**
 * The rooms (teams, by slug) a person's inbox listens to: their own teams', and the rooms of
 * the teams their personal view's channels are filed under. In those other rooms they hear
 * only about the channels of their personal view (`scoped`, room.js).
 */
export async function roomsOf(env, me) {
  const own = (me.teams || []).map((t) => t.slug);
  const { results } = await env.DB.prepare(`SELECT DISTINCT team FROM threads t
    WHERE ${inPersonalView('t', '?1')} AND team IS NOT NULL ORDER BY team`)
    .bind(me.id).all();
  return [...new Set([...own, ...(results || []).map((r) => r.team)])];
}

/**
 * Which of a room's sockets get `event`: `sockets` are `{ person, scoped }`, `scoped` for
 * someone who is not on the room's team and hears only about the channels of their personal
 * view. Events about a thread (`event.thread`) go to them when its channel is one of those;
 * events about nothing in particular, only to the team. Returns the sockets to send to.
 */
export async function recipients(env, event, sockets) {
  const scoped = sockets.filter((s) => s.scoped);
  if (!scoped.length) {
    return sockets;
  }
  let allowed = new Set();
  if (event && typeof event.thread === 'string') {
    const place = await env.DB.prepare('SELECT source, channel_id FROM threads WHERE thread = ?')
      .bind(event.thread).first();
    allowed = await inChannel(env, scoped.map((s) => s.person), place);
  }
  return sockets.filter((s) => !s.scoped || allowed.has(s.person));
}

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
