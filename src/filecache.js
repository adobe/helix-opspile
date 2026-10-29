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

import { parse } from './channels.js';

/**
 * Pile-2 message files of a thread folder, parsed, with the files this isolate has read
 * before kept in memory. A Worker may only wait on six R2 calls at a time, so a thread of a
 * hundred messages took some twenty rounds of reads; now the listing says which files are
 * new or changed (by their R2 `version`), and only those are read.
 *
 * The cache is per isolate and bounded by size; a file without a version is always read.
 */
const MAX_BYTES = 24 * 1024 * 1024;

export function fileCache(maxBytes = MAX_BYTES) {
  const entries = new Map(); // key -> { version, size, file }
  let bytes = 0;
  const drop = (key) => {
    const e = entries.get(key);
    if (e) {
      bytes -= e.size;
      entries.delete(key);
    }
  };
  return {
    get(key, version) {
      const e = entries.get(key);
      if (!e || !version || e.version !== version) {
        return undefined;
      }
      // Most recently used last, so the oldest go first.
      entries.delete(key);
      entries.set(key, e);
      return e.file;
    },
    set(key, version, size, file) {
      drop(key);
      if (!version || size > maxBytes) {
        return;
      }
      entries.set(key, { version, size, file });
      bytes += size;
      for (const k of entries.keys()) {
        if (bytes <= maxBytes) {
          break;
        }
        drop(k);
      }
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
  };
}

const shared = fileCache();

/**
 * Where the snapshot of the folder `prefix` is: every file of it, parsed, by R2 version, in one
 * object. It is kept outside `channels/`, so no folder listing sees it. A Worker isolate that has
 * not read the folder before (a new isolate, another colo, the first read after a deploy) reads
 * it instead of every file: one read, not one per message in rounds of six (a thread of 300
 * messages took three seconds). Derived and checked against the listing, so it is never
 * trusted for a file that changed; rebuilding pile 2 may drop it.
 */
export const snapshotKey = (prefix) => `snapshots/${String(prefix).replace(/\/$/, '')}.json`;

// Raise it when `parse` reads files differently: older snapshots are then ignored.
const SNAPSHOT_FORMAT = 1;
// How many R2 calls a Worker waits on at a time: fewer misses than that are one round anyway.
const AT_ONCE = 6;

async function listAll(bucket, prefix) {
  const objects = [];
  let cursor;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function readSnapshot(bucket, key) {
  try {
    const obj = await bucket.get(key);
    const s = obj && JSON.parse(await obj.text());
    return s && s.v === SNAPSHOT_FORMAT && s.files && typeof s.files === 'object' ? s.files : {};
  } catch {
    return {};
  }
}

// Roughly what a parsed file takes in memory, for one that came from a snapshot.
const sizeOf = (file) => 2 * (String((file && file.body) || '').length + 512);

/**
 * The parsed files (`{ meta, body }`, or null for one that cannot be read) under `prefix`, in
 * listing order: from this isolate's cache, else the folder's snapshot, else R2. A snapshot that
 * was read and is out of date is written again, through `waitUntil` when given.
 */
export async function folderFiles(bucket, prefix, { cache = shared, waitUntil = null } = {}) {
  const listed = await listAll(bucket, prefix);
  const versionOf = (o) => o.version || o.etag || null;
  const out = listed.map((o) => cache.get(o.key, versionOf(o)));
  const missing = out.flatMap((f, i) => (f === undefined ? [i] : []));
  if (!missing.length) {
    return out;
  }
  const key = snapshotKey(prefix);
  const snap = missing.length > AT_ONCE ? await readSnapshot(bucket, key) : null;
  let stale = false;
  await Promise.all(missing.map(async (i) => {
    const o = listed[i];
    const version = versionOf(o);
    const kept = snap && version && snap[o.key];
    if (kept && kept.version === version && kept.file) {
      out[i] = kept.file;
      cache.set(o.key, version, sizeOf(kept.file), kept.file);
      return;
    }
    stale = true;
    const obj = await bucket.get(o.key);
    if (!obj) {
      out[i] = null;
      return;
    }
    const text = await obj.text();
    out[i] = parse(text);
    cache.set(o.key, version, text.length * 2, out[i]);
  }));
  if (!snap) {
    return out;
  }
  const files = {};
  listed.forEach((o, i) => {
    const version = versionOf(o);
    if (version && out[i]) {
      files[o.key] = { version, file: out[i] };
    }
  });
  // Out of date (a file changed, came or went): written again, for the next isolate.
  if (stale || Object.keys(snap).length !== Object.keys(files).length) {
    const put = bucket.put(key, JSON.stringify({ v: SNAPSHOT_FORMAT, files }), {
      httpMetadata: { contentType: 'application/json' },
    }).catch((e) => console.warn(JSON.stringify({ route: 'snapshot', error: String(e) })));
    if (waitUntil) {
      waitUntil(put);
    } else {
      await put;
    }
  }
  return out;
}
