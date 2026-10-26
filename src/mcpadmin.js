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
  GLOBAL_SERVERS, globalConnection, instancesOf, isGlobalServer, storedTools, storeTools,
  usableTools,
} from './agent/globals.js';
import { probe, serverWithHeaders } from './agent/mcpclient.js';
import {
  appManifest, approveInstallation, createApp, currentApp, forgetGithub, installationsWithApprovals,
  manifestAction, shownApp,
} from './github.js';
import { json, text } from './http.js';
import { checkState, makeState, seal } from './post.js';
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
 *
 * The global servers (src/agent/globals.js) come with the list, as `globals`: whether each is
 * available, what its last check found, and its switches for this knowledge base's team and
 * channels. `PUT /global { server, team | channel, enabled }` switches one (`enabled: null`
 * hands a channel back to its team's switch), for the admin team and the team's managers;
 * `POST /global/check { server }` connects and lists its tools again.
 *
 * The GitHub App of the github server, for the admin team: `POST /api/kb/github/manifest
 * { org?, name? }` is what the page posts to GitHub to create it, and GitHub sends the admin
 * back to `GET /api/kb/github/created`, which keeps the app and goes on to its installation.
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
export async function ownerOf(env, me, repo) {
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

// ---- global servers ----------------------------------------------------------------------

const shownSwitch = (r) => r && { enabled: Boolean(r.enabled), by: r.changed_by, at: r.changed_at };

const shownTools = (tools) => (tools || []).map((t) => ({
  name: t.name,
  description: String(t.description || t.title || '').split('\n')[0].slice(0, 300),
  readOnly: Boolean(t.annotations && t.annotations.readOnlyHint),
}));

/**
 * The global servers as the editor shows them for a knowledge base's team or customer: each
 * with its instances and their last check, the team's switch (a team's knowledge base only),
 * and the switches of the channels the knowledge base learns from. The admin team also gets
 * the GitHub App and where it is installed.
 */
async function globalsView(env, me, owner, only) {
  const column = owner.scope === 'team' ? 'team' : 'org';
  const { results } = await env.DB.prepare(`SELECT * FROM mcp_global_switches
    WHERE (scope = 'team' AND target = ?) OR (scope = 'channel' AND target IN
      (SELECT DISTINCT channel_id FROM threads WHERE ${column} = ?))`)
    .bind(owner.scope === 'team' ? owner.slug : '', owner.slug).all();
  const rows = results || [];
  const admin = isAdmin(me);
  return Promise.all(GLOBAL_SERVERS.filter((g) => !only || g.server === only).map(async (g) => {
    const { instances, problem } = await instancesOf(env, g.server);
    const checks = await Promise.all(instances
      .map((i) => storedTools(env, i.key).catch(() => null)));
    const view = {
      server: g.server,
      title: g.title,
      description: g.description,
      available: instances.length > 0,
      problem,
      instances: instances.map((i, n) => ({
        key: i.key,
        name: i.name,
        account: i.account || null,
        tools: shownTools(usableTools(g.server, checks[n] && checks[n].tools)),
        checkedAt: (checks[n] && checks[n].checkedAt) || null,
        checkError: (checks[n] && checks[n].error) || null,
      })),
      team: owner.scope === 'team'
        ? shownSwitch(rows.find((r) => r.server === g.server && r.scope === 'team'))
          || { enabled: false }
        : null,
      channels: Object.fromEntries(rows.filter((r) => r.server === g.server && r.scope === 'channel')
        .map((r) => [r.target, shownSwitch(r)])),
    };
    if (g.server === 'github' && admin) {
      const app = await currentApp(env).catch(() => null);
      view.github = {
        app: shownApp(app),
        installations: app ? await installationsWithApprovals(env, app).catch(() => []) : [],
        configured: Boolean(env.TOKEN_KEY && env.PUBLIC_ORIGIN),
      };
    }
    return view;
  }));
}

/** The team a channel is filed under (its latest thread's), and its kind; null if unknown. */
export async function channelOwner(env, channel) {
  return env.DB.prepare(`SELECT team, kind FROM threads WHERE channel_id = ?
    ORDER BY COALESCE(last_at, any_at) DESC LIMIT 1`).bind(channel).first();
}

/**
 * PUT /api/kb/mcp/global `{ server, team | channel, enabled }`: turns a global server on or off
 * for a team, or for a channel (`enabled: null` lets the channel follow its team again). For
 * the admin team and the managers of the team (of the team that owns the channel).
 */
async function switchGlobal(env, me, body) {
  const server = String(body.server || '');
  if (!isGlobalServer(server)) {
    return bad('no such global server');
  }
  const { enabled } = body;
  if (enabled !== null && typeof enabled !== 'boolean') {
    return bad('give enabled: true or false (or null, for a channel to follow its team)');
  }
  let scope;
  let target;
  let team;
  if (body.team) {
    scope = 'team';
    target = String(body.team);
    team = target;
    if (enabled === null) {
      return bad('a team\'s switch is on or off');
    }
    const known = await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(target).first();
    if (!known || !managesTeam(me, target)) {
      return json({ error: 'no such team' }, 404);
    }
  } else if (body.channel) {
    scope = 'channel';
    target = String(body.channel);
    const owner = await channelOwner(env, target);
    if (!owner || owner.kind === 'ignore' || !managesTeam(me, owner.team)) {
      return json({ error: 'no such channel' }, 404);
    }
    team = owner.team;
  } else {
    return bad('give a team or a channel');
  }
  const by = me.name || me.email || String(me.id);
  const at = new Date().toISOString();
  if (enabled === null) {
    await env.DB.prepare(`DELETE FROM mcp_global_switches WHERE server = ? AND scope = ?
      AND target = ?`).bind(server, scope, target).run();
  } else {
    await env.DB.prepare(`INSERT INTO mcp_global_switches (server, scope, target, enabled,
        changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (server, scope, target) DO UPDATE SET enabled = excluded.enabled,
        changed_by = excluded.changed_by, changed_at = excluded.changed_at`)
      .bind(server, scope, target, enabled ? 1 : 0, by, at).run();
  }
  console.log(JSON.stringify({
    route: 'kb', mcp: 'global', server, scope, team, enabled, by: me.id,
  }));
  return json({
    ok: true,
    server,
    [scope]: target,
    switch: enabled === null ? null : { enabled, by, at },
  });
}

/** Connects to each instance of a global server and keeps its tools: what each check found. */
async function checkInstances(env, instances) {
  return Promise.all(instances.map(async (i) => {
    const conn = await globalConnection(env, `global:${i.key}`)
      .catch((e) => ({ error: e.message }));
    let res;
    if (!conn) {
      res = { error: 'not available' };
    } else if (conn.error) {
      res = conn;
    } else {
      res = await probe(conn);
    }
    await storeTools(env, i.key, res);
    return {
      name: i.name,
      tools: (res.tools || []).length,
      error: res.error || null,
      server: res.server || null,
    };
  }));
}

/** POST /api/kb/mcp/global/check `{ server, repo? }`: connects to each instance, lists tools. */
async function checkGlobal(env, me, body) {
  const server = String(body.server || '');
  if (!isGlobalServer(server)) {
    return bad('no such global server');
  }
  const { instances, problem } = await instancesOf(env, server);
  if (!instances.length) {
    return json({ error: problem }, 409);
  }
  const checked = await checkInstances(env, instances);
  const owner = body.repo ? await ownerOf(env, me, body.repo) : null;
  console.log(JSON.stringify({
    route: 'kb',
    mcp: 'global check',
    server,
    instances: checked.length,
    errors: checked.filter((c) => c.error).length,
  }));
  return json({
    ok: true,
    checked,
    ...(owner ? { global: (await globalsView(env, me, owner, server))[0] } : {}),
  });
}

/**
 * Cron: checks the global servers whose last check is older than `maxAgeMs` (or that were
 * never checked), so that the tools agents get follow the servers' (GitHub's change).
 */
export async function refreshGlobalTools(env, { now = Date.now(), maxAgeMs = 24 * 3600_000 } = {}) {
  const out = {};
  for (const g of GLOBAL_SERVERS) {
    // eslint-disable-next-line no-await-in-loop
    const { instances } = await instancesOf(env, g.server);
    // eslint-disable-next-line no-await-in-loop
    const stale = (await Promise.all(instances.map(async (i) => {
      const stored = await storedTools(env, i.key).catch(() => null);
      return !stored || stored.error || now - Date.parse(stored.checkedAt) > maxAgeMs ? i : null;
    }))).filter(Boolean);
    if (stale.length) {
      // eslint-disable-next-line no-await-in-loop
      const checked = await checkInstances(env, stale);
      out[g.server] = checked.map((c) => (c.error ? `${c.name}: ${c.error}` : `${c.name}: ${c.tools} tools`));
    }
  }
  return out;
}

// ---- the GitHub App ----------------------------------------------------------------------

/** POST /api/kb/github/manifest `{ org?, name? }`: where to post which manifest (admin team). */
async function githubManifest(env, me, body) {
  if (!isAdmin(me)) {
    return json({ error: 'the admin team creates the GitHub App' }, 403);
  }
  if (!env.TOKEN_KEY || !env.PUBLIC_ORIGIN) {
    return json({ error: 'TOKEN_KEY and PUBLIC_ORIGIN must be set first' }, 503);
  }
  const action = manifestAction(body.org, await makeState(env, me.id, 'github-app'));
  if (!action) {
    return bad('that is not a GitHub account name');
  }
  return json({ action, manifest: JSON.stringify(appManifest(env, { name: body.name })) });
}

/**
 * PUT /api/kb/github/installation `{ id, approved }`: allows an installation of the app, so
 * that agents read its repositories, or no longer allows it. For the admin team.
 */
async function githubInstallation(env, me, body) {
  if (!isAdmin(me)) {
    return json({ error: 'the admin team allows installations' }, 403);
  }
  if (typeof body.approved !== 'boolean' || !Number(body.id)) {
    return bad('give an installation id and approved: true or false');
  }
  const app = await currentApp(env);
  if (!app) {
    return json({ error: 'there is no GitHub App yet' }, 409);
  }
  forgetGithub();
  const by = me.email || String(me.id);
  const done = await approveInstallation(env, app, body.id, body.approved, by);
  if (!done) {
    return json({ error: 'the app has no such installation' }, 404);
  }
  console.log(JSON.stringify({
    route: 'kb',
    github: body.approved ? 'installation allowed' : 'installation revoked',
    installation: done.id,
    by: me.id,
  }));
  return json({ ok: true, installations: await installationsWithApprovals(env, app) });
}

/** GET /api/kb/github/created?code&state: GitHub created the app; keep it, then install it. */
async function githubCreated(env, me, url) {
  if (!isAdmin(me)) {
    return text('Only the admin team creates the GitHub App.\n', 403);
  }
  if (!await checkState(env, url.searchParams.get('state'), me.id, 'github-app')) {
    return text('This link expired or was not started here. Start again from the'
      + ' knowledge-base editor.\n', 400);
  }
  try {
    const app = await createApp(env, url.searchParams.get('code'), me.email || String(me.id));
    forgetGithub();
    console.log(JSON.stringify({
      route: 'kb', github: 'app created', app: app.id, by: me.id,
    }));
    return new Response(null, {
      status: 302,
      headers: { location: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new` },
    });
  } catch (e) {
    return text(`GitHub did not create the app: ${e.message}\n`, 502);
  }
}

async function list(env, me, repo) {
  const owner = await ownerOf(env, me, repo);
  if (!owner) {
    return json({ error: NO_BASE }, 404);
  }
  const { results } = await env.DB.prepare(`SELECT * FROM mcp_servers WHERE scope = ? AND slug = ?
    ORDER BY name`).bind(owner.scope, owner.slug).all();
  return json({
    repo,
    servers: (results || []).map(shown),
    globals: await globalsView(env, me, owner),
  });
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

/** Routes `/api/kb/mcp*` and `/api/kb/github/*`; null for other paths. */
export async function mcpAdmin(request, env, url, me) {
  if (url.pathname !== '/api/kb/mcp' && !url.pathname.startsWith('/api/kb/mcp/')
    && !url.pathname.startsWith('/api/kb/github/')) {
    return null;
  }
  const body = request.method === 'GET' ? {} : await request.json().catch(() => ({}));
  switch (`${request.method} ${url.pathname}`) {
    case 'PUT /api/kb/mcp/global': return switchGlobal(env, me, body);
    case 'POST /api/kb/mcp/global/check': return checkGlobal(env, me, body);
    case 'POST /api/kb/github/manifest': return githubManifest(env, me, body);
    case 'GET /api/kb/github/created': return githubCreated(env, me, url);
    case 'PUT /api/kb/github/installation': return githubInstallation(env, me, body);
    case 'GET /api/kb/mcp': return list(env, me, url.searchParams.get('repo'));
    case 'POST /api/kb/mcp': return create(env, me, body);
    case 'PUT /api/kb/mcp': return update(env, me, body);
    case 'DELETE /api/kb/mcp': return remove(env, me, body);
    case 'POST /api/kb/mcp/check': return recheck(env, me, body);
    default: return json({ error: 'not found' }, 404);
  }
}
