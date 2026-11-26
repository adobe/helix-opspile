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
import { orgDomain } from './favicons.js';
import { json } from './http.js';
import { CLEF } from './label.js';
import { facts as orgFacts } from './orgmerge.js';
import { partnerDomainLookup } from './partners.js';
import { platformName } from './platforms.js';
import { isAdmin } from './roles.js';
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
 * The admin team confirms a pair or dismisses it in Customers; a candidate nobody decided that
 * stops being one goes. Everyone at Adobe reads an org's confirmed and likely pairs
 * (`partnersOf`, `customersOf`), with how many of each signal and no message text. A merged org's
 * decisions follow the merge (src/orgmerge.js `mergeOrgs`, `unmergeOrg`).
 */

/** From this probability on, Clef says the partner works for the customer: "likely". */
export const LIKELY = 0.5;
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
 * [{ domain, threads, people }]>`, most people first), who is in each org's channels
 * (`members`: `Map<org, Map<domain, people>>`), the owners each org's facts name (`owners`:
 * `Map<org, Map<owner, threads>>`), and the partners' knowledge-base entries (`kb`: `Map<partner,
 * [{ path, head, body }]>`: the path, title and aliases, and the text, lowercase).
 */
async function loadEvidence(env) {
  const [posters, members, owned, kb] = await Promise.all([
    rows(env, `SELECT t.org, LOWER(SUBSTR(i.email, INSTR(i.email, '@') + 1)) AS domain,
        COUNT(DISTINCT m.thread) AS threads, COUNT(DISTINCT m.author_key) AS people
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
      by.get(r.org).push({ domain: r.domain, threads: r.threads, people: r.people });
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

let cachedEvidence = null;

/** The evidence (`loadEvidence`), kept as src/orgmerge.js keeps its facts. */
async function evidence(env, { fresh = false } = {}) {
  const db = underlying(env.DB);
  const c = cachedEvidence;
  if (!fresh && c && c.db === db && Date.now() - c.at < EVIDENCE_MS) {
    return c.evidence;
  }
  const kept = { db, at: Date.now(), evidence: loadEvidence(env) };
  cachedEvidence = kept;
  kept.evidence.catch(() => {
    if (cachedEvidence === kept) {
      cachedEvidence = null;
    }
  });
  return kept.evidence;
}

/** Forgets the evidence kept (for tests). */
export function forgetEvidence() {
  cachedEvidence = null;
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
 * Why partner `p` may work for customer `c` (both orgs of the duplicates' facts), each
 * `{ kind, weight, n, text }`: `n` is how many (threads, people, owners, entries, places,
 * channels), `text` says it, with names for the admin team. `ev` is the evidence, `ctx`
 * `contextOf`'s.
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

/** What Clef is shown of a pair. */
export function pairState(c, p, signals, ctx) {
  const shared = signals.length ? `\nFound: ${signals.map(said).join('; ')}.` : '';
  const mail = (ctx.partnerMail.get(p.slug) || []).join(', ') || ctx.usual.get(p.slug);
  return `${INTRO}\n${describeOrg('C', c, ctx.usual.get(c.slug))}\n${describeOrg('P', p, mail)}${shared}`;
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
  };
}

const decided = (r) => Boolean(r && (r.confirmed_at || r.dismissed_at));

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
 */
async function sync(env, { fresh = false, ask = ASK_PER_LIST, wait = ASK_TIMEOUT_MS } = {}) {
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
  const writes = [];
  const now = new Date().toISOString();
  const pairs = [];
  const asking = [];
  for (const c of found) {
    const row = keptBy.get(keyOf(c.customer, c.partner));
    const state = pairState(orgs.get(c.customer), orgs.get(c.partner), c.signals, ctx);
    // eslint-disable-next-line no-await-in-loop
    const fingerprint = await fingerprintOf(state);
    const signals = JSON.stringify(c.signals);
    if (!row || row.signals !== signals || row.score !== c.score) {
      writes.push(env.DB.prepare(`INSERT INTO org_partners (customer, partner, score, signals, signals_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (customer, partner) DO UPDATE SET score = excluded.score,
          signals = excluded.signals, signals_at = excluded.signals_at`)
        .bind(c.customer, c.partner, c.score, signals, now));
    }
    const pair = pairOf(row, c);
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
  if (writes.length) {
    await env.DB.batch(writes);
  }
  // The decided pairs that are no candidate now, with the signals they had.
  for (const r of kept.filter((x) => decided(x) && !live.has(keyOf(x.customer, x.partner)))) {
    if (!merged.has(r.customer) && !merged.has(r.partner)) {
      pairs.push(pairOf(r));
    }
  }
  await pool(asking, ASK_PARALLEL, async ({
    pair, state, fingerprint, c,
  }) => {
    const p = await askPair(env, state, wait);
    if (p === null) {
      return;
    }
    Object.assign(pair, { p, checked: now, stale: false });
    await env.DB.prepare(`UPDATE org_partners SET p = ?, fingerprint = ?, checked_at = ?
      WHERE customer = ? AND partner = ?`).bind(p, fingerprint, now, c.customer, c.partner).run();
  });
  const unchecked = pairs.filter((x) => x.candidate && !x.confirmed && !x.dismissed
    && (x.p === null || x.stale)).length;
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

/** An org as the review shows it. */
const shownOrg = (o, ctx) => ({
  slug: o.slug,
  name: o.name || null,
  type: o.type,
  icon: o.icon || null,
  domain: ctx.usual.get(o.slug) || (o.domains || [])[0] || null,
  domains: [...new Set([...(ctx.partnerMail.get(o.slug) || []), ctx.usual.get(o.slug),
    ...(o.domains || [])].filter(Boolean))],
  channels: o.channels.length,
  threads: o.threads,
  latest: o.latest,
  channelNames: o.channels.slice(0, SHOWN_CHANNELS).map((c) => ({
    label: c.label, source: c.source, threads: c.threads,
  })),
});

/** Whether a pair is a likely one: confirmed, or Clef says so and nobody dismissed it. */
const likely = (x) => Boolean(x.confirmed) || (!x.dismissed && x.p !== null && x.p >= LIKELY);

/**
 * GET /api/admin/org-partners[?pair=<customer>:<partner>][&fresh=1], for the admin team: the
 * pairs of a customer and a partner that may work together, each `{ customer, partner, signals,
 * score, p, checked, stale, candidate, confirmed, dismissed }`, with the orgs in `orgs`; the
 * undecided likely ones first, then the rest by Clef's probability and the signals, the decided
 * last. `unchecked` counts the pairs Clef was not asked about yet. `pair` answers that one pair,
 * whatever its signals. `skipped`: the partner domains could not be read, so these are the pairs
 * as they were kept (`sync`).
 */
export async function orgPartners(env, me, { pair = '', fresh = false } = {}) {
  if (!isAdmin(me)) {
    return json({ error: 'for the admin team' }, 403);
  }
  const s = await sync(env, { fresh });
  let list = s.pairs;
  if (pair) {
    const [customer, partner] = String(pair).split(':');
    const c = s.orgs.get(customer);
    const p = s.orgs.get(partner);
    if (!c || !p || customer === partner) {
      return json({ error: 'no such pair of orgs (one may be merged)' }, 404);
    }
    const one = list.find((x) => x.customer === customer && x.partner === partner);
    if (one) {
      list = [one];
    } else {
      const signals = partnerSignals(c, p, s.ev, s.ctx);
      const row = await env.DB.prepare('SELECT * FROM org_partners WHERE customer = ? AND partner = ?')
        .bind(customer, partner).first();
      const found = {
        customer, partner, signals, score: scoreOf(signals),
      };
      list = [{ ...pairOf(row, found), candidate: false }];
    }
  }
  const rank = (x) => {
    if (x.confirmed || x.dismissed) {
      return 2;
    }
    return likely(x) ? 0 : 1;
  };
  list.sort((x, y) => rank(x) - rank(y) || ((y.p ?? -1) - (x.p ?? -1)) || y.score - x.score
    || x.customer.localeCompare(y.customer));
  const orgs = {};
  for (const x of list) {
    for (const slug of [x.customer, x.partner]) {
      const o = s.orgs.get(slug);
      orgs[slug] = o ? shownOrg(o, s.ctx) : {
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
    pairs: list, orgs, unchecked: s.unchecked, likely: LIKELY, skipped: Boolean(s.skipped),
  });
}

/**
 * POST /api/admin/org-partners/confirm and /dismiss `{ customer, partner, undo? }`, for the
 * admin team: the partner works for the customer, or does not. Either replaces the other;
 * `undo` takes it back, and Clef's verdict is what is said of the pair again.
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
  const at = body.undo ? null : new Date().toISOString();
  const by = body.undo ? null : String(me.email || me.id);
  const [set, other] = what === 'confirm' ? ['confirmed', 'dismissed'] : ['dismissed', 'confirmed'];
  // An undo clears only its own; a decision replaces the other.
  const clear = body.undo ? '' : `, ${other}_by = NULL, ${other}_at = NULL`;
  await env.DB.prepare(`INSERT INTO org_partners (customer, partner, ${set}_by, ${set}_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (customer, partner) DO UPDATE SET ${set}_by = excluded.${set}_by,
      ${set}_at = excluded.${set}_at${clear}, merged_from = NULL, merged_new = NULL`).bind(customer, partner, by, at).run();
  const row = await env.DB.prepare('SELECT * FROM org_partners WHERE customer = ? AND partner = ?')
    .bind(customer, partner).first();
  console.log(JSON.stringify({
    route: 'orgpartners', [what]: !body.undo, by: me.id,
  }));
  return json({ ok: true, pair: pairOf(row) });
}

// ---- what everyone reads ---------------------------------------------------------------------

/**
 * The confirmed and likely pairs of an org, as everyone at Adobe reads them: `[{ slug, name,
 * type, icon, confirmed, p, score, signals: { <kind>: n } }]`, the confirmed first, then by
 * Clef's probability. No message text and no names beyond the orgs'. `side` is the column the
 * org is in (`customer`), the other is listed.
 */
async function linked(env, slug, side) {
  const other = side === 'customer' ? 'partner' : 'customer';
  const list = await rows(env, `SELECT x.${other} AS slug, o.name, o.type, o.icon, x.p, x.score,
      x.signals, x.confirmed_at
    FROM org_partners x LEFT JOIN orgs o ON o.slug = x.${other}
    WHERE x.${side} = ?1 AND x.dismissed_at IS NULL AND (x.confirmed_at IS NOT NULL OR x.p >= ?2)
      AND x.${other} NOT IN (SELECT slug FROM org_merges)
    ORDER BY x.confirmed_at IS NULL, x.p DESC, x.score DESC, x.${other}`, clean(slug), LIKELY);
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
