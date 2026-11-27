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

import { isolateCache } from './isolatecache.js';
import { entryOf } from './drafts.js';
import { entryRows, vectorOf } from './expertise.js';
import { registrable } from './favicons.js';
import { CLEF, stateOf, threadMessages } from './label.js';
import {
  customersOf, OWNER_SPREAD, ownerOf, partnersOf, standingOf,
} from './orgpartners.js';
import {
  customerDomains, customerOf, iconDomain, partnerDomains,
} from './partners.js';
import { PUBLIC_NOW } from './follows.js';
import { platformName } from './platforms.js';
import { partnerOf } from './profiles.js';
import { inParts } from './search.js';

/**
 * Threads linked across a partner and the customers it works for (src/orgpartners.js). A
 * partner's people work on a customer's sites in the partner's own channels and in the
 * customer's, and nothing said that two such threads were one matter. After each labelling of a
 * thread (src/normalizer.js, a `{ link }` job a minute later, once its vector is written), the link
 * job (`linkThread`) works out:
 *
 * - **which customer a partner's thread is about** (`thread_orgs`, role `about`): of the
 *   customers the partner works for (`customersOf`), the ones its facts name (an Edge Delivery
 *   or GitHub owner only that customer's threads name, a URL on its domain), its channel's or its
 *   text's words, and Clef's answer when asked about each (`aboutScores`, `aboutOf`);
 * - **the partners in a customer's thread** (role `partner`): those whose people posted in it,
 *   by their mail domain (src/partners.js `partnerDomains`, the one source of who is a partner's);
 * - **who is in a public thread** (an org of type `public`: a community's or an event's channel,
 *   where people of many orgs post): the partners whose people posted in it (role `partner`), and
 *   the customers (role `customer`), by their mail domain too (`customerDomains`, a customer's
 *   own); its people of no known org are the community, and link it with nobody;
 * - **"possibly the same issue"** (`thread_links`): the threads of the last RELATED_DAYS days in
 *   the linked orgs' channels (the customers it is about, else all the partner's; a customer's
 *   partners) whose thread vectors are like this one's (CONTENT, src/vectors.js), Clef deciding
 *   whether each is about the same issue, or a threshold without it.
 *
 * The inbox shows them (`linkedOrgsOf` for the list, `entryLinks` for the open thread); people
 * dismiss what is wrong (`dismissAbout`, `dismissLink`). The agents of both threads of a new
 * link are told (`relatedUpdate`, src/agent/related.js), and the search's customer filter takes
 * in the partners' threads about the customer (`aboutThreads`).
 */

/** From this probability on, a partner's thread is about the customer. */
export const ABOUT_MIN = 0.5;
/** What each fact says, as a probability that the thread is about the customer. */
export const FACT_OWNER_ONLY = 0.9;
export const FACT_OWNER_FEW = 0.75;
export const FACT_HOST = 0.85;
export const FACT_HOST_NAMED = 0.7;
/** A channel named for the customer, its name in the title, in the messages. */
export const CHANNEL_NAMED = 0.8;
export const TITLE_NAMED = 0.7;
export const TEXT_NAMED = 0.6;
/**
 * How much more Clef must say of a customer than of any other, where nothing else says the
 * thread is about it (measured on production: the one wrong answer of twenty had 0.07).
 */
export const CLEF_MARGIN = 0.25;
/** The customers Clef is asked about, at most, for one thread. */
export const ASK_CUSTOMERS = 12;
/** The days a related thread was active in. */
export const RELATED_DAYS = 14;
/** Below this similarity (bge, cosine, thread vectors) a thread is no candidate. */
export const RELATED_MIN = 0.75;
/** Without Clef, from this similarity on a candidate is kept. */
export const RELATED_SURE = 0.86;
/** From this probability on, Clef says the two are about the same issue. */
export const RELATED_P = 0.5;
/** New candidates Clef is asked about per job, and the vectors asked for. */
export const RELATED_ASK = 3;
const RELATED_K = 50;
const ASK_TIMEOUT_MS = 10000;
const MAX_LINKED = 100;
const SHOWN_FACTS = 8;
const EXCERPT = 600;
/** Of each thread Clef is shown its first and latest messages, this many, of this many letters. */
const SHOWN_MESSAGES = 4;
const MIN_SAID = 20;
const OWNERS_MS = 10 * 60 * 1000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const URL_FIELDS = new Set(['url', 'affected_url']);

const clean = (v, n = 300) => String(v ?? '').trim().slice(0, n);

async function rows(env, sql, ...args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

/** Letters and digits only, and the words of a text as `-word-word-` for whole-word matches. */
const compact = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
const words = (s) => `-${String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-')}-`;

/**
 * The names a text may call a customer by, as `words` has them: its display name, and its slug
 * where that is more than one word (a one-word slug, `acme`, is often a word of its own).
 */
function namesOf(c) {
  const out = [];
  const name = words(c.name).replace(/^-|-$/g, '');
  if (name.length >= 3) {
    out.push(name);
  }
  if (String(c.slug).includes('-')) {
    out.push(String(c.slug));
  }
  return [...new Set(out)];
}
const named = (text, c) => namesOf(c).some((n) => text.includes(`-${n}-`));

// ---- owners ----------------------------------------------------------------------------------

const ownersKept = isolateCache(OWNERS_MS);

/**
 * Which orgs that are not partners each GitHub or aem.live owner is named by, in their threads'
 * facts: `Map<owner, Set<org>>`. Kept in the isolate for OWNERS_MS, as the duplicates' facts are.
 */
async function loadOwners(env) {
  const list = await rows(env, `SELECT DISTINCT t.org, f.field, f.value
    FROM facts f JOIN threads t ON t.thread = f.thread LEFT JOIN orgs o ON o.slug = t.org
    WHERE COALESCE(o.type, 'customer') != 'partner' AND SUBSTR(t.org, 1, 1) != '_'
      AND (f.field IN ('site', 'repo') OR (f.field = 'url' AND (f.value LIKE '%.aem.%'
        OR f.value LIKE '%.hlx.%' OR f.value LIKE '%github.com/%')))`);
  const out = new Map();
  for (const r of list) {
    const o = ownerOf(r.field, r.value);
    if (o) {
      if (!out.has(o)) {
        out.set(o, new Set());
      }
      out.get(o).add(r.org);
    }
  }
  return out;
}

async function ownerIndex(env) {
  return ownersKept.get(env, loadOwners);
}

/** Forgets the owners kept (for tests). */
export function forgetOwners() {
  ownersKept.forget();
}

// ---- which customer ----------------------------------------------------------------------------

const hostOf = (value) => {
  try {
    return new URL(String(value || '').trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * What a partner's thread says of each of `customers` (`[{ slug, name, icon }]`): `Map<slug,
 * { facts, channel, text }>`, each the probability that one part of it gives that the thread is
 * about the customer (0 where it says nothing). `facts` are the thread's (`[{ field, value }]`),
 * `owners` `ownerIndex`'s; `channel` the channel's name, `title` and `text` the thread's.
 *
 * - an Edge Delivery or GitHub owner of a `site`, `repo` or `url` that only this customer's
 *   threads name (FACT_OWNER_ONLY), or this one and one other org's (FACT_OWNER_FEW): Adobe's own
 *   and demo owners are in many, and say nothing;
 * - a URL on the customer's own domain (its icon's, FACT_HOST), or on one that names it
 *   (`acme.com` for acme, FACT_HOST_NAMED);
 * - the customer's name as words of the channel's name, the title or the messages.
 */
export function aboutScores({
  env = {}, customers, facts = [], owners = new Map(), channel = '', title = '', text = '',
}) {
  const chan = words(channel);
  const head = words(title);
  const body = words(text);
  const out = new Map();
  for (const c of customers) {
    let f = 0;
    const own = iconDomain(env, c.icon);
    const names = [compact(c.slug), compact(c.name)].filter((n) => n.length >= 4);
    for (const { field, value } of facts) {
      const o = ownerOf(field, value);
      const by = o && owners.get(o);
      if (by && by.has(c.slug)) {
        if (by.size === 1) {
          f = Math.max(f, FACT_OWNER_ONLY);
        } else if (by.size <= OWNER_SPREAD) {
          f = Math.max(f, FACT_OWNER_FEW);
        }
      }
      const host = URL_FIELDS.has(field) && hostOf(value);
      if (host) {
        const reg = registrable(host);
        if (own && reg === own) {
          f = Math.max(f, FACT_HOST);
        } else if (names.includes(compact(reg.split('.')[0]))) {
          f = Math.max(f, FACT_HOST_NAMED);
        }
      }
    }
    let t = 0;
    if (named(head, c)) {
      t = TITLE_NAMED;
    } else if (named(body, c)) {
      t = TEXT_NAMED;
    }
    out.set(c.slug, { facts: f, channel: named(chan, c) ? CHANNEL_NAMED : 0, text: t });
  }
  return out;
}

/**
 * The customers a partner's thread is about, from `aboutScores`'s `scores` and Clef's answers
 * (`clef`: `Map<slug, p>`, for those it was asked about): `[{ org, p, via }]`, the likeliest first,
 * those of ABOUT_MIN or more. Clef reads the text, so where it answered its word stands for the
 * text's; the facts and the channel's name stand beside it. `p` is 1 − Π(1 − pᵢ) of those.
 * Where Clef is all that says so, its answer must beat its answer for every other customer by
 * CLEF_MARGIN: a thread about several of them, or none, gets close answers for each.
 */
export function aboutOf(scores, clef = new Map()) {
  const out = [];
  for (const [org, s] of scores) {
    const asked = clef.has(org);
    const said = asked ? clef.get(org) : s.text;
    const parts = [
      ['facts', s.facts], ['channel', s.channel], [asked ? 'clef' : 'text', said],
    ].filter(([, p]) => p > 0);
    const p = 1 - parts.reduce((q, [, x]) => q * (1 - x), 1);
    const others = [...clef].filter(([k]) => k !== org).map(([, x]) => x);
    const alone = asked && !s.facts && !s.channel;
    const clear = !alone || said - Math.max(0, ...others) >= CLEF_MARGIN;
    if (p >= ABOUT_MIN && clear) {
      // What said so: Clef only where it said yes.
      const via = parts.filter(([k, x]) => k !== 'clef' || x >= ABOUT_MIN).map(([k]) => k);
      out.push({ org, p: Math.round(p * 1000) / 1000, via: via.join(',') || 'clef' });
    }
  }
  return out.sort((a, b) => b.p - a.p || a.org.localeCompare(b.org));
}

/** Clef's question about one customer of the partner. */
export function aboutQuestion(c, partner) {
  const name = c.name ? `${c.name} (slug ${c.slug})` : c.slug;
  return {
    type: 'noul',
    instructions: `Is this thread about the customer ${name}: its sites, code, project or people,`
      + ` in work that ${partner}, a partner of Adobe's (an agency or system integrator), does for it?`,
  };
}

/** Runs `fn` for at most ASK_TIMEOUT_MS: null when it takes longer or fails. */
async function timed(what, fn) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } catch (e) {
    console.log(JSON.stringify({ route: 'threadlinks', clef: what, error: String(e && e.message) }));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Clef's probability for each of `customers` that the thread of `state` is about it. */
async function askAbout(env, state, customers, partner) {
  const keys = new Map(customers.map((c, i) => [`about_${i}`, c.slug]));
  const questions = Object.fromEntries(customers.map((c, i) => [`about_${i}`, aboutQuestion(c, partner)]));
  const res = await timed('about', () => env.AI.run(CLEF, { model: 'clef', state, questions }));
  const out = new Map();
  for (const [k, slug] of keys) {
    const p = Number(res && res.answers && res.answers[k] && res.answers[k].noul);
    if (Number.isFinite(p)) {
      out.set(slug, p);
    }
  }
  return out;
}

/** The text of messages, for the names in them. */
const textOf = (messages) => messages.filter((m) => !m.deletedAt).map((m) => m.body || '').join('\n');

/**
 * The customers a partner's entry is about (see `aboutScores`, `aboutOf`): its customers' scores
 * from the entry's facts, its channel's name, its title and messages, and Clef's answers.
 */
async function aboutCustomers(env, {
  entry, anchor, keys, partner,
}) {
  const customers = (await customersOf(env, anchor.org)).filter((c) => c.type === 'customer');
  if (!customers.length) {
    return [];
  }
  const [facts, owners, label] = await Promise.all([
    rows(
      env,
      'SELECT field, value FROM facts WHERE thread IN (SELECT value FROM json_each(?))',
      JSON.stringify(keys),
    ),
    ownerIndex(env),
    env.DB.prepare('SELECT title FROM labels WHERE thread = ?').bind(entry.key).first(),
  ]);
  const messages = await threadMessages(env, anchor);
  const title = (label && label.title) || anchor.title || '';
  const scores = aboutScores({
    env, customers, facts, owners, channel: anchor.channel_name, title, text: textOf(messages),
  });
  let clef = new Map();
  if (env.AI && messages.length) {
    // The customers with something for them first, then those the partner works for most surely.
    const ask = [...customers].sort((a, b) => {
      const s = (c) => Object.values(scores.get(c.slug)).reduce((x, y) => x + y, 0);
      return s(b) - s(a);
    }).slice(0, ASK_CUSTOMERS);
    const state = `This channel is of ${partner}, a partner of Adobe's (an agency or system integrator)`
      + ` that works for several of Adobe's customers.\n${stateOf({ ...anchor, org_type: 'partner' }, messages)}`;
    clef = await askAbout(env, state, ask, partner);
  }
  return aboutOf(scores, clef);
}

/**
 * The partners whose people posted in an entry, and with `customers` (a public thread's) the
 * customers whose people did, by their mail domain: `{ partners, customers }`, each `[{ org, p,
 * via, people }]`. A domain that is a partner's (or named no partner's, `excluded`) is no
 * customer's.
 */
async function postingOrgs(env, { keys, anchor, customers: withCustomers = false }) {
  const [list, domains, own] = await Promise.all([
    rows(env, `SELECT DISTINCT LOWER(i.email) AS email FROM messages m
      JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +m.author_key
      WHERE m.thread IN (SELECT value FROM json_each(?)) AND m.staff = 0 AND m.deleted = 0
        AND m.counted = 1 AND i.email LIKE '%_@_%' AND COALESCE(i.staff, 0) = 0`, JSON.stringify(keys)),
    partnerDomains(env),
    withCustomers ? customerDomains(env) : new Map(),
  ]);
  const partners = new Map();
  const customers = new Map();
  for (const { email } of list) {
    const domain = String(email).split('@')[1];
    const p = partnerOf(domain, domains);
    const c = !p && withCustomers && !domains.has(domain) ? customerOf(domain, own) : null;
    if (p && p.org && p.org !== anchor.org) {
      partners.set(p.org, (partners.get(p.org) || 0) + 1);
    } else if (c && c.org !== anchor.org) {
      customers.set(c.org, (customers.get(c.org) || 0) + 1);
    }
  }
  if (!partners.size && !customers.size) {
    return { partners: [], customers: [] };
  }
  // Only orgs that are partners now (a domain may name one retyped since), and customers: of no
  // other type (an org of no row is one), not merged.
  const typed = await rows(
    env,
    `SELECT slug, type FROM orgs
    WHERE slug IN (SELECT value FROM json_each(?1))
    UNION SELECT slug, 'merged' FROM org_merges WHERE slug IN (SELECT value FROM json_each(?1))`,
    JSON.stringify([...partners.keys(), ...customers.keys()]),
  );
  const typeOf = new Map();
  for (const r of typed) {
    typeOf.set(r.slug, typeOf.get(r.slug) === 'merged' ? 'merged' : r.type);
  }
  const out = (by, type) => [...by].filter(([org]) => (typeOf.get(org) || 'customer') === type)
    .map(([org, people]) => ({
      org, p: 1, via: 'posters', people,
    }));
  return { partners: out(partners, 'partner'), customers: out(customers, 'customer') };
}

/**
 * Writes the entry's `thread_orgs` of `role`: `found` (`[{ org, p, via }]`) upserted, a dismissed
 * row left as it is, and those of the role no longer found deleted unless dismissed.
 */
async function writeOrgs(env, key, role, found, now) {
  const writes = found.map((f) => env.DB.prepare(`INSERT INTO thread_orgs (thread, org, role, p, via, found_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (thread, org, role) DO UPDATE SET p = excluded.p,
      via = excluded.via, found_at = CASE WHEN thread_orgs.p = excluded.p
        AND thread_orgs.via = excluded.via THEN thread_orgs.found_at ELSE excluded.found_at END`)
    .bind(key, f.org, role, f.p, f.via, now));
  writes.push(env.DB.prepare(`DELETE FROM thread_orgs WHERE thread = ? AND role = ?
    AND dismissed_at IS NULL AND org NOT IN (SELECT value FROM json_each(?))`)
    .bind(key, role, JSON.stringify(found.map((f) => f.org))));
  await env.DB.batch(writes);
}

// ---- linked orgs -----------------------------------------------------------------------------

/**
 * The `about`, `partner` and `customer` rows of entry keys `keys` that are shown: not dismissed,
 * likely. An `about` row of a partner's thread and a customer's thread's `partner` row name a pair
 * of a customer and a partner, the row's org and its thread's, by the thread's org type now, as
 * the link job keeps the roles (`ROLES`; `pairable`), with how it stands (`org_partners`,
 * `pair_*`); a public thread's rows name none: a public org is nobody's customer or partner.
 */
async function shownOrgs(env, keys) {
  return rows(env, `SELECT x.thread, x.org, x.role, x.p, x.via, o.name, o.icon,
      ((x.role = 'about' AND ot.type = 'partner')
        OR (x.role = 'partner' AND COALESCE(ot.type, 'customer') = 'customer')) AS pairable,
      op.customer AS pair_customer, op.confirmed_at AS pair_confirmed,
      op.dismissed_at AS pair_dismissed, op.until AS pair_until, op.p AS pair_p
    FROM thread_orgs x LEFT JOIN orgs o ON o.slug = x.org
    LEFT JOIN threads t ON t.thread = x.thread LEFT JOIN orgs ot ON ot.slug = t.org
    LEFT JOIN org_partners op
      ON op.customer = CASE WHEN x.role = 'about' THEN x.org ELSE t.org END
      AND op.partner = CASE WHEN x.role = 'about' THEN t.org ELSE x.org END
    WHERE x.thread IN (SELECT value FROM json_each(?1)) AND x.dismissed_at IS NULL AND x.p >= ?2
      AND x.org NOT IN (SELECT slug FROM org_merges)
      AND (x.role != 'customer' OR ${PUBLIC_NOW('x')})
    ORDER BY x.p DESC, x.org`, JSON.stringify(keys), ABOUT_MIN);
}

/**
 * The orgs whose channels an entry's related threads are looked for in: for a partner's, the
 * customers it is about, else every customer the partner works for; for a customer's, its
 * partners and those whose people post in it. None for another org's (a vendor's, Adobe's own).
 */
export async function linkedOrgs(env, { keys, org, type }) {
  if (!org || String(org).startsWith('_')) {
    return [];
  }
  const shown = await shownOrgs(env, keys);
  if (type === 'partner') {
    const about = shown.filter((r) => r.role === 'about').map((r) => r.org);
    if (about.length) {
      return [...new Set(about)];
    }
    return (await customersOf(env, org)).filter((c) => c.type === 'customer').map((c) => c.slug)
      .slice(0, MAX_LINKED);
  }
  if (type === 'customer') {
    const posting = shown.filter((r) => r.role === 'partner').map((r) => r.org);
    const partners = (await partnersOf(env, org)).filter((p) => p.type === 'partner').map((p) => p.slug);
    return [...new Set([...partners, ...posting])].slice(0, MAX_LINKED);
  }
  return [];
}

/**
 * The thread agent of `name`, started: src/agent/stub.js's `agentStub`, which this file does not
 * import (the agent's computer Worker imports this one, not the inbox's stubs).
 */
async function agentOf(env, name) {
  const stub = env.AGENTS.get(env.AGENTS.idFromName(name));
  // eslint-disable-next-line no-underscore-dangle
  await stub.__unsafe_ensureInitialized();
  return stub;
}

// ---- possibly the same issue -----------------------------------------------------------------

const pairOf = (x, y) => (x < y ? [x, y] : [y, x]);

/**
 * Threads of the last `days` in the channels of `orgs` whose thread vectors are like `vector`, by
 * inbox entry, best first: `[{ key, score, org }]`, leaving out the entries `skip` (keys) and,
 * for a customer's entry (`customer`), a partner's thread about another customer.
 */
export async function similarIn(env, vector, orgs, {
  skip = [], days = RELATED_DAYS, min = RELATED_MIN, customer = null, now = new Date(),
} = {}) {
  if (!env.CONTENT || !vector || !orgs.length) {
    return [];
  }
  const filters = inParts(orgs, (part) => ({
    type: 'thread', org: part.length === 1 ? part[0] : { $in: part },
  }));
  // All the metadata: an indexed string comes back cut to its first 64 bytes, and a Teams
  // thread's key is longer. The scores are Vectorize's approximate ones, as the search's.
  const found = await Promise.all(filters.map((filter) => env.CONTENT.query(vector, {
    topK: RELATED_K, filter, returnMetadata: 'all',
  })));
  const matches = found.flatMap((f) => (f && f.matches) || [])
    .filter((m) => m.metadata && m.metadata.thread && m.score >= min);
  if (!matches.length) {
    return [];
  }
  const since = new Date(now.getTime() - days * 86400 * 1000).toISOString();
  const list = await rows(
    env,
    `SELECT thread, COALESCE(logical_thread, thread) AS g, org, kind,
      last_at FROM threads WHERE thread IN (SELECT value FROM json_each(?))`,
    JSON.stringify([...new Set(matches.map((m) => m.metadata.thread))]),
  );
  const byKey = new Map(list.map((r) => [r.thread, r]));
  const skipped = new Set(skip);
  const wanted = new Set(orgs);
  const best = new Map();
  for (const m of matches) {
    const r = byKey.get(m.metadata.thread);
    if (r && r.kind === 'channel' && r.last_at && r.last_at >= since && wanted.has(r.org)
      && !skipped.has(r.g) && !skipped.has(r.thread)) {
      const was = best.get(r.g);
      if (!was || m.score > was.score) {
        best.set(r.g, { key: r.g, score: Math.round(m.score * 1000) / 1000, org: r.org });
      }
    }
  }
  let out = [...best.values()];
  if (customer && out.length) {
    // A partner's thread about another customer is not this one's.
    const about = await rows(
      env,
      `SELECT thread, org FROM thread_orgs WHERE role = 'about'
      AND dismissed_at IS NULL AND p >= ? AND thread IN (SELECT value FROM json_each(?))`,
      ABOUT_MIN,
      JSON.stringify(out.map((x) => x.key)),
    );
    const of = new Map();
    for (const r of about) {
      of.set(r.thread, [...(of.get(r.thread) || []), r.org]);
    }
    out = out.filter((x) => !of.has(x.key) || of.get(x.key).includes(customer));
  }
  return out.sort((a, b) => b.score - a.score);
}

/** An entry as Clef is shown it: where it is, its title and facts, its first and latest words. */
async function describeEntry(env, letter, key) {
  const t = await env.DB.prepare(`SELECT t.*, COALESCE(l.title, t.title) AS shown_title, o.name AS org_name,
      COALESCE(o.type, 'customer') AS org_type
    FROM threads t LEFT JOIN labels l ON l.thread = t.thread LEFT JOIN orgs o ON o.slug = t.org
    WHERE t.thread = ?`).bind(key).first();
  if (!t) {
    return null;
  }
  const [facts, messages] = await Promise.all([
    rows(env, `SELECT field, value FROM facts WHERE thread = ? AND field IN ('site', 'repo', 'url',
      'affected_url', 'error', 'http_status', 'admin_api', 'ticket') ORDER BY field LIMIT ?`, key, SHOWN_FACTS),
    threadMessages(env, t),
  ]);
  // What people wrote: not the bots' and the platform's notices, nor a bare link or an image.
  const said = messages.filter((m) => !m.deletedAt && m.author && m.author.kind === 'person'
    && String(m.body || '').replace(/!?\[[^\]]*\]\([^)]*\)|https?:\S+/g, '').trim().length >= MIN_SAID);
  const shown = said.length > SHOWN_MESSAGES
    ? [said[0], ...said.slice(-(SHOWN_MESSAGES - 1))] : said;
  const who = t.org_type === 'partner' ? 'a partner' : 'a customer';
  return [
    `Thread ${letter}, in a channel of ${t.org_name || t.org} (${who}) on ${platformName(t.source)},`
      + ` #${t.channel_name || t.channel_id}: ${t.shown_title || '(no title)'}`,
    facts.length ? `Facts: ${facts.map((f) => `${f.field} ${f.value}`).join('; ')}` : null,
    ...shown.map((m, i) => `${i ? 'Later' : 'First'} message: ${String(m.body || '').slice(0, EXCERPT)}`),
  ].filter(Boolean).join('\n');
}

/**
 * Whether the facts of entries `a` and `b` (their keys) name the same GitHub or aem.live owner
 * that the threads of at most OWNER_SPREAD orgs that are not partners name: their site, their
 * repository. Adobe's own and demo owners are in many, and say nothing.
 */
async function sharedOwner(env, a, b) {
  const [fa, fb, owners] = await Promise.all([
    rows(env, 'SELECT field, value FROM facts WHERE thread IN (SELECT value FROM json_each(?))', JSON.stringify(a)),
    rows(env, 'SELECT field, value FROM facts WHERE thread IN (SELECT value FROM json_each(?))', JSON.stringify(b)),
    ownerIndex(env),
  ]);
  const of = (facts) => new Set(facts.map((f) => ownerOf(f.field, f.value)).filter(Boolean));
  const ob = of(fb);
  return [...of(fa)].some((o) => ob.has(o) && owners.has(o) && owners.get(o).size <= OWNER_SPREAD);
}

/**
 * Asked alone (Clef's answers move with the other questions of a call). Of the wordings tried on
 * production pairs judged by hand, this one parted the same issue from the merely alike best.
 */
export const SAME_QUESTION = 'Would someone working thread A want to know about thread B, because'
  + ' both deal with the same problem or the same change?';

/** What Clef is shown of entries `a` and `b` (their keys), or null where one is gone. */
export async function sameState(env, a, b) {
  const [da, db] = await Promise.all([describeEntry(env, 'A', a), describeEntry(env, 'B', b)]);
  if (!da || !db) {
    return null;
  }
  return 'Two threads of an ops inbox at Adobe, in the channels of two organizations that work'
    + ` together: a customer and a partner (an agency or system integrator) that works for it.\n\n${da}\n\n${db}`;
}

/** Clef's probability that entries `a` and `b` are about the same issue, or null. */
async function askSame(env, a, b) {
  const state = await sameState(env, a, b);
  if (!state) {
    return null;
  }
  const res = await timed('same', () => env.AI.run(CLEF, {
    model: 'clef', state, questions: { same: { type: 'noul', instructions: SAME_QUESTION } },
  }));
  const p = Number(res && res.answers && res.answers.same && res.answers.same.noul);
  return Number.isFinite(p) ? p : null;
}

/** Whether a link is shown: Clef said so, or it was not asked and the vectors are that alike. */
/**
 * Whether a link is shown: both name the same owner (a site, a repository few customers have)
 * and the vectors are alike, Clef said so, or it was not asked and the vectors are that alike.
 */
export const shownLink = (l) => !l.dismissed_at && (Boolean(l.owner)
  || (l.p == null ? l.score >= RELATED_SURE : l.p >= RELATED_P));

/** What says a link is shown, for the inbox: `owner`, `clef`, `vector`. */
export const linkVia = (l) => [l.owner && 'owner', l.p != null && l.p >= RELATED_P && 'clef',
  l.p == null && l.score >= RELATED_SURE && 'vector'].filter(Boolean);

/**
 * The entry's related threads, found and kept (see `similarIn`): the candidates, each kept with
 * its score; Clef asked about RELATED_ASK of the new ones (or of one whose verdict is missing);
 * `[{ a, b, score, p }]` of the links shown now that were not before.
 */
async function relate(env, {
  entry, anchor, type, now,
}) {
  const orgs = await linkedOrgs(env, { keys: entry.keys, org: anchor.org, type });
  if (!orgs.length || !env.CONTENT) {
    return { orgs: 0, candidates: 0, fresh: [] };
  }
  const vector = await vectorOf(env, await entryRows(env, entry.key));
  const found = await similarIn(env, vector, orgs, {
    skip: entry.keys, customer: type === 'customer' ? anchor.org : null, now,
  });
  if (!found.length) {
    return { orgs: orgs.length, candidates: 0, fresh: [] };
  }
  const kept = await rows(env, `SELECT * FROM thread_links WHERE (a = ?1 AND b IN (SELECT value FROM json_each(?2)))
    OR (b = ?1 AND a IN (SELECT value FROM json_each(?2)))`, entry.key, JSON.stringify(found.map((f) => f.key)));
  const keptBy = new Map(kept.map((l) => [`${l.a}\n${l.b}`, l]));
  const at = now.toISOString();
  const fresh = [];
  let asked = 0;
  for (const f of found) {
    const [a, b] = pairOf(entry.key, f.key);
    const was = keptBy.get(`${a}\n${b}`);
    let p = was ? was.p : null;
    let checked = was ? was.checked_at : null;
    if (env.AI && p == null && asked < RELATED_ASK && !(was && was.dismissed_at)) {
      asked += 1;
      // eslint-disable-next-line no-await-in-loop
      p = await askSame(env, entry.key, f.key);
      checked = p == null ? checked : at;
    }
    // eslint-disable-next-line no-await-in-loop
    const owner = was && was.owner ? 1 : Number(await sharedOwner(env, entry.keys, [f.key]));
    const link = {
      a,
      b,
      score: Math.max(f.score, was ? was.score : 0),
      p,
      owner,
      dismissed_at: was ? was.dismissed_at : null,
    };
    if (!was || was.score !== link.score || was.p !== p || Number(was.owner) !== owner) {
      // eslint-disable-next-line no-await-in-loop
      await env.DB.prepare(`INSERT INTO thread_links (a, b, score, p, owner, found_at, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (a, b) DO UPDATE SET score = excluded.score,
          p = excluded.p, owner = excluded.owner, checked_at = excluded.checked_at`)
        .bind(a, b, link.score, p, owner, at, checked).run();
    }
    if (shownLink(link) && !(was && shownLink(was))) {
      fresh.push(link);
    }
  }
  return {
    orgs: orgs.length, candidates: found.length, asked, fresh,
  };
}

/** The agents of both threads of each new link hear of it (src/agent/related.js). */
async function tellAgents(env, links) {
  if (!env.AGENTS) {
    return 0;
  }
  let told = 0;
  for (const l of links) {
    for (const [mine, other] of [[l.a, l.b], [l.b, l.a]]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const agent = await agentOf(env, mine);
        // eslint-disable-next-line no-await-in-loop
        await agent.relatedUpdate({
          kind: 'related', other, score: l.score, p: l.p,
        });
        told += 1;
      } catch (e) {
        console.warn(JSON.stringify({ route: 'threadlinks', tell: 'failed', error: e.message }));
      }
    }
  }
  return told;
}

/** The roles of `thread_orgs` the threads of each org type have. */
const ROLES = { partner: ['about'], customer: ['partner'], public: ['partner', 'customer'] };

/**
 * Queue job `{ link: thread }`, a minute after the thread was labelled: its entry's linked orgs
 * (`thread_orgs`) and related threads (`thread_links`), as above; the agent hears of a new
 * customer its thread is about, and both agents of a new link.
 */
export async function linkThread(env, key, now = new Date()) {
  const entry = await entryOf(env, key);
  if (!entry) {
    return { result: 'missing' };
  }
  const anchor = await env.DB.prepare(`SELECT t.*, COALESCE(o.type, 'customer') AS org_type,
      o.name AS org_name FROM threads t LEFT JOIN orgs o ON o.slug = t.org WHERE t.thread = ?`)
    .bind(entry.key).first();
  if (!anchor || anchor.kind !== 'channel' || String(anchor.org).startsWith('_')) {
    return { result: 'skip', reason: anchor ? anchor.kind : 'no thread' };
  }
  const type = anchor.org_type;
  const at = now.toISOString();
  // The roles its type has; those of another (its org was retyped, or its channel filed under
  // another org) go, as the rows of its own role it no longer finds do.
  const own = ROLES[type] || [];
  await env.DB.prepare(`DELETE FROM thread_orgs WHERE thread = ? AND dismissed_at IS NULL
    AND role NOT IN (SELECT value FROM json_each(?))`).bind(entry.key, JSON.stringify(own)).run();
  if (!own.length) {
    return { result: 'skip', reason: type };
  }
  const before = await shownOrgs(env, entry.keys);
  let orgs = [];
  if (type === 'partner') {
    orgs = await aboutCustomers(env, {
      entry, anchor, keys: entry.keys, partner: anchor.org_name || anchor.org,
    });
    await writeOrgs(env, entry.key, 'about', orgs, at);
  } else if (type === 'public') {
    // Who is in it, and nothing more: a public thread is related to no customer's own.
    const posting = await postingOrgs(env, { keys: entry.keys, anchor, customers: true });
    await writeOrgs(env, entry.key, 'partner', posting.partners, at);
    await writeOrgs(env, entry.key, 'customer', posting.customers, at);
    return {
      result: 'linked',
      role: 'customer',
      orgs: posting.partners.length + posting.customers.length,
      partners: posting.partners.length,
      customers: posting.customers.length,
      linked: 0,
      candidates: 0,
      asked: 0,
      related: 0,
      told: 0,
    };
  } else {
    orgs = (await postingOrgs(env, { keys: entry.keys, anchor })).partners;
    await writeOrgs(env, entry.key, 'partner', orgs, at);
  }
  const was = new Set(before.map((r) => `${r.role}:${r.org}`));
  const role = type === 'partner' ? 'about' : 'partner';
  const gained = orgs.filter((o) => o.p >= ABOUT_MIN && !was.has(`${role}:${o.org}`));
  const rel = await relate(env, {
    entry, anchor, type, now,
  });
  let told = await tellAgents(env, rel.fresh);
  if (gained.length && type === 'partner' && env.AGENTS) {
    try {
      const agent = await agentOf(env, entry.key);
      await agent.relatedUpdate({ kind: 'about', orgs: gained.map((o) => o.org) });
      told += 1;
    } catch (e) {
      console.warn(JSON.stringify({ route: 'threadlinks', tell: 'failed', error: e.message }));
    }
  }
  return {
    result: 'linked',
    role,
    orgs: orgs.length,
    linked: rel.orgs,
    candidates: rel.candidates,
    asked: rel.asked || 0,
    related: rel.fresh.length,
    told,
  };
}

// ---- what the inbox reads --------------------------------------------------------------------

const orgEntry = (r) => ({
  slug: r.org,
  name: r.name || null,
  icon: r.icon || null,
  role: r.role,
  p: r.p,
  via: String(r.via || '').split(',').filter(Boolean),
  // How the pair of the thread's org and this one stands (src/orgpartners.js `standingOf`); none
  // in a public thread, whose org is nobody's customer or partner (`shownOrgs`).
  ...(r.pairable ? {
    pair: standingOf(r.pair_customer ? {
      confirmed: r.pair_confirmed, dismissed: r.pair_dismissed, until: r.pair_until, p: r.pair_p,
    } : null),
  } : {}),
});

/**
 * The linked orgs of inbox entries, for the list: `Map<key, { about, with }>`, `about` the
 * customers a partner's thread is about, `with` the partners in a customer's thread, and the
 * partners and customers in a public one (`role` says which), each `{ slug, name, icon, role, p,
 * via, pair? }`, `pair` how the org and the thread's stand as partners (src/orgpartners.js
 * `standingOf`: confirmed, former, dismissed, or Clef's word), not in a public thread. `keys` are
 * the threads the list has (members too).
 */
export async function linkedOrgsOf(env, keys) {
  const out = new Map();
  if (!keys.length) {
    return out;
  }
  for (const r of await shownOrgs(env, keys)) {
    if (!out.has(r.thread)) {
      out.set(r.thread, { about: [], with: [] });
    }
    out.get(r.thread)[r.role === 'about' ? 'about' : 'with'].push(orgEntry(r));
  }
  return out;
}

/**
 * What the open thread shows of its links (`keys`: its entry's): `{ about, with, related }`,
 * `related` the threads possibly about the same issue, each `{ thread, score, p, org, org_name,
 * org_icon, org_type, team, source, channel_name, last_at }`, with its `title` and `permalink`
 * where `canSee(key)` says the viewer may see it (none of its words otherwise).
 */
export async function entryLinks(env, keys, canSee) {
  const [orgs, links] = await Promise.all([
    linkedOrgsOf(env, keys),
    rows(env, `SELECT * FROM thread_links WHERE dismissed_at IS NULL
      AND (a IN (SELECT value FROM json_each(?1)) OR b IN (SELECT value FROM json_each(?1)))
      ORDER BY owner DESC, COALESCE(p, score) DESC`, JSON.stringify(keys)),
  ]);
  const mine = new Set(keys);
  const about = [];
  const withs = [];
  for (const k of keys) {
    const o = orgs.get(k);
    if (o) {
      about.push(...o.about);
      withs.push(...o.with);
    }
  }
  const once = (list) => list.filter((x, i) => list.findIndex((y) => y.slug === x.slug) === i);
  const shown = links.filter(shownLink).map((l) => ({ ...l, other: mine.has(l.a) ? l.b : l.a }))
    .filter((l) => !mine.has(l.other));
  const others = shown.length ? await rows(env, `SELECT t.thread, t.org, t.team, t.source, t.channel_name,
      t.last_at, t.channel_id, COALESCE(l.title, t.title) AS title, o.name AS org_name, o.icon AS org_icon,
      COALESCE(o.type, 'customer') AS org_type,
      (SELECT m.permalink FROM messages m WHERE m.thread = t.thread AND m.permalink IS NOT NULL
        ORDER BY m.at LIMIT 1) AS permalink
    FROM threads t LEFT JOIN labels l ON l.thread = t.thread LEFT JOIN orgs o ON o.slug = t.org
    WHERE t.thread IN (SELECT value FROM json_each(?))`, JSON.stringify(shown.map((l) => l.other))) : [];
  const byKey = new Map(others.map((r) => [r.thread, r]));
  const related = [];
  for (const l of shown) {
    const r = byKey.get(l.other);
    if (r) {
      // eslint-disable-next-line no-await-in-loop
      const seen = await canSee(r.thread);
      related.push({
        thread: r.thread,
        score: l.score,
        p: l.p,
        via: linkVia(l),
        org: r.org,
        org_name: r.org_name || null,
        org_icon: r.org_icon || null,
        org_type: r.org_type,
        team: r.team,
        source: r.source,
        channel_name: r.channel_name || null,
        last_at: r.last_at,
        can_see: Boolean(seen),
        ...(seen ? { title: r.title || null, permalink: r.permalink || null } : {}),
      });
    }
  }
  return { about: once(about), with: once(withs), related };
}

/**
 * Of `keys` (inbox entries' keys), those a customer filter for `org` takes in: its own, the
 * partners' threads about it, and the public threads its people posted in.
 */
export async function aboutThreads(env, org, keys) {
  if (!keys.length || !org) {
    return new Set();
  }
  const list = await rows(
    env,
    `SELECT thread FROM threads WHERE org = ?1
      AND thread IN (SELECT value FROM json_each(?2))
    UNION SELECT x.thread FROM thread_orgs x WHERE x.org = ?1 AND x.dismissed_at IS NULL
      AND x.p >= ?3 AND x.thread IN (SELECT value FROM json_each(?2))
      AND (x.role = 'about' OR (x.role = 'customer' AND ${PUBLIC_NOW('x')}))`,
    String(org),
    JSON.stringify(keys),
    ABOUT_MIN,
  );
  return new Set(list.map((r) => r.thread));
}

// ---- dismissing ------------------------------------------------------------------------------

/** The entry key of `thread`, or null. */
async function entryKey(env, thread) {
  const r = await env.DB.prepare('SELECT COALESCE(logical_thread, thread) AS k FROM threads WHERE thread = ?')
    .bind(clean(thread)).first();
  return r ? r.k : null;
}

/**
 * POST /api/thread/about/dismiss `{ thread, org, role?, undo? }`: the thread is not about that
 * customer (or that partner is not in it); `undo` shows it again. The caller checks that the
 * viewer may work the thread.
 */
export async function dismissAbout(env, me, body) {
  const key = await entryKey(env, body.thread);
  const org = clean(body.org, 80);
  const role = ['partner', 'customer'].includes(body.role) ? body.role : 'about';
  if (!key || !SLUG.test(org)) {
    return { error: 'give a thread and an org', status: 400 };
  }
  const by = body.undo ? null : String(me.email || me.id);
  const at = body.undo ? null : new Date().toISOString();
  const res = await env.DB.prepare(`UPDATE thread_orgs SET dismissed_by = ?, dismissed_at = ?
    WHERE thread = ? AND org = ? AND role = ?`).bind(by, at, key, org, role).run();
  if (!(res.meta && res.meta.changes)) {
    return { error: 'not linked', status: 404 };
  }
  return {
    ok: true, thread: key, org, role, dismissed: !body.undo,
  };
}

/**
 * POST /api/thread/related/dismiss `{ thread, other, undo? }`: the two are not the same issue;
 * `undo` shows the link again. The caller checks that the viewer may work `thread`.
 */
export async function dismissLink(env, me, body) {
  const [x, y] = await Promise.all([entryKey(env, body.thread), entryKey(env, body.other)]);
  if (!x || !y || x === y) {
    return { error: 'give a thread and the other', status: 400 };
  }
  const [a, b] = pairOf(x, y);
  const by = body.undo ? null : String(me.email || me.id);
  const at = body.undo ? null : new Date().toISOString();
  const res = await env.DB.prepare(`UPDATE thread_links SET dismissed_by = ?, dismissed_at = ?
    WHERE a = ? AND b = ?`).bind(by, at, a, b).run();
  if (!(res.meta && res.meta.changes)) {
    return { error: 'not linked', status: 404 };
  }
  return {
    ok: true, thread: x, other: y, dismissed: !body.undo,
  };
}
