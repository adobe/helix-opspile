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

import { sha256 } from './raw.js';

/**
 * Full-text search over what was said (SEARCH, an AI Search instance with built-in storage):
 * one item per message of a channel thread, its markdown body as it is in pile 2, so that the
 * words of a message are found, an error string or a hostname as much as a sentence. The
 * CONTENT vectors (src/vectors.js) find what a thread is about; these find what it says.
 *
 * Each item carries the metadata search filters and answers with (the instance's schema,
 * created by hand; see README): `team`, `channel` (a hash of the channel key: filters read only
 * the first 64 bytes of a value, and a Teams channel key is longer), `message` (`<thread>|<id>`,
 * as the inbox names a message) and `at` (when it was posted, for boosting the recent).
 *
 * A thread's items are brought up to date with its vectors (the same queue job and sweep):
 * each message keeps a hash of what its item was uploaded with (`messages.indexed`), so only
 * new and edited messages, and those of a re-filed thread (the team is in the hash), are
 * uploaded again; a deleted one loses its item (`messages.search_item`). A failure throws and
 * leaves the row as it was, so that the next run (the sweep's) tries again: above all, an item
 * that could not be deleted keeps its id until it is. Search never shows a deleted message's
 * item meanwhile (src/search.js asks D1).
 */

/** Uploads per job: a long thread is finished by the next jobs, the cron sees to it. */
export const MAX_UPLOADS = 100;

const hashOf = async (text) => (await sha256(text)).slice(0, 32);

/** Whether `e` says the item is not there (any more): what deleting it was for. */
export const notFound = (e) => Boolean(e) && (e.name === 'AiSearchNotFoundError'
  || e.status === 404 || /not.?found/i.test(String(e.message)));

/** The `channel` an item carries for channel key `channel` (`<source>:<tenant>:<id>`). */
export const channelTag = async (channel) => (await sha256(`channel:${channel}`)).slice(0, 32);

/** The item of message `key` (`<channel>:<id>`): a name of its own, short enough (128). */
export const itemName = async (key) => `${(await sha256(`item:${key}`)).slice(0, 48)}.md`;

/** The text a message's item is made of: its body, unless it is deleted or a system notice. */
export function itemText(file) {
  if (!file || file.deletedAt || (file.author && file.author.kind === 'system')) {
    return '';
  }
  return String(file.body || '').trim();
}

/**
 * Brings the items of channel thread `thread` (its D1 row) up to date, from its message files
 * (`Map<id, file>`, already read from pile 2; an empty map takes all of its items away, for a
 * thread that is no longer a channel thread). Returns `{ uploaded, removed, complete }`;
 * `complete` is false when MAX_UPLOADS was reached and more are left.
 */
export async function indexThread(env, thread, files) {
  const channel = `${thread.source}:${thread.tenant}:${thread.channel_id}`;
  const tag = await channelTag(channel);
  const { results } = await env.DB.prepare(`SELECT id, at, deleted, indexed, search_item
    FROM messages WHERE thread = ?`).bind(thread.thread).all();
  let uploaded = 0;
  let removed = 0;
  let complete = true;
  for (const row of results || []) {
    const text = row.deleted ? '' : itemText(files.get(String(row.id)));
    const key = `${channel}:${row.id}`;
    if (text) {
      // eslint-disable-next-line no-await-in-loop
      const hash = await hashOf(`${thread.team}\n${text}`);
      if (hash !== row.indexed) {
        if (uploaded >= MAX_UPLOADS) {
          complete = false;
          // eslint-disable-next-line no-continue
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const item = await env.SEARCH.items.upload(await itemName(key), text, {
          metadata: {
            team: thread.team,
            channel: tag,
            message: `${thread.thread}|${row.id}`,
            at: String(row.at),
          },
        });
        // eslint-disable-next-line no-await-in-loop
        await env.DB.prepare(`UPDATE messages SET indexed = ?, search_item = ?
          WHERE thread = ? AND id = ?`).bind(
          hash,
          (item && item.id) || row.search_item || null,
          thread.thread,
          row.id,
        ).run();
        uploaded += 1;
      }
    } else if (row.indexed || row.search_item) {
      if (row.search_item) {
        // eslint-disable-next-line no-await-in-loop
        await env.SEARCH.items.delete(row.search_item).catch((e) => {
          // Already gone is what was wanted; anything else is tried again.
          if (!notFound(e)) {
            throw e;
          }
        });
      }
      // eslint-disable-next-line no-await-in-loop
      await env.DB.prepare(`UPDATE messages SET indexed = NULL, search_item = NULL
        WHERE thread = ? AND id = ?`).bind(thread.thread, row.id).run();
      removed += 1;
    }
  }
  return { uploaded, removed, complete };
}
