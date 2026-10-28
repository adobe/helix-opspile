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
 * Files attached to a reply from the inbox: what each platform takes, read from the
 * multipart request, and uploaded with the credentials the post is made with.
 *
 * - Slack (as the person, and as the app): `files.getUploadURLExternal` per file, the bytes
 *   to the URL it gives, then one `files.completeUploadExternal` that shares them in the
 *   thread with the text as `initial_comment`. Needs `files:write` (user scope for the person,
 *   bot scope for the app).
 * - Teams as the person (Graph): images go inline as hosted contents of the message (Graph
 *   takes those up to 4 MB, as base64 in the same request); any other file, and images beyond
 *   that, are uploaded to the channel's SharePoint folder and attached as a reference, which
 *   needs the delegated `Files.ReadWrite.All` the person grants by connecting again.
 * - Teams as the app (Bot Framework): images only, inline as data URIs (PNG, JPEG, GIF up to
 *   1 MB each); Teams lets bots send other files in personal chats only.
 * - Discord as the app: the files in the same request (`files[n]`, multipart), 10 MB in all.
 *
 * A rule says what one kind of post may carry; the inbox gets the same rules (GET /api/me) and
 * checks a file before it is attached, the Worker checks again before anything is uploaded.
 */

const MB = 1024 * 1024;
/** Files per message, on every platform. */
export const MAX_FILES = 10;
/** The largest upload request the Worker reads: every file plus the text. */
export const MAX_REQUEST = 26 * MB;
/** Images Teams shows inline (hosted contents, bot attachments). */
export const WEB_IMAGES = ['image/png', 'image/jpeg', 'image/gif'];
/** Hosted contents of one Graph message, raw bytes: as base64 in the request they are 4 MB. */
export const HOSTED_MAX = 3 * MB;
/** The scopes that let a person's token upload files. */
export const FILES_SCOPE = { slack: 'files:write', teams: 'Files.ReadWrite.All' };

const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Whether a token's granted `scope` (Slack: commas; Microsoft: spaces, maybe URLs) has `name`. */
export const hasScope = (scope, name) => String(scope || '').split(/[\s,]+/)
  .some((s) => s === name || s.endsWith(`/${name}`));

/**
 * What a post may carry: `count` files (0: none, `why` says why), each up to `file` bytes,
 * `total` together. `types` are the only image types that count as images (null: any
 * `image/*`); `other` says whether anything else may go, and `why` why not. `reconnect` names
 * the account to connect again (with file access) to change that.
 */
const SLACK = {
  count: MAX_FILES, file: 20 * MB, total: 25 * MB, types: null, other: true,
};

/** The rule for posting as the person on `platform`, with a token granted `scope` (or none). */
export function personRule(platform, scope) {
  if (platform === 'slack') {
    return hasScope(scope, FILES_SCOPE.slack) ? { ...SLACK } : {
      count: 0,
      why: 'opspile needs your permission to upload files to Slack as you: connect your Slack account again',
      reconnect: 'slack',
    };
  }
  if (platform === 'teams') {
    return hasScope(scope, FILES_SCOPE.teams) ? {
      count: MAX_FILES, file: 20 * MB, total: 25 * MB, types: WEB_IMAGES, other: true,
    } : {
      count: MAX_FILES,
      file: HOSTED_MAX,
      total: HOSTED_MAX,
      types: WEB_IMAGES,
      other: false,
      why: 'on Teams opspile attaches images (PNG, JPEG, GIF) only, until you connect your Microsoft account again with access to the channel\'s files',
      reconnect: 'teams',
    };
  }
  return { count: 0, why: 'opspile cannot post to Discord as you' };
}

/** The rule for posting as the opspile app on `platform`. */
export function appRule(platform) {
  if (platform === 'slack') {
    return { ...SLACK };
  }
  if (platform === 'teams') {
    return {
      count: MAX_FILES,
      file: MB,
      total: MB,
      types: WEB_IMAGES,
      other: false,
      why: 'the opspile Teams bot attaches only images (PNG, JPEG, GIF up to 1 MB): Teams lets bots send other files in personal chats only',
    };
  }
  if (platform === 'discord') {
    return {
      count: MAX_FILES, file: 10 * MB, total: 10 * MB, types: null, other: true,
    };
  }
  return { count: 0, why: `opspile cannot attach files on ${platform}` };
}

const size = (n) => (n >= MB ? `${(n / MB).toFixed(1).replace(/\.0$/, '')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Whether a file counts as an image under `rule`. */
export const isImage = (rule, f) => (rule.types ? rule.types.includes(f.type) : /^image\//.test(f.type || ''));

/** Why `files` cannot go under `rule`, or null when they can. */
export function checkFiles(rule, files) {
  if (!files.length) {
    return null;
  }
  if (!rule.count) {
    return `cannot attach files here: ${rule.why}`;
  }
  if (files.length > rule.count) {
    return `up to ${rule.count} files per message`;
  }
  let total = 0;
  for (const f of files) {
    if (!isImage(rule, f) && !rule.other) {
      return `cannot attach ${f.name}: ${rule.why}`;
    }
    if (!f.size) {
      return `${f.name} is empty`;
    }
    if (f.size > rule.file) {
      return `${f.name} is ${size(f.size)}: files here take up to ${size(rule.file)}`;
    }
    total += f.size;
  }
  if (total > rule.total) {
    return `the files are ${size(total)} together: up to ${size(rule.total)} per message`;
  }
  return null;
}

/** A file name a platform takes: no folders, no characters SharePoint refuses. */
export function cleanName(name) {
  // eslint-disable-next-line no-control-regex
  const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[\s.-]+|\s+$/g, '');
  return clean.slice(-120) || 'file';
}

/**
 * The body of POST /api/post or /api/post/app: JSON as it always was, or `multipart/form-data`
 * with the JSON as `payload` and the files as `files`. `{ body, files }` (each file
 * `{ name, type, size, bytes }`), or `{ error, status }`.
 */
export async function readPost(request) {
  const type = request.headers.get('content-type') || '';
  if (!/^multipart\/form-data/i.test(type)) {
    return { body: await request.json().catch(() => ({})) || {}, files: [] };
  }
  if (Number(request.headers.get('content-length') || 0) > MAX_REQUEST) {
    return { error: `attachments take up to ${size(MAX_REQUEST - MB)} per message`, status: 413 };
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return { error: 'could not read the attachments', status: 400 };
  }
  let body;
  try {
    body = JSON.parse(String(form.get('payload') || '{}')) || {};
  } catch {
    return { error: 'bad payload', status: 400 };
  }
  const parts = form.getAll('files').filter((f) => f && typeof f !== 'string');
  if (parts.length > MAX_FILES) {
    return { error: `up to ${MAX_FILES} files per message`, status: 400 };
  }
  const files = await Promise.all(parts.map(async (f) => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    return {
      name: cleanName(f.name), type: f.type || 'application/octet-stream', size: bytes.length, bytes,
    };
  }));
  return { body, files };
}

/** Bytes as base64, in pieces (a spread of megabytes would overflow the stack). */
export function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

/**
 * Uploads `files` to Slack with `token` and shares them in the thread, `comment` (mrkdwn) as
 * the message: `{ ok, files }` (the file ids), or `{ error }` (Slack's error code).
 */
export async function slackUpload(token, { channel, threadTs, comment }, files) {
  const api = async (method, params) => {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    return res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
  };
  const uploaded = await Promise.all(files.map(async (f) => {
    const got = await api('files.getUploadURLExternal', { filename: f.name, length: String(f.size) });
    if (!got.ok) {
      return { error: got.error || 'upload_url_failed' };
    }
    const up = await fetch(got.upload_url, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f.bytes,
    });
    return up.ok ? { id: got.file_id, title: f.name } : { error: `upload_${up.status}` };
  }));
  const failed = uploaded.find((u) => u.error);
  if (failed) {
    return { error: failed.error };
  }
  const done = await api('files.completeUploadExternal', {
    files: JSON.stringify(uploaded),
    channel_id: channel,
    thread_ts: threadTs,
    ...(comment ? { initial_comment: comment } : {}),
  });
  if (!done.ok) {
    return { error: done.error || 'complete_failed' };
  }
  return { ok: true, files: uploaded.map((u) => u.id) };
}

/**
 * Attachments of a Teams message posted with a person's Graph `token` in thread row `t`:
 * images inline as hosted contents while they fit in one request, the rest uploaded to the
 * channel's SharePoint folder and attached by reference (when `rule.other`). Resolves to
 * `{ html, hostedContents, attachments }` to add to the message, or `{ error, status }`.
 */
export async function teamsAttachments(token, t, files, rule) {
  const hosted = [];
  const others = [];
  let budget = HOSTED_MAX;
  for (const f of files) {
    if (WEB_IMAGES.includes(f.type) && f.size <= budget) {
      hosted.push(f);
      budget -= f.size;
    } else {
      others.push(f);
    }
  }
  if (others.length && !rule.other) {
    return { error: `cannot attach ${others[0].name}: ${rule.why}`, status: 400 };
  }
  const hostedContents = hosted.map((f, i) => ({
    '@microsoft.graph.temporaryId': String(i + 1),
    contentBytes: base64(f.bytes),
    contentType: f.type,
  }));
  const images = hosted.map((f, i) => `<img src="../hostedContents/${i + 1}/$value" alt="${escape(f.name)}">`);
  const attachments = [];
  if (others.length) {
    const auth = { authorization: `Bearer ${token}` };
    const folderRes = await fetch(`${GRAPH}/teams/${encodeURIComponent(t.group_id)}/channels/${encodeURIComponent(t.channel_id)}/filesFolder`, { headers: auth });
    const folder = await folderRes.json().catch(() => ({}));
    if (!folderRes.ok || !folder.id || !folder.parentReference) {
      return { error: `Teams files: ${(folder.error && folder.error.code) || folderRes.status}`, status: folderRes.status === 403 || folderRes.status === 401 ? 409 : 502 };
    }
    const drive = encodeURIComponent(folder.parentReference.driveId);
    const items = await Promise.all(others.map(async (f) => {
      const res = await fetch(`${GRAPH}/drives/${drive}/items/${encodeURIComponent(folder.id)}:/${encodeURIComponent(f.name)}:/content?@microsoft.graph.conflictBehavior=rename`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': f.type },
        body: f.bytes,
      });
      const item = await res.json().catch(() => ({}));
      return res.ok ? item : { error: (item.error && item.error.code) || res.status };
    }));
    const failed = items.find((i) => i.error);
    if (failed) {
      return { error: `Teams files: ${failed.error}`, status: 502 };
    }
    for (const item of items) {
      // A reference attachment is known by the GUID in its file's eTag: "{GUID},version".
      const id = ((/\{?([0-9a-f]{8}-[0-9a-f-]{27})\}?/i.exec(item.eTag || '') || [])[1] || item.id || '').toLowerCase();
      attachments.push({
        id, contentType: 'reference', contentUrl: item.webUrl, name: item.name,
      });
    }
  }
  const html = [...images, ...attachments.map((a) => `<attachment id="${escape(a.id)}"></attachment>`)].join('');
  return { html, hostedContents, attachments };
}

/** Bot Framework attachments for images (Teams shows them inline): data URIs. */
export const botImages = (files) => files.map((f) => ({
  contentType: f.type, contentUrl: `data:${f.type};base64,${base64(f.bytes)}`, name: f.name,
}));

/** A Discord message with files: `payload_json` and `files[n]`, as Discord takes them. */
export function discordForm(message, files) {
  const form = new FormData();
  form.append('payload_json', JSON.stringify({
    ...message,
    attachments: files.map((f, i) => ({ id: i, filename: f.name })),
  }));
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.bytes], { type: f.type }), f.name));
  return form;
}
