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

import {
  MAX_SECRETS, nameProblem, parseHosts, valueProblem,
} from './agent/secrets.js';
import { json } from './http.js';
import { repoName } from './kb.js';
import { mayEdit } from './kbaccess.js';
import { ownerOf } from './mcpadmin.js';
import { seal } from './post.js';

/**
 * The knowledge-base editor's API for the secrets of the agents' computers (migration 0060,
 * src/agent/secrets.js), behind `/api/kb/tools/secrets`, in the Computer tool: a knowledge
 * base's secrets are those of its team (`kb-team-*`) or its customer (`kb-org-*`), managed by
 * the same people who edit it (the admin team; team managers for their teams).
 *
 * - `GET /api/kb/tools?repo=` lists them with the Computer tool (`secrets`), by name, with
 *   their hosts, never their values (src/tooladmin.js);
 * - `POST { repo, name, value, hosts, description? }` adds one;
 * - `PUT { id, name?, value?, hosts?, description? }` changes it (`value` absent: kept);
 * - `DELETE { id }` removes it.
 *
 * Values are sealed with TOKEN_KEY. Agents notice at their next command.
 */

const MAX_TEXT = 300;
const NO_BASE = 'no such knowledge base';
const NO_SECRET = 'no such secret';

const clean = (v, n = MAX_TEXT) => String(v ?? '').trim().slice(0, n);
const bad = (error) => json({ error }, 400);

/** A row as the page sees it: no value. */
export const shownSecret = (r) => ({
  id: r.id,
  repo: repoName(r.scope, r.slug),
  scope: r.scope,
  name: r.name,
  hosts: String(r.hosts || '').split(',').filter(Boolean),
  description: r.description || '',
  updatedBy: r.updated_by || null,
  updatedAt: r.updated_at,
});

/** The secrets of a team or a customer (`owner`, as ownerOf gives it), by name, as shown. */
export async function secretsOf(env, owner) {
  const { results } = await env.DB.prepare(`SELECT id, scope, slug, name, hosts, description,
      updated_by, updated_at FROM agent_secrets WHERE scope = ? AND slug = ? ORDER BY name`)
    .bind(owner.scope, owner.slug).all();
  return (results || []).map(shownSecret);
}

const byId = (env, id) => env.DB.prepare('SELECT * FROM agent_secrets WHERE id = ?')
  .bind(Number(id) || 0).first();

/** The fields of the request, checked, over `current`: `{ fields }` or `{ error }`. */
async function fieldsFrom(env, body, current) {
  const name = 'name' in body ? clean(body.name, 64) : current.name;
  const problem = nameProblem(name || '');
  if (problem) {
    return { error: problem };
  }
  const hosts = parseHosts('hosts' in body ? body.hosts : current.hosts);
  if (hosts.error) {
    return { error: hosts.error };
  }
  const fields = {
    name,
    hosts: hosts.hosts.join(','),
    description: 'description' in body ? clean(body.description) : (current.description || ''),
  };
  const given = body.value === undefined || body.value === null ? '' : String(body.value).trim();
  if (given || !current.value) {
    const wrong = valueProblem(given);
    if (wrong) {
      return { error: wrong };
    }
    if (!env.TOKEN_KEY) {
      return { error: 'TOKEN_KEY is not set in this deployment: secrets cannot be kept' };
    }
    fields.value = await seal(env, given);
  }
  return { fields };
}

const taken = (env, scope, slug, name) => env.DB.prepare(`SELECT 1 FROM agent_secrets
  WHERE scope = ? AND slug = ? AND name = ?`).bind(scope, slug, name).first();

async function create(env, me, body) {
  const owner = await ownerOf(env, me, body.repo);
  if (!owner) {
    return json({ error: NO_BASE }, 404);
  }
  const { fields, error } = await fieldsFrom(env, body, {});
  if (error) {
    return bad(error);
  }
  if (await taken(env, owner.scope, owner.slug, fields.name)) {
    return json({ error: `there is a secret named ${fields.name} here already` }, 409);
  }
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_secrets
    WHERE scope = ? AND slug = ?`).bind(owner.scope, owner.slug).first();
  if (count && count.n >= MAX_SECRETS) {
    return bad(`at most ${MAX_SECRETS} secrets here`);
  }
  const row = await env.DB.prepare(`INSERT INTO agent_secrets (scope, slug, name, value, hosts,
      description, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).bind(
    owner.scope,
    owner.slug,
    fields.name,
    fields.value,
    fields.hosts,
    fields.description,
    me.email || String(me.id),
    new Date().toISOString(),
  ).first();
  console.log(JSON.stringify({
    route: 'kb', secret: 'added', id: row.id, scope: owner.scope, by: me.id,
  }));
  return json({ ok: true, secret: shownSecret(row), secrets: await secretsOf(env, owner) });
}

/** A secret `me` manages, by id, with its owner; else an error response. */
async function mine(env, me, id) {
  const current = await byId(env, id);
  if (!current || !await mayEdit(env, me, { kind: current.scope, slug: current.slug })) {
    return { error: json({ error: NO_SECRET }, 404) };
  }
  return { current, owner: { scope: current.scope, slug: current.slug } };
}

async function update(env, me, body) {
  const { current, owner, error: missing } = await mine(env, me, body.id);
  if (missing) {
    return missing;
  }
  const { fields, error } = await fieldsFrom(env, body, current);
  if (error) {
    return bad(error);
  }
  if (fields.name !== current.name && await taken(env, owner.scope, owner.slug, fields.name)) {
    return json({ error: `there is a secret named ${fields.name} here already` }, 409);
  }
  const row = await env.DB.prepare(`UPDATE agent_secrets SET name = ?, hosts = ?, description = ?,
      value = COALESCE(?, value), updated_by = ?, updated_at = ? WHERE id = ? RETURNING *`).bind(
    fields.name,
    fields.hosts,
    fields.description,
    fields.value ?? null,
    me.email || String(me.id),
    new Date().toISOString(),
    current.id,
  ).first();
  console.log(JSON.stringify({
    route: 'kb', secret: 'changed', id: current.id, value: Boolean(fields.value), by: me.id,
  }));
  return json({ ok: true, secret: shownSecret(row), secrets: await secretsOf(env, owner) });
}

async function remove(env, me, body) {
  const { current, owner, error } = await mine(env, me, body.id);
  if (error) {
    return error;
  }
  await env.DB.prepare('DELETE FROM agent_secrets WHERE id = ?').bind(current.id).run();
  console.log(JSON.stringify({
    route: 'kb', secret: 'deleted', id: current.id, by: me.id,
  }));
  return json({ ok: true, deleted: current.id, secrets: await secretsOf(env, owner) });
}

/** Routes `/api/kb/tools/secrets`; null for other paths. */
export async function secretAdmin(request, env, url, me) {
  if (url.pathname !== '/api/kb/tools/secrets') {
    return null;
  }
  const body = await request.json().catch(() => ({}));
  switch (request.method) {
    case 'POST': return create(env, me, body);
    case 'PUT': return update(env, me, body);
    case 'DELETE': return remove(env, me, body);
    default: return json({ error: 'not found' }, 404);
  }
}
