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
 * The parsed files (`{ meta, body }`, or null for one that cannot be read) under `prefix`.
 */
export async function folderFiles(bucket, prefix, cache = shared) {
  const listed = await bucket.list({ prefix });
  return Promise.all(listed.objects.map(async (o) => {
    const version = o.version || o.etag || null;
    const hit = cache.get(o.key, version);
    if (hit !== undefined) {
      return hit;
    }
    const obj = await bucket.get(o.key);
    if (!obj) {
      return null;
    }
    const text = await obj.text();
    const file = parse(text);
    cache.set(o.key, version, text.length * 2, file);
    return file;
  }));
}
