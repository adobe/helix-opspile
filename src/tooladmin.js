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
  AGENT_TOOLS, isAgentTool, setToolSwitch, toolProblem,
} from './agent/agenttools.js';
import { json } from './http.js';
import { channelOwner, ownerOf } from './mcpadmin.js';
import { managesTeam } from './review.js';

/**
 * The knowledge-base editor's API for the agents' switchable tools (src/agent/agenttools.js),
 * behind `/api/kb/tools`, next to their MCP servers:
 *
 * - `GET ?repo=` lists the tools, whether this deployment can run each, the team's switch (a
 *   team's knowledge base only), and the switches of the channels the knowledge base learns
 *   from.
 * - `PUT { tool, team | channel, enabled }` switches one for a team, or a channel
 *   (`enabled: null` lets the channel follow its team again). For the admin team and the
 *   managers of the team (of the team that owns the channel).
 *
 * Agents notice at their next message.
 */

const bad = (error) => json({ error }, 400);
const shownSwitch = (r) => r && { enabled: Boolean(r.enabled), by: r.changed_by, at: r.changed_at };

async function list(env, me, repo) {
  const owner = await ownerOf(env, me, repo);
  if (!owner) {
    return json({ error: 'no such knowledge base' }, 404);
  }
  const column = owner.scope === 'team' ? 'team' : 'org';
  const { results } = await env.DB.prepare(`SELECT * FROM agent_tool_switches
    WHERE (scope = 'team' AND target = ?) OR (scope = 'channel' AND target IN
      (SELECT DISTINCT channel_id FROM threads WHERE ${column} = ?))`)
    .bind(owner.scope === 'team' ? owner.slug : '', owner.slug).all();
  const rows = results || [];
  return json({
    repo,
    tools: AGENT_TOOLS.map((t) => ({
      tool: t.tool,
      title: t.title,
      description: t.description,
      note: t.note,
      names: t.names,
      platforms: t.platforms,
      problem: toolProblem(env, t.tool),
      team: owner.scope === 'team'
        ? shownSwitch(rows.find((r) => r.tool === t.tool && r.scope === 'team')) || { enabled: false }
        : null,
      channels: Object.fromEntries(rows.filter((r) => r.tool === t.tool && r.scope === 'channel')
        .map((r) => [r.target, shownSwitch(r)])),
    })),
  });
}

async function switchTool(env, me, body) {
  const tool = String(body.tool || '');
  if (!isAgentTool(tool)) {
    return bad('no such tool');
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
  const sw = await setToolSwitch(env, {
    tool, scope, target, enabled, by,
  });
  console.log(JSON.stringify({
    route: 'kb', action: 'tool', tool, scope, team, enabled, by: me.id,
  }));
  return json({
    ok: true, tool, [scope]: target, switch: sw,
  });
}

/** Routes `/api/kb/tools`; null for other paths. */
export async function toolAdmin(request, env, url, me) {
  if (url.pathname !== '/api/kb/tools') {
    return null;
  }
  if (request.method === 'GET') {
    return list(env, me, url.searchParams.get('repo'));
  }
  if (request.method === 'PUT') {
    return switchTool(env, me, await request.json().catch(() => ({})));
  }
  return json({ error: 'not found' }, 404);
}
