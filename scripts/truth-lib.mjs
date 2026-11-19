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
 * The parts of scripts/truth.mjs that need no network: the seeded, stratified sample, the
 * marks' shape, ids through `tech_moves`, and the scores (precision and recall of "uses" and
 * "about", the hub share, the long-tail recall).
 */

import { productKey } from '../src/products.js';

/** A thread's layer when nothing was seen on it. */
export const NO_LAYER = 'none';

/* eslint-disable no-bitwise, operator-assignment -- mulberry32 works on 32-bit integers */
/** A seeded random number generator (mulberry32), from a string. */
export function random(seed) {
  let h = 1779033703;
  for (const c of String(seed)) {
    h = Math.imul(h ^ c.codePointAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* eslint-enable no-bitwise, operator-assignment */

/** `list` in an order `rand` decides (Fisher–Yates), as a new array. */
export function shuffle(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * `n` split over groups of the sizes given (`{ key: size }`), by size ** power, by largest
 * remainder, no group more than its size: `{ key: count }`. Every group that has any gets at
 * least one while `n` allows.
 */
export function allocate(sizes, n, power = 0.5) {
  const keys = Object.keys(sizes).filter((k) => sizes[k] > 0).sort();
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  let left = Math.min(n, keys.reduce((s, k) => s + sizes[k], 0));
  for (const k of [...keys].sort((a, b) => sizes[b] - sizes[a] || a.localeCompare(b))) {
    if (left > 0) {
      out[k] = 1;
      left -= 1;
    }
  }
  while (left > 0) {
    const open = keys.filter((k) => out[k] < sizes[k]);
    const weight = open.reduce((s, k) => s + sizes[k] ** power, 0);
    const rest = left;
    const want = open.map((k) => ({ k, share: (rest * sizes[k] ** power) / weight }));
    let given = 0;
    for (const { k, share } of want) {
      const add = Math.min(Math.floor(share), sizes[k] - out[k]);
      out[k] += add;
      given += add;
    }
    if (given === 0) {
      const best = want.sort((a, b) => (b.share % 1) - (a.share % 1) || a.k.localeCompare(b.k))[0];
      out[best.k] += 1;
      given = 1;
    }
    left -= given;
  }
  return out;
}

/**
 * The layer a thread is sampled in: the rarest (in the population) of the layers of what it
 * shows, so the small layers get threads; NO_LAYER when it shows nothing.
 *
 * @param {string[]} layers the thread's layers
 * @param {Record<string, number>} counts threads per layer in the population
 */
export function stratumLayer(layers, counts) {
  if (!layers.length) {
    return NO_LAYER;
  }
  return [...layers].sort((a, b) => (counts[a] || 0) - (counts[b] || 0) || a.localeCompare(b))[0];
}

/**
 * The sample: `n` threads, split over teams (by size ** power), within a team over layers the
 * same way, drawn at random from `seed`, with no customer above `cap` threads. Where a
 * stratum runs out (or its customers are at the cap), its team's other layers fill in, then
 * the other teams.
 *
 * @param {{ thread: string, team: string, org: string, layers: string[] }[]} population
 * @returns {{ picked: object[], plan: Record<string, Record<string, number>> }}
 */
export function drawSample(population, {
  n = 150, seed = 'truth', cap = Math.ceil(n / 10), power = 0.5,
} = {}) {
  const rand = random(seed);
  const layerCounts = {};
  for (const t of population) {
    for (const l of t.layers.length ? t.layers : [NO_LAYER]) {
      layerCounts[l] = (layerCounts[l] || 0) + 1;
    }
  }
  const sorted = [...population].sort((a, b) => a.thread.localeCompare(b.thread));
  const strata = new Map();
  for (const t of sorted) {
    const key = `${t.team}\u0000${stratumLayer(t.layers, layerCounts)}`;
    strata.set(key, [...(strata.get(key) || []), t]);
  }
  for (const [key, list] of strata) {
    strata.set(key, shuffle(list, rand));
  }
  const teamSizes = {};
  for (const t of sorted) {
    teamSizes[t.team] = (teamSizes[t.team] || 0) + 1;
  }
  const perTeam = allocate(teamSizes, n, power);
  const plan = {};
  const picked = [];
  const byOrg = {};
  const taken = new Set();
  const take = (t, layer) => {
    if (taken.has(t.thread) || (byOrg[t.org] || 0) >= cap) {
      return false;
    }
    taken.add(t.thread);
    byOrg[t.org] = (byOrg[t.org] || 0) + 1;
    picked.push({ ...t, stratum: layer });
    return true;
  };
  const layersOf = (team) => [...strata.keys()].filter((k) => k.startsWith(`${team}\u0000`))
    .map((k) => k.split('\u0000')[1]);
  let short = 0;
  for (const team of Object.keys(perTeam)) {
    const sizes = Object.fromEntries(layersOf(team)
      .map((l) => [l, strata.get(`${team}\u0000${l}`).length]));
    plan[team] = allocate(sizes, perTeam[team], power);
    let want = 0;
    for (const [layer, count] of Object.entries(plan[team])) {
      let got = 0;
      for (const t of strata.get(`${team}\u0000${layer}`)) {
        if (got >= count) {
          break;
        }
        got += take(t, layer) ? 1 : 0;
      }
      want += count - got;
    }
    // A stratum that ran out: the team's other layers, in their random order.
    for (const layer of Object.keys(plan[team])) {
      for (const t of strata.get(`${team}\u0000${layer}`)) {
        if (want <= 0) {
          break;
        }
        want -= take(t, layer) ? 1 : 0;
      }
    }
    short += want;
  }
  // Still short: any team, the largest first.
  for (const [key, list] of [...strata].sort((a, b) => b[1].length - a[1].length)) {
    for (const t of list) {
      if (short <= 0) {
        break;
      }
      short -= take(t, key.split('\u0000')[1]) ? 1 : 0;
    }
  }
  return { picked, plan };
}

/**
 * The map of ids that moved (`tech_moves` rows `{ team, old, tech }`): old → new, the admin
 * team's first, followed to the end of a chain.
 */
export function movesMap(rows = [], globalTeam = 'admin') {
  const direct = new Map();
  for (const r of [...rows].sort((a, b) => (b.team === globalTeam) - (a.team === globalTeam))) {
    if (!direct.has(r.old) && r.old !== r.tech) {
      direct.set(r.old, r.tech);
    }
  }
  const resolve = (id) => {
    let at = id;
    const seen = new Set([at]);
    while (direct.has(at) && !seen.has(direct.get(at))) {
      at = direct.get(at);
      seen.add(at);
    }
    return at;
  };
  return { resolve, size: direct.size };
}

/** An id as it is now: through `moves` (movesMap) when there are any. */
export const mapId = (id, moves) => (moves ? moves.resolve(id) : id);

/**
 * A thread's marks as sets: `uses` (everything it uses, the `about` ones too) and `about`.
 * Marks are `{ tech: { <id>: 'uses' | 'about' }, missing: [{ name }], own: [..], note }`.
 */
export function markSets(mark, moves = null) {
  const uses = new Set();
  const about = new Set();
  for (const [id, how] of Object.entries(mark?.tech || {})) {
    const now = mapId(id, moves);
    if (how === 'uses' || how === 'about') {
      uses.add(now);
    }
    if (how === 'about') {
      about.add(now);
    }
  }
  return { uses, about };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * A label's technologies (`labels.tech`: `{ <id>: p }`, or `{ <id>: { p, about } }`), and
 * `thread_tech` rows, as sets: `uses` at `min` or above; `about` where the label says so, else
 * null (a pipeline that does not tell "about" apart; the score then takes its `uses`).
 */
export function labelSets(tech, rows = [], { min = 0.8, moves = null } = {}) {
  const uses = new Set();
  let about = null;
  const value = typeof tech === 'string' ? safeJson(tech) : tech;
  for (const [id, v] of Object.entries(value && typeof value === 'object' ? value : {})) {
    const p = typeof v === 'number' ? v : Number(v?.p ?? v?.uses);
    if (p >= min) {
      uses.add(mapId(id, moves));
    }
    if (v && typeof v === 'object' && v.about !== undefined) {
      about = about || new Set();
      if (Number(v.about) >= min) {
        about.add(mapId(id, moves));
      }
    }
  }
  for (const r of rows) {
    if (r.p >= min) {
      uses.add(mapId(r.tech, moves));
    }
  }
  return { uses, about };
}

const ratio = (a, b) => (b ? a / b : null);
/** F1 of a precision and a recall: 0 when both are 0 (nothing right), null when one is unknown. */
const f1 = (p, r) => {
  if (p === null || r === null) {
    return null;
  }
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
};

/**
 * Precision and recall of a pipeline against the marks, per entry and overall, for one
 * relation (`uses` or `about`).
 *
 * @param {Map<string, Set<string>>} truth the marked ids per thread
 * @param {Map<string, Set<string>>} guess the pipeline's ids per thread (missing: none)
 * @param {string[]} vocabulary the ids scored; others the pipeline names are counted apart
 */
export function scoreRelation(truth, guess, vocabulary) {
  const vocab = new Set(vocabulary);
  const per = Object.fromEntries(vocabulary.map((id) => [id, {
    tp: 0, fp: 0, fn: 0, truth: 0, guess: 0,
  }]));
  let outside = 0;
  for (const [thread, want] of truth) {
    const got = guess.get(thread) || new Set();
    for (const id of got) {
      if (!vocab.has(id)) {
        outside += 1;
      } else {
        per[id].guess += 1;
        per[id][want.has(id) ? 'tp' : 'fp'] += 1;
      }
    }
    for (const id of want) {
      if (vocab.has(id)) {
        per[id].truth += 1;
        if (!got.has(id)) {
          per[id].fn += 1;
        }
      }
    }
  }
  const sum = (k) => Object.values(per).reduce((s, e) => s + e[k], 0);
  for (const e of Object.values(per)) {
    e.precision = ratio(e.tp, e.tp + e.fp);
    e.recall = ratio(e.tp, e.tp + e.fn);
    e.f1 = f1(e.precision, e.recall);
  }
  const tp = sum('tp');
  const fp = sum('fp');
  const fn = sum('fn');
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const supported = Object.values(per).filter((e) => e.truth > 0);
  const macroRecall = supported.length
    ? supported.reduce((s, e) => s + e.recall, 0) / supported.length : null;
  const named = Object.values(per).filter((e) => e.guess > 0);
  const macroPrecision = named.length
    ? named.reduce((s, e) => s + e.precision, 0) / named.length : null;
  return {
    per,
    overall: {
      tp, fp, fn, precision, recall, f1: f1(precision, recall), macroPrecision, macroRecall,
    },
    outside,
    threads: truth.size,
  };
}

/**
 * The hub share: per id, the share of the threads that name it (`sets`, a Map of thread →
 * Set), largest first.
 */
export function hubShare(sets, threads = sets.size) {
  const count = {};
  for (const ids of sets.values()) {
    for (const id of ids) {
      count[id] = (count[id] || 0) + 1;
    }
  }
  return Object.entries(count).map(([id, n]) => ({ id, n, share: ratio(n, threads) }))
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
}

/** Whether two product names are the same one: by productKey, or one in the other as words. */
export function sameProduct(a, b) {
  const x = productKey(a);
  const y = productKey(b);
  if (!x || !y) {
    return false;
  }
  // One in the other as words: a name of two words or more, or the first word of the other
  // ("Jira" in "Jira Software", not "Cloud" in "Zeta Cloud").
  const inside = (short, long) => ` ${long} `.includes(` ${short} `)
    && (short.includes(' ') || long.startsWith(`${short} `));
  return x === y || inside(x, y) || inside(y, x);
}

/**
 * The long-tail recall: of the `missing` names marked (products no entry covered when they
 * were marked), how many a pipeline covers in that thread. `covers(thread, name)` says it does.
 */
export function longTail(marks, covers) {
  let names = 0;
  let hit = 0;
  const hits = [];
  for (const [thread, mark] of Object.entries(marks)) {
    for (const m of mark.missing || []) {
      const name = typeof m === 'string' ? m : m.name;
      if (name) {
        names += 1;
        if (covers(thread, name)) {
          hit += 1;
          hits.push(name);
        }
      }
    }
  }
  return {
    names, hit, recall: ratio(hit, names), hits,
  };
}

/** A number as a percentage with no decimals, or "–". */
export const pct = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
