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
 * D1 with the reads a request asks for at once sent as one batch (`db.batch`): one round trip
 * to D1 instead of one each. D1 runs a database's queries one at a time, so twenty queries
 * asked for together still took twenty turns of it, each with its own request: opening a thread
 * asked some thirty-five at once, and waited ~400 ms for them, for a few ms of SQL.
 *
 * Only `all()` and `first()` of a read (`SELECT`, `WITH` without a write in it) wait, until the
 * code that asked has nothing else to do (a timer of 0 ms, after every promise that can go on);
 * whatever else is asked then goes in the same batch. Writes, `run()` and `raw()` go to D1 at
 * once, as they did. A batch is one transaction, which reads do not mind, but one failing query
 * fails all of it: then each is asked on its own, so only that one fails, as before.
 *
 * Unless D1 turned the batch away because the database is overloaded (`overloaded`): then no
 * query of it failed, and asking each on its own would send D1 one request for each of them
 * just when it takes none. A read waits a moment then (0.5–1.5 s, at random, so that the
 * requests it turned away together do not come back together) and is asked once more, in its
 * batch; if D1 is still overloaded, it fails with that, and the request with it. Writes are not
 * asked again: one D1 turned away did not run, but nothing here knows a write is safe twice.
 *
 * So a read asked for alongside a write (in one `Promise.all`) reaches D1 after it, and sees
 * it: separate requests never promised an order either, and nothing may rely on one. A batch
 * answers all at once, so a slow read holds back the reads asked with it.
 *
 * The thread agents' D1 (`patientDatabase`, src/agent/agentenv.js) asks a read again in the
 * same way, once, 0.5–1.5 s after D1 turned it away as overloaded, but batches nothing: each
 * query goes to D1 when it is asked, as from the bare binding.
 */

const READ = /^\s*(?:--[^\n]*\n\s*)*(?:SELECT|WITH)\b/i;
const WRITE = /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/i;

/** Whether `sql` only reads, and may wait for a batch. */
export const batchable = (sql) => READ.test(sql) && !WRITE.test(sql);

/**
 * Whether `e` is D1 turning queries away because the database is overloaded ("D1 DB is
 * overloaded.", whichever limit: too many resources in 10 s, too many requests queued, queued
 * too long). The queries did not run, and are likely to a second or two later.
 */
export function overloaded(e) {
  const said = (x) => String((x && x.message) || x || '');
  return /D1 DB is overloaded/i.test(`${said(e)} ${said(e && e.cause)}`);
}

/** How long a read D1 turned away waits before it is asked again: 0.5–1.5 s. */
const backoff = () => 500 + Math.floor(Math.random() * 1000);
const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** `ask()`, and once more after `pause(wait())` if D1 was overloaded. */
function patiently(ask, { pause, wait }) {
  return Promise.resolve(ask()).catch((e) => {
    if (!overloaded(e)) {
      throw e;
    }
    return pause(wait()).then(ask);
  });
}

/** The answer of `first(column)` from a statement's rows, as D1 gives it. */
function firstOf(rows, column) {
  const row = rows[0];
  if (!row) {
    return null;
  }
  if (column === undefined) {
    return row;
  }
  if (!(column in row)) {
    throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
  }
  return row[column];
}

/** Runs one queued read on its own: `{ stmt, how, column, resolve, reject }`. */
function alone(q, retry) {
  const first = () => (q.column === undefined ? q.stmt.first() : q.stmt.first(q.column));
  patiently(() => (q.how === 'first' ? first() : q.stmt.all()), retry).then(q.resolve, q.reject);
}

/**
 * Asked of a wrapper of the database (this one, src/timing.js's): the binding under it. Each
 * request wraps the binding anew, so what is kept across requests is kept by it (`underlying`).
 */
export const UNDERLYING = Symbol('underlying database');

/** The D1 binding under the wrappers `db` may be in. */
export const underlying = (db) => (db && db[UNDERLYING]) || db;

/**
 * `db` (a D1 binding, or anything shaped like one) whose concurrent reads go as one batch.
 * At most `most` statements a batch. A read D1 turned away as overloaded is asked again once,
 * after `pause(wait())` (for tests: `pause` resolves after that many ms).
 */
export function batchedDatabase(db, {
  most = 100, defer = (fn) => setTimeout(fn, 0), pause = sleep, wait = backoff,
} = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    return db;
  }
  const retry = { pause, wait };
  const single = (q) => alone(q, retry);
  let queue = [];
  const flush = () => {
    const all = queue;
    queue = [];
    for (let i = 0; i < all.length; i += most) {
      const part = all.slice(i, i + most);
      if (part.length === 1) {
        single(part[0]);
        // eslint-disable-next-line no-continue
        continue;
      }
      patiently(() => db.batch(part.map((q) => q.stmt)), retry).then((results) => {
        if (!Array.isArray(results) || results.length !== part.length
          || results.some((r) => !r || !Array.isArray(r.results))) {
          part.forEach(single);
          return;
        }
        part.forEach((q, j) => {
          if (q.how === 'all') {
            q.resolve(results[j]);
            return;
          }
          try {
            q.resolve(firstOf(results[j].results, q.column));
          } catch (e) {
            q.reject(e);
          }
        });
      }, (e) => (overloaded(e) ? part.forEach((q) => q.reject(e)) : part.forEach(single)));
    }
  };
  const enqueue = (stmt, how, column) => new Promise((resolve, reject) => {
    if (!queue.length) {
      defer(flush);
    }
    queue.push({
      stmt, how, column, resolve, reject,
    });
  });
  const statement = (sql, args) => {
    const real = () => (args ? db.prepare(sql).bind(...args) : db.prepare(sql));
    const reads = batchable(sql);
    return {
      bind: (...a) => statement(sql, a),
      all: () => (reads ? enqueue(real(), 'all') : real().all()),
      first: (...c) => (reads ? enqueue(real(), 'first', c[0]) : real().first(...c)),
      run: (...a) => real().run(...a),
      raw: (...a) => real().raw(...a),
      // For `batch()`: the statement D1 knows.
      get d1() {
        return real();
      },
    };
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === UNDERLYING) {
        return underlying(target);
      }
      if (prop === 'prepare') {
        return (sql) => statement(sql, null);
      }
      if (prop === 'batch') {
        return (stmts, ...rest) => target.batch(stmts.map((s) => (s && s.d1) || s), ...rest);
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** What a statement is asked with: all of them answer a read without writing anything. */
const ASKS = new Set(['all', 'first', 'raw', 'run']);

/**
 * `db` (a D1 binding, or anything shaped like one) whose reads D1 turned away as overloaded are
 * asked again once, after `pause(wait())`, and nothing else changed: each query goes to D1 when
 * it is asked, on its own. A statement whose SQL only reads (`batchable`) is asked again however
 * it is asked (`all()`, `first()`, `raw()`, `run()`), and so is a `batch()` of such statements
 * only; a write, or a batch with one, is not (see above). A session (`withSession`) is wrapped
 * as the database is, and `UNDERLYING` answers the binding under it.
 */
export function patientDatabase(db, { pause = sleep, wait = backoff } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    return db;
  }
  const retry = { pause, wait };
  // Each statement of this wrapper: the one under it, and whether it reads.
  const own = new WeakMap();
  const statement = (stmt, reads) => {
    if (!stmt || typeof stmt !== 'object') {
      return stmt;
    }
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (typeof v !== 'function') {
          return v;
        }
        if (prop === 'bind') {
          return (...args) => statement(Reflect.apply(v, target, args), reads);
        }
        if (reads && ASKS.has(prop)) {
          return (...args) => patiently(() => Reflect.apply(v, target, args), retry);
        }
        return v.bind(target);
      },
    });
    own.set(proxy, { stmt, reads });
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === UNDERLYING) {
        return underlying(target);
      }
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') {
        return v;
      }
      if (prop === 'prepare') {
        return (sql, ...rest) => statement(
          Reflect.apply(v, target, [sql, ...rest]),
          batchable(sql),
        );
      }
      if (prop === 'batch') {
        return (stmts, ...rest) => {
          const reads = stmts.length > 0 && stmts.every((s) => own.has(s) && own.get(s).reads);
          // D1 wants its own statements back.
          const under = stmts.map((s) => (own.has(s) ? own.get(s).stmt : s));
          const ask = () => Reflect.apply(v, target, [under, ...rest]);
          return reads ? patiently(ask, retry) : ask();
        };
      }
      if (prop === 'withSession') {
        return (...args) => patientDatabase(Reflect.apply(v, target, args), retry);
      }
      return v.bind(target);
    },
  });
}
