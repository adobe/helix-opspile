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
 * The images of the agents' computers on the SLICC kernel (src/agent/kernel.js): which
 * programs a computer has. An image is a stack of layers, as a container image is: each
 * layer is a tree of files, and where two layers have a path, the upper one's file is the
 * image's. scripts/computer-images.mjs builds them from this repository's pinned packages and
 * keeps them in the `IMAGES` bucket, and says what is where: `images/index.json`,
 * `images/<name>.json`, `layers/<sha256>.json` and `blobs/<sha256>`.
 *
 * The Worker carries none of them, and no agent keeps a copy. A team chooses an image by name
 * (the knowledge-base editor's Computer tool), and a kernel mounts it when it boots, read-only,
 * at IMAGE_ROOT: a file system this Worker serves (`imageDriver`) from the layers' merged tree
 * (`imageTree`), which reads a file from the bucket when a program first opens it. The kernel
 * finds the image's commands under IMAGE_COMMANDS.
 *
 * Layers and blobs are named by their content and never change, so what was read is kept for
 * every agent of this isolate: the trees of the last few images, and blobs up to CACHE_BYTES.
 *
 * No Workers runtime is needed here, so this is tested in Node, with a bucket in memory.
 */

export const DEFAULT_IMAGE = 'base';
export const isImageName = (name) => /^[a-z][a-z0-9-]{0,31}$/.test(String(name || ''));

/** Where a kernel has its image, and its packages in it. */
export const IMAGE_ROOT = '/opt/image';
export const IMAGE_COMMANDS = `${IMAGE_ROOT}/node_modules`;

const CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_TREES = 8;
// How long the kernel may keep what it was told of a file: the image never changes.
const TTL_MS = 60 * 60 * 1000;

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0'))
  .join('');
const sha256 = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
const fsError = (code, path) => Object.assign(new Error(`${code}: ${path}`), { code });

async function text(bucket, key) {
  const object = bucket ? await bucket.get(key) : null;
  return object ? object.text() : null;
}

/** The images in `bucket`: `[{ name, title, description, digest, bytes, layers }]`. */
export async function listImages(bucket) {
  try {
    const index = JSON.parse(await text(bucket, 'images/index.json'));
    return index.v === 2 ? index.images.filter((i) => isImageName(i.name)) : [];
  } catch {
    return [];
  }
}

/** The manifest of the image `name` in `bucket`, or null. */
export async function readImage(bucket, name) {
  const body = isImageName(name) ? await text(bucket, `images/${name}.json`) : null;
  const image = body ? JSON.parse(body) : null;
  return image && image.v === 2 && Array.isArray(image.layers) ? image : null;
}

/** The commands of `image` (a manifest), sorted. */
export const commandsOf = (image) => [...image.commands].sort();

/** The trees of the images last mounted in this isolate, by digest. */
const trees = new Map();
/** The blobs last read in this isolate, by sha256, the least recently used first. */
const blobs = new Map();
let cached = 0;

/** Forgets what this isolate kept of the bucket (for tests). */
export function forgetImages() {
  trees.clear();
  blobs.clear();
  cached = 0;
}

async function layer(bucket, { name, digest }) {
  const body = await text(bucket, `layers/${digest}.json`);
  if (body === null) {
    throw new Error(`the images bucket has no layers/${digest}.json (${name})`);
  }
  if (await sha256(new TextEncoder().encode(body)) !== digest) {
    throw new Error(`layers/${digest}.json is not the layer it names (${name})`);
  }
  return JSON.parse(body);
}

/**
 * The tree of `image` (a manifest): its layers from `bucket`, each checked against its
 * digest, merged from the bottom up, so that the upper layer's file is the image's.
 * `{ files, dirs }`: `files` by path (`/node_modules/…`: `{ size, mode, sha256 | bytes }`),
 * `dirs` the names in each directory, by its path (`/` the image's root).
 */
export async function imageTree(bucket, image) {
  const kept = trees.get(image.digest);
  if (kept) {
    return kept;
  }
  const files = new Map();
  for (const l of await Promise.all(image.layers.map((ref) => layer(bucket, ref)))) {
    for (const f of l.files) {
      files.set(`/${f.path}`, {
        size: f.size,
        mode: f.mode,
        ...(f.sha256 ? { sha256: f.sha256 }
          : { bytes: Uint8Array.from(atob(f.data || ''), (c) => c.charCodeAt(0)) }),
      });
    }
  }
  const dirs = new Map([['/', new Set()]]);
  for (const path of files.keys()) {
    const parts = path.split('/').slice(1);
    let dir = '/';
    for (const part of parts) {
      if (!dirs.has(dir)) {
        dirs.set(dir, new Set());
      }
      dirs.get(dir).add(part);
      dir = dir === '/' ? `/${part}` : `${dir}/${part}`;
    }
  }
  const tree = { files, dirs };
  trees.set(image.digest, tree);
  if (trees.size > CACHE_TREES) {
    trees.delete(trees.keys().next().value);
  }
  return tree;
}

/** The bytes of the blob `hash` from `bucket`, checked against its name; kept (see above). */
async function blob(bucket, hash, path) {
  const kept = blobs.get(hash);
  if (kept) {
    // The most recently used last.
    blobs.delete(hash);
    blobs.set(hash, kept);
    return kept;
  }
  const object = await bucket.get(`blobs/${hash}`);
  if (!object) {
    throw fsError('EIO', `the images bucket has no blobs/${hash} (${path})`);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256(bytes) !== hash) {
    throw fsError('EIO', `blobs/${hash} is not the file it names (${path})`);
  }
  blobs.set(hash, bytes);
  cached += bytes.length;
  while (cached > CACHE_BYTES && blobs.size > 1) {
    const [oldest, old] = blobs.entries().next().value;
    blobs.delete(oldest);
    cached -= old.length;
  }
  return bytes;
}

/**
 * `tree` (imageTree) as a read-only file system of the kernel: `{ handlers, capabilities }`,
 * for its `inProcessMount`. Paths are the mount's own (`/` its root). A file's bytes come
 * from `bucket` when it is first read, and every change is refused (EROFS).
 */
export function imageDriver(bucket, tree) {
  const { files, dirs } = tree;
  const open = new Map();
  let next = 0;
  const refuse = async (path) => {
    throw fsError('EROFS', path);
  };
  const attr = (path) => {
    const file = files.get(path);
    if (file) {
      return {
        kind: 'file', size: file.size, mtime: 0, mode: file.mode,
      };
    }
    if (dirs.has(path)) {
      return {
        kind: 'directory', size: 0, mtime: 0, mode: 0o555,
      };
    }
    throw fsError('ENOENT', path);
  };
  const handlers = {
    getattr: async (path) => attr(path),
    async readdir(path) {
      if (!dirs.has(path)) {
        throw fsError(files.has(path) ? 'ENOTDIR' : 'ENOENT', path);
      }
      const prefix = path === '/' ? '/' : `${path}/`;
      return [...dirs.get(path)].sort().map((name) => ({ name, kind: attr(prefix + name).kind }));
    },
    async open(path, flags = {}) {
      if (flags.write || flags.create || flags.truncate) {
        throw fsError('EROFS', path);
      }
      if (!files.has(path)) {
        throw fsError(dirs.has(path) ? 'EISDIR' : 'ENOENT', path);
      }
      next += 1;
      open.set(next, path);
      return next;
    },
    async read(fh, offset, size) {
      const path = open.get(fh);
      if (!path) {
        throw fsError('EBADF', String(fh));
      }
      const file = files.get(path);
      const bytes = file.bytes || await blob(bucket, file.sha256, path);
      // A copy: the kernel may take the buffer it is given.
      return bytes.slice(offset, offset + size);
    },
    async release(fh) {
      open.delete(fh);
    },
    async statfs() {
      const used = [...files.values()].reduce((n, f) => n + Math.ceil(f.size / 4096), 0);
      return { bsize: 4096, blocks: used, bfree: 0 };
    },
    write: refuse,
    mkdir: refuse,
    rmdir: refuse,
    unlink: refuse,
    rename: refuse,
    setattr: refuse,
  };
  return {
    handlers,
    capabilities: {
      readonly: true, ranges: true, attrTtl: TTL_MS, entryTtl: TTL_MS,
    },
  };
}
