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

import { parse, render } from './channels.js';
import { CLEF } from './label.js';
import { notifyRoom } from './notify.js';
import { sha256 } from './raw.js';
import { teamsOf } from './shares.js';

/**
 * Re-threading. When a root message arrives, the most similar earlier roots in the same
 * channel are found by vector search (Workers AI embeddings in Vectorize). A near-identical
 * one is a match outright; otherwise Clef chooses between the candidates (in conversations,
 * always including the channel's previous root from the last hour) and "a new topic".
 * A match sets `logicalThread` on the new thread, pointing at the earliest thread of the
 * group, so repeated alerts and follow-ups fold into one inbox entry.
 */

/** How long after a root arrives it is re-threaded (its agent waits for that). */
export const RETHREAD_DELAY_SECONDS = 30;
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
export const TOP_K = 6;
export const WINDOW_DAYS = 14;
/** At or above this similarity, two roots are the same without asking Clef. */
export const AUTO_MATCH = 0.97;
/** Below this similarity, a candidate is not worth asking about. */
export const MIN_CANDIDATE = 0.82;
/** In conversations, follow-ups are worded differently: ask Clef about weaker matches. */
export const MIN_CANDIDATE_CONVERSATION = 0.6;
/** A second root by the same person this soon after their first continues it. */
export const BURST_MS = 10 * 60 * 1000;
/**
 * In conversations, the channel's previous root from this recently is always a candidate,
 * however differently it is worded: answers, nudges and escalations posted as new messages
 * ("this is a blocker, please help") share few words with what they follow up.
 */
export const RECENT_MS = 60 * 60 * 1000;
/** Clef must be at least this sure that the new root continues a candidate. */
export const MIN_CLEF = 0.7;
const MAX_TEXT = 1500;
const SNIPPET = 600;

/**
 * The root's text with the parts that differ between repeats of the same event removed:
 * fields that only hold a link, short codes, timestamps, long numbers, hex and UUID ids,
 * query strings and user agents. Short numbers (status codes, ports) stay, because they
 * tell different failures apart.
 */
export function skeleton(text) {
  return String(text || '')
    // A field whose whole value is a link (the page an alert fired on) is context, not
    // identity; short upper-case codes in a field (coupons, ids) are values, too.
    .split('\n')
    .filter((l) => !/^\*{1,2}[^*\n]+:\*{1,2}\s*<?https?:\/\/\S+>?\s*$/.test(l))
    .join('\n')
    .replace(/^(\*{1,2}[^*\n]+:\*{1,2})\s*[A-Z0-9]{4,16}\s*$/gm, '$1 <code>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/\b\d{5,}\b/g, '<n>')
    .replace(/(https?:\/\/[^\s?#>|]+)[?#][^\s>|]*/g, '$1')
    .replace(/Mozilla\/[^\n]*/g, '<user-agent>')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

const channelKey = (t) => `${t.source}:${t.tenant}:${t.channel_id}`;
const vectorId = async (thread) => (await sha256(thread)).slice(0, 48);

async function rootBody(env, thread) {
  const obj = await env.CHANNELS.get(`${thread.path}${thread.root_id}.md`);
  const parsed = obj ? parse(await obj.text()) : null;
  return parsed ? { parsed, obj } : null;
}

/** Writes `logicalThread` into the root's pile-2 file, as ARCHITECTURE describes. */
async function markRootFile(env, thread, logical) {
  const root = await rootBody(env, thread);
  if (!root || root.parsed.meta.logicalThread === (logical || undefined)) {
    return;
  }
  const meta = { ...root.parsed.meta, logicalThread: logical || undefined };
  await env.CHANNELS.put(`${thread.path}${thread.root_id}.md`, render(meta, root.parsed.body), {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    customMetadata: root.obj.customMetadata || {},
  });
}

async function embed(env, text) {
  const res = await env.AI.run(EMBEDDING_MODEL, { text: [text] });
  return res.data[0];
}

/** How long before the new root a candidate was posted, in words. */
export function ago(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 120) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

export const CLEF_INSTRUCTIONS = 'This message was posted as a new thread instead of a reply. '
  + 'Is it part of the conversation of one of the earlier threads, or a new topic? '
  + 'It is part of an earlier conversation when it repeats the same issue or alert, answers or '
  + 'reacts to the earlier message, or follows it up: adds details, asks again, escalates, or '
  + 'presses for an answer, even without naming the issue again. A message that names no issue '
  + 'of its own belongs to the most recent earlier thread. It is a new topic when it raises a '
  + 'different question or issue.';

/**
 * Clef: does the new root continue one of the candidates? Candidates (`{ thread, group, text,
 * ago }`) of the same group share their probability, so a group that is offered twice (its
 * most similar root and its latest) is not split in two.
 */
export async function askClef(env, text, candidates) {
  const criteria = { new: 'A different question, issue or topic' };
  candidates.forEach((c, i) => {
    const when = c.ago ? `, posted ${c.ago} before` : '';
    criteria[`c${i}`] = `Continues this earlier thread${when}: ${c.text.slice(0, SNIPPET)}`;
  });
  const res = await env.AI.run(CLEF, {
    model: 'clef',
    state: text.slice(0, MAX_TEXT * 2),
    questions: {
      continues: {
        type: 'choice',
        instructions: CLEF_INSTRUCTIONS,
        criteria,
      },
    },
  });
  const a = res.answers && res.answers.continues;
  if (!a || !a.choice) {
    return { p: 0 };
  }
  const probabilities = a.probabilities || { [a.choice]: a.confidence ?? 0 };
  const groups = new Map();
  candidates.forEach((c, i) => {
    const g = c.group || c.thread;
    groups.set(g, (groups.get(g) || 0) + (probabilities[`c${i}`] || 0));
  });
  let best = null;
  for (const [group, p] of groups) {
    if (!best || p > best.p) {
      best = { group, p };
    }
  }
  if (!best || best.p < MIN_CLEF) {
    return { p: best ? best.p : 0 };
  }
  const candidate = candidates.find((c) => (c.group || c.thread) === best.group);
  return { candidate, p: best.p };
}

/**
 * Re-threads one thread by its root. Idempotent: a thread that was decided once is not
 * decided again (pass `force` to redo it).
 */
export async function rethread(env, key, { force = false } = {}) {
  const thread = await env.DB.prepare('SELECT * FROM threads WHERE thread = ?').bind(key).first();
  if (!thread || !thread.root_at) {
    return { result: 'skip', reason: 'no root' };
  }
  if (thread.rethreaded_at && !force) {
    return { result: 'unchanged', logical: thread.logical_thread };
  }
  const root = await rootBody(env, thread);
  if (!root || root.parsed.meta.deletedAt) {
    return { result: 'skip', reason: 'root missing or deleted' };
  }
  const text = skeleton(root.parsed.body || thread.title);
  if (!text) {
    return { result: 'skip', reason: 'empty' };
  }

  const at = Math.floor(Date.parse(thread.root_at) / 1000);
  const hash = (await sha256(text)).slice(0, 32);
  await env.DB.prepare('UPDATE threads SET skeleton_hash = ? WHERE thread = ?').bind(hash, key).run();

  // An exact repeat: the earliest thread in the channel and window with the same skeleton.
  const twin = await env.DB.prepare(`SELECT thread, logical_thread FROM threads
    WHERE source = ? AND tenant = ? AND channel_id = ? AND skeleton_hash = ? AND thread != ?
      AND root_at >= ? AND root_at <= ? ORDER BY root_at LIMIT 1`)
    .bind(
      thread.source,
      thread.tenant,
      thread.channel_id,
      hash,
      key,
      new Date((at - WINDOW_DAYS * 86400) * 1000).toISOString(),
      thread.root_at,
    ).first();

  // A burst: the channel's previous root is by the same person, minutes earlier. People
  // split one request over several messages instead of replying to themselves.
  // Only people in conversations: a bot posts many different alerts within minutes.
  const conversation = thread.kind === 'channel';
  const rootAuthor = conversation && await env.DB.prepare(`SELECT author_key
    FROM messages WHERE thread = ? AND id = ? AND counted = 1`).bind(key, thread.root_id).first();
  const author = rootAuthor && rootAuthor.author_key;
  const previous = conversation && await env.DB.prepare(`SELECT t.*, m.author_key FROM threads t
    JOIN messages m ON m.thread = t.thread AND m.id = t.root_id AND m.counted = 1
    WHERE t.source = ? AND t.tenant = ? AND t.channel_id = ? AND t.thread != ?
      AND t.root_at < ? AND t.root_at >= ? ORDER BY t.root_at DESC LIMIT 1`)
    .bind(
      thread.source,
      thread.tenant,
      thread.channel_id,
      key,
      thread.root_at,
      new Date(Date.parse(thread.root_at) - RECENT_MS).toISOString(),
    ).first();
  const burst = previous && author && previous.author_key === author
    && Date.parse(thread.root_at) - Date.parse(previous.root_at) <= BURST_MS ? previous : null;

  const values = await embed(env, text);
  const found = await env.VECTORS.query(values, {
    topK: TOP_K,
    filter: { channel: channelKey(thread) },
    returnMetadata: 'all',
  });
  await env.VECTORS.upsert([{
    id: await vectorId(key), values, metadata: { channel: channelKey(thread), thread: key, at },
  }]);

  // Earlier roots in the window, most similar first.
  const earlier = (found.matches || [])
    .filter((m) => m.metadata && m.metadata.thread !== key && m.metadata.at < at
      && m.metadata.at >= at - WINDOW_DAYS * 86400
      && m.score >= (conversation ? MIN_CANDIDATE_CONVERSATION : MIN_CANDIDATE))
    .sort((a, b) => b.score - a.score);

  let match = null;
  let asked = null;
  if (burst) {
    match = { thread: burst.thread, via: 'burst', p: 1 };
  } else if (twin) {
    match = { thread: twin.thread, via: 'skeleton', p: 1 };
  } else if (earlier.length && earlier[0].score >= AUTO_MATCH) {
    match = { thread: earlier[0].metadata.thread, via: 'vector', p: earlier[0].score };
  } else if (earlier.length || previous) {
    const rows = [];
    for (const m of earlier.slice(0, 4)) {
      // eslint-disable-next-line no-await-in-loop
      rows.push(await env.DB.prepare('SELECT * FROM threads WHERE thread = ?').bind(m.metadata.thread).first());
    }
    // The conversation's latest root, however it is worded (see RECENT_MS).
    if (previous && !rows.some((r) => r && r.thread === previous.thread)) {
      rows.push(previous);
    }
    const candidates = [];
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      const body = row && await rootBody(env, row);
      if (body && !body.parsed.meta.deletedAt) {
        candidates.push({
          thread: row.thread,
          group: row.logical_thread || row.thread,
          text: skeleton(body.parsed.body),
          ago: ago(Date.parse(thread.root_at) - Date.parse(row.root_at)),
        });
      }
    }
    asked = candidates.length ? await askClef(env, text, candidates) : null;
    if (asked && asked.candidate) {
      match = { thread: asked.candidate.thread, via: 'clef', p: asked.p };
    }
  }

  let logical = null;
  if (match) {
    // Point at the group's first thread, so a chain of repeats is one group.
    const target = await env.DB.prepare('SELECT logical_thread FROM threads WHERE thread = ?')
      .bind(match.thread).first();
    logical = (target && target.logical_thread) || match.thread;
  }
  await env.DB.prepare(`UPDATE threads SET logical_thread = ?, logical_via = ?, logical_p = ?,
    rethreaded_at = ? WHERE thread = ?`)
    .bind(logical, match ? match.via : null, match ? match.p : null, new Date().toISOString(), key)
    .run();
  await markRootFile(env, thread, logical);

  // Replays arrive in any order: near-identical later roots that found nothing earlier
  // (because this one was not indexed yet) join this group now, and so do the threads that
  // had joined them. Every member always points at the group's first thread.
  const group = logical || key;
  const joined = [key];
  for (const m of found.matches || []) {
    if (m.metadata && m.metadata.thread !== key && m.metadata.at > at
      && m.metadata.at <= at + WINDOW_DAYS * 86400 && m.score >= AUTO_MATCH) {
      // eslint-disable-next-line no-await-in-loop
      const later = await env.DB.prepare('SELECT logical_thread FROM threads WHERE thread = ?')
        .bind(m.metadata.thread).first();
      if (later && (!later.logical_thread || joined.includes(later.logical_thread))) {
        // eslint-disable-next-line no-await-in-loop
        await env.DB.prepare(`UPDATE threads SET logical_thread = ?, logical_via = 'vector',
            logical_p = ?, rethreaded_at = ? WHERE thread = ?`)
          .bind(group, m.score, new Date().toISOString(), m.metadata.thread).run();
        joined.push(m.metadata.thread);
      }
    }
  }
  // Later exact twins join, unless they already belong to a group that starts earlier.
  const { results: laterTwins } = await env.DB.prepare(`SELECT t.thread, t.logical_thread,
      a.root_at AS anchor_at FROM threads t LEFT JOIN threads a ON a.thread = t.logical_thread
    WHERE t.source = ? AND t.tenant = ? AND t.channel_id = ? AND t.skeleton_hash = ? AND t.thread != ?
      AND t.root_at > ? AND t.root_at <= ?`)
    .bind(
      thread.source,
      thread.tenant,
      thread.channel_id,
      hash,
      key,
      thread.root_at,
      new Date((at + WINDOW_DAYS * 86400) * 1000).toISOString(),
    ).all();
  for (const t of laterTwins || []) {
    if (!t.logical_thread || joined.includes(t.logical_thread) || t.anchor_at > thread.root_at) {
      // eslint-disable-next-line no-await-in-loop
      await env.DB.prepare(`UPDATE threads SET logical_thread = ?, logical_via = 'skeleton',
          logical_p = 1, rethreaded_at = ? WHERE thread = ?`)
        .bind(group, new Date().toISOString(), t.thread).run();
      joined.push(t.thread);
    }
  }
  // The next root, if it is by the same person minutes later, continues this one.
  const next = author && await env.DB.prepare(`SELECT t.thread, t.logical_thread, m.author_key
    FROM threads t JOIN messages m ON m.thread = t.thread AND m.id = t.root_id
    WHERE t.source = ? AND t.tenant = ? AND t.channel_id = ? AND t.thread != ?
      AND t.root_at > ? AND t.root_at <= ? ORDER BY t.root_at LIMIT 1`)
    .bind(
      thread.source,
      thread.tenant,
      thread.channel_id,
      key,
      thread.root_at,
      new Date(Date.parse(thread.root_at) + BURST_MS).toISOString(),
    ).first();
  const nextFree = next && (!next.logical_thread || joined.includes(next.logical_thread));
  if (nextFree && next.author_key === author) {
    await env.DB.prepare(`UPDATE threads SET logical_thread = ?, logical_via = 'burst', logical_p = 1,
        rethreaded_at = ? WHERE thread = ?`).bind(group, new Date().toISOString(), next.thread).run();
    joined.push(next.thread);
  }
  const { results: moved } = await env.DB.prepare(`SELECT * FROM threads
    WHERE logical_thread IN (SELECT value FROM json_each(?)) OR thread IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(joined), JSON.stringify(joined.slice(1))).all();
  const folded = new Set(logical && logical !== thread.logical_thread ? [key] : []);
  joined.slice(1).forEach((t) => folded.add(t));
  for (const t of moved || []) {
    if (t.thread !== group) {
      if (t.logical_thread !== group) {
        folded.add(t.thread);
      }
      // eslint-disable-next-line no-await-in-loop
      await env.DB.prepare('UPDATE threads SET logical_thread = ? WHERE thread = ?').bind(group, t.thread).run();
      // eslint-disable-next-line no-await-in-loop
      await markRootFile(env, t, group);
    }
  }
  // Open inboxes show the group now, and a folded thread that is open there becomes its group.
  if (folded.size || (thread.logical_thread && thread.logical_thread !== logical)) {
    const rooms = env.ROOMS ? await teamsOf(env, thread) : [];
    await notifyRoom(env, rooms, {
      type: 'thread', thread: logical || thread.logical_thread || key, folded: [...folded],
    });
  }
  if (thread.kind === 'alert' && env.NORMALIZE) {
    await env.NORMALIZE.send({ label: logical || key });
  }
  return {
    result: logical ? 'rethreaded' : 'new-topic',
    via: match ? match.via : null,
    p: match ? match.p : null,
    // What Clef thought of the best candidate when it said no (for tuning MIN_CLEF).
    ...(!match && asked ? { clef: Math.round(asked.p * 100) / 100 } : {}),
  };
}
