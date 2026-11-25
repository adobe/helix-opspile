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

import { MAX_ANSWER, MAX_SIDEBAR, sidebarId } from './sidebar.js';

/**
 * The knowledge base's sidebar: on a team's or a customer's page (ui/kbchat.js), whoever may look
 * at its knowledge base (src/kbaccess.js `mayRead`) talks to its knowledge-base agent, which looks
 * things up in the knowledge bases and in every thread of the inbox, and for who may write it
 * (`mayWrite`: the people on its team) changes that knowledge base, and only that one, and runs
 * commands on its computer. A team's is the agent `kb:<team>:`, a customer's `kb::<org>`: no
 * thread, and no other team's or customer's knowledge base to write.
 *
 * Each conversation (`chat`, `kc_<uuid>`) is one person's, a session of the agent of its own
 * pinned to the knowledge base (src/agent/kbchat.js), and they start another when they like.
 * A message goes into that session as an input of its own that starts as a thread's sidebar
 * message does (`Sidebar message sb_… from`, src/sidebar.js), so the agent's turns on it are
 * read as those are (src/agent/turn.js `sidebarTurns`), and into D1 (`kb_chat_messages`,
 * migration 0104), which the page shows; the agent's answer when its turn ends. No SDK import
 * here.
 */

export const MAX_CHAT = MAX_SIDEBAR;
/** The earlier conversations the page lists, newest first. */
export const MAX_CHATS = 20;

export { sidebarId as chatMessageId };

/** A new conversation's id. */
export const chatId = () => `kc_${crypto.randomUUID()}`;

const CHAT_ID = /^kc_[0-9a-f-]{36}$/;
/** Whether `id` is a conversation's id. */
export const isChatId = (id) => CHAT_ID.test(String(id || ''));

/**
 * The knowledge-base agent a knowledge base's sidebar talks to, by its `knowledge_bases` row
 * (`{ kind, slug }`): a team's `kb:<team>:`, a customer's `kb::<org>`.
 */
export function chatAgentName(base) {
  if (!base || !base.slug) {
    return null;
  }
  return base.kind === 'team' ? `kb:${base.slug}:` : `kb::${base.slug}`;
}

const PLACE = {
  team: 'the ops team\'s knowledge base, kb-team',
  org: 'the customer\'s knowledge base, kb-org',
};

/** Who `by` is to the knowledge base: whether they may have it changed (`write`). */
const standing = (by, kb, repo, write) => (write
  ? `${by} is on its team: they may change ${PLACE[kb] || repo}, and have commands run on your computer.`
  : `${by} is not on its team: they may read ${PLACE[kb] || repo} and ask about it, but not have it changed, nor commands run, so kb_write, draw_stack, bash, request_bash and the extraction rules' and tech stack's changes are refused in their turns. Answer what they ask, and say what you would change, for someone on the team.`);

/**
 * What the agent is told. The first line names the message as a thread's sidebar message does
 * (src/sidebar.js `sidebarOf`), so its turn is read as one; `kb` (`team`, `org`) is the
 * knowledge base the conversation is about, `repo` its name, and `write` whether its person may
 * have it changed.
 */
export function chatNote({
  id, by, text, kb, repo, write = false,
}) {
  return `Sidebar message ${id} from ${by} (Adobe staff), on the page of ${repo} in the inbox.\n\n`
    + `${by} talks to you on the page of ${PLACE[kb] || repo}: a conversation of their own about`
    + ' that knowledge base: only they see it, and nothing of it is posted anywhere. It is trusted.'
    + ` ${standing(by, kb, repo, write)}`
    + ' Do what they ask in this turn (look things up, write, fix, merge, move), then'
    + ` answer ${by} directly, in Markdown, at the end of the turn, as long as the answer needs:`
    + ' say what you found and what you changed, by path.'
    + `\n\n<sidebar-message>\n${text}\n</sidebar-message>`;
}

/**
 * What the agent is told of something that happened in conversation `chat` since its last turn
 * (a command it asked for ran, or was denied, or expired), as a sidebar message `id` of the
 * conversation's person, `by`, so its answer is kept as any other: `what`, as its tool would say
 * it in a thread.
 */
export function chatEventNote({ id, by, what }) {
  return `Sidebar message ${id} from ${by} (Adobe staff), on the knowledge base's page: what came`
    + ' of a command you asked for in this conversation. Tell them, at the end of this turn, what'
    + ' it showed and what you did with it.'
    + `\n\n<sidebar-message>\n${what}\n</sidebar-message>`;
}

/** The line the conversation shows for what `chatEventNote` tells the agent. */
export function chatEventLine(request, outcome) {
  const which = `the command (request ${request.id})`;
  if (outcome.status === 'denied') {
    return `Denied ${which}.`;
  }
  if (outcome.status === 'expired') {
    return `Nobody ran ${which} before its deadline.`;
  }
  if (outcome.status === 'failed') {
    return `Ran ${which}; it did not run to its end.`;
  }
  if (outcome.status === 'timeout') {
    return `Ran ${which}; it was stopped at its timeout.`;
  }
  return `Ran ${which}; it exited with code ${outcome.exitCode ?? '?'}.`;
}

const shape = (r) => ({
  id: r.id,
  role: r.role,
  body: r.body,
  state: r.state,
  reply_to: r.reply_to || null,
  at: r.at,
});

/** The conversation of `person` in the sidebar of `repo` that they talked in last, or null. */
export async function latestChat(env, repo, person) {
  if (!env.DB || !repo || !person) {
    return null;
  }
  const row = await env.DB.prepare(`SELECT chat FROM kb_chat_messages
    WHERE repo = ? AND person = ? ORDER BY at DESC LIMIT 1`).bind(repo, person).first();
  return row ? row.chat : null;
}

/** Whether `chat` is a conversation of `person` in the sidebar of `repo`. */
export async function isChatOf(env, repo, person, chat) {
  if (!env.DB || !isChatId(chat)) {
    return false;
  }
  const row = await env.DB.prepare(`SELECT 1 AS yes FROM kb_chat_messages
    WHERE chat = ? AND repo = ? AND person = ? LIMIT 1`).bind(chat, repo, person).first();
  return Boolean(row);
}

/** The messages of conversation `chat` of `person` in `repo`, oldest first. */
export async function chatMessages(env, repo, person, chat) {
  if (!env.DB || !chat) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT * FROM kb_chat_messages
    WHERE chat = ? AND repo = ? AND person = ? ORDER BY at, role DESC`)
    .bind(chat, repo, person).all();
  return (results || []).map(shape);
}

/**
 * The conversations of `person` in the sidebar of `repo`, the latest first: `[{ chat, at,
 * first, messages }]`, `at` its latest message's time and `first` what they asked first.
 */
export async function chatsOf(env, repo, person, limit = MAX_CHATS) {
  if (!env.DB || !repo || !person) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT c.chat, MAX(c.at) AS at, COUNT(*) AS messages,
      (SELECT f.body FROM kb_chat_messages f WHERE f.chat = c.chat AND f.role = 'person'
        ORDER BY f.at LIMIT 1) AS first
    FROM kb_chat_messages c WHERE c.repo = ? AND c.person = ?
    GROUP BY c.chat ORDER BY at DESC LIMIT ?`).bind(repo, person, limit).all();
  return (results || []).map((r) => ({
    chat: r.chat, at: r.at, messages: r.messages, first: String(r.first || '').slice(0, 200),
  }));
}

/** Writes a person's message to their conversation `chat` of `repo`; returns it as shown. */
export async function addChatMessage(env, {
  id, repo, chat, person, text,
}) {
  const at = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO kb_chat_messages (id, repo, chat, person, role, body, at)
    VALUES (?, ?, ?, ?, 'person', ?, ?)`).bind(id, repo, chat, person, text, at).run();
  return shape({
    id, role: 'person', body: text, state: 'done', at,
  });
}

/** Takes back a person's message the agent did not take (it was not there to). */
export async function dropChatMessage(env, id) {
  await env.DB.prepare('DELETE FROM kb_chat_messages WHERE id = ? AND role = \'person\'')
    .bind(id).run();
}

/**
 * Keeps the agent's answer to a message of conversation `chat`, `turn` being a finished turn
 * (src/agent/turn.js) with its `sidebar` id, as keepSidebarAnswer does a thread's: only for a
 * message of that conversation; once per message, a failed answer replaced by the next
 * attempt's; never before the message. Whether it wrote.
 */
export async function keepChatAnswer(env, chat, turn) {
  if (!env.DB || !isChatId(chat) || !turn || !turn.sidebar
    || !['done', 'failed'].includes(turn.state)) {
    return false;
  }
  const res = await env.DB.prepare(`INSERT INTO kb_chat_messages
      (id, repo, chat, person, role, body, state, reply_to, at)
    SELECT ?, q.repo, q.chat, q.person, 'agent', ?, ?, q.id, MAX(?, q.at)
    FROM kb_chat_messages q WHERE q.id = ? AND q.chat = ? AND q.role = 'person'
    ON CONFLICT (id) DO UPDATE SET body = excluded.body, state = excluded.state,
      at = excluded.at WHERE kb_chat_messages.state = 'failed'`)
    .bind(
      `${turn.sidebar}:answer`,
      String(turn.text || '').slice(0, MAX_ANSWER),
      turn.state,
      turn.endedAt || new Date().toISOString(),
      turn.sidebar,
      chat,
    ).run();
  return Boolean(res && res.meta && res.meta.changes);
}

/** Whether the latest message of `messages` (as chatMessages gives them) waits for an answer. */
export function waiting(messages) {
  const list = messages || [];
  const last = list[list.length - 1];
  if (!last || last.role !== 'person') {
    return false;
  }
  return !list.some((m) => m.role === 'agent' && m.reply_to === last.id);
}
