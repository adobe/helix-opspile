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
  afterEach, beforeEach, describe, it,
} from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { Bash, InMemoryFs } from 'just-bash';
import { toolsFor } from '../src/agent/agenttools.js';
import { COMPUTER_CWD, computerEnv } from '../src/agent/computer.js';
import { postAsApp } from '../src/agent/posting.js';
import { agentToolsExtension, opspileExtension } from '../src/agent/tools.js';
import { kbAdmin } from '../src/kbadmin.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up people, teams, channels, ids and tokens only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1,
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1,
};
const admin = { ...ADA, teams: [{ slug: 'admin', role: 'member' }] };
const manager = { ...BO, teams: [{ slug: 'helix', role: 'manager' }] };
const outsider = { ...BO, teams: [{ slug: 'edge', role: 'manager' }] };

const SLACK = 'slack:E1:C1:1792584000.000100';
const TEAMS = 'teams:TN1:G1:19:abc@thread.tacv2:1792584000000';
const DISCORD = 'discord:900:910:920';

function env(extra = {}) {
  const DB = d1({
    people: [{ ...ADA, teams: ['admin'] }, { ...BO, teams: ['helix'] }],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix' }, { slug: 'edge', name: 'Edge' }],
  });
  const thread = (key, source, tenant, channel, root) => DB.sqlite.prepare(`INSERT INTO threads
      (thread, source, tenant, channel_id, root_id, org, team, kind, channel_name, path, any_at,
        updated_at)
    VALUES (?, ?, ?, ?, ?, 'acme', 'helix', 'channel', 'aem-acme', 'channels/x/', ?, ?)`)
    .run(key, source, tenant, channel, root, '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z');
  thread(SLACK, 'slack', 'E1', 'C1', '1792584000.000100');
  thread(TEAMS, 'teams', 'TN1', '19:abc@thread.tacv2', '1792584000000');
  thread(DISCORD, 'discord', '900', '910', '920');
  DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at) VALUES
    ('kb-team-helix', 'team', 'helix', 'x', '2026-10-20T09:00:00Z'),
    ('kb-org-acme', 'org', 'acme', 'x', '2026-10-20T09:00:00Z')`);
  return {
    DB,
    SLACK_BOT_TOKEN: 'xoxb-made-up',
    DISCORD_GUILDS: '900',
    DISCORD_BOT_TOKEN: 'made-up-discord-token',
    LOADER: {},
    ...extra,
  };
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

const target = (key, source, channelId) => ({
  key, team: 'helix', org: 'acme', channelId, source, threads: [key],
});

describe('agent tools', () => {
  it('are off until a team or a channel turns them on; a channel wins over its team', async () => {
    const e = env();
    const slack = target(SLACK, 'slack', 'C1');
    assert.deepEqual(await toolsFor(e, slack), []);

    let res = await call(e, manager, 'PUT', '/api/kb/tools', { tool: 'computer', team: 'helix', enabled: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.switch.enabled, true);
    assert.equal(res.body.switch.by, 'Bo');
    assert.deepEqual(await toolsFor(e, slack), ['computer']);

    res = await call(e, manager, 'PUT', '/api/kb/tools', { tool: 'post_message', channel: 'C1', enabled: true });
    assert.equal(res.status, 200);
    res = await call(e, manager, 'PUT', '/api/kb/tools', { tool: 'computer', channel: 'C1', enabled: false });
    assert.deepEqual(await toolsFor(e, slack), ['post_message']);
    // Back to its team's switch.
    res = await call(e, manager, 'PUT', '/api/kb/tools', { tool: 'computer', channel: 'C1', enabled: null });
    assert.equal(res.body.switch, null);
    assert.deepEqual(await toolsFor(e, slack), ['computer', 'post_message']);

    // Teams threads cannot post; a deployment without a Worker Loader has no computer.
    await call(e, admin, 'PUT', '/api/kb/tools', { tool: 'post_message', team: 'helix', enabled: true });
    assert.deepEqual(await toolsFor(e, target(TEAMS, 'teams', '19:abc@thread.tacv2')), ['computer']);
    assert.deepEqual(await toolsFor({ ...e, LOADER: undefined }, slack), ['post_message']);
    // An agent without a thread (filing seeded knowledge) gets none.
    assert.deepEqual(await toolsFor(e, { ...slack, key: null }), []);
  });

  it('are listed and switched by the admin team and the team\'s managers only', async () => {
    const e = env({ LOADER: undefined });
    let res = await call(e, outsider, 'PUT', '/api/kb/tools', { tool: 'computer', team: 'helix', enabled: true });
    assert.equal(res.status, 404);
    res = await call(e, outsider, 'PUT', '/api/kb/tools', { tool: 'computer', channel: 'C1', enabled: true });
    assert.equal(res.status, 404);
    res = await call(e, manager, 'PUT', '/api/kb/tools', { tool: 'rm_rf', team: 'helix', enabled: true });
    assert.equal(res.status, 400);
    res = await call(e, manager, 'PUT', '/api/kb/tools', { tool: 'computer', team: 'helix', enabled: null });
    assert.equal(res.status, 400);
    res = await call(e, outsider, 'GET', '/api/kb/tools?repo=kb-team-helix');
    assert.equal(res.status, 404);
    res = await call(e, manager, 'GET', '/api/kb/tools?repo=kb-org-acme');
    assert.equal(res.status, 404);

    await call(e, manager, 'PUT', '/api/kb/tools', { tool: 'post_message', channel: 'C1', enabled: true });
    res = await call(e, manager, 'GET', '/api/kb/tools?repo=kb-team-helix');
    assert.equal(res.status, 200);
    const [post, computer] = res.body.tools;
    assert.equal(post.tool, 'post_message');
    assert.deepEqual(post.platforms, ['slack', 'discord']);
    assert.deepEqual(post.team, { enabled: false });
    assert.equal(post.channels.C1.enabled, true);
    assert.equal(post.problem, null);
    assert.deepEqual(computer.names, ['bash']);
    assert.match(computer.problem, /Worker Loader/);
    // A customer's knowledge base shows the channel switches, not a team's.
    res = await call(e, admin, 'GET', '/api/kb/tools?repo=kb-org-acme');
    assert.equal(res.body.tools[0].team, null);
    assert.equal(res.body.tools[0].channels.C1.enabled, true);
  });
});

describe('posting as the opspile app', () => {
  const realFetch = globalThis.fetch;
  let sent;
  beforeEach(() => {
    sent = [];
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      sent.push({ url: String(url), auth: init.headers && init.headers.authorization, body });
      const u = new URL(url);
      if (u.pathname === '/api/chat.postMessage') {
        return Response.json({ ok: true, ts: '1792584999.000900' });
      }
      if (u.pathname === '/api/v10/channels/920/messages') {
        // 920 is a message, not a thread.
        return Response.json({ code: 10003 }, { status: 404 });
      }
      if (u.pathname === '/api/v10/channels/910/messages') {
        return Response.json({ id: '930' });
      }
      throw new Error(`unexpected ${url}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('replies in the Slack thread with the bot token', async () => {
    const res = await postAsApp(env(), SLACK, 'Purges take *up to* 5 minutes <here>');
    assert.deepEqual(res, { ok: true, platform: 'slack', id: '1792584999.000900' });
    assert.equal(sent[0].auth, 'Bearer xoxb-made-up');
    assert.deepEqual(sent[0].body, {
      channel: 'C1', thread_ts: '1792584000.000100', text: 'Purges take *up to* 5 minutes &lt;here&gt;',
    });
  });

  it('replies inline on Discord when the conversation is no Discord thread, without pings', async () => {
    const res = await postAsApp(env(), DISCORD, 'On it @everyone');
    assert.deepEqual(res, { ok: true, platform: 'discord', id: '930' });
    assert.equal(sent[0].auth, 'Bot made-up-discord-token');
    assert.deepEqual(sent[1].body, {
      content: 'On it @everyone',
      allowed_mentions: { parse: [] },
      message_reference: { message_id: '920', fail_if_not_exists: false },
    });
  });

  it('cannot post to Teams, nor too much', async () => {
    assert.match((await postAsApp(env(), TEAMS, 'Hi')).error, /cannot post to Teams/);
    assert.match((await postAsApp(env(), DISCORD, 'x'.repeat(2001))).error, /up to 2000/);
    assert.equal(sent.length, 0);
  });
});

/** A Cloudflare Computer workspace in memory: just-bash over one filesystem that stays. */
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
        const r = await bash.exec(command, { cwd: options.cwd });
        const { exitCode, stdout, stderr } = r;
        return { result: async () => ({ exitCode, stdout, stderr }) };
      },
    },
  };
}

describe('the agent\'s switchable tools', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('give it pi\'s bash on its computer and post_message, each with its guidance', async () => {
    const e = env();
    const posts = [];
    globalThis.fetch = async (url, init) => {
      posts.push(JSON.parse(init.body));
      return Response.json({ ok: true, ts: '1792584999.000900' });
    };
    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-model' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    const posted = [];
    const agent = {
      env: e,
      hasThread: true,
      target: async () => ({ ...target(SLACK, 'slack', 'C1'), channelName: 'aem-acme' }),
      verdicts: async () => new Map(),
      posted: async (id) => posted.push(id),
    };
    const ws = fakeWorkspace();
    registry.install(opspileExtension(agent));
    // Off first: as ThreadAgent installs it before Pi has been told anything.
    registry.install(agentToolsExtension(agent, []));
    const ctx = BACKGROUND_CONTEXT;
    const harness = await Harness.open(new MemoryStorage(), {
      models, registry, env: () => computerEnv(async () => ws),
    }, ctx);
    const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-model' } } });
    // Then turned on, as syncTools does: the extension is replaced in place.
    registry.install(agentToolsExtension(agent, ['computer', 'post_message']));

    const results = [];
    let system = '';
    const step = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
    const capture = (next) => (context) => {
      const last = context.messages[context.messages.length - 1];
      results.push({ text: last.content.map((c) => c.text).join(''), error: last.isError });
      return next;
    };
    faux.setResponses([
      (context) => {
        system = context.messages.filter((m) => m.role === 'system')
          .map((m) => Object.values(m.sections || {}).join('\n\n') || m.content).join('\n');
        return step('bash', { command: 'printf "a,1\\nb,2\\n" > data.csv && pwd' });
      },
      capture(step('bash', { command: 'cut -d, -f2 data.csv | sort -r; ls' })),
      capture(step('bash', { command: 'cat missing.txt' })),
      capture(step('post_message', { text: 'Purges take up to 5 minutes.' })),
      capture(fauxAssistantMessage('Posted the purge time.')),
    ]);
    const sub = await root.submit({ type: 'input', content: 'New message in the thread' }, ctx);
    assert.equal((await quiet(() => sub.wait(ctx))).status, 'done');
    await harness.close(ctx);

    assert.match(system, /<posting>\nThe team turned on post_message/);
    assert.match(system, /<computer>\nYou have a computer: the bash tool runs commands in a shell of your own, with the working directory \/workspace/);
    const [pwd, sum, missing, post] = results;
    assert.equal(pwd.text.trim(), '/workspace');
    // The file is still there for the next command.
    assert.equal(sum.text.trim(), '2\n1\ndata.csv');
    assert.ok(missing.error);
    assert.match(missing.text, /missing\.txt/);
    assert.match(post.text, /^posted on Slack \(message 1792584999\.000900\)\./);
    assert.deepEqual(posts, [{ channel: 'C1', thread_ts: '1792584000.000100', text: 'Purges take up to 5 minutes.' }]);
    assert.deepEqual(posted, ['1792584999.000900']);
    assert.equal(ws.runs[0].options.cwd, '/workspace');
  });

  it('report a command the shell stopped at its timeout as one', async () => {
    const stopped = computerEnv(async () => ({
      runtime: {
        exec: async (command, options) => ({
          result: async () => ({ exitCode: 124, stdout: '', stderr: `stopped after ${options.timeoutMs} ms\n` }),
        }),
      },
    }));
    let out = '';
    const onOutput = (t) => {
      out += t;
    };
    const r = await stopped.exec('sleep 5', { timeout: 1, onOutput });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'timeout');
    assert.equal(out, 'stopped after 1000 ms\n');
    assert.equal((await stopped.exec(['ls'], {})).error.code, 'spawn_error');
  });

  it('are absent while off', async () => {
    const ext = agentToolsExtension({ env: env(), hasThread: true }, []);
    assert.deepEqual((ext.tools || []).map((t) => t.name), []);
    const seed = agentToolsExtension({ env: env(), hasThread: false }, ['post_message', 'computer']);
    assert.deepEqual((seed.tools || []).map((t) => t.name), ['bash']);
  });
});
