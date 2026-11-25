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

import { MAX_TECH_ID } from './techid.js';

/**
 * Following technologies (migration 0072). A team follows technologies of the tech stack, and so
 * does a person: the threads that show one (`thread_tech`, the thread's own label, not its
 * channel's) are in the team's inbox, or in the person's personal view, whichever team their
 * channel is filed under, and they work them as they would a shared channel's. An inbox entry
 * shows what any of its members shows. Channels stay filed where the rules and the shares put
 * them: nothing moves.
 */

/** At most this many technologies per team, or per person. */
export const MAX_FOLLOWS = 50;

/**
 * SQL: the rows of `person_follows` that count: all of them. Anyone who may sign in follows, on
 * an ops team or not (someone who signed in from SIGNIN_DOMAINS), and the threads that show what
 * they follow are in their personal view, to work as the channels' own. What a follow opens is
 * only ever asked for someone signed in (their inbox, their thread, their socket), who may sign in
 * by then; `entryFollowers`, which counts others, leaves out those who may not any more.
 */
const COUNTED_PERSON_FOLLOWS = 'SELECT person, tech FROM person_follows';

/**
 * SQL: the rows of `person_follows_by` that count (customers, people and areas), as
 * COUNTED_PERSON_FOLLOWS does for technologies.
 */
const COUNTED_FOLLOWS_BY = 'SELECT person, kind, target FROM person_follows_by';

/** SIGNIN_DOMAINS, as src/lookup.js `domainList` reads it. */
const signInDomains = (env) => String(env.SIGNIN_DOMAINS || '').toLowerCase().split(',')
  .map((d) => d.trim())
  .filter(Boolean);

/**
 * SQL, `?2` the mail domains of SIGNIN_DOMAINS (a JSON list): person `p` may sign in, on an ops
 * team or from one of those domains (src/api.js `admitted`).
 */
const ADMITTED = `(EXISTS (SELECT 1 FROM team_members m WHERE m.person = p.id)
    OR lower(substr(p.email, instr(p.email, '@') + 1)) IN (SELECT value FROM json_each(?2)))`;

/**
 * What a person follows besides technologies: a customer, a person of D1, an area, a person known
 * by their platform account only (`account`, an identity key, as messages.author_key has it), and
 * a thread (`thread`, an inbox entry's key).
 */
export const FOLLOW_KINDS = ['org', 'person', 'area', 'account', 'thread'];

/** SQL: the targets of kind `kind` person `param` follows. */
const followedBy = (param, kind) => `SELECT target FROM (${COUNTED_FOLLOWS_BY})
  WHERE person = ${param} AND kind = '${kind}'`;

/** SQL: the inbox entries with a member among the threads `threads` selects; conversations. */
const entriesOf = (threads) => `SELECT COALESCE(x.logical_thread, x.thread) FROM threads x
    WHERE x.thread IN (${threads}) AND x.kind = 'channel'`;

/** SQL: thread row `alias` is in an entry with a member among the threads `threads` selects. */
const inEntries = (alias, threads) => `(${alias}.thread IN (${entriesOf(threads)})
    OR ${alias}.logical_thread IN (${entriesOf(threads)}))`;

/**
 * SQL: the inbox entries (`COALESCE(logical_thread, thread)`) with a member that shows one of the
 * technologies `techs` selects (SQL that selects `tech` ids). Conversations only: an alert or an
 * ignored channel's thread is in no one's inbox by what it shows.
 */
const followedEntries = (techs) => `SELECT COALESCE(x.logical_thread, x.thread)
    FROM thread_tech g JOIN threads x ON x.thread = g.thread
    WHERE g.tech IN (${techs}) AND x.kind = 'channel'`;

/**
 * SQL: thread row `alias` is in an entry that shows one of the technologies `techs` selects. The
 * thread or its group, each by index (the key, `threads_group_latest`), so that `… OR <this>`
 * stays a multi-index OR.
 */
const inFollowed = (alias, techs) => `(${alias}.thread IN (${followedEntries(techs)})
    OR ${alias}.logical_thread IN (${followedEntries(techs)}))`;

/** What a team follows besides technologies (migration 0105); customers are follow rules. */
export const TEAM_FOLLOW_KINDS = ['area'];

/** SQL: the entries Clef puts in one of the areas `areas` selects (SQL that selects area ids). */
const inAreas = (alias, areas) => inEntries(alias, `SELECT a.thread FROM thread_areas a
      WHERE a.area IN (${areas})`);

/**
 * SQL: thread row `alias` is in an entry team `param` (an SQL parameter, a slug) follows: one that
 * shows a technology it follows, or one Clef puts in an area it follows (thread_areas).
 */
export const followedByTeam = (alias, param) => `(${inFollowed(
  alias,
  `SELECT tech FROM team_follows WHERE team = ${param}`,
)}
  OR ${inAreas(alias, `SELECT target FROM team_follows_by WHERE team = ${param} AND kind = 'area'`)})`;

/** SQL: as `followedByTeam`, for any of the teams `param` (a JSON array of slugs) has. */
export const followedByTeams = (alias, param) => `(${inFollowed(
  alias,
  `SELECT tech FROM team_follows WHERE team IN (SELECT value FROM json_each(${param}))`,
)}
  OR ${inAreas(alias, `SELECT target FROM team_follows_by
      WHERE team IN (SELECT value FROM json_each(${param})) AND kind = 'area'`)})`;

/**
 * SQL: thread row `alias` is in an entry person `param` (an SQL parameter, an id) follows: one
 * that shows a technology they follow, a conversation of a customer they follow, one a person
 * (or an account) they follow posted in, one Clef puts in an area they follow (thread_areas), or
 * one they follow itself. Each by index: an account's messages by `messages_author`.
 */
export const followedByPerson = (alias, param) => `(${inFollowed(
  alias,
  `SELECT tech FROM (${COUNTED_PERSON_FOLLOWS}) WHERE person = ${param}`,
)}
  OR (${alias}.kind = 'channel' AND ${alias}.org IN (${followedBy(param, 'org')}))
  OR ${inEntries(alias, `SELECT m.thread FROM messages m WHERE m.deleted = 0
      AND m.person IN (SELECT CAST(target AS INTEGER) FROM (${followedBy(param, 'person')}))`)}
  OR ${inEntries(alias, `SELECT m.thread FROM messages m WHERE m.deleted = 0
      AND m.author_key IN (${followedBy(param, 'account')})`)}
  OR ${inAreas(alias, followedBy(param, 'area'))}
  OR ${inEntries(alias, followedBy(param, 'thread'))})`;

/**
 * SQL, `?1` a thread: the members of its entry (`x`), each with what it shows (`g`). For who
 * follows the entry.
 */
const ENTRY_TECH = `WITH k AS (SELECT COALESCE(logical_thread, thread) AS g FROM threads WHERE thread = ?1)
  SELECT DISTINCT f.who FROM k JOIN threads x ON (x.thread = k.g OR x.logical_thread = k.g)
    JOIN thread_tech g ON g.thread = x.thread`;

/**
 * SQL, `?1` a thread: why teams have its entry, `(team, tech, area)`: each technology it shows
 * that a team follows (`area` null), and each area Clef puts it in that a team follows (`tech`
 * null). Conversations only.
 */
const ENTRY_TEAM_FOLLOWS = `WITH k AS (SELECT COALESCE(logical_thread, thread) AS g
      FROM threads WHERE thread = ?1),
    x AS (SELECT t.thread FROM k JOIN threads t ON (t.thread = k.g OR t.logical_thread = k.g)
      WHERE t.kind = 'channel')
  SELECT f.team, f.tech, NULL AS area FROM x JOIN thread_tech g ON g.thread = x.thread
    JOIN team_follows f ON f.tech = g.tech
  UNION SELECT f.team, NULL, f.target FROM x JOIN thread_areas a ON a.thread = x.thread
    JOIN team_follows_by f ON f.kind = 'area' AND f.target = a.area`;

/**
 * The teams that follow inbox entry `thread` (any of its members' keys): a technology it shows,
 * or an area Clef puts it in.
 */
export async function followingTeams(env, thread) {
  if (!env.DB || !thread) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT DISTINCT team FROM (${ENTRY_TEAM_FOLLOWS})
    ORDER BY team`).bind(String(thread)).all();
  return (results || []).map((r) => r.team);
}

/**
 * Why the teams that follow inbox entry `thread` have it: `[{ team, tech }]` for each technology
 * of the entry's that a team follows, `[{ team, area }]` for each area, by team.
 */
export async function entryFollows(env, thread) {
  if (!env.DB || !thread) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT team, tech, area FROM (${ENTRY_TEAM_FOLLOWS})
    ORDER BY team, tech IS NULL, tech, area`).bind(String(thread)).all();
  return (results || []).map((r) => (r.tech ? { team: r.team, tech: r.tech }
    : { team: r.team, area: r.area }));
}

/**
 * The people who follow a technology inbox entry `thread` shows, and may sign in (on an ops team,
 * or from SIGNIN_DOMAINS): their ids.
 */
export async function entryFollowers(env, thread) {
  if (!env.DB || !thread) {
    return [];
  }
  const { results } = await env.DB.prepare(`${ENTRY_TECH}
      JOIN (SELECT person AS who, tech FROM (${COUNTED_PERSON_FOLLOWS})) f ON f.tech = g.tech
      JOIN people p ON p.id = f.who
    WHERE x.kind = 'channel' AND ${ADMITTED} ORDER BY f.who`)
    .bind(String(thread), JSON.stringify(signInDomains(env))).all();
  return (results || []).map((r) => r.who);
}

/**
 * Which of `people` (ids) follow inbox entry `thread`: a technology it shows, its customer, a
 * person (or an account) who posted in it, an area it is in, or the entry itself. A Set of ids.
 */
export async function followersOf(env, people, thread) {
  const ids = [...new Set([].concat(people || []).filter(Boolean))];
  if (!env.DB || !ids.length || !thread) {
    return new Set();
  }
  const [{ results: tech }, { results: more }] = await Promise.all([
    env.DB.prepare(`${ENTRY_TECH}
        JOIN (SELECT person AS who, tech FROM (${COUNTED_PERSON_FOLLOWS})
          WHERE person IN (SELECT value FROM json_each(?2))) f ON f.tech = g.tech
      WHERE x.kind = 'channel'`).bind(String(thread), JSON.stringify(ids)).all(),
    env.DB.prepare(`WITH k AS (SELECT COALESCE(logical_thread, thread) AS g FROM threads WHERE thread = ?1),
        x AS (SELECT t.thread, t.org FROM k JOIN threads t ON (t.thread = k.g OR t.logical_thread = k.g)
          WHERE t.kind = 'channel'),
        f AS (SELECT person, kind, target FROM (${COUNTED_FOLLOWS_BY})
          WHERE person IN (SELECT value FROM json_each(?2)))
      SELECT DISTINCT f.person AS who FROM f WHERE
        (f.kind = 'org' AND f.target IN (SELECT org FROM x))
        OR (f.kind = 'area' AND f.target IN (SELECT a.area FROM thread_areas a WHERE a.thread IN (SELECT thread FROM x)))
        OR (f.kind = 'person' AND CAST(f.target AS INTEGER) IN (SELECT m.person FROM messages m
          WHERE m.thread IN (SELECT thread FROM x) AND m.deleted = 0))
        OR (f.kind = 'account' AND f.target IN (SELECT m.author_key FROM messages m
          WHERE m.thread IN (SELECT thread FROM x) AND m.deleted = 0))
        OR (f.kind = 'thread' AND f.target IN (SELECT thread FROM x))`)
      .bind(String(thread), JSON.stringify(ids)).all(),
  ]);
  return new Set([...(tech || []), ...(more || [])].map((r) => r.who));
}

/**
 * Which of `people` (ids) follow any of `techs` (ids), as it counts: those who had a thread
 * that no longer shows what they follow hear that it changed, so their open inbox lets it go.
 */
export async function followersOfTech(env, people, techs) {
  const ids = [...new Set([].concat(people || []).filter(Boolean))];
  const list = [...new Set([].concat(techs || []).filter(Boolean))];
  if (!env.DB || !ids.length || !list.length) {
    return new Set();
  }
  const { results } = await env.DB.prepare(`SELECT DISTINCT person FROM (${COUNTED_PERSON_FOLLOWS})
    WHERE person IN (SELECT value FROM json_each(?1)) AND tech IN (SELECT value FROM json_each(?2))`)
    .bind(JSON.stringify(ids), JSON.stringify(list)).all();
  return new Set((results || []).map((r) => r.person));
}

/**
 * Which of `people` (ids) follow any of `areas` (ids), as it counts: those who had a thread that
 * is no longer in an area they follow hear that it changed, as followersOfTech.
 */
export async function followersOfAreas(env, people, areas) {
  const ids = [...new Set([].concat(people || []).filter(Boolean))];
  const list = [...new Set([].concat(areas || []).filter(Boolean))];
  if (!env.DB || !ids.length || !list.length) {
    return new Set();
  }
  const { results } = await env.DB.prepare(`SELECT DISTINCT person FROM (${COUNTED_FOLLOWS_BY})
    WHERE kind = 'area' AND person IN (SELECT value FROM json_each(?1))
      AND target IN (SELECT value FROM json_each(?2))`)
    .bind(JSON.stringify(ids), JSON.stringify(list)).all();
  return new Set((results || []).map((r) => r.person));
}

/** Whether person `person` follows a technology inbox entry `thread` shows. */
export async function followsEntry(env, person, thread) {
  return (await followersOf(env, [person], thread)).has(person);
}

/** The teams that follow any of `techs` (ids), or any of `areas` (ids), by slug. */
export async function teamsFollowing(env, techs, areas = []) {
  const list = [...new Set([].concat(techs || []).filter(Boolean))];
  const inAreasList = [...new Set([].concat(areas || []).filter(Boolean))];
  if (!env.DB || (!list.length && !inAreasList.length)) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT team FROM team_follows
      WHERE tech IN (SELECT value FROM json_each(?1))
    UNION SELECT team FROM team_follows_by WHERE kind = 'area'
      AND target IN (SELECT value FROM json_each(?2))
    ORDER BY team`).bind(JSON.stringify(list), JSON.stringify(inAreasList)).all();
  return (results || []).map((r) => r.team);
}

/**
 * The statements that make thread `thread`'s rows of `thread_tech` what its label shows
 * (`shown`, `{ tech: p }`, as `labels.tech`), for the batch that writes the label.
 */
export function threadTechStatements(db, thread, shown, about = {}) {
  return [
    db.prepare('DELETE FROM thread_tech WHERE thread = ?').bind(thread),
    ...Object.entries(shown || {}).filter(([, p]) => typeof p === 'number')
      .map(([tech, p]) => db.prepare('INSERT INTO thread_tech (thread, tech, p, about) VALUES (?, ?, ?, ?)')
        .bind(thread, tech, p, typeof about[tech] === 'number' ? about[tech] : null)),
  ];
}

/** The technologies team `team` follows, by id. */
export async function teamFollows(env, team) {
  const { results } = await env.DB.prepare(`SELECT tech, added_by, added_at FROM team_follows
    WHERE team = ? ORDER BY tech`).bind(team).all();
  return results || [];
}

/**
 * What person `person` follows besides technologies: `{ org: [slug], person: [id], area: [id],
 * account: [identity key], thread: [key] }`.
 */
export async function personFollowsBy(env, person) {
  const { results } = await env.DB.prepare(`SELECT kind, target FROM person_follows_by
    WHERE person = ? ORDER BY kind, target`).bind(person).all();
  const out = Object.fromEntries(FOLLOW_KINDS.map((k) => [k, []]));
  for (const r of results || []) {
    out[r.kind].push(r.kind === 'person' ? Number(r.target) : r.target);
  }
  return out;
}

/** `target` as it is stored: trimmed; a person's id as the integer it is (null if it is none). */
function targetOf(kind, target) {
  const id = String(target ?? '').trim();
  if (kind !== 'person') {
    return id;
  }
  return /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? String(Number(id)) : null;
}

/**
 * Whether `target` is one of kind `kind` that may be followed: a customer, a person, an area, an
 * account (a person's, not a bot's) or a conversation (no alert: the personal view has none).
 */
async function knownTarget(env, kind, target) {
  const id = targetOf(kind, target);
  if (!id || id.length > (kind === 'thread' || kind === 'account' ? 400 : 120)) {
    return null;
  }
  if (kind === 'account') {
    const [source, tenant, ...rest] = id.split(':');
    if (!source || !tenant || !rest.length) {
      return null;
    }
    const row = await env.DB.prepare(`SELECT 1 FROM identities
      WHERE source = ? AND tenant = ? AND user_id = ? AND kind != 'bot'`).bind(source, tenant, rest.join(':')).first();
    return row ? id : null;
  }
  // A customer is one with threads, whether or not the admin pages named it (`orgs`).
  const sql = {
    org: 'SELECT 1 FROM threads WHERE org = ?1 UNION ALL SELECT 1 FROM orgs WHERE slug = ?1',
    person: 'SELECT 1 FROM people WHERE id = ?1',
    area: 'SELECT 1 FROM areas WHERE id = ?1 AND enabled = 1',
    thread: "SELECT 1 FROM threads WHERE thread = ?1 AND kind = 'channel'",
  }[kind];
  const row = await env.DB.prepare(`${sql} LIMIT 1`).bind(kind === 'person' ? Number(id) : id).first();
  return row ? id : null;
}

const NOUNS = {
  org: 'customer', person: 'person', area: 'area', account: 'account', thread: 'thread',
};

/**
 * Person `person` follows `target` of `kind` (a customer's slug, a person's id, an area's id, an
 * identity key, a thread's key), or (`follow` false) no more. As setPersonFollow: anyone signed
 * in follows, on a team or not; whether they may follow a thread is the caller's to ask.
 */
export async function setPersonFollowBy(env, {
  person, kind, target, follow,
}) {
  if (!FOLLOW_KINDS.includes(kind)) {
    return { error: `kind is ${FOLLOW_KINDS.join(', ')} or tech`, status: 400 };
  }
  if (!follow) {
    const { meta } = await env.DB.prepare(`DELETE FROM person_follows_by
      WHERE person = ? AND kind = ? AND target = ?`).bind(person, kind, targetOf(kind, target) ?? '').run();
    return { ok: true, changed: Boolean(meta.changes) };
  }
  const id = await knownTarget(env, kind, target);
  if (!id) {
    return { error: `no such ${NOUNS[kind]}` };
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM person_follows_by WHERE person = ? AND kind = ?')
    .bind(person, kind).first('n');
  if (n >= MAX_FOLLOWS) {
    return { error: `you follow at most ${MAX_FOLLOWS} of each` };
  }
  const { meta } = await env.DB.prepare(`INSERT INTO person_follows_by (person, kind, target, added_at)
    VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(person, kind, id, new Date().toISOString()).run();
  return { ok: true, changed: Boolean(meta.changes) };
}

/** The statements that make thread `thread`'s rows of `thread_areas` what `topics` says. */
export function threadAreaStatements(db, thread, topics) {
  return [
    db.prepare('DELETE FROM thread_areas WHERE thread = ?').bind(thread),
    ...Object.entries(topics || {}).filter(([, p]) => typeof p === 'number')
      .map(([area, p]) => db.prepare('INSERT INTO thread_areas (thread, area, p) VALUES (?, ?, ?)')
        .bind(thread, area, p)),
  ];
}

/** The technologies person `person` follows, by id. */
export async function personFollows(env, person) {
  const { results } = await env.DB.prepare(`SELECT tech FROM person_follows WHERE person = ?
    ORDER BY tech`).bind(person).all();
  return (results || []).map((r) => r.tech);
}

/** The technologies each of `teams` (slugs) follows: `{ [slug]: [tech] }`. */
export async function followsOfTeams(env, teams) {
  const list = [...new Set([].concat(teams || []).filter(Boolean))];
  if (!list.length) {
    return {};
  }
  const { results } = await env.DB.prepare(`SELECT team, tech FROM team_follows
    WHERE team IN (SELECT value FROM json_each(?)) ORDER BY team, tech`).bind(JSON.stringify(list)).all();
  const out = Object.fromEntries(list.map((t) => [t, []]));
  for (const r of results || []) {
    out[r.team].push(r.tech);
  }
  return out;
}

/**
 * Every technology one may follow: the tech stack of every team, by id, each with the name and
 * product that `team`'s own entry gives it, else the admin team's, else another team's (as
 * `techNames`). Those turned off everywhere are left out. `[{ tech, name, product }]`, by name.
 */
export async function followable(env, team = null) {
  const { results } = await env.DB.prepare(`SELECT tech, name, product, enabled FROM tech_stack
    ORDER BY team = ? DESC, team = 'admin' DESC, team`).bind(team || 'admin').all();
  const by = new Map();
  const on = new Set();
  for (const r of results || []) {
    if (!by.has(r.tech)) {
      by.set(r.tech, { tech: r.tech, name: r.name || r.tech, product: r.product || null });
    }
    if (r.enabled) {
      on.add(r.tech);
    }
  }
  return [...by.values()].filter((t) => on.has(t.tech))
    .sort((a, b) => a.name.localeCompare(b.name) || a.tech.localeCompare(b.tech));
}

/** `tech`, checked against what one may follow: the id, or null. */
async function known(env, tech) {
  const id = String(tech || '').trim();
  if (!id || id.length > MAX_TECH_ID) {
    return null;
  }
  const row = await env.DB.prepare('SELECT 1 FROM tech_stack WHERE tech = ? AND enabled = 1 LIMIT 1')
    .bind(id).first();
  return row ? id : null;
}

/**
 * Team `team` follows `tech`, or (`follow` false) no more, as `by` (an email). `{ ok, changed }`,
 * or `{ error }` for a technology no tech stack has, or one too many.
 */
export async function setTeamFollow(env, {
  team, tech, follow, by,
}) {
  if (!follow) {
    const { meta } = await env.DB.prepare('DELETE FROM team_follows WHERE team = ? AND tech = ?')
      .bind(team, String(tech || '')).run();
    return { ok: true, changed: Boolean(meta.changes) };
  }
  const id = await known(env, tech);
  if (!id) {
    return { error: 'no tech stack has that technology' };
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM team_follows WHERE team = ?').bind(team).first('n');
  if (n >= MAX_FOLLOWS) {
    return { error: `a team follows at most ${MAX_FOLLOWS} technologies` };
  }
  const { meta } = await env.DB.prepare(`INSERT INTO team_follows (team, tech, added_by, added_at)
    VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(team, id, by || null, new Date().toISOString()).run();
  return { ok: true, changed: Boolean(meta.changes) };
}

/**
 * Person `person` follows `tech`, or (`follow` false) no more. As `setTeamFollow`; anyone signed
 * in follows, on an ops team or not (see COUNTED_PERSON_FOLLOWS).
 */
export async function setPersonFollow(env, { person, tech, follow }) {
  if (!follow) {
    const { meta } = await env.DB.prepare('DELETE FROM person_follows WHERE person = ? AND tech = ?')
      .bind(person, String(tech || '')).run();
    return { ok: true, changed: Boolean(meta.changes) };
  }
  const id = await known(env, tech);
  if (!id) {
    return { error: 'no tech stack has that technology' };
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM person_follows WHERE person = ?').bind(person).first('n');
  if (n >= MAX_FOLLOWS) {
    return { error: `you follow at most ${MAX_FOLLOWS} technologies` };
  }
  const { meta } = await env.DB.prepare(`INSERT INTO person_follows (person, tech, added_at)
    VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).bind(person, id, new Date().toISOString()).run();
  return { ok: true, changed: Boolean(meta.changes) };
}

/**
 * What team `team` follows besides technologies: `[{ kind, target, added_by, added_at }]`, areas
 * (migration 0105). Its customers are follow rules (src/admin.js `followOrg`).
 */
export async function teamFollowsBy(env, team) {
  const { results } = await env.DB.prepare(`SELECT kind, target, added_by, added_at
    FROM team_follows_by WHERE team = ? ORDER BY kind, target`).bind(team).all();
  return results || [];
}

/**
 * Team `team` follows `target` of `kind` (TEAM_FOLLOW_KINDS: an area's id), or (`follow` false)
 * no more, as `by` (an email). As setTeamFollow: `{ ok, changed }` or `{ error, status }`.
 */
export async function setTeamFollowBy(env, {
  team, kind, target, follow, by,
}) {
  if (!TEAM_FOLLOW_KINDS.includes(kind)) {
    return { error: `a team follows a ${TEAM_FOLLOW_KINDS.join(', ')}, a technology or a customer`, status: 400 };
  }
  if (!follow) {
    const { meta } = await env.DB.prepare(`DELETE FROM team_follows_by
      WHERE team = ? AND kind = ? AND target = ?`).bind(team, kind, targetOf(kind, target) ?? '').run();
    return { ok: true, changed: Boolean(meta.changes) };
  }
  const id = await knownTarget(env, kind, target);
  if (!id) {
    return { error: 'no such area', status: 400 };
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM team_follows_by WHERE team = ? AND kind = ?')
    .bind(team, kind).first('n');
  if (n >= MAX_FOLLOWS) {
    return { error: `a team follows at most ${MAX_FOLLOWS} of each`, status: 400 };
  }
  const { meta } = await env.DB.prepare(`INSERT INTO team_follows_by (team, kind, target, added_by,
      added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(team, kind, id, by || null, new Date().toISOString()).run();
  return { ok: true, changed: Boolean(meta.changes) };
}

/** The areas each of `teams` (slugs) follows: `{ [slug]: [area] }`. */
export async function areasOfTeams(env, teams) {
  const list = [...new Set([].concat(teams || []).filter(Boolean))];
  if (!list.length) {
    return {};
  }
  const { results } = await env.DB.prepare(`SELECT team, target FROM team_follows_by
    WHERE kind = 'area' AND team IN (SELECT value FROM json_each(?)) ORDER BY team, target`)
    .bind(JSON.stringify(list)).all();
  const out = Object.fromEntries(list.map((t) => [t, []]));
  for (const r of results || []) {
    out[r.team].push(r.target);
  }
  return out;
}
