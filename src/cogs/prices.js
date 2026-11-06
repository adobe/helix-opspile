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

/*
 * COGS: the list prices of every service opspile uses, per unit, as the providers publish them
 * (`AS_OF`). Costs are list prices at the margin: the allowances a plan includes (`included`)
 * are shown, not subtracted, so a cost is what one more message or thread adds once they are
 * used up, and a customer's share does not depend on who came first in the month.
 *
 * A metric is `flow` (counted as it happens: requests, rows, tokens; priced per `per` units) or
 * `stock` (what is kept: bytes, vectors; priced per `per` units and month). Workers AI and
 * Bedrock price per model: the metric's `detail` is the model, and `models` its prices.
 */

import { untagged } from '../experiments.js';

export const AS_OF = '2026-11-02';

/** The embedding models' dimensions (bge-base-en-v1.5), as the Vectorize indexes have them. */
export const DIMENSIONS = 768;

/** A Durable Object is billed for 128 MB while it is active. */
export const DO_GB = 0.128;

const M = 1e6;
const GB = 1e9;

const WORKERS_AI_MODELS = {
  '@cf/cloudflare/clef': { input: 0.24, output: 0 },
  '@cf/cloudflare/clef-flash': { input: 0.038, output: 0 },
  '@cf/cloudflare/clef-omni': { input: 0.15, output: 0 },
  '@cf/cloudflare/clairic': { input: 0.10, output: 0 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input: 0.293, output: 2.253 },
  '@cf/baai/bge-base-en-v1.5': { input: 0.067, output: 0 },
};

// Claude on Amazon Bedrock: Anthropic's list prices, which Bedrock's on-demand prices follow. A
// cache write kept for an hour costs twice the input, one kept for five minutes 1.25 times.
// Keyed by the model's name without its Bedrock prefix (`us.anthropic.`) and version suffix.
const BEDROCK_MODELS = {
  'claude-opus-5-5': {
    input: 4, output: 20, cache_read: 0.2, cache_write: 5, cache_write_1h: 8,
  },
  'claude-opus-5': {
    input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, cache_write_1h: 10,
  },
  'claude-sonnet-5-5': {
    input: 2, output: 10, cache_read: 0.1, cache_write: 2.5, cache_write_1h: 4,
  },
  'claude-sonnet-5': {
    input: 2, output: 10, cache_read: 0.2, cache_write: 2.5, cache_write_1h: 4,
  },
  'claude-haiku-5-5': {
    input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125, cache_write_1h: 0.2,
  },
};

/**
 * A Bedrock model id (`us.anthropic.claude-opus-5-5`, `…-v1:0`, an experiment's arm after it:
 * `…#cache=short`, src/experiments.js) as priced here.
 */
export const bedrockModel = (id) => untagged(id)
  .replace(/^.*\//, '')
  .replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '')
  .replace(/-v\d+(?::\d+)?$/, '');

export const SERVICES = [
  {
    id: 'bedrock',
    name: 'Amazon Bedrock',
    about: 'The thread agents\' model (Claude), through AI Gateway, which is free',
    url: 'https://aws.amazon.com/bedrock/pricing/',
    metrics: [
      {
        id: 'input_tokens', label: 'Input tokens', unit: 'tokens', per: M, price: 'input',
      },
      {
        id: 'output_tokens', label: 'Output tokens', unit: 'tokens', per: M, price: 'output',
      },
      {
        id: 'cache_read_tokens', label: 'Cache reads', unit: 'tokens', per: M, price: 'cache_read',
      },
      {
        id: 'cache_write_tokens', label: 'Cache writes (5 minutes)', unit: 'tokens', per: M, price: 'cache_write',
      },
      {
        id: 'cache_write_1h_tokens', label: 'Cache writes (1 hour)', unit: 'tokens', per: M, price: 'cache_write_1h',
      },
      {
        // What pi-ai's catalog says the tokens cost, for a model not priced here.
        id: 'catalog_usd', label: 'Cost by the model catalog', unit: 'USD', per: 1, fallback: true,
      },
    ],
    models: BEDROCK_MODELS,
  },
  {
    id: 'workers_ai',
    name: 'Workers AI',
    about: 'Clef, Clairic, the titles\' model and the embeddings',
    url: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    included: '10,000 neurons a day',
    metrics: [
      {
        id: 'input_tokens', label: 'Input tokens', unit: 'tokens', per: M, price: 'input',
      },
      {
        id: 'output_tokens', label: 'Output tokens', unit: 'tokens', per: M, price: 'output',
      },
      {
        id: 'requests', label: 'Requests', unit: 'requests', per: M, usd: 0,
      },
      {
        id: 'conversions', label: 'Markdown conversions', unit: 'files', per: M, usd: 0,
      },
    ],
    models: WORKERS_AI_MODELS,
  },
  {
    id: 'ai_search',
    name: 'AI Search',
    about: 'Full-text search over the messages',
    url: 'https://developers.cloudflare.com/ai-search/platform/limits-pricing/',
    metrics: [
      {
        id: 'fulltext_queries', label: 'Full-text queries', unit: 'queries', per: 1e3, usd: 0.10, included: '1,000 a month',
      },
      {
        id: 'semantic_queries', label: 'Semantic queries', unit: 'queries', per: 1e3, usd: 0.75, included: '1,000 a month',
      },
      {
        id: 'ingest_tokens', label: 'Ingested tokens', unit: 'tokens', per: M, usd: 0.75, included: '5M a month',
      },
      {
        id: 'uploads', label: 'Uploaded items', unit: 'items', per: M, usd: 0,
      },
      {
        id: 'ingest_bytes', label: 'Uploaded text', unit: 'bytes', per: GB, usd: 0,
      },
      {
        id: 'stored_bytes', label: 'Stored', unit: 'bytes', per: GB, usd: 2.00, stock: true, included: '10 GB',
      },
    ],
  },
  {
    id: 'durable_objects',
    name: 'Durable Objects',
    about: 'The thread agents, the team rooms and the Discord poller',
    url: 'https://developers.cloudflare.com/durable-objects/platform/pricing/',
    metrics: [
      {
        id: 'requests', label: 'Requests', unit: 'requests', per: M, usd: 0.15, included: '1M a month',
      },
      {
        id: 'gb_s', label: 'Duration', unit: 'GB-s', per: M, usd: 12.50, included: '400,000 GB-s a month',
      },
      {
        id: 'stored_bytes', label: 'SQLite storage', unit: 'bytes', per: GB, usd: 0.20, stock: true, included: '5 GB',
      },
    ],
  },
  {
    id: 'workers',
    name: 'Workers',
    about: 'The Worker: events, the inbox\'s API, the queue and the cron',
    url: 'https://developers.cloudflare.com/workers/platform/pricing/',
    metrics: [
      {
        id: 'requests', label: 'Requests', unit: 'requests', per: M, usd: 0.30, included: '10M a month',
      },
      {
        id: 'cpu_ms', label: 'CPU time', unit: 'ms', per: M, usd: 0.02, included: '30M ms a month',
      },
      {
        id: 'subscription', label: 'Workers Paid plan (the account\'s)', unit: 'plans', per: 1, usd: 5, stock: true,
      },
    ],
  },
  {
    id: 'workers_logs',
    name: 'Workers Logs',
    url: 'https://developers.cloudflare.com/workers/platform/pricing/#workers-logs',
    metrics: [
      {
        id: 'events', label: 'Log events', unit: 'events', per: M, usd: 0.60, included: '20M a month',
      },
    ],
  },
  {
    id: 'r2',
    name: 'R2',
    about: 'Piles 1 and 2, and the files',
    url: 'https://developers.cloudflare.com/r2/pricing/',
    metrics: [
      {
        id: 'class_a', label: 'Class A operations', unit: 'operations', per: M, usd: 4.50, included: '1M a month',
      },
      {
        id: 'class_b', label: 'Class B operations', unit: 'operations', per: M, usd: 0.36, included: '10M a month',
      },
      {
        id: 'stored_bytes', label: 'Stored', unit: 'bytes', per: GB, usd: 0.015, stock: true, included: '10 GB',
      },
    ],
  },
  {
    id: 'd1',
    name: 'D1',
    about: 'The fast index (pile 4)',
    url: 'https://developers.cloudflare.com/d1/platform/pricing/',
    metrics: [
      {
        id: 'rows_read', label: 'Rows read', unit: 'rows', per: M, usd: 0.001, included: '25B a month',
      },
      {
        id: 'rows_written', label: 'Rows written', unit: 'rows', per: M, usd: 1.00, included: '50M a month',
      },
      {
        id: 'stored_bytes', label: 'Stored', unit: 'bytes', per: GB, usd: 0.75, stock: true, included: '5 GB',
      },
    ],
  },
  {
    id: 'vectorize',
    name: 'Vectorize',
    about: 'Root messages for re-threading, and what was said for search',
    url: 'https://developers.cloudflare.com/vectorize/platform/pricing/',
    metrics: [
      {
        id: 'queried_dims', label: 'Queried dimensions', unit: 'dimensions', per: M, usd: 0.01, included: '50M a month',
      },
      {
        id: 'written_dims', label: 'Written dimensions', unit: 'dimensions', per: M, usd: 0,
      },
      {
        // A stored vector counts towards the queried dimensions too, every month.
        id: 'stored_dims', label: 'Stored dimensions', unit: 'dimensions', per: M, usd: 0.0105, stock: true, included: '10M',
      },
    ],
  },
  {
    id: 'queues',
    name: 'Queues',
    url: 'https://developers.cloudflare.com/queues/platform/pricing/',
    metrics: [
      {
        id: 'operations', label: 'Operations', unit: 'operations', per: M, usd: 0.40, included: '1M a month',
      },
    ],
  },
  {
    id: 'artifacts',
    name: 'Artifacts',
    about: 'The knowledge bases and the agents\' GitHub mirrors',
    url: 'https://developers.cloudflare.com/artifacts/platform/pricing/',
    metrics: [
      {
        id: 'operations', label: 'Operations', unit: 'operations', per: 1e3, usd: 0.15, included: '10,000 a month',
      },
    ],
  },
  {
    id: 'browser_run',
    name: 'Browser Run',
    about: 'The agents\' global browser MCP server',
    url: 'https://developers.cloudflare.com/browser-run/pricing/',
    metrics: [
      {
        id: 'browser_ms', label: 'Browser time', unit: 'ms', per: 3.6e6, usd: 0.09, included: '10 hours a month',
      },
    ],
  },
  {
    id: 'analytics_engine',
    name: 'Workers Analytics Engine',
    about: 'Where opspile counts all of this',
    url: 'https://developers.cloudflare.com/analytics/analytics-engine/pricing/',
    metrics: [
      {
        id: 'points', label: 'Data points written', unit: 'points', per: M, usd: 0.25, included: '10M a month',
      },
      {
        id: 'queries', label: 'Read queries', unit: 'queries', per: M, usd: 1.00, included: '1M a month',
      },
    ],
  },
];

/** What is counted but not priced: how many messages and threads there were. */
export const VOLUME = 'volume';

const BY_ID = new Map(SERVICES.map((s) => [s.id, s]));

export const serviceOf = (id) => BY_ID.get(id) || null;

export function metricOf(service, metric) {
  const s = BY_ID.get(service);
  return (s && s.metrics.find((m) => m.id === metric)) || null;
}

/** Whether a metric is a stock (priced per month) rather than a flow. */
export const isStock = (service, metric) => Boolean(metricOf(service, metric)?.stock);

/** The prices of a model of `service`, or null when it has none here. */
export function modelPrices(service, model) {
  const s = BY_ID.get(service);
  if (!s || !s.models) {
    return null;
  }
  return s.models[service === 'bedrock' ? bedrockModel(model) : model] || null;
}

/**
 * The price of one `per` of a metric (`detail`: the model, for the per-model services), as
 * `{ usd, per }`, or null for an unknown metric or an unpriced model. Bedrock's `catalog_usd`
 * counts only where the model is not priced here, so its tokens are not counted twice.
 */
export function unitPrice(service, metric, detail = '') {
  const m = metricOf(service, metric);
  if (!m) {
    return null;
  }
  if (m.fallback) {
    return modelPrices(service, detail) ? { usd: 0, per: m.per } : { usd: 1, per: m.per };
  }
  if (m.price) {
    const p = modelPrices(service, detail);
    return p && typeof p[m.price] === 'number' ? { usd: p[m.price], per: m.per } : null;
  }
  return { usd: m.usd, per: m.per };
}

/** What `quantity` of a metric costs (a flow), or costs a month (a stock); 0 when unpriced. */
export function costOf(service, metric, detail, quantity) {
  const p = unitPrice(service, metric, detail);
  return p && Number.isFinite(quantity) ? (quantity / p.per) * p.usd : 0;
}

/** The catalog as the dashboard shows it: every priced metric, and the models. */
export function priceList() {
  return {
    asOf: AS_OF,
    services: SERVICES.map((s) => ({
      id: s.id,
      name: s.name,
      about: s.about || '',
      url: s.url,
      included: s.included || '',
      metrics: s.metrics.filter((m) => !m.fallback).map((m) => ({
        id: m.id,
        label: m.label,
        unit: m.unit,
        per: m.per,
        usd: m.price ? null : m.usd,
        stock: Boolean(m.stock),
        included: m.included || '',
      })),
      models: s.models ? Object.entries(s.models).map(([id, p]) => ({ id, ...p })) : [],
    })),
  };
}
