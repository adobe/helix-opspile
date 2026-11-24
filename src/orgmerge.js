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

import { listFiles, readBlobs } from './agent/repos.js';
import { MAX_CHANGES, writeKnowledge } from './agent/kbwrite.js';
import { isEntry } from './agent/okf.js';
import { orgDomain } from './favicons.js';
import { json } from './http.js';
import { underlying } from './d1batch.js';
import { ensureKnowledgeBase, repoName } from './kb.js';
import { CLEF } from './label.js';
import { domainList, loadRules } from './lookup.js';
import { platformName } from './platforms.js';
import { isAdmin } from './review.js';
import { mergeRule, UNASSIGNED } from './rules.js';
import { ownedCustomers } from './shares.js';

/**
 * Duplicate customers, and merging them (migration 0091). An org is a slug the rules give a
 * channel (`aem-<slug>`, a manual assignment), so one company can end up under two: a channel
 * named `workfront-acmeco` and one named `aem-acme`. The admin pages list the pairs of orgs that
 * may be one, likeliest first:
 *
 * - candidates, from what the inbox knows of each org: their names and slugs (one the same as,
 *   or the start of, or close to the other's), their icons, their people's usual mail domains,
 *   a Slack Connect team or a Teams team their channels share, and the people outside Adobe in
 *   channels of both (`signalsOf`);
 * - Clef, asked about each candidate with what it is shown of both orgs: whether the two are one
 *   company (`askPair`). Its answers are kept (`org_pairs`), and asked again once what it would
 *   be shown changed.
 *
 * The admin team merges a pair (`mergeOrgs`): the one org is filed under the other from then on,
 * since `loadRules` hands every caller of the rules the merges too (src/rules.js `mergedOrg`), so
 * its channels move as a rule change moves them (src/refile.js), and so do the ones a template
 * names it later. Its name and icon fill in the other's where that has none; its agents' MCP
 * servers, secrets and repositories, the people who follow it, its stack drawing and its portal
 * lobbies go to the other; and the entries of its knowledge base the other has not are copied
 * over (`mergeKnowledge`). A merge can be undone (`unmergeOrg`): its channels move back, what
 * moved with it stays. Anyone who sees one of the two asks the admin team for a merge instead
 * (`org_merge_requests`), which the admin team merges or declines under Requests.
 */

/** From this probability on, Clef says two orgs are one: the list's "likely" pairs. */
export const LIKELY = 0.5;
/** What a pair's signals add up to before Clef is asked about it (`signalsOf`). */
export const CANDIDATE = 3;
/** Most candidates listed, the strongest first. */
const MAX_CANDIDATES = 200;
/** Clef questions per list: the rest are asked the next time it is loaded. */
const ASK_PER_LIST = 24;
const ASK_PARALLEL = 8;
const ASK_TIMEOUT_MS = 10000;
/** People in channels of more orgs than this are not anyone's own: staff, bots, agencies. */
const MAX_SPREAD = 6;
/** Channels Clef is shown of each org. */
const SHOWN_CHANNELS = 8;
/** What the facts of every org are kept for in an isolate: the list is loaded again and again. */
const FACTS_MS = 5 * 60 * 1000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_NOTE = 500;

const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const bad = (error) => json({ error }, 400);
const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const ordered = (a, b) => (a < b ? [a, b] : [b, a]);

async function rows(env, sql, ...args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

// ---- what is known of each org ---------------------------------------------------------------

/**
 * The mail domains of the people outside Adobe who post in an org's threads (all orgs', or
 * `slug`'s), most people first: `Map<org, [domain]>`. Free mail and tenant domains are left
 * out; the first is the org's usual mail domain, whose favicon it has without an icon.
 *
 * One org's from its threads (`threads_org`), not from every message: `?1 IS NULL OR t.org = ?1`
 * kept SQLite off the index, and an org's page (and each of its icon searches) read all the
 * messages there are, some 200,000 rows a time.
 */
export async function mailDomains(env, slug = null) {
  const list = await rows(env, `SELECT t.org, LOWER(SUBSTR(i.email, INSTR(i.email, '@') + 1)) AS domain,
      COUNT(DISTINCT m.thread || ' ' || m.author_key) AS n
    FROM ${slug ? 'threads t JOIN messages m ON m.thread = t.thread' : 'messages m JOIN threads t ON t.thread = m.thread'}
    JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +m.author_key
    WHERE m.staff = 0 AND m.deleted = 0 AND m.counted = 1 AND i.email LIKE '%_@_%'
      ${slug ? 'AND t.org = ?1' : ''}
    GROUP BY t.org, domain ORDER BY t.org, n DESC, domain`, ...(slug ? [slug] : []));
  const by = new Map();
  for (const r of list) {
    if (orgDomain(env, r.domain)) {
      if (!by.has(r.org)) {
        by.set(r.org, []);
      }
      by.get(r.org).push(r.domain);
    }
  }
  return by;
}

/** The merged orgs: `[{ slug, into, name, type, icon, merged_by, merged_at }]`. */
export async function listMerges(env) {
  return rows(env, `SELECT slug, into_slug AS "into", name, type, icon, merged_by, merged_at
    FROM org_merges ORDER BY merged_at DESC`);
}

/**
 * Who is in each org's channels, among the people outside Adobe in the channels of a few orgs
 * only (`MAX_SPREAD`): how many each org has (`size`), and how many of them two orgs share
 * (`shared`, by `pairKey`). A person is their mail address, else their platform account.
 */
async function memberOverlap(env) {
  const om = `WITH co AS (SELECT DISTINCT source, tenant, channel_id, org FROM threads WHERE org != ?2),
    om AS (SELECT DISTINCT co.org,
        COALESCE(LOWER(m.email), m.source || ':' || m.tenant || ':' || m.user_id) AS who
      FROM channel_members m JOIN co ON co.source = m.source AND co.tenant = m.tenant
        AND co.channel_id = m.channel_id
      WHERE m.email IS NULL OR LOWER(SUBSTR(m.email, INSTR(m.email, '@') + 1))
        NOT IN (SELECT value FROM json_each(?1))),
    own AS (SELECT who FROM om GROUP BY who HAVING COUNT(*) <= ${MAX_SPREAD})`;
  const staff = JSON.stringify(domainList(env.STAFF_DOMAINS));
  const [sizes, pairs] = await Promise.all([
    rows(env, `${om} SELECT org, COUNT(*) AS n FROM om WHERE who IN (SELECT who FROM own)
      GROUP BY org`, staff, UNASSIGNED),
    rows(env, `${om} SELECT a.org AS a, b.org AS b, COUNT(*) AS n FROM om a
      JOIN om b ON b.who = a.who AND a.org < b.org
      WHERE a.who IN (SELECT who FROM own) GROUP BY a.org, b.org`, staff, UNASSIGNED),
  ]);
  return {
    size: new Map(sizes.map((r) => [r.org, r.n])),
    shared: new Map(pairs.map((r) => [pairKey(r.a, r.b), r.n])),
  };
}

const channelText = (c) => (c.source === 'teams' && c.group_name ? `${c.group_name} › ${c.name}` : `#${c.name || c.channel_id}`);

/**
 * Every org but the merged ones, with what the duplicate search compares: `{ orgs: Map<slug,
 * { slug, name, type, icon, domains, channels: [...], threads, latest }>, members }`.
 */
async function loadFacts(env) {
  const [list, counts, channels, domains, members] = await Promise.all([
    rows(env, `SELECT s.slug, o.name, COALESCE(o.type, 'customer') AS type, o.icon
      FROM (SELECT slug FROM orgs UNION SELECT DISTINCT org FROM threads
        UNION SELECT slug FROM knowledge_bases WHERE kind = 'org') s
      LEFT JOIN orgs o ON o.slug = s.slug
      WHERE s.slug != ?1 AND s.slug NOT IN (SELECT slug FROM org_merges)`, UNASSIGNED),
    rows(env, `SELECT org, COUNT(*) AS threads, MAX(COALESCE(last_at, any_at)) AS latest
      FROM threads GROUP BY org`),
    rows(env, `SELECT c.source, c.tenant, c.channel_id, c.name, c.group_id, c.group_name,
        c.shared, c.connected, c.topic, t.org, COUNT(*) AS threads
      FROM threads t JOIN channels c ON c.source = t.source AND c.tenant = t.tenant
        AND c.channel_id = t.channel_id
      WHERE c.archived_at IS NULL AND t.org != ?1
      GROUP BY c.source, c.tenant, c.channel_id, t.org ORDER BY threads DESC`, UNASSIGNED),
    mailDomains(env),
    memberOverlap(env),
  ]);
  const count = new Map(counts.map((r) => [r.org, r]));
  const orgs = new Map(list.map((o) => [o.slug, {
    ...o,
    domains: (domains.get(o.slug) || []).slice(0, 3),
    channels: [],
    threads: (count.get(o.slug) || {}).threads || 0,
    latest: (count.get(o.slug) || {}).latest || null,
  }]));
  for (const c of channels) {
    const o = orgs.get(c.org);
    if (o) {
      let connected = [];
      try {
        connected = JSON.parse(c.connected || '[]');
      } catch {
        // none
      }
      o.channels.push({
        source: c.source,
        tenant: c.tenant,
        channelId: c.channel_id,
        label: channelText(c),
        topic: c.topic || null,
        threads: c.threads,
        // What a channel of another org in the same place shares with it.
        places: [
          ...(Array.isArray(connected) ? connected : []).map((t) => `connect:${t}`),
          ...(c.source === 'teams' && c.group_id ? [`teams:${c.group_id}`] : []),
          ...(c.source === 'portal' ? [`portal:${c.tenant}`] : []),
        ],
      });
    }
  }
  return { orgs, members };
}

let cachedFacts = null;

/**
 * The facts (`loadFacts`), from this isolate's last five minutes when it has them. Kept by the
 * D1 binding under the request's wrappers (`underlying`): each request wraps it anew, so kept by
 * the wrapper they were never found again, and every list loaded them all. The promise is kept,
 * so requests that come together load them once.
 */
export async function facts(env, { fresh = false } = {}) {
  const db = underlying(env.DB);
  const c = cachedFacts;
  if (!fresh && c && c.db === db && Date.now() - c.at < FACTS_MS) {
    return c.facts;
  }
  const kept = { db, at: Date.now(), facts: loadFacts(env) };
  cachedFacts = kept;
  kept.facts.catch(() => {
    if (cachedFacts === kept) {
      cachedFacts = null;
    }
  });
  return kept.facts;
}

/** Forgets the facts kept (after a merge, and for tests). */
export function forgetFacts() {
  cachedFacts = null;
}

// ---- candidates ------------------------------------------------------------------------------

/** Letters and digits only: "Acme Co." and acme-co meet. */
const compact = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
/** Words that say nothing of which company a name is. */
const STOP = new Set(['the', 'and', 'inc', 'corp', 'corporation', 'company', 'group', 'holding',
  'holdings', 'ltd', 'limited', 'llc', 'gmbh', 'plc', 'international', 'global', 'support',
  'alerts', 'team', 'digital', 'services', 'solutions', 'systems', 'technologies', 'university']);
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').split(/[^a-z0-9]+/)
  .filter((w) => w.length >= 4 && !STOP.has(w));

/** How many typos a name of this length may have and still be spelled like another: 1 or 2. */
const typos = (c) => Math.min(2, Math.max(1, Math.floor(c.length / 8)));

/** Edit distance of two short strings, or `max + 1` once it is beyond `max`. */
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) {
    return max + 1;
  }
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      low = Math.min(low, cur[j]);
    }
    if (low > max) {
      return max + 1;
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * What the signals compare of an org, worked out once per org (the list compares every pair):
 * its names (slug and display name) in letters and digits, the words of them, its icon, and the
 * places its channels are in (`connect:<Slack team>`, `teams:<Teams team>`, `portal:<domain>`).
 */
const prepared = new WeakMap();
function prep(o) {
  if (!prepared.has(o)) {
    prepared.set(o, {
      names: [...new Set([o.slug, o.name].filter(Boolean))].map((n) => ({ n, c: compact(n) }))
        .filter((x) => x.c),
      words: new Set([...words(o.name), ...words(o.slug)]),
      icon: String(o.icon || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, ''),
      places: new Set((o.channels || []).flatMap((c) => c.places || [])),
      domains: o.domains || [],
    });
  }
  return prepared.get(o);
}

/** How alike two orgs' names are: a signal `{ kind: 'name', weight, text }`, or null. */
function nameSignal(pa, pb) {
  let best = null;
  const take = (weight, text) => {
    if (!best || weight > best.weight) {
      best = { kind: 'name', weight, text };
    }
  };
  for (const x of pa.names) {
    for (const y of pb.names) {
      const [s, l] = x.c.length <= y.c.length ? [x, y] : [y, x];
      if (s.c === l.c) {
        take(3, x.n === y.n ? `both are called ${x.n}` : `"${x.n}" and "${y.n}" are the same name`);
      } else if (s.c.length >= 4 && l.c.startsWith(s.c)) {
        take(2, `"${l.n}" starts with "${s.n}"`);
      } else if (s.c.length >= 5 && s.c[0] === l.c[0]
        && distance(s.c, l.c, typos(l.c)) <= typos(l.c)) {
        take(2, `"${x.n}" and "${y.n}" are spelled alike`);
      } else if (s.c.length >= 5 && l.c.includes(s.c)) {
        take(1, `"${l.n}" has "${s.n}" in it`);
      }
    }
  }
  if (!best) {
    const common = [...pb.words].find((w) => pa.words.has(w));
    if (common) {
      take(1, `both names have "${common}"`);
    }
  }
  return best;
}

/**
 * Why two orgs may be one, each `{ kind, weight, text }`: names, icons, mail domains, channels in
 * the same place, people in both. `places` counts the orgs with a channel in each place,
 * `domains` the orgs whose people write from each mail domain, and `members` is
 * `memberOverlap`'s.
 */
export function signalsOf(a, b, { places = new Map(), domains = new Map(), members = null } = {}) {
  const pa = prep(a);
  const pb = prep(b);
  const out = [];
  const name = nameSignal(pa, pb);
  if (name) {
    out.push(name);
  }
  if (pa.icon && pa.icon === pb.icon) {
    out.push({ kind: 'icon', weight: 2, text: `the same icon (${pa.icon})` });
  } else if ((pa.icon && pa.icon === pb.domains[0]) || (pb.icon && pb.icon === pa.domains[0])) {
    const icon = pa.icon && pa.icon === pb.domains[0] ? pa.icon : pb.icon;
    out.push({ kind: 'icon', weight: 2, text: `one's icon is the other's mail domain (${icon})` });
  }
  const common = pa.domains.find((d) => pb.domains.includes(d));
  if (common) {
    // A domain the people of more orgs write from is a partner's, who works for them all.
    const others = (domains.get(common) || 2) - 2;
    const usual = pa.domains[0] === common && pb.domains[0] === common;
    out.push({
      kind: 'mail',
      weight: others > 0 ? 1 : 1.5 + (usual ? 1.5 : 0),
      text: `${usual ? 'their people' : 'people of both'} write from ${common}${others > 0 ? `, as do people of ${others} other ${others === 1 ? 'org' : 'orgs'}` : ''}`,
    });
  }
  if (pa.places.size && pb.places.size) {
    const shared = [...pb.places].filter((p) => pa.places.has(p));
    if (shared.length) {
      const others = Math.min(...shared.map((p) => places.get(p) || 2)) - 2;
      const kind = ['connect', 'teams', 'portal'].find((k) => shared.some((p) => p.startsWith(`${k}:`)));
      const what = {
        connect: 'the same Slack Connect team', teams: 'the same Teams team', portal: 'the same portal domain',
      }[kind];
      out.push({
        kind: 'place',
        weight: others > 0 ? 1.5 : 3,
        text: `channels of both are with ${what}${others > 0 ? `, as are channels of ${others} other ${others === 1 ? 'org' : 'orgs'}` : ''}`,
      });
    }
  }
  if (members) {
    const n = members.shared.get(pairKey(a.slug, b.slug)) || 0;
    if (n) {
      const of = Math.min(members.size.get(a.slug) || n, members.size.get(b.slug) || n);
      out.push({
        kind: 'people',
        weight: n >= 2 && n / of >= 0.3 ? 2 : 0.5,
        text: `${n} ${n === 1 ? 'person' : 'people'} outside Adobe ${n === 1 ? 'is' : 'are'} in channels of both`,
      });
    }
  }
  return out;
}

const scoreOf = (signals) => signals.reduce((n, s) => n + s.weight, 0);

/**
 * How many orgs have a channel in each place, and how many write from each mail domain
 * (`signalsOf`'s `places` and `domains`).
 */
function spreads(orgs) {
  const places = new Map();
  const domains = new Map();
  for (const o of orgs.values()) {
    for (const p of prep(o).places) {
      places.set(p, (places.get(p) || 0) + 1);
    }
    for (const d of prep(o).domains) {
      domains.set(d, (domains.get(d) || 0) + 1);
    }
  }
  return { places, domains };
}

/**
 * The pairs of orgs whose signals add up to `CANDIDATE`, strongest first, at most
 * `MAX_CANDIDATES`: `[{ a, b, signals, score }]`, `a` before `b`. Orgs of two types (a customer
 * and its partner, vendor, or Adobe) share people, mail domains and Slack Connect teams because
 * one works for the other: only alike names make them a candidate.
 */
export function candidates({ orgs, members }) {
  const spread = spreads(orgs);
  const list = [...orgs.values()].sort((x, y) => x.slug.localeCompare(y.slug));
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const signals = signalsOf(list[i], list[j], { ...spread, members });
      const score = scoreOf(signals);
      const named = (list[i].type || 'customer') === (list[j].type || 'customer')
        || signals.some((s) => s.kind === 'name');
      if (score >= CANDIDATE && named) {
        out.push({
          a: list[i].slug, b: list[j].slug, signals, score,
        });
      }
    }
  }
  return out.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a)).slice(0, MAX_CANDIDATES);
}

// ---- Clef ------------------------------------------------------------------------------------

const INTRO = 'An ops inbox at Adobe files Slack, Teams and Discord channels under organizations:'
  + ' customers, partners, vendors, or Adobe itself (internal). A channel name is usually'
  + ' <product>-<organization> (aem-acme, workfront-acme), and the organization\'s slug comes from'
  + ' it, so one organization can end up under two slugs. Two of them, A and B, may be the same.'
  + ' Partners and agencies work for several customers at once: the same agency\'s people, mail'
  + ' domain or Slack Connect team in channels of both is no sign that two customers are one.';
export const QUESTION = 'Should A and B be one organization in the inbox: do both names refer to the'
  + ' same company (one may be a part, product group, brand, site or project of it), rather than to'
  + ' two different companies?';

/** An org as Clef is told about it. */
function describeOrg(letter, o) {
  const parts = [`slug ${o.slug}`];
  if (o.name) {
    parts.push(`display name "${o.name}"`);
  }
  parts.push(o.type || 'customer');
  if (o.icon) {
    parts.push(`icon ${o.icon}`);
  }
  const shown = o.channels.slice(0, SHOWN_CHANNELS).map((c) => `${c.label} (${platformName(c.source)}${c.topic ? `; topic: ${String(c.topic).slice(0, 120)}` : ''})`);
  const more = o.channels.length > SHOWN_CHANNELS ? ` and ${o.channels.length - SHOWN_CHANNELS} more` : '';
  const chans = o.channels.length
    ? ` ${o.channels.length} ${o.channels.length === 1 ? 'channel' : 'channels'}: ${shown.join(', ')}${more}.`
    : ' No channels.';
  const mail = o.domains.length ? ` Its people write from ${o.domains.join(', ')}.` : '';
  return `${letter}: ${parts.join(', ')}.${chans}${mail}`;
}

/** What Clef is shown of a pair. */
export function pairState(a, b, signals) {
  const shared = signals.length ? `\nShared: ${signals.map((s) => s.text).join('; ')}.` : '';
  return `${INTRO}\n${describeOrg('A', a)}\n${describeOrg('B', b)}${shared}`;
}

async function fingerprintOf(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d).slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Clef's probability that the two orgs of `state` are one, or null when it did not answer. */
async function askPair(env, state) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([env.AI.run(CLEF, {
      model: 'clef', state, questions: { one: { type: 'noul', instructions: QUESTION } },
    }), timeout]);
    const p = Number(res && res.answers && res.answers.one && res.answers.one.noul);
    return Number.isFinite(p) ? p : null;
  } catch (e) {
    console.log(JSON.stringify({ route: 'orgmerge', clef: 'failed', error: String(e && e.message) }));
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

/**
 * Clef's verdict on each of `pairs` (with `state` and `fingerprint`): the one kept when it was
 * asked about what it is shown now, else asked now, at most `ASK_PER_LIST` of them (the
 * strongest first), else the one kept from before (`stale`) or none. Sets `p`, `checked` and
 * `stale` on each.
 */
async function judge(env, pairs, kept) {
  const ask = [];
  for (const pair of pairs) {
    const row = kept.get(pairKey(pair.a, pair.b));
    pair.p = row && row.p !== null ? row.p : null;
    pair.checked = (row && row.checked_at) || null;
    pair.stale = Boolean(row && row.p !== null && row.fingerprint !== pair.fingerprint);
    if ((!row || row.p === null || pair.stale) && env.AI && ask.length < ASK_PER_LIST) {
      ask.push(pair);
    }
  }
  const now = new Date().toISOString();
  await pool(ask, ASK_PARALLEL, async (pair) => {
    const p = await askPair(env, pair.state);
    if (p === null) {
      return;
    }
    Object.assign(pair, { p, checked: now, stale: false });
    await env.DB.prepare(`INSERT INTO org_pairs (a, b, fingerprint, p, checked_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (a, b) DO UPDATE SET fingerprint = excluded.fingerprint, p = excluded.p,
        checked_at = excluded.checked_at`).bind(pair.a, pair.b, pair.fingerprint, p, now).run();
  });
  return pairs.filter((x) => x.p === null || x.stale).length;
}

// ---- requests --------------------------------------------------------------------------------

const requestOf = (r) => ({
  id: r.id,
  from: r.slug,
  into: r.into_slug,
  note: r.note,
  requestedBy: { email: r.requested_by, name: r.requested_name },
  requestedAt: r.requested_at,
  status: r.status,
  decidedBy: r.decided_by ? { email: r.decided_by } : null,
  decidedAt: r.decided_at,
  reason: r.reason,
});

/**
 * The merge requests, open ones first and then the latest decided (`limit`): every one for the
 * admin team, `me`'s own for anyone else.
 */
export async function listMergeRequests(env, me, { limit = 50 } = {}) {
  const mine = isAdmin(me) ? null : String(me.email || '');
  const list = await rows(env, `SELECT * FROM org_merge_requests WHERE (?1 IS NULL OR requested_by = ?1)
    ORDER BY status = 'open' DESC, COALESCE(decided_at, requested_at) DESC LIMIT ?2`, mine, limit);
  return list.map(requestOf);
}

/** How many merge requests wait for the admin team. */
export async function openMergeCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM org_merge_requests WHERE status = 'open'").first();
  return (row && row.n) || 0;
}

/** Whether `slug` is an org the inbox knows (a row, threads, a knowledge base), not merged. */
async function known(env, slug) {
  if (!SLUG.test(slug)) {
    return false;
  }
  const row = await env.DB.prepare(`SELECT
      (SELECT 1 FROM org_merges WHERE slug = ?1) AS merged,
      (SELECT 1 FROM orgs WHERE slug = ?1) AS org,
      (SELECT 1 FROM threads WHERE org = ?1 LIMIT 1) AS threads,
      (SELECT 1 FROM knowledge_bases WHERE kind = 'org' AND slug = ?1) AS kb`).bind(slug).first();
  return Boolean(row && !row.merged && (row.org || row.threads || row.kb));
}

/**
 * POST /api/admin/org-merge-requests `{ from, into, note? }`: asks the admin team to merge `from`
 * into `into`. For anyone who sees one of them (the admin team, or a team that owns it).
 */
export async function requestMerge(env, me, body) {
  const from = clean(body.from);
  const into = clean(body.into);
  if (!from || !into || from === into) {
    return bad('give two different orgs, from and into');
  }
  if (!await known(env, from) || !await known(env, into)) {
    return json({ error: 'no such org, or it was merged already' }, 404);
  }
  if (!isAdmin(me)) {
    const owned = await ownedCustomers(env, (me.teams || []).map((t) => t.slug));
    if (!owned.has(from) && !owned.has(into)) {
      return json({ error: 'none of your teams works with either of them' }, 403);
    }
  }
  const open = await env.DB.prepare(`SELECT * FROM org_merge_requests WHERE status = 'open'
    AND ((slug = ?1 AND into_slug = ?2) OR (slug = ?2 AND into_slug = ?1))`).bind(from, into).first();
  if (open) {
    return json({ error: 'a merge of these two was asked for already', request: requestOf(open) }, 409);
  }
  const r = await env.DB.prepare(`INSERT INTO org_merge_requests (slug, into_slug, note, requested_by,
      requested_name, requested_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(
      from,
      into,
      clean(body.note, MAX_NOTE) || null,
      String(me.email || me.id),
      me.name || null,
      new Date().toISOString(),
    ).first();
  console.log(JSON.stringify({
    route: 'orgmerge', request: 'created', by: me.id, id: r.id,
  }));
  return json({ ok: true, request: requestOf(r) });
}

/**
 * DELETE /api/admin/org-merge-requests `{ id }`: whoever asked takes it back. POST
 * /api/admin/org-merge-requests/decline `{ id, reason? }`: the admin team turns it down.
 */
export async function closeMergeRequest(env, me, body, status) {
  const id = Number(body.id);
  const r = await env.DB.prepare('SELECT * FROM org_merge_requests WHERE id = ?').bind(id).first();
  if (!r) {
    return json({ error: 'no such request' }, 404);
  }
  if (status === 'withdrawn' && r.requested_by !== String(me.email || me.id) && !isAdmin(me)) {
    return json({ error: 'only whoever asked takes a request back' }, 403);
  }
  const { meta } = await env.DB.prepare(`UPDATE org_merge_requests SET status = ?, decided_by = ?,
      decided_at = ?, reason = ? WHERE id = ? AND status = 'open'`)
    .bind(
      status,
      String(me.email || me.id),
      new Date().toISOString(),
      status === 'declined' ? clean(body.reason, MAX_NOTE) || null : null,
      id,
    ).run();
  const now = requestOf(await env.DB.prepare('SELECT * FROM org_merge_requests WHERE id = ?').bind(id).first());
  if (!meta.changes) {
    return json({ error: `this request is ${now.status} already`, request: now }, 409);
  }
  console.log(JSON.stringify({
    route: 'orgmerge', request: status, by: me.id, id,
  }));
  return json({ ok: true, request: now });
}

// ---- the list --------------------------------------------------------------------------------

/** The candidates of the facts kept: `candidates` compares every pair, a tenth of a second. */
const found = new WeakMap();

/** An org as the page shows it in a pair. */
const shownOrg = (o) => ({
  slug: o.slug,
  name: o.name || null,
  type: o.type,
  icon: o.icon || null,
  domain: o.domains[0] || null,
  domains: o.domains,
  channels: o.channels.length,
  threads: o.threads,
  latest: o.latest,
  channelNames: o.channels.slice(0, SHOWN_CHANNELS).map((c) => ({
    label: c.label, source: c.source, threads: c.threads, topic: c.topic,
  })),
});

/**
 * GET /api/admin/org-duplicates[?pair=a:b][&fresh=1]: the pairs of orgs that may be one, each
 * `{ a, b, signals, score, p, checked, stale, dismissed, requests }` with the orgs in `orgs`,
 * open requests first, then by Clef's probability and the signals; `unchecked` counts the pairs
 * Clef was not asked about yet (the next load asks them). `pair` answers that one pair, whatever
 * its signals. The admin team sees every pair, the dismissed ones too, and the merges
 * (`merges`); anyone else the pairs of the customers their teams own that are not dismissed,
 * and their own requests.
 */
export async function orgDuplicates(env, me, { pair = '', fresh = false } = {}) {
  const admin = isAdmin(me);
  const [cached, kept, requests, owned, merges] = await Promise.all([
    facts(env, { fresh }),
    rows(env, 'SELECT * FROM org_pairs'),
    listMergeRequests(env, me),
    admin ? null : ownedCustomers(env, (me.teams || []).map((t) => t.slug)),
    listMerges(env),
  ]);
  // The facts may be from before a merge another isolate made.
  const merged = new Set(merges.map((m) => m.slug));
  const f = merged.size && [...merged].some((slug) => cached.orgs.has(slug)) ? {
    ...cached, orgs: new Map([...cached.orgs].filter(([slug]) => !merged.has(slug))),
  } : cached;
  const keptBy = new Map(kept.map((r) => [pairKey(r.a, r.b), r]));
  const sees = (slug) => admin || owned.has(slug);
  let list;
  if (pair) {
    const [x, y] = ordered(...String(pair).split(':'));
    if (!f.orgs.has(x) || !f.orgs.has(y) || x === y) {
      return json({ error: 'no such pair of orgs (one may be merged already)' }, 404);
    }
    if (!sees(x) && !sees(y)) {
      return json({ error: 'none of your teams works with either of them' }, 403);
    }
    const signals = signalsOf(f.orgs.get(x), f.orgs.get(y), {
      ...spreads(f.orgs), members: f.members,
    });
    list = [{
      a: x, b: y, signals, score: scoreOf(signals),
    }];
  } else {
    if (!found.has(f)) {
      found.set(f, candidates(f));
    }
    // Copies: what is said of each is added below.
    list = found.get(f).filter((c) => sees(c.a) || sees(c.b)).map((c) => ({ ...c }));
    // The pairs asked for, whatever their signals.
    const have = new Set(list.map((c) => pairKey(c.a, c.b)));
    const spread = spreads(f.orgs);
    for (const r of requests.filter((q) => q.status === 'open')) {
      const [x, y] = ordered(r.from, r.into);
      if (f.orgs.has(x) && f.orgs.has(y) && !have.has(pairKey(x, y))) {
        have.add(pairKey(x, y));
        const signals = signalsOf(f.orgs.get(x), f.orgs.get(y), { ...spread, members: f.members });
        list.push({
          a: x, b: y, signals, score: scoreOf(signals),
        });
      }
    }
  }
  for (const c of list) {
    c.state = pairState(f.orgs.get(c.a), f.orgs.get(c.b), c.signals);
    // eslint-disable-next-line no-await-in-loop
    c.fingerprint = await fingerprintOf(c.state);
    const row = keptBy.get(pairKey(c.a, c.b));
    c.dismissed = row && row.dismissed_at ? { by: row.dismissed_by, at: row.dismissed_at } : null;
    c.requests = requests.filter((r) => pairKey(r.from, r.into) === pairKey(c.a, c.b));
  }
  const open = (c) => c.requests.some((r) => r.status === 'open');
  // Not dismissed, unless somebody asks for it; for the admin team, the dismissed ones last.
  const shown = list.filter((c) => pair || admin || !c.dismissed || open(c));
  const unchecked = await judge(env, shown.filter((c) => pair || !c.dismissed || open(c)), keptBy);
  shown.sort((x, y) => (open(y) - open(x)) || (Boolean(x.dismissed) - Boolean(y.dismissed))
    || ((y.p ?? -1) - (x.p ?? -1)) || (y.score - x.score));
  const orgs = {};
  for (const c of shown) {
    orgs[c.a] = shownOrg(f.orgs.get(c.a));
    orgs[c.b] = shownOrg(f.orgs.get(c.b));
  }
  return json({
    // What Clef was shown stays here.
    pairs: shown.map((c) => Object.fromEntries(Object.entries(c)
      .filter(([k]) => k !== 'state' && k !== 'fingerprint'))),
    orgs,
    unchecked,
    likely: LIKELY,
    requests,
    ...(admin ? { merges } : {}),
  });
}

/**
 * POST /api/admin/org-duplicates/dismiss `{ a, b, undo? }`: the admin team says two orgs are not
 * one; they leave the list (the admin team's shows them last), until somebody asks to merge them.
 */
export async function dismissPair(env, me, body) {
  const [a, b] = ordered(clean(body.a), clean(body.b));
  if (!SLUG.test(a) || !SLUG.test(b) || a === b) {
    return bad('give two orgs, a and b');
  }
  const at = body.undo ? null : new Date().toISOString();
  const by = body.undo ? null : String(me.email || me.id);
  await env.DB.prepare(`INSERT INTO org_pairs (a, b, dismissed_by, dismissed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (a, b) DO UPDATE SET dismissed_by = excluded.dismissed_by,
      dismissed_at = excluded.dismissed_at`).bind(a, b, by, at).run();
  return json({ ok: true, dismissed: at ? { by, at } : null });
}

// ---- merging ---------------------------------------------------------------------------------

/** The org-scoped tables a merge moves to the org kept: `[table, column, where]`. */
const MOVED = [
  ['mcp_servers', 'slug', "scope = 'org'"],
  ['agent_secrets', 'slug', "scope = 'org'"],
  ['agent_repos', 'slug', "scope = 'org'"],
  ['person_follows_by', 'target', "kind = 'org'"],
  ['org_stacks', 'org', '1 = 1'],
  ['portal_requests', 'org', '1 = 1'],
];

/** How many rows of each of `MOVED` `slug` has: `{ mcp_servers: 2, … }`, without the empty ones. */
async function movedCounts(env, slug) {
  const counts = await Promise.all(MOVED.map(([table, col, where]) => env.DB
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where} AND ${col} = ?`).bind(slug).first()));
  return Object.fromEntries(MOVED.map(([table], i) => [table, counts[i].n]).filter(([, n]) => n));
}

/**
 * Every file of a knowledge base (`listFiles` lists 400 at most: each directory of the root is
 * listed on its own), and whether some were left out.
 */
async function allFiles(env, repo) {
  const root = await listFiles(env, repo, '');
  if (root.error || root.empty) {
    return { files: [], error: root.error };
  }
  const files = root.entries.filter((e) => e.type !== 'tree');
  let truncated = Boolean(root.truncated);
  for (const dir of root.entries.filter((e) => e.type === 'tree')) {
    // eslint-disable-next-line no-await-in-loop
    const below = await listFiles(env, repo, dir.path, { recursive: true });
    files.push(...(below.entries || []).filter((e) => e.type !== 'tree'));
    truncated = truncated || Boolean(below.truncated);
  }
  return { files, truncated };
}

/**
 * Copies the entries of `from`'s knowledge base that `into`'s has not (by path) into `into`'s,
 * as `me`, `MAX_CHANGES` a commit. A path both have with other content is left in `from`'s
 * (`kept`), for the knowledge-base agent's dream or a person to reconcile. `write` is
 * `writeKnowledge` (tests give their own).
 */
export async function mergeKnowledge(env, me, from, into, { write = writeKnowledge } = {}) {
  const src = repoName('org', from);
  const dst = repoName('org', into);
  const row = src && await env.DB.prepare('SELECT entries FROM knowledge_bases WHERE repo = ?').bind(src).first();
  if (!row || row.entries === 0 || !env.ARTIFACTS) {
    return { copied: 0, kept: [] };
  }
  await ensureKnowledgeBase(env, 'org', into);
  const [a, b] = await Promise.all([allFiles(env, src), allFiles(env, dst)]);
  if (a.error) {
    return { copied: 0, kept: [], error: a.error };
  }
  const there = new Map(b.files.map((e) => [e.path, e.hash]));
  const entries = a.files.filter((e) => isEntry(e.path) && there.get(e.path) !== e.hash);
  const copy = entries.filter((e) => !there.has(e.path));
  const kept = entries.filter((e) => there.has(e.path)).map((e) => e.path);
  let copied = 0;
  const failed = [];
  const who = me.name || me.email;
  for (let i = 0; i < copy.length; i += MAX_CHANGES) {
    const batch = copy.slice(i, i + MAX_CHANGES);
    // eslint-disable-next-line no-await-in-loop
    const texts = await readBlobs(env, src, batch.map((e) => e.hash));
    const changes = batch.filter((e) => typeof texts[e.hash] === 'string')
      .map((e) => ({ path: e.path, content: texts[e.hash], create: true }));
    if (changes.length) {
      // eslint-disable-next-line no-await-in-loop
      const res = await write(env, dst, changes, {
        message: `Merge ${from} into ${into}\n\nOpspile-Editor: ${who}`,
        by: `human:${me.email}`,
        author: { name: who, email: me.email },
        logEntry: `**Merge**: ${changes.length} entries of ${src}, merged into this customer (${who})`,
        staff: true,
      }).catch((e) => ({ error: e.message }));
      if (res.error || res.conflict) {
        failed.push(...changes.map((c) => c.path));
        console.error(JSON.stringify({
          route: 'orgmerge', kb: 'not copied', files: changes.length, error: res.error || res.conflict,
        }));
      } else {
        copied += changes.length;
      }
    }
  }
  return {
    copied, kept, ...(failed.length ? { failed } : {}), ...(a.truncated ? { truncated: true } : {}),
  };
}

/** Whether `slug` was merged into another org: the merge's row, or null. */
async function mergeOf(env, slug) {
  return env.DB.prepare('SELECT slug, into_slug AS "into", name, type, icon, merged_by, merged_at FROM org_merges WHERE slug = ?')
    .bind(slug).first();
}

/**
 * POST /api/admin/org-merge `{ from, into, dryRun? }`: the admin team merges `from` into `into`
 * (see the top of this file). `dryRun` answers with the channels it would re-file (`moves`) and
 * what else would move (`moved`: rows by table, `kb`: the entries of `from`'s knowledge base);
 * applied, with the same and the knowledge base's copy (`kb: { copied, kept }`). Every open
 * request for the pair is merged with it. `applyRules` is src/admin.js's.
 */
export async function mergeOrgs(env, me, body, { applyRules }) {
  const from = clean(body.from);
  const into = clean(body.into);
  if (!from || !into || from === into) {
    return bad('give two different orgs, from and into');
  }
  if (!await known(env, from)) {
    return json({ error: `there is no org ${from}, or it was merged already` }, 404);
  }
  if (!await known(env, into)) {
    const m = await mergeOf(env, into);
    return json({ error: m ? `${into} was merged into ${m.into}: merge into that one` : `there is no org ${into}` }, m ? 409 : 404);
  }
  const current = await loadRules(env);
  // What was merged into `from` goes to `into` directly: no chain.
  const next = [
    ...current.map((r) => (r.target === 'merge' && r.value === from ? { ...r, value: into } : r)),
    mergeRule({ slug: from, into }, current.filter((r) => r.target === 'merge').length),
  ];
  const kb = await env.DB.prepare('SELECT entries FROM knowledge_bases WHERE kind = \'org\' AND slug = ?')
    .bind(from).first();
  const moved = await movedCounts(env, from);
  const res = await applyRules(env, me, {
    next,
    dryRun: body.dryRun,
    extra: { merge: { from, into }, moved, kb: { entries: kb ? kb.entries : 0 } },
    only: (m) => m.to.org === into && m.from.some((f) => f.org === from),
    write: async () => {
      const [by, at] = [String(me.email || me.id), new Date().toISOString()];
      const was = await env.DB.prepare('SELECT name, type, icon FROM orgs WHERE slug = ?').bind(from).first();
      const statements = [
        env.DB.prepare(`INSERT INTO org_merges (slug, into_slug, name, type, icon, merged_by, merged_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
          from,
          into,
          was ? was.name : null,
          was ? was.type : null,
          was ? was.icon : null,
          by,
          at,
        ),
        env.DB.prepare('UPDATE org_merges SET into_slug = ? WHERE into_slug = ?').bind(into, from),
        ...(was ? [env.DB.prepare(`INSERT INTO orgs (slug, name, type, icon, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (slug) DO UPDATE SET name = COALESCE(orgs.name, excluded.name),
            icon = COALESCE(orgs.icon, excluded.icon)`).bind(into, was.name, was.type, was.icon, at)] : []),
        env.DB.prepare('DELETE FROM orgs WHERE slug = ?').bind(from),
        // A row `into` has of its own (a server of the same name) stays, and so does `from`'s.
        ...MOVED.map(([table, col, where]) => env.DB.prepare(`UPDATE OR IGNORE ${table} SET ${col} = ?
          WHERE ${where} AND ${col} = ?`).bind(into, from)),
        // A repository both list, a person who follows both: once is enough.
        env.DB.prepare("DELETE FROM agent_repos WHERE scope = 'org' AND slug = ?").bind(from),
        env.DB.prepare("DELETE FROM person_follows_by WHERE kind = 'org' AND target = ?").bind(from),
        env.DB.prepare('DELETE FROM org_pairs WHERE a = ?1 OR b = ?1').bind(from),
        env.DB.prepare(`UPDATE org_merge_requests SET status = 'merged', decided_by = ?, decided_at = ?
          WHERE status = 'open' AND ((slug = ?3 AND into_slug = ?4) OR (slug = ?4 AND into_slug = ?3))`)
          .bind(by, at, from, into),
      ];
      await env.DB.batch(statements);
      forgetFacts();
      console.log(JSON.stringify({
        route: 'orgmerge', merged: true, by: me.id,
      }));
      return {};
    },
  });
  if (body.dryRun || !res.ok) {
    return res;
  }
  const done = await res.json();
  const copied = await mergeKnowledge(env, me, from, into).catch((e) => {
    console.error(JSON.stringify({ route: 'orgmerge', kb: 'failed', error: e.message }));
    return { copied: 0, kept: [], error: e.message };
  });
  return json({ ...done, kb: { ...done.kb, ...copied } });
}

/**
 * DELETE /api/admin/org-merge `{ slug, dryRun? }`: undoes the merge of `slug`. Its channels go
 * back to it (a rule change, as the merge was), and so does its name, icon and type; what moved
 * with it to the other org (servers, secrets, follows, knowledge) stays there.
 */
export async function unmergeOrg(env, me, body, { applyRules }) {
  const slug = clean(body.slug);
  const m = await mergeOf(env, slug);
  if (!m) {
    return json({ error: `${slug || 'that org'} was not merged` }, 404);
  }
  const current = await loadRules(env);
  return applyRules(env, me, {
    next: current.filter((r) => !(r.target === 'merge' && r.pattern === slug)),
    dryRun: body.dryRun,
    extra: { unmerged: { slug, into: m.into } },
    only: (move) => move.to.org === slug,
    write: async () => {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM org_merges WHERE slug = ?').bind(slug),
        ...(m.name || m.icon || m.type ? [env.DB.prepare(`INSERT INTO orgs (slug, name, type, icon, updated_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (slug) DO NOTHING`)
          .bind(slug, m.name, m.type || 'customer', m.icon, new Date().toISOString())] : []),
      ]);
      forgetFacts();
      console.log(JSON.stringify({ route: 'orgmerge', unmerged: true, by: me.id }));
      return {};
    },
  });
}
