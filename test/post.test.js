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
  checkState, connections, finishAuth, learnMembers, makeState, mentionable, post, seal, slackText,
  splitMentions, teamsMessage, unseal,
} from '../src/post.js';
import { htmlToMarkdown } from '../src/markdown.js';
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
const inTeam = (t) => [].concat(t).includes('helix');

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
  // Teams bots: one seen in the thread's Teams team (G1), one only in another team.
  add('teams', 'T', 'b-help', 'bot', 'helper-agent');
  add('teams', 'T', 'b-else', 'bot', 'bob-bot');
  e.DB.sqlite.prepare("UPDATE identities SET handle = 'helper' WHERE user_id = 'b-help'").run();
  e.DB.sqlite.prepare(`INSERT INTO bot_teams (source, tenant, bot_id, group_id, at) VALUES
    ('teams', 'T', 'b-help', 'G1', '2026-10-21T10:00:00Z'),
    ('teams', 'T', 'b-else', 'G2', '2026-10-21T10:00:00Z')`).run();
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
    assert.equal(slackText('**@Ada**, see `a<b`', [ada]), '*<@U1>*, see `a&lt;b`');
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

  it('writes Teams messages as HTML from their Markdown', () => {
    const html = (md, mentions) => teamsMessage(md, mentions).body.content;
    assert.equal(
      html('**Rename** `a<b`, see the [docs](https://example.com/a?b=1&c=2) ~~now~~'),
      '<strong>Rename</strong> <code>a&lt;b</code>, see the <a href="https://example.com/a?b=1&amp;c=2">docs</a> <s>now</s>',
    );
    assert.equal(html('one\ntwo\n\nthree'), 'one<br>two<br><br>three');
    assert.equal(html('Steps:\n\n- one\n- two\n\nDone'), '<p>Steps:</p><ul><li>one</li><li>two</li></ul><p>Done</p>');
    assert.equal(html('```\na\n  b\n```'), '<pre><code>a\n  b\n</code></pre>');
    assert.equal(html('> quoted\n> twice'), '<blockquote><p>quoted<br>twice</p></blockquote>');
    assert.equal(html('<b>typed</b> &amp;'), '&lt;b&gt;typed&lt;/b&gt; &amp;');
    assert.equal(html('**@Ada** and `x`', [ada]), '<strong><at id="0">Ada</at></strong> and <code>x</code>');
    assert.equal(html(''), '');
  });

  it('reads back what it writes to Teams', () => {
    const md = '**One** and *two*\nline\n\n- a\n- b\n\n> c\n> d\n\n```\ne\n  f\n```\n\n[g](https://example.com/)';
    assert.equal(htmlToMarkdown(teamsMessage(md).body.content), md);
  });

  it('writes a Teams bot mention as an application, so the bot receives it', () => {
    const bot = { id: 'b-help', name: 'helper', kind: 'bot' };
    assert.deepEqual(teamsMessage('@helper add x@example.com', [bot]), {
      body: { contentType: 'html', content: '<at id="0">helper</at> add x@example.com' },
      mentions: [{
        id: 0,
        mentionText: 'helper',
        mentioned: { application: { id: 'b-help', displayName: 'helper', applicationIdentityType: 'bot' } },
      }],
    });
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
    // Teams bots of the thread's Teams team, by handle, after the people.
    assert.deepEqual(await names('teams:T:G:19:c:5', 'help'), ['helper']);
    assert.deepEqual(await names('teams:T:G:19:c:5', ''), ['Bob Builder', 'helper']);
    const helper = (await (await mentionable(e, 'teams:T:G:19:c:5', 'h', inTeam)).json()).people[0];
    assert.deepEqual(helper, {
      id: 'b-help', name: 'helper', avatar: null, here: false, staff: false, kind: 'bot',
    });
    assert.equal((await mentionable(e, 'slack:E1:C1:1.1', 'b', () => false)).status, 404);
  });

  // Made-up: a colleague who never posted in the thread, with a login unlike her name.
  function withColleagues(e) {
    const insert = e.DB.sqlite.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name,
      email, aliases, staff, fetched_at) VALUES ('slack', 'E1', ?, 'person', ?, ?, ?, ?,
      '2026-10-21T10:00:00Z')`);
    const add = (id, name, { email = null, aliases = null, staff = false } = {}) => insert
      .run(id, name, email, aliases && JSON.stringify(aliases), staff ? 1 : null);
    add('U10', 'Kira Selby', { email: 'kira.s@staff.example', aliases: ['kselby', 'Kiki'], staff: true });
    // Staff whose last name starts with K, sorted before her by name.
    ['Ann Kahn', 'Ben Katz', 'Cy Kehl', 'Di Kerr', 'Ed Kidd', 'Flo Kim', 'Gus Klee', 'Hal Knox']
      .forEach((name, i) => add(`U2${i}`, name, { staff: true }));
    return e;
  }

  it('finds a colleague by any case, the start of any name, her login or her mail', async () => {
    const e = withColleagues(withAccounts(env()));
    const names = async (q) => (await (await mentionable(e, 'slack:E1:C1:1.1', q, inTeam)).json())
      .people.map((p) => p.name);
    const typed = ['K', 'k', 'KI', 'kira', 'Kira S', 'sel', 'SELBY', 'kse', 'KSEL', 'kiki', 'kira.s',
      'selby k'];
    const found = await Promise.all(typed.map(names));
    typed.forEach((q, i) => assert.ok(found[i].includes('Kira Selby'), q));
    // Her first name starts with K: she comes before the eight whose last name does.
    assert.equal((await names('K'))[0], 'Kira Selby');
    assert.deepEqual(await names('kse'), ['Kira Selby']);
    // The mail's domain is no name.
    assert.deepEqual(await names('staff'), []);
  });

  it('puts the members of the channel after the thread, before everyone else', async () => {
    const e = withColleagues(withAccounts(env()));
    e.DB.sqlite.prepare(`INSERT INTO channel_members (source, tenant, channel_id, user_id)
      VALUES ('slack', 'E1', 'C1', 'U27')`).run();
    // Posted in another thread of the channel: a member too.
    e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author_key)
      VALUES ('slack', 'E1', 'C1', '2.1', 'slack:E1:C1:2.1', '2026-10-21T10:00:00Z', 'slack:E1:U26')`).run();
    const { people } = await (await mentionable(e, 'slack:E1:C1:1.1', 'k', inTeam)).json();
    assert.deepEqual(people.slice(0, 3).map((p) => [p.name, p.member]), [
      ['Gus Klee', true], ['Hal Knox', true], ['Kira Selby', false],
    ]);
    const { people: blank } = await (await mentionable(e, 'slack:E1:C1:1.1', '', inTeam)).json();
    assert.deepEqual(blank.slice(0, 3).map((p) => [p.name, p.here, p.member]), [
      ['Bea Bunny', true, true], ['Gus Klee', false, true], ['Hal Knox', false, true],
    ]);
  });

  it('counts whoever posted anywhere in the Teams team as a member', async () => {
    const e = withAccounts(env());
    e.DB.sqlite.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, fetched_at)
      VALUES ('teams', 'T', 'u-zed', 'person', 'Bo Zed', '2026-10-21T10:00:00Z')`).run();
    e.DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, group_id, fetched_at)
      VALUES ('teams', 'T', '19:other', 'G1', '2026-10-21T10:00:00Z')`).run();
    e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author_key)
      VALUES ('teams', 'T', '19:other', '9', 'teams:T:G:19:other:9', '2026-10-21T10:00:00Z',
        'teams:T:u-zed')`).run();
    const { people } = await (await mentionable(e, 'teams:T:G:19:c:5', 'B', inTeam)).json();
    assert.deepEqual(people.map((p) => [p.name, p.member]), [['Bo Zed', true], ['Bob Builder', false]]);
  });

  it('lists the channel\'s members once a week, and looks up the ones it never saw', async () => {
    const e = withAccounts(env());
    e.DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, fetched_at)
      VALUES ('slack', 'E1', 'C1', '2026-10-21T10:00:00Z')`).run();
    const listed = [];
    const slack = async (method, params) => {
      listed.push([method, params.channel]);
      return { ok: true, members: ['U2', 'U-NEW'] };
    };
    const looked = [];
    const getIdentity = async (env2, ref) => {
      looked.push(ref.userId);
      env2.DB.sqlite.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, aliases,
        fetched_at) VALUES (?, ?, ?, 'person', 'Nia Quiet', '["nquiet"]', '2026-10-21T10:00:00Z')`)
        .run(ref.source, ref.tenant, ref.userId);
    };
    const t = { source: 'slack', tenant: 'E1', channel_id: 'C1' };
    const now = Date.parse('2026-10-22T10:00:00Z');
    assert.deepEqual(await learnMembers(e, t, { now, slack, getIdentity }), {
      members: 2, looked_up: 1,
    });
    assert.deepEqual(listed, [['conversations.members', 'C1']]);
    assert.deepEqual(looked, ['U-NEW']);
    // Never posted, now found by login, as a member of the channel.
    const { people } = await (await mentionable(e, 'slack:E1:C1:1.1', 'nqu', inTeam)).json();
    assert.deepEqual(people.map((p) => [p.name, p.member]), [['Nia Quiet', true]]);
    // A day later: still fresh. Eight days later: listed again.
    assert.deepEqual(await learnMembers(e, t, { now: now + 86400000, slack, getIdentity }), {
      skipped: 'listed recently',
    });
    await learnMembers(e, t, { now: now + 8 * 86400000, slack, getIdentity });
    assert.equal(listed.length, 2);
    assert.deepEqual(looked, ['U-NEW']);
    assert.deepEqual(await learnMembers(e, { ...t, source: 'discord' }), { skipped: 'members are not listed here' });
  });

  it('lists the members in the background when the suggestions open', async () => {
    const e = withAccounts(env());
    const waited = [];
    await mentionable(e, 'slack:E1:C1:1.1', 'b', inTeam, { waitUntil: (p) => waited.push(p) });
    assert.equal(waited.length, 0);
    await mentionable(e, 'slack:E1:C1:1.1', '', inTeam, { waitUntil: (p) => waited.push(p) });
    assert.equal(waited.length, 1);
    await waited[0];
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
    assert.deepEqual(await connections(e, 1), { slack: true, teams: false, discord: false });
    assert.doesNotMatch(JSON.stringify(e.DB.rows('SELECT * FROM user_tokens')), /xoxp-ada/);

    const res = await post(e, ME, { thread: 'slack:E1:C1:1.1', text: 'On it.' }, inTeam);
    assert.equal(res.status, 200);
    const sent = calls.find((c) => c.u.endsWith('/chat.postMessage'));
    assert.equal(sent.init.headers.authorization, 'Bearer xoxp-ada');
    assert.deepEqual(JSON.parse(sent.init.body), { channel: 'C1', thread_ts: '1.1', text: 'On it.' });
  });

  it('sends emoji names as the platform knows them, and says what it sent', async () => {
    const e = env();
    await e.DB.sqlite.prepare(`INSERT INTO user_tokens (person, platform, user_id, access_token,
      updated_at) VALUES (1, 'slack', 'U1', ?, '2026-10-21T10:00:00Z')`).run(await seal(e, 'xoxp-ada'));
    const res = await post(e, ME, { thread: 'slack:E1:C1:1.1', text: 'never mind :facepalm:' }, inTeam);
    const sent = JSON.parse(calls.find((c) => c.u.endsWith('/chat.postMessage')).init.body);
    assert.equal(sent.text, 'never mind :face_palm:');
    assert.equal((await res.json()).text, 'never mind :face_palm:');

    await e.DB.sqlite.prepare(`INSERT INTO user_tokens (person, platform, user_id, access_token,
      updated_at) VALUES (1, 'teams', 'u-ada', ?, '2026-10-21T10:00:00Z')`).run(await seal(e, 'ms-ada'));
    const teams = await post(e, ME, { thread: 'teams:T:G:19:c:5', text: 'done :white_check_mark:' }, inTeam);
    assert.equal(teams.status, 200);
    const reply = JSON.parse(calls.find((c) => c.u.includes('/replies')).init.body);
    assert.equal(reply.body.content, 'done ✅');
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
    assert.deepEqual(await connections(e, 1), { slack: false, teams: false, discord: false });
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

    // A bot of this Teams team becomes an application mention; one from elsewhere does not.
    await post(e, ME, {
      thread: 'teams:T:G:19:c:5', text: '@helper add x@example.com @bob-bot', mentions: ['b-help', 'b-else'],
    }, inTeam);
    const asked = JSON.parse(calls.filter((c) => c.u.includes('/replies')).pop().init.body);
    assert.equal(asked.body.content, '<at id="0">helper</at> add x@example.com @bob-bot');
    assert.deepEqual(asked.mentions, [{
      id: 0,
      mentionText: 'helper',
      mentioned: { application: { id: 'b-help', displayName: 'helper', applicationIdentityType: 'bot' } },
    }]);
  });

  it('only lets staff reply, and only in their teams', async () => {
    const e = env();
    const outsider = { ...ME, email: 'ada@else.example' };
    assert.equal((await post(e, outsider, { thread: 'slack:E1:C1:1.1', text: 'x' }, inTeam)).status, 403);
    assert.equal((await post(e, ME, { thread: 'slack:E1:C1:1.1', text: 'x' }, () => false)).status, 404);
    assert.equal((await post(e, ME, { thread: 'slack:E1:C1:1.1', text: '' }, inTeam)).status, 400);
  });
});

describe('Discord accounts', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const G = '100000000000000001';
  const U = '400000000000000001';
  function discordEnv() {
    const e = env();
    Object.assign(e, {
      DISCORD_GUILDS: G, DISCORD_CLIENT_ID: 'dcid', DISCORD_CLIENT_SECRET: 'dsecret', DISCORD_BOT_TOKEN: 'made-up',
    });
    e.DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      path, any_at, updated_at) VALUES (?, 'discord', ?, '2', '3', 'acme', 'helix', 'd/',
      '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z')`).run(`discord:${G}:2:3`, G);
    e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author_key,
      counted) VALUES ('discord', ?, '2', '3', ?, '2026-10-21T10:00:00Z', ?, 1)`)
      .run(G, `discord:${G}:2:3`, `discord:${G}:${U}`);
    return e;
  }

  it('links the account to the person: identity and earlier posts', async () => {
    const e = discordEnv();
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/oauth2/token')) {
        return Response.json({ access_token: 'dat', expires_in: 604800, scope: 'identify' });
      }
      if (String(url).endsWith('/users/@me')) {
        return Response.json({ id: U, username: 'ada' });
      }
      throw new Error(`unexpected ${url}`);
    };
    const state = await makeState(e, 1, 'discord');
    const res = await finishAuth(e, ME, 'discord', new URL(`https://x/cb?code=c&state=${encodeURIComponent(state)}`));
    assert.match(res.headers.get('location'), /connected=discord/);
    assert.deepEqual(await connections(e, 1), { slack: false, teams: false, discord: true });
    const [identity] = e.DB.rows(`SELECT person FROM identities WHERE source = 'discord' AND user_id = '${U}'`);
    assert.equal(identity.person, 1);
    const [m] = e.DB.rows("SELECT person, staff FROM messages WHERE source = 'discord'");
    assert.deepEqual([m.person, m.staff], [1, 1]);
  });

  it('does not reply on Discord', async () => {
    const res = await post(discordEnv(), ME, { thread: `discord:${G}:2:3`, text: 'hi' }, inTeam);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /reply in Discord/);
  });
});
