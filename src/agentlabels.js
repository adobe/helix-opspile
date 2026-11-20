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

import { QUESTIONS } from './label.js';

/**
 * What a thread's agent says of its thread, with its tools `resolve_thread` and `label_thread`
 * (src/agent/agenttools.js, src/agent/tools.js): `agent_labels`, one row per platform thread
 * and question (migration 0091). Only the inbox has it: nothing is posted or reacted on the
 * platform.
 *
 * - `resolved` (`yes`): as a staff ✅ on the root (src/resolve.js `resolutionFacts`): the thread
 *   is resolved from `at` until a customer writes again, then reopened until Clef has read that
 *   message. resolve_thread's `undo` and the inbox's ✅ button take it back.
 * - `kind`: Clef's answer is replaced until the agent says otherwise: what a thread is about
 *   rarely changes, and Clef's answer can flip from one message to the next.
 * - `urgency` and `next_actor`: replaced until a person posts after `at` (`threads.last_at`):
 *   both change with the conversation, and Clef reads the new message then.
 *
 * A person's label review of the current label (src/review.js) wins over the agent's.
 */

/** The urgency the agent gives, by name, as Clef's score (`labels.urgency`, 0 to 3). */
export const URGENCY = {
  low: 0, normal: 1, high: 2, critical: 3,
};

/** What the agent may answer, per question: as label review's (src/review.js ANSWERS). */
export const AGENT_ANSWERS = {
  kind: Object.keys(QUESTIONS.kind.criteria),
  next_actor: Object.keys(QUESTIONS.next_actor.criteria),
  urgency: Object.values(URGENCY).map(String),
};

const MAX_REASON = 500;

/** Whether an agent's row of `question` still holds, by the thread's latest person message. */
export function holds(row) {
  if (row.question === 'kind') {
    return true;
  }
  if (row.question === 'urgency' || row.question === 'next_actor') {
    return !row.last_at || row.last_at <= row.at;
  }
  return false;
}

/**
 * The agent's rows of the threads (all but `resolved`, which src/resolve.js reads), each with
 * its thread's `last_at`.
 */
export async function agentLabelsFor(db, threads) {
  if (!threads.length) {
    return [];
  }
  const { results } = await db.prepare(`SELECT a.thread, a.question, a.value, a.reason, a.at,
      t.last_at FROM agent_labels a LEFT JOIN threads t ON t.thread = a.thread
    WHERE a.thread IN (SELECT value FROM json_each(?)) AND a.question != 'resolved'`)
    .bind(JSON.stringify([...new Set(threads)])).all();
  return results || [];
}

/**
 * `label` with the agent's answers that hold in place of Clef's, and `agent` listing the
 * questions they replaced. `rows` are the label's thread's (`agentLabelsFor`).
 */
export function applyAgentLabels(label, rows) {
  if (!label) {
    return null;
  }
  const own = (rows || []).filter((r) => (!r.thread || !label.thread || r.thread === label.thread)
    && holds(r));
  if (!own.length) {
    return label;
  }
  const out = { ...label, agent: own.map((r) => r.question).sort() };
  for (const r of own) {
    if (r.question === 'kind') {
      out.kind = r.value;
      if ('label_kind' in out) {
        out.label_kind = r.value;
      }
    } else if (r.question === 'urgency') {
      out.urgency = Number(r.value);
    } else if (r.question === 'next_actor') {
      out.next_actor = r.value;
    }
  }
  return out;
}

/**
 * The member of an entry the agent's labels go on: its latest (by `any_at`), whose label the
 * inbox shows for the group (src/threads.js `latestMember`). `keys` are the entry's threads.
 */
export async function labelThreadOf(db, keys) {
  const list = [...new Set((keys || []).filter(Boolean))];
  if (!list.length) {
    return null;
  }
  const row = await db.prepare(`SELECT thread FROM threads
    WHERE thread IN (SELECT value FROM json_each(?)) ORDER BY any_at DESC, thread LIMIT 1`)
    .bind(JSON.stringify(list)).first();
  return row ? row.thread : null;
}

/**
 * Records the agent's answers (`{ question: value }`, validated by the caller) on `thread`, now,
 * and takes the same questions off the entry's other members (`keys`), so one row speaks.
 */
export async function setAgentLabels(db, thread, keys, answers, reason, now = new Date()) {
  const at = now.toISOString();
  const why = reason ? String(reason).trim().slice(0, MAX_REASON) : null;
  const others = JSON.stringify([...new Set(keys || [])].filter((k) => k !== thread));
  const statements = Object.entries(answers).flatMap(([question, value]) => [
    db.prepare(`DELETE FROM agent_labels WHERE question = ?
      AND thread IN (SELECT value FROM json_each(?))`).bind(question, others),
    db.prepare(`INSERT INTO agent_labels (thread, question, value, reason, at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (thread, question) DO UPDATE SET value = excluded.value,
        reason = excluded.reason, at = excluded.at`).bind(thread, question, String(value), why, at),
  ]);
  if (statements.length) {
    await db.batch(statements);
  }
  return at;
}

/** Takes the agent's answer to `question` off the threads `keys`: how many it took off. */
export async function clearAgentLabel(db, keys, question) {
  const list = [...new Set((keys || []).filter(Boolean))];
  if (!list.length) {
    return 0;
  }
  const res = await db.prepare(`DELETE FROM agent_labels WHERE question = ?
    AND thread IN (SELECT value FROM json_each(?))`).bind(question, JSON.stringify(list)).run();
  return Number(res?.meta?.changes || 0);
}
