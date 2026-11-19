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
 * Tool requests (migration 0080): while it answers a sidebar message, a thread agent asks for a
 * tool its channel does not have (its `request_tool`, src/agent/toolrequest.js): a switchable
 * tool (src/agent/agenttools.js) or an MCP server (src/agent/mcpclient.js, src/agent/globals.js).
 * The inbox shows the request in the sidebar, under the agent's answer, and anyone who may work
 * the thread grants or denies it there. A grant gives the thread's agent the tool for GRANT_MS,
 * in all its turns, on top of the switches of its team and channel; whoever may work the thread
 * can end it earlier.
 *
 * This file is the record in D1 and its lifecycle, `status`:
 *
 *   pending -> granted -> revoked
 *   pending -> denied
 *
 * A pending request past its deadline is `expired`, and a grant past `expires_at` has `ended`:
 * both read off the clock (`shape`), never written, so nothing has to wake up for them. Every
 * transition names the status it starts from (`WHERE status = …`), so two people who click at
 * once cannot both win.
 */

export const MAX_REASON = 500;
/** Requests of one thread that may wait at a time. */
export const MAX_OPEN = 5;
const HOUR = 60 * 60 * 1000;
/** How long a person may decide. */
export const DEADLINE_MS = 24 * HOUR;
/** How long a grant lasts. */
export const GRANT_MS = 24 * HOUR;
/** The latest requests of a thread the inbox shows. */
const SHOWN = 50;

/** The reason the agent gave, or `{ error }`. */
export function cleanReason(input) {
  const reason = String(input || '').trim();
  if (!reason || reason.length > MAX_REASON) {
    return { error: `say why, for the person who decides (up to ${MAX_REASON} characters)` };
  }
  return { reason };
}

/** A request's status as it stands at `now`: the clock's `expired` and `ended` included. */
function statusAt(r, at) {
  if (r.status === 'pending' && r.deadline <= at) {
    return 'expired';
  }
  if (r.status === 'granted' && r.expires_at <= at) {
    return 'ended';
  }
  return r.status;
}

const who = (id, name) => (id ? { id, name: name || null } : null);

/** A request as the inbox and the agent's code see it. */
const shape = (r, now) => ({
  id: r.id,
  thread: r.thread,
  sidebar: r.sidebar,
  kind: r.kind,
  name: r.name,
  title: r.title,
  about: r.about,
  reason: r.reason,
  status: statusAt(r, now.toISOString()),
  created_at: r.created_at,
  deadline: r.deadline,
  by: who(r.decided_by, r.decider),
  decided_at: r.decided_at,
  expires_at: r.expires_at,
  revoked_by: who(r.revoked_by, r.revoker),
  revoked_at: r.revoked_at,
});

const SELECT = `SELECT r.*, d.name AS decider, v.name AS revoker FROM tool_requests r
  LEFT JOIN people d ON d.id = r.decided_by
  LEFT JOIN people v ON v.id = r.revoked_by`;

/** The request `id`, or null. */
export async function toolRequestOf(env, id, now = new Date()) {
  const row = id && await env.DB.prepare(`${SELECT} WHERE r.id = ?`).bind(String(id)).first();
  return row ? shape(row, now) : null;
}

/** The latest requests of an inbox entry (`keys`: its member threads), oldest first. */
export async function toolRequestsFor(env, keys, now = new Date()) {
  const list = [...new Set((keys || []).filter(Boolean))];
  if (!env.DB || !list.length) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT * FROM (${SELECT}
    WHERE r.thread IN (SELECT value FROM json_each(?)) ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${SHOWN}) ORDER BY created_at, id`).bind(JSON.stringify(list)).all();
  return (results || []).map((r) => shape(r, now));
}

/**
 * The request of `thread` for `kind` and `name` that waits or is granted at `now`, or null: the
 * agent does not ask twice.
 */
export async function openRequestFor(env, thread, { kind, name }, now = new Date()) {
  const at = now.toISOString();
  const row = await env.DB.prepare(`${SELECT} WHERE r.thread = ? AND r.kind = ? AND r.name = ?
      AND ((r.status = 'pending' AND r.deadline > ?) OR (r.status = 'granted' AND r.expires_at > ?))
    ORDER BY r.created_at DESC LIMIT 1`).bind(thread, kind, String(name), at, at).first();
  return row ? shape(row, now) : null;
}

/** How many requests of `thread` wait at `now`. */
export async function pendingCount(env, thread, now = new Date()) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tool_requests
    WHERE thread = ? AND status = 'pending' AND deadline > ?`)
    .bind(thread, now.toISOString()).first();
  return row ? row.n : 0;
}

/**
 * Stores a new request of `thread` under `id`: pending until DEADLINE_MS from `now`.
 * `request`: `{ sidebar, kind, name, title, about, reason }`.
 */
export async function insertToolRequest(env, id, thread, request, now = new Date()) {
  await env.DB.prepare(`INSERT INTO tool_requests (id, thread, sidebar, kind, name, title, about,
      reason, status, created_at, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .bind(
      id,
      thread,
      request.sidebar || null,
      request.kind,
      String(request.name),
      request.title,
      request.about || null,
      request.reason,
      now.toISOString(),
      new Date(now.getTime() + DEADLINE_MS).toISOString(),
    ).run();
  return toolRequestOf(env, id, now);
}

const changed = (res) => Boolean(res && res.meta && res.meta.changes);

/** pending -> granted, by `person`, for GRANT_MS from `now`, by the deadline: whether it did. */
export async function grantToolRequest(env, id, person, now = new Date()) {
  const at = now.toISOString();
  const until = new Date(now.getTime() + GRANT_MS).toISOString();
  return changed(await env.DB.prepare(`UPDATE tool_requests SET status = 'granted',
      decided_by = ?, decided_at = ?, expires_at = ?
    WHERE id = ? AND status = 'pending' AND deadline > ?`).bind(person, at, until, id, at).run());
}

/** pending -> denied, by `person`, before the deadline. Whether it did. */
export async function denyToolRequest(env, id, person, now = new Date()) {
  const at = now.toISOString();
  return changed(await env.DB.prepare(`UPDATE tool_requests SET status = 'denied',
      decided_by = ?, decided_at = ?
    WHERE id = ? AND status = 'pending' AND deadline > ?`).bind(person, at, id, at).run());
}

/** granted -> revoked, by `person`, while the grant lasts. Whether it did. */
export async function revokeToolRequest(env, id, person, now = new Date()) {
  const at = now.toISOString();
  return changed(await env.DB.prepare(`UPDATE tool_requests SET status = 'revoked',
      revoked_by = ?, revoked_at = ?
    WHERE id = ? AND status = 'granted' AND expires_at > ?`).bind(person, at, id, at).run());
}

/**
 * What `thread` (an entry's key) was granted and has at `now`, of `kind` ('tool' or 'server'):
 * the names, and when the latest of them was granted (for the MCP catalog's fingerprint), by
 * name: `Map<name, decided_at>`.
 */
export async function grantsOf(env, thread, kind, now = new Date()) {
  if (!thread || !env.DB) {
    return new Map();
  }
  const { results } = await env.DB.prepare(`SELECT name, MAX(decided_at) AS at FROM tool_requests
    WHERE thread = ? AND kind = ? AND status = 'granted' AND expires_at > ? GROUP BY name`)
    .bind(thread, kind, now.toISOString()).all();
  return new Map((results || []).map((r) => [r.name, r.at]));
}
