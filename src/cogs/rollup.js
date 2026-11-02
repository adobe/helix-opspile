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

import { DIMENSIONS, DO_GB } from './prices.js';

/*
 * COGS rollup (cron): what each day used, per customer, team, service, metric and detail, into
 * `cogs_usage` (migration 0051), which the dashboard reads (src/cogs/report.js). Three sources,
 * each a `source` of its own, each replaced whole for the days it rolls up:
 *
 * - `meter`: what the Worker counted (src/cogs/meter.js), from its Analytics Engine dataset.
 * - `account`: what Cloudflare's own analytics say about opspile's resources (the Worker's
 *   script, buckets, indexes and Artifacts namespace, `COGS_RESOURCES`), through the Analytics
 *   SQL binding (`ANALYTICS`): Durable Objects' requests and duration per object (an agent's is
 *   its thread's customer's; a team room's its team's; WebSocket connections hibernate, so a
 *   room's connections count as requests, not duration), the Worker's CPU time and log events,
 *   Artifacts operations per repository (a knowledge base's are its customer's or team's), and
 *   what the buckets and indexes hold.
 * - `d1`: the day's messages and new threads per customer and team (`volume`), and, once a day,
 *   what is kept that only D1 knows: its own size, the agents' storage (`cogs_objects`), the
 *   full-text items (their number times the average size of an upload), and the Workers Paid plan.
 *
 * Each run rolls up today and yesterday (late data), and up to BACKFILL_PER_RUN of the last
 * BACKFILL_DAYS that have no `account` or `d1` rows yet. A row is written only when it changed.
 */

export const BACKFILL_DAYS = 30;
export const BACKFILL_PER_RUN = 3;
const BATCH = 50;
const LIMIT = 10000;
/** An upload to AI Search when there were none to measure. */
const ITEM_BYTES = 800;

const NAME = /^[A-Za-z0-9._-]+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const nextDay = (day) => dayOf(Date.parse(`${day}T00:00:00Z`) + 86400000);
const iso = (day) => `${day}T00:00:00Z`;

/** The names of opspile's resources, as the deployment says (`COGS_RESOURCES`, JSON). */
export function resources(env) {
  let r = {};
  try {
    r = JSON.parse(env.COGS_RESOURCES || '{}') || {};
  } catch {
    r = {};
  }
  const name = (v) => (typeof v === 'string' && NAME.test(v) ? v : null);
  const names = (v) => (Array.isArray(v) ? v.map(name).filter(Boolean) : []);
  return {
    worker: name(r.worker),
    dataset: name(r.dataset),
    artifacts: name(r.artifacts),
    buckets: names(r.buckets),
    indexes: names(r.indexes),
  };
}

const list = (names) => names.map((n) => `'${n}'`).join(', ');

async function sql(env, query) {
  const res = await env.ANALYTICS.query({ query });
  return (res && res.data) || [];
}

/** Rows `{ day, org, team, service, metric, detail, quantity }` added up by key. */
function rowsOf(list_) {
  const m = new Map();
  for (const r of list_) {
    const q = Number(r.quantity);
    if (!DAY.test(r.day) || !Number.isFinite(q) || !q) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const row = {
      day: r.day,
      org: r.org || '',
      team: r.team || '',
      service: r.service,
      metric: r.metric,
      detail: r.detail || '',
    };
    const k = [row.day, row.service, row.metric, row.detail, row.org, row.team].join('\u0000');
    const had = m.get(k);
    m.set(k, had ? { ...had, quantity: had.quantity + q } : { ...row, quantity: q });
  }
  return [...m.values()];
}

/** What the Worker counted on `day`. */
export async function meterRows(env, day) {
  const { dataset } = resources(env);
  if (!dataset) {
    return null;
  }
  const data = await sql(env, `SELECT toDate(timestamp) AS day, blob1 AS service, blob2 AS metric,
      blob3 AS detail, blob4 AS org, blob5 AS team, SUM(double1) AS quantity
    FROM events.analyticsEngine."${dataset}"
    WHERE timestamp >= '${iso(day)}' AND timestamp < '${iso(nextDay(day))}'
    GROUP BY day, service, metric, detail, org, team
    LIMIT ${LIMIT}`);
  return rowsOf(data.map((r) => ({ ...r, day: String(r.day).slice(0, 10) })));
}

/** Customer and team of agents' threads, by the threads' keys. */
async function threadsOf(env, keys) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += BATCH) {
    const part = keys.slice(i, i + BATCH);
    // eslint-disable-next-line no-await-in-loop
    const { results } = await env.DB.prepare(`SELECT thread, org, team FROM threads
      WHERE thread IN (${part.map(() => '?').join(', ')})`).bind(...part).all();
    for (const r of results || []) {
      out.set(r.thread, { org: r.org || '', team: r.team || '' });
    }
  }
  return out;
}

/** Whom a Durable Object worked for, by its name: an agent, a team's room, or nobody. */
function objectOwner(name, threads, teams) {
  const kb = /^kb:([^:]*):(.*)$/.exec(name);
  if (kb) {
    return { org: kb[2], team: kb[1], room: false };
  }
  if (teams.has(name)) {
    return { org: '', team: name, room: true };
  }
  return { ...(threads.get(name) || { org: '', team: '' }), room: false };
}

/**
 * What Cloudflare's analytics say about opspile's resources on `day`: `{ rows, services,
 * errors }`, `services` those whose queries answered (only they may replace the day's rows).
 */
export async function accountRows(env, day) {
  const res = resources(env);
  const since = iso(day);
  const until = iso(nextDay(day));
  const rows = [];
  const add = (service, metric, detail, quantity, who = {}) => rows.push({
    day, service, metric, detail, quantity, org: who.org || '', team: who.team || '',
  });
  // Each query, with the services it counts: a query that fails leaves those as they were.
  const tries = [];

  if (res.worker) {
    tries.push([['durable_objects'], (async () => {
      const data = await sql(env, `SELECT objectName AS name, invocationType AS type,
          COUNT(*) AS requests, SUM(wallTimeUs) AS wall
        FROM events.durableObjectsInvocations
        WHERE timestamp >= '${since}' AND timestamp < '${until}' AND scriptName = '${res.worker}'
        GROUP BY name, type
        LIMIT ${LIMIT}`);
      const names = [...new Set(data.map((r) => String(r.name || '')))];
      const threads = await threadsOf(env, names.filter((n) => n.includes(':') && !n.startsWith('kb:')));
      const { results: teamRows } = await env.DB.prepare('SELECT slug FROM teams').all();
      const teams = new Set((teamRows || []).map((t) => t.slug));
      for (const r of data) {
        const who = objectOwner(String(r.name || ''), threads, teams);
        add('durable_objects', 'requests', '', Number(r.requests), who);
        if (!(who.room && r.type === 'http')) {
          add('durable_objects', 'gb_s', '', (Number(r.wall) / 1e6) * DO_GB, who);
        }
      }
    })()]);
    tries.push([['workers', 'workers_logs'], (async () => {
      const data = await sql(env, `SELECT logType AS log, invocationType AS type,
          COUNT(*) AS events, SUM(cpuTimeMs) AS cpu
        FROM logs.workersLogs
        WHERE timestamp >= '${since}' AND timestamp < '${until}' AND scriptName = '${res.worker}'
        GROUP BY log, type
        LIMIT ${LIMIT}`);
      for (const r of data) {
        add('workers_logs', 'events', '', Number(r.events));
        // An invocation's own event has its CPU time; a Durable Object's is billed as duration.
        if (r.log === 'cf-worker-event' && ['fetch', 'queue', 'scheduled'].includes(r.type)) {
          add('workers', 'cpu_ms', '', Number(r.cpu));
        }
      }
    })()]);
  }
  if (res.artifacts) {
    tries.push([['artifacts'], (async () => {
      const data = await sql(env, `SELECT repositoryName AS repo, COUNT(*) AS n
        FROM events.artifactsEventsByNamespaceAccount
        WHERE timestamp >= '${since}' AND timestamp < '${until}'
          AND repositoryNamespace = '${res.artifacts}' AND eventKind = 'action'
          AND eventType != 'token_create'
        GROUP BY repo
        LIMIT ${LIMIT}`);
      const { results: kbs } = await env.DB.prepare('SELECT repo, kind, slug FROM knowledge_bases').all();
      const bases = new Map((kbs || []).map((k) => [k.repo, k]));
      const owner = (kb) => {
        if (!kb) {
          return {};
        }
        return kb.kind === 'org' ? { org: kb.slug } : { team: kb.slug };
      };
      for (const r of data) {
        add('artifacts', 'operations', '', Number(r.n), owner(bases.get(r.repo)));
      }
    })()]);
  }
  if (res.buckets.length) {
    tries.push([['r2'], (async () => {
      const data = await sql(env, `SELECT bucketName AS bucket, MAX(payloadSizeBytes) AS payload,
          MAX(metadataSizeBytes) AS meta
        FROM states.r2CombinedStorage
        WHERE usageReportTimestamp >= '${since}' AND usageReportTimestamp < '${until}'
          AND bucketName IN (${list(res.buckets)})
        GROUP BY bucket
        LIMIT ${LIMIT}`);
      for (const r of data) {
        add('r2', 'stored_bytes', String(r.bucket), Number(r.payload) + (Number(r.meta) || 0));
      }
    })()]);
  }
  if (res.indexes.length) {
    tries.push([['vectorize'], (async () => {
      const data = await sql(env, `SELECT indexName AS idx, MAX(vectorCount) AS vectors
        FROM states.vectorizeStorage
        WHERE timestamp >= '${since}' AND timestamp < '${until}' AND indexName IN (${list(res.indexes)})
        GROUP BY idx
        LIMIT ${LIMIT}`);
      for (const r of data) {
        add('vectorize', 'stored_dims', String(r.idx), Number(r.vectors) * DIMENSIONS);
      }
    })()]);
  }
  const done = await Promise.allSettled(tries.map(([, p]) => p));
  const services = ['analytics_engine'];
  const errors = [];
  done.forEach((d, i) => {
    if (d.status === 'fulfilled') {
      services.push(...tries[i][0]);
    } else {
      errors.push(`${tries[i][0].join('/')}: ${d.reason?.message || d.reason}`);
    }
  });
  // The queries above count Analytics SQL queries too.
  add('analytics_engine', 'queries', '', tries.length + 1);
  return { rows: rowsOf(rows.filter((r) => services.includes(r.service))), services, errors };
}

/** The day's messages and new threads, per customer and team. */
export async function volumeRows(env, day) {
  const since = iso(day);
  const until = iso(nextDay(day));
  const [messages, threads] = await Promise.all([
    env.DB.prepare(`SELECT t.org AS org, t.team AS team, COUNT(*) AS n
      FROM messages m JOIN threads t ON t.thread = m.thread
      WHERE m.at >= ? AND m.at < ? GROUP BY t.org, t.team`).bind(since, until).all(),
    env.DB.prepare(`SELECT org, team, COUNT(*) AS n FROM threads
      WHERE root_at >= ? AND root_at < ? GROUP BY org, team`).bind(since, until).all(),
  ]);
  return rowsOf([
    // Rolled up, even on a day without messages.
    {
      day, service: 'volume', metric: 'days', quantity: 1,
    },
    ...(messages.results || []).map((r) => ({
      day, org: r.org, team: r.team, service: 'volume', metric: 'messages', quantity: r.n,
    })),
    ...(threads.results || []).map((r) => ({
      day, org: r.org, team: r.team, service: 'volume', metric: 'threads', quantity: r.n,
    })),
  ]);
}

/** What only D1 knows is kept, as of now: for today, once a day. */
export async function storedRows(env, day) {
  const rows = [{
    day, service: 'workers', metric: 'subscription', quantity: 1,
  }];
  const size = await env.DB.prepare('SELECT 1 AS one').run().catch(() => null);
  const bytes = Number(size && size.meta && size.meta.size_after);
  if (bytes) {
    rows.push({
      day, service: 'd1', metric: 'stored_bytes', quantity: bytes,
    });
  }
  const { results: objects } = await env.DB.prepare(`SELECT org, team, SUM(bytes) AS bytes
    FROM cogs_objects GROUP BY org, team`).all();
  for (const r of objects || []) {
    rows.push({
      day, org: r.org, team: r.team, service: 'durable_objects', metric: 'stored_bytes', quantity: r.bytes,
    });
  }
  const avg = await env.DB.prepare(`SELECT
      SUM(CASE WHEN metric = 'ingest_bytes' THEN quantity ELSE 0 END) AS bytes,
      SUM(CASE WHEN metric = 'uploads' THEN quantity ELSE 0 END) AS uploads
    FROM cogs_usage WHERE source = 'meter' AND service = 'ai_search' AND day >= ?`)
    .bind(dayOf(Date.parse(iso(day)) - BACKFILL_DAYS * 86400000)).first();
  const perItem = avg && avg.uploads > 0 ? avg.bytes / avg.uploads : ITEM_BYTES;
  const { results: items } = await env.DB.prepare(`SELECT t.org AS org, t.team AS team, COUNT(*) AS n
    FROM messages m JOIN threads t ON t.thread = m.thread
    WHERE m.search_item IS NOT NULL GROUP BY t.org, t.team`).all();
  for (const r of items || []) {
    rows.push({
      day, org: r.org, team: r.team, service: 'ai_search', metric: 'stored_bytes', quantity: r.n * perItem,
    });
  }
  return rowsOf(rows);
}

/**
 * Replaces `source`'s rows of `day` in the selected services with `rows`: writes the ones that
 * changed, deletes the ones that are gone. `services`: only those (a part of a source), or all.
 */
export async function replaceDay(env, day, source, rows, services = null, now = Date.now()) {
  const at = new Date(now).toISOString();
  const key = (r) => [r.service, r.metric, r.detail || '', r.org || '', r.team || ''].join('\u0000');
  const { results: had } = await env.DB.prepare(`SELECT service, metric, detail, org, team, quantity
    FROM cogs_usage WHERE day = ? AND source = ?`).bind(day, source).all();
  const inScope = (r) => !services || services.includes(r.service);
  const before = new Map((had || []).filter(inScope).map((r) => [key(r), r]));
  const stmts = [];
  for (const r of rows) {
    const old = before.get(key(r));
    before.delete(key(r));
    if (!old || Math.abs(old.quantity - r.quantity) > 1e-9 * Math.max(1, Math.abs(r.quantity))) {
      stmts.push(env.DB.prepare(`INSERT INTO cogs_usage
          (day, source, service, metric, detail, org, team, quantity, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (day, source, service, metric, detail, org, team) DO UPDATE SET
          quantity = excluded.quantity, updated_at = excluded.updated_at`)
        .bind(day, source, r.service, r.metric, r.detail || '', r.org || '', r.team || '', r.quantity, at));
    }
  }
  for (const r of before.values()) {
    stmts.push(env.DB.prepare(`DELETE FROM cogs_usage WHERE day = ? AND source = ? AND service = ?
        AND metric = ? AND detail = ? AND org = ? AND team = ?`)
      .bind(day, source, r.service, r.metric, r.detail, r.org, r.team));
  }
  for (let i = 0; i < stmts.length; i += BATCH) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.batch(stmts.slice(i, i + BATCH));
  }
  return stmts.length;
}

/** The days of the last BACKFILL_DAYS before `today` without rows of `source`, latest first. */
async function missingDays(env, source, today) {
  const since = dayOf(Date.parse(iso(today)) - BACKFILL_DAYS * 86400000);
  const { results } = await env.DB.prepare(`SELECT DISTINCT day FROM cogs_usage
    WHERE source = ? AND day >= ? AND day < ?`).bind(source, since, today).all();
  const have = new Set((results || []).map((r) => r.day));
  const out = [];
  const before = (d, n = 1) => dayOf(Date.parse(iso(d)) - n * 86400000);
  for (let d = before(today, 2); d >= since; d = before(d)) {
    if (!have.has(d)) {
      out.push(d);
    }
  }
  return out;
}

/** Cron: rolls up today, yesterday and a few missing days. Says how many rows each wrote. */
export async function rollupCogs(env, { now = Date.now() } = {}) {
  if (!env.DB) {
    return { skipped: 'no D1' };
  }
  const today = dayOf(now);
  const yesterday = dayOf(now - 86400000);
  const out = {};
  const run = async (what, fn) => {
    try {
      out[what] = await fn();
    } catch (e) {
      out[what] = `error: ${e.message}`;
    }
  };
  const days = [yesterday, today];

  if (env.ANALYTICS) {
    for (const day of days) {
      // eslint-disable-next-line no-await-in-loop
      await run(`meter ${day}`, async () => {
        const rows = await meterRows(env, day);
        return rows ? replaceDay(env, day, 'meter', rows, null, now) : 'no dataset';
      });
    }
    const back = (await missingDays(env, 'account', today)).slice(0, BACKFILL_PER_RUN);
    for (const day of [...days, ...back]) {
      // eslint-disable-next-line no-await-in-loop
      await run(`account ${day}`, async () => {
        const { rows, services, errors } = await accountRows(env, day);
        const written = await replaceDay(env, day, 'account', rows, services, now);
        return errors.length ? `${written}, failed: ${errors.join('; ')}` : written;
      });
    }
  }
  const back = (await missingDays(env, 'd1', today)).slice(0, BACKFILL_PER_RUN);
  for (const day of [...days, ...back]) {
    // eslint-disable-next-line no-await-in-loop
    await run(`volume ${day}`, async () => replaceDay(env, day, 'd1', await volumeRows(env, day), ['volume'], now));
  }
  const measured = await env.DB.prepare(`SELECT 1 AS one FROM cogs_usage
    WHERE day = ? AND source = 'd1' AND service = 'workers' AND metric = 'subscription'`).bind(today).first();
  if (!measured) {
    await run(`stored ${today}`, async () => replaceDay(
      env,
      today,
      'd1',
      await storedRows(env, today),
      ['workers', 'd1', 'durable_objects', 'ai_search'],
      now,
    ));
  }
  return out;
}
