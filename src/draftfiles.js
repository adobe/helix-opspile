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

import { json } from './http.js';

/**
 * The files of a draft: pictures that go with it when it is sent, such as a screenshot the
 * thread's agent took on its computer (update_draft's `files`, src/agent/tools.js). A draft
 * keeps their names, types and sizes (`drafts.files`, migration 0103); their bytes are in the
 * FILES bucket under `drafts/<id>`, whose lifecycle rule deletes them after 30 days. The inbox
 * shows them with the draft (`GET /api/draft/file`), and sends them as the reply's files, as a
 * person's own: what the channel takes is checked then (src/attach.js).
 *
 * Only PNG, JPEG, GIF and WebP, as their bytes say (not their names): a browser shows them as
 * pictures and runs nothing of them, and they are served inline under `default-src 'none'`.
 */

export const DRAFT_FILE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_DRAFT_FILES = 4;
export const MAX_DRAFT_FILE_BYTES = 5 * 1024 * 1024;
const PREFIX = 'drafts/';
const ID = /^df_[0-9a-f-]{36}$/;

const SAFE = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'",
};

/** The type a picture's bytes say it is, or null when they are not one of DRAFT_FILE_TYPES. */
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const at = (i, ...v) => v.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png';
  }
  if (at(0, 0xff, 0xd8, 0xff)) {
    return 'image/jpeg';
  }
  if (at(0, 0x47, 0x49, 0x46, 0x38)) {
    return 'image/gif';
  }
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
    return 'image/webp';
  }
  return null;
}

/** A file's name as a draft keeps it: its last path part, without control characters. */
export const fileName = (name) => String(name || 'file').split('/').pop()
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .trim()
  .slice(0, 120) || 'file';

/** A draft's files, from its row's `files`. */
export function filesOf(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.filter((f) => f && ID.test(f.id)) : [];
  } catch {
    return [];
  }
}

/**
 * Keeps a picture for a draft: `{ file: { id, name, type, size } }`, or `{ error }` when it is
 * not a picture the draft takes.
 */
export async function storeDraftFile(env, { bytes, name }) {
  if (!env.FILES) {
    return { error: 'this deployment keeps no files (FILES)' };
  }
  const type = sniffImage(bytes);
  if (!type) {
    return { error: `${fileName(name)} is not a PNG, JPEG, GIF or WebP picture` };
  }
  if (bytes.length > MAX_DRAFT_FILE_BYTES) {
    return { error: `${fileName(name)} is over ${MAX_DRAFT_FILE_BYTES / 1024 / 1024} MB` };
  }
  const file = {
    id: `df_${crypto.randomUUID()}`, name: fileName(name), type, size: bytes.length,
  };
  await env.FILES.put(`${PREFIX}${file.id}`, bytes, { httpMetadata: { contentType: type } });
  return { file };
}

/**
 * The files a save gives a draft: those of `current` it keeps (`keep`, their ids; all of them
 * when left out) and the ones just stored (`added`). `{ files }`, or `{ error }`.
 */
export function savedFiles(current = [], keep = undefined, added = []) {
  let kept = current;
  if (keep !== undefined) {
    if (!Array.isArray(keep)) {
      return { error: 'files is the list of the draft\'s files to keep, by id' };
    }
    const ids = new Set(keep.map(String));
    kept = current.filter((f) => ids.has(f.id));
    if (kept.length !== ids.size) {
      return { error: 'a file to keep is not the draft\'s' };
    }
  }
  const files = [...kept, ...added];
  if (files.length > MAX_DRAFT_FILES) {
    return { error: `a draft has at most ${MAX_DRAFT_FILES} files` };
  }
  return { files };
}

/** GET /api/draft/file?thread=&id=: a file of the entry's draft, `draft` (null: none). */
export async function draftFileResponse(env, draft, id) {
  const f = draft && (draft.files || []).find((x) => x.id === id);
  if (!f) {
    return json({ error: 'not found' }, 404);
  }
  const object = env.FILES && await env.FILES.get(`${PREFIX}${f.id}`);
  if (!object) {
    return json({ error: 'this file is gone: a draft keeps its files for 30 days' }, 404);
  }
  const name = encodeURIComponent(f.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return new Response(object.body, {
    headers: {
      ...SAFE,
      'content-type': DRAFT_FILE_TYPES.includes(f.type) ? f.type : 'application/octet-stream',
      'content-disposition': `inline; filename*=UTF-8''${name}`,
      'cache-control': 'private, max-age=3600',
      'content-length': String(f.size),
    },
  });
}
