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
import { describe, it } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { Bash, InMemoryFs } from 'just-bash';
import { COMPUTER_CWD, computerEnv } from '../src/agent/computer.js';
import {
  agentScope, forward, hostAllowed, nameProblem, parseHosts, placeholder, scrubber, secretsFor,
} from '../src/agent/secrets.js';
import { agentToolsExtension } from '../src/agent/tools.js';
import { kbAdmin } from '../src/kbadmin.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up people, teams, customers, hosts and keys only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1,
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1,
};
const CY = {
  id: 3, email: 'cy@staff.example', name: 'Cy', staff: 1,
};
const admin = { ...ADA, teams: [{ slug: 'admin', role: 'member' }] };
const manager = { ...BO, teams: [{ slug: 'helix', role: 'manager' }] };
const member = { ...CY, teams: [{ slug: 'helix', role: 'member' }] };
const outsider = { ...BO, teams: [{ slug: 'edge', role: 'manager' }] };

const SLACK = 'slack:E1:C1:1792584000.000100';
const KEY = 'made-up-key-0123456789';
const ORG_KEY = 'made-up-org-key-9876';

function env() {
  const DB = d1({
    people: [{ ...ADA, teams: ['admin'] }, { ...BO, teams: ['helix'] }, { ...CY, teams: ['helix'] }],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix' }, { slug: 'edge', name: 'Edge' }],
  });
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      kind, channel_name, path, any_at, updated_at)
    VALUES (?, 'slack', 'E1', 'C1', '1792584000.000100', 'acme', 'helix', 'channel', 'aem-acme',
      'channels/x/', '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z')`).run(SLACK);
  DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at) VALUES
    ('kb-team-helix', 'team', 'helix', 'x', '2026-10-20T09:00:00Z'),
    ('kb-team-edge', 'team', 'edge', 'x', '2026-10-20T09:00:00Z'),
    ('kb-org-acme', 'org', 'acme', 'x', '2026-10-20T09:00:00Z')`);
  return { DB, TOKEN_KEY: Buffer.alloc(32, 7).toString('base64url'), LOADER: {} };
}

async function call(e, me, method, path, body) {
  const url = new URL(`http://localhost${path}`);
  const req = new Request(url, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const res = await quiet(() => kbAdmin(req, e, url, me));
  return { status: res.status, body: await res.json() };
}

const computerOf = (res) => res.body.tools.find((t) => t.tool === 'computer');

/** The helix team's ACME_API_KEY for api.acme.example, and acme's own, for *.acme.example. */
async function withSecrets() {
  const e = env();
  await call(e, manager, 'POST', '/api/kb/tools/secrets', {
    repo: 'kb-team-helix', name: 'ACME_API_KEY', value: KEY, hosts: 'api.acme.example', description: 'The ticket API',
  });
  await call(e, admin, 'POST', '/api/kb/tools/secrets', {
    repo: 'kb-org-acme', name: 'ACME_API_KEY', value: ORG_KEY, hosts: '*.acme.example',
  });
  await call(e, admin, 'POST', '/api/kb/tools/secrets', {
    repo: 'kb-org-acme', name: 'ACME_USER', value: 'made-up-user', hosts: 'api.acme.example',
  });
  return e;
}

/** A fake network that records what reaches it and answers with `answer(request)`. */
function network(answer = (r) => new Response(`ok ${r.url}`)) {
  const sent = [];
  return {
    sent,
    fetch: async (request) => {
      sent.push({ request, body: request.body ? await request.clone().text() : null });
      return answer(request);
    },
  };
}

const quietly = (fn) => quiet(fn);

describe('agent secrets', () => {
  it('take names of capitals and hosts by name, a star for the hosts below one', () => {
    assert.equal(nameProblem('ACME_API_KEY'), null);
    assert.match(nameProblem('acme'), /capitals/);
    assert.match(nameProblem('PATH'), /shell has itself/);
    assert.match(nameProblem('BASH_ENV'), /shell has itself/);
    assert.deepEqual(
      parseHosts('API.acme.example, *.acme.example api.acme.example'),
      { hosts: ['api.acme.example', '*.acme.example'] },
    );
    assert.match(parseHosts('').error, /give the hosts/);
    assert.match(parseHosts('*.example').error, /not a host name/);
    assert.match(parseHosts('*').error, /not a host name/);
    assert.match(parseHosts('10.0.0.1').error, /not a host name/);
    assert.deepEqual(parseHosts('https://api.acme.example/v1?x=1'), { hosts: ['api.acme.example'] });
    assert.match(parseHosts('https://user@api.acme.example').error, /not a host name/);
    assert.ok(hostAllowed('api.acme.example', ['api.acme.example']));
    assert.ok(hostAllowed('a.b.acme.example', ['*.acme.example']));
    assert.ok(!hostAllowed('acme.example', ['*.acme.example']));
    assert.ok(!hostAllowed('evilacme.example', ['*.acme.example']));
    assert.ok(!hostAllowed('api.acme.example.evil.example', ['api.acme.example']));
  });

  it('are kept by whoever edits the knowledge base, and listed by name only', async () => {
    const e = await withSecrets();
    const team = await call(e, member, 'GET', '/api/kb/tools?repo=kb-team-helix');
    assert.equal(team.status, 200);
    assert.deepEqual(
      computerOf(team).secrets.map((s) => [s.name, s.hosts, s.description, s.updatedBy]),
      [['ACME_API_KEY', ['api.acme.example'], 'The ticket API', 'bo@staff.example']],
    );
    assert.ok(!JSON.stringify(team.body).includes(KEY));
    // Only the computer has them.
    assert.ok(team.body.tools.filter((t) => t.tool !== 'computer').every((t) => !('secrets' in t)));
    // Sealed in D1.
    const [row] = e.DB.rows("SELECT value FROM agent_secrets WHERE scope = 'team'");
    assert.ok(row.value && !row.value.includes(KEY));

    // A member looks, an outsider does not even see them, and neither changes them.
    const [secret] = computerOf(team).secrets;
    let res = await call(e, member, 'PUT', '/api/kb/tools/secrets', { id: secret.id, hosts: 'x.example.com' });
    assert.equal(res.status, 404);
    res = await call(e, outsider, 'DELETE', '/api/kb/tools/secrets', { id: secret.id });
    assert.equal(res.status, 404);
    res = await call(e, outsider, 'POST', '/api/kb/tools/secrets', {
      repo: 'kb-team-helix', name: 'OTHER', value: 'x', hosts: 'a.example.com',
    });
    assert.equal(res.status, 404);

    // A new value, hosts and description; the value stays when none is given.
    res = await call(e, manager, 'PUT', '/api/kb/tools/secrets', { id: secret.id, hosts: ['api.acme.example', 'files.acme.example'] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.secret.hosts, ['api.acme.example', 'files.acme.example']);
    assert.deepEqual(e.DB.rows("SELECT value FROM agent_secrets WHERE scope = 'team'"), [row]);
    res = await call(e, manager, 'PUT', '/api/kb/tools/secrets', { id: secret.id, value: 'made-up-new-key' });
    assert.notDeepEqual(e.DB.rows("SELECT value FROM agent_secrets WHERE scope = 'team'"), [row]);

    // Checked.
    const post = (body) => call(e, manager, 'POST', '/api/kb/tools/secrets', { repo: 'kb-team-helix', ...body });
    assert.equal((await post({ name: 'ACME_API_KEY', value: 'x', hosts: 'a.example.com' })).status, 409);
    assert.match((await post({ name: 'NEW', hosts: 'a.example.com' })).body.error, /one line/);
    assert.match((await post({ name: 'NEW', value: 'a\nb', hosts: 'a.example.com' })).body.error, /one line/);
    assert.match((await post({ name: 'NEW', value: placeholder('X'), hosts: 'a.example.com' })).body.error, /placeholder/);
    assert.match((await post({ name: 'NEW', value: 'x' })).body.error, /give the hosts/);
    assert.match((await post({ name: 'new', value: 'x', hosts: 'a.example.com' })).body.error, /capitals/);

    res = await call(e, manager, 'DELETE', '/api/kb/tools/secrets', { id: secret.id });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.secrets, []);
  });

  it('of the team win over the customer\'s, for its agents', async () => {
    const e = await withSecrets();
    assert.deepEqual(await agentScope(e, SLACK), { team: 'helix', org: 'acme' });
    assert.deepEqual(await agentScope(e, 'kb:helix:acme'), { team: 'helix', org: 'acme' });
    const list = await secretsFor(e, { team: 'helix', org: 'acme' });
    assert.deepEqual(list.map((s) => [s.name, s.scope, s.hosts]), [
      ['ACME_API_KEY', 'team', ['api.acme.example']],
      ['ACME_USER', 'org', ['api.acme.example']],
    ]);
    assert.deepEqual((await secretsFor(e, { team: 'edge', org: 'acme' })).map((s) => [s.name, s.scope]), [
      ['ACME_API_KEY', 'org'], ['ACME_USER', 'org'],
    ]);
    assert.deepEqual(await secretsFor(e, { team: 'edge', org: 'globex' }), []);
  });
});

describe('the secret gateway', () => {
  it('lets a request that names no secret through as it is', async () => {
    const e = await withSecrets();
    const net = network();
    const request = new Request('http://anywhere.example/page', { headers: { 'x-a': '1' } });
    const res = await forward(e, { agent: SLACK }, request, { fetch: net.fetch });
    assert.equal(await res.text(), 'ok http://anywhere.example/page');
    assert.equal(net.sent[0].request, request);
  });

  it('puts the values in, in headers, the URL, Basic and a JSON body, and takes them out again', async () => {
    const e = await withSecrets();
    const net = network(async (r) => new Response(`you sent ${r.headers.get('authorization')} ${await r.text()}`, {
      headers: { 'x-echo': r.headers.get('x-api-key'), 'content-length': '999' },
    }));
    const request = new Request(`https://api.acme.example/v1/items?key=${placeholder('ACME_API_KEY')}`, {
      method: 'POST',
      headers: {
        'x-api-key': placeholder('ACME_API_KEY'),
        authorization: `Basic ${btoa(`${placeholder('ACME_USER')}:${placeholder('ACME_API_KEY')}`)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ key: placeholder('ACME_API_KEY') }),
    });
    const res = await quietly(() => forward(e, { agent: SLACK }, request, { fetch: net.fetch }));
    const [{ request: out, body }] = net.sent;
    // The team's key, not the customer's of the same name.
    assert.equal(out.url, `https://api.acme.example/v1/items?key=${KEY}`);
    assert.equal(out.headers.get('x-api-key'), KEY);
    assert.equal(atob(out.headers.get('authorization').slice(6)), `made-up-user:${KEY}`);
    assert.equal(body, JSON.stringify({ key: KEY }));
    assert.equal(out.redirect, 'manual');
    // What comes back has the placeholders again.
    assert.equal(res.headers.get('x-echo'), placeholder('ACME_API_KEY'));
    assert.equal(res.headers.get('content-length'), null);
    const text = await res.text();
    assert.ok(!text.includes(KEY) && !text.includes('made-up-user'));
    assert.match(text, new RegExp(`${placeholder('ACME_API_KEY')}"\\}$`));
  });

  it('sends a body it does not read as it is', async () => {
    const e = await withSecrets();
    const net = network();
    const bytes = new Uint8Array([1, 2, 3, 250]);
    await quietly(() => forward(e, { agent: SLACK }, new Request('https://api.acme.example/upload', {
      method: 'PUT',
      headers: { 'x-api-key': placeholder('ACME_API_KEY'), 'content-type': 'application/octet-stream' },
      body: bytes,
    }), { fetch: net.fetch }));
    const [{ request }] = net.sent;
    assert.equal(request.headers.get('x-api-key'), KEY);
    assert.deepEqual(new Uint8Array(await request.arrayBuffer()), bytes);
  });

  it('refuses a secret for another host, over HTTP, or one it does not have, and sends nothing', async () => {
    const e = await withSecrets();
    const net = network();
    const ask = (url, agent = SLACK) => quietly(() => forward(e, { agent }, new Request(url, {
      headers: { authorization: `Bearer ${placeholder('ACME_API_KEY')}` },
    }), { fetch: net.fetch }));
    let res = await ask('https://elsewhere.example/collect');
    assert.equal(res.status, 403);
    assert.match(await res.text(), /nothing was sent to elsewhere\.example: ACME_API_KEY is only sent to api\.acme\.example, over HTTPS/);
    res = await ask('http://api.acme.example/v1');
    assert.equal(res.status, 403);
    res = await quietly(() => forward(e, { agent: SLACK }, new Request(`https://api.acme.example/?k=${placeholder('NOPE')}`), { fetch: net.fetch }));
    assert.match(await res.text(), /there is no secret NOPE here/);
    // An agent of another team gets the customer's, for its hosts.
    res = await ask('https://files.acme.example/', 'kb:edge:acme');
    assert.equal(res.status, 200);
    assert.equal(net.sent.length, 1);
    assert.equal(net.sent[0].request.headers.get('authorization'), `Bearer ${ORG_KEY}`);
    // An agent with neither has none.
    res = await ask('https://api.acme.example/', 'kb:edge:globex');
    assert.equal(res.status, 403);
    assert.equal(net.sent.length, 1);
  });

  it('scrubs a value split between chunks', async () => {
    const chunks = ['abc made-up-', 'key-01', '23456789 and made-up-key-0123456789', ' end'];
    const stream = new ReadableStream({
      start(c) {
        chunks.forEach((x) => c.enqueue(new TextEncoder().encode(x)));
        c.close();
      },
    }).pipeThrough(scrubber([[KEY, '<K>']]));
    assert.equal(await new Response(stream).text(), 'abc <K> and <K> end');
  });
});

/** A Cloudflare Computer workspace in memory, with the variables a command is given. */
function fakeWorkspace() {
  const fs = new InMemoryFs();
  const runs = [];
  return {
    runs,
    runtime: {
      async exec(command, options) {
        runs.push({ command, options });
        const bash = new Bash({ fs, cwd: options.cwd });
        await bash.exec(`mkdir -p ${COMPUTER_CWD}`);
        const r = await bash.exec(command, { cwd: options.cwd, env: options.env });
        const { exitCode, stdout, stderr } = r;
        return { result: async () => ({ exitCode, stdout, stderr }) };
      },
    },
  };
}

describe('the agent\'s computer', () => {
  it('has the secrets as placeholders, and is told about them', async () => {
    const e = await withSecrets();
    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-model' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    const agent = {
      env: e,
      hasThread: true,
      target: async () => ({
        key: SLACK, team: 'helix', org: 'acme', channelId: 'C1', source: 'slack', threads: [SLACK],
      }),
    };
    registry.install(agentToolsExtension(agent, ['computer']));
    const ws = fakeWorkspace();
    const ctx = BACKGROUND_CONTEXT;
    const harness = await Harness.open(new MemoryStorage(), {
      models, registry, env: () => computerEnv(async () => ws),
    }, ctx);
    const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-model' } } });
    let system = '';
    let echoed = '';
    faux.setResponses([
      (context) => {
        system = context.messages.filter((m) => m.role === 'system')
          .map((m) => Object.values(m.sections || {}).join('\n\n') || m.content).join('\n');
        return fauxAssistantMessage(fauxToolCall('bash', { command: 'echo "$ACME_API_KEY $ACME_USER"' }), { stopReason: 'toolUse' });
      },
      (context) => {
        const last = context.messages[context.messages.length - 1];
        echoed = last.content.map((c) => c.text).join('');
        return fauxAssistantMessage('Done.');
      },
    ]);
    const sub = await root.submit({ type: 'input', content: 'New message in the thread' }, ctx);
    assert.equal((await quiet(() => sub.wait(ctx))).status, 'done');
    await harness.close(ctx);
    assert.match(system, /Secrets: the team keeps API keys for you/);
    assert.match(system, /- \$ACME_API_KEY, sent to api\.acme\.example: The ticket API/);
    assert.ok(!system.includes(KEY));
    assert.equal(echoed.trim(), `${placeholder('ACME_API_KEY')} ${placeholder('ACME_USER')}`);
    assert.deepEqual(ws.runs[0].options.env, {
      ACME_API_KEY: placeholder('ACME_API_KEY'), ACME_USER: placeholder('ACME_USER'),
    });
  });
});
