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

import { discordEnabled, refreshAttachment } from '../discord.js';
import { slackApi } from '../lookup.js';
import { canonicalUrl, isTeamsFileUrl, keptTeamsFile } from '../teamsfiles.js';

/**
 * The files people attached to the messages of an agent's thread, for its `read_file` tool.
 * Only files a message of its own thread links to can be read, with the opspile app's
 * credentials (the Slack bot token, scope `files:read`; the Discord bot, which refreshes
 * attachment links), never anyone's own:
 *
 * - images (PNG, JPEG, GIF, WebP up to 3.75 MB) go to the model as images;
 * - plain text (text/*, JSON) is read as it is;
 * - everything else (PDF, Word and Excel, OpenDocument, Numbers, HTML, XML, CSV, larger images)
 *   goes through Workers AI's Markdown conversion (`env.AI.toMarkdown`); PowerPoint is not one
 *   of its formats.
 *
 * What a file says is written by people outside the agent's control, like a message: its text
 * goes through the same prompt-injection check (Clef) and is withheld when flagged.
 *
 * Teams files (SharePoint and OneDrive files, pasted images) are read from the copies the
 * normalizer keeps in pile 1 (src/teamsfiles.js); one without a copy cannot be read.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;
export const MAX_FILE_TEXT = 30000;
// The injection check reads up to this much at a time (src/agent/deliver.js).
export const SCREEN_CHUNK = 6000;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const PLAIN = /^(text\/(?!html)|application\/(json|x-ndjson|yaml|x-yaml)$)/;

const SLACK_PERMALINK = /^https:\/\/[a-z0-9.-]+\.slack\.com\/files\/[^/]+\/(F[A-Z0-9]+)(?:\/|$)/i;
const SLACK_PRIVATE = /^https:\/\/files\.slack\.com\/files-(?:pri|tmb)\/[A-Z0-9]+-(F[A-Z0-9]+)\//i;
const DISCORD = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/\d+\/\d+\/[^?#\s]+/;

/** Markdown links of a message body: `{ label, url }`. */
const links = (body) => [...String(body || '').matchAll(/\[((?:\\.|[^\]\\])*)\]\((https:\/\/[^)\s]+)/g)]
  .map((m) => ({ label: m[1].replace(/\\(.)/g, '$1'), url: m[2] }));

/** A file reference from a link, or null: `{ source, id, url }`. */
export function fileRef(link) {
  const url = String(link || '').trim().replace(/^<|>$/g, '');
  const slack = SLACK_PERMALINK.exec(url) || SLACK_PRIVATE.exec(url);
  if (slack) {
    return { source: 'slack', id: slack[1].toUpperCase(), url };
  }
  const discord = DISCORD.exec(url);
  if (discord) {
    return { source: 'discord', id: discord[0], url };
  }
  if (isTeamsFileUrl(url)) {
    return { source: 'teams', id: canonicalUrl(url), url: canonicalUrl(url) };
  }
  return null;
}

/** The files the readable messages link to: refs with the message (`id`, `at`) and link text. */
export function threadFiles(messages, readable = () => true) {
  const out = new Map();
  for (const m of messages || []) {
    if (!m.deletedAt && readable(m)) {
      for (const { label, url } of links(m.body)) {
        const ref = fileRef(url);
        if (ref && !out.has(ref.id)) {
          out.set(ref.id, {
            ...ref, name: label || null, message: m.id, at: m.at, thread: m.thread,
          });
        }
      }
    }
  }
  return [...out.values()];
}

/** Which of `files` the agent asked for: a link as the message shows it, or a Slack file id. */
export function pickFile(files, wanted) {
  const w = String(wanted || '').trim();
  const ref = fileRef(w);
  const id = ref ? ref.id : w.toUpperCase();
  return files.find((f) => f.id === id || (ref && f.id === ref.id)) || null;
}

/** A Teams file from its copy in pile 1: `{ bytes, type, name }` or `{ error }`. */
async function keptCopy(env, f, name) {
  const kept = await keptTeamsFile(env, f.thread, f.url);
  if (!kept) {
    return { error: 'opspile has no copy of this Teams file (it could not read it from SharePoint)' };
  }
  if (kept.size > MAX_FILE_BYTES) {
    return { error: `too large (${Math.round(kept.size / 1024 / 1024)} MB; up to 10 MB)` };
  }
  return {
    bytes: new Uint8Array(await kept.arrayBuffer()),
    type: (kept.httpMetadata && kept.httpMetadata.contentType) || 'application/octet-stream',
    name: (kept.customMetadata && kept.customMetadata.name) || name,
  };
}

/** Fetches the file's bytes with the app's credentials: `{ bytes, type, name }` or `{ error }`. */
async function download(env, f) {
  let { url } = f;
  let name = f.name || url.split('/').pop().split('?')[0];
  if (f.source === 'teams') {
    return keptCopy(env, f, name);
  }
  let type = '';
  const headers = {};
  if (f.source === 'slack') {
    if (!env.SLACK_BOT_TOKEN) {
      return { error: 'the opspile Slack app is not set up here' };
    }
    let file;
    try {
      ({ file } = await slackApi(env, 'files.info', { file: f.id }));
    } catch (e) {
      return { error: `Slack does not let opspile read this file (${e.message.replace(/^slack files\.info: /, '')})` };
    }
    if (!file || file.file_access === 'check_file_info' || !(file.url_private_download || file.url_private)) {
      return { error: 'Slack does not let opspile read this file' };
    }
    if (file.size > MAX_FILE_BYTES) {
      return { error: `too large (${Math.round(file.size / 1024 / 1024)} MB; up to 10 MB)` };
    }
    url = file.url_private_download || file.url_private;
    name = file.name || name;
    type = file.mimetype || '';
    headers.authorization = `Bearer ${env.SLACK_BOT_TOKEN}`;
  } else if (f.source === 'discord') {
    if (!discordEnabled(env)) {
      return { error: 'the opspile Discord bot is not set up here' };
    }
    url = await refreshAttachment(env, url).catch(() => url);
  }
  const res = await fetch(url, { headers, redirect: 'follow' });
  const got = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  // Slack answers a token it does not accept with its sign-in page.
  if (!res.ok || (f.source === 'slack' && got === 'text/html' && type !== 'text/html')) {
    return { error: `could not download it (${res.status})` };
  }
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_FILE_BYTES) {
    return { error: `too large (${Math.round(length / 1024 / 1024)} MB; up to 10 MB)` };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) {
    return { error: 'too large (up to 10 MB)' };
  }
  return { bytes, type: type || got || 'application/octet-stream', name };
}

const base64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

/** The file's content: `{ text, kind }` (converted or plain), `{ image }`, or `{ error }`. */
export async function fileContent(env, { bytes, type, name }) {
  if (IMAGE_TYPES.includes(type) && bytes.length <= MAX_IMAGE_BYTES) {
    return { image: { type: 'image', data: base64(bytes), mimeType: type } };
  }
  if (PLAIN.test(type)) {
    return { text: new TextDecoder().decode(bytes), kind: 'text' };
  }
  if (!env.AI || typeof env.AI.toMarkdown !== 'function') {
    return { error: 'opspile cannot convert this kind of file here' };
  }
  try {
    const r = await env.AI.toMarkdown({ name, blob: new Blob([bytes], { type }) });
    const out = Array.isArray(r) ? r[0] : r;
    if (!out || out.format === 'error') {
      return { error: `could not convert it (${(out && out.error) || 'no result'})` };
    }
    return { text: String(out.data || ''), kind: 'converted' };
  } catch (e) {
    return { error: `could not convert it (${String(e.message || e).slice(0, 200)})` };
  }
}

/**
 * Reads a file of the thread for the agent. `messages`: the thread's messages; `readable(m)`:
 * whether the agent may see message `m` (not withheld); `screen(text)`: the injection check,
 * resolving to `{ flagged, p }`. `offset`: where to start in a long text. Resolves to
 * `{ file, text?, image?, more?, withheld? }` or `{ error }`.
 */
export async function readThreadFile(env, {
  messages, readable, screen, wanted, offset = 0,
}) {
  const files = threadFiles(messages, readable);
  const f = pickFile(files, wanted);
  if (!f) {
    const list = files.map((x) => x.url).slice(0, 10);
    return {
      error: `That is not a file of your thread. Give the link as a message shows it${list.length ? `; the files of your thread: ${list.join(', ')}` : ' (your thread has no files opspile can read)'}.`,
    };
  }
  const got = await download(env, f);
  if (got.error) {
    return { error: got.error };
  }
  const file = {
    name: got.name, type: got.type, bytes: got.bytes.length, message: f.message,
  };
  const content = await fileContent(env, got);
  if (content.error) {
    return { error: content.error, file };
  }
  if (content.image) {
    return { file, image: content.image };
  }
  const from = Math.max(0, Math.floor(Number(offset) || 0));
  const text = content.text.slice(from, from + MAX_FILE_TEXT);
  // Every part the agent gets is checked, as a message of its own would be.
  const parts = [];
  for (let i = 0; i < text.length; i += SCREEN_CHUNK) {
    parts.push(text.slice(i, i + SCREEN_CHUNK));
  }
  const verdicts = await Promise.all(parts.map((part) => screen(part)));
  const bad = verdicts.find((v) => v && v.flagged);
  if (bad) {
    return { file, withheld: bad.p === null ? 'the check failed' : `p=${bad.p.toFixed(2)}` };
  }
  return {
    file: { ...file, converted: content.kind === 'converted', chars: content.text.length },
    text,
    ...(from + MAX_FILE_TEXT < content.text.length ? { more: from + MAX_FILE_TEXT } : {}),
  };
}
