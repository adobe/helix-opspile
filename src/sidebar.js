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
 * The sidebar: a person on the team talks to the thread's agent in the inbox, about the thread,
 * and the agent answers there. It is a conversation with the agent, never with the channel:
 * nothing of it goes to Slack, Teams or Discord. A message goes into the agent's own
 * conversation (its transcript, so it remembers it in later turns) as an input of its own, and
 * into the thread's history in D1 (`sidebar_messages`), which the inbox shows between the
 * thread's messages, folded. The agent's answer is its closing text of that turn, kept when the
 * turn ends (ThreadAgent.keepTurn). While it answers one, its `post_message` and `add_reaction`
 * are refused (src/agent/tools.js): `sidebarOf` reads the turn's input. No SDK import here.
 */

export const MAX_SIDEBAR = 8000;
/** What the agent's answer keeps: more than a note, as it answers a person. */
export const MAX_ANSWER = 8000;

const HEAD = /^Sidebar message (sb_[0-9a-f-]{36}) from /;

/** A new sidebar message's id. */
export const sidebarId = () => `sb_${crypto.randomUUID()}`;

/**
 * What the agent is told. The first line names the message, and only an input that starts with
 * it is a sidebar message (`sidebarOf`): a customer's text quoting one is told inside a delivery,
 * which starts otherwise.
 */
export function sidebarNote({ id, by, text }) {
  return `Sidebar message ${id} from ${by} (Adobe staff), in the inbox.\n\n`
    + `${by} talks to you in the inbox's sidebar of this thread: a side conversation with the team.`
    + ' It is never posted to the channel and nobody outside the team sees it, so post_message and'
    + ' add_reaction are refused while you answer it, and nothing of it goes into a reply unless'
    + ` ${by} asks for it in the draft. It is trusted. Answer ${by} directly, in Markdown, at the`
    + ' end of this turn, as long as the answer needs: that text is shown to them in the sidebar'
    + ' instead of your note. Do what they ask with your other tools (the draft, the knowledge'
    + ' bases, a lookup) where it fits the thread, and say what you changed.'
    + `\n\n<sidebar-message>\n${text}\n</sidebar-message>`;
}

/** The text of a transcript input (pi's user message), or ''. */
export function inputText(message) {
  const content = message && message.content;
  if (typeof content === 'string') {
    return content;
  }
  return (Array.isArray(content) ? content : [])
    .filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n');
}

/** The id of the sidebar message that `text` (an input) is, or null. */
export function sidebarOf(text) {
  const m = HEAD.exec(String(text || ''));
  return m ? m[1] : null;
}

const shape = (r) => ({
  id: r.id,
  role: r.role,
  by: r.role === 'person' ? { id: r.person, name: r.name || 'someone' } : null,
  body: r.body,
  state: r.state,
  reply_to: r.reply_to || null,
  at: r.at,
});

/** The sidebar messages of the entry's threads (`keys`), oldest first. */
export async function sidebarFor(env, keys) {
  const list = [...new Set((keys || []).filter(Boolean))];
  if (!env.DB || !list.length) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT s.*, p.name FROM sidebar_messages s
    LEFT JOIN people p ON p.id = s.person
    WHERE s.thread IN (SELECT value FROM json_each(?)) ORDER BY s.at, s.role DESC`)
    .bind(JSON.stringify(list)).all();
  return (results || []).map(shape);
}

/** Writes a person's sidebar message to entry `key`; returns it as `sidebarFor` does. */
export async function addSidebarMessage(env, key, {
  id, person, name, text,
}) {
  const at = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO sidebar_messages (id, thread, role, person, body, at)
    VALUES (?, ?, 'person', ?, ?, ?)`).bind(id, key, person, text, at).run();
  return shape({
    id, role: 'person', person, name, body: text, state: 'done', at,
  });
}

/**
 * Keeps the agent's answer to a sidebar message, `turn` being `latestTurn`'s finished one with
 * its `sidebar` id, for entry `key`. Only for a message of that entry; once per message: a
 * finished answer is not replaced, a failed one is, by the next attempt's. Never before the
 * message, whatever the clocks say. Whether it wrote.
 */
export async function keepSidebarAnswer(env, key, turn) {
  if (!env.DB || !key || !turn || !turn.sidebar || !['done', 'failed'].includes(turn.state)) {
    return false;
  }
  const res = await env.DB.prepare(`INSERT INTO sidebar_messages
      (id, thread, role, person, body, state, reply_to, at)
    SELECT ?, ?, 'agent', q.person, ?, ?, q.id, MAX(?, q.at)
    FROM sidebar_messages q WHERE q.id = ? AND q.thread = ? AND q.role = 'person'
    ON CONFLICT (id) DO UPDATE SET body = excluded.body, state = excluded.state,
      at = excluded.at WHERE sidebar_messages.state = 'failed'`)
    .bind(
      `${turn.sidebar}:answer`,
      key,
      String(turn.text || '').slice(0, MAX_ANSWER),
      turn.state,
      turn.endedAt || new Date().toISOString(),
      turn.sidebar,
      key,
    ).run();
  return Boolean(res && res.meta && res.meta.changes);
}
