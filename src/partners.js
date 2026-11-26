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
 * (its slug or display name) in whose threads its people post, one whose org part is that of a
 * customer's icon (`orgs.icon`, a domain or the host of its URL: a subsidiary's people may write
 * from its parent's domain), or, for any but a partner's first domain, the domain most of a
 * customer's people write from. A partner's first domain may be
 * that of a customer whose channels only its people post in, which is how partners work. A domain
 * two partners have is the one's with more of its people there. Each is named by its org's
 * display name.
 *
 * They are found from every message there is (a few hundred thousand rows), so an isolate keeps
 * what it found for an hour (`DERIVED_MS`), and the first request after that finds them again.
 * What changes them forgets them in its isolate (`forgetPartnerDomains`: an org's name, type or
 * icon, a merge, an edit of `partner_domains`); the other isolates find them again within the hour.
 * The rows of `partner_domains` (migration 0013, `org` and `excluded` in 0109) are the admin
 * team's overrides, read every time: a domain added by hand (with a name or a partner org), a
 * found one renamed or given to another partner, and one that is not a partner's (`excluded`),
 * which leaves out its subdomains too unless one of them is listed itself.
 */

// ---- partner domains: who is a partner's, by mail domain ------------------------------------

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
 * The org part of the domain an org's icon (`orgs.icon`) is of: the icon itself, a domain, or the
 * host of its URL (the domain a favicon service's URL asks for); none for one this Worker serves
 * (a portal logo) or one that is no domain.
 */
export function iconDomain(env, icon) {
  let host = String(icon || '').trim().toLowerCase();
  if (/^https?:\/\//.test(host)) {
    try {
      const url = new URL(host);
      const own = new URL(String(env.PUBLIC_ORIGIN || 'https://invalid.invalid')).hostname;
      host = url.hostname === own ? '' : url.searchParams.get('domain') || url.hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^www\./, '');
  return DOMAIN.test(host) ? registrable(host) : null;
}

/**
 * The partner domains the threads show, from `rows` (`[{ org, type, name, domain, people,
 * threads }]`, a row per org and mail domain of its people outside Adobe, and `icons`, `[{ slug,
 * icon }]` of the customers): `{ found: [{ domain,
 * org, name, people, threads }], left: [{ domain, org, name, people, threads, customer }] }`,
 * `left` those a partner's people write from that are a customer's own (`customer` is which).
 */
export function derive(env, rows, icons = []) {
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
  // The org part of each customer's icon: its people may write from it, though they post from
  // others (a subsidiary, its parent's).
  const pictured = new Map();
  for (const { slug, icon } of icons || []) {
    const d = iconDomain(env, icon);
    if (d && !pictured.has(d)) {
      pictured.set(d, { slug });
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
          || pictured.get(registrable(d.domain))
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

/** The customers' icons, as `derive` reads them. */
async function loadIcons(env) {
  const { results } = await env.DB.prepare(`SELECT slug, icon FROM orgs
    WHERE COALESCE(type, 'customer') = 'customer' AND icon IS NOT NULL
      AND slug NOT IN (SELECT slug FROM org_merges)`).all();
  return results || [];
}

const NONE = Object.freeze({ found: [], left: [], at: null });
/** How long a request waits for a look; one that takes longer is looked for anew by the next. */
const LOOK_MS = 20 * 1000;
/** After a look that failed, the next one is this much later: what was found before until then. */
const RETRY_MS = 60 * 1000;
/** `{ db, done, at, look, retry }`: what was found, when, the look on its way, the next try. */
let kept = null;

/**
 * The domains found (`derive`), as this isolate found them in the last hour (`DERIVED_MS`). After
 * the hour, the request that asks looks again and waits for it (a fraction of a second, once an
 * hour): a look nobody awaits could be cancelled with the response, and the old domains would be
 * trusted for another hour. Requests that come together share a look. Kept by the D1 binding under
 * the request's wrappers (`underlying`). `at` moves only when a look succeeds: one that fails or
 * takes longer than `LOOK_MS` answers what was found before (none, the first time). After a
 * failure, so do the requests of the next minute (`RETRY_MS`), so that an overloaded D1 is not
 * asked for every message again by each of them; the first after it looks again.
 */
export async function derivedDomains(env, { fresh = false } = {}) {
  const db = underlying(env.DB);
  if (!kept || kept.db !== db) {
    kept = {
      db, done: null, at: 0, look: null, retry: 0,
    };
  }
  const k = kept;
  if (!fresh && k.done && Date.now() - k.at < DERIVED_MS) {
    return k.done;
  }
  if (!fresh && !k.look && Date.now() < k.retry) {
    return k.done || NONE;
  }
  if (fresh || !k.look || Date.now() - k.look.started >= LOOK_MS) {
    const next = { started: Date.now() };
    next.value = Promise.all([loadRows(env), loadIcons(env)]).then(([rows, icons]) => {
      const done = { ...derive(env, rows, icons), at: new Date().toISOString() };
      k.done = done;
      k.at = Date.now();
      k.retry = 0;
      return done;
    }, (e) => {
      k.retry = Date.now() + RETRY_MS;
      throw e;
    }).finally(() => {
      if (k.look === next) {
        k.look = null;
      }
    });
    // Its failure is each waiting request's; once none waits, nobody's.
    next.value.catch(() => {});
    k.look = next;
  }
  const { look } = k;
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), LOOK_MS);
  });
  try {
    const done = await Promise.race([look.value, late]);
    if (done) {
      return done;
    }
    console.error('partner domains: still looking after', LOOK_MS, 'ms');
  } catch (e) {
    console.error('partner domains:', e && e.message);
  } finally {
    clearTimeout(timer);
  }
  return k.done || NONE;
}

/**
 * Forgets the domains found in this isolate: the next request finds them again. Whatever changes
 * an org's name, type or icon, merges one, or edits `partner_domains` calls it, as src/orgmerge.js
 * `forgetFacts` for the duplicate search.
 */
export function forgetPartnerDomains() {
  kept = null;
}

/** The admin team's rows of `partner_domains`, with the name of the partner org one names. */
async function overrides(env) {
  const { results } = await env.DB.prepare(`SELECT p.domain, p.name, p.org, p.excluded,
      p.updated_by, p.updated_at, o.name AS org_name
    FROM partner_domains p LEFT JOIN orgs o ON o.slug = p.org`).all();
  return results || [];
}

/**
 * The partner domains and whether they were found (`{ domains, found }`): `domains` is
 * `partnerDomains`'s, `found` false when no look ever succeeded in this isolate (the first failed
 * or is late, `NONE`), so `domains` has the admin team's rows only. What a look found before, kept
 * while the next one fails, is found. A caller that writes from them (src/orgpartners.js) waits
 * for found ones; one that only shows them takes what there is.
 */
export async function partnerDomainLookup(env) {
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
  return { domains: out, found: derived.at !== null };
}

/**
 * The partner domains: `Map<domain, { name, org } | null>`, the domains found and then the admin
 * team's rows over them; `null` is a domain that is not a partner's (src/profiles.js `partnerOf`).
 */
export async function partnerDomains(env) {
  return (await partnerDomainLookup(env)).domains;
}

// ---- partner domains: the admin team's editor ------------------------------------------------

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
  forgetPartnerDomains();
  return json({ ok: true, domain });
}

/** DELETE /api/admin/partner-domains `{ domain }`: the admin team's row gone, the found back. */
export async function deletePartnerDomain(env, body) {
  const domain = domainOf(body.domain);
  if (!domain) {
    return bad('a mail domain');
  }
  const { meta } = await env.DB.prepare('DELETE FROM partner_domains WHERE domain = ?').bind(domain).run();
  forgetPartnerDomains();
  return json({ ok: true, domain, removed: (meta && meta.changes) || 0 });
}
