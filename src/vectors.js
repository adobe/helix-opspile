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

import { threadMessages } from './label.js';
import { sha256 } from './raw.js';
import { EMBEDDING_MODEL } from './rethread.js';
import { indexThread } from './fulltext.js';

/**
 * Message and thread vectors (CONTENT, Vectorize): one vector per message a person posted in
 * a channel thread, and one per thread, made from all of its messages. They are what a
 * search over what was said, and who said it, runs on: `type` tells them apart, `person` and
 * `staff` say who wrote a message. The roots' vectors for re-threading stay in VECTORS.
 *
 * A thread is vectorized shortly after a person posts in it, and the cron sweeps up the
 * threads that changed since their vector was made (including all of them, the first time).
 * Each message keeps a hash of the text its vector was made from, so only what changed is
 * embedded again; a message that is deleted, or no longer has anything to embed, loses its
 * vector.
 */

/** How long after a message the thread is vectorized: as long as it takes to label it. */
export const VECTORIZE_DELAY_SECONDS = 120;
/** About the 512 tokens bge-base reads; the rest of a longer input would be cut off. */
export const MAX_CHUNK = 1500;
/** A thread's vector is the mean of at most this many pieces: the first, then the latest. */
export const MAX_CHUNKS = 16;
/** A message's vector is the mean of at most this many pieces of it. */
const MAX_MESSAGE_CHUNKS = 4;
/** Shorter messages ("thanks", "+1") say nothing about a topic. */
export const MIN_TEXT = 12;
/** Texts per Workers AI call, and vectors per Vectorize call. */
const BATCH = 50;
/** Threads the cron enqueues per run, and how long a thread must be quiet first. */
export const SWEEP = 50;
const SETTLE_MS = 5 * 60 * 1000;

const seconds = (iso) => Math.floor(Date.parse(iso) / 1000);
const hashOf = async (text) => (await sha256(text)).slice(0, 32);
export const messageVectorId = async (key) => (await sha256(`message:${key}`)).slice(0, 48);
export const threadVectorId = async (key) => (await sha256(`thread:${key}`)).slice(0, 48);

/** A message's text for its vector: the markdown body, whitespace collapsed. */
export function messageText(body) {
  return String(body || '').replace(/\s+/g, ' ').trim();
}

/** `text` in pieces of at most `max` characters, cut at a space where there is one. */
export function chunks(text, max = MAX_CHUNK) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > max) {
    const space = rest.lastIndexOf(' ', max);
    const cut = space > max / 2 ? space : max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) {
    out.push(rest);
  }
  return out;
}

/**
 * The pieces a thread's vector is made from: its title, then its messages, packed into
 * pieces of at most MAX_CHUNK characters. A longer thread keeps its first piece (the
 * question) and its latest.
 */
export function threadChunks(title, texts) {
  const out = [];
  let current = '';
  for (const part of [title, ...texts].filter(Boolean).flatMap((t) => chunks(t))) {
    if (current && current.length + part.length + 2 > MAX_CHUNK) {
      out.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${part}` : part;
  }
  if (current) {
    out.push(current);
  }
  return out.length > MAX_CHUNKS ? [out[0], ...out.slice(-(MAX_CHUNKS - 1))] : out;
}

/** The mean of `vectors`, of unit length (cosine is what the index compares). */
export function mean(vectors) {
  const sum = new Array(vectors[0].length).fill(0);
  for (const v of vectors) {
    v.forEach((x, i) => {
      sum[i] += x;
    });
  }
  const norm = Math.sqrt(sum.reduce((s, x) => s + x * x, 0)) || 1;
  return sum.map((x) => x / norm);
}

/** One vector per list of pieces: the pieces are embedded in batches, then averaged. */
async function embed(env, pieceLists) {
  const flat = pieceLists.flat();
  const vectors = [];
  for (let i = 0; i < flat.length; i += BATCH) {
    // eslint-disable-next-line no-await-in-loop
    const res = await env.AI.run(EMBEDDING_MODEL, { text: flat.slice(i, i + BATCH) });
    vectors.push(...res.data);
  }
  let at = 0;
  return pieceLists.map((pieces) => {
    const own = vectors.slice(at, at + pieces.length);
    at += pieces.length;
    return mean(own);
  });
}

async function upsert(env, items) {
  for (let i = 0; i < items.length; i += BATCH) {
    // eslint-disable-next-line no-await-in-loop
    await env.CONTENT.upsert(items.slice(i, i + BATCH));
  }
}

async function remove(env, ids) {
  for (let i = 0; i < ids.length; i += BATCH) {
    // eslint-disable-next-line no-await-in-loop
    await env.CONTENT.deleteByIds(ids.slice(i, i + BATCH));
  }
}

/** Metadata without the values Vectorize cannot hold (null, undefined). */
const defined = (o) => Object.fromEntries(Object.entries(o)
  .filter(([, v]) => v !== null && v !== undefined));

/**
 * Takes away the vectors of a thread that is no longer a channel thread (re-filed as an alert
 * or ignored): `{ removed }`, or nothing when it had none.
 */
async function dropVectors(env, thread) {
  if (!env.CONTENT) {
    return {};
  }
  const { results } = await env.DB.prepare(`SELECT id FROM messages
    WHERE thread = ? AND embedded IS NOT NULL`).bind(thread.thread).all();
  const rows = results || [];
  if (!rows.length && !thread.embedded) {
    return {};
  }
  const channel = `${thread.source}:${thread.tenant}:${thread.channel_id}`;
  await remove(env, [
    ...await Promise.all(rows.map((r) => messageVectorId(`${channel}:${r.id}`))),
    ...(thread.embedded ? [await threadVectorId(thread.thread)] : []),
  ]);
  await env.DB.prepare('UPDATE messages SET embedded = NULL WHERE thread = ?').bind(thread.thread).run();
  await env.DB.prepare(`UPDATE threads SET embedded = NULL, vectorized_through = NULL
    WHERE thread = ?`).bind(thread.thread).run();
  return { removed: rows.length + (thread.embedded ? 1 : 0) };
}

/**
 * The thread's full-text items brought up to date (src/fulltext.js). A failure there (the
 * service, its item limit) is logged and leaves the thread for the sweep to come back to
 * (`complete: false`), and does not keep the vectors from being made.
 */
async function fulltextOf(env, thread, files) {
  try {
    return await indexThread(env, thread, files);
  } catch (e) {
    console.log(JSON.stringify({
      route: 'fulltext', thread: thread.thread, error: e.message,
    }));
    return {
      uploaded: 0, removed: 0, complete: false, error: e.message,
    };
  }
}

/**
 * Brings the vectors of thread `key` and of its messages up to date (CONTENT), and its
 * messages' full-text items (SEARCH, src/fulltext.js), with whichever of them is bound. Only
 * channel threads (an alert thread is a bot's post); vectors only for what a person wrote.
 */
export async function vectorizeThread(env, key) {
  const thread = await env.DB.prepare(`SELECT t.*, COALESCE(l.title, t.title) AS shown_title
    FROM threads t LEFT JOIN labels l ON l.thread = t.thread WHERE t.thread = ?`).bind(key).first();
  if (!thread) {
    return { result: 'missing' };
  }
  if (thread.kind !== 'channel') {
    const items = env.SEARCH ? await fulltextOf(env, thread, new Map()) : null;
    return {
      result: 'skip',
      reason: thread.kind,
      ...await dropVectors(env, thread),
      ...(items && (items.removed || items.error) ? { fulltext: items } : {}),
    };
  }
  const { results } = await env.DB.prepare(`SELECT id, at, person, staff, counted, deleted,
      author_key, embedded FROM messages WHERE thread = ?`).bind(key).all();
  const files = new Map((await threadMessages(env, thread)).map((m) => [String(m.id), m]));
  const fulltext = env.SEARCH ? await fulltextOf(env, thread, files) : null;
  if (!env.CONTENT || !env.AI) {
    await env.DB.prepare('UPDATE threads SET indexed_through = ? WHERE thread = ?')
      .bind(fulltext && fulltext.complete ? thread.any_at : null, key).run();
    return { result: 'indexed', fulltext };
  }
  const channel = `${thread.source}:${thread.tenant}:${thread.channel_id}`;
  const common = {
    channel, thread: key, org: thread.org, team: thread.team,
  };

  // Messages: embed what is new or changed, drop what is gone.
  const fresh = [];
  const gone = [];
  const said = [];
  for (const row of results || []) {
    const file = files.get(String(row.id));
    const text = file && !file.deletedAt && !row.deleted && row.counted ? messageText(file.body) : '';
    if (text.length >= MIN_TEXT) {
      said.push({ at: String(row.at), text });
      // eslint-disable-next-line no-await-in-loop
      const hash = await hashOf(text);
      if (hash !== row.embedded) {
        fresh.push({ row, text, hash });
      }
    } else if (row.embedded) {
      gone.push(row);
    }
  }
  if (fresh.length) {
    const values = await embed(env, fresh.map((f) => chunks(f.text).slice(0, MAX_MESSAGE_CHUNKS)));
    const items = await Promise.all(fresh.map(async ({ row }, i) => {
      const message = `${channel}:${row.id}`;
      return {
        id: await messageVectorId(message),
        values: values[i],
        metadata: defined({
          type: 'message',
          ...common,
          message,
          at: seconds(row.at),
          person: row.person,
          staff: Boolean(row.staff),
          author: row.author_key,
        }),
      };
    }));
    await upsert(env, items);
  }
  if (gone.length) {
    await remove(env, await Promise.all(gone.map((row) => messageVectorId(`${channel}:${row.id}`))));
  }
  for (const { row, hash } of fresh) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare('UPDATE messages SET embedded = ? WHERE thread = ? AND id = ?')
      .bind(hash, key, row.id).run();
  }
  for (const row of gone) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare('UPDATE messages SET embedded = NULL WHERE thread = ? AND id = ?')
      .bind(key, row.id).run();
  }

  // The thread: everything people wrote in it, in order, under its title.
  const ordered = said.sort((a, b) => a.at.localeCompare(b.at)).map((m) => m.text);
  const pieces = ordered.length ? threadChunks(thread.shown_title, ordered) : [];
  const hash = pieces.length ? await hashOf(pieces.join('\n\n')) : null;
  let threadResult = 'unchanged';
  if (hash && hash !== thread.embedded) {
    const [values] = await embed(env, [pieces]);
    await upsert(env, [{
      id: await threadVectorId(key),
      values,
      metadata: defined({
        type: 'thread',
        ...common,
        at: thread.root_at ? seconds(thread.root_at) : null,
        last: thread.last_at ? seconds(thread.last_at) : null,
        messages: ordered.length,
      }),
    }]);
    threadResult = 'embedded';
  } else if (!hash && thread.embedded) {
    await remove(env, [await threadVectorId(key)]);
    threadResult = 'removed';
  }
  await env.DB.prepare(`UPDATE threads SET embedded = ?, vectorized_through = ?,
      indexed_through = ? WHERE thread = ?`)
    .bind(hash, thread.any_at, fulltext && fulltext.complete ? thread.any_at : null, key).run();
  return {
    result: 'vectorized',
    messages: fresh.length,
    removed: gone.length,
    thread: threadResult,
    ...(fulltext ? { fulltext } : {}),
  };
}

/**
 * Cron: enqueues the channel threads whose vectors (or full-text items) are older than their
 * latest message, the most recently active first, once they have been quiet for a few
 * minutes. The first runs after a deploy vectorize and index what was there before.
 */
export async function sweepVectors(env, now = new Date()) {
  const vectors = Boolean(env.CONTENT && env.AI);
  if ((!vectors && !env.SEARCH) || !env.NORMALIZE) {
    return { skipped: 'no CONTENT index' };
  }
  const { results } = await env.DB.prepare(`SELECT thread FROM threads
    WHERE kind = 'channel' AND last_at IS NOT NULL AND any_at < ?
      AND ((?3 AND (vectorized_through IS NULL OR vectorized_through != any_at))
        OR (?4 AND (indexed_through IS NULL OR indexed_through != any_at)))
    ORDER BY any_at DESC LIMIT ?2`)
    .bind(
      new Date(now.getTime() - SETTLE_MS).toISOString(),
      SWEEP,
      vectors ? 1 : 0,
      env.SEARCH ? 1 : 0,
    ).all();
  const jobs = (results || []).map((r) => ({ body: { vectorize: r.thread } }));
  if (jobs.length) {
    await env.NORMALIZE.sendBatch(jobs);
  }
  return { queued: jobs.length };
}
