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

import { slug as toSlug } from './rules.js';
import { resolveTech, techMoves } from './catalog.js';
import { MAX_TECH_ID } from './techid.js';
import { announceRequest } from './requestkeys.js';

/**
 * Portal requests (migration 0074): what a customer's lobby in the customer portal asks for.
 * Its people signed in there with their work mail address, picked what they use of Adobe's
 * and asked for a channel. The portal tells how the lobby is now with every change (a `lobby`
 * event, src/normalize.js); `recordLobby` keeps the latest as one row per lobby.
 *
 * The admin team decides them in its inbox, where each is a thread (src/requestthreads.js): it
 * opens a channel (names it, files it under a team and a customer, shares it with more teams, and
 * writes the welcome message), or declines with a reason the customer reads. A team's managers see
 * the lobbies that picked a technology their team follows (`team_follows`), on their team's page,
 * and open a channel for their team. This module keeps the rows; src/admin.js routes them and opens
 * the channel.
 *
 * Status: `open` (waiting), `opened` (it has a channel), `declined`. The portal's lobby says
 * the same in its words (`requested`, `open`, `declined`), and its events move the row: a
 * lobby that asks again after a decline is open again.
 */

const STATUS = { requested: 'open', open: 'opened', declined: 'declined' };
const LIMIT = 100;

const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const stamp = (me) => [me.email || String(me.id), me.name || null, new Date().toISOString()];

const list = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/**
 * A lobby as the portal's event tells it (`{ portal, domain, seq, at, company, tech, note,
 * status, requestedBy, requestedAt, members }`): the row follows it, unless it has a later
 * event's already (a replay of pile 1, or two delivered out of order). Who decided it last
 * stays on the row, and is shown while it is decided. `{ result }`.
 */
export async function recordLobby(env, lobby) {
  const status = STATUS[lobby.status];
  if (!status || !lobby.domain) {
    return { result: 'skip', reason: `lobby ${lobby.status || 'without a status'}` };
  }
  const by = lobby.requestedBy || {};
  const members = (Array.isArray(lobby.members) ? lobby.members : []).slice(0, 500).map((m) => ({
    id: clean(m && m.id, 64),
    name: clean(m && m.name),
    email: clean(m && m.email).toLowerCase(),
    joined: Boolean(m && m.joined),
  }));
  // The portal keeps the ids a lobby picked: one from before a catalog move is the one it moved
  // to (src/catalog.js), so what the lobby picked stays followed.
  const moves = await techMoves(env);
  const tech = [...new Set((Array.isArray(lobby.tech) ? lobby.tech : [])
    .map((t) => resolveTech(clean(t, MAX_TECH_ID), moves)).filter(Boolean))].slice(0, 100);
  const { meta } = await env.DB.prepare(`INSERT INTO portal_requests (portal, domain, company,
      tech, note, members, requested_by, requested_name, requested_at, seq, status, logo)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
    ON CONFLICT (portal, domain) DO UPDATE SET company = excluded.company, tech = excluded.tech,
      logo = excluded.logo,
      note = excluded.note, members = excluded.members, requested_by = excluded.requested_by,
      requested_name = excluded.requested_name, requested_at = excluded.requested_at,
      seq = excluded.seq, status = excluded.status
    WHERE excluded.seq > portal_requests.seq`)
    .bind(
      clean(lobby.portal, 32) || 'portal',
      clean(lobby.domain).toLowerCase(),
      clean(lobby.company) || null,
      JSON.stringify(tech),
      clean(lobby.note, 2000) || null,
      JSON.stringify(members),
      clean(by.email).toLowerCase() || null,
      clean(by.name) || null,
      lobby.requestedAt || lobby.at || new Date().toISOString(),
      Number(lobby.seq) || 0,
      status,
      clean(lobby.logo, 64).replace(/[^a-z0-9]/gi, '') || null,
    ).run();
  // The admin team's inbox has it as a thread (src/requestthreads.js).
  if (meta.changes) {
    await announceRequest(env);
  }
  return { result: meta.changes ? 'lobby' : 'unchanged', status };
}

/** The teams that follow any of `tech` (ids): `[{ team, name, tech: [ids] }]`, by name. */
export async function teamsFor(env, tech) {
  const ids = [...new Set((tech || []).filter(Boolean))];
  if (!ids.length) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT f.team, t.name, f.tech FROM team_follows f
    JOIN teams t ON t.slug = f.team WHERE f.tech IN (SELECT value FROM json_each(?))
    ORDER BY t.name, f.tech`).bind(JSON.stringify(ids)).all();
  const by = new Map();
  for (const r of results || []) {
    const entry = by.get(r.team)
      || by.set(r.team, { team: r.team, name: r.name, tech: [] }).get(r.team);
    entry.tech.push(r.tech);
  }
  return [...by.values()];
}

/** The customer a lobby is, when the inbox knows one already: by its slug, or null. */
async function knownOrg(env, r) {
  // An org shown with the domain's favicon, or one named as the lobby's company or its domain.
  const first = r.domain.split('.')[0];
  const row = await env.DB.prepare(`SELECT slug, name FROM orgs WHERE LOWER(icon) = ?1
      OR slug = ?2 OR slug = ?3 OR LOWER(name) = LOWER(?4) ORDER BY LOWER(icon) = ?1 DESC LIMIT 1`)
    .bind(r.domain, toSlug(r.company || first), toSlug(first), r.company || first).first();
  return row || null;
}

/** A request row as the API answers it. `names` are the technologies' names, by id. */
async function shape(env, r, names) {
  const tech = list(r.tech);
  const org = await knownOrg(env, r);
  const first = r.domain.split('.')[0];
  return {
    id: r.id,
    portal: r.portal,
    domain: r.domain,
    company: r.company || null,
    tech: tech.map((id) => ({ tech: id, name: names.get(id) || id })),
    note: r.note || null,
    // The customer's logo, where they uploaded one: through the portal's Worker.
    logo: r.logo ? `/api/portal/logo/${r.domain}?v=${r.logo}` : null,
    members: list(r.members),
    requestedBy: { email: r.requested_by, name: r.requested_name },
    requestedAt: r.requested_at,
    status: r.status,
    // A lobby that asked again after a decline waits: the last decision is not this one's.
    decidedBy: r.status !== 'open' && r.decided_by ? { email: r.decided_by, name: r.decided_name } : null,
    decidedAt: r.status !== 'open' ? r.decided_at : null,
    reason: r.status === 'declined' ? r.reason || null : null,
    channel: r.channel_id ? {
      source: 'portal', tenant: r.domain, channelId: r.channel_id, team: r.team, org: r.org,
    } : null,
    // Who it may be for: the teams that follow what the lobby picked.
    teams: await teamsFor(env, tech),
    // What opening it would start from: a name for the channel, and the customer.
    suggest: {
      name: toSlug(r.company || first),
      org: org ? org.slug : toSlug(r.company || first),
      orgName: org ? org.name || org.slug : r.company || null,
      known: Boolean(org),
    },
  };
}

async function techNames(env) {
  const { results } = await env.DB.prepare(`SELECT tech, name FROM tech_stack
    ORDER BY team = 'admin' DESC, team`).all();
  const names = new Map();
  for (const r of results || []) {
    if (!names.has(r.tech)) {
      names.set(r.tech, r.name);
    }
  }
  return names;
}

/** One request, shaped, or null. */
export async function getPortalRequest(env, id) {
  const r = await env.DB.prepare('SELECT * FROM portal_requests WHERE id = ?')
    .bind(Number(id) || 0).first();
  return r ? shape(env, r, await techNames(env)) : null;
}

/**
 * The requests, the waiting ones first (oldest first), then the decided ones, latest first.
 * `teams` (slugs) limits them to the lobbies that picked a technology one of them follows:
 * what a manager of those teams sees. Null: every request, the admin team's.
 */
export async function listPortalRequests(env, { teams = null, limit = LIMIT } = {}) {
  const { results } = await env.DB.prepare(`SELECT r.* FROM portal_requests r
    WHERE ?1 IS NULL OR EXISTS (SELECT 1 FROM json_each(r.tech) j JOIN team_follows f
      ON f.tech = j.value WHERE f.team IN (SELECT value FROM json_each(?1)))
    ORDER BY r.status = 'open' DESC,
      CASE WHEN r.status = 'open' THEN r.requested_at END ASC,
      COALESCE(r.decided_at, r.requested_at) DESC, r.id DESC LIMIT ?2`)
    .bind(teams ? JSON.stringify(teams) : null, limit).all();
  const names = await techNames(env);
  return Promise.all((results || []).map((r) => shape(env, r, names)));
}

/** How many requests wait: every one, or those `teams` (slugs) may open. */
export async function portalOpenCount(env, teams = null) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM portal_requests r
    WHERE r.status = 'open' AND (?1 IS NULL OR EXISTS (SELECT 1 FROM json_each(r.tech) j
      JOIN team_follows f ON f.tech = j.value WHERE f.team IN (SELECT value FROM json_each(?1))))`)
    .bind(teams ? JSON.stringify(teams) : null).first();
  return r ? r.n : 0;
}

/**
 * Says that request `id` has a channel now: who opened it, and where it is filed. A request
 * that had one keeps the latest.
 */
export async function recordOpened(env, me, id, { channelId, team, org }) {
  const [by, name, at] = stamp(me);
  await env.DB.prepare(`UPDATE portal_requests SET status = 'opened', decided_by = ?,
      decided_name = ?, decided_at = ?, reason = NULL, channel_id = ?, team = ?, org = ?
    WHERE id = ?`).bind(by, name, at, channelId, team, org, Number(id)).run();
  return getPortalRequest(env, id);
}

/**
 * Declines open request `id`, with a reason for the customer: whether this call did, or
 * someone decided it first.
 */
export async function recordDeclined(env, me, id, reason) {
  const [by, name, at] = stamp(me);
  const { meta } = await env.DB.prepare(`UPDATE portal_requests SET status = 'declined',
      decided_by = ?, decided_name = ?, decided_at = ?, reason = ? WHERE id = ? AND status = 'open'`)
    .bind(by, name, at, clean(reason, 500) || null, Number(id)).run();
  return meta.changes > 0;
}

/** Opens declined request `id` again, when the portal did not take the decline. */
export async function reopenDeclined(env, id) {
  await env.DB.prepare(`UPDATE portal_requests SET status = 'open', decided_by = NULL,
      decided_name = NULL, decided_at = NULL, reason = NULL WHERE id = ? AND status = 'declined'`)
    .bind(Number(id)).run();
}
