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
import { sweepDelay, sweepsNow } from './deadjobs.js';
import { CLEF } from './label.js';
import { QUOTE_HEAD, quotesAsText } from './markdown.js';
import { notifyRoom } from './notify.js';
import { sha256 } from './raw.js';
import { teamsOf } from './shares.js';

/**
 * Re-threading. When a root message arrives, the most similar earlier roots in the same
 * channel are found by vector search (Workers AI embeddings in Vectorize). In alert channels, a
 * near-identical one is a match outright; otherwise Clef chooses between the candidates and "a
 * new topic". In conversations, Clef reads the channel's latest conversations and the similar
 * ones as a transcript and says which one the new root continues, if any.
 * A match sets `logicalThread` on the new thread, pointing at the earliest thread of the
 * group, so repeated alerts and follow-ups fold into one inbox entry. A root that quotes a
 * message (Slack: forwarded, or a link to it) was started on purpose, and stays on its own.
 * So does a conversation's root that people answer in its own platform thread: one that has
 * replies when it is decided is not folded, and one that gets them after it was folded is split
 * back out (`dethread`), for good, unless the inbox replied for the group in its platform thread
 * (`routed_at`): then it stays in the group for good. A root that announces a thread (🧵,
 * `:thread:`) stays on its own, too.
 *
 * People continue a chat with more top-level messages where the chat is top-level messages.
 * Where its people reply in platform threads, a new top-level message is nearly always a topic
 * of its own, however close it reads: so Clef must be all but certain to fold a root into a
 * conversation with thread replies, or into any in a channel whose roots mostly get them
 * (MIN_CLEF_THREADED, HABIT_THREADED), and a root is no burst of one that has been answered
 * already.
 */

/** How long after a root arrives it is re-threaded (its agent waits for that). */
export const RETHREAD_DELAY_SECONDS = 30;
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
export const TOP_K = 6;
export const WINDOW_DAYS = 14;
/** At or above this similarity, two alerts are the same without asking Clef. */
export const AUTO_MATCH = 0.97;
/** Below this similarity, a candidate is not worth asking about. */
export const MIN_CANDIDATE = 0.82;
/** In conversations, follow-ups are worded differently: ask Clef about weaker matches. */
export const MIN_CANDIDATE_CONVERSATION = 0.6;
/**
 * A second root by the same person this soon after their first continues it. Later than that,
 * people as often move on to something else ("the fix is deployed" after "see you on the call"),
 * which Clef tells apart.
 */
export const BURST_MS = 3 * 60 * 1000;
/**
 * In conversations, the channel's latest conversations active this recently are always
 * candidates, however differently they are worded: answers, thanks, nudges and escalations
 * posted as new messages ("this is a blocker, please help", "done, you have access") share few
 * words with what they follow up, and people answer hours later, or after a weekend.
 */
export const RECENT_MS = 3 * 86400 * 1000;
/** How many of the latest conversations, and how many conversations at most, Clef reads. */
export const RECENT_CONVERSATIONS = 3;
export const MAX_CONVERSATIONS = 5;
/** Of each conversation, Clef reads its first message and its latest ones. */
const LATEST_MESSAGES = 2;
const TRANSCRIPT_TEXT = 300;
const LABELS = 'ABCDEFGHIJ';
/** Clef must be at least this sure that the new root continues a candidate. */
export const MIN_CLEF = 0.7;
/** In conversations, where it reads the transcript and is sure of the right answers. */
export const MIN_CLEF_CONVERSATION = 0.8;
/**
 * For a conversation with replies in its platform threads. Folded into one at Clef's usual
 * certainty, new roots got replies of their own as often as the channel's new topics do: they
 * were new topics. Folded into a conversation without any, half as often, as follow-ups do.
 */
export const MIN_CLEF_THREADED = 0.99;
/**
 * A channel whose people reply in platform threads: of its roots in the last 30 days, at least
 * five, half or more got a person's reply in their own. There, a conversation without replies
 * yet (its question still waiting for one) is held in threads all the same: a new root is a new
 * question, however close it reads, and needs MIN_CLEF_THREADED too. Of the conversation roots
 * Clef had folded in such channels below that, more than half got replies of their own, twice
 * as often as the other folds.
 */
export const HABIT_MS = 30 * 86400 * 1000;
export const HABIT_MIN_ROOTS = 5;
export const HABIT_THREADED = 0.5;
const MAX_TEXT = 1500;
const SNIPPET = 600;

/**
 * The root's text with the parts that differ between repeats of the same event removed:
 * fields that only hold a link, short codes, timestamps, long numbers, hex and UUID ids,
 * query strings and user agents. Short numbers (status codes, ports) stay, because they
 * tell different failures apart.
 */
export function skeleton(text) {
  return quotesAsText(text)
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

export const CONVERSATION_INSTRUCTIONS = 'The new message was posted in a chat channel as a '
  + 'message of its own instead of a reply. Does it continue one of the earlier conversations, or '
  + 'start a new topic? It continues a conversation when it answers, explains, acknowledges, '
  + 'thanks or reacts to its messages, repeats the same issue or alert, or follows it up: adds '
  + 'details, asks again, escalates, or presses for an answer, even without naming the issue '
  + 'again. A reply that names no issue of its own continues the conversation that was active '
  + 'last. It is a new topic when it raises a question or issue that none of the conversations is '
  + 'about, or says that it changes the subject ("in other news", "another question").';

const groupOf = (t) => t.logical_thread || t.thread;
/**
 * Whether a root quotes a message (src/markdown.js quoteMarkdown). Forwarding a message into the
 * channel, or linking to one, starts a topic on purpose: people who meant to continue the earlier
 * conversation would have replied there, and the text after a quote ("first step in that
 * direction") reads like a follow-up of whatever was said last.
 */
export const quotes = (body) => String(body || '').split('\n').some((l) => QUOTE_HEAD.test(l));
/**
 * Whether a root announces a thread (🧵, `:thread:`, often in its first line): its author wants the
 * replies there, so it is a topic of its own, as nearly all of them are answered in theirs.
 */
export const announcesThread = (body) => /🧵|:thread:/u.test(String(body || ''));
/** Platform notices ("… has joined the channel"): no conversation's part, nor a topic. */
const isSystem = (parsed) => Boolean(parsed.meta.author && parsed.meta.author.kind === 'system');
/**
 * `logical_via` of a root that was split out of its group (`dethread`): it is decided, and not
 * folded again, not even by a forced re-threading or a burst before it.
 */
export const SPLIT = 'split';

/**
 * Whether a root has replies of its own: a person posted in its platform thread. People who
 * answer there, and not in the conversation it was folded into, hold a conversation of its own,
 * and the inbox's replies go to the platform thread its entry was last active in
 * (src/post.js `target`), which must be this one then.
 */
async function answered(env, thread, before = null) {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM messages
    WHERE thread = ? AND id != ? AND counted = 1 AND deleted = 0 AND (?3 IS NULL OR at < ?3) LIMIT 1`)
    .bind(thread.thread, thread.root_id, before).first());
}

/**
 * The conversations a new root in a conversation channel may continue: the channel's latest
 * ones (by their messages before the root) and the groups of the similar earlier roots, each
 * with its first message and its latest ones before the root, oldest first.
 */
async function conversations(env, thread, similar) {
  const { results: recent } = await env.DB.prepare(`SELECT COALESCE(t.logical_thread, t.thread) AS grp,
      MAX(m.at) AS latest FROM messages m JOIN threads t ON t.thread = m.thread
    WHERE m.source = ? AND m.tenant = ? AND m.channel_id = ? AND m.at < ? AND m.at >= ?
      AND m.author_key IS NOT NULL AND m.deleted = 0 AND t.thread != ?
    GROUP BY grp ORDER BY latest DESC LIMIT ?`)
    .bind(
      thread.source,
      thread.tenant,
      thread.channel_id,
      thread.root_at,
      new Date(Date.parse(thread.root_at) - RECENT_MS).toISOString(),
      thread.thread,
      RECENT_CONVERSATIONS + 1,
    ).all();
  const groups = (recent || []).map((r) => r.grp).filter((g) => g !== thread.thread)
    .slice(0, RECENT_CONVERSATIONS);
  for (const m of similar) {
    // eslint-disable-next-line no-await-in-loop
    const row = await env.DB.prepare('SELECT thread, logical_thread FROM threads WHERE thread = ?')
      .bind(m.metadata.thread).first();
    const g = row && groupOf(row);
    if (g && g !== thread.thread && !groups.includes(g)) {
      groups.push(g);
    }
  }
  const out = [];
  for (const g of groups.slice(0, MAX_CONVERSATIONS)) {
    // eslint-disable-next-line no-await-in-loop
    const anchor = await env.DB.prepare('SELECT * FROM threads WHERE thread = ?').bind(g).first();
    // eslint-disable-next-line no-await-in-loop
    const { results: latest } = await env.DB.prepare(`SELECT m.id, m.at, t.path FROM messages m
        JOIN threads t ON t.thread = m.thread
      WHERE (t.thread = ? OR t.logical_thread = ?) AND t.thread != ? AND m.at < ? AND m.deleted = 0
        AND m.author_key IS NOT NULL
      ORDER BY m.at DESC LIMIT ?`).bind(g, g, thread.thread, thread.root_at, LATEST_MESSAGES).all();
    const picked = [...(latest || [])].reverse();
    if (anchor && anchor.root_at && anchor.root_at < thread.root_at
      && !picked.some((m) => m.id === anchor.root_id)) {
      picked.unshift({ id: anchor.root_id, at: anchor.root_at, path: anchor.path });
    }
    const messages = [];
    for (const m of picked) {
      // eslint-disable-next-line no-await-in-loop
      const obj = await env.CHANNELS.get(`${m.path}${m.id}.md`);
      // eslint-disable-next-line no-await-in-loop
      const parsed = obj ? parse(await obj.text()) : null;
      const text = parsed && !parsed.meta.deletedAt && !isSystem(parsed) && skeleton(parsed.body);
      if (text) {
        messages.push({ at: m.at, text: text.slice(0, TRANSCRIPT_TEXT) });
      }
    }
    if (messages.length) {
      // Replies in the conversation's platform threads (by people, before the new root).
      // eslint-disable-next-line no-await-in-loop
      const replied = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages m
          JOIN threads t ON t.thread = m.thread
        WHERE (t.thread = ? OR t.logical_thread = ?) AND t.thread != ? AND m.id != t.root_id
          AND m.at < ? AND m.deleted = 0 AND m.counted = 1`)
        .bind(g, g, thread.thread, thread.root_at).first();
      out.push({
        thread: g, group: g, messages, replies: (replied && replied.n) || 0,
      });
    }
  }
  return out;
}

/**
 * Whether the channel of `thread` replies in platform threads (HABIT_THREADED), from its roots by
 * people before `thread`'s, and their replies before it.
 */
async function repliesInThreads(env, thread) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS roots, COALESCE(SUM(EXISTS (SELECT 1 FROM messages x
      WHERE x.thread = t.thread AND x.id != t.root_id AND x.counted = 1 AND x.deleted = 0
        AND x.at < ?4)), 0) AS replied
    FROM threads t JOIN messages m ON m.thread = t.thread AND m.id = t.root_id AND m.counted = 1
      AND m.deleted = 0
    WHERE t.source = ?1 AND t.tenant = ?2 AND t.channel_id = ?3 AND t.kind = 'channel'
      AND t.root_at < ?4 AND t.root_at >= ?5 AND t.thread != ?6`)
    .bind(
      thread.source,
      thread.tenant,
      thread.channel_id,
      thread.root_at,
      new Date(Date.parse(thread.root_at) - HABIT_MS).toISOString(),
      thread.thread,
    ).first();
  return Boolean(row && row.roots >= HABIT_MIN_ROOTS && row.replied >= row.roots * HABIT_THREADED);
}

/**
 * Clef, in conversations: which of the conversations does the new root continue, if any? It
 * reads them as the channel's transcript (each message marked with its conversation and how
 * long before it was posted), which tells answers and thanks apart from new topics far better
 * than comparing the new root with each conversation on its own. In a channel that replies in
 * threads (`inThreads`), every conversation counts as held in threads.
 */
export async function askClefConversation(env, text, at, convs, { inThreads = false } = {}) {
  const lines = [];
  convs.forEach((c, i) => c.messages.forEach((m) => lines.push({
    at: m.at, line: `[${LABELS[i]}, ${ago(at - Date.parse(m.at))} before] ${m.text}`,
  })));
  lines.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const state = `Earlier messages in the channel, by conversation:\n${lines.map((l) => l.line).join('\n')}`
    + `\n\nNew message: ${text}`;
  const criteria = { new: 'A new topic' };
  convs.forEach((c, i) => {
    criteria[`c${i}`] = `Continues conversation ${LABELS[i]} (${c.messages[0].text.slice(0, 80)})`;
  });
  const res = await env.AI.run(CLEF, {
    model: 'clef',
    state,
    questions: {
      continues: { type: 'choice', instructions: CONVERSATION_INSTRUCTIONS, criteria },
    },
  });
  const a = res.answers && res.answers.continues;
  if (!a || !a.choice) {
    return { p: 0 };
  }
  const probabilities = a.probabilities || { [a.choice]: a.confidence ?? 0 };
  let best = null;
  convs.forEach((c, i) => {
    const p = probabilities[`c${i}`] || 0;
    if (!best || p > best.p) {
      best = { candidate: c, p };
    }
  });
  if (!best) {
    return { p: 0 };
  }
  // A conversation held in platform threads, or any in a channel that replies in threads, needs
  // Clef all but certain (MIN_CLEF_THREADED).
  const threaded = Boolean(best.candidate.replies) || inThreads;
  if (best.p >= (threaded ? MIN_CLEF_THREADED : MIN_CLEF_CONVERSATION)) {
    return best;
  }
  return { p: best.p, ...(threaded ? { threaded } : {}) };
}

// Longer than a job's retries take.
const SWEEP_AFTER_MS = 60 * 60 * 1000;
const SWEEP_LIMIT = 100;

/**
 * Re-threads one thread by its root. Idempotent: a thread that was decided once is not
 * decided again (pass `force` to redo it). `rethreaded_at` says it was decided, and is written
 * last, so a job that fails half way is repeated by its retry, not cut short by this guard.
 */
export async function rethread(env, key, { force = false } = {}) {
  const thread = await env.DB.prepare('SELECT * FROM threads WHERE thread = ?').bind(key).first();
  if (!thread || !thread.root_at) {
    return { result: 'skip', reason: 'no root' };
  }
  if (thread.logical_via === SPLIT) {
    return { result: 'unchanged', logical: null, reason: 'split' };
  }
  // The inbox replied for its group in its platform thread: that is where the group goes on.
  if (thread.routed_at && thread.logical_thread) {
    return { result: 'unchanged', logical: thread.logical_thread, reason: 'routed' };
  }
  if (thread.rethreaded_at && !force) {
    return { result: 'unchanged', logical: thread.logical_thread };
  }
  // A skip is final: asking again finds the same. A hash means that an earlier job got further and
  // died, and the sweep sends a root out for as long as it has one without a decision.
  const skip = async (reason) => {
    if (thread.skeleton_hash && !thread.rethreaded_at) {
      await env.DB.prepare('UPDATE threads SET rethreaded_at = ? WHERE thread = ?')
        .bind(new Date().toISOString(), key).run();
    }
    return { result: 'skip', reason };
  };
  const root = await rootBody(env, thread);
  if (!root || root.parsed.meta.deletedAt) {
    return skip('root missing or deleted');
  }
  if (thread.kind === 'channel' && isSystem(root.parsed)) {
    return skip('system message');
  }
  const text = skeleton(root.parsed.body || thread.title);
  if (!text) {
    return skip('empty');
  }

  const at = Math.floor(Date.parse(thread.root_at) / 1000);
  const hash = (await sha256(text)).slice(0, 32);
  await env.DB.prepare('UPDATE threads SET skeleton_hash = ? WHERE thread = ?').bind(hash, key).run();

  // An exact repeat: the earliest thread in the channel and window with the same skeleton.
  // Only alerts: in conversations, the same words ("thanks!") are often a different talk.
  const conversation = thread.kind === 'channel';
  const twin = !conversation && await env.DB.prepare(`SELECT thread, logical_thread FROM threads
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
  // Only people in conversations: a bot posts many different alerts within minutes. Not a root
  // that is deleted: people delete a message and post it again, and the new one is the thread.
  const rootAuthor = conversation && await env.DB.prepare(`SELECT author_key
    FROM messages WHERE thread = ? AND id = ? AND counted = 1`).bind(key, thread.root_id).first();
  const author = rootAuthor && rootAuthor.author_key;
  const previous = author && await env.DB.prepare(`SELECT t.*, m.author_key FROM threads t
    JOIN messages m ON m.thread = t.thread AND m.id = t.root_id AND m.counted = 1 AND m.deleted = 0
    WHERE t.source = ? AND t.tenant = ? AND t.channel_id = ? AND t.thread != ?
      AND t.root_at < ? AND t.root_at >= ? ORDER BY t.root_at DESC LIMIT 1`)
    .bind(
      thread.source,
      thread.tenant,
      thread.channel_id,
      key,
      thread.root_at,
      new Date(Date.parse(thread.root_at) - BURST_MS).toISOString(),
    ).first();
  // Not once someone answered it in its thread: the next root is no piece of it then, but a
  // message of its own (the next of several questions, each in its thread).
  const burst = previous && previous.author_key === author
    && !await answered(env, previous, thread.root_at) ? previous : null;

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
  const quoting = quotes(root.parsed.body);
  const announcing = conversation && !quoting && announcesThread(root.parsed.body);
  // A burst is one request in pieces, wherever it is answered; anything else that people answer
  // in its own platform thread is a conversation of its own.
  const replied = conversation && !quoting && !announcing && !burst && await answered(env, thread);
  if (quoting || announcing || replied) {
    // On its own: see quotes(), announcesThread() and answered().
  } else if (burst) {
    match = { thread: burst.thread, via: 'burst', p: 1 };
  } else if (conversation) {
    // The channel's latest conversations and the similar ones, read as a transcript.
    const convs = await conversations(env, thread, earlier.slice(0, 4));
    asked = convs.length ? await askClefConversation(env, text, Date.parse(thread.root_at), convs, {
      inThreads: await repliesInThreads(env, thread),
    }) : null;
    if (asked && asked.candidate) {
      match = { thread: asked.candidate.thread, via: 'clef', p: asked.p };
    }
  } else if (twin) {
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
  await env.DB.prepare(`UPDATE threads SET logical_thread = ?, logical_via = ?, logical_p = ?
    WHERE thread = ?`)
    .bind(logical, match ? match.via : null, match ? match.p : null, key)
    .run();
  await markRootFile(env, thread, logical);

  // Replays arrive in any order: near-identical later alerts that found nothing earlier
  // (because this one was not indexed yet) join this group now, and so do the threads that
  // had joined them. Every member always points at the group's first thread.
  const group = logical || key;
  const joined = [key];
  for (const m of conversation ? [] : found.matches || []) {
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
  const { results: laterTwins } = conversation ? { results: [] } : await env.DB.prepare(`SELECT t.thread, t.logical_thread,
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
  const next = author && await env.DB.prepare(`SELECT t.*, m.author_key
    FROM threads t JOIN messages m ON m.thread = t.thread AND m.id = t.root_id AND m.deleted = 0
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
  const nextFree = next && next.logical_via !== SPLIT
    && (!next.logical_thread || joined.includes(next.logical_thread));
  const nextBurst = nextFree && next.author_key === author
    && !await answered(env, thread, next.root_at);
  const nextRoot = nextBurst && await rootBody(env, next);
  const nextBody = nextRoot && nextRoot.parsed.body;
  const nextOwn = nextRoot && (quotes(nextBody) || announcesThread(nextBody));
  if (nextBurst && !nextOwn) {
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
  // Decided only now that all of it is done: a retry starts from the top until then, and decides
  // again what it wrote so far.
  await env.DB.prepare('UPDATE threads SET rethreaded_at = ? WHERE thread = ?')
    .bind(new Date().toISOString(), key).run();
  return {
    result: logical ? 'rethreaded' : 'new-topic',
    via: match ? match.via : null,
    p: match ? match.p : null,
    ...(quoting ? { reason: 'quotes a message' } : {}),
    ...(announcing ? { reason: 'starts a thread' } : {}),
    ...(replied ? { reason: 'has replies of its own' } : {}),
    // What Clef thought of the best candidate when it said no (for tuning MIN_CLEF), and whether
    // that one was held in threads (MIN_CLEF_THREADED).
    ...(!match && asked ? { clef: Math.round(asked.p * 100) / 100 } : {}),
    ...(!match && asked && asked.threaded ? { threaded: true } : {}),
  };
}

/**
 * De-threading: a conversation's root that was folded into an earlier conversation, and then
 * gets replies in its own platform thread, is split back out into an inbox entry of its own
 * (see answered()). Called for every reply a person posts; only a folded root changes, once:
 * `logical_via` becomes SPLIT, which re-threading leaves alone. The roots that followed it in a
 * burst go with it. A burst member itself, and alerts, stay in their group: a burst is one
 * request in pieces, and someone answering one of a series of alerts answers all of them. So does
 * a root the inbox sent a reply of its group to (`routed_at`, src/post.js routeReply): the group's
 * conversation goes on in its platform thread, and those who answer there answer the group.
 * `rethreaded_at` moves to now, so the export sweep writes the threads again.
 */
export async function dethread(env, key) {
  const thread = await env.DB.prepare('SELECT * FROM threads WHERE thread = ?').bind(key).first();
  if (!thread || thread.kind !== 'channel' || !thread.logical_thread || thread.logical_via === 'burst'
    || thread.routed_at || !thread.root_id || !await answered(env, thread)) {
    return { result: 'unchanged' };
  }
  const group = thread.logical_thread;
  const now = new Date().toISOString();
  // Only from the group it is in now: a job that decided otherwise meanwhile wins.
  const { meta } = await env.DB.prepare(`UPDATE threads SET logical_thread = NULL, logical_via = ?,
      logical_p = NULL, rethreaded_at = ? WHERE thread = ? AND logical_thread = ?`)
    .bind(SPLIT, now, key, group).run();
  if (!meta || !meta.changes) {
    return { result: 'unchanged' };
  }
  await markRootFile(env, thread, null);
  // The roots its author posted right after it, each within minutes of the one before, with
  // nobody else's root between them: the burst re-threading folded into the group with it.
  const author = await env.DB.prepare(`SELECT author_key FROM messages
    WHERE thread = ? AND id = ? AND counted = 1`).bind(key, thread.root_id).first();
  const split = [key];
  let last = thread;
  while (author && author.author_key) {
    // eslint-disable-next-line no-await-in-loop
    const next = await env.DB.prepare(`SELECT t.*, m.author_key FROM threads t
      JOIN messages m ON m.thread = t.thread AND m.id = t.root_id
      WHERE t.source = ? AND t.tenant = ? AND t.channel_id = ? AND t.thread != ?
        AND t.root_at > ? AND t.root_at <= ? ORDER BY t.root_at LIMIT 1`)
      .bind(
        thread.source,
        thread.tenant,
        thread.channel_id,
        last.thread,
        last.root_at,
        new Date(Date.parse(last.root_at) + BURST_MS).toISOString(),
      ).first();
    if (!next || next.author_key !== author.author_key || next.logical_thread !== group
      || next.logical_via !== 'burst' || next.routed_at) {
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare('UPDATE threads SET logical_thread = ?, rethreaded_at = ? WHERE thread = ?')
      .bind(key, now, next.thread).run();
    // eslint-disable-next-line no-await-in-loop
    await markRootFile(env, next, key);
    split.push(next.thread);
    last = next;
  }
  // Open inboxes reload the group, which has these no more, and list them on their own.
  const rooms = env.ROOMS ? await teamsOf(env, thread) : [];
  await notifyRoom(env, rooms, { type: 'thread', thread: group, split });
  return { result: 'split', group, split };
}

/**
 * Cron: the roots whose job died (their hash is written before the work that can fail, and
 * `rethreaded_at` after it) go out again, within the window re-threading looks back. A root that
 * was skipped on purpose (a system notice, an empty one) has no hash, or, when a job had died on
 * it before, a decision.
 */
export async function sweepRethreads(env, now = new Date()) {
  if (!env.VECTORS || !env.AI || !env.NORMALIZE) {
    return { skipped: 'no VECTORS index' };
  }
  if (!sweepsNow(now)) {
    return { skipped: 'not this run' };
  }
  // Not a root that is deleted or a notice by now, which the job skips, and not one that died
  // within the day: a root that always fails goes out once a day, not with every cron run.
  const { results } = await env.DB.prepare(`SELECT t.thread FROM threads t
    JOIN messages m ON m.thread = t.thread AND m.id = t.root_id
    WHERE t.skeleton_hash IS NOT NULL AND t.rethreaded_at IS NULL AND t.root_at >= ? AND t.root_at < ?
      AND m.deleted = 0 AND COALESCE(m.author_kind, '') != 'system'
      AND NOT EXISTS (SELECT 1 FROM dead_jobs d WHERE d.job = 'rethread:' || t.thread AND d.at > ?)
    ORDER BY t.root_at LIMIT ?`)
    .bind(
      new Date(now.getTime() - WINDOW_DAYS * 86400 * 1000).toISOString(),
      new Date(now.getTime() - SWEEP_AFTER_MS).toISOString(),
      new Date(now.getTime() - 86400 * 1000).toISOString(),
      SWEEP_LIMIT,
    ).all();
  for (const [i, { thread }] of (results || []).entries()) {
    // eslint-disable-next-line no-await-in-loop
    await env.NORMALIZE.send({ rethread: thread }, sweepDelay(i));
  }
  return { queued: (results || []).length };
}
