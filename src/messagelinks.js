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
 * One link to a Slack or Teams message, as the message opspile has: a draft's source that is
 * a message (GET /api/draft/source) shows as the card a message link in a thread shows as
 * (src/slacklinks.js), not as the platform's page, which a frame cannot show signed in.
 */

import { teamsOf } from './shares.js';
import { slackMessageRef } from './slackurl.js';

/** Teams' hosts for a message link: the classic one and the new `teams.cloud.microsoft`. */
const TEAMS_HOST = /^(?:[a-z0-9-]+\.)*(?:teams\.microsoft\.com|teams\.cloud\.microsoft)$/i;
/** `/l/message/<channel id, encoded>/<message id>`. */
const TEAMS_PATH = /^\/l\/message\/([^/]+)\/(\d+)\/?$/;

/**
 * `{ source: 'teams', channel, id, tenant }` for a Teams message link (`tenant` from its
 * `tenantId`, or null), or null.
 */
export function teamsMessageRef(address) {
  let url;
  try {
    url = new URL(String(address || '').trim());
  } catch {
    return null;
  }
  const m = url.protocol === 'https:' && TEAMS_HOST.test(url.hostname) && TEAMS_PATH.exec(url.pathname);
  if (!m) {
    return null;
  }
  let channel;
  try {
    channel = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return {
    source: 'teams', channel, id: m[2], tenant: url.searchParams.get('tenantId') || null,
  };
}

/** `{ source, channel, id, tenant }` for a Slack or Teams message link, or null. */
export function messageRef(address) {
  const slack = slackMessageRef(address);
  if (slack) {
    return { source: 'slack', ...slack, tenant: null };
  }
  return teamsMessageRef(address);
}

const lookupSql = `SELECT m.channel_id, m.id, m.thread, m.at, m.author, m.author_key, m.preview,
    t.team
  FROM messages m JOIN threads t ON t.thread = m.thread
  WHERE m.source = ?1 AND m.tenant = ?2 AND m.channel_id = ?3 AND m.id = ?4 AND m.deleted = 0`;

/**
 * The message `address` links to, for someone `canSee(teams, place)` lets see its channel:
 * `{ source, channel, id, thread, at, author, authorKey, preview }` (as src/slacklinks.js
 * gives), or null. A link to no message of opspile's, or to one they may not see, is null.
 * `near` is the thread the link is in (`{ source, tenant }`): a Slack link does not say its
 * workspace, so the thread's is tried first, then every one opspile has the channel in.
 *
 * @param {object} env bindings
 * @param {string} address the link
 * @param {{ near?: object, canSee: Function }} options
 */
export async function linkedMessage(env, address, { near = null, canSee } = {}) {
  const ref = messageRef(address);
  if (!env.DB || !ref || !canSee) {
    return null;
  }
  const first = ref.tenant || (near && near.source === ref.source ? near.tenant : null);
  const find = (tenant) => env.DB.prepare(lookupSql)
    .bind(ref.source, String(tenant), ref.channel, ref.id).first();
  let row = first && await find(first);
  if (!row && !ref.tenant) {
    const { results } = await env.DB.prepare(`SELECT DISTINCT tenant FROM threads
      WHERE channel_id = ? AND source = ?`).bind(ref.channel, ref.source).all();
    for (const { tenant } of results || []) {
      if (tenant !== first) {
        // eslint-disable-next-line no-await-in-loop
        row = await find(tenant);
        if (row) {
          break;
        }
      }
    }
  }
  if (!row) {
    return null;
  }
  const place = { source: ref.source, channel_id: row.channel_id, team: row.team };
  if (!await canSee(await teamsOf(env, place), place)) {
    return null;
  }
  return {
    source: ref.source,
    channel: String(row.channel_id),
    id: String(row.id),
    thread: row.thread,
    at: row.at,
    author: row.author || null,
    authorKey: row.author_key || null,
    preview: row.preview || '',
  };
}
