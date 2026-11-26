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
import { AVATAR, NAME, TITLE } from './personsql.js';
import { UNASSIGNED } from './rules.js';
import { WEEK, zeros } from './teamprofile.js';
import {
  entriesOf, forViewer, listRow, MAY_WAIT, middle, ROW, sharesOf,
} from './vendors.js';

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
 * two partners have is the one's with more of its people there, and one that names one other
 * partner org (of no posts, too) and not the partner whose people write from it is the one's it
 * names: a bought agency's people write from its new parent's domain. Each is named by its org's
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
 * icon }]` of the customers, and `partners`, `[{ slug, name }]` of every partner org, those of no
 * posts too): `{ found: [{ domain,
 * org, name, people, threads }], left: [{ domain, org, name, people, threads, customer }] }`,
 * `left` those a partner's people write from that are a customer's own (`customer` is which). A
 * domain that names one other partner and not the one whose people write from it is the one's it
 * names: an agency's people still write from the parent's domain after it was bought.
 */
export function derive(env, rows, icons = [], partners = []) {
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
  // Every partner org, those whose people posted nothing too (their channels hide the members'
  // mail, or they were only just made one).
  const known = new Map((partners || []).map((p) => [p.slug, p]));
  for (const o of orgs.filter((x) => x.type === 'partner')) {
    if (!known.has(o.slug)) {
      known.set(o.slug, o);
    }
  }
  // The one other partner a domain names, when it does not name `o`.
  const namedOther = (domain, o) => {
    if (namesOrg(domain, o)) {
      return null;
    }
    const others = [...known.values()].filter((p) => p.slug !== o.slug && namesOrg(domain, p));
    return others.length === 1 ? others[0] : null;
  };
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
        const other = !own && namedOther(d.domain, o);
        const entry = {
          domain: d.domain,
          org: other ? other.slug : o.slug,
          name: (other || o).name || (other || o).slug,
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

/** Every partner org, not merged, as `derive` reads them: those of no posts too. */
async function loadPartners(env) {
  const { results } = await env.DB.prepare(`SELECT slug, name FROM orgs WHERE type = 'partner'
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
    next.value = Promise.all([loadRows(env), loadIcons(env), loadPartners(env)]).then(([rows,
      icons, partners]) => {
      const done = { ...derive(env, rows, icons, partners), at: new Date().toISOString() };
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

/**
 * The partner a mail domain belongs to, `{ domain, name, org }`, matching the domain or any
 * parent domain: `partners` is `partnerDomains`, whose `null` (a domain that is
 * not a partner's) ends the search there. A plain name instead of `{ name, org }` does too.
 */
export function partnerOf(domain, partners) {
  const parts = String(domain || '').toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    const d = parts.slice(i).join('.');
    if (partners.has(d)) {
      const p = partners.get(d);
      if (p === null) {
        return null;
      }
      return typeof p === 'object'
        ? { domain: d, name: p.name || d, org: p.org || null }
        : { domain: d, name: p || d, org: null };
    }
  }
  return null;
}

// ---- a partner's page: its customers, its people, what waits on Adobe ----------------------

/** At most this many of each list of a partner's page. */
export const MAX_PARTNER_PEOPLE = 12;
export const MAX_PARTNER_CUSTOMERS = 20;
export const MAX_PARTNER_WAITING = 25;
/**
 * A customer nothing links to the partner yet is listed from this many threads with its people,
 * or this many of its people, in the weeks: one stray post lists nobody.
 */
export const UNLINKED_MIN = 2;
/** Of a person, the customers whose threads they post in that their card names. */
const MAX_PERSON_ORGS = 4;

/** Who an account of the partner's is: their person, else their mail address, else it. */
const whoOf = (a) => {
  if (a.person) {
    return `p:${a.person}`;
  }
  return a.mail ? `m:${a.mail}` : `a:${a.key}`;
};

/** Whether an org (`{ type }`) is a customer, as an org of no row is. */
const isCustomer = (o) => (o ? (o.type || 'customer') === 'customer' : true);

/**
 * What a partner's page adds to its overview (src/orgprofile.js `orgNumbers`; docs/ARCHITECTURE.md,
 * "Partners"), for the weeks `weeks`, everyone's at Adobe but the list of threads, which
 * `partnerForViewer` filters:
 *
 * - `customers`: the customers it works for, confirmed and likely (src/orgpartners.js
 *   `customersOf`, with what links them), and those whose threads its people posted in, each with
 *   how many of the customer's threads its people are in (`theirs`) and how many of its own the
 *   customer's people are in (`ours`: the people outside Adobe of its threads who post in the
 *   customer's too); one nothing links yet from `UNLINKED_MIN` threads or people on;
 * - `people`: its people (their mail domain its, `partnerDomains`), wherever they posted: in its
 *   own channels and in customers', how much, and in whose;
 * - `posts`: what its people said in its channels and in customers', week by week;
 * - `waiting`: what waits on Adobe in its channels and in the customers' threads its people are in;
 * - `answers`: how soon Adobe answers what its people start, in its channels and in customers'
 *   (the median, and every wait).
 *
 * `customers` is what src/orgpartners.js `customersOf` says of it, which the caller reads: that
 * file reaches this one through src/orgmerge.js.
 */
export async function partnerNumbers(env, slug, weeks, { customers: linked = [] } = {}) {
  const since = `${weeks[0]}T00:00:00.000Z`;
  const at = new Map(weeks.map((w, i) => [w, i]));
  const all = (sql, ...args) => env.DB.prepare(sql).bind(...args).all()
    .then((r) => r.results || []);
  const list = (values) => JSON.stringify([...values]);
  const partners = await partnerDomains(env);
  const domains = [...partners].filter(([, v]) => v && v.org === slug).map(([d]) => d);
  const [accounts, ownRows, guests] = await Promise.all([
    // The accounts of its mail domains, or under them; `partnerOf` says which are its.
    domains.length ? all(`SELECT i.source || ':' || i.tenant || ':' || i.user_id AS key, i.person,
        COALESCE(i.display_name, i.name) AS name, LOWER(COALESCE(p.email, i.email)) AS mail
      FROM identities i LEFT JOIN people p ON p.id = i.person
      WHERE COALESCE(i.kind, 'person') = 'person' AND COALESCE(i.staff, 0) = 0
        AND EXISTS (SELECT 1 FROM json_each(?1) d
          WHERE LOWER(COALESCE(p.email, i.email)) LIKE '%@' || d.value
            OR LOWER(COALESCE(p.email, i.email)) LIKE '%.' || d.value)`, list(domains)) : [],
    // Its threads of the weeks that may wait on someone.
    all(`SELECT ${ROW} FROM threads h WHERE h.org = ?1 AND h.kind = 'channel' AND h.last_at >= ?2
      AND ${MAY_WAIT('h')}`, slug, since),
    // Who outside Adobe posted in its threads of the weeks.
    all(`SELECT DISTINCT g.author_key AS key, g.thread FROM threads h
        JOIN messages g ON g.thread = h.thread AND g.at >= ?2
      WHERE h.org = ?1 AND h.kind = 'channel' AND h.last_at >= ?2 AND g.staff = 0 AND g.deleted = 0
        AND g.counted = 1 AND g.author_key IS NOT NULL`, slug, since),
  ]);
  const mine = accounts.filter((a) => partnerOf(String(a.mail || '').split('@').pop(), partners)
    ?.org === slug);
  const keyOf = new Map(mine.map((a) => [a.key, a]));
  const guestKeys = [...new Set(guests.map((g) => g.key))].filter((k) => !keyOf.has(k));
  const [posts, guestOrgs] = await Promise.all([
    // What its people said of the weeks, wherever: by account, thread and week.
    keyOf.size ? all(`SELECT m.author_key AS key, h.thread, h.org, ${WEEK('m.at')} AS week,
        COUNT(*) AS n, MAX(m.at) AS last
      FROM messages m JOIN threads h ON h.thread = m.thread
      WHERE m.author_key IN (SELECT value FROM json_each(?1)) AND m.at >= ?2 AND m.staff = 0
        AND m.deleted = 0 AND m.counted = 1 AND h.kind = 'channel'
      GROUP BY 1, 2, 4`, list(keyOf.keys()), since) : [],
    // Where the others of its threads post: the customers whose people they are.
    guestKeys.length ? all(
      `SELECT DISTINCT m.author_key AS key, h.org FROM messages m
        JOIN threads h ON h.thread = m.thread
      WHERE m.author_key IN (SELECT value FROM json_each(?1)) AND m.at >= ?2 AND h.org != ?3
        AND h.kind = 'channel' AND m.staff = 0 AND m.deleted = 0 AND m.counted = 1`,
      list(guestKeys),
      since,
      slug,
    ) : [],
  ]);
  const slugs = new Set([...posts.map((r) => r.org), ...guestOrgs.map((r) => r.org),
    ...linked.map((c) => c.slug)].filter((o) => o && o !== slug && o !== UNASSIGNED));
  const orgRows = slugs.size ? await all(`SELECT slug, name, COALESCE(type, 'customer') AS type,
      icon FROM orgs WHERE slug IN (SELECT value FROM json_each(?1))`, list(slugs)) : [];
  const orgOf = new Map(orgRows.map((o) => [o.slug, o]));
  const merged = new Set((await all(`SELECT slug FROM org_merges
    WHERE slug IN (SELECT value FROM json_each(?1))`, list(slugs))).map((r) => r.slug));
  const customer = (o) => o !== slug && o !== UNASSIGNED && !merged.has(o)
    && isCustomer(orgOf.get(o));

  // Its people: an account each, a person's accounts and those of one mail address as one.
  const people = new Map();
  const custThreads = new Set();
  const ownThreads = new Set();
  const byCustomer = new Map();
  const weekly = { own: zeros(weeks.length), customers: zeros(weeks.length) };
  for (const r of posts) {
    const a = keyOf.get(r.key);
    const w = whoOf(a);
    if (!people.has(w)) {
      people.set(w, {
        person: a.person ?? null,
        account: a.person ? null : a.key,
        name: a.name || null,
        messages: 0,
        own: 0,
        customers: 0,
        threads: new Set(),
        orgs: new Map(),
        weekly: zeros(weeks.length),
        last: null,
      });
    }
    const e = people.get(w);
    const i = at.get(r.week);
    const own = r.org === slug;
    const theirs = customer(r.org);
    e.messages += r.n;
    e.threads.add(r.thread);
    e.last = [e.last, r.last].filter(Boolean).sort().pop() || null;
    if (i !== undefined) {
      e.weekly[i] += r.n;
    }
    if (own) {
      e.own += r.n;
      ownThreads.add(r.thread);
      if (i !== undefined) {
        weekly.own[i] += r.n;
      }
    } else if (theirs) {
      e.customers += r.n;
      e.orgs.set(r.org, (e.orgs.get(r.org) || new Set()).add(r.thread));
      custThreads.add(r.thread);
      if (i !== undefined) {
        weekly.customers[i] += r.n;
      }
      if (!byCustomer.has(r.org)) {
        byCustomer.set(r.org, {
          threads: new Set(), people: new Set(), messages: 0, last: null,
        });
      }
      const c = byCustomer.get(r.org);
      c.threads.add(r.thread);
      c.people.add(w);
      c.messages += r.n;
      c.last = [c.last, r.last].filter(Boolean).sort().pop() || null;
    }
  }
  // The customers' people in its threads: those who post in a customer's threads too.
  const orgsOfGuest = new Map();
  for (const g of guestOrgs.filter((x) => customer(x.org))) {
    orgsOfGuest.set(g.key, [...(orgsOfGuest.get(g.key) || []), g.org]);
  }
  const ours = new Map();
  for (const g of guests) {
    for (const o of orgsOfGuest.get(g.key) || []) {
      ours.set(o, (ours.get(o) || new Set()).add(g.thread));
    }
  }

  const ids = [...new Set([...people.values()].map((e) => e.person).filter(Boolean))];
  const [whoRows, custRows, firsts] = await Promise.all([
    ids.length ? all(
      `SELECT p.id, ${NAME('p.id')} AS name, ${AVATAR('p.id')} AS avatar,
        ${TITLE('p.id')} AS title FROM people p WHERE p.id IN (SELECT value FROM json_each(?1))`,
      list(ids),
    ) : [],
    // The customers' threads its people are in that may wait on someone.
    custThreads.size ? all(`SELECT ${ROW} FROM threads h
      WHERE h.thread IN (SELECT value FROM json_each(?1)) AND h.last_at >= ?2
        AND ${MAY_WAIT('h')}`, list(custThreads), since) : [],
    // The threads of the weeks it or its people are in: who posted first, and Adobe's answer.
    all(`WITH f AS (SELECT h.thread, h.org,
          (SELECT m.author_key FROM messages m WHERE m.thread = h.thread AND m.counted = 1
            AND m.deleted = 0 ORDER BY m.at LIMIT 1) AS key,
          (SELECT m.staff FROM messages m WHERE m.thread = h.thread AND m.counted = 1
            AND m.deleted = 0 ORDER BY m.at LIMIT 1) AS staff,
          (SELECT MIN(m.at) FROM messages m WHERE m.thread = h.thread AND m.counted = 1
            AND m.deleted = 0) AS first
        FROM threads h WHERE (h.org = ?1 OR h.thread IN (SELECT value FROM json_each(?3)))
          AND h.kind = 'channel' AND h.root_at >= ?2)
      SELECT f.org, f.key, f.staff, f.first, (SELECT MIN(m.at) FROM messages m
          WHERE m.thread = f.thread AND m.staff = 1 AND m.counted = 1 AND m.deleted = 0
            AND m.at > f.first) AS answered
      FROM f WHERE f.staff = 0`, slug, since, list(custThreads)),
  ]);
  const who = new Map(whoRows.map((r) => [r.id, r]));
  const typed = [
    ...ownRows.map((r) => ({ ...r, org_type: 'partner' })),
    ...custRows.map((r) => ({ ...r, org_type: orgOf.get(r.org)?.type || 'customer' })),
  ];
  const [entries, shares] = await Promise.all([entriesOf(env, typed), sharesOf(env, typed)]);
  const waiting = typed.map((r) => ({ row: listRow(r, entries.get(r.thread), shares), r }))
    .filter(({ row }) => row.waiting === 'us' && !entries.get(row.thread).resolved)
    .map(({ row }) => row)
    .sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')));
  const waitingOf = new Map();
  for (const w of waiting.filter((x) => x.org !== slug)) {
    waitingOf.set(w.org, (waitingOf.get(w.org) || 0) + 1);
  }

  // How soon Adobe answers what it starts: in its threads, the people's outside Adobe; in
  // customers', its people's.
  const answers = (rows) => {
    const waits = rows.filter((f) => f.answered)
      .map((f) => (Date.parse(f.answered) - Date.parse(f.first)) / 60000);
    return {
      asked: rows.length,
      answered: waits.length,
      median: middle(waits),
      // Every wait, in whole minutes, shortest first: the page draws each one (ui/customer.js).
      waits: waits.map((m) => Math.max(0, Math.round(m))).sort((a, b) => a - b),
    };
  };
  const ownFirsts = firsts.filter((f) => f.org === slug);
  const custFirsts = firsts.filter((f) => f.org !== slug && keyOf.has(f.key));

  const linkOf = new Map(linked.filter((c) => !merged.has(c.slug)).map((c) => [c.slug, c]));
  const unlinked = [...byCustomer].filter(([o, c]) => !linkOf.has(o)
    && (c.threads.size >= UNLINKED_MIN || c.people.size >= UNLINKED_MIN)).map(([o]) => o);
  const customers = [...linkOf.keys(), ...unlinked].map((o) => {
    const l = linkOf.get(o);
    const c = byCustomer.get(o);
    const row = orgOf.get(o);
    return {
      slug: o,
      name: (row && row.name) || (l && l.name) || null,
      type: (row && row.type) || (l && l.type) || 'customer',
      icon: (row && row.icon) || (l && l.icon) || null,
      linked: Boolean(l),
      confirmed: Boolean(l && l.confirmed),
      p: l ? l.p : null,
      signals: l ? l.signals : {},
      theirs: c ? c.threads.size : 0,
      people: c ? c.people.size : 0,
      messages: c ? c.messages : 0,
      ours: (ours.get(o) || new Set()).size,
      waiting: waitingOf.get(o) || 0,
      last: c ? c.last : null,
    };
  }).sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || Number(b.linked) - Number(a.linked)
    || b.theirs - a.theirs || (b.p ?? 0) - (a.p ?? 0) || a.slug.localeCompare(b.slug));

  const ranked = [...people.values()].sort((a, b) => b.messages - a.messages
    || String(a.name || '').localeCompare(String(b.name || '')));
  const nameOf = (o) => orgOf.get(o)?.name || linkOf.get(o)?.name || o;
  return {
    domains: domains.length,
    customers: {
      count: customers.length,
      linked: customers.filter((c) => c.linked).length,
      confirmed: customers.filter((c) => c.confirmed).length,
      list: customers.slice(0, MAX_PARTNER_CUSTOMERS),
    },
    people: {
      count: people.size,
      inCustomers: ranked.filter((e) => e.customers).length,
      list: ranked.slice(0, MAX_PARTNER_PEOPLE).map((e) => {
        const p = e.person ? who.get(e.person) : null;
        return {
          id: e.person,
          account: e.account,
          name: (p && p.name) || e.name || null,
          avatar: (p && p.avatar) || null,
          title: (p && p.title) || null,
          messages: e.messages,
          own: e.own,
          customers: e.customers,
          threads: e.threads.size,
          orgs: [...e.orgs].sort((x, y) => y[1].size - x[1].size || x[0].localeCompare(y[0]))
            .slice(0, MAX_PERSON_ORGS)
            .map(([o, t]) => ({ slug: o, name: nameOf(o), threads: t.size })),
          orgCount: e.orgs.size,
          weekly: e.weekly,
          last: e.last,
        };
      }),
    },
    posts: {
      own: weekly.own.reduce((n, v) => n + v, 0),
      customers: weekly.customers.reduce((n, v) => n + v, 0),
      ownThreads: ownThreads.size,
      customerThreads: custThreads.size,
      weekly,
    },
    waiting: {
      count: waiting.length,
      own: waiting.filter((w) => w.org === slug).length,
      customers: waiting.filter((w) => w.org !== slug).length,
      list: waiting,
    },
    answers: { own: answers(ownFirsts), customers: answers(custFirsts) },
  };
}

/** `partnerNumbers` as `me` sees it: the titles and links of the threads they work only. */
export function partnerForViewer(me, v) {
  if (!v) {
    return null;
  }
  const waiting = forViewer(me, v.waiting.list, MAX_PARTNER_WAITING);
  return { ...v, waiting: { ...v.waiting, list: waiting.list, hidden: waiting.hidden } };
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
