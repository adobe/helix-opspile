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

import { channelUrlRef } from '../channelurl.js';
import { platformUrl } from '../channelrefs.js';
import { likePattern as like } from '../like.js';
import { channelOf, resolveAnyThread } from './history.js';

/**
 * The inbox's channels, for a thread agent with the `any_thread` tool (src/agent/agenttools.js):
 * which channels are a customer's (`findChannels`, the agent's find_channels), and which channel
 * an id or a link names (`resolveChannel`, for list_any_channel_threads). A colleague relays a
 * customer's question into an internal channel, and the customer has a channel of its own, on
 * Slack, Teams or Discord: the agent finds it by the customer's name, the name of the channel,
 * or a site or repository its threads are about, instead of only by a link someone saved.
 *
 * Only what the rules and the labels say of a channel: its customer (the org its latest thread
 * is filed under, and that org's name), its name (on Teams, and its team's), and the `site` and
 * `repo` facts of its threads. A channel the rules ignore is nobody's to find.
 */

export const MAX_CHANNELS = 25;
const DEFAULT_CHANNELS = 10;
const MAX_WORDS = 8;
const MAX_CANDIDATES = 200;
/** Of the candidates, the details of this many (or three times the limit) are read. */
const MIN_DETAILS = 30;
/** Words in a company's name that say nothing about which company it is. */
const STOP = new Set(['and', 'the', 'for', 'inc', 'corp', 'corporation', 'company', 'ltd',
  'limited', 'llc', 'gmbh', 'plc', 'group', 'holding', 'holdings', 'technologies', 'technology',
  'international', 'global', 'services', 'solutions', 'systems', 'customer', 'channel', 'team',
  // Ours: most channels are named aem-<customer>.
  'adobe', 'aem']);
/** An Edge Delivery host: `<ref>--<site>--<owner>.aem.page` and its kin, as the site rule. */
const EDS_HOST = /^(?:(?:[a-z0-9]|-(?!-))+--)?((?:[a-z0-9]|-(?!-))+)--((?:[a-z0-9]|-(?!-))+)\.(?:aem\.(?:page|live|network|reviews)|hlx\.(?:page|live))$/;
/** The orgs whose channels a site's threads alone find: a vendor's or ours ask about others'. */
const OWN_SITES = ['customer', 'partner'];
const SITE = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/;

/**
 * What a query looks for: `{ words, sites }`. `words` are matched against the customers' and
 * the channels' names, and as the owner of a site or repository (`acme` finds `acme/site`);
 * `sites` (`owner/name`, from an Edge Delivery host too) against the facts as they are.
 */
export function queryParts(q) {
  const words = new Set();
  const sites = new Set();
  const add = (s) => s.split(/[^a-z0-9]+/).forEach((w) => {
    if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) {
      words.add(w);
    }
  });
  for (const raw of String(q || '').toLowerCase().split(/[\s,;|()<>[\]"'`“”‘’]+/)) {
    let w = raw.replace(/^[a-z]+:\/\//, '').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    const [host, ...rest] = w.split('/');
    const eds = EDS_HOST.exec(host);
    if (eds) {
      sites.add(`${eds[2]}/${eds[1]}`);
      add(eds[2]);
    } else if (rest.length && SITE.test(`${host}/${rest[0]}`) && !host.includes('.')) {
      sites.add(`${host}/${rest[0]}`);
      add(host);
    } else {
      if (host.includes('.')) {
        // A domain: its name, without www. and the top-level domain (agilent.com: agilent).
        [w] = host.split('.').filter((l) => l && l !== 'www');
      } else {
        w = host;
      }
      add(w);
    }
  }
  return { words: [...words].slice(0, MAX_WORDS), sites: [...sites].slice(0, MAX_WORDS) };
}

const channelKey = (r) => `${r.source}:${r.tenant}:${r.channel_id}`;

/** A row of `details` as the agent's tools show it, with its id and its link on its platform. */
const shown = (r) => ({
  id: channelKey(r),
  source: r.source,
  tenant: String(r.tenant),
  channel_id: String(r.channel_id),
  name: r.name || null,
  group_name: r.group_name || null,
  org: r.org || null,
  org_name: r.org_name || null,
  org_type: r.org_type,
  team: r.team || null,
  shared: r.shared,
  kind: r.kind || null,
  threads: r.threads,
  at: r.at || null,
  url: platformUrl(r),
});

/**
 * The channels `keys` (`[[source, tenant, channel_id]]`) as the agent sees them: their name,
 * the customer, team and kind of their latest thread, how many conversations they have and
 * when the latest was active, and the teams they are shared with.
 */
async function details(env, keys) {
  if (!keys.length) {
    return [];
  }
  const [{ results }, { results: shares }] = await Promise.all([
    env.DB.prepare(`WITH k AS (SELECT json_extract(value, '$[0]') AS source,
          json_extract(value, '$[1]') AS tenant, json_extract(value, '$[2]') AS channel_id
        FROM json_each(?1)),
      latest AS (SELECT k.source, k.tenant, k.channel_id,
          (SELECT t.thread FROM threads t WHERE t.channel_id = k.channel_id
            AND t.source = k.source AND t.tenant = k.tenant
            ORDER BY COALESCE(t.last_at, t.any_at) DESC LIMIT 1) AS thread
        FROM k)
      SELECT l.source, l.tenant, l.channel_id, COALESCE(c.name, t.channel_name) AS name,
        c.group_name, c.group_id, c.domain, t.org, t.team, t.kind, o.name AS org_name,
        COALESCE(o.type, 'customer') AS org_type, t.last_at AS at,
        (SELECT COUNT(*) FROM threads x WHERE x.channel_id = l.channel_id AND x.source = l.source
          AND x.tenant = l.tenant AND x.logical_thread IS NULL AND x.last_at IS NOT NULL) AS threads
      FROM latest l LEFT JOIN threads t ON t.thread = l.thread
        LEFT JOIN channels c ON c.source = l.source AND c.tenant = l.tenant
          AND c.channel_id = l.channel_id
        LEFT JOIN orgs o ON o.slug = t.org`).bind(JSON.stringify(keys)).all(),
    env.DB.prepare(`SELECT source, channel_id, team FROM channel_teams
      WHERE channel_id IN (SELECT json_extract(value, '$[2]') FROM json_each(?1))
      ORDER BY added_at, team`).bind(JSON.stringify(keys)).all(),
  ]);
  return (results || []).filter((r) => r.kind !== 'ignore').map((r) => ({
    ...r,
    shared: (shares || []).filter((s) => s.source === r.source && s.channel_id === r.channel_id
      && s.team !== r.team).map((s) => s.team),
  }));
}

/** `{ sql, bind }`: any of `columns` has any of the words. */
const anyLike = (columns, words) => ({
  sql: words.flatMap(() => columns.map((c) => `${c} LIKE ? ESCAPE '\\'`)).join(' OR '),
  bind: words.flatMap((w) => columns.map(() => like(w))),
});

/** The channels whose own name or, on Teams, team's name has one of the words. */
async function byName(env, words) {
  if (!words.length) {
    return [];
  }
  const where = anyLike(['name', 'group_name'], words);
  const { results } = await env.DB.prepare(`SELECT source, tenant, channel_id, name, group_name
    FROM channels WHERE ${where.sql} LIMIT ${MAX_CANDIDATES}`).bind(...where.bind).all();
  return results || [];
}

/**
 * The channels of the customers whose slug or name has one of the words: an org with a row, or
 * one the rules filed threads under without one.
 */
async function byCustomer(env, words) {
  if (!words.length) {
    return [];
  }
  const named = anyLike(['slug', 'name'], words);
  const slugs = anyLike(['org'], words);
  const { results } = await env.DB.prepare(`SELECT DISTINCT t.source, t.tenant, t.channel_id,
      t.org, o.name AS org_name
    FROM threads t LEFT JOIN orgs o ON o.slug = t.org WHERE t.kind != 'ignore' AND t.org IN (
      SELECT slug FROM orgs WHERE ${named.sql}
      UNION SELECT DISTINCT org FROM threads WHERE ${slugs.sql})
    LIMIT ${MAX_CANDIDATES}`).bind(...named.bind, ...slugs.bind).all();
  return results || [];
}

/**
 * Per channel and site or repository, how many of its threads are about one of `sites`, or one
 * owned by one of the words: `[{ source, tenant, channel_id, value, n }]`.
 */
async function bySite(env, words, sites) {
  if (!words.length && !sites.length) {
    return [];
  }
  const ranges = words.map(() => '(f.value >= ? AND f.value < ?)');
  const exact = sites.length ? ['f.value IN (SELECT value FROM json_each(?))'] : [];
  const { results } = await env.DB.prepare(`SELECT t.source, t.tenant, t.channel_id, f.value,
      COUNT(DISTINCT f.thread) AS n
    FROM facts f JOIN threads t ON t.thread = f.thread
    WHERE f.field IN ('site', 'repo') AND t.kind != 'ignore'
      AND (${[...exact, ...ranges].join(' OR ')})
    GROUP BY t.source, t.tenant, t.channel_id, f.value ORDER BY n DESC LIMIT ${MAX_CANDIDATES}`)
    // '0' is the character after '/': `acme/` up to it is every site of acme.
    .bind(...(sites.length ? [JSON.stringify(sites)] : []), ...words.flatMap((w) => [`${w}/`, `${w}0`]))
    .all();
  return results || [];
}

/**
 * The channels of the inbox that `query` names, best first, without the channel `here`
 * (`{ source, tenant, channelId }`, the agent's own): `{ words, sites, channels: [{ id, source,
 * tenant, channel_id, name, group_name, org, org_name, org_type, team, shared, kind, threads, at,
 * url, matched: { customer, channel, sites } }] }`. `matched` says why: the words in the
 * customer's slug or name, those in the channel's (or its Teams team's) name, and the sites and
 * repositories its threads are about (`[{ value, threads }]`). A word matches at the start of a
 * word of a name. A channel of an internal org or a vendor is found by its name or its org's,
 * not by a site someone asked about there.
 */
export async function findChannels(env, query, { here = null, limit = DEFAULT_CHANNELS } = {}) {
  const { words, sites } = queryParts(query);
  const n = Math.min(Math.max(Number(limit) || DEFAULT_CHANNELS, 1), MAX_CHANNELS);
  if (!words.length && !sites.length) {
    return { words, sites, channels: [] };
  }
  const [named, customers, sited] = await Promise.all([
    byName(env, words), byCustomer(env, words), bySite(env, words, sites),
  ]);
  const own = here ? `${here.source}:${here.tenant}:${here.channelId}` : null;
  // At the start of a word of the name: "acme" is in aem-acme and Acme Corp, not in megacme.
  const has = (w, ...fields) => fields.some((f) => String(f || '').toLowerCase()
    .split(/[^a-z0-9]+/).some((part) => part.startsWith(w)));
  // What the candidates say already, to read the details of the likeliest only.
  const first = new Map();
  for (const r of [...named, ...customers, ...sited]) {
    const k = channelKey(r);
    if (k !== own) {
      const c = first.get(k) || {
        key: [r.source, String(r.tenant), String(r.channel_id)], words: new Set(), sites: 0,
      };
      words.filter((w) => has(w, r.name, r.group_name, r.org, r.org_name))
        .forEach((w) => c.words.add(w));
      c.sites += r.n ? 1 : 0;
      first.set(k, c);
    }
  }
  const guess = (c) => 2 * c.words.size + Math.sign(c.sites);
  const likeliest = [...first.values()].sort((a, b) => guess(b) - guess(a))
    .slice(0, Math.max(3 * n, MIN_DETAILS));
  const rows = await details(env, likeliest.map((c) => c.key));
  const found = rows.map((r) => {
    const siteRows = sited.filter((s) => channelKey(s) === channelKey(r));
    const matched = {
      customer: words.filter((w) => has(w, r.org, r.org_name)),
      channel: words.filter((w) => has(w, r.name, r.group_name)),
      sites: siteRows.map((s) => ({ value: s.value, threads: s.n })),
    };
    const byWords = new Set([...matched.customer, ...matched.channel]).size;
    const siteThreads = siteRows.reduce((sum, s) => sum + s.n, 0);
    const exact = words.includes(String(r.org || '').toLowerCase()) ? 1 : 0;
    let score = 2 * byWords + exact;
    if (siteRows.length && (byWords || OWN_SITES.includes(r.org_type))) {
      const exactSite = siteRows.some((s) => sites.includes(s.value)) ? 1 : 0;
      score += 1 + Math.min(siteThreads, 10) / 10 + exactSite;
    }
    return { ...shown(r), matched, score };
  }).filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || String(b.at || '').localeCompare(String(a.at || '')));
  return {
    words,
    sites,
    channels: found.slice(0, n).map(({ score: _, ...r }) => r),
    more: found.length > n,
  };
}

/**
 * The channel `ref` names: an id from findChannels (`<source>:<tenant>:<channel id>`), a link to
 * the channel (src/channelurl.js), or a thread's key or a link to one of its messages (its
 * channel). `{ channel }` as findChannels gives one (without `matched`), or `{ error }`. A
 * channel the rules ignore, or that has no conversations opspile knows, is none.
 */
export async function resolveChannel(env, ref) {
  // A link pasted from markdown may keep the backslash of an escaped `&`.
  const s = String(ref || '').trim().replace(/\\&/g, '&');
  let keys = [];
  const id = /^(slack|teams|discord):([^:]+):(.+)$/.exec(s);
  if (id) {
    keys.push([id[1], id[2], id[3]]);
  }
  const link = channelUrlRef(s);
  if (link) {
    const { results } = await env.DB.prepare(`SELECT DISTINCT source, tenant, channel_id
      FROM threads WHERE source = ? AND channel_id = ? AND (?3 IS NULL OR tenant = ?3)
      LIMIT 5`).bind(link.source, link.channel, link.tenant).all();
    keys.push(...(results || []).map((r) => [r.source, String(r.tenant), String(r.channel_id)]));
  }
  if (!keys.length || id) {
    const thread = await resolveAnyThread(env, s);
    const at = !thread.error && await channelOf(env, thread.key);
    if (at) {
      keys = [[at.source, String(at.tenant), String(at.channel_id)]];
    }
  }
  const rows = (await details(env, keys)).filter((r) => r.kind && r.threads > 0);
  if (!rows.length) {
    return { error: 'no channel of the inbox has that id or link; find_channels finds them by name' };
  }
  if (rows.length > 1) {
    return { error: 'that link is to channels of more than one workspace; give the id from find_channels' };
  }
  return { channel: shown(rows[0]) };
}
