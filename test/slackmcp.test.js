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

import assert from 'node:assert/strict';
import {
  after, before, beforeEach, describe, it,
} from 'node:test';
import { api } from '../src/api.js';
import { refreshGlobalTools } from '../src/mcpadmin.js';
import { AgentMcp, mcpSection } from '../src/agent/mcp.js';
import { serversFor } from '../src/agent/mcpclient.js';
import { SLACK_MCP_URL, slackGuide } from '../src/agent/slackmcp.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up people, teams, orgs, channels, users and addresses only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin', 'helix'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
};
const asMe = (p, roles = {}) => ({ ...p, teams: p.teams.map((slug) => ({ slug, role: roles[slug] || 'member' })) });
const admin = asMe(ADA);
const manager = asMe(BO, { helix: 'manager' });

const TOOLS = [
  { name: 'channel_profile', kind: 'read' },
  { name: 'person_status', kind: 'read' },
  { name: 'invite_guest', kind: 'write' },
  { name: 'add_to_channel', kind: 'write' },
  { name: 'remove_from_channel', kind: 'write' },
  { name: 'invite_slack_connect', kind: 'write' },
  { name: 'disconnect_org', kind: 'write' },
  { name: 'archive_channel', kind: 'write' },
];

/**
 * The relay's `SlackMcp` entrypoint as a service binding: stateless JSON-RPC over Streamable
 * HTTP, as slack-automation's relay/src/slack-mcp.mjs answers (JSON for every POST, 202 for a
 * notification, 405 for anything else, any URL). `requests` records what reached it.
 */
function relayBinding() {
  const requests = [];
  const reply = (id, result) => Response.json({ jsonrpc: '2.0', id, result });
  return {
    requests,
    async fetch(request) {
      assert.ok(request instanceof Request, 'a Request, as a service binding takes it');
      if (request.method !== 'POST') {
        requests.push({ method: request.method });
        return new Response(null, { status: 405, headers: { allow: 'POST' } });
      }
      const msg = await request.json();
      requests.push({
        method: 'POST', rpc: msg.method, via: request.headers.get('x-mcp-via'), url: request.url,
      });
      if (msg.id === undefined) {
        return new Response(null, { status: 202 });
      }
      if (msg.method === 'initialize') {
        return reply(msg.id, {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'slack-automation-relay', version: '1.0.0' },
          instructions: 'Channel management for the workspace. Pass asked_by and reason on every write.',
        });
      }
      if (msg.method === 'tools/list') {
        return reply(msg.id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: `${t.name}, made up`,
            inputSchema: {
              type: 'object',
              properties: {
                channel: { type: 'string' },
                email: { type: 'string' },
                ...(t.kind === 'write' ? { asked_by: { type: 'string' }, reason: { type: 'string' } } : {}),
              },
            },
            annotations: { readOnlyHint: t.kind === 'read', destructiveHint: t.name === 'archive_channel' },
          })),
        });
      }
      if (msg.method === 'tools/call') {
        const result = { done: true, tool: msg.params.name, args: msg.params.arguments };
        return reply(msg.id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
      }
      return Response.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
    },
  };
}

// Nothing of this goes to the internet: a request that does is recorded, and refused.
const realFetch = globalThis.fetch;
const outside = [];
before(() => {
  globalThis.fetch = async (input, init) => {
    outside.push(new Request(input, init).url);
    return new Response('not here', { status: 404 });
  };
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  outside.length = 0;
});

function env({ bound = true } = {}) {
  const DB = d1({
    people: [ADA, BO],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }],
  });
  DB.sqlite.prepare(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
    VALUES ('kb-team-helix', 'team', 'helix', 'test', '2026-10-22T00:00:00Z')`).run();
  const thread = DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id,
      org, team, kind, channel_name, path, last_at, updated_at) VALUES (?, ?, 'E1', ?, '1.0', 'acme',
      'helix', 'channel', ?, 'p/', '2026-10-25T10:00:00Z', '2026-10-25T10:00:00Z')`);
  thread.run('slack:E1:C1:1.0', 'slack', 'C1', 'aem-acme');
  thread.run('teams:E1:19x:1.0', 'teams', '19x', 'Acme support');
  return { DB, TOKEN_KEY: Buffer.alloc(32, 5).toString('base64url'), ...(bound ? { SLACK_MCP: relayBinding() } : {}) };
}

async function call(e, me, method, path, body) {
  const url = `https://opspile.example${path}`;
  const request = new Request(url, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const res = await quiet(() => api(request, e, new URL(url), { viewer: me }));
  return { status: res.status, body: await res.json() };
}

function memoryStorage() {
  const m = new Map();
  return {
    get: async (k) => structuredClone(m.get(k)),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
  };
}

const slackOf = (globals) => globals.find((g) => g.server === 'slack_channels');
const SLACK_TARGET = {
  team: 'helix', org: 'acme', channelId: 'C1', source: 'slack',
};

describe('the global slack_channels MCP server', () => {
  it('is listed off, and not set up where the relay is not bound', async () => {
    const e = env();
    const listed = slackOf((await call(e, manager, 'GET', '/api/kb/mcp?repo=kb-team-helix')).body.globals);
    assert.equal(listed.available, true);
    assert.deepEqual(listed.team, { enabled: false });
    assert.deepEqual(listed.platforms, ['slack']);
    assert.equal(listed.admins, true);
    assert.equal(listed.may, false, 'a team manager does not switch it');
    assert.equal(slackOf((await call(e, admin, 'GET', '/api/kb/mcp?repo=kb-team-helix')).body.globals).may, true);
    assert.deepEqual(await serversFor(e, SLACK_TARGET), [], 'off until someone turns it on');

    const unbound = slackOf((await call(env({ bound: false }), admin, 'GET', '/api/kb/mcp?repo=kb-team-helix')).body.globals);
    assert.equal(unbound.available, false);
    assert.match(unbound.problem, /SLACK_MCP/);
  });

  it('is switched by the admin team only, and only for agents of Slack threads', async () => {
    const e = env();
    const put = (me, body) => call(e, me, 'PUT', '/api/kb/mcp/global', { server: 'slack_channels', ...body });
    assert.equal((await put(manager, { team: 'helix', enabled: true })).status, 403);
    assert.equal((await put(manager, { channel: 'C1', enabled: true })).status, 403);
    assert.equal((await put(admin, { channel: 'C1', enabled: true })).status, 200);

    const ids = async (target) => (await serversFor(e, target)).map((s) => s.id);
    assert.deepEqual(await ids(SLACK_TARGET), ['global:slack_channels']);
    assert.deepEqual(await ids({ ...SLACK_TARGET, channelId: 'C2' }), [], 'another channel of the team');
    // On for the whole team: still not for its Teams threads, nor for an agent without a thread.
    assert.equal((await put(admin, { team: 'helix', enabled: true })).status, 200);
    assert.deepEqual(await ids({
      team: 'helix', org: 'acme', channelId: '19x', source: 'teams',
    }), []);
    assert.deepEqual(await ids({ team: 'helix', org: 'acme' }), []);
    assert.deepEqual(await ids({ ...SLACK_TARGET, channelId: 'C2' }), ['global:slack_channels']);
  });

  it('reaches the relay through the binding, never the internet, and tells the agent how to use it', async () => {
    const e = env();
    const checked = await call(e, admin, 'POST', '/api/kb/mcp/global/check', { server: 'slack_channels' });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.deepEqual(checked.body.checked, [{
      name: 'slack_channels', tools: 8, error: null, server: { name: 'slack-automation-relay', version: '1.0.0' },
    }]);
    await call(e, admin, 'PUT', '/api/kb/mcp/global', { server: 'slack_channels', channel: 'C1', enabled: true });

    const mcp = new AgentMcp(e, memoryStorage());
    const { catalog } = await mcp.refresh(SLACK_TARGET);
    const [server] = catalog.servers;
    assert.equal(server.ns, 'slack_channels');
    assert.deepEqual(server.tools.map((t) => t.name), TOOLS.map((t) => t.name), 'all of them');
    assert.deepEqual(server.tools.filter((t) => t.readOnly).map((t) => t.name), ['channel_profile', 'person_status']);
    assert.match(server.instructions, /asked_by/);
    const section = mcpSection(catalog);
    assert.match(section, /mcp__slack_channels \(global, opspile's own\)/);
    assert.match(section, /Your channel is the Slack channel C1/);
    assert.match(section, /pass asked_by, the Slack user id \(U…\) of the person who asked/);
    assert.match(section, /this replaces "never use a server to act on the customer's behalf" above/);

    const res = await mcp.call(server, 'invite_guest', {
      email: 'new.person@acme.example', channel: 'C1', asked_by: 'U0MADEUP1', reason: 'Asked in the thread.',
    });
    assert.equal(res.isError, false);
    assert.deepEqual(res.structuredContent.args, {
      email: 'new.person@acme.example', channel: 'C1', asked_by: 'U0MADEUP1', reason: 'Asked in the thread.',
    });

    const { requests } = e.SLACK_MCP;
    assert.deepEqual(outside, [], 'nothing went to the internet');
    assert.ok(requests.every((r) => r.method === 'POST'), 'no GET stream reaches the relay');
    assert.ok(requests.every((r) => r.via === 'opspile' && r.url === SLACK_MCP_URL));
    assert.ok(requests.some((r) => r.rpc === 'tools/call'));
  });

  it('is checked by the cron with the other global servers', async () => {
    const e = env();
    assert.deepEqual((await quiet(() => refreshGlobalTools(e))).slack_channels, ['slack_channels: 8 tools']);
    assert.ok(e.SLACK_MCP.requests.every((r) => r.rpc !== 'tools/call'), 'listing calls no tool');
  });

  it('cannot be reached by a team\'s server, whatever its URL', async () => {
    const e = env();
    e.DB.sqlite.prepare(`INSERT INTO mcp_servers (scope, slug, name, url, enabled, updated_at)
      VALUES ('team', 'helix', 'sneaky', ?, 1, 'x')`).run(SLACK_MCP_URL);
    const mcp = new AgentMcp(e, memoryStorage());
    const { catalog } = await quiet(() => mcp.refresh(SLACK_TARGET));
    assert.deepEqual(catalog.servers.map((s) => s.name), ['sneaky']);
    assert.ok(catalog.servers[0].error, 'its URL is a name on the internet');
    assert.deepEqual(e.SLACK_MCP.requests, [], 'the binding was never asked');
    assert.ok(outside.includes(SLACK_MCP_URL));
  });

  it('names the thread\'s Slack channel, or says there is none', () => {
    assert.match(slackGuide(SLACK_TARGET), /Slack channel C1/);
    assert.match(slackGuide({ source: 'teams', channelId: '19x' }), /not on Slack/);
    assert.match(slackGuide(SLACK_TARGET, 'slack_channels_team'), /^mcp__slack_channels_team manages/);
  });
});
