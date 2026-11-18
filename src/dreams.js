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

import { agentStates } from './agent/enabled.js';
import { modelProblem } from './agent/model.js';
import { agentStub } from './agent/stub.js';
import { armOf, DREAM, running } from './experiments.js';

/*
 * Dreams, from the cron (the dream experiment, src/experiments.js): a customer in the `dream` arm
 * whose channels have been quiet for QUIET_MS, with no dream since their latest message, has its
 * knowledge-base agent (`kb:<team>:<org>`, the team of its latest channel with an agent)
 * consolidate kb-org in a session of its own (src/agent/dream.js). A row of `kb_dreams` is each
 * dream, written before the agent is asked: it is what "a dream since" means, so a dream is never
 * started twice for one quiet spell. What is left to do is in its columns, for the sweep: an
 * unsubmitted row is asked again, a submitted one asked where it stands, and one still open after
 * MAX_DREAM_MS ends as `timeout`.
 */

export const QUIET_MS = 8 * 60 * 60 * 1000;
// Only customers with a message in this time: one quiet for longer had its dream, or has nothing
// new for one.
export const ACTIVE_MS = 7 * 24 * 60 * 60 * 1000;
// A knowledge base with fewer concepts has nothing to consolidate yet.
export const MIN_ENTRIES = 5;
// At most this many dreams start per cron run (every 20 minutes), so a window that opens on many
// quiet customers spreads them out.
export const STARTS_PER_RUN = 3;
export const MAX_DREAM_MS = 3 * 60 * 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();

/**
 * Customers due a dream at `now`: in the `dream` arm, kb-org with MIN_ENTRIES concepts, their
 * latest message between ACTIVE_MS and QUIET_MS ago, no dream since it and none open, and a
 * channel with an agent. `[{ org, team, quietSince, entries }]`, the longest quiet first.
 */
export async function dueDreams(env, now = Date.now()) {
  const { results } = await env.DB.prepare(`WITH latest AS (
      SELECT org, MAX(MAX(COALESCE(any_at, ''), COALESCE(last_at, ''))) AS at
      FROM threads WHERE kind = 'channel' AND org != '' GROUP BY org)
    SELECT l.org, l.at, k.entries FROM latest l
      JOIN knowledge_bases k ON k.kind = 'org' AND k.slug = l.org
    WHERE l.at <= ? AND l.at >= ? AND k.entries >= ?
      AND NOT EXISTS (SELECT 1 FROM kb_dreams d WHERE d.org = l.org
        AND (d.started_at >= l.at OR d.ended_at IS NULL))
    ORDER BY l.at`).bind(iso(now - QUIET_MS), iso(now - ACTIVE_MS), MIN_ENTRIES).all();
  const out = [];
  for (const r of (results || []).filter((x) => armOf(DREAM, x.org, now)?.id === 'dream')) {
    // eslint-disable-next-line no-await-in-loop
    const { results: channels } = await env.DB.prepare(`SELECT channel_id, team,
        MAX(MAX(COALESCE(any_at, ''), COALESCE(last_at, ''))) AS at
      FROM threads WHERE org = ? AND kind = 'channel' GROUP BY channel_id, team ORDER BY at DESC`)
      .bind(r.org).all();
    const list = channels || [];
    // eslint-disable-next-line no-await-in-loop
    const states = await agentStates(env, list.map((c) => c.channel_id), {
      teams: new Map(list.map((c) => [c.channel_id, c.team])),
    });
    const on = list.find((c) => c.team && states.get(c.channel_id)?.enabled);
    if (on) {
      out.push({
        org: r.org, team: on.team, quietSince: r.at, entries: r.entries,
      });
    }
  }
  return out;
}

/** Hands dream `row` to its agent; `submitted_at` once it took it, else the error, kept open. */
async function submit(env, row, now) {
  const res = await (await agentStub(env, `kb:${row.team}:${row.org}`)).dream({ id: row.id })
    .catch((e) => ({ error: e.message }));
  if (res.error) {
    await env.DB.prepare('UPDATE kb_dreams SET error = ? WHERE id = ?')
      .bind(String(res.error).slice(0, 500), row.id).run();
    return false;
  }
  await env.DB.prepare('UPDATE kb_dreams SET submitted_at = ?, error = NULL WHERE id = ?')
    .bind(iso(now), row.id).run();
  return true;
}

/** Ends dream `row` with `outcome`, the knowledge base's entries as they are now. */
async function end(env, row, now, { outcome, note = null, error = null }) {
  await env.DB.prepare(`UPDATE kb_dreams SET ended_at = ?, outcome = ?, note = ?,
      error = COALESCE(?, error),
      entries_after = (SELECT entries FROM knowledge_bases WHERE kind = 'org' AND slug = ?)
    WHERE id = ? AND ended_at IS NULL`)
    .bind(iso(now), outcome, note, error, row.org, row.id).run();
}

/**
 * The sweep of the open dreams: each unsubmitted one asked again, each submitted one asked where it
 * stands (ended when it settled), and any open for MAX_DREAM_MS ended as `timeout`.
 */
export async function sweepDreams(env, now = Date.now()) {
  const { results } = await env.DB.prepare(`SELECT id, org, team, started_at, submitted_at
    FROM kb_dreams WHERE ended_at IS NULL ORDER BY started_at LIMIT 20`).all();
  const counts = { open: 0, ended: 0, submitted: 0 };
  for (const row of results || []) {
    if (now - Date.parse(row.started_at) > MAX_DREAM_MS) {
      // eslint-disable-next-line no-await-in-loop
      await end(env, row, now, { outcome: 'timeout' });
      counts.ended += 1;
      // eslint-disable-next-line no-continue
      continue;
    }
    let state = { state: 'unknown' };
    if (row.submitted_at) {
      // eslint-disable-next-line no-await-in-loop
      state = await (await agentStub(env, `kb:${row.team}:${row.org}`)).dreamState({ id: row.id })
        .catch((e) => ({ state: 'error', error: e.message }));
    }
    if (state.state === 'settled') {
      // eslint-disable-next-line no-await-in-loop
      await end(env, row, now, { outcome: state.status, note: state.note });
      counts.ended += 1;
    } else if (state.state === 'unknown') {
      // Never taken, or its agent does not know it: asked again, the same dream.
      // eslint-disable-next-line no-await-in-loop
      counts.submitted += await submit(env, row, now) ? 1 : 0;
      counts.open += 1;
    } else {
      counts.open += 1;
    }
  }
  return counts;
}

/**
 * The cron's dreams: the sweep, then, while the experiment runs, up to STARTS_PER_RUN new ones.
 * The row comes first, and only where no dream since the customer's latest message is (in the
 * same statement, so two runs at once start one).
 */
export async function runDreams(env, now = Date.now()) {
  if (!env.DB || !env.AGENTS || !env.AGENT_MODEL || modelProblem(env)) {
    return { skipped: 'agents off' };
  }
  const swept = await sweepDreams(env, now);
  let started = 0;
  if (running(DREAM, now)) {
    for (const due of (await dueDreams(env, now)).slice(0, STARTS_PER_RUN)) {
      // eslint-disable-next-line no-await-in-loop
      const row = await env.DB.prepare(`INSERT INTO kb_dreams
          (org, team, quiet_since, entries_before, started_at)
        SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM kb_dreams
          WHERE org = ?1 AND (started_at >= ?3 OR ended_at IS NULL))
        RETURNING id`)
        .bind(due.org, due.team, due.quietSince, due.entries, iso(now)).first();
      if (row) {
        // eslint-disable-next-line no-await-in-loop
        await submit(env, { ...due, id: row.id }, now);
        started += 1;
      }
    }
  }
  return { ...swept, started };
}
