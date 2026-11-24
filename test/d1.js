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

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

/** The customer portal's own database (portal/migrations): `d1({ migrations: PORTAL })`. */
export const PORTAL = new URL('../portal/migrations/', import.meta.url);

/**
 * A D1-shaped wrapper around an in-memory SQLite database with the real migrations
 * applied, so tests run the same SQL as production.
 */
export function d1({
  rules = [], people = [], teams = [], migrations = MIGRATIONS,
} = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  // D1's limit, where this Node can set it: a longer LIKE pattern fails there, "too complex".
  if (db.limits) {
    db.limits.likePatternLength = 50;
  }
  for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  const insert = (table, row) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((c) => row[c]));
  };
  teams.forEach((t) => insert('teams', t));
  people.forEach(({ teams: memberOf = [], ...p }) => {
    insert('people', p);
    memberOf.forEach((team) => insert('team_members', { team, person: p.id }));
  });
  rules.forEach((r) => insert('rules', r));

  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a.map((v) => (v === undefined ? null : v))),
    async first(column) {
      const row = db.prepare(sql).get(...args);
      if (!row) {
        return null;
      }
      // As D1's: one column's value, when asked for one, and an error for one it does not have.
      if (column === undefined) {
        return { ...row };
      }
      if (!(column in row)) {
        throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
      }
      return row[column];
    },
    async all() {
      return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) };
    },
    async run() { return this.execute(); },
    execute() {
      const prepared = db.prepare(sql);
      // As D1's, a read's rows come along too (`batch` gives each statement's that way).
      if (prepared.columns().length) {
        const results = prepared.all(...args).map((r) => ({ ...r }));
        return { results, success: true, meta: { changes: 0, rows_read: results.length } };
      }
      const { changes } = prepared.run(...args);
      return { results: [], success: true, meta: { changes: Number(changes) } };
    },
  });
  return {
    sqlite: db,
    prepare: (sql) => stmt(sql),
    async batch(statements) {
      // D1 executes the batch in one transaction. No interleaved reads or partial writes.
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => s.execute());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    rows: (sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r })),
  };
}
