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

import { isStaffDomain } from './lookup.js';

/**
 * Profile cards: what the inbox knows about an author, keyed by their identity
 * (`<source>:<tenant>:<user id>`, as `messages.author_key`). Everything comes from D1 (the
 * cached platform lookups, people, ops teams, partner domains), so a card costs no request:
 * the cards of a page's authors travel with the inbox and thread payloads.
 *
 * Who someone is to us:
 * - `adobe`: staff (a person marked staff in D1, or a mail domain in STAFF_DOMAINS)
 * - `partner`: their mail domain (or a parent domain) is in `partner_domains`
 * - `customer`: any other person
 * - `bot`: a bot account
 *
 * Emails stay on the server; the card gets the mail domain only.
 */

const domainOf = (email) => (email && email.includes('@') ? email.split('@').pop().toLowerCase() : null);

/** The partner a mail domain belongs to, matching the domain or any parent domain. */
export function partnerOf(domain, partners) {
  const parts = String(domain || '').toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    const d = parts.slice(i).join('.');
    if (partners.has(d)) {
      return { domain: d, name: partners.get(d) || d };
    }
  }
  return null;
}

/** `adobe`, `partner`, `customer` or `bot`. */
export function relationOf(env, { kind, staff, email }, partners) {
  if (kind === 'bot') {
    return 'bot';
  }
  if (staff || isStaffDomain(env, email)) {
    return 'adobe';
  }
  return partnerOf(domainOf(email), partners) ? 'partner' : 'customer';
}

const splitKey = (key) => {
  const [source, tenant, ...rest] = String(key).split(':');
  return [source, tenant, rest.join(':')];
};

/**
 * Cards for the given identity keys: `{ [key]: { name, avatar, platform, kind, title,
 * company, domain, relation, partner, teams } }`. Unknown keys are left out.
 */
export async function profiles(env, keys) {
  const wanted = [...new Set((keys || []).filter(Boolean))];
  if (!wanted.length) {
    return {};
  }
  const { results: rows } = await env.DB.prepare(`WITH k AS (
      SELECT json_extract(value, '$[0]') AS s, json_extract(value, '$[1]') AS t,
        json_extract(value, '$[2]') AS u FROM json_each(?))
    SELECT i.source, i.tenant, i.user_id, i.kind, COALESCE(p.name, i.name) AS name, i.avatar,
      i.email, i.title, i.company, i.person, COALESCE(p.staff, 0) AS staff
    FROM k JOIN identities i ON i.source = k.s AND i.tenant = k.t AND i.user_id = k.u
    LEFT JOIN people p ON p.id = i.person`).bind(JSON.stringify(wanted.map(splitKey))).all();
  if (!rows || !rows.length) {
    return {};
  }
  const persons = [...new Set(rows.map((r) => r.person).filter(Boolean))];
  const { results: memberships } = persons.length ? await env.DB.prepare(`SELECT m.person,
      t.name FROM team_members m JOIN teams t ON t.slug = m.team
    WHERE m.person IN (SELECT value FROM json_each(?)) ORDER BY t.name`)
    .bind(JSON.stringify(persons)).all() : { results: [] };
  const { results: partnerRows } = await env.DB
    .prepare('SELECT domain, name FROM partner_domains').all();
  const partners = new Map((partnerRows || [])
    .map((r) => [String(r.domain).toLowerCase(), r.name]));
  const teamsOf = new Map();
  for (const m of memberships || []) {
    teamsOf.set(m.person, [...(teamsOf.get(m.person) || []), m.name]);
  }
  return Object.fromEntries(rows.map((r) => {
    const domain = domainOf(r.email);
    const relation = relationOf(env, r, partners);
    const partner = relation === 'partner' ? partnerOf(domain, partners) : null;
    return [`${r.source}:${r.tenant}:${r.user_id}`, {
      name: r.name || null,
      avatar: r.avatar || null,
      platform: r.source,
      kind: r.kind,
      title: r.title || null,
      company: r.company || null,
      domain,
      relation,
      partner: partner ? partner.name : null,
      teams: (r.person && teamsOf.get(r.person)) || [],
    }];
  }));
}
