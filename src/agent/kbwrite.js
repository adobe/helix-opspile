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
import { checkDiagrams } from '../diagrams.js';
import {
  addLogEntry, asSystemPrompt, checkConcept, checkLayout, dotInfo, isDiagram, isEntry, renderIndex,
  RESERVED,
  splitFrontmatter, stampGenerated, SYSTEM_PROMPT,
} from './okf.js';
import { checkStackTech } from '../stacktech.js';
import { storeOrgStack } from '../orgstacks.js';
import { STACK_PATH } from '../stack.js';
import {
  checkCatalog, compileCatalog, inCatalog, movesOf, storeCatalog, withMovedFrom,
} from '../catalog.js';

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
export const AGENT_AUTHOR = { name: 'opspile agent', email: 'agent@opspile.invalid' };
export const MAX_CHANGES = 20;
const MAX_SYSTEM_PROMPT = 16 * 1024;

const enc = new TextEncoder();

/** `org` or `team`: the kind of knowledge base an Artifacts repo is, or null. */
export const kindOf = (artifact) => (/^kb-(org|team)-/.exec(String(artifact)) || [])[1] || null;

/**
 * Checks a change set before anything is cloned; returns an error message or null. Only
 * `staff` writes (the admin team, in the knowledge-base editor) may touch `systemprompt.md`.
 * The agents' concepts (not `staff`) of a knowledge base of `kind` go where their type goes
 * (`checkLayout`); people file as they like.
 */
export function checkChanges(changes, { staff = false, kind = null } = {}) {
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
    if (c.path === SYSTEM_PROMPT) {
      if (!staff) {
        return `${SYSTEM_PROMPT} is maintained by the admin team; you cannot change it`;
      }
      if (!c.delete && String(c.content ?? '').length > MAX_SYSTEM_PROMPT) {
        return `${SYSTEM_PROMPT} is at most ${MAX_SYSTEM_PROMPT / 1024} KB: it goes into every request`;
      }
      // eslint-disable-next-line no-continue
      continue;
    }
    if (c.delete) {
      if (RESERVED.has(String(c.path).split('/').pop())) {
        return `${c.path} is maintained automatically`;
      }
    } else {
      const why = checkConcept(c.path, String(c.content ?? ''))
        // What is under products/ of a team's is what Clef asks: people are held to it too.
        || (kind === 'team' ? checkCatalog(c.path, String(c.content ?? '')) : null)
        || (!staff && kind ? checkLayout(c.path, String(c.content ?? ''), kind) : null);
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
        const count = fs.files(`${abs}/${name}`).filter((f) => (f.endsWith('.md') || isDiagram(f)) && !RESERVED.has(f.split('/').pop())).length;
        if (count) {
          entries.push({ name, dir: true, count });
        }
      } else if (isDiagram(name)) {
        // eslint-disable-next-line no-await-in-loop
        entries.push({ name, dot: dotInfo(name, await fs.promises.readFile(`${abs}/${name}`, 'utf8')) });
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
    if (c.create && present) {
      return `${c.path} already exists; open it and edit it instead`;
    }
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
      const content = c.path === SYSTEM_PROMPT ? asSystemPrompt(c.content) : String(c.content);
      // A diagram has no frontmatter to stamp: its commit says who wrote it and when.
      const text = isDiagram(c.path) ? content : stampGenerated(content, by, at);
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.writeFile(abs, enc.encode(text));
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
 * `changes` with what a move of a catalog file keeps (src/catalog.js): a file the write deletes
 * and one it creates in its place, the new one listing the old one's ids in `moved_from`.
 */
async function keepMoves(fs, changes) {
  const pairs = await movesOf(changes, {
    old: (path) => fs.promises.readFile(`${DIR}/${path}`, 'utf8').catch(() => ''),
    present: (path) => exists(fs, `${DIR}/${path}`),
  });
  if (!pairs.length) {
    return changes;
  }
  return changes.map((c) => {
    const pair = pairs.find((x) => x.to === c.path);
    return pair ? { ...c, content: withMovedFrom(String(c.content ?? ''), pair.ids) } : c;
  });
}

/**
 * Commits `changes` to the clone in `fs` (already cloned or initialised at `DIR`). Exported
 * for tests, which run it without a remote. `catalog`: a team's knowledge base, whose moved
 * catalog files keep their ids.
 */
export async function commitChanges(fs, changes, {
  message, by, at, logEntry, author = AGENT_AUTHOR, catalog = false,
}) {
  const conflict = await apply(fs, catalog ? await keepMoves(fs, changes) : changes, { by, at });
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
    author: {
      name: author.name, email: author.email, timestamp: Math.floor(Date.parse(at) / 1000),
    },
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

/**
 * Records how many entries the knowledge base has now (`knowledge_bases.entries`), from the
 * work tree that was pushed. The editor's list ranks by it; a failure leaves the last count.
 */
async function countEntries(env, artifact, fs) {
  if (!env.DB) {
    return;
  }
  const n = fs.files(DIR).filter((f) => !f.startsWith('.git/') && isEntry(f)).length;
  await env.DB.prepare('UPDATE knowledge_bases SET entries = ? WHERE repo = ?').bind(n, artifact).run()
    .catch((e) => console.error(JSON.stringify({
      route: 'kb', action: 'count', artifact, error: e.message,
    })));
}

/**
 * Compiles the catalog of a team's knowledge base from the work tree that was pushed
 * (src/catalog.js): its products/ files into tech_stack. A failure leaves the rows as they were,
 * and the cron compiles it again (its commit is not recorded).
 */
export async function compileTree(env, artifact, fs, commit) {
  if (!env.DB) {
    return null;
  }
  try {
    const paths = fs.files(DIR).filter((f) => !f.startsWith('.git/') && inCatalog(f));
    const files = await Promise.all(paths.map(async (path) => ({
      path, text: await fs.promises.readFile(`${DIR}/${path}`, 'utf8'),
    })));
    const team = artifact.replace(/^kb-team-/, '');
    return await storeCatalog(env, { team, repo: artifact, commit }, compileCatalog(files));
  } catch (e) {
    console.error(JSON.stringify({
      route: 'kb', action: 'catalog', artifact, error: e.message,
    }));
    return null;
  }
}

const rejected = (e) => /PushRejected|not a simple fast-forward|non-fast-forward|fetch first|failed to update ref/i
  .test(`${e && e.code} ${e && e.message}`);

/**
 * Writes `changes` (`{ path, content }`, `{ path, delete: true }`, each with an optional
 * `base` blob hash) to the Artifacts repo `artifact`. `by` is the OKF actor stamped into
 * `generated`, `author` the commit author (default: the agent), and `staff` allows changes
 * to `systemprompt.md`.
 *
 * @returns {Promise<{ commit?: string, conflict?: string, unchanged?: boolean, files?: string[] }>}
 */
export async function writeKnowledge(env, artifact, changes, {
  message, by, at = new Date().toISOString(), logEntry, author, staff = false,
}) {
  const invalid = checkChanges(changes, { staff, kind: kindOf(artifact) })
    || await checkDiagrams(env, changes);
  if (invalid) {
    return { error: invalid };
  }
  // A customer's stack drawing names its technologies as the catalog does (src/stacktech.js).
  let filled = [];
  if (kindOf(artifact) === 'org') {
    const fixed = await checkStackTech(env, changes, { staff });
    if (fixed.error) {
      return { error: fixed.error };
    }
    ({ filled } = fixed);
    // eslint-disable-next-line no-param-reassign
    changes = fixed.changes;
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
        message, by, at, logEntry, author, catalog: kindOf(artifact) === 'team',
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
        // eslint-disable-next-line no-await-in-loop
        await countEntries(env, artifact, fs);
        if (kindOf(artifact) === 'org' && changes.some((c) => c.path === STACK_PATH)) {
          // The customer's stack as the inbox's list shows it (src/orgstacks.js).
          // eslint-disable-next-line no-await-in-loop
          const text = await fs.promises.readFile(`${DIR}/${STACK_PATH}`, 'utf8').catch(() => null);
          // eslint-disable-next-line no-await-in-loop
          await storeOrgStack(env, artifact.replace(/^kb-org-/, ''), text).catch((e) => console.error(
            JSON.stringify({
              route: 'kb', action: 'stack', artifact, error: e.message,
            }),
          ));
        }
        if (kindOf(artifact) === 'team' && changes.some((c) => inCatalog(c.path))) {
          // eslint-disable-next-line no-await-in-loop
          await compileTree(env, artifact, fs, result.commit);
        }
        const files = changes.map((c) => c.path);
        return { commit: result.commit, files, ...(filled.length ? { filled } : {}) };
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
