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
import { advanceWatermark, indexMessage, recordMentions } from '../src/threads.js';
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
      id: 1, name: 'A', email: 'a@staff.example', teams: [{ slug: 'helix', name: 'Helix', role: 'member' }], admin: false, manages: [],
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
      ...base, rootId: '2', id: '3', thread: 't2', at: '2026-10-21T11:05:00Z', person: 2, staff: true, path: 'p2/', preview: 'on it',
    });
    DB.sqlite.prepare(`INSERT INTO labels (thread, next_actor, labeled_through, model, labeled_at)
      VALUES (?, 'us', '', 'm', '')`).run('t2');
    const { threads, members } = await inbox({ DB }, { id: 1 }, 'helix');
    assert.deepEqual(members.map((m) => m.name), ['A', 'B']);
    assert.deepEqual(threads.map((t) => t.permalink), [null, 'https://chat.example/1']);
    const view = threads.map((t) => [
      t.thread, t.unread, t.seenByOthers, t.unseen, t.last_staff, t.waiting_on, t.last_text,
    ]);
    // t2 is labeled "us", but Adobe posted last: it does not wait on us.
    assert.deepEqual(view, [
      ['t2', true, true, false, 1, 'nobody', 'on it'],
      ['t1', true, false, true, 0, 'us', null],
    ]);
  });
});

describe('personal view', () => {
  const people = [
    {
      id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['admin', 'helix'],
    },
    {
      id: 2, email: 'b@staff.example', name: 'B', staff: 1, teams: ['helix', 'other'],
    },
  ];
  const fresh = () => d1({
    teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'admin', name: 'Admin' }, { slug: 'other', name: 'Other' }],
    people,
  });
  const me = {
    id: 1, name: 'A', teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix' }],
  };
  let n = 0;
  /** One message: `channelId` filed under `team`, as `person` (or a customer). */
  const say = (DB, {
    thread, channelId, team, person = null, at, kind = 'channel',
  }) => {
    n += 1;
    return indexMessage(DB, {
      source: 'slack',
      tenant: 'E1',
      channelId,
      org: 'acme',
      team,
      kind,
      counted: true,
      staff: Boolean(person),
      person,
      rootId: thread,
      id: `${thread}.${n}`,
      thread,
      at,
      title: thread,
      path: `${thread}/`,
    }).then(() => `slack:E1:${channelId}:${thread}.${n}`);
  };

  it('has the threads of my teams\' channels that I posted or was mentioned in', async () => {
    const DB = fresh();
    const at = (m) => `2026-10-21T10:${String(m).padStart(2, '0')}:00Z`;
    await say(DB, {
      thread: 'posted', channelId: 'C1', team: 'helix', person: 1, at: at(1),
    });
    // Another thread of a channel I posted in, though not in this one.
    await say(DB, {
      thread: 'same-channel', channelId: 'C1', team: 'helix', at: at(2),
    });
    await say(DB, {
      thread: 'alert', channelId: 'C1', team: 'helix', at: at(3), kind: 'alert',
    });
    const m = await say(DB, {
      thread: 'mentioned', channelId: 'C2', team: 'helix', person: 2, at: at(4),
    });
    await recordMentions(DB, { thread: 'mentioned', message: m, at: at(4) }, [{ person: 1, via: 'id' }]);
    await say(DB, {
      thread: 'quiet', channelId: 'C3', team: 'helix', at: at(5),
    });
    await say(DB, {
      thread: 'admin', channelId: 'C4', team: 'admin', person: 1, at: at(6),
    });
    // Not one of my teams' channels: not mine to see, though I posted there.
    await say(DB, {
      thread: 'elsewhere', channelId: 'C5', team: 'other', person: 1, at: at(7),
    });
    const res = await inbox({ DB }, me, null, { personal: true });
    assert.equal(res.personal, true);
    assert.equal(res.team, null);
    assert.deepEqual(res.threads.map((t) => t.thread).sort(), ['admin', 'mentioned', 'posted', 'same-channel']);
    assert.deepEqual(res.members.map((x) => x.name), ['A', 'B']);
    // The team inbox is as it was.
    const team = await inbox({ DB }, me, 'helix');
    assert.deepEqual(team.threads.map((t) => t.thread).sort(), ['alert', 'mentioned', 'posted', 'quiet', 'same-channel']);
  });

  it('is asked for with view=personal, whatever the team', async () => {
    const DB = fresh();
    await say(DB, {
      thread: 'posted', channelId: 'C1', team: 'helix', person: 1, at: '2026-10-21T10:00:00Z',
    });
    const url = new URL('https://opspile.test/api/inbox?view=personal');
    const res = await api(new Request(url), { DB }, url, { viewer: me });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).threads.map((t) => t.thread), ['posted']);
  });

  it('counts the mentions of me since I last read the thread, once each', async () => {
    const DB = fresh();
    const at = (m) => `2026-10-21T10:${String(m).padStart(2, '0')}:00Z`;
    const mention = async (minute) => {
      const m = await say(DB, {
        thread: 't', channelId: 'C1', team: 'helix', person: 2, at: at(minute),
      });
      await recordMentions(DB, { thread: 't', message: m, at: at(minute) }, [{ person: 1, via: 'id' }]);
    };
    await mention(1);
    await advanceWatermark(DB, 1, 't', at(1), 'open');
    await mention(2);
    await mention(3);
    // A is in two of the teams (admin, helix), B in helix: the mention counts once.
    const [t] = (await inbox({ DB }, me, null, { personal: true })).threads;
    assert.deepEqual([t.thread, t.unreadMentions, t.mentionedMe], ['t', 2, true]);
    const [same] = (await inbox({ DB }, me, 'helix')).threads;
    assert.equal(same.unreadMentions, 2);
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

  it('pages through the groups, newest first, with no gaps or repeats, even at equal times', async () => {
    const DB = d1({
      teams: [{ slug: 'helix', name: 'Helix' }],
      people: [{
        id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['helix'],
      }],
    });
    const row = DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      kind, title, path, root_at, last_at, any_at, messages, updated_at)
      VALUES (?, 'slack', 'E1', 'C1', ?, 'acme', 'helix', 'channel', 't', ?, ?, ?, ?, 1, ?)`);
    for (let i = 0; i < 7; i += 1) {
      // Two threads share each minute.
      const at = new Date(Date.UTC(2026, 9, 20, 0, Math.floor(i / 2))).toISOString();
      row.run(`t${i}`, `${i}`, `p${i}/`, at, at, at, at);
    }
    const pages = [];
    let cursor = null;
    for (let n = 0; n < 5; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { threads, page } = await inbox({ DB }, { id: 1 }, 'helix', { before: cursor, limit: 3 });
      pages.push(threads.map((t) => t.thread).sort().reverse());
      cursor = page.next;
      if (!cursor) {
        break;
      }
    }
    // Pages follow each other in time; within a page the inbox sorts as it likes.
    assert.deepEqual(pages, [['t6', 't5', 't4'], ['t3', 't2', 't1'], ['t0']]);
    assert.equal(cursor, null);
  });
});

describe('system-only threads', () => {
  it('hides join notices but keeps threads where a person or a bot posted', async () => {
    const DB = d1({
      teams: [{ slug: 'helix', name: 'Helix' }],
      people: [{
        id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['helix'],
      }],
    });
    const base = {
      source: 'slack', tenant: 'E1', channelId: 'C1', org: 'acme', team: 'helix', kind: 'channel', staff: false,
    };
    await indexMessage(DB, {
      ...base, rootId: '1', id: '1', thread: 'join', at: '2026-10-21T10:00:00Z', title: '@Sam has joined the channel', path: 'p1/', counted: false,
    });
    await indexMessage(DB, {
      ...base, rootId: '2', id: '2', thread: 'bot', at: '2026-10-21T10:01:00Z', title: 'Welcome!', path: 'p2/', counted: false, authorKey: 'slack:E1:B1',
    });
    await indexMessage(DB, {
      ...base, rootId: '3', id: '3', thread: 'person', at: '2026-10-21T10:02:00Z', title: 'help', path: 'p3/', counted: true, authorKey: 'slack:E1:U1',
    });
    const { threads } = await inbox({ DB }, { id: 1 }, 'helix');
    assert.deepEqual(threads.map((t) => t.thread).sort(), ['bot', 'person']);
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
