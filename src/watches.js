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
import { GITHUB_API, installationToken } from './github.js';
import { agentStub } from './agent/stub.js';
import {
  forgetWatched, githubAccess, githubChanges, githubRef, MIN_POLL_MS,
} from './agent/watches.js';

/**
 * The Worker's side of what thread agents watch (src/agent/watches.js has the agents' side, the
 * tools, and what they are told): a watched thread's new messages (the `{ watched }` queue job),
 * the GitHub items polled by the cron (`WATCH_CRON`), and watches that ran out. Each wakes the
 * watching agent through its object (`watchUpdate`).
 */

const MAX_POLL = 30;
/** A quiet GitHub item is polled at most this rarely, a failing one backs off to this. */
const MAX_POLL_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** Tells the watching agent of watch `w` about `change`, in its own object. */
async function tell(env, w, change) {
  if (!env.AGENTS) {
    return true;
  }
  try {
    const agent = await agentStub(env, w.watcher);
    await agent.watchUpdate({
      watch: {
        id: w.id, kind: w.kind, target: w.target, url: w.url, why: w.why, set_at: w.set_at,
      },
      change,
    });
    return true;
  } catch (e) {
    console.error(JSON.stringify({
      route: 'agent', watch: 'tell failed', id: w.id, error: e.message,
    }));
    return false;
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
  let failed = 0;
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
        const ok = await tell(env, w, {
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
        if (ok) {
          told += 1;
        } else {
          // Not told: what it saw goes back, and the queue asks again.
          // eslint-disable-next-line no-await-in-loop
          await env.DB.prepare('UPDATE agent_watches SET seen = ? WHERE id = ? AND seen = ?')
            .bind(w.seen, w.id, latest).run();
          failed += 1;
        }
      }
    }
  }
  if (failed) {
    // The queue delivers the job again: those not told are, then.
    throw new Error(`${failed} of the watching agents were not told`);
  }
  return { result: told ? 'told' : 'nothing new', watches: (watches || []).length, told };
}

/** When to poll a GitHub watch again, as an ISO time (see `pollWatches`). */
export function nextPoll(now, {
  changedAt = null, failures = 0, low = false, resetAt = null,
} = {}) {
  const t = now.getTime();
  // Quiet items slower: a twelfth of how long it has been quiet, from 4 minutes to an hour.
  const quiet = changedAt ? Math.max(0, t - Date.parse(changedAt)) : 0;
  let every = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, quiet / 12));
  if (low) {
    every *= 4;
  }
  if (failures) {
    every = Math.max(every, Math.min(MAX_BACKOFF_MS, MIN_POLL_MS * 2 ** failures));
  }
  const at = Math.max(t + every, resetAt ? resetAt + 1000 : 0);
  return new Date(at).toISOString();
}

/**
 * A GET of GitHub's API as `token`, conditional on `etag` (a 304 does not count against the rate
 * limit): `{ status, data, etag, rate: { remaining, limit, reset }, retryAfter }`, never throws
 * for an HTTP status.
 */
export async function githubGet(path, token, etag = null) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'helix-opspile',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${token}`,
      ...(etag ? { 'if-none-match': etag } : {}),
    },
  });
  const num = (h) => (res.headers.get(h) === null ? null : Number(res.headers.get(h)));
  return {
    status: res.status,
    data: res.status === 200 ? await res.json().catch(() => null) : null,
    etag: res.headers.get('etag'),
    rate: { remaining: num('x-ratelimit-remaining'), limit: num('x-ratelimit-limit'), reset: num('x-ratelimit-reset') },
    retryAfter: num('retry-after'),
  };
}

/**
 * When GitHub says to stop asking with this token, as ms since the epoch, or null: a 429, or a
 * 403 with no requests left (the primary limit, until `x-ratelimit-reset`) or a `retry-after`
 * (the secondary limit).
 */
export function limitedUntil(r, now = Date.now()) {
  if (r.status !== 403 && r.status !== 429) {
    return null;
  }
  if (r.retryAfter !== null && Number.isFinite(r.retryAfter)) {
    return now + r.retryAfter * 1000;
  }
  if (r.rate.remaining === 0 && r.rate.reset) {
    return r.rate.reset * 1000;
  }
  // GitHub's advice for a secondary limit without a header: wait a minute at least.
  return r.status === 429 ? now + 60_000 : null;
}

/** The target of the agent of inbox entry `key`, as far as its GitHub access goes. */
async function watcherTarget(env, key) {
  const entry = await entryOf(env, key);
  const row = entry && await env.DB.prepare('SELECT team, channel_id, source, org FROM threads WHERE thread = ?')
    .bind(entry.key).first();
  return row ? {
    key: entry.key,
    team: entry.team || row.team,
    channelId: row.channel_id,
    source: row.source,
    org: row.org,
  } : null;
}

/** What one poll of watch `w` found: `{ told }`, `{ unchanged }` or `{ limited: until }`. */
async function pollOne(env, app, w, ref, { now, rate }) {
  const { token } = await installationToken(env, app, w.installation);
  const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const r = await githubGet(`${base}/issues/${ref.number}`, token, w.etag);
  if (r.rate.limit) {
    Object.assign(rate, r.rate);
  }
  const limited = limitedUntil(r, now.getTime());
  if (limited) {
    return { limited };
  }
  if (r.status === 304) {
    return { unchanged: true };
  }
  if (r.status !== 200 || !r.data) {
    throw new Error(`GitHub GET ${base}/issues/${ref.number}: ${r.status}`);
  }
  const issue = r.data;
  if (!issue.updated_at || issue.updated_at === w.seen) {
    await env.DB.prepare('UPDATE agent_watches SET etag = ? WHERE id = ?').bind(r.etag, w.id).run();
    return { unchanged: true };
  }
  const since = w.seen || w.set_at;
  const [pull, comments, reviews] = await Promise.all([
    issue.pull_request ? githubGet(`${base}/pulls/${ref.number}`, token) : null,
    githubGet(`${base}/issues/${ref.number}/comments?since=${encodeURIComponent(since)}&per_page=50`, token),
    issue.pull_request ? githubGet(`${base}/pulls/${ref.number}/reviews?per_page=100`, token) : null,
  ]);
  const ok = (x) => (x && x.status === 200 && Array.isArray(x.data) ? x.data : []);
  const p = pull && pull.status === 200 ? pull.data : null;
  const state = {
    type: issue.pull_request ? 'pull' : 'issue',
    title: String(issue.title || '').slice(0, 200),
    state: issue.state || null,
    reason: issue.state_reason || null,
    merged: p ? Boolean(p.merged) : null,
    draft: p ? Boolean(p.draft) : null,
    comments: Number(issue.comments) || 0,
  };
  const lines = githubChanges(JSON.parse(w.state || '{}'), state, {
    comments: ok(comments).filter((c) => c.created_at > since)
      .map((c) => ({ by: (c.user && c.user.login) || 'someone', at: c.created_at })),
    reviews: ok(reviews).filter((v) => v.submitted_at && v.submitted_at > since)
      .map((v) => ({ by: (v.user && v.user.login) || 'someone', at: v.submitted_at, state: v.state })),
  });
  const moved = await env.DB.prepare(`UPDATE agent_watches SET seen = ?, state = ?, etag = ?,
      changed_at = ? WHERE id = ? AND COALESCE(seen, '') = ?`)
    .bind(issue.updated_at, JSON.stringify(state), r.etag, now.toISOString(), w.id, w.seen || '').run();
  if (lines.length && moved.meta && moved.meta.changes) {
    const told = await tell(env, w, {
      type: 'github', target: w.target, title: state.title, item: state.type, lines, latest: issue.updated_at,
    });
    if (!told) {
      // Not told (its agent did not answer): what it saw goes back, so the next poll tells it.
      await env.DB.prepare(`UPDATE agent_watches SET seen = ?, state = ?, etag = NULL
        WHERE id = ? AND seen = ?`).bind(w.seen, w.state, w.id, issue.updated_at).run();
      throw new Error('the watching agent was not told');
    }
    return { told: true };
  }
  return { unchanged: true };
}

/**
 * Cron (`WATCH_CRON`, every five minutes): the GitHub watches due (`poll_after`), the most
 * overdue first. Before each poll, the watching agent's channel is asked again whether it still
 * reads the item's account (src/agent/watches.js githubAccess): one that no longer does ends, and
 * its agent hears only that. Each poll is one conditional request (an unchanged item answers 304,
 * which costs no rate limit); only a changed one asks for its pull request, comments and reviews.
 * When to poll again (`nextPoll`): a quiet item slower (up to an hour), a failing one backing off
 * (up to six hours), all of them four times slower while the installation has less than a tenth
 * of its requests left; once GitHub limits an installation (a 429, a 403 without requests left),
 * none of its watches is asked until GitHub says so. Expired watches end, and their agents hear
 * so.
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
    AND (poll_after IS NULL OR poll_after <= ?) ORDER BY poll_after LIMIT ?`).bind(at, MAX_POLL).all();
  const watches = results || [];
  const out = {
    expired: (expired || []).length, polled: 0, told: 0, failed: 0, revoked: 0, limited: 0,
  };
  if (!watches.length) {
    return out;
  }
  // Per installation: GitHub's rate limit as it last said, and until when it is limited.
  const rates = new Map();
  const until = new Map();
  const later = (w, opts) => env.DB.prepare(`UPDATE agent_watches SET checked_at = ?, poll_after = ?,
      failures = ? WHERE id = ?`).bind(at, nextPoll(now, opts), opts.failures || 0, w.id).run();
  for (const w of watches) {
    const ref = githubRef(w.url);
    let access;
    try {
      // eslint-disable-next-line no-await-in-loop
      const target = ref && await watcherTarget(env, w.watcher);
      // A refusal is `{ error }`; what cannot be told (D1 or GitHub did not answer) throws.
      // eslint-disable-next-line no-await-in-loop
      access = target ? await githubAccess(env, target, ref.owner) : { error: 'the watching thread is gone' };
    } catch (e) {
      access = { unknown: e.message };
    }
    if (access.unknown) {
      out.failed += 1;
      console.error(JSON.stringify({
        route: 'cron', watch: 'github', id: w.id, access: 'unknown', error: access.unknown,
      }));
      // eslint-disable-next-line no-await-in-loop
      await later(w, { changedAt: w.changed_at, failures: (Number(w.failures) || 0) + 1 });
    } else if (access.error) {
      // eslint-disable-next-line no-await-in-loop
      await env.DB.prepare('DELETE FROM agent_watches WHERE id = ?').bind(w.id).run();
      // eslint-disable-next-line no-await-in-loop
      await tell(env, w, { type: 'revoked', reason: access.error });
      out.revoked += 1;
    } else if (until.has(access.installation)) {
      // eslint-disable-next-line no-await-in-loop
      await later(w, {
        changedAt: w.changed_at, failures: w.failures, resetAt: until.get(access.installation),
      });
      out.limited += 1;
    } else {
      const cur = { ...w, installation: access.installation };
      if (cur.installation !== w.installation) {
        // eslint-disable-next-line no-await-in-loop
        await env.DB.prepare('UPDATE agent_watches SET installation = ? WHERE id = ?').bind(cur.installation, w.id).run();
      }
      const rate = rates.get(cur.installation) || {};
      rates.set(cur.installation, rate);
      out.polled += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await pollOne(env, access.app, cur, ref, { now, rate });
        const low = Boolean(rate.limit && rate.remaining !== null
          && rate.remaining < rate.limit / 10);
        if (r.limited) {
          until.set(cur.installation, r.limited);
          out.limited += 1;
          // eslint-disable-next-line no-await-in-loop
          await later(w, { changedAt: w.changed_at, failures: w.failures, resetAt: r.limited });
        } else {
          out.told += r.told ? 1 : 0;
          // eslint-disable-next-line no-await-in-loop
          await later(w, { changedAt: r.told ? at : w.changed_at, low });
        }
      } catch (e) {
        out.failed += 1;
        console.error(JSON.stringify({
          route: 'cron', watch: 'github', id: w.id, error: e.message,
        }));
        // eslint-disable-next-line no-await-in-loop
        await later(w, { changedAt: w.changed_at, failures: (Number(w.failures) || 0) + 1 });
      }
    }
  }
  return out;
}
