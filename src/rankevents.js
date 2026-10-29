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
 * What people pick in the thread list (`rank_events`, migration 0040), for the team order to
 * learn from: `POST /api/rank/pick` when someone opens a thread by clicking it in the list,
 * with the threads on screen then and their features; `GET /api/rank/events` gives them to
 * the admin team's training (scripts/rank.mjs), page by page.
 */

export const MAX_SHOWN = 60;
const MAX_FEATURES = 80;
const MAX_KEY = 300;
export const EVENTS_PAGE = 500;

const key = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_KEY;

/** The features of a thread as sent: finite numbers by name, rounded, or null when not that. */
function cleanFeatures(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) {
    return null;
  }
  const out = {};
  const entries = Object.entries(f);
  if (entries.length > MAX_FEATURES) {
    return null;
  }
  for (const [k, v] of entries) {
    if (!/^[A-Za-z_][\w]{0,40}$/.test(k) || typeof v !== 'number' || !Number.isFinite(v)) {
      return null;
    }
    out[k] = Math.round(v * 10000) / 10000;
  }
  return out;
}

/**
 * Checks a pick: `{ view, clicked, shown: [{ thread, pos, features }], model }`, the clicked
 * thread among those shown. Returns the row to keep, or `{ error }`.
 */
export function cleanPick(body) {
  const {
    view, clicked, shown, model,
  } = body || {};
  if (!key(view) || !key(clicked) || !Array.isArray(shown) || !shown.length
    || shown.length > MAX_SHOWN) {
    return { error: 'a pick needs a view, the clicked thread and the threads shown' };
  }
  const list = [];
  const seen = new Set();
  for (const s of shown) {
    const features = cleanFeatures(s?.features);
    if (!s || !key(s.thread) || seen.has(s.thread) || !Number.isInteger(s.pos) || s.pos < 0
      || !features) {
      return { error: 'each thread shown needs its key, its place and its features' };
    }
    seen.add(s.thread);
    list.push({ thread: s.thread, pos: s.pos, features });
  }
  if (!seen.has(clicked)) {
    return { error: 'the clicked thread is not among those shown' };
  }
  if (list.length < 2) {
    return { error: 'nothing to compare the pick with' };
  }
  return {
    view, clicked, shown: list, model: typeof model === 'string' ? model.slice(0, 40) : null,
  };
}

export async function recordPick(env, me, body, now = new Date()) {
  const pick = cleanPick(body);
  if (pick.error) {
    return pick;
  }
  await env.DB.prepare(`INSERT INTO rank_events (person, at, view, clicked, shown, model)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(me.id, now.toISOString(), pick.view, pick.clicked, JSON.stringify(pick.shown), pick.model)
    .run();
  return { ok: true };
}

/** The picks after `since` (an id), oldest first, a page at a time; `next` when there are more. */
export async function rankEvents(env, since = 0, limit = EVENTS_PAGE) {
  const size = Math.max(1, Math.min(EVENTS_PAGE, Number(limit) || EVENTS_PAGE));
  const { results } = await env.DB.prepare(`SELECT id, person, at, view, clicked, shown, model
    FROM rank_events WHERE id > ? ORDER BY id LIMIT ?`).bind(Number(since) || 0, size + 1).all();
  const rows = results || [];
  const more = rows.length > size;
  const page = rows.slice(0, size).map((r) => ({ ...r, shown: JSON.parse(r.shown) }));
  return { events: page, next: more ? page[page.length - 1].id : null };
}
