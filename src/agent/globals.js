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

/**
 * Global MCP servers: set up once for the whole deployment, not per team or customer, and
 * turned on for an ops team or a single channel (`mcp_global_switches`; a channel's switch
 * wins over its team's, and both are off until someone turns them on).
 *
 * - `browser`: Cloudflare Browser Run through Chrome DevTools MCP. Each agent gets a browser
 *   box of its own (src/agent/browser.js): a container running chrome-devtools-mcp, whose
 *   browser is a Browser Run session reached through the Worker's BROWSER binding.
 * - `github`: GitHub's MCP server, read-only, as the opspile GitHub App (src/github.js), on
 *   the repositories it is installed on, for each installation the admin team allowed. One
 *   server per allowed installation: `github`, or `github_<account>` when there are several.
 *
 * A server's agents see it as `mcp__<name>`, like the team's and the customer's servers
 * (src/agent/mcp.js); its id there is `global:<key>`.
 */

export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/readonly';
const GITHUB_TOOLSETS = 'context,repos,issues,pull_requests,actions,discussions';

export const GLOBAL_SERVERS = [
  {
    server: 'browser',
    title: 'Cloudflare Browser Run',
    description: 'A Chrome browser in Cloudflare Browser Run, driven through Chrome DevTools MCP:'
      + ' open pages, read their accessibility snapshot, take screenshots, check console'
      + ' messages and network requests, and record performance traces',
    instructions: 'Every thread has a browser of its own; it is not signed in anywhere and'
      + ' forgets everything after ten idle minutes. Most tools take a pageId: call list_pages'
      + ' first, then navigate_page, then take_snapshot to find the uid of an element.',
  },
  {
    server: 'github',
    title: 'GitHub (read-only)',
    description: 'GitHub\'s MCP server, read-only: code, commits, issues, pull requests, Actions'
      + ' runs and discussions of the repositories the opspile GitHub App is installed on',
    instructions: 'Only the repositories the opspile GitHub App is installed on can be read; a'
      + ' repository that is not found is one it is not installed on.',
  },
];

const BY_NAME = new Map(GLOBAL_SERVERS.map((g) => [g.server, g]));
export const isGlobalServer = (server) => BY_NAME.has(String(server));

let boxNamespace = () => null;

/** Where the browser boxes live: the Worker's own `BrowserBox` namespace (set in src/index.js). */
export function useBoxes(namespace) {
  boxNamespace = typeof namespace === 'function' ? namespace : () => namespace;
}

const boxes = (env) => env.BROWSER_BOXES || boxNamespace();

/** `github_<account>`, as a script can name it. */
const githubName = (account) => `github_${String(account).toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;

/**
 * The instances of a global server, as `{ instances: [{ key, name, account? }], problem }`;
 * `problem` says why there are none.
 */
export async function instancesOf(env, server) {
  if (server === 'browser') {
    if (!env.BROWSER || !boxes(env)) {
      return { instances: [], problem: 'Browser Run is not bound to this deployment (BROWSER).' };
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

/** Whether a global server is on: the channel's switch if it has one, else the team's. */
export const effective = ({ team, channel }) => Boolean((channel || team || {}).enabled);

/**
 * The global servers on for an agent's target (its team and channel), as `mcp_servers`-shaped
 * entries: `{ id: 'global:<key>', scope: 'global', slug: <server>, name, description, allow,
 * updated_at }`. `updated_at` changes with the switch and the last check, so the agent's
 * catalog follows both.
 */
export async function globalServersFor(env, target) {
  const switches = await switchesFor(env, target);
  const on = GLOBAL_SERVERS.filter((g) => effective(switches.get(g.server)));
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
 * fetch?, expiresAt? }`, null when it is gone. `agent` names the browser box: one per agent.
 */
export async function globalConnection(env, id, { agent } = {}) {
  const key = String(id).replace(/^global:/, '');
  if (key === 'browser') {
    const ns = boxes(env);
    if (!env.BROWSER || !ns) {
      return null;
    }
    const box = ns.getByName(agent || 'opspile-check');
    return {
      id,
      name: 'browser',
      url: 'http://box/mcp',
      headers: {},
      fetch: (input, init) => box.fetch(new Request(input, init)),
    };
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
