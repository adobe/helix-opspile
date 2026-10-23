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

import { writeKnowledge } from './agent/kbwrite.js';
import { SYSTEM_PROMPT } from './agent/okf.js';
import { commitLog, listFiles, readText } from './agent/repos.js';
import { json } from './http.js';

/**
 * The knowledge-base editor's API, for the admin team only (`/inbox/kb`): list the knowledge
 * bases, list and read their files, and change them as the signed-in person. Writes go
 * through the same path as the agents' (OKF checks, indexes and log by code, retry on a
 * concurrent push), are committed with the person as author and stamped `human:<email>`, and
 * may also change `systemprompt.md`, which agents cannot.
 */

const MAX_MESSAGE = 200;

async function knownRepo(env, repo) {
  if (!repo) {
    return null;
  }
  return env.DB.prepare('SELECT repo, kind, slug FROM knowledge_bases WHERE repo = ?')
    .bind(String(repo)).first();
}

/** GET /api/kb: every knowledge base, teams first, with the team's or customer's name. */
async function listBases(env) {
  const { results } = await env.DB.prepare(`SELECT k.repo, k.kind, k.slug, k.created_at,
      t.name AS team_name
    FROM knowledge_bases k LEFT JOIN teams t ON k.kind = 'team' AND t.slug = k.slug
    ORDER BY CASE k.kind WHEN 'team' THEN 0 ELSE 1 END, k.slug`).all();
  return json({
    systemPrompt: SYSTEM_PROMPT,
    bases: (results || []).map((r) => ({
      repo: r.repo,
      kind: r.kind,
      slug: r.slug,
      name: r.team_name || r.slug,
      created_at: r.created_at,
    })),
  });
}

/** GET /api/kb/files?repo=: every file, and whether `systemprompt.md` exists. */
async function files(env, repo) {
  const res = await listFiles(env, repo, '', { recursive: true });
  if (res.error) {
    return json({ error: res.error }, 404);
  }
  const list = (res.entries || []).filter((e) => e.type !== 'tree')
    .map((e) => ({ path: e.path, hash: e.hash }));
  return json({
    repo,
    commit: res.commit || null,
    truncated: Boolean(res.truncated),
    files: list,
    hasSystemPrompt: list.some((f) => f.path === SYSTEM_PROMPT),
  });
}

/** PUT or DELETE /api/kb/file `{ repo, path, content?, base?, message? }`. */
async function change(env, me, body, remove) {
  const path = String(body.path || '').replace(/^\/+/, '');
  const message = String(body.message || '').split('\n')[0].trim().slice(0, MAX_MESSAGE)
    || `${remove ? 'Delete' : 'Update'} ${path}`;
  const base = typeof body.base === 'string' && body.base ? body.base : null;
  if (!remove && typeof body.content !== 'string') {
    return json({ error: 'content is required' }, 400);
  }
  // A new file (no `base`) must not exist yet, so nobody's file is overwritten unseen.
  const changes = [remove ? { path, delete: true, base }
    : {
      path, content: body.content, base, create: !base,
    }];
  const res = await writeKnowledge(env, body.repo, changes, {
    message: `${message}\n\nOpspile-Editor: ${me.name || me.email}`,
    by: `human:${me.email}`,
    author: { name: me.name || me.email, email: me.email },
    logEntry: `**${remove ? 'Deletion' : 'Update'}**: ${message} (${me.name || me.email})`,
    staff: true,
  });
  if (res.error) {
    return json({ error: res.error }, 400);
  }
  if (res.conflict) {
    const current = await readText(env, body.repo, path, { full: true })
      .catch(() => ({ error: 'unreadable' }));
    return json({ error: res.conflict, current: current.error ? null : current }, 409);
  }
  if (res.unchanged) {
    return json({ ok: true, unchanged: true });
  }
  const now = remove ? null : await readText(env, body.repo, path).catch(() => null);
  return json({ ok: true, commit: res.commit, hash: now && !now.error ? now.hash : null });
}

/** Routes `/api/kb*` for a member of the admin team. Returns null for other paths. */
export async function kbAdmin(request, env, url, me) {
  if (url.pathname === '/api/kb' && request.method === 'GET') {
    return listBases(env);
  }
  if (!url.pathname.startsWith('/api/kb/')) {
    return null;
  }
  if (!env.ARTIFACTS) {
    return json({ error: 'knowledge bases are not configured' }, 503);
  }
  const body = request.method === 'GET' ? {} : await request.json().catch(() => ({}));
  const repo = request.method === 'GET' ? url.searchParams.get('repo') : body.repo;
  if (!await knownRepo(env, repo)) {
    return json({ error: 'no such knowledge base' }, 404);
  }
  if (url.pathname === '/api/kb/files' && request.method === 'GET') {
    return files(env, repo);
  }
  if (url.pathname === '/api/kb/log' && request.method === 'GET') {
    return json({ repo, ...await commitLog(env, repo, 30) });
  }
  if (url.pathname === '/api/kb/file') {
    if (request.method === 'GET') {
      const res = await readText(env, repo, url.searchParams.get('path'), { full: true });
      return res.error ? json({ error: res.error }, 404) : json(res);
    }
    if (request.method === 'PUT' || request.method === 'DELETE') {
      return change(env, me, { ...body, repo }, request.method === 'DELETE');
    }
  }
  return json({ error: 'not found' }, 404);
}
