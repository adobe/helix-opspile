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
 * The history import (src/history.js): the threads of every known Slack and Teams channel started
 * in the last `--days` days that the inbox does not have, read from the platforms' history APIs
 * and filed as imported: read, waiting on nobody, without agent, label, vectors or full-text
 * items. One queue job per channel, spread out; each sends the channel's next page itself.
 *
 *   node scripts/import.mjs --days 90 | --since 2026-07-23 [--mode prod|stage]
 *     [--source slack|teams] [--channel <id>] [--alerts] [--every 60] [--per 10] [--dry-run]
 *   node scripts/import.mjs --status [--mode prod|stage]
 *   node scripts/import.mjs --resume [--mode prod|stage] [--alerts] [--dry-run]
 *
 * --days counts back from now, --since names the day (UTC) to start from: 90 days before the
 * inbox began is `--since` that day.
 * --alerts imports alert channels too (tens of thousands of bot posts a month).
 * --every and --per: `--per` channels start every `--every` seconds, each at its own second of
 * it, so that a queue batch rarely holds two pages (a page is a few hundred subrequests). The
 * queue delays at most 12 hours: with very many channels, raise `--per`.
 * --status says where each import stands, from `history_imports`.
 * --resume sends the imports that did not finish (a page that outlived its retries) on from where
 * they stopped.
 *
 * Labels and vectors are not made for imported threads; `scripts/replay.mjs --relabel`,
 * `--vectorize` and `--index` make them when wanted. Uses the `cf` CLI and its auth profile for
 * this directory.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const mode = opt('mode', 'prod');
const suffix = mode === 'prod' ? '' : `-${mode}`;
const dryRun = args.includes('--dry-run');
const alerts = args.includes('--alerts');
const source = opt('source', null);
const channel = opt('channel', null);
const every = Number(opt('every', 60));
const per = Number(opt('per', 5));
const MAX_DELAY = 12 * 60 * 60;

const cf = (...a) => JSON.parse(execFileSync('cf', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const items = (d) => (Array.isArray(d) ? d : (d.result || d.objects || d.items || []));
const db = items(cf('d1', 'list')).find((d) => d.name === `helix-opspile${suffix}`);
if (!db) {
  throw new Error(`database helix-opspile${suffix} not found`);
}
const query = (sql) => {
  const res = cf('d1', 'query', db.uuid, '--sql', sql);
  return (res.result || res)[0].results;
};
const quoted = (v) => `'${String(v).replace(/'/g, "''")}'`;

if (args.includes('--status')) {
  const rows = query(`SELECT source, CASE WHEN done_at IS NULL THEN 'open'
      WHEN error IS NULL THEN 'done' ELSE 'ended: ' || error END AS state,
      COUNT(*) AS channels, SUM(pages) AS pages, SUM(threads) AS threads, SUM(messages) AS messages,
      MIN(since) AS since, MAX(updated_at) AS last
    FROM history_imports GROUP BY 1, 2 ORDER BY 1, 3 DESC`);
  console.table(rows);
  const stuck = query(`SELECT COUNT(*) AS n FROM history_imports
    WHERE done_at IS NULL AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')`);
  if (stuck[0] && stuck[0].n) {
    console.log(`${stuck[0].n} open import(s) moved no page for an hour: --resume sends them on`);
  }
  process.exit(0);
}

const resume = args.includes('--resume');
const days = Number(opt('days', 0));
const from = opt('since', null);
if (!resume && !(days > 0) && !(from && Number.isFinite(Date.parse(from)))) {
  throw new Error('--days <n> or --since <yyyy-mm-dd> (or --status, --resume)');
}
if (channel && !/^[\w:@.-]+$/.test(channel)) {
  throw new Error('--channel takes a channel id');
}
const run = new Date().toISOString();
const since = new Date(from ? Date.parse(from) : Date.now() - days * 86400 * 1000).toISOString();
const filters = [
  source ? `c.source = ${quoted(source)}` : "c.source IN ('slack', 'teams')",
  ...(channel ? [`c.channel_id = ${quoted(channel)}`] : []),
].join(' AND ');
const jobs = resume
  ? query(`SELECT h.source, h.tenant, h.channel_id, c.group_id, h.since, h.run, h.cursor, h.skip
      FROM history_imports h JOIN channels c ON c.source = h.source AND c.tenant = h.tenant
        AND c.channel_id = h.channel_id
      WHERE h.done_at IS NULL AND ${filters}`).map((r) => ({
    source: r.source,
    tenant: r.tenant,
    channelId: r.channel_id,
    groupId: r.group_id,
    since: r.since,
    run: r.run,
    cursor: r.cursor,
    skip: r.skip,
    ...(alerts ? { alerts } : {}),
  }))
  : query(`SELECT c.source, c.tenant, c.channel_id, c.group_id FROM channels c
      WHERE ${filters} AND (c.source != 'teams' OR c.group_id IS NOT NULL)
      ORDER BY c.source, c.channel_id`).map((r) => ({
    source: r.source,
    tenant: r.tenant,
    channelId: r.channel_id,
    ...(r.group_id && r.source === 'teams' ? { groupId: r.group_id } : {}),
    since,
    run,
    ...(alerts ? { alerts } : {}),
  }));

const batches = Math.ceil(jobs.length / per);
if ((batches - 1) * every > MAX_DELAY) {
  throw new Error(`${jobs.length} channels at ${per} every ${every}s take longer than the queue delays: raise --per`);
}
const queue = items(cf('queues', 'list')).find((q) => q.queue_name === `helix-opspile-normalize${suffix}`);
if (!queue) {
  throw new Error(`queue helix-opspile-normalize${suffix} not found`);
}
const dir = mkdtempSync(join(tmpdir(), 'opspile-import-'));
try {
  for (let i = 0; i < jobs.length; i += per) {
    const file = join(dir, 'jobs.json');
    // Each job at its own second of the batch's `every`, on top of the batch's delay.
    writeFileSync(file, JSON.stringify(jobs.slice(i, i + per)
      .map((job, j) => ({
        body: { import: job },
        content_type: 'json',
        delay_seconds: (i / per) * every + Math.floor((j * every) / per),
      }))));
    if (!dryRun) {
      cf(
        'queues',
        'messages',
        'bulk-push',
        '--queue-id',
        queue.queue_id,
        '--messages',
        `@${file}`,
      );
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const what = resume ? 'resume' : `import the threads since ${since.slice(0, 10)} of`;
console.log(`${dryRun ? 'would' : 'will'} ${what} ${jobs.length} channel(s), over ${Math.round(((batches - 1) * every) / 60)} minute(s)`);
