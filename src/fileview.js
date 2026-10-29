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

import { download, pickFile, threadFiles } from './agent/files.js';
import { refreshAttachment } from './discord.js';
import { folderFiles } from './filecache.js';
import { json } from './http.js';
import { slackApi } from './lookup.js';
import { keptTeamsFile } from './teamsfiles.js';

/**
 * Files attached to the messages of a thread, for the inbox to show them (the routes check
 * that the viewer may see the thread; these, that a message of it links to the file, and they
 * fetch it with the opspile app's credentials, as an agent's `read_file` does,
 * src/agent/files.js):
 *
 * - `GET /api/file?t=<thread>&u=<link>`: a text file (a CSV, a log, JSON), for the preview of
 *   it (ui/table.js). Only text is passed on, and always as `text/plain` (never HTML the
 *   browser would run): what the file is comes in `x-file-type`, its name in `x-file-name`
 *   (URI-encoded).
 * - `GET /api/file/stream?t=&u=`: a video or audio file, streamed with the browser's `Range`
 *   (seeking asks for parts of it), for the inbox's player. Slack's MP4 copy of a video when
 *   it made one (QuickTime recordings play everywhere then).
 * - `GET /api/file/poster?t=&u=`: the still Slack made of a video, for the player's poster.
 */

// What a preview can show: text by its type, or by its name where the platform says less
// (Slack calls a .har `application/octet-stream`, Teams copies keep what SharePoint said).
const TEXT_TYPE = /^(text\/(?!html)|application\/(json|x-ndjson|ld\+json|yaml|x-yaml|xml|csv|x-csv|x-sh|sql)$)/;
export const TEXT_NAME = /\.(csv|tsv|txt|log|json|ndjson|jsonl|har|md|markdown|ya?ml|xml|ini|conf|cfg|toml|env|properties|sql|sh|diff|patch)$/i;

const baseType = (type) => String(type || '').split(';')[0].trim().toLowerCase();
export const isText = (type, name) => TEXT_TYPE.test(baseType(type))
  || TEXT_NAME.test(String(name || ''));

// Video and audio by their name, with the type the player is given for them.
const MEDIA_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
};
const extOf = (name) => (/\.([a-z0-9]{1,5})$/i.exec(String(name || '')) || [])[1]?.toLowerCase() || '';
/** The type to serve a media file as, or null when it is not video or audio. */
export function mediaType(type, name) {
  const t = baseType(type);
  if (/^(video|audio)\/[a-z0-9.+-]+$/.test(t)) {
    return t;
  }
  return MEDIA_TYPES[extOf(name)] || null;
}

// The Slack bot token goes to Slack's own file host only: a remote file's `url_private` can be
// anywhere (Slack's file docs).
const onSlackHost = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname === 'files.slack.com';
  } catch {
    return false;
  }
};

const MINUTE = 60000;
// Seeking in a video asks for one part after another: the thread's files and Slack's answer
// about a file are kept for a few minutes, so a part costs one fetch, not three.
const refs = new Map(); // `${thread}\u0000${link}` -> { f, at }
const infos = new Map(); // Slack file id -> { info, at }
const MEMO_MAX = 500;
const remember = (map, k, v) => {
  if (map.size >= MEMO_MAX) {
    map.delete(map.keys().next().value);
  }
  map.set(k, { ...v, at: Date.now() });
};
const fresh = (map, k, ttl) => {
  const e = map.get(k);
  return e && Date.now() - e.at < ttl ? e : null;
};
/** Forgets what is kept (tests). */
export function forgetFiles() {
  refs.clear();
  infos.clear();
}

/** A thread's messages from its pile-2 folder, through the inbox's cache of them. */
const cachedMessages = async (env, row) => (await folderFiles(env.CHANNELS, row.path))
  .filter(Boolean).map(({ meta, body }) => ({ ...meta, body }));

/** The file `wanted` (its link) of thread `key`: a ref (src/agent/files.js), or null. */
async function fileOf(env, key, wanted, load) {
  const k = `${key}\u0000${wanted}`;
  const kept = fresh(refs, k, 5 * MINUTE);
  if (kept) {
    return kept.f;
  }
  const row = await env.DB.prepare('SELECT thread, path FROM threads WHERE thread = ?').bind(key).first();
  if (!row || !row.path) {
    return null;
  }
  const f = pickFile(threadFiles(await load(env, row)), wanted);
  if (f) {
    remember(refs, k, { f });
  }
  return f;
}

/** What Slack says about a file (`files.info`), or null when it does not let the app see it. */
async function slackInfo(env, id) {
  const kept = fresh(infos, id, 10 * MINUTE);
  if (kept) {
    return kept.info;
  }
  if (!env.SLACK_BOT_TOKEN) {
    return null;
  }
  try {
    const { file } = await slackApi(env, 'files.info', { file: id });
    const info = file && file.file_access !== 'check_file_info' ? file : null;
    remember(infos, id, { info });
    return info;
  } catch {
    return null;
  }
}

const SAFE = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'",
};

/**
 * The response to `GET /api/file` for file `wanted` (its link) of thread `key`. `load`: how
 * the thread's messages are read (tests give their own).
 */
export async function threadFile(env, key, wanted, { load = cachedMessages } = {}) {
  const f = await fileOf(env, key, wanted, load);
  if (!f) {
    return json({ error: 'not a file of this thread' }, 404);
  }
  const got = await download(env, f);
  if (got.error) {
    return json({ error: got.error }, 502);
  }
  if (!isText(got.type, got.name)) {
    return json({ error: `cannot preview this kind of file (${got.type})` }, 415);
  }
  // Text the browser is told nothing else about: no sniffing, nothing it may load or run.
  return new Response(got.bytes, {
    headers: {
      ...SAFE,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'private, max-age=300',
      'x-file-name': encodeURIComponent(got.name || ''),
      'x-file-type': got.type,
    },
  });
}

/** The part of an R2 object a `Range` asked for, as an HTTP response would say it. */
function r2Part(obj, type) {
  const headers = {
    ...SAFE, 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600',
  };
  const r = obj.range;
  if (r && (r.offset !== undefined || r.suffix !== undefined)) {
    const start = r.suffix !== undefined ? Math.max(0, obj.size - r.suffix) : r.offset;
    const length = r.length !== undefined ? r.length : obj.size - start;
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

/**
 * The response to `GET /api/file/stream`: the video or audio file `wanted` of thread `key`,
 * the part `request` asks for (`Range`). Anything else is refused.
 */
export async function streamFile(env, key, wanted, request, { load = cachedMessages } = {}) {
  const f = await fileOf(env, key, wanted, load);
  if (!f) {
    return json({ error: 'not a file of this thread' }, 404);
  }
  const range = request.headers.get('range');
  if (f.source === 'teams') {
    const obj = await keptTeamsFile(env, f.thread, f.url, range ? { range: request.headers } : {});
    const meta = obj ? { ...obj.httpMetadata, ...obj.customMetadata } : {};
    const type = obj && mediaType(meta.contentType, meta.name || f.name);
    if (!obj || !type) {
      return json({ error: obj ? 'not a video or audio file' : 'opspile has no copy of this Teams file' }, obj ? 415 : 404);
    }
    return r2Part(obj, type);
  }
  let url;
  let type;
  const headers = {};
  if (f.source === 'slack') {
    const info = await slackInfo(env, f.id);
    if (!info) {
      return json({ error: 'Slack does not let opspile read this file' }, 502);
    }
    type = mediaType(info.mimetype, info.name);
    // Slack's MP4 copy where it made one: QuickTime and other recordings play everywhere then.
    url = [info.mp4, info.url_private].find(onSlackHost);
    if (url && url === info.mp4) {
      type = 'video/mp4';
    }
    headers.authorization = `Bearer ${env.SLACK_BOT_TOKEN}`;
  } else {
    type = mediaType('', f.name || f.url.split('?')[0]);
    url = await refreshAttachment(env, f.url).catch(() => f.url);
  }
  if (!type) {
    return json({ error: 'not a video or audio file' }, 415);
  }
  if (!url) {
    return json({ error: 'Slack does not let opspile read this file' }, 502);
  }
  if (range) {
    headers.range = range;
  }
  const res = await fetch(url, { headers });
  // Slack answers a token it does not accept with its sign-in page.
  if (!res.ok || baseType(res.headers.get('content-type')) === 'text/html') {
    return json({ error: `could not load it (${res.status})` }, res.status === 416 ? 416 : 502);
  }
  const out = {
    ...SAFE, 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600',
  };
  for (const h of ['content-length', 'content-range']) {
    if (res.headers.get(h)) {
      out[h] = res.headers.get(h);
    }
  }
  return new Response(res.body, { status: res.status === 206 ? 206 : 200, headers: out });
}

/** The response to `GET /api/file/poster`: the still Slack made of video `wanted`, or 404. */
export async function filePoster(env, key, wanted, { load = cachedMessages } = {}) {
  const f = await fileOf(env, key, wanted, load);
  const info = f && f.source === 'slack' ? await slackInfo(env, f.id) : null;
  const url = info
    && [info.thumb_video, info.thumb_720, info.thumb_480, info.thumb_360].find(onSlackHost);
  if (!url) {
    return json({ error: 'no still of this file' }, 404);
  }
  const res = await fetch(url, { headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
  const type = baseType(res.headers.get('content-type'));
  if (!res.ok || !/^image\/(jpeg|png|gif|webp)$/.test(type)) {
    return json({ error: `could not load it (${res.status})` }, 502);
  }
  return new Response(res.body, { headers: { ...SAFE, 'content-type': type, 'cache-control': 'private, max-age=86400' } });
}
