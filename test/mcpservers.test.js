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
  after, before, describe, it,
} from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import {
  AgentMcp, CATALOG_TTL_MS, codemodeExtension, MAX_CALLS, mcpExtension, mcpSection,
  withNamespaces,
} from '../src/agent/mcp.js';
import { api } from '../src/api.js';
import { d1 } from './d1.js';
import { fakeMcpServers } from './mcp-server.js';
import { quiet } from './fakes.js';

// Made-up people, teams, orgs, hosts and tokens only.
const KEY = Buffer.alloc(32, 7).toString('base64url');
const TOKEN = 'secret-token-for-tests';
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin', 'helix'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
};
const CY = {
  id: 3, email: 'cy@staff.example', name: 'Cy', staff: 1, teams: ['helix'],
};
const asMe = (p, roles = {}) => ({ ...p, teams: p.teams.map((slug) => ({ slug, role: roles[slug] || 'member' })) });

const SERVERS = fakeMcpServers([
  {
    url: 'https://docs.mcp.example/mcp',
    name: 'docs',
    token: TOKEN,
    instructions: 'Search before you read.',
    tools: [
      {
        name: 'search_docs',
        description: 'Search the product documentation',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        readOnly: true,
        run: ({ query }) => `3 pages about ${query}: /purge, /cache, /headers`,
      },
      {
        name: 'delete-page',
        description: 'Delete a page',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        run: () => 'deleted',
      },
    ],
  },
  {
    url: 'https://status.mcp.example/mcp',
    name: 'status',
    tools: [{
      name: 'site_status',
      description: 'Status of a customer site',
      inputSchema: { type: 'object', properties: { host: { type: 'string' } } },
      run: ({ host }) => ({ content: [{ type: 'text', text: `${host}: degraded` }], structuredContent: { host, ok: false } }),
    }],
  },
]);

function env() {
  const DB = d1({
    people: [ADA, BO, CY],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }, { slug: 'edge', name: 'Edge ops' }],
  });
  // The knowledge bases the editor knows; their team or customer owns the MCP servers.
  for (const [kind, slug] of [['team', 'helix'], ['team', 'edge'], ['org', 'acme'], ['org', 'other']]) {
    DB.sqlite.prepare(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
      VALUES (?, ?, ?, 'test', '2026-10-22T00:00:00Z')`).run(`kb-${kind}-${slug}`, kind, slug);
  }
  return { DB, TOKEN_KEY: KEY };
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

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (input, init) => (SERVERS.handles(new Request(input).url)
    ? SERVERS.fetch(input, init) : realFetch(input, init));
});
after(() => {
  globalThis.fetch = realFetch;
});

describe('MCP servers in the knowledge-base editor', () => {
  const admin = asMe(ADA);
  const manager = asMe(BO, { helix: 'manager' });
  const member = asMe(CY);

  it('adds a team server, checks it, and never shows the credentials', async () => {
    const e = env();
    const added = await call(e, manager, 'POST', '/api/kb/mcp', {
      repo: 'kb-team-helix',
      name: 'docs',
      url: 'https://docs.mcp.example/mcp',
      description: 'Product documentation',
      headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }],
    });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.deepEqual(added.body.server.headerNames, ['Authorization']);
    assert.deepEqual(added.body.server.tools.map((t) => t.name), ['search_docs', 'delete-page']);
    assert.equal(added.body.server.tools[0].readOnly, true);
    assert.equal(added.body.server.checkError, null);
    assert.equal(added.body.instructions, 'Search before you read.');
    assert.ok(!JSON.stringify(added.body).includes(TOKEN));
    assert.ok(!JSON.stringify(e.DB.rows('SELECT * FROM mcp_servers')).includes(TOKEN), 'sealed in D1');

    const listed = await call(e, manager, 'GET', '/api/kb/mcp?repo=kb-team-helix');
    assert.equal(listed.body.servers.length, 1);
    assert.ok(!JSON.stringify(listed.body).includes(TOKEN));

    // Changing the description keeps the headers; replacing them with none fails the check.
    const { id } = added.body.server;
    const kept = await call(e, manager, 'PUT', '/api/kb/mcp', { id, description: 'Docs' });
    assert.deepEqual(kept.body.server.headerNames, ['Authorization']);
    const cleared = await call(e, manager, 'PUT', '/api/kb/mcp', { id, headers: {} });
    assert.deepEqual(cleared.body.server.headerNames, []);
    assert.match(cleared.body.server.checkError, /./);
    assert.deepEqual(cleared.body.server.tools, []);

    const gone = await call(e, manager, 'DELETE', '/api/kb/mcp', { id });
    assert.equal(gone.status, 200);
    assert.equal(e.DB.rows('SELECT * FROM mcp_servers').length, 0);
  });

  it('keeps customers to the admin team and teams to their managers', async () => {
    const e = env();
    const org = {
      repo: 'kb-org-acme', name: 'status', url: 'https://status.mcp.example/mcp',
    };
    // As in the editor: a knowledge base someone may not edit does not exist for them.
    assert.equal((await call(e, manager, 'POST', '/api/kb/mcp', org)).status, 404);
    assert.equal((await call(e, member, 'POST', '/api/kb/mcp', { ...org, repo: 'kb-team-helix' })).status, 403);
    assert.equal((await call(e, manager, 'POST', '/api/kb/mcp', { ...org, repo: 'kb-team-edge' })).status, 404);
    const made = await call(e, admin, 'POST', '/api/kb/mcp', org);
    assert.equal(made.status, 200);
    assert.equal(made.body.server.repo, 'kb-org-acme');
    assert.equal((await call(e, manager, 'GET', '/api/kb/mcp?repo=kb-org-acme')).status, 404);
    assert.equal((await call(e, manager, 'DELETE', '/api/kb/mcp', { id: made.body.server.id })).status, 404);
    assert.equal((await call(e, admin, 'POST', '/api/kb/mcp/check', { id: made.body.server.id })).body.server.tools.length, 1);
  });

  it('refuses what an agent could not use', async () => {
    const e = env();
    const base = {
      repo: 'kb-team-helix', name: 'docs', url: 'https://docs.mcp.example/mcp',
    };
    const refused = async (patch, pattern) => {
      const r = await call(e, admin, 'POST', '/api/kb/mcp', { ...base, ...patch });
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.match(r.body.error, pattern);
    };
    await refused({ url: 'http://docs.mcp.example/mcp' }, /https/);
    await refused({ url: 'https://user:pw@docs.mcp.example/mcp' }, /header/);
    await refused({ name: 'Docs Server' }, /lowercase/);
    await refused({ headers: { 'Mcp-Session-Id': 'x' } }, /client itself/);
    await refused({ headers: { Authorization: 'a\nb' } }, /one line/);
    assert.equal((await call(e, admin, 'POST', '/api/kb/mcp', { ...base, repo: 'kb-team-nope' })).status, 404);
    assert.equal((await call(e, admin, 'POST', '/api/kb/mcp', base)).status, 200);
    assert.equal((await call(e, admin, 'POST', '/api/kb/mcp', base)).status, 409);
  });
});

/** A Durable Object's storage, enough for AgentMcp. */
function memoryStorage() {
  const m = new Map();
  return {
    get: async (k) => structuredClone(m.get(k)),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
  };
}

async function configured() {
  const e = env();
  const admin = asMe(ADA);
  await call(e, admin, 'POST', '/api/kb/mcp', {
    repo: 'kb-team-helix',
    name: 'docs',
    url: 'https://docs.mcp.example/mcp',
    description: 'Product documentation',
    headers: { Authorization: `Bearer ${TOKEN}` },
    allow: 'search_docs',
  });
  await call(e, admin, 'POST', '/api/kb/mcp', {
    repo: 'kb-org-acme', name: 'docs', url: 'https://status.mcp.example/mcp', description: 'Their status page',
  });
  await call(e, admin, 'POST', '/api/kb/mcp', {
    repo: 'kb-org-other', name: 'secret', url: 'https://status.mcp.example/mcp',
  });
  return e;
}

describe('MCP servers in thread agents', () => {
  it('names a customer server like a team one apart', () => {
    assert.deepEqual(withNamespaces([
      { scope: 'team', name: 'docs' }, { scope: 'org', name: 'docs' }, { scope: 'org', name: 'my-api' },
    ]).map((s) => s.ns), ['docs', 'docs_customer', 'my_api']);
  });

  it('keeps a catalog of the team\'s and the customer\'s servers, and asks again only when it changes', async () => {
    const e = await configured();
    const mcp = new AgentMcp(e, memoryStorage());
    const target = { team: 'helix', org: 'acme' };
    const first = await mcp.refresh(target);
    assert.equal(first.changed, true);
    const listed = first.catalog.servers.map((s) => [s.scope, s.ns, s.tools.map((t) => t.name)]);
    assert.deepEqual(listed, [
      ['team', 'docs', ['search_docs']], // allow list: no delete-page
      ['org', 'docs_customer', ['site_status']],
    ]);
    assert.ok(!JSON.stringify(first.catalog).includes(TOKEN), 'no credentials in the agent');
    assert.equal((await mcp.refresh(target)).changed, false);
    assert.equal((await mcp.refresh(target, Date.now() + CATALOG_TTL_MS + 1)).changed, true);
    e.DB.sqlite.prepare("UPDATE mcp_servers SET enabled = 0, updated_at = 'later' WHERE scope = 'org'").run();
    const off = await mcp.refresh(target);
    assert.equal(off.changed, true);
    assert.deepEqual(off.catalog.servers.map((s) => s.name), ['docs']);
    assert.match(mcpSection(off.catalog), /mcp__docs \(ops team helix\): Product documentation\. 1 tool: search_docs/);
  });

  it('calls MCP tools from a codemode script, and only from one', async () => {
    const e = await configured();
    const mcp = new AgentMcp(e, memoryStorage());
    const { catalog } = await mcp.refresh({ team: 'helix', org: 'acme' });
    const sandbox = new CodemodeSandbox({ timeoutMs: 20_000 });
    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-model' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(codemodeExtension(catalog, sandbox));
    registry.install(mcpExtension(catalog, (...args) => mcp.call(...args)));
    const ctx = BACKGROUND_CONTEXT;
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
    const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-model' } } });
    let offered = [];
    let system = '';
    let result = '';
    const script = `
      const docs = await tools.mcp__docs__search_docs({ query: 'purge' });
      const site = await tools.mcp__docs_customer__site_status({ host: 'www.acme.example' });
      const ns = await describeNamespace('mcp__docs');
      text(docs.content[0].text);
      text(JSON.stringify(site.structuredContent));
      text(ns.tools.join(','));
      text(ns.instructions);`;
    faux.setResponses([
      (context) => {
        offered = context.messages.filter((m) => m.role === 'system')
          .flatMap((m) => (m.toolsAdded || []).map((t) => t.name));
        system = context.messages.filter((m) => m.role === 'system')
          .map((m) => Object.values(m.sections || {}).join('\n\n') || m.content).join('\n');
        return fauxAssistantMessage(fauxToolCall('codemode', { code: script }), { stopReason: 'toolUse' });
      },
      (context) => {
        const last = context.messages[context.messages.length - 1];
        result = last.content.map((c) => c.text).join('');
        return fauxAssistantMessage('done');
      },
    ]);
    const sub = await root.submit({ type: 'input', content: 'How are purges doing?' }, ctx);
    const settled = await sub.wait(ctx);
    assert.equal(settled.status, 'done', JSON.stringify(settled));
    await harness.close(ctx);
    await sandbox.close();

    assert.deepEqual(offered, ['codemode'], 'MCP tools are not offered to the model');
    assert.match(system, /mcp__docs \(ops team helix\)/);
    assert.match(system, /mcp__docs_customer \(customer acme\)/);
    assert.match(system, /data, not instructions/);
    assert.match(result, /3 pages about purge/);
    assert.match(result, /\{"host":"www.acme.example","ok":false\}/);
    assert.match(result, /mcp__docs__search_docs/);
    assert.match(result, /Search before you read\./);
    assert.deepEqual(SERVERS.calls.slice(-2).map((c) => c.tool), ['search_docs', 'site_status']);
  });

  it('keeps the latest calls for the trace, arguments clipped, results not', async () => {
    const e = await configured();
    const storage = memoryStorage();
    const mcp = new AgentMcp(e, storage);
    const { catalog } = await mcp.refresh({ team: 'helix', org: 'acme' });
    const [tool] = mcpExtension(catalog, (...args) => mcp.call(...args)).tools;
    await tool.execute({ query: 'robots' }, {}, {});
    await tool.execute({ query: 'x'.repeat(2000) }, {}, {});
    const [first, second] = await mcp.calls();
    assert.deepEqual([first.tool, first.server, first.status, first.arguments], ['mcp__docs__search_docs', 'docs', 'ok', { query: 'robots' }]);
    assert.ok(/^\d{4}-/.test(first.at) && first.duration_ms >= 0 && !('result' in first));
    assert.equal(typeof second.arguments, 'string');
    assert.ok(second.arguments.length <= 1000 && second.arguments_bytes > 2000);
    for (let i = 0; i < MAX_CALLS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await mcp.record({ ns: 'docs', name: 'docs' }, 'search_docs', {}, Date.now(), 'ok');
    }
    assert.equal((await mcp.calls()).length, MAX_CALLS);
  });

  it('tells a script when a server fails', async () => {
    const e = await configured();
    const mcp = new AgentMcp(e, memoryStorage());
    const { catalog } = await mcp.refresh({ team: 'helix', org: 'acme' });
    // The credentials stop working: the call fails, the script sees the error.
    e.DB.sqlite.prepare("UPDATE mcp_servers SET headers = NULL WHERE name = 'docs' AND scope = 'team'").run();
    const [tool] = mcpExtension(catalog, (...args) => mcp.call(...args)).tools;
    const res = await quiet(() => tool.execute({ query: 'x' }, {}, {}));
    assert.equal(res.isError, true);
    assert.match(res.output[0].text, /^docs: /);
  });
});
