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

import { slug as toSlug } from './rules.js';
import { portalBound, portalCall } from './portalsource.js';

/**
 * Integration access requests: people a host of the customer portal's integration signed in with
 * its identity provider (Adobe IMS), who are not enrolled yet (docs/PORTAL-INTEGRATION.md,
 * "Access requests"). The portal keeps them (src/portal/integration-requests.js); the inbox reads
 * them through the `PORTAL` binding, as it acts there, and keeps nothing of them. The admin team
 * decides them in its inbox, where each is a thread (src/requestthreads.js), as the portal's
 * lobbies: approving one either maps a new organization (its channel, filed under a team and a
 * customer by hand, as `portal/open` files a lobby's) or enrolls the person in the channel the
 * organization has on that host already (src/admin.js `approveIntegration`).
 *
 * This module shapes what the portal answers, with what approving would start from (`suggest`):
 * a channel name of our convention, `<product>-<customer>`, the customer part short, from the
 * verified mail domain or the organization's name.
 */

/** Mail domains of everyone: they say nothing of the company. */
const PUBLIC_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me',
  'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'yandex.com', 'yandex.ru',
  'mail.ru', 'qq.com', '163.com', '126.com', 'zoho.com', 'hey.com', 'fastmail.com', 'mail.com',
  't-online.de', 'orange.fr', 'free.fr', 'libero.it', 'naver.com']);
/** The same providers' country domains (`yahoo.co.uk`, `gmx.at`). */
const PUBLIC_BRANDS = new Set(['gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'yahoo', 'gmx',
  'yandex', 'icloud', 'protonmail', 'proton']);
/** Second-level labels of country domains (`acme.co.uk`): the company is the label before. */
const SECOND_LEVEL = new Set(['co', 'com', 'ac', 'gov', 'org', 'net', 'edu', 'ne', 'or', 'gv', 'ltd', 'plc']);
/** Words of a company's name that are not its name. */
const NOISE = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'llp',
  'ltd', 'limited', 'gmbh', 'ag', 'se', 'sa', 'sas', 'sarl', 'srl', 'spa', 'bv', 'nv', 'oy', 'ab',
  'as', 'aps', 'kk', 'pty', 'pte', 'plc', 'group', 'holding', 'holdings', 'international', 'intl',
  'global', 'worldwide', 'the', 'and', 'of', 'org', 'organization', 'organisation', 'enterprise',
  'prod', 'production', 'stage', 'test', 'dev']);
/** The longest customer part suggested: IMS names are often long. */
const SHORT = 20;
const LIMIT = 100;

const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n);

/** `domain`'s company label (`mail.acme.co.uk` → `acme`), or '' for a public mail domain. */
export function mailCompany(email) {
  const domain = String(email || '').toLowerCase().split('@')[1] || '';
  const labels = domain.split('.').filter(Boolean);
  if (labels.length < 2) {
    return '';
  }
  const at = labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2])
    && labels[labels.length - 1].length === 2 ? labels.length - 3 : labels.length - 2;
  const company = labels[at];
  if (PUBLIC_MAIL.has(labels.slice(at).join('.')) || PUBLIC_BRANDS.has(company)) {
    return '';
  }
  const part = toSlug(company);
  return /[a-z]/.test(part) && part.length >= 2 && part.length <= SHORT ? part : '';
}

/**
 * An organization's name, short: before the first `-`, `:`, `|` or `(` (what IMS names add,
 * `Acme Corp - Marketing (Prod)`), without legal forms and filler words, the first words that fit
 * in twenty characters. '' when nothing is left.
 */
export function orgShort(name) {
  const head = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .split(/\s[-–—:|]\s|[:|([]/)[0];
  const words = head.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !NOISE.has(w));
  let out = '';
  for (const w of words.slice(0, 3)) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > SHORT) {
      break;
    }
    out = next;
  }
  return out || (words[0] || '').slice(0, SHORT);
}

/**
 * The customer part of a new channel's name: the mail domain's company when there is one and it
 * is no longer than the organization's short name (or the organization has none), else that.
 */
export function customerPart(orgName, email) {
  const mail = mailCompany(email);
  const org = orgShort(orgName);
  if (mail && (!org || mail.length <= org.length || org.startsWith(mail))) {
    return mail;
  }
  return org || mail || 'customer';
}

/** A channel's name by our convention: `<product>-<customer>`, or the customer part alone. */
export const channelName = (product, part) => toSlug(product ? `${product}-${part}` : part).slice(0, 80);

/** The customer the inbox knows already for a request, by mail domain, slug or name; or null. */
async function knownOrg(env, r, part) {
  const domain = mailCompany(r.email) ? String(r.email).split('@')[1].toLowerCase() : '';
  return env.DB.prepare(`SELECT slug, name FROM orgs WHERE (?1 != '' AND LOWER(icon) = ?1)
      OR slug = ?2 OR (?3 != '' AND LOWER(name) = LOWER(?3))
    ORDER BY (?1 != '' AND LOWER(icon) = ?1) DESC, slug = ?2 DESC LIMIT 1`)
    .bind(domain, part, r.orgName || '').first();
}

/** Where the inbox files a portal channel by hand: `{ team, org }` of its manual rules. */
async function routeOf(env, channelId) {
  const { results } = await env.DB.prepare(`SELECT target, value FROM rules WHERE field = 'channel_id'
      AND pattern = ? AND priority = 10 AND target IN ('team', 'org')
      AND (source IS NULL OR source = 'portal') ORDER BY id`)
    .bind(`^${channelId}$`).all();
  const by = Object.fromEntries((results || []).map((x) => [x.target, x.value]));
  return { team: by.team || null, org: by.org || null };
}

/** A request as the portal answers it, with where approving would start from. */
async function shape(env, r) {
  const part = customerPart(r.orgName, r.email);
  const org = await knownOrg(env, r, part);
  const team = r.product ? await env.DB.prepare('SELECT slug FROM teams WHERE slug = ?')
    .bind(toSlug(r.product)).first() : null;
  const mapping = r.mapping ? { ...r.mapping, route: await routeOf(env, r.mapping.channel) } : null;
  return {
    ...r,
    mapping,
    suggest: {
      name: channelName(r.product, part),
      org: org ? org.slug : toSlug(part),
      orgName: org ? org.name || org.slug : r.orgName || null,
      known: Boolean(org),
      // The team of the host's product, when the inbox has one of that name.
      team: team ? team.slug : null,
      person: r.name || (r.email ? r.email.split('@')[0] : '') || 'Customer',
    },
  };
}

/** The requests the portal keeps, shaped: the pending ones first. [] when it is not bound. */
export async function listIntegrationRequests(env, { limit = LIMIT } = {}) {
  if (!portalBound(env)) {
    return [];
  }
  const res = await portalCall(env, 'accessRequests', {});
  if (!res.ok) {
    throw new Error(res.error || 'the portal did not list its access requests');
  }
  const rows = (res.requests || []).filter((r) => r.status === 'pending')
    .concat((res.requests || []).filter((r) => r.status !== 'pending').slice(0, limit));
  return Promise.all(rows.map((r) => shape(env, r)));
}

/** One request, shaped, or null. */
export async function getIntegrationRequest(env, id) {
  if (!portalBound(env) || !/^\d{1,15}$/.test(clean(id))) {
    return null;
  }
  const res = await portalCall(env, 'accessRequests', { id: Number(id) });
  return res.ok && res.request ? shape(env, res.request) : null;
}

/** How many wait; 0 when the portal is not bound or does not answer. */
export async function integrationOpenCount(env) {
  if (!portalBound(env)) {
    return 0;
  }
  const res = await portalCall(env, 'accessRequests', { count: true });
  return res.ok ? Number(res.pending) || 0 : 0;
}
