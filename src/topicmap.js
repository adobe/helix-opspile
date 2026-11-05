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

import { TITLER, topicList, topicNames } from './label.js';
import { EMBEDDING_MODEL } from './rethread.js';
import { authHeaders, gatewayBaseUrl, modelProblem } from './agent/model.js';
import { threadVectorId } from './vectors.js';
import {
  coveredBy, GENERIC, nameKey, productKey, techIndex,
} from './products.js';

export {
  coveredBy, GENERIC, productKey, techIndex,
} from './products.js';

/**
 * Topic maps: what the channel threads are about, found rather than asked. The threads' CONTENT
 * vectors (src/vectors.js, the mean of everything people wrote in them) are clustered with
 * k-means into topics, and a language model names each topic from the titles of its most typical
 * threads. With them come the Adobe people who posted in each thread, the customer it is for and
 * Clef's topics (labels.topics) and the products Clairic found in it (`product` facts), so the
 * Topics page (ui/topics.js) can draw people, topics, Clef's topics, products and customers as one
 * graph, and show what Clef's topics and the tech stack do not cover yet: topics that get no tag,
 * and products no tech stack entry names (the gaps).
 *
 * Only threads with something to say: at least MIN_MESSAGES messages, and not a meeting or a
 * people thread (Clef's kind), whose vectors say "let's meet" more than what about. The vectors
 * are centred (their mean taken away) before they are clustered: bge's vectors share a large
 * common part, and without it the clusters are fewer big ones and many of one or two threads.
 *
 * A map is built by the cron once it is STALE_DAYS old, and by the admin team on the page; one
 * row of `topic_maps` each, the newest KEEP kept. Nothing else reads them.
 */

export const MIN_MESSAGES = 3;
export const NOISE_KINDS = ['meeting', 'people'];
/** At most this many topics, and about one per PER_TOPIC threads below that. */
export const MAX_TOPICS = 30;
export const PER_TOPIC = 12;
/** Fewer threads than this make no map: the topics would be single threads. */
export const MIN_THREADS = 24;
export const STALE_DAYS = 7;
export const KEEP = 5;
/** Vectors per CONTENT.getByIds call. */
const GET_BATCH = 20;
/** Titles the namer reads per topic, the most typical first. */
const NEAREST = 15;
/** How long the agents' model may take to name every topic. */
const NAME_TIMEOUT_MS = 60000;
const RESTARTS = 4;
const ITERATIONS = 40;
const MAX_LABEL = 60;
const MAX_THEME = 240;

/** A seeded random number generator (Park and Miller's): the same threads make the same map. */
export function random(seed) {
  let a = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => {
    a = (a * 16807) % 2147483647;
    return (a - 1) / 2147483646;
  };
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    s += a[i] * b[i];
  }
  return s;
}

function unit(v) {
  const n = Math.sqrt(dot(v, v)) || 1;
  for (let i = 0; i < v.length; i += 1) {
    // eslint-disable-next-line no-param-reassign
    v[i] /= n;
  }
  return v;
}

/** The vectors with their mean taken away, each of unit length again. */
export function centered(vectors) {
  const d = vectors[0].length;
  const mean = new Float64Array(d);
  for (const v of vectors) {
    for (let i = 0; i < d; i += 1) {
      mean[i] += v[i] / vectors.length;
    }
  }
  return vectors.map((v) => unit(Float32Array.from(v, (x, i) => x - mean[i])));
}

/** Each vector's nearest centroid and how near (cosine): `{ labels, sims }`. */
function assign(X, centroids) {
  const labels = new Int32Array(X.length);
  const sims = new Float64Array(X.length);
  X.forEach((x, i) => {
    let best = -Infinity;
    centroids.forEach((c, j) => {
      const s = dot(x, c);
      if (s > best) {
        best = s;
        labels[i] = j;
      }
    });
    sims[i] = best;
  });
  return { labels, sims };
}

/** k-means++ seeds: each next one far from those before, likelier the farther (D²). */
function seeds(X, k, rnd) {
  const centroids = [Float32Array.from(X[Math.floor(rnd() * X.length)])];
  const far = new Float64Array(X.length).fill(Infinity);
  while (centroids.length < k) {
    const last = centroids[centroids.length - 1];
    let total = 0;
    X.forEach((x, i) => {
      far[i] = Math.min(far[i], Math.max(0, 1 - dot(x, last)) ** 2);
      total += far[i];
    });
    let pick = rnd() * total;
    let i = 0;
    while (i < X.length - 1 && (pick > far[i] || far[i] === 0)) {
      pick -= far[i];
      i += 1;
    }
    centroids.push(Float32Array.from(X[i]));
  }
  return centroids;
}

const changed = (a, b) => a.some((l, i) => l !== b[i]);

/** The centroids moved to the mean of their vectors; an empty one to the farthest vector. */
function update(X, centroids, { labels, sims }) {
  const d = X[0].length;
  const sums = centroids.map(() => new Float64Array(d));
  const counts = centroids.map(() => 0);
  for (let i = 0; i < X.length; i += 1) {
    const c = labels[i];
    counts[c] += 1;
    for (let j = 0; j < d; j += 1) {
      sums[c][j] += X[i][j];
    }
  }
  const taken = new Set();
  for (let c = 0; c < centroids.length; c += 1) {
    if (counts[c]) {
      // eslint-disable-next-line no-param-reassign
      centroids[c] = unit(Float32Array.from(sums[c]));
    } else {
      let far = -1;
      for (let i = 0; i < X.length; i += 1) {
        if (!taken.has(i) && (far < 0 || sims[i] < sims[far])) {
          far = i;
        }
      }
      taken.add(far);
      // eslint-disable-next-line no-param-reassign
      centroids[c] = Float32Array.from(X[far]);
    }
  }
}

/**
 * Spherical k-means (cosine) of unit vectors `X`: k-means++ seeds, then Lloyd's iterations; the
 * best of `restarts` by the total similarity of the vectors to their centroids. A cluster left
 * empty takes the vector farthest from its own. `{ labels, sims, centroids }`.
 */
export function kmeans(X, k, { seed = 1, restarts = RESTARTS, iterations = ITERATIONS } = {}) {
  const rnd = random(seed);
  let best = null;
  for (let r = 0; r < restarts; r += 1) {
    const centroids = seeds(X, k, rnd);
    let now = assign(X, centroids);
    for (let it = 0; it < iterations; it += 1) {
      update(X, centroids, now);
      const next = assign(X, centroids);
      const moved = changed(now.labels, next.labels);
      now = next;
      if (!moved) {
        break;
      }
    }
    const score = now.sims.reduce((s, x) => s + x, 0);
    if (!best || score > best.score) {
      best = {
        score, labels: [...now.labels], sims: [...now.sims], centroids,
      };
    }
  }
  return best;
}

/** How many topics `n` threads make. */
export const topicCount = (n) => Math.max(2, Math.min(MAX_TOPICS, Math.round(n / PER_TOPIC)));

const NOISE = NOISE_KINDS.map((k) => `'${k}'`).join(', ');
const WHERE = `t.kind = 'channel' AND t.embedded IS NOT NULL AND t.messages >= ?
  AND COALESCE(l.kind, '') NOT IN (${NOISE})`;

/** The threads a map is of, with their labels, and the Adobe people who posted in them. */
async function threadsOf(env) {
  const { results: threads } = await env.DB.prepare(`SELECT t.thread, t.team, t.org, t.root_at,
      t.last_at, t.messages, COALESCE(l.title, t.title) AS title, l.kind, l.topics
    FROM threads t LEFT JOIN labels l ON l.thread = t.thread WHERE ${WHERE}`)
    .bind(MIN_MESSAGES).all();
  const { results: posts } = await env.DB.prepare(`SELECT m.thread, m.person, p.name, COUNT(*) AS n
    FROM messages m JOIN threads t ON t.thread = m.thread LEFT JOIN labels l ON l.thread = t.thread
    JOIN people p ON p.id = m.person
    WHERE ${WHERE} AND m.staff = 1 AND m.counted = 1 AND m.deleted = 0
    GROUP BY m.thread, m.person`).bind(MIN_MESSAGES).all();
  const { results: orgs } = await env.DB.prepare('SELECT slug, name, type FROM orgs').all();
  const { results: products } = await env.DB.prepare(`SELECT f.thread, f.value FROM facts f
    JOIN threads t ON t.thread = f.thread LEFT JOIN labels l ON l.thread = t.thread
    WHERE ${WHERE} AND f.source = 'clairic' AND f.field = 'product'`).bind(MIN_MESSAGES).all();
  const { results: tech } = await env.DB.prepare(`SELECT tech, name, description, product,
    aliases FROM tech_stack WHERE enabled = 1 ORDER BY team = 'admin' DESC`).all();
  return {
    threads: threads || [],
    posts: posts || [],
    orgs: orgs || [],
    products: products || [],
    tech: tech || [],
  };
}

// ---- products and the tech stack (src/products.js) --------------------------------------

/**
 * The products of the threads (Clairic's `product` facts), each as the tech stack entry that
 * covers it (`tech:<id>`, named as the entry, with the product it is part of: `product`, the
 * admin team's when teams differ) or, when none does, as itself (`new:<key>`, named as most
 * threads write it, no `tech`): `{ of: thread → ids, products: id → { name, tech, product } }`.
 */
export function productsOf(facts, techRows) {
  const index = techIndex(techRows);
  const partOf = new Map();
  for (const r of techRows) {
    if (r.product && !partOf.has(r.tech)) {
      partOf.set(r.tech, r.product);
    }
  }
  const of = new Map();
  const forms = new Map();
  const products = {};
  for (const f of facts) {
    const key = productKey(f.value);
    if (key && !GENERIC.has(nameKey(f.value))) {
      const tech = coveredBy(f.value, index);
      const id = tech ? `tech:${tech}` : `new:${key}`;
      if (tech) {
        products[id] = {
          name: index.find((t) => t.tech === tech).name, tech, product: partOf.get(tech) || null,
        };
      } else {
        const counts = forms.get(id) || new Map();
        counts.set(f.value, (counts.get(f.value) || 0) + 1);
        forms.set(id, counts);
      }
      of.set(f.thread, [...new Set([...(of.get(f.thread) || []), id])]);
    }
  }
  for (const [id, counts] of forms) {
    products[id] = {
      name: [...counts].sort((a, b) => b[1] - a[1])[0][0], tech: null, product: null,
    };
  }
  return { of, products };
}

/** The threads' vectors from CONTENT, by thread key; those it does not have are left out. */
async function vectorsOf(env, keys) {
  const ids = await Promise.all(keys.map((k) => threadVectorId(k)));
  const byId = new Map(ids.map((id, i) => [id, keys[i]]));
  const out = new Map();
  for (let i = 0; i < ids.length; i += GET_BATCH) {
    // eslint-disable-next-line no-await-in-loop
    const found = await env.CONTENT.getByIds(ids.slice(i, i + GET_BATCH));
    for (const v of found || []) {
      if (v && v.values && v.values.length && byId.has(v.id)) {
        out.set(byId.get(v.id), [...v.values]);
      }
    }
  }
  return out;
}

export const NAMER = 'You name a topic: a group of support threads between Adobe and its'
  + ' customers about Adobe Experience Manager and Edge Delivery Services. Answer with two lines'
  + ' and nothing else. The first: a name of two to five words for what the threads have in'
  + ' common, in sentence case, as specific as they allow (for example "CDN purge and stale'
  + ' cache", not "Technical issues"). The second: one sentence on what the customers need. Name'
  + ' no customer, company, brand or person, and not Adobe, AEM or Edge Delivery Services, which'
  + ' every thread is about.';

const tidy = (s) => String(s || '').replace(/^\s*(?:\d+[.)]|[-*#•]|name:|theme:|topic:|line \d:)\s*/i, '')
  .replace(/^["'`*\s]+|["'`*\s]+$/g, '').trim();

/**
 * A topic's name and theme from the titles of its most typical threads, by the language model;
 * `{ label, theme }`, with no label when it gave none worth showing.
 */
export async function nameTopic(env, titles) {
  try {
    const res = await env.AI.run(TITLER, {
      messages: [
        { role: 'system', content: NAMER },
        { role: 'user', content: `Threads, the most typical first:\n${titles.map((t) => `- ${t}`).join('\n')}` },
      ],
      max_tokens: 90,
    });
    const text = String((res && (res.response || res.choices?.[0]?.message?.content)) || '');
    const [first, ...rest] = text.split('\n').map(tidy).filter(Boolean);
    const label = first && first.length <= MAX_LABEL ? first.replace(/[.:]$/, '') : null;
    return { label, theme: label ? (rest[0] || '').slice(0, MAX_THEME) : '' };
  } catch (e) {
    console.log(JSON.stringify({ route: 'topicmap', namer: 'error', error: e.message }));
    return { label: null, theme: '' };
  }
}

/** Words that make a name vague: a name made of them and little else names nothing. */
export const FILLER = ['issues', 'issue', 'problems', 'troubleshooting', 'support', 'management',
  'configuration', 'configurations', 'setup', 'implementation', 'integration', 'content delivery',
  'content management', 'technical', 'general', 'various', 'miscellaneous'];

export const NAMER_ALL = 'You name the topics of a support inbox: groups of threads between'
  + ' Adobe and its enterprise customers about Adobe Experience Manager (Edge Delivery Services,'
  + ' Document Authoring, Universal Editor, AEM as a Cloud Service) and the products around it.'
  + ' For each topic you get the titles of its most typical threads, the concerns a classifier'
  + ' found in them and the products they name, with how many threads have each. Name what sets'
  + ' each topic apart from the others: read all of them first, and give no two topics names that'
  + ' could be swapped. A name has two to five words, in sentence case (a capital first letter,'
  + ' and for names of products), and is as specific as the threads allow: name the product or'
  + ' the failure where the threads share one ("Sidekick sign-in after SSO changes", "CDN purge'
  + ` and stale cache", "Product feeds for marketplaces"). Do not use ${FILLER.map((w) => `"${w}"`).join(', ')}`
  + ' or a name every topic could have; and not "AEM", "Adobe" or "Edge Delivery" alone. A topic'
  + ' that is mostly one project names what the project is ("Storefront rebuild on Edge"). Name no'
  + ' customer or person. With each name write one sentence on what its customers need. Answer'
  + ' with JSON only: [{"id": 0, "name": "…", "theme": "…"}, …], every topic once.';

/** What NAMER_ALL reads: per topic, its threads' titles, concerns and products, with counts. */
export function namingInput(topics) {
  const counts = (list) => list.map(([name, n]) => `${name} (${n})`).join(', ') || 'none';
  return topics.map((t) => [
    `Topic ${t.id} (${t.titles.length} titles shown):`,
    ...t.titles.map((title) => `- ${title}`),
    `Concerns: ${counts(t.tags)}`,
    `Products: ${counts(t.products)}`,
  ].join('\n')).join('\n\n');
}

const vague = (label) => {
  const rest = FILLER.reduce((s, w) => s.replace(new RegExp(`\\b${w}\\b`, 'gi'), ' '), label)
    .replace(/\b(?:and|of|for|the|a|with|aem|adobe|edge)\b/gi, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
  return rest.length < 4;
};

/** Sentence case: the first letter a capital, the rest as written (product names keep theirs). */
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The names NAMER_ALL gave, by topic id: `[{ label, theme }]`, null for a topic it gave no name
 * worth showing (none, too long, vague, or the same as another's).
 */
export function parseNames(text, n) {
  const out = Array.from({ length: n }, () => null);
  const json = String(text || '').match(/\[[\s\S]*\]/);
  let list = [];
  try {
    list = json ? JSON.parse(json[0]) : [];
  } catch {
    list = [];
  }
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const id = Number(item && item.id);
    const label = sentence(tidy(item && item.name).replace(/[.:]$/, ''));
    if (Number.isInteger(id) && id >= 0 && id < n && !out[id] && label && label.length <= MAX_LABEL
      && !vague(label) && !seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      out[id] = { label, theme: String((item && item.theme) || '').trim().slice(0, MAX_THEME) };
    }
  }
  return out;
}

/**
 * NAMER_ALL's answer: from the agents' model on Bedrock (src/agent/model.js) where agents are
 * configured, else from Workers AI's title model; `{ text, model }`, or null when it failed.
 */
async function nameAll(env, user) {
  if (!modelProblem(env)) {
    try {
      const res = await fetch(`${gatewayBaseUrl(env)}/v1/messages`, {
        method: 'POST',
        headers: {
          ...authHeaders(env), 'content-type': 'application/json', 'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: env.AGENT_MODEL,
          max_tokens: 6000,
          system: NAMER_ALL,
          messages: [{ role: 'user', content: user }],
        }),
        // A stalled gateway falls back to Workers AI instead of holding up the build.
        signal: AbortSignal.timeout(NAME_TIMEOUT_MS),
      });
      const body = await res.json().catch(() => ({}));
      const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      // COGS (src/cogs/meter.js): Bedrock is not a binding, so its tokens are counted here.
      const u = body.usage || {};
      for (const [metric, q] of [['input_tokens', u.input_tokens], ['output_tokens', u.output_tokens]]) {
        if (env.meter && q) {
          env.meter.add('bedrock', metric, env.AGENT_MODEL, q);
        }
      }
      if (res.ok && text) {
        return { text, model: env.AGENT_MODEL };
      }
      console.log(JSON.stringify({ route: 'topicmap', namer: 'bedrock', status: res.status }));
    } catch (e) {
      console.log(JSON.stringify({ route: 'topicmap', namer: 'bedrock', error: e.message }));
    }
  }
  try {
    const res = await env.AI.run(TITLER, {
      messages: [{ role: 'system', content: NAMER_ALL }, { role: 'user', content: user }],
      max_tokens: 4000,
    });
    const text = String((res && (res.response || res.choices?.[0]?.message?.content)) || '');
    return text ? { text, model: TITLER } : null;
  } catch (e) {
    console.log(JSON.stringify({ route: 'topicmap', namer: 'error', error: e.message }));
    return null;
  }
}

/**
 * Every topic's name and theme, in one call, so the names tell the topics apart; a topic that call
 * named badly is named on its own (nameTopic). `topics`: `{ id, titles, tags, products }`, the
 * last two `[name, threads]`, the most first. `{ names, model }`.
 */
export async function nameTopics(env, topics) {
  const all = await nameAll(env, namingInput(topics));
  const names = all ? parseNames(all.text, topics.length) : topics.map(() => null);
  const taken = new Set(names.filter(Boolean).map((x) => x.label.toLowerCase()));
  const filled = await Promise.all(topics.map(async (t, i) => {
    if (names[i]) {
      return names[i];
    }
    const one = await nameTopic(env, t.titles);
    return one.label && !taken.has(one.label.toLowerCase())
      ? { ...one, label: sentence(one.label) } : one;
  }));
  return { names: filled, model: (all && all.model) || TITLER };
}

const round = (x, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;

/**
 * Builds a topic map of the channel threads and keeps it (`topic_maps`): `{ id, built_at,
 * threads, k, map }`, or `{ error }` when there is nothing to build it from. The map:
 *
 * - `topics`: `{ id, label, theme, size, cohesion }`, the biggest first (`cohesion`: the mean
 *   cosine of its threads to its centre, in the centred space).
 * - `threads`: `{ key, title, team, org, at, last, messages, kind, tags, topic, sim, staff }`, by
 *   topic, the most typical first; `tags` are Clef's topics (labels.topics), `staff` the Adobe
 *   people who posted, by id, with their messages.
 * - `people` (id → name, Adobe staff only), `orgs` (slug → `{ name, type }`), `tags` (Clef's
 *   topic ids → the names the inbox shows), `products` (id → `{ name, tech, product }`: the
 *   products Clairic found in the threads, `tech` the tech stack entry that covers one (null for
 *   a gap), `product` the product that entry is part of; a thread's `products` are their ids).
 */
export async function buildTopicMap(env, { now = new Date(), by = 'cron', seed = 1 } = {}) {
  if (!env.CONTENT || !env.AI) {
    return { error: 'a topic map needs the CONTENT index and Workers AI' };
  }
  const {
    threads, posts, orgs, products: facts, tech,
  } = await threadsOf(env);
  const vectors = await vectorsOf(env, threads.map((t) => t.thread));
  const rows = threads.filter((t) => vectors.has(t.thread));
  if (rows.length < MIN_THREADS) {
    return {
      error: `${rows.length} threads with ${MIN_MESSAGES} messages or more and a vector: a topic`
        + ` map needs ${MIN_THREADS}`,
    };
  }
  const X = centered(rows.map((t) => vectors.get(t.thread)));
  const k = topicCount(rows.length);
  const { labels, sims } = kmeans(X, k, { seed });

  const members = Array.from({ length: k }, () => []);
  rows.forEach((t, i) => members[labels[i]].push(i));
  const clusters = members.filter((m) => m.length)
    .map((m) => m.sort((a, b) => sims[b] - sims[a]))
    .sort((a, b) => b.length - a.length);
  const products = productsOf(facts, tech);
  const top = (list) => [...list.reduce((c, v) => c.set(v, (c.get(v) || 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  const tagNames = topicNames();
  const productName = (id) => {
    const p = products.products[id];
    return (p && (p.product && p.tech ? `${p.name} (${p.product})` : p.name)) || id;
  };
  const { names, model: namer } = await nameTopics(env, clusters.map((m, id) => ({
    id,
    titles: m.slice(0, NEAREST).map((i) => rows[i].title).filter(Boolean),
    tags: top(m.flatMap((i) => topicList(rows[i].topics).map((g) => tagNames[g] || g))),
    products: top(m.flatMap((i) => [...new Set((products.of.get(rows[i].thread) || [])
      .map(productName))])),
  })));
  const seen = new Map();
  const topics = clusters.map((m, id) => {
    let label = names[id].label || `Topic ${id + 1}`;
    const n = (seen.get(label.toLowerCase()) || 0) + 1;
    seen.set(label.toLowerCase(), n);
    label = n > 1 ? `${label} (${n})` : label;
    return {
      id,
      label,
      theme: names[id].theme,
      size: m.length,
      cohesion: round(m.reduce((s, i) => s + sims[i], 0) / m.length),
    };
  });

  const staff = new Map();
  const people = {};
  for (const p of posts) {
    staff.set(p.thread, { ...staff.get(p.thread), [p.person]: p.n });
    people[p.person] = p.name || `#${p.person}`;
  }
  const used = new Set(rows.map((t) => t.org));
  const map = {
    version: 1,
    built_at: now.toISOString(),
    built_by: by,
    model: EMBEDDING_MODEL,
    namer,
    min_messages: MIN_MESSAGES,
    topics,
    threads: clusters.flatMap((m, topic) => m.map((i) => {
      const t = rows[i];
      return {
        key: t.thread,
        title: t.title || '',
        team: t.team,
        org: t.org,
        at: t.root_at,
        last: t.last_at,
        messages: t.messages,
        kind: t.kind || null,
        tags: topicList(t.topics),
        products: products.of.get(t.thread) || [],
        topic,
        sim: round(sims[i]),
        staff: staff.get(t.thread) || {},
      };
    })),
    people,
    orgs: Object.fromEntries(orgs.filter((o) => used.has(o.slug))
      .map((o) => [o.slug, { name: o.name || o.slug, type: o.type }])),
    tags: topicNames(),
    products: products.products,
  };
  const built = await env.DB.prepare(`INSERT INTO topic_maps (built_at, built_by, threads, k, map)
    VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .bind(map.built_at, by, rows.length, topics.length, JSON.stringify(map)).first();
  await env.DB.prepare(`DELETE FROM topic_maps WHERE id NOT IN
    (SELECT id FROM topic_maps ORDER BY built_at DESC, id DESC LIMIT ?)`).bind(KEEP).run();
  return {
    id: built.id, built_at: map.built_at, threads: rows.length, k: topics.length, map,
  };
}

/** The newest topic map: `{ id, built_at, built_by, map }`, or null. */
export async function latestTopicMap(env) {
  const row = await env.DB.prepare(`SELECT id, built_at, built_by, map FROM topic_maps
    ORDER BY built_at DESC, id DESC LIMIT 1`).first();
  return row ? { ...row, map: JSON.parse(row.map) } : null;
}

/** Cron: builds a topic map when the newest is STALE_DAYS old, or there is none. */
export async function sweepTopicMap(env, now = new Date()) {
  if (!env.CONTENT || !env.AI) {
    return { skipped: 'no CONTENT index' };
  }
  const row = await env.DB.prepare('SELECT MAX(built_at) AS at FROM topic_maps').first();
  if (row && row.at && now.getTime() - Date.parse(row.at) < STALE_DAYS * 86400000) {
    return { fresh: row.at };
  }
  const built = await buildTopicMap(env, { now });
  return built.error ? { error: built.error } : {
    built: built.id, threads: built.threads, k: built.k,
  };
}
