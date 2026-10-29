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
 * The parts of scripts/rank.mjs that need no network: how a pair of threads is put to Clef,
 * the Elo tournament's pairings and updates, Bradley–Terry ratings, and the model's training
 * (pairwise logistic regression on the features of ui/rank.js).
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const UI = new URL('../ui/', import.meta.url);

/** ui/rank.js, run as the browser runs it: its global `Rank`. */
export function loadRank(source = readFileSync(new URL('rank.js', UI), 'utf8')) {
  const context = { Math, Date, Object };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.Rank;
}

/**
 * The inbox's hand-made within-pile score (`classicScore` in ui/inbox.js) for nobody in particular,
 * at `now`: what the model is measured against.
 */
export function loadClassic(now, source = readFileSync(new URL('inbox.js', UI), 'utf8')) {
  const from = (a, b) => {
    const i = source.indexOf(a);
    const j = source.indexOf(b, i);
    if (i < 0 || j < 0) {
      throw new Error(`${a} not found in ui/inbox.js`);
    }
    return source.slice(i, j);
  };
  const code = [
    from('const lastOf', '\n'),
    from('const checked', '\nconst viewerId'),
    from('function closeness', '\nconst tpl'),
  ].join('\n');
  class At extends Date {
    static now() { return now; }
  }
  // eslint-disable-next-line no-new-func
  return new Function('Date', 'viewerId', 'teamIds', 'signals', `${code}\nreturn classicScore;`)(
    At,
    () => null,
    () => new Set(),
    () => ({}),
  );
}

// ---------------------------------------------------------------- what Clef is asked

/** The team's policy, as Clef is told it. */
export const POLICY = 'Two threads from the inbox of an Adobe ops team that supports customers,'
  + ' partners and vendors on Slack, Microsoft Teams and Discord. Which one should the team turn to'
  + ' first? Work that waits on Adobe comes before work that waits on the customer; production'
  + ' impact, security problems and customers who have waited long come first. A thread that is'
  + ' resolved, or where nothing is pending (thanks, FYI, social), comes last, however recent'
  + ' its last message is. Alert channels carry the automated posts of monitoring bots, most of'
  + ' them routine (errors in visitors\' browsers, single failed requests): an alert comes before'
  + ' a person waiting on Adobe only when it shows a site down or broadly failing and nobody at'
  + ' Adobe has read it.';

export const QUESTION = {
  first: {
    type: 'choice',
    instructions: POLICY,
    criteria: { a: 'Thread A first', b: 'Thread B first' },
  },
};

/** Bumped whenever what Clef is shown changes: earlier judgements are then asked again. */
export const PROMPT_VERSION = 2;

const MAX_BODY = 1500;
const BUDGET = 9000;

function ago(ms) {
  const h = ms / 3600000;
  if (h < 1) {
    return `${Math.max(1, Math.round(h * 60))} min ago`;
  }
  if (h < 48) {
    return `${Math.round(h)} h ago`;
  }
  return `${Math.round(h / 24)} days ago`;
}

const URGENCY = ['low', 'normal', 'high', 'critical'];

/** What the inbox shows of a thread, in a line: the features, in words. */
export function summary(t, now) {
  const lab = t.label || {};
  const lastAt = Date.parse(t.kind === 'alert' ? t.any_at : t.last_at || t.any_at);
  const parts = [];
  if (t.kind === 'alert') {
    parts.push('an alert channel (bot posts)');
  }
  if (lastAt) {
    parts.push(`last message ${ago(now - lastAt)}${t.kind === 'alert' ? ''
      : ` by ${t.last_staff ? 'Adobe staff' : 'the customer'}`}`);
  }
  if (t.kind !== 'alert') {
    parts.push(`waits on: ${t.waiting_on || 'nobody'}`);
  }
  if (lab.urgency != null) {
    parts.push(`urgency: ${URGENCY[Math.min(3, Math.round(lab.urgency))]}`);
  }
  if (t.resolution?.verdict === 'resolved') {
    parts.push('resolved (✅ by Adobe staff)');
  } else if (lab.resolved_p != null) {
    parts.push(`resolved: ${lab.resolved_p >= 0.5 ? 'probably' : 'probably not'}`);
  }
  if (lab.label_kind) {
    parts.push(`kind: ${lab.label_kind}`);
  }
  if (t.unseenByAdobe) {
    parts.push('nobody at Adobe has read the latest');
  }
  const staff = (t.signals || []).filter((x) => x.staff);
  if (staff.some((x) => x.signal === 'seen')) {
    parts.push('👀 by Adobe staff (someone is on it)');
  }
  if (staff.some((x) => x.signal === 'help')) {
    parts.push('🛟 by Adobe staff (they ask the team for help)');
  }
  if (t.draft) {
    parts.push('a reply is drafted');
  }
  const root = Date.parse(t.root_at);
  parts.push(`${t.messages || 0} messages${root ? `, started ${ago(now - root)}` : ''}`);
  return parts.join(' · ');
}

function who(m) {
  const a = m.author || {};
  if (a.kind && a.kind !== 'person') {
    return `${a.name || a.kind} (${a.kind})`;
  }
  return `${a.name || 'someone'} (${a.staff ? 'Adobe staff' : `customer${a.org ? `, ${a.org}` : ''}`})`;
}

function reactions(m, staffByName) {
  const list = (m.reactions || []).flatMap((r) => (r.names?.length ? r.names : ['someone'])
    .map((n) => `:${r.emoji}: by ${n}${staffByName.get(n) ? ' (Adobe staff)' : ''}`));
  return list.length ? `\nReactions: ${list.join(', ')}` : '';
}

/**
 * A thread as Clef reads it: where it is, the summary line, then its first message and as
 * many of the latest as fit.
 */
export function render(rec, now, staffByName = new Map()) {
  const t = rec.entry;
  const block = (m) => `[${m.at}] ${who(m)}:\n${String(m.body || '').slice(0, MAX_BODY)}`
    + `${reactions(m, staffByName)}`;
  const live = (rec.messages || []).filter((m) => !m.deletedAt);
  const head = [
    `Channel: ${t.channel_name || '?'} · Customer: ${t.org_name || t.org}${t.org_type ? ` (${t.org_type})` : ''}`,
    t.title ? `Title: ${t.title}` : null,
    `In the inbox: ${summary(t, now)}`,
  ].filter(Boolean).join('\n');
  if (!live.length) {
    return `${head}\n\n(no messages)`;
  }
  const first = block(live[0]);
  const tail = [];
  let left = BUDGET - first.length;
  for (let i = live.length - 1; i > 0; i -= 1) {
    const b = block(live[i]);
    if (b.length > left) {
      break;
    }
    tail.unshift(b);
    left -= b.length;
  }
  const skipped = live.length - 1 - tail.length;
  return [head, first, skipped ? `(${skipped} messages left out)` : null, ...tail]
    .filter(Boolean).join('\n\n');
}

/** The state of one question to Clef: thread `a` as A, `b` as B. */
export function pairState(a, b, now, staffByName) {
  return `Now: ${new Date(now).toISOString()}\n\n=== Thread A ===\n${render(a, now, staffByName)}`
    + `\n\n=== Thread B ===\n${render(b, now, staffByName)}`;
}

/** Clef's answer to QUESTION as the probability that A comes first. */
export function firstP(answer) {
  const a = answer?.answers?.first;
  if (!a) {
    return null;
  }
  if (a.probabilities) {
    return a.probabilities.a ?? 1 - (a.probabilities.b ?? 0.5);
  }
  return a.choice === 'a' ? (a.confidence ?? 1) : 1 - (a.confidence ?? 1);
}

// ---------------------------------------------------------------- the tournament

export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** A seeded random number generator (Park–Miller), so a run can be repeated. */
export function random(seed = 1) {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function shuffle(xs, rnd) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const expected = (ra, rb) => 1 / (1 + 10 ** ((rb - ra) / 400));

/** Elo after a game where `s` (0..1) is how much a won. */
export function elo(ra, rb, s, k = 24) {
  const e = expected(ra, rb);
  return [ra + k * (s - e), rb - k * (s - e)];
}

/**
 * A Swiss round: every thread meets the nearest-rated one it has not met yet (a little jitter,
 * so equal ratings do not always pair the same way). Odd one out sits the round out.
 */
export function swiss(ids, rating, met, rnd, { window = 12, jitter = 30 } = {}) {
  const order = ids.map((id) => [id, (rating.get(id) ?? 1500) + (rnd() - 0.5) * jitter])
    .sort((x, y) => y[1] - x[1]).map(([id]) => id);
  const free = new Set(order);
  const pairs = [];
  for (let i = 0; i < order.length; i += 1) {
    const a = order[i];
    if (free.has(a)) {
      free.delete(a);
      let b = null;
      for (let j = i + 1; j < order.length && j <= i + window && !b; j += 1) {
        if (free.has(order[j]) && !met.has(pairKey(a, order[j]))) {
          b = order[j];
        }
      }
      if (!b) {
        b = order.find((x) => free.has(x) && !met.has(pairKey(a, x))) || null;
      }
      if (b) {
        free.delete(b);
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

/**
 * Bradley–Terry ratings (Elo scale, mean 1500) from soft outcomes `{ a, b, p }` (p: a won),
 * with a weak prior that keeps a thread that only won or only lost finite.
 */
export function bradleyTerry(ids, games, { iterations = 2000, prior = 0.05, rate = 0.5 } = {}) {
  const idx = new Map(ids.map((id, i) => [id, i]));
  const th = new Float64Array(ids.length);
  const n = new Float64Array(ids.length);
  for (const g of games) {
    n[idx.get(g.a)] += 1;
    n[idx.get(g.b)] += 1;
  }
  for (let it = 0; it < iterations; it += 1) {
    const grad = new Float64Array(ids.length);
    for (const g of games) {
      const i = idx.get(g.a);
      const j = idx.get(g.b);
      const e = 1 / (1 + Math.exp(th[j] - th[i]));
      grad[i] += g.p - e;
      grad[j] -= g.p - e;
    }
    for (let i = 0; i < th.length; i += 1) {
      th[i] += (rate * (grad[i] - prior * th[i])) / (n[i] + 1);
    }
  }
  const mean = th.reduce((s, x) => s + x, 0) / (th.length || 1);
  return new Map(ids.map((id, i) => [id, 1500 + ((th[i] - mean) * 400) / Math.LN10]));
}

// ---------------------------------------------------------------- the model

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** Solves A x = b (A symmetric positive definite, small) by Gaussian elimination. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) {
      if (Math.abs(M[r][c]) > Math.abs(M[p][c])) {
        p = r;
      }
    }
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r += 1) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k += 1) {
        M[r][k] -= f * M[c][k];
      }
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k += 1) {
      s -= M[r][k] * x[k];
    }
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * Pairwise logistic regression (RankNet with a linear scorer): weights `w` such that
 * σ(w·(f(a) − f(b))) is Clef's p, with an L2 penalty `l2` on standardized features. Fitted by
 * Newton's method. `vec` maps an id to its feature vector (in `names` order).
 */
export function fit(names, vec, games, { l2 = 1, iterations = 30 } = {}) {
  const d = names.length;
  const all = [...new Set(games.flatMap((g) => [g.a, g.b]))].map(vec);
  const sd = names.map((_, k) => {
    const m = all.reduce((s, v) => s + v[k], 0) / (all.length || 1);
    const v = all.reduce((s, x) => s + (x[k] - m) ** 2, 0) / (all.length || 1);
    return Math.sqrt(v) || 1;
  });
  const rows = games.map((g) => {
    const a = vec(g.a);
    const b = vec(g.b);
    return { x: names.map((_, k) => (a[k] - b[k]) / sd[k]), y: g.p, w: g.weight ?? 1 };
  });
  let w = new Array(d).fill(0);
  for (let it = 0; it < iterations; it += 1) {
    const g = w.map((x) => l2 * x);
    const Hm = names.map((_, i) => names.map((__, j) => (i === j ? l2 : 0)));
    for (const r of rows) {
      let z = 0;
      for (let k = 0; k < d; k += 1) {
        z += r.x[k] * w[k];
      }
      const s = sigmoid(z);
      const q = r.w * s * (1 - s);
      for (let i = 0; i < d; i += 1) {
        g[i] += r.w * (s - r.y) * r.x[i];
        for (let j = 0; j < d; j += 1) {
          Hm[i][j] += q * r.x[i] * r.x[j];
        }
      }
    }
    const step = solve(Hm, g);
    w = w.map((x, k) => x - step[k]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) {
      break;
    }
  }
  return Object.fromEntries(names.map((n, k) => [n, w[k] / sd[k]]));
}

/** How well `score` (id → number) agrees with Clef on `games`: log loss and accuracy. */
export function agreement(score, games) {
  let loss = 0;
  let right = 0;
  let decided = 0;
  for (const g of games) {
    const s = Math.min(1 - 1e-6, Math.max(1e-6, sigmoid(score(g.a) - score(g.b))));
    loss -= g.p * Math.log(s) + (1 - g.p) * Math.log(1 - s);
    if (Math.abs(g.p - 0.5) >= 0.1) {
      decided += 1;
      right += (s > 0.5) === (g.p > 0.5) ? 1 : 0;
    }
  }
  return { logloss: loss / (games.length || 1), accuracy: right / (decided || 1), decided };
}

/** Spearman's rank correlation of two lists. */
export function spearman(xs, ys) {
  const ranks = (v) => {
    const order = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(v.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) {
        j += 1;
      }
      for (let k = i; k <= j; k += 1) {
        r[order[k][1]] = (i + j) / 2;
      }
      i = j + 1;
    }
    return r;
  };
  const a = ranks(xs);
  const b = ranks(ys);
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

/** A value as the source of ui/rank.js writes it (the style the linter wants). */
function literal(v, indent = '  ') {
  if (v && typeof v === 'object') {
    const inner = `${indent}  `;
    const rows = Object.entries(v).map(([k, x]) => `${inner}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${literal(x, inner)},`);
    return `{\n${rows.join('\n')}\n${indent}}`;
  }
  return typeof v === 'string' ? `'${v.replace(/[\\']/g, '\\$&')}'` : String(v);
}

/** ui/rank.js with `model` as its MODEL. */
export function withModel(source, model) {
  const re = /(\/\/ MODEL:[^\n]*\n)[\s\S]*?(\n\s*\/\/ END MODEL)/;
  if (!re.test(source)) {
    throw new Error('ui/rank.js has no MODEL block');
  }
  return source.replace(re, (all, head, end) => `${head}  const MODEL = ${literal(model)};${end}`);
}
