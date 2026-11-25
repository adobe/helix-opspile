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
import { ADMIN_TEAM } from './roles.js';
import { UNASSIGNED } from './rules.js';
import { topicIndex } from './topicindex.js';

/**
 * Suggested members of a team (GET /api/admin/member-suggestions; docs/ARCHITECTURE.md, "Team
 * managers"): the Adobe people who are likely on it and are not yet, for its managers and the
 * admin team to add with one click. The team's channels are the ones it holds and the ones
 * shared with it. Three signals, each scaled to its best person, then weighed (WEIGHTS):
 *
 * - worked: the team's threads they posted in (or, at half the weight, reacted in) over the last
 *   WINDOW_DAYS, tf-idf style: the term frequency grows with the log of the threads, and it is
 *   weighed by the square root of the share of all the threads they worked in that time that are
 *   the team's. Somebody who works mostly here counts the most; an admin who posts everywhere
 *   little.
 * - member: the team's channels they are in (`channel_members`: Slack's members of the channel,
 *   the Teams team's members), the same way: the log of those channels, weighed by the square
 *   root of the share of all the channels they are listed in that are the team's.
 * - topic: the topics of the newest topic map (src/topicindex.js) that are the team's (at least
 *   MIN_TOPIC_THREADS of its threads, and MIN_TOPIC_SHARE of the topic's), and who worked their
 *   threads anywhere lately: the experts the thread agents' `list_experts` and `list_topics`
 *   name for those topics. A topic counts by how much of it is the team's.
 *
 * Staff only (STAFF_DOMAINS, or marked staff), with a mail address: what a team member is.
 * Members, and the people dismissed for the team (`member_suggestion_dismissals`, migration 0095:
 * by its page, or by being taken off the team), are left out. Only numbers and topic names leave
 * here: the team's own threads and channels, which whoever may see the team's page sees anyway.
 */

export const WINDOW_DAYS = 180;
export const WEIGHTS = { worked: 1, member: 0.5, topic: 0.5 };
/** Suggested at most, and what a suggestion needs of the score at least. */
export const MAX_SUGGESTED = 15;
export const MIN_SCORE = 0.15;
/** A topic is the team's with this many of its threads, and this share of the topic. */
export const MIN_TOPIC_THREADS = 2;
export const MIN_TOPIC_SHARE = 0.25;
const MAX_TOPICS = 5;
/** The topics a suggestion names. */
const TOPICS_SHOWN = 3;

const DAY = 24 * 60 * 60 * 1000;
const round = (x) => Math.round(x * 1000) / 1000;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function rows(env, sql, ...args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

/** Whether `team` gets suggestions: an ops team, not the admin team, which holds every channel. */
export const suggestsMembers = (team) => Boolean(team) && team !== ADMIN_TEAM
  && team !== UNASSIGNED;

/**
 * SQL: the team `?1`'s threads, `thread, source, tenant, channel_id`: the ones of its channels and
 * of the channels shared with it (migration 0024). `recent`: active since `?2` only.
 */
const teamThreads = (recent) => {
  const since = recent ? ' AND COALESCE(t.last_at, t.any_at) >= ?2' : '';
  return `SELECT t.thread, t.source, t.tenant, t.channel_id FROM threads t WHERE t.team = ?1${since}
    UNION SELECT t.thread, t.source, t.tenant, t.channel_id FROM threads t
      WHERE (t.source, t.channel_id) IN (SELECT source, channel_id FROM channel_teams WHERE team = ?1)${since}`;
};

/**
 * tf-idf of one signal: `n` here (threads or channels; a reaction is half a thread) of `all` in
 * total. The term frequency is `1 + ln n` (`n` itself under one), weighed by the square root of
 * the share `n / all`. 0 for none.
 */
export function focused(n, all) {
  if (!(n > 0)) {
    return 0;
  }
  const tf = n >= 1 ? 1 + Math.log(n) : n;
  return tf * Math.sqrt(n / Math.max(all || 0, n));
}

/**
 * The score of each candidate (`[{ worked, member, topic }]`, the raw signals): each signal
 * scaled to its best, weighed by WEIGHTS and summed. Returns the scores in the same order.
 */
export function scores(list) {
  const top = Object.fromEntries(Object.keys(WEIGHTS)
    .map((k) => [k, Math.max(0, ...list.map((x) => x[k] || 0))]));
  return list.map((x) => round(Object.entries(WEIGHTS)
    .reduce((s, [k, w]) => s + (top[k] ? (w * (x[k] || 0)) / top[k] : 0), 0)));
}

/**
 * The team's topics in the topic map `index`, `[{ id, label, here, size, share }]`: at least
 * MIN_TOPIC_THREADS of `threads` (the team's thread keys) and MIN_TOPIC_SHARE of the topic, the
 * most of the team's first, MAX_TOPICS of them.
 */
export function teamTopics(index, threads) {
  if (!index) {
    return [];
  }
  const here = new Map();
  for (const key of threads) {
    const id = index.topicOf.get(key);
    if (id !== undefined) {
      here.set(id, (here.get(id) || 0) + 1);
    }
  }
  return [...here].map(([id, n]) => {
    const t = index.topics.get(id);
    return {
      id, label: t.label, here: n, size: t.size, share: t.size ? n / t.size : 0,
    };
  }).filter((t) => t.here >= MIN_TOPIC_THREADS && t.share >= MIN_TOPIC_SHARE)
    .sort((a, b) => (b.here - a.here) || (b.share - a.share))
    .slice(0, MAX_TOPICS);
}

/**
 * The suggested members of `team` (see the top): `{ suggestions, dismissed, coverage }`.
 * Each suggestion is `{ email, id, name, teams, posted, reacted, channels, topics, last, score }`:
 * the team's threads they posted and reacted in lately, how many of the team's channels they are
 * in, the team's topics they worked (`[{ label, threads }]`), their latest activity here and
 * their other ops teams. `dismissed` are the ones left out by a dismissal, with who and when.
 */
export async function memberSuggestions(env, team, { now = Date.now() } = {}) {
  const since = new Date(now - WINDOW_DAYS * DAY).toISOString();
  const [
    members, dismissals, channels, posted, reacted, listedIn, recent, index,
  ] = await Promise.all([
    rows(env, `SELECT LOWER(p.email) AS email FROM team_members m JOIN people p ON p.id = m.person
      WHERE m.team = ? AND p.email IS NOT NULL`, team),
    rows(env, `SELECT LOWER(email) AS email, why, dismissed_by, dismissed_at
      FROM member_suggestion_dismissals WHERE team = ?`, team),
    rows(env, `WITH mine AS (${teamThreads(false)})
      SELECT h.source, h.tenant, h.channel_id, c.members_at, c.members_error
      FROM (SELECT DISTINCT source, tenant, channel_id FROM mine) h
      LEFT JOIN channels c ON c.source = h.source AND c.tenant = h.tenant AND c.channel_id = h.channel_id
      WHERE c.archived_at IS NULL`, team),
    rows(env, `WITH mine AS (${teamThreads(true)})
      SELECT LOWER(p.email) AS email, p.id, p.name, p.staff, COUNT(DISTINCT m.thread) AS threads,
        MAX(m.at) AS last
      FROM mine t JOIN messages m ON m.thread = t.thread JOIN people p ON p.id = m.person
      WHERE m.staff = 1 AND m.counted = 1 AND m.deleted = 0 AND m.at >= ?2 AND p.email IS NOT NULL
      GROUP BY p.id`, team, since),
    rows(env, `WITH mine AS (${teamThreads(true)})
      SELECT LOWER(COALESCE(p.email, i.email)) AS email, p.id, COALESCE(p.name, i.name) AS name,
        COALESCE(p.staff, 0) AS staff, COUNT(DISTINCT r.thread) AS threads, MAX(r.at) AS last
      FROM mine t JOIN reactions r ON r.thread = t.thread
      JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +r.user_key
      LEFT JOIN people p ON p.id = i.person
      WHERE i.kind = 'person' AND r.at >= ?2 AND COALESCE(p.email, i.email) IS NOT NULL
      GROUP BY LOWER(COALESCE(p.email, i.email))`, team, since),
    rows(env, `WITH mine AS (${teamThreads(false)}),
        held AS (SELECT DISTINCT source, tenant, channel_id FROM mine)
      SELECT LOWER(COALESCE(x.email, i.email)) AS email, MAX(COALESCE(i.name, x.name)) AS name,
        COUNT(DISTINCT x.source || ':' || x.tenant || ':' || x.channel_id) AS channels
      FROM held h JOIN channel_members x ON x.source = h.source AND x.tenant = h.tenant
        AND x.channel_id = h.channel_id
      JOIN channels c ON c.source = h.source AND c.tenant = h.tenant AND c.channel_id = h.channel_id
      LEFT JOIN identities i ON i.source = x.source AND i.tenant = x.tenant AND i.user_id = x.user_id
      WHERE c.archived_at IS NULL AND (i.kind IS NULL OR i.kind = 'person')
        AND COALESCE(x.email, i.email) IS NOT NULL
      GROUP BY LOWER(COALESCE(x.email, i.email))`, team),
    rows(env, `${teamThreads(true)}`, team, since),
    topicIndex(env, { now }),
  ]);
  const skip = new Set([...members.map((m) => m.email), ...dismissals.map((d) => d.email)]);
  const staff = (email, flag) => Boolean(flag) || isStaffDomain(env, email);
  const people = new Map();
  const candidate = (email, { id = null, name = null } = {}) => {
    const k = String(email || '').toLowerCase();
    if (!EMAIL.test(k) || skip.has(k)) {
      return null;
    }
    const p = people.get(k) || {
      email: k,
      id: null,
      name: null,
      posted: 0,
      reacted: 0,
      channels: 0,
      topics: [],
      topic: 0,
      last: null,
    };
    p.id = p.id || id || null;
    p.name = p.name || name || null;
    people.set(k, p);
    return p;
  };
  const later = (a, b) => (!a || (b && b > a) ? b || a : a);
  for (const r of posted.filter((x) => staff(x.email, x.staff))) {
    const p = candidate(r.email, r);
    if (p) {
      p.posted = r.threads;
      p.last = later(p.last, r.last);
    }
  }
  for (const r of reacted.filter((x) => staff(x.email, x.staff))) {
    const p = candidate(r.email, r);
    if (p) {
      p.reacted = r.threads;
      p.last = later(p.last, r.last);
    }
  }
  for (const r of listedIn.filter((x) => staff(x.email))) {
    const p = candidate(r.email, r);
    if (p) {
      p.channels = r.channels;
    }
  }
  // The topics: who worked the team's topics lately, by person id.
  const topics = teamTopics(index, [...new Set(recent.map((r) => r.thread))]);
  const byId = new Map();
  for (const t of topics) {
    for (const [id, w] of index.topics.get(t.id).people) {
      if (w.threads && (!w.last || w.last >= since)) {
        const x = byId.get(id) || { score: 0, topics: [], last: null };
        x.score += t.share * w.threads;
        x.topics.push({ label: t.label, threads: w.threads });
        x.last = later(x.last, w.last);
        byId.set(id, x);
      }
    }
  }
  if (byId.size) {
    const known = await rows(env, `SELECT id, LOWER(email) AS email, name, staff FROM people
      WHERE id IN (SELECT value FROM json_each(?)) AND email IS NOT NULL`, JSON.stringify([...byId.keys()]));
    for (const r of known.filter((x) => staff(x.email, x.staff))) {
      const p = candidate(r.email, r);
      if (p) {
        const x = byId.get(r.id);
        p.topic = x.score;
        p.topics = x.topics.sort((a, b) => b.threads - a.threads).slice(0, TOPICS_SHOWN);
      }
    }
  }
  const list = [...people.values()];
  // What each worked, and the channels each is listed in, at all: the idf of the two signals.
  const emails = JSON.stringify(list.map((p) => p.email));
  const [workedAll, inAll, onTeams] = list.length ? await Promise.all([
    rows(env, `SELECT LOWER(p.email) AS email, COUNT(DISTINCT m.thread) AS threads FROM people p
      JOIN messages m ON m.person = p.id
      WHERE LOWER(p.email) IN (SELECT value FROM json_each(?1)) AND m.staff = 1 AND m.counted = 1
        AND m.deleted = 0 AND m.at >= ?2
      GROUP BY p.id`, emails, since),
    rows(env, `SELECT email, COUNT(DISTINCT k) AS channels FROM (
        SELECT LOWER(x.email) AS email, x.source || ':' || x.tenant || ':' || x.channel_id AS k
        FROM channel_members x WHERE x.email IN (SELECT value FROM json_each(?1))
        UNION ALL SELECT LOWER(i.email), x.source || ':' || x.tenant || ':' || x.channel_id
        FROM identities i JOIN channel_members x ON x.source = i.source AND x.tenant = i.tenant
          AND x.user_id = i.user_id
        WHERE i.email IN (SELECT value FROM json_each(?1)) AND x.email IS NULL)
      GROUP BY email`, emails),
    rows(env, `SELECT LOWER(p.email) AS email, m.team FROM team_members m JOIN people p ON p.id = m.person
      WHERE LOWER(p.email) IN (SELECT value FROM json_each(?)) ORDER BY m.team`, emails),
  ]) : [[], [], []];
  const allWorked = new Map(workedAll.map((r) => [r.email, r.threads]));
  const allIn = new Map(inAll.map((r) => [r.email, r.channels]));
  const teamsOf = new Map();
  onTeams.forEach((r) => teamsOf.set(r.email, [...(teamsOf.get(r.email) || []), r.team]));
  const raw = list.map((p) => ({
    worked: focused(p.posted + p.reacted / 2, (allWorked.get(p.email) || 0) + p.reacted / 2),
    member: focused(p.channels, allIn.get(p.email)),
    topic: p.topic,
  }));
  const scored = scores(raw);
  const out = list.map((p, i) => ({
    email: p.email,
    id: p.id,
    name: p.name,
    teams: teamsOf.get(p.email) || [],
    posted: p.posted,
    reacted: p.reacted,
    channels: p.channels,
    topics: p.topics,
    last: p.last,
    score: scored[i],
  })).filter((p) => p.score >= MIN_SCORE)
    .sort((a, b) => (b.score - a.score) || (b.posted - a.posted) || (b.channels - a.channels)
      || String(a.name || a.email).localeCompare(String(b.name || b.email)))
    .slice(0, MAX_SUGGESTED);
  // Who was dismissed, by name where the inbox knows one.
  const names = dismissals.length ? new Map((await rows(env, `SELECT LOWER(email) AS email, name FROM people
    WHERE LOWER(email) IN (SELECT value FROM json_each(?))`, JSON.stringify(dismissals.map((d) => d.email))))
    .map((r) => [r.email, r.name])) : new Map();
  return {
    suggestions: out,
    dismissed: dismissals.map((d) => ({
      email: d.email,
      name: names.get(d.email) || null,
      why: d.why,
      by: d.dismissed_by,
      at: d.dismissed_at,
    })).sort((a, b) => String(b.at).localeCompare(String(a.at))),
    coverage: {
      channels: channels.length,
      membersListed: channels.filter((c) => c.members_at && !c.members_error).length,
      topics: topics.map((t) => t.label),
      topicMap: Boolean(index),
    },
  };
}

/**
 * Dismisses `email` from `team`'s suggestions (`dismiss: true`, `why` 'dismissed' or 'removed'),
 * or suggests them again. Answers whether anything changed.
 */
export async function dismissMember(env, team, email, {
  by = null, why = 'dismissed', dismiss = true, now = Date.now(),
} = {}) {
  const k = String(email || '').trim().toLowerCase();
  if (!dismiss) {
    const { meta } = await env.DB.prepare('DELETE FROM member_suggestion_dismissals WHERE team = ? AND email = ?')
      .bind(team, k).run();
    return Boolean(meta.changes);
  }
  const { meta } = await env.DB.prepare(`INSERT INTO member_suggestion_dismissals (team, email, why,
      dismissed_by, dismissed_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (team, email) DO UPDATE SET why = excluded.why, dismissed_by = excluded.dismissed_by,
      dismissed_at = excluded.dismissed_at`)
    .bind(team, k, why, by, new Date(now).toISOString()).run();
  return Boolean(meta.changes);
}
