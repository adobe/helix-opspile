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

/** In-memory stand-ins for the RAW bucket and the NORMALIZE queue. */
export function fakeEnv(vars = {}, { failPut = false } = {}) {
  const objects = new Map();
  const queued = [];
  return {
    objects,
    queued,
    RAW: {
      async put(key, body, options) {
        if (failPut) {
          throw new Error('r2 down');
        }
        objects.set(key, { body, options });
      },
    },
    NORMALIZE: {
      async send(message) {
        queued.push(message);
      },
    },
    ...vars,
  };
}

/** Collects ctx.waitUntil promises so a test can await them. */
export function fakeCtx() {
  const pending = [];
  return {
    pending,
    waitUntil(p) {
      pending.push(p);
    },
    settle() {
      return Promise.all(pending);
    },
  };
}

/** Runs fn with console.log/warn/error silenced. */
export async function quiet(fn) {
  const { log, warn, error } = console;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

/** An R2 bucket with get/put, enough for pile 2. */
export function fakeBucket(initial = {}) {
  const objects = new Map(Object.entries(initial).map(([k, body]) => [k, { body, options: {} }]));
  return {
    objects,
    async get(key) {
      const o = objects.get(key);
      if (!o) {
        return null;
      }
      return {
        text: async () => o.body,
        customMetadata: (o.options && o.options.customMetadata) || {},
      };
    },
    async put(key, body, options) {
      objects.set(key, { body, options });
    },
  };
}

/**
 * A D1 stand-in that understands exactly the statements src/lookup.js issues, keyed on
 * the table they touch.
 */
export function fakeDb({ rules = [], people = [] } = {}) {
  const channels = new Map();
  const identities = new Map();
  const k = (...a) => a.join('|');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async first() {
      if (/FROM channels/.test(sql)) {
        return channels.get(k(...args)) || null;
      }
      if (/FROM identities/.test(sql)) {
        const row = identities.get(k(...args));
        if (!row) {
          return null;
        }
        const p = people.find((x) => x.id === row.person);
        return { ...row, person_staff: p ? p.staff : null, person_name: p ? p.name : null };
      }
      if (/FROM people WHERE email/.test(sql)) {
        return people.find((p) => p.email.toLowerCase() === String(args[0]).toLowerCase()) || null;
      }
      throw new Error(`fakeDb: ${sql}`);
    },
    async all() {
      if (/FROM rules/.test(sql)) {
        return { results: rules };
      }
      throw new Error(`fakeDb: ${sql}`);
    },
    async run() {
      if (/INSERT INTO channels \(source, tenant, channel_id, name, fetched_at\)/.test(sql)) {
        const [source, tenant, id, name, at] = args;
        const old = channels.get(k(source, tenant, id)) || {};
        channels.set(k(source, tenant, id), { ...old, name, fetched_at: at });
      } else if (/INSERT INTO channels/.test(sql)) {
        const [source, tenant, id, name, gid, gname, shared, connected, at] = args;
        channels.set(k(source, tenant, id), {
          name, group_id: gid, group_name: gname, shared, connected, fetched_at: at,
        });
      } else if (/INSERT INTO identities/.test(sql)) {
        const [source, tenant, id, kind, name, email, home, person, at] = args;
        identities.set(k(source, tenant, id), {
          kind, name, email, home, person, fetched_at: at,
        });
      } else {
        throw new Error(`fakeDb: ${sql}`);
      }
      return { success: true };
    },
  });
  return {
    channels, identities, prepare: (sql) => stmt(sql),
  };
}
