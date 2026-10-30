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
import {
  appRule, checkFiles, cleanName, personRule, readPost,
} from '../src/attach.js';
import {
  attachable, finishAuth, makeState, personalToken, seal, startAuth,
} from '../src/post.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up keys, ids, people and files only.
const KEY = Buffer.alloc(32, 7).toString('base64url');
const ME = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'helix' }],
};
const SLACK = 'slack:E1:C1:1.1';
const TEAMS = 'teams:T:G:19:c:5';
const DISCORD = 'discord:900:910:920';
const MB = 1024 * 1024;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const file = (name, type, bytes = PNG) => ({
  name, type, size: bytes.length, bytes,
});
const big = (n) => ({ name: 'big.png', type: 'image/png', size: n });

function env(extra = {}) {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }],
    people: [{
      id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
    }],
  });
  const thread = (key, source, tenant, channel, root) => DB.sqlite.prepare(`INSERT INTO threads
      (thread, source, tenant, channel_id, root_id, org, team, path, any_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'acme', 'helix', 'p/', '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z')`)
    .run(key, source, tenant, channel, root);
  thread(SLACK, 'slack', 'E1', 'C1', '1.1');
  thread(TEAMS, 'teams', 'T', '19:c', '5');
  thread(DISCORD, 'discord', '900', '910', '920');
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
    ...extra,
  };
}

async function connect(e, platform, token, scope, expiresAt = null) {
  e.DB.sqlite.prepare(`INSERT INTO user_tokens (person, platform, user_id, access_token,
    refresh_token, expires_at, scope, updated_at) VALUES (1, ?, 'u1', ?, ?, ?, ?, '2026-10-21T10:00:00Z')`)
    .run(platform, await seal(e, token), await seal(e, 'refresh-made-up'), expiresAt, scope);
}

/** A multipart POST of the inbox: the JSON as `payload`, the files as `files`. */
function upload(path, payload, files) {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  for (const f of files) {
    form.append('files', new Blob([f.bytes], { type: f.type }), f.name);
  }
  return new Request(`https://opspile.test${path}`, { method: 'POST', body: form });
}
const send = (e, path, payload, files) => quiet(() => api(
  upload(path, payload, files),
  e,
  new URL(`https://opspile.test${path}`),
  { viewer: ME },
));

describe('attachment rules', () => {
  it('lets Slack take any file once the token may upload, nothing before', () => {
    const none = personRule('slack', 'chat:write,reactions:write');
    assert.equal(none.count, 0);
    assert.equal(none.reconnect, 'slack');
    assert.match(checkFiles(none, [file('a.png', 'image/png')]), /connect your Slack account again/);
    const ok = personRule('slack', 'chat:write,reactions:write,files:write');
    assert.equal(checkFiles(ok, [file('a.png', 'image/png'), file('log.txt', 'text/plain')]), null);
    assert.match(checkFiles(ok, [big(21 * MB)]), /big\.png is 21 MB: files here take up to 20 MB/);
    assert.match(checkFiles(ok, Array(11).fill(file('a.png', 'image/png'))), /up to 10 files/);
    assert.match(checkFiles(ok, [big(15 * MB), big(15 * MB)]), /30 MB together: up to 25 MB/);
    assert.match(checkFiles(ok, [file('empty.txt', 'text/plain', new Uint8Array(0))]), /empty/);
  });

  it('lets Teams take inline images, and other files only with access to the channel files', () => {
    const images = personRule('teams', 'https://graph.microsoft.com/ChannelMessage.Send');
    assert.equal(checkFiles(images, [file('a.png', 'image/png'), file('b.gif', 'image/gif')]), null);
    assert.match(checkFiles(images, [file('a.pdf', 'application/pdf')]), /cannot attach a\.pdf: on Teams the inbox attaches images/);
    assert.match(checkFiles(images, [big(4 * MB)]), /up to 3 MB/);
    const all = personRule('teams', 'ChannelMessage.Send https://graph.microsoft.com/Files.ReadWrite.All');
    assert.equal(checkFiles(all, [file('a.pdf', 'application/pdf'), big(10 * MB)]), null);
  });

  it('has the bots take what their platform lets a bot send', () => {
    assert.equal(checkFiles(appRule('slack'), [file('a.pdf', 'application/pdf')]), null);
    assert.equal(checkFiles(appRule('discord'), [file('a.pdf', 'application/pdf')]), null);
    assert.match(checkFiles(appRule('discord'), [big(11 * MB)]), /up to 10 MB/);
    assert.equal(checkFiles(appRule('teams'), [file('a.png', 'image/png')]), null);
    assert.match(checkFiles(appRule('teams'), [file('a.pdf', 'application/pdf')]), /Teams bot attaches only images/);
    assert.match(checkFiles(personRule('discord'), [file('a.png', 'image/png')]), /cannot post to Discord as you/);
  });

  it('keeps file names without folders or characters SharePoint refuses', () => {
    assert.equal(cleanName('../etc/pass:wd?.txt'), 'etc-pass-wd-.txt');
    assert.equal(cleanName(''), 'file');
  });

  it('reads JSON as before, and multipart with the payload and files', async () => {
    const json = new Request('https://x/api/post', { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
    assert.deepEqual(await readPost(json), { body: { text: 'hi' }, files: [] });
    const read = await readPost(upload('/api/post', { thread: SLACK, text: 'see' }, [file('shot.png', 'image/png')]));
    assert.deepEqual(read.body, { thread: SLACK, text: 'see' });
    assert.equal(read.files.length, 1);
    assert.deepEqual({ ...read.files[0], bytes: [...read.files[0].bytes] }, {
      name: 'shot.png', type: 'image/png', size: 8, bytes: [...PNG],
    });
  });

  it('tells the inbox what each connected account and each bot may attach', async () => {
    const e = env();
    await connect(e, 'slack', 'xoxp-ada', 'chat:write,reactions:write');
    await connect(e, 'teams', 'ms-ada', 'ChannelMessage.Send Files.ReadWrite.All');
    const rules = await attachable(e, 1);
    assert.equal(rules.slack.count, 0);
    assert.equal(rules.teams.other, true);
    const me = await (await api(new Request('https://opspile.test/api/me'), e, new URL('https://opspile.test/api/me'), { viewer: ME })).json();
    assert.equal(me.attach.slack.reconnect, 'slack');
    assert.equal(me.attach.app.teams.other, false);
  });
});

describe('connecting with file access', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('asks Slack for files:write and Microsoft for the channel files only when asked to', async () => {
    const e = env();
    const slack = new URL((await startAuth(e, ME, 'slack', { files: true })).headers.get('location'));
    assert.equal(slack.searchParams.get('user_scope'), 'chat:write,reactions:write,files:write');
    const plain = new URL((await startAuth(e, ME, 'slack')).headers.get('location'));
    assert.equal(plain.searchParams.get('user_scope'), 'chat:write,reactions:write');
    const teams = new URL((await startAuth(e, ME, 'teams', { files: true })).headers.get('location'));
    assert.match(teams.searchParams.get('scope'), /Files\.ReadWrite\.All/);
  });

  it('redeems the Microsoft code with file access, and refreshes with it too', async () => {
    const asked = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/oauth2/v2.0/token')) {
        const scope = new URLSearchParams(init.body).get('scope');
        if (!scope.endsWith('.default')) {
          asked.push(scope);
        }
        return Response.json({
          access_token: 'ms-ada', refresh_token: 'r', expires_in: 3600, scope,
        });
      }
      if (u.includes('/v1.0/me?')) {
        return Response.json({ id: 'u-ada', mail: 'ada@staff.example' });
      }
      if (u.includes('/v1.0/users/')) {
        return Response.json({ displayName: 'Ada', mail: 'ada@staff.example' });
      }
      throw new Error(`unexpected ${u}`);
    };
    const e = env();
    const state = await makeState(e, 1, 'teams', Date.now(), { f: 1 });
    const back = await finishAuth(e, ME, 'teams', new URL(`https://opspile.test/cb?code=c&state=${state}`));
    assert.match(back.headers.get('location'), /connected=teams/);
    assert.match(asked[0], /Files\.ReadWrite\.All/);
    assert.equal((await attachable(e, 1)).teams.other, true);
    e.DB.sqlite.prepare("UPDATE user_tokens SET expires_at = '2020-01-01T00:00:00Z'").run();
    await personalToken(e, 1, 'teams');
    assert.match(asked[1], /Files\.ReadWrite\.All/);
  });

  it('refreshes without file access when that consent is gone, so replies keep working', async () => {
    const asked = [];
    globalThis.fetch = async (url, init = {}) => {
      const scope = new URLSearchParams(init.body).get('scope');
      asked.push(scope);
      return /Files/.test(scope)
        ? Response.json({ error: 'invalid_grant' }, { status: 400 })
        : Response.json({
          access_token: 'ms-plain', refresh_token: 'r', expires_in: 3600, scope,
        });
    };
    const e = env();
    await connect(e, 'teams', 'ms-old', 'ChannelMessage.Send Files.ReadWrite.All', '2020-01-01T00:00:00Z');
    assert.equal((await personalToken(e, 1, 'teams')).token, 'ms-plain');
    assert.equal(asked.length, 2);
    assert.doesNotMatch(asked[1], /Files/);
    // Images only again, with the way to grant file access once more.
    assert.equal((await attachable(e, 1)).teams.other, false);
  });
});

describe('posting with files', () => {
  const real = globalThis.fetch;
  let calls;
  beforeEach(() => {
    calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const call = { url: String(url), method: init.method || 'GET', init };
      calls.push(call);
      if (u.pathname === '/api/files.getUploadURLExternal') {
        const p = new URLSearchParams(init.body);
        return Response.json({ ok: true, upload_url: `https://files.slack.test/upload/${p.get('filename')}`, file_id: `F-${p.get('filename')}` });
      }
      if (u.host === 'files.slack.test') {
        return new Response(`OK - ${init.body.length}`);
      }
      if (u.pathname === '/api/files.completeUploadExternal') {
        return Response.json({ ok: true, files: [] });
      }
      if (u.pathname.endsWith('/filesFolder')) {
        return Response.json({ id: 'folder-1', parentReference: { driveId: 'drive-1' } });
      }
      if (u.pathname.startsWith('/v1.0/drives/')) {
        return Response.json({
          id: 'item-1', name: 'report.pdf', webUrl: 'https://sharepoint.test/report.pdf', eTag: '"{1A2B3C4D-0000-1111-2222-333344445555},1"',
        }, { status: 201 });
      }
      if (u.pathname.endsWith('/replies')) {
        return Response.json({ id: '9' }, { status: 201 });
      }
      if (u.pathname.endsWith('/oauth2/v2.0/token')) {
        return Response.json({ access_token: 'bot-token', expires_in: 3600 });
      }
      if (u.host === 'smba.trafficmanager.net') {
        return Response.json({ id: '77' }, { status: 201 });
      }
      if (u.pathname === '/api/v10/channels/920/messages') {
        return Response.json({ id: '930' });
      }
      throw new Error(`unexpected ${url}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  const allowBot = (e) => e.DB.sqlite.prepare(`INSERT INTO agent_tool_switches (tool, scope, target,
    enabled, changed_at) VALUES ('post_message', 'team', 'helix', 1, '2026-10-21T10:00:00Z')`).run();

  it('uploads to Slack as the person and shares the files in the thread with the text', async () => {
    const e = env();
    await connect(e, 'slack', 'xoxp-ada', 'chat:write,reactions:write,files:write');
    const res = await send(e, '/api/post', { thread: SLACK, text: 'See **this**' }, [
      file('shot.png', 'image/png'), file('log.txt', 'text/plain', new Uint8Array([104, 105])),
    ]);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true, platform: 'slack', id: null, files: ['F-shot.png', 'F-log.txt'], text: 'See **this**',
    });
    const urls = calls.filter((c) => c.url.includes('getUploadURLExternal'));
    assert.equal(urls.length, 2);
    assert.equal(urls[0].init.headers.authorization, 'Bearer xoxp-ada');
    assert.equal(new URLSearchParams(urls[0].init.body).get('length'), '8');
    const bytes = calls.find((c) => c.url.endsWith('/upload/shot.png')).init.body;
    assert.deepEqual([...bytes], [...PNG]);
    const done = new URLSearchParams(calls.find((c) => c.url.includes('completeUploadExternal')).init.body);
    assert.deepEqual(Object.fromEntries(done), {
      files: JSON.stringify([{ id: 'F-shot.png', title: 'shot.png' }, { id: 'F-log.txt', title: 'log.txt' }]),
      channel_id: 'C1',
      thread_ts: '1.1',
      initial_comment: 'See *this*',
    });
    assert.ok(!calls.some((c) => c.url.includes('chat.postMessage')));
  });

  it('sends files without text, and asks to connect Slack again without files:write', async () => {
    const e = env();
    await connect(e, 'slack', 'xoxp-ada', 'chat:write,reactions:write');
    const refused = await send(e, '/api/post', { thread: SLACK, text: '' }, [file('shot.png', 'image/png')]);
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.equal(body.reconnect, 'slack');
    assert.equal(body.files, true);
    assert.equal(calls.length, 0);

    e.DB.sqlite.prepare("UPDATE user_tokens SET scope = 'chat:write,files:write'").run();
    const res = await send(e, '/api/post', { thread: SLACK, text: '' }, [file('shot.png', 'image/png')]);
    assert.equal(res.status, 200);
    const done = new URLSearchParams(calls.find((c) => c.url.includes('completeUploadExternal')).init.body);
    assert.equal(done.get('initial_comment'), null);
  });

  it('puts images inline on Teams as hosted contents of the reply', async () => {
    const e = env();
    await connect(e, 'teams', 'ms-ada', 'ChannelMessage.Send');
    const res = await send(e, '/api/post', { thread: TEAMS, text: 'Look' }, [file('a "b".png', 'image/png')]);
    assert.equal(res.status, 200);
    const sent = JSON.parse(calls.find((c) => c.url.endsWith('/replies')).init.body);
    assert.equal(sent.body.content, 'Look<br><img src="../hostedContents/1/$value" alt="a -b-.png">');
    assert.deepEqual(sent.hostedContents, [{
      '@microsoft.graph.temporaryId': '1', contentBytes: Buffer.from(PNG).toString('base64'), contentType: 'image/png',
    }]);
    // Other files need the channel's files: refused, with a way to grant that.
    const pdf = await send(e, '/api/post', { thread: TEAMS, text: 'Report' }, [file('report.pdf', 'application/pdf')]);
    assert.equal(pdf.status, 409);
    assert.equal((await pdf.json()).reconnect, 'teams');
  });

  it('uploads other files to the channel folder and attaches them by reference', async () => {
    const e = env();
    await connect(e, 'teams', 'ms-ada', 'ChannelMessage.Send Files.ReadWrite.All');
    const res = await send(e, '/api/post', { thread: TEAMS, text: '' }, [file('report.pdf', 'application/pdf')]);
    assert.equal(res.status, 200);
    assert.match(calls.find((c) => c.url.endsWith('/filesFolder')).url, /\/teams\/G1\/channels\/19%3Ac\/filesFolder$/);
    const put = calls.find((c) => c.method === 'PUT');
    assert.match(put.url, /\/drives\/drive-1\/items\/folder-1:\/report\.pdf:\/content\?@microsoft\.graph\.conflictBehavior=rename$/);
    assert.equal(put.init.headers.authorization, 'Bearer ms-ada');
    const sent = JSON.parse(calls.find((c) => c.url.endsWith('/replies')).init.body);
    assert.equal(sent.body.content, '<attachment id="1a2b3c4d-0000-1111-2222-333344445555"></attachment>');
    assert.deepEqual(sent.attachments, [{
      id: '1a2b3c4d-0000-1111-2222-333344445555', contentType: 'reference', contentUrl: 'https://sharepoint.test/report.pdf', name: 'report.pdf',
    }]);
    assert.equal(sent.hostedContents, undefined);
  });

  it('uploads as the opspile app on Slack and Discord, and inline images on Teams', async () => {
    const e = env({
      DISCORD_GUILDS: '900', DISCORD_BOT_TOKEN: 'made-up-discord', TEAMS_APP_ID: 'catalog-app-1',
    });
    allowBot(e);
    let res = await send(e, '/api/post/app', { thread: SLACK, text: 'From the app' }, [file('a.png', 'image/png')]);
    assert.equal(res.status, 200);
    assert.equal(calls.find((c) => c.url.includes('getUploadURLExternal')).init.headers.authorization, 'Bearer xoxb-made-up');
    assert.equal(new URLSearchParams(calls.find((c) => c.url.includes('completeUploadExternal')).init.body).get('initial_comment'), 'From the app');

    res = await send(e, '/api/post/app', { thread: DISCORD, text: 'Here' }, [file('a.png', 'image/png')]);
    assert.equal(res.status, 200);
    const form = calls.find((c) => c.url.endsWith('/channels/920/messages')).init.body;
    assert.ok(form instanceof FormData);
    assert.deepEqual(JSON.parse(form.get('payload_json')), {
      content: 'Here', allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: 'a.png' }],
    });
    assert.equal(form.get('files[0]').name, 'a.png');
    assert.deepEqual([...new Uint8Array(await form.get('files[0]').arrayBuffer())], [...PNG]);

    res = await send(e, '/api/post/app', { thread: TEAMS, text: '' }, [file('a.png', 'image/png')]);
    assert.equal(res.status, 200);
    const activity = JSON.parse(calls.find((c) => c.url.includes('smba.trafficmanager.net')).init.body);
    assert.deepEqual(activity.attachments, [{
      contentType: 'image/png', contentUrl: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`, name: 'a.png',
    }]);

    // The Teams bot cannot send other files: refused before anything is sent.
    const before = calls.length;
    res = await send(e, '/api/post/app', { thread: TEAMS, text: 'x' }, [file('a.pdf', 'application/pdf')]);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Teams bot attaches only images/);
    assert.equal(calls.length, before);
  });

  it('says when the Slack app may not upload yet', async () => {
    globalThis.fetch = async () => Response.json({ ok: false, error: 'missing_scope', needed: 'files:write' });
    const e = env();
    allowBot(e);
    const res = await send(e, '/api/post/app', { thread: SLACK, text: 'x' }, [file('a.png', 'image/png')]);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /needs the bot scope files:write/);
  });
});
