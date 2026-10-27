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

import { agentChannels, agentStates, setAgent } from './agent/enabled.js';
import { writeKnowledge } from './agent/kbwrite.js';
import { SYSTEM_PROMPT } from './agent/okf.js';
import { commitLog, listFiles, readText } from './agent/repos.js';
import { json } from './http.js';
import { mcpAdmin } from './mcpadmin.js';
import { isAdmin, managesTeam } from './review.js';
import { toolAdmin } from './tooladmin.js';

/**
 * May `me` edit this knowledge base? The admin team edits all of them; a team manager the
 * knowledge base of the teams they manage.
 */
const mayEdit = (me, base) => isAdmin(me) || (base.kind === 'team' && managesTeam(me, base.slug));

/**
 * The knowledge-base editor's API, for the admin team and team managers (`/inbox/kb`): list
 * the knowledge bases, list and read their files, and change them as the signed-in person
 * (team managers: their teams' knowledge bases only). Writes go
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

/**
 * How many channels with an agent on each knowledge base learns from, by `<kind>:<slug>`.
 * The channels with an agent are few, so this reads their threads by channel.
 */
async function agentCounts(env) {
  const { results: set } = await env.DB.prepare('SELECT channel_id, enabled FROM agent_channels').all();
  const on = new Set(agentChannels(env));
  for (const r of set || []) {
    on[r.enabled === 1 ? 'add' : 'delete'](r.channel_id);
  }
  const ids = [...on];
  const pairs = new Set();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    // eslint-disable-next-line no-await-in-loop
    const { results } = await env.DB.prepare(`SELECT DISTINCT channel_id, team, org FROM threads
      WHERE channel_id IN (${part.map(() => '?').join(', ')}) AND kind = 'channel'`).bind(...part).all();
    for (const r of results || []) {
      pairs.add(`team:${r.team}\n${r.channel_id}`).add(`org:${r.org}\n${r.channel_id}`);
    }
  }
  const counts = new Map();
  for (const pair of pairs) {
    const key = pair.split('\n')[0];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/** GET /api/kb: every knowledge base, teams first, with the team's or customer's name. */
async function listBases(env, me) {
  const counts = await agentCounts(env);
  const { results } = await env.DB.prepare(`SELECT k.repo, k.kind, k.slug, k.created_at,
      t.name AS team_name
    FROM knowledge_bases k LEFT JOIN teams t ON k.kind = 'team' AND t.slug = k.slug
    ORDER BY CASE k.kind WHEN 'team' THEN 0 ELSE 1 END, k.slug`).all();
  return json({
    systemPrompt: SYSTEM_PROMPT,
    bases: (results || []).filter((r) => mayEdit(me, r)).map((r) => ({
      repo: r.repo,
      kind: r.kind,
      slug: r.slug,
      name: r.team_name || r.slug,
      created_at: r.created_at,
      agents: counts.get(`${r.kind}:${r.slug}`) || 0,
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

// ---- thread agents ----------------------------------------------------------------------

/** Whether this deployment runs agents at all; a channel's switch counts only then. */
const agentsConfigured = (env) => Boolean(env.AGENTS && env.AGENT_MODEL);

/**
 * GET /api/kb/channels?repo=: the channels whose threads this knowledge base learns from (a
 * team's: the team's channels; a customer's: theirs, in every team), newest first, each with
 * its agent's state and whether `me` may switch it (the admin team, and managers of the team
 * that owns the channel). Ignored channels are left out; alert channels have no agents.
 */
async function channels(env, me, base) {
  const column = base.kind === 'team' ? 'team' : 'org';
  const { results } = await env.DB.prepare(`SELECT t.source, t.channel_id, t.team, t.org, t.kind,
      MAX(t.channel_name) AS channel_name, c.name, c.group_name, COUNT(*) AS threads,
      MAX(COALESCE(t.last_at, t.any_at)) AS latest, tm.name AS team_name
    FROM threads t
      LEFT JOIN channels c ON c.source = t.source AND c.tenant = t.tenant
        AND c.channel_id = t.channel_id
      LEFT JOIN teams tm ON tm.slug = t.team
    WHERE t.${column} = ? AND t.kind != 'ignore'
    GROUP BY t.source, t.tenant, t.channel_id, t.team, t.org, t.kind
    ORDER BY latest DESC`).bind(base.slug).all();
  // A channel being re-filed has threads in two places for a while: its latest place counts.
  const seen = new Set();
  const rows = (results || []).filter((r) => !seen.has(r.channel_id) && seen.add(r.channel_id));
  const states = await agentStates(env, rows.map((r) => r.channel_id));
  return json({
    repo: base.repo,
    configured: agentsConfigured(env),
    channels: rows.map((r) => ({
      source: r.source,
      channelId: r.channel_id,
      name: r.name || r.channel_name || null,
      groupName: r.group_name || null,
      team: r.team,
      teamName: r.team_name || r.team,
      org: r.org,
      kind: r.kind,
      threads: r.threads,
      latest: r.latest,
      agent: states.get(r.channel_id),
      may: r.kind === 'channel' && managesTeam(me, r.team),
    })),
  });
}

/**
 * PUT /api/kb/agent `{ channel, enabled }`: turns a channel's thread agent on or off. For the
 * admin team, and managers of the team that owns the channel (the team of its latest
 * thread). Running agents notice at their next message, or their wrap-up a day later.
 */
async function switchAgent(env, me, body) {
  const channel = String(body.channel || '');
  if (typeof body.enabled !== 'boolean' || !channel) {
    return json({ error: 'give a channel and enabled: true or false' }, 400);
  }
  const owner = await env.DB.prepare(`SELECT team, kind FROM threads WHERE channel_id = ?
    ORDER BY COALESCE(last_at, any_at) DESC LIMIT 1`).bind(channel).first();
  if (!owner || owner.kind === 'ignore' || !(isAdmin(me) || managesTeam(me, owner.team))) {
    return json({ error: 'no such channel' }, 404);
  }
  if (body.enabled && owner.kind !== 'channel') {
    return json({ error: 'alert channels have no thread agents' }, 400);
  }
  const agent = await setAgent(env, channel, body.enabled, me.name || me.email);
  console.log(JSON.stringify({
    route: 'kb', action: 'agent', channel, enabled: agent.enabled, team: owner.team,
  }));
  return json({ ok: true, channel, agent });
}

/** Routes `/api/kb*` for a member of the admin team. Returns null for other paths. */
export async function kbAdmin(request, env, url, me) {
  if (url.pathname === '/api/kb' && request.method === 'GET') {
    return listBases(env, me);
  }
  if (url.pathname === '/api/kb/agent' && request.method === 'PUT') {
    return switchAgent(env, me, await request.json().catch(() => ({})));
  }
  // The agents' MCP servers of a knowledge base's team or customer (src/mcpadmin.js).
  const servers = await mcpAdmin(request, env, url, me);
  if (servers) {
    return servers;
  }
  // The agents' tools that are off until switched on (src/tooladmin.js).
  const tools = await toolAdmin(request, env, url, me);
  if (tools) {
    return tools;
  }
  if (url.pathname === '/api/kb/channels' && request.method === 'GET') {
    const base = await knownRepo(env, url.searchParams.get('repo'));
    return base && mayEdit(me, base) ? channels(env, me, base)
      : json({ error: 'no such knowledge base' }, 404);
  }
  if (!url.pathname.startsWith('/api/kb/')) {
    return null;
  }
  if (!env.ARTIFACTS) {
    return json({ error: 'knowledge bases are not configured' }, 503);
  }
  const body = request.method === 'GET' ? {} : await request.json().catch(() => ({}));
  const repo = request.method === 'GET' ? url.searchParams.get('repo') : body.repo;
  const base = await knownRepo(env, repo);
  if (!base || !mayEdit(me, base)) {
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
