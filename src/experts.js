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

import { kept, keptAccounts } from './accounts.js';
import { roster } from './agent/members.js';
import { entryOf } from './drafts.js';
import { recordList, rejectedBy } from './expertevents.js';
import {
  affinities, entryRows, queryVector, similarThreads, staffMatches, vectorOf,
} from './expertise.js';
import { json } from './http.js';
import { notifyRoom } from './notify.js';
import {
  ACCOUNTS, learnMembers, NAME, target,
} from './post.js';
import { fitResponses, predict } from './response-model.js';
import { findTopic, topicIndex, topicsOfThreads } from './topicindex.js';

/**
 * The expert finder of a thread: Adobe people worth pulling into it, who are not in it yet, each
 * with why (docs/ARCHITECTURE.md, "Expert finder"). Five signals, each scaled to its best person:
 * the threads someone worked in this channel and for this customer (D1), the staff messages
 * closest to the thread by meaning (CONTENT, src/expertise.js) and by words (SEARCH, the title
 * with BM25, for messages that have two neighbouring words of it), and the threads of any
 * channel closest to it as a whole, which credits whoever worked them however little their own
 * words say (a "still happening?" carries none of the topic). Measured on production threads,
 * channel and customer history say best who answers,
 * and the vectors and words find the people that history misses; their sum beat each alone.
 * A thread agent can say what the thread is about in its own words (`about`), when its title and
 * first message say it badly. Only names, numbers and the topic map's names (src/topicindex.js)
 * leave here, never text: the signals read channels of every team, which neither the viewer nor
 * a thread agent may read.
 */

/**
 * What the finder is: the signals and weights below. Recorded with each list it shows
 * (src/expertevents.js), so what people did with a list is learned with what made it; change
 * it when they change.
 */
export const FINDER = 'signals-2026-11';
/** History older than this does not count. */
const WINDOW_DAYS = 180;
/** Someone who has not posted for this long has moved on. */
const ACTIVE_DAYS = 90;
/** The weights of the signals: customer history mostly repeats channel history. */
const WEIGHTS = {
  channel: 1, customer: 0.5, meaning: 1, words: 1, similar: 1,
};
/** A person's closest similar threads that count, so that a prolific one does not win on volume. */
const SIMILAR_THREADS = 3;
/** What a signal needs, of its best person's, to say someone "knows about this topic". */
const TOPIC = 0.5;
/** A mention of someone outside the channel may never reach them, so they rank lower. */
const OUTSIDE = 0.7;
/** People a list has at most, and people whose response times are worked out. */
export const MAX_EXPERTS = 8;
const MAX_MEASURED = 20;
/** Answers a "typically responds" needs, and how many mentions must be answered. */
export const MIN_ANSWERS = 3;
const MIN_RATE = 0.5;
/** The response model is kept this long per isolate: it learns slowly and reads every message. */
const MODEL_MS = 60 * 60 * 1000;
let model = null;
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
const ENTRY = 'COALESCE(t.logical_thread, t.thread) AS entry';

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
async function byMeaning(env, rows, threads, vector) {
  if (!vector) {
    return new Map();
  }
  return affinities(await staffMatches(env, rows, { vector }), { threads }).people;
}

/**
 * Who worked the threads closest to the entry (src/expertise.js `similarThreads`): `{ people,
 * worked }`, `people` person id to what their SIMILAR_THREADS closest have over the weakest
 * that counts, `worked` person id to `{ threads, last }` (those threads' keys, the closest
 * first, and when they last posted in one).
 */
async function bySimilar(env, similar) {
  const people = new Map();
  const worked = new Map();
  if (!similar.length) {
    return { people, worked };
  }
  const { results } = await env.DB.prepare(`SELECT thread, person, MAX(at) AS last FROM messages
    WHERE thread IN (SELECT value FROM json_each(?)) AND staff = 1 AND counted = 1 AND deleted = 0
      AND person IS NOT NULL GROUP BY thread, person`)
    .bind(JSON.stringify(similar.map((s) => s.thread))).all();
  const gains = new Map();
  for (const s of similar) {
    for (const r of (results || []).filter((x) => x.thread === s.thread)) {
      gains.set(r.person, [...(gains.get(r.person) || []), s.gain]);
      const w = worked.get(r.person) || { threads: [], last: null };
      w.threads.push(s.thread);
      w.last = !w.last || r.last > w.last ? r.last : w.last;
      worked.set(r.person, w);
    }
  }
  for (const [person, list] of gains) {
    people.set(person, list.sort((a, b) => b - a).slice(0, SIMILAR_THREADS)
      .reduce((sum, g) => sum + g, 0));
  }
  return { people, worked };
}

/** The vector the entry's signals go by: `about` as a query, else the entry's own, or null. */
async function entryVector(env, rows, about) {
  if (!env.CONTENT || !env.AI) {
    return null;
  }
  return about ? queryVector(env, about) : vectorOf(env, rows);
}

/** A signal that failed counts for nothing; the others still answer. */
const quietly = (signal, promise) => promise.catch((e) => {
  console.log(JSON.stringify({ route: 'experts', signal, error: e.message }));
  return new Map();
});

/** The response model of everyone's answers lately, or null without any. */
async function responseModel(env, now) {
  if (model && now - model.at < MODEL_MS) {
    return model.fit;
  }
  const { results } = await env.DB.prepare(`SELECT ${ENTRY},
      x.source || ':' || x.tenant || ':' || x.channel_id AS channel, x.at, x.staff, x.person
    FROM messages x JOIN threads t ON t.thread = x.thread
    WHERE x.at >= ? AND x.counted = 1 AND x.deleted = 0`).bind(iso(now - WINDOW_DAYS * day)).all();
  const rows = (results || []).map((r) => ({ ...r, at: Date.parse(r.at) }));
  model = { at: now, fit: fitResponses(rows) };
  return model.fit;
}

/**
 * What to say of how `people` respond, in `channel` at `now`, a re-threaded group as one thread:
 * person id to `{ minutes, joins, answered, mentions }`. `minutes` and `joins` are the response
 * model's (src/response-model.js); `answered` of `mentions` is how often they posted in a thread
 * after being mentioned in it, which the model cannot see: it only knows who did answer.
 */
export async function responseTimes(env, people, { channel, now = Date.now() } = {}) {
  if (!people.length) {
    return new Map();
  }
  const list = JSON.stringify(people);
  const since = iso(now - WINDOW_DAYS * day);
  const [{ results: asked }, { results: posts }, fit] = await Promise.all([
    env.DB.prepare(`SELECT m.person, m.at, ${ENTRY} FROM mentions m
      JOIN threads t ON t.thread = m.thread
      WHERE m.person IN (SELECT value FROM json_each(?)) AND m.at >= ?`).bind(list, since).all(),
    env.DB.prepare(`SELECT x.person, x.at, ${ENTRY} FROM messages x
      JOIN threads t ON t.thread = x.thread
      WHERE x.person IN (SELECT value FROM json_each(?)) AND x.at >= ? AND x.deleted = 0`)
      .bind(list, since).all(),
    responseModel(env, now),
  ]);
  const seen = new Map();
  for (const m of asked || []) {
    const so = seen.get(m.person) || { mentions: 0, answered: 0 };
    so.mentions += 1;
    if ((posts || []).some((x) => x.person === m.person && x.entry === m.entry && x.at > m.at)) {
      so.answered += 1;
    }
    seen.set(m.person, so);
  }
  return new Map(people.map((person) => [person, {
    minutes: fit ? Math.round(predict(fit, { person, channel, at: now })) : null,
    joins: fit ? fit.people.get(person) || 0 : 0,
    answered: 0,
    mentions: 0,
    ...seen.get(person),
  }]));
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

/** Whether a response time says something: enough answers, and most mentions answered. */
const reliable = (r) => Boolean(r) && r.joins >= MIN_ANSWERS
  && (!r.mentions || r.answered / r.mentions >= MIN_RATE);

/** What to say about someone: `reasons`, the strongest first. */
export function reasonsOf(e) {
  const reasons = [];
  if (e.topic) {
    reasons.push('knows about this topic');
  }
  const similar = e.similar && e.similar.threads;
  if (similar) {
    reasons.push(`worked on ${similar} similar ${similar === 1 ? 'thread' : 'threads'}`);
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

/**
 * Candidates' accounts on the thread's platform, by person; other people cannot be mentioned.
 * Of a person's several, their account for the thread (src/accounts.js): the signals are the
 * person's, from all of their accounts, and go to that one.
 */
async function accounts(env, t, people, now) {
  const [{ results }, reached] = await Promise.all([
    env.DB.prepare(`SELECT i.user_id AS id, i.person, ${NAME} AS name,
        i.avatar, MAX(COALESCE(p.staff, 0), COALESCE(i.staff, 0)) AS staff
      ${ACCOUNTS} AND i.person IN (SELECT value FROM json_each(?))`)
      .bind(t.source, t.tenant, JSON.stringify(people)).all(),
    keptAccounts(env, t, { people, now }),
  ]);
  const out = new Map();
  for (const r of results || []) {
    if (r.staff && (!out.has(r.person) || kept(reached, r.id) === r.id)) {
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

/** Adobe people's messages in an entry that say the team has it in hand (`inHand`). */
export const IN_HAND = 3;

/**
 * Whether Adobe has the entry in hand: staff wrote IN_HAND messages in it (a first answer
 * may only say who will look). Then its own people are the ones to ask, and the finder only
 * says more when `me` was mentioned and has not posted since (they may be looking for whom to
 * hand it to). Agents' suggestions still show.
 */
async function inHand(env, threads, me) {
  const list = JSON.stringify(threads);
  const of = 'thread IN (SELECT value FROM json_each(?))';
  // `answered`: a post of mine since I was last asked, not an early reply before someone handed
  // the thread to me.
  const asked = `SELECT MAX(at) FROM mentions WHERE ${of} AND person = ?`;
  const row = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM messages WHERE ${of} AND staff = 1 AND counted = 1 AND deleted = 0)
        AS staff,
      (${asked}) AS askedMe,
      EXISTS (SELECT 1 FROM messages WHERE ${of} AND person = ? AND deleted = 0
        AND at > COALESCE((${asked}), '')) AS answered`)
    .bind(list, list, me, list, me, list, me).first();
  if (!row || row.staff < IN_HAND) {
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

/** What someone's similar threads say (`bySimilar`), for the reasons: names and dates only. */
function workedOn(worked, index) {
  if (!worked) {
    return null;
  }
  return {
    threads: worked.threads.length,
    last: worked.last,
    topics: topicsOfThreads(index, worked.threads.map((thread) => ({ thread })))
      .map((t) => t.label),
  };
}

/**
 * The people of an entry's list, best first, without what is the viewer's alone, and the topics
 * of the topic map its similar threads are in: `{ list, topics }`. With `about`, the vectors and
 * words go by that instead of the thread's own (an agent's description of it).
 */
async function rank(env, t, rows, now, { about = null } = {}) {
  const threads = rows.map((r) => r.thread);
  const since = iso(now - WINDOW_DAYS * day);
  const title = about || rows.map((r) => r.title).find(Boolean);
  const vector = await entryVector(env, rows, about).catch((e) => {
    console.log(JSON.stringify({ route: 'experts', signal: 'vector', error: e.message }));
    return null;
  });
  const near = await similarThreads(env, vector, { threads }).catch((e) => {
    console.log(JSON.stringify({ route: 'experts', signal: 'similar', error: e.message }));
    return [];
  });
  const [channel, customer, meaning, words, similar, index] = await Promise.all([
    quietly('channel', workedIn(env, 'FROM messages m', 'm.source = ? AND m.tenant = ? AND m.channel_id = ?', [t.source, t.tenant, t.channel_id], threads, since)),
    t.org && !t.org.startsWith('_')
      ? quietly('customer', workedIn(env, 'FROM messages m JOIN threads t ON t.thread = m.thread', "t.org = ? AND t.kind <> 'alert'", [t.org], threads, since))
      : new Map(),
    quietly('meaning', byMeaning(env, rows, threads, vector)),
    quietly('words', byWords(env, title, threads)),
    bySimilar(env, near).catch((e) => {
      console.log(JSON.stringify({ route: 'experts', signal: 'similar', error: e.message }));
      return { people: new Map(), worked: new Map() };
    }),
    topicIndex(env, { now }),
  ]);
  const topics = topicsOfThreads(index, near);
  const found = {
    channel, customer, meaning, words, similar: similar.people,
  };
  const signals = Object.fromEntries(Object.entries(found).map(([k, m]) => [k, scaled(m)]));
  const people = [...new Set(Object.values(signals).flatMap((m) => [...m.keys()]))];
  const inThread = await inEntry(env, threads);
  const open = people.filter((p) => !inThread.has(p));
  if (!open.length) {
    return { list: [], topics };
  }
  const [known, recent] = await Promise.all([accounts(env, t, open, now), active(env, open, now)]);
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
      similar: of('similar') >= TOPIC ? workedOn(similar.worked.get(person), index) : null,
      channel: of('channel') > 0,
      customer: of('customer') > 0,
      score: score * (member === false ? OUTSIDE : 1),
      // Each signal scaled, as it is added up, and as it was found (threads; affinity; BM25;
      // what the closest threads have over the weakest).
      signals: {
        channel: of('channel'),
        customer: of('customer'),
        meaning: of('meaning'),
        words: of('words'),
        similar: of('similar'),
        channelThreads: raw('channel'),
        customerThreads: raw('customer'),
        meaningRaw: raw('meaning'),
        wordsRaw: raw('words'),
        similarRaw: raw('similar'),
        similarThreads: (similar.worked.get(person) || { threads: [] }).threads.length,
      },
    };
  }).sort((a, b) => b.score - a.score).slice(0, MAX_MEASURED);
  const times = await responseTimes(env, ranked.map((e) => e.person), {
    channel: `${t.source}:${t.tenant}:${t.channel_id}`, now,
  });
  return { list: ranked.map((e) => ({ ...e, response: times.get(e.person) || null })), topics };
}

/**
 * The agents' suggestions on an entry that still stand: they are not in it yet. Each person
 * once, the latest, by their account for the thread (src/accounts.js), whichever of theirs the
 * agent named.
 */
async function suggested(env, t, keys, threads, now = Date.now()) {
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
  const [inThread, reached] = await Promise.all([
    inEntry(env, threads),
    keptAccounts(env, t, { ids: results.map((r) => r.id), now }),
  ]);
  const moved = results.filter((r) => !inThread.has(r.person))
    .map((r) => ({ ...r, id: kept(reached, r.id), named: r.id }));
  const ids = [...new Set(moved.filter((r) => r.id !== r.named).map((r) => r.id))];
  // The name and picture of an account the agent did not name.
  const { results: shown } = ids.length ? await env.DB.prepare(`SELECT i.user_id AS id,
      ${NAME} AS name, i.avatar ${ACCOUNTS} AND i.user_id IN (SELECT value FROM json_each(?))`)
    .bind(t.source, t.tenant, JSON.stringify(ids)).all() : { results: [] };
  const looks = new Map((shown || []).map((r) => [r.id, r]));
  const seen = new Set();
  return moved.filter((r) => {
    const who = r.person ?? r.id;
    if (seen.has(who)) {
      return false;
    }
    seen.add(who);
    return true;
  }).map(({ named: _, ...r }) => ({ ...r, ...(looks.get(r.id) || {}) }));
}

/**
 * The accounts person `me` said are not the right ones for the entry (`rejectedBy`), with each
 * one's person's account for the thread: whichever of theirs was on the list, it was them.
 */
async function rejectedAccounts(env, t, me, keys, now) {
  const said = await rejectedBy(env, me, keys).catch(() => new Set());
  if (!said.size) {
    return said;
  }
  const reached = await keptAccounts(env, t, { ids: [...said], now }).catch(() => new Map());
  return new Set([...said].flatMap((id) => [id, kept(reached, id)]));
}

/** Whether a list entry and an agent's suggestion are one person. */
const same = (e, s) => e.id === s.id || (e.person !== null && e.person !== undefined
  && e.person === s.person);

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
    ...(e.similar ? { similar: e.similar } : {}),
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
      rejected: Number(Boolean(e.rejected)),
      ...(r ? { mentioned: r.mentions, answered: r.answered } : {}),
      ...(r && r.minutes !== null ? { responseMinutes: r.minutes } : {}),
    },
  };
}

/**
 * The experts of inbox entry `key`, best first, agents' suggestions before the others, as
 * `{ platform, experts, candidates }`, or null when there is no such entry: `candidates` are
 * all that were ranked, in the same order, as the training records them (`candidate`). `me`
 * (a person id) is left out, and so is whom they said is not the right person for it (a
 * candidate still, `rejected`). With `whenNeeded` (the inbox's header), only agents'
 * suggestions while Adobe has the entry in hand (`inHand`), and `held` says so; the candidates
 * are all of them still, for the training to see whom the team pulled in anyway. `topics` are
 * the topic map's topics the entry's closest threads are in (src/topicindex.js). With `about`
 * (a thread agent's words for what the entry is about), the vectors and words go by that. Never
 * throws for a signal that fails.
 */
export async function findExperts(env, key, {
  me = null, now = Date.now(), whenNeeded = false, about = null,
} = {}) {
  const t = key && await target(env, key);
  const rows = t ? await entryRows(env, key) : [];
  if (!rows.length) {
    return null;
  }
  const threads = rows.map((r) => r.thread);
  const said = String(about || '').replace(/\s+/g, ' ').trim() || null;
  const version = `${key}|${rows.map((r) => `${r.thread}:${r.embedded || r.title}`).join(',')}|${t.any_at}|${said || ''}`;
  let ranked = cache.get(version);
  if (!ranked || now - ranked.at >= CACHE_MS) {
    ranked = { at: now, ...await rank(env, t, rows, now, { about: said }) };
    cache.delete(version);
    cache.set(version, ranked);
    while (cache.size > CACHE_MAX) {
      cache.delete(cache.keys().next().value);
    }
  }
  const keys = [...new Set([key, ...threads])];
  const [pins, rejected] = await Promise.all([
    suggested(env, t, keys, threads, now),
    rejectedAccounts(env, t, me, keys, now),
  ]);
  const others = ranked.list.filter((e) => e.person !== me && !pins.some((s) => same(e, s)));
  const mine = pins.filter((s) => s.person !== me);
  const members = await membersOf(env, t, mine.map((s) => s.id));
  const pinned = mine.map((s) => {
    const e = ranked.list.find((x) => same(x, s));
    return { ...e, ...s, member: inChannel(members, s.id, Boolean(e && e.member)) };
  });
  // Who `me` said is not the right person stays out of what is shown, not of what is recorded.
  const all = [...pinned, ...others]
    .map((e) => (rejected.has(e.id) ? { ...e, rejected: true } : e));
  const held = whenNeeded && others.length > 0 && await inHand(env, threads, me)
    .catch(() => false);
  return {
    platform: t.source,
    // Held back, only agents' suggestions (they have a reason).
    experts: all.filter((e) => !e.rejected && (!held || e.reason)).slice(0, MAX_EXPERTS)
      .map(shape),
    candidates: all.map(candidate),
    topics: ranked.topics,
    ...(held ? { held: true } : {}),
  };
}

/**
 * The thread agents' suggestions for inbox entry `key` alone, as `{ platform, experts }`, or null
 * when there is no such entry: what the inbox's header shows, as the finder's own ranking is not
 * shown (docs/ARCHITECTURE.md, "Expert finder"). Nothing is ranked or recorded. `me` (a person
 * id) is left out, and so is whom they said is not the right person for the entry.
 */
export async function agentSuggestions(env, key, { me = null } = {}) {
  const t = key && await target(env, key);
  const rows = t ? await entryRows(env, key) : [];
  if (!rows.length) {
    return null;
  }
  const threads = rows.map((r) => r.thread);
  const keys = [...new Set([key, ...threads])];
  const [pins, rejected] = await Promise.all([
    suggested(env, t, keys, threads),
    rejectedAccounts(env, t, me, keys, Date.now()),
  ]);
  const mine = pins.filter((s) => s.person !== me && !rejected.has(s.id));
  const members = mine.length ? await membersOf(env, t, mine.map((s) => s.id)) : null;
  return {
    platform: t.source,
    experts: mine.slice(0, MAX_EXPERTS)
      .map((s) => shape({ ...s, member: inChannel(members, s.id, false) })),
  };
}

/**
 * GET /api/experts?thread=…: the thread's expert finder. It lists the channel's members in the
 * background when that is a week old, as the mention suggestions do, for what it says of them.
 * The list is recorded for the viewer (src/expertevents.js), and `list` is its id, for what
 * the page then says of it; not while viewing as someone else. With `suggested` (the inbox's
 * header), only the thread agents' suggestions (`agentSuggestions`), unrecorded.
 */
export async function experts(env, key, canSee, { me, waitUntil, suggestedOnly = false } = {}) {
  const e = await entryOf(env, key);
  if (!e || !await canSee(e.teams, e)) {
    return json({ error: 'not found' }, 404);
  }
  if (suggestedOnly) {
    return json(await agentSuggestions(env, e.key, { me: me ? me.id : null }));
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
  // The topics are the agents': the page shows none.
  const { candidates, held } = found;
  const body = { platform: found.platform, experts: found.experts };
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
  const t = await target(env, key);
  // A person's accounts are one suggestion, kept as their account for the thread.
  const { results: theirs } = await env.DB.prepare(`SELECT user_id FROM identities
    WHERE source = ?1 AND tenant = ?2 AND (user_id = ?3 OR person = (SELECT person FROM identities
      WHERE source = ?1 AND tenant = ?2 AND user_id = ?3))`)
    .bind(t.source, t.tenant, account).all();
  const accountsOf = JSON.stringify([
    ...new Set([account, ...(theirs || []).map((r) => r.user_id)]),
  ]);
  const forget = () => env.DB.prepare(`DELETE FROM expert_suggestions
    WHERE user_id IN (SELECT value FROM json_each(?))
      AND thread IN (SELECT value FROM json_each(?))`).bind(accountsOf, JSON.stringify(e.keys)).run();
  if (withdraw) {
    await forget();
    await notifyRoom(env, e.teams, { type: 'experts', thread: e.key });
    return { ok: true };
  }
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
  if (!why) {
    return { error: 'say why: the reason is what the team reads' };
  }
  const person = await env.DB.prepare(`SELECT i.person, ${NAME} AS name,
      MAX(COALESCE(p.staff, 0), COALESCE(i.staff, 0)) AS staff
    ${ACCOUNTS} AND i.user_id = ?`).bind(t.source, t.tenant, account).first();
  if (!person || !person.staff) {
    return { error: `${account} is not an Adobe colleague on this platform: use an id from list_experts` };
  }
  const { results } = await env.DB.prepare(`SELECT user_id FROM expert_suggestions
    WHERE thread IN (SELECT value FROM json_each(?))
      AND user_id NOT IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(e.keys), accountsOf).all();
  if ((results || []).length >= MAX_SUGGESTED) {
    return { error: `this thread has ${MAX_SUGGESTED} suggestions already: withdraw one first` };
  }
  const chosen = kept(await keptAccounts(env, t, { ids: [account] }), account);
  await forget();
  await env.DB.prepare(`INSERT INTO expert_suggestions (thread, user_id, reason, by, at)
    VALUES (?, ?, ?, ?, ?)`).bind(e.key, chosen, why, by, new Date().toISOString()).run();
  await notifyRoom(env, e.teams, { type: 'experts', thread: e.key });
  return { ok: true, name: person.name };
}

/** People a topic's list has at most (`topicExperts`). */
export const MAX_TOPIC_PEOPLE = 10;

/**
 * The topics of the newest topic map (src/topicmap.js), the biggest first: `{ built_at, topics:
 * [{ id, label, theme, size }] }`, or null when there is none.
 */
export async function listTopics(env, { now = Date.now() } = {}) {
  const index = await topicIndex(env, { now });
  if (!index) {
    return null;
  }
  return {
    built_at: index.built_at,
    topics: [...index.topics.values()].sort((a, b) => b.size - a.size).map((t) => ({
      id: t.id, label: t.label, theme: t.theme, size: t.size,
    })),
  };
}

/**
 * Who worked the threads of topic `name` (a topic map's label, or its id) and could be pulled into
 * inbox entry `key`: `{ topic: { id, label, theme, size }, people: [{ id, name, threads, last,
 * member }] }`, the most threads first, or `{ error }`. Like the finder, it leaves out who is in
 * the entry, `me`, who has not posted for ACTIVE_DAYS and who has no account on its platform.
 */
export async function topicExperts(env, key, name, { me = null, now = Date.now() } = {}) {
  const index = await topicIndex(env, { now });
  if (!index) {
    return { error: 'there is no topic map yet' };
  }
  const topic = findTopic(index, name);
  if (!topic) {
    return { error: `no topic is called ${JSON.stringify(String(name || ''))}: list_topics without a topic lists them` };
  }
  const t = key && await target(env, key);
  const rows = t ? await entryRows(env, key) : [];
  if (!rows.length) {
    return { error: 'no such thread' };
  }
  const inThread = await inEntry(env, rows.map((r) => r.thread));
  const open = [...topic.people.keys()].filter((p) => p !== me && !inThread.has(p));
  const [known, recent] = open.length
    ? await Promise.all([accounts(env, t, open, now), active(env, open, now)])
    : [new Map(), new Set()];
  const listed = open.filter((p) => known.has(p) && recent.has(p))
    .sort((a, b) => topic.people.get(b).threads - topic.people.get(a).threads
      || String(topic.people.get(b).last).localeCompare(String(topic.people.get(a).last)))
    .slice(0, MAX_TOPIC_PEOPLE);
  const members = listed.length
    ? await membersOf(env, t, listed.map((p) => known.get(p).id)) : null;
  return {
    topic: {
      id: topic.id, label: topic.label, theme: topic.theme, size: topic.size,
    },
    people: listed.map((p) => {
      const a = known.get(p);
      const { threads, last } = topic.people.get(p);
      return {
        id: a.id, name: a.name, threads, last, member: inChannel(members, a.id, false),
      };
    }),
  };
}

/** Forgets the kept lists and the response model (tests). */
export function clearExpertLists() {
  cache.clear();
  model = null;
}
