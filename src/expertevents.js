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
 * What the expert finder showed and what people did with it (`expert_events`, migration 0047),
 * for a better finder to learn from (docs/ARCHITECTURE.md, "Expert finder"). GET /api/experts
 * records the `list` it computed, every candidate with its signals, and answers with its id;
 * the page then says, about that list, `POST /api/experts/event`: `shown` (on screen in the open
 * thread), `open` (▾), `pick` (someone, by account), `dismiss` (the ▾ list closed with nobody
 * picked: the strongest "none of these") and `reject` (someone, by account, is not the right
 * person: the finder leaves them out of the viewer's lists of that thread from then on).
 * `GET /api/experts/events` gives them to the admin team's training (`npm run rank -- experts`),
 * page by page; the cron deletes those older than EXPERT_EVENTS_DAYS, as for the team order's
 * picks (src/rankevents.js).
 */

export const ACTIONS = ['shown', 'open', 'pick', 'dismiss', 'reject'];
/** Actions about one person on a list, by account. */
const ABOUT = ['pick', 'reject'];
export const EVENTS_PAGE = 500;
/** How long events are kept in D1, and how many the cron deletes in a run at most. */
export const EXPERT_EVENTS_DAYS = 90;
const PRUNE_LIMIT = 5000;
const MAX_CANDIDATES = 40;
const MAX_FEATURES = 40;
const MAX_KEY = 300;

const key = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_KEY;

/** A candidate's features: finite numbers by name, rounded; the others are left out. */
function cleanFeatures(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {}).slice(0, MAX_FEATURES)) {
    if (/^[A-Za-z_]\w{0,40}$/.test(k) && typeof v === 'number' && Number.isFinite(v)) {
      out[k] = Math.round(v * 10000) / 10000;
    }
  }
  return out;
}

/**
 * Records the list the finder computed for `me` on entry `thread` (`candidates` of
 * src/experts.js, best first) and answers with its id, or null when there is nothing to record.
 */
export async function recordList(env, me, thread, { finder, candidates }, now = new Date()) {
  if (!me || !me.id || me.readonly || !key(thread) || !candidates || !candidates.length) {
    return null;
  }
  const data = {
    finder,
    candidates: candidates.slice(0, MAX_CANDIDATES).map((c, pos) => ({
      id: c.id, person: c.person, pos, features: cleanFeatures(c.features),
    })),
  };
  const row = await env.DB.prepare(`INSERT INTO expert_events (person, at, thread, action, data)
    VALUES (?, ?, ?, 'list', ?) RETURNING id`)
    .bind(me.id, now.toISOString(), thread, JSON.stringify(data)).first();
  return row ? row.id : null;
}

/** Checks an event of the page's: `{ list, action, account? }`. Returns it, or `{ error }`. */
export function cleanExpertEvent(body) {
  const { list, action, account } = body || {};
  if (!Number.isInteger(list) || list <= 0 || !ACTIONS.includes(action)) {
    return { error: `an event needs a list and one of ${ACTIONS.join(', ')}` };
  }
  if (ABOUT.includes(action) && !key(account)) {
    return { error: `a ${action} needs the account` };
  }
  return { list, action, ...(ABOUT.includes(action) ? { account } : {}) };
}

/**
 * Records an event of `me`'s about one of their lists; a pick only of someone on it, at the
 * place the list gave them, so a stray client cannot feed the training made-up lists or people.
 */
export async function recordExpertEvent(env, me, body, now = new Date()) {
  const ev = cleanExpertEvent(body);
  if (ev.error) {
    return ev;
  }
  const list = await env.DB.prepare(`SELECT thread, data FROM expert_events
    WHERE id = ? AND person = ? AND action = 'list'`).bind(ev.list, me.id).first();
  if (!list) {
    return { error: 'no such list of yours' };
  }
  let pos = null;
  if (ABOUT.includes(ev.action)) {
    const c = JSON.parse(list.data).candidates.find((x) => x.id === ev.account);
    if (!c) {
      return { error: 'not on that list' };
    }
    pos = c.pos;
  }
  await env.DB.prepare(`INSERT INTO expert_events (person, at, thread, action, list, account, pos)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(me.id, now.toISOString(), list.thread, ev.action, ev.list, ev.account || null, pos)
    .run();
  return { ok: true };
}

/** The accounts person `me` said are not the right ones for entry `keys` (its threads too). */
export async function rejectedBy(env, me, keys) {
  if (!me) {
    return new Set();
  }
  const { results } = await env.DB.prepare(`SELECT DISTINCT account FROM expert_events
    WHERE person = ? AND action = 'reject' AND thread IN (SELECT value FROM json_each(?))`)
    .bind(me, JSON.stringify(keys)).all();
  return new Set((results || []).map((r) => r.account));
}

/** The events after `since` (an id), oldest first, a page at a time; `next` when there are more. */
export async function expertEvents(env, since = 0, limit = EVENTS_PAGE) {
  const size = Math.max(1, Math.min(EVENTS_PAGE, Number(limit) || EVENTS_PAGE));
  const { results } = await env.DB.prepare(`SELECT id, person, at, thread, action, list, account,
      pos, data FROM expert_events WHERE id > ? ORDER BY id LIMIT ?`)
    .bind(Number(since) || 0, size + 1).all();
  const rows = results || [];
  const more = rows.length > size;
  const page = rows.slice(0, size).map(({ data, ...r }) => Object.fromEntries(
    Object.entries({ ...r, ...(data ? JSON.parse(data) : {}) }).filter(([, v]) => v !== null),
  ));
  return { events: page, next: more ? page[page.length - 1].id : null };
}

/** Deletes events older than `days`, oldest first, at most `limit` a run. */
export async function pruneExpertEvents(env, now = new Date(), {
  days = EXPERT_EVENTS_DAYS, limit = PRUNE_LIMIT,
} = {}) {
  const before = new Date(now.getTime() - days * 86400000).toISOString();
  const res = await env.DB.prepare(`DELETE FROM expert_events WHERE id IN (
      SELECT id FROM expert_events WHERE at < ? ORDER BY id LIMIT ?)`).bind(before, limit).run();
  return { deleted: res.meta?.changes ?? 0, before };
}
