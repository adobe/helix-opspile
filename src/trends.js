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

import { topicList } from './label.js';
import { likePattern } from './like.js';
import { EMBEDDING_MODEL } from './rethread.js';
import { QUERY_PREFIX } from './expertise.js';
import { threadVectorId } from './vectors.js';
import { kmeans, nameTopics, random } from './topicmap.js';

/**
 * Trends, the Topics page's other view (docs/ARCHITECTURE.md, "Trends"): how much each topic,
 * area, technology, word or phrase is talked about, week by week, as Google Trends shows a
 * search term. The page does the counting (ui/trends.js); this is what it counts from.
 *
 * - A **trend map**: topics found over the channel threads of the last WEEKS weeks, not only the
 *   recent ones a topic map clusters (src/topicmap.js), or every old thread would be in a topic
 *   of now and every topic would look new. A sample of every month's threads, the same number of
 *   each (SAMPLE), is clustered with the topic map's k-means and named by its namer; the means
 *   are kept (`trend_maps`), and kept for STALE_DAYS, so a topic's line means the same throughout.
 * - Each thread's **topic**: the nearest centre, in the centred space the map was found in
 *   (`trend_threads`). The build assigns the threads it sampled; the cron, ASSIGN_BATCH a run,
 *   every other one, and those whose vector changed since.
 * - The **threads** (GET /api/topics/trends): a re-threaded group as its first thread, with the
 *   messages of all of its members; only those Clef labelled, not meetings or people's comings
 *   and goings, and no internal org's. Each with its channel, customer, team, platform, kind,
 *   topic, Clef's areas and technologies, and its messages by the week they were written.
 * - **Matches** (GET /api/topics/trends/match): the threads a word or a phrase is in, and those a
 *   phrase is about (`~`), from the CONTENT vectors month by month, above a similarity the map's
 *   sample of vectors sets for that phrase (SEMANTIC_Z standard deviations above their mean).
 */

export const WEEKS = 52;
/** Threads clustered, at most: as many of each month's as there are of the smallest's. */
export const SAMPLE = 2000;
/** About one topic per this many threads clustered, MIN_TOPICS to MAX_TOPICS. */
export const PER_TOPIC = 60;
export const MIN_TOPICS = 8;
export const MAX_TOPICS = 40;
/** Nearer no centre than this (cosine, centred), a thread is in no topic. */
export const MIN_SIM = 0.2;
export const STALE_DAYS = 28;
/** Threads the cron assigns a run. */
export const ASSIGN_BATCH = 600;
/** Raw vectors kept with a map, to tell how similar a phrase is to a thread by chance. */
export const SAMPLE_VECTORS = 128;
export const SEMANTIC_Z = 3;
/** Vectors per CONTENT.getByIds call, and threads per CONTENT.query (no metadata asked). */
const GET_BATCH = 20;
const QUERY_K = 100;
const DIM = 768;
const NAMED_TITLES = 15;
const NOISE = "'meeting', 'people'";

// ---- weeks ----------------------------------------------------------------------------------

/** The Monday (UTC) of the week of `iso`, as YYYY-MM-DD. */
export function mondayOf(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** The Mondays of the WEEKS weeks up to the one of `now`, the oldest first. */
export function weeksTo(now = new Date(), n = WEEKS) {
  const last = new Date(`${mondayOf(now.toISOString())}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(last);
    d.setUTCDate(d.getUTCDate() - 7 * (n - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}

// ---- vectors --------------------------------------------------------------------------------

function unit(v) {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) {
    s += v[i] * v[i];
  }
  s = Math.sqrt(s) || 1;
  return Float32Array.from(v, (x) => x / s);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    s += a[i] * b[i];
  }
  return s;
}

/** Vectors as base64 of their float32s, one after the other. */
export function packVectors(list) {
  const all = new Float32Array(list.length * DIM);
  list.forEach((v, i) => all.set(v, i * DIM));
  const bytes = new Uint8Array(all.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** packVectors' vectors again. */
export function unpackVectors(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) {
    bytes[i] = s.charCodeAt(i);
  }
  const all = new Float32Array(bytes.buffer);
  return Array.from({ length: all.length / DIM }, (_, i) => all.subarray(i * DIM, (i + 1) * DIM));
}

/** `{ mean, centroids, sample }` of a trend map's `vectors`, for `k` topics. */
export function mapVectors(b64, k) {
  const all = unpackVectors(b64);
  return { mean: all[0], centroids: all.slice(1, 1 + k), sample: all.slice(1 + k) };
}

/** A vector's topic: its nearest centre, centred as the map was; `{ topic, sim }`. */
export function assignTopic(values, { mean, centroids }) {
  const c = unit(Float32Array.from(values, (x, i) => x - mean[i]));
  let topic = null;
  let sim = -Infinity;
  centroids.forEach((m, j) => {
    const s = dot(c, m);
    if (s > sim) {
      sim = s;
      topic = j;
    }
  });
  return sim >= MIN_SIM ? { topic, sim } : { topic: null, sim };
}

/**
 * The similarity above which a thread is about a phrase: SEMANTIC_Z standard deviations above the
 * mean of the phrase's similarity to the map's sample of threads (bge's are all 0.4 to 0.6 alike).
 */
export function semanticFloor(query, sample, z = SEMANTIC_Z) {
  const sims = sample.map((v) => dot(unit(v), query));
  const mean = sims.reduce((a, b) => a + b, 0) / (sims.length || 1);
  const sd = Math.sqrt(sims.reduce((a, b) => a + (b - mean) ** 2, 0) / (sims.length || 1));
  return mean + z * sd;
}

async function vectorsOf(env, rows) {
  const out = new Map();
  for (let i = 0; i < rows.length; i += GET_BATCH) {
    const batch = rows.slice(i, i + GET_BATCH);
    // eslint-disable-next-line no-await-in-loop
    const found = await env.CONTENT.getByIds(batch.map((r) => r.vid));
    const byId = new Map(batch.map((r) => [r.vid, r.thread]));
    for (const v of found || []) {
      if (v && v.values && v.values.length === DIM && byId.has(v.id)) {
        out.set(byId.get(v.id), Float32Array.from(v.values));
      }
    }
  }
  return out;
}

// ---- the threads ----------------------------------------------------------------------------

const since = (now) => `${weeksTo(now)[0]}T00:00:00.000Z`;

/** The threads the page counts: the condition, on `t` (threads), `l` (labels) and `o` (orgs). */
const COUNTED = `t.kind = 'channel' AND t.logical_thread IS NULL AND t.root_at >= ?
  AND l.kind IS NOT NULL AND l.kind NOT IN (${NOISE}) AND COALESCE(o.type, 'customer') != 'internal'`;

/**
 * `n` of `rows` (each with `root_at`), as many of each month's as there are to take, seeded:
 * round by round one more of every month that has one left, so a busy month does not make the
 * topics all its own.
 */
export function stratified(rows, n, seed = 1) {
  const rnd = random(seed);
  const months = new Map();
  for (const r of rows) {
    const m = r.root_at.slice(0, 7);
    months.set(m, [...(months.get(m) || []), r]);
  }
  const lists = [...months.values()].map((l) => l.map((r) => [rnd(), r]).sort((a, b) => a[0] - b[0])
    .map(([, r]) => r));
  const out = [];
  for (let i = 0; out.length < n && lists.some((l) => l.length > i); i += 1) {
    for (const l of lists) {
      if (l.length > i && out.length < n) {
        out.push(l[i]);
      }
    }
  }
  return out;
}

const topicCount = (n) => Math.max(MIN_TOPICS, Math.min(MAX_TOPICS, Math.round(n / PER_TOPIC)));

/** The newest trend map (`vectors` only when asked for), or null. */
export async function latestTrendMap(env, { vectors = false } = {}) {
  const row = await env.DB.prepare(`SELECT id, built_at, built_by, threads, k, topics, model
      ${vectors ? ', vectors' : ''} FROM trend_maps ORDER BY built_at DESC, id DESC LIMIT 1`).first();
  return row ? { ...row, topics: JSON.parse(row.topics) } : null;
}

async function saveAssignments(env, map, rows) {
  const stmt = env.DB.prepare(`INSERT INTO trend_threads (thread, map, topic, sim, embedded, vid)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (thread) DO UPDATE SET map = excluded.map,
    topic = excluded.topic, sim = excluded.sim, embedded = excluded.embedded, vid = excluded.vid`);
  for (let i = 0; i < rows.length; i += 100) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.batch(rows.slice(i, i + 100).map((r) => stmt.bind(
      r.thread,
      map,
      r.topic,
      r.sim === null ? null : Math.round(r.sim * 1000) / 1000,
      r.embedded,
      r.vid,
    )));
  }
}

/**
 * Builds a trend map (`trend_maps`) from a sample of every month's threads, and assigns those:
 * `{ id, threads, k }`, or `{ error }`.
 */
export async function buildTrendMap(env, { now = new Date(), by = 'cron', seed = 1 } = {}) {
  if (!env.CONTENT || !env.AI) {
    return { error: 'trends need the CONTENT index and Workers AI' };
  }
  const { results } = await env.DB.prepare(`SELECT t.thread, t.root_at, t.embedded,
      COALESCE(l.title, t.title) AS title, l.topics
    FROM threads t JOIN labels l ON l.thread = t.thread LEFT JOIN orgs o ON o.slug = t.org
    WHERE ${COUNTED} AND t.embedded IS NOT NULL`).bind(since(now)).all();
  const rows = await Promise.all(stratified(results || [], SAMPLE, seed)
    .map(async (r) => ({ ...r, vid: await threadVectorId(r.thread) })));
  const vectors = await vectorsOf(env, rows);
  const have = rows.filter((r) => vectors.has(r.thread));
  const k = topicCount(have.length);
  if (have.length < k * 3) {
    return { error: `${have.length} threads with a vector: trends need ${MIN_TOPICS * 3}` };
  }
  const raw = have.map((r) => unit(vectors.get(r.thread)));
  const mean = new Float32Array(DIM);
  for (const v of raw) {
    for (let i = 0; i < DIM; i += 1) {
      mean[i] += v[i] / raw.length;
    }
  }
  const X = raw.map((v) => unit(Float32Array.from(v, (x, i) => x - mean[i])));
  const { labels, sims, centroids } = kmeans(X, k, { seed, restarts: 1, iterations: 20 });

  const members = centroids.map(() => []);
  labels.forEach((c, i) => members[c].push(i));
  const top = (list) => [...list.reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  const { names, model: namer } = await nameTopics(env, members.map((m, id) => {
    const typical = [...m].sort((a, b) => sims[b] - sims[a]);
    return {
      id,
      titles: [...new Set(typical.map((i) => have[i].title).filter(Boolean))]
        .slice(0, NAMED_TITLES),
      tags: top(m.flatMap((i) => topicList(have[i].topics))),
      products: [],
    };
  }));
  const seen = new Map();
  const topics = members.map((m, id) => {
    let label = names[id]?.label || `Topic ${id + 1}`;
    const n = (seen.get(label.toLowerCase()) || 0) + 1;
    seen.set(label.toLowerCase(), n);
    label = n > 1 ? `${label} (${n})` : label;
    return {
      id,
      label,
      theme: names[id]?.theme || '',
      area: top(m.flatMap((i) => topicList(have[i].topics).slice(0, 1)))[0]?.[0] || null,
      size: m.length,
    };
  });
  const rnd = random(seed + 1);
  const sample = raw.map((v) => [rnd(), v]).sort((a, b) => a[0] - b[0]).slice(0, SAMPLE_VECTORS)
    .map(([, v]) => v);
  const built = await env.DB.prepare(`INSERT INTO trend_maps (built_at, built_by, threads, k,
      topics, model, vectors) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(
      now.toISOString(),
      by,
      have.length,
      k,
      JSON.stringify(topics),
      EMBEDDING_MODEL,
      packVectors([mean, ...centroids, ...sample]),
    ).first();
  await env.DB.prepare('DELETE FROM trend_maps WHERE id != ?').bind(built.id).run();
  const space = { mean, centroids };
  await saveAssignments(env, built.id, have.map((r) => ({
    ...r, ...assignTopic(vectors.get(r.thread), space),
  })));
  console.log(JSON.stringify({
    route: 'trends', built: built.id, threads: have.length, k, namer,
  }));
  return { id: built.id, threads: have.length, k };
}

/**
 * Assigns up to `limit` threads that have no topic in the newest map, or whose vector changed
 * since: `{ assigned, left }`.
 */
export async function assignPending(env, { now = new Date(), limit = ASSIGN_BATCH } = {}) {
  const map = await latestTrendMap(env, { vectors: true });
  if (!map) {
    return { assigned: 0, left: 0 };
  }
  const { results } = await env.DB.prepare(`SELECT t.thread, t.embedded FROM threads t
      JOIN labels l ON l.thread = t.thread LEFT JOIN orgs o ON o.slug = t.org
      LEFT JOIN trend_threads g ON g.thread = t.thread
    WHERE ${COUNTED} AND t.embedded IS NOT NULL
      AND (g.thread IS NULL OR g.map != ? OR g.embedded IS NOT t.embedded)
    ORDER BY t.root_at DESC LIMIT ?`).bind(since(now), map.id, limit + 1).all();
  const rows = await Promise.all((results || []).slice(0, limit)
    .map(async (r) => ({ ...r, vid: await threadVectorId(r.thread) })));
  const vectors = await vectorsOf(env, rows);
  const space = mapVectors(map.vectors, map.k);
  // A thread whose vector is gone is in no topic, so it is not asked for again and again.
  await saveAssignments(env, map.id, rows.map((r) => ({
    ...r,
    ...(vectors.has(r.thread) ? assignTopic(vectors.get(r.thread), space)
      : { topic: null, sim: null }),
  })));
  return { assigned: rows.length, left: Math.max(0, (results || []).length - rows.length) };
}

/** Cron: a trend map once the newest is STALE_DAYS old (or there is none), else assignments. */
export async function sweepTrends(env, now = new Date()) {
  if (!env.CONTENT || !env.AI) {
    return { skipped: 'no CONTENT index' };
  }
  const row = await env.DB.prepare('SELECT MAX(built_at) AS at FROM trend_maps').first();
  if (!row || !row.at || now.getTime() - Date.parse(row.at) >= STALE_DAYS * 86400000) {
    return { built: await buildTrendMap(env, { now }) };
  }
  return { assigned: await assignPending(env, { now }) };
}

// ---- what the page counts -------------------------------------------------------------------

/** The keys of a label's JSON object of probabilities (`labels.about`, the likely ones only). */
function keysOf(stored) {
  try {
    const o = stored ? JSON.parse(stored) : null;
    return o && typeof o === 'object' ? Object.keys(o) : [];
  } catch {
    return [];
  }
}

const channelOf = (key) => key.slice(0, key.lastIndexOf(':'));
const names = () => {
  const index = new Map();
  const of = (v) => {
    const k = v ?? '';
    if (!index.has(k)) {
      index.set(k, index.size);
    }
    return index.get(k);
  };
  return { of, list: () => [...index.keys()] };
};

/**
 * GET /api/topics/trends: the newest trend map's topics and every thread the page counts, made
 * small: a thread is `[id, week, channel, org, team, source, kind, topic, areas, tech, weeks]`,
 * the names as indexes into the lists beside them, `week` the week it started, and `weeks` its
 * messages as `[week, count, …]` (both as indexes into `weeks`). `id` is the thread's rowid, as
 * the matches and GET /api/topics/trends/threads name it.
 */
export async function trendsData(env, { now = new Date() } = {}) {
  const weeks = weeksTo(now);
  const from = since(now);
  const map = await latestTrendMap(env);
  const [threads, msgs, orgRows, tech, areaRows, assigned] = await Promise.all([
    env.DB.prepare(`SELECT t.rowid AS id, t.thread, t.source, t.team, t.org, t.root_at, l.kind,
        l.topics, l.about, g.topic
      FROM threads t JOIN labels l ON l.thread = t.thread LEFT JOIN orgs o ON o.slug = t.org
        LEFT JOIN trend_threads g ON g.thread = t.thread AND g.map = ?
      WHERE ${COUNTED}`).bind(map ? map.id : -1, from).all(),
    env.DB.prepare(`SELECT COALESCE(t.logical_thread, t.thread) AS thread,
        date(m.at, '-6 days', 'weekday 1') AS week, COUNT(*) AS n
      FROM messages m JOIN threads t ON t.thread = m.thread
      WHERE m.counted = 1 AND m.deleted = 0 AND m.at >= ? AND t.kind = 'channel'
      GROUP BY 1, 2`).bind(from).all(),
    env.DB.prepare('SELECT slug, name, type FROM orgs').all(),
    env.DB.prepare(`SELECT tech, name FROM tech_stack WHERE enabled = 1
      ORDER BY team = 'admin' DESC`).all(),
    env.DB.prepare('SELECT id, name FROM areas WHERE enabled = 1 ORDER BY team = \'admin\' DESC').all(),
    map ? env.DB.prepare('SELECT COUNT(*) AS n FROM trend_threads WHERE map = ?').bind(map.id).first()
      : null,
  ]);
  const W = new Map(weeks.map((w, i) => [w, i]));
  const byThread = new Map();
  for (const m of msgs.results || []) {
    const w = W.get(m.week);
    if (w !== undefined) {
      byThread.set(m.thread, [...(byThread.get(m.thread) || []), w, m.n]);
    }
  }
  const lists = {
    channel: names(),
    org: names(),
    team: names(),
    source: names(),
    kind: names(),
    area: names(),
    tech: names(),
  };
  const rows = [];
  for (const t of threads.results || []) {
    const w = W.get(mondayOf(t.root_at));
    const counts = byThread.get(t.thread);
    if (w !== undefined && counts) {
      rows.push([
        t.id, w, lists.channel.of(channelOf(t.thread)), lists.org.of(t.org),
        lists.team.of(t.team), lists.source.of(t.source), lists.kind.of(t.kind), t.topic ?? -1,
        topicList(t.topics).map((a) => lists.area.of(a)),
        keysOf(t.about).map((a) => lists.tech.of(a)),
        counts,
      ]);
    }
  }
  const orgs = new Map((orgRows.results || []).map((o) => [o.slug, o]));
  const techNames = new Map();
  for (const r of tech.results || []) {
    if (!techNames.has(r.tech)) {
      techNames.set(r.tech, r.name);
    }
  }
  const areaNames = new Map();
  for (const r of areaRows.results || []) {
    if (!areaNames.has(r.id)) {
      areaNames.set(r.id, r.name);
    }
  }
  return {
    weeks,
    map: map && {
      id: map.id,
      built_at: map.built_at,
      built_by: map.built_by,
      threads: map.threads,
      k: map.k,
      topics: map.topics,
      assigned: assigned ? assigned.n : 0,
    },
    available: Boolean(env.CONTENT && env.AI),
    // Channels are counted, never named: only how many there are.
    channels: lists.channel.list().length,
    orgs: lists.org.list().map((slug) => ({
      slug, name: orgs.get(slug)?.name || slug, type: orgs.get(slug)?.type || 'customer',
    })),
    teams: lists.team.list(),
    sources: lists.source.list(),
    kinds: lists.kind.list(),
    areas: lists.area.list().map((id) => ({ id, name: areaNames.get(id) || id })),
    tech: lists.tech.list().map((id) => ({ id, name: techNames.get(id) || id })),
    threads: rows,
  };
}

/** GET /api/topics/trends/threads?ids=: those threads, as the page lists them. */
export async function trendThreads(env, ids) {
  const want = [...new Set(ids.map(Number).filter(Number.isInteger))].slice(0, 100);
  if (!want.length) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT t.rowid AS id, t.thread, t.team, t.org,
      t.source, t.root_at, t.messages, COALESCE(l.title, t.title) AS title
    FROM threads t LEFT JOIN labels l ON l.thread = t.thread
    WHERE t.rowid IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(want)).all();
  return (results || []).map((r) => ({
    id: r.id,
    key: r.thread,
    team: r.team,
    org: r.org,
    source: r.source,
    at: r.root_at,
    messages: r.messages,
    title: r.title || '',
  }));
}

const WORD = /^[\p{L}\p{N}][\p{L}\p{N} .+#/-]{0,38}[\p{L}\p{N}+#]?$/u;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rowids of the counted threads (a group's first) whose `keys` these are. */
async function firstsOf(env, keys, now) {
  if (!keys.length) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT DISTINCT f.rowid AS id
    FROM threads m JOIN threads f ON f.thread = COALESCE(m.logical_thread, m.thread)
    WHERE m.thread IN (SELECT value FROM json_each(?)) AND f.root_at >= ?`)
    .bind(JSON.stringify(keys), since(now)).all();
  return (results || []).map((r) => r.id);
}

/**
 * GET /api/topics/trends/match?term=: the threads `term` is in (its words, in a title or a
 * message), or, as `~phrase`, those about it: `{ ids, semantic, capped }`, `capped` when a month
 * had more than a query returns, so its count is too low.
 */
export async function matchTerm(env, term, { now = new Date() } = {}) {
  const t = String(term || '').trim();
  if (t.startsWith('~')) {
    const phrase = t.slice(1).trim().slice(0, 200);
    const map = await latestTrendMap(env, { vectors: true });
    if (!phrase || !map || !env.CONTENT || !env.AI) {
      return { error: map ? 'a phrase to look for' : 'no trend map yet', status: map ? 400 : 503 };
    }
    const res = await env.AI.run(EMBEDDING_MODEL, { text: [`${QUERY_PREFIX}${phrase}`] });
    const query = unit(res.data[0]);
    const floor = semanticFloor(query, mapVectors(map.vectors, map.k).sample);
    // Month by month, each its own query: one would return the QUERY_K nearest of all time.
    const starts = [];
    const first = new Date(since(now));
    for (let d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1)); d <= now;
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
      starts.push(d.getTime() / 1000);
    }
    const found = await Promise.all(starts.map((s, i) => env.CONTENT.query([...query], {
      topK: QUERY_K,
      filter: { type: 'thread', at: { $gte: s, $lt: starts[i + 1] || now.getTime() / 1000 + 1 } },
    })));
    const near = found.map((f) => (f.matches || []).filter((m) => m.score >= floor));
    const vids = near.flat().map((m) => m.id);
    const ids = [];
    for (let i = 0; i < vids.length; i += 500) {
      // eslint-disable-next-line no-await-in-loop
      const { results } = await env.DB.prepare(`SELECT DISTINCT t.rowid AS id FROM trend_threads g
        JOIN threads t ON t.thread = g.thread WHERE g.vid IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(vids.slice(i, i + 500))).all();
      ids.push(...(results || []).map((r) => r.id));
    }
    return {
      ids: [...new Set(ids)],
      semantic: true,
      capped: near.some((n) => n.length >= QUERY_K),
      floor: Math.round(floor * 1000) / 1000,
    };
  }
  if (!WORD.test(t)) {
    return { error: 'a word or a few, letters and digits', status: 400 };
  }
  // LIKE finds them case-blind; the expression keeps only whole words (not "cdn" in "cdns").
  const pattern = likePattern(t);
  const [titles, messages] = await Promise.all([
    env.DB.prepare(`SELECT t.thread, COALESCE(l.title, t.title) AS text FROM threads t
        LEFT JOIN labels l ON l.thread = t.thread
      WHERE t.kind = 'channel' AND t.root_at >= ? AND COALESCE(l.title, t.title) LIKE ? ESCAPE '\\'`)
      .bind(since(now), pattern).all(),
    env.DB.prepare(`SELECT m.thread, m.preview AS text FROM messages m
      WHERE m.at >= ? AND m.counted = 1 AND m.deleted = 0 AND m.preview LIKE ? ESCAPE '\\'`)
      .bind(since(now), pattern).all(),
  ]);
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}($|[^\\p{L}\\p{N}])`, 'iu');
  const keys = [...new Set([...(titles.results || []), ...(messages.results || [])]
    .filter((r) => re.test(r.text || '')).map((r) => r.thread))];
  const ids = [];
  for (let i = 0; i < keys.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    ids.push(...await firstsOf(env, keys.slice(i, i + 500), now));
  }
  return { ids: [...new Set(ids)], semantic: false, capped: false };
}
