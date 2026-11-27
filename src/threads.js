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

import { QUOTE_HEAD, quotesAsText } from './markdown.js';

export const TITLE_MAX = 140;

/** Markdown and Slack links as their text, and images dropped, for a title or a preview. */
const unlink = (s) => s
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
  .replace(/<(https?:\/\/[^>\s]+)>/g, '$1');

/** First meaningful line of a markdown body, for the thread title; not a quote's author line. */
export function titleOf(subject, body) {
  const line = String(subject || body || '')
    .split('\n')
    .filter((l) => !QUOTE_HEAD.test(l))
    .map((l) => unlink(l).replace(/^[#>\-*\s]+/, '').replace(/[*~`]/g, '')
      // `_` only as emphasis at word edges, so `:rotating_light:` keeps its name.
      .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
      .trim())
    .find(Boolean) || '';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** How much of a message the inbox's rows show of it (they cut it off sooner, with `…`). */
export const PREVIEW_MAX = 200;

/**
 * A message's markdown body as one line of plain text, for the inbox's rows: code blocks and
 * images as `[code]` and `[image]`, links as their text, no list, quote or heading marks and no
 * emphasis. Emoji shortcodes (`:rotating_light:`) are kept: the inbox shows them as emoji.
 */
export function previewOf(body) {
  const text = quotesAsText(body)
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/^\s*(?:[-*+]|\d+\.|>|#+|\|)\s*/gm, '')
    .replace(/[*~`|]/g, '')
    // `_` only as emphasis at word edges, so `:rotating_light:` keeps its name.
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
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
 *   staff, counted, deleted, title, preview, org, team, kind, channelName, path }`
 */
export async function indexMessage(db, m, now = new Date()) {
  await db.prepare(`INSERT INTO messages
    (source, tenant, channel_id, id, thread, at, author, person, staff, counted, deleted, title,
     permalink, author_key, preview, author_kind, edited, attachments, imported)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, tenant, channel_id, id) DO UPDATE SET thread = excluded.thread,
      at = excluded.at, author = excluded.author, person = excluded.person,
      staff = excluded.staff, counted = excluded.counted,
      deleted = MAX(messages.deleted, excluded.deleted),
      title = COALESCE(excluded.title, messages.title),
      permalink = COALESCE(excluded.permalink, messages.permalink),
      author_key = COALESCE(excluded.author_key, messages.author_key),
      preview = COALESCE(excluded.preview, messages.preview),
      author_kind = COALESCE(excluded.author_kind, messages.author_kind),
      edited = COALESCE(excluded.edited, messages.edited),
      attachments = COALESCE(excluded.attachments, messages.attachments),
      -- Heard of any other way than the history import once, and it was never only imported.
      imported = MIN(messages.imported, excluded.imported)`)
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
      m.preview ?? null,
      m.authorKind || null,
      m.edited == null ? null : Number(Boolean(m.edited)),
      m.attachments ?? null,
      m.imported ? 1 : 0,
    )
    .run();

  const isRoot = m.id === m.rootId;
  // The thread row is derived from its messages, so it is the same in any order.
  await db.prepare(`INSERT INTO threads
    (thread, source, tenant, channel_id, root_id, org, team, kind, channel_name, title, path,
     root_at, last_at, last_id, last_author, last_staff, last_text, any_at, messages, updated_at,
     imported)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
      -- What was said titles a thread; a system notice (a meeting started) only one without.
      COALESCE(
        (SELECT title FROM messages WHERE thread = ?1 AND id = ?5 AND deleted = 0 AND title != ''
          AND COALESCE(author_kind, '') != 'system'),
        (SELECT title FROM messages WHERE thread = ?1 AND deleted = 0 AND title != ''
          AND COALESCE(author_kind, '') != 'system' ORDER BY at LIMIT 1),
        (SELECT title FROM messages WHERE thread = ?1 AND deleted = 0 AND title != ''
          ORDER BY at LIMIT 1)),
      ?11, ?12,
      l.at, l.id, l.author, l.staff, l.preview,
      (SELECT MAX(at) FROM messages WHERE thread = ?1 AND deleted = 0),
      (SELECT COUNT(*) FROM messages WHERE thread = ?1 AND deleted = 0
        AND COALESCE(author_kind, '') != 'system'),
      ?13,
      -- Imported while every message is (src/history.js).
      (SELECT COALESCE(MIN(imported), 0) FROM messages WHERE thread = ?1)
    FROM (SELECT NULL) LEFT JOIN (
      SELECT at, id, author, staff, preview FROM messages
      WHERE thread = ?1 AND counted = 1 AND deleted = 0 ORDER BY at DESC LIMIT 1
    ) l ON 1
    ON CONFLICT (thread) DO UPDATE SET
      org = excluded.org, team = excluded.team, kind = excluded.kind, path = excluded.path,
      channel_name = COALESCE(excluded.channel_name, threads.channel_name),
      title = excluded.title,
      root_at = CASE WHEN ?14 THEN excluded.root_at ELSE COALESCE(threads.root_at, excluded.root_at) END,
      last_at = excluded.last_at, last_id = excluded.last_id,
      last_author = excluded.last_author, last_staff = excluded.last_staff,
      last_text = excluded.last_text,
      any_at = excluded.any_at, messages = excluded.messages, updated_at = excluded.updated_at,
      imported = excluded.imported`)
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
 * The member of a re-threaded group with the latest activity, whose label speaks for the group. A
 * member whose messages are all deleted has no `any_at`: it is the oldest, not the latest (as
 * text, `null` sorts after every date).
 */
export function latestMember(members) {
  return [...members]
    .sort((a, b) => String(b.any_at || '').localeCompare(String(a.any_at || '')))[0];
}

/**
 * Who a thread waits on: `us`, `customer`, `vendor` or `nobody`. Clef's `next_actor` (on
 * `label`) answers it, but a label can be stale or wrong: when Adobe posted last, the thread
 * does not wait on us, whatever the label says. Without a label, a thread waits on us when
 * someone outside Adobe posted last. Alerts, threads nobody posted in and imported threads (the
 * history import's, src/history.js: over before the inbox began) wait on nobody. In a vendor's
 * thread (`org_type` 'vendor') the other side is the vendor: a thread that waits on someone
 * outside Adobe waits on the vendor, whatever the label calls them (labels from before Clef was
 * asked of vendors the other way round, src/label.js VENDOR_QUESTIONS, say `customer`).
 *
 * @param {object} t a thread with `kind`, `last_staff` (1, 0, or null), `label`, `imported`
 *   and `org_type`
 */
export function waitingOn(t) {
  if (t.kind === 'alert' || t.last_staff == null || Number(t.imported)) {
    return 'nobody';
  }
  // 🙏 after the last message: thanks, nothing is pending.
  const last = t.last_at || t.any_at;
  if ((t.signals || []).some((x) => x.signal === 'thanks' && x.at && last && x.at >= last)) {
    return 'nobody';
  }
  const ours = Boolean(Number(t.last_staff));
  const actor = t.label && t.label.next_actor;
  if (!actor || actor === 'us') {
    return ours ? 'nobody' : 'us';
  }
  if (actor !== 'customer' && actor !== 'vendor') {
    return 'nobody';
  }
  return t.org_type === 'vendor' ? 'vendor' : actor;
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
 * `marks` (one thread's watermarks) with mine at `own` at least, the time I last posted in the
 * thread's entry (`{ at, staff }`, ownPosts): posting is having read up to there, in every
 * thread of the entry, as myself or as the opspile app.
 */
function withOwnPost(marks, thread, me, own) {
  if (!own || !own.at) {
    return marks;
  }
  const mine = marks.find((w) => w.person === me);
  if (mine && mine.read_at >= own.at) {
    return marks;
  }
  return [
    ...marks.filter((w) => w !== mine),
    mine ? { ...mine, read_at: own.at } : {
      person: me, thread, read_at: own.at, staff: own.staff ? 1 : 0, in_team: 1,
    },
  ];
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
 *   - `unreadMentions`: how many messages mention me after I last read the thread
 *   - `unreadForYou`: what the red badge counts, as Slack's: the messages I have not read that
 *     mention me or are in a thread of mine (`yours`, see unreadInYours), at least the mentions
 *   - `attention`: the most pressing of ATTENTION that applies, or null
 *
 * `own` is when I last posted in each thread's entry (ownPosts): what came before it is read by
 * me, whatever my watermark says, as it is for the red badge (unreadInYours).
 *
 * An imported thread (src/history.js) is read by everyone: it was over before the inbox began.
 */
export function readState(threads, marks, mentions, me, yours = new Map(), own = new Map()) {
  const marksBy = group(marks);
  const mentionsBy = group(mentions);
  return threads.map((t) => {
    const alert = t.kind === 'alert';
    const imported = Boolean(Number(t.imported));
    const last = alert ? t.any_at : t.last_at;
    const ws = withOwnPost(marksBy.get(t.thread) || [], t.thread, me, own.get(t.thread));
    const readAt = new Map(ws.map((w) => [w.person, w.read_at]));
    const caughtUp = (w) => imported || (Boolean(last) && w.read_at >= last);
    const readers = ws.filter((w) => w.in_team && caughtUp(w)).map((w) => w.person);
    const mine = imported || readers.includes(me);
    const fresh = (m) => !imported && (!readAt.has(m.person) || m.at > readAt.get(m.person));
    const ms = (mentionsBy.get(t.thread) || []).filter(fresh);
    const unreadMentions = ms.filter((m) => m.person === me).length;
    const mentionedMe = unreadMentions > 0;
    const mentionedTeam = [...new Set(ms.filter((m) => m.person !== me).map((m) => m.person))];
    const state = {
      readers,
      unread: Boolean(last) && !mine,
      seenByOthers: !mine && readers.some((p) => p !== me),
      unseen: !imported && Boolean(last) && readers.length === 0,
      // Alert threads are bot posts: nobody outside is waiting for Adobe to look.
      unseenByAdobe: !alert && !imported && Boolean(last)
        && !ws.some((w) => w.staff && caughtUp(w)),
      mentionedMe,
      unreadMentions,
      unreadForYou: Math.max(unreadMentions, imported ? 0 : yours.get(t.thread) || 0),
      mentionedTeam,
    };
    // A bot's reply for me (an agent's post_message in a thread of mine) moves no `last_at`, which
    // counts people's messages only, but it is mine to read: the thread is unread until I do.
    if (!state.unread && state.unreadForYou > 0) {
      state.unread = true;
    }
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

/**
 * SQL: the time person `?2` last posted in each inbox entry of `g` (`g AS (thread, g)`, `g` the
 * entry's key, `COALESCE(logical_thread, thread)`), in any of its threads, those not asked for
 * too: as themselves, or as the opspile app (`app_posts`, at its message's time once the message
 * is in). `own(g, at)`. Everything of the entry up to then is read by them.
 */
const OWN_POSTS = `entries AS (SELECT DISTINCT g FROM g),
    members AS (SELECT thread, g FROM g
      UNION SELECT t.thread, t.logical_thread FROM threads t
        WHERE t.logical_thread IN (SELECT g FROM entries)
      UNION SELECT e.g, e.g FROM entries e),
    own AS (SELECT g, MAX(at) AS at FROM (
        SELECT p.g, m.at FROM members p JOIN messages m ON m.thread = p.thread
        WHERE m.person = ?2 AND m.deleted = 0
        UNION ALL SELECT p.g, COALESCE(m.at, a.at) FROM members p
          JOIN app_posts a ON a.thread = p.thread AND a.person = ?2
          LEFT JOIN messages m ON m.source = a.source AND m.tenant = a.tenant
            AND m.channel_id = a.channel_id AND m.id = a.id
        WHERE COALESCE(m.deleted, 0) = 0)
      GROUP BY g)`;

/**
 * When person `me` last posted in the inbox entry of each of `threads` (see OWN_POSTS), for
 * readState: `Map<thread, { at, staff }>`, without the threads of entries they never posted in.
 */
export async function ownPosts(db, threads, me) {
  if (!threads.length || !me) {
    return new Map();
  }
  const { results } = await db.prepare(`WITH k AS (SELECT value AS thread FROM json_each(?1)),
    g AS (SELECT t.thread, COALESCE(t.logical_thread, t.thread) AS g FROM threads t
      WHERE t.thread IN (SELECT thread FROM k)),
    ${OWN_POSTS}
    SELECT g.thread, o.at, (SELECT staff FROM people WHERE id = ?2) AS staff
    FROM g JOIN own o ON o.g = g.g`).bind(JSON.stringify(threads), me).all();
  return new Map((results || []).map((r) => [r.thread, { at: r.at, staff: Boolean(r.staff) }]));
}

/**
 * SQL: whether bot message `m` answers person `?2`: the latest message before it in its platform
 * thread that is a person's or theirs as the opspile app is theirs. A bot's answer to someone else
 * (admin-bot's to a customer's `@admin-bot add`, a monitor's notice) is not for everyone who
 * ever posted in the thread, any more than it moves the thread's `last_at`.
 */
const ANSWERS_ME = `COALESCE((SELECT p.person IS ?2 OR EXISTS (SELECT 1 FROM app_posts a
      WHERE a.source = p.source AND a.tenant = p.tenant AND a.channel_id = p.channel_id
        AND a.id = p.id AND a.person = ?2)
    FROM messages p WHERE p.thread = m.thread AND p.deleted = 0 AND p.at < m.at
      AND (p.counted = 1 OR EXISTS (SELECT 1 FROM app_posts a WHERE a.source = p.source
        AND a.tenant = p.tenant AND a.channel_id = p.channel_id AND a.id = p.id
        AND a.person = ?2))
    ORDER BY p.at DESC LIMIT 1), 0)`;

/**
 * What the red badge counts of `threads` for person `me`, as Slack counts its badge: the
 * messages they have not read (after their watermark on the message's thread) that mention them,
 * and in a thread of theirs (one they posted or were mentioned in; a re-threaded group's members
 * among `threads` are one thread) the messages from someone else since they first were in it:
 * people's, and a bot's that answers them (ANSWERS_ME: an agent's `post_message`, admin-bot's
 * answer to their `@admin-bot add`), but not a bot's that answers someone else, nor Teams' system
 * notices, nor what they posted themselves (as themselves, or as the
 * opspile app: `app_posts`). A message counts once. Deleted ones do not.
 *
 * Nothing they have read counts: what came before their watermark on the message's thread, nor
 * what came before their own last post anywhere in the entry (OWN_POSTS). Replying is having
 * read the conversation up to there, wherever it was replied from and in whichever of the
 * entry's threads, and a thread folded into the entry later brings nothing from before it.
 *
 * @returns {Promise<Map<string, number>>} thread to count, without the threads of none
 */
export async function unreadInYours(db, threads, me) {
  if (!threads.length) {
    return new Map();
  }
  const { results } = await db.prepare(`WITH k AS (SELECT value AS thread FROM json_each(?1)),
    -- An imported thread (src/history.js) has nothing unread.
    g AS (SELECT t.thread, COALESCE(t.logical_thread, t.thread) AS g FROM threads t
      WHERE t.thread IN (SELECT thread FROM k) AND t.imported = 0),
    ${OWN_POSTS},
    -- When the viewer was first in each group: posted in it or mentioned ('~' sorts last: never).
    since AS (SELECT g.g, MIN(MIN(
        COALESCE((SELECT MIN(a.at) FROM messages a WHERE a.thread = g.thread AND a.person = ?2
          AND a.deleted = 0), '~'),
        COALESCE((SELECT MIN(b.at) FROM mentions b WHERE b.thread = g.thread
          AND +b.person = ?2), '~'))) AS at
      FROM g GROUP BY g.g HAVING at < '~')
    SELECT m.thread, COUNT(*) AS n
    FROM g JOIN since s ON s.g = g.g
      JOIN messages m ON m.thread = g.thread AND m.at >= s.at
      LEFT JOIN watermarks w ON w.thread = g.thread AND w.person = ?2
      LEFT JOIN own o ON o.g = g.g
    WHERE m.deleted = 0 AND (w.read_at IS NULL OR m.at > w.read_at)
      AND (o.at IS NULL OR m.at > o.at)
      -- Never their own, not even one that mentions them.
      AND m.person IS NOT ?2
      AND NOT EXISTS (SELECT 1 FROM app_posts a WHERE a.source = m.source
        AND a.tenant = m.tenant AND a.channel_id = m.channel_id AND a.id = m.id
        AND a.person = ?2)
      AND (m.counted = 1 OR (m.author_kind = 'bot' AND ${ANSWERS_ME})
        OR EXISTS (SELECT 1 FROM mentions n
        WHERE n.thread = m.thread AND n.person = ?2
          AND n.message = m.source || ':' || m.tenant || ':' || m.channel_id || ':' || m.id))
    GROUP BY m.thread`).bind(JSON.stringify(threads), me).all();
  return new Map((results || []).map((r) => [r.thread, r.n]));
}

/**
 * The bots' replies that came after the last person's message of each of `threads` (an agent's
 * `post_message`, say): its row shows that one, not the message it answers, since it is what is
 * new. `last_text` is people's only (bots do not answer the customer, `last_staff`).
 *
 * @returns {Promise<Map<string, { who: string, text: string, at: string }>>}
 */
export async function botReplies(db, threads) {
  if (!threads.length) {
    return new Map();
  }
  const { results } = await db.prepare(`SELECT m.thread, m.author, m.preview, m.at
    FROM threads t JOIN messages m ON m.thread = t.thread AND m.at = t.any_at
    WHERE t.thread IN (SELECT value FROM json_each(?1)) AND t.any_at > COALESCE(t.last_at, '')
      AND m.deleted = 0 AND m.author_kind = 'bot' AND m.preview IS NOT NULL`)
    .bind(JSON.stringify(threads)).all();
  return new Map((results || []).map((r) => [r.thread, { who: r.author || '', text: r.preview, at: r.at }]));
}

/**
 * Records who a message mentions, replacing what was recorded for it before. Returns the
 * people it mentions now and did not before (a new message's, or the ones an edit added).
 */
export async function recordMentions(db, { thread, message, at }, mentioned) {
  const had = new Set();
  if (mentioned.length) {
    const { results } = await db.prepare('SELECT person FROM mentions WHERE thread = ? AND message = ?')
      .bind(thread, message).all();
    (results || []).forEach((r) => had.add(r.person));
  }
  await db.prepare('DELETE FROM mentions WHERE thread = ? AND message = ?').bind(thread, message).run();
  for (const { person, via } of mentioned) {
    // eslint-disable-next-line no-await-in-loop
    await db.prepare(`INSERT OR IGNORE INTO mentions (thread, message, person, at, via)
      VALUES (?, ?, ?, ?, ?)`).bind(thread, message, person, at, via).run();
  }
  return [...new Set(mentioned.map((m) => m.person))].filter((p) => !had.has(p));
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

/**
 * Adds or removes one reaction (Slack reaction events, and reactions made in the inbox).
 * A removal only takes away a reaction made before it, and a later add of the same
 * reaction moves its time forward, so a remove-and-add arrives right in either order.
 */
export async function applyReaction(db, {
  thread, message, emoji, userKey, at, removed,
}) {
  if (!emoji) {
    return;
  }
  if (removed) {
    await db.prepare(`DELETE FROM reactions WHERE message = ? AND emoji = ? AND user_key = ?
      AND (? IS NULL OR at IS NULL OR at <= ?)`)
      .bind(message, emoji, userKey, at || null, at || null).run();
    return;
  }
  await db.prepare(`INSERT INTO reactions (message, thread, emoji, user_key, at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (message, emoji, user_key) DO UPDATE SET at = excluded.at
    WHERE excluded.at > COALESCE(reactions.at, '')`)
    .bind(message, thread, emoji, userKey, at || null).run();
}
