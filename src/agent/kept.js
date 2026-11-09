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
 * a moment later, pushing them up. A turn in progress is not kept: the inbox asks the agent
 * about it (GET /api/agent). The transcript stays the record: this is a copy of what
 * `latestTurn` (src/agent/turn.js) reads from it. No Agents SDK import here.
 */

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
