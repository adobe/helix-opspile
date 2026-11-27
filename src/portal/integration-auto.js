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

import { domainOf, domainParts, isPublicMail } from './ids.js';

/**
 * Auto-approval of the integration's user-token hosts (portal migration 0007,
 * docs/PORTAL-INTEGRATION.md "Auto-approval"): which channel of a host a verified caller lands in
 * (`resolveChannel`: their tenant's own channel, a channel that lists their org ID, else one that
 * lists their provider-verified mail domain, exactly), and enrolling them there on their first
 * call when the admin team marked that channel auto-approving (`autoEnroll`), within a cap an hour.
 * `listChannels` and `setAuto` are the admin team's, through `PortalPlatform`.
 *
 * An auto-approval is an enrollment as an approval makes one: a new actor for the subject only
 * (bound to the verified address when a domain caught them), never an existing user, staff or
 * bot, never a subject with a member row on the host. Nothing here enables a channel.
 */

/** Auto-enrollments per channel per hour; beyond, the caller gets a pending request. */
export const AUTO_HOURLY = 30;
/** Extra org IDs and domains per channel. */
const MAX_CATCHES = 50;
/** An IMS organization ID, as a profile's `ownerOrg` is. */
export const ORG_ID = /^[A-Za-z0-9]{1,64}@AdobeOrg$/;

const clean = (v, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const iso = (s) => (Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : null);
const fail = (error, status = 400) => ({ error, status });

/** The provider-verified address of caller `c`, lower case, or null. */
export const verifiedEmail = (c) => (c.email_verified === true && typeof c.email === 'string'
  && c.email.length <= 254 && domainOf(c.email) ? c.email.trim().toLowerCase() : null);

/**
 * The channel of `host` a caller lands in: the one of their tenant, else the one listing their
 * tenant as an extra org ID, else (only then) the one listing their verified mail `domain`.
 * `{ channel, name, customer, tenant, enabled, enabled_at, approved_by, auto_approve, auto_by,
 * via, ruleBy }`: `via` null for the channel's own tenant, `org:<id>` or `domain:<d>`;
 * `ruleBy` who set the rule that matched. Null when none.
 */
export async function resolveChannel(db, host, { tenant, domain }) {
  const cols = `c.channel, c.name, c.customer, c.tenant, c.enabled, c.enabled_at, c.approved_by,
    c.auto_approve, c.auto_by`;
  return db.prepare(`SELECT * FROM (
      SELECT ${cols}, 0 AS rank, NULL AS via, c.auto_by AS ruleBy FROM integration_customers c
        WHERE c.host = ?1 AND c.tenant = ?2
      UNION ALL SELECT ${cols}, 1, 'org:' || k.value, k.added_by FROM integration_catches k
        JOIN integration_customers c ON c.channel = k.channel
        WHERE k.host = ?1 AND k.kind = 'tenant' AND k.value = ?2
      UNION ALL SELECT ${cols}, 2, 'domain:' || k.value, k.added_by FROM integration_catches k
        JOIN integration_customers c ON c.channel = k.channel
        WHERE k.host = ?1 AND k.kind = 'domain' AND k.value = ?3
    ) ORDER BY rank LIMIT 1`).bind(host, tenant || '', domain || '').first();
}

/** The channel `subject` is a member of on `host` (any state), or null. */
export async function memberOnHost(db, host, subject) {
  return db.prepare(`SELECT m.channel, m.active FROM integration_members m
    JOIN integration_customers c ON c.channel = m.channel WHERE c.host = ? AND m.subject = ?
    LIMIT 1`).bind(host, subject).first();
}

/**
 * Enrolls verified caller `c` of `host` on their first call, when the channel they land in is
 * enabled and auto-approving and its cap allows: a new actor named as the provider names them
 * (bound to their verified address when a domain caught them), a member recorded as auto-approved,
 * with the rule that matched (`via`) and who set it (`approved_by`), and their pending request, if
 * any, approved. All in one batch, each step conditional on the one before, so a channel turned
 * off meanwhile, or a full hour, enrolls nobody. Whether it did.
 */
export async function autoEnroll(env, host, c, { now = Date.now(), notify = () => {} } = {}) {
  const db = env.DB;
  const email = verifiedEmail(c);
  const domain = email && domainOf(email);
  const m = await resolveChannel(db, host.id, { tenant: c.tenant, domain });
  if (!m || !m.enabled || !m.auto_approve || !m.ruleBy) {
    return false;
  }
  if (await memberOnHost(db, host.id, c.sub)) {
    return false;
  }
  const sec = Math.floor(now / 1000);
  const actor = `p${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')}`;
  const name = clean(c.name, 120) || (email ? email.split('@')[0] : '') || 'Customer';
  const bound = m.via && m.via.startsWith('domain:') ? email : null;
  let results;
  try {
    results = await db.batch([
      db.prepare(`INSERT INTO integration_actors(channel, actor, name, verified_email)
        SELECT ?1, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM integration_customers WHERE channel = ?1
          AND enabled = 1 AND auto_approve = 1)
        AND (SELECT COUNT(*) FROM integration_members WHERE channel = ?1 AND auto = 1
          AND approved_at > ?2 - 3600) < ${AUTO_HOURLY}`)
        .bind(m.channel, sec, actor, name, bound),
      db.prepare(`INSERT INTO integration_members(channel, subject, actor, approved_by, approved_at,
          via, auto) SELECT ?1, ?2, ?3, ?4, ?5, ?6, 1
        WHERE EXISTS (SELECT 1 FROM integration_actors WHERE channel = ?1 AND actor = ?3)`)
        .bind(m.channel, c.sub, actor, m.ruleBy, sec, m.via),
      db.prepare(`UPDATE integration_requests SET status = 'approved', decided_at = ?4,
          decided_by = ?5, decided_name = 'auto-approved', reason = NULL, channel = ?6, actor = ?7
        WHERE host = ?1 AND tenant = ?2 AND subject = ?3 AND status != 'approved'
          AND EXISTS (SELECT 1 FROM integration_members WHERE channel = ?6 AND actor = ?7)`)
        .bind(host.id, c.tenant || '', c.sub, sec, m.ruleBy, m.channel, actor),
    ]);
  } catch {
    // Their verified address is another actor's in the channel, or the subject was enrolled
    // meanwhile: for a human, as a pending request.
    return false;
  }
  if (!results[1].meta.changes) {
    return false;
  }
  console.log(JSON.stringify({ route: 'portal', integration: 'auto-approved', via: m.via ? m.via.split(':')[0] : 'tenant' }));
  notify({ channel: m.channel });
  return true;
}

/** A channel as the admin team gets it. */
function shapeChannel(c, catches, members) {
  return {
    channel: c.channel,
    host: c.host,
    product: c.product || null,
    tenant: c.tenant,
    name: c.name,
    customer: c.customer,
    enabled: Boolean(c.enabled),
    enabledAt: iso(c.enabled_at),
    approvedBy: c.approved_by || null,
    approvedAt: iso(c.approved_at),
    // Who sees its threads: every member (`shared`), or each their own (`individual`).
    audience: c.audience || 'shared',
    audienceBy: c.audience_by || null,
    audienceAt: iso(c.audience_at),
    // Whom "shared" means, as `GET /threads` names it (`audienceName`): the admin team's name,
    // else the provider's of its tenant, recorded at approval.
    orgName: c.org_name || null,
    audienceName: c.audience_name || null,
    audienceNameBy: c.audience_name_by || null,
    audienceNameAt: iso(c.audience_name_at),
    shownName: c.audience_name || c.org_name || null,
    autoApprove: Boolean(c.auto_approve),
    autoBy: c.auto_by || null,
    autoAt: iso(c.auto_at),
    tenants: catches.filter((k) => k.kind === 'tenant').map((k) => ({ value: k.value, by: k.added_by, at: iso(k.added_at) })),
    domains: catches.filter((k) => k.kind === 'domain').map((k) => ({ value: k.value, by: k.added_by, at: iso(k.added_at) })),
    members: c.members,
    autoMembers: c.auto_members,
    autoLastHour: c.auto_hour,
    autoHourly: AUTO_HOURLY,
    // The latest auto-approved members: nobody joins without the admin team seeing it.
    autoApproved: members.map((x) => ({
      name: x.name, email: x.verified_email || null, via: x.via || 'tenant', by: x.approved_by, at: iso(x.approved_at), active: Boolean(x.active),
    })),
  };
}

/**
 * `{ channel? }`: the channels of the hosts with an identity provider, with their auto-approval,
 * what else they catch, and their members (`{ ok, channels }`); with `channel` that one.
 */
export async function listChannels(env, args = {}, now = Date.now()) {
  const db = env.DB;
  const one = clean(args.channel, 20) || null;
  const sec = Math.floor(now / 1000);
  const [channels, catches, members] = await Promise.all([
    db.prepare(`SELECT c.*, h.product, COALESCE(ca.audience, 'shared') AS audience,
        ca.set_by AS audience_by, ca.set_at AS audience_at,
        (SELECT COUNT(*) FROM integration_members m WHERE m.channel = c.channel AND m.active = 1) AS members,
        (SELECT COUNT(*) FROM integration_members m WHERE m.channel = c.channel AND m.auto = 1) AS auto_members,
        (SELECT COUNT(*) FROM integration_members m WHERE m.channel = c.channel AND m.auto = 1
          AND m.approved_at > ?2 - 3600) AS auto_hour
      FROM integration_customers c JOIN integration_hosts h ON h.id = c.host
      LEFT JOIN channel_audiences ca ON ca.channel = c.channel
      WHERE h.identity IS NOT NULL AND (?1 IS NULL OR c.channel = ?1) ORDER BY c.host, c.name LIMIT 500`)
      .bind(one, sec).all(),
    db.prepare(`SELECT * FROM integration_catches WHERE ?1 IS NULL OR channel = ?1
      ORDER BY kind, value`).bind(one).all(),
    db.prepare(`SELECT m.channel, m.via, m.approved_by, m.approved_at, m.active, u.name,
        a.verified_email FROM integration_members m JOIN users u ON u.id = m.actor
      JOIN integration_actors a ON a.channel = m.channel AND a.actor = m.actor
      WHERE m.auto = 1 AND (?1 IS NULL OR m.channel = ?1) ORDER BY m.approved_at DESC LIMIT 500`)
      .bind(one).all(),
  ]);
  const by = (rows, channel) => (rows.results || []).filter((r) => r.channel === channel);
  const list = (channels.results || []).map((c) => shapeChannel(
    c,
    by(catches, c.channel),
    by(members, c.channel).slice(0, 50),
  ));
  if (one) {
    return list[0] ? { ok: true, channel: list[0] } : fail('no such channel', 404);
  }
  return { ok: true, channels: list };
}

/** A list of the request's values: unique, trimmed, of at most `MAX_CATCHES`, or null. */
function values(v, norm) {
  if (v === undefined || v === null) {
    return null;
  }
  const list = (Array.isArray(v) ? v : String(v).split(/[\s,]+/)).map((x) => norm(String(x).trim())).filter(Boolean);
  return [...new Set(list)];
}

/**
 * `{ channel, on?, tenants?, domains?, by }`: turns a channel's auto-approval on or off, and sets
 * what else it catches (a list replaces the channel's; one left out stays). An org ID is of
 * `ORG_ID`'s form; a domain exact, lowercase and nobody's free mail. Each belongs to one channel
 * of the host: one another channel holds (or another channel's own tenant) is refused, naming it.
 * Off stops new auto-enrollments; the members stay. `{ ok, channel }`.
 */
export async function setAuto(env, args = {}, now = Date.now()) {
  const db = env.DB;
  const by = clean(args.by && args.by.email, 200).toLowerCase();
  if (!by) {
    return fail('say who changes it: by { email, name }');
  }
  const c = await db.prepare(`SELECT c.*, h.identity FROM integration_customers c
    JOIN integration_hosts h ON h.id = c.host WHERE c.channel = ?`).bind(clean(args.channel, 20)).first();
  if (!c) {
    return fail('no such channel', 404);
  }
  if (c.identity === null) {
    return fail('only a host with an identity provider auto-approves: an assertion host enrolls by hand', 409);
  }
  const tenants = values(args.tenants, (x) => (ORG_ID.test(x) ? x : (x && `!${x}`)));
  const domains = values(args.domains, (x) => x.toLowerCase().replace(/^@/, ''));
  const badTenant = (tenants || []).find((t) => t.startsWith('!'));
  if (badTenant) {
    return fail(`${badTenant.slice(1)} is not an organization ID (like 0123456789ABCDEF01234567@AdobeOrg)`);
  }
  const badDomain = (domains || []).find((d) => !domainParts(d) || isPublicMail(d));
  if (badDomain) {
    return fail(domainParts(badDomain) ? `${badDomain} is everyone's mail: it cannot catch anyone` : `${badDomain} is not a mail domain`);
  }
  const extra = (tenants || []).filter((t) => t !== c.tenant);
  if (extra.length > MAX_CATCHES || (domains || []).length > MAX_CATCHES) {
    return fail(`at most ${MAX_CATCHES} organization IDs and ${MAX_CATCHES} domains`);
  }
  // Held elsewhere on the host: say where.
  const held = await db.prepare(`SELECT k.kind, k.value, k.channel, c.name FROM integration_catches k
      JOIN integration_customers c ON c.channel = k.channel
      WHERE k.host = ?1 AND k.channel != ?2 AND ((k.kind = 'tenant' AND k.value IN (SELECT value FROM json_each(?3)))
        OR (k.kind = 'domain' AND k.value IN (SELECT value FROM json_each(?4))))
    UNION ALL SELECT 'tenant', tenant, channel, name FROM integration_customers
      WHERE host = ?1 AND channel != ?2 AND tenant IN (SELECT value FROM json_each(?3))`)
    .bind(c.host, c.channel, JSON.stringify(extra), JSON.stringify(domains || [])).all();
  const conflict = (held.results || [])[0];
  if (conflict) {
    return {
      ...fail(`${conflict.value} lands in #${conflict.name} (${conflict.channel}) on this host already: take it off there first`, 409),
      conflict: {
        kind: conflict.kind, value: conflict.value, channel: conflict.channel, name: conflict.name,
      },
    };
  }
  const sec = Math.floor(now / 1000);
  const writes = [];
  if (args.on !== undefined) {
    writes.push(db.prepare(`UPDATE integration_customers SET auto_approve = ?, auto_by = ?, auto_at = ?
      WHERE channel = ?`).bind(args.on ? 1 : 0, by, sec, c.channel));
  }
  for (const [kind, list] of [['tenant', tenants && extra], ['domain', domains]]) {
    if (list) {
      writes.push(db.prepare(`DELETE FROM integration_catches WHERE channel = ? AND kind = ?
        AND value NOT IN (SELECT value FROM json_each(?))`).bind(c.channel, kind, JSON.stringify(list)));
      for (const value of list) {
        // Not `ON CONFLICT DO NOTHING`: one another channel took meanwhile fails the batch.
        writes.push(db.prepare(`INSERT INTO integration_catches(host, channel, kind, value, added_by,
          added_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE NOT EXISTS (SELECT 1 FROM integration_catches
            WHERE host = ?1 AND kind = ?3 AND value = ?4 AND channel = ?2)`)
          .bind(c.host, c.channel, kind, value, by, sec));
      }
    }
  }
  if (writes.length) {
    try {
      await db.batch(writes);
    } catch (e) {
      if (!/UNIQUE|tenant mapped|catch is of/i.test(String(e.message || e))) {
        throw e;
      }
      return fail('another channel of this host took one of these meanwhile: look again', 409);
    }
  }
  console.log(JSON.stringify({
    route: 'portal', integration: 'auto', on: args.on === undefined ? undefined : Boolean(args.on),
  }));
  return listChannels(env, { channel: c.channel }, now);
}

/**
 * `{ channel, name, by }`: the name the channel's customer is shown by to its members (`GET
 * /threads` `audienceName`, for a shared channel), instead of the provider's name of its tenant;
 * an empty `name` takes it back. Plain text on one line, up to 120 characters, and neither the
 * channel's own name nor an organization ID. `{ ok, channel }`.
 */
export async function setAudienceName(env, args = {}, now = Date.now()) {
  const db = env.DB;
  const by = clean(args.by && args.by.email, 200).toLowerCase();
  if (!by) {
    return fail('say who changes it: by { email, name }');
  }
  const c = await db.prepare('SELECT channel, name, tenant FROM integration_customers WHERE channel = ?')
    .bind(clean(args.channel, 20)).first();
  if (!c) {
    return fail('no such channel', 404);
  }
  const raw = typeof args.name === 'string' ? args.name : '';
  // Whitespace, line breaks too, is one space; any other control character is refused.
  const name = raw.replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    return fail('a name is one line of plain text, up to 120 characters');
  }
  const its = name && (name.toLowerCase() === c.name.toLowerCase() || name === c.tenant);
  if (its || ORG_ID.test(name)) {
    return fail('give the customer\'s name as people know it, not the channel\'s name or an organization ID');
  }
  await db.prepare(`UPDATE integration_customers SET audience_name = ?, audience_name_by = ?,
    audience_name_at = ? WHERE channel = ?`).bind(name || null, by, Math.floor(now / 1000), c.channel).run();
  console.log(JSON.stringify({ route: 'portal', integration: 'audience name', set: Boolean(name) }));
  return listChannels(env, { channel: c.channel }, now);
}
