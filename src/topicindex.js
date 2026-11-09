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
 * The newest topic map (src/topicmap.js) as the expert finder reads it: which topic each thread
 * is in, and who worked the threads of each topic. Topic names name no customer (the namer is
 * told so), so they can say why someone fits a thread to whoever asks, in any team, where the
 * threads' titles could not (docs/ARCHITECTURE.md, "Expert finder").
 */

/** A map is read again at most this often per isolate; one is built a week. */
const RECHECK_MS = 10 * 60 * 1000;
let kept = null;

/** Folds a topic's name for matching what an agent typed. */
const fold = (s) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

/**
 * The index of a topic map (`{ id, map }`, as `topic_maps` keeps it): `{ id, built_at, topics,
 * topicOf }`. `topics` by id: `{ id, label, theme, size, people }`, `people` a map of person id to
 * `{ threads, last }` (the threads they posted in, the latest activity of those); `topicOf` a
 * map of thread key to topic id.
 */
export function indexTopicMap({ id, map }) {
  const topics = new Map((map.topics || []).map((t) => [t.id, {
    id: t.id, label: t.label, theme: t.theme || '', size: t.size, people: new Map(),
  }]));
  const topicOf = new Map();
  for (const t of map.threads || []) {
    const topic = topics.get(t.topic);
    if (topic) {
      topicOf.set(t.key, t.topic);
      for (const person of Object.keys(t.staff || {})) {
        const p = topic.people.get(Number(person)) || { threads: 0, last: null };
        p.threads += 1;
        p.last = !p.last || (t.last && t.last > p.last) ? t.last || p.last : p.last;
        topic.people.set(Number(person), p);
      }
    }
  }
  return {
    id, built_at: map.built_at, topics, topicOf,
  };
}

/** The index of the newest topic map, or null when there is none (or no table yet). */
export async function topicIndex(env, { now = Date.now() } = {}) {
  if (kept && kept.env === env && now - kept.at < RECHECK_MS) {
    return kept.index;
  }
  let index = null;
  try {
    const row = await env.DB.prepare(`SELECT id FROM topic_maps
      ORDER BY built_at DESC, id DESC LIMIT 1`).first();
    if (row && kept && kept.env === env && kept.index && kept.index.id === row.id) {
      index = kept.index;
    } else if (row) {
      const full = await env.DB.prepare('SELECT id, map FROM topic_maps WHERE id = ?')
        .bind(row.id).first();
      index = full ? indexTopicMap({ id: full.id, map: JSON.parse(full.map) }) : null;
    }
  } catch (e) {
    console.log(JSON.stringify({ route: 'experts', signal: 'topics', error: e.message }));
    index = null;
  }
  kept = { env, at: now, index };
  return index;
}

/** The topic of an index named `name` (its label, folded, or its id), or null. */
export function findTopic(index, name) {
  if (!index) {
    return null;
  }
  const n = fold(name);
  const all = [...index.topics.values()];
  return all.find((t) => String(t.id) === n)
    || all.find((t) => fold(t.label) === n)
    || all.find((t) => n && fold(t.label).includes(n))
    || null;
}

/**
 * The topics `threads` (`[{ thread, gain }]`, as src/expertise.js `similarThreads` gives them)
 * are in, the most weight first: `[{ id, label, theme, threads }]`, `threads` how many of them.
 */
export function topicsOfThreads(index, threads) {
  if (!index) {
    return [];
  }
  const weight = new Map();
  for (const { thread, gain = 1 } of threads) {
    const id = index.topicOf.get(thread);
    if (id !== undefined) {
      const w = weight.get(id) || { gain: 0, threads: 0 };
      weight.set(id, { gain: w.gain + gain, threads: w.threads + 1 });
    }
  }
  return [...weight].sort((a, b) => b[1].gain - a[1].gain).map(([id, w]) => {
    const t = index.topics.get(id);
    return {
      id, label: t.label, theme: t.theme, threads: w.threads,
    };
  });
}

/** Forgets the kept index (tests). */
export function clearTopicIndex() {
  kept = null;
}
