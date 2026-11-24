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

/**
 * Adobe's accounts that no mail address names a person for, and whose they are (migration 0097):
 * the Teams tenant that hosts the teams has admin accounts of its own (src/lookup.js,
 * `isHostAdmin`), one for each of a few Adobe people, named by their initials and mailed at the
 * tenant's own domain. They count as staff by themselves (`identities.staff`), but who uses one is
 * hard to tell from the outside, so the admin team says it, in the account's thread in its inbox
 * (src/requestthreads.js): the account is linked to that Adobe person (`identities.person`, with
 * `linked_by` and `linked_at`), and shows as them, with their name, the messages it wrote before
 * too (`relabelAccount`). Looking the account up again keeps the link.
 *
 * Only an account that is staff by itself is linked, and only to a staff person: a customer's
 * account is never made Adobe's here, nor an Adobe account a customer's.
 */

import { json } from './http.js';
import { isStaffDomain, relabelAccount, toAuthor } from './lookup.js';

const KEY = "i.source || ':' || i.tenant || ':' || i.user_id";

/** `[source, tenant, userId]` of an identity key; a user id may have colons of its own. */
const splitKey = (key) => {
  const [source, tenant, ...rest] = String(key || '').split(':');
  return [source, tenant, rest.join(':')];
};

const SELECT = `SELECT i.source, i.tenant, i.user_id, i.name, i.email, i.avatar, i.staff,
    i.person, i.linked_by, i.linked_at, p.name AS person_name, p.email AS person_email,
    p.staff AS person_staff,
    (SELECT COUNT(*) FROM messages m WHERE m.author_key = ${KEY} AND m.deleted = 0) AS messages,
    (SELECT MAX(m.at) FROM messages m WHERE m.author_key = ${KEY}) AS latest
  FROM identities i LEFT JOIN people p ON p.id = i.person
  WHERE i.kind = 'person' AND i.staff = 1 AND (i.person IS NULL OR i.linked_at IS NOT NULL)`;

/** An account as the admin page shows it. */
function accountOf(r) {
  return {
    key: `${r.source}:${r.tenant}:${r.user_id}`,
    source: r.source,
    id: r.user_id,
    // The platform's name (the initials) and mail address (the tenant's own).
    name: r.name || null,
    email: r.email || null,
    avatar: r.avatar || null,
    // Whose it is, by the admin team's say: null while nobody said.
    person: r.person
      ? { id: r.person, name: r.person_name || null, email: r.person_email || null } : null,
    linkedBy: r.linked_by || null,
    linkedAt: r.linked_at || null,
    messages: r.messages || 0,
    latest: r.latest || null,
  };
}

/**
 * GET /api/admin/accounts: the host tenant's admin accounts (Teams accounts that are staff by
 * themselves), those nobody said whose they are first, then by their latest message.
 */
export async function listAccounts(env) {
  const { results } = await env.DB.prepare(`${SELECT} AND i.source = 'teams'`).all();
  const accounts = (results || []).map(accountOf);
  accounts.sort((a, b) => Number(Boolean(a.person)) - Number(Boolean(b.person))
    || String(b.latest || '').localeCompare(String(a.latest || ''))
    || String(a.name || a.id).localeCompare(String(b.name || b.id)));
  return json({ accounts });
}

/**
 * PUT /api/admin/accounts `{ key, email }`: account `key` is the Adobe person's with mail address
 * `email` (a staff person, or one of STAFF_DOMAINS, who gets a `people` row then); `email` null
 * takes the link back. Its messages follow at once (`relabelAccount`): their person, and their
 * author's name, the person's (with the link taken back, the account's own again).
 */
export async function linkAccount(env, me, body) {
  const [source, tenant, userId] = splitKey(body.key);
  if (!source || !tenant || !userId) {
    return json({ error: 'give the account\'s key' }, 400);
  }
  const email = body.email === null ? null : String(body.email || '').trim().toLowerCase();
  if (email !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'give the mail address of the Adobe person whose account it is, or null' }, 400);
  }
  const where = 'i.source = ? AND i.tenant = ? AND i.user_id = ?';
  const row = await env.DB.prepare(`SELECT i.*, p.staff AS person_staff, p.name AS person_name
    FROM identities i LEFT JOIN people p ON p.id = i.person WHERE ${where}`)
    .bind(source, tenant, userId).first();
  if (!row || row.kind !== 'person') {
    return json({ error: 'no such account' }, 404);
  }
  if (!row.staff) {
    return json({ error: 'only an account that is Adobe\'s by itself is linked to an Adobe person' }, 409);
  }
  if (row.person && !row.linked_at) {
    return json({ error: 'its mail address links it to a person already' }, 409);
  }
  let person = null;
  if (email) {
    person = await env.DB.prepare('SELECT id, name, email, staff FROM people WHERE email = ?')
      .bind(email).first();
    if (!(person && person.staff) && !isStaffDomain(env, email)) {
      return json({ error: 'not an Adobe person: give the mail address of a colleague' }, 409);
    }
    if (!person || !person.staff) {
      // Staff by their mail domain, not seen yet: their row, named after an account of theirs.
      const account = await env.DB.prepare(`SELECT name FROM identities WHERE email = ?
        AND kind = 'person' AND name IS NOT NULL LIMIT 1`).bind(email).first();
      await env.DB.prepare(`INSERT INTO people (email, name, staff) VALUES (?, ?, 1)
        ON CONFLICT (email) DO UPDATE SET staff = 1`).bind(email, account ? account.name : null).run();
      person = await env.DB.prepare('SELECT id, name, email, staff FROM people WHERE email = ?')
        .bind(email).first();
    }
  }
  await env.DB.prepare(`UPDATE identities SET person = ?, linked_by = ?, linked_at = ?
    WHERE source = ? AND tenant = ? AND user_id = ?`).bind(
    person ? person.id : null,
    person ? me.email || String(me.id) : null,
    person ? new Date().toISOString() : null,
    source,
    tenant,
    userId,
  ).run();
  const author = toAuthor(env, {
    ...row, person: person ? person.id : null, person_staff: person ? person.staff : null,
  });
  const name = (person && person.name) || row.name || null;
  const moved = await relabelAccount(env, body.key, {
    person: person ? person.id : null, staff: author.staff, name,
  });
  console.log(JSON.stringify({
    route: 'admin', account: person ? 'linked' : 'unlinked', by: me.id, messages: moved,
  }));
  const after = await env.DB.prepare(`${SELECT} AND ${where}`).bind(source, tenant, userId).first();
  return json({ ok: true, account: accountOf(after), messages: moved });
}
