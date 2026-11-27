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
 * accounts that are staff by themselves (`identities.staff`) on a platform that says nothing of
 * who uses one. They are
 *
 * - the Teams tenant that hosts the teams' admin accounts of its own (src/lookup.js,
 *   `isHostAdmin`), one for each of a few Adobe people, named by their initials and mailed at the
 *   tenant's own domain;
 * - a Discord account with one of the DISCORD_STAFF_ROLES that its person did not connect in the
 *   inbox (src/post.js, `linkDiscord`): Discord shares no mail address, so the inbox knows it only
 *   by its handle (often initials). Only those that wrote a message wait to be linked.
 *
 * Who uses one is hard to tell from the outside, so the admin team says it, in the account's thread
 * in its inbox (src/requestthreads.js): the account is linked to that Adobe person
 * (`identities.person`, with `linked_by` and `linked_at`), and shows as them, with their name, the
 * messages it wrote before too (`relabelAccount`), so the work counts towards their profile, their
 * expertise and the expert finder. Looking the account up again keeps the link. A Discord account
 * is one user in every guild the inbox reads: the link is of every row of it that is staff by
 * itself.
 *
 * The thread offers candidates (`linkCandidates`: a staff person whose name the handle is the
 * initials of, or who has the account's name, or whose Contact in a knowledge base names it among
 * its `aliases`), and what a thread agent proposed (`proposeAccountLink`, migration 0116), each a
 * one-click action: a suggestion or a proposal never links by itself. Nothing here is inferred from
 * a mail address or a merge key: the link is the admin team's say.
 *
 * Only an account that is staff by itself is linked, and only to a staff person: a customer's
 * account is never made Adobe's here, nor an Adobe account a customer's.
 */

import { json } from './http.js';
import { isStaffDomain, relabelAccount, toAuthor } from './lookup.js';
import { announceRequest, requestKey } from './requestkeys.js';
import { personSlug } from './agent/okf.js';

/** The platforms whose accounts can be staff by themselves, with no mail address saying whose. */
export const SOURCES = ['teams', 'discord'];

const KEY = "i.source || ':' || i.tenant || ':' || i.user_id";
const IN_SOURCES = `i.source IN (${SOURCES.map((s) => `'${s}'`).join(', ')})`;
/** An account that wrote something: a Discord one waits to be linked only then. */
const WROTE = `(i.source != 'discord' OR EXISTS (SELECT 1 FROM messages m
  WHERE m.author_key = ${KEY} AND m.deleted = 0))`;
/** Staff by itself and nobody's: waits for the admin team. */
const OPEN = `i.kind = 'person' AND ${IN_SOURCES} AND i.staff = 1 AND i.person IS NULL AND ${WROTE}`;

/** `s` as text in markdown: what would be markup is escaped. */
const md = (s) => String(s ?? '').replace(/[\\`*_[\]<>~|]/g, '\\$&');

/** How many candidates an account's thread offers, besides what agents proposed. */
const MAX_CANDIDATES = 3;
/** How long an agent's note may be. */
const MAX_NOTE = 1000;

/** `[source, tenant, userId]` of an identity key; a user id may have colons of its own. */
const splitKey = (key) => {
  const [source, tenant, ...rest] = String(key || '').split(':');
  return [source, tenant, rest.join(':')];
};

const SELECT = `SELECT i.source, i.tenant, i.user_id, i.name, i.handle, i.aliases, i.email,
    i.avatar, i.staff, i.person, i.linked_by, i.linked_at, p.name AS person_name,
    p.email AS person_email, p.staff AS person_staff,
    (SELECT COUNT(*) FROM messages m WHERE m.author_key = ${KEY} AND m.deleted = 0) AS messages,
    (SELECT MAX(m.at) FROM messages m WHERE m.author_key = ${KEY}) AS latest
  FROM identities i LEFT JOIN people p ON p.id = i.person
  WHERE ((${OPEN}) OR (i.kind = 'person' AND ${IN_SOURCES} AND i.person IS NOT NULL
    AND i.linked_at IS NOT NULL AND ${WROTE}))`;

const parseList = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
};

/** An account as the admin page shows it. */
function accountOf(r) {
  return {
    key: `${r.source}:${r.tenant}:${r.user_id}`,
    source: r.source,
    tenant: r.tenant,
    id: r.user_id,
    // The platform's name (the initials, a Discord nickname) and mail address (the tenant's own;
    // none on Discord), and the other names it goes by (a Discord user name and display name).
    name: r.name || null,
    handle: r.handle || null,
    aliases: parseList(r.aliases),
    email: r.email || null,
    avatar: r.avatar || null,
    // Whose it is, by the admin team's say: null while nobody said.
    person: r.person
      ? { id: r.person, name: r.person_name || null, email: r.person_email || null } : null,
    linkedBy: r.linked_by || null,
    linkedAt: r.linked_at || null,
    messages: r.messages || 0,
    latest: r.latest || null,
    proposals: [],
  };
}

/** A proposal as the account's thread offers it. */
const proposalOf = (r) => ({
  person: { id: r.person, name: r.name || null, email: r.email || null },
  note: r.note,
  thread: r.thread || null,
  by: r.by_email ? { email: r.by_email, name: r.by_name || null } : { agent: true, name: r.by_name || 'An agent' },
  at: r.at,
});

/**
 * The accounts that are staff by themselves and that no mail address links (those nobody said
 * whose they are first, then by their latest message), with what agents proposed of each.
 */
export async function loadAccounts(env) {
  const [{ results }, { results: proposed }] = await Promise.all([
    env.DB.prepare(SELECT).all(),
    env.DB.prepare(`SELECT a.account, a.person, a.note, a.thread, a.by_email, a.by_name, a.at,
        p.name, p.email FROM account_proposals a JOIN people p ON p.id = a.person
      WHERE a.declined_at IS NULL ORDER BY a.at, a.person`).all(),
  ]);
  const accounts = (results || []).map(accountOf);
  const byKey = new Map(accounts.map((a) => [a.key, a]));
  for (const r of proposed || []) {
    const a = byKey.get(r.account);
    if (a && !a.person) {
      a.proposals.push(proposalOf(r));
    }
  }
  accounts.sort((a, b) => Number(Boolean(a.person)) - Number(Boolean(b.person))
    || String(b.latest || '').localeCompare(String(a.latest || ''))
    || String(a.name || a.id).localeCompare(String(b.name || b.id)));
  return accounts;
}

/**
 * GET /api/admin/accounts: the accounts that are staff by themselves (the host tenant's admin
 * accounts, Discord accounts with a staff role) and that no mail address links.
 */
export async function listAccounts(env) {
  return json({ accounts: await loadAccounts(env) });
}

/**
 * How many accounts that are staff by themselves nobody said whose they are: each is a request,
 * an open thread of the admin team's inbox (src/requestthreads.js), counted on Inbox.
 */
export async function unlinkedCount(env) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM identities i WHERE ${OPEN}`).first();
  return r ? r.n : 0;
}

// ---- candidates --------------------------------------------------------------------------------

/** The names account `a` goes by: its platform's, its handle, and its aliases. */
const namesOf = (a) => [...new Set([a.name, a.handle, ...(a.aliases || [])]
  .filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim()))];

/**
 * The initials a name is, lower case, or null: two to four letters, each alone or with a dot
 * (`AB`, `a.b.`, `abc`), not a word of its own (`Ann`, `Bob`).
 */
export function initialsOf(name) {
  const s = String(name || '').trim();
  if (!/^(?:[A-Za-z][._\s-]?){2,4}$/.test(s) || /^[A-Z][a-z]{2,}$/.test(s)) {
    return null;
  }
  return s.replace(/[^A-Za-z]/g, '').toLowerCase();
}

/** Whether `initials` are those of the person named `name`: every word's, or first and last. */
export function hasInitials(name, initials) {
  const words = personSlug(name).split('-').filter(Boolean);
  if (words.length < 2 || !initials) {
    return false;
  }
  const all = words.map((w) => w[0]).join('');
  return all === initials || (words.length > 2 && `${words[0][0]}${words.at(-1)[0]}` === initials);
}

/**
 * The staff people account `a` may be, best first, at most `max`: `[{ person: { id, name, email },
 * why: [{ kind: 'contact' | 'name' | 'initials', ... }] }]`. A person whose Contact in a knowledge
 * base names the account among its `aliases` (`kb_concepts`, src/kbindex.js; the Contact is found
 * by its file name or title, as src/kbpeople.js finds people), who has its name, or whose name it
 * is the initials of. Never a customer (`people.staff`), never its person now, never one the admin
 * team said it is not (a declined proposal) or an agent proposed already. A suggestion links
 * nothing.
 */
export async function linkCandidates(env, a, max = MAX_CANDIDATES) {
  const names = namesOf(a);
  if (!names.length) {
    return [];
  }
  const slugs = new Set(names.map(personSlug).filter(Boolean));
  const initials = [...new Set(names.map(initialsOf).filter(Boolean))];
  // A Contact's aliases are kept comma-separated (src/kbindex.js): one of them, exactly.
  const lower = [...new Set([...names.map((n) => n.toLowerCase()), ...slugs])];
  const [{ results: people }, { results: contacts }, { results: left }] = await Promise.all([
    env.DB.prepare(`SELECT id, name, email FROM people WHERE staff = 1 AND name IS NOT NULL
      AND email IS NOT NULL`).all(),
    env.DB.prepare(`SELECT c.repo, c.path, c.title, c.aliases,
        COALESCE(t.name, o.name, c.repo) AS kb
      FROM kb_concepts c LEFT JOIN knowledge_bases k ON k.repo = c.repo
        LEFT JOIN teams t ON k.kind = 'team' AND t.slug = k.slug
        LEFT JOIN orgs o ON k.kind = 'org' AND o.slug = k.slug
      WHERE LOWER(c.type) = 'contact' AND c.aliases IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(?) n WHERE instr(
          ',' || REPLACE(LOWER(c.aliases), ', ', ',') || ',', ',' || n.value || ',') > 0)
      ORDER BY c.repo, c.path LIMIT 200`).bind(JSON.stringify(lower)).all(),
    env.DB.prepare('SELECT person FROM account_proposals WHERE account = ?').bind(a.key).all(),
  ]);
  const skip = new Set([...(left || []).map((r) => r.person), a.person && a.person.id]);
  const staff = (people || []).filter((p) => !skip.has(p.id));
  const bySlug = new Map();
  for (const p of staff) {
    const s = personSlug(p.name);
    if (s) {
      bySlug.set(s, [...(bySlug.get(s) || []), p]);
    }
  }
  const found = new Map();
  const add = (p, why) => {
    const hit = found.get(p.id) || { person: { id: p.id, name: p.name, email: p.email }, why: [] };
    if (!hit.why.some((w) => w.kind === why.kind)) {
      hit.why.push(why);
    }
    found.set(p.id, hit);
  };
  for (const c of contacts || []) {
    const alias = String(c.aliases).split(',').map((x) => x.trim())
      .find((x) => slugs.has(personSlug(x)));
    if (alias) {
      const file = c.path.split('/').pop().replace(/\.md$/i, '');
      const whose = new Set([file, c.title].map(personSlug).filter(Boolean));
      for (const p of [...whose].flatMap((s) => bySlug.get(s) || [])) {
        add(p, {
          kind: 'contact', kb: c.kb, path: c.path, alias,
        });
      }
    }
  }
  for (const s of slugs) {
    for (const p of bySlug.get(s) || []) {
      add(p, { kind: 'name' });
    }
  }
  for (const p of initials.length ? staff : []) {
    const i = initials.find((x) => hasInitials(p.name, x));
    if (i) {
      add(p, { kind: 'initials', initials: i.toUpperCase() });
    }
  }
  const WEIGHT = { contact: 4, name: 2, initials: 1 };
  const score = (c) => c.why.reduce((n, w) => n + WEIGHT[w.kind], 0);
  return [...found.values()]
    .sort((x, y) => score(y) - score(x)
      || String(x.person.name).localeCompare(String(y.person.name)))
    .slice(0, max);
}

// ---- linking -----------------------------------------------------------------------------------

/**
 * The staff person with mail address `email`, or `{ error }`: one marked staff, or one of
 * STAFF_DOMAINS, who gets a `people` row then when `create` (named after an account of theirs).
 */
async function staffPerson(env, email, { create = false } = {}) {
  let person = await env.DB.prepare('SELECT id, name, email, staff FROM people WHERE email = ?')
    .bind(email).first();
  if (!(person && person.staff) && !isStaffDomain(env, email)) {
    return { error: 'not an Adobe person: give the mail address of a colleague' };
  }
  if (person && person.staff) {
    return { person };
  }
  if (!create) {
    return { error: 'the inbox knows no colleague with that mail address yet' };
  }
  // Staff by their mail domain, not seen yet: their row, named after an account of theirs.
  const account = await env.DB.prepare(`SELECT name FROM identities WHERE email = ?
    AND kind = 'person' AND name IS NOT NULL LIMIT 1`).bind(email).first();
  await env.DB.prepare(`INSERT INTO people (email, name, staff) VALUES (?, ?, 1)
    ON CONFLICT (email) DO UPDATE SET staff = 1`).bind(email, account ? account.name : null).run();
  person = await env.DB.prepare('SELECT id, name, email, staff FROM people WHERE email = ?')
    .bind(email).first();
  return { person };
}

const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROW = `SELECT i.*, p.staff AS person_staff, p.name AS person_name
  FROM identities i LEFT JOIN people p ON p.id = i.person`;

/**
 * The rows a link of account `row` is of: the account itself, and on Discord the same user in the
 * other guilds the inbox reads, where that is staff by itself too and nobody connected it.
 */
async function rowsOf(env, row) {
  if (row.source !== 'discord') {
    return [row];
  }
  const { results } = await env.DB.prepare(`${ROW} WHERE i.source = 'discord' AND i.user_id = ?
      AND i.kind = 'person' AND (i.tenant = ? OR (i.staff = 1 AND i.person IS NULL)
        OR i.linked_at IS NOT NULL)
    ORDER BY i.tenant`).bind(row.user_id, row.tenant).all();
  return (results || []).length ? results : [row];
}

/**
 * PUT /api/admin/accounts `{ key, email }`: account `key` is the Adobe person's with mail address
 * `email` (a staff person, or one of STAFF_DOMAINS, who gets a `people` row then); `email` null
 * takes the link back. Its messages follow at once (`relabelAccount`): their person, and their
 * author's name, the person's (with the link taken back, the account's own again). Linked, the
 * account's open proposals are gone (what was decided is in its thread's log).
 */
export async function linkAccount(env, me, body) {
  const [source, tenant, userId] = splitKey(body.key);
  if (!source || !tenant || !userId) {
    return json({ error: 'give the account\'s key' }, 400);
  }
  const email = body.email === null ? null : String(body.email || '').trim().toLowerCase();
  if (email !== null && !ADDRESS.test(email)) {
    return json({ error: 'give the mail address of the Adobe person whose account it is, or null' }, 400);
  }
  const where = 'i.source = ? AND i.tenant = ? AND i.user_id = ?';
  const row = await env.DB.prepare(`${ROW} WHERE ${where}`).bind(source, tenant, userId).first();
  if (!row || row.kind !== 'person' || !SOURCES.includes(source)) {
    return json({ error: 'no such account' }, 404);
  }
  if (!row.staff && !(email === null && row.linked_at)) {
    return json({ error: 'only an account that is Adobe\'s by itself is linked to an Adobe person' }, 409);
  }
  if (row.person && !row.linked_at) {
    return json({
      error: source === 'discord' ? 'its person connected it to the inbox already'
        : 'its mail address links it to a person already',
    }, 409);
  }
  let person = null;
  if (email) {
    const found = await staffPerson(env, email, { create: true });
    if (found.error) {
      return json({ error: found.error }, 409);
    }
    ({ person } = found);
  }
  const rows = await rowsOf(env, row);
  const at = new Date().toISOString();
  await env.DB.batch(rows.map((r) => env.DB.prepare(`UPDATE identities
      SET person = ?, linked_by = ?, linked_at = ? WHERE source = ? AND tenant = ? AND user_id = ?`)
    .bind(
      person ? person.id : null,
      person ? me.email || String(me.id) : null,
      person ? at : null,
      r.source,
      r.tenant,
      r.user_id,
    )));
  let moved = 0;
  for (const r of rows) {
    const author = toAuthor(env, {
      ...r, person: person ? person.id : null, person_staff: person ? person.staff : null,
    });
    // eslint-disable-next-line no-await-in-loop
    moved += await relabelAccount(env, `${r.source}:${r.tenant}:${r.user_id}`, {
      person: person ? person.id : null,
      staff: author.staff,
      name: (person && person.name) || r.name || null,
    });
  }
  if (person) {
    // Decided: what agents proposed of it is answered (a declined one stays, said once).
    await env.DB.prepare(`DELETE FROM account_proposals WHERE declined_at IS NULL
      AND account IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(rows.map((r) => `${r.source}:${r.tenant}:${r.user_id}`))).run();
  }
  console.log(JSON.stringify({
    route: 'admin', account: person ? 'linked' : 'unlinked', source, by: me.id, rows: rows.length, messages: moved,
  }));
  const after = await env.DB.prepare(`${SELECT} AND ${where}`).bind(source, tenant, userId).first();
  return json({ ok: true, account: after ? accountOf(after) : null, messages: moved });
}

/**
 * POST /api/admin/accounts/decline `{ key, person }`: the account is not person `person`'s, as an
 * agent proposed: the proposal is kept as declined, so neither it nor the suggestions name them
 * for the account again.
 */
export async function declineProposal(env, me, body) {
  const key = String((body && body.key) || '');
  const person = Number(body && body.person);
  const { meta } = await env.DB.prepare(`UPDATE account_proposals SET declined_at = ?,
      declined_by = ? WHERE account = ? AND person = ? AND declined_at IS NULL`)
    .bind(new Date().toISOString(), me.email || String(me.id), key, person).run();
  if (!meta || !meta.changes) {
    return json({ error: 'no such proposal: it may be decided already' }, 404);
  }
  const p = await env.DB.prepare('SELECT id, name, email FROM people WHERE id = ?').bind(person).first();
  console.log(JSON.stringify({ route: 'admin', account: 'declined', by: me.id }));
  return json({ ok: true, person: p || { id: person } });
}

// ---- an agent's proposal -----------------------------------------------------------------------

/**
 * The accounts of platform `source` (and `tenant`, but on Discord, whose users are one in every
 * guild) that wait to be linked and go by `name` (their name, handle or an alias, as personSlug
 * compares them), those that wrote in `thread` first.
 */
async function waitingByName(env, { source, tenant, thread }, name) {
  const slug = personSlug(name);
  if (!slug) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT i.source, i.tenant, i.user_id, i.name,
      i.handle, i.aliases,
      EXISTS (SELECT 1 FROM messages m WHERE m.author_key = ${KEY} AND m.thread = ?3) AS here
    FROM identities i WHERE ${OPEN} AND i.source = ?1 AND (i.source = 'discord' OR i.tenant = ?2)`)
    .bind(source, tenant, thread || '').all();
  const hits = (results || []).filter((r) => namesOf({
    name: r.name, handle: r.handle, aliases: parseList(r.aliases),
  }).some((n) => personSlug(n) === slug));
  const here = hits.filter((r) => r.here);
  return here.length ? here : hits;
}

/**
 * A thread agent's proposal (`request_account_link`, src/agent/accountlink.js) that the account
 * that goes by `account` in its thread `t` is the colleague with mail address `email`: kept for the
 * admin team to confirm or decline in the account's thread, with `note` and who asked (`by`:
 * `{ email, name }` of the person in its sidebar, or `{ agent: true, name }`). It links nothing.
 * `{ proposal, account }`, or `{ error }`.
 */
export async function proposeAccountLink(env, t, by, { account, email, note }) {
  const [source, tenant] = String(t.key || '').split(':');
  const name = String(account || '').trim();
  if (!SOURCES.includes(source)) {
    return { error: 'only an account of Teams or Discord that is Adobe\'s by itself can be linked to a colleague here' };
  }
  if (!name) {
    return { error: 'give the account\'s name as your thread shows it' };
  }
  const mail = String(email || '').trim().toLowerCase();
  if (!ADDRESS.test(mail)) {
    return { error: 'give the mail address of the colleague whose account it is' };
  }
  const text = String(note || '').trim().slice(0, MAX_NOTE);
  if (!text) {
    return { error: 'say why in `note`: who said so, where, or which knowledge-base Contact names it' };
  }
  const found = await waitingByName(env, { source, tenant, thread: t.key }, name);
  if (!found.length) {
    const any = await env.DB.prepare(`SELECT p.name FROM identities i JOIN people p ON p.id = i.person
      WHERE i.source = ? AND i.kind = 'person' AND (LOWER(i.name) = LOWER(?2) OR LOWER(i.handle) = LOWER(?2))
      LIMIT 1`).bind(source, name).first();
    return {
      error: any ? `${name} is ${any.name || 'a colleague'}'s already`
        : `no account called ${name} waits to be linked: only one that is Adobe's by itself (a staff role on Discord, the Teams tenant's admin accounts), and that nobody linked or connected`,
    };
  }
  if (found.length > 1) {
    return { error: `several accounts go by ${name}: give the name the thread shows for the one meant` };
  }
  const a = found[0];
  const key = `${a.source}:${a.tenant}:${a.user_id}`;
  const who = await staffPerson(env, mail);
  if (who.error) {
    return { error: `${mail}: ${who.error}` };
  }
  const { person } = who;
  const was = await env.DB.prepare(`SELECT declined_at FROM account_proposals
    WHERE account = ? AND person = ?`).bind(key, person.id).first();
  if (was) {
    return {
      error: was.declined_at ? `the admin team said ${name} is not ${person.name || mail}'s`
        : `${name} is proposed as ${person.name || mail}'s already: the admin team decides`,
    };
  }
  const at = new Date().toISOString();
  const byEmail = by && by.email ? String(by.email).toLowerCase() : null;
  const byName = (by && by.name) || null;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO account_proposals (account, person, note, thread, by_email, by_name, at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(key, person.id, text, t.key || null, byEmail, byName, at),
    // In the account's thread, as who asked said it.
    env.DB.prepare(`INSERT INTO request_log (request, type, body, person, author_name, author_email, at)
      VALUES (?, 'note', ?, NULL, ?, ?, ?)`).bind(
      requestKey('account', key),
      `Proposes that it is **${md(person.name || mail)}**'s (${md(mail)}): ${md(text)}${t.key ? `\n\nFrom [a thread](/inbox?team=${encodeURIComponent(t.team || 'admin')}&t=${encodeURIComponent(t.key)}).` : ''}`,
      byEmail ? `${byName || byEmail}, by the agent` : byName || 'An agent',
      byEmail,
      at,
    ),
  ]);
  await announceRequest(env, 'account', key);
  return {
    account: { key, name: a.name || a.handle || name, source: a.source },
    proposal: { person: { id: person.id, name: person.name || null, email: person.email }, at },
  };
}
