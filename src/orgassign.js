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

import { orgDomain, registrable } from './favicons.js';
import { domainList } from './lookup.js';
import { facts } from './orgmerge.js';
import { UNASSIGNED } from './rules.js';

/**
 * Which org a channel no rule files under one (the org `_unassigned`) may belong to, for the
 * admin pages' Unassigned customers: the orgs it shares something with, strongest first, and a
 * new org its name or its people's mail domain suggests where none fits.
 *
 * - place: a Slack Connect team or a Teams team the channel shares with the channels of an org,
 *   and with those of few others (the inbox's own Enterprise Grid is in every Connect channel);
 * - mail: the mail domain of the people outside Adobe in it, or who post there, is an org's;
 * - name: a word of its name, or a few together (`home-depot`), is an org's slug or name, the
 *   products the rules know (`aem-`, `workfront-`) and words such as `adobe` or `alerts` aside.
 */

/** Words of a channel's name that name no org. */
const NOT_ORG = new Set(['adobe', 'and', 'the', 'with', 'for', 'alerts', 'alert', 'notify',
  'notifications', 'release', 'releases', 'notes', 'team', 'teams', 'dev', 'devs', 'test', 'tests',
  'testing', 'prod', 'stage', 'staging', 'ops', 'support', 'help', 'internal', 'eng', 'general',
  'integration', 'project', 'projects', 'sandbox', 'feedback', 'partner', 'partners', 'ext',
  'external', 'shared', 'channel', 'main', 'sync', 'migration', 'launch', 'golive', 'poc', 'pilot',
  'foundation', 'automation', 'autom', 'tmp', 'temp', 'old', 'new', 'emea', 'apac', 'amer', 'us',
  'eu', 'uk', 'global', 'inc', 'corp', 'group', 'ams', 'eds']);
/** Most orgs a place may have channels of and still say something about one of them. */
const MAX_PLACE = 3;
/** Most existing orgs suggested for a channel. */
const MAX_SUGGESTED = 3;

const compact = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');

/**
 * The products the org rules know: the alternatives of a template rule's `^(?:aem|da|…)-`, each
 * of their words. A channel named for one of them says nothing of its org.
 */
export function productWords(rules) {
  const out = new Set();
  for (const r of rules.filter((x) => x.target === 'org' && /\$\d/.test(x.value))) {
    const m = /^\^\(\?:([^()]+)\)/.exec(r.pattern || '');
    if (m) {
      for (const p of m[1].split('|')) {
        p.replace(/\\(.)/g, '$1').split('-').filter(Boolean).forEach((w) => out.add(w.toLowerCase()));
      }
    }
  }
  return out;
}

/** The words of a channel's name that may name an org, in order: letters, at least three. */
export function nameWords(name, products = new Set()) {
  return String(name || '').toLowerCase().normalize('NFKD').split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !NOT_ORG.has(w) && !products.has(w));
}

/** A new org's name from a word or a domain: `clickhouse` is Clickhouse. */
const titled = (s) => s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/**
 * Suggestions for one channel (`{ name, places, domains }`) among `orgs` (src/orgmerge.js facts):
 * `{ orgs: [{ org, why }], fresh: { slug, name, why } | null }`. `places` counts the orgs with a
 * channel in each place; `byDomain` the orgs by the mail domains of their people.
 */
export function suggestFor(channel, {
  orgs, places, byDomain, products,
}) {
  const found = new Map();
  const add = (slug, weight, why) => {
    if (!orgs.has(slug)) {
      return;
    }
    const was = found.get(slug) || { org: slug, weight: 0, why: [] };
    was.weight += weight;
    was.why.push(why);
    found.set(slug, was);
  };
  for (const p of channel.places) {
    const alike = [...orgs.values()].filter((o) => o.channels.some((c) => c.places.includes(p)));
    if (alike.length && (places.get(p) || alike.length) <= MAX_PLACE) {
      const what = p.startsWith('teams:') ? 'Teams team' : 'Slack Connect team';
      alike.forEach((o) => add(o.slug, 3, `the same ${what} as its channels`));
    }
  }
  for (const d of channel.domains) {
    for (const slug of byDomain.get(d) || byDomain.get(registrable(d)) || []) {
      add(slug, 3, `its people write from ${d}`);
    }
  }
  const ws = nameWords(channel.name, products);
  const byName = new Map();
  for (const o of orgs.values()) {
    for (const n of [o.slug, o.name]) {
      if (compact(n).length >= 3) {
        byName.set(compact(n), o.slug);
      }
    }
  }
  for (let i = 0; i < ws.length; i += 1) {
    for (let j = Math.min(ws.length, i + 3); j > i; j -= 1) {
      const slug = byName.get(ws.slice(i, j).join(''));
      if (slug) {
        add(slug, j - i > 1 ? 3 : 2, `"${ws.slice(i, j).join('-')}" in its name`);
      }
    }
  }
  const list = [...found.values()].sort((a, b) => b.weight - a.weight || a.org.localeCompare(b.org))
    .slice(0, MAX_SUGGESTED).map(({ org, why }) => ({ org, why: [...new Set(why)].join('; ') }));
  // A new org, where nothing fits: its people's mail domain, else the first word of its name.
  let fresh = null;
  if (!list.length) {
    const domain = channel.domains[0];
    if (domain) {
      const slug = registrable(domain).split('.')[0];
      fresh = { slug, name: titled(slug), why: `its people write from ${domain}` };
    } else if (ws.length) {
      fresh = { slug: ws[0], name: titled(ws[0]), why: `"${ws[0]}" in its name` };
    }
    if (fresh && orgs.has(fresh.slug)) {
      fresh = null;
    }
  }
  return { orgs: list, fresh };
}

async function rows(env, sql, ...args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

/**
 * The suggestions for every channel of `channels` (src/admin.js `channelList`, those of the org
 * `_unassigned`), by channel id. `rules` are the rules as loaded.
 */
export async function unassignedSuggestions(env, channels, rules) {
  const ids = [...new Set(channels.map((c) => c.channelId))];
  if (!ids.length) {
    return {};
  }
  const staff = JSON.stringify(domainList(env.STAFF_DOMAINS));
  const json = JSON.stringify(ids);
  const [f, meta, members, posters] = await Promise.all([
    facts(env),
    rows(env, `SELECT channel_id, source, group_id, connected FROM channels
      WHERE channel_id IN (SELECT value FROM json_each(?))`, json),
    rows(env, `SELECT channel_id, LOWER(SUBSTR(email, INSTR(email, '@') + 1)) AS domain, COUNT(*) AS n
      FROM channel_members WHERE channel_id IN (SELECT value FROM json_each(?1)) AND email LIKE '%_@_%'
        AND LOWER(SUBSTR(email, INSTR(email, '@') + 1)) NOT IN (SELECT value FROM json_each(?2))
      GROUP BY channel_id, domain`, json, staff),
    rows(env, `SELECT m.channel_id, LOWER(SUBSTR(i.email, INSTR(i.email, '@') + 1)) AS domain,
        COUNT(DISTINCT m.author_key) AS n
      FROM messages m JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +m.author_key
      WHERE m.channel_id IN (SELECT value FROM json_each(?1)) AND m.staff = 0 AND m.deleted = 0
        AND i.email LIKE '%_@_%'
      GROUP BY m.channel_id, domain`, json),
  ]);
  const places = new Map();
  for (const o of f.orgs.values()) {
    for (const p of new Set(o.channels.flatMap((c) => c.places))) {
      places.set(p, (places.get(p) || 0) + 1);
    }
  }
  const byDomain = new Map();
  for (const o of f.orgs.values()) {
    for (const d of o.domains.slice(0, 1)) {
      byDomain.set(d, [...(byDomain.get(d) || []), o.slug]);
    }
  }
  const domainsOf = new Map();
  for (const r of [...members, ...posters].filter((x) => orgDomain(env, x.domain))) {
    const m = domainsOf.get(r.channel_id) || new Map();
    m.set(r.domain, (m.get(r.domain) || 0) + r.n);
    domainsOf.set(r.channel_id, m);
  }
  const products = productWords(rules);
  const out = {};
  for (const c of channels.filter((x) => x.org === UNASSIGNED)) {
    const row = meta.find((x) => x.channel_id === c.channelId && x.source === c.source) || {};
    let connected = [];
    try {
      connected = JSON.parse(row.connected || '[]');
    } catch {
      // none
    }
    out[c.channelId] = suggestFor({
      name: c.name,
      places: [
        ...(Array.isArray(connected) ? connected : []).map((t) => `connect:${t}`),
        ...(c.source === 'teams' && row.group_id ? [`teams:${row.group_id}`] : []),
      ],
      domains: [...(domainsOf.get(c.channelId) || new Map())].sort((a, b) => b[1] - a[1])
        .map(([d]) => d),
    }, {
      orgs: f.orgs, places, byDomain, products,
    });
  }
  return out;
}
