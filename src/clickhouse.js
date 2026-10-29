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

import { fileRef } from './agent/files.js';
import { threadMessages } from './label.js';
import { withoutQuotes } from './markdown.js';
import { relationOf } from './profiles.js';
import {
  mergeFacts, resolution, resolutionFacts, signalFacts,
} from './resolve.js';
import { effectiveLabel, reviewsFor } from './review.js';
import { waitingOn } from './threads.js';

/**
 * The klickhaus export: one row per message, metadata and Clef's classification but no text,
 * in ClickHouse (`<CLICKHOUSE_DATABASE>.opspile_messages_raw`, a ReplacingMergeTree keyed by
 * `(timestamp, thread, message_id)` with `_version` and `_deleted`), for klickhaus' opspile view.
 *
 * A thread is exported whole: every message, a deleted one as a tombstone (`_deleted = 1`,
 * the same key), and every message of a thread re-filed as `ignore` too. The label, the
 * title, whether it is resolved and the facts are the inbox entry's (a re-threaded group's, as
 * the inbox shows the group), so exporting a thread exports its whole group.
 *
 * `threads.exported_through` is the thread row's `updated_at` the export read (it changes
 * with every message written, edits and deletions too) and `threads.exported_at` when the
 * export started. The sweep exports what changed since: new messages, labels, reviews and
 * re-threading; a re-file clears the watermark. A failed insert leaves it alone.
 *
 * Off unless CLICKHOUSE_URL, CLICKHOUSE_DATABASE, CLICKHOUSE_USER and CLICKHOUSE_PASSWORD are set.
 */

/** After a message, the export waits for the label job (LABEL_DELAY_SECONDS) to be done. */
export const EXPORT_DELAY_SECONDS = 180;
/** Threads the cron sweep enqueues per run (the backfill too), and per job. */
export const SWEEP = 1500;
export const SWEEP_JOB = 25;
/** A group with more members exports only the threads asked for (and its first). */
export const MAX_GROUP = 100;
/** Rows per INSERT. */
const MAX_ROWS = 5000;
const SETTLE_MS = 5 * 60 * 1000;

const URGENCY = ['low', 'normal', 'high', 'critical'];
const FACTS = {
  facts_tickets: ['ticket'],
  facts_sites: ['site'],
  facts_cves: ['cve'],
  facts_urls: ['url', 'affected_url'],
  facts_problems: ['problem'],
};

export const exportEnabled = (env) => Boolean(env.CLICKHOUSE_URL && env.CLICKHOUSE_DATABASE
  && env.CLICKHOUSE_USER && env.CLICKHOUSE_PASSWORD && env.DB);

const list = (xs) => JSON.stringify([...new Set(xs)]);
const domainOf = (email) => (email && email.includes('@') ? email.split('@').pop().toLowerCase() : '');
const iso = (at) => {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const by = (rows, key) => {
  const m = new Map();
  for (const r of rows || []) {
    m.set(r[key], [...(m.get(r[key]) || []), r]);
  }
  return m;
};

// Slack Connect files the app could not look up (src/normalize.js) are listed by kind.
const UNSEEN_FILE = /\(shared from another workspace; opspile cannot see it\)/g;
const LINK = /\[(?:\\.|[^\]\\])*\]\((https:\/\/[^)\s]+)/g;

/** How many files a message body has (links to platform files; quoted messages' not). */
export function attachmentsOf(body) {
  const text = withoutQuotes(String(body || ''));
  const files = new Set();
  for (const [, url] of text.matchAll(LINK)) {
    const ref = fileRef(url);
    if (ref) {
      files.add(ref.id);
    }
  }
  return files.size + (text.match(UNSEEN_FILE) || []).length;
}

/** `low`, `normal`, `high` or `critical`, as the inbox buckets Clef's urgency (none is low). */
export const urgencyLevel = (urgency) => (urgency == null ? 'low'
  : URGENCY[Math.max(0, Math.min(3, Math.round(urgency)))]);

/** The author kind of a message pile 2 does not say: people count, bots have an account. */
const guessedKind = (m) => {
  if (m.counted) {
    return 'person';
  }
  return m.author_key ? 'bot' : 'system';
};

/**
 * Messages indexed before migration 0041 lack what only pile 2 had (author kind, edited,
 * files): read once from the thread's folder and kept in D1.
 */
async function fillFromPile2(env, threads, messages) {
  const missing = messages.filter((m) => m.author_kind == null);
  if (!missing.length) {
    return;
  }
  const wanted = new Set(missing.map((m) => m.thread));
  const files = new Map();
  for (const t of threads.filter((x) => wanted.has(x.thread))) {
    // eslint-disable-next-line no-await-in-loop
    const read = env.CHANNELS && t.path ? await threadMessages(env, t) : [];
    for (const f of read) {
      files.set(`${t.thread}|${f.id}`, f);
    }
  }
  const updates = [];
  for (const m of missing) {
    const f = files.get(`${m.thread}|${m.id}`);
    Object.assign(m, {
      author_kind: (f && f.author && f.author.kind) || guessedKind(m),
      edited: f && f.editedAt ? 1 : 0,
      attachments: f && !f.deletedAt ? attachmentsOf(f.body) : 0,
    });
    updates.push(env.DB.prepare(`UPDATE messages SET author_kind = ?, edited = ?, attachments = ?
      WHERE source = ? AND tenant = ? AND channel_id = ? AND id = ?`)
      .bind(m.author_kind, m.edited, m.attachments, m.source, m.tenant, m.channel_id, m.id));
  }
  for (let i = 0; i < updates.length; i += 50) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.batch(updates.slice(i, i + 50));
  }
}

/**
 * The threads to export for `keys`: each with its group (a re-threaded group's members), or
 * of a group larger than MAX_GROUP only the threads asked for and the group's first.
 * `{ emit, groups }`: the thread rows to write, and every member of their groups by group key.
 */
async function threadsOf(env, keys) {
  const { results: asked } = await env.DB.prepare(`SELECT thread, logical_thread FROM threads
    WHERE thread IN (SELECT value FROM json_each(?))`).bind(list(keys)).all();
  const groupKeys = [...new Set((asked || []).map((t) => t.logical_thread || t.thread))];
  if (!groupKeys.length) {
    return { emit: [], groups: new Map() };
  }
  const { results: rows } = await env.DB.prepare(`SELECT * FROM threads
    WHERE thread IN (SELECT value FROM json_each(?1))
      OR logical_thread IN (SELECT value FROM json_each(?1))`).bind(list(groupKeys)).all();
  const groups = by((rows || []).map((t) => ({ ...t, group: t.logical_thread || t.thread })), 'group');
  const wanted = new Set(keys);
  const emit = [...groups].flatMap(([g, members]) => (members.length > MAX_GROUP
    ? members.filter((m) => wanted.has(m.thread) || m.thread === g) : members));
  return { emit, groups };
}

/**
 * What the inbox shows for each group (src/api.js): the latest member's label (else the first
 * thread's), reviewed; the first thread's title; resolved by a staff ✅ on a member's root
 * (reopened by a customer), else by Clef; who it waits on (`waitingOn`, over the group as the
 * inbox folds it: the latest member's last speaker, every member's 🙏); the facts of every member.
 */
async function entries(env, groups) {
  const all = [...groups.values()].flat().map((t) => t.thread);
  const [{ results: labels }, reviews, { results: facts }, checks, signals] = await Promise.all([
    env.DB.prepare('SELECT * FROM labels WHERE thread IN (SELECT value FROM json_each(?))')
      .bind(list(all)).all(),
    reviewsFor(env.DB, all),
    env.DB.prepare(`SELECT DISTINCT thread, field, value FROM facts
      WHERE thread IN (SELECT value FROM json_each(?)) ORDER BY field, value`).bind(list(all)).all(),
    resolutionFacts(env, all),
    signalFacts(env, all),
  ]);
  const labelOf = new Map((labels || []).map((l) => [l.thread, l]));
  const reviewsOf = by(reviews, 'thread');
  const factsOf = by(facts, 'thread');
  const out = new Map();
  for (const [g, members] of groups) {
    const anchor = members.find((m) => m.thread === g) || members[0];
    const latest = [...members].sort((a, b) => String(b.any_at).localeCompare(String(a.any_at)))[0];
    const labelKey = labelOf.has(latest.thread) ? latest.thread : anchor.thread;
    const model = labelOf.get(labelKey) || null;
    const label = effectiveLabel(model, reviewsOf.get(labelKey) || []);
    const anchorLabel = labelOf.get(anchor.thread);
    const verdict = resolution(mergeFacts(members.map((m) => checks.get(m.thread))), label, null)
      ?.verdict;
    const known = members.flatMap((m) => factsOf.get(m.thread) || []);
    const kind = label && label.kind && label.kind !== 'other' ? label.kind : 'other';
    const latestOf = (column) => members.map((m) => m[column]).filter(Boolean).sort().pop() || null;
    const waiting = waitingOn({
      kind: anchor.kind,
      last_staff: latest.last_staff,
      last_at: latestOf('last_at'),
      any_at: latestOf('any_at'),
      label,
      signals: members.flatMap((m) => signals.get(m.thread) || []),
    });
    out.set(g, {
      title: (anchorLabel && anchorLabel.title) || (label && label.title) || anchor.title || '',
      resolved: verdict ? verdict === 'resolved'
        : Boolean(label && label.resolved_p != null && label.resolved_p >= 0.5),
      waiting,
      label: {
        'label.next_actor': (label && label.next_actor) || '',
        'label.kind': anchor.kind === 'alert' ? 'alert' : kind,
        'label.urgency': (label && label.urgency) || 0,
        'label.urgency_level': urgencyLevel(label && label.urgency),
        'label.resolved_p': (label && label.resolved_p) || 0,
        'label.model': (model && model.model) || '',
      },
      facts: Object.fromEntries(Object.entries(FACTS).map(([column, fields]) => [column,
        [...new Set(known.filter((f) => fields.includes(f.field)).map((f) => f.value))]])),
    });
  }
  return out;
}

/**
 * The rows of threads `emit` (thread rows, with their `group`), as the table takes them.
 * `version` is the export's time, ms.
 */
async function rowsOf(env, emit, groups, version) {
  const keys = emit.map((t) => t.thread);
  const { results: messages } = await env.DB.prepare(`SELECT m.source, m.tenant, m.channel_id,
      m.id, m.thread, m.at, m.author, m.author_key, m.counted, m.deleted, m.author_kind,
      m.edited, m.attachments, COALESCE(p.name, i.name, m.author) AS name,
      COALESCE(p.email, i.email) AS email, COALESCE(m.person, i.person) AS person,
      MAX(m.staff, COALESCE(p.staff, 0), COALESCE(i.staff, 0)) AS staff
    FROM messages m
    LEFT JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +m.author_key
    LEFT JOIN people p ON p.id = COALESCE(m.person, i.person)
    WHERE m.thread IN (SELECT value FROM json_each(?)) ORDER BY m.thread, m.at`)
    .bind(list(keys)).all();
  const all = messages || [];
  await fillFromPile2(env, emit, all);
  const persons = all.map((m) => m.person).filter(Boolean);
  const [{ results: rx }, { results: mentions }, { results: members }, { results: shares },
    { results: orgs }, { results: partnerRows }, entryOf] = await Promise.all([
    env.DB.prepare(`SELECT message, COUNT(*) AS n FROM reactions
      WHERE thread IN (SELECT value FROM json_each(?)) GROUP BY message`).bind(list(keys)).all(),
    env.DB.prepare(`SELECT message, COUNT(*) AS n FROM mentions
      WHERE thread IN (SELECT value FROM json_each(?)) GROUP BY message`).bind(list(keys)).all(),
    env.DB.prepare(`SELECT person, team FROM team_members
      WHERE person IN (SELECT value FROM json_each(?)) ORDER BY team`).bind(list(persons)).all(),
    env.DB.prepare(`SELECT source, channel_id, team FROM channel_teams
      WHERE channel_id IN (SELECT value FROM json_each(?)) ORDER BY added_at, team`)
      .bind(list(emit.map((t) => t.channel_id))).all(),
    env.DB.prepare('SELECT slug, name, type FROM orgs WHERE slug IN (SELECT value FROM json_each(?))')
      .bind(list(emit.map((t) => t.org))).all(),
    env.DB.prepare('SELECT domain, name FROM partner_domains').all(),
    entries(env, groups),
  ]);
  const count = (rows) => new Map((rows || []).map((r) => [r.message, r.n]));
  const reactions = count(rx);
  const mentioned = count(mentions);
  const teamsOfPerson = new Map([...by(members, 'person')].map(([p, rs]) => [p, rs.map((r) => r.team)]));
  const sharesOf = by((shares || []).map((s) => ({ ...s, k: `${s.source}:${s.channel_id}` })), 'k');
  const orgOf = new Map((orgs || []).map((o) => [o.slug, o]));
  const partners = new Map((partnerRows || [])
    .map((r) => [String(r.domain).toLowerCase(), r.name]));
  const threadOf = new Map(emit.map((t) => [t.thread, t]));
  const origin = String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  return all.map((m) => {
    const t = threadOf.get(m.thread);
    const entry = entryOf.get(t.group);
    const org = orgOf.get(t.org);
    const key = `${m.source}:${m.tenant}:${m.channel_id}:${m.id}`;
    const kind = m.author_kind || guessedKind(m);
    const email = m.email || null;
    const domain = domainOf(email);
    // Bots and platform notices are `bot`; a person is Adobe, a partner or the customer.
    const relation = relationOf(env, {
      kind: kind === 'person' ? 'person' : 'bot', staff: m.staff, email,
    }, partners);
    const at = iso(m.at);
    return {
      timestamp: at,
      source: m.source,
      thread: m.thread,
      logical_thread: t.logical_thread || '',
      message_id: String(m.id),
      is_root: String(m.id) === String(t.root_id) ? 1 : 0,
      'channel.key': `${t.source}:${t.tenant}:${t.channel_id}`,
      'channel.name': t.channel_name || '',
      'channel.kind': t.kind,
      team: t.team,
      teams: [...new Set([t.team, ...(sharesOf.get(`${t.source}:${t.channel_id}`) || [])
        .map((s) => s.team)])],
      'org.slug': t.org,
      'org.name': (org && org.name) || t.org,
      'org.type': (org && org.type) || 'customer',
      'author.kind': kind,
      'author.relation': relation,
      'author.name': m.name || '',
      'author.domain': domain,
      'author.ops_teams': (m.person && teamsOfPerson.get(m.person)) || [],
      edited: m.edited ? 1 : 0,
      reactions: Math.min(65535, reactions.get(key) || 0),
      mentions: Math.min(65535, mentioned.get(key) || 0),
      attachments: Math.min(65535, m.attachments || 0),
      'thread.title': entry.title,
      'thread.root_at': iso(t.root_at) || at,
      'thread.messages': t.messages || 0,
      'thread.resolved': entry.resolved ? 1 : 0,
      'thread.waiting_on': entry.waiting,
      ...entry.label,
      ...entry.facts,
      url: `${origin}/inbox?view=personal&t=${encodeURIComponent(m.thread)}`,
      _version: version,
      // A deleted message, or every message of a thread no longer followed, goes away.
      _deleted: m.deleted || t.kind === 'ignore' ? 1 : 0,
    };
  }).filter((r) => r.timestamp);
}

/** Why ClickHouse refused, without what it quotes of the data: its error code and name. */
const reason = (status, text) => {
  const code = /Code: (\d+)/.exec(text);
  const name = /\(([A-Z_]+)\)/.exec(text);
  return `ClickHouse ${status}${code ? ` code ${code[1]}` : ''}${name ? ` ${name[1]}` : ''}`;
};

/** POSTs `rows` as JSONEachRow into `<db>.opspile_messages_raw`. */
export async function insertRows(env, rows) {
  const url = new URL(env.CLICKHOUSE_URL);
  url.searchParams.set('query', `INSERT INTO ${env.CLICKHOUSE_DATABASE}.opspile_messages_raw FORMAT JSONEachRow`);
  url.searchParams.set('async_insert', '1');
  url.searchParams.set('wait_for_async_insert', '1');
  url.searchParams.set('date_time_input_format', 'best_effort');
  for (let i = 0; i < rows.length; i += MAX_ROWS) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-ndjson',
        'x-clickhouse-user': env.CLICKHOUSE_USER,
        'x-clickhouse-key': env.CLICKHOUSE_PASSWORD,
      },
      body: `${rows.slice(i, i + MAX_ROWS).map((r) => JSON.stringify(r)).join('\n')}\n`,
    });
    if (!res.ok) {
      // eslint-disable-next-line no-await-in-loop
      throw new Error(reason(res.status, await res.text().catch(() => '')));
    }
  }
}

/**
 * Exports threads `keys` (and their groups) to ClickHouse. With `at` (when the job was
 * queued), a thread exported since is skipped: a burst of messages exports once.
 */
export async function exportThreads(env, keys, { at = null, now = Date.now() } = {}) {
  if (!exportEnabled(env)) {
    return { result: 'skip', reason: 'no ClickHouse' };
  }
  let wanted = [...new Set([].concat(keys || []).filter(Boolean))];
  if (at && wanted.length) {
    const { results } = await env.DB.prepare(`SELECT thread FROM threads
      WHERE thread IN (SELECT value FROM json_each(?)) AND exported_at > ?`)
      .bind(list(wanted), new Date(at).toISOString()).all();
    const done = new Set((results || []).map((r) => r.thread));
    wanted = wanted.filter((k) => !done.has(k));
  }
  if (!wanted.length) {
    return { result: 'unchanged' };
  }
  // The export's time: its version, and since when the threads are exported (read after it).
  const started = new Date(now);
  const { emit, groups } = await threadsOf(env, wanted);
  if (!emit.length) {
    return { result: 'missing' };
  }
  const rows = await rowsOf(env, emit, groups, started.getTime());
  if (rows.length) {
    await insertRows(env, rows);
  }
  const marks = emit.map((t) => env.DB.prepare(`UPDATE threads SET exported_through = ?,
      exported_at = ? WHERE thread = ?`).bind(t.updated_at, started.toISOString(), t.thread));
  for (let i = 0; i < marks.length; i += 50) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.batch(marks.slice(i, i + 50));
  }
  return { result: 'exported', threads: emit.length, rows: rows.length };
}

/** Queues an export of `thread` (after the label job, unless `delaySeconds` says otherwise). */
export async function queueExport(env, thread, { delaySeconds = EXPORT_DELAY_SECONDS } = {}) {
  if (!exportEnabled(env) || !env.NORMALIZE || !thread) {
    return;
  }
  const body = { export: thread, at: Date.now() };
  await (delaySeconds ? env.NORMALIZE.send(body, { delaySeconds }) : env.NORMALIZE.send(body));
}

/**
 * Cron: enqueues the threads that changed since they were exported (a message written, a
 * label, a review or re-threading since; a re-file clears the watermark), the most recently
 * active first, once they have been quiet for a few minutes. The first runs after the
 * exporter is turned on export everything there is.
 */
export async function sweepExports(env, now = new Date()) {
  if (!exportEnabled(env) || !env.NORMALIZE) {
    return { skipped: 'no ClickHouse' };
  }
  const { results } = await env.DB.prepare(`SELECT t.thread FROM threads t
    LEFT JOIN labels l ON l.thread = t.thread
    WHERE t.updated_at < ?1 AND (t.exported_through IS NULL OR t.exported_through != t.updated_at
      OR l.labeled_at > t.exported_at OR t.rethreaded_at > t.exported_at
      OR EXISTS (SELECT 1 FROM label_reviews r WHERE r.thread = t.thread
        AND r.created_at > t.exported_at))
    ORDER BY COALESCE(t.any_at, t.updated_at) DESC LIMIT ?2`)
    .bind(new Date(now.getTime() - SETTLE_MS).toISOString(), SWEEP).all();
  const keys = (results || []).map((r) => r.thread);
  const jobs = [];
  for (let i = 0; i < keys.length; i += SWEEP_JOB) {
    // When the sweep ran: a thread exported since (by the online job, or by the jobs of a run
    // that overlaps the next one, as the backfill's may) is not exported again.
    jobs.push({ body: { export: keys.slice(i, i + SWEEP_JOB), at: now.getTime() } });
  }
  for (let i = 0; i < jobs.length; i += 100) {
    // eslint-disable-next-line no-await-in-loop
    await env.NORMALIZE.sendBatch(jobs.slice(i, i + 100));
  }
  return { queued: keys.length, jobs: jobs.length };
}
