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
 * A customer's overview, the first section of its page in Customers (ui/admin.js
 * `showOrgOverview`, ui/customer.js), for every internal user, as a team's is
 * (src/teamprofile.js; docs/ARCHITECTURE.md, "Customer overview"):
 *
 * - `GET /api/customers`: every customer, partner and vendor, for the list.
 * - `GET /api/customers/profile?org=`: the customer's last WEEKS weeks, from D1 alone:
 *   - its **threads**, week by week: what its people said, and what Adobe's people said;
 *   - how soon Adobe **answers** a thread its people start (the median wait for Adobe's first
 *     post, and how many of those threads have one);
 *   - its **people** (and the partners' in its threads), each with a picture, their title, how
 *     much they posted, what they ask about (Clef's areas and technologies of their threads, the
 *     ones that set them apart from the rest of them first), and their Contact in its knowledge
 *     base where it has one; the accounts of one mail address are one person, and so are those
 *     the admin team said are (src/accountpairs.js);
 *   - **Adobe's people** in its threads, with their teams, and the **teams** that work it: whose
 *     people post there, the teams its channels are filed under or shared with, and those that
 *     follow it;
 *   - what its threads are **about** (Clef's areas), its **channels**, and its **technologies**:
 *     those Clef sees in its threads, and the parts of its stack drawing;
 *   - its **knowledge base**: its entries by type, listed for whoever may read it
 *     (src/kbaccess.js), counted for everyone else; and whether it has a stack drawing.
 *
 * A vendor's (`orgs.type` 'vendor') is the other way round: how soon it answers what Adobe starts
 * (`answers.by` 'them'), and `vendor`, its cases, status posts and the customers on its products
 * (src/vendors.js), whose lists are filtered per viewer.
 *
 * A partner's (`orgs.type` 'partner', an agency or a system integrator) adds `partner`: the
 * customers it works for, its people wherever they post, what waits on Adobe in its channels and
 * in the customers' threads its people are in, and how soon Adobe answers them (src/partners.js
 * `partnerNumbers`); its own people are its, not "partners'". A customer's adds `partners`: the
 * partners that work for it (src/orgpartners.js `partnersOf`) and those whose people posted in
 * its threads, with what links them. A decision on a pair forgets both pages (`forgetOrgProfiles`).
 *
 * "Its threads" are the channel conversations filed under it, active in the window. Names,
 * numbers, pictures and titles only: no message text, and no mail address, leaves the Worker. A
 * customer's numbers are kept CACHE_MS per isolate.
 */

import { ADMIN_TEAM } from './roles.js';
import { underlying } from './d1batch.js';
import { mayRead } from './kbaccess.js';
import { weeksTo } from './trends.js';
import { LAYERS, STACK_PATH } from './stack.js';
import { partnerOf } from './profiles.js';
import {
  partnerDomains, partnerForViewer, partnerNumbers, UNLINKED_MIN,
} from './partners.js';
import { customersOf, partnersOf } from './orgpartners.js';
import { personSlug } from './agent/okf.js';
import { mailDomains } from './orgmerge.js';
import { activeSince } from './listactivity.js';
import { AVATAR, NAME, TITLE } from './personsql.js';
import { sameAccounts, sameLinks } from './accountpairs.js';
import { VENDOR, vendorForViewer, vendorNumbers } from './vendors.js';
import {
  byWeek, CACHE_MS, CATALOG_TYPES, distinctive, MAX_ENTRIES, techNames, UNASSIGNED, WEEK, WEEKS,
  zeros,
} from './teamprofile.js';

export { WEEKS };
/** At most this many of each list. */
export const MAX_PEOPLE = 12;
export const MAX_STAFF = 15;
export const MAX_TEAMS = 10;
export const MAX_CHANNELS = 12;
export const MAX_AREAS = 12;
export const MAX_SEEN = 15;
/** The parts a breakdown of the chart has at most, the rest as one. */
export const MAX_PARTS = 7;

let cache = new WeakMap();
/**
 * Each org's numbers forgotten (`forgetOrgProfiles`): the count of forgets when they last were.
 * Numbers read before that are not used.
 */
let forgotten = new Map();
let forgets = 0;
const PARTNER = 'partner';

/** SQL: the customer's threads (`thread`), `?1` the org, `?2` the first day counted. */
const SCOPE = `scope AS (SELECT h.thread FROM threads h
    WHERE h.org = ?1 AND h.kind = 'channel' AND h.last_at >= ?2)`;

/** SQL: who posted in its threads, by account and week, before their accounts are looked up. */
const AUTHORS = `a AS (SELECT g.author_key AS key, g.staff, ${WEEK('g.at')} AS week, COUNT(*) AS n,
      COUNT(DISTINCT g.thread) AS threads, MAX(g.at) AS last
    FROM scope JOIN messages g ON g.thread = scope.thread AND g.at >= ?2
    WHERE g.deleted = 0 AND g.counted = 1 AND g.author_key IS NOT NULL GROUP BY 1, 2, 3)`;

/**
 * The partners of customer `slug`, for its page: those that work for it, confirmed or likely
 * (src/orgpartners.js `partnersOf`, with what links them and since when), then its former ones
 * (`until`), and those whose people posted in its
 * threads of the weeks (from `UNLINKED_MIN` threads or people on), each with how many of its
 * threads (`threads`) and how many of its people (`people`) that is. `authors` and `threadsBy` are
 * `orgNumbers`' rows of who posted, `partnerFor` the partner of a mail domain.
 */
async function partnersHere(env, slug, authors, threadsBy, partnerFor) {
  const linked = await partnersOf(env, slug);
  const orgOfKey = new Map();
  const people = new Map();
  for (const r of authors.filter((x) => !x.staff)) {
    const p = partnerFor(r.domain);
    if (p && p.org) {
      orgOfKey.set(r.key, p.org);
      people.set(p.org, (people.get(p.org) || new Set()).add(r.person ? `p:${r.person}` : r.mail || r.key));
    }
  }
  const threads = new Map();
  for (const r of threadsBy) {
    const o = orgOfKey.get(r.key);
    if (o) {
      threads.set(o, (threads.get(o) || new Set()).add(r.thread));
    }
  }
  const linkOf = new Map(linked.map((x) => [x.slug, x]));
  const others = [...people.keys()].filter((o) => !linkOf.has(o)
    && ((threads.get(o) || new Set()).size >= UNLINKED_MIN || people.get(o).size >= UNLINKED_MIN));
  const { results: rows } = others.length ? await env.DB.prepare(`SELECT slug, name, type, icon
    FROM orgs WHERE slug IN (SELECT value FROM json_each(?)) AND slug NOT IN (SELECT slug FROM org_merges)`)
    .bind(JSON.stringify(others)).all() : { results: [] };
  const orgOf = new Map((rows || []).map((o) => [o.slug, o]));
  return [...linked, ...others.filter((o) => orgOf.has(o)).map((o) => ({
    slug: o,
    name: orgOf.get(o).name || null,
    type: orgOf.get(o).type || PARTNER,
    icon: orgOf.get(o).icon || null,
    confirmed: false,
    p: null,
    score: 0,
    signals: {},
  }))].map((x) => ({
    slug: x.slug,
    name: x.name,
    type: x.type,
    icon: x.icon,
    linked: linkOf.has(x.slug),
    confirmed: x.confirmed,
    // Since when it works for them, and a former partner's end (src/orgpartners.js `linked`).
    since: x.since || null,
    until: x.until || null,
    p: x.p,
    signals: x.signals,
    threads: (threads.get(x.slug) || new Set()).size,
    people: (people.get(x.slug) || new Set()).size,
  })).sort((a, b) => Number(Boolean(a.until)) - Number(Boolean(b.until))
    || Number(b.confirmed) - Number(a.confirmed)
    || Number(b.linked) - Number(a.linked) || b.threads - a.threads || (b.p ?? 0) - (a.p ?? 0)
    || a.slug.localeCompare(b.slug));
}

/** A partner's numbers for its page (src/partners.js), handed the customers it works for. */
async function partnerHere(env, slug, weeks) {
  return partnerNumbers(env, slug, weeks, { customers: await customersOf(env, slug) });
}

/** The middle of `values` (a sorted copy), or null for none. */
export function median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) {
    return null;
  }
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * The Contact of a person among a knowledge base's `contacts` (`[{ path, title, aliases }]`, as
 * kb_concepts has them): the one whose file name, title or aliases are their name, as
 * src/kbpeople.js finds one by name: `{ path, description }` (their profile there, as a team's
 * members have theirs, src/teamprofile.js), or null.
 */
export function contactOf(contacts, name) {
  const want = personSlug(name);
  if (!want) {
    return null;
  }
  const hit = contacts.find((c) => [
    c.path.split('/').pop().replace(/\.md$/, ''), c.title,
    ...String(c.aliases || '').split(','),
  ].some((x) => x && personSlug(x) === want));
  return hit ? { path: hit.path, description: hit.description || null } : null;
}

/**
 * A stacked breakdown of `rows` (`{ week, n, part }`, `part` null for none) by week: its biggest
 * parts (`fixed` ones in that order instead, every one of them), each `{ id, name, weekly, n }`
 * with `nameOf(id)` its name, and the rest as one part `rest` (id null), where there is any.
 */
export function stacked(rows, weeks, nameOf, { fixed = null, rest = 'Other', most = MAX_PARTS } = {}) {
  const at = new Map(weeks.map((w, i) => [w, i]));
  const by = new Map();
  for (const r of rows) {
    const i = at.get(r.week);
    if (i !== undefined) {
      const k = r.part ?? null;
      if (!by.has(k)) {
        by.set(k, { weekly: zeros(weeks.length), n: 0 });
      }
      by.get(k).weekly[i] += r.n;
      by.get(k).n += r.n;
    }
  }
  const ranked = fixed ? fixed.filter((k) => by.has(k))
    : [...by.keys()].filter((k) => k !== null).sort((a, b) => by.get(b).n - by.get(a).n
      || String(a).localeCompare(String(b)));
  // One more part than `most` is shown as it is, not as the rest.
  const shown = fixed || ranked.length <= most + 1 ? ranked : ranked.slice(0, most);
  const parts = shown.map((k) => ({
    id: k, name: nameOf(k) || String(k), weekly: by.get(k).weekly, n: by.get(k).n,
  }));
  const left = [...by.keys()].filter((k) => !shown.includes(k));
  if (left.length) {
    const weekly = zeros(weeks.length);
    let n = 0;
    for (const k of left) {
      by.get(k).weekly.forEach((v, i) => {
        weekly[i] += v;
      });
      n += by.get(k).n;
    }
    parts.push({
      id: null, name: rest, weekly, n,
    });
  }
  return parts;
}

/** The overview of org `slug`, as everyone sees it (`viewer` adds the rest): null for none. */
export async function orgNumbers(env, slug, { now = new Date() } = {}) {
  const weeks = weeksTo(now, WEEKS);
  const since = `${weeks[0]}T00:00:00.000Z`;
  const db = env.DB;
  const q = (sql, ...args) => db.prepare(sql).bind(slug, since, ...args).all()
    .then((r) => r.results || []);
  const all = (sql, ...args) => db.prepare(sql).bind(...args).all().then((r) => r.results || []);
  const [row, merged, any] = await Promise.all([
    db.prepare('SELECT slug, name, type, icon FROM orgs WHERE slug = ?').bind(slug).first(),
    db.prepare('SELECT into_slug FROM org_merges WHERE slug = ?').bind(slug).first(),
    db.prepare(`SELECT (SELECT COUNT(*) FROM threads WHERE org = ?1) AS threads,
        (SELECT COUNT(*) FROM knowledge_bases WHERE kind = 'org' AND slug = ?1) AS kb`).bind(slug).first(),
  ]);
  if (merged) {
    return { mergedInto: merged.into_slug };
  }
  if (!row && !(any && (any.threads || any.kb))) {
    return null;
  }
  const [threadWeeks, threadTech, threadAreas, authors, tags, firsts, channelRows, shares, follows,
    concepts, base, stackRow, partners, domains, threadsBy, links] = await Promise.all([
    // Its threads, week by week: what was said in each, how much of it by Adobe; the chart, the
    // channels, the areas and the technologies are counted from these (a thread by its rowid).
    q(`WITH ${SCOPE} SELECT h.rowid AS id, h.team, h.source || ':' || h.tenant || ':' || h.channel_id AS channel,
        ${WEEK('g.at')} AS week, COUNT(*) AS n, SUM(g.staff) AS staff, MAX(g.at) AS last
      FROM scope JOIN threads h ON h.thread = scope.thread
        JOIN messages g ON g.thread = scope.thread AND g.at >= ?2
      WHERE g.deleted = 0 AND g.counted = 1 GROUP BY 1, 4`),
    q(`WITH ${SCOPE} SELECT h.rowid AS id, x.tech, x.p FROM scope
        JOIN threads h ON h.thread = scope.thread JOIN thread_tech x ON x.thread = scope.thread`),
    q(`WITH ${SCOPE} SELECT h.rowid AS id, a.area, a.p FROM scope
        JOIN threads h ON h.thread = scope.thread JOIN thread_areas a ON a.thread = scope.thread`),
    // Everyone who posted, by account: the mail domain only to tell a partner's people (it stays
    // here), the person to count someone's accounts as one.
    q(`WITH ${SCOPE}, ${AUTHORS}
      SELECT a.key, a.staff, a.week, a.n, a.threads, a.last, i.person, i.kind,
        COALESCE(i.display_name, i.name) AS name,
        LOWER(COALESCE(p.email, i.email)) AS mail,
        LOWER(SUBSTR(COALESCE(p.email, i.email), INSTR(COALESCE(p.email, i.email), '@') + 1)) AS domain
      FROM a LEFT JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +a.key
        LEFT JOIN people p ON p.id = i.person`),
    // What the customer's people ask about: the areas and technologies of their threads.
    q(`WITH ${SCOPE}, mine AS (SELECT g.author_key AS key, g.thread, COUNT(*) AS n
        FROM scope JOIN messages g ON g.thread = scope.thread AND g.at >= ?2
        WHERE g.staff = 0 AND g.deleted = 0 AND g.counted = 1 AND g.author_key IS NOT NULL GROUP BY 1, 2)
      SELECT key, 'all' AS kind, NULL AS what, SUM(n) AS n, COUNT(*) AS threads FROM mine GROUP BY key
      UNION ALL SELECT mine.key, 'area', a.area, SUM(mine.n), COUNT(*) FROM mine
        JOIN thread_areas a ON a.thread = mine.thread GROUP BY 1, 3
      UNION ALL SELECT mine.key, 'tech', x.tech, SUM(mine.n), COUNT(*) FROM mine
        JOIN thread_tech x ON x.thread = mine.thread GROUP BY 1, 3`),
    // The threads started in the window, and the other side's first post after the first one:
    // Adobe's in those its people started, theirs in those Adobe started (a vendor's answer).
    q(`WITH ${SCOPE}, f AS (SELECT scope.thread,
          (SELECT m.staff FROM messages m WHERE m.thread = scope.thread AND m.counted = 1
            AND m.deleted = 0 ORDER BY m.at LIMIT 1) AS staff,
          (SELECT MIN(m.at) FROM messages m WHERE m.thread = scope.thread AND m.counted = 1
            AND m.deleted = 0) AS first
        FROM scope JOIN threads h ON h.thread = scope.thread WHERE h.root_at >= ?2)
      SELECT f.first, f.staff, (SELECT MIN(m.at) FROM messages m WHERE m.thread = f.thread
          AND m.staff = 1 - f.staff AND m.counted = 1 AND m.deleted = 0 AND m.at > f.first)
          AS answered
      FROM f WHERE f.staff IS NOT NULL`),
    // Its channels, whichever team they are filed under (a re-filing not done yet: both).
    all(`SELECT h.source, h.tenant, h.channel_id, h.source || ':' || h.tenant || ':' || h.channel_id AS channel,
        h.team, COALESCE(c.name, MAX(h.channel_name)) AS name, c.archived_at, COUNT(*) AS threads,
        MAX(h.last_at) AS last
      FROM threads h LEFT JOIN channels c ON c.source = h.source AND c.tenant = h.tenant
        AND c.channel_id = h.channel_id
      WHERE h.org = ? AND h.kind = 'channel' GROUP BY 1, 2, 3, 5`, slug),
    all(`SELECT DISTINCT s.team, s.source, s.channel_id FROM channel_teams s
      JOIN threads h ON h.source = s.source AND h.channel_id = s.channel_id
      WHERE h.org = ? AND h.kind = 'channel'`, slug),
    // The teams that follow it (a follow rule, src/rules.js `followedOrg`).
    all(`SELECT DISTINCT value AS team FROM rules WHERE target = 'follow' AND field = 'org'
      AND pattern = ?`, `^${slug}$`),
    all(`SELECT type, path, title, description, aliases FROM kb_concepts WHERE repo = ?
      ORDER BY title`, `kb-org-${slug}`),
    db.prepare('SELECT repo, entries FROM knowledge_bases WHERE kind = \'org\' AND slug = ?')
      .bind(slug).first(),
    db.prepare('SELECT parts FROM org_stacks WHERE org = ?').bind(slug).first(),
    partnerDomains(env),
    mailDomains(env, slug),
    // The threads each of its people's accounts posted in, to count a person's threads once.
    q(`WITH ${SCOPE} SELECT DISTINCT g.author_key AS key, g.thread
      FROM scope JOIN messages g ON g.thread = scope.thread AND g.at >= ?2
      WHERE g.staff = 0 AND g.deleted = 0 AND g.counted = 1 AND g.author_key IS NOT NULL`),
    sameLinks(env),
  ]);
  const at = new Map(weeks.map((w, i) => [w, i]));

  // Everything said in its threads, week by week: by Adobe's people, and in how many.
  const activity = {
    messages: zeros(weeks.length), staff: zeros(weeks.length), threads: zeros(weeks.length),
  };
  const weeksOf = new Map();
  for (const r of threadWeeks) {
    const i = at.get(r.week);
    if (i !== undefined) {
      activity.messages[i] += r.n;
      activity.staff[i] += r.staff || 0;
      activity.threads[i] += 1;
    }
    weeksOf.set(r.id, [...(weeksOf.get(r.id) || []), r]);
  }
  /** What was said in the threads `ids`, week by week. */
  const weeklyOf = (ids) => {
    const out = zeros(weeks.length);
    for (const id of ids) {
      for (const r of weeksOf.get(id) || []) {
        if (at.has(r.week)) {
          out[at.get(r.week)] += r.n;
        }
      }
    }
    return out;
  };

  // Who posted: a person's accounts count as one, and so do the accounts of one mail address
  // without a person (a customer's, as a guest and again from their own workspace) and those the
  // admin team said are one person (src/accountpairs.js), as the first of them; any other account
  // as its own; no workflow or bot account.
  const sameAs = sameAccounts(authors.filter((r) => !r.person), links);
  const whoOf = (r) => (r.person ? `p:${r.person}` : `a:${sameAs(r.key)}`);
  const people = (staff) => byWeek(
    authors.filter((r) => Boolean(r.staff) === staff && (r.kind || 'person') === 'person')
      .map((r) => ({ ...r, who: whoOf(r) })),
    'who',
    weeks,
    (r, e) => {
      e.person = r.person ?? null;
      e.name = (`a:${r.key}` === r.who && r.name) || e.name || r.name || null;
      e.threads = (e.threads || 0) + r.threads;
      e.keys = (e.keys || new Set()).add(r.key);
      e.domain = e.domain || r.domain || null;
    },
  );
  const rank = (m) => [...m].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  const theirs = rank(people(false));
  const ours = rank(people(true));
  const topTheirs = theirs.slice(0, MAX_PEOPLE);
  const topOurs = ours.slice(0, MAX_STAFF);
  const ids = [...new Set([...topTheirs, ...ours].map(([, e]) => e.person).filter(Boolean))];
  const [whoRows, memberRows] = ids.length ? await Promise.all([
    all(`SELECT p.id, ${NAME('p.id')} AS name, ${AVATAR('p.id')} AS avatar, ${TITLE('p.id')} AS title
      FROM people p WHERE p.id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)),
    all(`SELECT m.person, t.slug, t.name FROM team_members m JOIN teams t ON t.slug = m.team
      WHERE m.person IN (SELECT value FROM json_each(?)) ORDER BY t.name`, JSON.stringify(ids)),
  ]) : [[], []];
  const who = new Map(whoRows.map((r) => [r.id, r]));
  const teamsOf = new Map();
  for (const r of memberRows) {
    teamsOf.set(r.person, [...(teamsOf.get(r.person) || []), { slug: r.slug, name: r.name }]);
  }

  // What sets each of its people apart, among its people: by `who`, as a team's members.
  const keyWho = new Map();
  for (const [w, e] of theirs) {
    for (const k of e.keys) {
      keyWho.set(k, w);
    }
  }
  const threadsOf = new Map();
  for (const r of threadsBy.filter((x) => keyWho.has(x.key))) {
    const w = keyWho.get(r.key);
    threadsOf.set(w, (threadsOf.get(w) || new Set()).add(r.thread));
  }
  const merge = (kind) => {
    const by = new Map();
    for (const t of tags.filter((x) => x.kind === kind && keyWho.has(x.key))) {
      const k = `${keyWho.get(t.key)}\u0000${t.what}`;
      const was = by.get(k) || {
        person: keyWho.get(t.key), what: t.what, n: 0, threads: 0,
      };
      was.n += t.n;
      was.threads += t.threads;
      by.set(k, was);
    }
    return [...by.values()];
  };
  const totals = new Map();
  for (const t of merge('all')) {
    totals.set(t.person, t.n);
  }
  const areasOf = distinctive(merge('area'), totals);
  const techOf = distinctive(merge('tech'), totals);

  // Each thread's likeliest area and technology, which the chart's breakdowns file it under.
  const firstOf = (rows, key) => {
    const out = new Map();
    for (const r of rows) {
      const was = out.get(r.id);
      if (!was || r.p > was.p || (r.p === was.p && String(r[key]) < String(was[key]))) {
        out.set(r.id, r);
      }
    }
    return new Map([...out].map(([id, r]) => [id, r[key]]));
  };
  const areaFirst = firstOf(threadAreas, 'area');
  const techFirst = firstOf(threadTech, 'tech');

  // The areas of its threads, and of its people's: their names, the admin team's words first.
  const areaThreads = new Map();
  for (const { id, area } of threadAreas) {
    areaThreads.set(area, [...(areaThreads.get(area) || []), id]);
  }
  const topAreas = [...areaThreads].sort((a, b) => b[1].length - a[1].length
    || a[0].localeCompare(b[0])).slice(0, MAX_AREAS);
  const areaIds = [...new Set([...topAreas.map(([id]) => id), ...areaFirst.values(),
    ...[...areasOf.values()].flat().map((a) => a.id)])];
  const areaRows = areaIds.length ? await all(`SELECT id, name FROM areas
      WHERE id IN (SELECT value FROM json_each(?)) ORDER BY team = ? DESC`, JSON.stringify(areaIds), ADMIN_TEAM) : [];
  const areaName = new Map();
  for (const a of areaRows) {
    if (!areaName.has(a.id)) {
      areaName.set(a.id, a.name);
    }
  }

  // The technologies: those Clef sees in its threads, and the parts of its stack drawing.
  let parts = [];
  try {
    parts = stackRow ? JSON.parse(stackRow.parts) : [];
  } catch {
    parts = [];
  }
  parts = Array.isArray(parts) ? parts : [];
  const techThreads = new Map();
  for (const { id, tech } of threadTech) {
    techThreads.set(tech, [...(techThreads.get(tech) || []), id]);
  }
  const drawn = new Map(parts.filter((p) => p.tech).map((p) => [p.tech, p]));
  const seenTop = [...techThreads].filter(([id]) => !drawn.has(id))
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_SEEN).map(([id]) => id);
  const wantedTech = [...new Set([...drawn.keys(), ...seenTop, ...techFirst.values(),
    ...[...techOf.values()].flat().map((t) => t.id)])];
  const nameRows = wantedTech.length ? await all(`SELECT team, tech, name, vendor, product, kind, layer,
      path FROM tech_stack WHERE tech IN (SELECT value FROM json_each(?))`, JSON.stringify(wantedTech)) : [];
  const names = techNames(nameRows, ADMIN_TEAM);
  const techRow = (id, part = null) => {
    const n = names.get(id);
    const list = techThreads.get(id) || [];
    return {
      tech: id,
      name: (n && n.name) || (part && part.name) || id,
      vendor: (n && n.vendor) || null,
      kind: (n && n.kind) || null,
      layer: (part && part.layer) || (n && n.layer) || null,
      stack: Boolean(part),
      threads: list.length,
      weekly: weeklyOf(list),
    };
  };
  const tech = [
    ...[...drawn.values()].map((p) => techRow(p.tech, p)),
    // The parts of its drawing Clef has no technology for, by their names.
    ...parts.filter((p) => !p.tech && p.name).map((p) => ({
      ...techRow(`stack:${p.name}`, p), tech: null,
    })),
    ...seenTop.map((id) => techRow(id)),
  ].sort((a, b) => b.threads - a.threads || a.name.localeCompare(b.name));

  // Its channels: what was said in each, the teams they are filed under and shared with.
  const chanIds = new Map();
  for (const r of threadWeeks) {
    chanIds.set(r.channel, (chanIds.get(r.channel) || new Set()).add(r.id));
  }
  const sharedBy = new Map();
  for (const s of shares) {
    const k = `${s.source}:${s.channel_id}`;
    sharedBy.set(k, [...(sharedBy.get(k) || []), s.team]);
  }
  // A channel being re-filed is under the team with the most of its threads.
  const channelsBy = new Map();
  for (const c of [...channelRows].sort((a, b) => b.threads - a.threads)) {
    const was = channelsBy.get(c.channel);
    if (was) {
      was.last = [was.last, c.last].filter(Boolean).sort().pop() || null;
    } else {
      channelsBy.set(c.channel, { ...c });
    }
  }
  const channelsAll = [...channelsBy.values()].map((c) => {
    const list = [...(chanIds.get(c.channel) || [])];
    const weekly = weeklyOf(list);
    return {
      source: c.source,
      name: c.name || null,
      team: c.team,
      shared: (sharedBy.get(`${c.source}:${c.channel_id}`) || []).filter((t) => t !== c.team),
      archived: Boolean(c.archived_at),
      threads: list.length,
      messages: weekly.reduce((s, v) => s + v, 0),
      weekly,
      last: c.last,
    };
  }).sort((a, b) => b.messages - a.messages || String(b.last || '').localeCompare(String(a.last || '')));

  // The teams that work it: whose people post in its threads, the teams its channels are filed
  // under or shared with, and those that follow it.
  const teamsBy = new Map();
  const teamOf = (slugOf) => {
    if (!teamsBy.has(slugOf)) {
      teamsBy.set(slugOf, {
        slug: slugOf,
        messages: 0,
        weekly: zeros(weeks.length),
        people: new Set(),
        filed: 0,
        shared: 0,
        follows: false,
      });
    }
    return teamsBy.get(slugOf);
  };
  for (const [, e] of ours) {
    for (const t of (e.person && teamsOf.get(e.person)) || []) {
      const x = teamOf(t.slug);
      x.messages += e.n;
      e.weekly.forEach((v, i) => {
        x.weekly[i] += v;
      });
      x.people.add(e.person);
    }
  }
  for (const c of channelsAll) {
    if (c.team && c.team !== UNASSIGNED) {
      teamOf(c.team).filed += 1;
    }
    for (const t of c.shared) {
      teamOf(t).shared += 1;
    }
  }
  for (const f of follows) {
    teamOf(f.team).follows = true;
  }
  const teamSlugs = [...teamsBy.keys()];
  const teamRows = teamSlugs.length ? await all(`SELECT slug, name FROM teams
      WHERE slug IN (SELECT value FROM json_each(?))`, JSON.stringify(teamSlugs)) : [];
  const teamName = new Map(teamRows.map((t) => [t.slug, t.name]));
  const teams = [...teamsBy.values()].filter((t) => teamName.has(t.slug))
    .map((t) => ({
      slug: t.slug,
      name: teamName.get(t.slug),
      messages: t.messages,
      people: t.people.size,
      weekly: t.weekly,
      filed: t.filed,
      shared: t.shared,
      follows: t.follows,
    }))
    .sort((a, b) => b.messages - a.messages || b.filed - a.filed || a.name.localeCompare(b.name));

  // Its people, a card each: their Contact in its knowledge base, where it has one.
  const contacts = concepts.filter((c) => String(c.type || '').toLowerCase() === 'contact');
  // A partner's own people are its, not a partner's: on its page they are "their people".
  const partnerFor = (domain) => {
    const x = partnerOf(domain, partners);
    return x && x.org !== slug ? x : null;
  };
  const personOut = ([w, e]) => {
    const p = e.person ? who.get(e.person) : null;
    const name = (p && p.name) || e.name || null;
    const partner = partnerFor(e.domain);
    return {
      id: e.person,
      // Without a person of D1, the account they are known by (an identity key), to follow.
      account: !e.person && w.startsWith('a:') ? w.slice(2) : null,
      name,
      avatar: (p && p.avatar) || null,
      title: (p && p.title) || null,
      partner: partner ? partner.name : null,
      messages: e.n,
      threads: (threadsOf.get(w) || new Set()).size,
      weekly: e.weekly,
      last: e.last,
      areas: (areasOf.get(w) || [])
        .map((x) => ({ ...x, name: areaName.get(x.id) || x.id })),
      tech: (techOf.get(w) || [])
        .map((x) => ({ ...x, name: names.get(x.id)?.name || x.id })),
      // Their profile in its knowledge base: their Contact there (ui/person.js draws it).
      profile: name ? contactOf(contacts, name) : null,
    };
  };
  const staffOut = ([, e]) => {
    const p = e.person ? who.get(e.person) : null;
    return {
      id: e.person,
      name: (p && p.name) || e.name || null,
      avatar: (p && p.avatar) || null,
      title: (p && p.title) || null,
      teams: (e.person && teamsOf.get(e.person)) || [],
      messages: e.n,
      // Threads a week, added up.
      active: e.threads,
      weekly: e.weekly,
      last: e.last,
    };
  };

  // The chart's breakdowns: what was said in its threads week by week, by who said it, by whom
  // of its people, by the team a thread is filed under, by its likeliest area, technology, and
  // by its channel. A thread is in one part of each.
  const breakdown = (rows, partOf, nameOf, { fixed = null, rest = 'Other' } = {}) => stacked(
    rows.map((r) => ({ week: r.week, n: r.n, part: partOf(r) })),
    weeks,
    nameOf,
    { fixed, rest },
  );
  const partnerKey = (r) => (partnerFor(r.domain) ? 'partners' : 'theirs');
  const posters = authors.filter((r) => (r.kind || 'person') === 'person');
  const nameOfPerson = new Map(theirs.map(([w, e]) => [w, (e.person && who.get(e.person)?.name)
    || e.name || 'Someone']));
  const breakdowns = {
    who: breakdown(posters, (r) => (r.staff ? 'adobe' : partnerKey(r)), (k) => ({
      adobe: 'Adobe', theirs: 'Their people', partners: 'Partners',
    }[k]), { fixed: ['theirs', 'partners', 'adobe'] }),
    people: breakdown(
      posters.filter((r) => !r.staff),
      whoOf,
      (k) => nameOfPerson.get(k),
      { rest: 'Everyone else' },
    ),
    teams: breakdown(threadWeeks, (r) => r.team, (k) => teamName.get(k) || k),
    areas: breakdown(
      threadWeeks,
      (r) => areaFirst.get(r.id) ?? null,
      (k) => areaName.get(k) || k,
      { rest: 'Other or none' },
    ),
    tech: breakdown(
      threadWeeks,
      (r) => techFirst.get(r.id) ?? null,
      (k) => names.get(k)?.name || k,
      { rest: 'Other or none' },
    ),
    channels: breakdown(threadWeeks, (r) => r.channel, (k) => {
      const c = channelsBy.get(k);
      return c && c.name ? `#${c.name}` : 'A channel';
    }),
  };

  // How soon Adobe answers what its people start: the wait for Adobe's first post, in minutes.
  // A vendor is the other way round: how soon it answers what Adobe starts.
  const orgType = (row && row.type) || 'customer';
  const vendor = orgType === VENDOR;
  const asked = firsts.filter((f) => Boolean(Number(f.staff)) === vendor);
  const waits = asked.filter((f) => f.answered)
    .map((f) => (Date.parse(f.answered) - Date.parse(f.first)) / 60000);

  // The knowledge base: its entries by type, the catalog and its people's Contacts apart.
  const types = new Map();
  for (const c of concepts) {
    if (c.type && !CATALOG_TYPES.has(c.type) && c.path !== STACK_PATH) {
      types.set(c.type, [...(types.get(c.type) || []), {
        path: c.path, title: c.title || c.path, description: c.description || null,
      }]);
    }
  }
  return {
    org: {
      slug,
      name: (row && row.name) || null,
      type: (row && row.type) || 'customer',
      icon: (row && row.icon) || null,
      // Its usual mail domain, whose favicon it is shown with when it has no icon.
      domain: (domains.get(slug) || [])[0] || null,
      channels: channelsAll.length,
    },
    weeks,
    layers: LAYERS.map(({ id, name }) => ({ id, name })),
    activity,
    breakdowns,
    threadCount: weeksOf.size,
    answers: {
      by: vendor ? 'them' : 'adobe',
      asked: asked.length,
      answered: waits.length,
      median: median(waits),
      // Every wait, in whole minutes, shortest first: the overview draws each one (ui/customer.js).
      waits: waits.map((m) => Math.max(0, Math.round(m))).sort((a, b) => a - b),
    },
    // A vendor's cases, status posts and the customers' threads of its products (src/vendors.js).
    ...(vendor ? { vendor: await vendorNumbers(env, slug, weeks) } : {}),
    // A partner's customers, people and what waits (src/partners.js), a customer's partners.
    ...(orgType === PARTNER ? { partner: await partnerHere(env, slug, weeks) } : {}),
    ...(orgType === 'customer' ? { partners: await partnersHere(env, slug, authors, threadsBy, partnerFor) } : {}),
    people: topTheirs.map(personOut),
    peopleCount: theirs.length,
    partnerCount: theirs.filter(([, e]) => partnerFor(e.domain)).length,
    staff: topOurs.map(staffOut),
    staffCount: ours.length,
    teams: teams.slice(0, MAX_TEAMS),
    teamCount: teams.length,
    areas: topAreas.map(([id, list]) => ({
      id, name: areaName.get(id) || id, threads: list.length, weekly: weeklyOf(list),
    })),
    channels: channelsAll.slice(0, MAX_CHANNELS),
    channelCount: channelsAll.length,
    tech,
    stack: parts.length > 0,
    kb: base ? {
      repo: base.repo,
      entries: base.entries ?? null,
      drawing: concepts.some((c) => c.path === STACK_PATH),
      types: [...types].map(([type, list]) => ({ type, n: list.length, entries: list }))
        .sort((a, b) => b.n - a.n || a.type.localeCompare(b.type)),
    } : null,
  };
}

/**
 * GET /api/customers/profile?org=: `orgNumbers`, kept a while, and what `me` may read: the
 * knowledge base's entries, its people's Contacts and the parts of its stack drawing are for
 * whoever may read its knowledge base (src/kbaccess.js); their numbers are everyone's.
 */
export async function orgProfile(env, me, slug, { now = new Date() } = {}) {
  const key = String(slug || '');
  if (!key || key === UNASSIGNED) {
    return { error: 'no such customer', status: 404 };
  }
  const db = underlying(env.DB);
  if (!cache.has(db)) {
    cache.set(db, new Map());
  }
  const kept = cache.get(db);
  const hit = kept.get(key);
  const fresh = hit && now.getTime() - hit.at < CACHE_MS && hit.seen >= (forgotten.get(key) ?? 0);
  let numbers = fresh ? hit.numbers : null;
  if (!numbers) {
    const seen = forgets;
    numbers = await orgNumbers(env, key, { now });
    if (numbers) {
      kept.set(key, { at: now.getTime(), numbers, seen });
    }
  }
  if (!numbers) {
    return { error: 'no such customer', status: 404 };
  }
  if (numbers.mergedInto) {
    return { error: `${key} was merged into ${numbers.mergedInto}`, mergedInto: numbers.mergedInto, status: 404 };
  }
  const readable = await mayRead(env, me, { kind: 'org', slug: key });
  return {
    ...numbers,
    people: numbers.people.map((p) => ({
      ...p, profile: readable && numbers.kb ? p.profile : null,
    })),
    // What its stack drawing has is its knowledge base's: what Clef sees is everyone's.
    tech: readable ? numbers.tech : numbers.tech.filter((t) => t.tech && t.threads)
      .map((t) => ({ ...t, stack: false })),
    stack: readable && numbers.stack,
    kb: numbers.kb && {
      ...numbers.kb,
      readable,
      types: numbers.kb.types.map((t) => ({
        type: t.type, n: t.n, entries: readable ? t.entries.slice(0, MAX_ENTRIES) : [],
      })),
      drawing: readable && numbers.kb.drawing,
    },
    ...(numbers.vendor ? { vendor: vendorForViewer(me, numbers.vendor) } : {}),
    ...(numbers.partner ? { partner: partnerForViewer(me, numbers.partner) } : {}),
    may: { read: readable },
  };
}

/**
 * GET /api/customers: every customer, partner and vendor that has a channel, a thread or a
 * knowledge base, `[{ slug, name, type, icon, channels, threads, latest }]`, by name: the list
 * beside the overviews for Adobe's people on no team (who do not get /api/admin/orgs).
 */
export async function orgDirectory(env) {
  const { results } = await env.DB.prepare(`SELECT s.slug, o.name, COALESCE(o.type, 'customer') AS type,
      o.icon,
      (SELECT COUNT(DISTINCT channel_id) FROM threads t WHERE t.org = s.slug AND t.kind = 'channel')
        AS channels,
      (SELECT COUNT(*) FROM threads t WHERE t.org = s.slug) AS threads,
      (SELECT COUNT(*) FROM threads t WHERE t.org = s.slug AND t.last_at >= ?2) AS recent,
      (SELECT MAX(COALESCE(last_at, any_at)) FROM threads t WHERE t.org = s.slug) AS latest
    FROM (SELECT slug FROM orgs UNION SELECT DISTINCT org FROM threads
      UNION SELECT slug FROM knowledge_bases WHERE kind = 'org') s
    LEFT JOIN orgs o ON o.slug = s.slug
    WHERE s.slug != ?1 AND s.slug NOT IN (SELECT slug FROM org_merges)
    ORDER BY COALESCE(o.name, s.slug)`).bind(UNASSIGNED, activeSince()).all();
  // Its usual mail domain, whose favicon it is shown with when it has no icon (as Customers').
  const domains = await mailDomains(env);
  return (results || []).map((o) => ({ ...o, domain: (domains.get(o.slug) || [])[0] || null }));
}

/**
 * Forgets the kept numbers of the orgs `slugs` in this isolate: a pair of a customer and a partner
 * was confirmed or dismissed (src/orgpartners.js `decidePartner`), so both pages say so at once
 * here; the other isolates' within CACHE_MS.
 */
export function forgetOrgProfiles(...slugs) {
  forgets += 1;
  for (const s of slugs.filter(Boolean)) {
    forgotten.set(String(s), forgets);
  }
}

/** Clears the kept numbers (tests). */
export function resetOrgProfiles() {
  cache = new WeakMap();
  forgotten = new Map();
}
