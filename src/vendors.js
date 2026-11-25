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
 * Vendors: the orgs of type `vendor`, companies whose products or services Adobe uses. In their
 * channels Adobe is the customer: the team asks, and the vendor answers, investigates and fixes
 * (Clef is asked so, src/label.js VENDOR_QUESTIONS; such a thread waits on the vendor,
 * src/threads.js waitingOn). What the pages show of them (docs/ARCHITECTURE.md, "Vendors"):
 *
 * - A vendor's page in Customers (src/orgprofile.js, ui/customer.js) adds `vendorNumbers`: its
 *   open cases (its conversations that are not resolved and wait on someone), its status posts
 *   (its channels' alerts, week by week), and the customers' threads that show its products
 *   (a technology whose catalog id is the vendor's slug or under it, `fastly/cdn`, the way
 *   products/<vendor>/<product>.md names it, src/catalog.js).
 * - A team's Vendors section in Teams (`GET /api/teams/vendors?team=`, `teamVendors`, drawn by
 *   ui/team.js): the vendors the team files, shares or follows a channel of, whose threads its
 *   people post in, or whose products its customers' threads show; their cases, how soon each
 *   answers, and the threads of the team's inbox that wait on a vendor.
 *
 * Counts are everyone's at Adobe, as the overviews'. A thread's title and its link are only for
 * whoever works it: someone on the team it is filed under or one it is shared with (`visible`).
 * No message text leaves the Worker.
 */

import { agentLabelsFor } from './agentlabels.js';
import { underlying } from './d1batch.js';
import { TECH_MIN } from './label.js';
import {
  isResolved, resolution, resolutionFacts, signalFacts,
} from './resolve.js';
import { effectiveLabel, managesTeam, reviewsFor } from './review.js';
import {
  CACHE_MS, WEEK, WEEKS, zeros,
} from './teamprofile.js';
import { waitingOn } from './threads.js';
import { weeksTo } from './trends.js';

export const VENDOR = 'vendor';
/** At most this many of each list. */
export const MAX_CASES = 20;
export const MAX_STATUS = 8;
export const MAX_DEPENDENTS = 10;
export const MAX_WAITING = 25;
/**
 * The threads asked about at once (`entriesOf`): every conversation of the window is read, in
 * chunks, so an old open case behind many newer resolved ones still counts.
 */
const CHUNK = 200;
/** SQL: a conversation of thread `h` that may wait on someone (src/threads.js waitingOn). */
const MAY_WAIT = (h) => `${h}.imported = 0 AND ${h}.last_staff IS NOT NULL`;

const URGENCY = ['low', 'normal', 'high', 'critical'];
const urgencyName = (u) => (u == null ? 'low' : URGENCY[Math.min(3, Math.max(0, Math.round(u)))]);

/** The middle of `values`, or null for none. */
function middle(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) {
    return null;
  }
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * SQL: technology `col` is one of the products of the vendor `param`: its catalog id is the
 * vendor's slug, or under it (`fastly/cdn` is Fastly's). Two ranges of the index, no LIKE.
 */
export const productOf = (col, param) => `(${col} = ${param}
  OR (${col} >= ${param} || '/' AND ${col} < ${param} || '0'))`;

/** Whether `me` works a thread row (`team`, `shared`): on its team or one it is shared with. */
export const visible = (me) => (row) => {
  const mine = new Set((me?.teams || []).map((t) => t.slug));
  return [row.team, ...(row.shared || [])].some((t) => mine.has(t));
};

/** The team of a visible row `me` opens it in: theirs among its teams, its own first. */
const viewTeam = (me, row) => {
  const mine = new Set((me?.teams || []).map((t) => t.slug));
  return [row.team, ...(row.shared || [])].find((t) => mine.has(t)) || row.team;
};

/** A thread row as a list shows it, for `me`: its title and link only where they work it. */
export const shown = (me) => (row) => ({
  ...row, inbox: `/inbox?${new URLSearchParams({ team: viewTeam(me, row), t: row.thread })}`,
});

/**
 * `rows` that `me` may see as they are, and how many are left out (`hidden`): the lists of the
 * pages, filtered per viewer after they are kept for everyone.
 */
export function forViewer(me, rows, most = Infinity) {
  const may = visible(me);
  const list = rows.filter(may);
  return { list: list.slice(0, most).map(shown(me)), hidden: rows.length - list.length };
}

/** `entriesOf`, for at most CHUNK rows. */
async function entriesOfChunk(env, rows) {
  const keys = [...new Set(rows.map((r) => r.thread))];
  if (!keys.length) {
    return new Map();
  }
  const [{ results: labels }, reviews, agent, checks, signals] = await Promise.all([
    env.DB.prepare(`SELECT thread, next_actor, kind, urgency, resolved_p, labeled_through, title
      FROM labels WHERE thread IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(keys)).all(),
    reviewsFor(env.DB, keys),
    agentLabelsFor(env.DB, keys),
    resolutionFacts(env, keys),
    signalFacts(env, keys),
  ]);
  const group = (list) => {
    const m = new Map();
    for (const r of list || []) {
      m.set(r.thread, [...(m.get(r.thread) || []), r]);
    }
    return m;
  };
  const labelOf = new Map((labels || []).map((l) => [l.thread, l]));
  const reviewsOf = group(reviews);
  const agentOf = group(agent);
  const out = new Map();
  for (const r of rows) {
    const label = effectiveLabel(
      labelOf.get(r.thread) || null,
      reviewsOf.get(r.thread) || [],
      agentOf.get(r.thread) || [],
    );
    const verdict = resolution(checks.get(r.thread), label, null)?.verdict;
    out.set(r.thread, {
      waiting: waitingOn({ ...r, label, signals: signals.get(r.thread) || [] }),
      resolved: isResolved(verdict, label),
      urgency: urgencyName(label && label.urgency),
      kind: (label && label.kind) || null,
      title: (label && label.title) || r.title || null,
    });
  }
  return out;
}

/**
 * What the inbox shows of thread rows (`thread`, `kind`, `last_staff`, `last_at`, `any_at`,
 * `imported`, `org_type`, `title`): their label with the agent's answers and the reviews, who
 * they wait on (src/threads.js waitingOn), whether they are resolved (a staff ✅, else Clef), their
 * urgency, kind and title. A Map by thread.
 */
export async function entriesOf(env, rows) {
  const out = new Map();
  for (let i = 0; i < rows.length; i += CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    for (const [k, v] of await entriesOfChunk(env, rows.slice(i, i + CHUNK))) {
      out.set(k, v);
    }
  }
  return out;
}

/** The teams each channel is shared with: `Map<"source:channelId", team[]>`, for `rows`. */
async function sharesOf(env, rows) {
  const ids = [...new Set(rows.map((r) => r.channel_id))];
  if (!ids.length) {
    return new Map();
  }
  const { results } = await env.DB.prepare(`SELECT source, channel_id, team FROM channel_teams
    WHERE channel_id IN (SELECT value FROM json_each(?)) ORDER BY added_at, team`)
    .bind(JSON.stringify(ids)).all();
  const out = new Map();
  for (const r of results || []) {
    const k = `${r.source}:${r.channel_id}`;
    out.set(k, [...(out.get(k) || []), r.team]);
  }
  return out;
}

/** SQL: what a thread row needs for `entriesOf` and a list, of threads `h`. */
const ROW = `h.thread, h.source, h.channel_id, h.org, h.team, h.kind, h.title, h.channel_name,
  h.root_at, h.last_at, h.any_at, h.last_staff, h.imported`;

/**
 * A row of a list: what it is, who it waits on, and its teams; `third` for a customer's thread,
 * whose `vendor` is a third party (src/label.js QUESTIONS), not a vendor's case.
 */
const listRow = (r, e, shares) => ({
  thread: r.thread,
  org: r.org,
  third: r.org_type !== VENDOR,
  title: e.title,
  channel: r.channel_name || null,
  source: r.source,
  kind: e.kind,
  urgency: e.urgency,
  waiting: e.waiting,
  root: r.root_at || null,
  last: r.last_at || r.any_at || null,
  team: r.team,
  shared: (shares.get(`${r.source}:${r.channel_id}`) || []).filter((t) => t !== r.team),
});

/**
 * How soon each of the vendors `slugs` answers what Adobe starts: for the threads whose first
 * post (a person's) was Adobe's, the wait for the vendor's first one after it, in minutes.
 * `Map<slug, { asked, answered, median }>`.
 */
export async function vendorAnswers(env, slugs, since) {
  if (!slugs.length) {
    return new Map();
  }
  const { results } = await env.DB.prepare(`WITH f AS (SELECT h.thread, h.org,
        (SELECT m.staff FROM messages m WHERE m.thread = h.thread AND m.counted = 1
          AND m.deleted = 0 ORDER BY m.at LIMIT 1) AS staff,
        (SELECT MIN(m.at) FROM messages m WHERE m.thread = h.thread AND m.counted = 1
          AND m.deleted = 0) AS first
      FROM threads h WHERE h.org IN (SELECT value FROM json_each(?1)) AND h.kind = 'channel'
        AND h.root_at >= ?2)
    SELECT f.org, f.first, (SELECT MIN(m.at) FROM messages m WHERE m.thread = f.thread
        AND m.staff = 0 AND m.counted = 1 AND m.deleted = 0 AND m.at > f.first) AS answered
    FROM f WHERE f.staff = 1`).bind(JSON.stringify(slugs), since).all();
  const by = new Map(slugs.map((s) => [s, { asked: 0, waits: [] }]));
  for (const r of results || []) {
    const v = by.get(r.org);
    if (v) {
      v.asked += 1;
      if (r.answered) {
        v.waits.push((Date.parse(r.answered) - Date.parse(r.first)) / 60000);
      }
    }
  }
  return new Map([...by].map(([s, v]) => [s, {
    asked: v.asked, answered: v.waits.length, median: middle(v.waits),
  }]));
}

/**
 * What a vendor's page adds to its overview (src/orgprofile.js `orgNumbers`), everyone's but the
 * lists, which `vendorForViewer` filters:
 * - `cases`: its conversations of the weeks that are open (not resolved, and waiting on the
 *   vendor or on Adobe), how many wait on each, and the latest `MAX_CASES` of them;
 * - `status`: its channels' alerts (a status page's posts, a maintenance notice), week by week,
 *   and the latest;
 * - `dependents`: the customers' threads of the weeks that show one of its products, by customer
 *   and by product, and the open ones that wait on a third party.
 */
export async function vendorNumbers(env, slug, weeks) {
  const since = `${weeks[0]}T00:00:00.000Z`;
  const db = env.DB;
  const all = (sql, ...args) => db.prepare(sql).bind(...args).all().then((r) => r.results || []);
  // The customers' threads that show one of its products (thread_tech, by index), of the weeks.
  const DEPENDS = `FROM thread_tech x JOIN threads h ON h.thread = x.thread
    WHERE ${productOf('x.tech', '?1')} AND x.p >= ?3 AND h.kind = 'channel' AND h.org != ?1
      AND h.last_at >= ?2`;
  const [
    threads, alertWeeks, alerts, [total], orgCounts, techCounts, waitingRows,
  ] = await Promise.all([
    all(`SELECT ${ROW} FROM threads h WHERE h.org = ?1 AND h.kind = 'channel' AND h.last_at >= ?2
      AND ${MAY_WAIT('h')} ORDER BY h.last_at DESC`, slug, since),
    all(`SELECT ${WEEK('h.root_at')} AS week, COUNT(*) AS n FROM threads h
      WHERE h.org = ?1 AND h.kind = 'alert' AND h.root_at >= ?2 GROUP BY 1`, slug, since),
    all(`SELECT h.thread, h.source, h.channel_id, h.team, h.channel_name,
        COALESCE(l.title, h.title) AS title, h.root_at, h.any_at
      FROM threads h LEFT JOIN labels l ON l.thread = h.thread
      WHERE h.org = ?1 AND h.kind = 'alert' AND h.root_at >= ?2
      ORDER BY h.root_at DESC LIMIT ${MAX_STATUS}`, slug, since),
    all(`SELECT COUNT(DISTINCT x.thread) AS threads ${DEPENDS}`, slug, since, TECH_MIN),
    all(`SELECT h.org, COUNT(DISTINCT x.thread) AS threads, MAX(h.last_at) AS last ${DEPENDS}
      GROUP BY h.org`, slug, since, TECH_MIN),
    all(
      `SELECT x.tech, COUNT(DISTINCT x.thread) AS threads ${DEPENDS} GROUP BY x.tech`,
      slug,
      since,
      TECH_MIN,
    ),
    // Those that Clef says wait on a third party: only those are read further.
    all(`SELECT DISTINCT ${ROW} ${DEPENDS} AND EXISTS (SELECT 1 FROM labels l
        WHERE l.thread = h.thread AND l.next_actor = 'vendor') AND ${MAY_WAIT('h')}
      ORDER BY h.last_at DESC`, slug, since, TECH_MIN),
  ]);
  const at = new Map(weeks.map((w, i) => [w, i]));
  const weekly = zeros(weeks.length);
  for (const r of alertWeeks) {
    if (at.has(r.week)) {
      weekly[at.get(r.week)] += r.n;
    }
  }
  const typed = [
    ...threads.map((r) => ({ ...r, org_type: VENDOR })),
    ...waitingRows.map((r) => ({ ...r, org_type: 'customer' })),
  ];
  const [entries, shares, orgRows, nameRows] = await Promise.all([
    entriesOf(env, typed),
    sharesOf(env, [...threads, ...waitingRows, ...alerts]),
    orgCounts.length ? all(`SELECT slug, name, type, icon FROM orgs
      WHERE slug IN (SELECT value FROM json_each(?))`, JSON.stringify(orgCounts.map((r) => r.org))) : [],
    techCounts.length ? all(`SELECT tech, name, team FROM tech_stack
      WHERE tech IN (SELECT value FROM json_each(?))`, JSON.stringify(techCounts.map((r) => r.tech))) : [],
  ]);
  const caseOf = (r) => listRow({ ...r, org_type: VENDOR }, entries.get(r.thread), shares);
  const open = threads.map(caseOf)
    .filter((r) => !entries.get(r.thread).resolved && ['vendor', 'us'].includes(r.waiting));
  const waiting = waitingRows.map((r) => listRow(r, entries.get(r.thread), shares))
    .filter((r) => r.waiting === 'vendor' && !entries.get(r.thread).resolved);

  const orgOf = new Map(orgRows.map((o) => [o.slug, o]));
  // A product's name: the admin team's, else any team's, else its id.
  const techName = new Map();
  for (const n of [...nameRows].sort((a, b) => Number(b.team === 'admin') - Number(a.team === 'admin'))) {
    if (!techName.has(n.tech) && n.name) {
      techName.set(n.tech, n.name);
    }
  }
  const waitingBy = new Map();
  for (const r of waiting) {
    waitingBy.set(r.org, (waitingBy.get(r.org) || 0) + 1);
  }
  const customers = orgCounts.map((o) => ({
    slug: o.org,
    name: orgOf.get(o.org)?.name || null,
    type: orgOf.get(o.org)?.type || 'customer',
    icon: orgOf.get(o.org)?.icon || null,
    threads: o.threads,
    waiting: waitingBy.get(o.org) || 0,
    last: o.last || null,
  })).sort((a, b) => b.threads - a.threads || a.slug.localeCompare(b.slug));
  return {
    cases: {
      open: open.length,
      them: open.filter((r) => r.waiting === 'vendor').length,
      us: open.filter((r) => r.waiting === 'us').length,
      list: open,
    },
    status: {
      total: weekly.reduce((s, v) => s + v, 0),
      weekly,
      list: alerts.map((r) => ({
        thread: r.thread,
        title: r.title || null,
        channel: r.channel_name || null,
        at: r.root_at,
        team: r.team,
        shared: (shares.get(`${r.source}:${r.channel_id}`) || []).filter((t) => t !== r.team),
      })),
    },
    dependents: {
      threads: (total && total.threads) || 0,
      customerCount: customers.length,
      customers: customers.slice(0, MAX_DEPENDENTS),
      products: techCounts.map((t) => ({
        tech: t.tech, name: techName.get(t.tech) || t.tech, threads: t.threads,
      })).sort((a, b) => b.threads - a.threads || a.name.localeCompare(b.name)),
      waiting: waiting.length,
      list: waiting,
    },
  };
}

/** `vendorNumbers` as `me` sees it: the lists' titles and links only where they work them. */
export function vendorForViewer(me, v) {
  if (!v) {
    return null;
  }
  const cases = forViewer(me, v.cases.list, MAX_CASES);
  const status = forViewer(me, v.status.list, MAX_STATUS);
  const waiting = forViewer(me, v.dependents.list, MAX_WAITING);
  return {
    cases: { ...v.cases, list: cases.list, hidden: cases.hidden },
    status: { ...v.status, list: status.list, hidden: status.hidden },
    dependents: { ...v.dependents, list: waiting.list, hidden: waiting.hidden },
  };
}

let cache = new WeakMap();

/**
 * A team's vendors, for everyone at Adobe: the vendors it files, shares or follows a channel of,
 * whose threads its members post in, or whose products its customers' threads show, each with its
 * cases and how soon it answers; and the threads of its inbox (filed under it or shared with it)
 * that wait on a vendor, or are a vendor's cases that wait on Adobe. Null for no such team.
 */
export async function teamVendorNumbers(env, team, { now = new Date() } = {}) {
  const weeks = weeksTo(now, WEEKS);
  const since = `${weeks[0]}T00:00:00.000Z`;
  const db = env.DB;
  const all = (sql, ...args) => db.prepare(sql).bind(...args).all().then((r) => r.results || []);
  const row = await db.prepare('SELECT slug, name FROM teams WHERE slug = ?').bind(team).first();
  if (!row) {
    return null;
  }
  // The team's threads: filed under it, or in a channel shared with it.
  const inTeam = (h) => `(${h}.team = ?1 OR (${h}.source, ${h}.channel_id) IN (
    SELECT source, channel_id FROM channel_teams WHERE team = ?1))`;
  const [vendors, channels, follows, posted, products, waitingRows] = await Promise.all([
    all('SELECT slug, name, icon FROM orgs WHERE type = ? ORDER BY COALESCE(name, slug)', VENDOR),
    // Every vendor channel: the team it is filed under, the teams it is shared with.
    all(`SELECT h.org, h.team, h.source, h.channel_id, MAX(COALESCE(h.last_at, h.any_at)) AS last,
        SUM(h.kind = 'channel' AND h.last_at >= ?2) AS threads
      FROM threads h WHERE h.org IN (SELECT slug FROM orgs WHERE type = ?1)
      GROUP BY 1, 2, 3, 4`, VENDOR, since),
    all('SELECT pattern FROM rules WHERE target = \'follow\' AND field = \'org\' AND value = ?', team),
    // What its members said in vendors' threads.
    all(`SELECT h.org, COUNT(*) AS messages, COUNT(DISTINCT m.person) AS people FROM threads h
        JOIN messages m ON m.thread = h.thread
      WHERE h.org IN (SELECT slug FROM orgs WHERE type = ?2) AND h.kind = 'channel'
        AND h.last_at >= ?3 AND m.at >= ?3 AND m.staff = 1 AND m.counted = 1 AND m.deleted = 0
        AND m.person IN (SELECT person FROM team_members WHERE team = ?1)
      GROUP BY h.org`, team, VENDOR, since),
    // Its customers' threads that show a vendor's products: equal to the slug, or under it.
    all(`SELECT o.slug AS org, COUNT(DISTINCT h.thread) AS threads FROM orgs o
        JOIN thread_tech x ON ${productOf('x.tech', 'o.slug')}
        JOIN threads h ON h.thread = x.thread
      WHERE o.type = ?2 AND x.p >= ?4 AND h.kind = 'channel' AND h.last_at >= ?3
        AND h.org != o.slug AND ${inTeam('h')}
      GROUP BY o.slug`, team, VENDOR, since, TECH_MIN),
    // Its customers' threads that Clef says wait on a third party.
    all(`SELECT ${ROW}, o.type AS org_type FROM threads h JOIN labels l ON l.thread = h.thread
        LEFT JOIN orgs o ON o.slug = h.org
      WHERE l.next_actor = 'vendor' AND h.kind = 'channel' AND h.last_at >= ?2
        AND COALESCE(o.type, 'customer') != ?3 AND ${inTeam('h')} AND ${MAY_WAIT('h')}
      ORDER BY h.last_at DESC`, team, since, VENDOR),
  ]);
  const shareRows = await all(`SELECT s.source, s.channel_id, s.team FROM channel_teams s
    WHERE (s.source, s.channel_id) IN (SELECT h.source, h.channel_id FROM threads h
      WHERE h.org IN (SELECT slug FROM orgs WHERE type = ?))`, VENDOR);
  const sharedWith = new Map();
  for (const s of shareRows) {
    const k = `${s.source}:${s.channel_id}`;
    sharedWith.set(k, [...(sharedWith.get(k) || []), s.team]);
  }
  const followed = new Set(follows.map((f) => String(f.pattern).replace(/^\^|\$$/g, '')));
  const postedBy = new Map(posted.map((p) => [p.org, p]));
  const productsBy = new Map(products.map((p) => [p.org, p.threads]));
  const rel = new Map(vendors.map((v) => [v.slug, {
    ...v, filed: 0, shared: 0, channels: new Set(), threads: 0, last: null,
  }]));
  for (const c of channels) {
    const v = rel.get(c.org);
    if (v) {
      const k = `${c.source}:${c.channel_id}`;
      if (c.team === team) {
        v.filed += 1;
      } else if ((sharedWith.get(k) || []).includes(team)) {
        v.shared += 1;
      }
      v.channels.add(k);
      v.threads += c.threads || 0;
      v.last = [v.last, c.last].filter(Boolean).sort().pop() || null;
    }
  }
  const related = [...rel.values()].filter((v) => v.filed || v.shared || followed.has(v.slug)
    || postedBy.has(v.slug) || productsBy.has(v.slug));
  const slugs = related.map((v) => v.slug);
  // Their conversations of the weeks: their cases.
  const threads = slugs.length ? await all(`SELECT ${ROW} FROM threads h
    WHERE h.org IN (SELECT value FROM json_each(?1)) AND h.kind = 'channel' AND h.last_at >= ?2
      AND ${MAY_WAIT('h')} ORDER BY h.last_at DESC`, JSON.stringify(slugs), since) : [];
  const [entries, answers, shares] = await Promise.all([
    entriesOf(env, [
      ...threads.map((r) => ({ ...r, org_type: VENDOR })),
      ...waitingRows.map((r) => ({ ...r, org_type: r.org_type || 'customer' })),
    ]),
    vendorAnswers(env, slugs, since),
    sharesOf(env, [...threads, ...waitingRows]),
  ]);
  const caseOf = (r) => listRow({ ...r, org_type: VENDOR }, entries.get(r.thread), shares);
  const cases = threads.map(caseOf)
    .filter((r) => !entries.get(r.thread).resolved && ['vendor', 'us'].includes(r.waiting));
  const casesOf = new Map();
  for (const c of cases) {
    casesOf.set(c.org, [...(casesOf.get(c.org) || []), c]);
  }
  const inbox = (r) => r.team === team || r.shared.includes(team);
  const theirs = waitingRows.map((r) => listRow(r, entries.get(r.thread), shares))
    .filter((r) => r.waiting === 'vendor' && !entries.get(r.thread).resolved);
  const list = related.map((v) => {
    const open = casesOf.get(v.slug) || [];
    return {
      slug: v.slug,
      name: v.name || null,
      icon: v.icon || null,
      filed: v.filed,
      shared: v.shared,
      follows: followed.has(v.slug),
      inInbox: Boolean(v.filed || v.shared || followed.has(v.slug)),
      // Its channels, anyone's: following it shares them with the team.
      channels: v.channels.size,
      posted: postedBy.get(v.slug)?.messages || 0,
      people: postedBy.get(v.slug)?.people || 0,
      products: productsBy.get(v.slug) || 0,
      threads: v.threads,
      cases: {
        open: open.length,
        them: open.filter((c) => c.waiting === 'vendor').length,
        us: open.filter((c) => c.waiting === 'us').length,
      },
      answers: answers.get(v.slug) || { asked: 0, answered: 0, median: null },
      last: v.last,
    };
  }).sort((a, b) => Number(b.inInbox) - Number(a.inInbox) || b.cases.open - a.cases.open
    || b.posted - a.posted || b.products - a.products || b.threads - a.threads
    || String(a.name || a.slug).localeCompare(String(b.name || b.slug)));
  return {
    team: { slug: row.slug, name: row.name },
    weeks,
    vendors: list,
    // What waits on a vendor in its inbox: its vendor cases, its customers' threads.
    waiting: [...cases.filter((c) => c.waiting === 'vendor' && inbox(c)), ...theirs]
      .sort((a, b) => String(b.last || '').localeCompare(String(a.last || ''))),
    // The vendors' cases that wait on Adobe, in its inbox or not.
    ours: cases.filter((c) => c.waiting === 'us'),
  };
}

/**
 * GET /api/teams/vendors?team=: `teamVendorNumbers`, kept CACHE_MS per isolate, as `me` sees it:
 * the lists' titles and links only where they work the thread, and whether they may make the
 * team follow a vendor (its managers and the admin team, `PUT /api/admin/org-follows`).
 */
export async function teamVendors(env, me, slug, { now = new Date() } = {}) {
  const key = String(slug || '');
  if (!key) {
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
    numbers = await teamVendorNumbers(env, key, { now });
    if (numbers) {
      kept.set(key, { at: now.getTime(), numbers });
    }
  }
  if (!numbers) {
    return { error: 'no such team', status: 404 };
  }
  const waiting = forViewer(me, numbers.waiting, MAX_WAITING);
  const ours = forViewer(me, numbers.ours, MAX_WAITING);
  return {
    ...numbers,
    waiting: waiting.list,
    waitingCount: numbers.waiting.length,
    waitingHidden: waiting.hidden,
    ours: ours.list,
    oursCount: numbers.ours.length,
    oursHidden: ours.hidden,
    may: { follow: managesTeam(me, key) },
  };
}

/**
 * Clears the kept numbers: a team began or stopped following a vendor (PUT
 * /api/admin/org-follows), so its Vendors section says so at once, in this isolate; tests.
 */
export function resetTeamVendors() {
  cache = new WeakMap();
}
