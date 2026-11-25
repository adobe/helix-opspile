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

import { entryOf } from './drafts.js';
import { currentApp, github } from './github.js';
import { agentStub } from './agent/stub.js';
import {
  forgetWatched, githubChanges, githubNow, githubRef,
} from './agent/watches.js';

/**
 * The Worker's side of what thread agents watch (src/agent/watches.js has the agents' side, the
 * tools, and what they are told): a watched thread's new messages (the `{ watched }` queue job),
 * the GitHub items polled by the cron (`WATCH_CRON`), and watches that ran out. Each wakes the
 * watching agent through its object (`watchUpdate`).
 */

const POLL_EVERY_MS = 4 * 60 * 1000;
const MAX_POLL = 30;

/** Tells the watching agent of watch `w` about `change`, in its own object. */
async function tell(env, w, change) {
  if (!env.AGENTS) {
    return;
  }
  try {
    const agent = await agentStub(env, w.watcher);
    await agent.watchUpdate({
      watch: {
        id: w.id, kind: w.kind, target: w.target, url: w.url, why: w.why, set_at: w.set_at,
      },
      change,
    });
  } catch (e) {
    console.error(JSON.stringify({
      route: 'agent', watch: 'tell failed', id: w.id, error: e.message,
    }));
  }
}

/**
 * Queue job `{ watched: thread }`: the watches of the thread's entry hear of its messages after
 * their `seen`, but the system's and Adobe's bots': who posted (names, and whether at Adobe), how
 * many, the latest when. Each watch once: `seen` moves only where it was what this job read, so
 * two jobs of one burst wake its agent once.
 */
export async function notifyWatched(env, thread, now = new Date()) {
  const entry = await entryOf(env, thread);
  if (!entry) {
    return { result: 'skip', reason: 'unknown thread' };
  }
  const { results: watches } = await env.DB.prepare(`SELECT * FROM agent_watches WHERE kind = 'thread'
    AND target IN (SELECT value FROM json_each(?)) AND expires_at > ?`)
    .bind(JSON.stringify(entry.keys), now.toISOString()).all();
  const place = (watches || []).length ? await env.DB.prepare('SELECT channel_name FROM threads WHERE thread = ?')
    .bind(entry.key).first() : null;
  let told = 0;
  for (const w of watches || []) {
    // eslint-disable-next-line no-await-in-loop
    const { results: rows } = await env.DB.prepare(`SELECT at, author, staff, author_kind FROM messages
      WHERE thread IN (SELECT value FROM json_each(?)) AND at > ? AND deleted = 0
        AND COALESCE(author_kind, 'person') != 'system'
        AND NOT (staff = 1 AND COALESCE(author_kind, 'person') = 'bot')
      ORDER BY at`).bind(JSON.stringify(entry.keys), w.seen || '').all();
    if (rows && rows.length) {
      const latest = rows[rows.length - 1].at;
      // eslint-disable-next-line no-await-in-loop
      const moved = await env.DB.prepare('UPDATE agent_watches SET seen = ? WHERE id = ? AND COALESCE(seen, \'\') = ?')
        .bind(latest, w.id, w.seen || '').run();
      if (moved.meta && moved.meta.changes) {
        const names = (staff) => [...new Set(rows.filter((r) => Boolean(r.staff) === staff)
          .map((r) => r.author).filter(Boolean))];
        // eslint-disable-next-line no-await-in-loop
        await tell(env, w, {
          type: 'thread',
          target: w.target,
          channel: (place && place.channel_name) || null,
          count: rows.length,
          adobe: rows.filter((r) => r.staff).length,
          adobeNames: names(true),
          others: rows.filter((r) => !r.staff).length,
          otherNames: names(false),
          since: w.seen || null,
          latest,
        });
        told += 1;
      }
    }
  }
  return { result: told ? 'told' : 'nothing new', watches: (watches || []).length, told };
}

/**
 * Cron (`WATCH_CRON`): each GitHub watch not polled for a few minutes, the oldest first: what
 * changed since its `seen` wakes its agent. Expired watches end, and their agents hear so.
 */
export async function pollWatches(env, now = new Date()) {
  if (!env.DB) {
    return { skipped: 'no DB' };
  }
  const at = now.toISOString();
  const { results: expired } = await env.DB.prepare('SELECT * FROM agent_watches WHERE expires_at <= ?')
    .bind(at).all();
  for (const w of expired || []) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare('DELETE FROM agent_watches WHERE id = ?').bind(w.id).run();
    // eslint-disable-next-line no-await-in-loop
    await tell(env, w, { type: 'expired' });
  }
  if ((expired || []).length) {
    forgetWatched();
  }
  const { results } = await env.DB.prepare(`SELECT * FROM agent_watches WHERE kind = 'github'
    AND (checked_at IS NULL OR checked_at < ?) ORDER BY checked_at LIMIT ?`)
    .bind(new Date(now.getTime() - POLL_EVERY_MS).toISOString(), MAX_POLL).all();
  const watches = results || [];
  if (!watches.length) {
    return { expired: (expired || []).length, polled: 0 };
  }
  const app = await currentApp(env).catch(() => null);
  let told = 0;
  let failed = 0;
  for (const w of watches) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare('UPDATE agent_watches SET checked_at = ? WHERE id = ?').bind(at, w.id).run();
    const ref = githubRef(w.url);
    if (!app || !ref) {
      failed += 1;
    } else {
      try {
        // eslint-disable-next-line no-await-in-loop
        const current = await githubNow(env, app, w.installation, ref);
        if (current.updated && current.updated !== w.seen) {
          const since = w.seen || w.set_at;
          // eslint-disable-next-line no-await-in-loop
          const [comments, reviews] = await Promise.all([
            github(`${current.base}/issues/${ref.number}/comments?since=${encodeURIComponent(since)}&per_page=50`, { token: current.token })
              .catch(() => []),
            current.state.type === 'pull'
              ? github(`${current.base}/pulls/${ref.number}/reviews?per_page=100`, { token: current.token }).catch(() => [])
              : [],
          ]);
          const was = JSON.parse(w.state || '{}');
          const lines = githubChanges(was, current.state, {
            comments: (comments || []).filter((c) => c.created_at > since)
              .map((c) => ({ by: (c.user && c.user.login) || 'someone', at: c.created_at })),
            reviews: (reviews || []).filter((r) => r.submitted_at && r.submitted_at > since)
              .map((r) => ({ by: (r.user && r.user.login) || 'someone', at: r.submitted_at, state: r.state })),
          });
          // eslint-disable-next-line no-await-in-loop
          const moved = await env.DB.prepare(`UPDATE agent_watches SET seen = ?, state = ?
            WHERE id = ? AND COALESCE(seen, '') = ?`)
            .bind(current.updated, JSON.stringify(current.state), w.id, w.seen || '').run();
          if (lines.length && moved.meta && moved.meta.changes) {
            // eslint-disable-next-line no-await-in-loop
            await tell(env, w, {
              type: 'github', target: w.target, title: current.state.title, item: current.state.type, lines, latest: current.updated,
            });
            told += 1;
          }
        }
      } catch (e) {
        failed += 1;
        console.error(JSON.stringify({
          route: 'cron', watch: 'github', id: w.id, error: e.message,
        }));
      }
    }
  }
  return {
    expired: (expired || []).length, polled: watches.length, told, failed,
  };
}
