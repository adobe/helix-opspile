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
const bucket = `helix-opspile-raw${suffix}`;
const channelsBucket = `helix-opspile-channels${suffix}`;
const queueName = `helix-opspile-normalize${suffix}`;

const cf = (...a) => JSON.parse(execFileSync('cf', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const items = (d) => (Array.isArray(d) ? d : (d.result || d.objects || d.items || []));

function* listKeys() {
  let cursor;
  do {
    const page = cf(
      'r2',
      'objects',
      'list',
      '--bucket-name',
      bucket,
      '--per-page',
      '1000',
      ...(prefix ? ['--prefix', prefix] : []),
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
  let doomed = [];
  let deleted = 0;
  const drop = () => {
    if (doomed.length && !dryRun) {
      cf('r2', 'objects', 'bulk-delete', '--bucket-name', channelsBucket, '--force', '--body', JSON.stringify(doomed));
    }
    deleted += doomed.length;
    doomed = [];
  };
  for (const key of listKeys(channelsBucket, '')) {
    doomed.push(key);
    if (doomed.length === 1000) {
      drop();
    }
  }
  drop();
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
