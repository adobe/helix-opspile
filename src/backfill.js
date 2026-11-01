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

import {
  discordApi, messagesAfter, putDiscord, reactionsOf, threadInfo,
} from './discord.js';
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

// Errors that stay: asking again changes nothing. Anything else may pass, so it is tried again.
const FINAL = /\b(channel_not_found|thread_not_found|not_in_channel|missing_scope|is_archived|no_permission|access_denied|not_authed|invalid_auth|account_inactive|token_revoked)\b|^graph 40[134]\b|^discord 40[134]\b/;

// A request nobody finished, a job that died or was never sent, goes out again this long after.
const SWEEP_AFTER_MS = 60 * 60 * 1000;
// Given up once the thread has been quiet this long.
const GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_LIMIT = 20;

/**
 * Asks for a thread's history once. Returns true if this call created the request.
 *
 *   requested → done, with the messages or with an error that stays
 *
 * A request stays requested through errors that may pass: the queue retries it, and
 * `sweepBackfills` picks up what the queue gave up on, or never got.
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
 * A Discord conversation: its root message in the channel, and the thread started from it
 * (or the forum post), each stored as a history envelope under the requested root.
 */
async function backfillDiscord(env, { tenant: guild, channelId, rootId }) {
  const envelopes = [];
  const root = await discordApi(env, `/channels/${channelId}/messages/${rootId}`, { allow: [403, 404] });
  if (root) {
    envelopes.push({
      t: 'MESSAGE_CREATE', via: 'history', guild, d: root, root: rootId,
    });
  }
  const thread = threadInfo(await discordApi(env, `/channels/${rootId}`, { allow: [403, 404] }));
  if (thread) {
    for (const d of await messagesAfter(env, thread.id, '0', MAX_PAGES * 100)) {
      envelopes.push({
        t: 'MESSAGE_CREATE', via: 'history', guild, d, thread, root: rootId,
      });
    }
  }
  for (const e of envelopes) {
    if (e.d.reactions && e.d.reactions.length) {
      // eslint-disable-next-line no-await-in-loop
      e.reactions = await reactionsOf(env, e.d.channel_id, e.d);
    }
    // eslint-disable-next-line no-await-in-loop
    await putDiscord(env, e);
  }
  return envelopes.length;
}

const BACKFILL = { slack: backfillSlack, teams: backfillTeams, discord: backfillDiscord };

/**
 * Runs one backfill request from the queue. An error that stays is recorded on the request (for
 * example, the bot is not in the channel). Any other is recorded and thrown, for a retry: the
 * request stays open until it is through.
 */
export async function runBackfill(env, request) {
  let count = 0;
  try {
    count = await (BACKFILL[request.source] || backfillTeams)(env, request);
  } catch (e) {
    if (!FINAL.test(e.message)) {
      await env.DB.prepare('UPDATE backfills SET error = ? WHERE thread = ?')
        .bind(e.message, request.thread).run();
      throw e;
    }
    await env.DB.prepare('UPDATE backfills SET done_at = ?, messages = 0, error = ? WHERE thread = ?')
      .bind(new Date().toISOString(), e.message, request.thread).run();
    return { result: 'backfill-failed', messages: 0, error: e.message };
  }
  await env.DB.prepare('UPDATE backfills SET done_at = ?, messages = ?, error = NULL WHERE thread = ?')
    .bind(new Date().toISOString(), count, request.thread).run();
  return { result: 'backfilled', messages: count, error: null };
}

/** What a backfill job needs, from a thread key (Teams channel ids have colons of their own). */
export function requestOf(thread) {
  const parts = String(thread).split(':');
  const [source, tenant] = parts;
  const rootId = parts[parts.length - 1];
  if (source === 'teams') {
    return {
      source, tenant, groupId: parts[2], channelId: parts.slice(3, -1).join(':'), rootId, thread,
    };
  }
  return {
    source, tenant, channelId: parts.slice(2, -1).join(':'), rootId, thread,
  };
}

/**
 * Cron: sends the requests left open out again, an hour apart, and gives up on those of threads
 * that have been quiet for a week.
 */
export async function sweepBackfills(env, now = new Date(), { limit = SWEEP_LIMIT } = {}) {
  const { results } = await env.DB.prepare(`SELECT b.thread, t.any_at FROM backfills b
    LEFT JOIN threads t ON t.thread = b.thread
    WHERE b.done_at IS NULL AND b.requested_at < ? ORDER BY b.requested_at LIMIT ?`)
    .bind(new Date(now.getTime() - SWEEP_AFTER_MS).toISOString(), limit).all();
  const quietSince = new Date(now.getTime() - GIVE_UP_MS).toISOString();
  const done = { sent: 0, gaveUp: 0 };
  for (const { thread, any_at: at } of results || []) {
    if (!at || at < quietSince) {
      // eslint-disable-next-line no-await-in-loop
      await env.DB.prepare(`UPDATE backfills SET done_at = ?, messages = 0,
          error = COALESCE(error, 'gave up') WHERE thread = ?`)
        .bind(now.toISOString(), thread).run();
      done.gaveUp += 1;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await env.DB.prepare('UPDATE backfills SET requested_at = ? WHERE thread = ?')
        .bind(now.toISOString(), thread).run();
      // eslint-disable-next-line no-await-in-loop
      await env.NORMALIZE.send({ backfill: requestOf(thread) });
      done.sent += 1;
    }
  }
  return done;
}
