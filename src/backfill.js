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
import {
  dayPath, messageKey, putRaw, segment,
} from './raw.js';

/**
 * Thread backfill: when a reply arrives whose root opspile has never seen, fetch the
 * whole thread (root and replies) from the history APIs once, store every message in
 * pile 1 marked `via: backfill`, and let the normalizer take it from there.
 */

const MAX_PAGES = 20;

/**
 * Asks for a thread's history once. Returns true if this call created the request.
 */
export async function requestBackfill(env, request) {
  const res = await env.DB.prepare(`INSERT OR IGNORE INTO backfills (thread, requested_at)
    VALUES (?, ?)`).bind(request.thread, new Date().toISOString()).run();
  const created = Boolean(res && res.meta && res.meta.changes);
  if (created) {
    await env.NORMALIZE.send({ backfill: request });
  }
  return created;
}

async function slackReplies(env, channel, ts) {
  const messages = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      channel, ts, limit: '200', ...(cursor ? { cursor } : {}),
    });
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`https://slack.com/api/conversations.replies?${params}`, {
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json();
    if (!data.ok) {
      throw new Error(`slack conversations.replies: ${data.error}`);
    }
    messages.push(...(data.messages || []));
    cursor = (data.response_metadata && data.response_metadata.next_cursor) || '';
    if (!cursor) {
      break;
    }
  }
  return messages;
}

/** Pile-1 key of a backfilled Slack message; a second backfill rewrites it. */
export function slackBackfillKey(tenant, channel, message) {
  return `slack/${segment(tenant)}/${segment(channel)}/${dayPath(new Date(Number(message.ts) * 1000))}`
    + `/${segment(message.ts)}-backfill.json`;
}

async function backfillSlack(env, { tenant, channelId, rootId }) {
  const messages = await slackReplies(env, channelId, rootId);
  for (const message of messages) {
    const body = JSON.stringify({
      type: 'backfill', method: 'conversations.replies', tenant, channel: channelId, message,
    });
    // eslint-disable-next-line no-await-in-loop
    await putRaw(env, slackBackfillKey(tenant, channelId, message), body, {
      source: 'slack', via: 'backfill',
    });
  }
  return messages.length;
}

export async function backfillTeams(env, {
  tenant, groupId, channelId, rootId,
}, { graph: injected } = {}) {
  const graph = injected || await cachedGraph(env);
  const base = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}`
    + `/messages/${encodeURIComponent(rootId)}`;
  const bodies = [];
  const root = await graph(base);
  if (root.ok) {
    bodies.push(await root.text());
  } else if (root.status !== 404) {
    throw new Error(`graph ${root.status} root`);
  }
  let next = `${base}/replies?$top=50`;
  for (let page = 0; next && page < MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await graph(next);
    if (!res.ok) {
      throw new Error(`graph ${res.status} replies`);
    }
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json();
    bodies.push(...(data.value || []).map((m) => JSON.stringify(m)));
    next = data['@odata.nextLink'] || null;
  }
  for (const body of bodies) {
    const message = JSON.parse(body);
    const res = {
      teamId: groupId, channelId, messageId: message.id,
    };
    // eslint-disable-next-line no-await-in-loop
    await putRaw(env, messageKey(tenant, res, message), body, {
      source: 'teams', via: 'backfill',
    });
  }
  return bodies.length;
}

/**
 * Runs one backfill request from the queue. Platform errors are recorded on the request
 * rather than retried forever (for example, the bot is not in the channel).
 */
export async function runBackfill(env, request) {
  let count = 0;
  let error = null;
  try {
    count = request.source === 'slack' ? await backfillSlack(env, request) : await backfillTeams(env, request);
  } catch (e) {
    error = e.message;
  }
  await env.DB.prepare('UPDATE backfills SET done_at = ?, messages = ?, error = ? WHERE thread = ?')
    .bind(new Date().toISOString(), count, error, request.thread).run();
  return { result: error ? 'backfill-failed' : 'backfilled', messages: count, error };
}
