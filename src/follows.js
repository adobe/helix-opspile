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
 * SQL: the rows of `person_follows` that count. A person's follows open threads in any team's
 * channels to them, as a team's shares do, so they count only while the person is on an ops team:
 * someone who signed in from SIGNIN_DOMAINS and is on none (src/shares.js `teamless`) cannot
 * follow, and someone who leaves every team stops seeing what they followed, without their rows
 * being deleted.
 */
const COUNTED_PERSON_FOLLOWS = `SELECT person, tech FROM person_follows f
  WHERE EXISTS (SELECT 1 FROM team_members m WHERE m.person = f.person)`;

/**
 * SQL: the rows of `person_follows_by` that count (customers, people and areas), as
 * COUNTED_PERSON_FOLLOWS does for technologies.
 */
const COUNTED_FOLLOWS_BY = `SELECT person, kind, target FROM person_follows_by f
  WHERE EXISTS (SELECT 1 FROM team_members m WHERE m.person = f.person)`;

/** What a person follows besides technologies. */
export const FOLLOW_KINDS = ['org', 'person', 'area'];

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

/** SQL: thread row `alias` shows a technology team `param` (an SQL parameter, a slug) follows. */
export const followedByTeam = (alias, param) => inFollowed(
  alias,
  `SELECT tech FROM team_follows WHERE team = ${param}`,
);

/** SQL: as `followedByTeam`, for any of the teams `param` (a JSON array of slugs) has. */
export const followedByTeams = (alias, param) => inFollowed(
  alias,
  `SELECT tech FROM team_follows WHERE team IN (SELECT value FROM json_each(${param}))`,
);

/**
 * SQL: thread row `alias` is in an entry person `param` (an SQL parameter, an id) follows: one
 * that shows a technology they follow, a conversation of a customer they follow, one a person
 * they follow posted in, or one Clef puts in an area they follow (thread_areas).
 */
export const followedByPerson = (alias, param) => `(${inFollowed(
  alias,
  `SELECT tech FROM (${COUNTED_PERSON_FOLLOWS}) WHERE person = ${param}`,
)}
  OR (${alias}.kind = 'channel' AND ${alias}.org IN (${followedBy(param, 'org')}))
  OR ${inEntries(alias, `SELECT m.thread FROM messages m WHERE m.deleted = 0
      AND m.person IN (SELECT CAST(target AS INTEGER) FROM (${followedBy(param, 'person')}))`)}
  OR ${inEntries(alias, `SELECT a.thread FROM thread_areas a
      WHERE a.area IN (${followedBy(param, 'area')})`)})`;

/**
 * SQL, `?1` a thread: the members of its entry (`x`), each with what it shows (`g`). For who
 * follows the entry.
 */
const ENTRY_TECH = `WITH k AS (SELECT COALESCE(logical_thread, thread) AS g FROM threads WHERE thread = ?1)
  SELECT DISTINCT f.who FROM k JOIN threads x ON (x.thread = k.g OR x.logical_thread = k.g)
    JOIN thread_tech g ON g.thread = x.thread`;

/** The teams that follow a technology inbox entry `thread` (any of its members' keys) shows. */
export async function followingTeams(env, thread) {
  if (!env.DB || !thread) {
    return [];
  }
  const { results } = await env.DB.prepare(`${ENTRY_TECH}
      JOIN (SELECT team AS who, tech FROM team_follows) f ON f.tech = g.tech
    WHERE x.kind = 'channel' ORDER BY f.who`).bind(String(thread)).all();
  return (results || []).map((r) => r.who);
}

/**
 * Why the teams that follow inbox entry `thread` have it: `[{ team, tech }]`, each technology
 * of the entry's that a team follows, by team.
 */
export async function entryFollows(env, thread) {
  if (!env.DB || !thread) {
    return [];
  }
  const { results } = await env.DB.prepare(`WITH k AS (SELECT COALESCE(logical_thread, thread) AS g
      FROM threads WHERE thread = ?1)
    SELECT DISTINCT f.team, f.tech FROM k JOIN threads x ON (x.thread = k.g OR x.logical_thread = k.g)
      JOIN thread_tech g ON g.thread = x.thread JOIN team_follows f ON f.tech = g.tech
    WHERE x.kind = 'channel' ORDER BY f.team, f.tech`).bind(String(thread)).all();
  return results || [];
}

/** The people who follow a technology inbox entry `thread` shows, as it counts: their ids. */
export async function entryFollowers(env, thread) {
  if (!env.DB || !thread) {
    return [];
  }
  const { results } = await env.DB.prepare(`${ENTRY_TECH}
      JOIN (SELECT person AS who, tech FROM (${COUNTED_PERSON_FOLLOWS})) f ON f.tech = g.tech
    WHERE x.kind = 'channel' ORDER BY f.who`).bind(String(thread)).all();
  return (results || []).map((r) => r.who);
}

/**
 * Which of `people` (ids) follow inbox entry `thread`: a technology it shows, its customer, a
 * person who posted in it, or an area it is in. A Set of ids.
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
          WHERE m.thread IN (SELECT thread FROM x) AND m.deleted = 0))`)
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

/** Whether person `person` follows a technology inbox entry `thread` shows. */
export async function followsEntry(env, person, thread) {
  return (await followersOf(env, [person], thread)).has(person);
}

/** The teams that follow any of `techs` (ids), by slug. */
export async function teamsFollowing(env, techs) {
  const list = [...new Set([].concat(techs || []).filter(Boolean))];
  if (!env.DB || !list.length) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT DISTINCT team FROM team_follows
    WHERE tech IN (SELECT value FROM json_each(?)) ORDER BY team`).bind(JSON.stringify(list)).all();
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
 * What person `person` follows besides technologies: `{ org: [slug], person: [id], area: [id] }`.
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

/** Whether `target` is one of kind `kind` that may be followed: a customer, a person, an area. */
async function knownTarget(env, kind, target) {
  const id = String(target ?? '').trim();
  if (!id || id.length > 120) {
    return null;
  }
  // A customer is one with threads, whether or not the admin pages named it (`orgs`).
  const sql = {
    org: 'SELECT 1 FROM threads WHERE org = ?1 UNION ALL SELECT 1 FROM orgs WHERE slug = ?1',
    person: 'SELECT 1 FROM people WHERE id = ?1',
    area: 'SELECT 1 FROM areas WHERE id = ?1 AND enabled = 1',
  }[kind];
  const row = await env.DB.prepare(`${sql} LIMIT 1`).bind(kind === 'person' ? Number(id) : id).first();
  return row ? id : null;
}

/**
 * Person `person` follows `target` of `kind` (a customer's slug, a person's id, an area's id), or
 * (`follow` false) no more. As setPersonFollow: only someone on an ops team follows; anyone stops.
 */
export async function setPersonFollowBy(env, {
  person, kind, target, follow,
}) {
  if (!FOLLOW_KINDS.includes(kind)) {
    return { error: `kind is ${FOLLOW_KINDS.join(', ')} or tech`, status: 400 };
  }
  if (!follow) {
    const { meta } = await env.DB.prepare(`DELETE FROM person_follows_by
      WHERE person = ? AND kind = ? AND target = ?`).bind(person, kind, String(target ?? '')).run();
    return { ok: true, changed: Boolean(meta.changes) };
  }
  const member = await env.DB.prepare('SELECT 1 FROM team_members WHERE person = ? LIMIT 1')
    .bind(person).first();
  if (!member) {
    return { error: 'only members of an ops team follow', status: 403 };
  }
  const id = await knownTarget(env, kind, target);
  if (!id) {
    return { error: `no such ${{ org: 'customer', person: 'person', area: 'area' }[kind]}` };
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
 * Person `person` follows `tech`, or (`follow` false) no more. As `setTeamFollow`; only someone
 * on an ops team follows (see COUNTED_PERSON_FOLLOWS), and anyone may stop.
 */
export async function setPersonFollow(env, { person, tech, follow }) {
  if (follow) {
    const member = await env.DB.prepare('SELECT 1 FROM team_members WHERE person = ? LIMIT 1')
      .bind(person).first();
    if (!member) {
      return { error: 'only members of an ops team follow technologies', status: 403 };
    }
  }
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
