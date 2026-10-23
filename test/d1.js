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

/**
 * A D1-shaped wrapper around an in-memory SQLite database with the real migrations
 * applied, so tests run the same SQL as production.
 */
export function d1({ rules = [], people = [], teams = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
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
    async first() {
      const row = db.prepare(sql).get(...args);
      return row ? { ...row } : null;
    },
    async all() {
      return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) };
    },
    async run() {
      const { changes } = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(changes) } };
    },
  });
  return {
    sqlite: db,
    prepare: (sql) => stmt(sql),
    async batch(statements) {
      const out = [];
      for (const s of statements) {
        // eslint-disable-next-line no-await-in-loop
        out.push(await s.run());
      }
      return out;
    },
    rows: (sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r })),
  };
}
