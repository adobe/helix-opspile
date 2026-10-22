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
    .map((l) => l.replace(/^[#>\-*\s]+/, '').replace(/[*~`]/g, '')
      // `_` only as emphasis at word edges, so `:rotating_light:` keeps its name.
      .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
      .trim())
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
    (source, tenant, channel_id, id, thread, at, author, person, staff, counted, deleted, title,
     permalink, author_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, tenant, channel_id, id) DO UPDATE SET thread = excluded.thread,
      at = excluded.at, author = excluded.author, person = excluded.person,
      staff = excluded.staff, counted = excluded.counted,
      deleted = MAX(messages.deleted, excluded.deleted),
      title = COALESCE(excluded.title, messages.title),
      permalink = COALESCE(excluded.permalink, messages.permalink),
      author_key = COALESCE(excluded.author_key, messages.author_key)`)
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
      m.permalink || null,
      m.authorKey || null,
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
      org = excluded.org, team = excluded.team, kind = excluded.kind, path = excluded.path,
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

/** Attention levels, most pressing first. */
export const ATTENTION = ['adobe', 'mentioned-me', 'mentioned-team', 'team', 'me'];

/**
 * Who a thread waits on: `us`, `customer`, `vendor` or `nobody`. Clef's `next_actor` (on
 * `label`) answers it, but a label can be stale or wrong: when Adobe posted last, the thread
 * does not wait on us, whatever the label says. Without a label, a thread waits on us when
 * someone outside Adobe posted last. Alerts and threads nobody posted in wait on nobody.
 *
 * @param {object} t a thread with `kind`, `last_staff` (1, 0, or null) and `label`
 */
export function waitingOn(t) {
  if (t.kind === 'alert' || t.last_staff == null) {
    return 'nobody';
  }
  const ours = Boolean(Number(t.last_staff));
  const actor = t.label && t.label.next_actor;
  if (!actor || actor === 'us') {
    return ours ? 'nobody' : 'us';
  }
  return actor === 'customer' || actor === 'vendor' ? actor : 'nobody';
}

function group(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.thread)) {
      by.set(r.thread, []);
    }
    by.get(r.thread).push(r);
  }
  return by;
}

/**
 * Read state and attention for a set of threads, as seen by one member of a team.
 *
 * @param {object[]} threads rows of `threads`
 * @param {object[]} marks watermarks for those threads: `{ person, thread, read_at, staff,
 *   in_team }` for every staff member (any team) and every member of the viewer's team
 * @param {object[]} mentions `{ thread, person, at }` for those threads (team members only)
 * @param {number} me the viewer's person id
 * @returns each thread with
 *   - `readers`: team members who have read up to the last message
 *   - `unread`: I have not seen the last message
 *   - `seenByOthers`: a teammate has, I have not
 *   - `unseen`: nobody on the team has
 *   - `unseenByAdobe`: no staff member at all has (posting, reacting or opening counts)
 *   - `mentionedMe` / `mentionedTeam`: I / these teammates were mentioned after they
 *     last read the thread
 *   - `attention`: the most pressing of ATTENTION that applies, or null
 */
export function readState(threads, marks, mentions, me) {
  const marksBy = group(marks);
  const mentionsBy = group(mentions);
  return threads.map((t) => {
    const alert = t.kind === 'alert';
    const last = alert ? t.any_at : t.last_at;
    const ws = marksBy.get(t.thread) || [];
    const readAt = new Map(ws.map((w) => [w.person, w.read_at]));
    const caughtUp = (w) => Boolean(last) && w.read_at >= last;
    const readers = ws.filter((w) => w.in_team && caughtUp(w)).map((w) => w.person);
    const mine = readers.includes(me);
    const fresh = (m) => !readAt.has(m.person) || m.at > readAt.get(m.person);
    const ms = (mentionsBy.get(t.thread) || []).filter(fresh);
    const mentionedMe = ms.some((m) => m.person === me);
    const mentionedTeam = [...new Set(ms.filter((m) => m.person !== me).map((m) => m.person))];
    const state = {
      readers,
      unread: Boolean(last) && !mine,
      seenByOthers: !mine && readers.some((p) => p !== me),
      unseen: Boolean(last) && readers.length === 0,
      // Alert threads are bot posts: nobody outside is waiting for Adobe to look.
      unseenByAdobe: !alert && Boolean(last) && !ws.some((w) => w.staff && caughtUp(w)),
      mentionedMe,
      mentionedTeam,
    };
    const applies = {
      adobe: state.unseenByAdobe,
      'mentioned-me': mentionedMe,
      'mentioned-team': mentionedTeam.length > 0,
      team: state.unseen,
      me: state.unread,
    };
    return { ...t, ...state, attention: ATTENTION.find((a) => applies[a]) || null };
  });
}

/** Records who a message mentions, replacing what was recorded for it before. */
export async function recordMentions(db, { thread, message, at }, mentioned) {
  await db.prepare('DELETE FROM mentions WHERE thread = ? AND message = ?').bind(thread, message).run();
  for (const { person, via } of mentioned) {
    // eslint-disable-next-line no-await-in-loop
    await db.prepare(`INSERT OR IGNORE INTO mentions (thread, message, person, at, via)
      VALUES (?, ?, ?, ?, ?)`).bind(thread, message, person, at, via).run();
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * People whose full name appears in the text ("Ada Lovelace", or "Lovelace, Ada" as
 * Teams writes it), as whole words. First names alone are too ambiguous to count.
 */
export function mentionedByName(text, people) {
  const body = String(text || '');
  return people.filter((p) => {
    const parts = String(p.name || '').trim().split(/\s+/);
    if (parts.length < 2) {
      return false;
    }
    const first = parts[0];
    const lastName = parts[parts.length - 1];
    const forms = [parts.join(' '), `${lastName}, ${first}`].map(escapeRe);
    return new RegExp(`(^|[^\\p{L}])(${forms.join('|')})(?![\\p{L}])`, 'iu').test(body);
  });
}

/** Replaces the reactions recorded for a message with a snapshot (backfill, Teams). */
export async function replaceReactions(db, { thread, message }, reactions) {
  await db.prepare('DELETE FROM reactions WHERE message = ?').bind(message).run();
  for (const r of reactions) {
    // eslint-disable-next-line no-await-in-loop
    await db.prepare(`INSERT OR IGNORE INTO reactions (message, thread, emoji, user_key, at)
      VALUES (?, ?, ?, ?, ?)`).bind(message, thread, r.emoji, r.userKey, r.at || null).run();
  }
}

/** Adds or removes one reaction (Slack reaction events). */
export async function applyReaction(db, {
  thread, message, emoji, userKey, at, removed,
}) {
  if (removed) {
    await db.prepare('DELETE FROM reactions WHERE message = ? AND emoji = ? AND user_key = ?')
      .bind(message, emoji, userKey).run();
    return;
  }
  await db.prepare(`INSERT OR IGNORE INTO reactions (message, thread, emoji, user_key, at)
    VALUES (?, ?, ?, ?, ?)`).bind(message, thread, emoji, userKey, at || null).run();
}
