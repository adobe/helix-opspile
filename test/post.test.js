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
import {
  checkState, connections, finishAuth, makeState, mentionable, post, seal, slackText, splitMentions,
  teamsMessage, unseal,
} from '../src/post.js';
import { d1 } from './d1.js';

// Made-up keys, ids and people only.
const KEY = Buffer.alloc(32, 7).toString('base64url');
const ME = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'helix' }],
};

function env() {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }],
    people: [{
      id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
    }],
  });
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
    path, any_at, updated_at) VALUES ('slack:E1:C1:1.1', 'slack', 'E1', 'C1', '1.1', 'acme', 'helix',
    'p/', '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z')`).run();
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
    path, any_at, updated_at) VALUES ('teams:T:G:19:c:5', 'teams', 'T', '19:c', '5', 'acme', 'helix',
    'q/', '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z')`).run();
  DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, group_id, fetched_at)
    VALUES ('teams', 'T', '19:c', 'G1', '2026-10-21T10:00:00Z')`).run();
  return {
    DB,
    TOKEN_KEY: KEY,
    STAFF_DOMAINS: 'staff.example',
    PUBLIC_ORIGIN: 'https://opspile.test',
    SLACK_CLIENT_ID: 'cid',
    SLACK_CLIENT_SECRET: 'csecret',
    SLACK_BOT_TOKEN: 'xoxb-made-up',
    MS_TENANT_ID: 'T',
    MS_CLIENT_ID: 'mcid',
    MS_CLIENT_SECRET: 'msecret',
  };
}
const inTeam = (t) => t === 'helix';

// Made-up accounts: two Slack people (one a bot) and one Teams person, all in D1 already.
function withAccounts(e) {
  const add = (source, tenant, id, kind, name, person = null) => e.DB.sqlite.prepare(`INSERT INTO
    identities (source, tenant, user_id, kind, name, person, fetched_at) VALUES (?, ?, ?, ?, ?, ?,
    '2026-10-21T10:00:00Z')`).run(source, tenant, id, kind, name, person);
  add('slack', 'E1', 'U1', 'person', 'ada.l', 1);
  add('slack', 'E1', 'U2', 'person', 'Bob Builder');
  add('slack', 'E1', 'U3', 'person', 'Bea Bunny');
  add('slack', 'E1', 'B1', 'bot', 'Bobbot');
  add('slack', 'E9', 'U4', 'person', 'Bob Elsewhere');
  add('teams', 'T', 'u-bob', 'person', 'Bob Builder');
  e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author_key)
    VALUES ('slack', 'E1', 'C1', '1.2', 'slack:E1:C1:1.1', '2026-10-21T10:00:00Z', 'slack:E1:U3')`).run();
  return e;
}

describe('mentions', () => {
  const ada = { id: 'U1', name: 'Ada' };
  const lovelace = { id: 'U5', name: 'Ada Lovelace' };

  it('splits @Name into mentions, longest name first, at word ends only', () => {
    assert.deepEqual(splitMentions('hi @Ada Lovelace and @Ada, not @Adam', [ada, lovelace]), [
      'hi ', lovelace, ' and ', ada, ', not @Adam',
    ]);
    assert.deepEqual(splitMentions('plain @Ada', []), ['plain @Ada']);
  });

  it('writes Slack mentions as <@id> and escapes the rest', () => {
    assert.equal(slackText('@Ada see a<b & c>d', [ada]), '<@U1> see a&lt;b &amp; c&gt;d');
    assert.equal(slackText('<@U9> by hand', []), '&lt;@U9&gt; by hand');
  });

  it('writes Teams mentions as <at> with a mention entry each', () => {
    assert.deepEqual(teamsMessage('@Ada &\n@Ada', [ada]), {
      body: { contentType: 'html', content: '<at id="0">Ada</at> &amp;<br><at id="1">Ada</at>' },
      mentions: [0, 1].map((id) => ({
        id,
        mentionText: 'Ada',
        mentioned: { user: { id: 'U1', displayName: 'Ada', userIdentityType: 'aadUser' } },
      })),
    });
    assert.deepEqual(teamsMessage('no one', [ada]), { body: { contentType: 'html', content: 'no one' } });
  });

  it('suggests people in D1 on the thread platform, those in the thread first', async () => {
    const e = withAccounts(env());
    const names = async (thread, q) => (await (await mentionable(e, thread, q, inTeam)).json())
      .people.map((p) => p.name);
    assert.deepEqual(await names('slack:E1:C1:1.1', 'b'), ['Bea Bunny', 'Bob Builder']);
    assert.deepEqual(await names('slack:E1:C1:1.1', 'build'), ['Bob Builder']);
    assert.deepEqual(await names('slack:E1:C1:1.1', 'bob b'), ['Bob Builder']);
    // Staff (a known person) before others, then by name; never bots or other workspaces.
    assert.deepEqual(await names('slack:E1:C1:1.1', ''), ['Bea Bunny', 'Ada', 'Bob Builder']);
    assert.deepEqual(await names('slack:E1:C1:1.1', '%'), []);
    assert.deepEqual(await names('teams:T:G:19:c:5', 'bo'), ['Bob Builder']);
    assert.equal((await mentionable(e, 'slack:E1:C1:1.1', 'b', () => false)).status, 404);
  });
});

describe('token sealing and OAuth state', () => {
  it('round-trips a sealed token and never stores it in the clear', async () => {
    const e = env();
    const sealed = await seal(e, 'xoxp-secret');
    assert.doesNotMatch(sealed, /xoxp/);
    assert.equal(await unseal(e, sealed), 'xoxp-secret');
    assert.notEqual(await seal(e, 'xoxp-secret'), sealed); // fresh IV
  });

  it('accepts only its own, fresh state for the same person and platform', async () => {
    const e = env();
    const s = await makeState(e, 1, 'slack', 1000);
    assert.equal(await checkState(e, s, 1, 'slack', 2000), true);
    assert.equal(await checkState(e, s, 2, 'slack', 2000), false);
    assert.equal(await checkState(e, s, 1, 'teams', 2000), false);
    assert.equal(await checkState(e, s, 1, 'slack', 1000 + 11 * 60 * 1000), false);
    assert.equal(await checkState(e, `${s.split('.')[0]}.forged`, 1, 'slack', 2000), false);
  });
});

describe('connecting and posting', () => {
  const real = globalThis.fetch;
  let calls;
  beforeEach(() => {
    calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push({ u, init });
      if (u.endsWith('/oauth.v2.access')) {
        return Response.json({
          ok: true, enterprise: { id: 'E1' }, authed_user: { id: 'U1', access_token: 'xoxp-ada', scope: 'chat:write' },
        });
      }
      if (u.includes('/users.info')) {
        const user = new URL(u).searchParams.get('user');
        const email = user === 'U1' ? 'ada@staff.example' : 'eve@else.example';
        return Response.json({ ok: true, user: { id: user, real_name: 'X', profile: { email } } });
      }
      if (u.endsWith('/chat.postMessage')) {
        return Response.json({ ok: true, ts: '1.9' });
      }
      if (u.endsWith('/oauth2/v2.0/token')) {
        return Response.json({ access_token: 'ms-ada', refresh_token: 'ms-refresh', expires_in: 3600 });
      }
      if (u.includes('/v1.0/me?')) {
        return Response.json({ id: 'u-ada', mail: 'ada@staff.example' });
      }
      if (u.includes('/v1.0/users/')) {
        return Response.json({ displayName: 'Ada', mail: 'ada@staff.example' });
      }
      if (u.includes('/replies')) {
        return Response.json({ id: '9' }, { status: 201 });
      }
      throw new Error(`unexpected ${u}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('asks the person to connect before the first reply', async () => {
    const res = await post(env(), ME, { thread: 'slack:E1:C1:1.1', text: 'hi' }, inTeam);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).connect, 'slack');
  });

  it('connects Slack, then replies in the thread as the person', async () => {
    const e = env();
    const state = await makeState(e, 1, 'slack');
    const back = await finishAuth(e, ME, 'slack', new URL(`https://opspile.test/api/auth/slack/callback?code=c&state=${state}`));
    assert.equal(back.headers.get('location'), 'https://opspile.test/inbox?connected=slack');
    assert.deepEqual(await connections(e, 1), { slack: true, teams: false });
    assert.doesNotMatch(JSON.stringify(e.DB.rows('SELECT * FROM user_tokens')), /xoxp-ada/);

    const res = await post(e, ME, { thread: 'slack:E1:C1:1.1', text: 'On it.' }, inTeam);
    assert.equal(res.status, 200);
    const sent = calls.find((c) => c.u.endsWith('/chat.postMessage'));
    assert.equal(sent.init.headers.authorization, 'Bearer xoxp-ada');
    assert.deepEqual(JSON.parse(sent.init.body), { channel: 'C1', thread_ts: '1.1', text: 'On it.' });
  });

  it('turns picked @Names into Slack mentions, only for accounts in D1', async () => {
    const e = withAccounts(env());
    await e.DB.sqlite.prepare(`INSERT INTO user_tokens (person, platform, user_id, access_token,
      updated_at) VALUES (1, 'slack', 'U1', ?, '2026-10-21T10:00:00Z')`).run(await seal(e, 'xoxp-ada'));
    const res = await post(e, ME, {
      thread: 'slack:E1:C1:1.1',
      text: '@Bob Builder @Bobbot @Bob Elsewhere see this',
      mentions: [{ id: 'U2' }, { id: 'B1' }, { id: 'U4' }],
    }, inTeam);
    assert.equal(res.status, 200);
    const sent = JSON.parse(calls.find((c) => c.u.endsWith('/chat.postMessage')).init.body);
    assert.equal(sent.text, '<@U2> @Bobbot @Bob Elsewhere see this');
  });

  it('refuses a Slack account that belongs to someone else', async () => {
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url).endsWith('/oauth.v2.access')
      ? Response.json({ ok: true, enterprise: { id: 'E1' }, authed_user: { id: 'U9', access_token: 'xoxp-eve' } })
      : inner(url, init));
    const e = env();
    const state = await makeState(e, 1, 'slack');
    const back = await finishAuth(e, ME, 'slack', new URL(`https://opspile.test/api/auth/slack/callback?code=c&state=${state}`));
    assert.match(back.headers.get('location'), /connect_error=that\+Slack\+account\+belongs\+to\+someone\+else/);
    assert.deepEqual(await connections(e, 1), { slack: false, teams: false });
  });

  it('connects Microsoft and replies in a Teams thread as the person', async () => {
    const e = env();
    const state = await makeState(e, 1, 'teams');
    await finishAuth(e, ME, 'teams', new URL(`https://opspile.test/api/auth/teams/callback?code=c&state=${state}`));
    const res = await post(e, ME, { thread: 'teams:T:G:19:c:5', text: 'a < b\nnext' }, inTeam);
    assert.equal(res.status, 200);
    const sent = calls.find((c) => c.u.includes('/replies'));
    assert.match(sent.u, /\/teams\/G1\/channels\/19%3Ac\/messages\/5\/replies$/);
    assert.equal(sent.init.headers.authorization, 'Bearer ms-ada');
    assert.deepEqual(JSON.parse(sent.init.body).body, { contentType: 'html', content: 'a &lt; b<br>next' });

    withAccounts(e);
    await post(e, ME, { thread: 'teams:T:G:19:c:5', text: 'thanks @Bob Builder', mentions: ['u-bob'] }, inTeam);
    const mentioned = JSON.parse(calls.filter((c) => c.u.includes('/replies')).pop().init.body);
    assert.equal(mentioned.body.content, 'thanks <at id="0">Bob Builder</at>');
    assert.deepEqual(mentioned.mentions[0].mentioned.user, {
      id: 'u-bob', displayName: 'Bob Builder', userIdentityType: 'aadUser',
    });
  });

  it('only lets staff reply, and only in their teams', async () => {
    const e = env();
    const outsider = { ...ME, email: 'ada@else.example' };
    assert.equal((await post(e, outsider, { thread: 'slack:E1:C1:1.1', text: 'x' }, inTeam)).status, 403);
    assert.equal((await post(e, ME, { thread: 'slack:E1:C1:1.1', text: 'x' }, () => false)).status, 404);
    assert.equal((await post(e, ME, { thread: 'slack:E1:C1:1.1', text: '' }, inTeam)).status, 400);
  });
});
