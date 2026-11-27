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
 * A blob over a piece has the hash of each piece (1 MiB) in its layer, so the mount reads only
 * the pieces a read covers, one GET for each run of them (the whole blob when that is all of
 * it), and checks each by itself; a file without them (a layer of an older build) is read
 * whole, and checked by its sha256. The kernel reads a program whole, in runs of 8 MiB, and a
 * data file in pages, a run of 1 MiB at a time.
 *
 * Layers and blobs are named by their content and never change, so what was read is kept for
 * every agent of this isolate: the trees of the last few images, and pieces and whole blobs up
 * to CACHE_BYTES, the least recently used going first. None of a file over CACHE_BLOB_MAX: of
 * one with pieces, the mount holds the last HOLD_PIECES it read; of one without, the file
 * handle that read it holds it whole.
 *
 * The kernel keeps no copy of a program (since 1.189.1): it compiles one, and a Dynamic Worker
 * that starts cold reads it again, whole, through this mount. So what is kept here is the only
 * copy of a program in the agent's object, which serves those reads, and the kernel's next
 * boot in this isolate (an agent mostly comes back to the same one): a command in some 100 ms
 * instead of one to three seconds. Reading a program costs, while the Worker Loader takes it,
 * its bytes once more (gh's 50 MB), beside what is kept here and the agent itself (its model
 * loop runs in the same object), all in the object's 128 MB.
 *
 * No Workers runtime is needed here, so this is tested in Node, with a bucket in memory.
 */

export const DEFAULT_IMAGE = 'base';
export const isImageName = (name) => /^[a-z][a-z0-9-]{0,31}$/.test(String(name || ''));

/** Where a kernel has its image, and its packages in it. */
export const IMAGE_ROOT = '/opt/image';
export const IMAGE_COMMANDS = `${IMAGE_ROOT}/node_modules`;

// Measured on stage (`npm run computer:check -- --measure`, GitHub image): at 64 MiB, kept
// with gh in it, the object exceeded its memory when its kernel booted again and read gh. At
// 48 MiB it does not, and leaves room for the agent's own loop.
const CACHE_BYTES = 48 * 1024 * 1024;
// Of a file larger than this none is kept for the isolate: gh (50 MB) and yq (28 MB) would push
// out every other program, which a kernel that boots again then reads from the bucket, and gh,
// kept, beside its copy for the Worker Loader, is what made 64 MiB too much.
const CACHE_BLOB_MAX = 24 * 1024 * 1024;
/** What the isolate keeps at most (CACHE_BYTES), and of one file (CACHE_BLOB_MAX). */
const budget = { bytes: CACHE_BYTES, fileMax: CACHE_BLOB_MAX };
const CACHE_TREES = 8;
// How many pieces of a file over CACHE_BLOB_MAX a mount holds: the last two it read.
const HOLD_PIECES = 2;
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
/**
 * The blobs and the pieces of blobs last read in this isolate, by their sha256, the least
 * recently used first; `cached` their bytes. A piece is named by its own hash, so two files
 * that share one share it here too.
 */
const kept = new Map();
let cached = 0;
/** What is being read from the bucket now, by sha256: two reads of it wait for one GET. */
const reading = new Map();
/** What this isolate asked of the bucket: GETs, the bytes they brought, and reads it had. */
const reads = { gets: 0, fetched: 0, hits: 0 };

/** Forgets what this isolate kept of the bucket (for tests). */
export function forgetImages() {
  trees.clear();
  kept.clear();
  reading.clear();
  cached = 0;
  Object.assign(reads, { gets: 0, fetched: 0, hits: 0 });
  Object.assign(budget, { bytes: CACHE_BYTES, fileMax: CACHE_BLOB_MAX });
}

/** The least recently used go until what is kept fits the budget. */
function evict() {
  while (cached > budget.bytes && kept.size > 0) {
    const [oldest, old] = kept.entries().next().value;
    kept.delete(oldest);
    cached -= old.length;
  }
}

/**
 * Sizes what this isolate keeps of the bucket's files: `bytes` in all, `fileMax` of one file
 * (by default CACHE_BYTES and CACHE_BLOB_MAX). For the dev computer's measurements
 * (scripts/dev-computer/worker.mjs): the Worker keeps the defaults.
 */
export function sizeImageCache({ bytes = CACHE_BYTES, fileMax = CACHE_BLOB_MAX } = {}) {
  Object.assign(budget, { bytes, fileMax: Math.min(fileMax, bytes) });
  evict();
  return { ...budget };
}

/**
 * What this isolate asked of the bucket for files, and keeps of them: `{ gets, fetched, hits,
 * entries, bytes, budget, fileMax }`, `fetched` the bytes the GETs brought, `hits` the reads
 * of a piece or a blob it had.
 */
export const imageReads = () => ({
  ...reads, entries: kept.size, bytes: cached, budget: budget.bytes, fileMax: budget.fileMax,
});

/** What this isolate keeps of the bucket's files now: `{ entries, bytes }` (for tests). */
export const keptOfImages = () => ({ entries: kept.size, bytes: cached });

/** The bytes kept as `hash`, now the most recently used, or undefined. */
function recall(hash) {
  const bytes = kept.get(hash);
  if (bytes) {
    kept.delete(hash);
    kept.set(hash, bytes);
    reads.hits += 1;
  }
  return bytes;
}

/** Keeps `bytes` as `hash`, the least recently used going while there is too much. */
function keep(hash, bytes) {
  if (kept.has(hash)) {
    return;
  }
  kept.set(hash, bytes);
  cached += bytes.length;
  evict();
}

/** `read()` once at a time for `hash`: a second caller meanwhile waits for the first. */
function once(hash, read) {
  let pending = reading.get(hash);
  if (!pending) {
    pending = read().finally(() => reading.delete(hash));
    reading.set(hash, pending);
  }
  return pending;
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

const isHash = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

/**
 * The pieces of a layer's file `f` (scripts/computer-images.mjs `piecesOf`), when they are
 * well-formed and cover it: `{ size, sha256 }`, or undefined (the file is read whole).
 */
function piecesOf(f) {
  const { pieces } = f;
  if (!pieces || !Number.isInteger(pieces.size) || pieces.size <= 0
    || !Array.isArray(pieces.sha256) || !pieces.sha256.every(isHash)
    || pieces.sha256.length !== Math.ceil(f.size / pieces.size)) {
    return undefined;
  }
  return { size: pieces.size, sha256: pieces.sha256 };
}

/**
 * The tree of `image` (a manifest): its layers from `bucket`, each checked against its
 * digest, merged from the bottom up, so that the upper layer's file is the image's.
 * `{ files, dirs }`: `files` by path (`/node_modules/…`: `{ size, mode, sha256, pieces? }`
 * or `{ size, mode, bytes }`), `dirs` the names in each directory, by its path (`/` the
 * image's root).
 */
export async function imageTree(bucket, image) {
  const known = trees.get(image.digest);
  if (known) {
    return known;
  }
  const files = new Map();
  for (const l of await Promise.all(image.layers.map((ref) => layer(bucket, ref)))) {
    for (const f of l.files) {
      const pieces = f.sha256 ? piecesOf(f) : undefined;
      files.set(`/${f.path}`, {
        size: f.size,
        mode: f.mode,
        ...(f.sha256 ? { sha256: f.sha256 }
          : { bytes: Uint8Array.from(atob(f.data || ''), (c) => c.charCodeAt(0)) }),
        ...(pieces ? { pieces } : {}),
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

/**
 * The bytes of the blob `hash` from `bucket`, whole, checked against its name: a file without
 * pieces. Kept (see above) unless it is over CACHE_BLOB_MAX.
 */
async function blob(bucket, hash, path) {
  const known = recall(hash);
  if (known) {
    return known;
  }
  return once(hash, async () => {
    const object = await bucket.get(`blobs/${hash}`);
    if (!object) {
      throw fsError('EIO', `the images bucket has no blobs/${hash} (${path})`);
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    reads.gets += 1;
    reads.fetched += bytes.length;
    if (await sha256(bytes) !== hash) {
      throw fsError('EIO', `blobs/${hash} is not the file it names (${path})`);
    }
    if (bytes.length <= budget.fileMax) {
      keep(hash, bytes);
    }
    return bytes;
  });
}

/**
 * Pieces `first` to `last` of `file` (one with `pieces`) from `bucket`, in one GET: the whole
 * blob when they are all of it, else the range they cover. Each is checked against its hash
 * and is a copy of its own, so that one kept does not hold the others' bytes.
 */
async function readPieces(bucket, file, first, last, path) {
  const { size, sha256: hashes } = file.pieces;
  const offset = first * size;
  const length = Math.min(file.size, (last + 1) * size) - offset;
  const whole = first === 0 && last === hashes.length - 1;
  const key = `blobs/${file.sha256}`;
  const object = await (whole ? bucket.get(key) : bucket.get(key, { range: { offset, length } }));
  if (!object) {
    throw fsError('EIO', `the images bucket has no ${key} (${path})`);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  reads.gets += 1;
  reads.fetched += bytes.length;
  if (bytes.length !== length) {
    throw fsError('EIO', `${key} is not the file it names (${path})`);
  }
  const out = [];
  for (let i = first; i <= last; i += 1) {
    const piece = bytes.slice((i - first) * size, (i - first + 1) * size);
    // eslint-disable-next-line no-await-in-loop
    if (await sha256(piece) !== hashes[i]) {
      throw fsError('EIO', `${key} is not the file it names, at piece ${i} (${path})`);
    }
    out.push(piece);
  }
  return out;
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
  // Of the files over CACHE_BLOB_MAX, the pieces this mount read last (HOLD_PIECES): the
  // kernel reads a file in runs that need not start where a piece does, so a run's first
  // piece may be the one before's last.
  const held = new Map();
  const hold = (hash, bytes) => {
    held.delete(hash);
    held.set(hash, bytes);
    while (held.size > HOLD_PIECES) {
      held.delete(held.keys().next().value);
    }
  };
  const have = (file, hash) => {
    if (file.size <= budget.fileMax) {
      return recall(hash);
    }
    const bytes = held.get(hash);
    if (bytes) {
      hold(hash, bytes);
      reads.hits += 1;
    }
    return bytes;
  };

  /**
   * `size` bytes at `offset` of `file` (one with pieces): the pieces they are in, from this
   * isolate or this mount where it has them, else from the bucket, one GET for each run of
   * pieces neither has. A copy: the kernel may take the buffer it is given.
   */
  async function pieced(file, path, offset, size) {
    const { size: piece, sha256: hashes } = file.pieces;
    const end = Math.min(file.size, offset + size);
    if (!(offset < end)) {
      return new Uint8Array(0);
    }
    const first = Math.floor(offset / piece);
    const last = Math.floor((end - 1) / piece);
    const found = new Map();
    const runs = [];
    for (let i = first; i <= last; i += 1) {
      const bytes = have(file, hashes[i]);
      if (bytes) {
        found.set(i, bytes);
      } else if (!reading.has(hashes[i])) {
        const run = runs[runs.length - 1];
        if (run && run[1] === i - 1) {
          run[1] = i;
        } else {
          runs.push([i, i]);
        }
      }
    }
    for (const [from, to] of runs) {
      const got = readPieces(bucket, file, from, to, path);
      for (let i = from; i <= to; i += 1) {
        const hash = hashes[i];
        if (!reading.has(hash)) {
          const one = got.then((parts) => {
            const bytes = parts[i - from];
            if (file.size <= budget.fileMax) {
              keep(hash, bytes);
            } else {
              hold(hash, bytes);
            }
            return bytes;
          });
          const done = () => reading.delete(hash);
          one.then(done, done);
          reading.set(hash, one);
        }
      }
    }
    const wanted = [];
    for (let i = first; i <= last; i += 1) {
      wanted.push(found.get(i) || reading.get(hashes[i]));
    }
    const parts = await Promise.all(wanted);
    const out = new Uint8Array(end - offset);
    parts.forEach((bytes, k) => {
      const at = (first + k) * piece;
      const part = bytes.subarray(Math.max(0, offset - at), Math.min(piece, end - at));
      out.set(part, Math.max(0, at - offset));
    });
    return out;
  }

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
      open.set(next, { path });
      return next;
    },
    async read(fh, offset, size) {
      const handle = open.get(fh);
      if (!handle) {
        throw fsError('EBADF', String(fh));
      }
      const file = files.get(handle.path);
      if (file.pieces) {
        return pieced(file, handle.path, offset, size);
      }
      // The handle keeps what it read, so a large blob is read once per open, not per read.
      handle.bytes ??= file.bytes ? Promise.resolve(file.bytes)
        : blob(bucket, file.sha256, handle.path);
      const bytes = await handle.bytes.catch((e) => {
        handle.bytes = undefined;
        throw e;
      });
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
