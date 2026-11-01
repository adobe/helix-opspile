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
 * A job on the NORMALIZE queue goes queued → retried → dead. The queue's dead-letter queue has
 * nobody reading it, so a dead job left no trace but a log line. Its last failure is recorded
 * here: `/diag/dead` shows them and sends them out again. Re-threading and labels also heal by
 * themselves (`sweepRethreads`, `sweepLabels`). A dead `refile` does not: sweeping would apply
 * today's rules to every channel, so it waits here for someone to send it out.
 */

export const DEAD_JOB_DAYS = 30;
const LIST = 100;
const REDRIVE = 100;

/** Records a job that failed for the last time. Quietly: it is failing already. */
export async function recordDead(env, job, body, error) {
  try {
    await env.DB.prepare('INSERT INTO dead_jobs (job, body, error, at) VALUES (?, ?, ?, ?)')
      .bind(
        String(job).slice(0, 500),
        JSON.stringify(body),
        String(error).slice(0, 500),
        new Date().toISOString(),
      )
      .run();
  } catch (e) {
    console.error(JSON.stringify({ route: 'normalize', dead: job, error: e.message }));
  }
}

/** How many jobs died, of each kind, and the latest. */
export async function listDead(env, { limit = LIST } = {}) {
  const { results } = await env.DB.prepare(`SELECT id, job, error, at FROM dead_jobs
    ORDER BY id DESC LIMIT ?`).bind(limit).all();
  const { results: kinds } = await env.DB.prepare(`SELECT
      CASE WHEN instr(job, ':') > 0 AND instr(job, '/') = 0 THEN substr(job, 1, instr(job, ':') - 1)
        ELSE 'normalize' END AS kind, COUNT(*) AS n
    FROM dead_jobs GROUP BY 1 ORDER BY 2 DESC`).all();
  return { kinds: kinds || [], jobs: results || [] };
}

/** Sends dead jobs out again, the oldest first, or those of `ids`. They leave the list. */
export async function redrive(env, { ids = null, limit = REDRIVE } = {}) {
  const { results } = await env.DB.prepare(`SELECT id, body FROM dead_jobs
    WHERE ?1 IS NULL OR id IN (SELECT value FROM json_each(?1)) ORDER BY id LIMIT ?2`)
    .bind(ids ? JSON.stringify(ids) : null, limit).all();
  for (const r of results || []) {
    // eslint-disable-next-line no-await-in-loop
    await env.NORMALIZE.send(JSON.parse(r.body));
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare('DELETE FROM dead_jobs WHERE id = ?').bind(r.id).run();
  }
  return { sent: (results || []).length };
}

/** Cron: nobody needs them after a month. */
export async function pruneDead(env, now = new Date()) {
  const before = new Date(now.getTime() - DEAD_JOB_DAYS * 24 * 3600 * 1000).toISOString();
  const res = await env.DB.prepare('DELETE FROM dead_jobs WHERE at < ?').bind(before).run();
  return { deleted: res.meta.changes };
}
