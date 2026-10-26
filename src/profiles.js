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
  // The partner domains do not depend on who is asked about: ask D1 for both at once.
  const [{ results: rows }, { results: partnerRows }] = await Promise.all([
    env.DB.prepare(`WITH k AS (
      SELECT json_extract(value, '$[0]') AS s, json_extract(value, '$[1]') AS t,
        json_extract(value, '$[2]') AS u FROM json_each(?))
    SELECT i.source, i.tenant, i.user_id, i.kind, COALESCE(p.name, i.name) AS name, i.avatar,
      i.email, i.title, i.company, i.person,
      MAX(COALESCE(p.staff, 0), COALESCE(i.staff, 0)) AS staff
    FROM k JOIN identities i ON i.source = k.s AND i.tenant = k.t AND i.user_id = k.u
    LEFT JOIN people p ON p.id = i.person`).bind(JSON.stringify(wanted.map(splitKey))).all(),
    env.DB.prepare('SELECT domain, name FROM partner_domains').all(),
  ]);
  if (!rows || !rows.length) {
    return {};
  }
  const persons = [...new Set(rows.map((r) => r.person).filter(Boolean))];
  const { results: memberships } = persons.length ? await env.DB.prepare(`SELECT m.person,
      t.name FROM team_members m JOIN teams t ON t.slug = m.team
    WHERE m.person IN (SELECT value FROM json_each(?)) ORDER BY t.name`)
    .bind(JSON.stringify(persons)).all() : { results: [] };
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

const MAX_MENTION_NAMES = 200;
// `@` and up to four words after it (a word may end in `,`, for Teams' `@Last, First`).
const AT_NAME = /(?:^|[^\p{L}\p{N}_@])@([\p{L}][\p{L}\p{N}.'-]*,?(?: [\p{L}][\p{L}\p{N}.'-]*,?){0,3})/gu;

/**
 * The names `@` mentions in these texts may stand for: one to four words after each `@`,
 * without trailing punctuation, and `Last, First` turned round. Markdown code is not told
 * apart: a name that matches nobody costs nothing.
 */
export function mentionCandidates(texts) {
  const out = new Set();
  for (const text of texts) {
    for (const [, run] of String(text || '').matchAll(AT_NAME)) {
      const words = run.split(' ');
      for (let n = 1; n <= words.length; n += 1) {
        const name = words.slice(0, n).join(' ').replace(/[.,'-]+$/, '');
        if (name) {
          out.add(name);
          const swapped = /^([^,]+), (\S+)$/.exec(name);
          if (swapped) {
            out.add(`${swapped[2]} ${swapped[1]}`);
          }
        }
        if (out.size >= MAX_MENTION_NAMES) {
          return [...out];
        }
      }
    }
  }
  return [...out];
}

/**
 * Who the people the texts `@` mention are to us, by the name they go by: `{ [name]:
 * 'adobe'|'partner'|'customer'|'bot' }`. A name is looked up among the platform accounts of
 * the thread's workspace (Slack) or tenant (Teams, Discord) and among people, and among those
 * the thread's messages mention (D1's `mentions`). A name that stands for people of different
 * kinds is left out, as is everything else unknown. Emails stay here.
 *
 * @param {object} env bindings
 * @param {{ source: string, tenant: string, threads: string[] }} where the thread
 * @param {string[]} texts the messages' markdown
 */
export async function mentionKinds(env, { source, tenant, threads }, texts) {
  const names = mentionCandidates(texts);
  if (!names.length) {
    return {};
  }
  const list = JSON.stringify(names);
  const [{ results: accounts }, { results: people }, { results: partnerRows }] = await Promise.all([
    env.DB.prepare(`SELECT i.kind, COALESCE(p.name, i.name) AS name, i.name AS handle,
        COALESCE(p.email, i.email) AS email,
        MAX(COALESCE(p.staff, 0), COALESCE(i.staff, 0)) AS staff
      FROM identities i LEFT JOIN people p ON p.id = i.person
      WHERE i.source = ? AND i.tenant = ? AND i.kind != 'system'
        AND i.name IN (SELECT value FROM json_each(?))`)
      .bind(source, tenant, list).all(),
    env.DB.prepare(`SELECT 'person' AS kind, name, email, staff FROM people
      WHERE name IN (SELECT value FROM json_each(?))
      UNION SELECT 'person', p.name, p.email, p.staff
      FROM mentions n JOIN people p ON p.id = n.person
      WHERE n.thread IN (SELECT value FROM json_each(?))`)
      .bind(list, JSON.stringify(threads || [])).all(),
    env.DB.prepare('SELECT domain, name FROM partner_domains').all(),
  ]);
  const partners = new Map((partnerRows || [])
    .map((r) => [String(r.domain).toLowerCase(), r.name]));
  const kinds = new Map();
  for (const r of [...(accounts || []), ...(people || [])]) {
    const relation = relationOf(env, r, partners);
    // The account's name only where it is not the person's, written differently.
    const handle = r.handle && r.handle.toLowerCase() !== String(r.name).toLowerCase()
      ? r.handle : null;
    for (const name of [r.name, handle].filter(Boolean)) {
      const seen = kinds.get(name);
      kinds.set(name, seen === undefined || seen === relation ? relation : null);
    }
  }
  return Object.fromEntries([...kinds].filter(([, relation]) => relation));
}
