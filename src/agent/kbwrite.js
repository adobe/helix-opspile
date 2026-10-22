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

import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { memfs } from './memfs.js';
import {
  addLogEntry, checkConcept, renderIndex, RESERVED, splitFrontmatter, stampGenerated,
} from './okf.js';

/**
 * Writes to a knowledge base: clone it into memory, apply the agent's changes, rewrite the
 * `index.md` of every directory it touched and add a `log.md` entry, commit, push. Several
 * agents write the same team knowledge base, so a rejected push is retried from a fresh
 * clone; a change that names the `base` it was written from fails instead of overwriting a
 * file somebody changed in between.
 */

const DIR = '/kb';
const BRANCH = 'main';
const ATTEMPTS = 3;
const AUTHOR = { name: 'opspile agent', email: 'agent@opspile.invalid' };
export const MAX_CHANGES = 20;

const enc = new TextEncoder();

/** Checks a change set before anything is cloned; returns an error message or null. */
export function checkChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) {
    return 'give at least one change';
  }
  if (changes.length > MAX_CHANGES) {
    return `at most ${MAX_CHANGES} files per write`;
  }
  const seen = new Set();
  for (const c of changes) {
    if (seen.has(c.path)) {
      return `${c.path} appears twice`;
    }
    seen.add(c.path);
    if (c.delete) {
      if (RESERVED.has(String(c.path).split('/').pop())) {
        return `${c.path} is maintained automatically`;
      }
    } else {
      const why = checkConcept(c.path, String(c.content ?? ''));
      if (why) {
        return `${c.path}: ${why}`;
      }
    }
  }
  return null;
}

async function exists(fs, path) {
  try {
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** `index.md` for `dir` and each of its ancestors, from what is now in the work tree. */
async function rewriteIndexes(fs, dirs) {
  const all = new Set();
  for (const d of dirs) {
    let cur = d;
    for (;;) {
      all.add(cur);
      if (!cur) {
        break;
      }
      cur = dirOf(cur);
    }
  }
  // Deepest first, so a directory left empty is gone before its parent is listed.
  for (const d of [...all].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a))) {
    const abs = d ? `${DIR}/${d}` : DIR;
    // eslint-disable-next-line no-await-in-loop
    if (!await exists(fs, abs)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const entries = [];
    // eslint-disable-next-line no-await-in-loop
    for (const name of await fs.promises.readdir(abs)) {
      if (name === '.git' || RESERVED.has(name)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const st = await fs.promises.stat(`${abs}/${name}`);
      if (st.isDirectory()) {
        const count = fs.files(`${abs}/${name}`).filter((f) => f.endsWith('.md') && !RESERVED.has(f.split('/').pop())).length;
        if (count) {
          entries.push({ name, dir: true, count });
        }
      } else if (name.endsWith('.md')) {
        // eslint-disable-next-line no-await-in-loop
        const fm = splitFrontmatter(await fs.promises.readFile(`${abs}/${name}`, 'utf8'));
        entries.push({ name, yaml: fm ? fm.yaml : '' });
      }
    }
    if (!entries.length && d) {
      // Nothing left here: drop the index, and the directory with it.
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.unlink(`${abs}/index.md`).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.rmdir(abs).catch(() => {});
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await fs.promises.writeFile(`${abs}/index.md`, renderIndex(d, entries, { root: !d }));
  }
}

/**
 * Applies `changes` to the clone in `fs`. Returns an error message for a change whose
 * `base` no longer matches, or null.
 */
async function apply(fs, changes, { by, at }) {
  for (const c of changes) {
    const abs = `${DIR}/${c.path}`;
    // eslint-disable-next-line no-await-in-loop
    const present = await exists(fs, abs);
    if (c.base !== undefined && c.base !== null) {
      const current = present
        // eslint-disable-next-line no-await-in-loop
        ? (await git.hashBlob({ object: await fs.promises.readFile(abs) })).oid
        : null;
      if (current !== c.base) {
        return `${c.path} changed since you read it (now ${current ? current.slice(0, 12) : 'deleted'}); read it again and redo your change`;
      }
    }
    if (c.delete) {
      if (!present) {
        return `${c.path} does not exist`;
      }
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.unlink(abs);
    } else {
      // eslint-disable-next-line no-await-in-loop
      await fs.mkdirp(dirOf(abs));
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.writeFile(abs, enc.encode(stampGenerated(String(c.content), by, at)));
    }
  }
  return null;
}

/** Stages every change in the work tree, deletions included. */
async function stageAll(fs) {
  const matrix = await git.statusMatrix({ fs, dir: DIR });
  let changed = 0;
  for (const [filepath, head, workdir] of matrix) {
    if (workdir === 0 && head === 1) {
      // eslint-disable-next-line no-await-in-loop
      await git.remove({ fs, dir: DIR, filepath });
      changed += 1;
    } else if (workdir === 2) {
      // eslint-disable-next-line no-await-in-loop
      await git.add({ fs, dir: DIR, filepath });
      changed += 1;
    }
  }
  return changed;
}

/**
 * Commits `changes` to the clone in `fs` (already cloned or initialised at `DIR`). Exported
 * for tests, which run it without a remote.
 */
export async function commitChanges(fs, changes, {
  message, by, at, logEntry,
}) {
  const conflict = await apply(fs, changes, { by, at });
  if (conflict) {
    return { conflict };
  }
  await rewriteIndexes(fs, new Set(changes.map((c) => dirOf(c.path))));
  const log = `${DIR}/log.md`;
  const existing = await exists(fs, log) ? await fs.promises.readFile(log, 'utf8') : '';
  await fs.promises.writeFile(log, addLogEntry(existing, at.slice(0, 10), logEntry));
  if (!await stageAll(fs)) {
    return { unchanged: true };
  }
  const commit = await git.commit({
    fs,
    dir: DIR,
    message,
    author: { ...AUTHOR, timestamp: Math.floor(Date.parse(at) / 1000) },
  });
  return { commit };
}

/** A fresh clone of the repo's main branch in memory, or an empty repo when it has none. */
async function cloneOrInit(url, headers, empty) {
  const fs = memfs();
  await fs.mkdirp(DIR);
  if (empty) {
    await git.init({ fs, dir: DIR, defaultBranch: BRANCH });
    await git.addRemote({
      fs, dir: DIR, remote: 'origin', url,
    });
  } else {
    await git.clone({
      fs, http, dir: DIR, url, ref: BRANCH, singleBranch: true, depth: 1, headers,
    });
  }
  return fs;
}

const rejected = (e) => /PushRejected|not a simple fast-forward|non-fast-forward|fetch first|failed to update ref/i
  .test(`${e && e.code} ${e && e.message}`);

/**
 * Writes `changes` (`{ path, content }`, `{ path, delete: true }`, each with an optional
 * `base` blob hash) to the Artifacts repo `artifact`.
 *
 * @returns {Promise<{ commit?: string, conflict?: string, unchanged?: boolean, files?: string[] }>}
 */
export async function writeKnowledge(env, artifact, changes, {
  message, by, at = new Date().toISOString(), logEntry,
}) {
  const invalid = checkChanges(changes);
  if (invalid) {
    return { error: invalid };
  }
  const repo = await env.ARTIFACTS.get(artifact);
  try {
    const { remote } = await repo.info();
    const { plaintext } = await repo.createToken('write', 900);
    const headers = { authorization: `Bearer ${plaintext}` };
    for (let attempt = 1; ; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const empty = !(await repo.log({ limit: 1 })).length;
      // eslint-disable-next-line no-await-in-loop
      const fs = await cloneOrInit(remote, headers, empty);
      // eslint-disable-next-line no-await-in-loop
      const result = await commitChanges(fs, changes, {
        message, by, at, logEntry,
      });
      if (!result.commit) {
        return result;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const pushed = await git.push({
          fs, http, dir: DIR, url: remote, ref: BRANCH, remoteRef: BRANCH, headers,
        });
        if (pushed && pushed.ok === false) {
          throw new Error(`push failed: ${pushed.error || 'rejected'}`);
        }
        return { commit: result.commit, files: changes.map((c) => c.path) };
      } catch (e) {
        if (!rejected(e) || attempt >= ATTEMPTS) {
          throw e;
        }
        // Somebody else pushed first: start over from their commit.
      }
    }
  } finally {
    if (repo[Symbol.dispose]) {
      repo[Symbol.dispose]();
    }
  }
}
