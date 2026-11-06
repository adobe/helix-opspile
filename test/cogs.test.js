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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { api } from '../src/api.js';
import {
  agentSubject, fit, followed, MAX_POINTS, Meter, modelUsage, objectMeter,
} from '../src/cogs/meter.js';
import {
  bedrockModel, costOf, isStock, priceList, unitPrice,
} from '../src/cogs/prices.js';
import {
  allocate, chartUnit, cogsReport, columns, estimateWindow, period,
} from '../src/cogs/report.js';
import {
  accountRows, meterRows, replaceDay, replaceHours, resources, rollupCogs, volumeRows,
} from '../src/cogs/rollup.js';
import { AGENT_EMAIL } from '../src/drafts.js';
import { jobSubject } from '../src/normalizer.js';
import { d1 } from './d1.js';

// Made-up customers, teams, people and resource names only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
};
const asMe = (p) => ({ ...p, teams: p.teams.map((slug) => ({ slug })) });
const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

function usage() {
  const points = [];
  return { points, writeDataPoint: (p) => points.push(p) };
}

/** A D1 binding that answers with `meta`, as D1 does. */
function metaDb() {
  const stmt = {
    bind: () => stmt,
    all: async () => ({ results: [{ a: 1 }], meta: { rows_read: 7, rows_written: 0 } }),
    run: async () => ({ results: [], meta: { rows_read: 1, rows_written: 3 } }),
    first: async () => ({ org: 'acme', team: 'helix' }),
    raw: async () => [[1], [2]],
  };
  return {
    prepare: () => stmt,
    batch: async (stmts) => stmts.map(() => ({ meta: { rows_read: 2, rows_written: 2 } })),
  };
}

const points = (u) => Object.fromEntries(u.points.map((p) => [`${p.blobs[0]}/${p.blobs[1]}/${p.blobs[2]}@${p.blobs[3]}:${p.blobs[4]}`, p.doubles[0]]));

function thread(DB, key, org, team, rootAt) {
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      kind, channel_name, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, 'slack', 'E1', 'C1', ?, ?, ?, 'channel', 'aem-x', 'p/', ?, ?, ?, 1, ?)`)
    .run(key, key, org, team, rootAt, rootAt, rootAt, rootAt);
}
function message(DB, key, id, at, item = null) {
  DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, counted, search_item)
    VALUES ('slack', 'E1', 'C1', ?, ?, ?, 1, ?)`).run(id, key, at, item);
}
/** A row of `cogs_usage`, and with `hour`, the same of `cogs_hours` too. */
function usageRow(DB, row) {
  if (row.hour !== undefined) {
    DB.sqlite.prepare(`INSERT INTO cogs_hours (day, hour, source, service, metric, detail, org, team,
        quantity, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-11-01T00:00:00Z')`).run(
      row.day,
      row.hour,
      row.source || 'meter',
      row.service,
      row.metric,
      row.detail || '',
      row.org || '',
      row.team || '',
      row.quantity,
    );
  }
  DB.sqlite.prepare(`INSERT INTO cogs_usage (day, source, service, metric, detail, org, team, quantity, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-11-01T00:00:00Z')`).run(
    row.day,
    row.source || 'meter',
    row.service,
    row.metric,
    row.detail || '',
    row.org || '',
    row.team || '',
    row.quantity,
  );
}

describe('cogs: prices', () => {
  it('prices flow per unit and stock per month', () => {
    close(costOf('workers', 'requests', '', 2e6), 0.6);
    close(costOf('r2', 'class_a', 'raw', 1e6), 4.5);
    close(costOf('r2', 'stored_bytes', 'helix-opspile-raw', 2e9), 0.03);
    close(costOf('ai_search', 'fulltext_queries', '', 1000), 0.10);
    close(costOf('browser_run', 'browser_ms', '', 3.6e6), 0.09);
    assert.equal(isStock('r2', 'stored_bytes'), true);
    assert.equal(isStock('r2', 'class_a'), false);
    assert.equal(costOf('nope', 'x', '', 5), 0);
  });

  it('prices models: Workers AI by id, Bedrock by the model behind the inference profile', () => {
    close(costOf('workers_ai', 'input_tokens', '@cf/cloudflare/clef', 1e6), 0.24);
    close(costOf('workers_ai', 'output_tokens', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 1e6), 2.253);
    assert.equal(unitPrice('workers_ai', 'input_tokens', '@cf/unknown/model'), null);
    assert.equal(bedrockModel('us.anthropic.claude-opus-5-5'), 'claude-opus-5-5');
    assert.equal(bedrockModel('anthropic.claude-opus-5-5-v1:0'), 'claude-opus-5-5');
    // An experiment's arm after the model is not part of it.
    assert.equal(bedrockModel('us.anthropic.claude-opus-5-5#cache=short'), 'claude-opus-5-5');
    close(costOf('bedrock', 'cache_write_tokens', 'us.anthropic.claude-opus-5-5#cache=short', 1e6), 5);
    close(costOf('bedrock', 'input_tokens', 'us.anthropic.claude-opus-5-5', 1e6), 4);
    close(costOf('bedrock', 'cache_write_1h_tokens', 'us.anthropic.claude-opus-5-5', 1e6), 8);
    // The catalog's cost counts only for a model not priced here.
    assert.equal(costOf('bedrock', 'catalog_usd', 'us.anthropic.claude-opus-5-5', 3), 0);
    assert.equal(costOf('bedrock', 'catalog_usd', 'us.anthropic.claude-next', 3), 3);
    const list = priceList();
    assert.ok(list.asOf);
    assert.ok(list.services.every((s) => s.url.startsWith('https://')));
    assert.ok(!list.services.find((s) => s.id === 'bedrock').metrics.some((m) => m.id === 'catalog_usd'));
  });
});

describe('cogs: meter', () => {
  it('leaves the environment alone without an Analytics Engine dataset', async () => {
    const env = { DB: metaDb() };
    const m = new Meter(env);
    assert.equal(m.env({ thread: 't' }), env);
    assert.deepEqual(await m.flush(), { points: 0 });
  });

  it('counts D1 rows, R2 operations, queue operations, Workers AI, Vectorize and AI Search', async () => {
    const USAGE = usage();
    const sent = [];
    const bucket = {
      get: async () => ({ text: async () => 'x' }),
      head: async () => null,
      put: async () => ({}),
      list: async () => ({ objects: [] }),
      delete: async () => {},
    };
    const base = {
      USAGE,
      DB: metaDb(),
      RAW: bucket,
      CHANNELS: bucket,
      NORMALIZE: { send: async (b) => sent.push(b), sendBatch: async (l) => sent.push(...l) },
      AI: {
        run: async (model) => (model.includes('clef') ? { answers: {}, usage: { prompt_tokens: 1200 } }
          : { data: [[0.1]] }),
        toMarkdown: async () => [{}],
      },
      VECTORS: { query: async () => ({ matches: [] }), upsert: async () => ({}) },
      SEARCH: {
        search: async () => ({ chunks: [] }),
        items: { upload: async () => ({ id: 'i1' }), delete: async () => {} },
      },
    };
    const m = new Meter(base, { via: 'queue' });
    const env = m.env({ org: 'acme', team: 'helix' });
    await env.DB.prepare('SELECT 1').bind(1).all();
    await env.DB.prepare('UPDATE x').run();
    await env.DB.prepare('SELECT 1').first();
    await env.DB.prepare('SELECT 1').raw();
    await env.DB.batch([env.DB.prepare('A'), env.DB.prepare('B')]);
    await env.RAW.get('k');
    await env.RAW.put('k', 'v');
    await env.CHANNELS.head('k');
    await env.CHANNELS.list({ prefix: 'p' });
    await env.CHANNELS.delete('k');
    await env.NORMALIZE.send({ label: 't' });
    await env.NORMALIZE.sendBatch([{ body: { a: 1 } }, { body: { b: 'x'.repeat(70000) } }]);
    await env.AI.run('@cf/cloudflare/clef', { model: 'clef', state: 's', questions: {} });
    await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: ['abcdefgh', 'abcd'] });
    await env.AI.toMarkdown([{ name: 'a.pdf' }]);
    await env.VECTORS.query([0.1], { topK: 4 });
    await env.VECTORS.upsert([{ id: 'a' }, { id: 'b' }]);
    await env.SEARCH.search({ query: 'q', ai_search_options: { retrieval: { retrieval_type: 'keyword' } } });
    await env.SEARCH.items.upload('n', 'x'.repeat(400), {});
    await env.SEARCH.items.delete('i1');
    env.meter.add('workers', 'requests', '', 0.5);
    assert.equal(sent.length, 3);
    assert.deepEqual(await m.flush(), { points: 19 });
    const p = points(USAGE);
    assert.equal(p['d1/rows_read/@acme:helix'], 7 + 1 + 1 + 2 + 4);
    assert.equal(p['d1/rows_written/@acme:helix'], 3 + 4);
    assert.equal(p['r2/class_b/raw@acme:helix'], 1);
    assert.equal(p['r2/class_a/raw@acme:helix'], 1);
    assert.equal(p['r2/class_b/channels@acme:helix'], 1);
    assert.equal(p['r2/class_a/channels@acme:helix'], 1);
    // Three operations per 64 KB of each message.
    assert.equal(p['queues/operations/@acme:helix'], 3 + 3 + 6);
    assert.equal(p['workers_ai/input_tokens/@cf/cloudflare/clef@acme:helix'], 1200);
    assert.equal(p['workers_ai/input_tokens/@cf/baai/bge-base-en-v1.5@acme:helix'], 3);
    assert.equal(p['workers_ai/requests/@cf/baai/bge-base-en-v1.5@acme:helix'], 1);
    assert.equal(p['workers_ai/conversions/@acme:helix'], 1);
    assert.equal(p['vectorize/queried_dims/roots@acme:helix'], 768);
    assert.equal(p['vectorize/written_dims/roots@acme:helix'], 2 * 768);
    assert.equal(p['ai_search/fulltext_queries/@acme:helix'], 1);
    assert.equal(p['ai_search/ingest_tokens/@acme:helix'], 100);
    assert.equal(p['workers/requests/@acme:helix'], 0.5);
    // What the meter writes is counted too, as shared.
    assert.equal(p['analytics_engine/points/@:'], 20);
    assert.ok(USAGE.points.every((x) => x.blobs[5] === 'queue'));
    // Flushed once: a second flush writes nothing new.
    assert.deepEqual(await m.flush(), { points: 0 });
  });

  it('attributes work to the customer and team of its thread, or names them later', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix ops' }] });
    thread(DB, 'slack:E1:C1:1.1', 'acme', 'helix', '2026-11-01T10:00:00Z');
    const USAGE = usage();
    const m = new Meter({ USAGE, DB });
    m.env({ thread: 'slack:E1:C1:1.1' }).meter.add('workers', 'requests', '', 1);
    const later = m.env({});
    later.meter.add('workers', 'requests', '', 1);
    later.meter.attribute({ org: 'globex', team: '' });
    m.env({}).meter.add('workers', 'requests', '', 1);
    await m.flush();
    const p = points(USAGE);
    assert.equal(p['workers/requests/@acme:helix'], 1);
    assert.equal(p['workers/requests/@globex:'], 1);
    assert.equal(p['workers/requests/@:'], 1);
    assert.deepEqual(USAGE.points.find((x) => x.blobs[3] === 'acme').indexes, ['acme']);
  });

  it('keeps under Analytics Engine\'s points per invocation, folding details, then customers', () => {
    const many = Array.from({ length: 300 }, (_, i) => [[`o${i % 50}`, 't', 'workers_ai', 'input_tokens', `m${i}`].join('\u0000'), 1]);
    const folded = fit(many);
    assert.equal(folded.length, 50);
    assert.equal(folded.reduce((n, [, q]) => n + q, 0), 300);
    const wide = Array.from({ length: 300 }, (_, i) => [[`o${i}`, 't', 's', 'm', ''].join('\u0000'), 2]);
    assert.deepEqual(fit(wide), [[['', '', 's', 'm', ''].join('\u0000'), 600]]);
    assert.ok(fit(many).length <= MAX_POINTS);
  });

  it('meters a Durable Object as its own subject, and flushes it by itself', async () => {
    assert.deepEqual(agentSubject('kb:helix:acme'), { team: 'helix', org: 'acme' });
    assert.deepEqual(agentSubject('kb:helix:'), { team: 'helix', org: '' });
    assert.deepEqual(agentSubject('slack:E1:C1:1.1'), { thread: 'slack:E1:C1:1.1' });
    const USAGE = usage();
    const who = { name: null };
    const o = objectMeter({ USAGE, DB: metaDb() }, { via: 'agent', subject: () => agentSubject(who.name), delay: 5 });
    who.name = 'kb:helix:acme';
    await o.env.DB.prepare('UPDATE x').run();
    o.scope.add('bedrock', 'input_tokens', 'us.anthropic.claude-opus-5-5', 100);
    await sleep(30);
    const p = points(USAGE);
    assert.equal(p['bedrock/input_tokens/us.anthropic.claude-opus-5-5@acme:helix'], 100);
    assert.equal(p['d1/rows_written/@acme:helix'], 3);
    // It keeps counting after a flush.
    o.scope.add('browser_run', 'browser_ms', '', 50);
    await o.meter.flush();
    assert.equal(points(USAGE)['browser_run/browser_ms/@acme:helix'], 50);
  });

  it('counts an agent\'s model use from its ledger: only what is new, not what was before', () => {
    const u = (input, output, extra = {}) => ({
      input, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, ...extra,
    });
    const key = 'opspile-bedrock/us.anthropic.claude-opus-5-5';
    const first = modelUsage(undefined, { models: { [key]: u(5000, 100) }, tools: {} });
    assert.deepEqual(first.adds, []);
    const next = modelUsage(first.now, {
      models: { [key]: u(7000, 300, { cacheWrite: 900, cacheWrite1h: 600, cost: { total: 0.5 } }) },
      tools: { codemode: u(10, 5) },
    }, 'us.anthropic.claude-opus-5-5');
    assert.deepEqual(next.adds, [
      ['input_tokens', 'us.anthropic.claude-opus-5-5', 2000],
      ['output_tokens', 'us.anthropic.claude-opus-5-5', 200],
      ['cache_write_tokens', 'us.anthropic.claude-opus-5-5', 300],
      ['cache_write_1h_tokens', 'us.anthropic.claude-opus-5-5', 600],
      ['catalog_usd', 'us.anthropic.claude-opus-5-5', 0.5],
      ['input_tokens', 'us.anthropic.claude-opus-5-5', 10],
      ['output_tokens', 'us.anthropic.claude-opus-5-5', 5],
    ]);
    // An agent in an experiment's arm: the arm follows the model in every detail.
    const tagged = modelUsage(next.now, {
      models: { [key]: u(7100, 300, { cacheWrite: 900, cacheWrite1h: 600, cost: { total: 0.5 } }) },
      tools: { codemode: u(12, 5) },
    }, 'us.anthropic.claude-opus-5-5', '#cache=short');
    assert.deepEqual(tagged.adds, [
      ['input_tokens', 'us.anthropic.claude-opus-5-5#cache=short', 100],
      ['input_tokens', 'us.anthropic.claude-opus-5-5#cache=short', 2],
    ]);
    // A new session: its ledger starts again.
    const reset = modelUsage(next.now, { models: { [key]: u(40, 2) } });
    assert.deepEqual(reset.adds.slice(0, 2), [
      ['input_tokens', 'us.anthropic.claude-opus-5-5', 40],
      ['output_tokens', 'us.anthropic.claude-opus-5-5', 2],
    ]);
  });

  it('waits for the work an invocation left running', async () => {
    const seen = [];
    const ctx = followed({ waitUntil: (p) => seen.push(p) });
    let done = false;
    // Work that adds more work as it goes.
    ctx.waitUntil(sleep(5).then(() => {
      ctx.waitUntil(sleep(5).then(() => {
        done = true;
      }));
    }));
    await ctx.settled();
    assert.equal(done, true);
    assert.equal(seen.length, 2);
  });

  it('names the thread of a queue job', () => {
    assert.deepEqual(jobSubject({ label: 't1' }), { thread: 't1' });
    assert.deepEqual(jobSubject({ backfill: { thread: 't2' } }), { thread: 't2' });
    assert.deepEqual(jobSubject({ export: ['t3'] }), { thread: 't3' });
    assert.deepEqual(jobSubject({ export: ['t3', 't4'] }), {});
    assert.deepEqual(jobSubject({ key: 'slack/E1/C1/x.json' }), {});
  });
});

const RESOURCES = JSON.stringify({
  worker: 'ops-worker',
  dataset: 'ops-usage',
  artifacts: 'ops-kb',
  buckets: ['ops-raw', 'ops-channels'],
  indexes: ['ops-roots'],
});

/** Cloudflare's analytics, made up: answers by the dataset a query reads. */
function analytics(answers) {
  const asked = [];
  return {
    asked,
    query: async ({ query }) => {
      asked.push(query);
      const hit = Object.entries(answers).find(([from]) => query.includes(from));
      if (!hit) {
        throw new Error(`unexpected query: ${query.slice(0, 80)}`);
      }
      if (hit[1] instanceof Error) {
        throw hit[1];
      }
      return { data: hit[1] };
    },
  };
}

describe('cogs: rollup', () => {
  it('reads only resource names it may put into SQL', () => {
    const r = resources({ COGS_RESOURCES: JSON.stringify({ worker: "x'; DROP", buckets: ['ok-1', 'no way'] }) });
    assert.equal(r.worker, null);
    assert.deepEqual(r.buckets, ['ok-1']);
    assert.deepEqual(resources({}).indexes, []);
  });

  it('rolls up the meter, Cloudflare\'s analytics and D1, writing only what changed', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix ops' }] });
    thread(DB, 'slack:E1:C1:1.1', 'acme', 'helix', '2026-11-02T09:00:00Z');
    thread(DB, 'slack:E1:C1:2.1', 'globex', 'helix', '2026-11-01T09:00:00Z');
    message(DB, 'slack:E1:C1:1.1', '1.1', '2026-11-02T09:00:00Z', 'item-1');
    message(DB, 'slack:E1:C1:1.1', '1.2', '2026-11-02T10:00:00Z');
    message(DB, 'slack:E1:C1:2.1', '2.1', '2026-11-01T09:00:00Z', 'item-2');
    DB.sqlite.prepare(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
      VALUES ('kb-org-acme', 'org', 'acme', 'r', '2026-10-01T00:00:00Z')`).run();
    DB.sqlite.prepare(`INSERT INTO cogs_objects (name, org, team, bytes, at)
      VALUES ('slack:E1:C1:1.1', 'acme', 'helix', 4096, '2026-11-02T00:00:00Z')`).run();
    const ANALYTICS = analytics({
      'events.analyticsEngine."ops-usage"': [
        {
          day: '2026-11-02', service: 'workers_ai', metric: 'input_tokens', detail: '@cf/cloudflare/clef', org: 'acme', team: 'helix', quantity: 5000,
        },
        {
          day: '2026-11-02', service: 'workers', metric: 'requests', detail: '', org: '', team: '', quantity: 40,
        },
      ],
      'events.durableObjectsInvocations': [
        {
          name: 'slack:E1:C1:1.1', type: 'alarm', requests: 3, wall: 8e6,
        },
        // A room's WebSocket connections hibernate: requests, but no duration.
        {
          name: 'helix', type: 'http', requests: 2, wall: 9e9,
        },
        {
          name: 'helix', type: 'jsrpc', requests: 4, wall: 1e6,
        },
      ],
      'logs.workersLogs': [
        {
          log: 'cf-worker-event', type: 'fetch', events: 10, cpu: 250,
        },
        {
          log: 'cf-worker-event', type: 'alarm', events: 5, cpu: 900,
        },
        {
          log: 'cf-worker', type: 'fetch', events: 20, cpu: 0,
        },
      ],
      'events.artifactsEventsByNamespaceAccount': [{ repo: 'kb-org-acme', n: 12 }, { repo: 'gh-x', n: 3 }],
      'states.r2CombinedStorage': [{ bucket: 'ops-raw', payload: 1e9, meta: 1e6 }],
      'states.vectorizeStorage': [{ idx: 'ops-roots', vectors: 1000 }],
    });
    const env = { DB, ANALYTICS, COGS_RESOURCES: RESOURCES };
    const now = Date.parse('2026-11-02T12:00:00Z');
    const out = await rollupCogs(env, { now });
    assert.ok(Object.values(out).every((v) => typeof v === 'number'), JSON.stringify(out));
    const rows = DB.sqlite.prepare(`SELECT day, source, service, metric, detail, org, team, quantity
      FROM cogs_usage WHERE day = '2026-11-02' ORDER BY source, service, metric, org`).all().map((r) => ({ ...r }));
    const q = (source, service, metric, org = '', team = '', detail = null) => rows
      .filter((r) => r.source === source && r.service === service && r.metric === metric
        && r.org === org && r.team === team && (detail === null || r.detail === detail))
      .reduce((n, r) => n + r.quantity, 0);
    assert.equal(q('meter', 'workers_ai', 'input_tokens', 'acme', 'helix'), 5000);
    assert.equal(q('meter', 'workers', 'requests'), 40);
    assert.equal(q('account', 'durable_objects', 'requests', 'acme', 'helix'), 3);
    close(q('account', 'durable_objects', 'gb_s', 'acme', 'helix'), 8 * 0.128);
    assert.equal(q('account', 'durable_objects', 'requests', '', 'helix'), 6);
    close(q('account', 'durable_objects', 'gb_s', '', 'helix'), 1 * 0.128);
    assert.equal(q('account', 'workers', 'cpu_ms'), 250);
    assert.equal(q('account', 'workers_logs', 'events'), 35);
    assert.equal(q('account', 'artifacts', 'operations', 'acme'), 12);
    assert.equal(q('account', 'artifacts', 'operations'), 3);
    assert.equal(q('account', 'r2', 'stored_bytes', '', '', 'ops-raw'), 1e9 + 1e6);
    assert.equal(q('account', 'vectorize', 'stored_dims', '', '', 'ops-roots'), 768000);
    assert.equal(q('d1', 'volume', 'messages', 'acme', 'helix'), 2);
    assert.equal(q('d1', 'volume', 'threads', 'acme', 'helix'), 1);
    assert.equal(q('d1', 'workers', 'subscription'), 1);
    assert.equal(q('d1', 'durable_objects', 'stored_bytes', 'acme', 'helix'), 4096);
    // Indexed items at the average upload, or 800 bytes when nothing was measured.
    assert.equal(q('d1', 'ai_search', 'stored_bytes', 'acme', 'helix'), 800);
    assert.equal(q('d1', 'ai_search', 'stored_bytes', 'globex', 'helix'), 800);
    // Yesterday too, and nothing written twice when nothing changed.
    assert.equal(DB.sqlite.prepare(`SELECT quantity FROM cogs_usage WHERE day = '2026-11-01' AND source = 'd1'
      AND metric = 'messages' AND org = 'globex'`).get().quantity, 1);
    const again = await rollupCogs(env, { now });
    assert.equal(again['meter 2026-11-02'], 0);
    assert.equal(again['volume 2026-11-02'], 0);
    assert.equal(again['stored 2026-11-02'], undefined, 'storage is measured once a day');
  });

  it('rolls up the flow by the hour too, for a week, and lets older hours go', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix ops' }] });
    thread(DB, 'slack:E1:C1:1.1', 'acme', 'helix', '2026-11-02T09:00:00Z');
    const ANALYTICS = analytics({
      'events.analyticsEngine."ops-usage"': [
        {
          day: '2026-11-02', hour: 9, service: 'workers', metric: 'requests', detail: '', org: 'acme', team: 'helix', quantity: 30,
        },
        {
          day: '2026-11-02', hour: '10', service: 'workers', metric: 'requests', detail: '', org: 'acme', team: 'helix', quantity: 10,
        },
      ],
      'events.durableObjectsInvocations': [
        {
          hour: 9, name: 'slack:E1:C1:1.1', type: 'alarm', requests: 3, wall: 8e6,
        },
      ],
      'logs.workersLogs': [
        {
          hour: 11, log: 'cf-worker-event', type: 'fetch', events: 10, cpu: 250,
        },
      ],
      'events.artifactsEventsByNamespaceAccount': [{ hour: 9, repo: 'gh-x', n: 3 }],
      'states.r2CombinedStorage': [{ bucket: 'ops-raw', payload: 1e9, meta: 1e6 }],
      'states.vectorizeStorage': [{ idx: 'ops-roots', vectors: 1000 }],
    });
    usageRow(DB, {
      day: '2026-10-20', hour: 3, service: 'workers', metric: 'requests', quantity: 1,
    });
    const env = { DB, ANALYTICS, COGS_RESOURCES: RESOURCES };
    const now = Date.parse('2026-11-02T12:00:00Z');
    const out = await rollupCogs(env, { now });
    assert.ok(Object.values(out).every((v) => typeof v === 'number'), JSON.stringify(out));
    const hours = (day) => DB.sqlite.prepare(`SELECT hour, source, service, metric, org, quantity
      FROM cogs_hours WHERE day = ? ORDER BY hour, source, service, metric`).all(day)
      .map((r) => [r.hour, r.source, `${r.service}/${r.metric}`, r.org, r.quantity]);
    assert.deepEqual(hours('2026-11-02'), [
      [0, 'account', 'analytics_engine/queries', '', 4],
      [9, 'account', 'artifacts/operations', '', 3],
      [9, 'account', 'durable_objects/gb_s', 'acme', 8 * 0.128],
      [9, 'account', 'durable_objects/requests', 'acme', 3],
      [9, 'meter', 'workers/requests', 'acme', 30],
      [10, 'meter', 'workers/requests', 'acme', 10],
      [11, 'account', 'workers/cpu_ms', '', 250],
      [11, 'account', 'workers_logs/events', '', 10],
    ]);
    // The days added up are as before: the hours are the chart's only.
    assert.equal(DB.sqlite.prepare(`SELECT quantity FROM cogs_usage WHERE day = '2026-11-02'
      AND source = 'meter' AND service = 'workers'`).get().quantity, 40);
    assert.equal(ANALYTICS.asked.filter((q) => q.includes('r2CombinedStorage')).length, 2 + 3, 'storage by the day only');
    // Yesterday, and three of the days before it; the hours of before the week are gone.
    const days = DB.sqlite.prepare(`SELECT DISTINCT day FROM cogs_hours WHERE source = 'account'
      ORDER BY day DESC`).all().map((r) => r.day);
    assert.deepEqual(days, ['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30', '2026-10-29']);
    assert.equal(out['hours deleted'], 1);
    const again = await rollupCogs(env, { now });
    assert.equal(again['meter hours 2026-11-02'], 0);
    assert.equal(again['account hours 2026-11-02'], 0);
    assert.ok(again['account hours 2026-10-26'] > 0);
    assert.equal(again['account hours 2026-10-25'], undefined, 'a week back, no more');
    assert.equal(await replaceHours(env, '2026-11-02', 'meter', [], null, now), 2);
  });

  it('keeps what a failing query of Cloudflare\'s counts as it was, and writes the rest', async () => {
    const DB = d1();
    const env = {
      DB,
      COGS_RESOURCES: RESOURCES,
      ANALYTICS: analytics({
        'events.durableObjectsInvocations': new Error('rate limited'),
        'logs.workersLogs': [],
        'events.artifactsEventsByNamespaceAccount': [],
        'states.r2CombinedStorage': [],
        'states.vectorizeStorage': [],
      }),
    };
    const r = await accountRows(env, '2026-11-02');
    assert.deepEqual(r.errors, ['durable_objects: rate limited']);
    assert.ok(!r.services.includes('durable_objects'));
    usageRow(DB, {
      day: '2026-11-02', source: 'account', service: 'durable_objects', metric: 'gb_s', quantity: 5,
    });
    const out = await rollupCogs(env, { now: Date.parse('2026-11-02T12:00:00Z') });
    assert.match(out['account 2026-11-02'], /failed: durable_objects: rate limited/);
    assert.equal(DB.sqlite.prepare(`SELECT quantity FROM cogs_usage WHERE source = 'account'
      AND service = 'durable_objects' AND day = '2026-11-02'`).get().quantity, 5);
    assert.equal(await meterRows({ COGS_RESOURCES: '{}' }, '2026-11-02'), null);
  });

  it('replaces a day: changed rows written, gone ones deleted, other services left alone', async () => {
    const DB = d1();
    const env = { DB };
    const day = '2026-11-02';
    const rows = [
      {
        service: 'volume', metric: 'messages', detail: '', org: 'acme', team: 'helix', quantity: 3,
      },
      {
        service: 'volume', metric: 'messages', detail: '', org: 'globex', team: 'helix', quantity: 1,
      },
    ];
    assert.equal(await replaceDay(env, day, 'd1', rows, ['volume']), 2);
    usageRow(DB, {
      day, source: 'd1', service: 'workers', metric: 'subscription', quantity: 1,
    });
    assert.equal(await replaceDay(env, day, 'd1', rows, ['volume']), 0);
    assert.equal(await replaceDay(env, day, 'd1', [{ ...rows[0], quantity: 4 }], ['volume']), 2);
    const left = DB.sqlite.prepare('SELECT service, org, quantity FROM cogs_usage ORDER BY service').all().map((r) => ({ ...r }));
    assert.deepEqual(left, [
      { service: 'volume', org: 'acme', quantity: 4 },
      { service: 'workers', org: '', quantity: 1 },
    ]);
  });

  it('counts the day\'s messages and new threads per customer and team', async () => {
    const DB = d1();
    thread(DB, 't1', 'acme', 'helix', '2026-11-02T01:00:00Z');
    thread(DB, 't0', 'acme', 'helix', '2026-10-30T01:00:00Z');
    message(DB, 't1', '1', '2026-11-02T01:00:00Z');
    message(DB, 't0', '2', '2026-11-02T23:59:59Z');
    message(DB, 't0', '3', '2026-11-03T00:00:00Z');
    const rows = await volumeRows({ DB }, '2026-11-02');
    const by = Object.fromEntries(rows.map((r) => [`${r.metric}@${r.org}`, r.quantity]));
    assert.deepEqual(by, { 'days@': 1, 'messages@acme': 2, 'threads@acme': 1 });
  });
});

describe('cogs: report', () => {
  /** Two days of usage; `counting`: every source counted since long before them. */
  function seeded({ counting = true } = {}) {
    const DB = d1({ teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }], people: [ADA, BO] });
    DB.sqlite.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES
      ('acme', 'ACME Corporation', 'customer', '2026-10-20T09:00:00Z'),
      ('globex', 'Globex', 'vendor', '2026-10-20T09:00:00Z')`);
    for (const day of ['2026-11-01', '2026-11-02']) {
      usageRow(DB, {
        day, source: 'd1', service: 'volume', metric: 'messages', org: 'acme', team: 'helix', quantity: 30,
      });
      usageRow(DB, {
        day, source: 'd1', service: 'volume', metric: 'messages', org: 'globex', team: 'helix', quantity: 10,
      });
      usageRow(DB, {
        day, source: 'd1', service: 'volume', metric: 'threads', org: 'acme', team: 'helix', quantity: 3,
      });
      usageRow(DB, {
        day, source: 'd1', service: 'volume', metric: 'threads', org: 'globex', team: 'helix', quantity: 1,
      });
      // $4 of Opus input for acme, $1 of shared Workers requests (allocated 3:1).
      usageRow(DB, {
        day, hour: 9, service: 'bedrock', metric: 'input_tokens', detail: 'us.anthropic.claude-opus-5-5', org: 'acme', team: 'helix', quantity: 1e6,
      });
      usageRow(DB, {
        day, hour: 9, service: 'workers', metric: 'requests', quantity: 1e6 / 0.3,
      });
    }
    // Stock: 2 GB on one day, 4 GB on the other: 3 GB on average, $0.045 a month.
    usageRow(DB, {
      day: '2026-11-01', source: 'account', service: 'r2', metric: 'stored_bytes', detail: 'raw', quantity: 2e9,
    });
    usageRow(DB, {
      day: '2026-11-02', source: 'account', service: 'r2', metric: 'stored_bytes', detail: 'raw', quantity: 4e9,
    });
    usageRow(DB, {
      day: '2026-11-02', service: 'workers_ai', metric: 'input_tokens', detail: '@cf/someone/new', quantity: 10,
    });
    if (counting) {
      for (const source of ['meter', 'account', 'd1']) {
        usageRow(DB, {
          day: '2026-10-01', source, service: 'volume', metric: 'days', quantity: 1,
        });
      }
    }
    return { DB };
  }
  const url = (q) => new URL(`https://opspile.example/api/admin/cogs?${q}`);
  const NOW = Date.parse('2026-11-02T12:00:00Z');
  /** The chart's columns by the day (hours added up), whatever its unit. */
  const daily = (r) => {
    const by = new Map();
    for (const c of r.chart.columns) {
      const day = c.at.slice(0, 10);
      if (!by.has(day)) {
        by.set(day, { services: {} });
      }
      const d = by.get(day);
      for (const [id, v] of Object.entries(c.services)) {
        d.services[id] = (d.services[id] || 0) + v;
      }
    }
    return [...by.values()];
  };

  it('reads a period, the last 30 days by default, at most 400', () => {
    assert.deepEqual(period(url(''), NOW), { from: '2026-10-04', to: '2026-11-02', days: 30 });
    assert.deepEqual(period(url('from=2026-11-02&to=2026-11-01'), NOW), { from: '2026-11-01', to: '2026-11-02', days: 2 });
    assert.equal(period(url('from=2020-01-01&to=2026-11-02'), NOW).days, 400);
  });

  it('costs the period: flow, per message and thread, stock a month, shared costs shared out', async () => {
    const env = seeded();
    const r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02'), { now: NOW });
    close(r.totals.flow, 2 * 4 + 2 * 1);
    assert.equal(r.totals.messages, 80);
    assert.equal(r.totals.threads, 8);
    close(r.totals.perMessage, 10 / 80);
    close(r.totals.perThread, 10 / 8);
    close(r.totals.stock, 0.045);
    assert.equal(r.services[0].id, 'bedrock');
    close(r.services[0].perMessage, 8 / 80);
    const acme = r.orgs.find((o) => o.org === 'acme');
    close(acme.flow, 8 + 2 * 0.75);
    close(acme.shared, 1.5);
    assert.equal(acme.name, 'ACME Corporation');
    close(acme.perThread, 9.5 / 6);
    assert.equal(r.orgs.find((o) => o.org === 'globex').type, 'vendor');
    assert.ok(!r.orgs.some((o) => o.org === '' && o.flow > 1e-9), 'nothing left shared');
    // A short period by the hour, from `cogs_hours` (none here), up to the hour of `now`.
    assert.equal(r.chart.unit, 'hour');
    assert.equal(r.chart.columns.length, 24 + 13);
    assert.equal(r.chart.columns[36].at, '2026-11-02T12:00:00Z');
    assert.equal(r.chart.columns[9].at, '2026-11-01T09:00:00Z');
    close(r.chart.columns[9].services.workers, 1);
    assert.deepEqual(r.chart.columns[10].services, {});
    assert.deepEqual(r.unpriced, ['workers_ai/input_tokens (@cf/someone/new)']);
    assert.deepEqual(r.since, { account: '2026-10-01', d1: '2026-10-01', meter: '2026-10-01' });
    // A month at the rate of the period so far: a day and a half.
    assert.deepEqual(r.estimate, { from: '2026-11-01', days: 1.5 });
    close(r.totals.flowMonthly, (10 / 1.5) * 30.44);
  });

  it('sets an experiment\'s arms side by side, per million prompt tokens', async () => {
    const env = seeded();
    const arm = (a, metric, quantity) => usageRow(env.DB, {
      day: '2026-11-02', service: 'bedrock', metric, detail: `us.anthropic.claude-opus-5-5#cache=${a}`, org: 'acme', team: 'helix', quantity,
    });
    // One hour: 1M prompt tokens, 0.8M read ($0.16) and 0.2M written at $8 ($1.60).
    arm('long', 'cache_read_tokens', 8e5);
    arm('long', 'cache_write_1h_tokens', 2e5);
    arm('long', 'output_tokens', 1e5);
    // Five minutes: 2M prompt tokens, 1.2M read ($0.24) and 0.8M written at $5 ($4).
    arm('short', 'cache_read_tokens', 1.2e6);
    arm('short', 'cache_write_tokens', 8e5);
    arm('short', 'output_tokens', 2e5);
    let r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02'), { now: NOW });
    assert.equal(r.experiments.length, 1);
    const [x] = r.experiments;
    assert.equal(x.id, 'cache');
    assert.equal(x.default, 'long');
    assert.deepEqual(x.arms.map((a) => a.id), ['long', 'short']);
    const [long, short] = x.arms;
    assert.equal(long.prompt, 1e6);
    close(long.hitRate, 0.8);
    close(long.perMPrompt, 1.76);
    close(long.usd, 1.76 + 2);
    assert.equal(long.vs, null);
    assert.equal(short.prompt, 2e6);
    close(short.perMPrompt, 4.24 / 2);
    close(short.vs, 2.12 / 1.76 - 1);
    assert.equal(short.output, 2e5);
    assert.equal(short.label, '5-minute cache');
    // Priced as the model: nothing unpriced, and the service table keeps the arms apart.
    assert.deepEqual(r.unpriced, ['workers_ai/input_tokens (@cf/someone/new)']);
    const bedrock = r.services.find((s) => s.id === 'bedrock');
    assert.ok(bedrock.metrics.some((m) => m.detail.endsWith('#cache=short') && m.price === 5));
    // Of what is selected: another customer has none.
    r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02&org=globex'), { now: NOW });
    assert.deepEqual(r.experiments, []);
  });

  it('filters by customer, team and service, after sharing out', async () => {
    const env = seeded();
    let r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02&org=globex'), { now: NOW });
    close(r.totals.flow, 0.5);
    assert.equal(r.totals.messages, 20);
    // The chart is the customer's too: its share of the shared Workers requests.
    close(daily(r)[0].services.workers, 0.25);
    assert.equal(daily(r)[0].services.bedrock, undefined);
    close(r.totals.perMessage, 0.5 / 20);
    // The customer list stays whole, to pick another.
    assert.deepEqual(r.orgs.map((o) => o.org).sort(), ['acme', 'globex']);
    r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02&service=workers'), { now: NOW });
    close(r.totals.flow, 2);
    assert.deepEqual(r.services.map((s) => s.id), ['workers']);
    r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02&allocate=none'), { now: NOW });
    close(r.orgs.find((o) => o.org === '').flow, 2);
    close(r.orgs.find((o) => o.org === 'acme').flow, 8);
    r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02&allocate=none&org=acme'), { now: NOW });
    close(daily(r)[1].services.bedrock, 4);
    assert.equal(daily(r)[1].services.workers, undefined);
    r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02&team=helix'), { now: NOW });
    close(r.totals.flow, 10);
    close(daily(r)[1].services.workers, 1);
    r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02&team=edge'), { now: NOW });
    assert.equal(r.totals.flow, 0);
    assert.equal(r.totals.perMessage, null);
  });

  it('estimates from the first whole day every source counted, to now', async () => {
    const since = { account: '2026-10-01', d1: '2026-10-01', meter: '2026-11-01' };
    const p = { from: '2026-10-04', to: '2026-11-02' };
    assert.deepEqual(estimateWindow(p, since, NOW), { from: '2026-11-02', days: 0.5 });
    assert.deepEqual(estimateWindow(p, {}, NOW), { from: '2026-10-04', days: 29.5 });
    assert.deepEqual(estimateWindow({ from: '2026-10-01', to: '2026-10-31' }, { meter: '2026-09-01' }, NOW), { from: '2026-10-01', days: 31 });
    assert.equal(estimateWindow({ from: '2026-10-01', to: '2026-11-01' }, since, NOW), null);
    // The meter started on the 1st: its first day is partial, so the estimates count the 2nd only.
    const env = seeded({ counting: false });
    let r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02'), { now: NOW });
    assert.deepEqual(r.estimate, { from: '2026-11-02', days: 0.5 });
    close(r.totals.flow, 10);
    assert.equal(r.totals.messages, 80);
    close(r.totals.flowMonthly, (5 / 0.5) * 30.44);
    close(r.totals.perMessage, 5 / 40);
    close(r.totals.perThread, 5 / 4);
    close(r.services.find((s) => s.id === 'bedrock').perMessage, 4 / 40);
    close(r.orgs.find((o) => o.org === 'acme').perThread, (4 + 0.75) / 3);
    r = await cogsReport(env, url('from=2026-10-30&to=2026-11-01'), { now: NOW });
    assert.equal(r.estimate, null);
    assert.equal(r.totals.flowMonthly, null);
    assert.equal(r.totals.perMessage, null);
    assert.equal(r.orgs.find((o) => o.org === 'acme').perMessage, null);
  });

  it('counts the agents\' drafts, and costs an accepted one', async () => {
    const env = seeded();
    const AGENT = 91;
    env.DB.sqlite.prepare("INSERT INTO people (id, email, name, staff) VALUES (?, ?, 'opspile agent', 0)")
      .run(AGENT, AGENT_EMAIL);
    const ev = (at, action, org, {
      by = 2, origin = AGENT, changed = null, version = 'v2', how = null,
    } = {}) => env.DB.sqlite.prepare(`INSERT INTO draft_events (thread, draft, version, action, how,
        person, by_agent, origin, origin_agent, changed, org, team, at)
      VALUES ('t', 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'helix', ?)`)
      .run(...[version, action, how, by, Number(by === AGENT), origin, Number(origin === AGENT),
        changed, org, at]);
    // Counting since long before the period.
    ev('2026-10-01T09:00:00.000Z', 'saved', 'acme', { by: AGENT, version: 'v1' });
    const at = '2026-11-01T10:00:00.000Z';
    ev(at, 'saved', 'acme', { by: AGENT, version: 'v1' });
    ev(at, 'saved', 'acme', { by: 1 });
    ev(at, 'sent', 'acme', { changed: 0, how: 'me' });
    ev(at, 'sent', 'acme', { changed: 0.3, how: 'app' });
    ev(at, 'discarded', 'globex');
    ev(at, 'discarded', 'acme', { by: AGENT });
    ev(at, 'posted', 'acme', { by: AGENT, how: 'agent' });
    // A person's own draft, sent, is not the agent's.
    ev(at, 'sent', 'acme', { origin: 1, changed: 0, how: 'me' });
    // One of the agent's drafts is still open.
    env.DB.sqlite.exec(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      path, updated_at) VALUES ('t', 'slack', 'E1', 'C1', '1.1', 'acme', 'helix', 'p/', '${at}')`);
    env.DB.sqlite.prepare(`INSERT INTO drafts (thread, body, person, created_at, updated_at, origin)
      VALUES ('t', 'Hi', ?, ?, ?, ?)`).run(AGENT, at, at, AGENT);
    let r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02'), { now: NOW });
    assert.deepEqual({ ...r.drafts, estimate: undefined }, {
      started: 1,
      sent: 1,
      edited: 1,
      discarded: 1,
      withdrawn: 1,
      agentPosts: 1,
      accepted: 2,
      decided: 4,
      acceptance: 0.5,
      open: 1,
      estimate: undefined,
    });
    close(r.totals.perAcceptedDraft, 10 / 2);
    close(r.totals.perAgentReply, 10 / 3);
    close(r.services.find((x) => x.id === 'bedrock').perAcceptedDraft, 8 / 2);
    const acme = r.orgs.find((o) => o.org === 'acme');
    assert.deepEqual([acme.accepted, acme.agentPosts], [2, 1]);
    close(acme.perAcceptedDraft, 9.5 / 2);
    assert.equal(r.orgs.find((o) => o.org === 'globex').perAcceptedDraft, null);
    assert.equal(r.since.drafts, '2026-10-01');
    r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02&org=globex'), { now: NOW });
    assert.deepEqual([r.drafts.accepted, r.drafts.discarded, r.drafts.open], [0, 1, 0]);
    assert.equal(r.totals.perAcceptedDraft, null);
    // Counted from the first whole day of the drafts' events: none were accepted on the 2nd.
    env.DB.sqlite.exec("DELETE FROM draft_events WHERE at < '2026-11-01'");
    r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02'), { now: NOW });
    assert.deepEqual(r.drafts.estimate, { from: '2026-11-02', days: 0.5 });
    assert.equal(r.drafts.accepted, 2);
    assert.equal(r.totals.perAcceptedDraft, null);
    close(r.totals.perMessage, 10 / 80);
  });

  it('charts about as many columns whatever the period: by the hour, the day or the week', async () => {
    const at = (from, days) => chartUnit({ from, days }, NOW);
    assert.equal(at('2026-10-27', 7), 'hour');
    assert.equal(at('2026-10-26', 7), 'hour');
    assert.equal(at('2026-10-25', 7), 'day', 'older than the hours kept');
    assert.equal(at('2026-10-04', 30), 'day');
    assert.equal(at('2026-08-05', 90), 'week');
    const costs = new Map([['2026-10-31', { workers: 1 }], ['2026-11-01', { workers: 2, d1: 1 }], ['2026-11-02', { d1: 4 }]]);
    // Weeks from Monday, cut to the period.
    assert.deepEqual(columns('week', '2026-10-29', '2026-11-10', costs, NOW), [
      { at: '2026-10-29', until: '2026-11-01', services: { workers: 3, d1: 1 } },
      { at: '2026-11-02', until: '2026-11-08', services: { d1: 4 } },
      { at: '2026-11-09', until: '2026-11-10', services: {} },
    ]);
    const env = seeded();
    // The same days a month later: their hours are gone, so by the day.
    let r = await cogsReport(env, url('from=2026-11-01&to=2026-11-02'), { now: NOW + 30 * 86400000 });
    assert.equal(r.chart.unit, 'day');
    assert.deepEqual(r.chart.columns.map((c) => c.at), ['2026-11-01', '2026-11-02']);
    close(r.chart.columns[1].services.workers, 1);
    close(r.chart.columns[1].services.bedrock, 4);
    r = await cogsReport(env, url('from=2026-08-01&to=2026-11-02'), { now: NOW });
    assert.equal(r.chart.unit, 'week');
    assert.equal(r.chart.columns.length, 15);
    assert.equal(r.chart.columns.at(-2).at, '2026-10-26');
    close(r.chart.columns.at(-2).services.bedrock, 4);
    close(r.chart.columns.at(-1).services.workers, 1);
    close(r.chart.columns.reduce((n, c) => n + (c.services.workers || 0), 0), 2);
  });

  it('shares a team\'s costs over its customers, and nobody\'s over everyone', () => {
    const rows = [
      {
        org: '', team: 'helix', quantity: 4, usd: 4,
      },
      {
        org: '', team: 'other', quantity: 1, usd: 1,
      },
    ];
    const out = allocate(rows, new Map([['acme|helix', 3], ['globex|helix', 1], ['x|edge', 10]]));
    assert.deepEqual(out.map((r) => [r.org, r.team, r.usd]), [['acme', 'helix', 3], ['globex', 'helix', 1], ['', 'other', 1]]);
  });

  it('is the admin team\'s', async () => {
    const env = seeded();
    const call = async (me, path) => {
      const u = new URL(`https://opspile.example${path}`);
      const res = await api(new Request(u), env, u, { viewer: asMe(me) });
      return { status: res.status, body: await res.json() };
    };
    const ok = await call(ADA, '/api/admin/cogs?from=2026-11-01&to=2026-11-02');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.totals.messages, 80);
    assert.equal((await call(BO, '/api/admin/cogs')).status, 403);
  });
});
