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

import { DIMENSIONS, DO_GB, isStock } from '../src/cogs/prices.js';
import { HOUR_DAYS } from '../src/cogs/rollup.js';
import { AGENT_EMAIL } from '../src/draftevents.js';

/**
 * The COGS dashboard's made-up usage for `npm run ui:dev` (`/inbox/cogs`): 120 days of what the
 * rollup (src/cogs/rollup.js) would have written into `cogs_usage`, for the fake inbox's
 * customers and teams, from all three sources, so the dashboard shows what production would:
 * the agents' customers cost the most (Bedrock), the inbox's lists and the cron are shared, a
 * quiet weekend, storage that grows, and one model without a price. The last HOUR_DAYS days'
 * flow is in `cogs_hours` too, busiest in the European and American working hours, for the chart
 * of a week. The agents' customers' drafts of the last DRAFT_DAYS days (`draft_events`, as
 * src/draftevents.js records them): most sent, some edited first, some discarded or withdrawn,
 * a few posts of the agents' own, and a few drafts open. The agents' model use of the last
 * EXPERIMENT_DAYS days is split between the cache experiment's arms (src/experiments.js).
 * Seeded, so every start shows the same numbers. Made-up data only.
 */

const DAYS = 120;
const DAY_MS = 86400000;
const AGENTS = new Set(['acme', 'hooli']);
/** How many of the last days the agents were in the cache experiment's arms. */
const EXPERIMENT_DAYS = 4;
/** How long the agents' drafts have been counted, for the preview. */
const DRAFT_DAYS = 40;

/**
 * The agents' drafts of the last DRAFT_DAYS days, for their customers' threads, a few a day each:
 * what became of them, and some open now.
 */
function seedDrafts(DB, rnd, now) {
  DB.sqlite.prepare("INSERT OR IGNORE INTO people (email, name, staff) VALUES (?, 'opspile agent', 0)")
    .run(AGENT_EMAIL);
  const agent = DB.sqlite.prepare('SELECT id FROM people WHERE email = ?').get(AGENT_EMAIL).id;
  const person = DB.sqlite.prepare('SELECT id FROM people WHERE id != ? ORDER BY id LIMIT 1').get(agent)?.id
    ?? agent;
  const threads = DB.sqlite.prepare('SELECT thread, org, team FROM threads ORDER BY thread').all()
    .filter((t) => AGENTS.has(t.org));
  const insert = DB.sqlite.prepare(`INSERT INTO draft_events (thread, draft, version, action, how,
      person, by_agent, origin, origin_agent, changed, org, team, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
  for (let i = DRAFT_DAYS - 1; i >= 0; i -= 1) {
    for (const t of threads) {
      const n = Math.floor(rnd() * 3);
      for (let k = 0; k < n; k += 1) {
        const start = now - i * DAY_MS - rnd() * DAY_MS * 0.9;
        if (start > now) {
          // eslint-disable-next-line no-continue
          continue;
        }
        const draft = new Date(start).toISOString();
        const end = new Date(Math.min(now, start + rnd() * 6 * 3600000)).toISOString();
        insert.run(t.thread, draft, draft, 'saved', null, agent, 1, agent, null, t.org, t.team, draft);
        const p = rnd();
        if (p < 0.45) {
          insert.run(t.thread, draft, draft, 'sent', 'me', person, 0, agent, 0, t.org, t.team, end);
        } else if (p < 0.68) {
          insert.run(t.thread, draft, draft, 'sent', rnd() < 0.3 ? 'app' : 'me', person, 0, agent, 0.05 + rnd() * 0.5, t.org, t.team, end);
        } else if (p < 0.82) {
          insert.run(t.thread, draft, draft, 'discarded', null, person, 0, agent, null, t.org, t.team, end);
        } else if (p < 0.93) {
          insert.run(t.thread, draft, draft, 'discarded', null, agent, 1, agent, null, t.org, t.team, end);
        }
      }
      if (rnd() < 0.15) {
        const at = new Date(Math.min(now, now - i * DAY_MS - rnd() * DAY_MS)).toISOString();
        insert.run(t.thread, '', null, 'posted', 'agent', agent, 1, agent, null, t.org, t.team, at);
      }
    }
  }
  const open = DB.sqlite.prepare(`INSERT OR IGNORE INTO drafts (thread, body, person, created_at,
      updated_at, origin, origin_body) VALUES (?, 'Looking into it.', ?, ?, ?, ?, 'Looking into it.')`);
  const at = new Date(now - 3600000).toISOString();
  threads.slice(0, 3).forEach((t) => open.run(t.thread, agent, at, at, agent));
}

/** A seeded random number generator (Park and Miller's), for the same preview every time. */
function random(seed) {
  let a = seed;
  return () => {
    a = (a * 16807) % 2147483647;
    return (a - 1) / 2147483646;
  };
}

/** The flow of the last HOUR_DAYS days and today by the hour, up to the hour of `now`. */
function seedHours(DB, rnd, now, at) {
  const today = new Date(now).toISOString().slice(0, 10);
  const since = new Date(now - HOUR_DAYS * DAY_MS).toISOString().slice(0, 10);
  const rows = DB.sqlite.prepare(`SELECT * FROM cogs_usage
    WHERE day >= ? AND source IN ('meter', 'account') AND service != 'volume'`).all(since)
    .filter((r) => !isStock(r.service, r.metric));
  const insert = DB.sqlite.prepare(`INSERT INTO cogs_hours (day, hour, source, service, metric, detail,
      org, team, quantity, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const shapes = new Map();
  const shape = (day) => {
    if (!shapes.has(day)) {
      const hours = day === today ? new Date(now).getUTCHours() + 1 : 24;
      const w = Array.from({ length: hours }, (_, h) => 0.15 + (h >= 7 && h <= 22 ? 1 : 0)
        + (h >= 13 && h <= 17 ? 0.6 : 0) + 0.3 * rnd());
      const sum = w.reduce((n, x) => n + x, 0);
      shapes.set(day, w.map((x) => x / sum));
    }
    return shapes.get(day);
  };
  for (const r of rows) {
    shape(r.day).forEach((part, hour) => insert.run(
      r.day,
      hour,
      r.source,
      r.service,
      r.metric,
      r.detail,
      r.org,
      r.team,
      r.quantity * part,
      at,
    ));
  }
}

export function seedCogs(DB, now = Date.now()) {
  const pairs = DB.sqlite.prepare(`SELECT org, team, COUNT(*) AS n FROM threads
    WHERE org != '_unassigned' GROUP BY org, team ORDER BY org, team`).all();
  if (!pairs.length) {
    return;
  }
  const rnd = random(4242);
  const insert = DB.sqlite.prepare(`INSERT INTO cogs_usage (day, source, service, metric, detail, org, team,
      quantity, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (day, source, service, metric, detail, org, team) DO UPDATE SET quantity = quantity + excluded.quantity`);
  const at = new Date(now).toISOString();
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  DB.sqlite.exec('BEGIN');
  for (let i = DAYS - 1; i >= 0; i -= 1) {
    const ms = today - i * DAY_MS;
    const day = new Date(ms).toISOString().slice(0, 10);
    const weekday = new Date(ms).getUTCDay();
    // Weekends are quiet, the volume grows over the months, and today is not over yet.
    const load = (weekday === 0 || weekday === 6 ? 0.3 : 1) * (0.6 + 0.4 * ((DAYS - i) / DAYS))
      * (i === 0 ? (now - today) / DAY_MS : 1);
    const put = (source, service, metric, detail, org, team, q) => {
      if (q > 0) {
        insert.run(day, source, service, metric, detail, org, team, q, at);
      }
    };
    let all = 0;
    for (const { org, team, n } of pairs) {
      const messages = Math.round(n * 6 * load * (0.5 + rnd()));
      const threads = Math.round(messages / (2.5 + rnd() * 2));
      all += messages;
      put('d1', 'volume', 'messages', '', org, team, messages);
      put('d1', 'volume', 'threads', '', org, team, threads);
      put('meter', 'workers', 'requests', '', org, team, messages * 14);
      put('meter', 'd1', 'rows_read', '', org, team, messages * 3800);
      put('meter', 'd1', 'rows_written', '', org, team, messages * 45);
      put('meter', 'r2', 'class_a', 'raw', org, team, messages * 1.2);
      put('meter', 'r2', 'class_b', 'raw', org, team, messages * 2);
      put('meter', 'r2', 'class_a', 'channels', org, team, messages * 1.6);
      put('meter', 'r2', 'class_b', 'channels', org, team, messages * 22);
      put('meter', 'queues', 'operations', '', org, team, messages * 18);
      put('meter', 'workers_ai', 'input_tokens', '@cf/cloudflare/clef', org, team, messages * 2100);
      put('meter', 'workers_ai', 'input_tokens', '@cf/cloudflare/clairic', org, team, messages * 1500);
      put('meter', 'workers_ai', 'input_tokens', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', org, team, messages * 320);
      put('meter', 'workers_ai', 'output_tokens', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', org, team, messages * 9);
      put('meter', 'workers_ai', 'input_tokens', '@cf/baai/bge-base-en-v1.5', org, team, messages * 1100);
      put('meter', 'vectorize', 'queried_dims', 'roots', org, team, messages * 0.4 * DIMENSIONS);
      put('meter', 'ai_search', 'ingest_tokens', '', org, team, messages * 70);
      put('meter', 'ai_search', 'uploads', '', org, team, messages * 0.8);
      put('meter', 'ai_search', 'ingest_bytes', '', org, team, messages * 0.8 * 650);
      put('account', 'artifacts', 'operations', '', org, team, messages * 3);
      if (AGENTS.has(org) && i < EXPERIMENT_DAYS) {
        // The cache experiment (src/experiments.js): half the work in each arm. The five-minute
        // cache misses between turns, so it writes more, at a lower price per token.
        const model = 'us.anthropic.claude-opus-5-5';
        for (const [arm, part] of [['long', 0.52], ['short', 0.48]]) {
          const m = messages * part;
          const tag = `${model}#cache=${arm}`;
          put('meter', 'bedrock', 'input_tokens', tag, org, team, m * 2400);
          put('meter', 'bedrock', 'output_tokens', tag, org, team, m * 1300);
          if (arm === 'long') {
            put('meter', 'bedrock', 'cache_read_tokens', tag, org, team, m * 52000);
            put('meter', 'bedrock', 'cache_write_1h_tokens', tag, org, team, m * 6100);
          } else {
            put('meter', 'bedrock', 'cache_read_tokens', tag, org, team, m * 49500);
            put('meter', 'bedrock', 'cache_write_tokens', tag, org, team, m * 8600);
          }
        }
      } else if (AGENTS.has(org)) {
        put('meter', 'bedrock', 'input_tokens', 'us.anthropic.claude-opus-5-5', org, team, messages * 2400);
        put('meter', 'bedrock', 'output_tokens', 'us.anthropic.claude-opus-5-5', org, team, messages * 1300);
        put('meter', 'bedrock', 'cache_read_tokens', 'us.anthropic.claude-opus-5-5', org, team, messages * 52000);
        put('meter', 'bedrock', 'cache_write_1h_tokens', 'us.anthropic.claude-opus-5-5', org, team, messages * 6100);
      }
      if (AGENTS.has(org)) {
        // The thread agents: Claude on Bedrock (above), their Durable Objects and their browser.
        put('meter', 'workers_ai', 'input_tokens', '@cf/cloudflare/clef', org, team, messages * 400);
        put('meter', 'browser_run', 'browser_ms', '', org, team, messages * 900 * rnd());
        put('account', 'durable_objects', 'requests', '', org, team, messages * 9);
        put('account', 'durable_objects', 'gb_s', '', org, team, messages * 140 * DO_GB);
      }
    }
    // Shared: the inbox's lists and live updates, the cron, search, the team rooms.
    put('meter', 'workers', 'requests', '', '', '', 9000 * load);
    put('meter', 'd1', 'rows_read', '', '', '', 4.2e6 * load);
    put('meter', 'd1', 'rows_written', '', '', '', 2400 * load);
    put('meter', 'r2', 'class_b', 'channels', '', '', 1800 * load);
    put('meter', 'ai_search', 'fulltext_queries', '', '', '', 40 * load);
    put('meter', 'workers_ai', 'input_tokens', '@cf/baai/bge-base-en-v1.5', '', '', 60 * 12 * load);
    put('meter', 'vectorize', 'queried_dims', 'content', '', '', 60 * DIMENSIONS * load);
    put('meter', 'analytics_engine', 'points', '', '', '', all * 9 + 3000 * load);
    // A model the price list does not know yet.
    if (i < 10) {
      put('meter', 'workers_ai', 'input_tokens', '@cf/cloudflare/clef-next', '', '', 4000 * load);
    }
    put('account', 'workers', 'cpu_ms', '', '', '', (all * 60 + 400000) * load);
    put('account', 'workers_logs', 'events', '', '', '', (all * 18 + 30000) * load);
    put('account', 'analytics_engine', 'queries', '', '', '', 72 * 6);
    for (const team of [...new Set(pairs.map((p) => p.team))]) {
      put('account', 'durable_objects', 'requests', '', '', team, 900 * load);
      put('account', 'durable_objects', 'gb_s', '', '', team, 40 * load);
    }
    put('d1', 'volume', 'days', '', '', '', 1);
    // Stock, measured once a day for the last 60: it grows.
    if (i < 60) {
      const grown = 1 + (60 - i) / 60;
      put('account', 'r2', 'stored_bytes', 'helix-opspile-raw', '', '', 0.06e9 * grown);
      put('account', 'r2', 'stored_bytes', 'helix-opspile-channels', '', '', 0.02e9 * grown);
      put('account', 'r2', 'stored_bytes', 'helix-opspile-files', '', '', 0.11e9 * grown);
      put('account', 'vectorize', 'stored_dims', 'helix-opspile-roots', '', '', 11000 * grown * DIMENSIONS);
      put('account', 'vectorize', 'stored_dims', 'helix-opspile-content', '', '', 3500 * grown * DIMENSIONS);
      put('d1', 'd1', 'stored_bytes', '', '', '', 32e6 * grown);
      put('d1', 'workers', 'subscription', '', '', '', 1);
      for (const { org, team, n } of pairs) {
        put('d1', 'ai_search', 'stored_bytes', '', org, team, n * 4 * 650 * grown);
        if (AGENTS.has(org)) {
          put('d1', 'durable_objects', 'stored_bytes', '', org, team, n * 2.5e6 * grown);
        }
      }
    }
  }
  seedHours(DB, rnd, now, at);
  seedDrafts(DB, rnd, now);
  DB.sqlite.exec('COMMIT');
}
