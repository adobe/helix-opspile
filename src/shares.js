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

import { ADMIN_TEAM, isAdmin } from './review.js';
import { UNASSIGNED } from './rules.js';
import {
  followedByPerson, followersOf, followersOfAreas, followersOfTech, followingTeams, followsEntry,
} from './follows.js';

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
 * Every team whose inbox has a thread (a row with `team`, `source` and `channel_id`, and its
 * `thread`): the team it is filed under first, then the teams its channel is shared with, then
 * the teams that follow a technology its entry shows (src/follows.js). A row without `thread`
 * is a channel's, which no one follows.
 */
export async function teamsOf(env, row) {
  if (!row) {
    return [];
  }
  const [shares, follows] = await Promise.all([
    sharesOf(env, row.source, row.channel_id),
    row.thread ? followingTeams(env, row.thread) : [],
  ]);
  return [...new Set([row.team, ...shares, ...follows].filter(Boolean))];
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
 * SQL: thread row `alias` is in a channel that one of the teams in `param` (an SQL parameter, a
 * JSON array of slugs) owns: filed under it, or shared with it. Ignored channels own nothing.
 */
const ownedBy = (alias, param) => `${alias}.kind != 'ignore' AND (
    ${alias}.team IN (SELECT value FROM json_each(${param}))
    OR (${alias}.source, ${alias}.channel_id) IN (SELECT source, channel_id FROM channel_teams
      WHERE team IN (SELECT value FROM json_each(${param}))))`;

/**
 * The customers (org slugs) the teams `teams` (slugs) own: those with a channel filed under one
 * of them or shared with one. A team's members read the knowledge bases of the customers it
 * owns, and its managers change them. A Set.
 */
export async function ownedCustomers(env, teams) {
  if (!(teams || []).length) {
    return new Set();
  }
  const { results } = await env.DB.prepare(`SELECT DISTINCT t.org FROM threads t
    WHERE ${ownedBy('t', '?1')} AND t.org IS NOT NULL`).bind(JSON.stringify(teams)).all();
  return new Set((results || []).map((r) => r.org));
}

/**
 * The ops teams (slugs) that own customer `org` (see `ownedCustomers`): its channels are filed
 * under them or shared with them. Sorted.
 */
export async function customerTeams(env, org) {
  if (!org || !env.DB) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT t.team FROM threads t
      WHERE t.org = ?1 AND t.kind != 'ignore' AND t.team IS NOT NULL
    UNION SELECT c.team FROM channel_teams c WHERE (c.source, c.channel_id) IN (
      SELECT source, channel_id FROM threads WHERE org = ?1 AND kind != 'ignore')`)
    .bind(String(org)).all();
  return [...new Set((results || []).map((r) => r.team).filter((t) => !isHolding(t)))].sort();
}

/** Whether one of `teams` (slugs) owns customer `org` (see `ownedCustomers`), by `threads_org`. */
export async function ownsCustomer(env, teams, org) {
  if (!(teams || []).length || !org) {
    return false;
  }
  const row = await env.DB.prepare(`SELECT 1 FROM threads t
    WHERE t.org = ?2 AND ${ownedBy('t', '?1')} LIMIT 1`).bind(JSON.stringify(teams), String(org)).first();
  return Boolean(row);
}

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
 * SQL: the channels of person `param`'s personal view as its list has them: `personalChannels`,
 * but those of a customer they muted (customer_marks.muted_at, migration 0099) only where they
 * posted or were mentioned after the mute. A person who muted none reads no more than before:
 * the mute is looked for by its key, and the channel's customer and later posts only for one.
 */
export const listedChannels = (param) => `SELECT source, channel_id FROM (${personalChannels(param)}) pc
    WHERE NOT EXISTS (SELECT 1 FROM customer_marks u WHERE u.person = ${param}
      AND u.muted_at IS NOT NULL
      AND u.org = (SELECT x.org FROM threads x
        WHERE x.channel_id = pc.channel_id AND x.source = pc.source LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.person = ${param}
        AND m.source = pc.source AND m.channel_id = pc.channel_id AND m.at > u.muted_at)
      AND NOT EXISTS (SELECT 1 FROM mentions n JOIN threads c ON c.thread = n.thread
        WHERE n.person = ${param} AND n.at > u.muted_at
          AND c.source = pc.source AND c.channel_id = pc.channel_id))`;

/**
 * SQL: thread row `alias` is of a customer person `param` muted, and has had no activity since
 * (customer_marks.muted_at): what they follow does not bring it into their personal view.
 */
const mutedBefore = (alias, param) => `EXISTS (SELECT 1 FROM customer_marks u
    WHERE u.person = ${param} AND u.org = ${alias}.org
      AND u.muted_at >= COALESCE(${alias}.last_at, ${alias}.any_at))`;

/**
 * SQL: thread row `alias` is in person `param`'s personal view, as its list has it: in one of its
 * channels (`listedChannels`), or in an entry they follow (src/follows.js) that has had activity
 * since they muted its customer, if they did. The access to a thread stays `inPersonalView`'s:
 * muting a customer takes its threads off the list only.
 */
export const inPersonalInbox = (alias, param) => {
  const listed = `${alias}.channel_id IN (SELECT channel_id FROM (${listedChannels(param)}))
  AND (${alias}.source, ${alias}.channel_id) IN (${listedChannels(param)})`;
  // The mute is asked after the OR, not in it: in it, SQLite no longer searches each side of
  // it by index (MULTI-INDEX OR), and reads every thread.
  return `((${listed}) OR ${followedByPerson(alias, param)})
  AND (NOT ${mutedBefore(alias, param)} OR (${listed}))`;
};

/**
 * Which of `people` (ids) posted or were mentioned in channel `place` (`source`, `channel_id`):
 * whose personal view has it. A Set of ids. Their mentions first (`CROSS JOIN` keeps that order):
 * a person has a few hundred at most, while an alert channel has tens of thousands of threads,
 * which SQLite would otherwise go through one by one, for every event in that channel.
 */
export async function inChannel(env, people, place) {
  const ids = [...new Set([].concat(people || []).filter(Boolean))];
  if (!ids.length || !place || !place.source || place.channel_id == null) {
    return new Set();
  }
  const { results } = await env.DB.prepare(`SELECT person FROM messages
      WHERE person IN (SELECT value FROM json_each(?1)) AND source = ?2 AND channel_id = ?3
    UNION SELECT n.person FROM mentions n CROSS JOIN threads c ON c.thread = n.thread
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
 * and `channel_id`, and the `thread`). A member of one of the teams may, and so may anyone in the
 * channels of their personal view (posted or mentioned there), whichever team they are filed
 * under, and anyone who follows a technology the thread's entry shows.
 */
export const mayWork = (env, me) => async (teams, place) => memberOf(me)(teams)
  || (Boolean(me) && (await inPersonalChannel(env, me.id, place)
    || (Boolean(place && place.thread) && followsEntry(env, me.id, place.thread))));

/**
 * Who may post where the platform does not decide it: in the customer portal, and as the inbox's
 * app (src/postapp.js). As `mayWork`, but a person's own follow is not enough. On Slack and Teams
 * they post as themselves, and the platform decides whether they may post in the channel; the
 * portal and the app take the inbox's word, which is the channel's teams' and its people's (who
 * posted or were mentioned there).
 */
export const mayPost = (env, me) => async (teams, place) => memberOf(me)(teams)
  || (Boolean(me) && inPersonalChannel(env, me.id, place));

/**
 * Who may reply as themselves (src/post.js): who may work the thread (`mayWork`), but in the
 * customer portal, where the inbox posts for them, who may post there (`mayPost`).
 */
export const mayReply = (env, me) => (teams, place) => (place && place.source === 'portal'
  ? mayPost(env, me) : mayWork(env, me))(teams, place);

/**
 * Whether person `person` talked to the agent in the sidebar of thread `thread`'s entry: in its
 * group, on any member's key (a sidebar is kept under the entry's key when it was talked in).
 */
export async function inSidebar(env, person, thread) {
  if (!person || !thread || !env.DB) {
    return false;
  }
  const row = await env.DB.prepare(`SELECT 1 AS yes FROM sidebar_messages
    WHERE person = ?1 AND role = 'person' AND thread IN (
      SELECT thread FROM threads
      WHERE thread = (SELECT COALESCE(logical_thread, thread) FROM threads WHERE thread = ?2)
        OR logical_thread = (SELECT COALESCE(logical_thread, thread) FROM threads WHERE thread = ?2)
      UNION SELECT ?2) LIMIT 1`).bind(person, String(thread)).first();
  return Boolean(row);
}

/**
 * Who may see a thread, and talk to its agent in its sidebar: `(teams, place) => Promise<bool>`,
 * as `mayWork`. Who may work it may, and so may the admin team, and whoever talked in its sidebar
 * before: a channel that moves to another team (often because they asked its agent to move it)
 * does not take away the conversation they had about it. Only to see and talk: replying,
 * drafting, and deciding on what its agent asks for stay `mayWork`'s.
 */
export const maySee = (env, me) => async (teams, place) => isAdmin(me)
  || await mayWork(env, me)(teams, place)
  || (Boolean(me) && Boolean(place && place.thread) && inSidebar(env, me.id, place.thread));

/**
 * The rooms (teams, by slug) a person's inbox listens to: their own teams', and the rooms of
 * the teams their personal view's threads are filed under (its channels', and the ones that show
 * a technology they follow). In those other rooms they hear only about the threads of their
 * personal view (`scoped`, room.js).
 *
 * A channel's teams one by one, each by a search of `threads_channel_team` (migration 0098): its
 * least team, then the next after it, and so on. Its threads are nearly always one team's, and an
 * alert channel has tens of thousands: asking for its threads' teams read every one of them.
 */
export async function roomsOf(env, me) {
  const own = (me.teams || []).map((t) => t.slug);
  const { results } = await env.DB.prepare(`WITH RECURSIVE
      c(source, channel_id) AS (${personalChannels('?1')}),
      s(source, channel_id, team) AS (
        SELECT source, channel_id, (SELECT MIN(x.team) FROM threads x
          WHERE x.channel_id = c.channel_id AND x.source = c.source) FROM c
        UNION ALL SELECT s.source, s.channel_id, (SELECT MIN(x.team) FROM threads x
          WHERE x.channel_id = s.channel_id AND x.source = s.source AND x.team > s.team)
        FROM s WHERE s.team IS NOT NULL)
    SELECT team FROM s WHERE team IS NOT NULL
    UNION SELECT team FROM threads t WHERE ${followedByPerson('t', '?1')} AND team IS NOT NULL
    ORDER BY team`).bind(me.id).all();
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
    const people = scoped.map((s) => s.person);
    const place = await env.DB.prepare('SELECT source, channel_id FROM threads WHERE thread = ?')
      .bind(event.thread).first();
    // A thread whose label gained or lost technologies (`tech`, src/normalizer.js) is told to
    // those who follow one of them too: one that no longer shows what they follow leaves their
    // open inbox when it reloads. The event names the thread only, nothing of what is in it.
    const [inIt, following, changed, moved] = await Promise.all([
      inChannel(env, people, place),
      place ? followersOf(env, people, event.thread) : new Set(),
      Array.isArray(event.tech) ? followersOfTech(env, people, event.tech) : new Set(),
      // And areas it joined or left (`areas`): one no longer in an area they follow goes too.
      Array.isArray(event.areas) ? followersOfAreas(env, people, event.areas) : new Set(),
    ]);
    allowed = new Set([...inIt, ...following, ...changed, ...moved]);
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
