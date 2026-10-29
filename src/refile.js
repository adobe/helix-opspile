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

import { snapshotKey } from './filecache.js';
import { ensureChannelKnowledgeBases } from './kb.js';
import { loadRules, toChannel } from './lookup.js';
import { segment } from './raw.js';
import { classify } from './rules.js';
import { notifyRoom } from './notify.js';
import { teamsOf } from './shares.js';

/**
 * Re-filing channels after a rule change. A channel's org and team are part of its pile-2
 * paths and of its thread rows, so when the rules classify a channel differently, its
 * thread folders move from `channels/<old org>/<old team>/…` to the new ones and its thread
 * rows follow. Without this, a rule change needs a full replay (scripts/replay.mjs --clear).
 *
 * `plan` compares every known channel's classification under some rules with what its
 * threads say now; `enqueueMoves` hands the differences to the NORMALIZE queue as `refile`
 * jobs, which `refile` carries out a few hundred files at a time.
 */

const MAX_OBJECTS = 300;
const MAX_THREADS_PER_JOB = 400;

const channelKey = (c) => `${c.source}:${c.tenant}:${c.channel_id}`;

/** The folder of a thread under another org and team: the first two segments change. */
export function movedFolder(folder, org, team) {
  const parts = String(folder).split('/');
  if (parts[0] !== 'channels' || parts.length < 5) {
    return null;
  }
  parts[1] = segment(org);
  parts[2] = segment(team);
  return parts.join('/');
}

/**
 * What changes for each channel under `rules`: `{ channel, from: [{ org, team, kind,
 * threads }], to: { org, team, kind } }` for every channel whose threads are filed
 * differently. Channels without threads are left out; nothing of theirs is filed yet.
 */
export async function plan(env, rules) {
  const { results: channels } = await env.DB.prepare('SELECT * FROM channels').all();
  const { results: filed } = await env.DB.prepare(`SELECT source, tenant, channel_id, org, team,
      kind, COUNT(*) AS threads, MAX(channel_name) AS channel_name
    FROM threads GROUP BY source, tenant, channel_id, org, team, kind`).all();
  const byChannel = new Map();
  for (const f of filed || []) {
    const list = byChannel.get(channelKey(f)) || [];
    list.push(f);
    byChannel.set(channelKey(f), list);
  }
  const moves = [];
  for (const c of channels || []) {
    const now = byChannel.get(channelKey(c));
    if (now) {
      const to = classify(rules, toChannel(c, c.source, c.channel_id));
      const differs = now.some((f) => f.org !== to.org || f.team !== to.team || f.kind !== to.kind);
      if (differs) {
        moves.push({
          channel: {
            source: c.source,
            tenant: c.tenant,
            channelId: c.channel_id,
            name: c.name || now[0].channel_name,
            groupName: c.group_name || null,
          },
          from: now.map((f) => ({
            org: f.org, team: f.team, kind: f.kind, threads: f.threads,
          })),
          to: { org: to.org, team: to.team, kind: to.kind },
        });
      }
    }
  }
  return moves.sort((a, b) => String(a.channel.name).localeCompare(String(b.channel.name)));
}

/** Queues one `refile` job per channel (and per few hundred threads). */
export async function enqueueMoves(env, moves) {
  if (!env.NORMALIZE) {
    return 0;
  }
  let jobs = 0;
  for (const m of moves) {
    const { channel } = m;
    // eslint-disable-next-line no-await-in-loop
    const { results } = await env.DB.prepare(`SELECT thread, path FROM threads
      WHERE source = ? AND tenant = ? AND channel_id = ?`)
      .bind(channel.source, channel.tenant, channel.channelId).all();
    const all = (results || []).map((r) => [r.thread, r.path]);
    for (let i = 0; i < all.length; i += MAX_THREADS_PER_JOB) {
      // eslint-disable-next-line no-await-in-loop
      await env.NORMALIZE.send({
        refile: {
          source: channel.source,
          tenant: channel.tenant,
          channelId: channel.channelId,
          threads: all.slice(i, i + MAX_THREADS_PER_JOB),
        },
      });
      jobs += 1;
    }
  }
  return jobs;
}

/**
 * Moves every object below `from` to the same name below `to`; at most `budget`. Each page
 * is listed from the start again: the objects of the previous page are gone by then.
 */
async function moveFolder(bucket, from, to, budget) {
  let moved = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await bucket.list({ prefix: from, limit: Math.min(100, budget - moved) });
    for (const o of page.objects) {
      const target = `${to}${o.key.slice(from.length)}`;
      // A message that arrived after the rule change is already at the new place, and it is
      // the newer version: keep it.
      // eslint-disable-next-line no-await-in-loop
      if (!(await bucket.head(target))) {
        // eslint-disable-next-line no-await-in-loop
        const obj = await bucket.get(o.key);
        if (obj) {
          // eslint-disable-next-line no-await-in-loop
          await bucket.put(target, await obj.text(), {
            httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata,
          });
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await bucket.delete(o.key);
      moved += 1;
    }
    if (!page.truncated || !page.objects.length) {
      // The folder's snapshot (src/filecache.js) names files that are gone: the new place
      // gets its own on its first read.
      // eslint-disable-next-line no-await-in-loop
      await bucket.delete(snapshotKey(from));
      return { moved, done: true };
    }
    if (moved >= budget) {
      return { moved, done: false };
    }
  }
}

/**
 * The message and thread vectors (CONTENT) and the full-text items (SEARCH) carry the team a
 * thread was filed under, and search asks for a team's: those of re-filed threads are made
 * again, under the new one (an item's hash has the team in it, so it is uploaded again). A
 * thread that is no longer a channel thread (`kind`, now an alert or ignored) loses them: its
 * hashes and item ids stay, so the job knows which to take away.
 */
async function revectorize(env, threads, kind) {
  if (!threads.length || !(env.CONTENT || env.SEARCH) || !env.NORMALIZE.sendBatch) {
    return;
  }
  const keys = JSON.stringify(threads);
  if (kind === 'channel') {
    await env.DB.prepare(`UPDATE messages SET embedded = NULL
      WHERE thread IN (SELECT value FROM json_each(?))`).bind(keys).run();
    await env.DB.prepare(`UPDATE threads SET embedded = NULL, vectorized_through = NULL,
        indexed_through = NULL
      WHERE thread IN (SELECT value FROM json_each(?))`).bind(keys).run();
  }
  for (let i = 0; i < threads.length; i += 100) {
    // eslint-disable-next-line no-await-in-loop
    await env.NORMALIZE.sendBatch(threads.slice(i, i + 100)
      .map((t) => ({ body: { vectorize: t } })));
  }
}

/**
 * Queue job `{ refile: { source, tenant, channelId, threads: [[thread, folder]] } }`: files
 * the channel's threads where the rules say now. Runs again for the threads it did not get
 * to, so a large channel moves in several jobs.
 *
 * Each thread's folder is read from D1, not taken from the job: several rule changes in a
 * row queue several jobs for a channel, and an earlier one may have moved the folder since
 * this job was queued. The folder in the job is for a thread D1 no longer has.
 */
export async function refile(env, job) {
  const row = await env.DB.prepare('SELECT * FROM channels WHERE source = ? AND tenant = ? AND channel_id = ?')
    .bind(job.source, job.tenant, job.channelId).first();
  if (!row) {
    return { result: 'skip', reason: 'unknown channel' };
  }
  const cls = classify(await loadRules(env), toChannel(row, job.source, job.channelId));
  await ensureChannelKnowledgeBases(env, cls);
  const { results: current } = await env.DB.prepare(`SELECT thread, path, org, team, kind FROM threads
    WHERE source = ? AND tenant = ? AND channel_id = ?`)
    .bind(job.source, job.tenant, job.channelId).all();
  const rowOf = new Map((current || []).map((r) => [r.thread, r]));
  const pathOf = new Map((current || []).map((r) => [r.thread, r.path]));
  const refiled = [];
  const fromTeams = new Set();
  let budget = MAX_OBJECTS;
  let threads = 0;
  let objects = 0;
  const left = [];
  for (const [thread, queued] of job.threads || []) {
    const folder = pathOf.get(thread) || queued;
    if (budget <= 0) {
      left.push([thread, folder]);
      // eslint-disable-next-line no-continue
      continue;
    }
    const to = movedFolder(folder, cls.org, cls.team);
    let done = true;
    if (to && to !== folder) {
      // eslint-disable-next-line no-await-in-loop
      const r = await moveFolder(env.CHANNELS, folder, to, budget);
      budget -= r.moved;
      objects += r.moved;
      ({ done } = r);
    }
    if (done) {
      // eslint-disable-next-line no-await-in-loop
      await env.DB.prepare('UPDATE threads SET org = ?, team = ?, kind = ?, path = ? WHERE thread = ?')
        .bind(cls.org, cls.team, cls.kind, to || folder, thread).run();
      threads += 1;
      const was = rowOf.get(thread);
      if (was && (was.team !== cls.team || was.org !== cls.org || was.kind !== cls.kind)) {
        refiled.push(thread);
        fromTeams.add(was.team);
      }
    } else {
      left.push([thread, folder]);
    }
  }
  await revectorize(env, refiled, cls.kind);
  // Open inboxes of the teams it left and the teams it is in now show it where it is now: an
  // inbox loaded before the move keeps the old org (or team) otherwise, until something else
  // reloads it.
  if (refiled.length && env.ROOMS) {
    const rooms = await teamsOf(env, {
      source: job.source, channel_id: job.channelId, team: cls.team,
    });
    await notifyRoom(env, [...fromTeams, ...rooms], {
      type: 'thread', thread: refiled[0], moved: refiled,
    });
  }
  if (left.length) {
    await env.NORMALIZE.send({ refile: { ...job, threads: left } });
  }
  return {
    result: 'refiled', org: cls.org, team: cls.team, kind: cls.kind, threads, objects, left: left.length,
  };
}
