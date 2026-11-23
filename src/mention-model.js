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
  clockMinutes, hoursOf, wallMinutes, weightOf,
} from './response-model.js';

/**
 * What happens when someone is mentioned in a thread they are not in yet (docs/ARCHITECTURE.md,
 * "Expert finder"): the odds that they post in it within a week, and how long they take when
 * they do. That is the expert finder's question, as it only lists people not in the thread.
 *
 * Both are learnt from every such mention of the window, and both start from what the person's
 * posts said at the time of the mention (`activityOf`): how long since their last post anywhere,
 * how much they posted in the day, the week, the window and the channel, whether they are of the
 * thread's team, how many were mentioned with them, how many Adobe people are in the thread
 * already, and how busy their hour usually is.
 *
 * - **Odds**: a logistic regression on those, then what the channel and then the person add,
 *   each pulled towards nothing while its mentions are few.
 * - **Time**: the log of the minutes on the person's own clock (src/response-model.js: each hour
 *   counts for as much as they post in it) is a regression on how recently they posted, then
 *   what the channel and the person add, each counting for as much as its data can carry. Asked
 *   about a moment, the person's clock runs forward from it, back to minutes on the wall.
 *
 * The model is fit once a day (src/mentionmodels.js) and kept as plain JSON: numbers by person
 * and channel id, nothing of what anyone wrote. `npm run response:backtest` says how it does.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A mention is answered when the person posts in the thread within this. */
export const HORIZON = 7 * DAY;
/** The days of mentions the model learns from, and of a person's posts it counts before one. */
export const WINDOW_DAYS = 365;
export const ACTIVITY_DAYS = 90;
/** A mention this soon after the thread's first message opens the thread. */
const OPENING = 6 * 60 * 1000;
/** How much the person's and the channel's own mentions count against the rest, for the odds. */
const PERSON_ODDS = 3;
const CHANNEL_ODDS = 20;
/** The ridge on the regressions' standardized weights. */
const RIDGE = 1;
/** Hours since the last post the time model tells apart. */
const RECENT = [0.25, 1, 4, 24];
const DIGITS = 1e4;

const sum = (values) => values.reduce((a, b) => a + b, 0);
const mean = (values) => (values.length ? sum(values) / values.length : 0);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const weekend = (at) => [0, 6].includes(new Date(at).getUTCDay());
const round = (v) => Math.round(v * DIGITS) / DIGITS;
const speedOf = (clock, at) => clock[weekend(at) ? 1 : 0][new Date(at).getUTCHours()];

/** The first index of sorted `values` not under `at`. */
function below(values, at) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid] < at) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * What a person's posts (`{ at, channel }`, sorted by `at`) say at `at` in `channel`: hours
 * `since` their last post (null without one in the `days` before), and how many in the last
 * `day`, the last `week`, all `days` (`all`) and in the channel in them (`inChannel`).
 */
export function activityOf(posts, at, channel, days = ACTIVITY_DAYS) {
  const ats = posts.ats || posts.map((p) => p.at);
  const end = below(ats, at);
  const start = below(ats, at - days * DAY);
  let inChannel = 0;
  for (let i = start; i < end; i += 1) {
    if (posts[i].channel === channel) {
      inChannel += 1;
    }
  }
  return {
    since: end > start ? (at - ats[end - 1]) / HOUR : null,
    day: end - below(ats, at - DAY),
    week: end - below(ats, at - 7 * DAY),
    all: end - start,
    inChannel,
  };
}

/**
 * The odds' inputs, from a mention's `activity` and the thread then (`staff`: Adobe people in
 * it, whoever mentioned them too; `opening`; `member` of its team; `mentioned`: people in the
 * same message) and the person's clock `speed` at the moment.
 */
const ODDS = [
  (m) => Math.log1p(m.activity.all),
  (m) => Math.log1p(m.activity.week),
  (m) => Math.log1p(m.activity.day),
  (m) => Math.log1p(m.activity.inChannel),
  (m) => (m.activity.since === null ? 1 : 0),
  (m) => (m.member ? 1 : 0),
  (m) => Math.log(Math.max(1, m.mentioned || 1)),
  (m) => (m.opening ? 1 : 0),
  (m) => Math.log1p(m.staff || 0),
  (m) => m.speed,
];

/** The time's inputs: how recently the person posted, and how much that day. */
const TIME = [
  ...RECENT.map((hours) => (m) => (m.activity.since !== null && m.activity.since < hours ? 1 : 0)),
  (m) => Math.log1p(m.activity.day),
];

/** Solves `a x = b` (small, dense). */
function solve(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i += 1) {
    let p = i;
    for (let r = i + 1; r < n; r += 1) {
      if (Math.abs(m[r][i]) > Math.abs(m[p][i])) {
        p = r;
      }
    }
    [m[i], m[p]] = [m[p], m[i]];
    if (Math.abs(m[i][i]) < 1e-12) {
      m[i][i] = 1e-12;
    }
    for (let r = 0; r < n; r += 1) {
      if (r !== i) {
        const f = m[r][i] / m[i][i];
        for (let c = i; c <= n; c += 1) {
          m[r][c] -= f * m[i][c];
        }
      }
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** The inputs of `items` by `features`, and their means and spreads, to standardize them. */
function design(items, features) {
  const raw = items.map((m) => features.map((f) => f(m)));
  const mu = features.map((_, j) => mean(raw.map((x) => x[j])));
  // An input that hardly varies is left as it is: standardized, it would say nothing but noise.
  const sd = features.map((_, j) => Math.sqrt(mean(raw.map((x) => (x[j] - mu[j]) ** 2))))
    .map((v) => (v < 1e-3 ? 1 : v));
  return { z: raw.map((x) => [1, ...x.map((v, j) => (v - mu[j]) / sd[j])]), mu, sd };
}

/** The linear part of `part` (`{ w, mu, sd }`) for item `m`. */
function linear(part, features, m) {
  return part.w[0] + sum(features
    .map((f, j) => part.w[j + 1] * ((f(m) - part.mu[j]) / part.sd[j])));
}

/** Logistic regression with a ridge, by Newton's method: the weights of `[1, ...z]`. */
function logistic(z, y) {
  const k = z[0].length;
  let w = Array(k).fill(0);
  for (let step = 0; step < 30; step += 1) {
    const g = Array(k).fill(0);
    const h = Array.from({ length: k }, () => Array(k).fill(0));
    const at = w;
    z.forEach((x, i) => {
      const p = sigmoid(sum(x.map((v, j) => v * at[j])));
      const s = p * (1 - p);
      for (let a = 0; a < k; a += 1) {
        g[a] += (p - y[i]) * x[a];
        for (let b = 0; b <= a; b += 1) {
          h[a][b] += s * x[a] * x[b];
        }
      }
    });
    for (let a = 0; a < k; a += 1) {
      for (let b = a + 1; b < k; b += 1) {
        h[a][b] = h[b][a];
      }
      if (a) {
        g[a] += RIDGE * w[a];
        h[a][a] += RIDGE;
      }
    }
    const d = solve(h, g);
    w = w.map((v, j) => v - d[j]);
    if (Math.max(...d.map(Math.abs)) < 1e-6) {
      break;
    }
  }
  return w;
}

/** Least squares with a ridge: the weights of `[1, ...z]`. */
function ridge(z, y) {
  const k = z[0].length;
  const a = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (__, j) => sum(z
    .map((x) => x[i] * x[j])) + (i === j && i ? RIDGE : 0)));
  return solve(a, Array.from({ length: k }, (_, i) => sum(z.map((x, n) => x[i] * y[n]))));
}

/**
 * What each group (by `key`) adds to the log-odds `zs` of `items`, one Newton step from none,
 * pulled towards nothing by `weight` mentions' worth: `{ group: offset }`.
 */
function offsets(items, zs, key, weight) {
  const groups = new Map();
  items.forEach((m, i) => {
    const p = sigmoid(zs[i]);
    const g = groups.get(key(m)) || [0, 0];
    g[0] += (m.minutes !== null ? 1 : 0) - p;
    g[1] += p * (1 - p);
    groups.set(key(m), g);
  });
  return Object.fromEntries([...groups].map(([k, [r, s]]) => [k, round(r / (s + weight))]));
}

/**
 * What each group (by `key`) adds to the residuals `left` of `items`, each counting for as much
 * as its data can carry (src/response-model.js): `{ effects: { group: effect }, left }`, `left`
 * without them.
 */
function effects(items, left, key) {
  const groups = new Map();
  items.forEach((m, i) => groups.set(key(m), [...(groups.get(key(m)) || []), left[i]]));
  const weight = weightOf([...groups.values()]);
  const out = weight === Infinity ? {} : Object.fromEntries([...groups]
    .map(([k, values]) => [k, round(sum(values) / (values.length + weight))]));
  return { effects: out, left: left.map((v, i) => v - (out[key(items[i])] || 0)) };
}

/** Posts by Adobe people in `rows`, by person, sorted, with `ats` for the searches. */
export function postsOf(rows) {
  const out = new Map();
  for (const r of rows) {
    if (r.staff && r.person !== null && r.person !== undefined) {
      if (!out.has(r.person)) {
        out.set(r.person, []);
      }
      out.get(r.person).push({ at: r.at, channel: r.channel });
    }
  }
  for (const posts of out.values()) {
    posts.sort((a, b) => a.at - b.at);
    posts.ats = posts.map((p) => p.at);
  }
  return out;
}

/**
 * The mentions of people not in the thread yet, from `rows` (counted messages: `{ entry,
 * channel, at, staff, person, team }`, `at` in ms, a re-threaded group as one entry),
 * `mentions` (`{ person, at, entry, channel, message, staff }`; without `staff`, whoever posted
 * for Adobe in `rows` is) and team `members` (`{ team, person }`): for each of an Adobe person,
 * its inputs, and `minutes` until the person's first post in the
 * thread, or null without one within HORIZON. Only a person's first mention in a thread counts,
 * and none once they posted in it. With `hours` (src/response-model.js), their clock's `speed`.
 */
export function coldMentions(rows, mentions, members, {
  posts = postsOf(rows), hours = null,
} = {}) {
  const team = new Set(members.map((m) => `${m.team}|${m.person}`));
  const entries = new Map();
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    if (!entries.has(r.entry)) {
      entries.set(r.entry, {
        first: r.at, team: r.team, staff: [], own: new Map(),
      });
    }
    const e = entries.get(r.entry);
    if (r.staff && r.person !== null && r.person !== undefined) {
      if (!e.own.has(r.person)) {
        e.own.set(r.person, []);
        e.staff.push(r.at);
      }
      e.own.get(r.person).push(r.at);
    }
  }
  const together = new Map();
  for (const m of mentions) {
    together.set(m.message, (together.get(m.message) || 0) + 1);
  }
  const staff = new Set(rows.filter((r) => r.staff).map((r) => r.person));
  const seen = new Set();
  const out = [];
  for (const m of [...mentions].sort((a, b) => a.at - b.at)) {
    const key = `${m.person}|${m.entry}`;
    const e = entries.get(m.entry);
    if (!seen.has(key) && e && (m.staff === undefined ? staff.has(m.person) : m.staff)) {
      seen.add(key);
      const own = e.own.get(m.person) || [];
      if (!own.length || own[0] > m.at) {
        const answer = own.find((at) => at > m.at);
        out.push({
          person: m.person,
          entry: m.entry,
          channel: m.channel,
          at: m.at,
          activity: activityOf(posts.get(m.person) || [], m.at, m.channel),
          staff: below(e.staff, m.at + 1),
          opening: m.at - e.first < OPENING,
          member: team.has(`${e.team}|${m.person}`),
          mentioned: together.get(m.message) || 1,
          speed: hours ? speedOf(hours.of(m.person), m.at) : null,
          minutes: answer !== undefined && answer - m.at <= HORIZON
            ? (answer - m.at) / 60000 : null,
        });
      }
    }
  }
  return out;
}

/** Clock speeds as kept: `[weekday[24], weekend[24]]`, rounded. */
const keepClock = (clock) => clock.map((hours) => hours.map(round));

/**
 * The model of the mentions in `rows` and `mentions` (see `coldMentions`) whose week was over by
 * `now`, or null without any: plain JSON, for src/mentionmodels.js to keep. `rows` should go
 * back ACTIVITY_DAYS further than `mentions`, for the posts before the first.
 */
export function fitMentions(rows, mentions, members, { now = Date.now() } = {}) {
  const hours = hoursOf(rows);
  const posts = postsOf(rows);
  const all = coldMentions(rows, mentions, members, { posts, hours })
    .filter((m) => m.at + HORIZON <= now);
  if (!all.length) {
    return null;
  }
  const o = design(all, ODDS);
  const odds = {
    w: logistic(o.z, all.map((m) => (m.minutes !== null ? 1 : 0))), mu: o.mu, sd: o.sd,
  };
  let zs = all.map((m) => linear(odds, ODDS, m));
  odds.channels = offsets(all, zs, (m) => m.channel, CHANNEL_ODDS);
  zs = zs.map((z, i) => z + (odds.channels[all[i].channel] || 0));
  odds.people = offsets(all, zs, (m) => m.person, PERSON_ODDS);

  const done = all.filter((m) => m.minutes !== null);
  let time = null;
  if (done.length) {
    const y = done.map((m) => Math.log(Math.max(1, clockMinutes(
      hours.of(m.person),
      m.at,
      m.at + m.minutes * 60000,
    ))));
    const t = design(done, TIME);
    time = { w: ridge(t.z, y), mu: t.mu, sd: t.sd };
    const left = y.map((v, i) => v - linear(time, TIME, done[i]));
    const channels = effects(done, left, (m) => m.channel);
    time.channels = channels.effects;
    time.people = effects(done, channels.left, (m) => m.person).effects;
  }

  const counts = {};
  for (const m of all) {
    const c = counts[m.person] || [0, 0];
    c[0] += 1;
    c[1] += m.minutes !== null ? 1 : 0;
    counts[m.person] = c;
  }
  const round3 = (part) => part && {
    ...part, w: part.w.map(round), mu: part.mu.map(round), sd: part.sd.map(round),
  };
  return {
    at: new Date(now).toISOString(),
    mentions: all.length,
    answered: done.length,
    odds: round3(odds),
    time: round3(time),
    clocks: Object.fromEntries([...posts.keys()].map((p) => [p, keepClock(hours.of(p))])),
    usual: keepClock(hours.of(undefined)),
    counts,
  };
}

/**
 * What the model says of mentioning `person` in `channel` at `at`, from their `activity` then
 * (`activityOf`) and the thread's `staff`, `opening` and whether they are a `member` of its
 * team: `{ odds, minutes, mentions, answered }`, `minutes` being the typical wall-clock minutes
 * until they post when they do, and `mentions` and `answered` how many the model learnt of them.
 */
export function predictMention(model, {
  person, channel, at, activity, staff = 0, opening = false, member = false, mentioned = 1,
}) {
  const clock = model.clocks[person] || model.usual;
  const m = {
    person, channel, at, activity, staff, opening, member, mentioned, speed: speedOf(clock, at),
  };
  const odds = sigmoid(linear(model.odds, ODDS, m) + (model.odds.channels[channel] || 0)
    + (model.odds.people[person] || 0));
  const own = model.time ? Math.exp(linear(model.time, TIME, m)
    + (model.time.channels[channel] || 0) + (model.time.people[person] || 0)) : null;
  const [mentions, answered] = model.counts[person] || [0, 0];
  return {
    odds,
    minutes: own === null ? null : wallMinutes(clock, at, own),
    mentions,
    answered,
  };
}
