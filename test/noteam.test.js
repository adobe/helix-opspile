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
import { describe, it } from 'node:test';
import {
  api, inbox, personByEmail, personById,
} from '../src/api.js';
import { withEmails } from '../src/accesssync.js';
import { recipients } from '../src/shares.js';
import { TOOLS } from '../src/mcp-tools.js';
import { advanceWatermark, indexMessage, recordMentions } from '../src/threads.js';
import { d1 } from './d1.js';

// No-team mode: anyone from SIGNIN_DOMAINS signs in, team or not. Made-up domains and people.
const people = [
  {
    id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['helix'],
  },
  {
    id: 2, email: 'solo@staff.example', name: 'Solo', staff: 1,
  },
];
const fresh = () => d1({
  teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'other', name: 'Other' }],
  people,
});
const OPEN = { STAFF_DOMAINS: 'staff.example', SIGNIN_DOMAINS: 'staff.example' };
const SOLO = {
  id: 2, email: 'solo@staff.example', name: 'Solo', teams: [],
};
const at = (m) => `2026-10-21T10:${String(m).padStart(2, '0')}:00Z`;
let n = 0;
/** One message: `channelId` filed under `team`, as `person` (or a customer). */
const say = (DB, {
  thread, channelId, team, person = null, minute, kind = 'channel',
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
    at: at(minute),
    title: thread,
    path: `${thread}/`,
  }).then(() => `slack:E1:${channelId}:${thread}.${n}`);
};
/** Solo posted in C1 (helix) and was mentioned in C2 (other); C3 is nothing of theirs. */
async function channels(DB) {
  await say(DB, {
    thread: 'posted', channelId: 'C1', team: 'helix', person: 2, minute: 1,
  });
  await say(DB, {
    thread: 'same-channel', channelId: 'C1', team: 'helix', minute: 2,
  });
  await say(DB, {
    thread: 'alert', channelId: 'C1', team: 'helix', minute: 3, kind: 'alert',
  });
  const m = await say(DB, {
    thread: 'mentioned', channelId: 'C2', team: 'other', person: 1, minute: 4,
  });
  await recordMentions(DB, { thread: 'mentioned', message: m, at: at(4) }, [{ person: 2, via: 'id' }]);
  await say(DB, {
    thread: 'elsewhere', channelId: 'C3', team: 'helix', person: 1, minute: 5,
  });
}
const call = (env, path, me, init) => {
  const url = new URL(`https://opspile.test${path}`);
  return api(new Request(url, init), env, url, { viewer: me });
};

describe('no-team mode', () => {
  it('lets someone on no team in only from SIGNIN_DOMAINS', async () => {
    const DB = fresh();
    assert.equal(await personByEmail({ DB, STAFF_DOMAINS: 'staff.example' }, 'solo@staff.example'), null);
    assert.equal(await personById({ DB, STAFF_DOMAINS: 'staff.example' }, 2), null);
    const solo = await personByEmail({ ...OPEN, DB }, 'solo@staff.example');
    assert.deepEqual([solo.id, solo.teams, solo.admin], [2, [], false]);
    assert.equal((await personById({ ...OPEN, DB }, 2)).id, 2);
    // Team members, as before.
    assert.equal((await personByEmail({ DB, STAFF_DOMAINS: 'staff.example' }, 'a@staff.example')).id, 1);
    assert.equal(await personByEmail({ ...OPEN, DB }, 'x@customer.example'), null);
  });

  it('makes a person of someone signing in for the first time, named as their accounts are', async () => {
    const DB = fresh();
    DB.sqlite.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, email, fetched_at)
      VALUES ('slack', 'E1', 'U9', 'person', 'New Person', 'new@staff.example', '')`).run();
    const me = await personByEmail({ ...OPEN, DB }, 'new@staff.example');
    assert.deepEqual([me.name, me.email, me.teams], ['New Person', 'new@staff.example', []]);
    assert.deepEqual(DB.rows('SELECT staff FROM people WHERE email = ?', 'new@staff.example'), [{ staff: 1 }]);
    // Once only.
    assert.equal((await personByEmail({ ...OPEN, DB }, 'new@staff.example')).id, me.id);
    assert.equal(DB.rows('SELECT COUNT(*) AS n FROM people')[0].n, 3);
  });

  it('has the threads of any team\'s channels they posted or were mentioned in', async () => {
    const DB = fresh();
    await channels(DB);
    const res = await inbox({ DB }, SOLO, null, { personal: true });
    assert.deepEqual(res.threads.map((t) => t.thread).sort(), ['mentioned', 'posted', 'same-channel']);
    const mentioned = res.threads.find((t) => t.thread === 'mentioned');
    assert.deepEqual([mentioned.mentionedMe, mentioned.unreadMentions], [true, 1]);
    // Their own read state.
    await advanceWatermark(DB, 2, 'mentioned', at(4), 'open');
    const again = (await inbox({ DB }, SOLO, null, { personal: true })).threads
      .find((t) => t.thread === 'mentioned');
    assert.deepEqual([again.unread, again.mentionedMe], [false, false]);
    // No team inbox.
    assert.equal((await call({ DB }, '/api/inbox?team=helix', SOLO)).status, 403);
  });

  it('opens, drafts and reads only the threads of those channels', async () => {
    const DB = fresh();
    await channels(DB);
    const CHANNELS = { list: async () => ({ objects: [] }), get: async () => null };
    const open = (t) => call({ DB, CHANNELS }, `/api/thread?thread=${t}`, SOLO);
    assert.equal((await open('same-channel')).status, 200);
    assert.equal((await open('mentioned')).status, 200);
    assert.equal((await open('elsewhere')).status, 404);
    const draft = (thread) => call({ DB }, '/api/draft', SOLO, {
      method: 'PUT', body: JSON.stringify({ thread, text: 'hi', base: null }),
    });
    assert.equal((await draft('posted')).status, 200);
    assert.equal((await draft('elsewhere')).status, 404);
    const reads = [];
    const ROOMS = {
      idFromName: (name) => name,
      get: (name) => ({
        fetch: async (u, init) => {
          reads.push([name, JSON.parse(init.body)]);
          return new Response(null);
        },
      }),
    };
    const read = (thread) => call({ DB, ROOMS }, '/api/read', SOLO, {
      method: 'POST', body: JSON.stringify({ thread, at: at(9) }),
    });
    assert.equal((await read('mentioned')).status, 204);
    assert.equal((await read('elsewhere')).status, 404);
    assert.deepEqual(reads, [['other', { person: 2, thread: 'mentioned', at: at(9) }]]);
  });

  it('listens to their teams\' rooms, and to those of the teams their channels are filed under', async () => {
    const DB = fresh();
    await channels(DB);
    const me = await (await call({ DB }, '/api/me', SOLO)).json();
    assert.deepEqual(me.rooms, ['helix', 'other']);
    // A posted in C2 (other) and C3 (helix): their own team first, then the other one.
    const A = {
      id: 1, email: 'a@staff.example', name: 'A', teams: [{ slug: 'helix', name: 'Helix' }],
    };
    const member = await (await call({ DB }, '/api/me', A)).json();
    assert.deepEqual(member.rooms, ['helix', 'other']);
    const connected = [];
    const ROOMS = {
      idFromName: (name) => name,
      get: (name) => ({
        fetch: async (r) => {
          connected.push([name, r.headers.get('x-opspile-scoped')]);
          return new Response('ok');
        },
      }),
    };
    const live = (team, who = SOLO) => call({ DB, ROOMS }, `/api/live?team=${team}`, who, { headers: { upgrade: 'websocket' } });
    assert.equal((await live('other')).status, 200);
    assert.equal((await live('nobody')).status, 400);
    assert.equal((await live('helix', A)).status, 200);
    assert.equal((await live('other', A)).status, 200);
    // In a room not of their team they hear only about their channels (src/room.js).
    assert.deepEqual(connected, [['other', '1'], ['helix', '0'], ['other', '1']]);
  });

  it('tells someone in a room not of their team only about the channels of their personal view', async () => {
    const DB = fresh();
    await channels(DB);
    await say(DB, {
      thread: 'unrelated', channelId: 'C9', team: 'helix', person: 1, minute: 6,
    });
    const sockets = [{ person: 1, scoped: false }, { person: 2, scoped: true }];
    const to = async (event) => (await recipients({ DB }, event, sockets)).map((x) => x.person);
    assert.deepEqual(await to({ type: 'thread', thread: 'same-channel' }), [1, 2]);
    assert.deepEqual(await to({
      type: 'thread', thread: 'unrelated', mentions: [1], author: 'A',
    }), [1]);
    assert.deepEqual(await to({
      type: 'read', person: 1, thread: 'elsewhere', at: at(9),
    }), [1]);
    assert.deepEqual(await to({ type: 'draft', thread: 'mentioned' }), [1, 2]);
    // Nothing about a thread in particular: the team only.
    assert.deepEqual(await to({ type: 'other' }), [1]);
    // Only team members in the room: nothing asked.
    assert.deepEqual((await recipients({}, { thread: 'x' }, [sockets[0]])).length, 1);
  });

  it('lets team members work the threads of other teams\' channels they are in', async () => {
    const DB = fresh();
    await channels(DB);
    const CHANNELS = { list: async () => ({ objects: [] }), get: async () => null };
    const B = {
      id: 3, email: 'b@staff.example', name: 'B', teams: [{ slug: 'helix', name: 'Helix' }],
    };
    DB.sqlite.prepare("INSERT INTO people (id, email, name, staff) VALUES (3, 'b@staff.example', 'B', 1)").run();
    DB.sqlite.prepare("INSERT INTO team_members (team, person) VALUES ('helix', 3)").run();
    const open = (t, who) => call({ DB, CHANNELS }, `/api/thread?thread=${t}`, who);
    // B is on helix only and never was in C2 (other): not theirs.
    assert.equal((await open('mentioned', B)).status, 404);
    await say(DB, {
      thread: 'mentioned', channelId: 'C2', team: 'other', person: 3, minute: 7,
    });
    assert.equal((await open('mentioned', B)).status, 200);
    const personal = await inbox({ DB }, B, null, { personal: true });
    assert.ok(personal.threads.some((t) => t.thread === 'mentioned'));
  });

  it('lists their personal view over MCP, and says there is no team to pick', async () => {
    const DB = fresh();
    await channels(DB);
    const list = TOOLS.find((t) => t.name === 'list_threads');
    const { data } = await list.run({ DB }, SOLO, {});
    assert.deepEqual(data.threads.map((t) => t.thread).sort(), ['mentioned', 'posted', 'same-channel']);
    const { error } = await list.run({ DB }, SOLO, { team: 'helix' });
    assert.match(error, /no ops team/);
  });

  it('opens the Access policy to the sign-in domains, once, and leaves other includes alone', () => {
    const policy = {
      name: 'members',
      decision: 'allow',
      include: [{ email: { email: 'a@staff.example' } }, { email_domain: { domain: 'kept.example' } }],
    };
    const first = withEmails(policy, ['a@staff.example'], ['staff.example']);
    assert.deepEqual(first.domainsAdded, ['staff.example']);
    assert.deepEqual(first.body.include, [
      { email_domain: { domain: 'kept.example' } },
      { email_domain: { domain: 'staff.example' } },
      { email: { email: 'a@staff.example' } },
    ]);
    const again = withEmails(first.body, ['a@staff.example'], ['staff.example']);
    assert.deepEqual([again.added, again.removed, again.domainsAdded], [[], [], []]);
    // Without sign-in domains nothing is taken off.
    assert.deepEqual(withEmails(first.body, ['a@staff.example']).body.include, first.body.include);
  });
});
