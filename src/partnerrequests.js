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
import { announceRequest } from './requestkeys.js';
import { isAdmin } from './roles.js';

/**
 * Requests to decide a pair of a customer and a partner (migration 0112, `org_partner_requests`):
 * that the partner works for the customer (`link`, from `since`), or no longer does (`end`, until
 * `until`). Each is a thread of the admin team's inbox (src/requestthreads.js, `partner`), whose
 * actions decide the pair through src/orgpartners.js (`decidePartner`, `endPartner`), which
 * closes the pair's open requests it settles. Nothing changes a pair until then.
 *
 * Who asks: the admin team, on the pair's page in Customers; anyone on an ops team through the API
 * (`requestPartner`; what it answers them leaves the admin team's evidence out, `requestFor`) or
 * an agent: a thread's agent
 * (`request_partner_link`, src/agent/partnerrequest.js), on its own from what a thread says, or for
 * the person in its sidebar; and Clef, from the pairs' sync (src/orgpartners.js): a likely pair
 * nobody decided, a confirmed one whose people stopped posting while the customer's go on, an ended
 * one whose people post again. Clef's requests carry the `fingerprint` of what they were found on:
 * one the admin team declined is not asked again until that changes, and Clef takes back its own
 * once the pair is no longer what it asked about.
 */

/** Who asked, when it was not a person: the requests' `requested_by`. */
export const CLEF_BY = 'clef';
export const AGENT_BY = 'agent';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_NOTE = 1000;
/** A date as the requests and the pairs take it: a day, or a month. */
const DATE = /^(\d{4})-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;

const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n);

async function rows(env, sql, ...args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

/**
 * A date as given (`2026-10`, `2026-10-24`, or an ISO time, whose day it takes), `null` for none,
 * or `undefined` for one that is no date.
 */
export function dateOf(v) {
  const s = clean(v, 40);
  if (!s) {
    return null;
  }
  const day = /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
  return DATE.test(day) ? day : undefined;
}

/** Who asked, as the threads say it: a person, an agent (for a person, or on its own), Clef. */
function askerOf(r) {
  if (r.requested_by === CLEF_BY) {
    return { kind: 'clef', email: null, name: 'Clef' };
  }
  if (r.requested_by === AGENT_BY) {
    return { kind: 'agent', email: null, name: r.requested_name || 'A thread\'s agent' };
  }
  return { kind: 'person', email: r.requested_by, name: r.requested_name || null };
}

/** A request's row as the lists give it, with the pair as it is now (`pair`), when read with it. */
export const requestOf = (r) => ({
  id: r.id,
  customer: r.customer,
  partner: r.partner,
  action: r.action,
  since: r.since || null,
  until: r.until || null,
  note: r.note || null,
  thread: r.thread || null,
  threadTeam: r.thread_team || null,
  fingerprint: r.fingerprint || null,
  requestedBy: askerOf(r),
  requestedAt: r.requested_at,
  // Through the agent, for a person: their address, and the thread they asked in.
  viaAgent: r.requested_by !== AGENT_BY && r.requested_by !== CLEF_BY && Boolean(r.thread),
  status: r.status,
  decidedBy: r.decided_by ? { email: r.decided_by } : null,
  decidedAt: r.decided_at || null,
  reason: r.reason || null,
  ...(r.pair_customer !== undefined ? {
    pair: r.pair_customer ? {
      confirmed: r.confirmed_at ? { by: r.confirmed_by, at: r.confirmed_at } : null,
      dismissed: r.dismissed_at ? { by: r.dismissed_by, at: r.dismissed_at } : null,
      since: r.pair_since || null,
      until: r.pair_until || null,
      first: r.first_at || null,
      last: r.last_at || null,
      p: r.p ?? null,
      signals: (() => {
        try {
          return JSON.parse(r.signals || '[]');
        } catch {
          return [];
        }
      })(),
    } : null,
  } : {}),
});

/**
 * A request as `me` may read it: the admin team all of it; anyone else without the pair's signals
 * (their text names domains, site owners and knowledge-base entries, the admin team's only), and
 * without Clef's note (which says them) and fingerprint.
 */
export function requestFor(me, r) {
  if (!r || isAdmin(me)) {
    return r;
  }
  const rest = { ...r };
  delete rest.fingerprint;
  // Clef's note says what it found, in the signals' words.
  if (rest.requestedBy && rest.requestedBy.kind === 'clef') {
    rest.note = null;
  }
  if (rest.pair) {
    rest.pair = { ...rest.pair };
    delete rest.pair.signals;
  }
  return rest;
}

/** The requests, with the pair as it is now and the team of the thread they were asked from. */
const SELECT = `SELECT q.*, x.customer AS pair_customer, x.confirmed_by, x.confirmed_at,
    x.dismissed_by, x.dismissed_at, x.since AS pair_since, x.until AS pair_until, x.first_at,
    x.last_at, x.p, x.signals, t.team AS thread_team
  FROM org_partner_requests q
  LEFT JOIN org_partners x ON x.customer = q.customer AND x.partner = q.partner
  LEFT JOIN threads t ON t.thread = q.thread`;

/**
 * The partner requests, open ones first and then the latest decided (`limit`): every one for the
 * admin team, `me`'s own for anyone else.
 */
export async function listPartnerRequests(env, me, { limit = 50 } = {}) {
  const mine = isAdmin(me) ? null : String(me.email || '');
  const list = await rows(env, `${SELECT} WHERE (?1 IS NULL OR q.requested_by = ?1)
    ORDER BY q.status = 'open' DESC, COALESCE(q.decided_at, q.requested_at) DESC LIMIT ?2`, mine, limit);
  return list.map(requestOf);
}

/** Partner request `id`, as the lists give it, or null. */
export async function getPartnerRequest(env, id) {
  const r = await env.DB.prepare(`${SELECT} WHERE q.id = ?`).bind(Number(id) || 0).first();
  return r ? requestOf(r) : null;
}

/** The requests of one pair, the latest first (`limit`). */
export async function pairRequests(env, customer, partner, { limit = 20 } = {}) {
  const list = await rows(env, `${SELECT} WHERE q.customer = ?1 AND q.partner = ?2
    ORDER BY q.status = 'open' DESC, q.requested_at DESC LIMIT ?3`, customer, partner, limit);
  return list.map(requestOf);
}

/** The requests that wait, by pair (`customer\npartner`): `Map<key, [{ id, action }]>`. */
export async function openRequestsByPair(env) {
  const list = await rows(env, `SELECT id, customer, partner, action FROM org_partner_requests
    WHERE status = 'open' ORDER BY id`);
  const by = new Map();
  for (const r of list) {
    const key = `${r.customer}\n${r.partner}`;
    by.set(key, [...(by.get(key) || []), { id: r.id, action: r.action }]);
  }
  return by;
}

/** How many partner requests wait for the admin team. */
export async function openPartnerCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM org_partner_requests WHERE status = 'open'").first();
  return (row && row.n) || 0;
}

/**
 * The other partners of each customer the requests are of, for their threads: `Map<customer,
 * [{ slug, name, confirmed, until, first, last, p }]>`, confirmed or likely and not dismissed.
 */
export async function otherPartners(env, customers, likely) {
  if (!customers.length) {
    return new Map();
  }
  const list = await rows(env, `SELECT x.customer, x.partner, o.name, x.confirmed_at, x.until,
      x.first_at, x.last_at, x.p
    FROM org_partners x LEFT JOIN orgs o ON o.slug = x.partner
    WHERE x.customer IN (SELECT value FROM json_each(?1)) AND x.dismissed_at IS NULL
      AND (x.confirmed_at IS NOT NULL OR x.p >= ?2)
      AND x.partner NOT IN (SELECT slug FROM org_merges)
    ORDER BY x.confirmed_at IS NULL, x.until IS NOT NULL, x.partner`, JSON.stringify(customers), likely);
  const by = new Map();
  for (const r of list) {
    by.set(r.customer, [...(by.get(r.customer) || []), {
      slug: r.partner,
      name: r.name || null,
      confirmed: Boolean(r.confirmed_at),
      until: r.until || null,
      first: r.first_at || null,
      last: r.last_at || null,
      p: r.p ?? null,
    }]);
  }
  return by;
}

/**
 * Whether `customer` and `partner` may be a pair: both orgs the inbox knows, not merged, the one
 * no partner and the other one. `{ c, p }` (their `orgs` rows, `null` without one), or `{ error,
 * status }`.
 */
async function knownPair(env, customer, partner) {
  if (!SLUG.test(customer) || !SLUG.test(partner) || customer === partner) {
    return { error: 'give two orgs, customer and partner', status: 400 };
  }
  const k = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM org_merges WHERE slug IN (?1, ?2)) AS merged,
      (SELECT type FROM orgs WHERE slug = ?1) AS ctype, (SELECT 1 FROM orgs WHERE slug = ?1) AS c,
      (SELECT 1 FROM threads WHERE org = ?1 LIMIT 1) AS ct,
      (SELECT type FROM orgs WHERE slug = ?2) AS ptype, (SELECT 1 FROM orgs WHERE slug = ?2) AS p`)
    .bind(customer, partner).first();
  if (!k || k.merged || !(k.c || k.ct) || !k.p) {
    return { error: 'no such org, or it was merged', status: 404 };
  }
  if (k.ptype !== 'partner') {
    return { error: `${partner} is no partner (its type is ${k.ptype || 'customer'}): change its type on its page first`, status: 409 };
  }
  if ((k.ctype || 'customer') !== 'customer') {
    return { error: `${customer} is no customer (its type is ${k.ctype})`, status: 409 };
  }
  return { ok: true };
}

/**
 * Files a request: `by` is a person (`{ email, name }`), an agent (`{ agent: true, name }`, its
 * own) or Clef (`{ clef: true }`); `body` `{ customer, partner, action, since?, until?, note? }`;
 * `thread`, the thread it was asked from (an agent's), and `fingerprint`, Clef's. `{ request }`,
 * or `{ error, status, request? }` (the open one that asks the same).
 */
export async function createPartnerRequest(env, by, body, {
  thread = null, fingerprint = null,
} = {}) {
  const customer = clean(body.customer).toLowerCase();
  const partner = clean(body.partner).toLowerCase();
  const action = clean(body.action);
  if (!['link', 'end'].includes(action)) {
    return { error: 'give an action: link (works for them) or end (no longer does)', status: 400 };
  }
  const known = await knownPair(env, customer, partner);
  if (known.error) {
    return known;
  }
  const since = action === 'link' ? dateOf(body.since) : null;
  const until = action === 'end' ? dateOf(body.until) : null;
  if (since === undefined || until === undefined) {
    return { error: 'give a date as 2026-10 or 2026-10-24', status: 400 };
  }
  const pair = await env.DB.prepare('SELECT * FROM org_partners WHERE customer = ? AND partner = ?')
    .bind(customer, partner).first();
  if (action === 'link' && pair && pair.confirmed_at && !pair.until) {
    return { error: `${partner} is confirmed as a partner of ${customer} already`, status: 409 };
  }
  if (action === 'end' && pair && pair.until) {
    return { error: `${partner} is a former partner of ${customer} already, until ${pair.until}`, status: 409 };
  }
  const open = await env.DB.prepare(`${SELECT} WHERE q.status = 'open' AND q.customer = ? AND q.partner = ?
    AND q.action = ?`).bind(customer, partner, action).first();
  if (open) {
    return { error: 'the same was asked for already', status: 409, request: requestOf(open) };
  }
  let who = by.email ? String(by.email).toLowerCase() : null;
  if (by.clef) {
    who = CLEF_BY;
  } else if (by.agent) {
    who = AGENT_BY;
  }
  if (!who) {
    return { error: 'nobody asked', status: 400 };
  }
  const r = await env.DB.prepare(`INSERT INTO org_partner_requests (customer, partner, action, since,
      until, note, thread, fingerprint, requested_by, requested_name, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`)
    .bind(
      customer,
      partner,
      action,
      since,
      until,
      clean(body.note, MAX_NOTE) || null,
      thread || null,
      fingerprint || null,
      who,
      by.clef ? null : clean(by.name) || null,
      new Date().toISOString(),
    ).first();
  if (!r) {
    // Asked at the same time by someone else.
    return { error: 'the same was asked for already', status: 409 };
  }
  console.log(JSON.stringify({
    route: 'partnerrequests', request: 'created', action, by: who === CLEF_BY || who === AGENT_BY ? who : 'person', id: r.id,
  }));
  if (!by.clef) {
    await announceRequest(env, 'partner', r.id);
  }
  return { request: await getPartnerRequest(env, r.id) };
}

/**
 * POST /api/admin/org-partner-requests `{ customer, partner, action, since?, until?, note? }`:
 * anyone on an ops team asks the admin team to decide a pair (`createPartnerRequest`).
 */
export async function requestPartner(env, me, body) {
  if (!isAdmin(me) && !(me.teams || []).length) {
    return json({ error: 'for the people on an ops team' }, 403);
  }
  const asker = { email: me.email || String(me.id), name: me.name };
  const res = await createPartnerRequest(env, asker, body);
  return res.error
    ? json({
      error: res.error, ...(res.request ? { request: requestFor(me, res.request) } : {}),
    }, res.status)
    : json({ ok: true, request: requestFor(me, res.request) });
}

/**
 * DELETE /api/admin/org-partner-requests `{ id }`: whoever asked takes it back (the admin team may
 * too). POST /api/admin/org-partner-requests/decline `{ id, reason? }`: the admin team turns it
 * down, and the pair stays as it is.
 */
export async function closePartnerRequest(env, me, body, status) {
  const id = Number(body.id);
  const r = await getPartnerRequest(env, id);
  if (!r) {
    return json({ error: 'no such request' }, 404);
  }
  if (status === 'withdrawn' && r.requestedBy.email !== String(me.email || '').toLowerCase() && !isAdmin(me)) {
    return json({ error: 'only whoever asked takes a request back' }, 403);
  }
  const { meta } = await env.DB.prepare(`UPDATE org_partner_requests SET status = ?, decided_by = ?,
      decided_at = ?, reason = ? WHERE id = ? AND status = 'open'`)
    .bind(
      status,
      String(me.email || me.id),
      new Date().toISOString(),
      status === 'declined' ? clean(body.reason, MAX_NOTE) || null : null,
      id,
    ).run();
  const now = requestFor(me, await getPartnerRequest(env, id));
  if (!meta.changes) {
    return json({ error: `this request is ${now.status} already`, request: now }, 409);
  }
  console.log(JSON.stringify({
    route: 'partnerrequests', request: status, by: me.id, id,
  }));
  await announceRequest(env, 'partner', id);
  return json({ ok: true, request: now });
}

/**
 * Closes the open requests of a pair that a decision settles: `actions` (`link`, `end`) with
 * `status`, by `by` (an address, or Clef's). Their ids.
 */
export async function settleRequests(env, by, customer, partner, actions, status) {
  const list = await rows(
    env,
    `UPDATE org_partner_requests SET status = ?1, decided_by = ?2, decided_at = ?3
      WHERE status = 'open' AND customer = ?4 AND partner = ?5
        AND action IN (SELECT value FROM json_each(?6)) RETURNING id`,
    status,
    by,
    new Date().toISOString(),
    customer,
    partner,
    JSON.stringify(actions),
  );
  for (const { id } of list) {
    // eslint-disable-next-line no-await-in-loop
    await announceRequest(env, 'partner', id);
  }
  return list.map((r) => r.id);
}

/**
 * Clef's requests now (`wants`, `[{ customer, partner, action, since?, until?, note,
 * fingerprint }]`, from the pairs' sync): each filed unless the same waits, or the admin team
 * declined one of Clef's on the same `fingerprint` (or Clef took it back); and Clef's open ones of
 * the pairs it wants no more taken back (`withdrawn`, with why). How many it filed and took back.
 * One announcement for all.
 */
export async function clefRequests(env, wants) {
  const mine = await rows(env, `SELECT id, customer, partner, action, status, fingerprint
    FROM org_partner_requests WHERE requested_by = ?1`, CLEF_BY);
  const keyOf = (x) => `${x.customer}\n${x.partner}\n${x.action}`;
  const open = new Map();
  const declined = new Set();
  for (const r of mine) {
    if (r.status === 'open') {
      open.set(keyOf(r), r);
    } else if (['declined', 'withdrawn'].includes(r.status) && r.fingerprint) {
      declined.add(`${keyOf(r)}\n${r.fingerprint}`);
    }
  }
  const wanted = new Set(wants.map(keyOf));
  let filed = 0;
  for (const w of wants) {
    if (!open.has(keyOf(w)) && !declined.has(`${keyOf(w)}\n${w.fingerprint}`)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await createPartnerRequest(env, { clef: true }, w, {
        fingerprint: w.fingerprint,
      });
      filed += res.request ? 1 : 0;
    }
  }
  let withdrawn = 0;
  for (const [key, r] of open) {
    if (!wanted.has(key)) {
      // eslint-disable-next-line no-await-in-loop
      const { meta } = await env.DB.prepare(`UPDATE org_partner_requests SET status = 'withdrawn',
          decided_by = ?, decided_at = ?, reason = ? WHERE id = ? AND status = 'open'`)
        .bind(CLEF_BY, new Date().toISOString(), 'Clef no longer finds it so', r.id).run();
      withdrawn += meta.changes ? 1 : 0;
    }
  }
  if (filed || withdrawn) {
    await announceRequest(env);
  }
  return { filed, withdrawn };
}
