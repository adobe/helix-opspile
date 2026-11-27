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
  areaNamesOf, garbled, mangled, TITLER, topicList,
} from './label.js';
import { EMBEDDING_MODEL } from './rethread.js';
import { authHeaders, gatewayBaseUrl, modelProblem } from './agent/model.js';
import { threadVectorId } from './vectors.js';
import { packVectors, saveAssignments, SAMPLE_VECTORS } from './trends.js';
import { topicPlaces } from './topicspace.js';
import { sameAccounts, sameLinks } from './accountpairs.js';
import {
  factOf, factWeights, MIN_WEIGHT, SKIP_FIELDS,
} from './factweights.js';
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
 * Clef's topics (labels.topics) and the technologies Clef says it is about (thread_tech), so the
 * Topics page (ui/topics.js) can draw people, topics, Clef's topics, products and customers as one
 * graph, and show what Clef's topics and the tech stack do not cover yet: topics that get no tag,
 * and products no tech stack entry names (the gaps).
 *
 * Each topic is named and described with the docs and links its threads share, too (`topicFacts`,
 * by the facts' tf-idf, src/factweights.js). They are no feature of the clustering: measured on
 * production threads, adding them to the vectors made the topics more alike only in the facts
 * they were given, not in the others (half of the facts held out), and less alike in what was said.
 *
 * Only threads with something to say: at least MIN_MESSAGES messages, and not a meeting or a
 * people thread (Clef's kind), whose vectors say "let's meet" more than what about. The vectors
 * are centred (their mean taken away) before they are clustered: bge's vectors share a large
 * common part, and without it the clusters are fewer big ones and many of one or two threads.
 *
 * A map is built by the cron once it is STALE_DAYS old, and by the admin team on the page; one
 * row of `topic_maps` each, the newest KEEP kept. The expert finder reads the newest
 * (src/topicindex.js).
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
/** A topic's docs and links, at most: those its threads share more than the others' do. */
export const TOPIC_FACTS = 5;
/** A topic's fact is in this many times the share of its threads as of all the map's. */
export const FACT_LIFT = 2;
/**
 * Facts the namer is not shown, which name a customer more than a subject: a site, an AEM Cloud
 * Service environment, a ticket.
 */
const UNNAMED_FIELDS = new Set(['site', 'aemcs_env', 'ticket']);

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

/** The unit mean of `vectors`. */
function centroid(vectors) {
  const m = new Float32Array(vectors[0].length);
  for (const v of vectors) {
    for (let d = 0; d < m.length; d += 1) {
      m[d] += v[d];
    }
  }
  return unit(m);
}

/**
 * A cluster is one customer's, one team's or one product's concern, not a topic, when one of
 * them has at least CONCENTRATED of its threads, and at least LIFT times their share of the
 * area's threads: Edge Delivery, on a quarter of all threads, or the team with most channels,
 * concentrates no cluster by being everywhere.
 */
export const CONCENTRATED = 0.6;
export const LIFT = 2;
/** An area's threads make at most this many topics. */
export const MAX_AREA_TOPICS = 8;
/**
 * The threads in no area make up to this many: they are what no area asks about, and split
 * finer they are the candidates for new areas, not a few catch-alls.
 */
export const MAX_NONE_TOPICS = 16;

/** What of `values` (a list per thread) the threads `members` are concentrated on, or null. */
function concentration(members, values, base, lift = LIFT) {
  const count = new Map();
  for (const i of members) {
    for (const v of new Set(values[i] || [])) {
      count.set(v, (count.get(v) || 0) + 1);
    }
  }
  for (const [v, n] of count) {
    const share = n / members.length;
    if (share >= CONCENTRATED && share >= lift * (base.get(v) || 0)) {
      return v;
    }
  }
  return null;
}

/** Each facet's values' share of the threads `idx`: `{ name: Map(value → share) }`. */
export function shares(facets, idx) {
  return Object.fromEntries(Object.entries(facets).map(([name, values]) => {
    const m = new Map();
    for (const i of idx) {
      for (const v of new Set(values[i] || [])) {
        m.set(v, (m.get(v) || 0) + 1 / idx.length);
      }
    }
    return [name, m];
  }));
}

/**
 * The topics of an area's threads (`idx`, indexes into `X`): k-means into about one topic per
 * PER_TOPIC threads, then each topic that is one customer's, team's or product's concern
 * (`facets`: `{ name: [values per thread] }`) dissolved into the others, its threads each to the
 * nearest topic left, until none is or one is left. `[{ members, sims, concentrated }]`, the
 * most threads first; `concentrated` names what the one left is concentrated on, if it is: what
 * has CONCENTRATED of its threads and LIFT times its share of all the map's (`overall`: the
 * facets' shares over every thread, as `shares` makes them).
 */
export function areaTopics(X, idx, facets, {
  seed = 1, max = MAX_AREA_TOPICS, overall = null,
} = {}) {
  if (!idx.length) {
    return [];
  }
  const k = Math.max(1, Math.min(max, Math.round(idx.length / PER_TOPIC)));
  const sub = idx.map((i) => X[i]);
  const { labels, centroids } = k > 1 ? kmeans(sub, k, { seed })
    : { labels: idx.map(() => 0), centroids: [centroid(sub)] };
  // The share of each facet's values over the area, for the lift.
  const bases = shares(facets, idx);
  const all = overall || shares(facets, Object.keys(facets).length
    ? Object.values(facets)[0].map((_, i) => i) : []);
  let live = centroids.map((c, j) => ({ c, members: idx.filter((_, n) => labels[n] === j) }))
    .filter((t) => t.members.length);
  const why = (t) => Object.entries(facets)
    .map(([name, values]) => {
      const v = concentration(t.members, values, bases[name]);
      return v === null ? null : `${name}:${v}`;
    }).find(Boolean) || null;
  for (;;) {
    const bad = live.length > 1 && live.find((t) => why(t));
    if (!bad) {
      break;
    }
    live = live.filter((t) => t !== bad);
    for (const i of bad.members) {
      let best = live[0];
      for (const t of live) {
        if (dot(X[i], t.c) > dot(X[i], best.c)) {
          best = t;
        }
      }
      best.members.push(i);
    }
    // Their centres again, from who is in them now.
    for (const t of live) {
      t.c = centroid(t.members.map((i) => X[i]));
    }
  }
  // The one topic an area could not split has every thread of it, so no lift over the area can
  // tell: its lift is over all the map's threads. The team with most channels, on most threads,
  // concentrates no area so; a team on a tenth of them whose area it is, does.
  const alone = (t) => Object.entries(facets)
    .map(([name, values]) => {
      const v = concentration(t.members, values, all[name]);
      return v === null ? null : `${name}:${v}`;
    }).find(Boolean) || null;
  return live.map((t) => ({
    members: t.members.map((i) => ({ i, sim: dot(X[i], t.c) })).sort((a, b) => b.sim - a.sim),
    concentrated: live.length === 1 ? alone(t) : null,
  })).sort((a, b) => b.members.length - a.members.length);
}

const NOISE = NOISE_KINDS.map((k) => `'${k}'`).join(', ');
const WHERE = `t.kind = 'channel' AND t.embedded IS NOT NULL AND t.messages >= ?
  AND COALESCE(l.kind, '') NOT IN (${NOISE})`;

/** The threads a map is of, with their labels, and the Adobe people who posted in them. */
async function threadsOf(env) {
  const { results: threads } = await env.DB.prepare(`SELECT t.thread, t.team, t.org, t.root_at,
      t.last_at, t.messages, t.embedded, COALESCE(l.title, t.title) AS title, l.kind, l.topics
    FROM threads t LEFT JOIN labels l ON l.thread = t.thread WHERE ${WHERE}`)
    .bind(MIN_MESSAGES).all();
  // Everyone who posted: Adobe's people (`staff`) and the customers', partners' and vendors'.
  // A person of D1 by their id; anyone else (the customers' people are no person of D1: their
  // messages have no `person`) by their platform account, `a:<author_key>`, named as it is.
  const { results: posts } = await env.DB.prepare(`SELECT m.thread,
      COALESCE(CAST(m.person AS TEXT), 'a:' || m.author_key) AS person, p.name,
      MAX(m.staff) AS staff, COUNT(*) AS n
    FROM messages m JOIN threads t ON t.thread = m.thread LEFT JOIN labels l ON l.thread = t.thread
    LEFT JOIN people p ON p.id = m.person
    WHERE ${WHERE} AND m.counted = 1 AND m.deleted = 0
      AND (m.person IS NOT NULL OR (m.author_kind = 'person' AND m.author_key IS NOT NULL))
    GROUP BY m.thread, 2`).bind(MIN_MESSAGES).all();
  const { results: accounts } = await env.DB.prepare(`SELECT source || ':' || tenant || ':' ||
      user_id AS author, name, LOWER(COALESCE(email, merge_email)) AS mail FROM identities
    WHERE kind = 'person' AND person IS NULL`).all();
  const named = new Map((accounts || []).map((a) => [`a:${a.author}`, a.name]));
  // The accounts of one mail address (a customer's, as a guest and again from their own
  // workspace), and those the admin team said are one person (src/accountpairs.js), are one of
  // them, the first.
  const links = await sameLinks(env);
  const same = sameAccounts((accounts || []).map((a) => ({ key: a.author, mail: a.mail })), links);
  const sameAs = new Map((accounts || []).map((a) => [`a:${a.author}`, `a:${same(a.author)}`]));
  const merged = new Map();
  for (const p of posts || []) {
    const who = sameAs.get(p.person) || p.person;
    const k = `${p.thread}\u0000${who}`;
    const was = merged.get(k);
    if (was) {
      was.n += p.n;
      was.staff = Math.max(was.staff, p.staff);
    } else {
      merged.set(k, { ...p, person: who, name: p.name || named.get(who) || null });
    }
  }
  // The teams Adobe's people are on, to group them by.
  const { results: memberships } = await env.DB.prepare(`SELECT person, team FROM team_members
    ORDER BY person, team`).all();
  const { results: orgs } = await env.DB.prepare('SELECT slug, name, type FROM orgs').all();
  // What Clef says each thread is about (thread_tech.about), or, where it was not asked that,
  // what it shows (src/label.js aboutOf).
  const { results: products } = await env.DB.prepare(`SELECT g.thread, g.tech, g.about,
      l.about IS NOT NULL AS asked FROM thread_tech g
    JOIN threads t ON t.thread = g.thread LEFT JOIN labels l ON l.thread = t.thread
    WHERE ${WHERE}`).bind(MIN_MESSAGES).all();
  const { results: tech } = await env.DB.prepare(`SELECT tech, name, description, product,
    aliases FROM tech_stack WHERE enabled = 1 ORDER BY team = 'admin' DESC`).all();
  // The facts the topics are named with (src/factweights.js), not those that say nothing.
  const { results: facts } = await env.DB.prepare(`SELECT f.thread, f.field, f.value FROM facts f
    JOIN threads t ON t.thread = f.thread LEFT JOIN labels l ON l.thread = t.thread
    WHERE ${WHERE} AND f.field NOT IN (SELECT value FROM json_each(?))`)
    .bind(MIN_MESSAGES, JSON.stringify([...SKIP_FIELDS])).all();
  return {
    facts: facts || [],
    threads: threads || [],
    posts: [...merged.values()],
    memberships: memberships || [],
    orgs: orgs || [],
    products: products || [],
    tech: tech || [],
  };
}

// ---- products and the tech stack (src/products.js) --------------------------------------

/**
 * The products of the threads, as Clef answered them (`thread_tech`): what a thread is about
 * (`about` set), or, for a thread whose label was not asked that (`asked` false), what it shows.
 * Each as its technology (`tech:<id>`, named as it, with the product it is part of). The same
 * shape as productsOf: `{ of: thread → ids, products: id → { name, tech, product } }`; Clef's
 * answers name only technologies of the tech stack, so none is a gap.
 */
export function techProductsOf(rows, techRows) {
  const by = new Map();
  for (const r of techRows) {
    if (!by.has(r.tech)) {
      by.set(r.tech, r);
    }
  }
  const of = new Map();
  const products = {};
  for (const r of rows) {
    const t = by.get(r.tech);
    if (t && (r.asked ? typeof r.about === 'number' : true)) {
      const id = `tech:${r.tech}`;
      products[id] = { name: t.name || r.tech, tech: r.tech, product: t.product || null };
      of.set(r.thread, [...new Set([...(of.get(r.thread) || []), id])]);
    }
  }
  return { of, products };
}

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

/**
 * The docs and links a topic's threads share (`members`: `[{ thread, org }]`), from the map's
 * fact weights (`factWeights`: `{ of, weights }`, over its `total` threads): those of two threads
 * and two customers or more, weighing MIN_WEIGHT or more, in FACT_LIFT times the share of its
 * threads as of all, the most
 * weighed by tf-idf first (the share of its threads that have it, times its weight). At most
 * `max`, each `{ key, field, label, href, threads, orgs }`. A link of one customer's threads is
 * its own site or pages, not what the topic is about.
 */
export function topicFacts(members, { of, weights }, total, { max = TOPIC_FACTS } = {}) {
  const count = new Map();
  for (const m of members) {
    for (const key of of.get(m.thread) || []) {
      const c = count.get(key) || { n: 0, orgs: new Set() };
      c.n += 1;
      if (m.org) {
        c.orgs.add(m.org);
      }
      count.set(key, c);
    }
  }
  const size = members.length || 1;
  return [...count].map(([key, c]) => {
    const w = weights.get(key);
    const share = c.n / size;
    return {
      key,
      n: c.n,
      orgs: c.orgs.size,
      weight: w.weight,
      score: share * w.weight,
      lift: share / (w.threads / total),
    };
  }).filter((x) => x.n >= 2 && x.orgs >= 2 && x.weight >= MIN_WEIGHT && x.lift >= FACT_LIFT)
    .sort((a, b) => b.score - a.score || b.n - a.n || a.key.localeCompare(b.key))
    .slice(0, max)
    .map((x) => {
      const f = factOf(x.key);
      return {
        key: x.key, field: f.field, label: f.label, href: f.href, threads: x.n, orgs: x.orgs,
      };
    });
}

export const NAMER = 'You name a topic: a group of support threads between Adobe and its'
  + ' customers about Adobe Experience Manager and Edge Delivery Services. Answer with two lines'
  + ' and nothing else. The first: a name of two to five words for what the threads have in'
  + ' common, in sentence case, as specific as they allow (for example "CDN purge and stale'
  + ' cache", not "Technical issues"). The second: one sentence on what the customers need. Name'
  + ' no customer, company, brand or person, and not Adobe, AEM or Edge Delivery Services, which'
  + ' every thread is about.';

// A theme the model mangled (src/label.js) is left out: the name stands on its own.
const themeOf = (s) => (mangled(s) ? '' : String(s || '').trim().slice(0, MAX_THEME));

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
    const label = first && first.length <= MAX_LABEL && !garbled(first)
      ? first.replace(/[.:]$/, '') : null;
    return { label, theme: label ? themeOf(rest[0]) : '' };
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
  + ' found in them, the products they name and the documentation pages and links they share'
  + ' more than other topics\' threads, with how many threads have each. A doc or a link most'
  + ' of a topic\'s threads share says what it is about (a limit, a setup guide, one pull'
  + ' request): name that, in words, not as a path or a URL. Name what sets'
  + ' each topic apart from the others: read all of them first, and give no two topics names that'
  + ' could be swapped. A name has two to five words, in sentence case (a capital first letter,'
  + ' and for names of products), and is as specific as the threads allow: name the product or'
  + ' the failure where the threads share one ("Sidekick sign-in after SSO changes", "CDN purge'
  + ` and stale cache", "Product feeds for marketplaces"). Do not use ${FILLER.map((w) => `"${w}"`).join(', ')}`
  + ' or a name every topic could have; and not "AEM", "Adobe" or "Edge Delivery" alone. A topic'
  + ' that is mostly one project names what the project is ("Storefront rebuild on Edge"). Name no'
  + ' customer or person. With each name write one sentence on what its customers need. Answer'
  + ' with JSON only: [{"id": 0, "name": "…", "theme": "…"}, …], every topic once.';

/**
 * What NAMER_ALL reads: per topic, its threads' titles, concerns, products and docs and links
 * (`facts`, topicFacts' but those of UNNAMED_FIELDS), with counts.
 */
export function namingInput(topics) {
  const counts = (list) => list.map(([name, n]) => `${name} (${n})`).join(', ') || 'none';
  return topics.map((t) => [
    `Topic ${t.id} (${t.titles.length} titles shown):`,
    ...t.titles.map((title) => `- ${title}`),
    `Concerns: ${counts(t.tags)}`,
    `Products: ${counts(t.products)}`,
    `Docs and links: ${counts((t.facts || []).filter((f) => !UNNAMED_FIELDS.has(f.field))
      .map((f) => [f.label, f.threads]))}`,
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
 * worth showing (none, too long, vague, garbled, or the same as another's).
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
      && !vague(label) && !garbled(label) && !seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      out[id] = { label, theme: themeOf(item && item.theme) };
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
 * named badly is named on its own (nameTopic). `topics`: `{ id, titles, tags, products, facts }`,
 * tags and products `[name, threads]`, the most first, facts as topicFacts makes them.
 * `{ names, model }`.
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
 * - `topics`: `{ id, label, theme, size, cohesion, at, facts }`, the biggest first (`cohesion`:
 *   the mean cosine of its threads to its centre, in the centred space; `at` its place on the
 *   page, `[x, y, z]`, src/topicspace.js; `facts` the docs and links its threads share,
 *   topicFacts).
 * - `threads`: `{ key, title, team, org, at, last, messages, kind, tags, topic, sim, staff }`, by
 *   topic, the most typical first; `tags` are Clef's topics (labels.topics), `staff` the Adobe
 *   people who posted, by id, with their messages.
 * - `people` (id → name; `a:<author_key>` for whoever is no person of D1), `orgs` (slug →
 *   `{ name, type }`), `tags` (Clef's topic ids → the names the inbox shows), `products` (id →
 *   `{ name, tech, product }`: the technologies Clef says the threads are about, `tech` the entry,
 *   `product` the product that entry is part of; a thread's `products` are their ids).
 */
export async function buildTopicMap(env, { now = new Date(), by = 'cron', seed = 1 } = {}) {
  if (!env.CONTENT || !env.AI) {
    return { error: 'a topic map needs the CONTENT index and Workers AI' };
  }
  const {
    threads, posts, memberships, orgs, products: facts, tech, facts: factRows,
  } = await threadsOf(env);
  const vectors = await vectorsOf(env, threads.map((t) => t.thread));
  const rows = threads.filter((t) => vectors.has(t.thread));
  if (rows.length < MIN_THREADS) {
    return {
      error: `${rows.length} threads with ${MIN_MESSAGES} messages or more and a vector: a topic`
        + ` map needs ${MIN_THREADS}`,
    };
  }
  const raw = rows.map((t) => vectors.get(t.thread));
  const X = centered(raw);
  const products = techProductsOf(facts, tech);
  // What the facts say of each thread, by tf-idf over the map's threads (src/factweights.js).
  const orgOf = new Map(rows.map((t) => [t.thread, t.org]));
  const weighed = factWeights(factRows.filter((f) => orgOf.has(f.thread))
    .map((f) => ({ ...f, org: orgOf.get(f.thread) })), { threads: rows.length });
  const tagNames = await areaNamesOf(env);
  // Each thread in its likeliest area (labels.topics), or in none; the topics are found within
  // each area, and none is one customer's, team's or product's concern (areaTopics).
  const areaOf = rows.map((t) => topicList(t.topics).find((id) => tagNames[id]) || '');
  const facets = {
    // A thread with no customer is nobody's concern, not one of `null`'s.
    customer: rows.map((t) => (t.org ? [t.org] : [])),
    team: rows.map((t) => (t.team ? [t.team] : [])),
    product: rows.map((t) => products.of.get(t.thread) || []),
  };
  const byArea = new Map();
  areaOf.forEach((a, i) => byArea.set(a, [...(byArea.get(a) || []), i]));
  const overall = shares(facets, rows.map((_, i) => i));
  // The areas with the most threads first; the threads in none last.
  const order = (x, y) => (x[0] ? 0 : 1) - (y[0] ? 0 : 1) || y[1].length - x[1].length;
  const found = [...byArea].sort(order)
    .flatMap(([area, idx]) => areaTopics(X, idx, facets, {
      seed, max: area ? MAX_AREA_TOPICS : MAX_NONE_TOPICS, overall,
    })
      .map((t) => ({ ...t, area: area || null })));
  const clusters = found.map((t) => t.members.map((m) => m.i));
  const sims = new Float64Array(rows.length);
  for (const t of found) {
    for (const m of t.members) {
      sims[m.i] = m.sim;
    }
  }
  const top = (list) => [...list.reduce((c, v) => c.set(v, (c.get(v) || 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  const productName = (id) => {
    const p = products.products[id];
    return (p && (p.product && p.tech ? `${p.name} (${p.product})` : p.name)) || id;
  };
  const factsOf = clusters.map((m) => topicFacts(m.map((i) => rows[i]), weighed, rows.length));
  const { names, model: namer } = await nameTopics(env, clusters.map((m, id) => ({
    id,
    facts: factsOf[id],
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
      // The area it was found in (null: the threads in none), and what the one topic an area
      // could not split is concentrated on (`customer:acme`), if it is.
      area: found[id].area,
      ...(found[id].concentrated ? { concentrated: found[id].concentrated } : {}),
      size: m.length,
      cohesion: round(m.reduce((s, i) => s + sims[i], 0) / m.length),
      // The docs and links its threads share, the most weighed first (topicFacts).
      facts: factsOf[id],
    };
  });

  const staff = new Map();
  const others = new Map();
  const people = {};
  for (const p of posts) {
    const into = p.staff ? staff : others;
    into.set(p.thread, { ...into.get(p.thread), [p.person]: p.n });
    people[p.person] = p.name || (String(p.person).startsWith('a:') ? 'Someone' : `#${p.person}`);
  }
  // Who each person is, to group them by: Adobe's by the team they are on whose threads they
  // posted in most (else their first; none when they are on no team: the channels they post in
  // are not their team), the others by the customer of most of their threads.
  const teamOf = new Map();
  for (const m of memberships) {
    teamOf.set(m.person, [...(teamOf.get(m.person) || []), m.team]);
  }
  const counts = new Map();
  rows.forEach((t) => {
    for (const p of Object.keys({ ...staff.get(t.thread), ...others.get(t.thread) })) {
      const c = counts.get(p) || new Map();
      const isStaff = Boolean(staff.get(t.thread)?.[p]);
      const k = isStaff ? `team:${t.team}` : `org:${t.org}`;
      // By threads, not messages: one long thread does not outweigh many.
      c.set(k, (c.get(k) || 0) + 1);
      counts.set(p, c);
    }
  });
  const peopleOf = {};
  for (const [p, c] of counts) {
    const isStaff = [...c.keys()].some((k) => k.startsWith('team:'));
    const best = (prefix, allowed) => [...c].filter(([k]) => k.startsWith(prefix)
      && (!allowed || allowed.includes(k.slice(prefix.length))))
      .sort((a, b) => b[1] - a[1])[0]?.[0]?.slice(prefix.length) || null;
    const teams = teamOf.get(Number(p)) || [];
    peopleOf[p] = isStaff
      ? { staff: true, team: teams.length ? best('team:', teams) || teams[0] : null }
      : { staff: false, org: best('org:') };
  }
  // Each topic's place on the page (src/topicspace.js): from what its threads say once their
  // people's, products' and customer's parts are taken out.
  const topicOf = new Array(rows.length).fill(null);
  clusters.forEach((m, topic) => m.forEach((i) => topicOf.splice(i, 1, topic)));
  const places = topicPlaces(X, topicOf, {
    people: rows.map((t) => Object.keys({ ...staff.get(t.thread), ...others.get(t.thread) })),
    products: rows.map((t) => products.of.get(t.thread) || []),
    orgs: rows.map((t) => (t.org ? [t.org] : [])),
  });
  topics.forEach((t, i) => Object.assign(t, { at: places[i] }));
  // The space the topics were found in, for the threads the map does not have (src/trends.js):
  // the mean (as `centered` took it away), each topic's centre, and a sample of raw vectors.
  const mean = new Float32Array(raw[0].length);
  for (const v of raw) {
    for (let d = 0; d < mean.length; d += 1) {
      mean[d] += v[d] / raw.length;
    }
  }
  const centres = clusters.map((m) => centroid(m.map((i) => X[i])));
  const pickSample = random(seed + 1);
  const sample = raw.map((v) => [pickSample(), v]).sort((a, b) => a[0] - b[0])
    .slice(0, SAMPLE_VECTORS).map(([, v]) => v);
  const used = new Set(rows.map((t) => t.org));
  const map = {
    // 2: topics found within areas (`topics[].area`), and everyone who posted (`customers`).
    version: 2,
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
        customers: others.get(t.thread) || {},
      };
    })),
    people,
    // Who each person is (`{ staff, team }` or `{ staff: false, org }`), to group them by.
    peopleOf,
    orgs: Object.fromEntries(orgs.filter((o) => used.has(o.slug))
      .map((o) => [o.slug, { name: o.name || o.slug, type: o.type }])),
    tags: tagNames,
    products: products.products,
  };
  const built = await env.DB.prepare(`INSERT INTO topic_maps (built_at, built_by, threads, k, map,
      vectors) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(
      map.built_at,
      by,
      rows.length,
      topics.length,
      JSON.stringify(map),
      packVectors([mean, ...centres, ...sample]),
    ).first();
  // Its threads' topics are its own; the others' the cron finds (src/trends.js assignPending).
  await saveAssignments(env, built.id, rows.map((t, i) => ({
    thread: t.thread, embedded: t.embedded, topic: topicOf[i], sim: sims[i],
  })));
  await env.DB.prepare(`DELETE FROM topic_maps WHERE id NOT IN
    (SELECT id FROM topic_maps ORDER BY built_at DESC, id DESC LIMIT ?)`).bind(KEEP).run();
  // Only the newest's space is used (src/trends.js): the older keep their maps, not it.
  await env.DB.prepare('UPDATE topic_maps SET vectors = NULL WHERE id != ? AND vectors IS NOT NULL')
    .bind(built.id).run();
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
  const row = await env.DB.prepare(`SELECT built_at AS at, vectors IS NOT NULL AS space
    FROM topic_maps ORDER BY built_at DESC, id DESC LIMIT 1`).first();
  // One from before maps kept their space is built again: the trends need it (src/trends.js).
  if (row && row.at && row.space && now.getTime() - Date.parse(row.at) < STALE_DAYS * 86400000) {
    return { fresh: row.at };
  }
  const built = await buildTopicMap(env, { now });
  return built.error ? { error: built.error } : {
    built: built.id, threads: built.threads, k: built.k,
  };
}
