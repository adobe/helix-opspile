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
import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  after, before, beforeEach, describe, it,
} from 'node:test';
import { api } from '../src/api.js';
import { refreshGlobalTools } from '../src/mcpadmin.js';
import { AgentMcp, CATALOG_TTL_MS, mcpSection } from '../src/agent/mcp.js';
import { serversFor, serverWithHeaders } from '../src/agent/mcpclient.js';
import { BROWSER_MCP_URL, GITHUB_MCP_URL } from '../src/agent/globals.js';
import {
  appJwt, appManifest, forgetGithub, manifestAction, pkcs8Pem,
} from '../src/github.js';
import { makeState, seal } from '../src/post.js';
import { d1 } from './d1.js';
import { fakeMcpServers } from './mcp-server.js';
import { quiet } from './fakes.js';

// Made-up people, teams, orgs, channels, accounts, keys and tokens only.
const KEY = Buffer.alloc(32, 5).toString('base64url');
const INSTALL_TOKEN = 'ghs_made-up-installation-token';
const { privateKey: PKCS1, publicKey: PUBLIC } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin', 'helix'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix', 'edge'],
};
const asMe = (p, roles = {}) => ({ ...p, teams: p.teams.map((slug) => ({ slug, role: roles[slug] || 'member' })) });
const admin = asMe(ADA);
const manager = asMe(BO, { helix: 'manager' });

// Cloudflare's Browser Run MCP server, and GitHub's MCP server, in memory.
const BROWSER_TOKEN = 'made-up-browser-run-token';
const BROWSER_MCP = fakeMcpServers([{
  url: BROWSER_MCP_URL,
  name: 'cloudflare-browser-mcp-server',
  token: BROWSER_TOKEN,
  tools: [
    {
      name: 'get_url_markdown',
      description: 'Fetches the webpage content and converts it into Markdown format',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      readOnly: true,
      run: ({ url }) => `# ${url}\n\nHello.`,
    },
    {
      name: 'get_url_screenshot',
      description: 'Captures a screenshot of the webpage',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      readOnly: true,
      run: () => ({ content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] }),
    },
    {
      name: 'kill_browser_session',
      description: 'Closes a Browser Run session',
      inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } } },
      run: () => 'killed',
    },
  ],
}]);
let browserRequests = 0;
const GITHUB_MCP = fakeMcpServers([{
  url: GITHUB_MCP_URL,
  name: 'github',
  token: INSTALL_TOKEN,
  tools: [{
    name: 'get_file_contents',
    description: 'Get the contents of a file',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' } } },
    readOnly: true,
    run: ({ repo, path }) => `${repo}/${path}: hello`,
  }],
}]);

/** GitHub's REST API, as far as the app needs it. */
const GITHUB = {
  installations: [{ id: 41, account: { login: 'acme-labs', type: 'Organization' }, repository_selection: 'selected' }],
  requests: [],
  mcpHeaders: [],
};

function verifyJwt(auth) {
  const [h, p, s] = String(auth).replace(/^Bearer /, '').split('.');
  const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(PUBLIC, Buffer.from(s, 'base64url'));
  return ok ? JSON.parse(Buffer.from(p, 'base64url').toString()) : null;
}

async function githubApi(request) {
  const url = new URL(request.url);
  GITHUB.requests.push(`${request.method} ${url.pathname}`);
  const reply = (body, status = 200) => Response.json(body, { status });
  if (request.method === 'POST' && /^\/app-manifests\/good-code\/conversions$/.test(url.pathname)) {
    return reply({
      id: 777,
      slug: 'opspile-test',
      name: 'opspile test',
      owner: { login: 'acme-labs' },
      html_url: 'https://github.com/apps/opspile-test',
      client_id: 'Iv1.madeup',
      client_secret: 'made-up-client-secret',
      webhook_secret: null,
      pem: PKCS1,
    }, 201);
  }
  const claims = verifyJwt(request.headers.get('authorization'));
  if (!claims || claims.iss !== 'Iv1.madeup') {
    return reply({ message: 'A JSON web token could not be decoded' }, 401);
  }
  if (request.method === 'GET' && url.pathname === '/app/installations') {
    return reply(GITHUB.installations);
  }
  const m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
  if (request.method === 'POST' && m) {
    const expires = new Date(Date.now() + 3600_000).toISOString();
    return reply({ token: INSTALL_TOKEN, expires_at: expires }, 201);
  }
  return reply({ message: 'Not Found' }, 404);
}

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith('https://api.github.com/')) {
      return githubApi(request);
    }
    if (BROWSER_MCP.handles(request.url)) {
      browserRequests += 1;
      return BROWSER_MCP.fetch(request);
    }
    if (GITHUB_MCP.handles(request.url)) {
      GITHUB.mcpHeaders.push(Object.fromEntries(request.headers));
      return GITHUB_MCP.fetch(request);
    }
    return realFetch(input, init);
  };
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  forgetGithub();
  GITHUB.requests.length = 0;
  GITHUB.installations = GITHUB.installations.slice(0, 1);
  GITHUB.mcpHeaders.length = 0;
});

function env({ browser = true } = {}) {
  const DB = d1({
    people: [ADA, BO],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }, { slug: 'edge', name: 'Edge ops' }],
  });
  for (const [kind, slug] of [['team', 'helix'], ['team', 'edge'], ['org', 'acme']]) {
    DB.sqlite.prepare(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
      VALUES (?, ?, ?, 'test', '2026-10-22T00:00:00Z')`).run(`kb-${kind}-${slug}`, kind, slug);
  }
  // Two channels of helix (for acme), one of edge.
  const thread = DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id,
      org, team, kind, channel_name, path, last_at, updated_at) VALUES (?, 'slack', 'E1', ?, '1.0', ?, ?,
      'channel', ?, 'p/', '2026-10-25T10:00:00Z', '2026-10-25T10:00:00Z')`);
  thread.run('slack:E1:C1:1.0', 'C1', 'acme', 'helix', 'aem-acme');
  thread.run('slack:E1:C2:1.0', 'C2', 'acme', 'helix', 'aem-acme-alerts');
  thread.run('slack:E1:C3:1.0', 'C3', 'initech', 'edge', 'aem-initech');
  return {
    DB,
    TOKEN_KEY: KEY,
    PUBLIC_ORIGIN: 'https://opspile.example',
    ...(browser ? { BROWSER_RUN_TOKEN: BROWSER_TOKEN } : {}),
  };
}

async function call(e, me, method, path, body) {
  const url = `https://opspile.example${path}`;
  const request = new Request(url, {
    method,
    redirect: 'manual',
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const res = await quiet(() => api(request, e, new URL(url), { viewer: me }));
  const type = res.headers.get('content-type') || '';
  return {
    status: res.status,
    location: res.headers.get('location'),
    body: type.includes('json') ? await res.json() : await res.text(),
  };
}

function memoryStorage() {
  const m = new Map();
  return {
    get: async (k) => structuredClone(m.get(k)),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
  };
}

/** The GitHub App, as the manifest flow would have stored it. */
async function withApp(e, { allowed = false } = {}) {
  e.DB.sqlite.prepare(`INSERT INTO github_apps (id, slug, name, owner, client_id, private_key, created_at)
    VALUES (777, 'opspile-test', 'opspile test', 'acme-labs', 'Iv1.madeup', ?, '2026-10-25T00:00:00Z')`)
    .run(await seal(e, pkcs8Pem(PKCS1)));
  if (allowed) {
    e.DB.sqlite.exec(`INSERT INTO github_installations (id, app_id, account, approved_by, approved_at)
      VALUES (41, 777, 'acme-labs', 'ada@staff.example', '2026-10-25T00:00:00Z')`);
  }
}

describe('the GitHub App', () => {
  it('turns GitHub\'s PKCS#1 key into one Web Crypto signs with', async () => {
    const pem = pkcs8Pem(PKCS1);
    assert.match(pem, /^-----BEGIN PRIVATE KEY-----\n/);
    assert.equal(pkcs8Pem(pem), pem, 'PKCS#8 stays as it is');
    const jwt = await appJwt({ id: 777, client_id: 'Iv1.madeup', privateKey: pem }, Date.UTC(2026, 9, 25));
    const claims = verifyJwt(jwt);
    assert.ok(claims, 'signed with the key');
    assert.equal(claims.iss, 'Iv1.madeup');
    assert.equal(claims.exp - claims.iat, 600);
    assert.throws(() => pkcs8Pem('not a key'), /PEM/);
  });

  it('asks for read access only, and knows where to go back to', () => {
    const m = appManifest({ PUBLIC_ORIGIN: 'https://opspile.example/' });
    assert.ok(Object.values(m.default_permissions).every((p) => p === 'read'));
    assert.equal(m.redirect_url, 'https://opspile.example/api/kb/github/created');
    assert.equal(m.public, true, 'installable anywhere; opspile allows installations itself');
    assert.equal(m.hook_attributes.active, false);
    assert.ok(m.name.length <= 34);
    assert.equal(manifestAction('', 's'), 'https://github.com/settings/apps/new?state=s');
    assert.equal(manifestAction('acme-labs', 's'), 'https://github.com/organizations/acme-labs/settings/apps/new?state=s');
    assert.equal(manifestAction('../evil', 's'), null);
  });

  it('is created by the admin team, through GitHub\'s manifest flow', async () => {
    const e = env();
    assert.equal((await call(e, manager, 'POST', '/api/kb/github/manifest', {})).status, 403);
    const started = await call(e, admin, 'POST', '/api/kb/github/manifest', { org: 'acme-labs', name: 'opspile test' });
    assert.equal(started.status, 200);
    assert.match(started.body.action, /^https:\/\/github\.com\/organizations\/acme-labs\/settings\/apps\/new\?state=/);
    assert.equal(JSON.parse(started.body.manifest).name, 'opspile test');
    const state = new URL(started.body.action).searchParams.get('state');

    assert.equal((await call(e, admin, 'GET', `/api/kb/github/created?code=good-code&state=${state}x`)).status, 400);
    assert.equal((await call(e, manager, 'GET', `/api/kb/github/created?code=good-code&state=${state}`)).status, 403);
    const created = await call(e, admin, 'GET', `/api/kb/github/created?code=good-code&state=${state}`);
    assert.equal(created.status, 302);
    assert.equal(created.location, 'https://github.com/apps/opspile-test/installations/new');
    const [row] = e.DB.rows('SELECT * FROM github_apps');
    assert.equal(row.id, 777);
    assert.ok(!JSON.stringify(row).includes('PRIVATE KEY'), 'the key is sealed');
    assert.ok(!JSON.stringify(row).includes('made-up-client-secret'), 'so is the secret');

    // A state is for the person who started it.
    const other = await makeState(e, 2, 'github-app');
    assert.equal((await call(e, admin, 'GET', `/api/kb/github/created?code=good-code&state=${other}`)).status, 400);
  });
});

describe('global MCP servers in the knowledge-base editor', () => {
  it('are listed with every knowledge base, off until someone turns them on', async () => {
    const e = env();
    const listed = await call(e, manager, 'GET', '/api/kb/mcp?repo=kb-team-helix');
    assert.equal(listed.status, 200);
    const [browser, github] = listed.body.globals;
    assert.equal(browser.server, 'browser');
    assert.equal(browser.available, true);
    assert.deepEqual(browser.team, { enabled: false });
    assert.equal(github.available, false);
    assert.match(github.problem, /no GitHub App/);
    assert.equal(github.github, undefined, 'the app is the admin team\'s business');
    const asAdmin = await call(e, admin, 'GET', '/api/kb/mcp?repo=kb-team-helix');
    assert.equal(asAdmin.body.globals[1].github.app, null);
    assert.equal((await call(e, admin, 'GET', '/api/kb/mcp?repo=kb-org-acme')).body.globals[0].team, null);
    const noBrowser = await call(env({ browser: false }), admin, 'GET', '/api/kb/mcp?repo=kb-team-helix');
    assert.match(noBrowser.body.globals[0].problem, /BROWSER_RUN_TOKEN/);
  });

  it('switch per team and per channel, for the admin team and the team\'s managers', async () => {
    const e = env();
    const put = (me, body) => call(e, me, 'PUT', '/api/kb/mcp/global', body);
    assert.equal((await put(manager, { server: 'browser', team: 'edge', enabled: true })).status, 404);
    assert.equal((await put(manager, { server: 'browser', channel: 'C3', enabled: true })).status, 404);
    assert.equal((await put(manager, { server: 'nope', team: 'helix', enabled: true })).status, 400);
    assert.equal((await put(manager, { server: 'browser', team: 'helix', enabled: 'yes' })).status, 400);
    assert.equal((await put(manager, { server: 'browser', team: 'helix', enabled: null })).status, 400);

    const on = await put(manager, { server: 'browser', team: 'helix', enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.switch.enabled, true);
    assert.equal(on.body.switch.by, 'Bo');
    const off = await put(manager, { server: 'browser', channel: 'C2', enabled: false });
    assert.equal(off.status, 200);
    assert.equal((await put(admin, { server: 'browser', channel: 'C3', enabled: true })).status, 200);

    const helix = (await call(e, manager, 'GET', '/api/kb/mcp?repo=kb-team-helix')).body.globals[0];
    assert.equal(helix.team.enabled, true);
    assert.deepEqual(Object.keys(helix.channels), ['C2'], 'only this knowledge base\'s channels');
    const acme = (await call(e, admin, 'GET', '/api/kb/mcp?repo=kb-org-acme')).body.globals[0];
    assert.equal(acme.channels.C2.enabled, false);

    // An agent in C1 follows the team; C2 is switched off; C3 is on though edge is not.
    const names = async (target) => (await serversFor(e, target)).map((s) => s.id);
    assert.deepEqual(await names({ team: 'helix', channelId: 'C1' }), ['global:browser']);
    assert.deepEqual(await names({ team: 'helix', channelId: 'C2' }), []);
    assert.deepEqual(await names({ team: 'edge', channelId: 'C3' }), ['global:browser']);
    assert.deepEqual(await names({ team: 'edge', channelId: 'C9' }), []);

    // Back to the team's switch.
    const reset = await put(manager, { server: 'browser', channel: 'C2', enabled: null });
    assert.equal(reset.body.switch, null);
    assert.deepEqual(await names({ team: 'helix', channelId: 'C2' }), ['global:browser']);
  });

  it('checks the browser, and keeps the tools for the agents but the session ones', async () => {
    const e = env();
    const checked = await call(e, manager, 'POST', '/api/kb/mcp/global/check', { server: 'browser', repo: 'kb-team-helix' });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.deepEqual(checked.body.checked, [{
      name: 'browser', tools: 3, error: null, server: { name: 'cloudflare-browser-mcp-server', version: '1.0.0' },
    }]);
    assert.deepEqual(checked.body.global.instances[0].tools.map((t) => t.name), ['get_url_markdown', 'get_url_screenshot']);
    assert.equal((await call(e, manager, 'POST', '/api/kb/mcp/global/check', { server: 'github' })).status, 409);
  });
});

describe('global MCP servers in the cron', () => {
  it('checks each one once a day', async () => {
    const e = env();
    await withApp(e, { allowed: true });
    const first = await quiet(() => refreshGlobalTools(e));
    assert.deepEqual(first, { browser: ['browser: 3 tools'], github: ['github: 1 tools'] });
    assert.deepEqual(await refreshGlobalTools(e), {}, 'fresh: nothing to do');
    const later = await refreshGlobalTools(e, { now: Date.now() + 2 * 86400_000 });
    assert.deepEqual(Object.keys(later), ['browser', 'github']);
  });
});

describe('global MCP servers in thread agents', () => {
  it('read web pages through Browser Run, from the tools the check found', async () => {
    const e = env();
    await call(e, admin, 'POST', '/api/kb/mcp/global/check', { server: 'browser' });
    await call(e, admin, 'PUT', '/api/kb/mcp/global', { server: 'browser', team: 'helix', enabled: true });
    browserRequests = 0;
    const mcp = new AgentMcp(e, memoryStorage());
    const { changed, catalog } = await mcp.refresh({ team: 'helix', org: 'acme', channelId: 'C1' });
    assert.equal(changed, true);
    assert.equal(browserRequests, 0, 'not asked only to list the tools');
    const [server] = catalog.servers;
    assert.equal(server.scope, 'global');
    assert.equal(server.ns, 'browser');
    assert.deepEqual(server.tools.map((t) => t.name), ['get_url_markdown', 'get_url_screenshot']);
    assert.match(server.instructions, /loads the page anew/);
    assert.match(mcpSection(catalog), /mcp__browser \(global, opspile's own\)/);
    assert.match(mcpSection(catalog), /never type customer data into a website/);
    assert.ok(!JSON.stringify(catalog).includes(BROWSER_TOKEN), 'no token in the catalog');

    const res = await mcp.call(server, 'get_url_markdown', { url: 'https://www.acme.example/' });
    assert.equal(res.content[0].text, '# https://www.acme.example/\n\nHello.');

    // Turned off for the channel: the next catalog has no browser.
    await call(e, admin, 'PUT', '/api/kb/mcp/global', { server: 'browser', channel: 'C1', enabled: false });
    const off = await mcp.refresh({ team: 'helix', org: 'acme', channelId: 'C1' });
    assert.equal(off.changed, true);
    assert.deepEqual(off.catalog.servers, []);
  });

  it('read GitHub as the app\'s installation, read-only, with a fresh token when it expires', async () => {
    const e = env();
    await withApp(e);
    await call(e, admin, 'PUT', '/api/kb/mcp/global', { server: 'github', team: 'helix', enabled: true });
    // Installed, but not allowed yet: no server, and no token.
    const waiting = (await call(e, admin, 'GET', '/api/kb/mcp?repo=kb-team-helix')).body.globals[1];
    assert.equal(waiting.available, false);
    assert.match(waiting.problem, /installed on acme-labs, but the admin team has not allowed/);
    assert.equal(waiting.github.installations[0].approved, false);
    assert.equal(await serverWithHeaders(e, 'global:github:41'), null);
    assert.deepEqual(await serversFor(e, { team: 'helix', channelId: 'C1' }), []);
    const allow = (me, body) => call(e, me, 'PUT', '/api/kb/github/installation', body);
    assert.equal((await allow(manager, { id: 41, approved: true })).status, 403);
    assert.equal((await allow(admin, { id: 99, approved: true })).status, 404);
    assert.equal((await allow(admin, { id: 41, approved: 'yes' })).status, 400);
    const allowed = await allow(admin, { id: 41, approved: true });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.installations[0].approvedBy, 'ada@staff.example');

    const listed = (await call(e, admin, 'GET', '/api/kb/mcp?repo=kb-team-helix')).body.globals[1];
    assert.equal(listed.available, true);
    assert.deepEqual(listed.instances.map((i) => [i.key, i.name, i.account]), [['github:41', 'github', 'acme-labs']]);
    assert.equal(listed.github.app.installUrl, 'https://github.com/apps/opspile-test/installations/new');
    assert.equal(listed.github.installations[0].selection, 'selected');

    const conn = await serverWithHeaders(e, 'global:github:41');
    assert.equal(conn.url, GITHUB_MCP_URL);
    assert.equal(conn.headers.Authorization, `Bearer ${INSTALL_TOKEN}`);
    assert.equal(conn.headers['X-MCP-Readonly'], 'true');

    const mcp = new AgentMcp(e, memoryStorage(), { agent: 'slack:E1:C1:1.0' });
    const { catalog } = await mcp.refresh({ team: 'helix', org: 'acme', channelId: 'C1' });
    assert.deepEqual(catalog.servers.map((s) => [s.ns, s.tools.map((t) => t.name)]), [['github', ['get_file_contents']]]);
    assert.ok(!JSON.stringify(catalog).includes(INSTALL_TOKEN), 'no token in the catalog');
    const res = await mcp.call(catalog.servers[0], 'get_file_contents', { owner: 'acme-labs', repo: 'site', path: 'README.md' });
    assert.equal(res.content[0].text, 'site/README.md: hello');
    assert.ok(GITHUB.mcpHeaders.every((h) => h['x-mcp-readonly'] === 'true' && h['x-mcp-lockdown'] === 'true'));

    // Near its expiry, the client is replaced, with a token minted anew.
    const [pending] = mcp.clients.values();
    pending.expiresAt = Date.now();
    forgetGithub();
    const minted = GITHUB.requests.filter((r) => r.endsWith('/access_tokens')).length;
    await mcp.call(catalog.servers[0], 'get_file_contents', { owner: 'acme-labs', repo: 'site', path: 'a' });
    assert.equal(GITHUB.requests.filter((r) => r.endsWith('/access_tokens')).length, minted + 1);

    // Installed on a second account: nothing until it is allowed, then one server each.
    GITHUB.installations = [...GITHUB.installations, { id: 42, account: { login: 'Initech' }, repository_selection: 'all' }];
    forgetGithub();
    const stranger = await mcp.refresh({ team: 'helix', org: 'acme', channelId: 'C1' }, Date.now() + CATALOG_TTL_MS + 1);
    assert.deepEqual(stranger.catalog.servers.map((s) => s.ns), ['github']);
    await allow(admin, { id: 42, approved: true });
    const two = await mcp.refresh({ team: 'helix', org: 'acme', channelId: 'C1' });
    assert.deepEqual(two.catalog.servers.map((s) => s.ns), ['github_acme_labs', 'github_initech']);
    // Revoked: gone again.
    await allow(admin, { id: 42, approved: false });
    const back = await mcp.refresh({ team: 'helix', org: 'acme', channelId: 'C1' });
    assert.deepEqual(back.catalog.servers.map((s) => s.ns), ['github']);
  });
});
