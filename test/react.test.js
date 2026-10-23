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
import { api, inbox } from '../src/api.js';
import { reactable, seal } from '../src/post.js';
import { nativeEmoji, react, resolve } from '../src/react.js';
import {
  isResolvedEmoji, mergeFacts, resolution, resolutionFacts, signalFacts, signalOf,
} from '../src/resolve.js';
import { applyReaction, waitingOn } from '../src/threads.js';
import { d1 } from './d1.js';

// Made-up keys, ids and people only.
const KEY = Buffer.alloc(32, 7).toString('base64url');
const ME = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'helix' }],
};
const SLACK = 'slack:E1:C1:1.1';
const TEAMS = 'teams:T:G:19:c:5';
const inTeam = (t) => [].concat(t).includes('helix');

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
  for (const [thread, source, tenant, channel, root] of [
    [SLACK, 'slack', 'E1', 'C1', '1.1'], [TEAMS, 'teams', 'T', '19:c', '5']]) {
    sql(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, path, root_at,
      last_at, any_at, updated_at) VALUES (?, ?, ?, ?, ?, 'acme', 'helix', 'p/',
      '2026-10-21T10:00:00Z', '2026-10-21T10:05:00Z', '2026-10-21T10:05:00Z',
      '2026-10-21T10:05:00Z')`, thread, source, tenant, channel, root);
  }
  const msg = (thread, source, tenant, channel, id, at, staff) => sql(
    `INSERT INTO messages (source,
    tenant, channel_id, id, thread, at, staff, counted) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    source,
    tenant,
    channel,
    id,
    thread,
    at,
    staff,
  );
  msg(SLACK, 'slack', 'E1', 'C1', '1.1', '2026-10-21T10:00:00Z', 0);
  msg(SLACK, 'slack', 'E1', 'C1', '1.2', '2026-10-21T10:05:00Z', 1);
  msg(TEAMS, 'teams', 'T', '19:c', '5', '2026-10-21T10:00:00Z', 0);
  msg(TEAMS, 'teams', 'T', '19:c', '6', '2026-10-21T10:05:00Z', 1);
  sql(`INSERT INTO channels (source, tenant, channel_id, group_id, fetched_at)
    VALUES ('teams', 'T', '19:c', 'G1', '2099-01-01T00:00:00Z')`);
  // Identities, cached far in the future so no lookup is needed.
  const id = (source, tenant, user, name, person, email) => sql(
    `INSERT INTO identities (source,
    tenant, user_id, kind, name, email, person, avatar, fetched_at)
    VALUES (?, ?, ?, 'person', ?, ?, ?, '', '2099-01-01T00:00:00Z')`,
    source,
    tenant,
    user,
    name,
    email,
    person,
  );
  id('slack', 'E1', 'U1', 'Ada', 1, 'ada@staff.example');
  id('slack', 'E1', 'U7', 'Cy', 2, 'cy@customer.example');
  id('teams', 'T', 'u-ada', 'Ada', 1, 'ada@staff.example');
  return {
    DB,
    TOKEN_KEY: KEY,
    STAFF_DOMAINS: 'staff.example',
    MS_TENANT_ID: 'T',
  };
}

async function connect(e, platform, scope) {
  const user = platform === 'slack' ? 'U1' : 'u-ada';
  e.DB.sqlite.prepare(`INSERT INTO user_tokens (person, platform, user_id, access_token, scope,
    updated_at) VALUES (1, ?, ?, ?, ?, '2026-10-21T10:00:00Z')`)
    .run(platform, user, await seal(e, `${platform}-token`), scope);
  return e;
}

const rx = (e) => e.DB.rows('SELECT message, emoji, user_key, at FROM reactions ORDER BY at');

describe('resolution', () => {
  const check = (at, person = 1) => ({ at, person, name: 'Ada' });

  it('is resolved by a staff ✅, and reopened by a later customer message', () => {
    assert.equal(resolution({ checks: [] }, null, 1), null);
    assert.deepEqual(resolution({ checks: [check('2026-10-21T11:00:00Z')], customerAt: '2026-10-21T10:00:00Z' }, null, 1), {
      state: 'resolved', verdict: 'resolved', at: '2026-10-21T11:00:00Z', by: ['Ada'], mine: true,
    });
    const reopened = resolution({
      checks: [check('2026-10-21T11:00:00Z', 3)], customerAt: '2026-10-21T12:00:00Z',
    }, { labeled_through: '2026-10-21T11:00:00Z' }, 1);
    assert.equal(reopened.state, 'reopened');
    assert.equal(reopened.verdict, 'open');
    assert.equal(reopened.mine, false);
    // Once Clef has read the customer's message, Clef decides again.
    assert.equal(resolution({
      checks: [check('2026-10-21T11:00:00Z')], customerAt: '2026-10-21T12:00:00Z',
    }, { labeled_through: '2026-10-21T12:00:00Z' }, 1).verdict, null);
  });

  it('merges the members of a group, latest ✅ and latest customer message', () => {
    const merged = mergeFacts([
      { checks: [check('2026-10-21T11:00:00Z')], customerAt: '2026-10-21T10:00:00Z' },
      { checks: [], customerAt: '2026-10-21T10:30:00Z' },
      undefined,
    ]);
    assert.equal(merged.customerAt, '2026-10-21T10:30:00Z');
    assert.equal(resolution(merged, null, 1).state, 'resolved');
  });

  it('counts only ✅ by staff, on the root message', async () => {
    const e = env();
    const add = (message, emoji, user, at) => applyReaction(e.DB, {
      thread: SLACK, message, emoji, userKey: `slack:E1:${user}`, at,
    });
    await add('slack:E1:C1:1.1', 'white_check_mark', 'U7', '2026-10-21T11:00:00Z'); // customer
    await add('slack:E1:C1:1.2', 'white_check_mark', 'U1', '2026-10-21T11:00:00Z'); // a reply
    await add('slack:E1:C1:1.1', 'thumbsup', 'U1', '2026-10-21T11:00:00Z');
    let facts = await resolutionFacts(e, [SLACK]);
    assert.deepEqual(facts.get(SLACK).checks, []);
    await add('slack:E1:C1:1.1', 'white_check_mark', 'U1', '2026-10-21T11:00:00Z');
    facts = await resolutionFacts(e, [SLACK]);
    assert.equal(facts.get(SLACK).checks.length, 1);
    assert.equal(facts.get(SLACK).customerAt, '2026-10-21T10:00:00Z');
    assert.equal(resolution(facts.get(SLACK), null, 1).state, 'resolved');
    assert.ok(isResolvedEmoji('✅\ufe0f'));
    assert.ok(isResolvedEmoji('heavy_check_mark'));
    assert.ok(isResolvedEmoji('✔️'));
  });

  it('counts a staff ✔️ on the root as resolved, too', async () => {
    const e = env();
    await applyReaction(e.DB, {
      thread: SLACK, message: 'slack:E1:C1:1.1', emoji: 'heavy_check_mark', userKey: 'slack:E1:U1', at: '2026-10-21T11:00:00Z',
    });
    const facts = await resolutionFacts(e, [SLACK]);
    assert.equal(resolution(facts.get(SLACK), null, 1).state, 'resolved');
  });
});

describe('steering reactions', () => {
  it('reads 👀, 🙏 and 🛟 on any message, with who and whether they are staff', async () => {
    assert.deepEqual(
      ['eyes', '👀', 'pray', '🙏', 'ring_buoy', '🛟', 'tada'].map(signalOf),
      ['seen', 'seen', 'thanks', 'thanks', 'help', 'help', null],
    );
    const e = env();
    const add = (emoji, user) => applyReaction(e.DB, {
      thread: SLACK, message: 'slack:E1:C1:1.2', emoji, userKey: `slack:E1:${user}`, at: '2026-10-21T11:00:00Z',
    });
    await add('eyes', 'U1');
    await add('pray', 'U7');
    await add('tada', 'U7');
    const got = (await signalFacts(e, [SLACK])).get(SLACK)
      .map((x) => [x.signal, x.person, x.staff]).sort();
    assert.deepEqual(got, [['seen', 1, true], ['thanks', 2, false]]);
  });

  it('🙏 after the last message clears "waiting on"', () => {
    const t = {
      kind: 'channel', last_staff: 0, last_at: '2026-10-21T10:05:00Z', label: { next_actor: 'us' },
    };
    assert.equal(waitingOn(t), 'us');
    assert.equal(waitingOn({ ...t, signals: [{ signal: 'thanks', at: '2026-10-21T10:06:00Z' }] }), 'nobody');
    // An older 🙏 does not answer a newer message.
    assert.equal(waitingOn({ ...t, signals: [{ signal: 'thanks', at: '2026-10-21T10:01:00Z' }] }), 'us');
  });
});

describe('reaction order', () => {
  it('a remove only takes away an older add, so remove-and-add arrives right in any order', async () => {
    const e = env();
    const r = (at, removed) => applyReaction(e.DB, {
      thread: SLACK, message: 'slack:E1:C1:1.1', emoji: 'eyes', userKey: 'slack:E1:U1', at, removed,
    });
    await r('2026-10-21T11:00:00Z');
    await r('2026-10-21T12:00:01Z'); // the add of a remove-and-add, before its remove
    await r('2026-10-21T12:00:00Z', true);
    assert.deepEqual(rx(e).map((x) => x.at), ['2026-10-21T12:00:01Z']);
    await r('2026-10-21T13:00:00Z', true);
    assert.deepEqual(rx(e), []);
  });
});

describe('reacting and resolving as the person', () => {
  const real = globalThis.fetch;
  let calls;
  let slackAnswer;
  beforeEach(() => {
    calls = [];
    slackAnswer = { ok: true };
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ u, body, auth: init.headers?.authorization });
      if (u.startsWith('https://slack.com/api/reactions.')) {
        return Response.json(slackAnswer);
      }
      if (/\/(set|unset)Reaction$/.test(u)) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${u}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('asks to connect Slack again when the token cannot react yet', async () => {
    const e = await connect(env(), 'slack', 'chat:write');
    assert.deepEqual(await reactable(e, 1), { slack: false, teams: false });
    const res = await react(e, ME, { thread: SLACK, id: '1.2', emoji: 'eyes' }, inTeam);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reconnect, 'slack');
    assert.equal(calls.length, 0);
  });

  it('reacts on Slack with the person\'s token and shows it at once', async () => {
    const e = await connect(env(), 'slack', 'chat:write,reactions:write');
    assert.equal((await reactable(e, 1)).slack, true);
    const res = await react(e, ME, { thread: SLACK, id: '1.2', emoji: 'tada' }, inTeam);
    assert.equal(res.status, 200);
    assert.equal(calls[0].u, 'https://slack.com/api/reactions.add');
    assert.equal(calls[0].auth, 'Bearer slack-token');
    assert.deepEqual(calls[0].body, { channel: 'C1', timestamp: '1.2', name: 'tada' });
    assert.deepEqual(rx(e).map((x) => [x.message, x.emoji, x.user_key]), [['slack:E1:C1:1.2', 'tada', 'slack:E1:U1']]);
    // Reacting means having read up to there.
    assert.equal(e.DB.rows('SELECT via FROM watermarks WHERE person = 1')[0].via, 'react');

    slackAnswer = { ok: false, error: 'no_reaction' };
    const gone = await react(e, ME, {
      thread: SLACK, id: '1.2', emoji: 'tada', remove: true,
    }, inTeam);
    assert.equal(gone.status, 200);
    assert.equal(calls[1].u, 'https://slack.com/api/reactions.remove');
    assert.deepEqual(rx(e), []);
  });

  it('puts a ✅ on a reply on the thread\'s first message, too, and takes it off both', async () => {
    const e = await connect(env(), 'slack', 'chat:write,reactions:write');
    const res = await react(e, ME, { thread: SLACK, id: '1.2', emoji: 'white_check_mark' }, inTeam);
    assert.equal(res.status, 200);
    assert.deepEqual(
      calls.map((c) => [c.u.split('.').pop(), c.body.timestamp, c.body.name]),
      [['add', '1.2', 'white_check_mark'], ['add', '1.1', 'white_check_mark']],
    );
    assert.equal((await resolutionFacts(e, [SLACK])).get(SLACK).checks.length, 1);
    await react(e, ME, {
      thread: SLACK, id: '1.2', emoji: 'white_check_mark', remove: true,
    }, inTeam);
    assert.deepEqual(
      calls.slice(2).map((c) => [c.u.split('.').pop(), c.body.timestamp]),
      [['remove', '1.2'], ['remove', '1.1']],
    );
    assert.deepEqual(rx(e), []);
  });

  it('reacts on a Teams reply with the Unicode emoji', async () => {
    const e = await connect(env(), 'teams', 'ChannelMessage.Send');
    const res = await react(e, ME, { thread: TEAMS, id: '6', emoji: 'thumbsup' }, inTeam);
    assert.equal(res.status, 200);
    assert.match(calls[0].u, /\/teams\/G1\/channels\/19%3Ac\/messages\/5\/replies\/6\/setReaction$/);
    assert.deepEqual(calls[0].body, { reactionType: '👍' });
    assert.deepEqual(rx(e).map((x) => x.user_key), ['teams:T:u-ada']);
  });

  it('refuses unknown messages, odd emoji, other teams and non-staff', async () => {
    const e = await connect(env(), 'slack', 'chat:write,reactions:write');
    assert.equal((await react(e, ME, { thread: SLACK, id: '9.9', emoji: 'eyes' }, inTeam)).status, 404);
    assert.equal((await react(e, ME, { thread: SLACK, id: '1.2', emoji: '<b>' }, inTeam)).status, 400);
    assert.equal((await react(e, ME, { thread: SLACK, id: '1.2', emoji: 'eyes' }, () => false)).status, 404);
    const outsider = { ...ME, email: 'ada@else.example' };
    assert.equal((await react(e, outsider, { thread: SLACK, id: '1.2', emoji: 'eyes' }, inTeam)).status, 403);
    assert.equal(nativeEmoji('teams', '✅'), '✅');
    assert.equal(nativeEmoji('teams', 'heart'), '❤️');
    assert.equal(nativeEmoji('teams', 'abc'), null);
    assert.equal(nativeEmoji('slack', 'thumbsup::skin-tone-3'), 'thumbsup::skin-tone-3');
    assert.equal(calls.length, 0);
  });

  it('resolves with ✅ on the root, undoes it, and moves it when resolving again', async () => {
    const e = await connect(env(), 'slack', 'chat:write,reactions:write');
    let res = await resolve(e, ME, { thread: SLACK }, inTeam);
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0].body, { channel: 'C1', timestamp: '1.1', name: 'white_check_mark' });
    let facts = await resolutionFacts(e, [SLACK]);
    assert.equal(resolution(facts.get(SLACK), null, 1).state, 'resolved');
    const { threads } = await inbox(e, ME, 'helix');
    const entry = threads.find((t) => t.thread === SLACK);
    assert.deepEqual([entry.resolution.verdict, entry.resolution.mine, entry.resolution.by], ['resolved', true, ['Ada']]);
    assert.equal(threads.find((t) => t.thread === TEAMS).resolution, null);

    // The customer writes again: reopened. Resolving again moves the ✅ past their message.
    const first = rx(e)[0].at;
    e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff,
      counted) VALUES ('slack', 'E1', 'C1', '1.3', ?, ?, 0, 1)`).run(SLACK, new Date(Date.parse(first) + 1).toISOString());
    facts = await resolutionFacts(e, [SLACK]);
    assert.equal(resolution(facts.get(SLACK), null, 1).verdict, 'open');
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    res = await resolve(e, ME, { thread: SLACK }, inTeam);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.slice(1).map((c) => c.u.split('.').pop()), ['remove', 'add']);
    facts = await resolutionFacts(e, [SLACK]);
    assert.equal(resolution(facts.get(SLACK), null, 1).state, 'resolved');

    res = await resolve(e, ME, { thread: SLACK, undo: true }, inTeam);
    assert.equal(res.status, 200);
    assert.equal(calls.pop().u, 'https://slack.com/api/reactions.remove');
    assert.deepEqual(rx(e), []);
    assert.equal((await resolve(e, ME, { thread: SLACK, undo: true }, inTeam)).status, 409);
  });

  it('resolves a Teams thread with ✅ on the root message', async () => {
    const e = await connect(env(), 'teams', 'ChannelMessage.Send');
    assert.equal((await resolve(e, ME, { thread: TEAMS }, inTeam)).status, 200);
    assert.match(calls[0].u, /\/messages\/5\/setReaction$/);
    assert.deepEqual(calls[0].body, { reactionType: '✅' });
    assert.equal((await resolve(e, ME, { thread: TEAMS, undo: true }, inTeam)).status, 200);
    assert.match(calls[1].u, /\/messages\/5\/unsetReaction$/);
  });

  it('refuses reactions while viewing as someone else', async () => {
    const e = await connect(env(), 'slack', 'chat:write,reactions:write');
    const viewer = { ...ME, readonly: true, viewer: { id: 9, name: 'Admin' } };
    for (const path of ['/api/react', '/api/resolve']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await api(new Request(`https://opspile.test${path}`, {
        method: 'POST', body: JSON.stringify({ thread: SLACK, id: '1.2', emoji: 'eyes' }),
      }), e, new URL(`https://opspile.test${path}`), { viewer });
      assert.equal(res.status, 403);
    }
    assert.equal(calls.length, 0);
  });
});
