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

import { EMBEDDING_MODEL } from './rethread.js';
import { threadVectorId } from './vectors.js';

/**
 * Which Adobe people know about what a thread is about, for the order of the composer's
 * mention suggestions (src/post.js `mentionable`): the thread's vector (CONTENT, src/vectors.js;
 * the mean of a re-threaded group's), and the staff messages closest to it, in any channel.
 * Each author's affinity is what their closest messages have over the weakest that still
 * counts, so someone who said several things close to the thread comes before someone who said
 * one thing a little less close. A thread without a vector yet (it is vectorized two minutes
 * after a post) is matched by its title. The expert finder (src/experts.js) builds on this.
 */

/** Staff messages looked at: Vectorize's most with full metadata. */
export const EXPERT_K = 50;
/** Below this similarity (bge, cosine, a message against a whole thread), it is not about it. */
export const EXPERT_MIN = 0.65;
/** And not much less similar than the closest message. */
export const EXPERT_WINDOW = 0.15;
/** An author's closest messages that count, so that a prolific one does not win on volume. */
export const EXPERT_MESSAGES = 5;
/** Affinities are kept this long per thread version, as typing asks again for every letter. */
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map();

/**
 * Affinities from Vectorize matches (`{ score, metadata: { author, person } }`):
 * `{ authors, people }`, maps from author key and from D1 person id to a number above 0.
 * The messages of `exclude` (a person id: the viewer) and those in `threads` (keys) do not count.
 */
export function affinities(matches, { exclude = null, threads = [] } = {}) {
  const usable = (matches || []).filter((m) => m && m.metadata
    && (m.metadata.author || m.metadata.person)
    && (exclude === null || m.metadata.person !== exclude)
    && !threads.includes(m.metadata.thread));
  const best = Math.max(-1, ...usable.map((m) => m.score));
  const floor = Math.max(EXPERT_MIN, best - EXPERT_WINDOW);
  const gains = { authors: new Map(), people: new Map() };
  const add = (map, key, gain) => {
    if (key !== null && key !== undefined) {
      map.set(key, [...(map.get(key) || []), gain]);
    }
  };
  for (const m of usable) {
    if (m.score > floor) {
      add(gains.authors, m.metadata.author, m.score - floor);
      add(gains.people, m.metadata.person, m.score - floor);
    }
  }
  const total = (list) => list.sort((a, b) => b - a).slice(0, EXPERT_MESSAGES)
    .reduce((s, x) => s + x, 0);
  return {
    authors: new Map([...gains.authors].map(([k, list]) => [k, total(list)])),
    people: new Map([...gains.people].map(([k, list]) => [k, total(list)])),
  };
}

/** The mean of vectors, unit length. */
function mean(vectors) {
  const sum = vectors[0].map((_, i) => vectors.reduce((s, v) => s + v[i], 0));
  const norm = Math.sqrt(sum.reduce((s, x) => s + x * x, 0)) || 1;
  return sum.map((x) => x / norm);
}

/** The vector of inbox entry `key`: its threads' vectors, else its title embedded. */
async function vectorOf(env, rows) {
  const ids = await Promise.all(rows.filter((r) => r.embedded)
    .map((r) => threadVectorId(r.thread)));
  const found = ids.length ? await env.CONTENT.getByIds(ids) : [];
  const values = (found || []).map((v) => v && v.values && [...v.values])
    .filter((v) => v && v.length);
  if (values.length) {
    return mean(values);
  }
  const title = rows.map((r) => r.title).find(Boolean);
  if (!title) {
    return null;
  }
  const res = await env.AI.run(EMBEDDING_MODEL, { text: [title] });
  return res.data[0];
}

/** The threads of inbox entry `key`, the latest first, with what `staffMatches` goes by. */
export async function entryRows(env, key) {
  const { results } = await env.DB.prepare(`SELECT t.thread, t.embedded,
      COALESCE(l.title, t.title) AS title
    FROM threads t LEFT JOIN labels l ON l.thread = t.thread
    WHERE t.thread = ? OR t.logical_thread = ? ORDER BY t.any_at DESC`).bind(key, key).all();
  return results || [];
}

/** The staff messages closest to an entry's threads (`entryRows`), or null with no vector. */
export async function staffMatches(env, rows) {
  const vector = await vectorOf(env, rows);
  if (!vector) {
    return null;
  }
  const { matches } = await env.CONTENT.query(vector, {
    topK: EXPERT_K, filter: { type: 'message', staff: true }, returnMetadata: 'all',
  });
  return matches;
}

/**
 * The Adobe people's affinity to inbox entry `key`, as `affinities` gives it, or null when
 * there is no CONTENT index or nothing to go by. `me` (a person id) is left out. Never throws:
 * suggestions without this are only ordered as before.
 */
export async function threadExperts(env, key, { me = null, now = Date.now() } = {}) {
  if (!env.CONTENT || !env.AI || !key) {
    return null;
  }
  try {
    const rows = await entryRows(env, key);
    if (!rows.length) {
      return null;
    }
    const version = `${key}|${me}|${rows.map((r) => `${r.thread}:${r.embedded || r.title}`).join(',')}`;
    const hit = cache.get(version);
    if (hit && now - hit.at < CACHE_MS) {
      return hit.experts;
    }
    const matches = await staffMatches(env, rows);
    if (!matches) {
      return null;
    }
    const experts = affinities(matches, { exclude: me });
    cache.delete(version);
    cache.set(version, { at: now, experts });
    while (cache.size > CACHE_MAX) {
      cache.delete(cache.keys().next().value);
    }
    return experts;
  } catch (e) {
    console.log(JSON.stringify({ route: 'mentionable', error: `expertise failed: ${e.message}` }));
    return null;
  }
}

/** Forgets the kept affinities (tests). */
export function clearExperts() {
  cache.clear();
}
