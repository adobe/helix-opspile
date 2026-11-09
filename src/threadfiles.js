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

/* global FixedLengthStream */

import { entryMessages } from './agent/deliver.js';
import { openFile, threadFiles } from './agent/files.js';
import { harRequests } from './har.js';
import { segment, sha256 } from './raw.js';

/**
 * Copies of the files attached to messages, for thread agents' shells. Slack and Discord keep
 * a file only on their side, and a Teams copy (src/teamsfiles.js) stops at 25 MB, so every file
 * is copied here when its message arrives, or at the latest when an agent is told about it:
 *
 * `FILES` bucket, `<thread>/<sha256 of the file's id>`: the bytes, and `name`, `thread` and
 * `message` as custom metadata. A HAR also gets `….requests.ndjson` (src/har.js).
 *
 * The bucket's lifecycle rule deletes objects after 30 days (README, "Bindings"), and a file
 * whose message is older is neither copied nor shown, so the rule and this code agree.
 *
 * `/workspace/uploads` in an agent's computer holds them read-only, as a mount of its Workspace
 * (`uploadsMount`). A mount is copied into the object's SQLite, and the shell reads a file whole,
 * so files over MAX_MOUNT_FILE stay out of it: `INDEX.txt` there says what is missing and why.
 */

export const FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_COPY_BYTES = 150 * 1024 * 1024;
export const MAX_MOUNT_FILE = 30 * 1024 * 1024;
export const MAX_MOUNT_BYTES = 200 * 1024 * 1024;
export const MAX_THREAD_FILES = 50;
export const UPLOADS_DIR = 'uploads';
const REQUESTS = '.requests.ndjson';

const log = (what, fields = {}) => console.log(JSON.stringify({ route: 'files', what, ...fields }));
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const fileKey = async (f) => `${segment(f.thread)}/${await sha256(f.id)}`;

/** What the agent is told about a kept copy. */
const copyOf = (obj, f, name, key, requests) => ({
  key,
  name,
  size: obj.size,
  expires: Date.parse(f.at) + FILE_TTL_MS,
  ...(requests ? { requests: { key: requests.key, size: requests.size } } : {}),
});

/** One file's copy: kept already, else fetched and kept. Null when it cannot be had. */
export async function keepFile(env, f) {
  const key = await fileKey(f);
  const requestsKey = `${key}${REQUESTS}`;
  const kept = await env.FILES.head(key);
  if (kept) {
    const name = kept.customMetadata?.name || f.name || f.id;
    return copyOf(kept, f, name, key, await env.FILES.head(requestsKey));
  }
  const got = await openFile(env, f, MAX_COPY_BYTES);
  if (got.error || !got.size) {
    await got.body?.cancel();
    log('not copied', { source: f.source, error: got.error || 'size unknown' });
    return null;
  }
  const name = got.name || f.name || f.id;
  const stored = await env.FILES.put(key, got.body.pipeThrough(new FixedLengthStream(got.size)), {
    httpMetadata: { contentType: got.type },
    customMetadata: {
      name: String(name).slice(0, 300), thread: f.thread, message: String(f.message),
    },
  });
  let requests = null;
  if (/\.har$/i.test(name)) {
    try {
      const obj = await env.FILES.get(key);
      const lines = await harRequests(obj.body);
      requests = lines && await env.FILES.put(requestsKey, lines, {
        httpMetadata: { contentType: 'application/x-ndjson' },
        customMetadata: { name: `${String(name).slice(0, 280)}${REQUESTS}`, thread: f.thread },
      });
    } catch (e) {
      log('har not read', { error: String(e.message || e).slice(0, 200) });
    }
  }
  log('copied', { source: f.source, bytes: stored.size });
  return copyOf(stored, f, name, key, requests);
}

/**
 * Copies of the files the `readable` messages link to, those of the last 30 days. Resolves to
 * the copies, for `mountList`.
 */
export async function keepThreadFiles(env, messages, { readable, now = Date.now() } = {}) {
  const files = threadFiles(messages, readable)
    .filter((f) => now - Date.parse(f.at) < FILE_TTL_MS)
    .slice(0, MAX_THREAD_FILES);
  const kept = [];
  for (const f of files) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const copy = await keepFile(env, f);
      if (copy) {
        kept.push(copy);
      }
    } catch (e) {
      log('copy failed', { source: f.source, error: String(e.message || e).slice(0, 200) });
    }
  }
  return kept;
}

/** The queue's job for a thread with new files. */
export async function copyThreadFiles(env, thread) {
  if (!env.FILES) {
    return { result: 'skip', reason: 'no bucket' };
  }
  const entry = await entryMessages(env, thread);
  const kept = await keepThreadFiles(env, entry ? entry.messages : []);
  return { result: 'files', files: kept.length };
}

/** A file name as one path segment of the shell: no directories, nothing hidden. */
const safeName = (name) => segment(name).replace(/^\.+/, '') || 'file';

/** `name`, or `name` with a number before its extension, whichever `taken` does not have. */
function unique(name, taken) {
  let out = name;
  for (let n = 2; taken.has(out); n += 1) {
    out = name.replace(/(\.[^.]*)?$/, (ext) => `-${n}${ext}`);
  }
  taken.add(out);
  return out;
}

/**
 * What `/workspace/uploads` holds for `copies`: `{ files: [{ key, path }], index, expires, all }`.
 * `index`: the text of INDEX.txt; `expires`: when the first copy goes; `all`: the copies, for
 * then. A file over the limits is left out, and a HAR's requests are there whatever its size.
 */
export function mountList(copies) {
  const taken = new Set(['INDEX.txt']);
  const files = [];
  const lines = [];
  let bytes = 0;
  const add = (key, path, size) => {
    files.push({ key, path });
    bytes += size;
  };
  for (const c of copies) {
    const name = unique(safeName(c.name), taken);
    const fits = c.size <= MAX_MOUNT_FILE && bytes + c.size <= MAX_MOUNT_BYTES;
    if (fits) {
      add(c.key, name, c.size);
    }
    let line = `${name} (${mb(c.size)})${fits ? '' : ': too large for the shell, not here'}`;
    if (c.requests) {
      const requests = unique(`${name}${REQUESTS}`, taken);
      add(c.requests.key, requests, c.requests.size);
      line += `; its requests, one JSON object a line, no bodies, credentials hidden: ${requests}`;
    }
    lines.push(line);
  }
  return {
    files,
    expires: Math.min(...copies.map((c) => c.expires), Infinity),
    all: copies,
    index: lines.length ? `${lines.join('\n')}\n` : 'No files in this thread.\n',
  };
}

/**
 * The read-only mount of a thread's uploads: `list()` resolves to what `mountList` said, or
 * nothing. It is filled when its version changes, and a Workspace asks once: a new list needs
 * a new Workspace. `FILES` lets objects go at any time, so a missing one is skipped.
 */
export function uploadsMount(bucket, list) {
  return {
    kind: 'thread-uploads',
    mode: 'read-only',
    strategy: 'eager',
    version: async () => sha256(JSON.stringify((await list()) || {})),
    async materialize(api) {
      const { files = [], index = 'No files in this thread.\n' } = (await list()) || {};
      await api.writeFile(`${api.root}/INDEX.txt`, new Response(index).body);
      for (const f of files) {
        // eslint-disable-next-line no-await-in-loop
        const got = await bucket.get(f.key);
        if (got) {
          // eslint-disable-next-line no-await-in-loop
          await api.writeFile(`${api.root}/${f.path}`, got.body);
        }
      }
    },
  };
}
