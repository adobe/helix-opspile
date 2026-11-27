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

import { cursorCodec, fail } from './integration-auth.js';
import { theirs, titleOf } from './store.js';

/**
 * Every read of an individual channel (portal migration 0008) is of the member's own threads
 * only: those they are in (`thread_members`), as `theirs` says with the member's `people` (`?3`
 * below: null in a shared channel, so every thread is theirs). Its list, a thread, the badge, the
 * unread counts, the feed and its watermark: a colleague's thread changes none of them, not even
 * a cursor's head.
 */
const scope = (m) => (m.audience === 'individual' ? JSON.stringify(m.people || [m.actor]) : null);

// Capture the list, its badge and its change watermark in one DB.batch snapshot. Head never
// goes backwards when old rows expire. A continuation either uses that snapshot or must relist.
const watermark = (db, m) => db.prepare(`SELECT pruned_seq AS floor, max(pruned_seq, coalesce(
  (SELECT max(seq) FROM integration_changes WHERE channel = ?1 AND (viewer IS NULL OR viewer = ?2)
    AND ${theirs('integration_changes.root', 3)}), 0)) AS head FROM integration_customers WHERE channel = ?1`)
  .bind(m.channel, m.actor, scope(m));

// Messages of others: of none of the accounts that are the member.
const unread = `FROM messages p LEFT JOIN integration_reads r ON r.channel = p.channel
  AND r.root = p.root AND r.actor = ?2 WHERE p.channel = ?1
  AND p.author NOT IN (SELECT value FROM json_each(?5)) AND ${theirs('p.root', 3)}
  AND p.deleted_at IS NULL AND p.position > coalesce(r.position, 0)`;
const people = (m) => JSON.stringify(m.people || [m.actor]);
const badge = (db, m) => db.prepare(`SELECT count(DISTINCT p.root) AS n ${unread}`)
  .bind(m.channel, m.actor, scope(m), null, people(m));
const visible = `SELECT m.id, m.body, m.deleted_at, EXISTS (SELECT 1 FROM reactions x
  JOIN users u ON u.id = x.user WHERE x.message = m.id AND u.kind = 'staff'
  AND x.emoji IN ('✅','✔️')) AS resolved FROM messages m WHERE m.root = m.id AND m.channel = ?1
  AND ${theirs('m.id', 3)}`;

function summary(r) {
  return { id: r.id, title: r.deleted_at ? '(deleted)' : titleOf(r.body), resolved: !!r.resolved };
}

export async function readThreads(db, m, root, params, now) {
  const limit = Number(params.get('limit') ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    fail(400, 'invalid_input');
  }
  const codec = await cursorCodec(m, root || 'threads', now);
  const page = params.has('cursor') ? await codec.open(params.get('cursor')) : null;
  const offset = page?.offset || 0;
  const select = root
    ? db.prepare(`SELECT p.id, p.at, p.rev, p.body, p.deleted_at, u.kind, u.name
      FROM messages p JOIN users u ON u.id = p.author WHERE p.channel = ?1 AND p.root = ?2
        AND ${theirs('?2', 5)} ORDER BY p.position LIMIT ?3 OFFSET ?4`)
      .bind(m.channel, root, limit + 1, offset, scope(m))
    : db.prepare(`SELECT t.*, (SELECT count(*) ${unread} AND p.root = t.id) AS unread,
      (SELECT max(p.at) FROM messages p WHERE p.channel = ?1 AND p.root = t.id
        AND p.deleted_at IS NULL) AS lastActivity FROM (${visible}) t WHERE lastActivity IS NOT NULL
      ORDER BY lastActivity DESC, id DESC LIMIT ?4 OFFSET ?6`)
      .bind(m.channel, m.actor, scope(m), limit + 1, people(m), offset);
  const [stamp, rows, info] = await db.batch([watermark(db, m), select,
    root ? db.prepare(`${visible} AND m.id = ?2`).bind(m.channel, root, scope(m)) : badge(db, m)]);
  const { head } = stamp.results[0];
  if (page && page.head !== head) {
    fail(410, 'cursor_expired');
  }
  const items = rows.results.slice(0, limit);
  const next = rows.results.length > limit ? await codec.seal({ offset: offset + limit, head })
    : null;
  if (root) {
    if (!info.results.length) {
      fail(404, 'not_found');
    }
    return {
      ...summary(info.results[0]),
      messages: items.map((r) => ({
        id: r.id,
        at: r.at,
        rev: r.rev,
        kind: r.kind,
        name: r.kind === 'customer' ? r.name : 'Adobe Support',
        body: r.deleted_at ? '' : r.body,
        deleted: !!r.deleted_at,
      })),
      next,
    };
  }
  const changes = await cursorCodec(m, 'changes', now);
  return {
    items: items.map((r) => ({ ...summary(r), unread: r.unread, lastActivity: r.lastActivity })),
    next,
    unreadThreads: info.results[0].n,
    changeCursor: await changes.seal(head),
    // Who sees the member's threads, for the host to say before they write.
    audience: m.audience === 'individual' ? 'individual' : 'shared',
  };
}

export async function readChanges(db, m, params, now) {
  const codec = await cursorCodec(m, 'changes', now);
  const after = await codec.open(params.get('after'));
  const [stamp, rows, counts] = await db.batch([watermark(db, m), db.prepare(`SELECT seq,
    event_id AS id, root AS threadId, reason FROM integration_changes WHERE channel = ?1
    AND (viewer IS NULL OR viewer = ?2) AND ${theirs('integration_changes.root', 3)} AND seq > ?4 ORDER BY seq
    LIMIT 101`).bind(m.channel, m.actor, scope(m), after), badge(db, m)]);
  const { floor, head } = stamp.results[0];
  if (after < floor) {
    fail(410, 'cursor_expired');
  }
  const hasMore = rows.results.length > 100;
  return {
    events: rows.results.slice(0, 100).map(({ id, threadId, reason }) => ({
      id, threadId, reason, type: 'thread.updated',
    })),
    next: await codec.seal(hasMore ? rows.results[99].seq : head),
    hasMore,
    unreadThreads: counts.results[0].n,
  };
}

export async function markRead(db, m, root, through) {
  const match = `FROM messages WHERE channel = ?1 AND root = ?3 AND id = ?4 AND ${theirs('?3', 5)}`;
  const args = [m.channel, m.actor, root, through, scope(m)];
  const [found, , counts] = await db.batch([
    db.prepare(`SELECT 1 ${match}`).bind(...args),
    db.prepare(`INSERT INTO integration_reads(channel, actor, root, position)
      SELECT channel, ?2, root, position ${match} ON CONFLICT (channel, actor, root)
      DO UPDATE SET position = excluded.position WHERE excluded.position > integration_reads.position`)
      .bind(...args),
    badge(db, m),
  ]);
  if (!found.results.length) {
    fail(404, 'not_found');
  }
  return { unreadThreads: counts.results[0].n };
}
