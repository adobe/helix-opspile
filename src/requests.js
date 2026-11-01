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

import { json } from './http.js';
import { PLATFORMS } from './platforms.js';

/**
 * Channel assignment requests (migration 0028). A team manager does not assign channels: they
 * ask the admin team to, "assign channel X to team Y", with a note. The admin team confirms a
 * request, which runs the manual assignment of src/admin.js (`assign`: the channel moves to
 * the team, or is shared with it when another team holds it), or declines it with a reason.
 * The manager may withdraw an open request. One request per channel and team is open at a
 * time; decided ones stay, so the manager sees the outcome.
 *
 * This module keeps the rows; src/admin.js routes them and confirms.
 */

export const OUTCOMES = ['moved', 'shared', 'assigned'];
const MAX_NOTE = 500;
const LIMIT = 100;

const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const stamp = (me) => [me.email || String(me.id), me.name || null, new Date().toISOString()];

const SELECT = `SELECT r.*, c.tenant, c.name, c.group_name, c.shared,
    (SELECT th.team FROM threads th WHERE th.source = r.source AND th.channel_id = r.channel_id
      ORDER BY th.any_at DESC LIMIT 1) AS filed_team,
    (SELECT th.org FROM threads th WHERE th.source = r.source AND th.channel_id = r.channel_id
      ORDER BY th.any_at DESC LIMIT 1) AS filed_org,
    (SELECT COUNT(*) FROM threads th WHERE th.source = r.source
      AND th.channel_id = r.channel_id) AS threads,
    (SELECT o.name FROM orgs o JOIN threads th ON th.org = o.slug WHERE th.source = r.source
      AND th.channel_id = r.channel_id LIMIT 1) AS org_name
  FROM channel_requests r
  LEFT JOIN channels c ON c.source = r.source AND c.channel_id = r.channel_id
    AND c.tenant = (SELECT MIN(tenant) FROM channels x WHERE x.source = r.source
      AND x.channel_id = r.channel_id)`;

/** A request row as the API answers it: the channel as the admin pages show channels. */
function shape(r) {
  return {
    id: r.id,
    team: r.team,
    note: r.note,
    status: r.status,
    requestedBy: { email: r.requested_by, name: r.requested_name },
    requestedAt: r.requested_at,
    decidedBy: r.decided_by ? { email: r.decided_by, name: r.decided_name } : null,
    decidedAt: r.decided_at,
    reason: r.reason,
    outcome: r.outcome,
    channel: {
      source: r.source,
      tenant: r.tenant || null,
      channelId: r.channel_id,
      name: r.name || null,
      groupName: r.group_name || null,
      shared: Boolean(r.shared),
      team: r.filed_team || null,
      org: r.filed_org || null,
      orgName: r.org_name || null,
      threads: r.threads || 0,
    },
  };
}

/** One request, shaped, or null. */
export async function getRequest(env, id) {
  const r = await env.DB.prepare(`${SELECT} WHERE r.id = ?`).bind(Number(id) || 0).first();
  return r ? shape(r) : null;
}

/**
 * Requests, the open ones first (oldest first: who waited longest), then the decided ones,
 * latest first. `teams` (slugs) limits them to those teams, `status` to open or decided ones.
 */
export async function listRequests(env, { teams = null, status = null, limit = LIMIT } = {}) {
  const where = [];
  const args = [];
  if (teams) {
    where.push('r.team IN (SELECT value FROM json_each(?))');
    args.push(JSON.stringify(teams));
  }
  if (status === 'open') {
    where.push("r.status = 'open'");
  } else if (status === 'decided') {
    where.push("r.status != 'open'");
  }
  const { results } = await env.DB.prepare(`${SELECT}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY r.status = 'open' DESC,
      CASE WHEN r.status = 'open' THEN r.requested_at END ASC,
      COALESCE(r.decided_at, r.requested_at) DESC, r.id DESC
    LIMIT ?`).bind(...args, limit).all();
  return (results || []).map(shape);
}

/** How many requests are open, of `teams` (slugs) or of every team. */
export async function openCount(env, teams = null) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM channel_requests WHERE status = 'open'
    AND (?1 IS NULL OR team IN (SELECT value FROM json_each(?1)))`)
    .bind(teams ? JSON.stringify(teams) : null).first();
  return r ? r.n : 0;
}

/**
 * POST /api/admin/requests `{ team, source, channelId, note? }`: asks the admin team to put a
 * channel in a team's inbox. Refused for a channel opspile has not seen, one that is in the
 * team's inbox already, and when the same request is open (409, with that request).
 */
export async function createRequest(env, me, body) {
  const team = clean(body.team);
  const channelId = clean(body.channelId);
  const source = clean(body.source);
  const note = clean(body.note, MAX_NOTE) || null;
  if (!team || !channelId || !PLATFORMS.includes(source)) {
    return json({ error: `give a team, a channelId and its source (${PLATFORMS.join(', ')})` }, 400);
  }
  if (!await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(team).first()) {
    return json({ error: 'no such team' }, 404);
  }
  const seen = await env.DB.prepare(`SELECT 1 FROM channels WHERE source = ?1 AND channel_id = ?2
    UNION SELECT 1 FROM threads WHERE source = ?1 AND channel_id = ?2 LIMIT 1`)
    .bind(source, channelId).first();
  if (!seen) {
    return json({ error: 'the inbox has not seen this channel' }, 404);
  }
  const here = await env.DB.prepare(`SELECT 1 FROM threads WHERE source = ?1 AND channel_id = ?2
      AND team = ?3
    UNION SELECT 1 FROM channel_teams WHERE source = ?1 AND channel_id = ?2 AND team = ?3 LIMIT 1`)
    .bind(source, channelId, team).first();
  if (here) {
    return json({ error: 'this channel is in the team\'s inbox already' }, 409);
  }
  const [by, name, at] = stamp(me);
  const row = await env.DB.prepare(`INSERT INTO channel_requests (source, channel_id, team, note,
      requested_by, requested_name, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING RETURNING id`).bind(source, channelId, team, note, by, name, at).first();
  if (!row) {
    const open = await env.DB.prepare(`SELECT id FROM channel_requests WHERE source = ?
      AND channel_id = ? AND team = ? AND status = 'open'`).bind(source, channelId, team).first();
    return json({
      error: 'this channel is requested for the team already', request: open && await getRequest(env, open.id),
    }, 409);
  }
  console.log(JSON.stringify({
    route: 'admin', request: 'created', by: me.id, id: row.id, team,
  }));
  return json({ ok: true, request: await getRequest(env, row.id) });
}

/**
 * Closes an open request: `confirmed` (with its `outcome`), `declined` (with a `reason`) or
 * `withdrawn`. Returns the request as it is now, and whether this call closed it (`closed`):
 * false when someone else decided it first.
 */
export async function closeRequest(env, me, id, { status, reason = null, outcome = null }) {
  const [by, name, at] = stamp(me);
  const { meta } = await env.DB.prepare(`UPDATE channel_requests SET status = ?, reason = ?,
      outcome = ?, decided_by = ?, decided_name = ?, decided_at = ?
    WHERE id = ? AND status = 'open'`)
    .bind(status, reason, outcome, by, name, at, Number(id)).run();
  console.log(JSON.stringify({
    route: 'admin', request: status, by: me.id, id: Number(id), outcome, closed: meta.changes > 0,
  }));
  return { closed: meta.changes > 0, request: await getRequest(env, id) };
}

/** What came of confirmed request `id`, once the assignment is done: the request as it is now. */
export async function recordOutcome(env, id, outcome) {
  await env.DB.prepare('UPDATE channel_requests SET outcome = ? WHERE id = ?')
    .bind(outcome, Number(id)).run();
  return getRequest(env, id);
}

/**
 * Opens request `id` again, when the assignment it was confirmed for failed. A manager may have
 * asked again meanwhile: that request stands, and this one stays as it is.
 */
export async function reopenRequest(env, id) {
  await env.DB.prepare(`UPDATE OR IGNORE channel_requests SET status = 'open', decided_by = NULL,
      decided_name = NULL, decided_at = NULL WHERE id = ? AND status = 'confirmed'`)
    .bind(Number(id)).run();
}

/**
 * After the admin team assigned a channel to a team directly (not from a request), or a rule
 * moved it there, the open requests for it are confirmed with it.
 */
export async function settleRequests(env, me, { channelId, team, outcome }) {
  const [by, name, at] = stamp(me);
  await env.DB.prepare(`UPDATE channel_requests SET status = 'confirmed', outcome = ?,
      decided_by = ?, decided_name = ?, decided_at = ?
    WHERE channel_id = ? AND team = ? AND status = 'open'`)
    .bind(outcome, by, name, at, channelId, team).run();
}

/** What a manual assignment's answer (src/admin.js `assign`) did, as a request's outcome. */
export function outcomeOf(answer) {
  if (answer.shared) {
    return 'shared';
  }
  return answer.moves && answer.moves.length ? 'moved' : 'assigned';
}
