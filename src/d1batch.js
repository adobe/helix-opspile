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
 */

const READ = /^\s*(?:--[^\n]*\n\s*)*(?:SELECT|WITH)\b/i;
const WRITE = /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/i;

/** Whether `sql` only reads, and may wait for a batch. */
export const batchable = (sql) => READ.test(sql) && !WRITE.test(sql);

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
function alone(q) {
  const first = () => (q.column === undefined ? q.stmt.first() : q.stmt.first(q.column));
  (q.how === 'first' ? first() : q.stmt.all()).then(q.resolve, q.reject);
}

/**
 * `db` (a D1 binding, or anything shaped like one) whose concurrent reads go as one batch.
 * At most `most` statements a batch.
 */
export function batchedDatabase(db, { most = 100, defer = (fn) => setTimeout(fn, 0) } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    return db;
  }
  let queue = [];
  const flush = () => {
    const all = queue;
    queue = [];
    for (let i = 0; i < all.length; i += most) {
      const part = all.slice(i, i + most);
      if (part.length === 1) {
        alone(part[0]);
        // eslint-disable-next-line no-continue
        continue;
      }
      db.batch(part.map((q) => q.stmt)).then((results) => {
        if (!Array.isArray(results) || results.length !== part.length
          || results.some((r) => !r || !Array.isArray(r.results))) {
          part.forEach(alone);
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
      }, () => part.forEach(alone));
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
