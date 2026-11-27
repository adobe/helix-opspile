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

import { entryOf } from '../drafts.js';
import { notifyRoom } from '../notify.js';
import {
  cleanReason, GRANT_MS, insertToolRequest, MAX_OPEN, openRequestFor, pendingCount,
} from '../toolrequests.js';
import {
  AGENT_TOOLS, onPlatform, toolProblem, toolsFor,
} from './agenttools.js';
import { forSource, GLOBAL_SERVERS, instancesOf } from './globals.js';
import { serversFor } from './mcpclient.js';

/**
 * The agent's side of tool requests (the record is src/toolrequests.js): while it answers a
 * sidebar message, `request_tool` lists what its thread could have and does not, and asks for
 * one of them with a reason. Anyone who may work the thread grants or denies it in the sidebar
 * (`decideTool`, src/agent/stub.js), and the agent hears of it as a sidebar message of theirs
 * (`grantText`, `denyText`), so it goes on in the sidebar.
 *
 * What it can ask for: the switchable tools (src/agent/agenttools.js) that are off in its
 * channel, work in this deployment and on its platform, but for the `internal` ones; the MCP
 * servers of its team and customer that are off in its channel; and the global ones
 * (src/agent/globals.js) that are off and have an instance, but for those only the admin team
 * switches (`admins`). A grant is the thread's, for every turn of its agent, not the sidebar's.
 */

const HOURS = GRANT_MS / (60 * 60 * 1000);

/**
 * What target `t` (the agent's) could be granted: `[{ id, kind, name, title, about, whose? }]`,
 * `id` being what the agent names it by (`web_search`, `mcp:12`, `mcp:global:github`).
 */
export async function requestableFor(env, t) {
  if (!t || !t.key || !env.DB) {
    return [];
  }
  const [tools, servers, { results }] = await Promise.all([
    toolsFor(env, t),
    serversFor(env, t),
    env.DB.prepare(`SELECT id, scope, slug, name, description FROM mcp_servers
      WHERE (scope = 'team' AND slug = ?) OR (scope = 'org' AND slug = ?)
      ORDER BY scope = 'team' DESC, name`).bind(t.team || '', t.org || '').all(),
  ]);
  const on = new Set(tools);
  const have = new Set(servers.map((s) => (s.scope === 'global' ? `global:${s.slug}` : String(s.id))));
  const out = AGENT_TOOLS
    .filter((x) => !x.internal && !on.has(x.tool) && !toolProblem(env, x.tool)
      && onPlatform(env, x.tool, t.source))
    .map((x) => ({
      id: x.tool, kind: 'tool', name: x.tool, title: x.title, about: x.description,
    }));
  for (const s of (results || []).filter((r) => !have.has(String(r.id)))) {
    out.push({
      id: `mcp:${s.id}`,
      kind: 'server',
      name: String(s.id),
      title: `MCP server ${s.name}`,
      about: s.description || null,
      whose: s.scope === 'team' ? `the ops team ${s.slug}'s` : `the customer ${s.slug}'s`,
    });
  }
  const globals = GLOBAL_SERVERS.filter((g) => !g.admins && forSource(g, t.source)
    && !have.has(`global:${g.server}`));
  // One without an instance (no token, no GitHub App) would give the agent nothing.
  const usable = await Promise.all(globals.map((g) => instancesOf(env, g.server)
    .then((r) => r.instances.length > 0).catch(() => false)));
  globals.forEach((g, i) => {
    if (usable[i]) {
      out.push({
        id: `mcp:global:${g.server}`,
        kind: 'server',
        name: `global:${g.server}`,
        title: `MCP server ${g.title}`,
        about: g.description,
        whose: 'opspile\'s global',
      });
    }
  });
  return out;
}

/** `requestableFor`'s answer as the agent reads it. */
export function requestableText(list) {
  if (!list.length) {
    return 'There is nothing you could ask for here: you have every tool and MCP server that works in this thread, or the others are the admin team\'s to turn on.';
  }
  const lines = list.map((x) => `- ${x.id}: ${x.title}${x.whose ? ` (${x.whose})` : ''}${x.about ? `. ${x.about}` : ''}`);
  return `What you can ask for with request_tool (\`tool\`: the name before the colon). A person on the team grants it to this thread for ${HOURS} hours, or denies it:\n${lines.join('\n')}`;
}

/** Tells the inboxes of the thread's teams that its sidebar changed. */
async function announce(env, thread) {
  const entry = await entryOf(env, thread).catch(() => null);
  if (entry) {
    await notifyRoom(env, entry.teams, { type: 'sidebar', thread: entry.key });
  }
}

/**
 * The agent's `request_tool` with a `tool`: stores the request, for the sidebar message it
 * answers, and tells the team's inboxes. `ctx` is the tools' context (`env`, `target`,
 * `sidebarMessage`). Resolves to `{ request }` or `{ error, request? }`.
 */
export async function requestTool(ctx, args, now = new Date()) {
  const { env } = ctx;
  const t = await ctx.target();
  const sidebar = ctx.sidebarMessage ? await ctx.sidebarMessage() : null;
  if (!t.key || !sidebar) {
    return { error: 'Only while you answer a sidebar message, for the person you talk to there: nothing was requested. Say in your note what you would need, and why.' };
  }
  const wanted = String((args && args.tool) || '').trim();
  const list = await requestableFor(env, t);
  const item = list.find((x) => x.id === wanted);
  if (!item) {
    const names = list.map((x) => x.id).join(', ');
    return { error: `${wanted || 'That'} is not something you can ask for in this thread${names ? ` (you can ask for: ${names})` : ' (there is nothing to ask for)'}. Nothing was requested.` };
  }
  const reason = cleanReason(args.reason);
  if (reason.error) {
    return { error: `${reason.error}. Nothing was requested.` };
  }
  const open = await openRequestFor(env, t.key, item, now);
  if (open) {
    return { error: `Request ${open.id} asks for ${item.title} already. Nothing was requested.`, request: open };
  }
  if (await pendingCount(env, t.key, now) >= MAX_OPEN) {
    return { error: `${MAX_OPEN} of your tool requests wait for a person already. Nothing was requested.` };
  }
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const request = await insertToolRequest(env, id, t.key, {
    sidebar,
    kind: item.kind,
    name: item.name,
    title: item.title,
    about: item.about,
    reason: reason.reason,
  }, now);
  console.log(JSON.stringify({
    route: 'agent', action: 'tool_request', id, kind: item.kind, name: item.name, team: t.team,
  }));
  await announce(env, t.key);
  return { request };
}

/**
 * What the person who granted request `r` says to the agent in the sidebar, as a sidebar
 * message of theirs (src/agent/stub.js `decideTool`); also what the sidebar shows them say.
 */
export const grantText = (r) => `Granted: you have **${r.title}** in this thread for the next ${HOURS} hours (tool request ${r.id}), in every turn, not only in the sidebar. Go on with what you needed it for.`;

/** What the person who denied request `r` says to the agent in the sidebar. */
export const denyText = (r) => `Denied: you do not get **${r.title}** (tool request ${r.id}). Go on without it.`;
