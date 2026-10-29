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

import { createHash } from 'node:crypto';

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

// R2 gives every write a new version; unique across buckets, as R2's are.
let versions = 0;
const nextVersion = () => {
  versions += 1;
  return `v${versions}`;
};

const meta = (key, o) => ({
  key,
  size: typeof o.body === 'string' ? new TextEncoder().encode(o.body).length
    : Number(o.body && o.body.byteLength) || 0,
  httpMetadata: (o.options && o.options.httpMetadata) || {},
  customMetadata: (o.options && o.options.customMetadata) || {},
});

/** An R2 bucket with get/put, enough for pile 2. */
export function fakeBucket(initial = {}) {
  const objects = new Map(Object.entries(initial)
    .map(([k, body]) => [k, { body, options: {}, version: nextVersion() }]));
  return {
    objects,
    async get(key) {
      const o = objects.get(key);
      if (!o) {
        return null;
      }
      return {
        ...meta(key, o),
        get body() {
          return new Response(o.body).body;
        },
        text: async () => (typeof o.body === 'string' ? o.body : new TextDecoder().decode(o.body)),
        arrayBuffer: async () => new Response(o.body).arrayBuffer(),
      };
    },
    async put(key, body, options) {
      objects.set(key, { body, options, version: nextVersion() });
    },
    async head(key) {
      return objects.has(key) ? meta(key, objects.get(key)) : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0;
      const page = keys.slice(from, from + limit);
      const truncated = from + limit < keys.length;
      return {
        objects: page.map((key) => ({ key, version: objects.get(key).version })),
        truncated,
        cursor: truncated ? String(from + limit) : undefined,
      };
    },
  };
}

const REMOTE = (name) => `https://account.artifacts.example/git/ns/${name}.git`;

/** An Artifacts namespace binding in memory. */
export function fakeArtifacts({ existing = [], fail = false } = {}) {
  const repos = new Set(existing);
  const calls = [];
  return {
    repos,
    calls,
    async create(name, opts) {
      calls.push(['create', name, opts]);
      if (fail) {
        throw new Error('INTERNAL_ERROR');
      }
      if (repos.has(name)) {
        const e = new Error('repository already exists');
        e.code = 'ALREADY_EXISTS';
        throw e;
      }
      repos.add(name);
      return { name, remote: REMOTE(name), token: 'art_v1_made-up' };
    },
    async get(name) {
      calls.push(['get', name]);
      return {
        info: async () => ({ name, remote: REMOTE(name) }),
        [Symbol.dispose]() {},
      };
    },
  };
}

const sha = (s) => createHash('sha1').update(s).digest('hex');

/** An Artifacts repo in memory, from `{ path: content }`, readable like the binding. */
export function fakeRepo(files) {
  const blobs = new Map();
  const trees = new Map();
  function tree(prefix) {
    const names = new Map();
    for (const path of Object.keys(files)) {
      if (path.startsWith(prefix)) {
        const [first, ...rest] = path.slice(prefix.length).split('/');
        names.set(first, rest.length ? 'tree' : 'blob');
      }
    }
    const entries = [...names].map(([name, type]) => {
      if (type === 'blob') {
        const content = files[`${prefix}${name}`];
        const hash = sha(`blob ${content}`);
        blobs.set(hash, content);
        return {
          name, type, hash, mode: '100644',
        };
      }
      return {
        name, type, hash: tree(`${prefix}${name}/`), mode: '40000',
      };
    });
    const hash = sha(`tree ${prefix} ${JSON.stringify(entries)}`);
    trees.set(hash, entries);
    return hash;
  }
  const root = Object.keys(files).length ? tree('') : null;
  return {
    async log() {
      return root ? [{
        hash: sha(`commit ${root}`), treeHash: root, message: 'seed', author: { name: 'x' }, committedAt: 1792584000,
      }] : [];
    },
    async readTree(hash) {
      return trees.get(hash) || null;
    },
    async readBlob(hash) {
      return blobs.has(hash) ? new Blob([blobs.get(hash)]) : null;
    },
    async info() {
      return { remote: 'https://made-up.example/git/ns/x.git' };
    },
    [Symbol.dispose]() {},
  };
}
