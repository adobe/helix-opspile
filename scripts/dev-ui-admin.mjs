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

import { admin } from '../src/admin.js';
import { kbAdmin } from '../src/kbadmin.js';
import { consume } from '../src/normalizer.js';
import { d1 } from '../test/d1.js';
import { fakeBucket } from '../test/fakes.js';
import { fakeMcpServers } from '../test/mcp-server.js';

/**
 * The admin pages (`/inbox/admin`) for `npm run ui:dev`: the real src/admin.js over an
 * in-memory D1 with the production migrations (test/d1.js), seeded from the fake inbox's
 * teams, people and threads. Re-filing jobs run at once on a fake pile 2. Made-up data only.
 *
 * The agents' MCP servers (the editor's "MCP servers"): a few made-up ones answer in memory at
 * `https://*.mcp.example` and `https://status.acme.example` (test/mcp-server.js), so adding and
 * checking a server works in the preview; any other `.example` URL fails the check, as an
 * unreachable server would.
 */

const PREVIEW_TOKEN = 'preview-token';
const tools = (list, property) => list.map(([name, description, readOnly]) => ({
  name,
  description,
  readOnly,
  inputSchema: { type: 'object', properties: { [property]: { type: 'string' } } },
  run: () => 'ok',
}));
const MCP = fakeMcpServers([
  {
    url: 'https://docs.mcp.example/mcp',
    name: 'docs',
    token: PREVIEW_TOKEN,
    tools: tools([
      ['search_docs', 'Search the product documentation', true],
      ['read_page', 'Read one documentation page as markdown', true],
      ['list_releases', 'Release notes of the last 90 days', true],
    ], 'query'),
  },
  {
    url: 'https://cdn.mcp.example/mcp',
    name: 'cdn',
    token: PREVIEW_TOKEN,
    tools: tools([
      ['purge_status', 'Status of recent purges for a host', true],
      ['cache_headers', 'The cache headers a URL is served with', true],
      ['purge', 'Purge a path from the CDN', false],
    ], 'host'),
  },
  {
    url: 'https://status.acme.example/mcp',
    name: 'acme-status',
    tools: tools([
      ['site_status', 'Uptime and error rate of an ACME site', true],
      ['open_incidents', 'Incidents ACME has open on their side', true],
    ], 'site'),
  },
]);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const { url } = new Request(input);
  if (MCP.handles(url)) {
    return MCP.fetch(input, init);
  }
  if (/^https:\/\/[^/]*\.example\//.test(url)) {
    return Promise.reject(new Error(`getaddrinfo ENOTFOUND ${new URL(url).hostname}`));
  }
  return realFetch(input, init);
};

const auth = [{ name: 'Authorization', value: `Bearer ${PREVIEW_TOKEN}` }];
const SEED_MCP = [
  {
    repo: 'kb-team-platform', name: 'docs', url: 'https://docs.mcp.example/mcp', description: 'Product documentation search', headers: auth,
  },
  {
    repo: 'kb-team-platform',
    name: 'cdn',
    url: 'https://cdn.mcp.example/mcp',
    description: 'Purge status and cache headers of the CDN',
    headers: auth,
    allow: 'purge_status, cache_headers',
  },
  {
    repo: 'kb-team-platform',
    name: 'tickets',
    url: 'https://tickets.internal.example/mcp',
    description: 'The ticket tracker',
    headers: [{ name: 'X-Api-Key', value: 'preview' }],
  },
  {
    repo: 'kb-org-acme', name: 'acme-status', url: 'https://status.acme.example/mcp', description: 'ACME\'s own status service: uptime and their open incidents',
  },
];

export function createAdmin(store, { manager = false, bases = [] } = {}) {
  const DB = d1({
    teams: [{ slug: 'admin', name: 'Admin' }, ...store.teams.map(({ slug, name }) => ({ slug, name }))],
    people: [...store.people.values()].map((p) => ({
      id: p.id,
      email: p.email,
      name: p.name,
      staff: p.staff ? 1 : 0,
      teams: [...store.teams.filter((t) => t.members.includes(p.id)).map((t) => t.slug), ...(p.id === 1 ? ['admin'] : [])],
    })),
    rules: [
      {
        id: 1, target: 'org', priority: 100, source: null, field: 'name', pattern: '^aem-(.+)$', value: '$1',
      },
      {
        id: 2, target: 'team', priority: 100, source: null, field: 'name', pattern: '^aem-', value: 'platform',
      },
    ],
  });
  const CHANNELS = fakeBucket();
  const seen = new Set();
  for (const { row } of store.threads.values()) {
    const ch = `${row.source}:${row.tenant}:${row.channel_id}`;
    if (!seen.has(ch)) {
      seen.add(ch);
      DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
        VALUES (?, ?, ?, ?, ?)`).run(row.source, row.tenant, row.channel_id, row.channel_name, row.updated_at || row.any_at);
    }
    const path = `channels/${row.org}/${row.team}/${row.source}-${row.channel_id}/${row.root_id}/`;
    DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, channel_name, path, root_at, last_at, any_at, messages, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...[
      row.thread, row.source, row.tenant, row.channel_id, row.root_id, row.org, row.team,
      row.kind || 'channel', row.channel_name, path, row.root_at, row.last_at, row.any_at,
      row.messages || 1, row.any_at,
    ]);
    CHANNELS.objects.set(`${path}${row.root_id}.md`, { body: '---\n---\n', options: {} });
  }
  // The fake channels are filed by hand, not by the rules: make the rules say the same, so a
  // change tried in the preview only moves what it should.
  const rule = DB.sqlite.prepare(`INSERT INTO rules (target, priority, source, field, pattern, value, note)
    VALUES (?, ?, ?, 'channel_id', ?, ?, ?)`);
  const kinds = new Map();
  for (const { row } of store.threads.values()) {
    kinds.set(row.channel_id, row);
  }
  for (const [id, row] of kinds) {
    const pattern = `^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    if (!/^aem-/.test(row.channel_name)) {
      rule.run('team', 10, row.source, pattern, row.team, 'manual assignment');
      rule.run('org', 10, row.source, pattern, row.org, 'manual assignment');
    } else if (row.team !== 'platform') {
      rule.run('team', 10, row.source, pattern, row.team, 'manual assignment');
    }
    if (row.kind && row.kind !== 'channel') {
      rule.run('kind', 10, row.source, pattern, row.kind, null);
    }
  }
  DB.sqlite.exec(`INSERT INTO orgs (slug, name, type, icon, updated_at) VALUES
    ('acme', 'ACME Corporation', 'customer', 'acme.example', '2026-10-20T09:00:00Z'),
    ('initech', 'Initech', 'vendor', NULL, '2026-10-20T09:00:00Z')`);

  // The knowledge bases of the fake editor (dev-ui-kb.mjs), so its channel and agent routes
  // (src/kbadmin.js) find them; agents are "configured", and on in one channel by default.
  for (const b of bases) {
    DB.sqlite.prepare(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
      VALUES (?, ?, ?, 'dev', ?)`).run(b.repo, b.kind, b.slug, b.created_at);
  }
  const queued = [];
  const env = {
    DB,
    CHANNELS,
    NORMALIZE: { send: async (body) => queued.push(body) },
    AGENTS: {},
    AGENT_MODEL: 'dev',
    AGENT_CHANNELS: 'C0ACMEAEM',
    // Seals the MCP servers' headers; made up for the preview.
    TOKEN_KEY: Buffer.alloc(32, 9).toString('base64url'),
  };
  // Dana is in the admin team here, or (`--manager`) only the manager of Edge ops.
  if (manager) {
    DB.sqlite.exec("DELETE FROM team_members WHERE team = 'admin' AND person = 1; UPDATE team_members SET role = 'manager' WHERE team = 'edge' AND person = 1");
  }
  const me = manager
    ? {
      ...store.me, admin: false, teams: store.me.teams.map((t) => ({ ...t, role: t.slug === 'edge' ? 'manager' : 'member' })), manages: ['edge'],
    }
    : { ...store.me, admin: true, teams: [...store.me.teams, { slug: 'admin', name: 'Admin' }] };

  const toRequest = (req, url, body) => new Request(url, {
    method: req.method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  // The preview's MCP servers, added once as the admin team would.
  const admins = { ...store.me, admin: true, teams: [{ slug: 'admin', name: 'Admin' }] };
  const mcpUrl = new URL('http://localhost/api/kb/mcp');
  const seeded = SEED_MCP.reduce((done, body) => done.then(() => kbAdmin(
    toRequest({ method: 'POST' }, mcpUrl, body),
    env,
    mcpUrl,
    admins,
  )), Promise.resolve());
  /** `/api/kb`, its channels, agents and MCP servers, by the real src/kbadmin.js. */
  const kb = async (req, url, body) => {
    await seeded;
    return kbAdmin(toRequest(req, url, body), env, url, me);
  };

  return Object.assign(async (req, url, body) => {
    const res = await admin(toRequest(req, url, body), env, url, me);
    // Re-filing runs right away here.
    while (queued.length) {
      const messages = queued.splice(0).map((b) => ({ body: b, ack() {}, retry() {} }));
      // eslint-disable-next-line no-await-in-loop
      await consume({ messages }, env);
    }
    return res;
  }, { kb });
}
