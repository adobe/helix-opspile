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

import { entryOf } from '../drafts.js';
import { EMBEDDING_MODEL } from '../rethread.js';

/**
 * The channel's earlier conversations, for a thread agent (list_channel_threads, and
 * read_thread with a `thread`): only the threads of its own channel, the one its inbox entry
 * is in, so that an agent never reads another customer's or team's channel. A re-threaded
 * group is one conversation, under its first thread's key.
 */

export const MAX_LIST = 50;
const DEFAULT_LIST = 20;
const VECTOR_K = 20;
// Similarity (bge, cosine) below which a first message is not about the query.
const MIN_SIMILAR = 0.5;

const COLUMNS = `t.thread, COALESCE(l.title, t.title) AS title, t.root_at, t.last_at, t.messages,
  m.permalink`;
const FROM = `FROM threads t LEFT JOIN labels l ON l.thread = t.thread
  LEFT JOIN messages m ON m.source = t.source AND m.tenant = t.tenant
    AND m.channel_id = t.channel_id AND m.id = t.root_id`;
// Conversations: no member of a re-threaded group (its first thread stands for it), and not
// only system messages ("… has joined the channel"), which leave last_at empty.
const LISTED = 't.channel_id = ? AND t.source = ? AND t.tenant = ? AND t.logical_thread IS NULL AND t.last_at IS NOT NULL';

/** The channel of inbox entry `key`: `{ source, tenant, channel_id, keys }`, or null. */
export async function channelOf(env, key) {
  const entry = key && await entryOf(env, key);
  const row = entry && await env.DB.prepare('SELECT source, tenant, channel_id FROM threads WHERE thread = ?')
    .bind(entry.key).first();
  return row ? { ...row, keys: entry.keys } : null;
}

const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Roots of the channel similar to `query` (Vectorize, as rethread.js writes them), by score. */
async function similarRoots(env, here, query) {
  if (!env.VECTORS || !env.AI) {
    return [];
  }
  try {
    const res = await env.AI.run(EMBEDDING_MODEL, { text: [String(query).slice(0, 1500)] });
    const found = await env.VECTORS.query(res.data[0], {
      topK: VECTOR_K,
      filter: { channel: `${here.source}:${here.tenant}:${here.channel_id}` },
      returnMetadata: 'all',
    });
    return (found.matches || [])
      .filter((m) => m.metadata && m.metadata.thread && m.score >= MIN_SIMILAR)
      .map((m) => ({ thread: m.metadata.thread, score: m.score }));
  } catch (e) {
    console.log(JSON.stringify({ route: 'agent', history: 'vector search failed', error: e.message }));
    return [];
  }
}

/**
 * The conversations of the channel of inbox entry `key` other than that entry, latest
 * activity first: `{ threads: [{ thread, title, root_at, last_at, messages, permalink }],
 * more }`. `query` keeps those whose title has it, then those whose first message is about
 * it (by embedding); `before` (a last_at) pages on.
 */
export async function channelThreads(env, key, { query = '', before = null, limit = DEFAULT_LIST } = {}) {
  const here = await channelOf(env, key);
  if (!here) {
    return { error: 'the thread is not known' };
  }
  const n = Math.min(Math.max(Number(limit) || DEFAULT_LIST, 1), MAX_LIST);
  const bind = [here.channel_id, here.source, here.tenant, JSON.stringify(here.keys)];
  const notHere = 'AND t.thread NOT IN (SELECT value FROM json_each(?))';
  const q = String(query || '').trim();
  if (!q) {
    const { results } = await env.DB.prepare(`SELECT ${COLUMNS} ${FROM}
      WHERE ${LISTED} ${notHere} ${before ? 'AND t.last_at < ?' : ''}
      ORDER BY t.last_at DESC LIMIT ?`).bind(...bind, ...(before ? [String(before)] : []), n + 1).all();
    const rows = results || [];
    return { threads: rows.slice(0, n), more: rows.length > n };
  }
  const { results: titled } = await env.DB.prepare(`SELECT ${COLUMNS} ${FROM}
    WHERE ${LISTED} ${notHere} AND COALESCE(l.title, t.title, '') LIKE ? ESCAPE '\\'
    ORDER BY t.last_at DESC LIMIT ?`).bind(...bind, like(q), n + 1).all();
  const out = [...(titled || [])];
  const similar = out.length < n ? await similarRoots(env, here, q) : [];
  if (similar.length) {
    // A hit may be a member of a re-threaded group: the group's first thread stands for it.
    const { results: groups } = await env.DB.prepare(`SELECT thread,
        COALESCE(logical_thread, thread) AS k FROM threads
      WHERE thread IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(similar.map((x) => x.thread))).all();
    const groupOf = new Map((groups || []).map((g) => [g.thread, g.k]));
    const rank = new Map();
    for (const x of similar) {
      const k = groupOf.get(x.thread);
      if (k && !rank.has(k)) {
        rank.set(k, rank.size);
      }
    }
    const { results } = await env.DB.prepare(`SELECT ${COLUMNS} ${FROM}
      WHERE ${LISTED} ${notHere} AND t.thread IN (SELECT value FROM json_each(?))`)
      .bind(...bind, JSON.stringify([...rank.keys()])).all();
    const seen = new Set(out.map((r) => r.thread));
    out.push(...(results || []).filter((r) => !seen.has(r.thread))
      .sort((a, b) => rank.get(a.thread) - rank.get(b.thread)));
  }
  return { threads: out.slice(0, n), more: out.length > n };
}

/**
 * What a message link names: the message ids, most specific first (the thread's root, then
 * the message), and the channel when the link says (Slack, Teams; a Discord link names a
 * Discord thread's own channel id).
 */
function parseLink(ref) {
  let url;
  try {
    url = new URL(ref);
  } catch {
    return { ids: [] };
  }
  const param = (name) => url.searchParams.get(name);
  const ids = [param('thread_ts'), param('parentMessageId')];
  let channel = null;
  // Slack: /archives/<channel>/p<ts without the dot>?thread_ts=<root>
  const slack = /\/archives\/([^/]+)\/p(\d{10})(\d{6})/.exec(url.pathname);
  // Teams: /l/message/<channel>/<message>?parentMessageId=<root>
  const teams = /\/l\/message\/([^/]+)\/(\d+)/.exec(url.pathname);
  // Discord: /channels/<guild>/<channel or thread>/<message>
  const discord = /\/channels\/[^/]+\/(\d+)(?:\/(\d+))?/.exec(url.pathname);
  if (slack) {
    [, channel] = slack;
    ids.push(`${slack[2]}.${slack[3]}`);
  } else if (teams) {
    channel = decodeURIComponent(teams[1]);
    ids.push(teams[2]);
  } else if (discord) {
    ids.push(discord[2], discord[1]);
  }
  return { ids: [...new Set(ids.filter(Boolean))], channel };
}

/**
 * The inbox entry key that `ref` names in the channel of inbox entry `key`: a thread key, a
 * link to one of its messages, or a message id. `{ key }`, or `{ error }` when it is not a
 * thread of that channel.
 */
export async function resolveThread(env, key, ref) {
  const here = await channelOf(env, key);
  if (!here) {
    return { error: 'the thread is not known' };
  }
  const s = String(ref || '').trim();
  let thread = null;
  const row = s && await env.DB.prepare(`SELECT thread, source, tenant, channel_id FROM threads
    WHERE thread = ?`).bind(s).first();
  if (row) {
    const same = row.source === here.source && row.tenant === here.tenant
      && row.channel_id === here.channel_id;
    if (!same) {
      return { error: 'that thread is in another channel; you can only read the threads of yours' };
    }
    thread = row.thread;
  } else {
    const link = /^[\w.:@-]+$/.test(s) ? { ids: [s] } : parseLink(s);
    if (link.channel && link.channel !== here.channel_id) {
      return { error: 'that link is to another channel; you can only read the threads of yours' };
    }
    for (const id of link.ids) {
      // eslint-disable-next-line no-await-in-loop
      const m = await env.DB.prepare(`SELECT thread FROM messages
        WHERE source = ? AND tenant = ? AND channel_id = ? AND id = ?`)
        .bind(here.source, here.tenant, here.channel_id, id).first();
      if (m) {
        thread = m.thread;
        break;
      }
    }
  }
  if (!thread) {
    return { error: 'no thread of your channel has that key, link or message id; list_channel_threads lists them' };
  }
  const entry = await entryOf(env, thread);
  return entry ? { key: entry.key } : { error: 'the thread is not known' };
}
