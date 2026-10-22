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
  before, beforeEach, describe, it,
} from 'node:test';
import { accessEmail, resetKeyCache } from '../src/access.js';
import { api, inbox, viewer } from '../src/api.js';
import { indexMessage } from '../src/threads.js';
import { d1 } from './d1.js';

// A throwaway key pair and made-up team domain, audience and people.
const TEAM = 'https://example.cloudflareaccess.com';
const AUD = 'test-aud';
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
let keys;
let jwk;

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
async function sign(claims, { kid = 'k1', key = keys.privateKey, alg = 'RS256' } = {}) {
  const head = b64(JSON.stringify({ alg, kid }));
  const body = b64(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(new Uint8Array(sig))}`;
}
const claims = (extra = {}) => ({
  aud: [AUD], iss: TEAM, exp: NOW / 1000 + 600, email: 'A@staff.example', ...extra,
});
const req = (jwt) => new Request('https://opspile.test/api/me', { headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} });
const fetchImpl = async () => Response.json({ keys: [jwk] });
const check = (jwt, e = env) => accessEmail(req(jwt), e, { fetchImpl, now: NOW });

before(async () => {
  keys = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' };
});
beforeEach(() => resetKeyCache());

describe('accessEmail', () => {
  it('returns the email of a valid token', async () => {
    assert.equal(await check(await sign(claims())), 'a@staff.example');
  });

  it('rejects a missing, expired, foreign or forged token', async () => {
    assert.equal(await check(null), null);
    assert.equal(await check(await sign(claims({ exp: NOW / 1000 - 1 }))), null);
    assert.equal(await check(await sign(claims({ aud: ['other'] }))), null);
    assert.equal(await check(await sign(claims({ iss: 'https://evil.example' }))), null);
    assert.equal(await check(await sign(claims(), { kid: 'unknown' })), null);
    const other = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
    }, true, ['sign', 'verify']);
    assert.equal(await check(await sign(claims(), { key: other.privateKey })), null);
    assert.equal(await check(await sign(claims(), { alg: 'none' })), null);
  });

  it('fails closed without configuration', async () => {
    assert.equal(await check(await sign(claims()), {}), null);
  });
});

describe('viewer and inbox', () => {
  const people = [
    {
      id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['helix'],
    },
    {
      id: 2, email: 'b@staff.example', name: 'B', staff: 1, teams: ['helix'],
    },
  ];
  const fresh = () => d1({ teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'admin', name: 'Admin' }], people });

  it('ties a signed-in email to a person and their teams', async () => {
    const DB = fresh();
    const me = await viewer(req(await sign(claims())), { ...env, DB }, { fetchImpl, now: NOW });
    assert.deepEqual(me, {
      id: 1, name: 'A', email: 'a@staff.example', teams: [{ slug: 'helix', name: 'Helix' }], admin: false,
    });
    const nobody = await viewer(req(await sign(claims({ email: 'x@else.example' }))), { ...env, DB }, { fetchImpl, now: NOW });
    assert.equal(nobody, null);
  });

  it('lists the team\'s threads with read state', async () => {
    const DB = fresh();
    const base = {
      source: 'slack', tenant: 'E1', channelId: 'C1', org: 'acme', team: 'helix', kind: 'channel', counted: true, staff: false,
    };
    await indexMessage(DB, {
      ...base, rootId: '1', id: '1', thread: 't1', at: '2026-10-21T10:00:00Z', title: 'one', path: 'p1/', permalink: 'https://chat.example/1',
    });
    await indexMessage(DB, {
      ...base, rootId: '2', id: '2', thread: 't2', at: '2026-10-21T11:00:00Z', title: 'two', path: 'p2/',
    });
    await indexMessage(DB, {
      ...base, rootId: '2', id: '3', thread: 't2', at: '2026-10-21T11:05:00Z', person: 2, staff: true, path: 'p2/',
    });
    const { threads, members } = await inbox({ DB }, { id: 1 }, 'helix');
    assert.deepEqual(members.map((m) => m.name), ['A', 'B']);
    assert.deepEqual(threads.map((t) => t.permalink), [null, 'https://chat.example/1']);
    const view = threads.map((t) => [t.thread, t.unread, t.seenByOthers, t.unseen, t.last_staff]);
    assert.deepEqual(view, [
      ['t2', true, true, false, 1],
      ['t1', true, false, true, 0],
    ]);
  });
});

describe('viewing as someone else', () => {
  const people = [
    {
      id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['admin', 'helix'],
    },
    {
      id: 2, email: 'b@staff.example', name: 'B', staff: 1, teams: ['helix'],
    },
  ];
  const fresh = () => d1({ teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'admin', name: 'Admin' }], people });
  const as = (jwt, who) => new Request('https://opspile.test/api/me', {
    headers: { 'cf-access-jwt-assertion': jwt, 'x-opspile-as': String(who) },
  });

  it('lets an admin see the inbox as another person, read-only', async () => {
    const DB = fresh();
    const me = await viewer(as(await sign(claims()), 2), { ...env, DB }, { fetchImpl, now: NOW });
    assert.deepEqual([me.id, me.readonly, me.viewer.id, me.teams.map((t) => t.slug)], [2, true, 1, ['helix']]);
    const res = await api(new Request('https://opspile.test/api/read', { method: 'POST', body: '{}' }), { DB }, new URL('https://opspile.test/api/read'), { viewer: me });
    assert.equal(res.status, 403);
  });

  it('ignores the header for everyone else', async () => {
    const DB = fresh();
    const me = await viewer(as(await sign(claims({ email: 'b@staff.example' })), 1), { ...env, DB }, { fetchImpl, now: NOW });
    assert.deepEqual([me.id, me.readonly], [2, undefined]);
  });
});

describe('inbox groups', () => {
  it('shows a big group once, with its first thread\'s title and the full count', async () => {
    const DB = d1({
      teams: [{ slug: 'helix', name: 'Helix' }],
      people: [{
        id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['helix'],
      }],
    });
    const row = DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      kind, title, path, root_at, any_at, messages, logical_thread, updated_at)
      VALUES (?, 'slack', 'E1', 'C1', ?, 'acme', 'helix', 'alert', 'generic', ?, ?, ?, 1, ?, ?)`);
    for (let i = 0; i < 12; i += 1) {
      const at = new Date(Date.UTC(2026, 9, 20, 0, i)).toISOString();
      row.run(`a${i}`, `${i}`, `p${i}/`, at, at, i ? 'a0' : null, at);
    }
    DB.sqlite.prepare(`INSERT INTO labels (thread, kind, labeled_through, model, labeled_at, title)
      VALUES ('a0', 'alert', '', 'm', '', 'Checkout fails with 422')`).run();
    const { threads } = await inbox({ DB }, { id: 1 }, 'helix');
    assert.equal(threads.length, 1);
    assert.deepEqual(
      [threads[0].thread, threads[0].title, threads[0].occurrences, threads[0].messages],
      ['a0', 'Checkout fails with 422', 12, 12],
    );
    assert.equal(threads[0].members.length, 6); // the first thread and the five most recent
  });
});

describe('media proxy', () => {
  it('only fetches Slack files and Teams hosted contents', async () => {
    const { media } = await import('../src/api.js');
    for (const u of ['https://evil.example/x.png', 'http://files.slack.com/x', 'https://graph.microsoft.com/v1.0/users/x', 'not a url']) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await media({}, u)).status, 400);
    }
  });

  it('passes on images only', async () => {
    const { media } = await import('../src/api.js');
    const real = globalThis.fetch;
    globalThis.fetch = async (u, init) => {
      assert.equal(init.headers.authorization, 'Bearer xoxb-made-up');
      return new Response(String(u).endsWith('.png') ? 'PNG' : '<html>', {
        headers: { 'content-type': String(u).endsWith('.png') ? 'image/png' : 'text/html' },
      });
    };
    try {
      const slackEnv = { SLACK_BOT_TOKEN: 'xoxb-made-up' };
      const ok = await media(slackEnv, 'https://files.slack.com/files-pri/T1-F1/a.png');
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('content-type'), 'image/png');
      assert.equal((await media(slackEnv, 'https://files.slack.com/files-pri/T1-F1/a.html')).status, 502);
    } finally {
      globalThis.fetch = real;
    }
  });
});
