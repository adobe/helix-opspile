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
 * The games the combo model learns from, each "thread a before thread b, with probability p",
 * with the features of both as they were then, a weight and where it comes from:
 *
 * - judges: the pairs of every sample (`.rank/` and the ones archived in `.rank/<when>/`),
 *   each decided by the one who ranks highest of those who judged it: you, then Sonnet, then
 *   Haiku, then Clef.
 * - clicks: each thread clicked in the list wins over the others on screen then
 *   (`rank_events`, fetched into `.rank/events.jsonl`); over those above it fully, over those
 *   below it less, as they may not have been looked at.
 * - replies: when the same person answers several customers on the same day, the customer
 *   answered sooner wins over the one answered later; each thread as it was when its customer
 *   wrote.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROMPT_VERSION, pairKey } from './rank-lib.mjs';

/** Who decides a pair, highest first. */
export const AUTHORITY = ['human', 'sonnet', 'haiku', 'clef'];

export const DEFAULT_WEIGHTS = {
  human: 4, sonnet: 2, haiku: 1.5, clef: 1, click: 1, below: 0.3, reply: 1,
};

/**
 * How much of the training each source is, whatever its number of games: Clef plays thousands
 * of games, you judge a hundred, so by count Clef would decide. A source with no games gives its
 * share to the others.
 */
export const DEFAULT_SHARES = {
  human: 0.15, sonnet: 0.2, haiku: 0.05, click: 0.3, reply: 0.2, clef: 0.1,
};

/**
 * The team's policy, as signs the model must keep: resolved lowers a thread, waiting on us and a
 * customer's first message nobody answered raise it. In the linear model a weight the games
 * would turn the other way is held at 0 (and said so); boosted trees are monotone in them.
 */
export const SIGNS = {
  resolved: -1,
  checked: -1,
  resolvedRecent: -1,
  waitsOnUs: 1,
  waitsOnUsLong: 1,
  // Waiting on the customer comes after waiting on us; an open urgent thread before a calm one.
  waitsOnThem: -1,
  openUrgency: 1,
  // Urgency raises a thread: picks below the critical and hot piles pass urgent threads over.
  urgency: 1,
  unseenUrgency: 1,
  firstWaiting: 1,
  firstWaitingLong: 1,
  unseenByAdobe: 1,
};

/** Each row's weight scaled so every source adds up to its share (of the rows' count). */
export function shareOut(list, shares = DEFAULT_SHARES) {
  const total = new Map();
  for (const r of list) {
    total.set(r.source, (total.get(r.source) || 0) + r.w);
  }
  const present = [...total.keys()].filter((k) => shares[k] > 0);
  const sum = present.reduce((acc, k) => acc + shares[k], 0);
  return list.filter((r) => shares[r.source] > 0).map((r) => ({
    ...r, w: (r.w / total.get(r.source)) * (shares[r.source] / sum) * list.length,
  }));
}

const H = 3600000;
const lines = async (file) => (existsSync(file)
  ? (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The samples: the current one and the archived ones, each with what was judged on it. */
export async function samples(dir) {
  const dirs = [dir, ...(existsSync(dir) ? (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => join(dir, d.name)) : [])];
  const out = [];
  for (const d of dirs) {
    const file = join(d, 'threads.json');
    if (existsSync(file)) {
      // eslint-disable-next-line no-await-in-loop
      const data = JSON.parse(await readFile(file, 'utf8'));
      out.push({
        dir: d,
        data,
        // eslint-disable-next-line no-await-in-loop
        games: (await lines(join(d, 'games.jsonl'))).filter((g) => g.v === PROMPT_VERSION),
        // eslint-disable-next-line no-await-in-loop
        human: (await lines(join(d, 'human.jsonl'))).filter((h) => h.snap === data.pulledAt),
        // eslint-disable-next-line no-await-in-loop
        llm: (await lines(join(d, 'llm.jsonl')))
          .filter((x) => x.snap === data.pulledAt && x.v === PROMPT_VERSION),
      });
    }
  }
  return out;
}

/**
 * One label per pair: yours over Sonnet's over Haiku's over Clef's. `p` is "a first", for the
 * pair as Clef's game names it.
 */
export function decide(games, human, llm) {
  const by = new Map();
  const put = (a, b, p, source) => {
    const k = pairKey(a, b);
    const was = by.get(k);
    const pa = a < b ? p : 1 - p;
    if (!was || AUTHORITY.indexOf(source) < AUTHORITY.indexOf(was.source)) {
      by.set(k, {
        a: a < b ? a : b, b: a < b ? b : a, p: pa, source,
      });
    }
  };
  games.forEach((g) => put(g.a, g.b, g.p, 'clef'));
  llm.forEach((x) => AUTHORITY.includes(x.judge) && put(x.a, x.b, x.p, x.judge));
  human.filter((h) => h.pick !== 'skip').forEach((h) => put(h.a, h.b, h.p, 'human'));
  return [...by.values()];
}

const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1000003, 7);

/** The fold a thread is held out in: by its key, the same in every source and sample. */
export const foldOf = (key, folds = 5) => hash(key) % folds;

/**
 * Whether a game is held out in fold `f`: it is about a thread of that fold. Trained on are the
 * games about none of them, so no held-out thread is in a game the model learned from, whether
 * a judge's, a pick's or a reply's; a held-out game's other thread may have been.
 */
export const inFold = (f, folds = 5) => (r) => r.keys.some((k) => foldOf(k, folds) === f);

/** A thread as it was when a customer wrote in it: what the messages say, then. */
export function asOf(entry, messages, turn) {
  const before = messages.filter((m) => !m.deletedAt && Date.parse(m.at) <= turn.at);
  const people = before.filter((m) => m.author?.kind === 'person' || !m.author?.kind);
  const faces = [];
  for (const m of people) {
    if (!faces.some((f) => f.name === m.author.name)) {
      faces.push({ name: m.author.name, staff: Boolean(m.author.staff) });
    }
  }
  const at = new Date(turn.at).toISOString();
  return {
    ...entry,
    last_at: at,
    any_at: at,
    last_staff: 0,
    last_text: turn.text.slice(-500),
    messages: before.length,
    waiting_on: 'us',
    unseenByAdobe: true,
    unseen: true,
    readers: [],
    signals: [],
    draft: null,
    resolution: null,
    reactions: [],
    participants: faces,
    staffPosted: people.some((m) => m.author.staff),
    label: entry.label
      ? { ...entry.label, resolved_p: Math.min(entry.label.resolved_p ?? 0, 0.3) } : null,
  };
}

/**
 * The replies of a sample as games: per person who answered and UTC day, the customers
 * answered sooner over those answered later (ties within `minMinutes` left out). The key of a
 * game says which turns it is about, so the same reply in another sample counts once.
 */
export function replyGames(threads, { minMinutes = 5 } = {}) {
  const answers = [];
  for (const t of threads) {
    if (t.entry.kind !== 'alert') {
      const live = (t.messages || []).filter((m) => !m.deletedAt && m.author)
        .sort((x, y) => String(x.at).localeCompare(String(y.at)));
      const person = (m) => m.author.kind === 'person' || !m.author.kind;
      let run = [];
      for (const m of live) {
        if (person(m) && !m.author.staff) {
          run.push(m);
        } else if (person(m) && m.author.staff && run.length) {
          const last = run[run.length - 1];
          const turn = { at: Date.parse(last.at), text: run.map((x) => x.body || '').join('\n') };
          answers.push({
            thread: t.key,
            entry: t.entry,
            messages: t.messages,
            turn,
            by: `${t.entry.source}|${m.author.name}`,
            day: m.at.slice(0, 10),
            latency: (Date.parse(m.at) - turn.at) / H,
          });
          run = [];
        }
      }
    }
  }
  const groups = new Map();
  for (const a of answers) {
    const k = `${a.by}|${a.day}`;
    if (!groups.has(k)) {
      groups.set(k, []);
    }
    groups.get(k).push(a);
  }
  const games = [];
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const [x, y] = list[i].latency <= list[j].latency ? [list[i], list[j]] : [list[j], list[i]];
        if (x.thread !== y.thread && (y.latency - x.latency) * 60 >= minMinutes) {
          games.push({
            key: `${x.by}|${x.thread}@${x.turn.at}|${y.thread}@${y.turn.at}`,
            a: x,
            b: y,
          });
        }
      }
    }
  }
  return games;
}

/**
 * Every game as a row `{ a, b, p, w, source, keys }`, `a` and `b` the feature objects, `keys`
 * the threads it is about: held-out folds go by thread, so that no thread a test game is about
 * was trained on (a thread is in many games, on either side; models that can remember one would
 * otherwise be scored on what they remembered).
 */
/** An inbox entry with today's kind (`kinds`: thread → `{ label_kind, kind_p }`), if known. */
export function withKind(entry, kinds) {
  const k = kinds && kinds[entry.thread];
  if (!k || !entry.label) {
    return entry;
  }
  return { ...entry, label: { ...entry.label, label_kind: k.label_kind, kind_p: k.kind_p } };
}

/** A pick's features with today's kind of their thread: its kind_* and kindP features again. */
export function featuresWithKind(thread, features, kinds, Rank) {
  const k = kinds && kinds[thread];
  if (!k) {
    return features;
  }
  const f = { ...features };
  const one = Rank.features({ label: { label_kind: k.label_kind, kind_p: k.kind_p } }, 0);
  for (const n of Object.keys(one).filter((x) => x.startsWith('kind_'))) {
    f[n] = f.alert ? 0 : one[n];
  }
  f.kindP = k.kind_p ?? 0;
  return f;
}

export function rows({
  Rank, samples: list, events = [], weights = DEFAULT_WEIGHTS, kinds = null,
}) {
  const out = [];
  const seenReplies = new Set();
  for (const s of list) {
    const now = s.data.pulledAt;
    const byKey = new Map(s.data.threads.map((t) => [t.key, t]));
    const features = new Map();
    const f = (k) => {
      if (!features.has(k)) {
        features.set(k, Rank.features(byKey.get(k).entry, now));
      }
      return features.get(k);
    };
    const games = s.games.filter((g) => byKey.has(g.a) && byKey.has(g.b));
    for (const g of decide(games, s.human, s.llm)) {
      if (byKey.has(g.a) && byKey.has(g.b)) {
        out.push({
          a: f(g.a),
          b: f(g.b),
          p: g.p,
          w: weights[g.source],
          source: g.source,
          keys: [g.a, g.b],
          ids: [g.a, g.b],
          snap: now,
        });
      }
    }
    for (const g of replyGames(s.data.threads)) {
      if (!seenReplies.has(g.key)) {
        seenReplies.add(g.key);
        out.push({
          a: Rank.features(asOf(withKind(g.a.entry, kinds), g.a.messages, g.a.turn), g.a.turn.at),
          b: Rank.features(asOf(withKind(g.b.entry, kinds), g.b.messages, g.b.turn), g.b.turn.at),
          p: 1,
          w: weights.reply,
          source: 'reply',
          keys: [g.a.thread, g.b.thread],
        });
      }
    }
  }
  for (const e of events) {
    const shown = e.shown.map((x) => ({
      ...x, features: featuresWithKind(x.thread, x.features, kinds, Rank),
    }));
    const clicked = shown.find((x) => x.thread === e.clicked);
    // The model orders threads within a status pile; the piles come first whatever it says. So
    // a pick wins over the others of its pile, when the pick says which (picks since the piles
    // were sent); else over all those on screen. (Over all, a pick under the critical and hot
    // piles would teach that urgency loses, as those were passed over.)
    const rivals = (x) => x.thread !== e.clicked && (!clicked.status || !x.status
      || x.status === clicked.status);
    if (clicked) {
      for (const other of shown.filter(rivals)) {
        out.push({
          a: clicked.features,
          b: other.features,
          p: 1,
          w: weights.click * (other.pos < clicked.pos ? 1 : weights.below),
          source: 'click',
          keys: [clicked.thread, other.thread],
        });
      }
    }
  }
  return out;
}
