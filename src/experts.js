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

import { roster } from './agent/members.js';
import { entryOf } from './drafts.js';
import { recordList } from './expertevents.js';
import { affinities, entryRows, staffMatches } from './expertise.js';
import { json } from './http.js';
import { notifyRoom } from './notify.js';
import {
  ACCOUNTS, learnMembers, NAME, target,
} from './post.js';

/**
 * The expert finder of a thread: Adobe people worth pulling into it, who are not in it yet, each
 * with why (docs/ARCHITECTURE.md, "Expert finder"). Four signals, each scaled to its best person:
 * the threads someone worked in this channel and for this customer (D1), the staff messages
 * closest to the thread by meaning (CONTENT, src/expertise.js) and by words (SEARCH, the title
 * with BM25, for messages that have two neighbouring words of it). Measured on production threads,
 * channel and customer history say best who answers,
 * and the vectors and words find the people that history misses; their sum beat each alone.
 * Only names and numbers leave here, never text: the signals read channels of every team,
 * which neither the viewer nor a thread agent may read.
 */

/**
 * What the finder is: the signals and weights below. Recorded with each list it shows
 * (src/expertevents.js), so what people did with a list is learned with what made it; change
 * it when they change.
 */
export const FINDER = 'signals-2026-10';
/** History older than this does not count. */
const WINDOW_DAYS = 180;
/** Someone who has not posted for this long has moved on. */
const ACTIVE_DAYS = 90;
/** The weights of the signals: customer history mostly repeats channel history. */
const WEIGHTS = {
  channel: 1, customer: 0.5, meaning: 1, words: 1,
};
/** What a signal needs, of its best person's, to say someone "knows about this topic". */
const TOPIC = 0.5;
/** A mention of someone outside the channel may never reach them, so they rank lower. */
const OUTSIDE = 0.7;
/** People a list has at most, and people whose response times are worked out. */
export const MAX_EXPERTS = 8;
const MAX_MEASURED = 20;
/** Answered mentions a "typically responds" needs, and how many of them must be answered. */
export const MIN_ANSWERS = 3;
const MIN_RATE = 0.5;
const WORD_RESULTS = 50;
const MAX_TITLE = 120;
/** Suggestions by agents an entry keeps, and the length of a reason. */
export const MAX_SUGGESTED = 3;
const MAX_REASON = 200;
/** Lists are kept this long per version of the thread (the rest is slow to change). */
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map();

const day = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** Words that say nothing of what a title is about: no pair of a title has one of them. */
const COMMON = new Set(`a an and are as at be but by can do does for from has have how i in is it
  its no not of on or our the their this to us was we were what when why will with you your`.split(/\s+/));

const wordsIn = (text) => String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const single = (word) => word.replace(/s$/, '');

/** A title's neighbouring words, as `hasPair` looks for them; `[]` when it has no such pair. */
export function titlePairs(title) {
  const words = wordsIn(title);
  return words.slice(1).map((word, i) => [words[i], word])
    .filter((pair) => !pair.some((word) => COMMON.has(word)))
    .map((pair) => ` ${pair.map(single).join(' ')} `);
}

/** Whether `text` has one of the pairs, in any case, plural or not, across any punctuation. */
export function hasPair(text, pairs) {
  const said = ` ${wordsIn(text).map(single).join(' ')} `;
  return pairs.some((pair) => said.includes(pair));
}

/** Each number over the map's largest. */
function scaled(map) {
  const top = Math.max(0, ...map.values());
  return new Map([...map].map(([k, v]) => [k, top ? v / top : 0]));
}

/** Who worked how many threads in `where` lately: a map of person id to threads. */
async function workedIn(env, from, where, bind, threads, since) {
  const { results } = await env.DB.prepare(`SELECT m.person, COUNT(DISTINCT m.thread) AS n ${from}
    WHERE ${where} AND m.staff = 1 AND m.counted = 1 AND m.deleted = 0 AND m.person IS NOT NULL
      AND m.at >= ? AND m.thread NOT IN (SELECT value FROM json_each(?)) GROUP BY m.person`)
    .bind(...bind, since, JSON.stringify(threads)).all();
  return new Map((results || []).map((r) => [r.person, r.n]));
}

/**
 * The staff authors of the messages with two neighbouring words of the title: person id to BM25
 * scores. The search takes any word of the title, so one common word would be enough for it.
 */
async function byWords(env, title, threads) {
  const pairs = titlePairs(title);
  if (!env.SEARCH || !pairs.length) {
    return new Map();
  }
  const { chunks } = await env.SEARCH.search({
    query: title.slice(0, MAX_TITLE),
    ai_search_options: {
      retrieval: {
        retrieval_type: 'keyword',
        keyword_match_mode: 'or',
        match_threshold: 0,
        max_num_results: WORD_RESULTS,
      },
    },
  });
  const hits = new Map();
  for (const c of chunks || []) {
    const message = c.item && c.item.metadata && c.item.metadata.message;
    if (message && !hits.has(message) && !threads.includes(message.split('|')[0])
      && hasPair(c.text, pairs)) {
      hits.set(message, c.score);
    }
  }
  const keys = [...new Set([...hits.keys()].map((m) => m.split('|')[0]))];
  const { results } = await env.DB.prepare(`SELECT thread, id, person FROM messages
    WHERE thread IN (SELECT value FROM json_each(?)) AND staff = 1 AND counted = 1 AND deleted = 0
      AND person IS NOT NULL`).bind(JSON.stringify(keys)).all();
  const out = new Map();
  for (const r of results || []) {
    const score = hits.get(`${r.thread}|${r.id}`);
    if (score) {
      out.set(r.person, (out.get(r.person) || 0) + score);
    }
  }
  return out;
}

/** The people the vectors find, or nothing: without them the finder only knows less. */
async function byMeaning(env, rows, threads) {
  if (!env.CONTENT || !env.AI) {
    return new Map();
  }
  return affinities(await staffMatches(env, rows), { threads }).people;
}

/** A signal that failed counts for nothing; the others still answer. */
const quietly = (signal, promise) => promise.catch((e) => {
  console.log(JSON.stringify({ route: 'experts', signal, error: e.message }));
  return new Map();
});

/**
 * How long people took to post in a thread after being mentioned in it, a re-threaded group as
 * one thread: person id to `{ minutes, answered, mentions }` (the median of those answered).
 */
export async function responseTimes(env, people, { now = Date.now() } = {}) {
  if (!people.length) {
    return new Map();
  }
  const list = JSON.stringify(people);
  const since = iso(now - WINDOW_DAYS * day);
  const entry = 'COALESCE(t.logical_thread, t.thread) AS entry';
  const [{ results: asked }, { results: posts }] = await Promise.all([
    env.DB.prepare(`SELECT m.person, m.at, ${entry} FROM mentions m
      JOIN threads t ON t.thread = m.thread
      WHERE m.person IN (SELECT value FROM json_each(?)) AND m.at >= ?`).bind(list, since).all(),
    env.DB.prepare(`SELECT x.person, x.at, ${entry} FROM messages x
      JOIN threads t ON t.thread = x.thread
      WHERE x.person IN (SELECT value FROM json_each(?)) AND x.at >= ? AND x.deleted = 0`)
      .bind(list, since).all(),
  ]);
  const seen = new Map();
  for (const m of asked || []) {
    const answer = (posts || [])
      .filter((x) => x.person === m.person && x.entry === m.entry && x.at > m.at)
      .reduce((first, x) => (!first || x.at < first ? x.at : first), null);
    const so = seen.get(m.person) || { mentions: 0, took: [] };
    so.mentions += 1;
    if (answer) {
      so.took.push((Date.parse(answer) - Date.parse(m.at)) / 60000);
    }
    seen.set(m.person, so);
  }
  return new Map([...seen].map(([person, { mentions, took }]) => {
    const sorted = took.sort((a, b) => a - b);
    return [person, {
      minutes: sorted.length ? Math.round(sorted[Math.floor((sorted.length - 1) / 2)]) : null,
      answered: sorted.length,
      mentions,
    }];
  }));
}

/** A time in words: "within minutes", "about 35 minutes", "about 4 hours", "about 2 days". */
export function roughly(minutes) {
  if (minutes < 5) {
    return 'within minutes';
  }
  if (minutes < 55) {
    return `about ${Math.round(minutes / 5) * 5} minutes`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 36) {
    return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `about ${Math.round(hours / 24)} days`;
}

/** Whether a response time says something: enough mentions, and most of them answered. */
const reliable = (r) => Boolean(r) && r.answered >= MIN_ANSWERS
  && r.answered / r.mentions >= MIN_RATE;

/** What to say about someone: `reasons`, the strongest first. */
export function reasonsOf(e) {
  const reasons = [];
  if (e.topic) {
    reasons.push('knows about this topic');
  }
  if (reliable(e.response)) {
    const { minutes } = e.response;
    reasons.push(`typically responds ${minutes < 5 ? '' : 'in '}${roughly(minutes)}`);
  }
  if (e.channel) {
    reasons.push('is active in this channel');
  } else if (e.customer) {
    reasons.push('works with this customer');
  }
  if (e.member === false) {
    reasons.push('not in this channel');
  }
  return reasons;
}

/** Candidates' accounts on the thread's platform, by person; other people cannot be mentioned. */
async function accounts(env, t, people) {
  const { results } = await env.DB.prepare(`SELECT i.user_id AS id, i.person, ${NAME} AS name,
      i.avatar, MAX(COALESCE(p.staff, 0), COALESCE(i.staff, 0)) AS staff
    ${ACCOUNTS} AND i.person IN (SELECT value FROM json_each(?))`)
    .bind(t.source, t.tenant, JSON.stringify(people)).all();
  const out = new Map();
  for (const r of results || []) {
    if (r.staff && !out.has(r.person)) {
      out.set(r.person, r);
    }
  }
  return out;
}

/** Who is in the entry already: its authors, and those it mentions. */
async function inEntry(env, threads) {
  const list = JSON.stringify(threads);
  const { results } = await env.DB.prepare(`SELECT person FROM messages
      WHERE thread IN (SELECT value FROM json_each(?)) AND person IS NOT NULL
    UNION SELECT person FROM mentions WHERE thread IN (SELECT value FROM json_each(?))`)
    .bind(list, list).all();
  return new Set((results || []).map((r) => r.person));
}

/**
 * Whether Adobe has the entry in hand: staff posted in it or were mentioned in it. Then its
 * own people are the ones to ask, and the finder only says more when `me` was mentioned and has
 * not posted yet (they may be looking for whom to hand it to). Agents' suggestions still show.
 */
async function inHand(env, threads, me) {
  const list = JSON.stringify(threads);
  const of = 'thread IN (SELECT value FROM json_each(?))';
  const row = await env.DB.prepare(`SELECT
      EXISTS (SELECT 1 FROM messages WHERE ${of} AND staff = 1 AND counted = 1 AND deleted = 0)
        AS posted,
      EXISTS (SELECT 1 FROM mentions m JOIN people p ON p.id = m.person
        WHERE m.${of} AND p.staff = 1) AS mentioned,
      EXISTS (SELECT 1 FROM mentions WHERE ${of} AND person = ?) AS askedMe,
      EXISTS (SELECT 1 FROM messages WHERE ${of} AND person = ? AND deleted = 0) AS answered`)
    .bind(list, list, list, me, list, me).first();
  if (!row || (!row.posted && !row.mentioned)) {
    return false;
  }
  return !(me !== null && row.askedMe && !row.answered);
}

/** Of `people`, those who posted anywhere lately. */
async function active(env, people, now) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT person FROM messages
    WHERE person IN (SELECT value FROM json_each(?)) AND at >= ?`)
    .bind(JSON.stringify(people), iso(now - ACTIVE_DAYS * day)).all();
  return new Set((results || []).map((r) => r.person));
}

/**
 * Of `ids` (accounts), those in the thread's channel (on Teams, in its team), or null without a
 * complete list of its members (src/agent/members.js): then nothing is known, as for most.
 */
async function membersOf(env, t, ids) {
  const { members } = await roster(env, {
    source: t.source, tenant: t.tenant, channelId: t.channel_id,
  });
  if (!members) {
    return null;
  }
  const listed = new Set(members.map((m) => m.user_id));
  return new Set(ids.filter((id) => listed.has(id)));
}

/** Whether an account is in the channel: true, false, or null when nobody can say. */
const inChannel = (members, id, posted) => {
  if (posted || (members && members.has(id))) {
    return true;
  }
  return members ? false : null;
};

/** The people of an entry's list, best first, without what is the viewer's alone. */
async function rank(env, t, rows, now) {
  const threads = rows.map((r) => r.thread);
  const since = iso(now - WINDOW_DAYS * day);
  const title = rows.map((r) => r.title).find(Boolean);
  const [channel, customer, meaning, words] = await Promise.all([
    quietly('channel', workedIn(env, 'FROM messages m', 'm.source = ? AND m.tenant = ? AND m.channel_id = ?', [t.source, t.tenant, t.channel_id], threads, since)),
    t.org && !t.org.startsWith('_')
      ? quietly('customer', workedIn(env, 'FROM messages m JOIN threads t ON t.thread = m.thread', "t.org = ? AND t.kind <> 'alert'", [t.org], threads, since))
      : new Map(),
    quietly('meaning', byMeaning(env, rows, threads)),
    quietly('words', byWords(env, title, threads)),
  ]);
  const found = {
    channel, customer, meaning, words,
  };
  const signals = Object.fromEntries(Object.entries(found).map(([k, m]) => [k, scaled(m)]));
  const people = [...new Set(Object.values(signals).flatMap((m) => [...m.keys()]))];
  const inThread = await inEntry(env, threads);
  const open = people.filter((p) => !inThread.has(p));
  if (!open.length) {
    return [];
  }
  const [known, recent] = await Promise.all([accounts(env, t, open), active(env, open, now)]);
  const listed = open.filter((p) => known.has(p) && recent.has(p));
  const members = await membersOf(env, t, listed.map((p) => known.get(p).id));
  const ranked = listed.map((person) => {
    const a = known.get(person);
    const of = (signal) => signals[signal].get(person) || 0;
    const raw = (signal) => found[signal].get(person) || 0;
    const member = inChannel(members, a.id, of('channel') > 0);
    const score = Object.keys(WEIGHTS).reduce((s, k) => s + WEIGHTS[k] * of(k), 0);
    return {
      person,
      id: a.id,
      name: a.name,
      avatar: a.avatar || null,
      member,
      topic: Math.max(of('meaning'), of('words')) >= TOPIC,
      channel: of('channel') > 0,
      customer: of('customer') > 0,
      score: score * (member === false ? OUTSIDE : 1),
      // Each signal scaled, as it is added up, and as it was found (threads; affinity; BM25).
      signals: {
        channel: of('channel'),
        customer: of('customer'),
        meaning: of('meaning'),
        words: of('words'),
        channelThreads: raw('channel'),
        customerThreads: raw('customer'),
        meaningRaw: raw('meaning'),
        wordsRaw: raw('words'),
      },
    };
  }).sort((a, b) => b.score - a.score).slice(0, MAX_MEASURED);
  const times = await responseTimes(env, ranked.map((e) => e.person), { now });
  return ranked.map((e) => ({ ...e, response: times.get(e.person) || null }));
}

/** The agents' suggestions on an entry that still stand: they are not in it yet. */
async function suggested(env, t, keys, threads) {
  const { results } = await env.DB.prepare(`SELECT s.user_id AS id, s.reason, s.at, i.person,
      ${NAME} AS name, i.avatar
    FROM expert_suggestions s
    JOIN identities i ON i.source = ? AND i.tenant = ? AND i.user_id = s.user_id
    LEFT JOIN people p ON p.id = i.person
    WHERE s.thread IN (SELECT value FROM json_each(?)) ORDER BY s.at DESC`)
    .bind(t.source, t.tenant, JSON.stringify(keys)).all();
  if (!results || !results.length) {
    return [];
  }
  const inThread = await inEntry(env, threads);
  return results.filter((r) => !inThread.has(r.person));
}

/** A list entry as the page and the agents get it; `member` null is not known. */
function shape(e) {
  return {
    id: e.id,
    name: e.name,
    avatar: e.avatar,
    member: e.member,
    staff: true,
    kind: 'person',
    reasons: e.reason ? [e.reason, ...reasonsOf(e)] : reasonsOf(e),
    response: reliable(e.response) ? e.response : null,
    ...(e.reason ? { suggested: { at: e.at } } : {}),
  };
}

/**
 * A list entry as the training gets it (src/expertevents.js): its account and person, and the
 * numbers that placed it. Nothing of what it says in words.
 */
function candidate(e) {
  const r = e.response;
  return {
    id: e.id,
    person: e.person,
    features: {
      ...(e.signals || {}),
      score: e.score || 0,
      topic: Number(Boolean(e.topic)),
      member: e.member === null || e.member === undefined ? -1 : Number(e.member),
      suggested: Number(Boolean(e.reason)),
      ...(r ? { mentioned: r.mentions, answered: r.answered } : {}),
      ...(r && r.minutes !== null ? { responseMinutes: r.minutes } : {}),
    },
  };
}

/**
 * The experts of inbox entry `key`, best first, agents' suggestions before the others, as
 * `{ platform, experts, candidates }`, or null when there is no such entry: `candidates` are
 * all that were ranked, in the same order, as the training records them (`candidate`). `me`
 * (a person id) is left out. With `whenNeeded` (the inbox's header), only agents' suggestions
 * while Adobe has the entry in hand (`inHand`), and `held` says so; the candidates are all of
 * them still, for the training to see whom the team pulled in anyway. Never throws for a
 * signal that fails.
 */
export async function findExperts(env, key, {
  me = null, now = Date.now(), whenNeeded = false,
} = {}) {
  const t = key && await target(env, key);
  const rows = t ? await entryRows(env, key) : [];
  if (!rows.length) {
    return null;
  }
  const threads = rows.map((r) => r.thread);
  const version = `${key}|${rows.map((r) => `${r.thread}:${r.embedded || r.title}`).join(',')}|${t.any_at}`;
  let ranked = cache.get(version);
  if (!ranked || now - ranked.at >= CACHE_MS) {
    ranked = { at: now, list: await rank(env, t, rows, now) };
    cache.delete(version);
    cache.set(version, ranked);
    while (cache.size > CACHE_MAX) {
      cache.delete(cache.keys().next().value);
    }
  }
  const pins = await suggested(env, t, [...new Set([key, ...threads])], threads);
  const others = ranked.list.filter((e) => e.person !== me
    && !pins.some((s) => s.id === e.id));
  const mine = pins.filter((s) => s.person !== me);
  const members = await membersOf(env, t, mine.map((s) => s.id));
  const pinned = mine.map((s) => {
    const e = ranked.list.find((x) => x.id === s.id);
    return { ...e, ...s, member: inChannel(members, s.id, Boolean(e && e.member)) };
  });
  const all = [...pinned, ...others];
  const held = whenNeeded && others.length > 0 && await inHand(env, threads, me)
    .catch(() => false);
  return {
    platform: t.source,
    experts: (held ? pinned : all).slice(0, MAX_EXPERTS).map(shape),
    candidates: all.map(candidate),
    ...(held ? { held: true } : {}),
  };
}

/**
 * GET /api/experts?thread=…: the thread's expert finder. It lists the channel's members in the
 * background when that is a week old, as the mention suggestions do, for what it says of them.
 * The list is recorded for the viewer (src/expertevents.js), and `list` is its id, for what
 * the page then says of it; not while viewing as someone else.
 */
export async function experts(env, key, canSee, { me, waitUntil } = {}) {
  const e = await entryOf(env, key);
  if (!e || !await canSee(e.teams, e)) {
    return json({ error: 'not found' }, 404);
  }
  if (waitUntil) {
    const t = await target(env, e.key);
    waitUntil(learnMembers(env, t).catch((err) => console.warn(JSON.stringify({
      route: 'experts', members: t.source, error: err.message,
    }))));
  }
  const found = await findExperts(env, e.key, { me: me ? me.id : null, whenNeeded: true });
  if (!found) {
    return json(found);
  }
  const { candidates, held, ...body } = found;
  const list = await recordList(env, me, e.key, { finder: FINDER, candidates, held })
    .catch((err) => {
      console.warn(JSON.stringify({ route: 'experts', record: 'list', error: err.message }));
      return null;
    });
  return json(list ? { ...body, list } : body);
}

/**
 * Suggests the account `id` (a colleague on the entry's platform) for the expert finder of
 * entry `key`, or with `withdraw` takes a suggestion back; `by` names the agent. It tells open
 * inboxes; nobody is mentioned or told. `{ ok }`, or `{ error }`.
 */
export async function suggestExpert(env, key, {
  id, reason, withdraw = false, by,
}) {
  const e = await entryOf(env, key);
  if (!e) {
    return { error: 'no such thread' };
  }
  const account = String(id || '');
  if (withdraw) {
    await env.DB.prepare(`DELETE FROM expert_suggestions WHERE user_id = ?
      AND thread IN (SELECT value FROM json_each(?))`).bind(account, JSON.stringify(e.keys)).run();
    await notifyRoom(env, e.teams, { type: 'experts', thread: e.key });
    return { ok: true };
  }
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
  if (!why) {
    return { error: 'say why: the reason is what the team reads' };
  }
  const t = await target(env, key);
  const person = await env.DB.prepare(`SELECT i.person, ${NAME} AS name,
      MAX(COALESCE(p.staff, 0), COALESCE(i.staff, 0)) AS staff
    ${ACCOUNTS} AND i.user_id = ?`).bind(t.source, t.tenant, account).first();
  if (!person || !person.staff) {
    return { error: `${account} is not an Adobe colleague on this platform: use an id from list_experts` };
  }
  const { results } = await env.DB.prepare(`SELECT user_id FROM expert_suggestions
    WHERE thread IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(e.keys)).all();
  const others = (results || []).filter((r) => r.user_id !== account);
  if (others.length >= MAX_SUGGESTED) {
    return { error: `this thread has ${MAX_SUGGESTED} suggestions already: withdraw one first` };
  }
  await env.DB.prepare(`DELETE FROM expert_suggestions WHERE user_id = ?
    AND thread IN (SELECT value FROM json_each(?))`).bind(account, JSON.stringify(e.keys)).run();
  await env.DB.prepare(`INSERT INTO expert_suggestions (thread, user_id, reason, by, at)
    VALUES (?, ?, ?, ?, ?)`).bind(e.key, account, why, by, new Date().toISOString()).run();
  await notifyRoom(env, e.teams, { type: 'experts', thread: e.key });
  return { ok: true, name: person.name };
}

/** Forgets the kept lists (tests). */
export function clearExpertLists() {
  cache.clear();
}
