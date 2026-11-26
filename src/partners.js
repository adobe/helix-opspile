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

import { underlying } from './d1batch.js';
import { DOMAIN, orgDomain, registrable } from './favicons.js';
import { json } from './http.js';
import { domainList } from './lookup.js';
import { UNASSIGNED } from './rules.js';

/**
 * Partner domains: the mail domains whose people work for a partner of Adobe (an agency, a
 * system integrator), so that the inbox shows them as a partner's people rather than the
 * customer's wherever it tells people apart (profile cards, a customer's people and its "Who",
 * mentions, the ClickHouse export). `partnerDomains` is the one source of them: every caller asks
 * it, never `partner_domains`.
 *
 * They are found, not typed in (`derive`): the usual mail domains of the people outside Adobe
 * who post in the threads of each org of type `partner`, the one that names the partner first,
 * then by how many people write from it; other domains of nearly as many of them count too, as
 * do those of the same name (`acme.co.uk` beside `acme.com`). Free mail, tenant and staff domains
 * never count (`orgDomain`), and neither does a customer's own domain: one that names a customer
 * (its slug or display name) in whose threads its people post, or, for any but a partner's first
 * domain, the domain most of a customer's people write from. A partner's first domain may be
 * that of a customer whose channels only its people post in, which is how partners work. A domain
 * two partners have is the one's with more of its people there. Each is named by its org's
 * display name.
 *
 * They are found from every message there is (a few hundred thousand rows), so an isolate keeps
 * what it found for an hour (`DERIVED_MS`) and finds them again in the background after that.
 * The rows of `partner_domains` (migration 0013, `org` and `excluded` in 0109) are the admin
 * team's overrides, read every time: a domain added by hand (with a name or a partner org), a
 * found one renamed or given to another partner, and one that is not a partner's (`excluded`),
 * which leaves out its subdomains too unless one of them is listed itself.
 */

/** How long an isolate keeps the domains it found. */
export const DERIVED_MS = 60 * 60 * 1000;
/** A partner's other domains count from half of the people of its busiest one. */
const SHARE = 0.5;
const MAX_NAME = 120;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const bad = (error) => json({ error }, 400);
/** Letters and digits only: "Acme Co." and acme-co meet. */
const compact = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
/** The name part of a domain: `acme` of `mail.acme.co.uk`. */
const label = (domain) => compact(registrable(domain).split('.')[0]);

/** Whether `domain` names the org: its name part is the slug's or the display name's. */
export function namesOrg(domain, { slug, name }) {
  const d = label(domain);
  return [compact(slug), compact(name)].filter(Boolean).some((n) => {
    const [s, l] = n.length <= d.length ? [n, d] : [d, n];
    return s === l || (s.length >= 3 && l.startsWith(s)) || (s.length >= 5 && l.includes(s));
  });
}

/**
 * The partner domains the threads show, from `rows` (`[{ org, type, name, domain, people,
 * threads }]`, a row per org and mail domain of its people outside Adobe): `{ found: [{ domain,
 * org, name, people, threads }], left: [{ domain, org, name, people, threads, customer }] }`,
 * `left` those a partner's people write from that are a customer's own (`customer` is which).
 */
export function derive(env, rows) {
  const by = new Map();
  for (const r of rows || []) {
    const domain = String(r.domain || '').toLowerCase();
    if (r.org && r.org !== UNASSIGNED && orgDomain(env, domain)) {
      if (!by.has(r.org)) {
        by.set(r.org, {
          slug: r.org, name: r.name || null, type: r.type || 'customer', domains: [],
        });
      }
      by.get(r.org).domains.push({ domain, people: r.people || 0, threads: r.threads || 0 });
    }
  }
  const orgs = [...by.values()];
  const customers = orgs.filter((o) => o.type === 'customer');
  // The domain most of each customer's people write from, and the customers whose threads each
  // domain's people post in.
  const tops = new Map();
  const postsIn = new Map();
  for (const o of customers) {
    const [top] = [...o.domains].sort((a, b) => b.people - a.people || b.threads - a.threads);
    tops.set(top.domain, [...(tops.get(top.domain) || []), o]);
    for (const d of o.domains) {
      postsIn.set(d.domain, [...(postsIn.get(d.domain) || []), o]);
    }
  }
  const found = new Map();
  const left = new Map();
  for (const o of orgs.filter((x) => x.type === 'partner')) {
    const most = Math.max(...o.domains.map((d) => d.people));
    const named = (d) => Number(namesOrg(d.domain, o));
    const ranked = [...o.domains].sort((a, b) => named(b) - named(a) || b.people - a.people
      || b.threads - a.threads || a.domain.localeCompare(b.domain));
    const first = ranked[0];
    for (const d of ranked) {
      const same = d === first || label(d.domain) === label(first.domain);
      if (same || d.people >= most * SHARE) {
        const own = (postsIn.get(d.domain) || []).find((c) => namesOrg(d.domain, c))
          || (!same && (tops.get(d.domain) || [])[0]);
        const entry = {
          domain: d.domain,
          org: o.slug,
          name: o.name || o.slug,
          people: d.people,
          threads: d.threads,
        };
        const into = own ? left : found;
        const was = into.get(d.domain);
        const more = !was || entry.people > was.people
          || (entry.people === was.people && entry.threads > was.threads);
        if (more) {
          into.set(d.domain, own ? { ...entry, customer: own.slug } : entry);
        }
      }
    }
  }
  for (const d of found.keys()) {
    left.delete(d);
  }
  const order = (a, b) => a.name.localeCompare(b.name) || a.domain.localeCompare(b.domain);
  return { found: [...found.values()].sort(order), left: [...left.values()].sort(order) };
}

/** Every org's people's mail domains, partners' and customers', as `derive` reads them. */
async function loadRows(env) {
  const { results } = await env.DB.prepare(`SELECT t.org, COALESCE(o.type, 'customer') AS type,
      o.name, LOWER(SUBSTR(i.email, INSTR(i.email, '@') + 1)) AS domain,
      COUNT(DISTINCT LOWER(i.email)) AS people, COUNT(DISTINCT m.thread) AS threads
    FROM messages m JOIN threads t ON t.thread = m.thread
    JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +m.author_key
    LEFT JOIN orgs o ON o.slug = t.org
    WHERE m.staff = 0 AND m.deleted = 0 AND m.counted = 1 AND i.email LIKE '%_@_%'
      AND COALESCE(i.kind, 'person') = 'person' AND COALESCE(i.staff, 0) = 0
      AND COALESCE(o.type, 'customer') IN ('customer', 'partner')
      AND t.org != ?1 AND t.org NOT IN (SELECT slug FROM org_merges)
    GROUP BY t.org, domain`).bind(UNASSIGNED).all();
  return results || [];
}

let kept = null;
const NONE = Object.freeze({ found: [], left: [], at: null });
/** After a failed look, the next one is this much later, with what was found before kept. */
const RETRY_MS = 60 * 1000;

/**
 * The domains found (`derive`), as this isolate found them in the last hour; after that, what it
 * found before while it looks again. Kept by the D1 binding under the request's wrappers
 * (`underlying`), and as a promise, so requests that come together look once. A failed look
 * keeps what was found before (none, the first time) and is tried again a minute later.
 */
export async function derivedDomains(env, { fresh = false } = {}) {
  const db = underlying(env.DB);
  const k = kept && kept.db === db ? kept : null;
  if (k && !fresh && Date.now() - k.at < DERIVED_MS) {
    return k.value;
  }
  const next = { db, at: Date.now(), last: k ? k.last : null };
  next.value = loadRows(env).then((rows) => {
    next.last = { ...derive(env, rows), at: new Date().toISOString() };
    return next.last;
  }, (e) => {
    console.error('partner domains:', e && e.message);
    if (kept === next) {
      kept = {
        ...next, at: Date.now() - DERIVED_MS + RETRY_MS, value: Promise.resolve(next.last || NONE),
      };
    }
    return next.last || NONE;
  });
  kept = next;
  return !fresh && next.last ? next.last : next.value;
}

/** Forgets the domains found (tests). */
export function forgetPartnerDomains() {
  kept = null;
}

/**
 * Has the domains found looked for again on the next request (an org's name or type changed),
 * which until then get what was found.
 */
export function stalePartnerDomains() {
  if (kept) {
    kept.at = 0;
  }
}

/** The admin team's rows of `partner_domains`, with the name of the partner org one names. */
async function overrides(env) {
  const { results } = await env.DB.prepare(`SELECT p.domain, p.name, p.org, p.excluded,
      p.updated_by, p.updated_at, o.name AS org_name
    FROM partner_domains p LEFT JOIN orgs o ON o.slug = p.org`).all();
  return results || [];
}

/**
 * The partner domains: `Map<domain, { name, org } | null>`, the domains found and then the admin
 * team's rows over them; `null` is a domain that is not a partner's (src/profiles.js `partnerOf`).
 */
export async function partnerDomains(env) {
  const [derived, rows] = await Promise.all([derivedDomains(env), overrides(env)]);
  const out = new Map(derived.found.map((d) => [d.domain, { name: d.name, org: d.org }]));
  for (const r of rows) {
    const domain = String(r.domain).toLowerCase();
    const was = out.get(domain);
    out.set(domain, r.excluded ? null : {
      name: r.name || r.org_name || r.org || (was && was.name) || domain,
      org: r.org || (was && was.org) || null,
    });
  }
  return out;
}

// ---- the admin team's editor --------------------------------------------------------------

/**
 * GET /api/admin/partner-domains: every partner domain, found or the admin team's, with where it
 * comes from: `{ domains: [{ domain, name, org, state, found, manual }], left, partners, at }`.
 * `state` is `found`, `manual` (added or changed by hand) or `excluded`; `found` what the threads
 * say of it (its org, people and threads), `manual` the admin team's row. `left` lists the domains
 * found that are left out as a customer's own, and `partners` the orgs of type `partner`.
 */
export async function listPartnerDomains(env, { fresh = false } = {}) {
  const [derived, rows, { results: partners }] = await Promise.all([
    derivedDomains(env, { fresh }),
    overrides(env),
    env.DB.prepare(`SELECT slug, name FROM orgs WHERE type = 'partner'
      AND slug NOT IN (SELECT slug FROM org_merges) ORDER BY COALESCE(name, slug)`).all(),
  ]);
  const merged = await partnerDomains(env);
  const found = new Map(derived.found.map((d) => [d.domain, d]));
  const manual = new Map(rows.map((r) => [String(r.domain).toLowerCase(), r]));
  const domains = [...new Set([...found.keys(), ...manual.keys()])].map((domain) => {
    const f = found.get(domain) || null;
    const m = manual.get(domain) || null;
    const now = merged.get(domain);
    let state = 'found';
    if (m) {
      state = m.excluded ? 'excluded' : 'manual';
    }
    return {
      domain,
      name: now ? now.name : (f && f.name) || m.name || null,
      org: now ? now.org : (f && f.org) || m.org || null,
      state,
      found: f && {
        org: f.org, name: f.name, people: f.people, threads: f.threads,
      },
      manual: m && {
        name: m.name || null,
        org: m.org || null,
        excluded: Boolean(m.excluded),
        by: m.updated_by || null,
        at: m.updated_at || null,
      },
    };
  }).sort((a, b) => String(a.name || a.domain).localeCompare(String(b.name || b.domain))
    || a.domain.localeCompare(b.domain));
  return json({
    domains,
    left: derived.left,
    partners: (partners || []).map((p) => ({ slug: p.slug, name: p.name || p.slug })),
    at: derived.at,
  });
}

/** A mail domain as the admin team typed it (`@acme.com`, `https://acme.com/`), or null. */
export function domainOf(value) {
  const d = clean(value, 253).toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^.*@/, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
  return DOMAIN.test(d) ? d : null;
}

/**
 * PUT /api/admin/partner-domains `{ domain, name?, org?, excluded? }`: the admin team's row for a
 * domain, made or replaced: a partner's domain (named, of a partner org, or both), or with
 * `excluded` one that is not a partner's.
 */
export async function savePartnerDomain(env, me, body) {
  const domain = domainOf(body.domain);
  if (!domain) {
    return bad('a mail domain, such as agency.example');
  }
  if (domainList(env.STAFF_DOMAINS).some((s) => domain === s || domain.endsWith(`.${s}`))) {
    return bad('that is a staff domain');
  }
  const excluded = Boolean(body.excluded);
  const name = excluded ? null : clean(body.name, MAX_NAME) || null;
  const org = excluded ? null : clean(body.org).toLowerCase() || null;
  if (org) {
    const row = SLUG.test(org) && await env.DB.prepare('SELECT type FROM orgs WHERE slug = ?')
      .bind(org).first();
    if (!row || row.type !== 'partner') {
      return bad('not a partner org');
    }
  }
  if (!excluded && !name && !org) {
    return bad('a name or a partner org');
  }
  await env.DB.prepare(`INSERT INTO partner_domains (domain, name, org, excluded, updated_by, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (domain) DO UPDATE SET name = ?2, org = ?3, excluded = ?4, updated_by = ?5,
      updated_at = ?6`)
    .bind(domain, name, org, excluded ? 1 : 0, me.email || String(me.id || ''), new Date().toISOString())
    .run();
  return json({ ok: true, domain });
}

/** DELETE /api/admin/partner-domains `{ domain }`: the admin team's row gone, the found back. */
export async function deletePartnerDomain(env, body) {
  const domain = domainOf(body.domain);
  if (!domain) {
    return bad('a mail domain');
  }
  const { meta } = await env.DB.prepare('DELETE FROM partner_domains WHERE domain = ?').bind(domain).run();
  return json({ ok: true, domain, removed: (meta && meta.changes) || 0 });
}
