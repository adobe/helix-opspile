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

/*
 * Tools a thread agent asks for in its sidebar (src/toolrequests.js, src/agent/toolrequest.js):
 * what it may ask for, its request_tool, a person's Grant, Deny and End now, and what a grant
 * gives the agent: its switchable tools (toolsFor) and its MCP servers (serversFor).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { api } from '../src/api.js';
import { toolsFor } from '../src/agent/agenttools.js';
import { serversFor, serverWithHeaders } from '../src/agent/mcpclient.js';
import { requestableFor, requestableText, requestTool } from '../src/agent/toolrequest.js';
import { MAX_OPEN, toolRequestOf } from '../src/toolrequests.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, teams, channels and ids only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'helix' }],
};
const EVE = {
  id: 3, email: 'eve@staff.example', name: 'Eve', teams: [{ slug: 'other' }],
};
const THREAD = 'slack:E1:C1:1.1';
const SIDEBAR = 'sb_00000000-0000-4000-8000-000000000001';
const TARGET = {
  key: THREAD, team: 'helix', org: 'acme', channelId: 'C1', source: 'slack', threads: [THREAD],
};

function env() {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'other', name: 'Other' }],
    people: [
      {
        id: 1, email: ADA.email, name: 'Ada', staff: 1, teams: ['helix'],
      },
      {
        id: 3, email: EVE.email, name: 'Eve', staff: 1, teams: ['other'],
      },
    ],
  });
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
    kind, channel_name, path, root_at, last_at, any_at, messages, updated_at) VALUES (?, 'slack',
    'E1', 'C1', '1.1', 'acme', 'helix', 'channel', 'aem-acme', 'p/1.1/', '2026-10-21T10:00:00Z',
    '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z', 1, '2026-10-21T10:00:00Z')`).run(THREAD);
  DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff,
    counted, author_key) VALUES ('slack', 'E1', 'C1', '1.1', ?, '2026-10-21T10:00:00Z', 0, 1,
    'slack:E1:U9')`).run(THREAD);
  DB.sqlite.prepare(`INSERT INTO sidebar_messages (id, thread, role, person, body, at)
    VALUES (?, ?, 'person', 1, 'Can you look it up?', '2026-10-21T10:05:00Z')`).run(SIDEBAR, THREAD);
  // The team's servers: one on everywhere, one off (in every channel).
  DB.sqlite.exec(`INSERT INTO mcp_servers (id, scope, slug, name, url, description, enabled,
      updated_at) VALUES
    (1, 'team', 'helix', 'tickets', 'https://tickets.example/mcp', 'The tickets', 1, 't'),
    (2, 'team', 'helix', 'logs', 'https://logs.example/mcp', 'The logs', 0, 't'),
    (3, 'team', 'other', 'elsewhere', 'https://other.example/mcp', 'Not ours', 0, 't')`);
  const notified = [];
  return {
    DB,
    notified,
    ROOMS: {
      idFromName: (n) => n,
      get: (team) => ({
        fetch: async (u, init) => {
          notified.push({ team, ...JSON.parse(init.body) });
          return new Response(null, { status: 204 });
        },
      }),
    },
    CHANNELS: fakeBucket(),
    STAFF_DOMAINS: 'staff.example',
    SLACK_BOT_TOKEN: 'made-up',
    BROWSER_RUN_TOKEN: 'made-up',
    AGENT_CHANNELS: 'C1',
    AI_GATEWAY_ACCOUNT: 'acct',
    AGENT_GATEWAY: 'gw',
    AGENT_MODEL: 'm',
    BEDROCK_API_KEY: 'k',
  };
}

/** The tools' context of the thread's agent, answering sidebar message `sidebar` (or none). */
const ctxOf = (e, sidebar = SIDEBAR) => ({
  env: e,
  target: async () => TARGET,
  sidebarMessage: async () => sidebar,
});

/** The agents' binding, as the Worker reaches a ThreadAgent: what it was asked, by method. */
function bound(e) {
  const calls = [];
  return {
    calls,
    env: {
      ...e,
      AGENTS: {
        idFromName: (name) => name,
        get: (name) => ({
          __unsafe_ensureInitialized: async () => {},
          sidebar: async (m) => {
            calls.push(['sidebar', name, m]);
            return { ok: true };
          },
          syncTools: async () => { calls.push(['syncTools', name]); },
          syncMcp: async () => { calls.push(['syncMcp', name]); },
        }),
      },
    },
  };
}

const call = (e, who, path, body) => quiet(() => api(
  new Request(`https://opspile.test${path}`, { method: 'POST', body: JSON.stringify(body) }),
  e,
  new URL(`https://opspile.test${path}`),
  { viewer: who },
));

const ask = (e, args, sidebar) => quiet(() => requestTool(ctxOf(e, sidebar), {
  reason: 'Ada asked for the logs of last night, which only this server has.',
  ...args,
}));

describe('what an agent may ask for', () => {
  it('is what its channel does not have, but the admin team\'s own', async () => {
    const e = env();
    const ids = (await requestableFor(e, TARGET)).map((x) => x.id);
    // Off, and working here: posting (a Slack bot), extraction rules, membership needs the
    // admin bots, the computer a Worker Loader, web search Workers AI; read any thread is the
    // admin team's, as is slack_channels.
    assert.deepEqual(ids, ['post_message', 'extraction_rules', 'mcp:2', 'mcp:global:browser']);
    e.DB.sqlite.exec(`INSERT INTO agent_tool_switches (tool, scope, target, enabled, changed_by,
      changed_at) VALUES ('extraction_rules', 'team', 'helix', 1, 'Ada', 't')`);
    assert.ok(!(await requestableFor(e, TARGET)).some((x) => x.id === 'extraction_rules'));
    const text = requestableText(await requestableFor(e, TARGET));
    assert.match(text, /- mcp:2: MCP server logs \(the ops team helix's\)\. The logs/);
    assert.match(requestableText([]), /nothing you could ask for/);
  });

  it('asks only while it answers a sidebar message, once, and a few at a time', async () => {
    const e = env();
    assert.match((await ask(e, { tool: 'mcp:2' }, null)).error, /Only while you answer a sidebar message/);
    assert.match((await ask(e, { tool: 'any_thread' })).error, /not something you can ask for.*mcp:2/);
    assert.match((await ask(e, { tool: 'mcp:2', reason: '' })).error, /say why/);
    const { request } = await ask(e, { tool: 'mcp:2' });
    assert.equal(request.status, 'pending');
    assert.equal(request.sidebar, SIDEBAR);
    assert.deepEqual([request.kind, request.name, request.title], ['server', '2', 'MCP server logs']);
    assert.deepEqual(e.notified.map((n) => n.type), ['sidebar']);
    const again = await ask(e, { tool: 'mcp:2' });
    assert.match(again.error, new RegExp(`Request ${request.id} asks for MCP server logs already`));
    for (const tool of ['post_message', 'extraction_rules', 'mcp:global:browser']) {
      // eslint-disable-next-line no-await-in-loop
      assert.ok((await ask(e, { tool })).request);
    }
    e.DB.sqlite.exec(`INSERT INTO mcp_servers (id, scope, slug, name, url, enabled, updated_at)
      VALUES (4, 'org', 'acme', 'crm', 'https://crm.example/mcp', 0, 't')`);
    assert.ok((await ask(e, { tool: 'mcp:4' })).request);
    assert.match((await ask(e, { tool: 'mcp:1' })).error, /not something/);
    e.DB.sqlite.exec(`INSERT INTO mcp_servers (id, scope, slug, name, url, enabled, updated_at)
      VALUES (5, 'org', 'acme', 'erp', 'https://erp.example/mcp', 0, 't')`);
    assert.match((await ask(e, { tool: 'mcp:5' })).error, new RegExp(`${MAX_OPEN} of your tool requests wait`));
  });
});

describe('a person decides on a tool request', () => {
  it('grants it: the agent has it in its thread for a day, and is told in the sidebar', async () => {
    const { env: e, calls } = bound(env());
    const { request: tool } = await ask(e, { tool: 'extraction_rules' });
    const { request: server } = await ask(e, { tool: 'mcp:2' });
    const { request: global } = await ask(e, { tool: 'mcp:global:browser' });
    assert.deepEqual(await toolsFor(e, TARGET), []);
    assert.deepEqual((await serversFor(e, TARGET)).map((s) => s.id), [1]);
    assert.equal(await serverWithHeaders(e, 2, { channelId: 'C1', thread: THREAD }), null);

    // Not on the thread's team, or only looking as someone: nothing.
    const body = { thread: THREAD, id: tool.id };
    assert.equal((await call(e, EVE, '/api/agent/tools/grant', body)).status, 404);
    assert.equal((await call(e, { ...ADA, readonly: true }, '/api/agent/tools/grant', body)).status, 403);
    assert.equal((await call(e, ADA, '/api/agent/tools/grant', { ...body, id: 'nope' })).status, 404);

    const res = await call(e, ADA, '/api/agent/tools/grant', body);
    assert.equal(res.status, 202);
    const { request, message } = await res.json();
    assert.equal(request.status, 'granted');
    assert.deepEqual(request.by, { id: 1, name: 'Ada' });
    assert.equal(Date.parse(request.expires_at) - Date.parse(request.decided_at), 24 * 3600 * 1000);
    assert.match(message.body, new RegExp(`^Granted: you have \\*\\*Extraction rules\\*\\* in this thread for the next 24 hours \\(tool request ${tool.id}\\)`));
    assert.deepEqual(calls, [['sidebar', THREAD, { id: message.id, by: 'Ada', text: message.body }]]);
    assert.ok(e.DB.sqlite.prepare('SELECT 1 FROM sidebar_messages WHERE id = ?').get(message.id));
    assert.deepEqual(await toolsFor(e, TARGET), ['extraction_rules']);
    // Only its own thread's agent.
    assert.deepEqual(await toolsFor(e, { ...TARGET, key: 'slack:E1:C1:2.2' }), []);
    // Granted once is all: a second click finds it decided.
    const twice = await call(e, ADA, '/api/agent/tools/grant', body);
    assert.equal(twice.status, 409);
    assert.match((await twice.json()).error, /Ada granted it already/);

    await call(e, ADA, '/api/agent/tools/grant', { thread: THREAD, id: server.id });
    await call(e, ADA, '/api/agent/tools/grant', { thread: THREAD, id: global.id });
    // The team's by name, then the global ones.
    assert.deepEqual((await serversFor(e, TARGET)).map((s) => s.id), [2, 1, 'global:browser']);
    assert.equal((await serverWithHeaders(e, 2, { channelId: 'C1', thread: THREAD })).name, 'logs');
    assert.equal(await serverWithHeaders(e, 2, { channelId: 'C1', thread: 'slack:E1:C1:2.2' }), null);
    // Nothing more to ask for of those.
    const left = (await requestableFor(e, TARGET)).map((x) => x.id);
    assert.deepEqual(left, ['post_message']);

    // A day later it is over, and the agent may ask again.
    e.DB.sqlite.exec('UPDATE tool_requests SET expires_at = \'2020-01-01T00:00:00.000Z\'');
    assert.deepEqual(await toolsFor(e, TARGET), []);
    assert.deepEqual((await serversFor(e, TARGET)).map((s) => s.id), [1]);
    assert.equal((await toolRequestOf(e, tool.id)).status, 'ended');
    assert.ok((await ask(e, { tool: 'extraction_rules' })).request);
  });

  it('denies it, or ends a grant early', async () => {
    const { env: e, calls } = bound(env());
    const { request: a } = await ask(e, { tool: 'extraction_rules' });
    const { request: b } = await ask(e, { tool: 'mcp:2' });
    const denied = await call(e, ADA, '/api/agent/tools/deny', { thread: THREAD, id: a.id });
    assert.equal(denied.status, 202);
    const d = await denied.json();
    assert.equal(d.request.status, 'denied');
    assert.match(d.message.body, /^Denied: you do not get \*\*Extraction rules\*\*/);
    assert.equal((await call(e, ADA, '/api/agent/tools/grant', { thread: THREAD, id: a.id })).status, 409);
    assert.deepEqual(await toolsFor(e, TARGET), []);

    // Only a grant can be ended, and only while it lasts.
    assert.equal((await call(e, ADA, '/api/agent/tools/revoke', { thread: THREAD, id: b.id })).status, 409);
    await call(e, ADA, '/api/agent/tools/grant', { thread: THREAD, id: b.id });
    calls.length = 0;
    const ended = await call(e, ADA, '/api/agent/tools/revoke', { thread: THREAD, id: b.id });
    assert.equal(ended.status, 200);
    const r = (await ended.json()).request;
    assert.equal(r.status, 'revoked');
    assert.deepEqual(r.revoked_by, { id: 1, name: 'Ada' });
    assert.deepEqual((await serversFor(e, TARGET)).map((s) => s.id), [1]);
    // The agent drops it at once, and is not told: it is no sidebar message.
    assert.deepEqual(calls.map(([m]) => m).sort(), ['syncMcp', 'syncTools']);

    // The inbox shows them with the thread, how each stands.
    const res = await quiet(() => api(
      new Request(`https://opspile.test/api/thread?thread=${encodeURIComponent(THREAD)}&team=helix`),
      e,
      new URL(`https://opspile.test/api/thread?thread=${encodeURIComponent(THREAD)}&team=helix`),
      { viewer: ADA },
    ));
    const shown = (await res.json()).tool_requests;
    assert.deepEqual(shown.map((x) => [x.id, x.status]), [[a.id, 'denied'], [b.id, 'revoked']]);
  });
});
