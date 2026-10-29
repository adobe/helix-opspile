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
 *   npm run rank -- pull  [--n all] [--alerts 0.1] [--team <slug>]… [--own-teams] [--no-personal]
 *     The threads in your teams' inboxes and your personal view, and for the admin team every
 *     team's (read as one of its members, read-only), all of them or a random sample, as
 *     the inbox gets them (GET /api/inbox, the features), with their messages (GET /api/thread,
 *     the content). Uses the session of `npm run ui:session -- <inbox origin>`. The sample
 *     before, and what was judged on it, moves to `.rank/<when it was pulled>/`.
 *   npm run rank -- duel  [--rounds 12] [--concurrency 8]
 *     An Elo tournament, Swiss pairings: Clef reads two threads (content and what the inbox
 *     shows of them) and says which the team should turn to first, asked both ways round.
 *     More rounds add to the games already played. Needs CLOUDFLARE_ACCOUNT_ID (the Worker's
 *     account) and CLOUDFLARE_API_TOKEN, or a `wrangler login` with Workers AI.
 *   npm run rank -- train [--l2 30] [--shares …|counts] [--min-support 20] [--without …]
 *     Fits the linear model of ui/rank.js to the games, reports how often it, the old score and
 *     recency alone agree with Clef (5-fold cross-validation) and with you, and writes it into
 *     ui/rank.js. `--human <weight>` trains on your answers too, each worth that many of Clef's.
 *   npm run rank -- llm [--judges haiku,sonnet|name=<model id>,…] [--pairs 200]
 *     Claude models judge Clef's games as Clef did, both ways round, with a reason: the pairs you
 *     judged, then `--pairs` more (scripts/rank-llm.mjs). Bedrock: AWS_BEARER_TOKEN_BEDROCK.
 *   npm run rank -- compare [--trees 150] [--depth 3] [--forest-depth 5]
 *     The linear model against boosted trees and a random forest on the same games and folds
 *     (scripts/rank-trees.mjs): held-out accuracy per source, log loss, size, time to score.
 *   npm run rank -- behavior [--refresh]
 *     What the teams do: how likely a thread is to be opened, and a customer's message to be
 *     answered within a day, by what they are like; and how well each score points at the
 *     threads that were opened (scripts/rank-behavior.mjs). Writes `.rank/behavior.md`.
 *   npm run rank -- judge [--port 8796]
 *     Two threads of Clef's games side by side in the browser: you pick, then see what Clef, the
 *     model and the old score said, and how often each agrees with you (scripts/rank-judge.mjs).
 */

import { execFileSync } from 'node:child_process';
import {
  appendFile, chmod, mkdir, readFile, rename, writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROMPT_VERSION, QUESTION, agreement, bradleyTerry, elo, firstP, fit, loadClassic, loadRank,
  pairKey, pairState, random, shuffle, swiss, withModel,
} from './rank-lib.mjs';
import { agreementWithYou, judge, readHuman } from './rank-judge.mjs';
import { llm } from './rank-llm.mjs';
import { behavior } from './rank-behavior.mjs';
import { boost, forest, treeScore } from './rank-trees.mjs';
import {
  DEFAULT_SHARES, DEFAULT_WEIGHTS, SIGNS, rows, samples, shareOut,
} from './rank-combo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.rank');
const THREADS = join(DIR, 'threads.json');
const GAMES = join(DIR, 'games.jsonl');
const RATINGS = join(DIR, 'ratings.json');
const HUMAN = join(DIR, 'human.jsonl');
const LLM = join(DIR, 'llm.jsonl');
// Picks in the list (production's rank_events), kept across samples.
const EVENTS = join(DIR, 'events.jsonl');
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
  // `as`: a person the admin team reads the inbox as (x-opspile-as, read-only).
  return async (path, as = null) => {
    const headers = { cookie: s.cookie, ...(as ? { 'x-opspile-as': String(as) } : {}) };
    const r = await fetch(`${s.origin}${path}`, { headers, redirect: 'manual' });
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

/**
 * Moves the last sample and everything judged on it into `.rank/<when it was pulled>/`: the
 * games, Clef's and yours, are of that sample as it was then.
 */
async function archive() {
  if (!existsSync(THREADS)) {
    return;
  }
  const { pulledAt } = JSON.parse(await readFile(THREADS, 'utf8'));
  const to = join(DIR, new Date(pulledAt).toISOString().replace(/[:.]/g, '-'));
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const f of [THREADS, GAMES, RATINGS, HUMAN, LLM]) {
    if (existsSync(f)) {
      // eslint-disable-next-line no-await-in-loop
      await rename(f, join(to, basename(f)));
    }
  }
  console.log(`the last sample and its games → ${to}`);
}

async function pull(opts) {
  const get = await session();
  const me = await get('/api/me');
  const teams = [].concat(opts.team || (me.teams || []).map((t) => t.slug || t));
  const rnd = random(num(opts.seed, 1));
  const entries = new Map();
  const people = {};
  // Every team's inbox, and the personal view (the channels of other teams you are in).
  const views = teams.map((team) => ({ q: `team=${encodeURIComponent(team)}` }));
  if (!opts['no-personal']) {
    views.push({ q: 'view=personal' });
  }
  // The admin team sees the other teams' inboxes too, as one of their members (read-only).
  if (me.admin && !opts.team && !opts['own-teams']) {
    const { teams: all = [] } = await get('/api/admin/teams');
    for (const t of all.filter((x) => !teams.includes(x.slug))) {
      // eslint-disable-next-line no-await-in-loop
      const { members = [] } = await get(`/api/admin/team?slug=${encodeURIComponent(t.slug)}`);
      if (members.length) {
        views.push({ q: `team=${encodeURIComponent(t.slug)}`, as: members[0].id });
      }
    }
  }
  for (const view of views) {
    let before = null;
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await get(`/api/inbox?${view.q}&limit=200`
        + `${before ? `&before=${encodeURIComponent(before)}` : ''}`, view.as);
      for (const t of page.threads) {
        if (!entries.has(t.thread)) {
          entries.set(t.thread, { team: t.team, entry: t, as: view.as });
        }
      }
      Object.assign(people, page.people || {});
      before = page.page?.next;
    } while (before);
  }
  const all = [...entries.values()];
  const alerts = shuffle(all.filter((x) => x.entry.kind === 'alert'), rnd);
  const talks = shuffle(all.filter((x) => x.entry.kind !== 'alert'), rnd);
  // All of them, by default; alerts are a tenth of the sample.
  const share = num(opts.alerts, 0.1);
  const n = opts.n === undefined || opts.n === 'all'
    ? Math.round(talks.length / (1 - share)) : num(opts.n, 200);
  const nAlerts = Math.min(alerts.length, Math.round(n * share));
  const picked = [...talks.slice(0, n - nAlerts), ...alerts.slice(0, nAlerts)];
  await archive();
  const pulledAt = Date.now();
  const threads = [];
  for (let i = 0; i < picked.length; i += 8) {
    // eslint-disable-next-line no-await-in-loop
    threads.push(...await Promise.all(picked.slice(i, i + 8).map(async ({ team, entry, as }) => {
      const r = await get(`/api/thread?thread=${encodeURIComponent(entry.thread)}`
        + `${team ? `&team=${encodeURIComponent(team)}` : ''}`, as);
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
  console.log(`${threads.length} threads (${nAlerts} alerts) of ${all.length} in ${views.length} views`
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

/** Rows as the trainer takes them: feature vectors in `names` order. */
const vectors = (names, list) => list.map((r) => ({
  ...r, xa: names.map((n) => r.a[n] || 0), xb: names.map((n) => r.b[n] || 0),
}));

function fitFree(names, list, l2) {
  const vec = new Map();
  const games = list.map((r, i) => {
    vec.set(`${i}a`, r.xa);
    vec.set(`${i}b`, r.xb);
    return {
      a: `${i}a`, b: `${i}b`, p: r.p, weight: r.w,
    };
  });
  return fit(names, (k) => vec.get(k), games, { l2 });
}

/**
 * Fitted within the policy's signs (SIGNS): a weight with the wrong sign is held at 0 and the
 * rest fitted again, until none is. `held` collects the features that were.
 */
function fitRows(names, list, l2, held = new Set()) {
  let free = names.filter((n) => !held.has(n));
  const pick = (cols, x) => cols.map((i) => x[i]);
  for (;;) {
    const cols = free.map((n) => names.indexOf(n));
    const sub = list.map((r) => ({ ...r, xa: pick(cols, r.xa), xb: pick(cols, r.xb) }));
    const w = fitFree(free, sub, l2);
    const wrong = free.filter((n) => SIGNS[n] && Math.sign(w[n]) === -SIGNS[n]);
    if (!wrong.length) {
      return Object.fromEntries(names.map((n) => [n, w[n] || 0]));
    }
    wrong.forEach((n) => held.add(n));
    free = free.filter((n) => !wrong.includes(n));
  }
}

const dot = (w, names, x) => x.reduce((acc, v, i) => acc + v * w[names[i]], 0);
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1000003, 7);
/** Held out in fold f: a game about any thread of that fold; trained on: the others. */
const inFold = (f) => (r) => r.keys.some((k) => hash(k) % 5 === f);

/** Picks in the list since the last fetch, from production (admin team), into EVENTS. */
async function events() {
  const get = await session();
  const have = await (async () => {
    if (!existsSync(EVENTS)) {
      return [];
    }
    return (await readFile(EVENTS, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  })();
  let since = have.length ? have[have.length - 1].id : 0;
  let added = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await get(`/api/rank/events?since=${since}`);
    if (page.events.length) {
      // eslint-disable-next-line no-await-in-loop
      await appendFile(EVENTS, page.events.map((e) => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
      added += page.events.length;
      since = page.events[page.events.length - 1].id;
    }
    if (!page.next) {
      break;
    }
  }
  console.log(`${added} new picks, ${have.length + added} in all → ${EVENTS}`);
}

async function readEvents() {
  if (!existsSync(EVENTS)) {
    return [];
  }
  return (await readFile(EVENTS, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * The combo model (scripts/rank-combo.mjs): your judgements, Sonnet's, Haiku's and Clef's,
 * one per pair in that order; picks in the list; replies, faster over slower. A Bradley–Terry
 * model whose strength is the linear score of ui/rank.js, fitted by pairwise logistic
 * regression, with five folds held out by thread (or by pick) to say how well it does.
 */
/** The games of every source, weighted, as feature vectors (`names`), for train and compare. */
async function trainingSet(opts) {
  const source = await readFile(RANK_JS, 'utf8');
  const Rank = loadRank(source);
  const without = new Set(String(opts.without || '').split(',').filter(Boolean));
  let names = Rank.names.filter((n) => !without.has(n));
  const weights = { ...DEFAULT_WEIGHTS };
  for (const kv of String(opts.weights || '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    weights[k] = Number(v);
  }
  const all = await samples(DIR);
  if (!all.length) {
    throw new Error('no sample: run `npm run rank -- pull` first');
  }
  // `--shares counts` weighs every game the same (per source by `--weights`); else each source
  // is its share of the training (`--shares click=0.3,…`, DEFAULT_SHARES).
  const shares = { ...DEFAULT_SHARES };
  const asked = opts.shares === 'counts' ? '' : opts.shares || '';
  for (const kv of String(asked).split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    shares[k] = Number(v);
  }
  const raw = rows({
    Rank, samples: all, events: await readEvents(), weights,
  }).filter((r) => r.w > 0);
  // A feature seen in too few threads (or picks) is not learned: its weight would be a guess.
  const items = new Set(raw.flatMap((r) => [r.a, r.b]));
  const support = (n) => [...items].filter((f) => f[n]).length;
  const minSupport = num(opts['min-support'], 20);
  const rare = names.filter((n) => support(n) < minSupport);
  if (rare.length) {
    console.log(`not learned, in fewer than ${minSupport} threads: ${rare.join(', ')}`);
  }
  names = names.filter((n) => !rare.includes(n));
  const list = vectors(names, opts.shares === 'counts' ? raw : shareOut(raw, shares));
  if (list.length < 50) {
    throw new Error(`${list.length} games: run \`npm run rank -- duel\` first`);
  }
  return {
    source, Rank, names, list, all,
  };
}

async function train(opts) {
  const {
    source, Rank, names, list, all,
  } = await trainingSet(opts);
  // The hand-made score, for the judged pairs (the sample's time is when it was pulled).
  const classicOf = new Map(all.map((s) => {
    const c = loadClassic(s.data.pulledAt);
    return [s.data.pulledAt, new Map(s.data.threads.map((t) => [t.key, c(t.entry)]))];
  }));
  const l2 = num(opts.l2, 30);
  const sources = [...new Set(list.map((r) => r.source))];
  const count = Object.fromEntries(sources
    .map((k) => [k, list.filter((r) => r.source === k).length]));
  const counts = Object.entries(count).map(([k, n]) => `${k} ${n}`).join(', ');
  console.log(`${list.length} games from ${all.length} samples: ${counts}`);
  const held = Object.fromEntries(sources.map((k) => [k, { model: [], classic: [] }]));
  for (let f = 0; f < 5; f += 1) {
    const w = fitRows(names, list.filter((r) => !inFold(f)(r)), l2);
    for (const k of sources) {
      const test = list.filter((r) => inFold(f)(r) && r.source === k);
      if (test.length) {
        const ids = new Map(test.map((r, i) => [`${i}`, r]));
        const s = (key) => {
          const [i, side] = [key.slice(0, -1), key.slice(-1)];
          const r = ids.get(i);
          return dot(w, names, side === 'a' ? r.xa : r.xb);
        };
        held[k].model.push({
          ...agreement(s, test.map((r, i) => ({ a: `${i}a`, b: `${i}b`, p: r.p }))),
          n: test.length,
        });
        const judged = test.filter((r) => r.ids);
        if (judged.length) {
          const c = (r, side) => classicOf.get(r.snap).get(r.ids[side === 'a' ? 0 : 1]);
          held[k].classic.push({
            ...agreement(
              (key) => {
                const r = judged[Number(key.slice(0, -1))];
                return c(r, key.slice(-1));
              },
              judged.map((r, i) => ({ a: `${i}a`, b: `${i}b`, p: r.p })),
            ),
            n: judged.length,
          });
        }
      }
    }
  }
  const mean = (xs, k) => {
    const n = xs.reduce((acc, x) => acc + (x.decided ?? x.n), 0);
    return n ? xs.reduce((acc, x) => acc + x[k] * (x.decided ?? x.n), 0) / n : NaN;
  };
  const report = Object.fromEntries(sources.map((k) => [k, {
    games: count[k],
    model: Number(mean(held[k].model, 'accuracy').toFixed(3)),
    'old score': held[k].classic.length ? Number(mean(held[k].classic, 'accuracy').toFixed(3)) : null,
  }]));
  console.log('How often each picks the winner, on threads (or picks) it was not trained on:');
  console.table(report);
  // The judges against you, sample by sample.
  for (const smp of all.filter((x) => x.human.length)) {
    const none = { model: () => 0, classic: () => 0 };
    const you = agreementWithYou(smp.human, smp.games, none, smp.llm);
    const share = (b) => (b.n ? `${Math.round((100 * b.agree) / b.n)}% of ${b.n}` : '–');
    console.log(`You, ${new Date(smp.data.pulledAt).toISOString().slice(0, 10)}: Clef ${share(you.clef)}, `
      + `${Object.entries(you.judges).map(([k, b]) => `${k} ${share(b)}`).join(', ')}`);
  }
  const pinned = new Set();
  const w = fitRows(names, list, l2, pinned);
  if (pinned.size) {
    console.log(`held at 0, as the games would turn them against the policy (SIGNS): ${[...pinned].join(', ')}`);
  }
  console.log('weights (log-odds per unit):');
  for (const [k, v] of Object.entries(w).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
    console.log(`  ${k.padEnd(18)} ${v >= 0 ? ' ' : ''}${v.toFixed(3)}`);
  }
  const model = {
    trained: new Date().toISOString().slice(0, 10),
    games: Object.fromEntries(Object.entries(count)),
    accuracy: Object.fromEntries(Object.entries(report).map(([k, r]) => [k, r.model])),
    weights: Object.fromEntries(Rank.names.map((k) => [k, Number((w[k] || 0).toFixed(4))])),
  };
  if (opts['dry-run']) {
    return model;
  }
  await writeFile(RANK_JS, withModel(source, model));
  console.log(`→ ${RANK_JS}`);
  return model;
}

async function judgeStep(o) {
  await judge({
    port: num(o.port, 8796),
    threadsFile: THREADS,
    gamesFile: GAMES,
    humanFile: HUMAN,
    llmFile: LLM,
    readGames,
  });
}

async function llmStep(o) {
  await llm(o, {
    threadsFile: THREADS, humanFile: HUMAN, llmFile: LLM, readGames, readHuman,
  });
}

async function behaviorStep(o) {
  const report = await behavior(o, {
    threadsFile: THREADS, outFile: join(DIR, 'behavior.md'), ratingsFile: RATINGS, get: await session(),
  });
  console.log(report);
}

const run = (cmd, args, extra = {}) => execFileSync(cmd, args, {
  cwd: ROOT, stdio: 'inherit', ...extra,
});

/**
 * The linear model against boosted trees and a random forest (scripts/rank-trees.mjs), on the
 * same games and folds as train: how often each picks the winner of each source's games it was
 * not trained on, its log loss, how big it is and how long it takes to score a thread.
 */
async function compare(opts) {
  const { names, list } = await trainingSet(opts);
  const l2 = num(opts.l2, 30);
  const trees = num(opts.trees, 150);
  const sources = [...new Set(list.map((r) => r.source))];
  const models = {
    linear: (games) => {
      const w = fitRows(names, games, l2);
      return { score: (r, side) => dot(w, names, side === 'a' ? r.xa : r.xb), json: w };
    },
    'linear, free signs': (games) => {
      const w = fitFree(names, games, l2);
      return { score: (r, side) => dot(w, names, side === 'a' ? r.xa : r.xb), json: w };
    },
    'boosted trees': (games) => {
      const m = boost(names, games, { trees, depth: num(opts.depth, 3) });
      return { score: (r, side) => treeScore(m, side === 'a' ? r.a : r.b), json: m };
    },
    'random forest': (games) => {
      const m = forest(names, games, { trees, depth: num(opts['forest-depth'], 5) });
      return { score: (r, side) => treeScore(m, side === 'a' ? r.a : r.b), json: m };
    },
  };
  const results = {};
  for (const [name, make] of Object.entries(models)) {
    const per = Object.fromEntries(sources.map((k) => [k, []]));
    const t0 = Date.now();
    let last = null;
    for (let f = 0; f < 5; f += 1) {
      const m = make(list.filter((r) => !inFold(f)(r)));
      last = m;
      for (const k of sources) {
        const test = list.filter((r) => inFold(f)(r) && r.source === k);
        if (test.length) {
          const s = (key) => m.score(test[Number(key.slice(0, -1))], key.slice(-1));
          per[k].push(agreement(s, test.map((r, i) => ({ a: `${i}a`, b: `${i}b`, p: r.p }))));
        }
      }
    }
    const fitMs = (Date.now() - t0) / 5;
    const probe = list.slice(0, 2000);
    const t1 = process.hrtime.bigint();
    for (const r of probe) {
      last.score(r, 'a');
    }
    const scoreUs = Number(process.hrtime.bigint() - t1) / 1000 / probe.length;
    const avg = (xs, k) => {
      const n = xs.reduce((acc, x) => acc + x.decided, 0);
      return n ? xs.reduce((acc, x) => acc + x[k] * x.decided, 0) / n : NaN;
    };
    results[name] = {
      ...Object.fromEntries(sources.map((k) => [k, `${Math.round(avg(per[k], 'accuracy') * 1000) / 10}%`])),
      'log loss': Number((Object.values(per).flat().reduce((acc, x) => acc + x.logloss, 0)
        / Object.values(per).flat().length).toFixed(3)),
      size: `${Math.round(JSON.stringify(last.json).length / 100) / 10} KB`,
      'fit (s)': Number((fitMs / 1000).toFixed(1)),
      'score (µs)': Number(scoreUs.toFixed(1)),
    };
    process.stdout.write(`${name} done\n`);
  }
  console.log('How often each picks the winner of each source\'s games, held out (5 folds):');
  console.table(results);
  return results;
}

/**
 * The new weights as a pull request against main, from a worktree of origin/main, so the
 * checkout the job runs in is left as it is. Only when main computes the same features.
 */
async function propose(model, trained) {
  const day = model.trained;
  const branch = `rank/weekly-${day}`;
  const tree = join(DIR, `pr-${day}`);
  const git = (...args) => run('git', args);
  git('fetch', '-q', 'origin', 'main');
  git('worktree', 'add', '-q', '-B', branch, tree, 'origin/main');
  try {
    const file = join(tree, 'ui', 'rank.js');
    const main = await readFile(file, 'utf8');
    const code = (src) => withModel(src, null);
    if (code(main) !== code(trained)) {
      throw new Error('main computes other features than this checkout: update it, then train again');
    }
    await writeFile(file, trained);
    const games = Object.entries(model.games).map(([k, n]) => `${k} ${n}`).join(', ');
    const acc = Object.entries(model.accuracy)
      .map(([k, a]) => `${k} ${Math.round(a * 100)}%`).join(', ');
    const title = `chore(rank): the team order, trained ${day}`;
    const at = (...args) => run('git', ['-C', tree, ...args]);
    at('add', 'ui/rank.js');
    at('commit', '-q', '-m', `${title}\n\nGames: ${games}.\nHeld out, it picks the winner: ${acc}.`);
    at('push', '-q', '-f', '-u', 'origin', branch);
    run('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body',
      'The weekly retraining of the team order (`npm run rank -- weekly`).\n\n'
      + `- Games: ${games}\n- On threads (or picks) it was not trained on, it picks the winner: ${acc}\n\n`
      + 'Only the weights in `ui/rank.js` change. Merge and deploy to use them.'], { cwd: tree });
  } finally {
    git('worktree', 'remove', '--force', tree);
  }
}

/**
 * Once a week (a bb automation runs it): a fresh session from the signed-in browser, the
 * picks since last time, a new sample (the last one, with everything judged on it, is kept in
 * `.rank/<when>/` and trained on still), Clef's tournament on it, the Claude judges on a part
 * of it (with AWS_BEARER_TOKEN_BEDROCK), then the combo model trained on all of it. With
 * `--pr`, the new weights go to a pull request against main, for a person to look at and merge.
 */
async function weekly(o) {
  const sess = JSON.parse(await readFile(join(ROOT, '.dev-ui-session.json'), 'utf8').catch(() => '{}'));
  const origin = o.origin || sess.origin;
  if (!origin) {
    throw new Error('no inbox origin: run `npm run ui:session -- <origin>` once, or pass --origin');
  }
  run(process.execPath, ['scripts/dev-ui-session.mjs', origin]);
  // Production may not record picks yet (before the deploy of migration 0040).
  await events().catch((e) => console.log(`no picks this week: ${e.message}`));
  await pull({ ...o, n: o.n });
  await duel({ ...o, rounds: o.rounds || 12 });
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
    await llmStep({ ...o, pairs: o.pairs || 150 });
  } else {
    console.log('no AWS_BEARER_TOKEN_BEDROCK: no Claude judges this week');
  }
  const before = await readFile(RANK_JS, 'utf8');
  const model = await train(o);
  const after = await readFile(RANK_JS, 'utf8');
  if (o.pr && after !== before) {
    await propose(model, after);
  }
}

const opts = options(process.argv.slice(2));
const step = {
  pull,
  duel,
  train,
  compare,
  judge: judgeStep,
  llm: llmStep,
  behavior: behaviorStep,
  events,
  weekly,
}[opts._[0]];
if (!step) {
  console.error('usage: npm run rank -- pull|duel|llm|judge|events|train|compare|behavior|weekly [options]'
    + ' (see scripts/rank.mjs)');
  process.exitCode = 1;
} else {
  step(opts).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
