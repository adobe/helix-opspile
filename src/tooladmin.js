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
  AGENT_TOOLS, agentTool, internalChannel, isAgentTool, platformsOf, setToolSwitch, toolProblem,
} from './agent/agenttools.js';
import { listImages } from './agent/image.js';
import {
  isRuntime, RUNTIMES, setTeamImage, setTeamRuntime, teamImage, teamRuntime,
} from './agent/kernel.js';
import { json } from './http.js';
import { channelOwner, ownerOf } from './mcpadmin.js';
import { isAdmin, managesTeam } from './review.js';
import { secretAdmin, secretsOf } from './secretadmin.js';

/**
 * The knowledge-base editor's API for the agents' switchable tools (src/agent/agenttools.js),
 * behind `/api/kb/tools`, next to their MCP servers:
 *
 * - `GET ?repo=` lists the tools, whether this deployment can run each, the team's switch (a
 *   team's knowledge base only), and the switches of the channels the knowledge base learns
 *   from.
 * - `PUT { tool, team | channel, enabled }` switches one for a team, or a channel
 *   (`enabled: null` lets the channel follow its team again). For the admin team and the
 *   managers of the team (of the team that owns the channel). An `internal` tool only for
 *   the admin team, per channel, and it turns on only in an internal channel.
 *
 * - `PUT { tool: 'computer', team, runtime }` chooses the shell of a team's computers
 *   (src/agent/kernel.js: `just-bash`, or `slicc-kernel`, which is experimental), and
 *   `PUT { tool: 'computer', team, image }` the image of its kernels (src/agent/image.js), one
 *   of those in the `IMAGES` bucket. For the admin team only.
 *
 * Agents notice at their next message.
 *
 * The Computer tool comes with the secrets of the team or the customer (`secrets`: names and
 * hosts, never values), which `/api/kb/tools/secrets` changes (src/secretadmin.js), and, in a
 * team's knowledge base, with its shell (`runtime`: `{ runtime, by, at }`), the shells there
 * are (`runtimes`), its image (`image`: `{ image, by, at }`), the images the bucket has
 * (`images`), and whether `me` chooses (`mayRuntime`).
 */

const bad = (error) => json({ error }, 400);
const shownSwitch = (r) => r && { enabled: Boolean(r.enabled), by: r.changed_by, at: r.changed_at };

async function list(env, me, repo) {
  const owner = await ownerOf(env, me, repo, { read: true });
  if (!owner) {
    return json({ error: 'no such knowledge base' }, 404);
  }
  const column = owner.scope === 'team' ? 'team' : 'org';
  const { results } = await env.DB.prepare(`SELECT * FROM agent_tool_switches
    WHERE (scope = 'team' AND target = ?) OR (scope = 'channel' AND target IN
      (SELECT DISTINCT channel_id FROM threads WHERE ${column} = ?))`)
    .bind(owner.scope === 'team' ? owner.slug : '', owner.slug).all();
  const rows = results || [];
  const secrets = await secretsOf(env, owner);
  // The computer's shell is a team's: a customer's knowledge base has none to show.
  const shell = owner.scope === 'team' ? {
    runtime: await teamRuntime(env, owner.slug),
    runtimes: RUNTIMES,
    image: await teamImage(env, owner.slug),
    images: await listImages(env.IMAGES),
    mayRuntime: isAdmin(me),
  } : {};
  return json({
    repo,
    tools: AGENT_TOOLS.map((t) => ({
      tool: t.tool,
      title: t.title,
      description: t.description,
      note: t.note,
      names: t.names,
      platforms: platformsOf(env, t.tool),
      problem: toolProblem(env, t.tool),
      internal: Boolean(t.internal),
      may: !t.internal || isAdmin(me),
      team: owner.scope === 'team' && !t.internal
        ? shownSwitch(rows.find((r) => r.tool === t.tool && r.scope === 'team')) || { enabled: false }
        : null,
      channels: Object.fromEntries(rows.filter((r) => r.tool === t.tool && r.scope === 'channel')
        .map((r) => [r.target, shownSwitch(r)])),
      ...(t.tool === 'computer' ? { secrets, ...shell } : {}),
    })),
  });
}

/** The admin team chooses the shell of a team's computers, or the image of its kernels. */
async function chooseShell(env, me, body) {
  if (!isAdmin(me)) {
    return json({ error: 'only the admin team chooses the computer\'s shell and image' }, 403);
  }
  const runtime = body.runtime === undefined ? null : String(body.runtime || '');
  const image = body.image === undefined ? null : String(body.image || '');
  if (body.tool !== 'computer' || (runtime !== null && !isRuntime(runtime))) {
    return bad(`give tool: computer and runtime: ${RUNTIMES.map((r) => r.runtime).join(' or ')}`);
  }
  const images = image === null ? [] : (await listImages(env.IMAGES)).map((i) => i.name);
  if (image !== null && !images.includes(image)) {
    return bad(images.length ? `give image: ${images.join(' or ')}`
      : 'there are no images in the images bucket (IMAGES): npm run computer:images');
  }
  const team = String(body.team || '');
  if (!team || !await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(team).first()) {
    return json({ error: 'no such team' }, 404);
  }
  const by = me.name || me.email || String(me.id);
  const chosen = {
    ...(runtime !== null ? { runtime: await setTeamRuntime(env, { team, runtime, by }) } : {}),
    ...(image !== null ? { image: await setTeamImage(env, { team, image, by }) } : {}),
  };
  console.log(JSON.stringify({
    route: 'kb',
    action: 'shell',
    tool: 'computer',
    team,
    ...(runtime !== null ? { runtime } : {}),
    ...(image !== null ? { image } : {}),
    by: me.id,
  }));
  return json({
    ok: true, tool: 'computer', team, ...chosen,
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
  if (agentTool(tool).internal) {
    if (!isAdmin(me)) {
      return json({ error: 'only the admin team switches this tool' }, 403);
    }
    if (body.team || !body.channel) {
      return bad('this tool is switched per channel');
    }
    if (enabled && !await internalChannel(env, String(body.channel))) {
      return bad('this tool works in internal channels only: the channel\'s org is not of type internal, or the channel is shared outside');
    }
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

/** Routes `/api/kb/tools` and `/api/kb/tools/secrets`; null for other paths. */
export async function toolAdmin(request, env, url, me) {
  if (url.pathname === '/api/kb/tools/secrets') {
    return secretAdmin(request, env, url, me);
  }
  if (url.pathname !== '/api/kb/tools') {
    return null;
  }
  if (request.method === 'GET') {
    return list(env, me, url.searchParams.get('repo'));
  }
  if (request.method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    return body.runtime === undefined && body.image === undefined
      ? switchTool(env, me, body) : chooseShell(env, me, body);
  }
  return json({ error: 'not found' }, 404);
}
