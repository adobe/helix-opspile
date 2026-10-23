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

import { probe, serverWithHeaders } from './agent/mcpclient.js';
import { json } from './http.js';
import { seal } from './post.js';
import { repoName } from './kb.js';
import { isAdmin, managesTeam } from './review.js';

/**
 * The knowledge-base editor's API for the MCP servers of the thread agents (migration 0023),
 * behind `/api/kb/mcp`. Next to the per-channel switch of the agents: a knowledge base's
 * servers are those of its team (`kb-team-*`) or its customer (`kb-org-*`), and the same
 * people manage them who edit it (the admin team; team managers for their teams).
 *
 * - `GET ?repo=`: the servers, with the names of their request headers but never the values;
 * - `POST { repo, name, url, description?, headers?, allow?, enabled? }` adds one,
 *   `PUT { id, … }` changes it (`headers` absent: kept; an object: replaces them all),
 *   `DELETE { id }` removes it;
 * - `POST /check { id }` connects and lists its tools, as an agent would. Adding or changing a
 *   server checks it too.
 *
 * Header values are sealed with TOKEN_KEY and only unsealed to talk to the server.
 */

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
const RESERVED = new Set(['host', 'content-length', 'content-type', 'accept', 'mcp-session-id',
  'mcp-protocol-version', 'connection', 'cookie']);
const MAX_HEADERS = 10;
const MAX_VALUE = 4096;
const MAX_TEXT = 500;
const NO_BASE = 'no such knowledge base';

const clean = (v, n = MAX_TEXT) => String(v ?? '').trim().slice(0, n);
const bad = (error) => json({ error }, 400);
const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

/** A row as the page sees it: no header values. */
function shown(row) {
  return {
    id: row.id,
    repo: repoName(row.scope, row.slug),
    scope: row.scope,
    slug: row.slug,
    name: row.name,
    url: row.url,
    description: row.description,
    headerNames: row.header_names ? row.header_names.split(',') : [],
    allow: row.allow || '',
    enabled: Boolean(row.enabled),
    tools: parse(row.tools, []),
    checkedAt: row.checked_at,
    checkError: row.check_error,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/** Whether `me` may manage the servers of `scope`/`slug`: whoever edits its knowledge base. */
const mayManage = (me, scope, slug) => isAdmin(me) || (scope === 'team' && managesTeam(me, slug));

/** The team or customer of a knowledge base `me` may edit, as `{ scope, slug }`; else null. */
async function ownerOf(env, me, repo) {
  const base = repo && await env.DB.prepare('SELECT kind, slug FROM knowledge_bases WHERE repo = ?')
    .bind(String(repo)).first();
  return base && mayManage(me, base.kind, base.slug) ? { scope: base.kind, slug: base.slug } : null;
}

/** `{ name: value }` from the request: an object, or `[{ name, value }]`. */
function headersFrom(input) {
  const entries = Array.isArray(input)
    ? input.map((h) => [h && h.name, h && h.value])
    : Object.entries(input || {});
  const out = {};
  for (const [rawName, rawValue] of entries) {
    const name = clean(rawName, 64);
    const value = String(rawValue ?? '').trim();
    if (name || value) {
      if (!HEADER.test(name)) {
        return { error: `${name || 'a header'} is not a header name (letters, digits and -)` };
      }
      if (RESERVED.has(name.toLowerCase())) {
        return { error: `the ${name} header is set by the MCP client itself` };
      }
      if (!value || value.length > MAX_VALUE || /[\r\n]/.test(value)) {
        return { error: `give ${name} a value of one line (at most ${MAX_VALUE} characters)` };
      }
      out[name] = value;
    }
  }
  if (Object.keys(out).length > MAX_HEADERS) {
    return { error: `at most ${MAX_HEADERS} headers` };
  }
  return { headers: out };
}

/** The fields of a server from the request, checked. */
async function fieldsFrom(env, body, current) {
  const f = {
    name: body.name !== undefined ? clean(body.name, 32).toLowerCase() : current.name,
    url: body.url !== undefined ? clean(body.url) : current.url,
    description: body.description !== undefined
      ? (clean(body.description) || null) : current.description,
    allow: body.allow !== undefined
      ? clean(body.allow, 4000).split(/[\s,]+/).filter(Boolean).join(', ') || null
      : current.allow,
    enabled: Number(body.enabled !== undefined ? Boolean(body.enabled) : (current.enabled ?? 1)),
  };
  if (!NAME.test(f.name || '')) {
    return { error: 'the name is lowercase letters, digits, - and _, starting with a letter, like docs' };
  }
  let url;
  try {
    url = new URL(f.url);
  } catch {
    return { error: 'give the server\'s https:// URL (its Streamable HTTP endpoint, often …/mcp)' };
  }
  if (url.protocol !== 'https:') {
    return { error: 'the URL must be https://' };
  }
  if (url.username || url.password) {
    return { error: 'put credentials in a header (e.g. Authorization), not in the URL' };
  }
  f.url = url.href;
  if (body.headers !== undefined) {
    const h = headersFrom(body.headers);
    if (h.error) {
      return h;
    }
    const names = Object.keys(h.headers);
    if (names.length && !env.TOKEN_KEY) {
      return { error: 'TOKEN_KEY is not set, so headers cannot be stored' };
    }
    f.headers = names.length ? await seal(env, JSON.stringify(h.headers)) : null;
    f.header_names = names.join(',') || null;
  }
  return { fields: f };
}

async function byId(env, id) {
  return env.DB.prepare('SELECT * FROM mcp_servers WHERE id = ?').bind(Number(id)).first();
}

/** Connects to the server and lists its tools; the result is stored with the row. */
async function check(env, id) {
  const server = await serverWithHeaders(env, id).catch((e) => ({ error: e.message }));
  let res;
  if (!server) {
    res = { error: 'turned off: agents do not use it' };
  } else if (server.error) {
    res = server;
  } else {
    res = await probe(server);
  }
  const tools = (res.tools || []).map((t) => ({
    name: t.name,
    description: String(t.description || t.title || '').split('\n')[0].slice(0, 300),
    readOnly: Boolean(t.annotations && t.annotations.readOnlyHint),
  }));
  await env.DB.prepare(`UPDATE mcp_servers SET tools = ?, checked_at = ?, check_error = ?
    WHERE id = ?`).bind(
    res.error ? null : JSON.stringify(tools),
    new Date().toISOString(),
    res.error ? String(res.error).slice(0, 500) : null,
    Number(id),
  ).run();
  return { server: res.server || null, instructions: res.instructions || null };
}

async function list(env, me, repo) {
  const owner = await ownerOf(env, me, repo);
  if (!owner) {
    return json({ error: NO_BASE }, 404);
  }
  const { results } = await env.DB.prepare(`SELECT * FROM mcp_servers WHERE scope = ? AND slug = ?
    ORDER BY name`).bind(owner.scope, owner.slug).all();
  return json({ repo, servers: (results || []).map(shown) });
}

async function create(env, me, body) {
  const owner = await ownerOf(env, me, body.repo);
  if (!owner) {
    return json({ error: NO_BASE }, 404);
  }
  const { scope, slug } = owner;
  const { fields, error } = await fieldsFrom(env, { headers: {}, ...body }, {});
  if (error) {
    return bad(error);
  }
  if (await env.DB.prepare('SELECT 1 FROM mcp_servers WHERE scope = ? AND slug = ? AND name = ?')
    .bind(scope, slug, fields.name).first()) {
    return json({ error: `there is a server named ${fields.name} here already` }, 409);
  }
  const row = await env.DB.prepare(`INSERT INTO mcp_servers (scope, slug, name, url, description,
      headers, header_names, allow, enabled, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(
    scope,
    slug,
    fields.name,
    fields.url,
    fields.description,
    fields.headers,
    fields.header_names,
    fields.allow,
    fields.enabled,
    me.email || String(me.id),
    new Date().toISOString(),
  ).first();
  const checked = await check(env, row.id);
  console.log(JSON.stringify({
    route: 'kb', mcp: 'added', id: row.id, scope, by: me.id,
  }));
  return json({ ok: true, ...checked, server: shown(await byId(env, row.id)) });
}

async function update(env, me, body) {
  const current = await byId(env, body.id);
  if (!current) {
    return json({ error: 'no such server' }, 404);
  }
  if (!mayManage(me, current.scope, current.slug)) {
    return json({ error: 'no such server' }, 404);
  }
  const { fields, error } = await fieldsFrom(env, body, current);
  if (error) {
    return bad(error);
  }
  if (fields.name !== current.name && await env.DB.prepare(`SELECT 1 FROM mcp_servers
    WHERE scope = ? AND slug = ? AND name = ?`).bind(current.scope, current.slug, fields.name).first()) {
    return json({ error: `there is a server named ${fields.name} here already` }, 409);
  }
  const headers = 'headers' in fields;
  await env.DB.prepare(`UPDATE mcp_servers SET name = ?, url = ?, description = ?, allow = ?,
      enabled = ?, headers = CASE WHEN ? THEN ? ELSE headers END,
      header_names = CASE WHEN ? THEN ? ELSE header_names END, updated_by = ?, updated_at = ?
    WHERE id = ?`).bind(
    fields.name,
    fields.url,
    fields.description,
    fields.allow,
    fields.enabled,
    headers ? 1 : 0,
    fields.headers ?? null,
    headers ? 1 : 0,
    fields.header_names ?? null,
    me.email || String(me.id),
    new Date().toISOString(),
    current.id,
  ).run();
  // Turning a server on or off, or a new URL or credentials, is worth checking again.
  const again = fields.enabled && (headers || fields.url !== current.url || !current.enabled);
  const checked = again ? await check(env, current.id) : {};
  return json({ ok: true, ...checked, server: shown(await byId(env, current.id)) });
}

async function remove(env, me, body) {
  const current = await byId(env, body.id);
  if (!current) {
    return json({ error: 'no such server' }, 404);
  }
  if (!mayManage(me, current.scope, current.slug)) {
    return json({ error: 'no such server' }, 404);
  }
  await env.DB.prepare('DELETE FROM mcp_servers WHERE id = ?').bind(current.id).run();
  return json({ ok: true, deleted: current.id });
}

async function recheck(env, me, body) {
  const current = await byId(env, body.id);
  if (!current) {
    return json({ error: 'no such server' }, 404);
  }
  if (!mayManage(me, current.scope, current.slug)) {
    return json({ error: 'no such server' }, 404);
  }
  const checked = await check(env, current.id);
  return json({ ok: true, ...checked, server: shown(await byId(env, current.id)) });
}

/** Routes `/api/kb/mcp*`; null for other paths. */
export async function mcpAdmin(request, env, url, me) {
  if (url.pathname !== '/api/kb/mcp' && !url.pathname.startsWith('/api/kb/mcp/')) {
    return null;
  }
  const body = request.method === 'GET' ? {} : await request.json().catch(() => ({}));
  switch (`${request.method} ${url.pathname}`) {
    case 'GET /api/kb/mcp': return list(env, me, url.searchParams.get('repo'));
    case 'POST /api/kb/mcp': return create(env, me, body);
    case 'PUT /api/kb/mcp': return update(env, me, body);
    case 'DELETE /api/kb/mcp': return remove(env, me, body);
    case 'POST /api/kb/mcp/check': return recheck(env, me, body);
    default: return json({ error: 'not found' }, 404);
  }
}
