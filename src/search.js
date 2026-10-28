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

import { parse } from './channels.js';
import { segment } from './raw.js';
import { EMBEDDING_MODEL } from './rethread.js';
import { channelTag } from './fulltext.js';

/**
 * Search over a team's inbox (or the viewer's teams', for the personal view), on every platform
 * at once: what the threads are about (the message and thread vectors of CONTENT,
 * src/vectors.js), the words of their messages (BM25 over the full-text items of SEARCH,
 * src/fulltext.js), and the words of their titles, channels, customers and facts (D1). `find`
 * ranks the inbox entries, best first, and says why each matched; `withSnippets` adds the
 * message that matched best. api.js's `searchInbox`
 * shapes them as the inbox does, for the viewer.
 *
 * The vectors are asked for the teams' own threads and the threads of the channels shared
 * with them; D1 decides what the viewer sees, as in the inbox.
 */

/** bge's instruction for short queries that look for passages. */
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
/** Below this similarity (bge, cosine), a message or thread is not about the query. */
export const MIN_SIMILAR = 0.6;
/** And not much less similar than the best match. */
export const SIMILAR_WINDOW = 0.12;
/** What a word match adds to the score: in the title, or in the channel or customer. */
export const TITLE_BONUS = 0.8;
export const PLACE_BONUS = 0.5;
export const FACT_BONUS = 0.4;
/** Every word in one of its messages (BM25), for the best such message, less for weaker ones. */
export const TEXT_BONUS = 0.7;
export const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 30;
const MAX_QUERY = 200;
const MAX_TERMS = 8;
const VECTOR_K = 50;
const KEYWORD_ROWS = 200;
/** The filter of a Vectorize query has at most 2 KB: shared channels go in parts. */
const FILTER_BYTES = 1800;
const SNIPPET = 240;
/** Full-text queries ask for the team's items, then the shared channels', so many at a time. */
const TAGS_PER_QUERY = 50;
const TEXT_RESULTS = 50;
const SNIPPETS = 30;

const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The query as words: at most MAX_TERMS of them, each of two characters or more. */
export function terms(q) {
  return [...new Set(String(q || '').toLowerCase().split(/\s+/)
    .map((w) => w.replace(/^["'“”‘’(]+|["'“”‘’),.;:!?]+$/g, ''))
    .filter((w) => w.length >= 2))].slice(0, MAX_TERMS);
}

/** How many of the words are in `text`, case aside, as a fraction. */
const share = (text, words) => {
  const t = String(text || '').toLowerCase();
  return words.length ? words.filter((w) => t.includes(w)).length / words.length : 0;
};

/**
 * A part of `body` of about SNIPPET characters, around the first word of the query in it
 * (from its start when none is): the markdown's links and markup as plain text.
 */
export function snippet(body, words = []) {
  const text = String(body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<([^>|]+)\|([^>]+)>/g, '$2')
    .replace(/\*\*|__|~~|`+/g, '')
    .replace(/^[ \t]*(?:>|#{1,6}|[-*•][ \t])[ \t]*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= SNIPPET) {
    return text;
  }
  const lower = text.toLowerCase();
  const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), Infinity);
  const start = Number.isFinite(at) ? Math.max(0, at - Math.floor(SNIPPET / 3)) : 0;
  const from = start ? text.indexOf(' ', start) + 1 || start : 0;
  let part = text.slice(from, from + SNIPPET);
  const more = from + part.length < text.length;
  if (more && part.lastIndexOf(' ') > SNIPPET / 2) {
    part = part.slice(0, part.lastIndexOf(' '));
  }
  return `${from ? '…' : ''}${part.trim()}${more ? '…' : ''}`;
}

/**
 * SQL: thread row `alias` is filed under one of the teams (`?1`, a JSON list), or in a channel
 * shared with one of them.
 */
const ofTeams = (alias) => `(${alias}.team IN (SELECT value FROM json_each(?1))
  OR (${alias}.source, ${alias}.channel_id) IN (SELECT source, channel_id FROM channel_teams
    WHERE team IN (SELECT value FROM json_each(?1))))`;

/** Filters for the vectors the teams see: their own, then the shared channels', in parts. */
export function vectorFilters(teams, channels) {
  const list = [].concat(teams);
  const out = [list.length === 1 ? { team: list[0] } : { team: { $in: list } }];
  let part = [];
  for (const c of channels) {
    if (part.length && JSON.stringify({ channel: { $in: [...part, c] } }).length > FILTER_BYTES) {
      out.push({ channel: { $in: part } });
      part = [];
    }
    part.push(c);
  }
  if (part.length) {
    out.push({ channel: { $in: part } });
  }
  return out;
}

/** The channels shared with `teams` and filed under another team, as channel keys. */
async function sharedChannels(env, teams) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT
      t.source || ':' || t.tenant || ':' || t.channel_id AS channel
    FROM threads t WHERE (t.source, t.channel_id) IN (SELECT source, channel_id
      FROM channel_teams WHERE team IN (SELECT value FROM json_each(?1)))
      AND t.team NOT IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(teams)).all();
  return (results || []).map((r) => r.channel);
}

/** Message and thread vectors similar to `q`: `[{ thread, score, message? }]`, best first. */
async function similar(env, teams, q, sharedP) {
  if (!env.CONTENT || !env.AI) {
    return [];
  }
  try {
    const [embedded, shared] = await Promise.all([
      env.AI.run(EMBEDDING_MODEL, { text: [`${QUERY_PREFIX}${q}`] }),
      sharedP,
    ]);
    const vector = embedded.data[0];
    const found = await Promise.all(vectorFilters(teams, shared)
      .map((filter) => env.CONTENT.query(vector, { topK: VECTOR_K, filter, returnMetadata: 'all' })));
    const matches = found.flatMap((f) => f.matches || [])
      .filter((m) => m.metadata && m.metadata.thread)
      .sort((a, b) => b.score - a.score);
    const best = matches.length ? matches[0].score : 0;
    return matches
      .filter((m) => m.score >= MIN_SIMILAR && m.score >= best - SIMILAR_WINDOW)
      .map((m) => ({
        thread: m.metadata.thread,
        score: m.score,
        message: m.metadata.type === 'message' ? m.metadata.message : null,
        channel: m.metadata.channel,
      }));
  } catch (e) {
    console.log(JSON.stringify({ route: 'search', error: `vector search failed: ${e.message}` }));
    return [];
  }
}

/** Of `refs` (`{ thread, id }`), those D1 has and are not deleted, as `<thread>|<id>`. */
async function liveMessages(env, refs) {
  if (!refs.length) {
    return new Set();
  }
  const { results } = await env.DB.prepare(`SELECT thread, id FROM messages
    WHERE thread IN (SELECT value FROM json_each(?1)) AND id IN (SELECT value FROM json_each(?2))
      AND deleted = 0`)
    .bind(
      JSON.stringify([...new Set(refs.map((r) => r.thread))]),
      JSON.stringify([...new Set(refs.map((r) => r.id))]),
    ).all();
  return new Set((results || []).map((r) => `${r.thread}|${r.id}`));
}

/**
 * Messages with every word of `q` (BM25, porter stemming: "purged" finds "purge"), the recent
 * boosted: `[{ thread, id, score, text }]`, best first, `score` relative to the best (1).
 */
async function inText(env, teams, q, sharedP) {
  if (!env.SEARCH) {
    return [];
  }
  try {
    const tags = await Promise.all((await sharedP).map(channelTag));
    const filters = [teams.length === 1 ? { team: teams[0] } : { team: { $in: teams } }];
    for (let i = 0; i < tags.length; i += TAGS_PER_QUERY) {
      filters.push({ channel: { $in: tags.slice(i, i + TAGS_PER_QUERY) } });
    }
    const found = await Promise.all(filters.map((f) => env.SEARCH.search({
      query: q,
      ai_search_options: {
        retrieval: {
          retrieval_type: 'keyword',
          keyword_match_mode: 'and',
          match_threshold: 0,
          max_num_results: TEXT_RESULTS,
          filters: f,
          boost_by: [{ field: 'at', direction: 'desc' }],
        },
      },
    })));
    const chunks = found.flatMap((r) => (r && r.chunks) || [])
      .map((c) => ({ message: c.item && c.item.metadata && c.item.metadata.message, ...c }))
      .filter((c) => typeof c.message === 'string' && c.message.includes('|'))
      .map((c) => {
        const at = c.message.lastIndexOf('|');
        return {
          thread: c.message.slice(0, at), id: c.message.slice(at + 1), score: c.score, text: String(c.text || ''),
        };
      });
    // Only messages D1 has and that are not deleted: an item outlives its message until the
    // next job takes it away (or, if that fails, the one after).
    const live = await liveMessages(env, chunks);
    const kept = chunks.filter((c) => live.has(`${c.thread}|${c.id}`))
      .sort((a, b) => b.score - a.score);
    const best = kept.length ? kept[0].score : 0;
    return kept.map((c) => ({ ...c, score: best > 0 ? c.score / best : 1 }));
  } catch (e) {
    console.log(JSON.stringify({ route: 'search', error: `full-text search failed: ${e.message}` }));
    return [];
  }
}

/** The teams' threads whose title, channel or customer has every word. */
async function titled(env, teams, words) {
  if (!words.length) {
    return [];
  }
  const hay = `(COALESCE(l.title, t.title, '') || ' ' || COALESCE(t.channel_name, '') || ' '
    || COALESCE(t.org, '') || ' ' || COALESCE(o.name, ''))`;
  const { results } = await env.DB.prepare(`SELECT t.thread, COALESCE(l.title, t.title, '') AS title,
      t.channel_name, t.org, o.name AS org_name
    FROM threads t LEFT JOIN labels l ON l.thread = t.thread LEFT JOIN orgs o ON o.slug = t.org
    WHERE ${ofTeams('t')} AND t.kind != 'ignore'
      ${words.map((w, i) => `AND ${hay} LIKE ?${i + 3} ESCAPE '\\'`).join(' ')}
    ORDER BY COALESCE(t.last_at, t.any_at) DESC LIMIT ?2`)
    .bind(JSON.stringify(teams), KEYWORD_ROWS, ...words.map(like)).all();
  return results || [];
}

/** The teams' threads with a fact (a URL, ticket, CVE, site, the problem…) with every word. */
async function withFacts(env, teams, words) {
  if (!words.length) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT f.thread, f.field, f.value
    FROM facts f JOIN threads t ON t.thread = f.thread
    WHERE ${ofTeams('t')} AND t.kind != 'ignore'
      ${words.map((w, i) => `AND f.value LIKE ?${i + 3} ESCAPE '\\'`).join(' ')}
    ORDER BY COALESCE(t.last_at, t.any_at) DESC LIMIT ?2`)
    .bind(JSON.stringify(teams), KEYWORD_ROWS, ...words.map(like)).all();
  return results || [];
}

/**
 * The message files of `refs` (`{ ref, path, id }`), from pile 2: `Map<ref, file>`, a deleted
 * message's as `{ deleted: true }`.
 */
async function messageFiles(env, refs) {
  const out = new Map();
  await Promise.all(refs.map(async ({ ref, path, id }) => {
    if (!path || !id || !env.CHANNELS) {
      return;
    }
    const obj = await env.CHANNELS.get(`${path}${segment(id)}.md`).catch(() => null);
    const file = obj && parse(await obj.text());
    if (file) {
      out.set(ref, file.meta.deletedAt ? { deleted: true } : file);
    }
  }));
  return out;
}

/** Where the message that matched best is in pile 2: the one with the words, else the vector's. */
function bestMessage(e) {
  if (e.said) {
    return {
      ref: `said:${e.said.thread}|${e.said.id}`, path: e.said.path, id: e.said.id, said: e.said,
    };
  }
  const m = e.message;
  if (!m || !m.channel || !m.message.startsWith(`${m.channel}:`)) {
    return null;
  }
  return { ref: m.message, path: m.path, id: m.message.slice(m.channel.length + 1) };
}

/**
 * The entries of the inboxes of `teams` (slugs) about `q`, best first, at most `limit` * 2 of
 * them (the viewer may not see them all; `inbox` with `groups` says which they do):
 * `{ q, words, hits }`, each hit `{ thread, score, title (the share of words in it), place,
 * fact, topic, text, message, said }`, `message` being the best matching message vector's
 * `{ thread, message, channel, path }`, `said` the best message with the words
 * `{ thread, id, path, text }`.
 */
export async function find(env, teams, q, { limit = DEFAULT_RESULTS } = {}) {
  const query = String(q || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
  const words = terms(query);
  const n = Math.max(1, Math.min(MAX_RESULTS, Number(limit) || DEFAULT_RESULTS));
  const none = { q: query, words, hits: [] };
  if (!words.length) {
    return none;
  }
  const list = [].concat(teams);
  const sharedP = sharedChannels(env, list);
  sharedP.catch(() => {});
  const [vectors, saidIn, byTitle, byFact] = await Promise.all([
    similar(env, list, query, sharedP),
    inText(env, list, query, sharedP),
    titled(env, list, words),
    withFacts(env, list, words),
  ]);
  // Every thread found, with its group (a re-threaded group is one entry) and its folder.
  const keys = [...new Set([...vectors, ...saidIn, ...byTitle, ...byFact].map((x) => x.thread))];
  if (!keys.length) {
    return none;
  }
  const { results: rows } = await env.DB.prepare(`SELECT thread,
      COALESCE(logical_thread, thread) AS g, path FROM threads
    WHERE thread IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(keys)).all();
  const groupOf = new Map((rows || []).map((r) => [r.thread, r.g]));
  const paths = new Map((rows || []).map((r) => [r.thread, r.path]));
  const found = new Map();
  const entry = (thread) => {
    const g = groupOf.get(thread);
    if (!g) {
      return null;
    }
    if (!found.has(g)) {
      found.set(g, {
        thread: g, topic: 0, title: 0, text: 0, fact: null, message: null, said: null, words: false,
      });
    }
    return found.get(g);
  };
  for (const v of vectors) {
    const e = entry(v.thread);
    if (e) {
      e.topic = Math.max(e.topic, v.score);
      if (v.message && !e.message) {
        e.message = { ...v, path: paths.get(v.thread) };
      }
    }
  }
  for (const t of saidIn) {
    const e = entry(t.thread);
    if (e) {
      e.text = Math.max(e.text, t.score);
      if (!e.said) {
        e.said = { ...t, path: paths.get(t.thread) };
      }
    }
  }
  for (const r of byTitle) {
    const e = entry(r.thread);
    if (e) {
      // Every word is in the title, the channel or the customer: the more in the title, the better.
      e.words = true;
      e.title = Math.max(e.title, share(r.title, words));
    }
  }
  for (const r of byFact) {
    const e = entry(r.thread);
    if (e && !e.fact) {
      e.fact = { field: r.field, value: r.value };
    }
  }
  const hits = [...found.values()].map((e) => ({
    ...e,
    place: e.words && e.title < 1,
    score: e.topic + (e.words ? TITLE_BONUS * e.title + PLACE_BONUS * (1 - e.title) : 0)
      + (e.fact ? FACT_BONUS : 0) + TEXT_BONUS * e.text,
  })).sort((a, b) => b.score - a.score).slice(0, n * 2);
  return { q: query, words, hits };
}

/**
 * Hits as the API sends them: `{ thread, score, matched, fact?, snippet? }`, `matched` saying
 * why (`title`, `place`: the channel or the customer, `fact`, `text`: the words of one of its
 * messages, `topic`), and the snippet
 * `{ message, author, at, text }` of the message that matched best, read from pile 2 (for the
 * first SNIPPETS hits).
 */
export async function withSnippets(env, hits, words) {
  const refs = hits.slice(0, SNIPPETS).map(bestMessage).filter(Boolean);
  const files = await messageFiles(env, refs);
  const refOf = new Map(hits.map((e) => [e.thread, bestMessage(e)]));
  return hits.map((e) => {
    const ref = refOf.get(e.thread);
    const read = ref && files.get(ref.ref);
    const file = read && !read.deleted ? read : null;
    const matched = [e.title > 0 && 'title', e.place && 'place', e.fact && 'fact',
      e.text > 0 && 'text', e.topic > 0 && 'topic'].filter(Boolean);
    // A message with the words that pile 2 cannot show (yet): the item's own text.
    const said = !read && ref && ref.said && ref.said.text ? {
      snippet: {
        message: `${ref.said.thread}|${ref.said.id}`, author: null, at: null, text: snippet(ref.said.text, words),
      },
    } : {};
    return {
      thread: e.thread,
      score: Math.round(e.score * 1000) / 1000,
      matched,
      ...(e.fact ? { fact: e.fact } : {}),
      ...(file ? {
        snippet: {
          message: `${file.meta.thread}|${file.meta.id}`,
          author: (file.meta.author && file.meta.author.name) || null,
          at: file.meta.at || null,
          text: snippet(file.body, words),
        },
      } : said),
    };
  });
}
