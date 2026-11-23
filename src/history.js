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

import { FINAL, slackReplies } from './backfill.js';
import { cachedGraph } from './graph.js';
import { loadRules, toChannel } from './lookup.js';
import {
  dayPath, messageKey, segment, writeRaw,
} from './raw.js';
import { classify } from './rules.js';

/**
 * History import: the threads a channel had before the inbox did, read from the platforms'
 * history APIs (Slack's `conversations.history`, Graph's channel messages) page by page, one
 * queue job a page, and stored in pile 1 as `via: import`. The normalizer files and indexes
 * them like any message, but they wake nobody (src/normalizer.js), and a thread of nothing but
 * imported messages is `imported` in D1: read, waiting on nobody, without agent, label, vectors
 * or full-text items until someone asks for them. `scripts/import.mjs` starts it.
 *
 * - A channel's threads started since `since` (Slack: roots posted since; Graph lists threads by
 *   their latest activity, and the listing ends at the first one quiet since before `since`).
 * - A thread the inbox has already (heard of live, or backfilled) is left as it is. One imported
 *   before is imported again: the same keys, so nothing changes but what changed since.
 * - `history_imports` has one row per channel: where the next page starts, what came of it.
 *
 *   requested → page by page → done, or ended by an error that stays
 *
 * An error that may pass is thrown, for the queue to retry the page; one that outlives the
 * retries leaves the row open, with its error, for `scripts/import.mjs --resume`.
 */

/** Pile 1 says so (`via`) of every object the import writes. */
export const IMPORT_VIA = 'import';

const SLACK_PAGE = 50;
const TEAMS_PAGE = 20;
/** Pile-1 objects one job writes, about: a page stops after the thread that passes it. */
const BUDGET = 300;
/**
 * Between two pages of a channel, and up to as much again at random: the channels' pages spread
 * out, so a queue batch rarely holds several (each is a few hundred subrequests).
 */
const PAGE_DELAY_SECONDS = 30;
const MAX_REPLY_PAGES = 20;

/** Pile-1 key of an imported Slack message; the import of it again rewrites it. */
export function slackImportKey(tenant, channel, message) {
  return `slack/${segment(tenant)}/${segment(channel)}/${dayPath(new Date(Number(message.ts) * 1000))}`
    + `/${segment(message.ts)}-import.json`;
}

async function slackHistory(env, job) {
  const params = new URLSearchParams({
    channel: job.channelId,
    oldest: String(Date.parse(job.since) / 1000),
    limit: String(SLACK_PAGE),
    ...(job.cursor ? { cursor: job.cursor } : {}),
  });
  const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
    headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  if (res.status === 429) {
    throw new Error('slack conversations.history: 429 ratelimited');
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`slack conversations.history: ${data.error}`);
  }
  return data;
}

/** One page of a Slack channel's roots, each with what reads its thread and what stores it. */
async function slackPage(env, job) {
  const data = await slackHistory(env, job);
  const { tenant, channelId } = job;
  // Replies sent to the channel too (`thread_broadcast`) come with their thread.
  const roots = (data.messages || []).filter((m) => m.ts && (!m.thread_ts || m.thread_ts === m.ts));
  return {
    next: (data.response_metadata && data.response_metadata.next_cursor) || null,
    roots: roots.map((root) => ({
      thread: `slack:${tenant}:${channelId}:${root.ts}`,
      read: async () => (root.reply_count ? slackReplies(env, channelId, root.ts) : [root]),
      objects: (messages) => messages.map((message) => ({
        key: slackImportKey(tenant, channelId, message),
        source: 'slack',
        body: JSON.stringify({
          type: 'backfill',
          method: root.reply_count ? 'conversations.replies' : 'conversations.history',
          tenant,
          channel: channelId,
          message,
        }),
      })),
    })),
  };
}

const at = (m) => Math.max(...[m.lastModifiedDateTime, m.createdDateTime]
  .map((d) => Date.parse(d)).filter(Number.isFinite), 0);

/** A Graph message as Graph sends it on its own: without the replies it was listed with. */
const alone = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('replies')));

/**
 * One page of a Teams channel's threads, with their replies (`$expand=replies`). Graph lists
 * them by their latest activity, newest first: the first one quiet since before `since` ends it.
 */
async function teamsPage(env, job, graph) {
  const { tenant, groupId, channelId } = job;
  const res = await graph(job.cursor || `/teams/${encodeURIComponent(groupId)}/channels/`
    + `${encodeURIComponent(channelId)}/messages?$top=${TEAMS_PAGE}&$expand=replies`);
  if (!res.ok) {
    throw new Error(`graph ${res.status} messages`);
  }
  const data = await res.json();
  const since = Date.parse(job.since);
  const roots = [];
  let over = false;
  for (const m of data.value || []) {
    const replies = m.replies || [];
    if (Math.max(at(m), ...replies.map(at)) < since) {
      over = true;
      break;
    }
    if ((Date.parse(m.createdDateTime) || 0) >= since) {
      roots.push({
        thread: `teams:${tenant}:${groupId}:${channelId}:${m.id}`,
        read: async () => {
          const all = [alone(m), ...replies];
          let next = m['replies@odata.nextLink'] || null;
          for (let page = 0; next && page < MAX_REPLY_PAGES; page += 1) {
            // eslint-disable-next-line no-await-in-loop
            const more = await graph(next);
            if (!more.ok) {
              throw new Error(`graph ${more.status} replies`);
            }
            // eslint-disable-next-line no-await-in-loop
            const list = await more.json();
            all.push(...(list.value || []));
            next = list['@odata.nextLink'] || null;
          }
          return all;
        },
        objects: (messages) => messages.map((message) => ({
          key: messageKey(tenant, { teamId: groupId, channelId, messageId: message.id }, message),
          source: 'teams',
          body: JSON.stringify(message),
        })),
      });
    }
  }
  return { next: over ? null : data['@odata.nextLink'] || null, roots };
}

/** The threads among `keys` the inbox has heard of other than by the import. */
async function liveThreads(env, keys) {
  if (!keys.length) {
    return new Set();
  }
  const { results } = await env.DB.prepare(`SELECT thread FROM threads
    WHERE thread IN (SELECT value FROM json_each(?)) AND imported = 0`)
    .bind(JSON.stringify(keys)).all();
  return new Set((results || []).map((r) => r.thread));
}

/** Writes the objects to pile 1, then hands their keys to the normalizer, a hundred at a time. */
async function store(env, objects) {
  for (const o of objects) {
    // eslint-disable-next-line no-await-in-loop
    await writeRaw(env, o.key, o.body, { source: o.source, via: IMPORT_VIA });
  }
  for (let i = 0; i < objects.length; i += 100) {
    // eslint-disable-next-line no-await-in-loop
    await env.NORMALIZE.sendBatch(objects.slice(i, i + 100).map((o) => ({ body: { key: o.key } })));
  }
}

const where = 'WHERE source = ? AND tenant = ? AND channel_id = ? AND run = ?';
const keyOf = (job) => [job.source, job.tenant, job.channelId, job.run];

/** Ends the import of a channel, with why when it is not done. */
async function end(env, job, now, error = null) {
  await env.DB.prepare(`UPDATE history_imports SET done_at = ?, updated_at = ?, error = ? ${where}`)
    .bind(now.toISOString(), now.toISOString(), error, ...keyOf(job)).run();
  return { result: error ? 'import-ended' : 'imported', error };
}

/**
 * The channel's first page: its row (a newer import replaces an older one), and whether its
 * channel is one to import. Alert channels only with `alerts`.
 */
async function begin(env, job, now) {
  await env.DB.prepare(`INSERT INTO history_imports
      (source, tenant, channel_id, since, run, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, tenant, channel_id) DO UPDATE SET since = excluded.since,
      run = excluded.run, cursor = NULL, skip = 0, pages = 0, threads = 0, messages = 0,
      updated_at = excluded.updated_at, done_at = NULL, error = NULL
    WHERE excluded.run > history_imports.run`)
    .bind(job.source, job.tenant, job.channelId, job.since, job.run, now.toISOString()).run();
  const row = await env.DB.prepare('SELECT * FROM channels WHERE source = ? AND tenant = ? AND channel_id = ?')
    .bind(job.source, job.tenant, job.channelId).first();
  if (!row) {
    return 'unknown channel';
  }
  const { kind } = classify(await loadRules(env), toChannel(row, job.source, job.channelId));
  if (kind === 'ignore') {
    return 'ignored channel';
  }
  return kind === 'alert' && !job.alerts ? 'alert channel' : null;
}

const PAGES = { slack: slackPage, teams: teamsPage };

/**
 * One page of a channel's import, from the queue:
 * `{ source, tenant, channelId, groupId?, since, run, cursor?, skip?, alerts? }`. Stores the
 * threads the inbox does not have, moves the row on (only from where this job started, so a
 * page delivered twice moves it once) and sends the next page.
 */
export async function runImport(env, job, { graph: injected, now = new Date() } = {}) {
  const first = !job.cursor && !job.skip;
  if (!PAGES[job.source]) {
    return { result: 'skip', reason: `no import for ${job.source}` };
  }
  if (first) {
    const skipped = await begin(env, job, now);
    if (skipped) {
      await end(env, job, now, skipped);
      return { result: 'skip', reason: skipped };
    }
  }
  const row = await env.DB.prepare(`SELECT cursor, skip, done_at FROM history_imports ${where}`)
    .bind(...keyOf(job)).first();
  // A newer import of the channel, or this page went through already.
  if (!row || row.done_at || (row.cursor || null) !== (job.cursor || null)
    || Number(row.skip) !== Number(job.skip || 0)) {
    return { result: 'skip', reason: row ? 'moved on' : 'superseded' };
  }
  let page;
  let stored = [];
  let threads = 0;
  let i = Number(job.skip || 0);
  try {
    const graph = job.source === 'teams' ? injected || await cachedGraph(env) : null;
    page = await PAGES[job.source](env, job, graph);
    const live = await liveThreads(env, page.roots.map((r) => r.thread));
    for (; i < page.roots.length && stored.length < BUDGET; i += 1) {
      const root = page.roots[i];
      if (!live.has(root.thread)) {
        let messages = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          messages = await root.read();
        } catch (e) {
          // A thread gone since it was listed (deleted, or out of reach) is left out.
          if (!FINAL.test(e.message)) {
            throw e;
          }
        }
        if (messages && messages.length) {
          stored = stored.concat(root.objects(messages));
          threads += 1;
        }
      }
    }
    await store(env, stored);
  } catch (e) {
    if (FINAL.test(e.message)) {
      return end(env, job, now, e.message);
    }
    await env.DB.prepare(`UPDATE history_imports SET error = ?, updated_at = ? ${where}`)
      .bind(e.message, now.toISOString(), ...keyOf(job)).run();
    throw e;
  }
  const through = i >= page.roots.length;
  const next = through ? { cursor: page.next, skip: 0 } : { cursor: job.cursor || null, skip: i };
  const done = through && !page.next;
  const moved = await env.DB.prepare(`UPDATE history_imports SET cursor = ?, skip = ?,
      pages = pages + ?, threads = threads + ?, messages = messages + ?, updated_at = ?,
      done_at = ?, error = NULL
    ${where} AND cursor IS ? AND skip = ? AND done_at IS NULL`)
    .bind(
      done ? null : next.cursor,
      done ? 0 : next.skip,
      through ? 1 : 0,
      threads,
      stored.length,
      now.toISOString(),
      done ? now.toISOString() : null,
      ...keyOf(job),
      job.cursor || null,
      Number(job.skip || 0),
    ).run();
  if (!done && moved.meta && moved.meta.changes) {
    await env.NORMALIZE.send({ import: { ...job, ...next } }, {
      delaySeconds: PAGE_DELAY_SECONDS + Math.floor(Math.random() * PAGE_DELAY_SECONDS),
    });
  }
  return {
    result: 'imported', threads, messages: stored.length, done,
  };
}
