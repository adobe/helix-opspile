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

import { discordEnabled } from '../discord.js';
import { teamsBotEnabled } from '../teamsbot.js';

/**
 * Tools of the thread agents that are off until someone turns them on: for an ops team, or
 * for one channel (`agent_tool_switches`; a channel's switch wins over its team's), in the
 * knowledge-base editor, by the admin team and the team's managers. As the global MCP servers
 * (src/agent/globals.js), but these are the agent's own tools, not reached through code mode.
 *
 * - `post_message`: the agent posts a reply in its thread right away, as the opspile app (the
 *   Slack bot, the Teams bot, the Discord bot), next to `update_draft`. A platform whose bot is
 *   not set up in this deployment does not get it.
 * - `computer`: pi's `bash` tool, run on Cloudflare Computer (src/agent/computer.js): a
 *   just-bash shell in a Dynamic Worker over a filesystem in the agent's own Durable Object,
 *   so each thread keeps its files from one turn to the next, with network access and curl.
 */

export const AGENT_TOOLS = [
  {
    tool: 'post_message',
    title: 'Post messages',
    names: ['post_message'],
    description: 'The agent posts its reply in the thread right away, as the opspile app,'
      + ' instead of only keeping the draft a person sends',
    note: 'As the opspile bot of each platform: the Slack app (bot scope chat:write), the Teams'
      + ' bot (installed in a team on its first post there), the Discord bot (Send Messages,'
      + ' Send Messages in Threads).',
    platforms: ['slack', 'teams', 'discord'],
  },
  {
    tool: 'computer',
    title: 'Computer',
    names: ['bash'],
    description: 'A bash shell for the agent on Cloudflare Computer: just-bash in a Dynamic'
      + ' Worker, over a working directory of its own per thread that keeps its files. cat, grep,'
      + ' sed, awk, jq, sort, find, curl and the like; no npm, node or python',
    note: 'The shell reaches the internet (curl), without a filter: what the agent read can'
      + ' leave opspile through it.',
    platforms: null,
  },
];

const BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.tool, t]));

/** Whether a platform's opspile bot is set up in this deployment. */
const BOTS = {
  slack: (env) => Boolean(env.SLACK_BOT_TOKEN),
  teams: teamsBotEnabled,
  discord: discordEnabled,
};
export const isAgentTool = (tool) => BY_NAME.has(String(tool));
export const agentTool = (tool) => BY_NAME.get(String(tool)) || null;

/** The platforms a tool works on in this deployment, or null for all of them. */
export function platformsOf(env, tool) {
  const t = agentTool(tool);
  return t && t.platforms ? t.platforms.filter((p) => BOTS[p](env)) : null;
}

/** Whether a tool works on a platform (a thread's `source`) in this deployment. */
export function onPlatform(env, tool, source) {
  const platforms = platformsOf(env, tool);
  return Boolean(agentTool(tool)) && (!platforms || platforms.includes(source));
}

/** Why a tool cannot work in this deployment, or null. */
export function toolProblem(env, tool) {
  if (tool === 'post_message' && !platformsOf(env, tool).length) {
    return 'No opspile bot (Slack, Teams or Discord) is set up in this deployment.';
  }
  if (tool === 'computer' && !env.LOADER) {
    return 'The Worker Loader binding (LOADER) is missing in this deployment.';
  }
  return null;
}

/** The switch rows of a team and a channel, by tool: `{ team, channel }`, each a row or null. */
export async function toolSwitches(env, { team, channelId }) {
  const { results } = await env.DB.prepare(`SELECT tool, scope, target, enabled, changed_by,
      changed_at FROM agent_tool_switches
    WHERE (scope = 'team' AND target = ?) OR (scope = 'channel' AND target = ?)`)
    .bind(team || '', channelId || '').all();
  const out = new Map(AGENT_TOOLS.map((t) => [t.tool, { team: null, channel: null }]));
  for (const r of results || []) {
    if (out.has(r.tool)) {
      out.get(r.tool)[r.scope] = r;
    }
  }
  return out;
}

/** Whether a tool is on: the channel's switch if it has one, else the team's. */
export const switchedOn = ({ team, channel }) => Boolean((channel || team || {}).enabled);

/**
 * The switchable tools an agent's target (its team, channel and platform) has, as a sorted
 * list of their keys: on, working in this deployment and on the thread's platform.
 */
export async function toolsFor(env, target) {
  if (!target || !target.key || !env.DB) {
    return [];
  }
  const switches = await toolSwitches(env, target);
  return AGENT_TOOLS.filter((t) => switchedOn(switches.get(t.tool))
    && !toolProblem(env, t.tool) && onPlatform(env, t.tool, target.source))
    .map((t) => t.tool).sort();
}

/**
 * Sets a tool's switch for a team or a channel, as `by` (a name), now; `enabled: null` lets a
 * channel follow its team again. Resolves to the switch, or null when it was removed.
 */
export async function setToolSwitch(env, {
  tool, scope, target, enabled, by,
}) {
  if (enabled === null) {
    await env.DB.prepare(`DELETE FROM agent_tool_switches WHERE tool = ? AND scope = ?
      AND target = ?`).bind(tool, scope, target).run();
    return null;
  }
  const at = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO agent_tool_switches (tool, scope, target, enabled, changed_by,
      changed_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (tool, scope, target) DO UPDATE SET enabled = excluded.enabled,
      changed_by = excluded.changed_by, changed_at = excluded.changed_at`)
    .bind(tool, scope, target, enabled ? 1 : 0, by, at).run();
  return { enabled: Boolean(enabled), by, at };
}
