#!/usr/bin/env node
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
 * Learns the team order from Clef. Three steps, each reading what the one before wrote in
 * `.rank/` (not committed: it holds production threads, read-only):
 *
 *   npm run rank -- pull  [--n 200] [--alerts 0.1] [--team <slug>]… [--seed 1]
 *     A random sample of the threads in your teams' inboxes, as the inbox gets them
 *     (GET /api/inbox, the features), with their messages (GET /api/thread, the content).
 *     Uses the session of `npm run ui:session -- <inbox origin>`.
 *   npm run rank -- duel  [--rounds 12] [--concurrency 8]
 *     An Elo tournament, Swiss pairings: Clef reads two threads (content and what the inbox
 *     shows of them) and says which the team should turn to first, asked both ways round.
 *     More rounds add to the games already played. Needs CLOUDFLARE_ACCOUNT_ID (the Worker's
 *     account) and CLOUDFLARE_API_TOKEN, or a `wrangler login` with Workers AI.
 *   npm run rank -- train [--l2 3] [--dry-run]
 *     Fits the linear model of ui/rank.js to the games, reports how often it, the old score and
 *     recency alone agree with Clef (5-fold cross-validation), and writes it into ui/rank.js.
 */

import { execFileSync } from 'node:child_process';
import {
  appendFile, chmod, mkdir, readFile, writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROMPT_VERSION, QUESTION, agreement, bradleyTerry, elo, firstP, fit, loadClassic, loadRank,
  pairKey, pairState, random, shuffle, spearman, swiss, withModel,
} from './rank-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.rank');
const THREADS = join(DIR, 'threads.json');
const GAMES = join(DIR, 'games.jsonl');
const RATINGS = join(DIR, 'ratings.json');
const RANK_JS = join(ROOT, 'ui', 'rank.js');
const CLEF = '@cf/cloudflare/clef';

function options(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
      out[k] = k in out ? [].concat(out[k], v) : v;
    } else {
      out._.push(a);
    }
  }
  return out;
}

const num = (v, d) => (v === undefined || v === true ? d : Number(v));

async function secretFile(path, data) {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  await writeFile(path, data, { mode: 0o600 });
  await chmod(path, 0o600);
}

// ---------------------------------------------------------------- pull

async function session() {
  const file = join(ROOT, '.dev-ui-session.json');
  if (!existsSync(file)) {
    throw new Error('no session: run `npm run ui:session -- <inbox origin>` first');
  }
  const s = JSON.parse(await readFile(file, 'utf8'));
  return async (path) => {
    const r = await fetch(`${s.origin}${path}`, { headers: { cookie: s.cookie }, redirect: 'manual' });
    if (r.status !== 200) {
      throw new Error(`${path.split('?')[0]}: ${r.status}${r.status === 302 ? ' (sign in again, then ui:session)' : ''}`);
    }
    return r.json();
  };
}

/** What a message is to Clef: no avatars, raw payloads or edit rights. */
const slim = (m) => ({
  id: m.id,
  at: m.at,
  deletedAt: m.deletedAt || null,
  author: m.author ? {
    kind: m.author.kind, name: m.author.name, staff: m.author.staff, org: m.author.org,
  } : null,
  body: m.body,
  reactions: (m.reactions || []).map((r) => ({ emoji: r.emoji, names: r.names || [] })),
});

async function pull(opts) {
  const get = await session();
  const me = await get('/api/me');
  const teams = [].concat(opts.team || (me.teams || []).map((t) => t.slug || t));
  const rnd = random(num(opts.seed, 1));
  const entries = new Map();
  const people = {};
  for (const team of teams) {
    let before = null;
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await get(`/api/inbox?team=${encodeURIComponent(team)}&limit=200`
        + `${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      for (const t of page.threads) {
        if (!entries.has(t.thread)) {
          entries.set(t.thread, { team, entry: t });
        }
      }
      Object.assign(people, page.people || {});
      before = page.page?.next;
    } while (before);
  }
  const n = num(opts.n, 200);
  const all = [...entries.values()];
  const alerts = shuffle(all.filter((x) => x.entry.kind === 'alert'), rnd);
  const talks = shuffle(all.filter((x) => x.entry.kind !== 'alert'), rnd);
  const nAlerts = Math.min(alerts.length, Math.round(n * num(opts.alerts, 0.1)));
  const picked = [...talks.slice(0, n - nAlerts), ...alerts.slice(0, nAlerts)];
  const pulledAt = Date.now();
  const threads = [];
  for (let i = 0; i < picked.length; i += 8) {
    // eslint-disable-next-line no-await-in-loop
    threads.push(...await Promise.all(picked.slice(i, i + 8).map(async ({ team, entry }) => {
      const r = await get(`/api/thread?thread=${encodeURIComponent(entry.thread)}&team=${encodeURIComponent(team)}`);
      return {
        key: entry.thread, team, entry, messages: (r.messages || []).map(slim),
      };
    })));
    process.stdout.write(`\r${threads.length}/${picked.length} threads`);
  }
  process.stdout.write('\n');
  const staff = Object.fromEntries(Object.values(people).filter((p) => p.name)
    .map((p) => [p.name, Boolean(p.staff)]));
  await secretFile(THREADS, JSON.stringify({
    pulledAt, teams, staff, threads,
  }));
  console.log(`${threads.length} threads (${nAlerts} alerts) of ${all.length} in ${teams.length} inboxes`
    + ` → ${THREADS}`);
}

// ---------------------------------------------------------------- duel

function clef(opts) {
  const account = opts.account || process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    throw new Error('set CLOUDFLARE_ACCOUNT_ID to the Worker\'s account');
  }
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    const out = execFileSync('npx', ['wrangler', 'auth', 'token', '--json'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'],
    });
    token = JSON.parse(out).token;
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${CLEF}`;
  return async function ask(state, tries = 5) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'clef', state, questions: QUESTION }),
    });
    if ((r.status === 429 || r.status >= 500) && tries > 1) {
      await new Promise((ok) => {
        setTimeout(ok, 2000 * (6 - tries));
      });
      return ask(state, tries - 1);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) {
      throw new Error(`Clef: ${r.status} ${JSON.stringify(j.errors || j)}`);
    }
    return firstP(j.result);
  };
}

async function readGames() {
  if (!existsSync(GAMES)) {
    return [];
  }
  return (await readFile(GAMES, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((g) => g.v === PROMPT_VERSION);
}

async function pool(items, size, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function duel(opts) {
  const data = JSON.parse(await readFile(THREADS, 'utf8'));
  const byKey = new Map(data.threads.map((t) => [t.key, t]));
  const ids = [...byKey.keys()];
  const staff = new Map(Object.entries(data.staff || {}));
  const ask = clef(opts);
  const games = (await readGames()).filter((g) => byKey.has(g.a) && byKey.has(g.b));
  const rating = new Map(ids.map((id) => [id, 1500]));
  const met = new Set();
  const play = (g) => {
    const [ra, rb] = elo(rating.get(g.a), rating.get(g.b), g.p);
    rating.set(g.a, ra);
    rating.set(g.b, rb);
    met.add(pairKey(g.a, g.b));
  };
  games.forEach(play);
  const rnd = random(num(opts.seed, 1) + games.length);
  const rounds = num(opts.rounds, 12);
  let spread = 0;
  let fresh = 0;
  for (let round = 1; round <= rounds; round += 1) {
    const pairs = swiss(ids, rating, met, rnd);
    let done = 0;
    // eslint-disable-next-line no-await-in-loop
    const played = await pool(pairs, num(opts.concurrency, 8), async ([a, b]) => {
      const [ab, ba] = await Promise.all([
        ask(pairState(byKey.get(a), byKey.get(b), data.pulledAt, staff)),
        ask(pairState(byKey.get(b), byKey.get(a), data.pulledAt, staff)),
      ]);
      done += 1;
      process.stdout.write(`\rround ${round}/${rounds}: ${done}/${pairs.length}`);
      // Asked both ways round, so where a thread is shown does not decide.
      return {
        v: PROMPT_VERSION, a, b, ab, ba, p: (ab + (1 - ba)) / 2,
      };
    });
    for (const g of played) {
      spread += Math.abs(g.ab - (1 - g.ba));
      fresh += 1;
      play(g);
      games.push(g);
    }
    // eslint-disable-next-line no-await-in-loop
    await appendFile(GAMES, played.map((g) => `${JSON.stringify(g)}\n`).join(''), { mode: 0o600 });
    process.stdout.write('\n');
  }
  const bt = bradleyTerry(ids, games);
  await secretFile(RATINGS, JSON.stringify(Object.fromEntries(
    [...bt].sort((x, y) => y[1] - x[1])
      .map(([k, r]) => [k, { bt: Math.round(r), elo: Math.round(rating.get(k)) }]),
  ), null, 1));
  console.log(`${games.length} games (${fresh} new${fresh ? `; swapping A and B moved Clef's p by ${(spread / fresh).toFixed(2)} on average` : ''}) → ${RATINGS}`);
}

// ---------------------------------------------------------------- train

async function train(opts) {
  const data = JSON.parse(await readFile(THREADS, 'utf8'));
  const byKey = new Map(data.threads.map((t) => [t.key, t]));
  const games = (await readGames()).filter((g) => byKey.has(g.a) && byKey.has(g.b));
  if (games.length < 50) {
    throw new Error(`${games.length} games: run \`npm run rank -- duel\` first`);
  }
  const source = await readFile(RANK_JS, 'utf8');
  const Rank = loadRank(source);
  const { names } = Rank;
  const vectors = new Map([...byKey].map(([k, t]) => {
    const f = Rank.features(t.entry, data.pulledAt);
    return [k, names.map((n) => f[n])];
  }));
  const vec = (k) => vectors.get(k);
  const l2 = num(opts.l2, 3);
  const classic = loadClassic(data.pulledAt);
  const baseline = {
    classic: (k) => classic(byKey.get(k).entry),
    recency: (k) => Rank.features(byKey.get(k).entry, data.pulledAt).recent2d,
  };
  // Cross-validation by threads: trained on the games among four fifths of them, tested on
  // every game of the other fifth, so the scores are for threads the model has not seen.
  const rnd = random(7);
  const fold = new Map(shuffle([...byKey.keys()], rnd).map((k, i) => [k, i % 5]));
  const scores = { model: [], classic: [], recency: [] };
  for (let f = 0; f < 5; f += 1) {
    const trainSet = games.filter((g) => fold.get(g.a) !== f && fold.get(g.b) !== f);
    const test = games.filter((g) => fold.get(g.a) === f || fold.get(g.b) === f);
    const w = fit(names, vec, trainSet, { l2 });
    const s = (k) => vec(k).reduce((acc, x, i) => acc + x * w[names[i]], 0);
    scores.model.push(agreement(s, test));
    // The baselines have no scale of their own: fitted on the train folds, a weight each.
    for (const b of ['classic', 'recency']) {
      const wb = fit(['x'], (k) => [baseline[b](k)], trainSet, { l2: 0.01 });
      scores[b].push(agreement((k) => wb.x * baseline[b](k), test));
    }
  }
  const mean = (list, k) => list.reduce((s, x) => s + x[k], 0) / list.length;
  const weights = fit(names, vec, games, { l2 });
  const ids = [...byKey.keys()];
  const bt = bradleyTerry(ids, games);
  const modelScore = (k) => vec(k).reduce((acc, x, i) => acc + x * weights[names[i]], 0);
  const rho = (s) => spearman(ids.map(s), ids.map((k) => bt.get(k)));
  const report = Object.fromEntries(Object.entries(scores).map(([k, list]) => [k, {
    accuracy: Number(mean(list, 'accuracy').toFixed(3)),
    logloss: Number(mean(list, 'logloss').toFixed(3)),
  }]));
  console.table(report);
  console.log(`Spearman vs Clef's ratings: model ${rho(modelScore).toFixed(3)}, classic ${rho(baseline.classic).toFixed(3)}, recency ${rho(baseline.recency).toFixed(3)}`);
  console.log('weights (log-odds per unit):');
  for (const [k, w] of Object.entries(weights).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
    console.log(`  ${k.padEnd(16)} ${w >= 0 ? ' ' : ''}${w.toFixed(3)}`);
  }
  const model = {
    trained: new Date().toISOString().slice(0, 10),
    threads: ids.length,
    games: games.length,
    accuracy: report.model.accuracy,
    classicAccuracy: report.classic.accuracy,
    weights: Object.fromEntries(Object.entries(weights).map(([k, w]) => [k, Number(w.toFixed(4))])),
  };
  if (opts['dry-run']) {
    return;
  }
  await writeFile(RANK_JS, withModel(source, model));
  console.log(`→ ${RANK_JS}`);
}

const opts = options(process.argv.slice(2));
const step = { pull, duel, train }[opts._[0]];
if (!step) {
  console.error('usage: npm run rank -- pull|duel|train [options] (see scripts/rank.mjs)');
  process.exitCode = 1;
} else {
  step(opts).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
