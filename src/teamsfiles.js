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

import { cachedGraph } from './graph.js';
import { decodeEntities } from './markdown.js';
import { segment, sha256 } from './raw.js';

/**
 * The files of Teams messages, copied into pile 1 when the message is normalized:
 *
 * - images pasted into a message (`hostedContents`, `<img src="https://graph.microsoft.com/
 *   v1.0/teams/…/hostedContents/<id>/$value">`), fetched with the app's Graph token
 *   (`ChannelMessage.Read.All`);
 * - files attached to it (`reference` attachments: a SharePoint or OneDrive link), fetched
 *   through Graph's `/shares` with the application permission `Files.Read.All` (or
 *   `Sites.Read.All`). Without it they stay links.
 *
 * Each is kept next to the channel's events, under the SHA-256 of its canonical URL:
 *
 * `teams/<tenant>/<team>/<channel>/files/<sha256 of the URL>`: the bytes, with their content
 * type, and `name`, `width`, `height` and `url` as custom metadata.
 *
 * So a message keeps the platform's link, and whoever knows its thread (the inbox's media
 * proxy, an agent's `read_file`) finds the copy from the link alone. A file is fetched once;
 * one Graph does not hand over is not stored, and a later pass (an edit, a replay) asks again.
 * These objects are not events: the normalizer skips them.
 */

export const MAX_TEAMS_FILE_BYTES = 25 * 1024 * 1024;

const HOSTED = /^https:\/\/graph\.microsoft\.com\/v1\.0\/(teams|chats)\/.+\/hostedContents\/[^/]+\/\$value$/;
const SHAREPOINT = /^https:\/\/[a-z0-9-]+\.sharepoint\.com\//i;

/** An https URL in one form, whichever way it was written (spaces, percent-encoding), or null. */
export function canonicalUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Whether `url` is a Teams file opspile copies: a hosted content or a SharePoint file. */
export const isTeamsFileUrl = (url) => {
  const u = canonicalUrl(url);
  return Boolean(u && (HOSTED.test(u) || SHAREPOINT.test(u)));
};

export const isSharePointUrl = (url) => SHAREPOINT.test(canonicalUrl(url) || '');

/** The channel of a Teams thread key (`teams:<tenant>:<team>:<channel>:<root>`), or null. */
export function threadChannel(thread) {
  const p = String(thread || '').split(':');
  if (p[0] !== 'teams' || p.length < 5) {
    return null;
  }
  return { tenant: p[1], team: p[2], channel: p.slice(3, -1).join(':') };
}

/** Whether a pile-1 key is a kept Teams file rather than an event. */
export const isTeamsFileKey = (key) => /^teams\/[^/]+\/[^/]+\/[^/]+\/files\//.test(String(key || ''));

/** Pile-1 key of the copy of the file at `url` in channel `{ tenant, team, channel }`. */
export async function teamsFileKey({ tenant, team, channel }, url) {
  const u = canonicalUrl(url);
  if (!u) {
    return null;
  }
  return `teams/${segment(tenant)}/${segment(team)}/${segment(channel)}/files/${await sha256(u)}`;
}

/** Graph's share id of a sharing URL: `u!` and the URL in unpadded base64url. */
export function shareId(url) {
  let s = '';
  for (const b of new TextEncoder().encode(url)) {
    s += String.fromCharCode(b);
  }
  return `u!${btoa(s).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
}

/** The hosted-content image URLs of a Teams message body. */
export function hostedImages(html) {
  return [...String(html || '').matchAll(/<img\s[^>]*>/gi)]
    .map((m) => (/\ssrc="([^"]*)"/i.exec(m[0]) || [])[1])
    .map((src) => canonicalUrl(decodeEntities(src || '')))
    .filter((u) => u && HOSTED.test(u));
}

const log = (what, extra = {}) => console.log(JSON.stringify({ route: 'normalize', teams: what, ...extra }));

/** Stores bytes under `key`; custom metadata stays under R2's 2 KB. */
async function put(env, key, bytes, {
  type, name, width, height, url, via,
}) {
  const meta = {
    source: 'teams',
    via,
    name: name ? String(name).slice(0, 300) : undefined,
    width: width ? String(width) : undefined,
    height: height ? String(height) : undefined,
    url: url.length <= 1000 ? url : undefined,
    fetchedAt: new Date().toISOString(),
  };
  await env.RAW.put(key, bytes, {
    httpMetadata: { contentType: type || 'application/octet-stream' },
    customMetadata: Object.fromEntries(Object.entries(meta).filter(([, v]) => v)),
  });
}

/** What a kept copy says about itself: `{ type, size, width, height, name }`. */
const describe = (head) => ({
  type: (head.httpMetadata && head.httpMetadata.contentType) || 'application/octet-stream',
  size: head.size,
  width: Number(head.customMetadata && head.customMetadata.width) || undefined,
  height: Number(head.customMetadata && head.customMetadata.height) || undefined,
  name: (head.customMetadata && head.customMetadata.name) || undefined,
});

async function bytesOf(res) {
  const length = Number(res.headers.get('content-length') || 0);
  if (!res.ok || length > MAX_TEAMS_FILE_BYTES) {
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.length <= MAX_TEAMS_FILE_BYTES ? bytes : null;
}

/** Copies a hosted content (an image pasted into the message). */
async function mirrorHosted(env, graph, key, url) {
  const res = await graph(url);
  const bytes = await bytesOf(res);
  if (!bytes) {
    log('hosted content not copied', { status: res.status });
    return null;
  }
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  await put(env, key, bytes, { type, url, via: 'hostedContents' });
  return { type, size: bytes.length };
}

/** Copies a SharePoint or OneDrive file through `/shares`. */
async function mirrorShared(env, graph, key, url, name, raw) {
  let res = await graph(`/shares/${shareId(url)}/driveItem`);
  if (res.status === 404 && raw && raw !== url) {
    // Teams writes the link with spaces; Graph may know it only that way.
    res = await graph(`/shares/${shareId(raw)}/driveItem`);
  }
  if (!res.ok) {
    // 403: the app has no Files.Read.All (or Sites.Read.All); the file stays a link.
    log('file not found', { status: res.status });
    return null;
  }
  const item = await res.json();
  if (!item.file || Number(item.size) > MAX_TEAMS_FILE_BYTES) {
    log('file not copied', { folder: !item.file, size: item.size });
    return null;
  }
  const download = item['@microsoft.graph.downloadUrl'];
  // A pre-authenticated link needs no token; without one, Graph redirects to the content.
  const drive = item.parentReference && item.parentReference.driveId;
  const got = download ? await fetch(download)
    : await graph(drive && item.id ? `/drives/${drive}/items/${item.id}/content`
      : `/shares/${shareId(url)}/driveItem/content`);
  const bytes = await bytesOf(got);
  if (!bytes) {
    log('file not downloaded', { status: got.status });
    return null;
  }
  const type = item.file.mimeType || (got.headers.get('content-type') || '').split(';')[0].trim();
  const { width, height } = item.image || {};
  await put(env, key, bytes, {
    type, name: item.name || name, width, height, url, via: 'shares',
  });
  return {
    type, size: bytes.length, width, height, name: item.name || name,
  };
}

/** The copy of one file: kept already, else fetched and kept; null if Graph does not give it. */
async function mirror(env, getGraph, key, url, name, raw) {
  const kept = await env.RAW.head(key);
  if (kept) {
    return describe(kept);
  }
  try {
    const graph = await getGraph();
    if (!graph) {
      return null;
    }
    return HOSTED.test(url) ? await mirrorHosted(env, graph, key, url)
      : await mirrorShared(env, graph, key, url, name, raw);
  } catch (e) {
    log('file copy failed', { error: String(e.message || e).slice(0, 200) });
    return null;
  }
}

/**
 * The payload of pile-1 key `key` with its files copied into pile 1, and each `reference`
 * attachment that was copied marked with what it is (`opspile: { type, size, width, height }`),
 * so the message can show an image inline. Anything else comes back as it is.
 */
export async function withTeamsFiles(env, key, payload, { graph } = {}) {
  const parts = String(key).split('/');
  if (parts[0] !== 'teams' || !payload || !env.RAW || payload.deletedDateTime
    || parts[parts.length - 1].startsWith('notification-') || !payload.channelIdentity) {
    return payload;
  }
  const { teamId: team, channelId: channel } = payload.channelIdentity;
  const where = { tenant: parts[1], team, channel };
  const refs = (payload.attachments || [])
    .filter((a) => a && a.contentType === 'reference' && isSharePointUrl(a.contentUrl));
  const hosted = hostedImages(payload.body && payload.body.content);
  if (!refs.length && !hosted.length) {
    return payload;
  }
  let client;
  // No Entra app here (a local run): kept copies are used, nothing is fetched.
  const canFetch = graph || (env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);
  const getGraph = async () => {
    client = client || graph || (canFetch ? await cachedGraph(env) : null);
    return client;
  };
  for (const url of new Set(hosted)) {
    // eslint-disable-next-line no-await-in-loop
    await mirror(env, getGraph, await teamsFileKey(where, url), url);
  }
  const copied = new Map();
  for (const a of refs) {
    const url = canonicalUrl(a.contentUrl);
    // eslint-disable-next-line no-await-in-loop
    const fileKey = await teamsFileKey(where, url);
    // eslint-disable-next-line no-await-in-loop
    const info = await mirror(env, getGraph, fileKey, url, a.name, a.contentUrl);
    if (info) {
      copied.set(a, info);
    }
  }
  if (!copied.size) {
    return payload;
  }
  return {
    ...payload,
    attachments: payload.attachments.map((a) => (copied.has(a) ? {
      ...a,
      opspile: Object.fromEntries(Object.entries(copied.get(a))
        .filter(([k, v]) => v !== undefined && k !== 'name')),
    } : a)),
  };
}

/**
 * The kept copy of the file at `url` in Teams thread `thread`: an R2 object with `body`, or
 * null.
 */
export async function keptTeamsFile(env, thread, url, options = {}) {
  const where = threadChannel(thread);
  if (!where || !env.RAW || !isTeamsFileUrl(url)) {
    return null;
  }
  return env.RAW.get(await teamsFileKey(where, url), options);
}
