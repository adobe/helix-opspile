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
 * Access requests of the integration's user-token hosts (portal migration 0006,
 * docs/PORTAL-INTEGRATION.md "Access requests"): what the customer portal's lobby requests are
 * for the standalone portal. A caller the host's identity provider verified, of a host that allows
 * the operation, who is not enrolled, is recorded (`captureAccess`): one row per (host, tenant,
 * subject), refreshed at most every 15 minutes, bounded per host and tenant. The inbox's admin
 * team lists them through `PortalPlatform` (`listAccess`), and approves one (`reserveAccess`, then
 * `enrollAccess`, with the inbox's routing rules in between) or declines it (`declineAccess`).
 *
 * Only a provider's verified caller gets here: a host signing its own assertions names its users
 * itself and keeps enrolling them by hand. Nothing here keeps a token. An approval creates a new
 * actor without an email for the subject: it never links an existing user of the portal, staff
 * or bot, and never moves a subject that has (or had) a member row.
 */

import { domainOf } from './ids.js';
import {
  memberOnHost, resolveChannel, verifiedEmail,
} from './integration-auto.js';

/** Unix seconds a pending request is refreshed after at the earliest. */
const REFRESH = 15 * 60;
/** After this long, a declined request is pending again on the person's next call. */
export const DECLINE_TTL = 30 * 24 * 60 * 60;
/** Bounds: pending per host, pending per tenant of a host, new per host per hour. */
const HOST_PENDING = 1000;
const TENANT_PENDING = 100;
const HOST_HOURLY = 120;
/** Decided requests are kept this long, and pending ones nobody repeated. */
const KEEP = 180 * 24 * 60 * 60;
const LIST = 200;

const clean = (v, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const iso = (s) => (Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : null);
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const fail = (error, status = 400) => ({ error, status });

/**
 * The channel a request's (or a caller's) tenant or verified address lands in on the host
 * (src/portal/integration-auto.js `resolveChannel`), and whether `subject` has a member row on
 * the host, in any channel and state.
 */
async function mappingOf(db, host, { tenant, email }, subject) {
  const [m, member] = await Promise.all([
    resolveChannel(db, host, { tenant, domain: email && domainOf(email) }),
    memberOnHost(db, host, subject),
  ]);
  return m || member ? { ...m, member: Boolean(member), mapped: Boolean(m) } : null;
}

/** A mapping an approval made and never enabled: approving again finishes it. */
const resumable = (m) => Boolean(m && !m.enabled && m.enabled_at === null && m.approved_by);

/**
 * Records (or refreshes) the access request of verified caller `c` (`{ tenant, sub, email,
 * email_verified, name }`) of `host`, who has no enabled membership: `{ request, reason? }` for
 * the error body (`pending`, `declined`), or null when nothing was recorded (a member row exists,
 * revoked or with another email; the bounds are reached). `organization(tenant)` is the
 * provider's name of the tenant, asked only when the row is written. `notify(id)` tells the inbox
 * of a request that is new or pending again.
 */
export async function captureAccess(env, host, c, {
  now = Date.now(), organization = async () => null, notify = () => {},
} = {}) {
  const db = env.DB;
  const sec = Math.floor(now / 1000);
  const email = verifiedEmail(c);
  const mapping = await mappingOf(db, host.id, { tenant: c.tenant, email }, c.sub);
  if (mapping && mapping.member) {
    // Revoked, or enrolled under another verified email: for a human, not for a request.
    return null;
  }
  // Without an organization (a personal profile) only a caught mail domain can place them.
  if (!c.tenant && !(mapping && mapping.mapped)) {
    return null;
  }
  const tenant = c.tenant || '';
  const row = await db.prepare(`SELECT id, status, seen_at, decided_at, reason
    FROM integration_requests WHERE host = ? AND tenant = ? AND subject = ?`)
    .bind(host.id, tenant, c.sub).first();
  if (row && row.status === 'approved') {
    // Its member row was removed by hand: the operator decides.
    return null;
  }
  if (row && row.status === 'declined' && row.decided_at > sec - DECLINE_TTL) {
    return { request: 'declined', ...(row.reason ? { reason: row.reason } : {}) };
  }
  if (row && row.status === 'pending' && row.seen_at > sec - REFRESH) {
    return { request: 'pending' };
  }
  const name = clean(c.name, 120) || null;
  const orgName = c.tenant ? clean(await organization(c.tenant).catch(() => null), 200) || null
    : null;
  if (row) {
    const again = row.status === 'declined';
    await db.prepare(`UPDATE integration_requests SET name = COALESCE(?2, name), email = ?3,
        org_name = COALESCE(?4, org_name), seen_at = ?5, attempts = attempts + 1,
        status = 'pending',
        requested_at = CASE WHEN status = 'declined' THEN ?5 ELSE requested_at END,
        decided_at = CASE WHEN status = 'declined' THEN NULL ELSE decided_at END,
        decided_by = CASE WHEN status = 'declined' THEN NULL ELSE decided_by END,
        decided_name = CASE WHEN status = 'declined' THEN NULL ELSE decided_name END,
        reason = CASE WHEN status = 'declined' THEN NULL ELSE reason END
      WHERE id = ?1 AND status = ?6`).bind(row.id, name, email, orgName, sec, row.status).run();
    if (again) {
      notify(row.id);
    }
    return { request: 'pending' };
  }
  // One atomic admission, as the nonces': within the bounds of the host and the tenant.
  const inserted = await db.prepare(`INSERT INTO integration_requests(host, tenant, subject, name,
      email, org_name, requested_at, seen_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7
    WHERE NOT EXISTS (SELECT 1 FROM integration_requests WHERE host = ?1 AND status = 'pending'
      LIMIT 1 OFFSET ${HOST_PENDING - 1})
    AND NOT EXISTS (SELECT 1 FROM integration_requests WHERE host = ?1 AND tenant = ?2
      AND status = 'pending' LIMIT 1 OFFSET ${TENANT_PENDING - 1})
    AND NOT EXISTS (SELECT 1 FROM integration_requests WHERE host = ?1 AND requested_at > ?7 - 3600
      LIMIT 1 OFFSET ${HOST_HOURLY - 1})
    ON CONFLICT DO NOTHING RETURNING id`)
    .bind(host.id, tenant, c.sub, name, email, orgName, sec).first();
  if (inserted) {
    notify(inserted.id);
    return { request: 'pending' };
  }
  // Another call of the same person won the race, or the bounds are reached.
  const raced = await db.prepare(`SELECT status FROM integration_requests WHERE host = ?
    AND tenant = ? AND subject = ?`).bind(host.id, tenant, c.sub).first();
  return raced && raced.status !== 'approved' ? { request: raced.status } : null;
}

/** A request row, as the inbox gets it: who asks, from where, and the tenant's mapping. */
function shape(r) {
  const mapping = r.m_channel ? {
    channel: r.m_channel,
    name: r.m_name,
    customer: r.m_customer,
    tenant: r.m_tenant,
    enabled: Boolean(r.m_enabled),
    resumable: resumable({
      enabled: r.m_enabled, enabled_at: r.m_enabled_at, approved_by: r.m_approved_by,
    }),
    autoApprove: Boolean(r.m_auto),
    // Who sees its threads: every member, or each their own (portal migration 0008).
    audience: r.m_audience || 'shared',
    // How the request lands in it: its tenant (null), an extra org ID, or a caught domain.
    via: r.m_via || null,
  } : null;
  return {
    id: r.id,
    host: r.host,
    product: r.product || null,
    tenant: r.tenant || null,
    orgName: r.org_name || null,
    subject: r.subject,
    name: r.name || null,
    email: r.email || null,
    status: r.status,
    requestedAt: iso(r.requested_at),
    seenAt: iso(r.seen_at),
    attempts: r.attempts,
    decidedAt: r.status === 'pending' ? null : iso(r.decided_at),
    decidedBy: r.status !== 'pending' && r.decided_by
      ? { email: r.decided_by, name: r.decided_name || null } : null,
    reason: r.status === 'declined' ? r.reason || null : null,
    channel: r.channel || null,
    mapping,
  };
}

// The channel each lands in, as `resolveChannel` finds it: the tenant's, an extra org ID's, else
// the verified address's domain's.
const SELECT = `SELECT r.*, h.product, c.channel AS m_channel, c.name AS m_name,
    c.customer AS m_customer, c.tenant AS m_tenant, c.enabled AS m_enabled,
    c.enabled_at AS m_enabled_at, c.approved_by AS m_approved_by, c.auto_approve AS m_auto,
    COALESCE((SELECT a.audience FROM channel_audiences a WHERE a.channel = c.channel), 'shared')
      AS m_audience,
    CASE WHEN c.tenant = r.tenant THEN NULL WHEN r.caught_org IS NOT NULL THEN 'org:' || r.tenant
      WHEN c.channel IS NOT NULL THEN 'domain:' || r.domain END AS m_via
  FROM (SELECT q.*, substr(q.email, instr(q.email, '@') + 1) AS domain,
      (SELECT k.channel FROM integration_catches k WHERE k.host = q.host AND k.kind = 'tenant'
        AND k.value = q.tenant) AS caught_org FROM integration_requests q) r
  JOIN integration_hosts h ON h.id = r.host
  LEFT JOIN integration_customers c ON c.channel = COALESCE(
    (SELECT o.channel FROM integration_customers o WHERE o.host = r.host AND o.tenant = r.tenant),
    r.caught_org,
    (SELECT k.channel FROM integration_catches k WHERE k.host = r.host AND k.kind = 'domain'
      AND k.value = r.domain))`;

async function requestById(db, id) {
  const r = await db.prepare(`${SELECT} WHERE r.id = ?`).bind(Number(id) || 0).first();
  return r ? shape(r) : null;
}

/**
 * `{ id? , count? }`: the access requests, the pending ones first (oldest first), then the latest
 * decided; with `id` that one (`{ ok, request }`), with `count` only how many wait.
 */
export async function listAccess(env, args = {}) {
  const db = env.DB;
  if (args.id !== undefined) {
    const request = await requestById(db, args.id);
    return request ? { ok: true, request } : fail('no such request', 404);
  }
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM integration_requests WHERE status = 'pending'")
    .first();
  if (args.count) {
    return { ok: true, pending: n };
  }
  const [pending, decided] = await Promise.all([
    db.prepare(`${SELECT} WHERE r.status = 'pending' ORDER BY r.requested_at, r.id LIMIT ?`)
      .bind(LIST).all(),
    db.prepare(`${SELECT} WHERE r.status != 'pending' ORDER BY r.decided_at DESC, r.id DESC LIMIT 100`)
      .all(),
  ]);
  return {
    ok: true,
    pending: n,
    requests: [...pending.results || [], ...decided.results || []].map(shape),
  };
}

const who = (by) => ({
  email: clean(by && by.email, 200).toLowerCase(), name: clean(by && by.name, 120) || null,
});

/** A pending request's row, or the answer that says why it cannot be decided. */
async function pendingRow(db, id) {
  const r = await requestById(db, id);
  if (!r) {
    return { error: fail('no such request', 404) };
  }
  if (r.status !== 'pending') {
    return { error: { ...fail(`this request is ${r.status} already`, 409), request: r } };
  }
  return { request: r };
}

const sec0 = (now) => Math.floor(now / 1000);

/** The statement that makes the mapping of request `r`'s tenant individual (migration 0008). */
const audienceOf = (db, r, by, sec) => db.prepare(`INSERT INTO channel_audiences (channel, audience,
    set_by, set_at) SELECT channel, 'individual', ?3, ?4 FROM integration_customers
    WHERE host = ?1 AND tenant = ?2 AND enabled = 0
  ON CONFLICT (channel) DO UPDATE SET audience = excluded.audience, set_by = excluded.set_by,
    set_at = excluded.set_at`).bind(r.host, r.tenant, by.email, sec);

/**
 * `{ id, customer, name, by, audience? }`: reserves the channel of a pending request's tenant,
 * which has no mapping on its host yet (`integration_customers`, disabled, with who approved it),
 * so the inbox files it before anyone can post. A mapping this flow reserved and never enabled is
 * answered as it is (approving again finishes it); an enabled one too (`existing`), for
 * `enrollAccess`.
 * With `audience: 'individual'` a new mapping (or one never enabled) is an individual channel
 * (portal migration 0008): each member sees only their own threads. An enabled one keeps its own.
 * `{ ok, channel: { id, name, audience? }, reserved, existing }`.
 */
export async function reserveAccess(env, args = {}, now = Date.now()) {
  const db = env.DB;
  const { request: r, error } = await pendingRow(db, args.id);
  if (error) {
    return error;
  }
  const by = who(args.by);
  if (!by.email) {
    return fail('say who approves: by { email, name }');
  }
  const m = r.mapping;
  if (!m && !r.tenant) {
    return fail('this person signed in without an organization: list their mail domain on a channel first', 409);
  }
  const individual = args.audience === 'individual';
  if (m) {
    if (!m.enabled && m.resumable && individual) {
      // Approving again what was reserved and never enabled: as the admin says now.
      await audienceOf(db, r, by, sec0(now)).run();
    }
    if (m.enabled || m.resumable) {
      return {
        ok: true, channel: { id: m.channel, name: m.name }, reserved: false, existing: m.enabled,
      };
    }
    return fail('this organization\'s channel on the host is suspended, or set up by hand: an operator enables it first', 409);
  }
  const name = clean(args.name, 80);
  const customer = clean(args.customer, 80);
  if (!SLUG.test(name) || !SLUG.test(customer)) {
    return fail('a channel name and a customer key are lowercase letters, digits and -');
  }
  const sec = Math.floor(now / 1000);
  for (let i = 0; i < 3; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const [made] = await db.batch([
        db.prepare(`INSERT INTO integration_customers(host, tenant, customer, name,
          approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING channel`)
          .bind(r.host, r.tenant, customer, name, by.email, sec),
        // With the mapping, before it is enabled: its first thread is already its author's alone.
        ...(individual ? [audienceOf(db, r, by, sec)] : []),
      ]);
      const row = made.results[0];
      // eslint-disable-next-line no-await-in-loop
      await db.prepare(`UPDATE integration_requests SET channel = ? WHERE id = ?
        AND status = 'pending'`).bind(row.channel, r.id).run();
      return {
        ok: true,
        channel: { id: row.channel, name, audience: individual ? 'individual' : 'shared' },
        reserved: true,
        existing: false,
      };
    } catch (e) {
      const msg = String(e.message || e);
      if (/integration_customers\.host, integration_customers\.customer/i.test(msg)) {
        return fail(`the host has a channel for customer ${customer} already: pick another name`, 409);
      }
      if (/integration_customers\.host, integration_customers\.tenant/i.test(msg)) {
        // Mapped meanwhile: answer that one.
        return reserveAccess(env, args, now);
      }
      if (!/channel in use|UNIQUE constraint failed: integration_customers\.channel/i.test(msg)) {
        throw e;
      }
      // A random channel ID taken already: draw another.
    }
  }
  return fail('could not reserve a channel; try again', 503);
}

/** The approval's one transaction: the claim, then the actor, the member and the enable. */
function enrollBatch(db, {
  r, m, actor, name, bound, by, sec, enable, mine,
}) {
  return db.batch([
    db.prepare(`UPDATE integration_requests SET status = 'approved', decided_at = ?, decided_by = ?,
        decided_name = ?, reason = NULL, channel = ?, actor = ? WHERE id = ? AND status = 'pending'`)
      .bind(sec, by.email, by.name, m.channel, actor, r.id),
    db.prepare(`INSERT INTO integration_actors(channel, actor, name, verified_email)
        SELECT ?3, ?2, ?4, ?5 WHERE ${mine}`)
      .bind(r.id, actor, m.channel, name, bound),
    db.prepare(`INSERT INTO integration_members(channel, subject, actor, approved_by, approved_at,
        via) SELECT ?3, ?4, ?2, ?5, ?6, ?7 WHERE ${mine}`)
      .bind(r.id, actor, m.channel, r.subject, by.email, sec, m.via),
    ...(enable ? [db.prepare(`UPDATE integration_customers SET enabled = 1 WHERE channel = ?3
        AND enabled = 0 AND enabled_at IS NULL AND approved_by IS NOT NULL AND ${mine}`)
      .bind(r.id, actor, m.channel)] : []),
  ]);
}

/**
 * `{ id, name, by, enable? }`: enrolls the person of pending request `id` in its tenant's channel
 * (a new actor, without an email, named `name`), records who approved it, and with `enable`
 * enables a mapping this flow reserved. A suspended mapping, or a subject with a member row,
 * is refused. One transaction, claimed by the request's status first. `{ ok, request, channel }`.
 */
export async function enrollAccess(env, args = {}, now = Date.now()) {
  const db = env.DB;
  const { request: r, error } = await pendingRow(db, args.id);
  if (error) {
    return error;
  }
  const by = who(args.by);
  const name = clean(args.name, 120);
  if (!by.email || !name) {
    return fail('say who approves (by { email, name }) and the name the person is shown by');
  }
  const m = await mappingOf(db, r.host, { tenant: r.tenant, email: r.email }, r.subject);
  if (!m || !m.mapped) {
    return fail('the organization has no channel on this host yet: reserve one first', 409);
  }
  if (m.member) {
    return fail('this person has a membership in the channel already (perhaps revoked): an operator decides', 409);
  }
  const enable = Boolean(args.enable) && resumable(m);
  if (!m.enabled && !enable) {
    return fail('this organization\'s channel on the host is suspended: an operator enables it first', 409);
  }
  const sec = Math.floor(now / 1000);
  const actor = `p${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')}`;
  // The claim first: everything after it happens only for this claim of this request.
  const mine = `EXISTS (SELECT 1 FROM integration_requests WHERE id = ?1 AND actor = ?2
    AND status = 'approved')`;
  // Placed by a caught domain: bound to that verified address, as an alias enrollment is.
  const bound = m.via && m.via.startsWith('domain:') ? r.email : null;
  let results;
  try {
    results = await enrollBatch(db, {
      r, m, actor, name, bound, by, sec, enable, mine,
    });
  } catch (e) {
    if (!/UNIQUE|enrolled on this host/i.test(String(e.message || e))) {
      throw e;
    }
    // Enrolled meanwhile, or their address is another actor's in the channel.
    return fail('this person, or their address, is in a channel of this host already: an operator decides', 409);
  }
  if (!results[0].meta.changes) {
    return { ...fail('decided meanwhile', 409), request: await requestById(db, r.id) };
  }
  console.log(JSON.stringify({ route: 'portal', integration: 'approved', enabled: enable }));
  return {
    ok: true,
    request: await requestById(db, r.id),
    channel: { id: m.channel, name: m.name, enabled: Boolean(m.enabled) || enable },
  };
}

/** `{ id, reason?, by }`: declines pending request `id`, with a reason the person is told. */
export async function declineAccess(env, args = {}, now = Date.now()) {
  const db = env.DB;
  const { request: r, error } = await pendingRow(db, args.id);
  if (error) {
    return error;
  }
  const by = who(args.by);
  if (!by.email) {
    return fail('say who declines: by { email, name }');
  }
  const { meta } = await db.prepare(`UPDATE integration_requests SET status = 'declined',
      decided_at = ?, decided_by = ?, decided_name = ?, reason = ? WHERE id = ? AND status = 'pending'`)
    .bind(Math.floor(now / 1000), by.email, by.name, clean(args.reason, 500) || null, r.id).run();
  if (!meta.changes) {
    return { ...fail('decided meanwhile', 409), request: await requestById(db, r.id) };
  }
  return { ok: true, request: await requestById(db, r.id) };
}

/** Old requests go: decided ones and pending ones nobody repeated, half a year on. Bounded. */
export function pruneAccess(db, sec) {
  return db.prepare(`DELETE FROM integration_requests WHERE id IN (SELECT id FROM
      integration_requests WHERE (status = 'pending' AND seen_at < ?1)
      OR (status != 'pending' AND decided_at < ?1) LIMIT 1000)`).bind(sec - KEEP);
}
