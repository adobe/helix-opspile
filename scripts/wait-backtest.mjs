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
 * Whether the wait model (src/wait-model.js) beats one number for everyone: what the customer
 * portal tells its people of Adobe's next answer. Reads production, read-only, and prints only
 * counts and errors:
 *
 *   npm run response:waits -- --database <D1 id> [--profile <cf profile>] [--days 28]
 *
 * Walks forward a day at a time: each wait that began in the last `--days` is estimated from
 * what was known then. Waits younger than three days are left out, since their slow answers are
 * still to come. The error is on the log of the minutes, so 0.7 is about a factor of two.
 * Intervals resample teams' channels, as one channel's waits are not independent.
 */

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { estimateWait, fitWaits, waitsOf } from '../src/wait-model.js';

const DAY = 24 * 60 * 60 * 1000;
const SETTLE = 3 * DAY;
const WINDOW = 180 * DAY;
const RESAMPLES = 2000;

const { values: args } = parseArgs({
  options: {
    database: { type: 'string' },
    profile: { type: 'string' },
    days: { type: 'string', default: '28' },
  },
});
if (!args.database) {
  console.error('usage: npm run response:waits -- --database <D1 id> [--profile <cf profile>]');
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

/** The mean of `pairs` (`{ group, diff }`) and its 95% interval over groups. */
function interval(pairs) {
  const by = new Map();
  for (const { group, diff } of pairs) {
    by.set(group, [...(by.get(group) || []), diff]);
  }
  const groups = [...by.values()];
  const means = Array.from({ length: RESAMPLES }, () => mean(Array.from(
    groups,
    () => groups[Math.floor(Math.random() * groups.length)],
  ).flat())).sort((a, b) => a - b);
  return {
    diff: mean(pairs.map((p) => p.diff)),
    low: means[Math.floor(0.025 * RESAMPLES)],
    high: means[Math.floor(0.975 * RESAMPLES)],
  };
}

const rows = query(`SELECT COALESCE(t.logical_thread, t.thread) AS entry, t.team, x.at, x.staff,
    x.source || ':' || x.tenant || ':' || x.channel_id AS channel
  FROM messages x JOIN threads t ON t.thread = x.thread
  WHERE x.at >= '${new Date(Date.now() - WINDOW).toISOString()}' AND x.counted = 1
    AND x.deleted = 0 AND t.kind = 'channel'`);
const waits = waitsOf(rows);
const end = Math.max(...rows.map((r) => r.at));
const results = [];
for (let day = end - Number(args.days) * DAY; day < end - SETTLE; day += DAY) {
  const known = waits.filter((w) => w.at + w.minutes * 60000 < day);
  const model = known.length ? fitWaits(rows.filter((r) => r.at < day)) : null;
  if (model) {
    const everyone = logOf(median(known.map((w) => w.minutes)));
    for (const w of waits.filter((x) => x.at >= day && x.at < day + DAY && x.at < end - SETTLE)) {
      const truth = logOf(w.minutes);
      const said = logOf(estimateWait(model, w));
      results.push({
        group: w.answer.channel,
        diff: Math.abs(said - truth) - Math.abs(everyone - truth),
        error: Math.abs(said - truth),
        baseline: Math.abs(everyone - truth),
        within: truth <= said,
      });
    }
  }
}

const { diff, low, high } = interval(results);
console.log(`waits: ${waits.length}, tested: ${results.length}`);
console.log(`error: model ${mean(results.map((r) => r.error)).toFixed(2)}, one number ${mean(results.map((r) => r.baseline)).toFixed(2)}`);
console.log(`model minus one number: ${diff.toFixed(2)} [${low.toFixed(2)}, ${high.toFixed(2)}]`);
console.log(`answered within the estimate: ${mean(results.map((r) => r.within)).toFixed(2)}`);
console.log(high < 0 ? 'The model beats one number.' : 'The model does not beat one number.');
