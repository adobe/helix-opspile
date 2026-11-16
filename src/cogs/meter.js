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

import { DIMENSIONS } from './prices.js';

/*
 * COGS metering: what each piece of work uses of the services opspile pays for, counted where it
 * happens and written to Workers Analytics Engine (`USAGE`), for whom it was done.
 *
 * A `Meter` belongs to one invocation (a request, a queue batch, a cron run) or to a Durable
 * Object. Its `env(subject)` is the environment one piece of work runs with: the same bindings,
 * counted (D1 rows, R2 operations, queue operations, Workers AI tokens, Vectorize dimensions, AI
 * Search queries and ingested tokens), and `env.meter`, where code adds what the bindings do not
 * show (an agent's Bedrock tokens, its browser time) and names whom the work is for
 * (`attribute`). A subject is a thread (whose customer and team D1 knows), or a customer and a
 * team, or nobody: shared work, which the dashboard spreads over the customers by their
 * messages. `flush()` resolves the subjects and writes one data point per customer, team,
 * service, metric and detail (a model, a bucket), never more than Analytics Engine takes in one
 * invocation. Nothing here ever fails the work it counts.
 *
 * Counted exactly: D1 rows of `all`, `run` and `batch` (`meta`), operations, queries,
 * Bedrock tokens, Workers AI tokens where the model reports them. Estimated: a `first` reads
 * one row (D1 does not say), a `raw` as many as it returns, tokens a model does not report are
 * a quarter of the characters it was given, a queue message is three operations per 64 KB.
 * What the Worker cannot see (CPU time, Durable Objects' duration, storage) comes from
 * Cloudflare's own analytics instead (src/cogs/rollup.js).
 */

/** Analytics Engine takes at most 250 data points per invocation. */
export const MAX_POINTS = 240;

const QUEUE_CHUNK = 64000;
const QUEUE_OVERHEAD = 100;
const CHARS_PER_TOKEN = 4;

const R2_CLASS_A = new Set(['put', 'list', 'createMultipartUpload', 'resumeMultipartUpload']);
const R2_CLASS_B = new Set(['get', 'head']);
const VECTOR_QUERIES = new Set(['query', 'queryById']);
const VECTOR_WRITES = new Set(['upsert', 'insert']);

const tokensIn = (text) => Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
const sizeOf = (value) => {
  try {
    return typeof value === 'string' ? value.length : JSON.stringify(value ?? null).length;
  } catch {
    return 0;
  }
};

/** Calls the binding method `v` on `target`, with `after` counting what it answered. */
const counted = (target, v, after) => async (...args) => {
  const res = await v.apply(target, args);
  try {
    after(res, args);
  } catch {
    // Counting never fails the call.
  }
  return res;
};

function d1(db, scope) {
  const originals = new WeakMap();
  const rows = (res) => {
    const m = res && res.meta;
    if (m) {
      scope.add('d1', 'rows_read', '', Number(m.rows_read) || 0);
      scope.add('d1', 'rows_written', '', Number(m.rows_written) || 0);
    }
  };
  const statement = (stmt) => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (typeof v !== 'function') {
          return v;
        }
        if (prop === 'bind') {
          return (...args) => statement(v.apply(target, args));
        }
        if (prop === 'all' || prop === 'run') {
          return counted(target, v, rows);
        }
        if (prop === 'first') {
          return counted(target, v, () => scope.add('d1', 'rows_read', '', 1));
        }
        if (prop === 'raw') {
          return counted(target, v, (res) => scope.add('d1', 'rows_read', '', Array.isArray(res) ? res.length : 0));
        }
        return v.bind(target);
      },
    });
    originals.set(proxy, stmt);
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') {
        return v;
      }
      if (prop === 'prepare') {
        return (...args) => statement(v.apply(target, args));
      }
      if (prop === 'batch') {
        // D1 wants its own statements back.
        return (stmts, ...rest) => counted(target, v, (results) => {
          for (const r of results || []) {
            rows(r);
          }
        })(stmts.map((s) => originals.get(s) || s), ...rest);
      }
      return v.bind(target);
    },
  });
}

function r2(bucket, scope, name) {
  return new Proxy(bucket, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') {
        return v;
      }
      if (R2_CLASS_A.has(prop)) {
        return counted(target, v, () => scope.add('r2', 'class_a', name, 1));
      }
      if (R2_CLASS_B.has(prop)) {
        return counted(target, v, () => scope.add('r2', 'class_b', name, 1));
      }
      return v.bind(target);
    },
  });
}

function queue(q, scope) {
  const ops = (body) => 3 * Math.max(1, Math.ceil((sizeOf(body) + QUEUE_OVERHEAD) / QUEUE_CHUNK));
  return new Proxy(q, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') {
        return v;
      }
      if (prop === 'send') {
        return counted(target, v, (_, [body]) => scope.add('queues', 'operations', '', ops(body)));
      }
      if (prop === 'sendBatch') {
        return counted(target, v, (_, [messages]) => scope.add(
          'queues',
          'operations',
          '',
          (messages || []).reduce((n, m) => n + ops(m && m.body), 0),
        ));
      }
      return v.bind(target);
    },
  });
}

/** Workers AI: tokens as the model reports them (`usage`), else from the text it was given. */
function ai(binding, scope) {
  const inputOf = (inputs) => {
    if (!inputs || typeof inputs !== 'object') {
      return tokensIn(inputs);
    }
    if (Array.isArray(inputs.text)) {
      return inputs.text.reduce((n, t) => n + tokensIn(t), 0);
    }
    if (typeof inputs.text === 'string') {
      return tokensIn(inputs.text);
    }
    if (Array.isArray(inputs.messages)) {
      return inputs.messages.reduce((n, m) => n + tokensIn(typeof m.content === 'string' ? m.content : sizeOf(m.content)), 0);
    }
    const { state, questions, prompt } = inputs;
    return tokensIn(typeof state === 'string' ? state : JSON.stringify(state ?? ''))
      + tokensIn(JSON.stringify(questions ?? '')) + tokensIn(prompt);
  };
  return new Proxy(binding, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') {
        return v;
      }
      if (prop === 'run') {
        return counted(target, v, (res, [model, inputs]) => {
          const u = (res && typeof res === 'object' && res.usage) || {};
          const input = Number(u.prompt_tokens ?? u.input_tokens) || inputOf(inputs);
          const text = res && typeof res.response === 'string' ? res.response : '';
          const output = Number(u.completion_tokens ?? u.output_tokens) || tokensIn(text);
          const id = String(model || '');
          scope.add('workers_ai', 'requests', id, 1);
          scope.add('workers_ai', 'input_tokens', id, input);
          scope.add('workers_ai', 'output_tokens', id, output);
        });
      }
      if (prop === 'toMarkdown') {
        return counted(target, v, (_, [files]) => scope.add('workers_ai', 'conversions', '', Array.isArray(files) ? files.length : 1));
      }
      return v.bind(target);
    },
  });
}

function vectorize(index, scope, name) {
  return new Proxy(index, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') {
        return v;
      }
      if (VECTOR_QUERIES.has(prop)) {
        return counted(target, v, () => scope.add('vectorize', 'queried_dims', name, DIMENSIONS));
      }
      if (VECTOR_WRITES.has(prop)) {
        return counted(target, v, (_, [vectors]) => scope.add('vectorize', 'written_dims', name, (vectors || []).length * DIMENSIONS));
      }
      return v.bind(target);
    },
  });
}

/** AI Search: queries by kind (`keyword` is full text), and the tokens of what is uploaded. */
function search(instance, scope) {
  const items = (target) => new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop);
      if (typeof v !== 'function') {
        return v;
      }
      if (prop === 'upload') {
        return counted(t, v, (_, [, content]) => {
          const text = typeof content === 'string' ? content : '';
          scope.add('ai_search', 'ingest_tokens', '', tokensIn(text));
          scope.add('ai_search', 'ingest_bytes', '', text.length);
          scope.add('ai_search', 'uploads', '', 1);
        });
      }
      return v.bind(t);
    },
  });
  return new Proxy(instance, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === 'items' && v && typeof v === 'object') {
        return items(v);
      }
      if (typeof v !== 'function') {
        return v;
      }
      if (prop === 'search') {
        return counted(target, v, (_, [options]) => {
          const kind = options?.ai_search_options?.retrieval?.retrieval_type;
          scope.add('ai_search', kind === 'keyword' ? 'fulltext_queries' : 'semantic_queries', '', 1);
        });
      }
      return v.bind(target);
    },
  });
}

const WRAPS = {
  DB: (b, s) => d1(b, s),
  RAW: (b, s) => r2(b, s, 'raw'),
  CHANNELS: (b, s) => r2(b, s, 'channels'),
  FILES: (b, s) => r2(b, s, 'files'),
  IMAGES: (b, s) => r2(b, s, 'images'),
  NORMALIZE: (b, s) => queue(b, s),
  AI: (b, s) => ai(b, s),
  VECTORS: (b, s) => vectorize(b, s, 'roots'),
  CONTENT: (b, s) => vectorize(b, s, 'content'),
  SEARCH: (b, s) => search(b, s),
};

const SEP = '\u0000';

/**
 * At most MAX_POINTS entries (`[key, quantity]`, keyed customer, team, service, metric, detail):
 * past that, details fold into their metric, then customers and teams into shared.
 */
export function fit(entries) {
  const fold = (list, keep) => {
    const out = new Map();
    for (const [k, q] of list) {
      const key = keep(k.split(SEP)).join(SEP);
      out.set(key, (out.get(key) || 0) + q);
    }
    return [...out];
  };
  let out = entries;
  if (out.length > MAX_POINTS) {
    out = fold(out, ([org, team, service, metric]) => [org, team, service, metric, '']);
  }
  if (out.length > MAX_POINTS) {
    out = fold(out, ([, , service, metric]) => ['', '', service, metric, '']);
  }
  return out.slice(0, MAX_POINTS);
}

/** One piece of work: what it used (`counts`), and whom it was for (`subject`). */
function newScope(meter, subject) {
  const scope = {
    subject: { ...subject },
    counts: new Map(),

    /** Adds `quantity` of a metric (`detail`: a model, a bucket). */
    add(service, metric, detail, quantity) {
      const q = Number(quantity);
      if (!q || !Number.isFinite(q)) {
        return;
      }
      const key = [service, metric, detail || ''].join(SEP);
      scope.counts.set(key, (scope.counts.get(key) || 0) + q);
      meter.touched();
    },

    /** Whom the work is for, as last said (an object's own subject first, `attribute` over it). */
    who() {
      const { dynamic, ...said } = scope.subject;
      let own = {};
      try {
        own = (dynamic && dynamic()) || {};
      } catch {
        own = {};
      }
      return { ...own, ...said };
    },

    /** Whom the work was for: `{ org, team }` (either may be unknown), or `{ thread }`. */
    attribute(who) {
      Object.assign(scope.subject, Object.fromEntries(Object.entries(who || {})
        .filter(([, v]) => v !== undefined && v !== null && v !== '')));
    },
  };
  return scope;
}

/** Whom an agent works for, from its name: `kb:<team>:<org>`, else an inbox entry's key. */
export function agentSubject(name) {
  const kb = /^kb:([^:]*):(.*)$/.exec(String(name || ''));
  return kb ? { team: kb[1], org: kb[2] } : { thread: name || null };
}

export class Meter {
  /**
   * `via`: what runs (`fetch`, `queue`, `cron`, `agent`, …), kept with every point.
   * `delay`: for a Durable Object, flush by itself this long after the first count.
   */
  constructor(env, { via = 'fetch', delay = 0, subject = null } = {}) {
    this.base = env || {};
    this.via = via;
    this.delay = delay;
    this.scopes = [];
    this.timer = null;
    this.lookups = new Map();
    this.root = subject ? this.scope(subject) : null;
  }

  /** Whether there is anywhere to write to. */
  get enabled() {
    return Boolean(this.base.USAGE && typeof this.base.USAGE.writeDataPoint === 'function');
  }

  scope(subject = {}) {
    const s = newScope(this, subject);
    this.scopes.push(s);
    return s;
  }

  /**
   * The environment of one piece of work: `env` with its bindings counted for `subject` (or
   * for an existing scope), and `env.meter`, the scope. Without `USAGE`, `env` as it is.
   */
  env(subject = {}, scope = null) {
    if (!this.enabled) {
      return this.base;
    }
    const s = scope || this.scope(subject);
    const out = { ...this.base, meter: s };
    for (const [name, wrap] of Object.entries(WRAPS)) {
      if (this.base[name]) {
        out[name] = wrap(this.base[name], s);
      }
    }
    return out;
  }

  /** A Durable Object's meter flushes by itself, `delay` after the first count since the last. */
  touched() {
    if (!this.delay || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, this.delay);
  }

  /** The customer and team a subject stands for (D1's, for a thread); '' where nobody. */
  async resolve(s) {
    if (!s) {
      return { org: '', team: '' };
    }
    if (s.org || s.team || !s.thread) {
      return { org: s.org || '', team: s.team || '' };
    }
    if (!this.lookups.has(s.thread)) {
      this.lookups.set(s.thread, (async () => {
        try {
          const row = await this.base.DB.prepare('SELECT org, team FROM threads WHERE thread = ?')
            .bind(s.thread).first();
          return { org: (row && row.org) || '', team: (row && row.team) || '' };
        } catch {
          return { org: '', team: '' };
        }
      })());
    }
    return this.lookups.get(s.thread);
  }

  /**
   * Writes what was counted since the last flush, one data point per customer, team, service,
   * metric and detail, and forgets it. Never throws.
   */
  async flush() {
    if (!this.enabled) {
      return { points: 0 };
    }
    const { scopes } = this;
    this.scopes = this.root ? [this.root] : [];
    const merged = new Map();
    for (const s of scopes) {
      if (!s.counts.size) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const { counts } = s;
      s.counts = new Map();
      // eslint-disable-next-line no-await-in-loop
      const { org, team } = await this.resolve(s.who());
      for (const [key, q] of counts) {
        const k = [org, team, key].join(SEP);
        merged.set(k, (merged.get(k) || 0) + q);
      }
    }
    const entries = fit([...merged]);
    let points = 0;
    for (const [k, q] of entries) {
      const [org, team, service, metric, detail] = k.split(SEP);
      try {
        this.base.USAGE.writeDataPoint({
          indexes: [org || '_'],
          blobs: [service, metric, detail, org, team, this.via],
          doubles: [q],
        });
        points += 1;
      } catch {
        // Counting never fails the work.
      }
    }
    if (points) {
      try {
        this.base.USAGE.writeDataPoint({
          indexes: ['_'],
          blobs: ['analytics_engine', 'points', '', '', '', this.via],
          doubles: [points + 1],
        });
      } catch {
        // As above.
      }
    }
    return { points };
  }
}

/**
 * An agent's model use since `before`, from pi's ledger of its session (`{ models: {
 * 'provider/model': Usage }, tools: { name: Usage } }`, cumulative): `now`, to keep for the next
 * time, and `adds`, `[metric, model, tokens]` of Bedrock. Without `before` (never metered), the
 * ledger is from before COGS counted and adds nothing. A ledger that went back (a new session)
 * counts from nothing. A tool's model use is the agent's model's (`model`). `tag` follows the
 * model in every metric's detail: the experiment arm the agent is in (src/experiments.js).
 */
export function modelUsage(before, ledger, model = '', tag = '') {
  const now = {};
  const adds = [];
  const buckets = [
    ...Object.entries(ledger?.models || {}).map(([k, u]) => [`m:${k}`, k.slice(k.indexOf('/') + 1) + tag, u]),
    ...Object.entries(ledger?.tools || {}).map(([k, u]) => [`t:${k}`, model ? model + tag : '', u]),
  ];
  for (const [key, id, u] of buckets) {
    const cur = {
      input: Number(u.input) || 0,
      output: Number(u.output) || 0,
      cacheRead: Number(u.cacheRead) || 0,
      cacheWrite: Number(u.cacheWrite) || 0,
      cacheWrite1h: Number(u.cacheWrite1h) || 0,
      usd: Number(u.cost && u.cost.total) || 0,
    };
    now[key] = cur;
    if (before) {
      const was = before[key] || {};
      const back = Object.keys(cur).some((f) => cur[f] < (was[f] || 0));
      const d = (f) => cur[f] - (back ? 0 : (was[f] || 0));
      adds.push(
        ['input_tokens', id, d('input')],
        ['output_tokens', id, d('output')],
        ['cache_read_tokens', id, d('cacheRead')],
        ['cache_write_tokens', id, d('cacheWrite') - d('cacheWrite1h')],
        ['cache_write_1h_tokens', id, d('cacheWrite1h')],
        ['catalog_usd', id, d('usd')],
      );
    }
  }
  return { now, adds: adds.filter(([, , q]) => q > 0) };
}

/**
 * A Durable Object's meter: its own work is for `subject` (a function, asked at each flush:
 * the object's name is known only once it runs), and flushes itself `delay` after it counted.
 * `env` is the object's environment, counted; `meter` adds what the bindings do not show.
 */
export function objectMeter(env, { via, subject = () => ({}), delay = 15000 } = {}) {
  const m = new Meter(env, { via, delay, subject: { dynamic: subject } });
  return { meter: m, env: m.env({}, m.root), scope: m.root };
}

/**
 * An invocation's `ctx` whose `waitUntil` work is followed, so that `settled()` resolves once all
 * of it (and whatever it added meanwhile) is done.
 */
export function followed(ctx) {
  const pending = [];
  const wrapped = {
    waitUntil(p) {
      pending.push(Promise.resolve(p).catch(() => {}));
      return ctx && ctx.waitUntil ? ctx.waitUntil(p) : undefined;
    },
    passThroughOnException() {
      return ctx && ctx.passThroughOnException ? ctx.passThroughOnException() : undefined;
    },
    async settled() {
      for (let seen = 0; seen < pending.length;) {
        const batch = pending.slice(seen);
        seen = pending.length;
        // eslint-disable-next-line no-await-in-loop
        await Promise.all(batch);
      }
    },
  };
  return new Proxy(wrapped, {
    get(target, prop) {
      if (prop in target) {
        return target[prop];
      }
      const v = ctx ? Reflect.get(ctx, prop) : undefined;
      return typeof v === 'function' ? v.bind(ctx) : v;
    },
  });
}
