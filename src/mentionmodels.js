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

import { ACTIVITY_DAYS, fitMentions, WINDOW_DAYS } from './mention-model.js';

/**
 * The mention model (src/mention-model.js) in D1, `mention_models`: fit by the cron once the
 * newest is STALE_HOURS old, read by the expert finder, which keeps it per isolate for KEEP_MS.
 * `npm run response:backtest` runs the same queries.
 */

const HOUR = 60 * 60 * 1000;
export const STALE_HOURS = 24;
/** Models kept in D1, the newest first. */
const KEPT = 3;
/** How long an isolate keeps the model it read. */
const KEEP_MS = HOUR;

/** Counted messages of the window, a re-threaded group as one entry. `?1`: from (ISO). */
export const ROWS_SQL = `SELECT COALESCE(t.logical_thread, t.thread) AS entry,
    x.source || ':' || x.tenant || ':' || x.channel_id AS channel, x.at, x.staff, x.person, t.team
  FROM messages x JOIN threads t ON t.thread = x.thread
  WHERE x.at >= ?1 AND x.counted = 1 AND x.deleted = 0`;

/** Mentions of the window, and whether the person is Adobe's. `?1`: from (ISO). */
export const MENTIONS_SQL = `SELECT m.person, m.at, m.message,
    COALESCE(t.logical_thread, t.thread) AS entry,
    t.source || ':' || t.tenant || ':' || t.channel_id AS channel, COALESCE(p.staff, 0) AS staff
  FROM mentions m JOIN threads t ON t.thread = m.thread LEFT JOIN people p ON p.id = m.person
  WHERE m.at >= ?1`;

export const MEMBERS_SQL = 'SELECT team, person FROM team_members';

const parse = (rows) => (rows || []).map((r) => ({ ...r, at: Date.parse(r.at) }));

/** Where the posts and the mentions a model of `now` learns from start (ISO). */
export function windowOf(now) {
  const ago = (days) => new Date(now - days * 24 * HOUR).toISOString();
  return { posts: ago(WINDOW_DAYS + ACTIVITY_DAYS), mentions: ago(WINDOW_DAYS) };
}

/**
 * Fits the model of the mentions of the WINDOW_DAYS before `now` and keeps it: `{ built,
 * mentions, answered }`.
 */
export async function buildMentionModel(env, now = Date.now()) {
  const from = windowOf(now);
  const [{ results: rows }, { results: mentions }, { results: members }] = await Promise.all([
    env.DB.prepare(ROWS_SQL).bind(from.posts).all(),
    env.DB.prepare(MENTIONS_SQL).bind(from.mentions).all(),
    env.DB.prepare(MEMBERS_SQL).all(),
  ]);
  const model = fitMentions(parse(rows), parse(mentions), members || [], { now });
  // Without a mention to learn from, an empty model is kept all the same: the next cron runs
  // do not read the year again until it is a day old.
  const built = model ? model.at : new Date(now).toISOString();
  await env.DB.prepare(`INSERT INTO mention_models (built_at, mentions, answered, model)
    VALUES (?, ?, ?, ?)`).bind(
    built,
    model ? model.mentions : 0,
    model ? model.answered : 0,
    JSON.stringify(model),
  ).run();
  await env.DB.prepare(`DELETE FROM mention_models WHERE id NOT IN
    (SELECT id FROM mention_models ORDER BY built_at DESC LIMIT ${KEPT})`).run();
  return {
    built, mentions: model ? model.mentions : 0, answered: model ? model.answered : 0,
  };
}

/** Cron: fits the model when the newest is STALE_HOURS old, or there is none. */
export async function sweepMentionModel(env, now = Date.now()) {
  const row = await env.DB.prepare('SELECT MAX(built_at) AS at FROM mention_models').first();
  if (row && row.at && now - Date.parse(row.at) < STALE_HOURS * HOUR) {
    return { fresh: row.at };
  }
  return buildMentionModel(env, now);
}

let kept = null;

/**
 * The newest model, or null before the first or when it is empty; read again once an isolate
 * kept it KEEP_MS.
 */
export async function mentionModel(env, now = Date.now()) {
  if (kept && now - kept.read < KEEP_MS) {
    return kept.model;
  }
  const row = await env.DB.prepare(`SELECT model FROM mention_models
    ORDER BY built_at DESC LIMIT 1`).first();
  kept = { read: now, model: row ? JSON.parse(row.model) : null };
  return kept.model;
}

/** Forgets the model an isolate kept (tests). */
export function clearMentionModel() {
  kept = null;
}
