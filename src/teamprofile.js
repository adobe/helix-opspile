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
 * A team's overview, the first section of its page in Teams (ui/admin.js `showOverview`), for
 * every internal user (docs/ARCHITECTURE.md, "Team overview"):
 *
 * - `GET /api/teams`: every ops team, with how many people are on it, for the list.
 * - `GET /api/teams/profile?team=`: the team's last WEEKS weeks, from D1 alone:
 *   - its **members**, each with a picture, their title, how much they posted (anywhere) week by
 *     week, and what the threads they posted in are about (Clef's areas and technologies, the
 *     ones that set them apart from the rest of the team first) and for whom (customers);
 *   - its **customers**, by how much was said in the team's threads of each;
 *   - its **collaborators**: Adobe's people on other teams (or none) who post in its threads;
 *   - its **technologies**: those it follows, those of its catalog (its knowledge base's
 *     products/, src/catalog.js), and the others Clef sees most in its threads;
 *   - its **knowledge base**: its entries by type, listed for whoever may read it
 *     (src/kbaccess.js), counted for everyone else; and whether it has a stack drawing.
 *
 * "The team's threads" are its inbox's conversations: the threads filed under it, those of the
 * channels shared with it (src/shares.js) and those that show a technology it follows
 * (src/follows.js), active in the window. Names, numbers, pictures and titles only: no message
 * text, and no mail address, leaves the Worker. A team's numbers are kept CACHE_MS per isolate
 * (they cost a few hundred milliseconds of D1 for the biggest team).
 */

import { ADMIN_TEAM, managesTeam } from './review.js';
import { underlying } from './d1batch.js';
import { mayRead } from './kbaccess.js';
import { weeksTo } from './trends.js';
import { LAYERS, STACK_PATH } from './stack.js';

/** The weeks an overview counts, up to this one. */
export const WEEKS = 26;
/** How long a team's numbers are kept, per database. */
export const CACHE_MS = 5 * 60000;
/** At most this many of each list. */
export const MAX_CUSTOMERS = 15;
export const MAX_COLLABORATORS = 15;
export const MAX_SEEN = 12;
/** What sets a member apart: at most this many areas and technologies each, and customers. */
export const MAX_EXPERTISE = 4;
export const MAX_KEY_CUSTOMERS = 3;
/** Entries listed per type of the knowledge base. */
export const MAX_ENTRIES = 8;
/** The types of the catalog (shown as technologies) and the files that are no entries. */
const CATALOG_TYPES = new Set(['Vendor', 'Product', 'Feature', 'Category', 'Area', 'System Prompt']);
const UNASSIGNED = '_unassigned';

let cache = new WeakMap();

/**
 * SQL: the team's threads (`thread`), `?1` the team, `?2` the first day counted: the
 * conversations filed under it, in the channels shared with it, and those that show a
 * technology it follows, with a message by a person since.
 */
const SCOPE = `scope AS (
    SELECT h.thread FROM threads h WHERE h.team = ?1 AND h.kind = 'channel' AND h.last_at >= ?2
    UNION SELECT h.thread FROM channel_teams s JOIN threads h ON h.source = s.source
      AND h.channel_id = s.channel_id WHERE s.team = ?1 AND h.kind = 'channel' AND h.last_at >= ?2
    UNION SELECT x.thread FROM team_follows f JOIN thread_tech g ON g.tech = f.tech
      JOIN threads x ON x.thread = g.thread
      WHERE f.team = ?1 AND x.kind = 'channel' AND x.last_at >= ?2)`;

/** SQL: the platform accounts of the team's members (`person`, `key` as messages.author_key). */
const KEYS = `keys AS (SELECT DISTINCT i.person, i.source || ':' || i.tenant || ':' || i.user_id AS key
    FROM identities i JOIN team_members m ON m.person = i.person AND m.team = ?1)`;

/** SQL: each member's messages of the window, by thread. */
const MINE = `mine AS (SELECT keys.person, g.thread, COUNT(*) AS n FROM keys
    JOIN messages g ON g.author_key = keys.key AND g.at >= ?2
    WHERE g.deleted = 0 AND g.counted = 1 GROUP BY 1, 2)`;

/** SQL: the Monday of the week of `col`, as YYYY-MM-DD (src/trends.js `mondayOf`). */
const WEEK = (col) => `date(${col}, '-6 days', 'weekday 1')`;

/** SQL: a person's picture: their own account's, Slack's before Teams', Gravatar's last. */
const AVATAR = (person) => `(SELECT COALESCE(i.display_avatar, i.avatar) FROM identities i
    WHERE i.person = ${person} AND i.kind = 'person' AND COALESCE(i.display_avatar, i.avatar) != ''
    ORDER BY COALESCE(i.display_avatar, i.avatar) LIKE '%gravatar.com/%',
      CASE i.source WHEN 'slack' THEN 0 WHEN 'teams' THEN 1 ELSE 2 END, i.fetched_at DESC LIMIT 1)`;
/** SQL: a person's job title, as a platform has it. */
const TITLE = (person) => `(SELECT i.title FROM identities i WHERE i.person = ${person}
    AND i.title IS NOT NULL AND i.title != '' ORDER BY i.source = 'slack' DESC LIMIT 1)`;
/**
 * SQL: a person's name: a full one (with a space) first, theirs in D1 else an account's, then
 * a handle; else the start of their mail address (someone added who never posted).
 */
const NAME = (person) => {
  const account = (full) => `(SELECT COALESCE(i.display_name, i.name) FROM identities i
    WHERE i.person = ${person} AND COALESCE(i.display_name, i.name) ${full ? "LIKE '% %'" : "!= ''"}
    ORDER BY i.source = 'slack' DESC LIMIT 1)`;
  return `COALESCE(CASE WHEN p.name LIKE '% %' THEN p.name END, ${account(true)}, NULLIF(p.name, ''),
    ${account(false)}, SUBSTR(p.email, 1, INSTR(p.email, '@') - 1))`;
};

/** A list of `n` zeros, one a week. */
const zeros = (n) => Array.from({ length: n }, () => 0);

/**
 * `{ key: { ... , weekly } }` from rows of `{ [by], week, n }`: `n` added up per key and week
 * (into `weekly`, by the index of the week), and `extra(row, entry)` for the rest.
 */
function byWeek(rows, by, weeks, extra = () => {}) {
  const at = new Map(weeks.map((w, i) => [w, i]));
  const out = new Map();
  for (const r of rows) {
    const k = r[by];
    if (!out.has(k)) {
      out.set(k, {
        weekly: zeros(weeks.length), n: 0, last: null,
      });
    }
    const e = out.get(k);
    const i = at.get(r.week);
    if (i !== undefined) {
      e.weekly[i] += r.n;
    }
    e.n += r.n;
    if (r.last && (!e.last || r.last > e.last)) {
      e.last = r.last;
    }
    extra(r, e);
  }
  return out;
}

/**
 * What sets each member apart, of one kind of tag (an area, a technology): `rows` of `{ person,
 * what, n, threads }`, each member's messages in the threads with that tag. A tag scores by how
 * much more of the member's messages it has than of the team's (its lift), times how many threads
 * it was in, on a log scale: a tag everyone has counts for its threads alone, and one a member
 * has much more than the rest comes first, from a few threads on. A tag of one thread counts
 * only for whoever has nothing more. `{ person: [{ id, n, threads }] }`.
 */
export function distinctive(rows, totals, { most = MAX_EXPERTISE } = {}) {
  const all = [...totals.values()].reduce((s, n) => s + n, 0);
  const tagTotal = new Map();
  for (const r of rows) {
    tagTotal.set(r.what, (tagTotal.get(r.what) || 0) + r.n);
  }
  const per = new Map();
  for (const r of rows) {
    const mine = totals.get(r.person) || 0;
    if (mine && all) {
      const lift = (r.n / mine) / (tagTotal.get(r.what) / all);
      const score = Math.log2(1 + r.threads) * lift;
      per.set(r.person, [...(per.get(r.person) || []), {
        id: r.what, n: r.n, threads: r.threads, score,
      }]);
    }
  }
  const out = new Map();
  for (const [person, tags] of per) {
    const sorted = tags.sort((a, b) => b.score - a.score || b.threads - a.threads
      || String(a.id).localeCompare(String(b.id)));
    const more = sorted.filter((t) => t.threads > 1);
    out.set(person, (more.length ? more : sorted).slice(0, most)
      .map(({ id, n, threads }) => ({ id, n, threads })));
  }
  return out;
}

/** The names of the technologies, as `team`'s catalog has them, else the admin team's. */
function techNames(rows, team) {
  const by = new Map();
  // The team's own first, then the admin team's, then any other's.
  const rank = (r) => [team, ADMIN_TEAM, r.team].indexOf(r.team);
  for (const r of rows) {
    const was = by.get(r.tech);
    if (!was || rank(r) < rank(was)) {
      by.set(r.tech, r);
    }
  }
  return by;
}

/** The overview of team `slug`, as everyone sees it (`viewer` adds the rest): null for none. */
export async function teamNumbers(env, slug, { now = new Date() } = {}) {
  const weeks = weeksTo(now, WEEKS);
  const since = `${weeks[0]}T00:00:00.000Z`;
  const db = env.DB;
  const q = (sql, ...args) => db.prepare(sql).bind(slug, since, ...args).all()
    .then((r) => r.results || []);
  const team = await db.prepare(`SELECT t.slug, t.name, t.self_managed,
      (SELECT COUNT(DISTINCT th.channel_id) FROM threads th WHERE th.team = t.slug
        AND th.kind = 'channel') AS channels,
      (SELECT COUNT(*) FROM channel_teams s WHERE s.team = t.slug) AS shared
    FROM teams t WHERE t.slug = ?`).bind(slug).first();
  if (!team) {
    return null;
  }
  const [members, posts, tags, threadWeeks, threadTech, staffWeeks, follows, catalog,
    concepts, base] = await Promise.all([
    db.prepare(`SELECT p.id, ${NAME('p.id')} AS name, m.role, ${AVATAR('p.id')} AS avatar,
        ${TITLE('p.id')} AS title
      FROM team_members m JOIN people p ON p.id = m.person WHERE m.team = ?`).bind(slug).all()
      .then((r) => r.results || []),
    // What each member posted, anywhere, week by week.
    q(`WITH ${KEYS} SELECT keys.person, ${WEEK('g.at')} AS week, COUNT(*) AS n, MAX(g.at) AS last
      FROM keys JOIN messages g ON g.author_key = keys.key AND g.at >= ?2
      WHERE g.deleted = 0 AND g.counted = 1 GROUP BY 1, 2`),
    // And what about, for whom: the areas, technologies and customers of their threads.
    q(`WITH ${KEYS}, ${MINE}
      SELECT person, 'all' AS kind, NULL AS what, SUM(n) AS n, COUNT(*) AS threads FROM mine
        GROUP BY person
      UNION ALL SELECT mine.person, 'area', a.area, SUM(mine.n), COUNT(*) FROM mine
        JOIN thread_areas a ON a.thread = mine.thread GROUP BY 1, 3
      UNION ALL SELECT mine.person, 'tech', x.tech, SUM(mine.n), COUNT(*) FROM mine
        JOIN thread_tech x ON x.thread = mine.thread GROUP BY 1, 3
      UNION ALL SELECT mine.person, 'org', h.org, SUM(mine.n), COUNT(*) FROM mine
        JOIN threads h ON h.thread = mine.thread LEFT JOIN orgs o ON o.slug = h.org
        WHERE h.kind = 'channel' AND h.org != '${UNASSIGNED}'
          AND COALESCE(o.type, 'customer') != 'internal' GROUP BY 1, 3`),
    // The team's threads, week by week: what was said in each, and how much of it by Adobe.
    // The chart, the customers and the technologies are all counted from these (a thread by
    // its rowid, which is shorter than its key).
    q(`WITH ${SCOPE} SELECT h.rowid AS id, h.org, ${WEEK('g.at')} AS week, COUNT(*) AS n,
        SUM(g.staff) AS staff, MAX(g.at) AS last
      FROM scope JOIN threads h ON h.thread = scope.thread
        JOIN messages g ON g.thread = scope.thread AND g.at >= ?2
      WHERE g.deleted = 0 AND g.counted = 1 GROUP BY 1, 3`),
    // And what Clef sees in them.
    q(`WITH ${SCOPE} SELECT h.rowid AS id, x.tech FROM scope JOIN threads h ON h.thread = scope.thread
        JOIN thread_tech x ON x.thread = scope.thread`),
    // Adobe's people in them, by account: aggregated before their identities are looked up.
    q(`WITH ${SCOPE}, a AS (SELECT g.author_key AS key, ${WEEK('g.at')} AS week, COUNT(*) AS n,
        COUNT(DISTINCT g.thread) AS threads, MAX(g.at) AS last
      FROM scope JOIN messages g ON g.thread = scope.thread AND g.at >= ?2
      WHERE g.staff = 1 AND g.deleted = 0 AND g.counted = 1 AND g.author_key IS NOT NULL
      GROUP BY 1, 2)
      SELECT a.key, a.week, a.n, a.threads, a.last, i.person, i.kind,
        COALESCE(i.display_name, i.name) AS name
      FROM a LEFT JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +a.key`),
    db.prepare('SELECT tech, added_at FROM team_follows WHERE team = ?').bind(slug).all()
      .then((r) => r.results || []),
    db.prepare('SELECT tech FROM tech_stack WHERE team = ? AND enabled = 1').bind(slug).all()
      .then((r) => r.results || []),
    db.prepare('SELECT type, path, title, description FROM kb_concepts WHERE repo = ? ORDER BY title')
      .bind(`kb-team-${slug}`).all().then((r) => r.results || []),
    db.prepare('SELECT repo, entries FROM knowledge_bases WHERE kind = \'team\' AND slug = ?')
      .bind(slug).first(),
  ]);
  const at = new Map(weeks.map((w, i) => [w, i]));

  // The members: what they posted, and what sets them apart.
  const posted = byWeek(posts, 'person', weeks);
  const all = new Map(tags.filter((t) => t.kind === 'all').map((t) => [t.person, t]));
  const totals = new Map([...all].map(([p, t]) => [p, t.n]));
  const of = (kind) => tags.filter((t) => t.kind === kind);
  const areas = distinctive(of('area'), totals);
  const tech = distinctive(of('tech'), totals);
  const orgsOf = new Map();
  for (const t of of('org').sort((a, b) => b.n - a.n)) {
    orgsOf.set(t.person, [...(orgsOf.get(t.person) || []), {
      slug: t.what, n: t.n, threads: t.threads,
    }]);
  }

  // The customers, with the members who work each most.
  const orgs = byWeek(threadWeeks, 'org', weeks, (r, e) => {
    e.staff = (e.staff || 0) + (r.staff || 0);
    e.ids = (e.ids || new Set()).add(r.id);
  });
  const orgSlugs = [...orgs.keys()].filter((o) => o !== UNASSIGNED);
  const orgRows = orgSlugs.length ? await db.prepare(`SELECT slug, name, type, icon FROM orgs
      WHERE slug IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(orgSlugs)).all()
    .then((r) => r.results || []) : [];
  const orgInfo = new Map(orgRows.map((o) => [o.slug, o]));
  const workers = new Map();
  for (const [person, list] of orgsOf) {
    for (const o of list) {
      workers.set(o.slug, [...(workers.get(o.slug) || []), { id: person, n: o.n }]);
    }
  }
  const customers = [...orgs].filter(([org]) => org !== UNASSIGNED
      && (orgInfo.get(org)?.type || 'customer') !== 'internal')
    .map(([org, o]) => ({
      slug: org,
      name: orgInfo.get(org)?.name || null,
      type: orgInfo.get(org)?.type || 'customer',
      icon: orgInfo.get(org)?.icon || null,
      messages: o.n,
      staff: o.staff,
      threads: o.ids.size,
      weekly: o.weekly,
      last: o.last,
      members: (workers.get(org) || []).sort((a, b) => b.n - a.n).slice(0, 4).map((w) => w.id),
    }))
    .sort((a, b) => b.messages - a.messages || a.slug.localeCompare(b.slug));

  // The collaborators: Adobe's people in the team's threads who are not on it. A person's
  // accounts count as one; an account without a person as its own.
  const onTeam = new Set(members.map((m) => m.id));
  const collab = [...byWeek(
    staffWeeks.filter((r) => !(r.person && onTeam.has(r.person)) && (r.kind || 'person') === 'person')
      .map((r) => ({ ...r, who: r.person ? `p:${r.person}` : `a:${r.key}` })),
    'who',
    weeks,
    (r, e) => {
      e.person = r.person ?? null;
      e.name = e.name || r.name || null;
      e.threads = (e.threads || 0) + r.threads;
    },
  )].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  const top = collab.slice(0, MAX_COLLABORATORS);
  const ids = top.map(([, c]) => c.person).filter(Boolean);
  const [whoRows, teamRows] = ids.length ? await Promise.all([
    db.prepare(`SELECT p.id, ${NAME('p.id')} AS name, ${AVATAR('p.id')} AS avatar,
        ${TITLE('p.id')} AS title, p.staff FROM people p
      WHERE p.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all()
      .then((r) => r.results || []),
    db.prepare(`SELECT m.person, t.slug, t.name FROM team_members m JOIN teams t ON t.slug = m.team
      WHERE m.person IN (SELECT value FROM json_each(?)) ORDER BY t.name`).bind(JSON.stringify(ids)).all()
      .then((r) => r.results || []),
  ]) : [[], []];
  const who = new Map(whoRows.map((r) => [r.id, r]));
  const teamsOf = new Map();
  for (const r of teamRows) {
    teamsOf.set(r.person, [...(teamsOf.get(r.person) || []), { slug: r.slug, name: r.name }]);
  }
  const collaborators = top.map(([, c]) => {
    const p = c.person ? who.get(c.person) : null;
    return {
      id: c.person,
      name: (p && p.name) || c.name || null,
      avatar: (p && p.avatar) || null,
      title: (p && p.title) || null,
      teams: (c.person && teamsOf.get(c.person)) || [],
      messages: c.n,
      // Threads a week, added up (as `active` of a customer).
      active: c.threads,
      weekly: c.weekly,
      last: c.last,
    };
  });

  // The technologies: followed, of the catalog, and seen in the threads; what was said in the
  // threads that show one, week by week.
  const weeksOf = new Map();
  for (const r of threadWeeks) {
    weeksOf.set(r.id, [...(weeksOf.get(r.id) || []), r]);
  }
  const seenBy = new Map();
  for (const { id, tech: t } of threadTech) {
    if (!seenBy.has(t)) {
      seenBy.set(t, { n: 0, weekly: zeros(weeks.length) });
    }
    const e = seenBy.get(t);
    e.n += 1;
    for (const r of weeksOf.get(id) || []) {
      if (at.has(r.week)) {
        e.weekly[at.get(r.week)] += r.n;
      }
    }
  }
  const followed = new Map(follows.map((f) => [f.tech, f.added_at]));
  const mine = new Set(catalog.map((c) => c.tech));
  const seenTop = [...seenBy].filter(([id]) => !followed.has(id) && !mine.has(id))
    .sort((a, b) => b[1].n - a[1].n).slice(0, MAX_SEEN).map(([id]) => id);
  const memberTech = [...tech.values()].flat().map((t) => t.id);
  const wantedTech = [...new Set([...followed.keys(), ...mine, ...seenTop, ...memberTech])];
  const nameRows = wantedTech.length ? await db.prepare(`SELECT team, tech, name, vendor, product,
      kind, layer, path FROM tech_stack WHERE tech IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(wantedTech)).all().then((r) => r.results || []) : [];
  const names = techNames(nameRows, slug);
  const techOut = [...new Set([...followed.keys(), ...mine, ...seenTop])].map((id) => {
    const n = names.get(id);
    const s = seenBy.get(id);
    return {
      tech: id,
      name: (n && n.name) || id,
      vendor: (n && n.vendor) || null,
      product: (n && n.product) || null,
      kind: (n && n.kind) || null,
      layer: (n && n.layer) || null,
      // Its file in the team's knowledge base, where the catalog is the team's.
      path: mine.has(id) && n && n.team === slug ? n.path : null,
      followed: followed.has(id),
      catalog: mine.has(id),
      threads: s ? s.n : 0,
      weekly: s ? s.weekly : zeros(weeks.length),
    };
  }).sort((a, b) => b.threads - a.threads || a.name.localeCompare(b.name));

  // The areas' names, the team's own words first.
  const areaIds = [...new Set([...areas.values()].flat().map((a) => a.id))];
  const areaRows = areaIds.length ? await db.prepare(`SELECT id, name FROM areas
      WHERE id IN (SELECT value FROM json_each(?)) ORDER BY team = ? DESC, team = ? DESC`)
    .bind(JSON.stringify(areaIds), slug, ADMIN_TEAM).all().then((r) => r.results || []) : [];
  const areaName = new Map();
  for (const a of areaRows) {
    if (!areaName.has(a.id)) {
      areaName.set(a.id, a.name);
    }
  }

  const orgName = new Map(customers.map((c) => [c.slug, c]));
  const memberOut = members.map((m) => {
    const p = posted.get(m.id);
    const a = all.get(m.id);
    return {
      id: m.id,
      name: m.name || null,
      role: m.role,
      avatar: m.avatar || null,
      title: m.title || null,
      messages: p ? p.n : 0,
      threads: a ? a.threads : 0,
      weekly: p ? p.weekly : zeros(weeks.length),
      last: p ? p.last : null,
      areas: (areas.get(m.id) || []).map((x) => ({ ...x, name: areaName.get(x.id) || x.id })),
      tech: (tech.get(m.id) || []).map((x) => ({ ...x, name: names.get(x.id)?.name || x.id })),
      customers: (orgsOf.get(m.id) || []).slice(0, MAX_KEY_CUSTOMERS).map((o) => ({
        ...o,
        name: orgName.get(o.slug)?.name || null,
        icon: orgName.get(o.slug)?.icon || null,
      })),
    };
  }).sort((a, b) => b.messages - a.messages || String(a.name).localeCompare(String(b.name)));

  // The knowledge base: its entries by type, the catalog left out (it is the technologies).
  const types = new Map();
  for (const c of concepts) {
    if (c.type && !CATALOG_TYPES.has(c.type) && c.path !== STACK_PATH) {
      types.set(c.type, [...(types.get(c.type) || []), {
        path: c.path, title: c.title || c.path, description: c.description || null,
      }]);
    }
  }
  // Everything said in the team's threads, week by week: by Adobe's people, and in how many.
  const activity = {
    messages: zeros(weeks.length), staff: zeros(weeks.length), threads: zeros(weeks.length),
  };
  for (const r of threadWeeks) {
    const i = at.get(r.week);
    if (i !== undefined) {
      activity.messages[i] += r.n;
      activity.staff[i] += r.staff || 0;
      activity.threads[i] += 1;
    }
  }
  const threadCount = weeksOf.size;
  return {
    team: {
      slug: team.slug,
      name: team.name,
      self_managed: Boolean(team.self_managed),
      channels: team.channels || 0,
      shared: team.shared || 0,
    },
    weeks,
    // The layers of a stack (src/stack.js), which the technologies are in.
    layers: LAYERS.map(({ id, name }) => ({ id, name })),
    activity,
    threadCount,
    members: memberOut,
    customers: customers.slice(0, MAX_CUSTOMERS),
    customerCount: customers.length,
    collaborators,
    collaboratorCount: collab.length,
    tech: techOut,
    kb: base ? {
      repo: base.repo,
      entries: base.entries ?? null,
      stack: concepts.some((c) => c.path === STACK_PATH),
      types: [...types].map(([type, list]) => ({ type, n: list.length, entries: list }))
        .sort((a, b) => b.n - a.n || a.type.localeCompare(b.type)),
    } : null,
  };
}

/** GET /api/teams/profile?team=: `teamNumbers`, kept a while, and what `me` may do and read. */
export async function teamProfile(env, me, slug, { now = new Date() } = {}) {
  const key = String(slug || '');
  if (!key || key === UNASSIGNED) {
    return { error: 'no such team', status: 404 };
  }
  const db = underlying(env.DB);
  if (!cache.has(db)) {
    cache.set(db, new Map());
  }
  const kept = cache.get(db);
  const hit = kept.get(key);
  let numbers = hit && now.getTime() - hit.at < CACHE_MS ? hit.numbers : null;
  if (!numbers) {
    numbers = await teamNumbers(env, key, { now });
    if (numbers) {
      kept.set(key, { at: now.getTime(), numbers });
    }
  }
  if (!numbers) {
    return { error: 'no such team', status: 404 };
  }
  const readable = numbers.kb ? await mayRead(env, me, { kind: 'team', slug: key }) : false;
  return {
    ...numbers,
    // The entries' titles for whoever may read the knowledge base; their number for everyone.
    kb: numbers.kb && {
      ...numbers.kb,
      readable,
      types: numbers.kb.types.map((t) => ({
        type: t.type, n: t.n, entries: readable ? t.entries.slice(0, MAX_ENTRIES) : [],
      })),
      stack: readable && numbers.kb.stack,
    },
    may: { manage: managesTeam(me, key) },
  };
}

/** GET /api/teams: every ops team, `[{ slug, name, members, self_managed }]`, by name. */
export async function teamDirectory(env) {
  const { results } = await env.DB.prepare(`SELECT t.slug, t.name, t.self_managed,
      (SELECT COUNT(*) FROM team_members m WHERE m.team = t.slug) AS members
    FROM teams t ORDER BY t.name`).all();
  return (results || []).map((t) => ({ ...t, self_managed: Boolean(t.self_managed) }));
}

/** Clears the kept numbers (tests). */
export function resetTeamProfiles() {
  cache = new WeakMap();
}
