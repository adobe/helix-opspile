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
import { api, editableAs } from '../src/api.js';
import { render } from '../src/channels.js';
import { editable, seal } from '../src/post.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up keys, ids, people and messages only.
const KEY = Buffer.alloc(32, 7).toString('base64url');
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'helix' }],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', teams: [{ slug: 'helix' }],
};
const EVE = {
  id: 3, email: 'eve@staff.example', name: 'Eve', teams: [{ slug: 'other' }],
};
const SLACK = 'slack:E1:C1:1.1';
const TEAMS = 'teams:T:G1:19:c:5';
const G = '100000000000000001';
const DISCORD = `discord:${G}:200000000000000002:300000000000000003`;
const AT = '2026-10-21T10:00:00Z';

function env(extra = {}) {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'other', name: 'Other' }],
    people: [
      {
        id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
      },
      {
        id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
      },
      {
        id: 3, email: 'eve@staff.example', name: 'Eve', staff: 1, teams: ['other'],
      },
    ],
  });
  const thread = (key, source, tenant, channel, root, path) => DB.sqlite.prepare(`INSERT INTO
    threads (thread, source, tenant, channel_id, root_id, org, team, path, root_at, last_at, any_at,
    messages, updated_at) VALUES (?, ?, ?, ?, ?, 'acme', 'helix', ?, ?, ?, ?, 1, ?)`)
    .run(key, source, tenant, channel, root, path, AT, AT, AT, AT);
  thread(SLACK, 'slack', 'E1', 'C1', '1.1', 'p/1.1/');
  thread(TEAMS, 'teams', 'T', '19:c', '5', 'q/5/');
  thread(DISCORD, 'discord', G, '200000000000000002', '300000000000000003', 'd/3/');
  DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, group_id, fetched_at)
    VALUES ('teams', 'T', '19:c', 'G1', ?)`).run(AT);
  const message = (source, tenant, channel, id, key, person, authorKey, permalink = null) => DB
    .sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff,
      counted, person, author_key, permalink) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`)
    .run(source, tenant, channel, id, key, AT, person, authorKey, permalink);
  message('slack', 'E1', 'C1', '1.1', SLACK, null, 'slack:E1:U9');
  message('slack', 'E1', 'C1', '1.2', SLACK, 1, 'slack:E1:U1');
  message('slack', 'E1', 'C1', '1.3', SLACK, 2, 'slack:E1:U2');
  message('teams', 'T', '19:c', '5', TEAMS, 1, 'teams:T:u-ada');
  message('teams', 'T', '19:c', '6', TEAMS, 1, 'teams:T:u-ada');
  message('discord', G, '200000000000000002', '300000000000000004', DISCORD, 1, `discord:${G}:400000000000000001`);
  const account = (source, tenant, id, name, person = null) => DB.sqlite.prepare(`INSERT INTO
    identities (source, tenant, user_id, kind, name, person, fetched_at)
    VALUES (?, ?, ?, 'person', ?, ?, ?)`).run(source, tenant, id, name, person, AT);
  account('slack', 'E1', 'U1', 'Ada', 1);
  account('slack', 'E1', 'U2', 'Bo', 2);
  account('slack', 'E1', 'U3', 'Cy Customer');
  account('slack', 'E1', 'U4', 'Dee Dupe');
  account('slack', 'E1', 'U5', 'Dee Dupe');
  account('teams', 'T', 'u-bob', 'Bob Builder');
  const CHANNELS = fakeBucket();
  return {
    DB,
    CHANNELS,
    TOKEN_KEY: KEY,
    STAFF_DOMAINS: 'staff.example',
    MS_TENANT_ID: 'T',
    MS_CLIENT_ID: 'mcid',
    MS_CLIENT_SECRET: 'msecret',
    ...extra,
  };
}

const call = (e, who, method, path, body) => api(
  new Request(`https://opspile.test${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
  e,
  new URL(`https://opspile.test${path}`),
  { viewer: who },
);
const editing = (e, who, body) => quiet(() => call(e, who, 'POST', '/api/edit', body));

async function connect(e, person, platform, userId, token, scope) {
  e.DB.sqlite.prepare(`INSERT INTO user_tokens (person, platform, user_id, access_token, scope,
    updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(person, platform, userId, await seal(e, token), scope, AT);
}

const switchOn = (e) => e.DB.sqlite.prepare(`INSERT INTO agent_tool_switches (tool, scope, target,
  enabled, changed_by, changed_at) VALUES ('post_message', 'team', 'helix', 1, 'Ada', ?)`).run(AT);

describe('editing sent messages', () => {
  const real = globalThis.fetch;
  let calls;
  let answer;
  beforeEach(() => {
    calls = [];
    answer = null;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const json = init.body && !(init.body instanceof URLSearchParams);
      calls.push({ u, init, body: json ? JSON.parse(init.body) : null });
      if (answer) {
        const a = answer(u, init);
        if (a) {
          return a;
        }
      }
      if (u.endsWith('/chat.update') || u.endsWith('/chat.postMessage')) {
        return Response.json({ ok: true, ts: '1.9' });
      }
      if (u.startsWith('https://graph.microsoft.com/') && init.method === 'PATCH') {
        return new Response(null, { status: 204 });
      }
      if (u.endsWith('/oauth2/v2.0/token')) {
        return Response.json({ access_token: 'bf-token', expires_in: 3600 });
      }
      if (u.includes('/v3/conversations/')) {
        return Response.json({ id: '7' });
      }
      if (u.startsWith('https://discord.com/api/')) {
        return Response.json({ id: '300000000000000009' });
      }
      throw new Error(`unexpected ${u}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('edits your own Slack message with your token, keeping its mentions', async () => {
    const e = env();
    await connect(e, 1, 'slack', 'U1', 'xoxp-ada', 'chat:write');
    // The message as pile 2 has it: it mentioned Cy, and someone with an ambiguous name.
    await e.CHANNELS.put('p/1.1/1.2.md', render({
      source: 'slack', thread: SLACK, id: '1.2', at: AT,
    }, 'see @Cy Customer and @Dee Dupe'));
    const res = await editing(e, ADA, {
      thread: SLACK, id: '1.2', text: 'see @Cy Customer, @Dee Dupe and **@Bo**', mentions: [{ id: 'U2' }],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true, platform: 'slack', id: '1.2', as: 'user',
    });
    const sent = calls.find((c) => c.u.endsWith('/chat.update'));
    assert.equal(sent.init.headers.authorization, 'Bearer xoxp-ada');
    assert.deepEqual(sent.body, {
      channel: 'C1', ts: '1.2', text: 'see <@U3>, @Dee Dupe and *<@U2>*',
    });
  });

  it('only edits your own messages, from the account that posted them', async () => {
    const e = env();
    await connect(e, 1, 'slack', 'U1', 'xoxp-ada', 'chat:write');
    assert.equal((await editing(e, ADA, { thread: SLACK, id: '1.3', text: 'x' })).status, 403);
    assert.equal((await editing(e, ADA, { thread: SLACK, id: '1.1', text: 'x' })).status, 403);
    assert.equal((await editing(e, ADA, { thread: SLACK, id: '9.9', text: 'x' })).status, 404);
    assert.equal((await editing(e, EVE, { thread: SLACK, id: '1.2', text: 'x' })).status, 404);
    assert.equal((await editing(e, { ...ADA, email: 'ada@else.example' }, { thread: SLACK, id: '1.2', text: 'x' })).status, 403);
    assert.equal((await editing(e, ADA, { thread: SLACK, id: '1.2', text: '  ' })).status, 400);
    e.DB.sqlite.prepare("UPDATE messages SET author_key = 'slack:E1:U7' WHERE id = '1.2'").run();
    const other = await editing(e, ADA, { thread: SLACK, id: '1.2', text: 'x' });
    assert.equal(other.status, 403);
    assert.match((await other.json()).error, /another Slack account/);
    e.DB.sqlite.prepare("UPDATE messages SET deleted = 1 WHERE id = '1.3'").run();
    assert.equal((await editing(e, BO, { thread: SLACK, id: '1.3', text: 'x' })).status, 404);
    assert.equal(calls.length, 0);
  });

  it('asks to connect first, and says what Slack refused', async () => {
    const e = env();
    const res = await editing(e, ADA, { thread: SLACK, id: '1.2', text: 'x' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).connect, 'slack');
    await connect(e, 1, 'slack', 'U1', 'xoxp-ada', 'chat:write');
    answer = (u) => (u.endsWith('/chat.update') ? Response.json({ ok: false, error: 'edit_window_closed' }) : null);
    const closed = await editing(e, ADA, { thread: SLACK, id: '1.2', text: 'x' });
    assert.equal(closed.status, 409);
    assert.match((await closed.json()).error, /no longer lets you edit/);
    answer = (u) => (u.endsWith('/chat.update') ? Response.json({ ok: false, error: 'token_revoked' }) : null);
    assert.equal((await (await editing(e, ADA, { thread: SLACK, id: '1.2', text: 'x' })).json()).connect, 'slack');
  });

  it('edits a Teams message once the token may (ChannelMessage.ReadWrite)', async () => {
    const send = 'https://graph.microsoft.com/ChannelMessage.Send';
    const e = env();
    await connect(e, 1, 'teams', 'u-ada', 'ms-ada', send);
    let res = await editing(e, ADA, { thread: TEAMS, id: '6', text: 'x' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /not set up here/);
    assert.deepEqual(await editable(e, 1), { slack: false, teams: false, discord: false });

    // The deployment asks for the scope now: this older token has to connect again.
    e.TEAMS_EDITS = '1';
    res = await editing(e, ADA, { thread: TEAMS, id: '6', text: 'x' });
    assert.equal((await res.json()).reconnect, 'teams');
    assert.deepEqual(await editable(e, 1), { slack: false, teams: 'reconnect', discord: false });

    e.DB.sqlite.prepare("UPDATE user_tokens SET scope = ? WHERE platform = 'teams'")
      .run(`${send} https://graph.microsoft.com/ChannelMessage.ReadWrite`);
    assert.deepEqual(await editable(e, 1), { slack: false, teams: true, discord: false });
    res = await editing(e, ADA, {
      thread: TEAMS, id: '6', text: 'a < b, @Bob Builder', mentions: ['u-bob'],
    });
    assert.equal(res.status, 200);
    const reply = calls.find((c) => c.init.method === 'PATCH');
    assert.match(reply.u, /\/teams\/G1\/channels\/19%3Ac\/messages\/5\/replies\/6$/);
    assert.equal(reply.init.headers.authorization, 'Bearer ms-ada');
    assert.equal(reply.body.body.content, 'a &lt; b, <at id="0">Bob Builder</at>');
    assert.equal(reply.body.mentions[0].mentioned.user.id, 'u-bob');
    // The thread's first message is the channel message itself.
    await editing(e, ADA, { thread: TEAMS, id: '5', text: 'root' });
    assert.match(calls.filter((c) => c.init.method === 'PATCH').pop().u, /\/messages\/5$/);
  });

  it('asks for the edit scope when connecting Microsoft, where the tenant consented', async () => {
    const start = async (e) => new URL((await call(e, ADA, 'GET', '/api/auth/teams/start'))
      .headers.get('location')).searchParams.get('scope');
    assert.doesNotMatch(await start(env({ PUBLIC_ORIGIN: 'https://opspile.test' })), /ReadWrite/);
    assert.match(await start(env({ PUBLIC_ORIGIN: 'https://opspile.test', TEAMS_EDITS: '1' })), /ChannelMessage\.ReadWrite/);
  });

  it('does not edit as the person on Discord', async () => {
    const res = await editing(env(), ADA, { thread: DISCORD, id: '300000000000000004', text: 'x' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /edit it in Discord/);
  });

  it('lets whoever posted as the opspile app edit that message, as the app', async () => {
    const e = env({ SLACK_BOT_TOKEN: 'xoxb-made-up' });
    switchOn(e);
    const posted = await quiet(() => call(e, ADA, 'POST', '/api/post/app', { thread: SLACK, text: 'one' }));
    assert.equal(posted.status, 200);
    assert.deepEqual(e.DB.rows('SELECT source, channel_id, id, thread, person FROM app_posts'), [{
      source: 'slack', channel_id: 'C1', id: '1.9', thread: SLACK, person: 1,
    }]);
    // The app's message, as ingestion files it: a bot, nobody's person.
    e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at,
      author_key) VALUES ('slack', 'E1', 'C1', '1.9', ?, ?, 'slack:E1:B1')`).run(SLACK, AT);

    // Only Ada, who posted it; Bo did not.
    assert.equal((await editing(e, BO, { thread: SLACK, id: '1.9', text: 'two' })).status, 403);
    const res = await editing(e, ADA, { thread: SLACK, id: '1.9', text: '**two**' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).as, 'app');
    const sent = calls.find((c) => c.u.endsWith('/chat.update'));
    assert.equal(sent.init.headers.authorization, 'Bearer xoxb-made-up');
    assert.deepEqual(sent.body, {
      channel: 'C1', ts: '1.9', text: '*two*', blocks: [{ type: 'markdown', text: '**two**' }],
    });

    // Where the app no longer posts, it does not edit either.
    e.DB.sqlite.prepare('DELETE FROM agent_tool_switches').run();
    assert.equal((await editing(e, ADA, { thread: SLACK, id: '1.9', text: 'three' })).status, 409);
  });

  it('edits the app\'s Teams and Discord messages with their bots', async () => {
    const e = env({
      TEAMS_APP_ID: 'app-1', DISCORD_BOT_TOKEN: 'made-up', DISCORD_GUILDS: G,
    });
    switchOn(e);
    const app = (source, tenant, channel, id, key, permalink = null) => {
      e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at,
        permalink) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(source, tenant, channel, id, key, AT, permalink);
      e.DB.sqlite.prepare(`INSERT INTO app_posts (source, tenant, channel_id, id, thread, person, at)
        VALUES (?, ?, ?, ?, ?, 1, ?)`).run(source, tenant, channel, id, key, AT);
    };
    app('teams', 'T', '19:c', '7', TEAMS);
    let res = await editing(e, ADA, { thread: TEAMS, id: '7', text: 'fixed' });
    assert.equal(res.status, 200);
    const put = calls.find((c) => c.init.method === 'PUT');
    assert.match(put.u, /\/v3\/conversations\/19%3Ac%3Bmessageid%3D5\/activities\/7$/);
    assert.deepEqual(put.body, {
      type: 'message', id: '7', text: 'fixed', textFormat: 'markdown',
    });

    // Discord: in the channel the message's link names (here the conversation's thread).
    const link = `https://discord.com/channels/${G}/300000000000000003/300000000000000009`;
    app('discord', G, '200000000000000002', '300000000000000009', DISCORD, link);
    res = await editing(e, ADA, { thread: DISCORD, id: '300000000000000009', text: '@everyone fixed' });
    assert.equal(res.status, 200);
    const patch = calls.find((c) => c.init.method === 'PATCH');
    assert.equal(patch.u, 'https://discord.com/api/v10/channels/300000000000000003/messages/300000000000000009');
    assert.deepEqual(patch.body, { content: '@everyone fixed', allowed_mentions: { parse: [] } });
  });

  it('tells the inbox which messages you may edit, and as whom', async () => {
    const e = env();
    await connect(e, 1, 'slack', 'U1', 'xoxp-ada', 'chat:write');
    for (const id of ['1.1', '1.2', '1.3', '1.9']) {
      // eslint-disable-next-line no-await-in-loop
      await e.CHANNELS.put(`p/1.1/${id}.md`, render({
        source: 'slack',
        thread: SLACK,
        id,
        at: AT,
        author: id === '1.9' ? { kind: 'bot', name: 'opspile' } : { kind: 'person', name: 'X' },
      }, `message ${id}`));
    }
    e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at)
      VALUES ('slack', 'E1', 'C1', '1.9', ?, ?)`).run(SLACK, AT);
    e.DB.sqlite.prepare(`INSERT INTO app_posts (source, tenant, channel_id, id, thread, person, at)
      VALUES ('slack', 'E1', 'C1', '1.9', ?, 1, ?)`).run(SLACK, AT);
    const of = async (who) => Object.fromEntries((await (await call(e, who, 'GET', `/api/thread?thread=${SLACK}`))
      .json()).messages.map((m) => [m.id, m.editable]));
    assert.deepEqual(await of(ADA), {
      1.1: null, 1.2: 'user', 1.3: null, 1.9: 'app',
    });
    assert.deepEqual(await of(BO), {
      1.1: null, 1.2: null, 1.3: 'user', 1.9: null,
    });
    const me = await (await call(e, ADA, 'GET', '/api/me')).json();
    assert.deepEqual(me.edit, { slack: true, teams: false, discord: false });
  });

  it('never offers to edit deleted, system or Discord messages as the person', () => {
    const none = new Set();
    const person = { kind: 'person', name: 'Ada' };
    assert.equal(editableAs({ source: 'slack', author: person }, true, none), 'user');
    assert.equal(editableAs({ source: 'slack', author: person, deletedAt: AT }, true, none), null);
    assert.equal(editableAs({ source: 'slack', author: { kind: 'system' } }, true, none), null);
    assert.equal(editableAs({ source: 'discord', author: person }, true, none), null);
    assert.equal(editableAs({
      source: 'discord', thread: 'd', id: '1', author: { kind: 'bot' },
    }, false, new Set(['d|1'])), 'app');
  });
});
