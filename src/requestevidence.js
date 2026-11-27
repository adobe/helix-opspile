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

import { isAdmin } from './roles.js';
import { maySee, teamsOf } from './shares.js';

/**
 * The evidence behind the admin team's requests (src/requestthreads.js): what a request says in
 * counts ("two of the partner's people posted in five of the customer's threads"), as the threads
 * and the messages it counted, which the admin deciding opens, and who at Adobe worked those
 * threads, who could know (`whoCouldKnow`). A thread the viewer may not see (`seen`, src/shares.js
 * `maySee`) is named only by its customer, its team and its channel: no title, no quote, no link.
 *
 * The same messages, quoted short and without who wrote them, are what Clef is shown beside the
 * signals when it decides a pair (`quoteLines`; src/orgpartners.js, src/orgmerge.js): never part
 * of what its verdict's fingerprint is of, so a new thread does not make it ask again.
 *
 * Everything here reads D1 only: a message is its `messages` row, its text the `preview` the
 * thread list shows (src/threads.js `previewOf`, at most 200 characters), and its link the
 * inbox's (`?t=…&m=…`), with the platform's permalink beside it.
 */

/** Threads each list of a request's evidence shows; the rest are counted. */
export const SHOWN = 5;
/** Adobe people a request names as who could know. */
export const PEOPLE = 3;
/** Messages read for a list, before they are grouped by thread. */
const READ = 300;
/** Of a large org, the latest threads whose messages are searched for a name. */
const SEARCHED_THREADS = 2000;
/** What a quote for Clef keeps of a message, and how many it is shown. */
export const QUOTE = 200;
export const QUOTES = 4;

const PLATFORM = {
  slack: 'Slack', teams: 'Teams', discord: 'Discord', portal: 'Portal',
};

/** `s` as text in markdown: what would be markup is escaped. */
export const md = (s) => String(s ?? '').replace(/[\\`*_[\]<>~|]/g, '\\$&');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayOf = (s) => String(s || '').slice(0, 10);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `text` has `word` as a word of its own (not part of a longer one). */
export const hasWord = (text, word) => new RegExp(`(^|[^a-z0-9])${escapeRe(word)}($|[^a-z0-9])`).test(String(text || '').toLowerCase());

async function rows(env, sql, ...args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

/** A channel's name as people know it: on Teams with its team first. */
export function channelText(r) {
  const name = r.channel_name || r.name || r.channel_id || '';
  return r.source === 'teams' && r.group_name ? `${r.group_name} › ${name}` : `#${name}`;
}

/** Each message with its thread, channel and author, as the lists here read them. */
const MESSAGE = `SELECT m.thread, m.id, m.at, m.preview, m.permalink, m.staff, m.person,
    m.author_key, t.team, t.org, t.source, t.tenant, t.channel_id, t.channel_name,
    COALESCE(l.title, t.title) AS title, c.group_name, COALESCE(p.name, i.name, m.author) AS author,
    LOWER(COALESCE(p.email, i.email)) AS email
  FROM messages m JOIN threads t ON t.thread = m.thread
  LEFT JOIN labels l ON l.thread = t.thread
  LEFT JOIN channels c ON c.source = t.source AND c.tenant = t.tenant AND c.channel_id = t.channel_id
  LEFT JOIN people p ON p.id = m.person
  LEFT JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +m.author_key`;

/** The messages of people who write from `domains` (or a subdomain), in the threads of `orgs`. */
export async function postedFrom(env, { orgs, domains, limit = READ }) {
  if (!orgs.length || !domains.length) {
    return [];
  }
  const list = await rows(env, `WITH a AS (SELECT DISTINCT source || ':' || tenant || ':' || user_id AS k,
        LOWER(SUBSTR(email, INSTR(email, '@') + 1)) AS domain
      FROM identities WHERE email LIKE '%_@_%')
    ${MESSAGE.replace('FROM messages m', 'FROM a JOIN messages m ON m.author_key = a.k')}
    WHERE t.org IN (SELECT value FROM json_each(?1)) AND m.deleted = 0 AND m.counted = 1
      AND m.staff = 0 AND (a.domain IN (SELECT value FROM json_each(?2))
        OR EXISTS (SELECT 1 FROM json_each(?2) d WHERE a.domain LIKE '%.' || d.value))
    ORDER BY m.at DESC LIMIT ?3`, JSON.stringify(orgs), JSON.stringify(domains), limit);
  return list;
}

/** The messages of accounts `keys` (identity keys), anywhere, the latest first. */
export async function postedBy(env, keys, { limit = READ } = {}) {
  if (!keys.length) {
    return [];
  }
  return rows(env, `${MESSAGE} WHERE m.author_key IN (SELECT value FROM json_each(?1))
    AND m.deleted = 0 ORDER BY m.at DESC LIMIT ?2`, JSON.stringify(keys), limit);
}

/** The messages of person `id` (a `people` row), anywhere, the latest first. */
export async function postedByPerson(env, id, { limit = READ } = {}) {
  if (!id) {
    return [];
  }
  return rows(env, `${MESSAGE} WHERE m.person = ?1 AND m.deleted = 0 AND m.counted = 1
    ORDER BY m.at DESC LIMIT ?2`, id, limit);
}

/**
 * The messages in the latest threads of `orgs` whose text names one of `names` (lowercase, each
 * a word of its own there): what a customer's channel says of a partner, or a partner's of a
 * customer. `staff` only Adobe's people's (true), only theirs (false), or anyone's (null).
 */
export async function namedIn(env, {
  orgs, names, staff = null, limit = READ,
}) {
  const words = [...new Set(names.map((x) => String(x || '').toLowerCase().trim()))]
    .filter((x) => x.replace(/[^a-z0-9]/g, '').length >= 4);
  if (!orgs.length || !words.length) {
    return [];
  }
  const like = words.map((_, i) => `m.preview LIKE ?${i + 4}`).join(' OR ');
  const list = await rows(env, `${MESSAGE}
    WHERE m.thread IN (SELECT thread FROM threads WHERE org IN (SELECT value FROM json_each(?1))
        ORDER BY last_at DESC LIMIT ${SEARCHED_THREADS})
      AND m.deleted = 0 AND m.counted = 1 AND (?2 IS NULL OR m.staff = ?2) AND (${like})
    ORDER BY m.at DESC LIMIT ?3`, JSON.stringify(orgs), staff === null ? null : Number(staff), limit, ...words.map((w) => `%${w}%`));
  return list.filter((m) => words.some((w) => hasWord(m.preview, w)));
}

/** The latest threads of a channel (`{ source, channelId }`), each with its latest message. */
export async function channelThreads(env, { source, channelId }, { limit = READ } = {}) {
  return rows(env, `${MESSAGE}
    WHERE m.thread IN (SELECT thread FROM threads WHERE source = ?1 AND channel_id = ?2
        ORDER BY last_at DESC LIMIT ${SHOWN * 4})
      AND m.deleted = 0 AND m.counted = 1
    ORDER BY m.at DESC LIMIT ?3`, source, channelId, limit);
}

/** The latest threads that show technology `tech` (`thread_tech`), each with its root message. */
export async function techThreads(env, tech, { limit = SHOWN * 4 } = {}) {
  return rows(env, `${MESSAGE}
    WHERE m.thread IN (SELECT x.thread FROM thread_tech x JOIN threads y ON y.thread = x.thread
        WHERE x.tech = ?1 ORDER BY y.last_at DESC LIMIT ?2)
      AND m.deleted = 0 AND m.counted = 1
    ORDER BY m.at DESC LIMIT ${READ}`, tech, limit);
}

/** The threads of `orgs` whose facts name one of `values`, with the fact (`fact`). */
export async function factThreads(env, {
  orgs, fields, match, like,
}) {
  if (!orgs.length || !like.length) {
    return [];
  }
  const facts = await rows(env, `SELECT f.thread, f.field, f.value FROM facts f
      JOIN threads t ON t.thread = f.thread
    WHERE t.org IN (SELECT value FROM json_each(?1)) AND f.field IN (SELECT value FROM json_each(?2))
      AND (${like.map((_, i) => `LOWER(f.value) LIKE ?${i + 3}`).join(' OR ')})
    LIMIT ${READ}`, JSON.stringify(orgs), JSON.stringify(fields), ...like.map((x) => `%${x}%`));
  const hits = facts.filter((f) => match(f.field, f.value));
  const by = new Map();
  for (const f of hits) {
    by.set(f.thread, by.get(f.thread) || f);
  }
  if (!by.size) {
    return [];
  }
  const list = await rows(env, `${MESSAGE} WHERE m.thread IN (SELECT value FROM json_each(?1))
    AND m.deleted = 0 AND m.counted = 1 ORDER BY m.at DESC LIMIT ${READ}`, JSON.stringify([...by.keys()]));
  return list.map((m) => ({ ...m, fact: by.get(m.thread) }));
}

/**
 * Messages grouped by thread: `[{ thread: row, message, n }]`, the threads with the most of them
 * first, then those whose message says the most, then the latest. Each thread's message is the
 * one with the most to say (its longest preview); with `latest`, it is the latest, and the latest
 * threads come first.
 */
export function byThread(list, { latest = false } = {}) {
  const by = new Map();
  for (const m of list) {
    const x = by.get(m.thread);
    if (!x) {
      by.set(m.thread, {
        thread: m, message: m, n: 1, at: m.at,
      });
    } else {
      x.n += 1;
      x.at = m.at > x.at ? m.at : x.at;
      const better = latest ? m.at > x.message.at
        : String(m.preview || '').length > String(x.message.preview || '').length;
      if (better) {
        x.message = m;
      }
    }
  }
  const says = (x) => String(x.message.preview || '').length;
  return [...by.values()].sort((a, b) => (latest ? 0 : b.n - a.n || says(b) - says(a))
    || String(b.at).localeCompare(String(a.at)) || a.thread.thread.localeCompare(b.thread.thread));
}

/** A list of the evidence: `{ head, items, more }`, the first SHOWN of `threads` (`byThread`). */
export function threadSection(head, threads, { note = null } = {}) {
  return {
    head,
    items: threads.slice(0, SHOWN).map((x) => ({
      thread: x.thread, message: x.message, n: x.n, note: note ? note(x) : null,
    })),
    more: Math.max(0, threads.length - SHOWN),
    threads: threads.map((x) => x.thread.thread),
  };
}

/**
 * The Adobe people most active in `threads` (keys): `[{ id, name, email, threads, last }]`, at
 * most `most` (one more than PEOPLE, as whoever reads the request is left out there), by how
 * many of them they wrote in, then how recently; `not`, people left out (by id: whoever the
 * request is about).
 */
export async function whoCouldKnow(env, threads, { not = [], most = PEOPLE + 1 } = {}) {
  const keys = [...new Set(threads)].filter(Boolean);
  if (!keys.length) {
    return [];
  }
  const list = await rows(env, `SELECT p.id, p.name, LOWER(p.email) AS email,
      COUNT(DISTINCT m.thread) AS threads, MAX(m.at) AS last
    FROM messages m JOIN people p ON p.id = m.person
    WHERE m.thread IN (SELECT value FROM json_each(?1)) AND m.staff = 1 AND m.counted = 1
      AND m.deleted = 0 AND p.email IS NOT NULL
      AND p.id NOT IN (SELECT value FROM json_each(?2))
    GROUP BY p.id ORDER BY threads DESC, last DESC LIMIT ?3`, JSON.stringify(keys), JSON.stringify(not), most);
  return list.map((r) => ({
    id: r.id, name: r.name || r.email, email: r.email, threads: r.threads, last: r.last,
  }));
}

/** The managers of `teams` (slugs): who could say whether a channel or a person is theirs. */
export async function managersOf(env, teams, { not = [], most = PEOPLE + 1 } = {}) {
  if (!teams.length) {
    return [];
  }
  const list = await rows(env, `SELECT p.id, p.name, LOWER(p.email) AS email, m.team
    FROM team_members m JOIN people p ON p.id = m.person
    WHERE m.team IN (SELECT value FROM json_each(?1)) AND m.role = 'manager' AND p.email IS NOT NULL
      AND p.id NOT IN (SELECT value FROM json_each(?2))
    ORDER BY p.name LIMIT ?3`, JSON.stringify(teams), JSON.stringify(not), most);
  return list.map((r) => ({
    id: r.id, name: r.name || r.email, email: r.email, manages: r.team,
  }));
}

/**
 * Marks each thread of `ev`'s lists that `me` may see (`seen`): the admin team sees them all;
 * anyone else, as `/api/thread` decides (src/shares.js `maySee`). `ev` as it is, marked.
 */
export async function markSeen(env, me, ev) {
  const items = (ev.sections || []).flatMap((s) => s.items).filter((x) => x.thread);
  if (isAdmin(me)) {
    items.forEach((x) => {
      // eslint-disable-next-line no-param-reassign
      x.seen = true;
    });
    return ev;
  }
  const may = maySee(env, me);
  await Promise.all(items.map(async (x) => {
    // eslint-disable-next-line no-param-reassign
    x.seen = Boolean(me) && await may(await teamsOf(env, x.thread), x.thread);
  }));
  return ev;
}

/** The inbox's link to a message: its thread, opened at it, in the team it is filed under. */
export const messageHref = (m) => `/inbox?${new URLSearchParams({ team: m.team, t: m.thread, ...(m.id ? { m: m.id } : {}) })}`;

/** A one-line quote of a message's preview, in markdown. */
const quoted = (s) => `“${md(String(s || '').replace(/\s+/g, ' ').trim())}”`;

/** One item of a list of the evidence, in markdown, as `n` names teams and orgs. */
function itemText(x, n) {
  if (!x.thread) {
    return `- ${x.href ? `[${md(x.text)}](${x.href})` : md(x.text)}${x.note ? `: ${x.note}` : ''}`;
  }
  const t = x.thread;
  const where = `${md(channelText(t))} (${PLATFORM[t.source] || md(t.source)})`;
  if (!x.seen) {
    // Not theirs to read: whose, where and when only.
    return `- A thread of **${md(n.org(t.org))}** in ${md(n.team(t.team))}'s ${where}, ${dayOf(x.message.at)}`;
  }
  const m = x.message;
  const title = t.title ? String(t.title).replace(/\s+/g, ' ').trim().slice(0, 120) : 'A thread';
  const by = m.author ? `${md(m.author)}${m.staff ? ' (Adobe)' : ''}: ` : '';
  const said = m.preview ? ` — ${by}${quoted(m.preview)}` : '';
  const permalink = m.permalink && /^https:\/\//.test(m.permalink) ? ` ([in ${PLATFORM[t.source] || t.source}](${m.permalink}))` : '';
  const count = x.n > 1 ? `, ${plural(x.n, 'message')}` : '';
  return `- [${md(title)}](${messageHref(m)}), ${where}, ${dayOf(m.at)}${count}${x.note ? `, ${x.note}` : ''}${said}${permalink}`;
}

/** Who could know, as a line: each with how many of the threads, and when they last wrote. */
export function peopleText(people, n, { ask = false } = {}) {
  if (!people.length) {
    return '';
  }
  return `**Who could know:** ${people.map((p) => {
    const what = p.manages ? `manages ${md(n.team(p.manages))}`
      : `in ${p.threads === 1 ? 'one' : p.threads} of these threads, last ${dayOf(p.last)}`;
    return `${md(p.name)} (${md(p.email)}, ${what})`;
  }).join('; ')}.${ask ? ' Ask one of them from here: **Ask a colleague**.' : ''}`;
}

/**
 * The evidence as its request's thread shows it, markdown: each list under its head, then who
 * could know. Empty when there is none.
 */
export function evidenceText(ev, n, { ask = false } = {}) {
  if (!ev) {
    return '';
  }
  const lists = (ev.sections || []).filter((s) => s.items.length).map((s) => [
    `**${s.head}**`,
    ...s.items.map((x) => itemText(x, n)),
    ...(s.more ? [`- and ${s.more} more`] : []),
  ].join('\n'));
  const people = peopleText(ev.people || [], n, { ask });
  return [...lists, people].filter(Boolean).join('\n\n');
}

/** People of several lists, each once, the first list's first: at most `most`. */
export function together(lists, most = PEOPLE + 1) {
  const out = [];
  for (const p of lists.flat()) {
    if (!out.some((x) => x.id === p.id) && out.length < most) {
      out.push(p);
    }
  }
  return out;
}

/** The threads of `ev`'s lists, for `whoCouldKnow`. */
export const threadsOf = (ev) => (ev.sections || []).flatMap((s) => s.threads || []);

/**
 * Messages as Clef is shown them: `[{ where, who, text }]` (`where` and `who` in Clef's letters:
 * "C's thread", "one of P's people"), at most QUOTES, one a thread, each at most QUOTE
 * characters; no names of people.
 */
export function quoteLines(groups) {
  const out = [];
  const seenThreads = new Set();
  // One of each group first, then the second of each, so every kind of evidence is quoted.
  const lists = groups.map((g) => ({ ...g, list: byThread(g.messages) }));
  for (let round = 0; out.length < QUOTES && lists.some((g) => g.list.length > round); round += 1) {
    for (const g of lists) {
      const x = g.list[round];
      if (x && out.length < QUOTES && !seenThreads.has(x.thread.thread) && x.message.preview) {
        seenThreads.add(x.thread.thread);
        const text = String(x.message.preview).replace(/\s+/g, ' ').trim().slice(0, QUOTE);
        out.push(`In ${g.where} (${channelText(x.thread)}), ${g.who(x.message)} wrote: "${text}"`);
      }
    }
  }
  return out;
}

/**
 * What Clef is shown: `state`, the signals (what its verdict's fingerprint is of), and then the
 * quotes (`quoteLines`), which are not: a new thread changes them, and is no reason to ask again.
 */
export function withQuotes(state, quotes) {
  return quotes.length
    ? `${state}\nWhat their messages say, quoted short (who wrote them left out):\n${quotes.map((q) => `- ${q}`).join('\n')}`
    : state;
}
