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
 * What waits for you, for the header of every page (ui/header.js): the threads with messages
 * for you that you have not read (the red badge's, src/threads.js unreadInYours), wherever
 * they are, and the questions thread agents asked you (src/questions.js). `GET /api/waiting`,
 * and `waiting` in `/api/me`. The admin team's requests are counted apart, for its members only
 * (GET /api/admin/requests?count=1).
 *
 * A thread is yours here as in the red badge: you posted in it or were mentioned in it, it is
 * of the last WAITING_DAYS, nobody imported it, and it is not of a customer you muted. Only those
 * with something after your last read are counted, at most WAITING_MAX of them, latest first.
 */

import { openQuestions } from './questions.js';
import { mutedOrgs } from './standing.js';
import { unreadInYours } from './threads.js';

export const WAITING_DAYS = 30;
export const WAITING_MAX = 300;

/**
 * The threads of person `me` (`{ id, email }`) with messages for them they have not read:
 * `[{ thread, entry, team, org, n }]`, latest first (`entry`: the inbox entry it is of, a
 * re-threaded group's first thread).
 */
export async function waitingThreads(db, me, now = new Date()) {
  const since = new Date(now.getTime() - WAITING_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { results } = await db.prepare(`WITH mine AS (
      SELECT thread FROM messages WHERE person = ?1 AND deleted = 0 AND at > ?2
      UNION SELECT thread FROM mentions WHERE person = ?1 AND at > ?2),
    groups AS (SELECT COALESCE(t.logical_thread, t.thread) AS g FROM threads t
      WHERE t.thread IN (SELECT thread FROM mine))
    SELECT t.thread, t.team, t.org, COALESCE(t.logical_thread, t.thread) AS entry,
      (t.logical_thread IS NOT NULL
        OR EXISTS (SELECT 1 FROM threads c WHERE c.logical_thread = t.thread)) AS grouped
      FROM threads t
      LEFT JOIN watermarks w ON w.thread = t.thread AND w.person = ?1
    WHERE (t.thread IN (SELECT thread FROM mine)
        OR COALESCE(t.logical_thread, t.thread) IN (SELECT g FROM groups))
      AND t.imported = 0 AND t.kind NOT IN ('alert', 'ignore') AND t.any_at > ?2
      AND (w.read_at IS NULL OR w.read_at < t.any_at)
      AND COALESCE(t.org, '') NOT IN (${mutedOrgs('?1')})
    ORDER BY t.any_at DESC LIMIT ?3`).bind(me.id, since, WAITING_MAX).all();
  const rows = results || [];
  // A re-threaded group is one thread to unreadInYours: you are in it from the first time you
  // were in any member, a read one too. The read members are asked along for that, and counted
  // for nothing (they have nothing after your read). A row is of a group when it points at its
  // root or is the root others point at (the root's own logical_thread is NULL, src/rethread.js).
  const multi = [...new Set(rows.filter((r) => r.grouped).map((r) => r.entry))];
  const { results: members } = multi.length
    ? await db.prepare(`SELECT thread FROM threads
      WHERE logical_thread IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(multi)).all()
    : { results: [] };
  const counts = await unreadInYours(db, [...new Set([...rows.map((r) => r.thread), ...multi,
    ...(members || []).map((r) => r.thread)])], me.id);
  return rows.filter((r) => counts.get(r.thread))
    .map((r) => ({
      thread: r.thread,
      entry: r.entry,
      team: r.team || null,
      org: r.org || null,
      n: counts.get(r.thread),
    }));
}

/** What waits for `me`: `{ threads, questions }` (see waitingThreads, openQuestions). */
export async function waitingFor(env, me, now = new Date()) {
  if (!me || me.readonly) {
    return { threads: [], questions: { open: 0, team: null } };
  }
  const [threads, questions] = await Promise.all([
    waitingThreads(env.DB, me, now),
    openQuestions(env, me.email, now),
  ]);
  return { threads, questions };
}
