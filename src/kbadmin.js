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
  agentChannels, agentStates, setAgent, setTeamDefault, teamDefault,
} from './agent/enabled.js';
import { writeKnowledge } from './agent/kbwrite.js';
import { isEntry, SYSTEM_PROMPT } from './agent/okf.js';
import {
  commitLog, countFiles, listFiles, readText,
} from './agent/repos.js';
import { json } from './http.js';
import { mcpAdmin } from './mcpadmin.js';
import { inTeam, isAdmin, managesTeam } from './review.js';
import { toolAdmin } from './tooladmin.js';

/**
 * May `me` edit this knowledge base? The admin team edits all of them; a team manager the
 * knowledge base of the teams they manage.
 */
const mayEdit = (me, base) => isAdmin(me) || (base.kind === 'team' && managesTeam(me, base.slug));

/**
 * May `me` look at this knowledge base, its agents and their tools? Whoever edits it, and the
 * members of its team: read-only (their own settings aside, which are not the editor's).
 */
const mayRead = (me, base) => mayEdit(me, base) || (base.kind === 'team' && inTeam(me, base.slug));

/**
 * The knowledge-base editor's API (`/inbox/kb`). The admin team and team managers list
 * the knowledge bases, list and read their files, and change them as the signed-in person
 * (team managers: their teams' knowledge bases only); the members of a team read its
 * knowledge base, and see its agents, without changing them. Writes go
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
 * The team and the customer of each channel in `ids` (its kind-`channel` threads), as rows
 * `{ channel_id, team, org }`; a channel being re-filed has two for a while.
 */
async function homesOf(env, ids) {
  const list = [...new Set(ids)];
  const out = [];
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    // eslint-disable-next-line no-await-in-loop
    const { results } = await env.DB.prepare(`SELECT DISTINCT channel_id, team, org FROM threads
      WHERE channel_id IN (${part.map(() => '?').join(', ')}) AND kind = 'channel'`).bind(...part).all();
    out.push(...(results || []));
  }
  return out;
}

/** Counts `value`s once per key: `{ add(key, value), size(key) }`. */
function tally() {
  const sets = new Map();
  return {
    add(key, value) {
      if (!sets.has(key)) {
        sets.set(key, new Set());
      }
      sets.get(key).add(value);
    },
    size: (key) => (sets.has(key) ? sets.get(key).size : 0),
  };
}

/**
 * How many channels with an agent each knowledge base learns from, by `<kind>:<slug>`: those
 * switched on, those of AGENT_CHANNELS and those of the teams with agents by default that
 * nobody switched off. Only the teams with agents by default are read by team.
 */
async function agentCounts(env) {
  const [{ results: set }, { results: teams }] = await Promise.all([
    env.DB.prepare('SELECT channel_id, enabled FROM agent_channels').all(),
    env.DB.prepare('SELECT team FROM agent_teams WHERE enabled = 1').all(),
  ]);
  const explicit = new Map((set || []).map((r) => [r.channel_id, r.enabled === 1]));
  const deployment = agentChannels(env);
  const teamsOn = (teams || []).map((r) => r.team);
  const switchedOn = [...explicit].filter(([, on]) => on).map(([id]) => id);
  const rows = await homesOf(env, [...deployment, ...switchedOn]);
  for (let i = 0; i < teamsOn.length; i += 90) {
    const part = teamsOn.slice(i, i + 90);
    // eslint-disable-next-line no-await-in-loop
    const { results } = await env.DB.prepare(`SELECT DISTINCT channel_id, team, org FROM threads
      WHERE team IN (${part.map(() => '?').join(', ')}) AND kind = 'channel'`).bind(...part).all();
    rows.push(...(results || []));
  }
  const on = new Set(teamsOn);
  const counts = tally();
  for (const r of rows) {
    const enabled = explicit.has(r.channel_id) ? explicit.get(r.channel_id)
      : deployment.has(r.channel_id) || on.has(r.team);
    if (enabled) {
      counts.add(`team:${r.team}`, r.channel_id);
      counts.add(`org:${r.org}`, r.channel_id);
    }
  }
  return counts;
}

/**
 * How many tools and MCP servers the agents of each knowledge base's threads have turned on,
 * by `<kind>:<slug>`, as the editor's "Tools and MCP servers" counts them: the switchable
 * tools and the global servers on for the team or in any of its channels, and its own servers.
 */
async function toolCounts(env) {
  const [{ results: servers }, { results: switches }] = await Promise.all([
    env.DB.prepare('SELECT scope, slug, id FROM mcp_servers WHERE enabled = 1').all(),
    env.DB.prepare(`SELECT 'tool:' || tool AS name, scope, target FROM agent_tool_switches WHERE enabled = 1
      UNION ALL SELECT 'mcp:' || server, scope, target FROM mcp_global_switches WHERE enabled = 1`).all(),
  ]);
  const counts = tally();
  for (const r of servers || []) {
    counts.add(`${r.scope}:${r.slug}`, `server:${r.id}`);
  }
  const byChannel = new Map();
  for (const r of switches || []) {
    if (r.scope === 'team') {
      counts.add(`team:${r.target}`, r.name);
    } else {
      byChannel.set(r.target, [...(byChannel.get(r.target) || []), r.name]);
    }
  }
  for (const r of await homesOf(env, [...byChannel.keys()])) {
    for (const name of byChannel.get(r.channel_id)) {
      counts.add(`team:${r.team}`, name);
      counts.add(`org:${r.org}`, name);
    }
  }
  return counts;
}

/**
 * GET /api/kb: every knowledge base `me` may read, teams first, with the team's or customer's
 * name, its entries (null until counted), how many channels with agents and tools it has, and
 * whether `me` may change it (`may`).
 */
async function listBases(env, me) {
  const [agents, tools, { results }] = await Promise.all([
    agentCounts(env),
    toolCounts(env),
    env.DB.prepare(`SELECT k.repo, k.kind, k.slug, k.created_at, k.entries,
        t.name AS team_name
      FROM knowledge_bases k LEFT JOIN teams t ON k.kind = 'team' AND t.slug = k.slug
      ORDER BY CASE k.kind WHEN 'team' THEN 0 ELSE 1 END, k.slug`).all(),
  ]);
  return json({
    systemPrompt: SYSTEM_PROMPT,
    bases: (results || []).filter((r) => mayRead(me, r)).map((r) => ({
      repo: r.repo,
      kind: r.kind,
      slug: r.slug,
      name: r.team_name || r.slug,
      created_at: r.created_at,
      entries: r.entries ?? null,
      agents: agents.size(`${r.kind}:${r.slug}`),
      tools: tools.size(`${r.kind}:${r.slug}`),
      may: mayEdit(me, r),
    })),
  });
}

/** Records how many entries a knowledge base has, when it changed. */
async function recordEntries(env, repo, n) {
  await env.DB.prepare(`UPDATE knowledge_bases SET entries = ?1
    WHERE repo = ?2 AND (entries IS NULL OR entries != ?1)`).bind(n, repo).run();
}

/**
 * Cron: counts the entries of knowledge bases not counted yet (`knowledge_bases.entries` is
 * NULL), `limit` at a time; writes keep the count after that (src/agent/kbwrite.js).
 */
export async function countEntries(env, { limit = 60, parallel = 6 } = {}) {
  if (!env.ARTIFACTS) {
    return { counted: 0 };
  }
  const { results } = await env.DB.prepare(`SELECT repo FROM knowledge_bases
    WHERE entries IS NULL ORDER BY RANDOM() LIMIT ?`).bind(limit).all();
  const repos = (results || []).map((r) => r.repo);
  const count = async (repo) => {
    try {
      // The whole tree, not a listing: one is capped, and a short count would stay.
      await recordEntries(env, repo, (await countFiles(env, repo, isEntry)).count);
      return true;
    } catch (e) {
      console.error(JSON.stringify({
        route: 'cron', kb: 'count', repo, error: e.message,
      }));
      return false;
    }
  };
  const done = [];
  for (let i = 0; i < repos.length; i += parallel) {
    // eslint-disable-next-line no-await-in-loop
    done.push(...await Promise.all(repos.slice(i, i + parallel).map(count)));
  }
  const counted = done.filter(Boolean).length;
  return { counted, failed: repos.length - counted };
}

/** GET /api/kb/files?repo=: every file, and whether `systemprompt.md` exists. */
async function files(env, repo) {
  const res = await listFiles(env, repo, '', { recursive: true });
  if (res.error) {
    return json({ error: res.error }, 404);
  }
  const list = (res.entries || []).filter((e) => e.type !== 'tree')
    .map((e) => ({ path: e.path, hash: e.hash }));
  if (!res.truncated) {
    await recordEntries(env, repo, list.filter((f) => isEntry(f.path)).length);
  }
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
  const states = await agentStates(env, rows.map((r) => r.channel_id), {
    // Alert channels have no agents: their team's default does not turn them on.
    teams: new Map(rows.filter((r) => r.kind === 'channel').map((r) => [r.channel_id, r.team])),
  });
  return json({
    repo: base.repo,
    configured: agentsConfigured(env),
    // A team's knowledge base: whether the channels nobody switched have agents.
    teamDefault: base.kind === 'team' ? {
      ...await teamDefault(env, base.slug), may: managesTeam(me, base.slug),
    } : null,
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
 * `{ team, enabled }` sets the team's default instead: whether its channels that nobody
 * switched have agents (for the admin team and the team's managers).
 */
async function switchAgent(env, me, body) {
  const channel = String(body.channel || '');
  const team = String(body.team || '');
  if (typeof body.enabled !== 'boolean' || !(channel || team)) {
    return json({ error: 'give a channel or a team, and enabled: true or false' }, 400);
  }
  if (team) {
    const known = await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(team).first();
    if (!known || !managesTeam(me, team)) {
      return json({ error: 'no such team' }, 404);
    }
    const teamDefaults = await setTeamDefault(env, team, body.enabled, me.name || me.email);
    console.log(JSON.stringify({
      route: 'kb', action: 'agent', team, enabled: teamDefaults.enabled,
    }));
    return json({ ok: true, team, teamDefault: { ...teamDefaults, may: true } });
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

/** Routes `/api/kb*` (see `mayRead` and `mayEdit`). Returns null for other paths. */
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
    return base && mayRead(me, base) ? channels(env, me, base)
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
  if (!base || !mayRead(me, base)) {
    return json({ error: 'no such knowledge base' }, 404);
  }
  if (request.method !== 'GET' && !mayEdit(me, base)) {
    return json({ error: 'the admin team and the team\'s managers change its knowledge base' }, 403);
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
