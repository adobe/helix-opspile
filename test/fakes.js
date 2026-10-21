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
    async list({ prefix = '' } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { objects: keys.map((key) => ({ key })) };
    },
  };
}
