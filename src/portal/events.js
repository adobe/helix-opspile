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
 * The portal's outbox: what happened in it, for the inbox, which reads the portal as it reads
 * Slack's events (src/portalsource.js). An event is written to `events` with what it tells of
 * (`emit`), then delivered through the `OPSPILE` binding (`deliver`): after the request that
 * made it, and by the cron for what that left. Delivery is at least once, in order of `seq`
 * within a batch; the inbox keys each event by its `seq`, so one delivered twice is one.
 *
 * Every event carries what the inbox needs to file it without asking back: the channel's name
 * and the author's name and mail address, as they were then.
 *
 * ```
 * { portal, seq, at, type: 'message' | 'reaction' | 'channel' | 'lobby', domain,
 *   channel?: { id, name, topic, company }, author?: { id, name, email, kind },
 *   message?: { id, root, rev, at, editedAt?, deletedAt?, text, permalink },
 *   reaction?: { message, root, emoji, removed, at },
 *   lobby?: { company, tech, note, status, requestedBy, requestedAt, members } }
 * ```
 */

/** Events sent to the inbox in one call. */
const BATCH = 50;
/** One delivery sends at most this many batches; the cron takes the rest. */
const MAX_BATCHES = 4;

/** The name this portal's events carry (`PORTAL_NAME`), which the inbox keys them under. */
export const portalName = (env) => String(env.PORTAL_NAME || 'portal')
  .replace(/[^a-z0-9-]/gi, '').slice(0, 32) || 'portal';

/** The statement that writes an event, for the batch that writes what it tells of. */
export function eventStatement(env, event, now = new Date()) {
  return env.DB.prepare('INSERT INTO events (body, at) VALUES (?, ?)')
    .bind(JSON.stringify(event), now.toISOString());
}

/** Writes one event on its own. */
export async function emit(env, event, now = new Date()) {
  await eventStatement(env, event, now).run();
}

/**
 * Sends the events not delivered yet to the inbox, oldest first. `{ result, sent }`:
 * `unbound` without the inbox's binding (the events wait), `failed` when it did not take them
 * (they are tried again, and `error` says why).
 */
export async function deliver(env, now = new Date()) {
  if (!env.OPSPILE) {
    return { result: 'unbound', sent: 0 };
  }
  let sent = 0;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { results } = await env.DB.prepare(`SELECT seq, body, at FROM events
      WHERE delivered_at IS NULL ORDER BY seq LIMIT ?`).bind(BATCH).all();
    const rows = results || [];
    if (!rows.length) {
      break;
    }
    const seqs = JSON.stringify(rows.map((r) => r.seq));
    const events = rows.map((r) => ({
      ...JSON.parse(r.body), portal: portalName(env), seq: r.seq, at: r.at,
    }));
    try {
      // eslint-disable-next-line no-await-in-loop
      await env.OPSPILE.events(events);
    } catch (e) {
      // eslint-disable-next-line no-await-in-loop
      await env.DB.prepare(`UPDATE events SET attempts = attempts + 1, error = ?
        WHERE seq IN (SELECT value FROM json_each(?))`)
        .bind(String(e.message || e).slice(0, 300), seqs).run();
      return { result: 'failed', sent, error: e.message };
    }
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare(`UPDATE events SET delivered_at = ?, error = NULL
      WHERE seq IN (SELECT value FROM json_each(?))`).bind(now.toISOString(), seqs).run();
    sent += rows.length;
    if (rows.length < BATCH) {
      break;
    }
  }
  return { result: 'delivered', sent };
}

/** Delivered events older than this are deleted: the inbox has them, in its pile 1. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Deletes the delivered events of more than a week ago. */
export async function pruneEvents(env, now = Date.now()) {
  const { meta } = await env.DB.prepare(`DELETE FROM events WHERE delivered_at IS NOT NULL
    AND delivered_at < ?`).bind(new Date(now - KEEP_MS).toISOString()).run();
  return { deleted: meta.changes || 0 };
}
