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
  approved, currentApp, installationsWithApprovals, installationToken,
} from '../github.js';
import { fluffyConnection, fluffyInstances } from './fluffyjaws.js';
import {
  INSTRUCTIONS as SLACK_INSTRUCTIONS, slackConnection, slackGuide, slackInstances,
} from './slackmcp.js';

/**
 * Global MCP servers: set up once for the whole deployment, not per team or customer, and
 * turned on for an ops team or a single channel (`mcp_global_switches`; a channel's switch
 * wins over its team's, and both are off until someone turns them on). Those marked `newTeams`
 * are turned on for a team when it is created (src/admin.js).
 *
 * - `browser`: Cloudflare's hosted Browser Run MCP server, with an API token of the account
 *   (BROWSER_RUN_TOKEN, Browser Run Write only): fetch pages as markdown or HTML, screenshots,
 *   PDFs, links, elements by selector, JSON extraction, crawls. Each call loads the page anew;
 *   there is no browser to click around in.
 * - `github`: GitHub's MCP server, read-only, as the opspile GitHub App (src/github.js), on
 *   the repositories it is installed on, for each installation the admin team allowed. One
 *   server per allowed installation: `github`, or `github_<account>` when there are several.
 * - `fluffyjaws`: FluffyJaws' MCP server (Adobe's internal search and support assistant: its
 *   knowledge, Slack, the wiki, Jira, GitHub, support tickets), as a person a member of the
 *   admin team connected once, or as a FluffyJaws service app (src/agent/fluffyjaws.js). Off for
 *   new teams: the agents of a team where it is on see what that person sees there.
 * - `slack_channels`: the slack-automation relay's channel management in Slack (AEM Ops
 *   Automation), through the service binding SLACK_MCP (src/agent/slackmcp.js): who is in a
 *   channel, and guest and Slack Connect invitations, adding, removing, disconnecting and
 *   archiving, at once and without a confirmation. Off for new teams, on Slack only, and only
 *   the admin team switches it.
 *
 * A server marked `admins` is switched by the admin team only; one with `platforms` is listed
 * for agents whose thread is on one of them only. One with a `guide(target, ns)` has rules of its
 * own in the agent's prompt (src/agent/mcp.js), beyond the instructions `describeNamespace`
 * shows. Only these definitions reach a service binding (a connection's `fetch`): a team's or
 * a customer's server is a row of `mcp_servers`, with a URL on the internet.
 *
 * A server's agents see it as `mcp__<name>`, like the team's and the customer's servers
 * (src/agent/mcp.js); its id there is `global:<key>`.
 */

export const BROWSER_MCP_URL = 'https://browser.mcp.cloudflare.com/mcp';
export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/readonly';
const GITHUB_TOOLSETS = 'context,repos,issues,pull_requests,actions,discussions';

export const GLOBAL_SERVERS = [
  {
    server: 'browser',
    title: 'Cloudflare Browser Run',
    description: 'Cloudflare Browser Run\'s MCP server: load a web page in a real Chrome and get'
      + ' it as markdown or HTML, a screenshot or a PDF, its links, elements by CSS selector, or'
      + ' JSON extracted from it; or crawl a site',
    instructions: 'Each call loads the page anew, in a browser signed in nowhere: there is no'
      + ' session to click through. get_url_markdown is the cheapest way to read a page;'
      + ' start_crawl is for whole sites (then get_crawl_result).',
    // The account's own sessions are not the agents' business.
    exclude: ['list_browser_sessions', 'kill_browser_session'],
    newTeams: true,
  },
  {
    server: 'github',
    title: 'GitHub (read-only)',
    description: 'GitHub\'s MCP server, read-only: code, commits, issues, pull requests, Actions'
      + ' runs and discussions of the repositories the opspile GitHub App is installed on',
    instructions: 'Only the repositories the opspile GitHub App is installed on can be read; a'
      + ' repository that is not found is one it is not installed on.',
    newTeams: true,
  },
  {
    server: 'fluffyjaws',
    title: 'FluffyJaws',
    description: 'FluffyJaws\' MCP server, Adobe\'s internal support assistant: searches its'
      + ' knowledge (FluffyPack), product documentation, Slack, the wiki, Jira, GitHub code and'
      + ' support tickets, and answers questions about them',
    instructions: 'FluffyJaws is Adobe\'s own, internal system: searching it for this customer\'s'
      + ' errors, tickets or products is what it is for. It answers as the person who connected'
      + ' it (or as opspile\'s service app), with what they may see, which is about every customer:'
      + ' never quote another customer\'s name or data into this thread.',
    // Saves a conversation at FluffyJaws: agents only read there.
    exclude: ['content_compass_recommend'],
    newTeams: false,
  },
  {
    server: 'slack_channels',
    title: 'Slack channel management',
    description: 'The slack-automation relay\'s MCP server (AEM Ops Automation): who is in a'
      + ' Slack channel and how, one person\'s account, and guest and Slack Connect invitations,'
      + ' adding and removing people, disconnecting organisations and archiving channels, at once',
    instructions: SLACK_INSTRUCTIONS,
    guide: slackGuide,
    platforms: ['slack'],
    admins: true,
    newTeams: false,
  },
];

const BY_NAME = new Map(GLOBAL_SERVERS.map((g) => [g.server, g]));
export const isGlobalServer = (server) => BY_NAME.has(String(server));

/** `github_<account>`, as a script can name it. */
const githubName = (account) => `github_${String(account).toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;

/**
 * The instances of a global server, as `{ instances: [{ key, name, account? }], problem }`;
 * `problem` says why there are none.
 */
export async function instancesOf(env, server) {
  if (server === 'browser') {
    if (!env.BROWSER_RUN_TOKEN) {
      return { instances: [], problem: 'BROWSER_RUN_TOKEN is not set in this deployment.' };
    }
    return { instances: [{ key: 'browser', name: 'browser' }], problem: null };
  }
  if (server === 'github') {
    const app = await currentApp(env).catch(() => null);
    if (!app) {
      return { instances: [], problem: 'There is no GitHub App yet: the admin team creates it.' };
    }
    let all;
    try {
      all = (await installationsWithApprovals(env, app)).filter((i) => !i.suspended);
    } catch (e) {
      return { instances: [], problem: `GitHub did not list the app's installations: ${e.message}` };
    }
    const list = all.filter((i) => i.approved);
    if (!all.length) {
      return { instances: [], problem: `The GitHub App ${app.slug} is not installed on any repository yet.` };
    }
    if (!list.length) {
      return {
        instances: [],
        problem: `The GitHub App ${app.slug} is installed on ${all.map((i) => i.account).join(', ')}, but the admin team has not allowed any installation yet.`,
      };
    }
    return {
      instances: list.map((i) => ({
        key: `github:${i.id}`,
        name: list.length === 1 ? 'github' : githubName(i.account),
        account: i.account,
        installationId: i.id,
      })),
      problem: null,
    };
  }
  if (server === 'fluffyjaws') {
    return fluffyInstances(env);
  }
  if (server === 'slack_channels') {
    return slackInstances(env);
  }
  return { instances: [], problem: 'unknown server' };
}

/** The switch rows of a team and a channel, by server: `{ team, channel }`, each a row or null. */
export async function switchesFor(env, { team, channelId }) {
  const { results } = await env.DB.prepare(`SELECT server, scope, target, enabled, changed_by,
      changed_at FROM mcp_global_switches
    WHERE (scope = 'team' AND target = ?) OR (scope = 'channel' AND target = ?)`)
    .bind(team || '', channelId || '').all();
  const out = new Map(GLOBAL_SERVERS.map((g) => [g.server, { team: null, channel: null }]));
  for (const r of results || []) {
    if (out.has(r.server)) {
      out.get(r.server)[r.scope] = r;
    }
  }
  return out;
}

/**
 * Sets a global server's switch for a team or a channel, as `by` (a name), now; `enabled: null`
 * lets a channel follow its team again. Resolves to the switch, or null when it was removed.
 */
export async function setGlobalSwitch(env, {
  server, scope, target, enabled, by,
}) {
  if (enabled === null) {
    await env.DB.prepare(`DELETE FROM mcp_global_switches WHERE server = ? AND scope = ?
      AND target = ?`).bind(server, scope, target).run();
    return null;
  }
  const at = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO mcp_global_switches (server, scope, target, enabled,
      changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (server, scope, target) DO UPDATE SET enabled = excluded.enabled,
      changed_by = excluded.changed_by, changed_at = excluded.changed_at`)
    .bind(server, scope, target, enabled ? 1 : 0, by, at).run();
  return { enabled: Boolean(enabled), by, at };
}

/** Whether a global server is on: the channel's switch if it has one, else the team's. */
export const effective = ({ team, channel }) => Boolean((channel || team || {}).enabled);

/** Whether a global server is for a thread on `source` (one without `platforms` is for all). */
export const forSource = (g, source) => !g.platforms || g.platforms.includes(source);

/**
 * The global servers on for an agent's target (its team, channel and platform: `source`; a
 * server with `platforms` needs one of them), as `mcp_servers`-shaped
 * entries: `{ id: 'global:<key>', scope: 'global', slug: <server>, name, description, allow,
 * updated_at }`. `updated_at` changes with the switch and the last check, so the agent's
 * catalog follows both.
 */
export async function globalServersFor(env, target) {
  const switches = await switchesFor(env, target);
  const on = GLOBAL_SERVERS.filter((g) => effective(switches.get(g.server))
    && forSource(g, target.source));
  if (!on.length) {
    return [];
  }
  const { results: checks } = await env.DB.prepare('SELECT server, checked_at FROM mcp_global_tools').all();
  const checkedAt = new Map((checks || []).map((c) => [c.server, c.checked_at]));
  const out = [];
  for (const g of on) {
    const s = switches.get(g.server);
    const at = (s.channel || s.team).changed_at;
    // eslint-disable-next-line no-await-in-loop
    const { instances } = await instancesOf(env, g.server);
    for (const i of instances) {
      out.push({
        id: `global:${i.key}`,
        scope: 'global',
        slug: g.server,
        name: i.name,
        url: null,
        description: i.account ? `${g.description} (on ${i.account})` : g.description,
        allow: null,
        updated_at: `${at}|${checkedAt.get(i.key) || ''}`,
      });
    }
  }
  return out;
}

/**
 * A global server to connect to, by its id (`global:<key>`): `{ id, name, url, headers,
 * expiresAt?, authProvider?, fetch? }`, null when it is gone. `authProvider` (fluffyjaws) gives
 * the transport a token before each request, and another when the server refuses it; `fetch`
 * (slack_channels) is how its requests go, through a service binding.
 */
export async function globalConnection(env, id) {
  const key = String(id).replace(/^global:/, '');
  if (key === 'browser') {
    return env.BROWSER_RUN_TOKEN ? {
      id,
      name: 'browser',
      url: BROWSER_MCP_URL,
      headers: { Authorization: `Bearer ${env.BROWSER_RUN_TOKEN}` },
    } : null;
  }
  if (key === 'fluffyjaws') {
    return fluffyConnection(env, id);
  }
  if (key === 'slack_channels') {
    return slackConnection(env, id);
  }
  const m = /^github:(\d+)$/.exec(key);
  if (m) {
    const app = await currentApp(env);
    if (!app || !await approved(env, app, Number(m[1]))) {
      return null;
    }
    const { token, expiresAt } = await installationToken(env, app, Number(m[1]));
    return {
      id,
      name: 'github',
      url: GITHUB_MCP_URL,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-MCP-Readonly': 'true',
        'X-MCP-Toolsets': GITHUB_TOOLSETS,
        // Hides public issue content from people without push access: text from strangers
        // that nobody screened for prompt injection.
        'X-MCP-Lockdown': 'true',
      },
      expiresAt,
    };
  }
  return null;
}

/** What the last check of an instance found: `{ tools, instructions, checkedAt, error }`. */
export async function storedTools(env, key) {
  const row = await env.DB.prepare('SELECT * FROM mcp_global_tools WHERE server = ?')
    .bind(key).first();
  return row && {
    tools: row.tools ? JSON.parse(row.tools) : [],
    instructions: row.instructions || null,
    checkedAt: row.checked_at,
    error: row.check_error,
  };
}

/** Keeps what a check of an instance found: the tools as the server reported them, or the error. */
export async function storeTools(env, key, res) {
  const tools = (res.tools || []).map((t) => ({
    name: t.name,
    ...(t.title ? { title: t.title } : {}),
    description: t.description || '',
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }));
  await env.DB.prepare(`INSERT INTO mcp_global_tools (server, tools, instructions, checked_at,
      check_error) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (server) DO UPDATE SET tools = excluded.tools, instructions = excluded.instructions,
      checked_at = excluded.checked_at, check_error = excluded.check_error`).bind(
    key,
    res.error ? null : JSON.stringify(tools),
    res.instructions || null,
    new Date().toISOString(),
    res.error ? String(res.error).slice(0, 500) : null,
  ).run();
}

/** The definition of a global server. */
export const globalServer = (server) => BY_NAME.get(String(server)) || null;

/**
 * A global server's rules in the prompt of an agent on `target`, whose scripts call it as
 * `mcp__<ns>`, if it has any.
 */
export function globalGuide(server, target, ns) {
  const g = globalServer(server);
  return g && g.guide ? g.guide(target || {}, ns) : null;
}

/** The tools of a global server agents may call: all but those it excludes. */
export function usableTools(server, tools) {
  const exclude = new Set((globalServer(server) || {}).exclude || []);
  return (tools || []).filter((t) => !exclude.has(t.name));
}
