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

import { DIMENSIONS, DO_GB, isStock } from './prices.js';

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
 *   full-text items (their number times the average size of an upload), and the Workers Paid plan;
 *   and, once a day too, the account's Cloudflare Access seats, from the Access API (`seatRows`).
 *
 * Each run rolls up today and yesterday (late data), and up to BACKFILL_PER_RUN of the last
 * BACKFILL_DAYS that have no `account` or `d1` rows yet. A row is written only when it changed.
 *
 * The flow of `meter` and `account` is also rolled up by the UTC hour, into `cogs_hours`
 * (migration 0052), for the chart of a short period: the same days, and up to BACKFILL_PER_RUN of
 * the last HOUR_DAYS without `account` hours yet. Older hours are deleted.
 */

export const BACKFILL_DAYS = 30;
export const BACKFILL_PER_RUN = 3;
/** How many days back `cogs_hours` is kept, today not counted. */
export const HOUR_DAYS = 8;
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

const isHour = (h) => Number.isInteger(h) && h >= 0 && h < 24;

/**
 * Rows `{ day, org, team, service, metric, detail, quantity }` added up by key; `hourly`, with
 * their `hour` (0–23) too.
 */
function rowsOf(list_, hourly = false) {
  const m = new Map();
  for (const r of list_) {
    const q = Number(r.quantity);
    const hour = hourly ? Number(r.hour) : null;
    if (!DAY.test(r.day) || !Number.isFinite(q) || !q || (hourly && !isHour(hour))) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const row = {
      day: r.day,
      ...(hourly ? { hour } : {}),
      org: r.org || '',
      team: r.team || '',
      service: r.service,
      metric: r.metric,
      detail: r.detail || '',
    };
    const k = [row.day, hour, row.service, row.metric, row.detail, row.org, row.team].join('\u0000');
    const had = m.get(k);
    m.set(k, had ? { ...had, quantity: had.quantity + q } : { ...row, quantity: q });
  }
  return [...m.values()];
}

/** The hour column of a query, and its grouping, when it is `hourly`. */
const hourOf = (hourly) => (hourly ? { col: 'toHour(timestamp) AS hour, ', by: 'hour, ' } : { col: '', by: '' });

/** What the Worker counted on `day`; `hourly`, by the hour. */
export async function meterRows(env, day, { hourly = false } = {}) {
  const { dataset } = resources(env);
  if (!dataset) {
    return null;
  }
  const h = hourOf(hourly);
  const data = await sql(env, `SELECT toDate(timestamp) AS day, ${h.col}blob1 AS service,
      blob2 AS metric, blob3 AS detail, blob4 AS org, blob5 AS team, SUM(double1) AS quantity
    FROM events.analyticsEngine."${dataset}"
    WHERE timestamp >= '${iso(day)}' AND timestamp < '${iso(nextDay(day))}'
    GROUP BY day, ${h.by}service, metric, detail, org, team
    LIMIT ${LIMIT}`);
  return rowsOf(data.map((r) => ({ ...r, day: String(r.day).slice(0, 10) })), hourly);
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
 * `hourly`: the flow by the hour (`hour` of each row), without what the buckets and indexes hold.
 */
export async function accountRows(env, day, { hourly = false } = {}) {
  const res = resources(env);
  const since = iso(day);
  const until = iso(nextDay(day));
  const h = hourOf(hourly);
  const rows = [];
  const add = (service, metric, detail, quantity, who = {}, hour = 0) => rows.push({
    day, hour, service, metric, detail, quantity, org: who.org || '', team: who.team || '',
  });
  // Each query, with the services it counts: a query that fails leaves those as they were.
  const tries = [];

  if (res.worker) {
    tries.push([['durable_objects'], (async () => {
      const data = await sql(env, `SELECT ${h.col}objectName AS name, invocationType AS type,
          COUNT(*) AS requests, SUM(wallTimeUs) AS wall
        FROM events.durableObjectsInvocations
        WHERE timestamp >= '${since}' AND timestamp < '${until}' AND scriptName = '${res.worker}'
        GROUP BY ${h.by}name, type
        LIMIT ${LIMIT}`);
      const names = [...new Set(data.map((r) => String(r.name || '')))];
      const threads = await threadsOf(env, names.filter((n) => n.includes(':') && !n.startsWith('kb:')));
      const { results: teamRows } = await env.DB.prepare('SELECT slug FROM teams').all();
      const teams = new Set((teamRows || []).map((t) => t.slug));
      for (const r of data) {
        const who = objectOwner(String(r.name || ''), threads, teams);
        add('durable_objects', 'requests', '', Number(r.requests), who, r.hour);
        if (!(who.room && r.type === 'http')) {
          add('durable_objects', 'gb_s', '', (Number(r.wall) / 1e6) * DO_GB, who, r.hour);
        }
      }
    })()]);
    tries.push([['workers', 'workers_logs'], (async () => {
      const data = await sql(env, `SELECT ${h.col}logType AS log, invocationType AS type,
          COUNT(*) AS events, SUM(cpuTimeMs) AS cpu
        FROM logs.workersLogs
        WHERE timestamp >= '${since}' AND timestamp < '${until}' AND scriptName = '${res.worker}'
        GROUP BY ${h.by}log, type
        LIMIT ${LIMIT}`);
      for (const r of data) {
        add('workers_logs', 'events', '', Number(r.events), {}, r.hour);
        // An invocation's own event has its CPU time; a Durable Object's is billed as duration.
        if (r.log === 'cf-worker-event' && ['fetch', 'queue', 'scheduled'].includes(r.type)) {
          add('workers', 'cpu_ms', '', Number(r.cpu), {}, r.hour);
        }
      }
    })()]);
  }
  if (res.artifacts) {
    tries.push([['artifacts'], (async () => {
      const data = await sql(env, `SELECT ${h.col}repositoryName AS repo, COUNT(*) AS n
        FROM events.artifactsEventsByNamespaceAccount
        WHERE timestamp >= '${since}' AND timestamp < '${until}'
          AND repositoryNamespace = '${res.artifacts}' AND eventKind = 'action'
          AND eventType != 'token_create'
        GROUP BY ${h.by}repo
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
        add('artifacts', 'operations', '', Number(r.n), owner(bases.get(r.repo)), r.hour);
      }
    })()]);
  }
  if (res.buckets.length && !hourly) {
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
  if (res.indexes.length && !hourly) {
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
  // The queries above count Analytics SQL queries too (by the hour: in the day's first).
  add('analytics_engine', 'queries', '', tries.length + 1);
  return {
    rows: rowsOf(rows.filter((r) => services.includes(r.service)), hourly), services, errors,
  };
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

const API = 'https://api.cloudflare.com/client/v4';
/** Access users a page (the API's most), and how many pages are read at most. */
const SEAT_PAGE = 1000;
const SEAT_PAGES = 20;

/** Whether the Access seats can be counted: the Access API token and account are set. */
export const seatsConfigured = (env) => Boolean(env.ACCESS_API_TOKEN && env.ACCESS_ACCOUNT_ID);

/**
 * The account's Cloudflare Access seats as of now, for `day`: everyone who signed in to an Access
 * application (or the WARP client) and was not removed since holds one, and every one is priced
 * (the Free plan's 50 are not taken off: past them, every seat is billed). A holder who is a
 * person on ops teams is theirs, split evenly between them; anyone else's is shared. Emails stay
 * here.
 */
export async function seatRows(env, day, { fetchImpl = fetch } = {}) {
  const headers = { authorization: `Bearer ${env.ACCESS_API_TOKEN}` };
  const holders = [];
  for (let page = 1; page <= SEAT_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetchImpl(`${API}/accounts/${env.ACCESS_ACCOUNT_ID}/access/users`
      + `?per_page=${SEAT_PAGE}&page=${page}`, { headers });
    // eslint-disable-next-line no-await-in-loop
    const got = await res.json().catch(() => ({}));
    if (!got.success) {
      throw new Error(`access users: ${res.status} ${JSON.stringify(got.errors || []).slice(0, 200)}`);
    }
    const users = got.result || [];
    for (const u of users) {
      if (u.access_seat || u.gateway_seat) {
        holders.push(String(u.email || '').toLowerCase());
      }
    }
    const pages = Number(got.result_info?.total_pages) || 1;
    if (page >= pages || users.length < SEAT_PAGE) {
      break;
    }
  }
  const { results } = await env.DB.prepare(`SELECT LOWER(p.email) AS email, m.team AS team
    FROM people p JOIN team_members m ON m.person = p.id WHERE p.email IS NOT NULL`).all();
  const teamsOf = new Map();
  for (const r of results || []) {
    teamsOf.set(r.email, [...(teamsOf.get(r.email) || []), r.team]);
  }
  const rows = [];
  for (const email of holders) {
    const teams = (email && teamsOf.get(email)) || [''];
    for (const team of teams) {
      const share = 1 / teams.length;
      rows.push({
        day, team, service: 'zero_trust', metric: 'seats', quantity: share,
      });
    }
  }
  return rowsOf(rows);
}

/** The rows of `day` and `source` in `table` (`cogs_usage`, or `cogs_hours`) replaced. */
async function replace(env, table, day, source, rows, services, now) {
  const at = new Date(now).toISOString();
  const hourly = table === 'cogs_hours';
  const h = hourly ? 'hour, ' : '';
  const andHour = hourly ? 'AND hour = ? ' : '';
  const hourOfRow = (r) => (hourly ? [r.hour] : []);
  const key = (r) => [hourly ? r.hour : '', r.service, r.metric, r.detail || '', r.org || '', r.team || ''].join('\u0000');
  const { results: had } = await env.DB.prepare(`SELECT ${h}service, metric, detail, org, team, quantity
    FROM ${table} WHERE day = ? AND source = ?`).bind(day, source).all();
  const inScope = (r) => !services || services.includes(r.service);
  const before = new Map((had || []).filter(inScope).map((r) => [key(r), r]));
  const stmts = [];
  for (const r of rows) {
    const old = before.get(key(r));
    before.delete(key(r));
    if (!old || Math.abs(old.quantity - r.quantity) > 1e-9 * Math.max(1, Math.abs(r.quantity))) {
      stmts.push(env.DB.prepare(`INSERT INTO ${table}
          (day, ${h}source, service, metric, detail, org, team, quantity, updated_at)
        VALUES (?, ${hourly ? '?, ' : ''}?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (day, ${h}source, service, metric, detail, org, team) DO UPDATE SET
          quantity = excluded.quantity, updated_at = excluded.updated_at`)
        .bind(day, ...hourOfRow(r), source, r.service, r.metric, r.detail || '', r.org || '', r.team || '', r.quantity, at));
    }
  }
  for (const r of before.values()) {
    stmts.push(env.DB.prepare(`DELETE FROM ${table}
      WHERE day = ? ${andHour}AND source = ? AND service = ?
        AND metric = ? AND detail = ? AND org = ? AND team = ?`)
      .bind(day, ...hourOfRow(r), source, r.service, r.metric, r.detail, r.org, r.team));
  }
  for (let i = 0; i < stmts.length; i += BATCH) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.batch(stmts.slice(i, i + BATCH));
  }
  return stmts.length;
}

/**
 * Replaces `source`'s rows of `day` in the selected services with `rows`: writes the ones that
 * changed, deletes the ones that are gone. `services`: only those (a part of a source), or all.
 */
export async function replaceDay(env, day, source, rows, services = null, now = Date.now()) {
  return replace(env, 'cogs_usage', day, source, rows, services, now);
}

/** As `replaceDay`, the hours of `day` (`cogs_hours`; each row has its `hour`). */
export async function replaceHours(env, day, source, rows, services = null, now = Date.now()) {
  return replace(env, 'cogs_hours', day, source, rows, services, now);
}

/**
 * The days of the last `back` before `today` (and yesterday) without rows of `source` in `table`,
 * latest first.
 */
async function missingDays(env, source, today, table = 'cogs_usage', back = BACKFILL_DAYS) {
  const since = dayOf(Date.parse(iso(today)) - back * 86400000);
  const { results } = await env.DB.prepare(`SELECT DISTINCT day FROM ${table}
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

/**
 * Cron: rolls up today, yesterday and a few missing days. Says how many rows each wrote.
 * `fetchImpl`: for the Access API (the seats).
 */
export async function rollupCogs(env, { now = Date.now(), fetchImpl = fetch } = {}) {
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
    // The flow by the hour, for the chart of a short period.
    const flow = (rows) => rows.filter((r) => !isStock(r.service, r.metric));
    const backHours = (await missingDays(env, 'account', today, 'cogs_hours', HOUR_DAYS - 1))
      .slice(0, BACKFILL_PER_RUN);
    for (const day of [...days, ...backHours]) {
      // eslint-disable-next-line no-await-in-loop
      await run(`meter hours ${day}`, async () => {
        const rows = await meterRows(env, day, { hourly: true });
        return rows ? replaceHours(env, day, 'meter', flow(rows), null, now) : 'no dataset';
      });
      // eslint-disable-next-line no-await-in-loop
      await run(`account hours ${day}`, async () => {
        const { rows, services, errors } = await accountRows(env, day, { hourly: true });
        const written = await replaceHours(env, day, 'account', flow(rows), services, now);
        return errors.length ? `${written}, failed: ${errors.join('; ')}` : written;
      });
    }
    await run('hours deleted', async () => {
      const r = await env.DB.prepare('DELETE FROM cogs_hours WHERE day < ?')
        .bind(dayOf(now - HOUR_DAYS * 86400000)).run();
      return (r && r.meta && r.meta.changes) || 0;
    });
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
  // The seats, once a day too: until the first run of the day that could count them.
  const seated = seatsConfigured(env) && await env.DB.prepare(`SELECT 1 AS one FROM cogs_usage
    WHERE day = ? AND source = 'd1' AND service = 'zero_trust'`).bind(today).first();
  if (seatsConfigured(env) && !seated) {
    await run(`seats ${today}`, async () => replaceDay(
      env,
      today,
      'd1',
      await seatRows(env, today, { fetchImpl }),
      ['zero_trust'],
      now,
    ));
  }
  return out;
}
