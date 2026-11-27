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
 * Questions a thread agent asks a person on its thread's teams (migration 0104): what the
 * knowledge bases and the thread do not say, for a runbook, a reply or a fact, one to three
 * questions with the agent's best guess at each, so that most can be answered by confirming it.
 * The agent asks with `ask_teammate` (src/agent/question.js); the person sees the question as a
 * thread of their inbox (src/requestthreads.js, kind `question`), as the admin team sees its
 * requests, and answers it, passes it to someone who knows, or says they do not know. The agent is
 * told, as an input of its own. A question nobody answered within `DEADLINE_MS` is expired: read
 * off the clock, and written only when the agent asks the same person again.
 *
 * An admin asks a colleague the same way from a request of the admin team's inbox ("Ask a
 * colleague", src/requestthreads.js): the question's `thread` is then the request's key, `asked_by`
 * the admin (migration 0117), and the answer goes into the request's decision log, not to an agent.
 *
 * This module keeps the rows.
 */

export const PURPOSES = ['runbook', 'reply', 'fact'];
export const MAX_ITEMS = 3;
export const MAX_CHOICES = 4;
export const MAX_TEXT = 300;
export const MAX_GUESS = 200;
export const MAX_CHOICE = 120;
export const MAX_WHY = 500;
export const MAX_NOTE = 1000;
/** How many of a thread's questions may wait at a time, each for another person. */
export const MAX_OPEN = 2;
/** How long a question waits for its answer. */
export const DEADLINE_MS = 3 * 24 * 60 * 60 * 1000;
const LIMIT = 100;

const clean = (v, n) => String(v ?? '').trim().slice(0, n);
const parse = (s, fallback) => {
  try {
    return JSON.parse(s || '') ?? fallback;
  } catch {
    return fallback;
  }
};

/** Where question `r` stands at `now`: an open one past its deadline has expired. */
function statusAt(r, now) {
  return r.status === 'open' && Date.parse(r.deadline) <= now.getTime() ? 'expired' : r.status;
}

/** A row as the API answers it. */
function shape(r, now = new Date()) {
  return {
    id: r.id,
    thread: r.thread,
    team: r.team,
    title: r.title || null,
    person: { email: r.email, name: r.name || null },
    purpose: r.purpose,
    why: r.why,
    items: parse(r.items, []),
    sidebar: r.sidebar || null,
    askedFor: r.asked_for_name || null,
    status: statusAt(r, now),
    askedAt: r.asked_at,
    deadline: r.deadline,
    answers: parse(r.answers, []),
    note: r.note || null,
    passedTo: r.passed_to || null,
    decidedAt: r.decided_at || null,
    toldAt: r.told_at || null,
    // An admin's, from a request of the admin team's inbox (its `thread` the request's key).
    askedBy: r.asked_by ? { email: r.asked_by, name: r.asked_by_name || null } : null,
  };
}

const SELECT = `SELECT q.*, (SELECT p.name FROM sidebar_messages s JOIN people p ON p.id = s.person
    WHERE s.id = q.sidebar) AS asked_for_name FROM questions q`;

/**
 * The agent's questions as it gives them, cleaned: `{ items }`, or `{ error }`. Each has its
 * `text`, and may have a `guess` and up to MAX_CHOICES `choices` (the guess among them, first).
 */
export function cleanItems(input) {
  const list = Array.isArray(input) ? input : [];
  if (!list.length || list.length > MAX_ITEMS) {
    return { error: `ask one to ${MAX_ITEMS} questions at a time` };
  }
  const items = [];
  for (const x of list) {
    const text = clean(x && x.text, MAX_TEXT);
    if (!text) {
      return { error: 'every question needs its text' };
    }
    const guess = clean(x.guess, MAX_GUESS);
    const choices = [...new Set([guess, ...(Array.isArray(x.choices) ? x.choices : [])]
      .map((c) => clean(c, MAX_CHOICE)).filter(Boolean))];
    if (choices.length > MAX_CHOICES) {
      return { error: `give at most ${MAX_CHOICES} choices for a question, your guess among them` };
    }
    items.push({ text, ...(guess ? { guess } : {}), ...(choices.length ? { choices } : {}) });
  }
  return { items };
}

/** Question `id`, shaped, or null. */
export async function getQuestion(env, id, now = new Date()) {
  const r = await env.DB.prepare(`${SELECT} WHERE q.id = ?`).bind(String(id || '')).first();
  return r ? shape(r, now) : null;
}

/** The questions asked of `email`, latest first: every open one, and the latest decided. */
export async function listQuestions(env, { email, limit = LIMIT }, now = new Date()) {
  const { results } = await env.DB.prepare(`${SELECT} WHERE q.email = ?
    ORDER BY q.status = 'open' DESC, q.asked_at DESC LIMIT ?`)
    .bind(String(email || '').toLowerCase(), limit).all();
  return (results || []).map((r) => shape(r, now));
}

/** The questions asked from thread `thread`, latest first. */
export async function questionsOf(env, thread, now = new Date()) {
  const { results } = await env.DB.prepare(`${SELECT} WHERE q.thread = ? ORDER BY q.asked_at DESC`)
    .bind(thread).all();
  return (results || []).map((r) => shape(r, now));
}

/**
 * The questions that wait for `email` now, for the number on Inbox (ui/header.js): `{ open,
 * team }`, the team being the one the latest is filed under (where a click on the number goes).
 */
export async function openQuestions(env, email, now = new Date()) {
  if (!email) {
    return { open: 0, team: null };
  }
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n, (SELECT team FROM questions WHERE email = ?1
      AND status = 'open' AND deadline > ?2 ORDER BY asked_at DESC LIMIT 1) AS team
    FROM questions WHERE email = ?1 AND status = 'open' AND deadline > ?2`)
    .bind(String(email).toLowerCase(), now.toISOString()).first();
  return { open: (r && r.n) || 0, team: (r && r.team) || null };
}

/**
 * Stores a question of thread `thread`'s agent for `person` (`{ email, name }`): `{ question }`,
 * or `{ error, question? }` (the one waiting for them already). An open one of theirs that expired
 * is closed as expired first, so the new one takes its place.
 */
export async function createQuestion(env, id, {
  thread, team, title, person, purpose, why, items, sidebar = null, askedBy = null,
}, now = new Date()) {
  const email = String(person.email).toLowerCase();
  const at = now.toISOString();
  await env.DB.prepare(`UPDATE questions SET status = 'expired' WHERE thread = ? AND email = ?
    AND status = 'open' AND deadline <= ?`).bind(thread, email, at).run();
  const waiting = await env.DB.prepare(`${SELECT} WHERE q.thread = ? AND q.email = ?
    AND q.status = 'open'`).bind(thread, email).first();
  if (waiting) {
    return { error: `question ${waiting.id} waits for ${waiting.name || email} already`, question: shape(waiting, now) };
  }
  const open = await env.DB.prepare(`SELECT COUNT(*) AS n FROM questions WHERE thread = ?
    AND status = 'open' AND deadline > ?`).bind(thread, at).first();
  if (open && open.n >= MAX_OPEN) {
    return { error: `${MAX_OPEN} of your questions wait for an answer already` };
  }
  await env.DB.prepare(`INSERT INTO questions (id, thread, team, title, email, name, purpose, why,
      items, sidebar, asked_at, deadline, asked_by, asked_by_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      thread,
      team,
      title || null,
      email,
      person.name || null,
      purpose,
      why,
      JSON.stringify(items),
      sidebar,
      at,
      new Date(now.getTime() + DEADLINE_MS).toISOString(),
      askedBy ? String(askedBy.email || '').toLowerCase() || null : null,
      askedBy ? askedBy.name || null : null,
    ).run();
  return { question: await getQuestion(env, id, now) };
}

/**
 * Closes question `id` as `status` (answered, passed or unknown), if it still waits: `answers`,
 * `note` and `passedTo` as the person gave them. Whether it closed it: of two answers, one wins.
 */
export async function closeQuestion(env, id, {
  status, answers = [], note = '', passedTo = '',
}, now = new Date()) {
  const at = now.toISOString();
  const res = await env.DB.prepare(`UPDATE questions SET status = ?, answers = ?, note = ?,
      passed_to = ?, decided_at = ? WHERE id = ? AND status = 'open' AND deadline > ?`)
    .bind(
      status,
      JSON.stringify(answers),
      clean(note, MAX_NOTE) || null,
      clean(passedTo, 200) || null,
      at,
      id,
      at,
    ).run();
  return Boolean(res && res.meta && res.meta.changes);
}

/** The agent was told how question `id` ended. */
export async function markTold(env, id, now = new Date()) {
  await env.DB.prepare('UPDATE questions SET told_at = ? WHERE id = ? AND told_at IS NULL')
    .bind(now.toISOString(), id).run();
}
