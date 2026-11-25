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
import { portalBound } from '../portalsource.js';
import { teamsBotEnabled } from '../teamsbot.js';
import { grantsOf } from '../toolrequests.js';
import { membershipOn } from './membership.js';
import { searchProblem } from './websearch.js';

/**
 * Tools of the thread agents that are off until someone turns them on: for an ops team, or
 * for one channel (`agent_tool_switches`; a channel's switch wins over its team's), in the
 * knowledge-base editor, by the admin team and the team's managers. As the global MCP servers
 * (src/agent/globals.js), but these are the agent's own tools, not reached through code mode.
 *
 * - `post_message`: the agent posts a reply in its thread right away, as the opspile app (the
 *   Slack bot, the Teams bot, the Discord bot), next to `update_draft`, and reacts to messages
 *   with an emoji (`add_reaction`; not on Teams, where no bot can). A platform whose bot is not
 *   set up in this deployment does not get it.
 * - `computer`: pi's `bash` tool, run on Cloudflare Computer (src/agent/computer.js): GNU bash
 *   and real programs on the SLICC kernel (src/agent/kernel.js), over a filesystem in the
 *   agent's own Durable Object, so each thread keeps its files from one turn to the next, with
 *   network access and curl, and the team's and the customer's secrets, which only the
 *   Worker's gateway puts into the shell's requests (src/agent/secrets.js). With it comes
 *   `request_bash`: a command the agent asks a person on the team to run there, with values
 *   the person fills in (src/agent/bashrequest.js). The admin team chooses the programs of a
 *   team's computers, its `image` (src/agent/image.js).
 * - `extraction_rules`: the agent reads, tests and changes its team's extraction rules and
 *   tech stack (src/extract.js), which apply to every channel of the team from the next
 *   labeling of a thread. It cannot change the admin team's, which apply to every channel.
 * - `org_threads`: the agent reads the other channels of its thread's customer (the org its
 *   thread is filed under), on every platform, with the same three tools as `any_thread`, but
 *   never a channel or thread of another org (src/agent/channelfind.js, src/agent/history.js).
 *   Not for an internal org, whose channels are about every customer, nor an internal slug
 *   (`_unassigned`), which is nobody's (`orgReadable`). On for every team (migration 0102) and
 *   every new one; a team's managers turn it off, for the team or one channel.
 * - `any_thread`: the agent reads any thread of the inbox, whatever its channel, team or
 *   customer (src/agent/history.js), finds a customer's channels and lists their threads
 *   (src/agent/channelfind.js). Where it is on, it stands for `org_threads`.
 * - `membership`: the agent asks the platform's admin bot to add people to the thread's channel,
 *   or remove them, where someone asked for it in the thread (src/agent/membership.js): on Teams
 *   admin-bot (teams-admin-agent), on Slack AEM Ops Automation (the slack-automation relay), each
 *   through a service binding. The admins approve, as when a person asks the bot.
 * - `web_search`: the agent searches the public web, through Microsoft Web IQ, or Cloudflare's
 *   Web Search API and AI Gateway (src/agent/websearch.js), for pages it has no address for;
 *   it reads them on its computer (playwright-cli, curl). On for every team
 *   (migration 0077) and every new one; its managers turn it off.
 * - `resolve`: the agent marks its thread resolved, or takes that back (src/agentlabels.js), in
 *   the inbox only: it counts as a staff ✅ on the root (src/resolve.js). On for every team
 *   (migration 0091) and every new one.
 * - `label`: the agent corrects Clef's kind, urgency and next actor of its thread, in the inbox
 *   only (src/agentlabels.js). On for every team (migration 0091) and every new one.
 *
 * Those marked `newTeams` are turned on for a team when it is created (src/admin.js).
 *
 * A tool marked `org` works only where the thread's org is one whose channels may be read across
 * (`orgReadable`).
 *
 * A tool marked `internal` has no team switch, only the admin team switches it, and it works
 * only in an internal channel (`internalChannel`), however it got switched on.
 *
 * A thread's agent also has the tools a person granted it in the sidebar, for a day
 * (src/toolrequests.js), on top of the switches: all but the `internal` ones, which are the
 * admin team's to give.
 */

export const AGENT_TOOLS = [
  {
    tool: 'post_message',
    title: 'Post messages',
    names: ['post_message', 'add_reaction'],
    description: 'The agent posts its reply in the thread right away, as the bot,'
      + ' instead of only keeping the draft a person sends, and reacts to messages with emoji',
    note: 'As the bot of each platform: the Slack app (bot scopes chat:write and'
      + ' reactions:write), the Teams bot (installed in a team on its first post there; it'
      + ' cannot react, Teams lets no bot), the Discord bot (Send Messages, Send Messages in'
      + ' Threads, Add Reactions), and in the customer portal as Enterprise Support.',
    platforms: ['slack', 'teams', 'discord', 'portal'],
  },
  {
    tool: 'computer',
    title: 'Computer',
    names: ['bash', 'request_bash'],
    description: 'A computer for the agent: GNU bash and real programs on the SLICC kernel, in'
      + ' Dynamic Workers, over a working directory of its own per thread that keeps its files.'
      + ' The programs are its image\'s, below (grep, sed, awk, jq, curl, git and the like); no'
      + ' npm, node or python. The files attached to the thread are in it, read-only, for 30'
      + ' days. It can also ask a person to run a command there (request_bash), with values only'
      + ' they have',
    note: 'The shell reaches the internet (curl), without a filter: what the agent read can'
      + ' leave the inbox through it, the files attached to the thread included. Secrets kept'
      + ' here are put into its requests on the way out, only to their hosts: the agent never'
      + ' sees their values. A command it asks for shows under its thread, for the team to run'
      + ' or deny: what the person fills in goes to that one run, is kept nowhere, and is taken'
      + ' out of what the agent reads of the output.',
    platforms: null,
    newTeams: true,
  },
  {
    tool: 'extraction_rules',
    title: 'Extraction rules',
    names: ['list_extraction_rules', 'test_extraction_rule', 'save_extraction_rule',
      'delete_extraction_rule', 'save_tech', 'delete_tech'],
    description: 'The agent defines detection and extraction rules for its team: regular'
      + ' expressions or scripts that find facts (sites, tickets, URLs, …) in threads or detect a'
      + ' technology the customer uses, and the tech stack Clef asks about',
    note: 'What the agent saves applies to every channel of its team, from the next labeling of'
      + ' a thread, and shows on this page, attributed to the agent. It cannot change the admin'
      + ' team\'s rules.',
    platforms: null,
    newTeams: true,
  },
  {
    tool: 'org_threads',
    title: 'Read the customer\'s channels',
    names: ['read_any_thread', 'find_channels', 'list_any_channel_threads'],
    description: 'The agent reads the other channels of its thread\'s customer, on every'
      + ' platform: it lists them, lists a channel\'s conversations and reads a thread of one,'
      + ' by its key or a link to one of its messages. Never a channel or thread of another'
      + ' customer',
    note: 'The customer is the org the thread is filed under (Rules): a channel counts when its'
      + ' latest thread is filed there, a thread when it is. Not in channels of an internal org,'
      + ' nor unassigned ones. What the agent read can reach its drafts, notes and the customer\'s'
      + ' knowledge base, and its posts in this customer\'s channels. Every thread it reads is'
      + ' recorded (agent_thread_reads).',
    platforms: null,
    newTeams: true,
    org: true,
  },
  {
    tool: 'any_thread',
    title: 'Read any thread',
    names: ['read_any_thread', 'find_channels', 'list_any_channel_threads'],
    description: 'The agent reads any thread of the inbox, of any channel, team or customer, by'
      + ' its key or a link to one of its messages, finds a customer\'s channels by its name or'
      + ' the sites their threads are about, and lists a channel\'s conversations',
    note: 'One channel at a time, by the admin team, in internal channels only: not a customer\'s,'
      + ' partner\'s or vendor\'s, and none shared outside Adobe. What the agent read can reach'
      + ' its drafts, notes, knowledge bases and the other tools it has here. Every thread it'
      + ' reads is recorded (agent_thread_reads).',
    platforms: null,
    internal: true,
  },
  {
    tool: 'membership',
    title: 'Request channel members',
    names: ['request_membership'],
    description: 'Where someone in the thread asks for people to be added to the channel (or'
      + ' removed), the agent files the request with the admins\' bot: admin-bot on Teams, AEM Ops'
      + ' Automation in #general on Slack',
    note: 'Nobody is added until it is approved: on Teams by the admins, in their Slack channel;'
      + ' on Slack by the person who asked, if they are a member there, or an admin. Each request'
      + ' names the person who asked, and says the opspile agent sent it.',
    platforms: ['slack', 'teams'],
    needs: membershipOn,
  },
  {
    tool: 'web_search',
    title: 'Web search',
    names: ['web_search'],
    description: 'The agent searches the public web for what the knowledge bases, the channel\'s'
      + ' threads and the repositories do not have (documentation, error messages, release notes),'
      + ' through Microsoft Web IQ or Cloudflare\'s Web Search API, and reads the pages it finds'
      + ' with its other tools',
    note: 'Each query goes to the deployment\'s search provider, outside Adobe: Microsoft Web IQ'
      + ' where its key (WEBIQ_API_KEY) is set, billed to its Azure subscription, else through'
      + ' AI Gateway to Ceramic.ai, Linkup or Exa (WEB_SEARCH_PROVIDER), billed to the account\'s'
      + ' AI Gateway credits or a provider key stored on the gateway. The agents are told to write'
      + ' general queries, never with the customer\'s name, people, hosts or the thread\'s text.',
    platforms: null,
    newTeams: true,
  },
  {
    tool: 'resolve',
    title: 'Resolve threads',
    names: ['resolve_thread'],
    description: 'The agent marks its thread resolved in the inbox once its issue or request is'
      + ' settled (the customer confirmed a fix, or said nothing more is needed), or when someone'
      + ' asks it to in the sidebar, and takes that back',
    note: 'In the inbox only, as a person\'s ✅ on the first message counts: nothing is'
      + ' posted or reacted in the channel. A customer\'s next message opens the thread again,'
      + ' and anyone on the team does with the ✅ button.',
    platforms: null,
    newTeams: true,
  },
  {
    tool: 'label',
    title: 'Label threads',
    names: ['label_thread'],
    description: 'The agent corrects what Clef says of its thread: its kind, its urgency, and'
      + ' whom it waits on',
    note: 'In the inbox only. The kind holds until the agent changes it; the urgency and whom it'
      + ' waits on until a person posts again, when Clef reads the thread anew. A label review'
      + ' by the admin team wins over the agent\'s.',
    platforms: null,
    newTeams: true,
  },
];

const BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.tool, t]));

/** Whether a platform's opspile bot is set up in this deployment. */
const BOTS = {
  slack: (env) => Boolean(env.SLACK_BOT_TOKEN),
  teams: teamsBotEnabled,
  discord: discordEnabled,
  // The customer portal: the inbox posts there as its app once the portal's Worker is bound.
  portal: portalBound,
};
export const isAgentTool = (tool) => BY_NAME.has(String(tool));
export const agentTool = (tool) => BY_NAME.get(String(tool)) || null;

/**
 * The platforms a tool works on in this deployment, or null for all of them: where the opspile
 * bot is set up, or for a tool with `needs` of its own, where those are.
 */
export function platformsOf(env, tool) {
  const t = agentTool(tool);
  return t && t.platforms ? t.platforms.filter((p) => (t.needs || BOTS)[p](env)) : null;
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
  if (tool === 'membership' && !platformsOf(env, tool).length) {
    return 'Neither admin bot is bound here (TEAMS_ADMIN, or SLACK_AUTOMATION with'
      + ' MEMBERSHIP_SLACK_CHANNEL and MEMBERSHIP_SLACK_BOT).';
  }
  if (tool === 'computer' && !env.LOADER) {
    return 'The Worker Loader binding (LOADER) is missing in this deployment.';
  }
  if (tool === 'web_search') {
    return searchProblem(env);
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
 * Whether a channel is internal: filed under an org of type `internal`, and not shared with
 * anyone (Slack Connect, a Teams shared channel). Not knowing is no. The org alone would not
 * do: an internal org can have shared channels. Neither proves that nobody outside is in the
 * channel (a guest, say), which is why someone has to turn such a tool on as well.
 */
export async function internalChannel(env, channelId) {
  const row = await env.DB.prepare(`SELECT o.type, c.shared, c.connected FROM threads t
      LEFT JOIN orgs o ON o.slug = t.org
      LEFT JOIN channels c ON c.source = t.source AND c.tenant = t.tenant
        AND c.channel_id = t.channel_id
    WHERE t.channel_id = ? ORDER BY COALESCE(t.last_at, t.any_at) DESC LIMIT 1`)
    .bind(channelId || '').first();
  return Boolean(row) && row.type === 'internal' && row.shared === 0
    && JSON.parse(row.connected || '[]').length === 0;
}

/**
 * Whether an agent may read across the channels of org `org` (`org_threads`): an org the rules
 * filed its thread under, not an internal slug (`_unassigned`, `_test`: many customers' channels,
 * nobody's), and not an org of type `internal` (Adobe's own channels, which are about every
 * customer; reading them is `any_thread`'s, the admin team's to turn on).
 */
export async function orgReadable(env, org) {
  if (!org || String(org).startsWith('_')) {
    return false;
  }
  const row = await env.DB.prepare('SELECT type FROM orgs WHERE slug = ?').bind(String(org)).first();
  return ((row && row.type) || 'customer') !== 'internal';
}

/**
 * Where an agent may read other channels' threads, from the tools it has (`toolsFor`):
 * `{ org: null }` anywhere in the inbox (`any_thread`), `{ org }` in its customer's channels only
 * (`org_threads`), or null nowhere.
 */
export function readScope(tools, target) {
  if (tools.includes('any_thread')) {
    return { org: null };
  }
  return tools.includes('org_threads') && target && target.org ? { org: target.org } : null;
}

/**
 * The switchable tools a knowledge-base agent has (`kb:<team>:`, `kb::<org>`, no thread): for the
 * conversations of its knowledge base's sidebar (src/kbchat.js), which are a person's, not a
 * channel's, so no switch decides them. The computer and the web search; a team's extraction
 * rules and tech stack too. The tools themselves refuse outside those conversations
 * (src/agent/tools.js), and their changes for who may not write the knowledge base.
 */
export const KB_AGENT_TOOLS = ['computer', 'web_search', 'extraction_rules'];

/**
 * The switchable tools an agent's target (its team, channel and platform) has, as a sorted
 * list of their keys: on, or granted to its thread (src/toolrequests.js), working in this
 * deployment and on the thread's platform. A knowledge-base agent's (no `key`): KB_AGENT_TOOLS,
 * those that work here, the extraction rules only for a team's.
 */
export async function toolsFor(env, target) {
  if (target && !target.key && (target.team || target.org)) {
    return KB_AGENT_TOOLS.filter((t) => !toolProblem(env, t)
      && (t !== 'extraction_rules' || Boolean(target.team))).sort();
  }
  if (!target || !target.key || !env.DB) {
    return [];
  }
  const [switches, granted] = await Promise.all([
    toolSwitches(env, target),
    grantsOf(env, target.key, 'tool'),
  ]);
  const on = AGENT_TOOLS.filter((t) => {
    const { team, channel } = switches.get(t.tool);
    return (switchedOn(t.internal ? { channel } : { team, channel })
      || (!t.internal && granted.has(t.tool)))
      && !toolProblem(env, t.tool) && onPlatform(env, t.tool, target.source);
  });
  const [internal, org] = await Promise.all([
    on.some((t) => t.internal) && internalChannel(env, target.channelId),
    on.some((t) => t.org) && orgReadable(env, target.org),
  ]);
  return on.filter((t) => (!t.internal || internal) && (!t.org || org)).map((t) => t.tool).sort();
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
