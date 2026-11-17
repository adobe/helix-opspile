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

/** SQL: thread row `alias` shows a technology person `param` (an SQL parameter, an id) follows. */
export const followedByPerson = (alias, param) => inFollowed(
  alias,
  `SELECT tech FROM (${COUNTED_PERSON_FOLLOWS}) WHERE person = ${param}`,
);

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

/** Which of `people` (ids) follow a technology inbox entry `thread` shows. A Set of ids. */
export async function followersOf(env, people, thread) {
  const ids = [...new Set([].concat(people || []).filter(Boolean))];
  if (!env.DB || !ids.length || !thread) {
    return new Set();
  }
  const { results } = await env.DB.prepare(`${ENTRY_TECH}
      JOIN (SELECT person AS who, tech FROM (${COUNTED_PERSON_FOLLOWS})
        WHERE person IN (SELECT value FROM json_each(?2))) f ON f.tech = g.tech
    WHERE x.kind = 'channel'`).bind(String(thread), JSON.stringify(ids)).all();
  return new Set((results || []).map((r) => r.who));
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
export function threadTechStatements(db, thread, shown) {
  return [
    db.prepare('DELETE FROM thread_tech WHERE thread = ?').bind(thread),
    ...Object.entries(shown || {}).filter(([, p]) => typeof p === 'number')
      .map(([tech, p]) => db.prepare('INSERT INTO thread_tech (thread, tech, p) VALUES (?, ?, ?)')
        .bind(thread, tech, p)),
  ];
}

/** The technologies team `team` follows, by id. */
export async function teamFollows(env, team) {
  const { results } = await env.DB.prepare(`SELECT tech, added_by, added_at FROM team_follows
    WHERE team = ? ORDER BY tech`).bind(team).all();
  return results || [];
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
  if (!id || id.length > 64) {
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
