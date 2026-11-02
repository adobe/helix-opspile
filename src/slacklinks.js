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
 * Slack message permalinks a thread's text names, resolved to messages the viewer may see.
 * The inbox embeds those as cards and offers to open their thread here. A message the
 * viewer cannot see is left out, preview and all.
 */

import { isAdmin } from './review.js';
import { mayWork, teamsOf } from './shares.js';
import { slackMessageRefs } from './slackurl.js';

export { slackMessageKey, slackMessageRef, slackMessageRefs } from './slackurl.js';

/**
 * Messages the texts link to, that `me` may open: `[{ channel, id, thread, at, author,
 * authorKey, preview }]`. `preview` is the message's plain preview (it may be empty).
 * `thread` is the message's thread key, the root when the link points at a reply.
 *
 * @param {object} env bindings
 * @param {object} me the viewer
 * @param {string[]} texts the messages' markdown
 */
export async function slackMessageLinks(env, me, texts) {
  const refs = slackMessageRefs(texts);
  if (!env.DB || !me || !refs.length) {
    return [];
  }
  const wanted = new Set(refs.map((r) => `${r.channel}:${r.id}`));
  const channels = [...new Set(refs.map((r) => r.channel))];
  const ids = [...new Set(refs.map((r) => r.id))];
  const { results } = await env.DB.prepare(`SELECT m.channel_id, m.id, m.thread, m.at, m.author,
      m.author_key, m.preview, t.team
    FROM messages m JOIN threads t ON t.thread = m.thread
    WHERE m.source = 'slack' AND m.deleted = 0
      AND m.channel_id IN (SELECT value FROM json_each(?1))
      AND m.id IN (SELECT value FROM json_each(?2))`)
    .bind(JSON.stringify(channels), JSON.stringify(ids)).all();
  const rows = (results || []).filter((r) => wanted.has(`${r.channel_id}:${r.id}`));
  const threads = [...new Set(rows.map((r) => r.thread))];
  const allowed = new Map(await Promise.all(threads.map(async (thread) => {
    const row = rows.find((r) => r.thread === thread);
    const place = { source: 'slack', channel_id: row.channel_id, team: row.team };
    const yes = isAdmin(me) || await mayWork(env, me)(await teamsOf(env, place), place);
    return [thread, yes];
  })));
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.channel_id}:${row.id}`;
    if (!byKey.has(key) && allowed.get(row.thread)) {
      byKey.set(key, {
        channel: String(row.channel_id),
        id: String(row.id),
        thread: row.thread,
        at: row.at,
        author: row.author || null,
        authorKey: row.author_key || null,
        preview: row.preview || '',
      });
    }
  }
  return refs.map((r) => byKey.get(`${r.channel}:${r.id}`)).filter(Boolean);
}
