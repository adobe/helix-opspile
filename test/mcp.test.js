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
import { render } from '../src/channels.js';
import { headerValue, mcp, PROTOCOL } from '../src/mcp.js';
import { checkConfirmState, confirmState, TOOLS } from '../src/mcp-tools.js';
import { seal } from '../src/post.js';
import { d1 } from './d1.js';

// Made-up keys, ids and people only.
const KEY = Buffer.alloc(32, 7).toString('base64url');
const ORIGIN = 'https://inbox.example';
const ME = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'helix', name: 'Helix' }],
};
const SLACK = 'slack:E1:C1:1.1';
const META = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

function bucket(files) {
  return {
    async list({ prefix }) {
      const keys = Object.keys(files).filter((k) => k.startsWith(prefix));
      return { objects: keys.map((key) => ({ key })) };
    },
    async get(key) {
      return key in files ? { text: async () => files[key] } : null;
    },
  };
}

function env() {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }],
    people: [
      {
        id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
      },
      { id: 2, email: 'cy@customer.example', name: 'Cy' },
    ],
  });
  const sql = (q, ...a) => DB.sqlite.prepare(q).run(...a);
  sql(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, path, root_at,
    last_at, last_staff, any_at, messages, updated_at, channel_name, title) VALUES (?, 'slack', 'E1',
    'C1', '1.1', 'acme', 'helix', 'p/', '2026-10-21T10:00:00Z', '2026-10-21T10:05:00Z', 0,
    '2026-10-21T10:05:00Z', 2, '2026-10-21T10:05:00Z', 'acme-ops', 'Site is down')`, SLACK);
  const msg = (id, at, staff, author) => sql(`INSERT INTO messages (source, tenant, channel_id,
    id, thread, at, staff, counted, author, author_key) VALUES ('slack', 'E1', 'C1', ?, ?, ?, ?, 1,
    ?, ?)`, id, SLACK, at, staff, author, `slack:E1:${author === 'Ada' ? 'U1' : 'U7'}`);
  msg('1.1', '2026-10-21T10:00:00Z', 0, 'Cy');
  msg('1.2', '2026-10-21T10:05:00Z', 0, 'Cy');
  const id = (user, name, person, email) => sql(`INSERT INTO identities (source, tenant, user_id,
    kind, name, email, person, avatar, fetched_at) VALUES ('slack', 'E1', ?, 'person', ?, ?, ?, '',
    '2099-01-01T00:00:00Z')`, user, name, email, person);
  id('U1', 'Ada', 1, 'ada@staff.example');
  id('U7', 'Cy', 2, 'cy@customer.example');
  const author = { kind: 'person', name: 'Cy', staff: false };
  const file = (mid, at, body) => render({
    source: 'slack', thread: SLACK, id: mid, at, author,
  }, body);
  return {
    DB,
    CHANNELS: bucket({
      'p/1.1.md': file('1.1', '2026-10-21T10:00:00Z', 'Our site is down'),
      'p/1.2.md': file('1.2', '2026-10-21T10:05:00Z', 'Still down, @Ada?'),
    }),
    TOKEN_KEY: KEY,
    STAFF_DOMAINS: 'staff.example',
    PUBLIC_ORIGIN: ORIGIN,
  };
}

/** A modern request, with the headers the spec requires. */
function req(method, params = {}, { headers = {}, meta = META, id = 1 } = {}) {
  return new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': meta['io.modelcontextprotocol/protocolVersion'] || '',
      'mcp-method': method,
      ...(params.name ? { 'mcp-name': params.name } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id, method, params: { ...params, _meta: meta },
    }),
  });
}
const legacy = (method, params, headers = {}) => new Request(`${ORIGIN}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 7, method, params,
  }),
});
const send = async (e, request, viewer = ME) => {
  const res = await mcp(request, e, { viewer });
  const empty = res.status === 202 || res.status === 405;
  return { status: res.status, body: empty ? null : await res.json() };
};
const callTool = (e, name, args, opts) => send(e, req('tools/call', { name, arguments: args }, opts));
const structured = (r) => r.body.result.structuredContent;

describe('mcp transport (2026-07-28)', () => {
  it('answers server/discover with versions, capabilities, identity and caching hints', async () => {
    const { status, body } = await send(env(), req('server/discover'));
    assert.equal(status, 200);
    assert.equal(body.id, 1);
    assert.equal(body.result.resultType, 'complete');
    assert.deepEqual(body.result.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
    assert.deepEqual(body.result.capabilities, { tools: {} });
    // eslint-disable-next-line no-underscore-dangle
    assert.equal(body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'helix-opspile');
    assert.ok(body.result.ttlMs >= 0);
    assert.equal(body.result.cacheScope, 'public');
  });

  it('lists the tools in a fixed order, without their implementation', async () => {
    const { body } = await send(env(), req('tools/list'));
    const everyones = TOOLS.filter((t) => !t.admin).map((t) => t.name);
    assert.deepEqual(body.result.tools.map((t) => t.name), everyones);
    const plain = (t) => !('run' in t) && !('admin' in t) && t.inputSchema.type === 'object';
    assert.ok(body.result.tools.every(plain));
    assert.equal(body.result.cacheScope, 'public');
    assert.equal(body.result.resultType, 'complete');
    assert.ok(Number.isInteger(body.result.ttlMs));
  });

  it('rejects an unsupported version, listing the supported ones', async () => {
    const meta = { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' };
    const { status, body } = await send(env(), req('tools/list', {}, { meta }));
    assert.equal(status, 400);
    assert.equal(body.error.code, -32022);
    assert.equal(body.error.data.requested, '1900-01-01');
    assert.ok(body.error.data.supported.includes(PROTOCOL));
  });

  it('rejects missing _meta fields with -32602', async () => {
    const meta = { 'io.modelcontextprotocol/protocolVersion': PROTOCOL };
    const { status, body } = await send(env(), req('tools/list', {}, { meta }));
    assert.equal(status, 400);
    assert.equal(body.error.code, -32602);
  });

  it('rejects headers that do not match the body (HeaderMismatch)', async () => {
    for (const headers of [
      { 'mcp-method': 'tools/call' },
      { 'mcp-protocol-version': '2025-11-25' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { status, body } = await send(env(), req('tools/list', {}, { headers }));
      assert.equal(status, 400);
      assert.equal(body.error.code, -32020);
    }
    const wrongName = await send(env(), req('tools/call', { name: 'whoami', arguments: {} }, { headers: { 'mcp-name': 'get_thread' } }));
    assert.equal(wrongName.body.error.code, -32020);
  });

  it('decodes a Base64 Mcp-Name before comparing', async () => {
    assert.equal(headerValue('=?base64?d2hvYW1p?='), 'whoami');
    assert.equal(headerValue('whoami'), 'whoami');
    const { status } = await send(env(), req('tools/call', { name: 'whoami', arguments: {} }, { headers: { 'mcp-name': '=?base64?d2hvYW1p?=' } }));
    assert.equal(status, 200);
  });

  it('answers unknown methods with 404 and -32601, and has no ping, GET or sessions', async () => {
    const { status, body } = await send(env(), req('subscriptions/listen'));
    assert.equal(status, 404);
    assert.equal(body.error.code, -32601);
    assert.equal((await send(env(), req('ping'))).status, 404);
    const get = await mcp(new Request(`${ORIGIN}/mcp`), env(), { viewer: ME });
    assert.equal(get.status, 405);
  });

  it('accepts notifications with 202', async () => {
    const res = await mcp(new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }), env(), { viewer: ME });
    assert.equal(res.status, 202);
  });

  it('refuses other origins and requests without an Access assertion', async () => {
    const r = req('tools/list', {}, { headers: { origin: 'https://evil.example' } });
    assert.equal((await mcp(r, env(), { viewer: ME })).status, 403);
    const same = req('tools/list', {}, { headers: { origin: ORIGIN } });
    assert.equal((await mcp(same, env(), { viewer: ME })).status, 200);
    const anon = await mcp(req('tools/list'), { ...env(), ACCESS_TEAM_DOMAIN: 'https://t.example', ACCESS_AUD: 'aud' });
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('www-authenticate'), /^Bearer resource_metadata="https:\/\/inbox\.example\/\.well-known\/oauth-protected-resource"$/);
  });
});

describe('mcp transport (2025 clients)', () => {
  it('answers initialize and serves tools without _meta or a session', async () => {
    const init = await send(env(), legacy('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } }));
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.equal(init.body.result.serverInfo.name, 'helix-opspile');
    const list = await send(env(), legacy('tools/list', {}, { 'mcp-protocol-version': '2025-06-18' }));
    assert.equal(list.body.result.tools.length, TOOLS.filter((t) => !t.admin).length);
    assert.equal(list.body.result.resultType, undefined);
    const ping = await send(env(), legacy('ping', {}));
    assert.deepEqual(ping.body.result, {});
  });

  it('offers the latest 2025 revision to an unknown one, and refuses initialize in 2026-07-28', async () => {
    const init = await send(env(), legacy('initialize', { protocolVersion: '2024-11-05' }));
    assert.equal(init.body.result.protocolVersion, '2025-11-25');
    assert.equal((await send(env(), req('initialize', { protocolVersion: PROTOCOL }))).status, 404);
  });
});

describe('mcp tools', () => {
  const realFetch = globalThis.fetch;
  let calls;
  beforeEach(() => {
    calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true, ts: '1.3' }));
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function connected() {
    const e = env();
    e.DB.sqlite.prepare(`INSERT INTO user_tokens (person, platform, user_id, access_token, scope,
      updated_at) VALUES (1, 'slack', 'U1', ?, 'chat:write,reactions:write', '2026-10-21T10:00:00Z')`)
      .run(await seal(e, 'slack-token'));
    return e;
  }

  it('whoami names the person and their teams', async () => {
    const r = await callTool(env(), 'whoami', {});
    assert.equal(structured(r).name, 'Ada');
    assert.deepEqual(structured(r).teams, [{ slug: 'helix', name: 'Helix' }]);
    assert.equal(JSON.parse(r.body.result.content[0].text).name, 'Ada');
  });

  it('list_threads filters by who has the next move, and explains bad values', async () => {
    const all = structured(await callTool(env(), 'list_threads', {}));
    assert.equal(all.matched, 1);
    assert.deepEqual(
      [all.threads[0].thread, all.threads[0].customer, all.threads[0].waiting_on],
      [SLACK, 'acme', 'us'],
    );
    assert.equal(structured(await callTool(env(), 'list_threads', { waiting_on: ['customer'] })).matched, 0);
    const bad = await callTool(env(), 'list_threads', { urgency: ['extreme'] });
    assert.equal(bad.body.result.isError, true);
    assert.match(bad.body.result.content[0].text, /Use: low, normal, high, critical/);
    const team = await callTool(env(), 'list_threads', { team: 'other' });
    assert.match(team.body.result.content[0].text, /Your teams: helix/);
  });

  it('get_thread returns messages with ids, and nothing for other teams', async () => {
    const t = structured(await callTool(env(), 'get_thread', { thread: SLACK }));
    assert.equal(t.customer, 'acme');
    assert.deepEqual(t.messages.map((m) => [m.message, m.text]), [
      [`${SLACK}|1.1`, 'Our site is down'], [`${SLACK}|1.2`, 'Still down, @Ada?'],
    ]);
    const other = { ...ME, teams: [{ slug: 'edge', name: 'Edge' }] };
    const res = await send(env(), req('tools/call', { name: 'get_thread', arguments: { thread: SLACK } }), other);
    assert.equal(res.body.result.isError, true);
  });

  it('post_as_user posts as the person when the client cannot ask the user', async () => {
    const r = await callTool(await connected(), 'post_as_user', { thread: SLACK, text: 'Looking now' });
    assert.equal(structured(r).ok, true);
    assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
    assert.equal(calls[0].body.text, 'Looking now');
  });

  it('post_as_user asks the user first (MRTR elicitation), and posts only after they accept', async () => {
    const e = await connected();
    const meta = { ...META, 'io.modelcontextprotocol/clientCapabilities': { elicitation: {} } };
    const args = { thread: SLACK, text: 'Looking now' };
    const first = await callTool(e, 'post_as_user', args, { meta });
    assert.equal(first.body.result.resultType, 'input_required');
    assert.equal(first.body.result.inputRequests.confirm_post.method, 'elicitation/create');
    assert.equal(calls.length, 0);
    const retry = (answer, state = first.body.result.requestState, a = args) => send(e, req('tools/call', {
      name: 'post_as_user', arguments: a, inputResponses: { confirm_post: answer }, requestState: state,
    }, { meta, id: 2 }));
    const declined = await retry({ action: 'decline' });
    assert.match(declined.body.result.content[0].text, /did not confirm/);
    const tampered = await retry({ action: 'accept' }, first.body.result.requestState, { ...args, text: 'Something else' });
    assert.match(tampered.body.result.content[0].text, /does not match/);
    assert.equal(calls.length, 0);
    const accepted = await retry({ action: 'accept', content: {} });
    assert.equal(structured(accepted).ok, true);
    assert.equal(calls.length, 1);
  });

  it('confirmation state is bound to the person, the call and a deadline', async () => {
    const e = env();
    const args = { thread: SLACK, text: 'x' };
    const state = await confirmState(e, ME, 'post_as_user', args, 1000);
    assert.equal(await checkConfirmState(e, ME, 'post_as_user', args, state, 2000), true);
    assert.equal(await checkConfirmState(e, { ...ME, id: 2 }, 'post_as_user', args, state, 2000), false);
    assert.equal(await checkConfirmState(e, ME, 'post_as_user', args, state, 1000 + 11 * 60 * 1000), false);
    assert.equal(await checkConfirmState(e, ME, 'post_as_user', args, `${state}x`, 2000), false);
  });

  it('post_as_user turns names into mentions, and says when a name is unknown', async () => {
    const e = await connected();
    const ok = await callTool(e, 'post_as_user', { thread: SLACK, text: 'Thanks @Cy', mention: ['Cy'] });
    assert.equal(structured(ok).ok, true);
    assert.equal(calls[0].body.text, 'Thanks <@U7>');
    const unknown = await callTool(e, 'post_as_user', { thread: SLACK, text: 'Hi @Bo', mention: ['Bo'] });
    assert.match(unknown.body.result.content[0].text, /Nobody named "Bo"/);
  });

  it('post_as_user says when the platform account is not connected', async () => {
    const r = await callTool(env(), 'post_as_user', { thread: SLACK, text: 'Hi' });
    assert.equal(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /connect your Slack account first.*connect their Slack account/);
  });

  it('refuses writes when viewing as someone else', async () => {
    const as = { ...ME, readonly: true };
    for (const [name, args] of [['post_as_user', { thread: SLACK, text: 'x' }],
      ['post_as_bot', { thread: SLACK, text: 'x' }], ['post_draft', { thread: SLACK, text: 'x' }],
      ['react_to_message', { message: `${SLACK}|1.1`, emoji: 'eyes' }], ['resolve_thread', { thread: SLACK }]]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await send(env(), req('tools/call', { name, arguments: args }), as);
      assert.match(r.body.result.content[0].text, /Read-only/);
    }
    assert.equal(calls.length, 0);
  });

  it('react_to_message reacts as the person, and checks the emoji', async () => {
    const e = await connected();
    const bad = await callTool(e, 'react_to_message', { message: `${SLACK}|1.2`, emoji: 'skull' });
    assert.match(bad.body.result.content[0].text, /Unsupported emoji/);
    const ok = await callTool(e, 'react_to_message', { message: `${SLACK}|1.2`, emoji: 'eyes' });
    assert.equal(structured(ok).ok, true);
    assert.equal(calls.at(-1).url, 'https://slack.com/api/reactions.add');
    assert.deepEqual(calls.at(-1).body, { channel: 'C1', timestamp: '1.2', name: 'eyes' });
  });

  it('post_draft saves the shared draft, and asks for the version before replacing one', async () => {
    const e = env();
    const first = await callTool(e, 'post_draft', { thread: SLACK, text: 'We are on it, @Cy', mention: ['Cy'] });
    assert.equal(structured(first).ok, true);
    const { version } = structured(first).draft;
    assert.equal(structured(first).draft.by, 'Ada');
    assert.equal(calls.length, 0);
    const row = e.DB.sqlite.prepare('SELECT body, mentions FROM drafts WHERE thread = ?').get(SLACK);
    assert.equal(row.body, 'We are on it, @Cy');
    assert.deepEqual(JSON.parse(row.mentions), [{ id: 'U7', name: 'Cy' }]);
    const shown = structured(await callTool(e, 'get_thread', { thread: SLACK }));
    assert.deepEqual(shown.draft, { text: 'We are on it, @Cy', by: 'Ada', version });
    const blind = await callTool(e, 'post_draft', { thread: SLACK, text: 'Other text' });
    assert.equal(blind.body.result.isError, true);
    assert.match(blind.body.result.content[0].text, new RegExp(`already has a shared draft.*base "${version}".*We are on it`, 's'));
    const replaced = await callTool(e, 'post_draft', { thread: SLACK, text: 'Other text', base: version });
    assert.equal(structured(replaced).draft.text, 'Other text');
  });

  it('post_as_user with `draft` uses the shared draft up', async () => {
    const e = await connected();
    const saved = structured(await callTool(e, 'post_draft', { thread: SLACK, text: 'Looking now' }));
    const r = await callTool(e, 'post_as_user', { thread: SLACK, text: 'Looking now', draft: saved.draft.version });
    assert.match(structured(r).note, /used up/);
    assert.equal(e.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 0);
  });

  const appOn = (e, scope = 'team', target = 'helix') => e.DB.sqlite.prepare(`INSERT INTO
    agent_tool_switches (tool, scope, target, enabled, changed_by, changed_at)
    VALUES ('post_message', ?, ?, 1, 'Ada', '2026-10-21T10:00:00Z')`).run(scope, target);

  it('post_as_bot posts as the opspile app only where Post messages is on', async () => {
    const e = { ...env(), SLACK_BOT_TOKEN: 'xoxb-test' };
    const off = await callTool(e, 'post_as_bot', { thread: SLACK, text: 'Looking now' });
    assert.equal(off.body.result.isError, true);
    assert.match(off.body.result.content[0].text, /Post messages/);
    assert.equal(structured(await callTool(e, 'get_thread', { thread: SLACK })).can_post_as_bot, false);
    assert.equal(calls.length, 0);
    appOn(e);
    assert.equal(structured(await callTool(e, 'get_thread', { thread: SLACK })).can_post_as_bot, true);
    const r = await callTool(e, 'post_as_bot', { thread: SLACK, text: 'Looking now' });
    assert.equal(structured(r).ok, true);
    assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
    assert.deepEqual([calls[0].body.channel, calls[0].body.thread_ts, calls[0].body.text], ['C1', '1.1', 'Looking now']);
    // A channel's own switch wins over its team's.
    e.DB.sqlite.prepare(`INSERT INTO agent_tool_switches (tool, scope, target, enabled, changed_by,
      changed_at) VALUES ('post_message', 'channel', 'C1', 0, 'Ada', '2026-10-21T10:00:00Z')`).run();
    const muted = await callTool(e, 'post_as_bot', { thread: SLACK, text: 'Again' });
    assert.equal(muted.body.result.isError, true);
    assert.equal(calls.length, 1);
  });

  it('post_as_bot says when the platform has no opspile bot, and asks the user first', async () => {
    const plain = env();
    appOn(plain);
    const none = await callTool(plain, 'post_as_bot', { thread: SLACK, text: 'Hi' });
    assert.match(none.body.result.content[0].text, /Slack bot is not set up/);
    const e = { ...env(), SLACK_BOT_TOKEN: 'xoxb-test' };
    appOn(e);
    const meta = { ...META, 'io.modelcontextprotocol/clientCapabilities': { elicitation: {} } };
    const args = { thread: SLACK, text: 'Looking now' };
    const first = await callTool(e, 'post_as_bot', args, { meta });
    assert.match(first.body.result.inputRequests.confirm_post.params.message, /as the opspile app/);
    assert.equal(calls.length, 0);
    // A confirmation for post_as_user does not pass for post_as_bot.
    const other = await confirmState(e, ME, 'post_as_user', args);
    const swapped = await send(e, req('tools/call', {
      name: 'post_as_bot', arguments: args, inputResponses: { confirm_post: { action: 'accept' } }, requestState: other,
    }, { meta, id: 2 }));
    assert.match(swapped.body.result.content[0].text, /does not match/);
    const accepted = await send(e, req('tools/call', {
      name: 'post_as_bot', arguments: args, inputResponses: { confirm_post: { action: 'accept' } }, requestState: first.body.result.requestState,
    }, { meta, id: 3 }));
    assert.equal(structured(accepted).ok, true);
    assert.equal(calls.length, 1);
  });

  describe('get_thread_trace (admin team)', () => {
    const ADMIN = { ...ME, teams: [{ slug: 'admin', name: 'Admin' }] };
    const STEPS = [
      { type: 'agent_input', at: '2026-10-21T10:05:10.000Z', text: 'A message posted by Cy…' },
      {
        type: 'agent_step',
        at: '2026-10-21T10:05:11.000Z',
        thinking: 'Check the site.',
        calls: [{ id: 'c1', tool: 'codemode', arguments: { code: 'await tools.mcp__browser__get_url_markdown({})' } }],
        usage: { tokens: 120, cost: 0.01 },
      },
      {
        type: 'tool_result',
        at: '2026-10-21T10:05:20.000Z',
        call: 'c1',
        tool: 'codemode',
        error: false,
        text: '503',
        nested_calls: [{ tool: 'mcp__browser__get_url_markdown', status: 'ok' }],
      },
      { type: 'agent_step', at: '2026-10-21T10:00:30.000Z', text: 'Earlier note.' },
    ];
    const withAgent = () => {
      const e = env();
      const asked = [];
      e.AGENT_CHANNELS = 'C1';
      e.AGENTS = {
        idFromName: (n) => n,
        get: (name) => ({
          // eslint-disable-next-line no-underscore-dangle
          __unsafe_ensureInitialized: async () => {},
          trace: async (options) => {
            asked.push({ name, options });
            return {
              status: {
                model: 'm', problem: null, pending: [], turn: { state: 'done', text: 'Earlier note.' }, tools: [], mcp: [],
              },
              steps: STEPS,
              earlier: 0,
              usage: { tokens: 120, cost: 0.01 },
            };
          },
        }),
      };
      e.asked = asked;
      return e;
    };

    it('is listed and callable for the admin team only', async () => {
      const mine = await send(env(), req('tools/list'));
      assert.ok(!mine.body.result.tools.some((t) => t.name === 'get_thread_trace'));
      const denied = await callTool(withAgent(), 'get_thread_trace', { thread: SLACK });
      assert.equal(denied.body.error.code, -32602);
      const admins = await send(env(), req('tools/list'), ADMIN);
      const tool = admins.body.result.tools.find((t) => t.name === 'get_thread_trace');
      assert.ok(tool && !('admin' in tool));
      assert.equal(admins.body.result.cacheScope, 'private');
    });

    it('lays the agent\'s steps out between the thread\'s messages, for any thread', async () => {
      const e = withAgent();
      const r = await send(e, req('tools/call', { name: 'get_thread_trace', arguments: { thread: SLACK } }), ADMIN);
      const t = structured(r);
      assert.equal(t.customer, 'acme');
      assert.deepEqual(t.timeline.map((x) => x.type), ['message', 'agent_step', 'message', 'agent_input', 'agent_step', 'tool_result']);
      assert.equal(t.timeline[1].text, 'Earlier note.');
      assert.equal(t.timeline[4].calls[0].tool, 'codemode');
      assert.equal(t.timeline[5].nested_calls[0].tool, 'mcp__browser__get_url_markdown');
      assert.deepEqual([t.agent.enabled, t.agent.model, t.agent.usage.tokens], [true, 'm', 120]);
      assert.equal(e.asked[0].name, SLACK);
      assert.equal(e.asked[0].options.chars, 1500);
    });

    it('still shows the thread when the agent does not answer', async () => {
      const e = withAgent();
      e.AGENTS.get = () => ({
        // eslint-disable-next-line no-underscore-dangle
        __unsafe_ensureInitialized: async () => {},
        trace: async () => { throw new Error('Durable Object reset'); },
      });
      const realError = console.error;
      console.error = () => {};
      try {
        const t = structured(await send(e, req('tools/call', { name: 'get_thread_trace', arguments: { thread: SLACK } }), ADMIN));
        assert.match(t.agent.error, /did not answer \(Durable Object reset\)/);
        assert.deepEqual(t.timeline.map((x) => x.type), ['message', 'message']);
      } finally {
        console.error = realError;
      }
    });

    it('pages back with `before`, and says when the channel has no agent', async () => {
      const e = withAgent();
      const page = structured(await send(e, req('tools/call', { name: 'get_thread_trace', arguments: { thread: SLACK, limit: 2 } }), ADMIN));
      assert.deepEqual(page.timeline.map((x) => x.type), ['agent_step', 'tool_result']);
      assert.equal(page.earlier, 4);
      const back = structured(await send(e, req('tools/call', {
        name: 'get_thread_trace', arguments: { thread: SLACK, limit: 2, before: page.next_before },
      }, { id: 2 }), ADMIN));
      assert.deepEqual(back.timeline.map((x) => x.type), ['message', 'agent_input']);
      const none = structured(await send(env(), req('tools/call', { name: 'get_thread_trace', arguments: { thread: SLACK } }), ADMIN));
      assert.equal(none.agent.enabled, false);
      assert.deepEqual(none.timeline.map((x) => x.type), ['message', 'message']);
    });
  });

  it('answers an unknown tool with -32602', async () => {
    const r = await callTool(env(), 'nope', {});
    assert.equal(r.body.error.code, -32602);
  });
});
