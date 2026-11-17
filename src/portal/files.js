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

import { imageSize } from '../agent/images.js';
import { gravatar } from '../raw.js';
import { fileId, filePath } from './ids.js';

/**
 * The customer portal's files, in its bucket (`FILES`) and the `files` table
 * (portal/migrations/0002_files.sql):
 *
 * - **attachments** of messages, `files/<lobby>/<channel>/<id>`: uploaded to a channel first,
 *   then named by the message that carries them. Whoever is in the channel's lobby reads them,
 *   and the inbox, for the channel's threads.
 * - **pictures** of people, `avatars/<user>/<version>`, and **logos** of customers,
 *   `logos/<domain>/<version>`: small images their owners upload.
 *
 * What people upload is theirs, not the portal's: it is served so that a browser runs none of
 * it. Only raster images, video and audio are shown in the page; everything else is a
 * download, and nothing is sniffed or may load anything.
 */

const MB = 1024 * 1024;
/** An attachment's size, how many a message carries, and a picture's size. */
export const MAX_FILE_BYTES = 20 * MB;
export const MAX_FILES = 10;
export const MAX_PICTURE_BYTES = 512 * 1024;
/** A file no message took is deleted after this long. */
const ORPHAN_MS = 24 * 60 * 60 * 1000;

/** What a browser may show in the page: raster images, video and audio. Never SVG or HTML. */
const SHOWN = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|quicktime|ogg)|audio\/(mpeg|mp4|ogg|wav|webm|aac|flac|x-m4a))$/;
const PICTURE = /^image\/(png|jpeg|webp|gif)$/;

const baseType = (type) => String(type || '').split(';')[0].trim().toLowerCase();
const iso = (now) => new Date(now).toISOString();
const fail = (error, status = 400) => ({ error, status });

/** A file's name as it is kept: its last path segment, without control characters. */
export function cleanName(name) {
  // eslint-disable-next-line no-control-regex
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return base.slice(0, 200) || 'file';
}

const bytesOf = (body) => (body instanceof Uint8Array ? body : new Uint8Array(body || []));

const fileKey = (f) => `files/${f.lobby}/${f.channel}/${f.id}`;

/** A file as the page and the events name it; `origin`: for an address outside the portal. */
export const fileInfo = (f, origin = '') => ({
  id: f.id,
  name: f.name,
  type: f.type,
  size: f.size,
  ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
  url: `${origin}${filePath(f.id, f.name)}`,
});

/**
 * Keeps a file `user` (an account row) uploads to `channel`, for a message they are writing:
 * `{ ok, file }` or `{ error, status }`. An image's size is read from its bytes; `width` and
 * `height` are what its uploader measured, for an image the portal cannot read. They only lay
 * the page out.
 */
export async function uploadFile(env, channel, user, {
  name, type, bytes, width, height,
}, now = Date.now()) {
  if (!env.FILES) {
    return fail('the portal keeps no files here', 409);
  }
  const body = bytesOf(bytes);
  if (!body.length) {
    return fail('the file is empty');
  }
  if (body.length > MAX_FILE_BYTES) {
    return fail(`a file is up to ${MAX_FILE_BYTES / MB} MB`, 413);
  }
  const side = (n) => (Number.isInteger(Number(n)) && n > 0 && n <= 30000 ? Number(n) : null);
  const mime = baseType(type) || 'application/octet-stream';
  const read = /^image\//.test(mime) ? imageSize(body) : null;
  const file = {
    id: fileId(),
    lobby: channel.lobby,
    channel: channel.id,
    name: cleanName(name),
    type: mime,
    size: body.length,
    width: side(read ? read.width : width),
    height: side(read ? read.height : height),
  };
  await env.FILES.put(fileKey(file), body, { httpMetadata: { contentType: file.type } });
  await env.DB.prepare(`INSERT INTO files (id, lobby, channel, name, type, size, width, height,
      uploaded_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      file.id,
      file.lobby,
      file.channel,
      file.name,
      file.type,
      file.size,
      file.width,
      file.height,
      user.id,
      iso(now),
    ).run();
  return { ok: true, file: fileInfo(file) };
}

/**
 * The files `ids` as a message of `author` in `channel` may take them: uploaded there by its
 * author, and in no message yet. `{ files }` (rows), or `{ error, status }` when one is not.
 */
export async function takeFiles(env, channel, author, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (!wanted.length) {
    return { files: [] };
  }
  if (wanted.length > MAX_FILES) {
    return fail(`a message carries up to ${MAX_FILES} files`);
  }
  const { results } = await env.DB.prepare(`SELECT * FROM files WHERE channel = ?
      AND uploaded_by = ? AND message IS NULL AND id IN (SELECT value FROM json_each(?))
    ORDER BY at, rowid`).bind(channel.id, author.id, JSON.stringify(wanted)).all();
  if ((results || []).length !== wanted.length) {
    return fail('a file is not there to attach: upload it again');
  }
  return { files: results };
}

/** The files of the messages `ids`, by message, in the order they were uploaded. */
export async function filesOf(env, ids) {
  const by = new Map();
  if (!ids.length) {
    return by;
  }
  const { results } = await env.DB.prepare(`SELECT * FROM files
    WHERE message IN (SELECT value FROM json_each(?)) ORDER BY at, rowid`)
    .bind(JSON.stringify(ids)).all();
  for (const f of results || []) {
    (by.get(f.message) || by.set(f.message, []).get(f.message)).push(f);
  }
  return by;
}

/** Deletes the files of message `id`: the rows, then the bytes. */
export async function deleteFilesOf(env, id) {
  const { results } = await env.DB.prepare('SELECT * FROM files WHERE message = ?').bind(id).all();
  if (!(results || []).length) {
    return 0;
  }
  await env.DB.prepare('DELETE FROM files WHERE message = ?').bind(id).run();
  await Promise.all(results.map((f) => env.FILES.delete(fileKey(f)).catch(() => {})));
  return results.length;
}

/** Cron: deletes the files no message took within a day. */
export async function pruneFiles(env, now = Date.now()) {
  if (!env.FILES) {
    return { deleted: 0 };
  }
  const { results } = await env.DB.prepare(`SELECT * FROM files WHERE message IS NULL
    AND at < ? LIMIT 200`).bind(iso(now - ORPHAN_MS)).all();
  for (const f of results || []) {
    // eslint-disable-next-line no-await-in-loop
    await env.FILES.delete(fileKey(f)).catch(() => {});
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare('DELETE FROM files WHERE id = ? AND message IS NULL').bind(f.id).run();
  }
  return { deleted: (results || []).length };
}

/**
 * File `id` of lobby `domain` (and of `channel`, when given), or null: one a message carries
 * that is not deleted, or one still waiting for its message.
 */
export async function fileRow(env, domain, id, channel = null) {
  return env.DB.prepare(`SELECT * FROM files f WHERE f.id = ?1 AND f.lobby = ?2
    AND (?3 IS NULL OR f.channel = ?3) AND NOT EXISTS (SELECT 1 FROM messages m
      WHERE m.id = f.message AND m.deleted_at IS NOT NULL)`)
    .bind(String(id || ''), String(domain || ''), channel ? String(channel) : null).first();
}

/** The part of an object a `Range` header asks for, as R2 takes it, or undefined. */
export function rangeOf(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (!m[1] && !m[2])) {
    return undefined;
  }
  if (!m[1]) {
    return { suffix: Number(m[2]) };
  }
  const offset = Number(m[1]);
  return m[2] ? { offset, length: Number(m[2]) - offset + 1 } : { offset };
}

/** What every answer with somebody's bytes says: nothing is sniffed, loaded or run. */
const SAFE = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'same-origin',
};

/** An object of the bucket as an answer, whole or the part asked for. */
function served(obj, headers) {
  const r = obj.range;
  if (r && (r.offset !== undefined || r.suffix !== undefined)) {
    const start = r.suffix !== undefined ? Math.max(0, obj.size - r.suffix) : r.offset;
    const length = r.length !== undefined ? Math.min(r.length, obj.size - start) : obj.size - start;
    return new Response(obj.body, {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${start}-${start + length - 1}/${obj.size}`,
        'content-length': String(length),
      },
    });
  }
  return new Response(obj.body, { headers: { ...headers, 'content-length': String(obj.size) } });
}

const notFound = (what) => new Response(`${what}\n`, {
  status: 404, headers: { 'content-type': 'text/plain', 'cache-control': 'private, max-age=300' },
});

/**
 * A file's bytes as an answer: shown in the page when it is an image, a video or audio, a
 * download otherwise. `x-file-name` and `x-file-type` say what it is to the inbox, which
 * decides for itself how to pass it on.
 */
export async function fileResponse(env, file, range = null) {
  const part = rangeOf(range);
  const obj = env.FILES && await env.FILES.get(fileKey(file), part ? { range: part } : {});
  if (!obj) {
    return notFound('the file is gone');
  }
  const shown = SHOWN.test(file.type);
  const star = encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return served(obj, {
    ...SAFE,
    'content-type': shown ? file.type : 'application/octet-stream',
    'content-disposition': `${shown ? 'inline' : 'attachment'}; filename*=UTF-8''${star}`,
    'accept-ranges': 'bytes',
    // A file never changes: an id names one upload.
    'cache-control': 'private, max-age=86400, immutable',
    'x-file-name': encodeURIComponent(file.name),
    'x-file-type': file.type,
  });
}

/**
 * Keeps a picture (`avatars`) or a logo (`logos`) of `owner` (an account id, a mail domain):
 * `{ ok, key }`, the new object's key, or `{ error, status }`. The one before is deleted.
 */
export async function putPicture(
  env,
  kind,
  owner,
  { type, bytes },
  before = null,
  now = Date.now(),
) {
  if (!env.FILES) {
    return fail('the portal keeps no files here', 409);
  }
  const body = bytesOf(bytes);
  const mime = baseType(type);
  if (!PICTURE.test(mime)) {
    return fail('a picture is a PNG, JPEG, WebP or GIF image', 415);
  }
  if (!body.length || body.length > MAX_PICTURE_BYTES) {
    return fail(`a picture is up to ${MAX_PICTURE_BYTES / 1024} KB`, body.length ? 413 : 400);
  }
  const key = `${kind}/${owner}/${Math.floor(now).toString(36)}${fileId().slice(1, 7)}`;
  await env.FILES.put(key, body, { httpMetadata: { contentType: mime } });
  if (before && before !== key) {
    await env.FILES.delete(before).catch(() => {});
  }
  return { ok: true, key };
}

/** Deletes a picture or a logo. */
export async function dropPicture(env, key) {
  if (key && env.FILES) {
    await env.FILES.delete(key).catch(() => {});
  }
}

/** What tells one picture of an owner from the one before, for its address. */
export const pictureVersion = (key) => String(key || '').split('/').pop() || null;

/** A picture or a logo from the bucket, as an answer; 404 when there is none. */
export async function pictureResponse(env, key) {
  const obj = key && env.FILES ? await env.FILES.get(key) : null;
  if (!obj) {
    return notFound('no picture');
  }
  const type = baseType(obj.httpMetadata && obj.httpMetadata.contentType);
  return new Response(obj.body, {
    headers: {
      ...SAFE,
      'content-type': PICTURE.test(type) ? type : 'application/octet-stream',
      'cache-control': 'private, max-age=86400',
    },
  });
}

/**
 * The picture of account `u` as an answer: the one they uploaded, else the one the inbox knows
 * (Adobe's people: their Slack or Gravatar picture), else their Gravatar. Fetched here, so the
 * customer's browser asks nobody but the portal. 404 when there is none.
 */
export async function avatarResponse(env, u, fetchImpl = fetch) {
  if (u.avatar_key) {
    return pictureResponse(env, u.avatar_key);
  }
  const url = /^https:\/\//.test(u.avatar || '') ? u.avatar : await gravatar(u.email);
  if (!url) {
    return notFound('no picture');
  }
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'follow' });
  } catch {
    return notFound('no picture');
  }
  const type = baseType(res.headers.get('content-type'));
  const length = Number(res.headers.get('content-length') || 0);
  if (!res.ok || !PICTURE.test(type) || length > 4 * MB) {
    await res.body?.cancel();
    return notFound('no picture');
  }
  return new Response(res.body, {
    headers: { ...SAFE, 'content-type': type, 'cache-control': 'private, max-age=86400' },
  });
}
