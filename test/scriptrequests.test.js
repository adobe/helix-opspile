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
 * Scripts a person runs as themselves for a thread agent (src/agent/scriptrequest.js, the
 * record src/bashrequests.js): the agent's request_codemode, the inbox's tools a script may
 * call (src/scripttools.js), a person's Run and Deny, and what the agent is told each time.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { api } from '../src/api.js';
import {
  bashDeadline, bashWatchdog, denyBash, requestBash, runBash, runScript, WATCHDOG_SECONDS,
} from '../src/agent/bashrequest.js';
import { requestScript, SCRIPT_GUIDE, scriptOutcomeText } from '../src/agent/scriptrequest.js';
import { opspileExtension } from '../src/agent/tools.js';
import { cleanScript, MAX_OPEN, requestOf } from '../src/bashrequests.js';
import { inboxCall } from '../src/mcp.js';
import { TOOLS } from '../src/mcp-tools.js';
import { SCRIPT_TOOL_NAMES, SCRIPT_TOOLS } from '../src/scripttools.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, teams, channels and ids only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'helix', name: 'Helix' }],
};
const EVE = {
  id: 3, email: 'eve@staff.example', name: 'Eve', teams: [{ slug: 'other', name: 'Other' }],
};
const THREAD = 'slack:E1:C1:1.1';
const OTHER = 'slack:E1:C2:2.2';
const NOW = new Date('2026-11-05T10:00:00.000Z');

function env(extra = {}) {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'other', name: 'Other' }],
    people: [
      {
        id: 1, email: ADA.email, name: 'Ada', staff: 1, teams: ['helix'],
      },
      {
        id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
      },
      {
        id: 3, email: EVE.email, name: 'Eve', staff: 1, teams: ['other'],
      },
    ],
  });
  const thread = DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id,
    root_id, org, team, kind, channel_name, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, 'slack', 'E1', ?, ?, 'acme', 'helix', 'channel', ?, ?, '2026-10-21T10:00:00Z',
    '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z', 1, '2026-10-21T10:00:00Z')`);
  thread.run(THREAD, 'C1', '1.1', 'aem-acme', 'p/1.1/');
  thread.run(OTHER, 'C2', '2.2', 'aem-acme-ops', 'p/2.2/');
  DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff,
    counted, author_key) VALUES ('slack', 'E1', 'C1', '1.1', ?, '2026-10-21T10:00:00Z', 0, 1,
    'slack:E1:U9')`).run(THREAD);
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
    AGENTS: {},
    AGENT_CHANNELS: 'C1',
    AI_GATEWAY_ACCOUNT: 'acct',
    AGENT_GATEWAY: 'gw',
    AGENT_MODEL: 'm',
    BEDROCK_API_KEY: 'k',
    ...extra,
  };
}

/** A ThreadAgent as far as a script request goes: its schedules, its sandbox, its harness. */
function fakeAgent(e) {
  const agent = {
    env: e,
    name: THREAD,
    hasThread: true,
    bashRuns: new Map(),
    schedules: [],
    submitted: [],
    sandboxes: [],
    target: async () => ({
      key: THREAD, team: 'helix', org: 'acme', channelId: 'C1', source: 'slack', threads: [THREAD],
    }),
    async schedule(when, callback, payload) {
      agent.schedules.push({ when, callback, payload });
      return { id: `s${agent.schedules.length}` };
    },
    syncTools: async () => undefined,
    syncMcp: async () => undefined,
    currentTools: async () => [],
    // As the ThreadAgent's, in Node: QuickJS in a worker thread instead of on the object's.
    scriptSandbox: (tools) => {
      agent.sandboxes.push(tools.map((t) => t.name));
      return new CodemodeSandbox({ tools });
    },
    harness: {
      async submit(input, options) {
        agent.submitted.push([input, options]);
        return { accepted: true };
      },
    },
  };
  return agent;
}

const told = (agent) => agent.submitted.map(([input]) => input);
const ada = { id: 1, name: 'Ada' };
const SCRIPT = `const r = await tools.search_threads({ query: 'blog cards' });
text(r.threads.map((t) => t.title).join('\\n'));
return { found: r.threads.length };`;
const ask = (agent, args = {}, now = new Date()) => quiet(() => requestScript(agent, {
  code: SCRIPT,
  tools: ['search_threads'],
  reason: 'Looks for the thread in the other channel that answered this.',
  ...args,
}, now));

describe('the tools a script may call', () => {
  it('are tools of the inbox that only read, every person\'s, with the arguments it is told', () => {
    for (const t of SCRIPT_TOOLS) {
      const tool = TOOLS.find((x) => x.name === t.name);
      assert.ok(tool, `${t.name} is a tool of the inbox`);
      assert.equal(tool.annotations.readOnlyHint, true, `${t.name} only reads`);
      assert.ok(!tool.admin, `${t.name} is not the admin team's`);
      const props = Object.keys(tool.inputSchema.properties || {});
      const named = t.args.map((a) => a.replace(/\?$/, ''));
      assert.deepEqual(named.filter((a) => !props.includes(a)), [], `${t.name} has those arguments`);
      const needed = t.args.filter((a) => !a.endsWith('?'));
      assert.deepEqual(needed.sort(), [...(tool.inputSchema.required || [])].sort(), `${t.name}'s required ones`);
    }
  });

  it('are what the inbox runs for a script, as the person, and no other', async () => {
    const e = env();
    const asAda = inboxCall(e, ADA);
    assert.deepEqual((await asAda('whoami', {})).data.teams, [{ slug: 'helix', name: 'Helix' }]);
    assert.equal((await asAda('get_thread', { thread: OTHER })).data.thread, OTHER);
    // Not Eve's: she is not on the thread's team.
    assert.match((await inboxCall(e, EVE)('get_thread', { thread: OTHER })).error, /^Not found, or not in one of your teams/);
    // Tools that write, and the admin team's, are none a script has.
    assert.equal((await asAda('post_as_user', { thread: OTHER, text: 'hi' })).error, 'post_as_user is not a tool a script can call');
    assert.equal((await asAda('get_thread_trace', { thread: OTHER })).error, 'get_thread_trace is not a tool a script can call');
  });
});

describe('a script request', () => {
  it('needs a script, the tools it calls, a reason and a timeout the sandbox allows', () => {
    const ok = cleanScript({ code: 'return 1', tools: ['get_thread', 'get_thread'], reason: 'why' }, NOW);
    assert.deepEqual(ok, {
      kind: 'codemode',
      command: 'return 1',
      reason: 'why',
      env: [],
      tools: ['get_thread'],
      timeout: 60,
      deadline: '2026-11-06T10:00:00.000Z',
    });
    const bad = (args) => cleanScript({
      code: 'return 1', tools: ['get_thread'], reason: 'why', ...args,
    }, NOW).error;
    assert.match(bad({ code: ' ' }), /give the script/);
    assert.match(bad({ tools: [] }), /name the tools the script calls/);
    assert.match(bad({ tools: ['post_as_user'] }), /can call only search_threads, .* not post_as_user/);
    assert.match(bad({ reason: '' }), /say why/);
    assert.match(bad({ timeout: 181 }), /1 to 180 seconds/);
    assert.match(bad({ deadline: '8d' }), /at most 7 days/);
  });

  it('is the request_codemode of a thread\'s agent, with what it may call in its prompt', async () => {
    const e = env();
    const agent = fakeAgent(e);
    const names = (ctx) => opspileExtension(ctx).tools.map((t) => t.name);
    assert.ok(names(agent).includes('request_codemode'));
    assert.ok(!names({ ...agent, hasThread: false }).includes('request_codemode'));
    const ext = opspileExtension(agent);
    const guide = await ext.sections.find((s) => s.key === 'script-requests').render();
    assert.equal(guide, SCRIPT_GUIDE);
    for (const name of SCRIPT_TOOL_NAMES) {
      assert.match(guide, new RegExp(`\\n- ${name}\\(`));
    }
    assert.match(guide, /- get_thread\(\{ thread, limit\? \}\): /);

    const tool = ext.tools.find((t) => t.name === 'request_codemode');
    const res = await quiet(() => tool.execute({
      code: SCRIPT, tools: ['search_threads'], reason: 'Finds the other thread.', deadline: '2h',
    }, {}));
    assert.equal(res.isError, undefined);
    const [row] = e.DB.rows('SELECT * FROM bash_requests');
    assert.match(res.output[0].text, new RegExp(`^requested \\(request ${row.id}\\): the team sees the script under the thread, calling search_threads as whoever runs it, until ${row.deadline.replace('.', '\\.')}\\. Nothing ran yet\\.`));
    assert.deepEqual([row.kind, row.command, row.tools, row.env, row.status], ['codemode', SCRIPT, '["search_threads"]', '[]', 'pending']);
    assert.deepEqual(agent.schedules.map((s) => [s.when.toISOString(), s.callback, s.payload]), [
      [row.deadline, 'bashDeadline', { id: row.id }],
    ]);
    assert.deepEqual(e.notified, [{ team: 'helix', type: 'bash', thread: THREAD }]);
    const refused = await quiet(() => tool.execute({ code: SCRIPT, tools: ['kb_write'], reason: 'why' }, {}));
    assert.ok(refused.isError);
    assert.match(refused.output[0].text, /not kb_write\. Nothing was requested\.$/);
  });

  it('keeps the sidebar message it was asked in answer to, and says whom to tell', async () => {
    const e = env({ LOADER: {} });
    e.DB.sqlite.exec(`INSERT INTO agent_tool_switches (tool, scope, target, enabled, changed_by,
      changed_at) VALUES ('computer', 'team', 'helix', 1, 'Ada', '2026-10-21T10:00:00Z')`);
    const agent = { ...fakeAgent(e), sidebarMessage: async () => 'sb_1' };
    const { request } = await ask(agent);
    assert.equal(request.sidebar, 'sb_1');
    // A command too, asked in the same turn.
    const cmd = await quiet(() => requestBash(agent, { command: 'ls', reason: 'why' }));
    assert.equal(cmd.error || cmd.request.sidebar, 'sb_1');
    await quiet(() => denyBash(agent, { id: request.id, by: ada }));
    assert.match(told(agent)[0], /do not ask for the same script again\..*\n\nYou asked for it while you answered sidebar message sb_1: tell its author what came of it with sidebar_followup \(message sb_1\), not in your note, which does not reach them\.$/s);
    // Asked otherwise: no sidebar, nothing said of one.
    const { request: plain } = await ask(fakeAgent(e));
    assert.equal(plain.sidebar, null);
    assert.doesNotMatch(scriptOutcomeText(plain, { status: 'denied' }), /sidebar/);
  });

  it('counts with the commands towards what may wait at a time', async () => {
    const e = env();
    const agent = fakeAgent(e);
    for (let i = 0; i < MAX_OPEN; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.ok((await ask(agent)).request);
    }
    assert.match((await ask(agent)).error, /^5 of your requests are waiting for a person already/);
  });

  it('runs as the person, with only the tools it names, and the agent is told what it output', async () => {
    const e = env();
    const agent = fakeAgent(e);
    const { request } = await ask(agent, {
      code: `${SCRIPT.replace(/\nreturn .*$/, '')}
const seen = await Promise.resolve().then(() => tools.get_thread({})).catch((err) => err.message);
return { found: r.threads.length, seen };`,
    });
    e.notified.length = 0;
    const calls = [];
    const call = async (name, args) => {
      calls.push([name, args]);
      return { data: { threads: [{ title: 'Blog cards miss an article' }, { title: 'Cards sort by date' }] } };
    };
    const res = await quiet(() => runScript(agent, { id: request.id, by: ada, call }));
    assert.equal(res.ok, true);
    assert.deepEqual([res.request.status, res.request.error, res.request.by], ['done', null, { id: 1, name: 'Ada' }]);
    assert.ok(res.request.told_at);
    // The watchdog was armed before it ran; its sandbox had the one tool.
    assert.deepEqual(agent.schedules[1], {
      when: 60 + WATCHDOG_SECONDS, callback: 'bashWatchdog', payload: { id: request.id },
    });
    assert.deepEqual(agent.sandboxes, [['search_threads']]);
    assert.deepEqual(calls, [['search_threads', { query: 'blog cards' }]]);
    assert.equal(agent.bashRuns.size, 0);
    assert.deepEqual(e.notified.map((n) => n.type), ['bash', 'bash']);

    const [[input, options]] = agent.submitted;
    assert.deepEqual(options, { operationId: `codemode:${request.id}`, whenBusy: 'followUp' });
    assert.match(input, new RegExp(`^Ada \\(Adobe staff\\) ran the script you asked for with request_codemode \\(request ${request.id}\\) as themselves, with their permissions in the inbox\\. It returned after \\d+\\.\\d s\\. It called search_threads ×1\\.`));
    assert.match(input, /<script>\nconst r = await tools\.search_threads/);
    assert.match(input, /<output>\nBlog cards miss an article\nCards sort by date\n<\/output>\n<returned>\n\{\n {2}"found": 2,\n {2}"seen": "tools\.get_thread does not exist\. Available: search_threads\. .*"\n\}\n<\/returned>/);
    assert.match(input, /never put another customer's threads, names or details into this thread's draft or posts\.$/);

    // Once: a colleague is told who was first; it is no command to run either.
    const again = await runScript(agent, { id: request.id, by: { id: 2, name: 'Bo' }, call });
    assert.deepEqual([again.status, again.error], [409, 'Ada ran it already']);
    assert.equal((await runBash(agent, { id: request.id, values: {}, by: ada })).status, 404);
    const { request: next } = await ask(agent);
    assert.equal((await runScript(agent, { id: next.id, by: ada, call: null })).ok, true);
    // A command is not run as a script.
    e.DB.sqlite.prepare("UPDATE bash_requests SET kind = 'bash' WHERE id = ?").run(next.id);
    assert.equal((await runScript(agent, { id: next.id, by: ada, call })).status, 404);
  });

  it('tells a script that threw, a tool that failed and a timeout apart', async () => {
    const e = env();
    const agent = fakeAgent(e);
    const failing = async () => ({ error: 'Not found, or not in one of your teams.' });
    let { request } = await ask(agent, { code: 'await tools.search_threads({ query: "x" });' });
    await quiet(() => runScript(agent, { id: request.id, by: ada, call: failing }));
    let after = await requestOf(e, request.id);
    assert.deepEqual([after.status, after.error], ['done', 'Not found, or not in one of your teams.']);
    assert.match(told(agent)[0], /It threw after \d+\.\d s: Not found, or not in one of your teams\. It called search_threads ×1 \(1 failed\)\..*\(it output nothing\)/s);

    ({ request } = await ask(agent, { code: 'while (true) {}', timeout: 1 }));
    await quiet(() => runScript(agent, { id: request.id, by: ada, call: failing }));
    after = await requestOf(e, request.id);
    assert.equal(after.status, 'timeout');
    assert.match(told(agent)[1], /It was stopped after 1 s, its timeout, before it finished\. It called no tool\./);

    ({ request } = await ask(agent));
    const broken = {
      ...agent,
      scriptSandbox: () => {
        throw new Error('no isolate');
      },
    };
    await quiet(() => runScript(broken, { id: request.id, by: ada, call: failing }));
    after = await requestOf(e, request.id);
    assert.deepEqual([after.status, after.error], ['failed', 'the sandbox failed: no isolate']);
    assert.match(told(agent)[2], /^Ada \(Adobe staff\) approved the script .*, but it did not run to its end: the sandbox failed: no isolate\./);
  });

  it('is denied, expires and is lost as a command is, said as a script', async () => {
    const e = env();
    const agent = fakeAgent(e);
    let { request } = await ask(agent);
    const denied = await quiet(() => denyBash(agent, { id: request.id, by: ada }));
    assert.equal(denied.request.status, 'denied');
    assert.match(told(agent)[0], new RegExp(`^Ada \\(Adobe staff\\) denied the script you asked for with request_codemode \\(request ${request.id}\\): it did not run\\. .*do not ask for the same script again\\.`));

    ({ request } = await ask(agent, { deadline: '30m' }, new Date(Date.now() - 31 * 60 * 1000)));
    assert.deepEqual(await quiet(() => bashDeadline(agent, { id: request.id })), { result: 'told' });
    assert.match(told(agent)[1], /^Nobody ran the script you asked for with request_codemode .* before its deadline/);

    ({ request } = await ask(agent));
    e.DB.sqlite.prepare(`UPDATE bash_requests SET status = 'running', decided_by = 1,
      decided_at = ? WHERE id = ?`).run(new Date().toISOString(), request.id);
    assert.deepEqual(await quiet(() => bashWatchdog(agent, { id: request.id })), { result: 'told' });
    assert.equal((await requestOf(e, request.id)).error, 'the agent restarted while it ran');
    assert.match(told(agent)[2], /^Ada \(Adobe staff\) approved the script .*: the agent restarted while it ran\./);
  });

  it('says what the agent is told of what it output, cut where it is long', () => {
    const request = {
      id: 'r1', command: 'return 1', timeout: 60, deadline: '2026-11-06T10:00:00.000Z', by: null,
    };
    assert.match(scriptOutcomeText(request, { status: 'done', output: '', value: '' }), /^A colleague \(Adobe staff\) ran .* It returned\. It called no tool\.\n\n<script>\nreturn 1\n<\/script>\n\n\(it output nothing\)\n\nThis is what A colleague may see/);
    const long = scriptOutcomeText(request, { status: 'done', output: 'x'.repeat(30005), value: '' });
    assert.match(long, /x\n\[… 5 more characters left out\]\n<\/output>/);
    assert.match(scriptOutcomeText(request, { status: 'done', lost: true }), /What it output was lost before you could be told/);
  });
});

describe('the inbox and a script request', () => {
  /** The agents' binding, as the Worker reaches a ThreadAgent: by name, over RPC. */
  const bound = (e, agent) => ({
    ...e,
    AGENTS: {
      idFromName: (name) => name,
      get: () => ({
        __unsafe_ensureInitialized: async () => {},
        runScript: (r) => runScript(agent, r),
        denyBash: (r) => denyBash(agent, r),
      }),
    },
  });
  const call = (e, who, path, body, options = { inboxTools: inboxCall }) => quiet(() => api(
    new Request(`https://opspile.test${path}`, { method: 'POST', body: JSON.stringify(body) }),
    e,
    new URL(`https://opspile.test${path}`),
    { viewer: who, ...options },
  ));

  it('runs it as who clicks Run, with the tools of the inbox it names, and answers once it ended', async () => {
    const base = env();
    const agent = fakeAgent(base);
    const e = bound(base, agent);
    agent.env = e;
    const { request } = await ask(agent, {
      code: `const t = await tools.get_thread({ thread: '${OTHER}' });
const me = await Promise.resolve().then(() => tools.whoami()).catch((err) => err.message);
return { channel: t.channel, me };`,
      tools: ['get_thread'],
    });
    const body = { thread: THREAD, id: request.id };
    // Not on the thread's team: there is no such request.
    assert.equal((await call(e, EVE, '/api/bash/run', body)).status, 404);
    // A Worker that does not pass the inbox's tools runs no script.
    assert.equal((await call(e, ADA, '/api/bash/run', body, {})).status, 503);

    const res = await call(e, ADA, '/api/bash/run', body);
    assert.equal(res.status, 200);
    const done = await res.json();
    assert.deepEqual([done.ok, done.request.status, done.request.kind, done.request.tools], [true, 'done', 'codemode', ['get_thread']]);
    // What Ada may read, through the one tool it names; whoami it did not name.
    assert.match(told(agent)[0], /<returned>\n\{\n {2}"channel": "aem-acme-ops",\n {2}"me": "tools\.whoami does not exist\. Available: get_thread\. .*"\n\}\n<\/returned>/);
  });

  it('refuses, in the Worker too, a tool the request does not name', async () => {
    const base = env();
    let seen = null;
    const agent = fakeAgent(base);
    const e = {
      ...bound(base, agent),
      AGENTS: {
        idFromName: (name) => name,
        get: () => ({
          __unsafe_ensureInitialized: async () => {},
          runScript: async (r) => {
            seen = [await r.call('whoami', {}), (await r.call('get_thread', { thread: OTHER })).data.thread];
            return { ok: true };
          },
        }),
      },
    };
    const { request } = await ask(agent, { tools: ['get_thread'] });
    await call(e, ADA, '/api/bash/run', { thread: THREAD, id: request.id });
    assert.deepEqual(seen, [{ error: 'whoami is not one of the tools this script may call' }, OTHER]);
  });
});
