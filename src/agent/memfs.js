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
 * A small in-memory file system with the `promises` interface isomorphic-git uses. A Worker
 * has no disk: a knowledge base is cloned into memory, changed, committed and pushed.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function fsError(code, path) {
  const e = new Error(`${code}: ${path}`);
  e.code = code;
  return e;
}

const norm = (path) => {
  const parts = [];
  for (const p of String(path).split('/')) {
    if (p === '..') {
      parts.pop();
    } else if (p && p !== '.') {
      parts.push(p);
    }
  }
  return `/${parts.join('/')}`;
};
const parentOf = (path) => path.slice(0, path.lastIndexOf('/')) || '/';

let lastInode = 0;
const nextInode = () => {
  lastInode += 1;
  return lastInode;
};

function stats(node) {
  const isDir = node.type === 'dir';
  const isLink = node.type === 'symlink';
  const size = isDir ? 0 : node.data.length;
  return {
    type: node.type === 'dir' ? 'dir' : 'file',
    mode: node.mode,
    size,
    ino: node.ino,
    mtimeMs: node.mtimeMs,
    ctimeMs: node.mtimeMs,
    uid: 1,
    gid: 1,
    dev: 1,
    isFile: () => !isDir && !isLink,
    isDirectory: () => isDir,
    isSymbolicLink: () => isLink,
  };
}

export function memfs() {
  const nodes = new Map([['/', {
    type: 'dir', mode: 0o40755, ino: nextInode(), mtimeMs: Date.now(),
  }]]);

  const dir = (path) => {
    const node = nodes.get(path);
    if (!node) {
      throw fsError('ENOENT', path);
    }
    if (node.type !== 'dir') {
      throw fsError('ENOTDIR', path);
    }
    return node;
  };

  const promises = {
    async readFile(path, options) {
      const p = norm(path);
      const node = nodes.get(p);
      if (!node) {
        throw fsError('ENOENT', p);
      }
      if (node.type === 'dir') {
        throw fsError('EISDIR', p);
      }
      const encoding = typeof options === 'string' ? options : options && options.encoding;
      return encoding ? dec.decode(node.data) : node.data;
    },
    async writeFile(path, data, options) {
      const p = norm(path);
      dir(parentOf(p));
      const existing = nodes.get(p);
      if (existing && existing.type === 'dir') {
        throw fsError('EISDIR', p);
      }
      const bytes = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
      const mode = (options && typeof options === 'object' && options.mode) || 0o100644;
      nodes.set(p, {
        type: 'file', data: bytes, mode, ino: existing ? existing.ino : nextInode(), mtimeMs: Date.now(),
      });
    },
    async unlink(path) {
      const p = norm(path);
      const node = nodes.get(p);
      if (!node) {
        throw fsError('ENOENT', p);
      }
      if (node.type === 'dir') {
        throw fsError('EISDIR', p);
      }
      nodes.delete(p);
    },
    async readdir(path) {
      const p = norm(path);
      dir(p);
      const prefix = p === '/' ? '/' : `${p}/`;
      const names = [];
      for (const key of nodes.keys()) {
        if (key !== p && key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          names.push(key.slice(prefix.length));
        }
      }
      return names.sort();
    },
    async mkdir(path) {
      const p = norm(path);
      if (nodes.has(p)) {
        throw fsError('EEXIST', p);
      }
      dir(parentOf(p));
      nodes.set(p, {
        type: 'dir', mode: 0o40755, ino: nextInode(), mtimeMs: Date.now(),
      });
    },
    async rmdir(path) {
      const p = norm(path);
      dir(p);
      if ((await promises.readdir(p)).length) {
        throw fsError('ENOTEMPTY', p);
      }
      nodes.delete(p);
    },
    async stat(path) {
      const p = norm(path);
      let node = nodes.get(p);
      if (node && node.type === 'symlink') {
        node = nodes.get(norm(dec.decode(node.data)));
      }
      if (!node) {
        throw fsError('ENOENT', p);
      }
      return stats(node);
    },
    async lstat(path) {
      const p = norm(path);
      const node = nodes.get(p);
      if (!node) {
        throw fsError('ENOENT', p);
      }
      return stats(node);
    },
    async readlink(path) {
      const p = norm(path);
      const node = nodes.get(p);
      if (!node || node.type !== 'symlink') {
        throw fsError('EINVAL', p);
      }
      return dec.decode(node.data);
    },
    async symlink(target, path) {
      const p = norm(path);
      dir(parentOf(p));
      nodes.set(p, {
        type: 'symlink', data: enc.encode(target), mode: 0o120000, ino: nextInode(), mtimeMs: Date.now(),
      });
    },
    async chmod(path, mode) {
      const node = nodes.get(norm(path));
      if (!node) {
        throw fsError('ENOENT', path);
      }
      node.mode = mode;
    },
  };

  /** Creates a directory and its parents. */
  async function mkdirp(path) {
    const p = norm(path);
    if (nodes.has(p)) {
      return;
    }
    await mkdirp(parentOf(p));
    await promises.mkdir(p);
  }

  /** Every file below `path`, as paths relative to it. */
  function files(path = '/') {
    const p = norm(path);
    const prefix = p === '/' ? '/' : `${p}/`;
    return [...nodes.entries()]
      .filter(([k, n]) => n.type === 'file' && k.startsWith(prefix))
      .map(([k]) => k.slice(prefix.length))
      .sort();
  }

  return { promises, mkdirp, files };
}
