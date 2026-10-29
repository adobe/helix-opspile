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
 * Tree models of the team order, next to the linear one: a score per thread, a sum (boosted
 * trees) or a mean (random forest) of small regression trees over the features, learned from
 * the same games with the same pairwise loss (σ(score a − score b) is "a first").
 *
 * - boost: gradient boosting, each tree a Newton step on the pairwise logistic loss
 *   (RankNet with trees, as LambdaMART without the list metric).
 * - forest: a random forest of such steps from zero, each on a bootstrap of the games and a
 *   random part of the features, averaged; then scaled to log-odds.
 *
 * A tree is `[f, t, l, r]` (feature index into the model's `names`, threshold: x[f] <= t goes
 * left) or a number (a leaf), so a model is plain JSON the browser (ui/rank.js) can walk, or D1
 * as nested CASE expressions. `monotone` (feature → 1 or −1) keeps a feature's effect one way,
 * as XGBoost does: a split on it must order its leaves so, and bounds what grows below.
 */

import { random } from './rank-lib.mjs';

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** The distinct threads (feature objects) of the games, and the games by their index. */
export function itemize(names, list) {
  const index = new Map();
  const X = [];
  const id = (o) => {
    if (!index.has(o)) {
      index.set(o, X.length);
      X.push(names.map((n) => o[n] || 0));
    }
    return index.get(o);
  };
  const pairs = list.map((r) => ({
    i: id(r.a), j: id(r.b), p: r.p, w: r.w,
  }));
  return { X, pairs };
}

/** Per thread: the gradient and hessian of the pairwise loss at scores F. */
function gradients(F, pairs, n) {
  const g = new Float64Array(n);
  const h = new Float64Array(n);
  for (const {
    i, j, p, w,
  } of pairs) {
    const s = sigmoid(F[i] - F[j]);
    const d = w * (s - p);
    const q = w * Math.max(s * (1 - s), 1e-6);
    g[i] += d;
    g[j] -= d;
    h[i] += q;
    h[j] += q;
  }
  return { g, h };
}

/** Each feature's threads in order of their value, once, for every split to scan. */
function presort(X, d) {
  return Array.from({ length: d }, (_, f) => X.map((_, i) => i).sort((a, b) => X[a][f] - X[b][f]));
}

/**
 * A regression tree on (g, h): each leaf the Newton step −G / (H + λ), within [lo, hi], splits
 * where they lower the loss most, down to `depth`, with at least `minH` hessian a side.
 */
function grow(X, g, h, sorted, members, opts, lo = -Infinity, hi = Infinity) {
  const {
    depth, lambda, minH, features, mono,
  } = opts;
  let G = 0;
  let Hs = 0;
  for (let i = 0; i < members.length; i += 1) {
    if (members[i]) {
      G += g[i];
      Hs += h[i];
    }
  }
  const clip = (w) => Math.min(hi, Math.max(lo, w));
  const loss = (gs, hs, w) => gs * w + 0.5 * (hs + lambda) * w * w;
  const here = clip(-G / (Hs + lambda));
  if (depth === 0 || Hs < 2 * minH) {
    return here;
  }
  const parent = loss(G, Hs, here);
  let best = null;
  for (const f of features) {
    const sign = mono[f] || 0;
    let gl = 0;
    let hl = 0;
    let prev = null;
    for (const i of sorted[f]) {
      if (members[i]) {
        const x = X[i][f];
        if (prev !== null && x > prev && hl >= minH && Hs - hl >= minH) {
          const wl = clip(-gl / (hl + lambda));
          const wr = clip(-(G - gl) / (Hs - hl + lambda));
          if (!sign || sign * (wr - wl) >= 0) {
            const gain = parent - loss(gl, hl, wl) - loss(G - gl, Hs - hl, wr);
            if (!best || gain > best.gain) {
              best = {
                gain, f, t: (prev + x) / 2, wl, wr,
              };
            }
          }
        }
        gl += g[i];
        hl += h[i];
        prev = x;
      }
    }
  }
  if (!best || best.gain <= 1e-9) {
    return here;
  }
  const left = new Uint8Array(members.length);
  const right = new Uint8Array(members.length);
  for (let i = 0; i < members.length; i += 1) {
    if (members[i]) {
      (X[i][best.f] <= best.t ? left : right)[i] = 1;
    }
  }
  const below = { ...opts, depth: depth - 1 };
  let [ll, lh, rl, rh] = [lo, hi, lo, hi];
  const sign = mono[best.f] || 0;
  if (sign) {
    const mid = (best.wl + best.wr) / 2;
    if (sign > 0) {
      lh = mid;
      rl = mid;
    } else {
      ll = mid;
      rh = mid;
    }
  }
  return [best.f, best.t, grow(X, g, h, sorted, left, below, ll, lh),
    grow(X, g, h, sorted, right, below, rl, rh)];
}

export function predict(node, x) {
  let n = node;
  while (Array.isArray(n)) {
    n = x[n[0]] <= n[1] ? n[2] : n[3];
  }
  return n;
}

const scale = (node, k) => (Array.isArray(node)
  ? [node[0], node[1], scale(node[2], k), scale(node[3], k)] : node * k);

const round = (node) => (Array.isArray(node)
  ? [node[0], Number(node[1].toFixed(4)), round(node[2]), round(node[3])]
  : Number(node.toFixed(4)));

const monotone = (names, signs = {}) => Object.fromEntries(names
  .map((n, f) => [f, signs[n] || 0]).filter(([, v]) => v));

/** Boosted trees: `trees` Newton steps of `rate`, each on all games. */
export function boost(names, list, {
  trees = 150, depth = 3, rate = 0.1, lambda = 5, minH = 2, colsample = 1, seed = 3, signs = {},
} = {}) {
  const mono = monotone(names, signs);
  const { X, pairs } = itemize(names, list);
  const sorted = presort(X, names.length);
  const rnd = random(seed);
  const F = new Float64Array(X.length);
  const out = [];
  const all = new Uint8Array(X.length).fill(1);
  for (let t = 0; t < trees; t += 1) {
    const { g, h } = gradients(F, pairs, X.length);
    const features = names.map((_, f) => f).filter(() => rnd() < colsample);
    const tree = scale(grow(X, g, h, sorted, all, {
      depth, lambda, minH, mono, features: features.length ? features : [0],
    }), rate);
    for (let i = 0; i < X.length; i += 1) {
      F[i] += predict(tree, X[i]);
    }
    out.push(round(tree));
  }
  return { kind: 'boost', names, trees: out };
}

/** A random forest: one Newton step from zero per tree, on a bootstrap and part of the features. */
export function forest(names, list, {
  trees = 150, depth = 5, lambda = 5, minH = 2, colsample = 0.5, seed = 3, signs = {},
} = {}) {
  const mono = monotone(names, signs);
  const { X, pairs } = itemize(names, list);
  const sorted = presort(X, names.length);
  const rnd = random(seed);
  const out = [];
  const zero = new Float64Array(X.length);
  for (let t = 0; t < trees; t += 1) {
    const sample = pairs.map(() => pairs[Math.floor(rnd() * pairs.length)]);
    const { g, h } = gradients(zero, sample, X.length);
    const members = Uint8Array.from(h, (x) => (x > 0 ? 1 : 0));
    const features = names.map((_, f) => f).filter(() => rnd() < colsample);
    out.push(grow(X, g, h, sorted, members, {
      depth, lambda, minH, mono, features: features.length ? features : [0],
    }));
  }
  // The mean of the steps, scaled to log-odds by one weight fitted on the games (Newton).
  const mean = (x) => out.reduce((s, tr) => s + predict(tr, x), 0) / out.length;
  const m = X.map(mean);
  let k = 1;
  for (let it = 0; it < 30; it += 1) {
    let gk = 0;
    let hk = 0;
    for (const {
      i, j, p, w,
    } of pairs) {
      const dx = m[i] - m[j];
      const s = sigmoid(k * dx);
      gk += w * (s - p) * dx;
      hk += w * s * (1 - s) * dx * dx;
    }
    k -= gk / (hk + 1e-9);
  }
  // A negative scale would turn every monotone feature around: kept at 0 or above.
  const kk = Math.max(0, k);
  return { kind: 'forest', names, trees: out.map((tr) => round(scale(tr, kk / out.length))) };
}

/** A tree model's score of a thread's features (an object by name). */
export function treeScore(model, features) {
  const x = model.names.map((n) => features[n] || 0);
  return model.trees.reduce((s, tr) => s + predict(tr, x), 0);
}
