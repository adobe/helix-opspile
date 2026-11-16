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
 * The thread agent's latest finished turn, kept in D1 (`agent_turns`) so that it comes with the
 * thread (GET /api/thread, and the inbox's prefetch of threads) instead of from the agent's
 * Durable Object after it: opening a thread then shows the agent's note with the messages, not
 * a moment later, pushing them up. What the agent is doing now, a turn in progress or one that
 * answers a sidebar message too, is kept apart (`agent_live`, `keepLive`): GET /api/agent answers
 * with it, so asking does not start the agent's Durable Object. The transcript stays the record:
 * both are copies of what `latestTurn` (src/agent/turn.js) reads from it. No Agents SDK import
 * here.
 */

import { STUCK_MS } from './turn.js';

const FINISHED = new Set(['done', 'failed']);

/**
 * Keeps `turn` (`latestTurn`'s answer) as entry `key`'s latest: a finished one replaces an
 * older one, none (a reset transcript) removes it. A turn in progress, and an agent without a
 * thread (`kb:…`), keep nothing. Whether something was written.
 */
export async function keepTurn(env, key, turn) {
  if (!env.DB || !key || String(key).startsWith('kb:')) {
    return false;
  }
  if (!turn) {
    await env.DB.prepare('DELETE FROM agent_turns WHERE thread = ?').bind(key).run();
    return true;
  }
  if (!FINISHED.has(turn.state)) {
    return false;
  }
  // An older turn (writes from two isolates crossing) does not replace a newer one.
  await env.DB.prepare(`INSERT INTO agent_turns (thread, state, text, started_at, ended_at, at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (thread) DO UPDATE SET state = excluded.state, text = excluded.text,
      started_at = excluded.started_at, ended_at = excluded.ended_at, at = excluded.at
    WHERE agent_turns.started_at IS NULL OR excluded.started_at >= agent_turns.started_at`)
    .bind(
      key,
      turn.state,
      String(turn.text || ''),
      turn.startedAt || null,
      turn.endedAt || null,
      new Date().toISOString(),
    ).run();
  return true;
}

/** The latest finished turn kept for entry `key`, as `latestTurn` says it, or null. */
export async function keptTurn(env, key) {
  if (!env.DB || !key) {
    return null;
  }
  const row = await env.DB.prepare(`SELECT state, text, started_at, ended_at
    FROM agent_turns WHERE thread = ?`).bind(key).first();
  return row ? {
    state: row.state, text: row.text, startedAt: row.started_at, endedAt: row.ended_at,
  } : null;
}

/**
 * Keeps `turn` (`latestTurn`'s answer, any state, null before the first) as what entry `key`'s
 * agent is doing, as it read its transcript at `at` (ISO): GET /api/agent answers with it, without
 * the agent. A reading older than the one kept does not replace it. Whether it was written.
 */
export async function keepLive(env, key, turn, at) {
  if (!env.DB || !key || String(key).startsWith('kb:')) {
    return false;
  }
  const { meta } = await env.DB.prepare(`INSERT INTO agent_live (thread, turn, at) VALUES (?, ?, ?)
    ON CONFLICT (thread) DO UPDATE SET turn = excluded.turn, at = excluded.at
    WHERE excluded.at >= agent_live.at`).bind(key, JSON.stringify(turn || null), at).run();
  return Boolean(meta && meta.changes);
}

/**
 * Whether `turn`, read at `at` (ISO), is to be kept as what the agent is doing, after `last`
 * (`{ sig, at }`: the JSON of the turn kept last, and when it was read, either unknown): when it
 * changed, or a working one was kept a third of STUCK_MS ago, so that `liveTurn` does not take
 * it for one that stopped while the turn still works.
 */
export function liveDue(last, turn, at) {
  if (!last || last.sig !== JSON.stringify(turn || null)) {
    return true;
  }
  if (!(turn && turn.state === 'working')) {
    return false;
  }
  return !last.at || !(Date.parse(at) - Date.parse(last.at) < STUCK_MS / 3);
}

/**
 * The turn GET /api/agent answers with from a kept `agent_live` row (`{ turn, at }`, or null for
 * none), or undefined when the agent has to be asked: there is no row, or the turn has been
 * working for longer than a turn's run takes without the agent writing (STUCK_MS: its object
 * stopped half way, and the agent's answer, `failed`, is what the inbox should hear).
 */
export function liveTurn(row, now = Date.now()) {
  if (!row || typeof row.turn !== 'string' || !row.at) {
    return undefined;
  }
  let turn;
  try {
    turn = JSON.parse(row.turn);
  } catch {
    return undefined;
  }
  if (turn && turn.state === 'working' && !(now - Date.parse(row.at) < STUCK_MS)) {
    return undefined;
  }
  return turn || null;
}
