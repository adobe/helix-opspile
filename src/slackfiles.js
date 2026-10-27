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

import { slackApi } from './lookup.js';
import { segment } from './raw.js';

/**
 * Files shared in Slack Connect channels. Slack's events (and history) carry only a stub of a
 * file uploaded there, `{ id, file_access: 'check_file_info', filetype }`, without name, link or
 * URL; the app has to ask `files.info` (bot scope `files:read`). The answer is kept in pile 1,
 * next to the channel's events, so a replay needs no Slack:
 *
 * `slack/<tenant>/<channel>/files/<file id>.json`: `{ type: 'file_info', file, fetched_at }`
 *
 * It is not an event: the normalizer skips it. Only the fields a message needs are kept (not
 * `shares`, which quotes the messages of other channels the file is in). A file Slack does not
 * show the app is not stored, so a later pass asks again; the message says the file is there.
 */

const FIELDS = [
  'id', 'name', 'title', 'mimetype', 'filetype', 'pretty_type', 'size', 'url_private',
  'url_private_download', 'permalink', 'original_w', 'original_h', 'created', 'user',
  'user_team', 'is_external', 'mode',
];

export const STUB = 'check_file_info';

export const slackFileKey = (tenant, channel, id) => `slack/${segment(tenant)}/${segment(channel)}/files/${segment(id)}.json`;

const pick = (file) => Object.fromEntries(FIELDS.filter((k) => file[k] !== undefined)
  .map((k) => [k, file[k]]));

/** The messages of a Slack payload (an event, an edit, a backfilled message) that carry files. */
function messagesOf(payload) {
  const e = payload.type === 'backfill' ? payload.message : payload.event;
  return [e, e && e.message].filter((m) => m && Array.isArray(m.files));
}

/** What `files.info` says about a file: kept in pile 1, else asked and kept; null if refused. */
async function fileInfo(env, tenant, channel, id) {
  const key = slackFileKey(tenant, channel, id);
  const kept = await env.RAW.get(key);
  if (kept) {
    return JSON.parse(await kept.text()).file || null;
  }
  if (!env.SLACK_BOT_TOKEN) {
    return null;
  }
  try {
    const { file } = await slackApi(env, 'files.info', { file: id });
    if (!file || file.file_access === STUB) {
      return null;
    }
    const info = pick(file);
    await env.RAW.put(key, JSON.stringify({
      type: 'file_info', file: info, fetched_at: new Date().toISOString(),
    }), { httpMetadata: { contentType: 'application/json' }, customMetadata: { source: 'slack', via: 'files.info' } });
    return info;
  } catch (e) {
    console.log(JSON.stringify({ route: 'normalize', slack: 'files.info failed', error: e.message }));
    return null;
  }
}

/**
 * The payload of pile-1 key `key` with the Slack Connect file stubs of its messages replaced by
 * what `files.info` says about them. Anything else comes back as it is.
 */
export async function withSlackFiles(env, key, payload) {
  const [source, tenant, channel] = String(key).split('/');
  if (source !== 'slack' || !payload || !env.RAW) {
    return payload;
  }
  const messages = messagesOf(payload);
  const ids = [...new Set(messages.flatMap((m) => m.files)
    .filter((f) => f && f.file_access === STUB && f.id).map((f) => f.id))];
  if (!ids.length) {
    return payload;
  }
  const found = new Map();
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    found.set(id, await fileInfo(env, tenant, channel, id));
  }
  const fill = (m) => ({
    ...m,
    files: m.files.map((f) => (f && found.get(f.id) ? { ...found.get(f.id) } : f)),
  });
  const out = structuredClone(payload);
  if (out.type === 'backfill') {
    out.message = fill(out.message);
    if (out.message.message && Array.isArray(out.message.message.files)) {
      out.message.message = fill(out.message.message);
    }
  } else {
    if (Array.isArray(out.event.files)) {
      out.event = fill(out.event);
    }
    if (out.event.message && Array.isArray(out.event.message.files)) {
      out.event.message = fill(out.event.message);
    }
  }
  return out;
}
