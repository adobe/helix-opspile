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

import {
  followable, MAX_FOLLOWS, personFollows, personFollowsBy,
} from './follows.js';
import { likePattern } from './like.js';
import { inPersonalView } from './shares.js';

/**
 * What to follow, suggested (GET /api/follows/suggest; docs/ARCHITECTURE.md, "Following"):
 * products (the tech stack's technologies), topics (areas) and customers, for anyone signed in,
 * on a team or not. Without a query, what the channels of their personal view were about lately
 * (MINE_DAYS), then what is trending everywhere (TREND_DAYS, against the TREND_DAYS before),
 * leaving out what they follow already; customers only from their own channels. With a query
 * (`q`), what matches it by name, followed or not.
 *
 * Only names and counts: no thread, channel or message of anyone else's is in the answer, and a
 * customer is suggested only from the channels the person is in. The trending counts are every
 * team's and the same for everyone, so an isolate keeps them TREND_TTL_MS.
 */

export const MINE_DAYS = 180;
export const TREND_DAYS = 30;
/** The suggestions of each kind, and the matches of a query. */
export const SUGGEST = { tech: 6, area: 6, org: 5 };
export const MATCHES = 12;
/** Trending, at least this many threads in the last TREND_DAYS. */
export const MIN_TRENDING = 2;
export const TREND_TTL_MS = 60 * 60 * 1000;
export const MAX_QUERY = 60;

const DAY = 24 * 60 * 60 * 1000;
const since = (now, days) => new Date(now - days * DAY).toISOString();
const ENTRY = 'COALESCE(t.logical_thread, t.thread)';

let trendCache = null;

/** Forgets the trending counts (tests). */
export function forgetTrends() {
  trendCache = null;
}

/**
 * Every technology's and area's conversations of the last TREND_DAYS (`recent`) and of the
 * TREND_DAYS before (`before`), by the entry's last activity: `{ tech: Map, area: Map }`.
 */
async function trending(env, now) {
  if (trendCache && trendCache.until > now) {
    return trendCache.value;
  }
  const from = since(now, 2 * TREND_DAYS);
  const split = since(now, TREND_DAYS);
  const count = (table, col) => env.DB.prepare(`SELECT g.${col} AS id,
      COUNT(DISTINCT CASE WHEN t.last_at >= ?2 THEN ${ENTRY} END) AS recent,
      COUNT(DISTINCT CASE WHEN t.last_at < ?2 THEN ${ENTRY} END) AS before
    FROM ${table} g JOIN threads t ON t.thread = g.thread
    WHERE t.kind = 'channel' AND t.last_at >= ?1 GROUP BY g.${col}`).bind(from, split).all();
  const [{ results: tech }, { results: area }] = await Promise.all([
    count('thread_tech', 'tech'), count('thread_areas', 'area'),
  ]);
  const byId = (rows) => new Map((rows || [])
    .map((r) => [r.id, { recent: r.recent, before: r.before }]));
  const value = { tech: byId(tech), area: byId(area) };
  trendCache = { until: now + TREND_TTL_MS, value };
  return value;
}

/**
 * What the channels of person `me`'s personal view were about in the last MINE_DAYS: the
 * conversations of each technology, area and customer, `{ tech: Map, area: Map, org: Map }`.
 */
async function mine(env, me, now) {
  const from = since(now, MINE_DAYS);
  const count = (join, col) => env.DB.prepare(`SELECT ${col} AS id, COUNT(DISTINCT ${ENTRY}) AS n
    FROM threads t ${join}
    WHERE t.kind = 'channel' AND t.last_at >= ?2 AND ${inPersonalView('t', '?1')}
      ${join ? '' : "AND t.org IS NOT NULL AND t.org NOT LIKE '\\_%' ESCAPE '\\'"}
    GROUP BY ${col}`).bind(me.id, from).all();
  const [{ results: tech }, { results: area }, { results: org }] = await Promise.all([
    count('JOIN thread_tech g ON g.thread = t.thread', 'g.tech'),
    count('JOIN thread_areas g ON g.thread = t.thread', 'g.area'),
    count('', 't.org'),
  ]);
  const byId = (rows) => new Map((rows || []).map((r) => [r.id, r.n]));
  return { tech: byId(tech), area: byId(area), org: byId(org) };
}

/** The areas one may follow (enabled in a team's catalog), with their names: `[{ id, name }]`. */
async function areas(env) {
  const { results } = await env.DB.prepare(`SELECT id, name, enabled FROM areas
    ORDER BY team = 'admin' DESC, team`).all();
  const by = new Map();
  const on = new Set();
  for (const r of results || []) {
    if (!by.has(r.id)) {
      by.set(r.id, { id: r.id, name: r.name || r.id });
    }
    if (r.enabled) {
      on.add(r.id);
    }
  }
  return [...by.values()].filter((a) => on.has(a.id));
}

/** The names of the teams that follow each technology: `Map<tech, [name]>`. */
async function teamsByTech(env) {
  const { results } = await env.DB.prepare(`SELECT f.tech, COALESCE(t.name, f.team) AS name
    FROM team_follows f LEFT JOIN teams t ON t.slug = f.team ORDER BY name`).all();
  const out = new Map();
  for (const r of results || []) {
    out.set(r.tech, [...(out.get(r.tech) || []), r.name]);
  }
  return out;
}

/** The names of the teams that follow each area (migration 0103): `Map<area, [name]>`. */
async function teamsByArea(env) {
  const { results } = await env.DB.prepare(`SELECT f.target AS area, COALESCE(t.name, f.team) AS name
    FROM team_follows_by f LEFT JOIN teams t ON t.slug = f.team WHERE f.kind = 'area'
    ORDER BY name`).all();
  const out = new Map();
  for (const r of results || []) {
    out.set(r.area, [...(out.get(r.area) || []), r.name]);
  }
  return out;
}

/** Customers by slug: `Map<slug, { name, icon }>`, for those the admin pages named. */
async function orgNames(env, slugs) {
  if (!slugs.length) {
    return new Map();
  }
  const { results } = await env.DB.prepare(`SELECT slug, name, icon FROM orgs
    WHERE slug IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(slugs)).all();
  return new Map((results || []).map((o) => [o.slug, o]));
}

/**
 * The customers whose name or slug has `q`: those the admin pages named, and the slugs of
 * conversations (by the `threads_org` index, from the start of the slug). At most MATCHES.
 */
async function orgsMatching(env, q) {
  const low = q.toLowerCase();
  const [{ results: named }, { results: slugs }] = await Promise.all([
    env.DB.prepare(`SELECT slug FROM orgs WHERE (name LIKE ?1 ESCAPE '\\' OR slug LIKE ?1 ESCAPE '\\')
      AND slug NOT LIKE '\\_%' ESCAPE '\\' AND COALESCE(type, 'customer') != 'internal'
      ORDER BY name LIMIT ?2`).bind(likePattern(q), MATCHES).all(),
    env.DB.prepare(`SELECT DISTINCT org AS slug FROM threads WHERE org >= ?1 AND org < ?2
      AND kind = 'channel' LIMIT ?3`).bind(low, `${low}\uffff`, MATCHES).all(),
  ]);
  return [...new Set([...(named || []), ...(slugs || [])].map((r) => r.slug))]
    .filter((s) => s && !s.startsWith('_')).slice(0, MATCHES);
}

/** A customer as the suggestions show it: `{ id, name, icon }`. */
const orgOf = (names, slug) => ({
  id: slug,
  name: (names.get(slug) && names.get(slug).name) || slug,
  icon: (names.get(slug) && names.get(slug).icon) || null,
});

/** Whether `text` has every word of `q` in it, as a person searching would mean it. */
const matches = (q) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return (...texts) => {
    const hay = texts.filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  };
};

/**
 * The suggestions, or the matches of `query`, from what was asked for (`suggestFollows`), without
 * D1, so that `npm run ui:dev` makes them from its fake data the same way. `techs` as `followable`
 * answers, `areaList` `[{ id, name }]`, `teams` the names of the teams that follow each
 * technology (`areaTeams`, each area), `trend` and `own` the counts (`{ tech, area }` and
 * `{ tech, area, org }` of Maps), `followed` and `followedBy` what the person follows, `orgs` the
 * customers' slugs (theirs, or those the query found) and `names` what the admin pages call them.
 */
export function suggestionsOf({
  query = '', techs, areaList, teams, areaTeams = new Map(), trend, own, followed, followedBy, orgs,
  names,
}) {
  const counts = (kind, id) => {
    const t = trend[kind].get(id);
    return { mine: own[kind].get(id) || 0, recent: t ? t.recent : 0, before: t ? t.before : 0 };
  };
  const tech = techs.map((t) => ({
    id: t.tech, name: t.name, product: t.product, ...counts('tech', t.tech), teams: teams.get(t.tech) || [],
  }));
  const area = areaList.map((a) => ({
    id: a.id, name: a.name, ...counts('area', a.id), teams: areaTeams.get(a.id) || [],
  }));
  const org = orgs.map((s) => ({ ...orgOf(names, s), mine: own.org.get(s) || 0 }));
  // Theirs first, then what is talked about most.
  const order = (a, b) => b.mine - a.mine || (b.recent || 0) - (a.recent || 0)
    || a.name.localeCompare(b.name);
  const done = { max: MAX_FOLLOWS, days: TREND_DAYS };
  if (query) {
    const has = matches(query);
    return {
      q: query,
      tech: tech.filter((t) => has(t.name, t.product, t.id)).sort(order).slice(0, MATCHES),
      area: area.filter((a) => has(a.name, a.id)).sort(order).slice(0, MATCHES),
      org: org.sort(order).slice(0, MATCHES),
      ...done,
    };
  }
  const suggested = (list, kind) => {
    const already = new Set((kind === 'tech' ? followed : followedBy[kind] || []).map(String));
    return list.filter((x) => !already.has(String(x.id)))
      .filter((x) => x.mine > 0 || (x.recent || 0) >= MIN_TRENDING)
      .sort(order).slice(0, SUGGEST[kind]);
  };
  return {
    q: null, tech: suggested(tech, 'tech'), area: suggested(area, 'area'), org: suggested(org, 'org'), ...done,
  };
}

/** The search's query: whitespace collapsed, at most MAX_QUERY characters. */
export const cleanQuery = (q) => String(q || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);

/**
 * Suggestions for `me` (`{ id }`), or the matches of query `q`: `{ q, tech, area, org }`, each a
 * list of `{ id, name, mine, recent, before }` (a technology or an area with the `teams` that
 * follow it, a technology with its `product`, a customer with its `icon`). `mine` counts the
 * conversations of their own channels, `recent` and `before` every team's (none for customers).
 */
export async function suggestFollows(env, me, { q = '', now = Date.now() } = {}) {
  const query = cleanQuery(q);
  const [
    techs, areaList, teams, areaTeams, trend, own, followed, followedBy, found,
  ] = await Promise.all([
    followable(env), areas(env), teamsByTech(env), teamsByArea(env), trending(env, now),
    mine(env, me, now), personFollows(env, me.id), personFollowsBy(env, me.id),
    query ? orgsMatching(env, query) : null,
  ]);
  const orgs = found || [...own.org.keys()];
  const names = await orgNames(env, orgs);
  return suggestionsOf({
    query, techs, areaList, teams, areaTeams, trend, own, followed, followedBy, orgs, names,
  });
}
