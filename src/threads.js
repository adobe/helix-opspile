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
 * Pile 4: the thread index and read state in D1 (migrations/0002_threads.sql).
 *
 * Every write here is idempotent and order-independent: a message row is upserted, the
 * thread row is recomputed from all of its messages, and a watermark only moves forward.
 */

export const TITLE_MAX = 140;

/** First meaningful line of a markdown body, for the thread title. */
export function titleOf(subject, body) {
  const line = String(subject || body || '')
    .split('\n')
    .map((l) => l.replace(/^[#>\-*\s]+/, '').replace(/[*_~`]/g, '').trim())
    .find(Boolean) || '';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/**
 * Moves a watermark forward (never back). `via` is post, react or open.
 */
export async function advanceWatermark(db, person, thread, at, via, now = new Date()) {
  if (!person || !thread || !at) {
    return;
  }
  await db.prepare(`INSERT INTO watermarks (person, thread, read_at, via, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (person, thread) DO UPDATE SET
      read_at = excluded.read_at, via = excluded.via, updated_at = excluded.updated_at
    WHERE excluded.read_at > watermarks.read_at`)
    .bind(person, thread, at, via, now.toISOString())
    .run();
}

/**
 * Records one pile-2 message and recomputes its thread.
 *
 * @param {object} db D1
 * @param {object} m `{ source, tenant, channelId, rootId, id, thread, at, author, person,
 *   staff, counted, deleted, title, org, team, kind, channelName, path }`
 */
export async function indexMessage(db, m, now = new Date()) {
  await db.prepare(`INSERT INTO messages
    (source, tenant, channel_id, id, thread, at, author, person, staff, counted, deleted, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, tenant, channel_id, id) DO UPDATE SET thread = excluded.thread,
      at = excluded.at, author = excluded.author, person = excluded.person,
      staff = excluded.staff, counted = excluded.counted,
      deleted = MAX(messages.deleted, excluded.deleted),
      title = COALESCE(excluded.title, messages.title)`)
    .bind(
      m.source,
      m.tenant,
      m.channelId,
      m.id,
      m.thread,
      m.at,
      m.author || null,
      m.person || null,
      m.staff ? 1 : 0,
      m.counted ? 1 : 0,
      m.deleted ? 1 : 0,
      m.title || null,
    )
    .run();

  const isRoot = m.id === m.rootId;
  // The thread row is derived from its messages, so it is the same in any order.
  await db.prepare(`INSERT INTO threads
    (thread, source, tenant, channel_id, root_id, org, team, kind, channel_name, title, path,
     root_at, last_at, last_id, last_author, last_staff, any_at, messages, updated_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
      COALESCE(
        (SELECT title FROM messages WHERE thread = ?1 AND id = ?5 AND deleted = 0 AND title != ''),
        (SELECT title FROM messages WHERE thread = ?1 AND deleted = 0 AND title != ''
          ORDER BY at LIMIT 1)),
      ?11, ?12,
      l.at, l.id, l.author, l.staff,
      (SELECT MAX(at) FROM messages WHERE thread = ?1 AND deleted = 0),
      (SELECT COUNT(*) FROM messages WHERE thread = ?1 AND deleted = 0),
      ?13
    FROM (SELECT NULL) LEFT JOIN (
      SELECT at, id, author, staff FROM messages
      WHERE thread = ?1 AND counted = 1 AND deleted = 0 ORDER BY at DESC LIMIT 1
    ) l ON 1
    ON CONFLICT (thread) DO UPDATE SET
      org = excluded.org, team = excluded.team, kind = excluded.kind,
      channel_name = COALESCE(excluded.channel_name, threads.channel_name),
      title = excluded.title,
      root_at = CASE WHEN ?14 THEN excluded.root_at ELSE COALESCE(threads.root_at, excluded.root_at) END,
      last_at = excluded.last_at, last_id = excluded.last_id,
      last_author = excluded.last_author, last_staff = excluded.last_staff,
      any_at = excluded.any_at, messages = excluded.messages, updated_at = excluded.updated_at`)
    .bind(
      m.thread,
      m.source,
      m.tenant,
      m.channelId,
      m.rootId,
      m.org,
      m.team,
      m.kind || 'channel',
      m.channelName || null,
      null, // ?10 is unused: the title is derived from the messages above
      m.path,
      isRoot ? m.at : null,
      now.toISOString(),
      isRoot ? 1 : 0,
    )
    .run();

  // Posting in a thread means having read it up to there.
  if (m.person && !m.deleted) {
    await advanceWatermark(db, m.person, m.thread, m.at, 'post', now);
  }
}

/** The thread and time of a message, for reactions. */
export async function findMessage(db, {
  source, tenant, channelId, id,
}) {
  return db.prepare(`SELECT thread, at FROM messages
    WHERE source = ? AND tenant = ? AND channel_id = ? AND id = ?`)
    .bind(source, tenant, channelId, id).first();
}

/**
 * Read state for a set of threads and a team.
 *
 * @param {object[]} threads rows of `threads`
 * @param {object[]} marks rows of `watermarks` for those threads and the team's members
 * @param {number} me the viewer's person id
 * @returns per thread: `unread` (for me), `seenByOthers` (others read it, I did not),
 *   `unseen` (nobody on the team read it), `readers` (person ids at or past the end)
 */
export function readState(threads, marks, me) {
  const byThread = new Map();
  for (const w of marks) {
    if (!byThread.has(w.thread)) {
      byThread.set(w.thread, []);
    }
    byThread.get(w.thread).push(w);
  }
  return threads.map((t) => {
    const last = t.kind === 'alert' ? t.any_at : t.last_at;
    const ws = byThread.get(t.thread) || [];
    const readers = last ? ws.filter((w) => w.read_at >= last).map((w) => w.person) : [];
    const mine = readers.includes(me);
    return {
      ...t,
      unread: Boolean(last) && !mine,
      seenByOthers: !mine && readers.some((p) => p !== me),
      unseen: Boolean(last) && readers.length === 0,
      readers,
    };
  });
}
