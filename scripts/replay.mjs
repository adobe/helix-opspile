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
 * Replays pile 1 into the normalizer: lists the raw bucket and pushes every key onto the
 * NORMALIZE queue, so pile 2 is rebuilt. Pile-2 writes are order-independent and
 * idempotent, so a replay can run at any time, in full or for a prefix.
 *
 *   node scripts/replay.mjs [--mode prod|stage] [--prefix slack/] [--clear] [--dry-run]
 *
 * --rethread re-runs re-threading for every thread with a root (no replay), spread over a few
 * minutes. Run it after a replay, once the vector index has caught up with the new roots.
 *
 * --clear deletes pile 2 (the channels bucket) first. Use it after changing the rules:
 * a file's path depends on its org and team, so a replay alone would leave the files
 * filed under the old ones.
 *
 * Uses the `cf` CLI and its auth profile for this directory.
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
const prefix = opt('prefix', '');
const dryRun = args.includes('--dry-run');
const suffix = mode === 'prod' ? '' : `-${mode}`;
const clear = args.includes('--clear');
const rethreadAll = args.includes('--rethread');
const bucket = `helix-opspile-raw${suffix}`;
const channelsBucket = `helix-opspile-channels${suffix}`;
const queueName = `helix-opspile-normalize${suffix}`;

const cf = (...a) => JSON.parse(execFileSync('cf', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const items = (d) => (Array.isArray(d) ? d : (d.result || d.objects || d.items || []));

function* listKeys(from = bucket, keyPrefix = prefix) {
  let cursor;
  do {
    const page = cf(
      'r2',
      'objects',
      'list',
      '--bucket-name',
      from,
      '--per-page',
      '1000',
      ...(keyPrefix ? ['--prefix', keyPrefix] : []),
      ...(cursor ? ['--cursor', cursor] : []),
    );
    for (const o of items(page)) {
      yield o.key;
    }
    cursor = page.cursor || (page.result_info && page.result_info.cursor) || null;
    if (page.truncated === false || (page.result_info && page.result_info.is_truncated === false)) {
      cursor = null;
    }
  } while (cursor);
}

const queue = items(cf('queues', 'list')).find((q) => q.queue_name === queueName);
if (!queue) {
  throw new Error(`queue ${queueName} not found`);
}

const dir = mkdtempSync(join(tmpdir(), 'opspile-replay-'));

if (rethreadAll) {
  const db = items(cf('d1', 'list')).find((d) => d.name === `helix-opspile${suffix}`);
  const res = cf('d1', 'query', db.uuid, '--sql', 'SELECT thread FROM threads WHERE root_at IS NOT NULL ORDER BY root_at');
  const keys = (res.result || res)[0].results.map((r) => r.thread);
  for (let i = 0; i < keys.length; i += 50) {
    const file = join(dir, 'rethread.json');
    writeFileSync(file, JSON.stringify(keys.slice(i, i + 50)
      .map((thread) => ({ body: { rethread: thread, force: true }, content_type: 'json' }))));
    if (!dryRun) {
      // Spread the batches out: Vectorize and Workers AI are rate limited.
      cf(
        'queues',
        'messages',
        'bulk-push',
        '--queue-id',
        queue.queue_id,
        '--messages',
        `@${file}`,
        '--delay-seconds',
        String(Math.floor(i / 50) * 20),
      );
    }
  }
  console.log(`${dryRun ? 'would re-thread' : 're-threading'} ${keys.length} thread(s)`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
let batch = [];
let sent = 0;
const flush = () => {
  if (!batch.length) {
    return;
  }
  if (!dryRun) {
    const file = join(dir, 'messages.json');
    writeFileSync(file, JSON.stringify(batch.map((key) => ({ body: { key }, content_type: 'json' }))));
    cf('queues', 'messages', 'bulk-push', '--queue-id', queue.queue_id, '--messages', `@${file}`);
  }
  sent += batch.length;
  batch = [];
};
if (clear) {
  const run = (keys) => execFileSync('cf', [
    'r2', 'objects', 'bulk-delete', '--bucket-name', channelsBucket, '--force',
    '--body', JSON.stringify(keys),
  ], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  const drop = (keys) => {
    if (dryRun || !keys.length) {
      return keys.length;
    }
    try {
      run(keys);
      return keys.length;
    } catch {
      // One bad key fails the whole batch: delete one by one, skipping keys that are gone.
      let n = 0;
      for (const key of keys) {
        try {
          run([key]);
          n += 1;
        } catch (e) {
          if (!/10007|does not exist/.test(String(e.stderr || e.stdout || e.message))) {
            console.error(`could not delete ${key}`);
          }
        }
      }
      return n;
    }
  };
  let doomed = [];
  let deleted = 0;
  for (const key of listKeys(channelsBucket, '')) {
    doomed.push(key);
    if (doomed.length === 50) {
      deleted += drop(doomed);
      doomed = [];
    }
  }
  deleted += drop(doomed);
  console.log(`${dryRun ? 'would delete' : 'deleted'} ${deleted} file(s) from ${channelsBucket}`);
}

try {
  for (const key of listKeys()) {
    batch.push(key);
    if (batch.length === 100) {
      flush();
    }
  }
  flush();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${dryRun ? 'would replay' : 'replayed'} ${sent} object(s) from ${bucket}${prefix ? `/${prefix}` : ''}`);
