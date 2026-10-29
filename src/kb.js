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
 * Pile 3: one Artifacts repository per org (`kb-org-<slug>`) and per team
 * (`kb-team-<slug>`). This module only makes sure they exist; filling them is separate.
 * `knowledge_bases` in D1 records the repos that exist, so Artifacts is asked only once.
 */

export const BRANCH = 'main';

/** Repo name for an org or team slug, or null for internal slugs (`_unassigned`). */
export function repoName(kind, slug) {
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return null;
  }
  return `kb-${kind}-${slug}`.slice(0, 63);
}

const codeOf = (e) => String(e && (e.code || e.message));

/** The remote of a repo that already exists. */
async function remoteOf(artifacts, name) {
  const repo = await artifacts.get(name);
  try {
    const info = await repo.info();
    return (info && info.remote) || null;
  } finally {
    if (repo[Symbol.dispose]) {
      repo[Symbol.dispose]();
    }
  }
}

/**
 * Creates the knowledge base for one org or team unless it exists.
 *
 * @param {object} env `ARTIFACTS`, `DB`
 * @param {'org'|'team'} kind
 * @param {string} slug
 * @returns {Promise<{ repo: string, result: 'created'|'exists' }|null>} null when the slug
 *   has no knowledge base or Artifacts is not bound
 */
export async function ensureKnowledgeBase(env, kind, slug, now = new Date()) {
  const repo = repoName(kind, slug);
  if (!repo || !env.ARTIFACTS) {
    return null;
  }
  const known = await env.DB.prepare('SELECT repo FROM knowledge_bases WHERE repo = ?')
    .bind(repo).first();
  if (known) {
    return { repo, result: 'exists' };
  }
  let remote;
  let result = 'created';
  try {
    const created = await env.ARTIFACTS.create(repo, {
      description: `opspile knowledge base: ${kind} ${slug}`,
      setDefaultBranch: BRANCH,
    });
    remote = created.remote;
  } catch (e) {
    // Created by another job, or before this table existed.
    if (!/ALREADY_EXISTS|already exists|10201/i.test(codeOf(e))) {
      throw e;
    }
    result = 'exists';
    remote = await remoteOf(env.ARTIFACTS, repo);
  }
  // A repo just created has no entries; one that existed is counted by the cron.
  await env.DB.prepare(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at, entries)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (repo) DO NOTHING`)
    .bind(repo, kind, slug, remote || null, now.toISOString(), result === 'created' ? 0 : null).run();
  return { repo, result };
}

/**
 * Makes sure a channel's org and team have their knowledge bases. Called for every
 * normalized message; `cache.kb` (one queue batch) holds the repos known to exist, so
 * Artifacts and D1 are asked once per repo and batch. A failure is logged and retried with
 * the channel's next message; it never fails the message itself.
 */
export async function ensureChannelKnowledgeBases(env, { org, team }, cache = {}) {
  if (!env.ARTIFACTS) {
    return [];
  }
  if (!cache.kb) {
    const { results } = await env.DB.prepare('SELECT repo FROM knowledge_bases').all();
    // eslint-disable-next-line no-param-reassign
    cache.kb = new Set(results.map((r) => r.repo));
  }
  const out = [];
  for (const [kind, slug] of [['org', org], ['team', team]]) {
    const repo = repoName(kind, slug);
    if (repo && !cache.kb.has(repo)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await ensureKnowledgeBase(env, kind, slug);
        cache.kb.add(repo);
        out.push(r);
      } catch (e) {
        console.error(JSON.stringify({ route: 'kb', repo, error: e.message }));
      }
    }
  }
  return out;
}

/** Cron: a knowledge base for every team in D1, including teams added by hand. */
export async function ensureTeamKnowledgeBases(env) {
  if (!env.ARTIFACTS) {
    return { created: 0 };
  }
  const { results } = await env.DB.prepare(`SELECT slug FROM teams
    WHERE 'kb-team-' || slug NOT IN (SELECT repo FROM knowledge_bases)`).all();
  let created = 0;
  for (const { slug } of results) {
    // eslint-disable-next-line no-await-in-loop
    const r = await ensureKnowledgeBase(env, 'team', slug);
    created += r && r.result === 'created' ? 1 : 0;
  }
  return { created };
}
