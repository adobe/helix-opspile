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
import { orgDomain } from './favicons.js';
import { json } from './http.js';
import { CLEF } from './label.js';
import { facts as orgFacts } from './orgmerge.js';
import { partnerDomainLookup } from './partners.js';
import {
  clefRequests, dateOf, openRequestsByPair, pairRequests, requestFor, settleRequests,
} from './partnerrequests.js';
import { platformName } from './platforms.js';
import { isAdmin } from './roles.js';
import {
  byThread, factThreads, md, namedIn, postedFrom, quoteLines, threadSection, threadsOf,
  whoCouldKnow, withQuotes,
} from './requestevidence.js';
import { UNASSIGNED } from './rules.js';

/**
 * Which customers each partner works for (migration 0110). A partner (an org of type
 * `partner`: an agency, a system integrator) works on the sites and projects of several
 * customers, in its own channels and in theirs, and nothing in the inbox said whose. The pairs
 * of a customer and a partner that may work together are found as duplicate customers are
 * (src/orgmerge.js):
 *
 * - candidates, from what the inbox knows of both (`partnerSignals`): the partner's people, by its
 *   usual mail domain, posting in the customer's threads (`posters`) or in its channels' members
 *   (`members`); the customer's people posting in the partner's threads (`guests`); the GitHub and
 *   aem.live owners the facts of both name, where few customers' threads name the owner
 *   (`owners`); the partner's knowledge base naming the customer's sites or name (`kb`); a Slack
 *   Connect or Teams team their channels share (`place`); and a channel whose name has both
 *   (`channel`, `<partner>-<customer>`);
 * - Clef, asked about each candidate with what it is shown of both: whether the partner works
 *   for the customer (`askPair`). Its answers are kept (`org_partners`), and asked again once
 *   what it would be shown changed, a few per list load and per cron run.
 *
 * The admin team decides a pair in its inbox, where each request to is a thread
 * (src/partnerrequests.js): a person's, an agent's, or Clef's, which every sync files where Clef
 * is unsure (`partnerWants`: a pair it is sure of counts as linked without one); or directly on
 * the pair's page, which anyone on an ops team reads (`orgPartners`); a pair confirmed may end
 * (`endPartner`: a former partner, until then), and every pair has the span of its partner's
 * posts in the customer's threads (`spanOf`). A candidate nobody decided that stops being one
 * goes. Everyone at Adobe reads an org's confirmed
 * and likely pairs (`partnersOf`, `customersOf`), with how many of each signal and no message
 * text. A merged org's decisions follow the merge (src/orgmerge.js `mergeOrgs`, `unmergeOrg`).
 */

/** From this probability on, Clef says the partner works for the customer: "likely". */
export const LIKELY = 0.5;
/**
 * Clef is unsure of a pair whose probability is in this band (inclusive): it asks the admin team
 * to decide one nobody decided (`partnerWants`). Above it, Clef is sure: the pair counts as
 * linked without anybody deciding it, as a likely one does. Below it, the pair is not linked.
 */
export const UNSURE_LOW = 0.35;
export const UNSURE_HIGH = 0.65;
/** What a pair's signals add up to before Clef is asked about it. */
export const CANDIDATE = 2;
/** Clef questions per list load and per cron run: the rest are asked the next time. */
const ASK_PER_LIST = 24;
const ASK_PARALLEL = 8;
const ASK_TIMEOUT_MS = 10000;
/**
 * An owner named in threads of more orgs than this (customers, vendors, Adobe's own; partners
 * are not counted) is nobody's own: Adobe's, a demo's.
 */
export const OWNER_SPREAD = 2;
/** A Slack or Teams team with channels of more orgs than this is a hub, not the two's. */
export const PLACE_SPREAD = 6;
/** Channels Clef is shown of each org, and the names a signal keeps. */
const SHOWN_CHANNELS = 8;
const SHOWN_NAMES = 5;
/** What the evidence is kept for in an isolate, as the duplicates' facts. */
const EVIDENCE_MS = 5 * 60 * 1000;
/** Of each knowledge-base entry, what is compared: its first characters. */
const KB_BODY = 4000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const bad = (error) => json({ error }, 400);
const keyOf = (customer, partner) => `${customer}\n${partner}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pctOf = (p) => `${Math.round(p * 100)}%`;

async function rows(env, sql, ...args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

// ---- owners ----------------------------------------------------------------------------------

/** GitHub paths that are not an owner. */
const NOT_OWNER = new Set(['orgs', 'users', 'settings', 'features', 'marketplace', 'apps', 'about',
  'login', 'enterprise', 'topics', 'collections', 'sponsors', 'search', 'notifications', 'pulls',
  'issues', 'explore', 'new', 'organizations']);
const OWNER = /^[a-z0-9][a-z0-9-]{0,38}$/;

/**
 * The GitHub or aem.live owner a fact names, lowercase, or null: a `site` or `repo` is
 * `<owner>/<repo>`, a `url` is `https://<branch>--<repo>--<owner>.aem.live/…` (or `.aem.page`,
 * `.hlx.*`), `https://github.com/<owner>/…`, or the admin API's `/<route>/<owner>/<repo>/…`.
 */
export function ownerOf(field, value) {
  const v = String(value || '').trim().toLowerCase();
  const ok = (o) => (o && OWNER.test(o) && !NOT_OWNER.has(o) ? o : null);
  if (field === 'site' || field === 'repo') {
    const m = v.match(/^([a-z0-9][a-z0-9-]*)\/[a-z0-9._-]+\/?$/);
    return m ? ok(m[1]) : null;
  }
  if (field !== 'url') {
    return null;
  }
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const host = u.hostname;
  const site = host.match(/^([a-z0-9-]+)\.(?:aem|hlx)\.(?:live|page)$/);
  const labels = site ? site[1].split('--') : [];
  if (labels.length >= 2) {
    return ok(labels[labels.length - 1]);
  }
  const seg = u.pathname.split('/').filter(Boolean);
  if (host === 'github.com' || host === 'www.github.com') {
    return seg.length >= 2 ? ok(seg[0]) : null;
  }
  if (host === 'admin.hlx.page' || host === 'admin.aem.live') {
    return seg.length >= 3 ? ok(seg[1]) : null;
  }
  return null;
}

// ---- evidence --------------------------------------------------------------------------------

/**
 * What the signals compare, beyond the duplicates' facts (`orgFacts`: every org, its channels and
 * their places): who posts in each org's threads, by mail domain (`posters`: `Map<org,
 * [{ domain, threads, people, first, last }]>`, most people first, with their first and last
 * post), who is in each org's channels (`members`: `Map<org, Map<domain, people>>`), the owners
 * each org's facts name (`owners`: `Map<org, Map<owner, threads>>`), and the partners'
 * knowledge-base entries (`kb`: `Map<partner, [{ path, head, body }]>`: the path, title and
 * aliases, and the text, lowercase).
 */
async function loadEvidence(env) {
  const [posters, members, owned, kb] = await Promise.all([
    rows(env, `SELECT t.org, LOWER(SUBSTR(i.email, INSTR(i.email, '@') + 1)) AS domain,
        COUNT(DISTINCT m.thread) AS threads, COUNT(DISTINCT m.author_key) AS people,
        MIN(m.at) AS first, MAX(m.at) AS last
      FROM messages m JOIN threads t ON t.thread = m.thread
      JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +m.author_key
      WHERE m.staff = 0 AND m.deleted = 0 AND m.counted = 1 AND i.email LIKE '%_@_%' AND t.org != ?1
      GROUP BY t.org, domain`, UNASSIGNED),
    rows(env, `WITH co AS (SELECT DISTINCT source, tenant, channel_id, org FROM threads WHERE org != ?1)
      SELECT co.org, LOWER(SUBSTR(m.email, INSTR(m.email, '@') + 1)) AS domain,
        COUNT(DISTINCT LOWER(m.email)) AS people
      FROM channel_members m JOIN co ON co.source = m.source AND co.tenant = m.tenant
        AND co.channel_id = m.channel_id
      WHERE m.email LIKE '%_@_%' GROUP BY co.org, domain`, UNASSIGNED),
    rows(env, `SELECT t.org, f.field, f.value, COUNT(DISTINCT f.thread) AS threads
      FROM facts f JOIN threads t ON t.thread = f.thread
      WHERE t.org != ?1 AND (f.field IN ('site', 'repo') OR (f.field = 'url' AND (f.value LIKE '%.aem.%'
        OR f.value LIKE '%.hlx.%' OR f.value LIKE '%github.com/%')))
      GROUP BY t.org, f.field, f.value`, UNASSIGNED),
    rows(env, `SELECT k.repo, k.path, k.title, k.aliases, SUBSTR(k.body, 1, ${KB_BODY}) AS body
      FROM kb_concepts k JOIN knowledge_bases b ON b.repo = k.repo
      JOIN orgs o ON o.slug = b.slug AND o.type = 'partner'
      WHERE b.kind = 'org'`),
  ]);
  const by = new Map();
  for (const r of posters) {
    if (orgDomain(env, r.domain)) {
      if (!by.has(r.org)) {
        by.set(r.org, []);
      }
      by.get(r.org).push({
        domain: r.domain, threads: r.threads, people: r.people, first: r.first, last: r.last,
      });
    }
  }
  for (const list of by.values()) {
    list.sort((x, y) => y.people - x.people || y.threads - x.threads
      || x.domain.localeCompare(y.domain));
  }
  const inChannels = new Map();
  for (const r of members) {
    if (!inChannels.has(r.org)) {
      inChannels.set(r.org, new Map());
    }
    inChannels.get(r.org).set(r.domain, r.people);
  }
  const owners = new Map();
  for (const r of owned) {
    const o = ownerOf(r.field, r.value);
    if (o) {
      if (!owners.has(r.org)) {
        owners.set(r.org, new Map());
      }
      const m = owners.get(r.org);
      // A thread may name the owner in several facts: the most of any one is a floor.
      m.set(o, Math.max(m.get(o) || 0, r.threads));
    }
  }
  const entries = new Map();
  for (const r of kb) {
    const slug = String(r.repo).slice('kb-org-'.length);
    if (!entries.has(slug)) {
      entries.set(slug, []);
    }
    entries.get(slug).push({
      path: String(r.path).toLowerCase(),
      head: [r.path, r.title, r.aliases].filter(Boolean).join('\n').toLowerCase(),
      body: String(r.body || '').toLowerCase(),
    });
  }
  return {
    posters: by, members: inChannels, owners, kb: entries,
  };
}

const evidenceKept = isolateCache(EVIDENCE_MS);

/** The evidence (`loadEvidence`), kept as src/orgmerge.js keeps its facts. */
async function evidence(env, { fresh = false } = {}) {
  return evidenceKept.get(env, loadEvidence, { fresh });
}

/**
 * The pairs Clef gave no verdict on when a pair's page asked (`onePair`: a timeout, an error), by
 * `customer\npartner`, when: their pages do not ask again for `UNANSWERED_MS` in the isolate, so
 * a slow Clef does not slow every view; the next sync asks as ever.
 */
const UNANSWERED_MS = 5 * 60 * 1000;
const unanswered = new Map();

/** When Clef last gave no verdict on the pair (ms), within `UNANSWERED_MS`, or null. */
function unansweredAt(key, now = Date.now()) {
  const at = unanswered.get(key);
  if (at && now - at < UNANSWERED_MS) {
    return at;
  }
  unanswered.delete(key);
  return null;
}

/** Forgets the evidence kept, and the pairs Clef did not answer on (for tests). */
export function forgetEvidence() {
  evidenceKept.forget();
  unanswered.clear();
}

// ---- signals ---------------------------------------------------------------------------------

/** Letters and digits only, and the dash-separated parts of a name. */
const compact = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
const parts = (s) => `-${String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-')}-`;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `text` has `word` as a word of its own (not part of a longer one). */
const hasWord = (text, word) => new RegExp(`(^|[^a-z0-9])${escape(word)}($|[^a-z0-9])`).test(text);

/** The partner whose people write from `domain` or a parent of it, or null (as `partnerOf`). */
export function domainPartner(domains, domain) {
  const labels = String(domain || '').toLowerCase().split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    const d = labels.slice(i).join('.');
    if (domains.has(d)) {
      return domains.get(d);
    }
  }
  return null;
}

/**
 * Each org's usual mail domain: the one most of its people outside Adobe post from, of no other
 * org's partner domains (`partnerOf`, `domainPartner`'s): a partner's people may well outnumber the
 * customer's in its channel, and are not the customer's.
 */
function usualDomains(ev, partnerOf = new Map()) {
  const usual = new Map();
  for (const [slug, list] of ev.posters) {
    const own = list.find((r) => [null, slug].includes(domainPartner(partnerOf, r.domain)));
    if (own) {
      usual.set(slug, own.domain);
    }
  }
  return usual;
}

/** Each partner's usual mail domain as its partner's (`partnerMailDomains`'s shape), for tests. */
function postedDomains(orgs, ev) {
  const usual = usualDomains(ev);
  return new Map([...orgs.values()].filter((o) => o.type === 'partner' && usual.has(o.slug))
    .map((o) => [usual.get(o.slug), o.slug]));
}

/**
 * Whose people write from each partner domain, `{ domains: Map<domain, partner | null>, found }`:
 * the one place the `posters`, `guests` and `members` signals get them. From src/partners.js
 * `partnerDomainLookup` (`found` is its: false when no look for them succeeded yet), the
 * domains found and the admin team's rows over them, by the partner org each is of (`orgs`, not
 * merged); `null` is a domain that is no partner's (excluded), or of no partner org here, which
 * keeps its subdomains from counting as their parent's (`domainPartner`).
 */
export async function partnerMailDomains(env, orgs) {
  const { domains, found } = await partnerDomainLookup(env);
  const out = new Map();
  for (const [domain, d] of domains) {
    const org = d && d.org && orgs.get(d.org);
    out.set(domain, org && org.type === 'partner' ? org.slug : null);
  }
  return { domains: out, found };
}

/**
 * What every pair is compared with, worked out once per list: each org's usual mail domain, whose
 * each partner domain is (`partnerMailDomains`, else each partner's usual one), how many orgs'
 * threads name each owner, and how many orgs have a channel in each place.
 */
export function contextOf(orgs, ev, domains = null) {
  const partnerOf = domains || postedDomains(orgs, ev);
  const usual = usualDomains(ev, partnerOf);
  // Each partner's own domains (not their subdomains), as Clef and the admin team are told.
  const partnerMail = new Map();
  for (const [d, slug] of partnerOf) {
    if (slug) {
      partnerMail.set(slug, [...(partnerMail.get(slug) || []), d].sort());
    }
  }
  // Partners name their customers' owners: the owners of Adobe and of demos are in the
  // threads of many customers, or of Adobe's own orgs.
  const ownerSpread = new Map();
  for (const [slug, m] of ev.owners) {
    if ((orgs.get(slug) || { type: 'customer' }).type !== 'partner') {
      for (const o of m.keys()) {
        ownerSpread.set(o, (ownerSpread.get(o) || 0) + 1);
      }
    }
  }
  const places = new Map();
  for (const o of orgs.values()) {
    for (const p of new Set((o.channels || []).flatMap((c) => c.places || []))) {
      places.set(p, (places.get(p) || 0) + 1);
    }
  }
  return {
    usual, partnerOf, partnerMail, ownerSpread, places,
  };
}

/** Of a list of names, the first few and how many more, as a signal says them. */
const listed = (names) => `${names.slice(0, SHOWN_NAMES).join(', ')}${names.length > SHOWN_NAMES ? ` and ${names.length - SHOWN_NAMES} more` : ''}`;

/**
 * The names of a customer the partner's knowledge base may use: its display name, and its slug
 * where it has more than one word (a slug of one word may be any word: a channel `aem-public`).
 */
function namesOf(o) {
  return [...new Set([o.name, o.slug.includes('-') ? o.slug : null].filter(Boolean)
    .map((n) => String(n).toLowerCase().trim()))].filter((n) => compact(n).length >= 5);
}

/** How much the partner's people posting in the customer's threads says. */
function postersWeight(threads, people) {
  if (threads >= 10 && people >= 2) {
    return 3;
  }
  return threads >= 3 || people >= 2 ? 2 : 1;
}

/** How much the partner's people in the customer's channels say. */
function membersWeight(n) {
  if (n >= 5) {
    return 2;
  }
  return n >= 2 ? 1.5 : 1;
}

/**
 * When the partner's people posted in the customer's threads, as the inbox has them (its history
 * is a floor): `{ first, last }`, ISO times, or nulls when they never did.
 */
export function spanOf(c, p, ev, ctx) {
  const its = (ev.posters.get(c.slug) || [])
    .filter((r) => domainPartner(ctx.partnerOf, r.domain) === p.slug);
  const firsts = its.map((r) => r.first).filter(Boolean).sort();
  const lasts = its.map((r) => r.last).filter(Boolean).sort();
  return { first: firsts[0] || null, last: lasts[lasts.length - 1] || null };
}

/**
 * Why partner `p` may work for customer `c` (both orgs of the duplicates' facts), each
 * `{ kind, weight, n, text, of }`: `n` is how many (threads, people, owners, entries, places,
 * channels), `text` says it, with names for the admin team, and `of` is what it found (the mail
 * domains, owners, knowledge-base paths, places or channels), which a request's evidence
 * (`partnerEvidence`) and Clef's quotes (`pairQuotes`) look the messages up by. `ev` is the
 * evidence, `ctx` `contextOf`'s.
 */
export function partnerSignals(c, p, ev, ctx) {
  const out = [];
  const its = (d) => domainPartner(ctx.partnerOf, d) === p.slug;
  const named = (list) => `${listed(list)}, the partner's mail ${list.length === 1 ? 'domain' : 'domains'}`;
  // The partner's people, from its mail domains, post in the customer's threads: people of each
  // domain are others, a thread may have several (the most of one is a floor).
  const posted = (ev.posters.get(c.slug) || []).filter((r) => its(r.domain));
  if (posted.length) {
    const threads = Math.max(...posted.map((r) => r.threads));
    const people = posted.reduce((n, r) => n + r.people, 0);
    out.push({
      kind: 'posters',
      weight: postersWeight(threads, people),
      n: threads,
      people,
      text: `${plural(people, 'person', 'people')} from ${named(posted.map((r) => r.domain))}, posted in ${plural(threads, 'thread')} of the customer's`,
      of: posted.map((r) => r.domain),
    });
  }
  // The customer's people, from its usual mail domain, post in the partner's threads.
  const home = ctx.usual.get(c.slug);
  const guest = home && !its(home)
    && (ev.posters.get(p.slug) || []).find((r) => r.domain === home);
  if (guest) {
    const { threads, people } = guest;
    out.push({
      kind: 'guests',
      weight: threads >= 3 || people >= 2 ? 2 : 1,
      n: threads,
      people,
      text: `${plural(people, 'person', 'people')} from ${home}, the customer's usual mail domain, posted in ${plural(threads, 'thread')} of the partner's`,
      of: [home],
    });
  }
  // The partner's people are in the customer's channels.
  const inChannels = [...(ev.members.get(c.slug) || new Map())].filter(([d]) => its(d));
  const members = inChannels.reduce((n, [, k]) => n + k, 0);
  if (members) {
    out.push({
      kind: 'members',
      weight: membersWeight(members),
      n: members,
      text: `${plural(members, 'person', 'people')} from ${listed(inChannels.map(([d]) => d))} ${members === 1 ? 'is' : 'are'} in the customer's channels`,
      of: inChannels.map(([d]) => d),
    });
  }
  // The same GitHub or aem.live owner in the facts of both, one only a few customers have.
  const mine = ev.owners.get(c.slug) || new Map();
  const shared = [...(ev.owners.get(p.slug) || new Map()).keys()]
    .filter((o) => mine.has(o) && (ctx.ownerSpread.get(o) || 0) <= OWNER_SPREAD).sort();
  if (shared.length) {
    // An owner only this customer's threads name says more than one two of them name.
    const only = shared.some((o) => (ctx.ownerSpread.get(o) || 0) <= 1);
    out.push({
      kind: 'owners',
      weight: (shared.length >= 2 ? 0.5 : 0) + (only ? 2.5 : 1.5),
      n: shared.length,
      text: `threads of both name the site owner${shared.length === 1 ? '' : 's'} ${listed(shared)}`,
      of: shared,
    });
  }
  // The partner's knowledge base names the customer's sites, or the customer.
  const entries = ev.kb.get(p.slug) || [];
  if (entries.length) {
    const owners = [...mine.keys()].filter((o) => (ctx.ownerSpread.get(o) || 0) <= OWNER_SPREAD
      && o.length >= 3);
    const names = namesOf(c);
    // An entry about the customer: `sites/<slug>-….md`, `projects/<slug>.md`.
    const lead = (e) => {
      const m = e.path.match(/^(?:sites|customers?|projects)\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/);
      return Boolean(m) && c.slug.length >= 4 && `${m[1]}-`.startsWith(`${c.slug}-`);
    };
    // An owner in an entry's path, title or aliases, or as an owner in its text (`<owner>/<repo>`,
    // `--<owner>.aem.live`); a name in its path, title or aliases.
    const naming = entries.filter((e) => lead(e) || owners.some((o) => hasWord(e.head, o)
      || new RegExp(`(^|[^a-z0-9-])${escape(o)}/[a-z0-9]|--${escape(o)}\\.(aem|hlx)\\.`).test(e.body))
      || names.some((n) => hasWord(e.head, n)));
    if (naming.length) {
      // An entry of its own about the customer: `sites/<owner>.md`, `projects/<customer>.md`.
      const slugged = [...owners, ...names].map((t) => t.replace(/[^a-z0-9]+/g, '-'));
      const entry = naming.some((e) => lead(e) || (/^(sites|customers?|projects)\//.test(e.path)
        && slugged.some((t) => hasWord(e.path, t))));
      out.push({
        kind: 'kb',
        weight: entry ? 3 : 2,
        n: naming.length,
        text: `${plural(naming.length, 'entry', 'entries')} of the partner's knowledge base name${naming.length === 1 ? 's' : ''} the customer or its sites (${listed(naming.map((e) => e.path))})`,
        of: naming.map((e) => e.path),
      });
    }
  }
  // Channels of both with the same Slack Connect or Teams team, one few orgs share.
  const placesOf = (o) => new Set((o.channels || []).flatMap((x) => x.places || [])
    .filter((x) => !x.startsWith('portal:')));
  const pc = placesOf(c);
  const common = [...placesOf(p)]
    .filter((x) => pc.has(x) && (ctx.places.get(x) || 2) <= PLACE_SPREAD);
  if (common.length) {
    const others = Math.min(...common.map((x) => ctx.places.get(x) || 2)) - 2;
    const teams = common.some((x) => x.startsWith('teams:'));
    out.push({
      kind: 'place',
      weight: others > 2 ? 1 : 2,
      n: common.length,
      text: `channels of both are with the same ${teams ? 'Teams team' : 'Slack Connect team'}${others > 0 ? `, as are channels of ${plural(others, 'other org')}` : ''}`,
      of: common,
    });
  }
  // A channel named for both: `<partner>-<customer>`.
  const pn = [...new Set([p.slug, compact(p.name)].filter((x) => x && x.length >= 3))];
  const cn = [...new Set([c.slug, compact(c.name)].filter((x) => x && x.length >= 3))];
  const both = [...(p.channels || []), ...(c.channels || [])].filter((x) => {
    const n = parts(x.name || x.label);
    return pn.some((s) => n.includes(`-${s}-`)) && cn.some((s) => n.includes(`-${s}-`));
  }).map((x) => x.label);
  if (both.length) {
    out.push({
      kind: 'channel',
      weight: 3,
      n: both.length,
      text: `${both.length === 1 ? 'a channel is' : `${both.length} channels are`} named for both (${listed(both)})`,
      of: both,
    });
  }
  return out;
}

const scoreOf = (signals) => signals.reduce((n, s) => n + s.weight, 0);

/**
 * Signals that make no candidate alone, however much they weigh: a knowledge-base entry that
 * names a customer, a Slack Connect or Teams team both have. Clef found most such pairs unlikely.
 */
const NOT_ALONE = new Set(['kb', 'place']);
const enough = (signals) => scoreOf(signals) >= CANDIDATE
  && !(signals.length === 1 && NOT_ALONE.has(signals[0].kind));

/**
 * The pairs of a customer and a partner whose signals add up to `CANDIDATE`, and are more than a
 * `NOT_ALONE` signal, strongest first: `[{ customer, partner, signals, score }]`. `f` is the
 * duplicates' facts, `ev` the evidence, `ctx` `contextOf`'s (of `f.orgs` and `ev` when none).
 */
export function partnerCandidates(f, ev, ctx = contextOf(f.orgs, ev)) {
  const all = [...f.orgs.values()];
  const partners = all.filter((o) => o.type === 'partner');
  const customers = all.filter((o) => o.type === 'customer');
  const out = [];
  for (const p of partners) {
    for (const c of customers) {
      const signals = partnerSignals(c, p, ev, ctx);
      if (enough(signals)) {
        out.push({
          customer: c.slug, partner: p.slug, signals, score: scoreOf(signals),
        });
      }
    }
  }
  return out.sort((x, y) => y.score - x.score || x.customer.localeCompare(y.customer)
    || x.partner.localeCompare(y.partner));
}

// ---- Clef ------------------------------------------------------------------------------------

const INTRO = 'An ops inbox at Adobe files Slack, Teams and Discord channels under organizations:'
  + ' customers, partners, vendors, or Adobe itself. A partner is an agency or system integrator'
  + ' that builds, runs or supports websites and projects with Adobe for several customers, in'
  + ' its own channels and in the customers\'. A channel name is usually'
  + ' <product>-<organization> (aem-acme), sometimes <partner>-<customer>. Below are a customer C'
  + ' and a partner P, with what the inbox found that they share.';
export const QUESTION = 'Does partner P work for customer C: is P an agency, system integrator'
  + ' or other partner on C\'s websites or projects, rather than the two sharing these things by'
  + ' chance?';

/** A count as Clef is told it: one, a few, many. It is asked again when that changes. */
const about = (n) => {
  if (n <= 1) {
    return 'one';
  }
  return n < 10 ? 'a few' : 'many';
};

/** A signal as Clef is told it, without what grows with every thread. */
function said(s) {
  switch (s.kind) {
    case 'posters': return `${about(s.people)} of P's people posted in ${about(s.n)} of C's threads`;
    case 'guests': return `${about(s.people)} of C's people posted in ${about(s.n)} of P's threads`;
    case 'members': return `${about(s.n)} of P's people ${s.n === 1 ? 'is' : 'are'} in C's channels`;
    default: return s.text.replace(/\bthe customer\b/g, 'C').replace(/\bthe partner\b/g, 'P');
  }
}

/** An org as Clef is told about it. */
function describeOrg(letter, o, domain) {
  const bits = [`slug ${o.slug}`];
  if (o.name) {
    bits.push(`display name "${o.name}"`);
  }
  bits.push(o.type);
  const shown = (o.channels || []).slice(0, SHOWN_CHANNELS).map((c) => `${c.label} (${platformName(c.source)})`);
  const more = o.channels.length > SHOWN_CHANNELS ? ` and ${o.channels.length - SHOWN_CHANNELS} more` : '';
  const chans = shown.length ? ` Channels: ${shown.join(', ')}${more}.` : ' No channels.';
  const mail = domain ? ` Its people write from ${domain}.` : '';
  return `${letter}: ${bits.join(', ')}.${chans}${mail}`;
}

/**
 * C's other partners as Clef is told them: `others`, `[{ slug, name, signals, until }]`, those
 * the admin team confirmed (not Clef's likely ones, whose verdicts would move each other's), each
 * with how many of its people post in C's threads, and a former one until when. One of a few
 * posts beside a partner of many does other work, or none, rather than build the site.
 */
function othersOf(others) {
  if (!others.length) {
    return '';
  }
  const one = (o) => {
    const posted = (o.signals || []).find((s) => s.kind === 'posters');
    const what = posted
      ? `${about(posted.people)} of its people posted in ${about(posted.n)} of C's threads`
      : 'none of its people posted in C\'s threads';
    // A former partner, by the month it ended: a day more is no news.
    const until = o.until ? `, until ${o.until.slice(0, 7)}` : '';
    return `${o.name ? `"${o.name}"` : o.slug} (${what}${until})`;
  };
  return `\nC's partners the admin team confirmed: ${others.map(one).join('; ')}.`;
}

/** What Clef is shown of a pair, with C's other partners the admin team confirmed (`othersOf`). */
export function pairState(c, p, signals, ctx, others = []) {
  const shared = signals.length ? `\nFound: ${signals.map(said).join('; ')}.` : '';
  const mail = (ctx.partnerMail.get(p.slug) || []).join(', ') || ctx.usual.get(p.slug);
  return `${INTRO}\n${describeOrg('C', c, ctx.usual.get(c.slug))}\n${describeOrg('P', p, mail)}${shared}${othersOf(others)}`;
}

/** Each customer's partners the admin team confirmed, from rows of `org_partners`, by customer. */
function confirmedPartners(kept, orgs) {
  const by = new Map();
  for (const r of kept) {
    if (r.confirmed_at && !r.dismissed_at && orgs.has(r.customer) && orgs.has(r.partner)) {
      let signals = [];
      try {
        signals = JSON.parse(r.signals || '[]');
      } catch {
        // none
      }
      const o = orgs.get(r.partner);
      const list = by.get(r.customer) || [];
      by.set(r.customer, [...list, {
        slug: r.partner, name: o.name || null, signals, until: r.until || null,
      }]);
    }
  }
  for (const list of by.values()) {
    list.sort((a, b) => a.slug.localeCompare(b.slug));
  }
  return by;
}

async function fingerprintOf(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d).slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Clef's probability that the partner of `state` works for its customer, or null. */
async function askPair(env, state, wait = ASK_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), wait);
  });
  try {
    const res = await Promise.race([env.AI.run(CLEF, {
      model: 'clef', state, questions: { works: { type: 'noul', instructions: QUESTION } },
    }), timeout]);
    // A timeout answers null, and Number(null) is 0: only a number Clef gave is a verdict.
    const p = res && res.answers && res.answers.works && res.answers.works.noul;
    return typeof p === 'number' && Number.isFinite(p) ? p : null;
  } catch (e) {
    console.log(JSON.stringify({ route: 'orgpartners', clef: 'failed', error: String(e && e.message) }));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `fn` on each of `items`, `n` at a time. */
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) {
      // eslint-disable-next-line no-await-in-loop
      await fn(queue.shift());
    }
  }));
}

// ---- what their messages say ----------------------------------------------------------------

/** What a signal found (`of`), or none. */
const foundBy = (signals, kind) => ((signals || []).find((s) => s.kind === kind) || {}).of || [];
/** The names a message may call an org by: its display name, and its slug. */
const callable = (o) => [o.name, o.slug].filter(Boolean);

/**
 * The messages behind a pair's signals (`signals`, `partnerSignals`'s, of `c` and `p`, `ctx`
 * `contextOf`'s): the partner's people in the customer's threads (`posters`), the customer's in the
 * partner's (`guests`), the customer named in the partner's threads (`customer`) and the partner
 * in the customer's (`partner`). Each a list of messages (src/requestevidence.js).
 */
async function pairMessages(env, c, p, signals, ctx, { limit } = {}) {
  const domains = [...new Set([...foundBy(signals, 'posters'), ...(ctx.partnerMail.get(p.slug) || [])])];
  const home = ctx.usual.get(c.slug);
  const homeIsTheirs = home && domainPartner(ctx.partnerOf, home) === p.slug;
  const [posters, guests, customer, partner] = await Promise.all([
    postedFrom(env, { orgs: [c.slug], domains, limit }),
    home && !homeIsTheirs ? postedFrom(env, { orgs: [p.slug], domains: [home], limit }) : [],
    namedIn(env, { orgs: [p.slug], names: callable(c), limit }),
    namedIn(env, { orgs: [c.slug], names: callable(p), limit }),
  ]);
  return {
    posters, guests, customer, partner, domains, home,
  };
}

/**
 * What Clef is shown of the pair's messages beside the signals (`withQuotes`): short quotes of
 * the messages behind them, without who wrote them (src/requestevidence.js `quoteLines`). None
 * when they cannot be read: the verdict is asked on the signals alone then.
 */
export async function pairQuotes(env, c, p, signals, ctx) {
  try {
    const m = await pairMessages(env, c, p, signals, ctx, { limit: 60 });
    const its = (email) => Boolean(email) && domainPartner(ctx.partnerOf, String(email).split('@')[1]) === p.slug;
    const who = (x) => {
      if (x.staff) {
        return 'Adobe staff';
      }
      return its(x.email) ? 'one of P\'s people' : 'someone outside Adobe';
    };
    return quoteLines([
      { where: 'a thread of C', who: () => 'one of P\'s people', messages: m.posters },
      { where: 'a thread of P', who, messages: m.customer },
      { where: 'a thread of C', who, messages: m.partner.filter((x) => !its(x.email)) },
      { where: 'a thread of P', who: () => 'one of C\'s people', messages: m.guests },
    ]);
  } catch (e) {
    console.log(JSON.stringify({ route: 'orgpartners', quotes: 'failed', error: String(e && e.message) }));
    return [];
  }
}

/**
 * What links customer `customer` and partner `partner`, as the admin team's request of the pair
 * shows it (src/requestthreads.js): `{ sections, people }` of src/requestevidence.js, the threads
 * behind each signal and the messages in them, the partner's knowledge-base entries that name the
 * customer, the channels; and who at Adobe worked those threads. Null when either org is gone.
 */
export async function partnerEvidence(env, customer, partner) {
  const [f, ev, merges] = await Promise.all([
    orgFacts(env),
    evidence(env),
    rows(env, 'SELECT slug FROM org_merges'),
  ]);
  const merged = new Set(merges.map((r) => r.slug));
  const orgs = new Map([...f.orgs].filter(([slug]) => !merged.has(slug)));
  const c = orgs.get(customer);
  const p = orgs.get(partner);
  if (!c || !p) {
    return null;
  }
  const mail = await partnerMailDomains(env, orgs);
  const ctx = contextOf(orgs, ev, mail.found ? mail.domains : null);
  const signals = partnerSignals(c, p, ev, ctx);
  const owners = foundBy(signals, 'owners');
  const [m, owned] = await Promise.all([
    pairMessages(env, c, p, signals, ctx),
    factThreads(env, {
      orgs: [c.slug, p.slug],
      fields: ['site', 'repo', 'url'],
      like: owners,
      match: (field, value) => owners.includes(ownerOf(field, value)),
    }),
  ]);
  const C = md(c.name || c.slug);
  const P = md(p.name || p.slug);
  const its = (email) => Boolean(email) && domainPartner(ctx.partnerOf, String(email).split('@')[1]) === p.slug;
  const sections = [
    threadSection(`${P}'s people in ${C}'s threads${m.domains.length ? ` (${md(m.domains.join(', '))})` : ''}`, byThread(m.posters)),
    threadSection(`${C} named in ${P}'s threads`, byThread(m.customer)),
    threadSection(`${P} named in ${C}'s threads`, byThread(m.partner.filter((x) => !its(x.email)))),
    threadSection(`${C}'s people in ${P}'s threads${m.home ? ` (${md(m.home)})` : ''}`, byThread(m.guests)),
    threadSection('Threads that name the site owners of both', byThread(owned), {
      note: (x) => (x.thread.fact ? `names \`${String(x.thread.fact.value).replace(/`/g, '')}\`` : null),
    }),
  ];
  const kb = foundBy(signals, 'kb');
  if (kb.length) {
    sections.push({
      head: `${P}'s knowledge base names ${C} or its sites`,
      items: kb.slice(0, 5).map((path) => ({
        text: path,
        href: `/inbox/admin?${new URLSearchParams({
          tab: 'orgs', org: p.slug, view: 'kb', path,
        })}`,
      })),
      more: Math.max(0, kb.length - 5),
      threads: [],
    });
  }
  const places = new Set(foundBy(signals, 'place'));
  const together = [...c.channels, ...p.channels]
    .filter((x) => (x.places || []).some((y) => places.has(y)));
  const named = new Set(foundBy(signals, 'channel'));
  const channels = [
    ...together.map((x) => ({ text: x.label, note: `with the same ${(x.places || []).some((y) => places.has(y) && y.startsWith('teams:')) ? 'Teams team' : 'Slack Connect team'}` })),
    ...[...c.channels, ...p.channels].filter((x) => named.has(x.label))
      .map((x) => ({ text: x.label, note: 'named for both' })),
  ];
  if (channels.length) {
    sections.push({
      head: 'Channels', items: channels.slice(0, 5), more: Math.max(0, channels.length - 5), threads: [],
    });
  }
  const people = await whoCouldKnow(env, threadsOf({ sections }));
  return { sections, people };
}

// ---- the pairs kept --------------------------------------------------------------------------

/** A row of `org_partners` as the lists give it. */
function pairOf(r, c = null) {
  let signals = c ? c.signals : [];
  if (!c) {
    try {
      signals = JSON.parse(r.signals || '[]');
    } catch {
      signals = [];
    }
  }
  return {
    customer: r ? r.customer : c.customer,
    partner: r ? r.partner : c.partner,
    signals,
    score: c ? c.score : (r.score || 0),
    p: r && r.p !== null && r.p !== undefined ? r.p : null,
    checked: (r && r.checked_at) || null,
    stale: false,
    candidate: Boolean(c),
    confirmed: r && r.confirmed_at ? { by: r.confirmed_by, at: r.confirmed_at } : null,
    dismissed: r && r.dismissed_at ? { by: r.dismissed_by, at: r.dismissed_at } : null,
    // The admin team's dates, and when its people posted in the customer's threads.
    since: (r && r.since) || null,
    until: (r && r.until) || null,
    ended: r && r.ended_at ? { by: r.ended_by, at: r.ended_at } : null,
    first: (r && r.first_at) || null,
    last: (r && r.last_at) || null,
  };
}

const decided = (r) => Boolean(r && (r.confirmed_at || r.dismissed_at));

/**
 * How a pair stands, as the thread agents, the MCP server and the pages are told it: `{ status,
 * p, until }`. `status` is the admin team's word, `confirmed` (a partner of now), `former`
 * (confirmed and ended, until `until`) or `dismissed` (not partners); else Clef's on a pair
 * nobody decided: `sure` (`p` above `UNSURE_HIGH`), `likely` (from `LIKELY`, linked), `unsure` (in
 * the band below `LIKELY`, not linked), `unlikely`, or `unknown` (Clef has not said); `none`
 * where the inbox has no such pair. `x` has the pair's `confirmed`, `dismissed` (truthy for a
 * decision), `until` and `p`, or is null.
 */
export function standingOf(x) {
  if (!x) {
    return { status: 'none', p: null, until: null };
  }
  const p = x.p ?? null;
  let status = 'unlikely';
  if (x.dismissed) {
    status = 'dismissed';
  } else if (x.confirmed) {
    status = x.until ? 'former' : 'confirmed';
  } else if (p === null) {
    status = 'unknown';
  } else if (p > UNSURE_HIGH) {
    status = 'sure';
  } else if (p >= LIKELY) {
    status = 'likely';
  } else if (p >= UNSURE_LOW) {
    status = 'unsure';
  }
  return { status, p, until: (status === 'former' && x.until) || null };
}

/** A pair's standing (`standingOf`) in words, as a thread agent is told it. */
export function standingWords(s) {
  const pc = s.p === null || s.p === undefined ? '' : ` (${pctOf(s.p)})`;
  switch (s.status) {
    case 'confirmed': return 'confirmed by the admin team';
    case 'former': return `a former partner, until ${s.until}, as the admin team said`;
    case 'dismissed': return 'not partners, as the admin team said';
    case 'sure': return `not decided; Clef is sure${pc}, so it counts as a partner`;
    case 'likely': return `not decided; likely, says Clef${pc}, though it is unsure`;
    case 'unsure': return `not decided and not linked; Clef is unsure${pc}`;
    case 'unlikely': return `not linked; unlikely, says Clef${pc}`;
    case 'unknown': return 'not decided, and Clef has not said yet';
    default: return 'not linked: the inbox found nothing else that pairs them';
  }
}

/**
 * How each of `pairs` (`[{ customer, partner }]`) stands (`standingOf`), from `org_partners`:
 * `Map<customer\npartner, standing>`.
 */
export async function pairStandings(env, pairs) {
  const list = pairs.filter((x) => x && x.customer && x.partner);
  if (!list.length) {
    return new Map();
  }
  const found = await rows(env, `SELECT x.customer, x.partner, x.confirmed_at, x.dismissed_at, x.until, x.p
    FROM org_partners x JOIN (SELECT json_extract(value, '$[0]') AS c, json_extract(value, '$[1]') AS p
      FROM json_each(?1)) j ON x.customer = j.c AND x.partner = j.p`, JSON.stringify(list.map((x) => [x.customer, x.partner])));
  const by = new Map(found.map((r) => [keyOf(r.customer, r.partner), r]));
  return new Map(list.map((x) => {
    const r = by.get(keyOf(x.customer, x.partner));
    return [keyOf(x.customer, x.partner), standingOf(r ? {
      confirmed: r.confirmed_at, dismissed: r.dismissed_at, until: r.until, p: r.p,
    } : null)];
  }));
}

/**
 * Why Clef takes back its open `link` request of each pair nobody decided that it no longer asks
 * about (src/partnerrequests.js `clefRequests`): sure now, or finding it unlikely.
 */
function takenBack(pairs) {
  const why = new Map();
  for (const x of pairs) {
    if (!x.confirmed && !x.dismissed && x.p !== null && x.p !== undefined) {
      if (x.p > UNSURE_HIGH) {
        why.set(keyOf(x.customer, x.partner), `Clef is sure of it, ${pctOf(x.p)}: it counts as a partner without a decision`);
      } else if (x.p < UNSURE_LOW) {
        why.set(keyOf(x.customer, x.partner), `Clef finds it unlikely now, ${pctOf(x.p)}`);
      }
    }
  }
  return why;
}

/** A confirmed pair whose people posted nothing in the customer's threads for this long ended… */
export const LAPSED_DAYS = 90;
/** …while the customer's threads went on for at least this long after their last post. */
export const GOING_ON_DAYS = 30;
/** An ended pair whose people post this long after its end works for the customer again. */
export const AGAIN_DAYS = 14;
const DAY = 24 * 3600 * 1000;
const dayOf = (iso) => String(iso || '').slice(0, 10);
/** An `until` (a day or a month) as the last moment it covers. */
const endOf = (until) => Date.parse(until.length === 7 ? `${until}-28T23:59:59Z` : `${until}T23:59:59Z`);
/**
 * Whether the partner's people stopped posting in the customer's threads (`x.last`, the pair's
 * span) for `LAPSED_DAYS` while the customer's went on for `GOING_ON_DAYS` after, at `now` (ms).
 */
function lapsed(x, orgs, now) {
  const latest = Date.parse((orgs.get(x.customer) || {}).latest || '') || 0;
  const last = Date.parse(x.last || '') || 0;
  return Boolean(last) && now - last > LAPSED_DAYS * DAY && latest - last > GOING_ON_DAYS * DAY;
}

/** Kinds of signal that say the two work together, not only that they share something. */
const DIRECT = new Set(['posters', 'channel']);

/**
 * Why Clef's sureness of a pair is in doubt (`x.p` above `UNSURE_HIGH`), or null. Narrowly, two
 * things only:
 *
 * - `alone`: everything found is of one kind, and not one that says they work together (the
 *   partner's people posting in the customer's threads, a channel named for both): a site owner
 *   both name, the partner's people among the channel's members, the customer's in the partner's
 *   threads. One coincidence may make Clef sure;
 * - `quiet`: the partner's people posted in the customer's threads, and none did for
 *   `LAPSED_DAYS` while the customer's threads went on for `GOING_ON_DAYS` after (`lapsed`, as a
 *   confirmed pair's end): the posting that made Clef sure stopped, and Clef's word stays.
 */
export function conflictOf(x, orgs, now) {
  const kinds = new Set((x.signals || []).map((g) => g.kind));
  if (kinds.size === 1 && !DIRECT.has([...kinds][0])) {
    return { kind: 'alone' };
  }
  return lapsed(x, orgs, now) ? { kind: 'quiet' } : null;
}

/**
 * What Clef asks the admin team to decide (src/partnerrequests.js `clefRequests`), from the
 * pairs as `sync` has them, `orgs` the facts' and `fingerprints` what Clef was shown of each
 * candidate, at `now` (ms). Clef asks only where it is unsure, or its sureness is in doubt; the
 * pairs it is sure of count as linked without a decision, as the likely ones always did:
 *
 * - a pair nobody decided whose `p` is in the unsure band (`UNSURE_LOW` to `UNSURE_HIGH`): a
 *   partner? (`link`, on what Clef was shown);
 * - one nobody decided that Clef is sure of while its signals conflict (`conflictOf`): a partner
 *   still? (`link`; `alone` on what Clef was shown, `quiet` on the partner's last post);
 * - a confirmed one whose people posted nothing in the customer's threads for `LAPSED_DAYS`, while
 *   the customer's went on: one no more? (`end`, until their last post);
 * - an ended one whose people post again: one again? (`link`).
 */
export function partnerWants(pairs, orgs, fingerprints, now) {
  const wants = [];
  const name = (slug) => (orgs.get(slug) && orgs.get(slug).name) || slug;
  const poss = (slug) => (/s$/i.test(name(slug)) ? `${name(slug)}'` : `${name(slug)}'s`);
  for (const x of pairs) {
    const key = keyOf(x.customer, x.partner);
    const latest = Date.parse((orgs.get(x.customer) || {}).latest || '') || 0;
    const last = Date.parse(x.last || '') || 0;
    const open = !x.confirmed && !x.dismissed && x.candidate && x.p !== null
      && fingerprints.has(key);
    const found = (x.signals || []).map((g) => g.text).join('; ');
    const doubt = open && x.p > UNSURE_HIGH ? conflictOf(x, orgs, now) : null;
    if (open && x.p >= UNSURE_LOW && x.p <= UNSURE_HIGH) {
      wants.push({
        customer: x.customer,
        partner: x.partner,
        action: 'link',
        since: x.first ? dayOf(x.first) : null,
        note: `Clef is unsure, ${pctOf(x.p)}, that ${name(x.partner)} works for ${name(x.customer)}: ${found}.`,
        fingerprint: fingerprints.get(key),
      });
    } else if (doubt) {
      const why = doubt.kind === 'quiet'
        ? `but nobody of ${name(x.partner)} posted in ${poss(x.customer)} threads since ${dayOf(x.last)}, and its threads went on until ${dayOf(new Date(latest).toISOString())}`
        : 'from one kind of evidence alone';
      wants.push({
        customer: x.customer,
        partner: x.partner,
        action: 'link',
        since: x.first ? dayOf(x.first) : null,
        note: `Clef is sure, ${pctOf(x.p)}, that ${name(x.partner)} works for ${name(x.customer)}, ${why}: ${found}.`,
        fingerprint: doubt.kind === 'quiet' ? `quiet:${dayOf(x.last)}` : fingerprints.get(key),
      });
    } else if (x.confirmed && !x.until && lapsed(x, orgs, now)) {
      wants.push({
        customer: x.customer,
        partner: x.partner,
        action: 'end',
        until: dayOf(x.last),
        note: `Nobody of ${name(x.partner)} posted in ${poss(x.customer)} threads since ${dayOf(x.last)}, and its threads went on until ${dayOf(new Date(latest).toISOString())}.`,
        fingerprint: `end:${dayOf(x.last)}`,
      });
    } else if (x.confirmed && x.until && last && last - endOf(x.until) > AGAIN_DAYS * DAY) {
      wants.push({
        customer: x.customer,
        partner: x.partner,
        action: 'link',
        since: null,
        note: `People of ${name(x.partner)} posted in ${poss(x.customer)} threads again, last on ${dayOf(x.last)}, after it was a partner until ${x.until}.`,
        fingerprint: `again:${x.until}`,
      });
    }
  }
  return wants;
}

/**
 * Brings `org_partners` up to the candidates of now: a candidate's signals and score are
 * written where they changed; Clef is asked about the candidates nobody decided whose verdict is
 * missing or was given on other signals (`fingerprint`), `ask` of them, strongest first; and the
 * rows of pairs that are no candidate any more and that nobody decided go. Returns the pairs,
 * each `pairOf`, the candidates first, and how many Clef was not asked about yet (`unchecked`).
 *
 * Without the partner domains (`partnerMailDomains` not `found`: D1 failed or was slow for the
 * isolate's first look), the partners' people would be nobody's: pairs would stop being
 * candidates, their rows pruned and their fingerprints changed, every verdict lost for a slow
 * minute. So it writes, deletes and asks nothing then, and answers the rows as they are
 * (`skipped`). `wait` is how long Clef is waited for (tests wait less).
 *
 * Every pair's span (`spanOf`: the first and last post of the partner's people in the customer's
 * threads) is written where it changed, the decided pairs' too; and then Clef files what it asks
 * the admin team to decide (`partnerWants`, src/partnerrequests.js `clefRequests`), unless
 * `requests` is false.
 */
async function sync(env, {
  fresh = false, ask = ASK_PER_LIST, wait = ASK_TIMEOUT_MS, requests = true,
} = {}) {
  const [f, ev, kept, merges] = await Promise.all([
    orgFacts(env, { fresh }),
    evidence(env, { fresh }),
    rows(env, 'SELECT * FROM org_partners'),
    rows(env, 'SELECT slug FROM org_merges'),
  ]);
  // The facts may be from before a merge another isolate made.
  const merged = new Set(merges.map((r) => r.slug));
  const orgs = new Map([...f.orgs].filter(([slug]) => !merged.has(slug)));
  const mail = await partnerMailDomains(env, orgs);
  const ctx = contextOf(orgs, ev, mail.domains);
  if (!mail.found) {
    console.error(JSON.stringify({ route: 'orgpartners', skipped: 'no partner domains' }));
    const pairs = kept.filter((r) => !merged.has(r.customer) && !merged.has(r.partner))
      .map((r) => ({ ...pairOf(r), candidate: !decided(r) }));
    return {
      pairs, unchecked: 0, orgs, ctx, ev, skipped: true,
    };
  }
  const found = partnerCandidates({ ...f, orgs }, ev, ctx);
  const keptBy = new Map(kept.map((r) => [keyOf(r.customer, r.partner), r]));
  const confirmed = confirmedPartners(kept, orgs);
  // What Clef was shown of each candidate, for the requests it files (`partnerWants`).
  const fingerprints = new Map();
  const writes = [];
  const now = new Date().toISOString();
  const pairs = [];
  const asking = [];
  for (const c of found) {
    const row = keptBy.get(keyOf(c.customer, c.partner));
    const others = (confirmed.get(c.customer) || []).filter((o) => o.slug !== c.partner);
    const state = pairState(orgs.get(c.customer), orgs.get(c.partner), c.signals, ctx, others);
    // eslint-disable-next-line no-await-in-loop
    const fingerprint = await fingerprintOf(state);
    const signals = JSON.stringify(c.signals);
    const span = spanOf(orgs.get(c.customer), orgs.get(c.partner), ev, ctx);
    const moved = !row || row.first_at !== span.first || row.last_at !== span.last;
    if (!row || row.signals !== signals || row.score !== c.score || moved) {
      writes.push(env.DB.prepare(`INSERT INTO org_partners (customer, partner, score, signals, signals_at,
          first_at, last_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (customer, partner) DO UPDATE SET score = excluded.score,
          signals = excluded.signals, signals_at = excluded.signals_at, first_at = excluded.first_at,
          last_at = excluded.last_at`)
        .bind(c.customer, c.partner, c.score, signals, now, span.first, span.last));
    }
    fingerprints.set(keyOf(c.customer, c.partner), fingerprint);
    const pair = { ...pairOf(row, c), first: span.first, last: span.last };
    pair.stale = Boolean(row && row.p !== null && row.fingerprint !== fingerprint);
    if (!decided(row) && (pair.p === null || pair.stale) && env.AI && asking.length < ask) {
      asking.push({
        pair, state, fingerprint, c,
      });
    }
    pairs.push(pair);
  }
  const live = new Set(found.map((c) => keyOf(c.customer, c.partner)));
  const gone = kept.filter((r) => !live.has(keyOf(r.customer, r.partner)) && !decided(r));
  for (const r of gone) {
    writes.push(env.DB.prepare('DELETE FROM org_partners WHERE customer = ? AND partner = ? AND confirmed_at IS NULL AND dismissed_at IS NULL')
      .bind(r.customer, r.partner));
  }
  // The decided pairs that are no candidate now, with the signals they had, and when the
  // partner's people posted in the customer's threads now (a former partner's stop).
  for (const r of kept.filter((x) => decided(x) && !live.has(keyOf(x.customer, x.partner)))) {
    if (orgs.has(r.customer) && orgs.has(r.partner)) {
      const span = spanOf(orgs.get(r.customer), orgs.get(r.partner), ev, ctx);
      if (r.first_at !== span.first || r.last_at !== span.last) {
        writes.push(env.DB.prepare(`UPDATE org_partners SET first_at = ?, last_at = ?
          WHERE customer = ? AND partner = ?`).bind(span.first, span.last, r.customer, r.partner));
      }
      pairs.push({ ...pairOf(r), first: span.first, last: span.last });
    }
  }
  if (writes.length) {
    await env.DB.batch(writes);
  }
  await pool(asking, ASK_PARALLEL, async ({
    pair, state, fingerprint, c,
  }) => {
    // What their messages say, beside the signals: not part of the fingerprint.
    const quotes = await pairQuotes(env, orgs.get(c.customer), orgs.get(c.partner), c.signals, ctx);
    const p = await askPair(env, withQuotes(state, quotes), wait);
    if (p === null) {
      return;
    }
    Object.assign(pair, { p, checked: now, stale: false });
    await env.DB.prepare(`UPDATE org_partners SET p = ?, fingerprint = ?, checked_at = ?
      WHERE customer = ? AND partner = ?`).bind(p, fingerprint, now, c.customer, c.partner).run();
  });
  const unchecked = pairs.filter((x) => x.candidate && !x.confirmed && !x.dismissed
    && (x.p === null || x.stale)).length;
  // What Clef asks the admin team to decide now, in its inbox; best effort, as the list is.
  if (requests) {
    const wants = partnerWants(pairs, orgs, fingerprints, Date.now());
    await clefRequests(env, wants, { why: takenBack(pairs) }).catch((e) => {
      console.error(JSON.stringify({ route: 'orgpartners', requests: 'failed', error: e.message }));
    });
  }
  return {
    pairs, unchecked, orgs, ctx, ev,
  };
}

/**
 * The cron's: the pairs brought up to date, and Clef asked about a few (see `sync`); `{ skipped:
 * true }` and nothing written without the partner domains. `wait` as `sync`'s.
 */
export async function refreshPartners(env, { wait } = {}) {
  const { pairs, unchecked, skipped } = await sync(env, { fresh: true, wait });
  if (skipped) {
    return { skipped: true };
  }
  return {
    pairs: pairs.length,
    likely: pairs.filter((x) => !x.dismissed && (x.confirmed || (x.p ?? 0) >= LIKELY)).length,
    unchecked,
  };
}

// ---- the admin team's list -------------------------------------------------------------------

/**
 * An org as the review shows it: its mail domains are its own and those of no other org's
 * partner domains (a partner's people post in a customer's channels, and are not the customer's).
 */
const shownOrg = (o, ctx) => {
  const own = (d) => [null, o.slug].includes(domainPartner(ctx.partnerOf, d));
  const domains = (o.domains || []).filter(own);
  return {
    slug: o.slug,
    name: o.name || null,
    type: o.type,
    icon: o.icon || null,
    domain: ctx.usual.get(o.slug) || domains[0] || null,
    domains: [...new Set([...(ctx.partnerMail.get(o.slug) || []), ctx.usual.get(o.slug),
      ...domains].filter(Boolean))],
    channels: o.channels.length,
    threads: o.threads,
    latest: o.latest,
    channelNames: o.channels.slice(0, SHOWN_CHANNELS).map((c) => ({
      label: c.label, source: c.source, threads: c.threads,
    })),
  };
};

/** Whether a pair is a likely one: confirmed, or Clef says so and nobody dismissed it. */
const likely = (x) => Boolean(x.confirmed) || (!x.dismissed && x.p !== null && x.p >= LIKELY);

/**
 * One pair, for its page (`orgPartners` with `pair`), read and nothing more: no `sync`, which
 * works out every pair, asks Clef about many and files and withdraws Clef's requests (the cron's
 * and the admin team's list load do). The pair's signals and span are worked out from the
 * evidence the isolate keeps (`evidence`, as the list's: an owner's or a place's spread is every
 * org's), its verdict is the one kept. Clef is asked only of a candidate nobody decided that has
 * no verdict yet, this pair alone, and its row written with the verdict, as `sync` would; a stale
 * verdict is shown as stale, for the next sync to ask again. Where Clef gives none (a timeout, an
 * error), the isolate keeps that for `UNANSWERED_MS` and the pair's pages do not ask again
 * meanwhile (`unanswered`: when it did not answer). Without the partner domains it is
 * the row as kept (`skipped`). `{ pairs: [pair], orgs, ctx, unchecked, skipped }`, or null where
 * either org is unknown or merged. `wait` as `sync`'s.
 */
async function onePair(env, customer, partner, { fresh = false, wait = ASK_TIMEOUT_MS } = {}) {
  if (!SLUG.test(String(customer)) || !SLUG.test(String(partner)) || customer === partner) {
    return null;
  }
  const [f, ev, kept, merges] = await Promise.all([
    orgFacts(env, { fresh }),
    evidence(env, { fresh }),
    rows(env, 'SELECT * FROM org_partners WHERE customer = ?', customer),
    rows(env, 'SELECT slug FROM org_merges'),
  ]);
  const merged = new Set(merges.map((r) => r.slug));
  const orgs = new Map([...f.orgs].filter(([slug]) => !merged.has(slug)));
  const c = orgs.get(customer);
  const p = orgs.get(partner);
  if (!c || !p) {
    return null;
  }
  const row = kept.find((r) => r.partner === partner) || null;
  const mail = await partnerMailDomains(env, orgs);
  const ctx = contextOf(orgs, ev, mail.domains);
  if (!mail.found) {
    const x = row ? { ...pairOf(row), candidate: !decided(row) } : {
      ...pairOf(null, {
        customer, partner, signals: [], score: 0,
      }),
      candidate: false,
    };
    return {
      pairs: [x], orgs, ctx, unchecked: 0, skipped: true,
    };
  }
  const signals = partnerSignals(c, p, ev, ctx);
  const score = scoreOf(signals);
  const candidate = enough(signals);
  const span = spanOf(c, p, ev, ctx);
  const x = {
    ...pairOf(row, {
      customer, partner, signals, score,
    }),
    candidate,
    first: span.first,
    last: span.last,
  };
  if (candidate && !decided(row)) {
    const others = (confirmedPartners(kept, orgs).get(customer) || [])
      .filter((o) => o.slug !== partner);
    const state = pairState(c, p, signals, ctx, others);
    const fingerprint = await fingerprintOf(state);
    x.stale = Boolean(row && row.p !== null && row.fingerprint !== fingerprint);
    const key = keyOf(customer, partner);
    const failed = unansweredAt(key);
    const asking = x.p === null && env.AI && !failed;
    const verdict = asking ? await askPair(env, state, wait) : null;
    if (asking && verdict === null) {
      for (const [k, at] of unanswered) {
        if (Date.now() - at >= UNANSWERED_MS) {
          unanswered.delete(k);
        }
      }
      unanswered.set(key, Date.now());
    }
    const since = unansweredAt(key);
    if (x.p === null && verdict === null && since) {
      // Shown as no verdict yet: Clef did not answer, and is not asked again for a while.
      x.unanswered = new Date(since).toISOString();
    }
    if (verdict !== null) {
      const now = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO org_partners (customer, partner, score, signals, signals_at,
          first_at, last_at, p, fingerprint, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (customer, partner) DO UPDATE SET score = excluded.score,
          signals = excluded.signals, signals_at = excluded.signals_at,
          first_at = excluded.first_at, last_at = excluded.last_at, p = excluded.p,
          fingerprint = excluded.fingerprint, checked_at = excluded.checked_at
        WHERE org_partners.p IS NULL`)
        .bind(
          customer,
          partner,
          score,
          JSON.stringify(signals),
          now,
          span.first,
          span.last,
          verdict,
          fingerprint,
          now,
        )
        .run();
      Object.assign(x, { p: verdict, checked: now, stale: false });
    }
  }
  const waits = x.candidate && !x.confirmed && !x.dismissed && (x.p === null || x.stale);
  const unchecked = waits ? 1 : 0;
  return {
    pairs: [x], orgs, ctx, unchecked, skipped: false,
  };
}

/**
 * A signal as anyone on an ops team reads it on a pair's page: its kind and counts, without its
 * text (which names mail domains, site owners, knowledge-base entries and channels).
 */
const countsOf = (g) => ({
  kind: g.kind, n: g.n, ...(g.people !== undefined ? { people: g.people } : {}),
});

/**
 * GET /api/admin/org-partners[?pair=<customer>:<partner>][&fresh=1]: the pairs of a customer and
 * a partner that may work together, each `{ customer, partner, signals, score, p, standing,
 * checked, stale, candidate, confirmed, dismissed, since, until, ended, first, last, open }`
 * (`standing`: `standingOf`'s; `open`: its requests that wait, `[{ id, action }]`), with the orgs
 * in `orgs`; the undecided likely ones first, then the rest by Clef's probability and the signals,
 * the decided last. `unchecked` counts the pairs Clef was not asked about yet. `pair` answers that
 * one pair, whatever its signals, and its requests (`requests`, src/partnerrequests.js
 * `pairRequests`). `skipped`: the partner domains could not be read, so these are the pairs as
 * they were kept (`sync`).
 *
 * The list is the admin team's, a `sync` (which files Clef's requests); one pair's page (`pair`,
 * `onePair`: read, Clef asked of that pair at most, no request filed or withdrawn) anyone's on an
 * ops team too (STAFF_ROUTES in src/admin.js), who read the evidence as counts only (`countsOf`),
 * the orgs without their mail domains, and the requests as `requestFor` gives them (no
 * fingerprint, no note but their own).
 * Only the admin team decides (`decidePartner`, `endPartner`).
 */
export async function orgPartners(env, me, { pair = '', fresh = false } = {}) {
  const admin = isAdmin(me);
  if (!admin && !(pair && me && (me.teams || []).length)) {
    return json({ error: pair ? 'for the people on an ops team' : 'for the admin team: open one pair with ?pair=' }, 403);
  }
  let s;
  if (pair) {
    const [customer, partner] = String(pair).split(':');
    s = await onePair(env, customer, partner, { fresh: admin && fresh });
    if (!s) {
      return json({ error: 'no such pair of orgs (one may be merged)' }, 404);
    }
  } else {
    s = await sync(env, { fresh });
  }
  let list = s.pairs;
  const rank = (x) => {
    if (x.confirmed || x.dismissed) {
      return 2;
    }
    return likely(x) ? 0 : 1;
  };
  list.sort((x, y) => rank(x) - rank(y) || ((y.p ?? -1) - (x.p ?? -1)) || y.score - x.score
    || x.customer.localeCompare(y.customer));
  // What waits for the admin team of each pair, in its inbox; of one pair, every request.
  const open = await openRequestsByPair(env);
  list = list.map((x) => ({
    ...x,
    ...(admin ? {} : { signals: x.signals.map(countsOf) }),
    standing: standingOf(x),
    open: open.get(keyOf(x.customer, x.partner)) || [],
  }));
  const requests = pair && list.length
    ? (await pairRequests(env, list[0].customer, list[0].partner)).map((r) => requestFor(me, r))
    : null;
  const orgs = {};
  for (const x of list) {
    for (const slug of [x.customer, x.partner]) {
      const o = s.orgs.get(slug);
      const shown = o && shownOrg(o, s.ctx);
      orgs[slug] = shown ? { ...shown, ...(admin ? {} : { domain: null, domains: [] }) } : {
        slug,
        name: null,
        type: null,
        icon: null,
        domain: null,
        domains: [],
        channels: 0,
        threads: 0,
        latest: null,
        channelNames: [],
      };
    }
  }
  return json({
    pairs: list,
    orgs,
    unchecked: s.unchecked,
    likely: LIKELY,
    unsure: [UNSURE_LOW, UNSURE_HIGH],
    skipped: Boolean(s.skipped),
    ...(requests ? { requests } : {}),
  });
}

/**
 * POST /api/admin/org-partners/confirm and /dismiss `{ customer, partner, since?, undo? }`, for
 * the admin team: the partner works for the customer (from `since`, a day or a month, kept as it
 * was without one), or does not. Either replaces the other; confirming a former partner makes it a
 * partner again (its `until` cleared), and dismissing a pair clears its dates. `undo` takes it
 * back, and Clef's verdict is what is said of the pair again; a confirmation undone clears its
 * dates too (`since`, and an end: an ended pair undoes its end first, `endPartner`). The pair's
 * open requests it settles are closed with it (src/partnerrequests.js `settleRequests`): a
 * confirmation the `link` ones, a dismissal all; an undo opens none again.
 */
export async function decidePartner(env, me, body, what) {
  const customer = clean(body.customer);
  const partner = clean(body.partner);
  if (!SLUG.test(customer) || !SLUG.test(partner) || customer === partner) {
    return bad('give two orgs, customer and partner');
  }
  const known = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM org_merges WHERE slug IN (?1, ?2)) AS merged,
      (SELECT 1 FROM orgs WHERE slug = ?1) AS c, (SELECT 1 FROM threads WHERE org = ?1 LIMIT 1) AS ct,
      (SELECT 1 FROM orgs WHERE slug = ?2) AS p, (SELECT 1 FROM threads WHERE org = ?2 LIMIT 1) AS pt`)
    .bind(customer, partner).first();
  if (!known || known.merged || !(known.c || known.ct) || !(known.p || known.pt)) {
    return json({ error: 'no such org, or it was merged' }, 404);
  }
  const since = what === 'confirm' && !body.undo ? dateOf(body.since) : null;
  if (since === undefined) {
    return bad('give since as 2026-10 or 2026-10-24');
  }
  const at = body.undo ? null : new Date().toISOString();
  const by = body.undo ? null : String(me.email || me.id);
  const [set, other] = what === 'confirm' ? ['confirmed', 'dismissed'] : ['dismissed', 'confirmed'];
  // An undo clears only its own; a decision replaces the other. Confirmed, a former partner is
  // one again; dismissed, the pair never was, and has no dates.
  let clear = body.undo ? '' : `, ${other}_by = NULL, ${other}_at = NULL`;
  if (body.undo && what === 'confirm') {
    // A confirmation undone takes its dates with it: an end is of a confirmed pair.
    clear = ', since = NULL, until = NULL, ended_by = NULL, ended_at = NULL';
  }
  if (!body.undo) {
    clear += what === 'confirm'
      ? ', since = COALESCE(excluded.since, org_partners.since), until = NULL, ended_by = NULL, ended_at = NULL'
      : ', since = NULL, until = NULL, ended_by = NULL, ended_at = NULL';
  }
  await env.DB.prepare(`INSERT INTO org_partners (customer, partner, ${set}_by, ${set}_at, since)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (customer, partner) DO UPDATE SET ${set}_by = excluded.${set}_by,
      ${set}_at = excluded.${set}_at${clear}, merged_from = NULL, merged_new = NULL`)
    .bind(customer, partner, by, at, since).run();
  if (!body.undo) {
    await settleRequests(env, by, customer, partner, what === 'confirm' ? ['link'] : ['link', 'end'], what === 'confirm' ? 'confirmed' : 'dismissed');
  }
  const row = await env.DB.prepare('SELECT * FROM org_partners WHERE customer = ? AND partner = ?')
    .bind(customer, partner).first();
  console.log(JSON.stringify({
    route: 'orgpartners', [what]: !body.undo, by: me.id,
  }));
  return json({ ok: true, pair: pairOf(row) });
}

/**
 * POST /api/admin/org-partners/end `{ customer, partner, until, undo? }`, for the admin team: the
 * partner worked for the customer until `until` (a day or a month), a former partner: confirmed,
 * by whoever ends it when nobody confirmed it before, and not dismissed. The pair's open `end`
 * requests are closed with it. `undo` makes it a partner again, as it was confirmed.
 */
export async function endPartner(env, me, body) {
  const customer = clean(body.customer);
  const partner = clean(body.partner);
  if (!SLUG.test(customer) || !SLUG.test(partner) || customer === partner) {
    return bad('give two orgs, customer and partner');
  }
  const until = body.undo ? null : dateOf(body.until);
  if (!body.undo && !until) {
    return bad('give until, as 2026-10 or 2026-10-24');
  }
  const known = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM org_merges WHERE slug IN (?1, ?2)) AS merged,
      (SELECT 1 FROM orgs WHERE slug = ?1) AS c, (SELECT 1 FROM threads WHERE org = ?1 LIMIT 1) AS ct,
      (SELECT 1 FROM orgs WHERE slug = ?2) AS p`).bind(customer, partner).first();
  if (!known || known.merged || !(known.c || known.ct) || !known.p) {
    return json({ error: 'no such org, or it was merged' }, 404);
  }
  const by = String(me.email || me.id);
  const at = new Date().toISOString();
  if (body.undo) {
    await env.DB.prepare(`UPDATE org_partners SET until = NULL, ended_by = NULL, ended_at = NULL
      WHERE customer = ? AND partner = ?`).bind(customer, partner).run();
  } else {
    await env.DB.prepare(`INSERT INTO org_partners (customer, partner, confirmed_by, confirmed_at,
        until, ended_by, ended_at) VALUES (?1, ?2, ?3, ?4, ?5, ?3, ?4)
      ON CONFLICT (customer, partner) DO UPDATE SET
        confirmed_by = COALESCE(org_partners.confirmed_by, excluded.confirmed_by),
        confirmed_at = COALESCE(org_partners.confirmed_at, excluded.confirmed_at),
        dismissed_by = NULL, dismissed_at = NULL, until = excluded.until,
        ended_by = excluded.ended_by, ended_at = excluded.ended_at, merged_from = NULL, merged_new = NULL`)
      .bind(customer, partner, by, at, until).run();
    await settleRequests(env, by, customer, partner, ['end'], 'ended');
  }
  const row = await env.DB.prepare('SELECT * FROM org_partners WHERE customer = ? AND partner = ?')
    .bind(customer, partner).first();
  console.log(JSON.stringify({
    route: 'orgpartners', ended: !body.undo, by: me.id,
  }));
  return json({ ok: true, pair: row ? pairOf(row) : null });
}

// ---- what everyone reads ---------------------------------------------------------------------

/**
 * The confirmed and likely pairs of an org, as everyone at Adobe reads them: `[{ slug, name,
 * type, icon, confirmed, current, since, until, last, p, score, signals: { <kind>: n } }]`, the
 * confirmed partners of now first, then the likely ones by Clef's probability, then the former
 * ones (`until`, the latest ended first). `since` is the admin team's, else the day the partner's
 * people first posted in the customer's threads as the inbox has them; `last` their last post. No
 * message text and no names beyond the orgs'. `side` is the column the org is in (`customer`),
 * the other is listed.
 */
async function linked(env, slug, side) {
  const other = side === 'customer' ? 'partner' : 'customer';
  const list = await rows(env, `SELECT x.${other} AS slug, o.name, o.type, o.icon, x.p, x.score,
      x.signals, x.confirmed_at, x.since, x.until, x.first_at, x.last_at
    FROM org_partners x LEFT JOIN orgs o ON o.slug = x.${other}
    WHERE x.${side} = ?1 AND x.dismissed_at IS NULL AND (x.confirmed_at IS NOT NULL OR x.p >= ?2)
      AND x.${other} NOT IN (SELECT slug FROM org_merges)
    ORDER BY CASE WHEN x.until IS NOT NULL THEN 2 WHEN x.confirmed_at IS NOT NULL THEN 0 ELSE 1 END,
      x.until DESC, x.p DESC, x.score DESC, x.${other}`, clean(slug), LIKELY);
  return list.map((r) => {
    let signals = [];
    try {
      signals = JSON.parse(r.signals || '[]');
    } catch {
      // none
    }
    return {
      slug: r.slug,
      name: r.name || null,
      type: r.type || 'customer',
      icon: r.icon || null,
      confirmed: Boolean(r.confirmed_at),
      current: !r.until,
      since: r.since || (r.first_at ? String(r.first_at).slice(0, 10) : null),
      until: r.until || null,
      last: r.last_at || null,
      p: r.p ?? null,
      score: r.score || 0,
      signals: Object.fromEntries(signals.map((s) => [s.kind, s.n])),
    };
  });
}

/** The partners that work for `customer`, confirmed or likely (see `linked`). */
export async function partnersOf(env, customer) {
  return linked(env, customer, 'customer');
}

/** The customers `partner` works for, confirmed or likely (see `linked`). */
export async function customersOf(env, partner) {
  return linked(env, partner, 'partner');
}

/**
 * GET /api/customers/partners?org=<slug>: an org's partners and the customers it works for, for
 * everyone at Adobe (src/api.js checks who): `{ org, partners, customers }`.
 */
export async function orgPartnerLinks(env, org) {
  const slug = clean(org);
  if (!SLUG.test(slug)) {
    return { error: 'give an org', status: 400 };
  }
  const [partners, customers] = await Promise.all([partnersOf(env, slug), customersOf(env, slug)]);
  return { org: slug, partners, customers };
}
