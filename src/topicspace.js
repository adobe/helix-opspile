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
 * Where the Topics page puts each topic in its space (ui/topicspace.js): three coordinates,
 * from what the topic's threads say once who said it, about which product and for whom is
 * taken out.
 *
 * A thread's vector is mostly its topic, but also its people, its products and its customer: a
 * team's threads read alike, and so do one customer's. Taken as the plain mean of its threads, a
 * topic sits where its people and its customers are as much as where its subject is, and the
 * topics that share people sit together whatever they are about. So every thread is fitted as
 * the sum of a part for its topic, one for each person who posted, one for each product and one
 * for its customer (ridge regression, each part shrunk by n / (n + RIDGE) for its n threads,
 * solved by coordinate descent, one entity at a time, which costs a pass over the threads per
 * sweep), and the topics are placed by their own parts: the first three principal components,
 * scaled so that the farthest topic is 1 from the middle.
 *
 * On the production threads (835, Nov 2026), the main Adobe poster of a thread could be told from
 * its vector 52% of the time, and from what is left once the people's, products' and customer's
 * parts are taken out 17% (chance: 22%); its customer 77% and 21% (26%); its topic 52% and 46%.
 */

/** How much a part is shrunk towards nothing: by n / (n + RIDGE), for its n threads. */
export const RIDGE = 1;
/** Passes of coordinate descent: the parts move by less than a percent after these. */
export const SWEEPS = 10;
const POWER_ITERATIONS = 200;

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    s += a[i] * b[i];
  }
  return s;
}

/**
 * The part of each entity of `facets` in vectors `X` (unit, centred): `facets` is a list of
 * blocks, each an array with, per thread, the keys of its entities in that block. The first
 * block's parts are returned, as a Map key → Float64Array.
 */
export function parts(X, facets, { ridge = RIDGE, sweeps = SWEEPS } = {}) {
  const d = X[0].length;
  const R = X.map((x) => Float64Array.from(x));
  const blocks = facets.map((block) => {
    const members = new Map();
    block.forEach((keys, i) => {
      for (const k of new Set(keys)) {
        if (!members.has(k)) {
          members.set(k, []);
        }
        members.get(k).push(i);
      }
    });
    return [...members].map(([key, idx]) => ({ key, idx, c: new Float64Array(d) }));
  });
  for (let s = 0; s < sweeps; s += 1) {
    for (const entities of blocks) {
      for (const e of entities) {
        const sum = new Float64Array(d);
        for (const i of e.idx) {
          const r = R[i];
          for (let j = 0; j < d; j += 1) {
            sum[j] += r[j] + e.c[j];
          }
        }
        const shrink = 1 / (e.idx.length + ridge);
        for (let j = 0; j < d; j += 1) {
          sum[j] *= shrink;
        }
        for (const i of e.idx) {
          const r = R[i];
          for (let j = 0; j < d; j += 1) {
            r[j] += e.c[j] - sum[j];
          }
        }
        e.c = sum;
      }
    }
  }
  return new Map(blocks[0].map((e) => [e.key, e.c]));
}

/**
 * The first `dims` principal components of `vectors` (each a row), as coordinates: per row, its
 * scores, by power iteration on the rows' Gram matrix (k × k, for k rows), deflated after each.
 */
export function principal(vectors, dims = 3) {
  const k = vectors.length;
  const d = vectors[0].length;
  const mean = new Float64Array(d);
  for (const v of vectors) {
    for (let j = 0; j < d; j += 1) {
      mean[j] += v[j] / k;
    }
  }
  const C = vectors.map((v) => Float64Array.from(v, (x, j) => x - mean[j]));
  const G = C.map((a) => C.map((b) => dot(a, b)));
  const out = Array.from({ length: k }, () => new Array(dims).fill(0));
  for (let c = 0; c < dims && c < k; c += 1) {
    // The same start every time: the same threads make the same space.
    let u = Array.from({ length: k }, (_, i) => 1 + ((i * 7919) % 13) / 13);
    let value = 0;
    for (let it = 0; it < POWER_ITERATIONS; it += 1) {
      const v = u;
      const next = G.map((row) => dot(row, v));
      const norm = Math.sqrt(dot(next, next));
      if (!norm) {
        break;
      }
      value = norm;
      u = next.map((x) => x / norm);
    }
    // Scores: u times the square root of its eigenvalue; the biggest of them positive, so a map
    // built again from the same threads is not mirrored.
    const big = u.reduce((b, x, i) => (Math.abs(x) > Math.abs(u[b]) ? i : b), 0);
    const sign = u[big] < 0 ? -1 : 1;
    const scale = Math.sqrt(value) * sign;
    u.forEach((x, i) => out[i].splice(c, 1, x * scale));
    for (let i = 0; i < k; i += 1) {
      for (let j = 0; j < k; j += 1) {
        G[i][j] -= value * u[i] * u[j];
      }
    }
  }
  return out;
}

/**
 * Each topic's place, `[x, y, z]` with the farthest 1 from the middle: `X` the threads' unit,
 * centred vectors, `topicOf` each thread's topic (an index), `people`, `products` and `orgs` per
 * thread the keys of its people, its products and its customer.
 */
export function topicPlaces(X, topicOf, { people = [], products = [], orgs = [] } = {}) {
  const n = X.length;
  const none = () => [];
  const own = parts(X, [
    topicOf.map((t) => (t === null || t === undefined ? [] : [t])),
    people.length ? people : Array.from({ length: n }, none),
    products.length ? products : Array.from({ length: n }, none),
    orgs.length ? orgs : Array.from({ length: n }, none),
  ]);
  const k = Math.max(-1, ...topicOf.filter((t) => t !== null && t !== undefined)) + 1;
  const d = X[0].length;
  const unitOf = (v) => {
    const norm = Math.sqrt(dot(v, v)) || 1;
    return Float64Array.from(v, (x) => x / norm);
  };
  const vectors = Array.from({ length: k }, (_, t) => unitOf(own.get(t) || new Float64Array(d)));
  if (k < 2) {
    return vectors.map(() => [0, 0, 0]);
  }
  const coords = principal(vectors, 3);
  const far = Math.max(1e-9, ...coords.map((c) => Math.hypot(...c)));
  // No -0: it is 0 once the map is JSON.
  return coords.map((c) => c.map((x) => Math.round((x / far) * 1000) / 1000 || 0));
}
