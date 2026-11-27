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

import { json } from './http.js';

/**
 * A customer's people with more than one account (migration 0106). The customers' people are no
 * person of D1, so their accounts are counted by themselves: the customers' overviews
 * (src/orgprofile.js) and the topic map (src/topicmap.js) count the accounts of one mail address
 * as one (a guest account and the one of their own workspace, on Slack Connect; two profiles of an
 * embedded portal account, by the address their provider verified, `identities.merge_email`), and
 * the accounts the admin team says are one person too (`sameAccounts`).
 *
 * What it is asked about (`listAccountPairs`): two accounts outside Adobe, of no person, with the
 * same full name and different mail addresses (the agency's and the customer's, a new job, a
 * second address), both of which posted. Each is a thread of the admin team's inbox
 * (src/requestthreads.js), where it says one person or two people (`decideAccountPair`, `PUT
 * /api/admin/account-pairs`); a name alone does not merge anyone.
 */

const KEY = "i.source || ':' || i.tenant || ':' || i.user_id";
/** Between the two keys of a pair's id: no platform's account id has one. */
const SEP = '|';

const clean = (v, n = 300) => String(v ?? '').trim().slice(0, n);

/** A name as two accounts of one person may write it: without accents, case or punctuation. */
export const nameKey = (s) => String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

/** The id of the pair of accounts `a` and `b`, either way round: `<a>|<b>`, a < b. */
export const pairId = (a, b) => (a < b ? `${a}${SEP}${b}` : `${b}${SEP}${a}`);

/**
 * Who of `accounts` (`[{ key, mail }]`, accounts of no person; one may be listed more than once)
 * is one with whom: the accounts of one mail address, and the pairs of `links` (`[{ a, b }]`, the
 * admin team's "one person", of two of them). Answers a function of an account's key to the key
 * that stands for its person, the least of theirs; an account it was not given stands for itself.
 */
export function sameAccounts(accounts, links = []) {
  const up = new Map();
  const find = (k) => {
    let r = k;
    while (up.get(r) !== r) {
      r = up.get(r);
    }
    return r;
  };
  const join = (a, b) => {
    const [x, y] = [find(a), find(b)];
    if (x !== y) {
      up.set(x < y ? y : x, x < y ? x : y);
    }
  };
  const byMail = new Map();
  for (const { key, mail } of accounts) {
    if (!up.has(key)) {
      up.set(key, key);
    }
    if (mail) {
      if (byMail.has(mail)) {
        join(byMail.get(mail), key);
      } else {
        byMail.set(mail, key);
      }
    }
  }
  for (const { a, b } of links) {
    if (up.has(a) && up.has(b)) {
      join(a, b);
    }
  }
  return (key) => (up.has(key) ? find(key) : key);
}

/** The admin team's "one person": `[{ a, b }]`, for `sameAccounts`. */
export async function sameLinks(env) {
  const { results } = await env.DB.prepare('SELECT a, b FROM account_pairs WHERE same = 1').all();
  return results || [];
}

/**
 * The pairs of accounts that may be one person, and those the admin team said of: `[{ id, a, b,
 * same, decidedBy, decidedAt }]`, `a` and `b` each one side, `{ key, name, source, mails,
 * keys, messages, last, orgs: [{ org, n }] }` (every account of its mail address), and `orgs` the
 * customers both posted for; the undecided ones whose accounts both posted, those sharing a
 * customer first, then the busiest.
 */
export async function listAccountPairs(env) {
  const [{ results: accounts }, { results: decided }] = await Promise.all([
    env.DB.prepare(`SELECT ${KEY} AS key, i.source, COALESCE(i.display_name, i.name) AS name,
        LOWER(COALESCE(i.email, i.merge_email)) AS mail FROM identities i
      WHERE i.kind = 'person' AND i.person IS NULL AND COALESCE(i.staff, 0) = 0`).all(),
    env.DB.prepare('SELECT * FROM account_pairs').all(),
  ]);
  const sameAs = sameAccounts(accounts || []);
  // Each person as the mail addresses say: their accounts, by the key that stands for them.
  const sides = new Map();
  for (const a of accounts || []) {
    const k = sameAs(a.key);
    const s = sides.get(k) || {
      key: k, name: null, source: null, mails: [], keys: [], messages: 0, last: null, orgs: [],
    };
    s.keys.push(a.key);
    if (a.mail && !s.mails.includes(a.mail)) {
      s.mails.push(a.mail);
    }
    if (a.key === k) {
      s.name = a.name || null;
      s.source = a.source;
    }
    sides.set(k, s);
  }
  const byName = new Map();
  for (const s of sides.values()) {
    const n = nameKey(s.name);
    if (n.includes(' ')) {
      byName.set(n, [...(byName.get(n) || []), s]);
    }
  }
  const named = [...byName.values()].filter((l) => l.length > 1);
  const kept = new Map((decided || []).map((r) => [pairId(r.a, r.b), r]));
  const keys = [...new Set([
    ...named.flat().flatMap((s) => s.keys),
    ...[...kept.values()].flatMap((r) => [r.a, r.b]),
  ])];
  const { results: posts } = keys.length ? await env.DB.prepare(`SELECT m.author_key AS key,
      h.org, COUNT(*) AS n, MAX(m.at) AS last
    FROM messages m JOIN threads h ON h.thread = m.thread
    WHERE m.author_key IN (SELECT value FROM json_each(?)) AND m.deleted = 0 AND m.counted = 1
    GROUP BY 1, 2`).bind(JSON.stringify(keys)).all() : { results: [] };
  // An account said of that is somebody's in the inbox since is no side.
  for (const p of (posts || []).filter((x) => sides.has(sameAs(x.key)))) {
    const s = sides.get(sameAs(p.key));
    const o = s.orgs.find((x) => x.org === p.org);
    if (o) {
      o.n += p.n;
    } else {
      s.orgs.push({ org: p.org, n: p.n });
    }
    s.messages += p.n;
    if (!s.last || p.last > s.last) {
      s.last = p.last;
    }
  }
  const pairOf = (x, y, row = null) => {
    const [a, b] = x.key < y.key ? [x, y] : [y, x];
    const theirs = new Set(b.orgs.map((o) => o.org));
    return {
      id: pairId(a.key, b.key),
      a: { ...a, orgs: [...a.orgs].sort((p, q) => q.n - p.n) },
      b: { ...b, orgs: [...b.orgs].sort((p, q) => q.n - p.n) },
      orgs: a.orgs.map((o) => o.org).filter((o) => theirs.has(o)),
      same: row ? Boolean(row.same) : null,
      decidedBy: row ? row.decided_by : null,
      decidedAt: row ? row.decided_at : null,
    };
  };
  const out = new Map();
  for (const l of named) {
    for (let i = 0; i < l.length; i += 1) {
      for (let j = i + 1; j < l.length; j += 1) {
        const id = pairId(l[i].key, l[j].key);
        if (kept.has(id) || (l[i].messages && l[j].messages)) {
          out.set(id, pairOf(l[i], l[j], kept.get(id)));
        }
      }
    }
  }
  // What the admin team said of two accounts that are not such a pair now stays theirs.
  for (const [id, r] of kept) {
    if (!out.has(id) && sides.has(r.a) && sides.has(r.b)) {
      out.set(id, pairOf(sides.get(r.a), sides.get(r.b), r));
    }
  }
  return [...out.values()].sort((x, y) => (x.same !== null) - (y.same !== null)
    || (y.orgs.length > 0) - (x.orgs.length > 0)
    || (y.a.messages + y.b.messages) - (x.a.messages + x.b.messages)
    || x.id.localeCompare(y.id));
}

/** How many pairs wait for the admin team to say. */
export async function undecidedPairCount(env) {
  return (await listAccountPairs(env)).filter((p) => p.same === null).length;
}

/**
 * PUT /api/admin/account-pairs `{ a, b, same }`: the admin team says two accounts outside Adobe
 * are one person (`same: true`) or two people (`false`); `null` takes it back.
 */
export async function decideAccountPair(env, me, body) {
  const [a, b] = [clean(body && body.a), clean(body && body.b)].sort();
  if (!a || !b || a === b || a.includes(SEP) || b.includes(SEP)) {
    return json({ error: 'give two accounts, a and b' }, 400);
  }
  const { results } = await env.DB.prepare(`SELECT ${KEY} AS key FROM identities i
    WHERE ${KEY} IN (?, ?) AND i.kind = 'person' AND i.person IS NULL
      AND COALESCE(i.staff, 0) = 0`).bind(a, b).all();
  if ((results || []).length !== 2) {
    return json({ error: 'both must be accounts outside Adobe, of nobody in the inbox' }, 404);
  }
  if (body.same === null) {
    await env.DB.prepare('DELETE FROM account_pairs WHERE a = ? AND b = ?').bind(a, b).run();
    return json({ ok: true, same: null });
  }
  const same = Boolean(body.same);
  await env.DB.prepare(`INSERT INTO account_pairs (a, b, same, decided_by, decided_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (a, b) DO UPDATE SET same = excluded.same,
      decided_by = excluded.decided_by, decided_at = excluded.decided_at`)
    .bind(a, b, same ? 1 : 0, String(me.email || me.id), new Date().toISOString()).run();
  return json({ ok: true, same });
}
