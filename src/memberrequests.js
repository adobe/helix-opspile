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

import { domainList, isStaffDomain } from './lookup.js';
import { announceRequest } from './requestkeys.js';

/**
 * Team membership requests (migration 0096): someone asks for a person to be added to an ops
 * team, with a reason. A thread's agent files them from its sidebar, for the person who wrote
 * there (`request_team_membership`, src/agent/memberrequest.js), as it files channel requests
 * (src/requests.js). An admin or one of the team's managers confirms one, which adds the person
 * as the team's page does (src/admin.js `addMember`), or declines it with a reason. One request
 * per team and mail address is open at a time; decided ones stay, so whoever asked sees the
 * outcome. Adding the person on the team's page answers the open requests for them.
 *
 * This module keeps the rows; src/admin.js routes them and confirms.
 */

const MAX_NOTE = 500;
const LIMIT = 100;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const stamp = (me) => [me.email || String(me.id), me.name || null, new Date().toISOString()];

const SELECT = `SELECT r.*, p.id AS person_id, p.name AS person_name,
    (SELECT GROUP_CONCAT(m.team, ',') FROM team_members m WHERE m.person = p.id) AS person_teams
  FROM member_requests r
  LEFT JOIN people p ON p.email = r.email`;

/** A request row as the API answers it: the person with the teams they are on now. */
function shape(r) {
  const teams = r.person_teams ? r.person_teams.split(',').sort() : [];
  return {
    id: r.id,
    team: r.team,
    person: {
      id: r.person_id || null,
      email: r.email,
      name: r.person_name || r.name || null,
      teams,
      member: teams.includes(r.team),
    },
    note: r.note,
    status: r.status,
    requestedBy: { email: r.requested_by, name: r.requested_name },
    requestedAt: r.requested_at,
    thread: r.thread || null,
    decidedBy: r.decided_by ? { email: r.decided_by, name: r.decided_name } : null,
    decidedAt: r.decided_at,
    reason: r.reason,
    outcome: r.outcome,
  };
}

/** One request, shaped, or null. */
export async function getMemberRequest(env, id) {
  const r = await env.DB.prepare(`${SELECT} WHERE r.id = ?`).bind(Number(id) || 0).first();
  return r ? shape(r) : null;
}

/**
 * Requests, the open ones first (oldest first), then the decided ones, latest first. `teams`
 * (slugs) limits them to those teams, `status` to open or decided ones, `email` to a person's.
 */
export async function listMemberRequests(env, {
  teams = null, status = null, email = null, limit = LIMIT,
} = {}) {
  const where = [];
  const args = [];
  if (teams) {
    where.push('r.team IN (SELECT value FROM json_each(?))');
    args.push(JSON.stringify(teams));
  }
  if (email) {
    where.push('r.email = ?');
    args.push(String(email).toLowerCase());
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
export async function memberOpenCount(env, teams = null) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM member_requests WHERE status = 'open'
    AND (?1 IS NULL OR team IN (SELECT value FROM json_each(?1)))`)
    .bind(teams ? JSON.stringify(teams) : null).first();
  return r ? r.n : 0;
}

/**
 * Asks, for `me` (who asked: `{ id, email, name }`), that `email` (named `name`) be added to
 * team `team`, with `note`; `thread` is the entry whose sidebar asked. `{ request }`, or
 * `{ error, status, request? }`: refused for a team there is not, an address that is not one, or
 * not of the staff's domains (STAFF_DOMAINS: team members are staff), a person on the team
 * already, and when the same request is open (with that request).
 */
export async function createMemberRequest(env, me, {
  team, email, name = null, note = null, thread = null,
}) {
  const slug = clean(team).toLowerCase();
  const mail = clean(email).toLowerCase();
  if (!slug || !EMAIL.test(mail)) {
    return { error: 'give a team and the person\'s email address', status: 400 };
  }
  if (!await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(slug).first()) {
    return { error: 'no such team', status: 404 };
  }
  if (domainList(env.STAFF_DOMAINS).length && !isStaffDomain(env, mail)) {
    return { error: `${mail} is not a staff address: only staff are on ops teams`, status: 400 };
  }
  const member = await env.DB.prepare(`SELECT 1 FROM team_members m JOIN people p ON p.id = m.person
    WHERE m.team = ? AND p.email = ?`).bind(slug, mail).first();
  if (member) {
    return { error: `${mail} is on ${slug} already`, status: 409 };
  }
  const [by, byName, at] = stamp(me);
  const row = await env.DB.prepare(`INSERT INTO member_requests (team, email, name, note,
      requested_by, requested_name, requested_at, thread) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING RETURNING id`)
    .bind(
      slug,
      mail,
      clean(name, 120) || null,
      clean(note, MAX_NOTE) || null,
      by,
      byName,
      at,
      thread || null,
    )
    .first();
  if (!row) {
    const open = await env.DB.prepare(`SELECT id FROM member_requests WHERE team = ? AND email = ?
      AND status = 'open'`).bind(slug, mail).first();
    return {
      error: `${mail} is requested for ${slug} already`,
      status: 409,
      request: open && await getMemberRequest(env, open.id),
    };
  }
  console.log(JSON.stringify({
    route: 'admin', memberRequest: 'created', by: me.id, id: row.id, team: slug, via: thread ? 'agent' : 'page',
  }));
  await announceRequest(env, 'member', row.id);
  return { request: await getMemberRequest(env, row.id) };
}

/**
 * Closes an open request: `declined` (with a `reason`) or `withdrawn`. Returns the request as it
 * is now, and whether this call closed it (`closed`): false when someone decided it first.
 */
export async function closeMemberRequest(env, me, id, { status, reason = null }) {
  const [by, name, at] = stamp(me);
  const { meta } = await env.DB.prepare(`UPDATE member_requests SET status = ?, reason = ?,
      decided_by = ?, decided_name = ?, decided_at = ? WHERE id = ? AND status = 'open'`)
    .bind(status, reason, by, name, at, Number(id)).run();
  console.log(JSON.stringify({
    route: 'admin', memberRequest: status, by: me.id, id: Number(id), closed: meta.changes > 0,
  }));
  return { closed: meta.changes > 0, request: await getMemberRequest(env, id) };
}

/**
 * Claims open request `id` as confirmed: whether this call did, or someone decided it first. The
 * person is added after it; `recordMemberOutcome` says what came of it, `reopenMemberRequest`
 * that it failed.
 */
export async function claimMemberRequest(env, me, id) {
  const [by, name, at] = stamp(me);
  const { meta } = await env.DB.prepare(`UPDATE member_requests SET status = 'confirmed',
      decided_by = ?, decided_name = ?, decided_at = ? WHERE id = ? AND status = 'open'`)
    .bind(by, name, at, Number(id)).run();
  return meta.changes > 0;
}

/** What came of confirmed request `id` (`added`, `member`): the request as it is now. */
export async function recordMemberOutcome(env, id, outcome) {
  await env.DB.prepare('UPDATE member_requests SET outcome = ? WHERE id = ?')
    .bind(outcome, Number(id)).run();
  return getMemberRequest(env, id);
}

/**
 * Opens request `id` again, when adding the person failed. If someone asked again meanwhile,
 * that request stands, and this one is closed as withdrawn: it did nothing.
 */
export async function reopenMemberRequest(env, id) {
  await env.DB.prepare(`UPDATE OR IGNORE member_requests SET status = 'open', decided_by = NULL,
      decided_name = NULL, decided_at = NULL WHERE id = ? AND status = 'confirmed'`)
    .bind(Number(id)).run();
  await env.DB.prepare(`UPDATE member_requests SET status = 'withdrawn', outcome = NULL
    WHERE id = ? AND status = 'confirmed'`).bind(Number(id)).run();
  return getMemberRequest(env, id);
}

/** After `email` was added to `team` directly (not from a request), its open requests are too. */
export async function settleMemberRequests(env, me, { team, email }) {
  const [by, name, at] = stamp(me);
  await env.DB.prepare(`UPDATE member_requests SET status = 'confirmed', outcome = 'member',
      decided_by = ?, decided_name = ?, decided_at = ?
    WHERE team = ? AND email = ? AND status = 'open'`)
    .bind(by, name, at, clean(team), clean(email).toLowerCase()).run();
}
