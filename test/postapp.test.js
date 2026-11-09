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
import { api } from '../src/api.js';
import { render } from '../src/channels.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, ids and tokens only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'helix' }],
};
const SLACK = 'slack:E1:C1:1.1';
const TEAMS = 'teams:T:G1:19:c:5';
const G = '100000000000000001';
const DISCORD = `discord:${G}:200000000000000002:300000000000000003`;
const AT = '2026-10-21T10:00:00Z';

function env() {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }],
    people: [{
      id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
    }],
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
  const account = (source, tenant, id, name, kind = 'person') => DB.sqlite.prepare(`INSERT INTO
    identities (source, tenant, user_id, kind, name, fetched_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(source, tenant, id, kind, name, AT);
  account('slack', 'E1', 'U3', 'Cy Customer');
  account('slack', 'E1', 'U4', 'Cy');
  account('teams', 'T', 'u-bob', 'Bob Builder');
  account('teams', 'T', 'b-helper', 'Helper', 'bot');
  DB.sqlite.prepare(`INSERT INTO bot_teams (source, tenant, bot_id, group_id, at)
    VALUES ('teams', 'T', 'b-helper', 'G1', ?)`).run(AT);
  account('discord', G, '400000000000000005', 'Dana');
  // The app may post in the team's channels ("Post messages").
  DB.sqlite.prepare(`INSERT INTO agent_tool_switches (tool, scope, target, enabled, changed_by,
    changed_at) VALUES ('post_message', 'team', 'helix', 1, 'Ada', ?)`).run(AT);
  return {
    DB,
    CHANNELS: fakeBucket(),
    STAFF_DOMAINS: 'staff.example',
    SLACK_BOT_TOKEN: 'xoxb-made-up',
    TEAMS_APP_ID: 'app-1',
    MS_TENANT_ID: 'T',
    MS_CLIENT_ID: 'mcid',
    MS_CLIENT_SECRET: 'msecret',
    DISCORD_BOT_TOKEN: 'made-up',
    DISCORD_GUILDS: G,
  };
}

const call = (e, method, path, body) => quiet(() => api(
  new Request(`https://opspile.test${path}`, { method, body: JSON.stringify(body) }),
  e,
  new URL(`https://opspile.test${path}`),
  { viewer: ADA },
));

describe('posting as the opspile app, with mentions', () => {
  const real = globalThis.fetch;
  let calls;
  beforeEach(() => {
    calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const json = init.body && !(init.body instanceof URLSearchParams);
      calls.push({ u, init, body: json ? JSON.parse(init.body) : null });
      if (u.endsWith('/chat.postMessage') || u.endsWith('/chat.update')) {
        return Response.json({ ok: true, ts: '1.9' });
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
  const sent = (pred) => calls.filter(pred).pop();

  it('posts a reply once, however often it is retried under its key', async () => {
    const e = env();
    const body = { thread: SLACK, text: 'Hello', key: 'k1' };
    const first = await call(e, 'POST', '/api/post/app', body);
    const again = await call(e, 'POST', '/api/post/app', body);
    const posts = calls.filter((c) => c.u.endsWith('/chat.postMessage'));
    assert.equal(posts.length, 1);
    assert.equal((await first.json()).id, '1.9');
    assert.deepEqual(await again.json(), {
      ok: true, platform: 'slack', id: '1.9', again: true,
    });
  });

  it('says so when a first try never finished', async () => {
    const e = env();
    globalThis.fetch = async () => {
      throw new Error('the connection dropped');
    };
    const body = { thread: SLACK, text: 'Hello', key: 'k2' };
    await assert.rejects(call(e, 'POST', '/api/post/app', body));
    const again = await call(e, 'POST', '/api/post/app', body);
    assert.equal(again.status, 409);
    assert.equal((await again.json()).unknown, true);
  });

  it('keeps the key when the connection to the platform dropped, on Discord and Teams', async () => {
    for (const [thread, key] of [[DISCORD, 'k3'], [TEAMS, 'k4']]) {
      const e = env();
      const { fetch } = globalThis;
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.startsWith('https://discord.com/api/') || u.includes('/v3/conversations/')) {
          throw new Error('the connection dropped');
        }
        return fetch(url, init);
      };
      const body = { thread, text: 'Hello', key };
      // eslint-disable-next-line no-await-in-loop
      const first = await call(e, 'POST', '/api/post/app', body);
      assert.equal(first.status, 502);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await first.json()).unknown, true);
      globalThis.fetch = fetch;
      // eslint-disable-next-line no-await-in-loop
      const again = await call(e, 'POST', '/api/post/app', body);
      assert.equal(again.status, 409, 'the retry does not post');
    }
  });

  it('lets a retry post after Discord refused', async () => {
    const e = env();
    const { fetch } = globalThis;
    globalThis.fetch = async (url, init) => (String(url).startsWith('https://discord.com/api/')
      ? Response.json({ code: 50013 }, { status: 403 }) : fetch(url, init));
    const body = { thread: DISCORD, text: 'Hello', key: 'k5' };
    const first = await call(e, 'POST', '/api/post/app', body);
    assert.equal(first.status, 502);
    assert.equal((await first.json()).unknown, undefined);
    globalThis.fetch = fetch;
    assert.equal((await call(e, 'POST', '/api/post/app', body)).status, 200);
  });

  it('keeps a post that went out when the draft it used up cannot be discarded', async () => {
    const e = env();
    const { prepare } = e.DB;
    e.DB.prepare = function broken(sql) {
      if (/SELECT d\.\*/.test(sql)) {
        throw new Error('D1 is down');
      }
      return prepare.call(this, sql);
    };
    const res = await call(e, 'POST', '/api/post/app', { thread: SLACK, text: 'Hello', draft: 'v1' });
    assert.equal(res.status, 200);
  });

  it('mentions the picked people on Slack, in the text and in the markdown block', async () => {
    const res = await call(env(), 'POST', '/api/post/app', {
      thread: SLACK,
      text: '@Cy Customer, see **this**; @Cy and @Nobody are not picked',
      mentions: [{ id: 'U3', name: 'Cy Customer' }, { id: 'U9', name: 'Unknown' }],
    });
    assert.equal(res.status, 200);
    const { body } = sent((c) => c.u.endsWith('/chat.postMessage'));
    assert.equal(body.text, '<@U3>, see *this*; @Cy and @Nobody are not picked');
    assert.deepEqual(body.blocks, [{
      type: 'markdown', text: '<@U3>, see **this**; @Cy and @Nobody are not picked',
    }]);
  });

  it('mentions the picked people on Teams, with the Bot Framework\'s mention entities', async () => {
    const res = await call(env(), 'POST', '/api/post/app', {
      thread: TEAMS,
      text: 'Thanks @Bob Builder, and @Helper',
      mentions: [{ id: 'u-bob' }, { id: 'b-helper' }],
    });
    assert.equal(res.status, 200);
    const { body } = sent((c) => c.u.includes('/v3/conversations/'));
    // Teams does not give bots what a bot writes: a picked bot stays its name.
    assert.deepEqual(body, {
      type: 'message',
      text: 'Thanks <at>Bob Builder</at>, and @Helper',
      textFormat: 'markdown',
      entities: [{
        type: 'mention', text: '<at>Bob Builder</at>', mentioned: { id: 'u-bob', name: 'Bob Builder' },
      }],
    });
  });

  it('mentions the picked people on Discord, and pings them only', async () => {
    const res = await call(env(), 'POST', '/api/post/app', {
      thread: DISCORD,
      text: '@Dana have a look, @everyone',
      mentions: [{ id: '400000000000000005' }],
    });
    assert.equal(res.status, 200);
    const { body } = sent((c) => c.u.startsWith('https://discord.com/api/'));
    assert.equal(body.content, '<@400000000000000005> have a look, @everyone');
    assert.deepEqual(body.allowed_mentions, { parse: [], users: ['400000000000000005'] });
  });

  it('posts without mentions as before', async () => {
    const res = await call(env(), 'POST', '/api/post/app', { thread: DISCORD, text: 'Hi @Dana' });
    assert.equal(res.status, 200);
    const { body } = sent((c) => c.u.startsWith('https://discord.com/api/'));
    assert.deepEqual(body, { content: 'Hi @Dana', allowed_mentions: { parse: [] } });
  });

  it('keeps the mentions of a message the app posted when it is edited', async () => {
    const e = env();
    const app = (source, tenant, channel, id, key, path, md) => {
      e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(source, tenant, channel, id, key, AT);
      e.DB.sqlite.prepare(`INSERT INTO app_posts (source, tenant, channel_id, id, thread, person, at)
        VALUES (?, ?, ?, ?, ?, 1, ?)`).run(source, tenant, channel, id, key, AT);
      return e.CHANNELS.put(`${path}${id}.md`, render({
        source, thread: key, id, at: AT,
      }, md));
    };
    await app('slack', 'E1', 'C1', '1.9', SLACK, 'p/1.1/', 'see @Cy Customer');
    let res = await call(e, 'POST', '/api/edit', {
      thread: SLACK, id: '1.9', text: 'see @Cy Customer again',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(sent((c) => c.u.endsWith('/chat.update')).body, {
      channel: 'C1',
      ts: '1.9',
      text: 'see <@U3> again',
      blocks: [{ type: 'markdown', text: 'see <@U3> again' }],
    });

    await app('teams', 'T', '19:c', '7', TEAMS, 'q/5/', 'hi');
    res = await call(e, 'POST', '/api/edit', {
      thread: TEAMS, id: '7', text: 'hi @Bob Builder', mentions: [{ id: 'u-bob' }],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(sent((c) => c.init.method === 'PUT').body, {
      type: 'message',
      id: '7',
      text: 'hi <at>Bob Builder</at>',
      textFormat: 'markdown',
      entities: [{
        type: 'mention', text: '<at>Bob Builder</at>', mentioned: { id: 'u-bob', name: 'Bob Builder' },
      }],
    });

    await app('discord', G, '200000000000000002', '300000000000000009', DISCORD, 'd/3/', 'x');
    res = await call(e, 'POST', '/api/edit', {
      thread: DISCORD, id: '300000000000000009', text: 'ok @Dana', mentions: [{ id: '400000000000000005' }],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(sent((c) => c.init.method === 'PATCH').body, {
      content: 'ok <@400000000000000005>',
      allowed_mentions: { parse: [], users: ['400000000000000005'] },
    });
  });
});
