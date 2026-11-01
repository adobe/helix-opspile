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
 * Whether the response model (src/response-model.js) beats one number for everyone. Reads
 * production, read-only, and prints only counts and errors:
 *
 *   npm run response:backtest -- --database <D1 id> [--profile <cf profile>] [--days 28]
 *
 * Walks forward a day at a time: each customer message of the last `--days` is predicted from
 * what was known then. Messages younger than three days are left out, since their slow answers
 * are still to come. The error is on the log of the minutes, so 0.7 is about a factor of two.
 * Intervals resample people, as one person's answers are not independent.
 */

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fitResponses, joins, predict } from '../src/response-model.js';

const DAY = 24 * 60 * 60 * 1000;
const SETTLE = 3 * DAY;
const WINDOW = 180 * DAY;
const RESAMPLES = 2000;
/** The answers before the model can be judged at all, and what it must then show. */
const MIN_ANSWERS = 1000;

const { values: args } = parseArgs({
  options: {
    database: { type: 'string' },
    profile: { type: 'string' },
    days: { type: 'string', default: '28' },
  },
});
if (!args.database) {
  console.error('usage: npm run response:backtest -- --database <D1 id> [--profile <cf profile>]');
  process.exit(1);
}

function query(sql) {
  const profile = args.profile ? ['--profile', args.profile] : [];
  const out = execFileSync('cf', ['d1', 'query', args.database, ...profile, '--sql', sql], {
    encoding: 'utf8', maxBuffer: 2 ** 30, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out)[0].results.map((r) => ({ ...r, at: Date.parse(r.at) }));
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const logOf = (minutes) => Math.log(Math.max(minutes, 1));

/** The mean difference of `pairs` (`{ person, diff }`) and its 95% interval over people. */
function interval(pairs) {
  const byPerson = new Map();
  for (const { person, diff } of pairs) {
    byPerson.set(person, [...(byPerson.get(person) || []), diff]);
  }
  const people = [...byPerson.values()];
  const means = Array.from({ length: RESAMPLES }, () => mean(Array.from(
    people,
    () => people[Math.floor(Math.random() * people.length)],
  ).flat())).sort((a, b) => a - b);
  return {
    diff: mean(pairs.map((p) => p.diff)),
    low: means[Math.floor(0.025 * RESAMPLES)],
    high: means[Math.floor(0.975 * RESAMPLES)],
  };
}

/** Mentions of someone not in the thread yet, the case the expert finder shows. */
function coldMentions(mentions, rows) {
  const posts = new Map();
  for (const r of rows.filter((x) => x.staff && x.person !== null)) {
    const key = `${r.person}|${r.entry}`;
    posts.set(key, [...(posts.get(key) || []), r.at]);
  }
  const seen = new Set();
  return mentions.sort((a, b) => a.at - b.at).flatMap((m) => {
    const key = `${m.person}|${m.entry}`;
    const own = posts.get(key) || [];
    const cold = !seen.has(key) && !own.some((at) => at < m.at);
    seen.add(key);
    const after = own.filter((at) => at > m.at && at <= m.at + 7 * DAY);
    return cold ? [{ ...m, took: after.length ? (Math.min(...after) - m.at) / 60000 : null }] : [];
  });
}

const fresh = Date.now() - WINDOW;
const entry = 'COALESCE(t.logical_thread, t.thread) AS entry';
const rows = query(`SELECT ${entry}, x.at, x.staff, x.person,
    x.source || ':' || x.tenant || ':' || x.channel_id AS channel
  FROM messages x JOIN threads t ON t.thread = x.thread
  WHERE x.at >= '${new Date(fresh).toISOString()}' AND x.counted = 1 AND x.deleted = 0`);
const answers = joins(rows);
const channels = new Map(rows.map((r) => [r.entry, r.channel]));
const cold = coldMentions(query(`SELECT m.person, m.at, ${entry} FROM mentions m
  JOIN threads t ON t.thread = m.thread
  WHERE m.at >= '${new Date(fresh).toISOString()}'`), rows);

const end = Math.max(...rows.map((r) => r.at));
const results = [];
const mentioned = [];
for (let day = end - Number(args.days) * DAY; day < end - SETTLE; day += DAY) {
  const known = answers.filter((a) => a.at + a.minutes * 60000 < day);
  if (known.length) {
    const fit = fitResponses(known);
    const everyone = logOf(median(known.map((a) => a.minutes)));
    const inDay = (a) => a.at >= day && a.at < day + DAY && a.at < end - SETTLE;
    for (const a of answers.filter(inDay)) {
      const truth = logOf(a.minutes);
      const said = Math.log(predict(fit, a));
      results.push({
        person: a.person,
        diff: Math.abs(said - truth) - Math.abs(everyone - truth),
        error: Math.abs(said - truth),
        baseline: Math.abs(everyone - truth),
        within: truth <= said,
      });
    }
    for (const m of cold.filter(inDay)) {
      const minutes = predict(fit, { ...m, channel: channels.get(m.entry) });
      mentioned.push(m.took !== null && m.took <= minutes);
    }
  }
}

const { diff, low, high } = interval(results);
console.log(`answers: ${answers.length}, tested: ${results.length}`);
console.log(`error: model ${mean(results.map((r) => r.error)).toFixed(2)}, one number ${mean(results.map((r) => r.baseline)).toFixed(2)}`);
console.log(`model minus one number: ${diff.toFixed(2)} [${low.toFixed(2)}, ${high.toFixed(2)}]`);
console.log(`answered within the prediction: ${mean(results.map((r) => r.within)).toFixed(2)}`);
console.log(`cold mentions answered within it (${mentioned.length}): ${mean(mentioned).toFixed(2)}`);
const ready = answers.length >= MIN_ANSWERS && high < 0;
console.log(ready ? 'The model beats one number.' : 'Not yet: keep this unmerged.');
