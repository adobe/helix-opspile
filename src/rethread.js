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
import { sha256 } from './raw.js';

/**
 * Re-threading. When a root message arrives, the most similar earlier roots in the same
 * channel are found by vector search (Workers AI embeddings in Vectorize). A near-identical
 * one is a match outright; otherwise Clef chooses between the candidates and "a new topic".
 * A match sets `logicalThread` on the new thread, pointing at the earliest thread of the
 * group, so repeated alerts and follow-ups fold into one inbox entry.
 */

export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
export const TOP_K = 6;
export const WINDOW_DAYS = 14;
/** At or above this similarity, two roots are the same without asking Clef. */
export const AUTO_MATCH = 0.97;
/** Below this similarity, a candidate is not worth asking about. */
export const MIN_CANDIDATE = 0.82;
/** Clef must be at least this sure that the new root continues a candidate. */
export const MIN_CLEF = 0.7;
const MAX_TEXT = 1500;
const SNIPPET = 600;

/**
 * The root's text with the parts that differ between repeats of the same event removed:
 * timestamps, long numbers, hex and UUID ids, query strings and user agents. Short
 * numbers (status codes, ports) stay, because they tell different failures apart.
 */
export function skeleton(text) {
  return String(text || '')
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

/** Clef: does the new root continue one of the candidates? */
export async function askClef(env, text, candidates) {
  const criteria = { new: 'A different issue or a new topic' };
  candidates.forEach((c, i) => {
    criteria[`c${i}`] = `The same issue as this earlier thread: ${c.text.slice(0, SNIPPET)}`;
  });
  const res = await env.AI.run(CLEF, {
    model: 'clef',
    state: text.slice(0, MAX_TEXT * 2),
    questions: {
      continues: {
        type: 'choice',
        instructions: 'This message was posted as a new thread. Is it about the same issue as one of the earlier threads (a repeat of the same alert, or a follow-up), or a new topic?',
        criteria,
      },
    },
  });
  const a = res.answers && res.answers.continues;
  if (!a || a.choice === 'new') {
    return null;
  }
  const i = Number(a.choice.slice(1));
  const p = a.probabilities?.[a.choice] ?? a.confidence ?? 0;
  return p >= MIN_CLEF && candidates[i] ? { candidate: candidates[i], p } : null;
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
      && m.metadata.at >= at - WINDOW_DAYS * 86400 && m.score >= MIN_CANDIDATE)
    .sort((a, b) => b.score - a.score);

  let match = null;
  if (twin) {
    match = { thread: twin.thread, via: 'skeleton', p: 1 };
  } else if (earlier.length && earlier[0].score >= AUTO_MATCH) {
    match = { thread: earlier[0].metadata.thread, via: 'vector', p: earlier[0].score };
  } else if (earlier.length) {
    const candidates = [];
    for (const m of earlier.slice(0, 4)) {
      // eslint-disable-next-line no-await-in-loop
      const row = await env.DB.prepare('SELECT * FROM threads WHERE thread = ?').bind(m.metadata.thread).first();
      // eslint-disable-next-line no-await-in-loop
      const body = row && await rootBody(env, row);
      if (body) {
        candidates.push({ thread: row.thread, text: skeleton(body.parsed.body) });
      }
    }
    const chosen = candidates.length ? await askClef(env, text, candidates) : null;
    if (chosen) {
      match = { thread: chosen.candidate.thread, via: 'clef', p: chosen.p };
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
  const { results: moved } = await env.DB.prepare(`SELECT * FROM threads
    WHERE logical_thread IN (SELECT value FROM json_each(?)) OR thread IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(joined), JSON.stringify(joined.slice(1))).all();
  for (const t of moved || []) {
    if (t.thread !== group) {
      // eslint-disable-next-line no-await-in-loop
      await env.DB.prepare('UPDATE threads SET logical_thread = ? WHERE thread = ?').bind(group, t.thread).run();
      // eslint-disable-next-line no-await-in-loop
      await markRootFile(env, t, group);
    }
  }
  return {
    result: logical ? 'rethreaded' : 'new-topic', via: match ? match.via : null, p: match ? match.p : null,
  };
}
