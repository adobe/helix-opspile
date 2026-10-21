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

import { segment } from './raw.js';

/**
 * Pile 2: one markdown file per message in the CHANNELS bucket, at
 * `channels/<org>/<team>/<source>-<channelId>/<rootId>/<messageId>.md`.
 *
 * Writes are order-independent, so pile 2 can be rebuilt by replaying pile 1 in any
 * order: a file only moves forward to a newer `version`, a tombstone (`deletedAt`) is
 * final, and `raw` collects every pile-1 key that contributed to the file.
 */

export function channelPath({
  org, team, source, channelId, rootId, id,
}) {
  return `channels/${segment(org)}/${segment(team)}/${source}-${segment(channelId)}`
    + `/${segment(rootId)}/${segment(id)}.md`;
}

// Every value is written as JSON, which is valid YAML, so the frontmatter can be read
// back without a YAML parser.
const FIELDS = [
  'source', 'thread', 'logicalThread', 'id', 'at', 'author', 'subject', 'editedAt',
  'deletedAt', 'raw', 'permalink',
];

export function render(meta, body) {
  const lines = FIELDS
    .filter((f) => meta[f] !== undefined && meta[f] !== null)
    .map((f) => `${f}: ${JSON.stringify(meta[f])}`);
  return `---\n${lines.join('\n')}\n---\n${body ? `\n${body}\n` : ''}`;
}

export function parse(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text || '');
  if (!m) {
    return null;
  }
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(': ');
    if (i > 0) {
      try {
        meta[line.slice(0, i)] = JSON.parse(line.slice(i + 2));
      } catch {
        meta[line.slice(0, i)] = line.slice(i + 2);
      }
    }
  }
  return { meta, body: m[2].replace(/^\n/, '').replace(/\n$/, '') };
}

const union = (a = [], b = []) => [...new Set([...a, ...b])].sort();

/**
 * Merges an incoming operation with the file that is already there.
 *
 * @param {object|null} existing `{ meta, body, version, deleted }` or null
 * @param {object} incoming `{ meta, body, version, deleted }`
 * @returns {object|null} what to write, or null when nothing changes
 */
export function merge(existing, incoming) {
  if (!existing) {
    return incoming.deleted ? { ...incoming, body: '' } : incoming;
  }
  const raw = union(existing.meta.raw, incoming.meta.raw);
  const rawChanged = raw.length !== (existing.meta.raw || []).length;

  if (existing.deleted) {
    // A tombstone stays a tombstone; it only learns about more raw objects.
    return rawChanged ? { ...existing, meta: { ...existing.meta, raw } } : null;
  }
  if (incoming.deleted) {
    return {
      version: incoming.version,
      deleted: true,
      meta: {
        ...existing.meta,
        deletedAt: incoming.meta.deletedAt,
        raw,
      },
      body: '',
    };
  }
  if (incoming.version > existing.version) {
    return {
      ...incoming,
      meta: { ...incoming.meta, at: existing.meta.at || incoming.meta.at, raw },
    };
  }
  return rawChanged ? { ...existing, meta: { ...existing.meta, raw } } : null;
}

/** Reads the current file at `path`, with its version from the object's metadata. */
export async function readExisting(bucket, path) {
  const obj = await bucket.get(path);
  if (!obj) {
    return null;
  }
  const parsed = parse(await obj.text());
  if (!parsed) {
    return null;
  }
  const meta = obj.customMetadata || {};
  return {
    ...parsed,
    version: meta.version || '',
    deleted: meta.deleted === '1',
  };
}

/** Writes one merged file. Returns the path, or null when nothing changed. */
export async function writeMessage(bucket, path, incoming) {
  const next = merge(await readExisting(bucket, path), incoming);
  if (!next) {
    return null;
  }
  await bucket.put(path, render(next.meta, next.body), {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    customMetadata: { version: next.version, deleted: next.deleted ? '1' : '0' },
  });
  return path;
}
