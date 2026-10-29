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

import { repoName } from '../kb.js';

/**
 * The repositories an agent can read: its team's and its customer's knowledge base, and the
 * GitHub repositories listed for the team, the customer or everyone in `agent_repos`. GitHub
 * repositories are read from mirrors in Artifacts, which the cron imports and refreshes, so
 * reads need no GitHub token and hit no GitHub rate limit.
 */

const MIRROR_TTL_MS = 6 * 60 * 60 * 1000;
const PENDING_TTL_MS = 60 * 60 * 1000;
const MAX_LIST = 400;
const COUNT_READS = 16;
const MAX_GREP_FILES = 300;
const MAX_GREP_HITS = 80;
const MAX_READ = 60 * 1024;
const TEXT = /\.(md|markdown|txt|js|mjs|cjs|ts|tsx|jsx|json|jsonc|ya?ml|toml|html?|css|scss|less|sql|sh|py|rb|go|rs|java|kt|xml|svg|csv|ini|conf|env\.example|gitignore|editorconfig|properties|graphql|vue|svelte)$/i;

/** `owner/name` of a GitHub URL, or null. */
export function githubSlug(url) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

/** A fresh Artifacts repo name for a mirror of `owner/name`. */
export function mirrorName(slug, now = new Date()) {
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 12);
  const base = `gh-${slug.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 63 - stamp.length - 1);
  return `${base.replace(/-+$/, '')}-${stamp}`;
}

/** The GitHub repositories listed for a team and an org, with their current mirror. */
export async function listedRepos(env, { team, org }) {
  const { results } = await env.DB.prepare(`SELECT r.url, r.scope, r.note, m.repo AS mirror
    FROM agent_repos r LEFT JOIN repo_mirrors m ON m.url = r.url
    WHERE r.scope = 'all' OR (r.scope = 'team' AND r.slug = ?) OR (r.scope = 'org' AND r.slug = ?)
    ORDER BY r.url`).bind(team || '', org || '').all();
  const seen = new Map();
  for (const r of results || []) {
    const slug = githubSlug(r.url);
    if (slug && !seen.has(slug)) {
      seen.set(slug, {
        id: slug, url: r.url, note: r.note || null, mirror: r.mirror || null,
      });
    }
  }
  return [...seen.values()];
}

/**
 * Every repository the agent may name, by the id it uses: `kb-team`, `kb-org`, and
 * `owner/name` for GitHub.
 */
export async function accessibleRepos(env, { team, org }) {
  const repos = [];
  const teamKb = repoName('team', team);
  const orgKb = repoName('org', org);
  if (teamKb) {
    repos.push({
      id: 'kb-team', artifact: teamKb, writable: true, kind: 'kb', what: `knowledge base of the ops team ${team}`,
    });
  }
  if (orgKb) {
    repos.push({
      id: 'kb-org', artifact: orgKb, writable: true, kind: 'kb', what: `knowledge base of the customer ${org}`,
    });
  }
  for (const r of await listedRepos(env, { team, org })) {
    repos.push({
      id: r.id,
      artifact: r.mirror,
      writable: false,
      kind: 'github',
      what: `GitHub ${r.url}${r.note ? ` (${r.note})` : ''}${r.mirror ? '' : ' - not mirrored yet, try later'}`,
    });
  }
  return repos;
}

async function withRepo(env, artifact, fn) {
  const repo = await env.ARTIFACTS.get(artifact);
  try {
    return await fn(repo);
  } finally {
    if (repo[Symbol.dispose]) {
      repo[Symbol.dispose]();
    }
  }
}

const cleanPath = (path) => String(path || '').replace(/^\/+|\/+$/g, '');

/** The head commit of a repo, or null when it has none yet. */
async function headOf(repo) {
  const [head] = await repo.log({ limit: 1 });
  return head || null;
}

/** The tree entry at `path` below the root tree, or null. The root itself is a tree. */
async function entryAt(repo, rootTree, path) {
  let entry = { type: 'tree', hash: rootTree, name: '' };
  for (const part of cleanPath(path).split('/').filter(Boolean)) {
    if (entry.type !== 'tree') {
      return null;
    }
    // eslint-disable-next-line no-await-in-loop
    const children = await repo.readTree(entry.hash);
    entry = (children || []).find((c) => c.name === part);
    if (!entry) {
      return null;
    }
  }
  return entry;
}

/**
 * Files and directories below `path`, breadth first, at most `limit`. The directories of one
 * level are read at once (the knowledge-base editor lists the whole tree, and reading it a
 * directory at a time took seconds); the result is the same as reading them one by one.
 */
async function walk(repo, tree, prefix, { recursive, limit }) {
  const out = [];
  let queue = [{ hash: tree, prefix }];
  while (queue.length && out.length < limit) {
    const level = queue;
    queue = [];
    // eslint-disable-next-line no-await-in-loop
    const trees = await Promise.all(level.map((d) => repo.readTree(d.hash)));
    let i = 0;
    for (; i < level.length && out.length < limit; i += 1) {
      const p = level[i].prefix;
      for (const c of (trees[i] || []).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = p ? `${p}/${c.name}` : c.name;
        out.push({ path, type: c.type, hash: c.hash });
        if (recursive && c.type === 'tree') {
          queue.push({ hash: c.hash, prefix: path });
        }
        if (out.length >= limit) {
          break;
        }
      }
    }
    // Directories of this level not taken in yet stay ahead of the next level, as before.
    queue = [...level.slice(i), ...queue];
  }
  return { entries: out, truncated: queue.length > 0 || out.length >= limit };
}

/** Lists a directory (or the whole tree below it). */
export async function listFiles(env, artifact, path, { recursive = false } = {}) {
  return withRepo(env, artifact, async (repo) => {
    const head = await headOf(repo);
    if (!head) {
      return { entries: [], empty: true };
    }
    const at = await entryAt(repo, head.treeHash, path);
    if (!at) {
      return { error: `no such path: ${cleanPath(path) || '/'}` };
    }
    if (at.type !== 'tree') {
      return { entries: [{ path: cleanPath(path), type: at.type, hash: at.hash }] };
    }
    const listed = await walk(repo, at.hash, cleanPath(path), { recursive, limit: MAX_LIST });
    return { commit: head.hash, ...listed };
  });
}

/**
 * How many files of the whole tree `keep(path)` accepts. Unlike `listFiles` this walks every
 * directory, `COUNT_READS` at a time, and keeps no listing, so the count is never cut short.
 */
export async function countFiles(env, artifact, keep = () => true) {
  return withRepo(env, artifact, async (repo) => {
    const head = await headOf(repo);
    if (!head) {
      return { count: 0, empty: true };
    }
    let count = 0;
    const queue = [{ hash: head.treeHash, prefix: '' }];
    while (queue.length) {
      const batch = queue.splice(0, COUNT_READS);
      // eslint-disable-next-line no-await-in-loop
      const trees = await Promise.all(batch.map((d) => repo.readTree(d.hash)));
      for (let i = 0; i < batch.length; i += 1) {
        const { hash, prefix } = batch[i];
        if (!trees[i]) {
          throw new Error(`missing tree ${hash}`);
        }
        for (const c of trees[i]) {
          const path = prefix ? `${prefix}/${c.name}` : c.name;
          if (c.type === 'tree') {
            queue.push({ hash: c.hash, prefix: path });
          } else if (keep(path)) {
            count += 1;
          }
        }
      }
    }
    return { commit: head.hash, count };
  });
}

/**
 * One file as text, with its blob hash (the `base` for a later write). Long files are cut
 * for the model; `full` reads all of it (the editor, which writes it back).
 */
export async function readText(env, artifact, path, { full = false } = {}) {
  return withRepo(env, artifact, async (repo) => {
    const head = await headOf(repo);
    const at = head && await entryAt(repo, head.treeHash, path);
    if (!at || at.type === 'tree') {
      return { error: at ? `${cleanPath(path)} is a directory` : `no such file: ${cleanPath(path)}` };
    }
    const blob = await repo.readBlob(at.hash);
    const text = blob ? await blob.text() : '';
    return {
      path: cleanPath(path),
      hash: at.hash,
      commit: head.hash,
      text: !full && text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n[… truncated at ${MAX_READ / 1024} KB]` : text,
    };
  });
}

/** Lines matching a regular expression (case-insensitive) in the text files below `path`. */
export async function grepFiles(env, artifact, pattern, path = '') {
  let re;
  try {
    re = new RegExp(pattern, 'i');
  } catch (e) {
    return { error: `invalid regular expression: ${e.message}` };
  }
  return withRepo(env, artifact, async (repo) => {
    const head = await headOf(repo);
    if (!head) {
      return { hits: [] };
    }
    const at = await entryAt(repo, head.treeHash, path);
    if (!at) {
      return { error: `no such path: ${cleanPath(path) || '/'}` };
    }
    const listed = at.type === 'tree'
      ? (await walk(repo, at.hash, cleanPath(path), { recursive: true, limit: 5000 })).entries
      : [{ path: cleanPath(path), type: at.type, hash: at.hash }];
    const files = listed.filter((e) => e.type === 'blob' && TEXT.test(e.path));
    const hits = [];
    let scanned = 0;
    for (const f of files) {
      if (scanned >= MAX_GREP_FILES || hits.length >= MAX_GREP_HITS) {
        break;
      }
      scanned += 1;
      // eslint-disable-next-line no-await-in-loop
      const blob = await repo.readBlob(f.hash);
      // eslint-disable-next-line no-await-in-loop
      const lines = blob ? (await blob.text()).split('\n') : [];
      for (let i = 0; i < lines.length && hits.length < MAX_GREP_HITS; i += 1) {
        if (re.test(lines[i])) {
          hits.push(`${f.path}:${i + 1}: ${lines[i].slice(0, 300)}`);
        }
      }
    }
    return { hits, truncated: hits.length >= MAX_GREP_HITS || files.length > scanned };
  });
}

/** The latest commits. */
export async function commitLog(env, artifact, limit = 20) {
  return withRepo(env, artifact, async (repo) => {
    const commits = await repo.log({ limit: Math.min(Math.max(1, limit), 100) });
    return {
      commits: commits.map((c) => ({
        hash: c.hash.slice(0, 12),
        at: new Date(c.committedAt * (c.committedAt < 1e12 ? 1000 : 1)).toISOString(),
        author: c.author && c.author.name,
        message: String(c.message || '').split('\n')[0],
      })),
    };
  });
}

/**
 * Cron: imports listed GitHub repositories that have no mirror, or whose mirror is older
 * than six hours, into a fresh Artifacts repo; promotes an import once it is readable and
 * deletes the mirror it replaces. Reads keep using the old mirror until then.
 */
export async function refreshMirrors(env, now = new Date()) {
  if (!env.ARTIFACTS) {
    return { skipped: 'no ARTIFACTS binding' };
  }
  const { results } = await env.DB.prepare(`SELECT DISTINCT r.url, m.repo, m.pending, m.pending_at,
      m.mirrored_at
    FROM agent_repos r LEFT JOIN repo_mirrors m ON m.url = r.url`).all();
  const done = { imported: 0, promoted: 0, failed: 0 };
  for (const r of results || []) {
    const slug = githubSlug(r.url);
    if (!slug) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      if (r.pending && now - Date.parse(r.pending_at) > PENDING_TTL_MS) {
        // An import that never became readable: give up on it and import again next time.
        // eslint-disable-next-line no-await-in-loop
        await env.DB.prepare('UPDATE repo_mirrors SET pending = NULL, pending_at = NULL WHERE url = ?')
          .bind(r.url).run();
        // eslint-disable-next-line no-await-in-loop
        await env.ARTIFACTS.delete(r.pending).catch(() => {});
        done.failed += 1;
      } else if (r.pending) {
        // Readable once the import has finished.
        // eslint-disable-next-line no-await-in-loop
        await withRepo(env, r.pending, (repo) => repo.info());
        // eslint-disable-next-line no-await-in-loop
        await env.DB.prepare(`UPDATE repo_mirrors SET repo = pending, pending = NULL, pending_at = NULL,
          mirrored_at = ? WHERE url = ?`).bind(now.toISOString(), r.url).run();
        done.promoted += 1;
        if (r.repo) {
          // eslint-disable-next-line no-await-in-loop
          await env.ARTIFACTS.delete(r.repo).catch(() => {});
        }
      } else if (!r.repo || !r.mirrored_at || now - Date.parse(r.mirrored_at) > MIRROR_TTL_MS) {
        const name = mirrorName(slug, now);
        // eslint-disable-next-line no-await-in-loop
        await env.ARTIFACTS.import({
          source: { url: `https://github.com/${slug}`, depth: 1 },
          target: { name, opts: { description: `opspile mirror of ${slug}`, readOnly: true } },
        });
        // eslint-disable-next-line no-await-in-loop
        await env.DB.prepare(`INSERT INTO repo_mirrors (url, repo, pending, pending_at, mirrored_at)
          VALUES (?, NULL, ?, ?, NULL) ON CONFLICT (url) DO UPDATE SET pending = excluded.pending,
            pending_at = excluded.pending_at`)
          .bind(r.url, name, now.toISOString()).run();
        done.imported += 1;
      }
    } catch (e) {
      const code = String(e && (e.code || e.message));
      if (!/IMPORT_IN_PROGRESS|NOT_FOUND|not ready/i.test(code)) {
        done.failed += 1;
        console.warn(JSON.stringify({ route: 'cron', mirror: slug, error: code.slice(0, 200) }));
      }
    }
  }
  return done;
}
