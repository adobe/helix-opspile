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
 * Whether the mention model (src/mention-model.js) beats what it replaced: for the odds of an
 * answer, the person's own share of answered mentions; for the time, the response model
 * (src/response-model.js) and one number for everyone. Reads production, read-only, with the
 * cron's queries (src/mentionmodels.js), and prints only counts and errors:
 *
 *   npm run response:backtest -- --database <D1 id> [--profile <cf profile>] [--days 60]
 *
 * Walks forward a day at a time, as the cron fits: each mention of someone not in the thread yet
 * of the last `--days` is predicted from a model of what was known the day before. Mentions of
 * the last week are left out, as whether they get an answer is not known yet. `--finder` keeps
 * the mentions most like the expert finder's: not opening the thread, at most two people named.
 * The odds are scored by log loss, the time by the error on the log of the minutes (0.7 is
 * about a factor of two). Intervals resample people, as one person's mentions are not
 * independent.
 */

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  coldMentions, fitMentions, HORIZON, predictMention,
} from '../src/mention-model.js';
import {
  MEMBERS_SQL, MENTIONS_SQL, ROWS_SQL, windowOf,
} from '../src/mentionmodels.js';
import { fitResponses, predict } from '../src/response-model.js';

const DAY = 24 * 60 * 60 * 1000;
const RESPONSE_WINDOW = 180 * DAY;
const RESAMPLES = 2000;
/** A person's own share of answered mentions counts as this many of everyone's. */
const OWN = 5;

const { values: args } = parseArgs({
  options: {
    database: { type: 'string' },
    profile: { type: 'string' },
    days: { type: 'string', default: '60' },
    finder: { type: 'boolean', default: false },
  },
});
if (!args.database) {
  console.error('usage: npm run response:backtest -- --database <D1 id> [--profile <cf profile>]'
    + ' [--days 60] [--finder]');
  process.exit(1);
}

function query(sql, from) {
  const profile = args.profile ? ['--profile', args.profile] : [];
  const out = execFileSync('cf', [
    'd1', 'query', args.database, ...profile, '--sql', sql.replaceAll('?1', `'${from}'`),
  ], { encoding: 'utf8', maxBuffer: 2 ** 30, stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)[0].results.map((r) => (r.at ? { ...r, at: Date.parse(r.at) } : r));
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];
const logOf = (minutes) => Math.log(Math.max(minutes, 1));
const logLoss = (p, yes) => -Math.log(Math.max(1e-6, yes ? p : 1 - p));

/** The mean of `diffs` and its 95% interval, resampling `people` (one per diff). */
function interval(diffs, people) {
  const byPerson = new Map();
  diffs.forEach((d, i) => byPerson.set(people[i], [...(byPerson.get(people[i]) || []), d]));
  const groups = [...byPerson.values()];
  const means = Array.from({ length: RESAMPLES }, () => mean(Array.from(
    groups,
    () => groups[Math.floor(Math.random() * groups.length)],
  ).flat())).sort((a, b) => a - b);
  return {
    diff: mean(diffs),
    low: means[Math.floor(0.025 * RESAMPLES)],
    high: means[Math.floor(0.975 * RESAMPLES)],
  };
}
const said = ({ diff, low, high }) => `${diff.toFixed(3)} [${low.toFixed(3)}, ${high.toFixed(3)}]`;

/** How well `scores` order `yes`: the chance an answered mention scores above one that is not. */
function auc(scores, yes) {
  const sorted = scores.map((s, i) => [s, yes[i]]).sort((a, b) => a[0] - b[0]);
  let ranks = 0;
  let pos = 0;
  sorted.forEach(([, y], i) => {
    if (y) {
      ranks += i + 1;
      pos += 1;
    }
  });
  return (ranks - (pos * (pos + 1)) / 2) / (pos * (sorted.length - pos));
}

const from = windowOf(Date.now() - Number(args.days) * DAY - HORIZON);
const rows = query(ROWS_SQL, from.posts).sort((a, b) => a.at - b.at);
const mentions = query(MENTIONS_SQL, from.posts);
const members = query(MEMBERS_SQL, from.posts);
const end = rows[rows.length - 1].at;
const cold = coldMentions(rows, mentions, members);
const like = args.finder ? (m) => !m.opening && m.mentioned <= 2 : () => true;

const out = [];
for (let day = end - HORIZON - Number(args.days) * DAY; day < end - HORIZON; day += DAY) {
  // What the cron would have read that day.
  const window = windowOf(day);
  const model = fitMentions(
    rows.filter((r) => r.at < day && r.at >= Date.parse(window.posts)),
    mentions.filter((m) => m.at < day && m.at >= Date.parse(window.mentions)),
    members,
    { now: day },
  );
  const response = fitResponses(rows.filter((r) => r.at < day && r.at >= day - RESPONSE_WINDOW));
  const past = cold.filter((m) => m.at + HORIZON <= day);
  if (model && response && past.length) {
    const rate = mean(past.map((m) => m.minutes !== null));
    const own = new Map();
    for (const m of past) {
      const [a, n] = own.get(m.person) || [0, 0];
      own.set(m.person, [a + (m.minutes !== null), n + 1]);
    }
    const everyone = median(past.filter((m) => m.minutes !== null).map((m) => m.minutes));
    for (const m of cold.filter((x) => x.at >= day && x.at < day + DAY && like(x))) {
      const p = predictMention(model, m);
      const [a, n] = own.get(m.person) || [0, 0];
      out.push({
        person: m.person,
        yes: m.minutes !== null,
        took: m.minutes,
        odds: p.odds,
        share: (a + OWN * rate) / (n + OWN),
        minutes: p.minutes,
        response: predict(response, m),
        everyone,
      });
    }
  }
}

const people = out.map((o) => o.person);
const yes = out.map((o) => o.yes);
const odds = interval(out.map((o) => logLoss(o.odds, o.yes) - logLoss(o.share, o.yes)), people);
console.log(`mentions: ${out.length} of ${new Set(people).size} people, `
  + `${Math.round(100 * mean(yes))}% answered within a week`);
console.log(`odds: log loss ${mean(out.map((o) => logLoss(o.odds, o.yes))).toFixed(3)}, `
  + `own share ${mean(out.map((o) => logLoss(o.share, o.yes))).toFixed(3)}; `
  + `model minus own share ${said(odds)}`);
console.log(`odds: AUC ${auc(out.map((o) => o.odds), yes).toFixed(3)}, `
  + `own share ${auc(out.map((o) => o.share), yes).toFixed(3)}`);
const bands = [0.2, 0.4, 0.6, 0.8, 1.01];
console.log(`odds said and answered: ${bands.map((top, i) => {
  const inBand = out.filter((o) => o.odds >= (i ? bands[i - 1] : 0) && o.odds < top);
  return inBand.length ? `${Math.round(100 * mean(inBand.map((o) => o.odds)))}% `
    + `${Math.round(100 * mean(inBand.map((o) => o.yes)))}% (${inBand.length})` : null;
}).filter(Boolean).join(', ')}`);

const answered = out.filter((o) => o.yes);
const errorOf = (k) => answered.map((o) => Math.abs(logOf(o[k]) - logOf(o.took)));
const [model, response, everyone] = ['minutes', 'response', 'everyone'].map(errorOf);
const time = interval(model.map((e, i) => e - response[i]), answered.map((o) => o.person));
console.log(`time: ${answered.length} answers; error ${mean(model).toFixed(2)}, `
  + `response model ${mean(response).toFixed(2)}, one number ${mean(everyone).toFixed(2)}; `
  + `model minus response model ${said(time)}`);
console.log(`answered within the time said: ${mean(answered.map((o) => o.took <= o.minutes))
  .toFixed(2)}`);
console.log(odds.high < 0 && time.high < 0 ? 'The mention model beats both.'
  : 'Not yet: the mention model does not beat both.');
