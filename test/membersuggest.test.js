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
import { api } from '../src/api.js';
import {
  focused, MIN_TOPIC_SHARE, scores, teamTopics,
} from '../src/membersuggest.js';
import { indexTopicMap } from '../src/topicindex.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up people, channels, teams and topics only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['edge'],
};
// Works Edge ops' threads, mostly.
const CY = {
  id: 3, email: 'cy@staff.example', name: 'Cy', staff: 1, teams: ['forms'],
};
// Posts everywhere, once in Edge ops'.
const DEE = {
  id: 4, email: 'dee@staff.example', name: 'Dee', staff: 1, teams: [],
};
// A customer in Edge ops' channels: never suggested.
const ZED = {
  id: 5, email: 'zed@customer.example', name: 'Zed', staff: 0, teams: [],
};
// Works Edge ops' topic, elsewhere.
const FAY = {
  id: 6, email: 'fay@staff.example', name: 'Fay', staff: 1, teams: [],
};
const asMe = (p, roles = {}) => ({ ...p, teams: p.teams.map((t) => ({ slug: t, role: roles[t] || 'member' })) });
const BOSS = asMe(BO, { edge: 'manager' });
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

function env() {
  const DB = d1({
    people: [ADA, BO, CY, DEE, ZED, FAY],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'edge', name: 'Edge ops' }, { slug: 'forms', name: 'Forms ops' }],
  });
  const db = DB.sqlite;
  const channel = (id, team, threads) => {
    db.prepare(`INSERT INTO channels (source, tenant, channel_id, name, members_at, fetched_at)
      VALUES ('slack', 'X1', ?, ?, ?, ?)`).run(id, `c-${id}`, ago(1), ago(1));
    for (let n = 0; n < threads; n += 1) {
      db.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind,
          channel_name, path, root_at, last_at, any_at, messages, updated_at)
        VALUES (?, 'slack', 'X1', ?, ?, 'acme', ?, 'channel', ?, ?, ?, ?, ?, 1, ?)`)
        .run(`slack:X1:${id}:r${n}`, id, `r${n}`, team, `c-${id}`, `channels/acme/${team}/slack-${id}/r${n}/`, ago(3), ago(2), ago(2), ago(2));
    }
  };
  let seq = 0;
  const post = (id, n, person, staff = 1) => {
    seq += 1;
    db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person, staff, counted, author_key)
      VALUES ('slack', 'X1', ?, ?, ?, ?, ?, ?, 1, ?)`).run(id, `m${seq}`, `slack:X1:${id}:r${n}`, ago(2), person, staff, `slack:X1:U${person}`);
  };
  const member = (id, user, email) => db.prepare(`INSERT INTO channel_members (source, tenant, channel_id, user_id, email, name)
    VALUES ('slack', 'X1', ?, ?, ?, ?)`).run(id, user, email, user);
  channel('E1', 'edge', 3);
  channel('E2', 'edge', 2);
  // Forms ops' channel, shared with Edge ops: its threads are Edge ops' too.
  channel('F1', 'forms', 2);
  db.prepare('INSERT INTO channel_teams (source, channel_id, team, added_at) VALUES (\'slack\', \'F1\', \'edge\', ?)').run(ago(5));
  channel('O1', 'admin', 12);
  // Cy: four of Edge ops' threads and the shared one, nothing else.
  [['E1', 0], ['E1', 1], ['E1', 2], ['E2', 0], ['F1', 0]].forEach(([id, n]) => post(id, n, CY.id));
  // Dee: one of Edge ops', and twelve others.
  post('E1', 0, DEE.id);
  for (let n = 0; n < 12; n += 1) {
    post('O1', n, DEE.id);
  }
  // Bo is on the team; Zed is a customer.
  post('E1', 0, BO.id);
  post('E2', 1, ZED.id, 0);
  // Dee reacts too; an account nobody added, only a member of Edge ops' channels (Slack, by
  // its identity's address), and a bot there.
  db.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, email, person, fetched_at)
    VALUES ('slack', 'X1', 'U4', 'person', 'Dee', ?, 4, ?), ('slack', 'X1', 'UEVE', 'person', 'Eve', 'eve@staff.example', NULL, ?),
      ('slack', 'X1', 'UBOT', 'bot', 'Botty', 'bot@staff.example', NULL, ?)`).run(DEE.email, ago(1), ago(1), ago(1));
  db.prepare('INSERT INTO reactions (message, thread, emoji, user_key, at) VALUES (?, ?, \'+1\', \'slack:X1:U4\', ?)')
    .run('slack:X1:E2:r1', 'slack:X1:E2:r1', ago(2));
  member('E1', 'UEVE', null);
  member('E2', 'UEVE', null);
  member('E1', 'UBOT', null);
  member('E1', 'UZED', ZED.email);
  member('E1', 'UBO', BO.email);
  // The topic map: a topic that is mostly Edge ops', which Fay worked elsewhere; and a topic
  // Edge ops has one thread of, which Dee worked.
  const map = {
    built_at: ago(1),
    topics: [{ id: 0, label: 'Cache purges', size: 5 }, { id: 1, label: 'Everything else', size: 20 }],
    threads: [
      { key: 'slack:X1:E1:r0', topic: 0, staff: { 3: 1 } },
      { key: 'slack:X1:E1:r1', topic: 0, staff: {} },
      { key: 'slack:X1:E2:r0', topic: 0, staff: {} },
      {
        key: 'slack:X1:O1:r0', topic: 0, last: ago(3), staff: { 6: 1 },
      },
      {
        key: 'slack:X1:O1:r1', topic: 0, last: ago(3), staff: { 6: 1 },
      },
      { key: 'slack:X1:E2:r1', topic: 1, staff: {} },
      {
        key: 'slack:X1:O1:r2', topic: 1, last: ago(3), staff: { 4: 1 },
      },
    ],
  };
  db.prepare('INSERT INTO topic_maps (built_at, built_by, threads, k, map) VALUES (?, \'cron\', 7, 2, ?)')
    .run(map.built_at, JSON.stringify(map));
  return { DB, STAFF_DOMAINS: 'staff.example' };
}

async function call(e, me, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await quiet(() => api(request, e, url, { viewer: me }));
  return { status: res.status, body: await res.json() };
}

const suggested = async (e, me = BOSS) => (await call(e, me, 'GET', '/api/admin/member-suggestions?team=edge')).body;

describe('suggested members', () => {
  it('weighs a signal by the log of it and by how much of it is here', () => {
    assert.equal(focused(0, 10), 0);
    assert.equal(focused(1, 1), 1);
    assert.equal(focused(0.5, 0.5), 0.5);
    // Four of four beats four of a hundred, and more threads of all of them beat fewer.
    assert.ok(focused(4, 4) > focused(4, 100));
    assert.ok(focused(4, 4) > focused(2, 2));
    // `all` below `n` (a reaction counted here only) is `n`.
    assert.equal(focused(2, 1), focused(2, 2));
    const two = [{ worked: 2, member: 1, topic: 0 }, { worked: 1, member: 0, topic: 4 }];
    assert.deepEqual(scores(two), [1.5, 1]);
  });

  it('finds the team\'s topics in the topic map', () => {
    const index = indexTopicMap({
      id: 1,
      map: {
        topics: [{ id: 0, label: 'A', size: 4 }, { id: 1, label: 'B', size: 100 }, { id: 2, label: 'C', size: 2 }],
        threads: [{ key: 'a', topic: 0 }, { key: 'b', topic: 0 }, { key: 'c', topic: 1 }, { key: 'd', topic: 1 }, { key: 'e', topic: 2 }],
      },
    });
    // B is too little the team's, C has one of its threads only.
    assert.deepEqual(teamTopics(index, ['a', 'b', 'c', 'd', 'e']).map((t) => [t.label, t.here, t.share]), [['A', 2, 0.5]]);
    assert.ok(MIN_TOPIC_SHARE > 2 / 100);
    assert.deepEqual(teamTopics(null, ['a']), []);
  });

  it('suggests who works the team\'s threads, channels and topics, to its managers', async () => {
    const e = env();
    const r = await suggested(e);
    const by = new Map(r.suggestions.map((p) => [p.email, p]));
    // Cy first; never the team's members, customers or bots.
    assert.equal(r.suggestions[0].email, CY.email);
    assert.deepEqual([...by.keys()].sort(), [CY.email, DEE.email, 'eve@staff.example', FAY.email].sort());
    assert.deepEqual({
      posted: by.get(CY.email).posted,
      teams: by.get(CY.email).teams,
      topics: by.get(CY.email).topics,
    }, { posted: 5, teams: ['forms'], topics: [{ label: 'Cache purges', threads: 1 }] });
    // Dee works everywhere: below Cy. Eve is only in the channels, Fay only in the topic.
    assert.ok(by.get(DEE.email).score < by.get(CY.email).score);
    assert.deepEqual([by.get(DEE.email).posted, by.get(DEE.email).reacted], [1, 1]);
    assert.deepEqual([by.get('eve@staff.example').channels, by.get('eve@staff.example').id], [2, null]);
    assert.deepEqual(by.get(FAY.email).topics, [{ label: 'Cache purges', threads: 2 }]);
    assert.deepEqual(r.coverage, {
      channels: 3, membersListed: 3, topics: ['Cache purges'], topicMap: true,
    });

    // Only the team's managers and the admin team; not for the admin team itself.
    assert.equal((await call(e, asMe(CY), 'GET', '/api/admin/member-suggestions?team=edge')).status, 403);
    assert.equal((await call(e, BOSS, 'GET', '/api/admin/member-suggestions?team=forms')).status, 403);
    assert.equal((await call(e, asMe(ADA), 'GET', '/api/admin/member-suggestions?team=edge')).status, 200);
    assert.equal((await call(e, asMe(ADA), 'GET', '/api/admin/member-suggestions?team=admin')).status, 400);
    assert.equal((await call(e, asMe(ADA), 'GET', '/api/admin/member-suggestions?team=nope')).status, 404);
  });

  it('leaves out who joins, is dismissed or is taken off the team', async () => {
    const e = env();
    // Added with one click, as on the page: a member, not suggested any more.
    let r = await call(e, BOSS, 'POST', '/api/admin/members', { team: 'edge', email: 'eve@staff.example' });
    assert.equal(r.status, 200);
    assert.equal(r.body.person.name, 'Eve');
    assert.equal((await suggested(e)).suggestions.some((p) => p.email === 'eve@staff.example'), false);

    // Dismissed, and suggested again.
    r = await call(e, BOSS, 'POST', '/api/admin/member-suggestions/dismiss', { team: 'edge', email: DEE.email });
    assert.equal(r.status, 200);
    let s = await suggested(e);
    assert.equal(s.suggestions.some((p) => p.email === DEE.email), false);
    assert.deepEqual(s.dismissed.map((d) => [d.email, d.name, d.why, d.by]), [[DEE.email, 'Dee', 'dismissed', BO.email]]);
    assert.equal((await call(e, BOSS, 'DELETE', '/api/admin/member-suggestions/dismiss', { team: 'edge', email: DEE.email })).status, 200);
    assert.equal((await suggested(e)).suggestions.some((p) => p.email === DEE.email), true);
    assert.equal((await call(e, BOSS, 'POST', '/api/admin/member-suggestions/dismiss', { team: 'forms', email: DEE.email })).status, 403);
    assert.equal((await call(e, BOSS, 'POST', '/api/admin/member-suggestions/dismiss', { team: 'edge', email: 'nope' })).status, 400);

    // Cy joins, then is taken off again: not suggested until someone says so.
    await call(e, BOSS, 'POST', '/api/admin/members', { team: 'edge', email: CY.email });
    r = await call(e, BOSS, 'DELETE', '/api/admin/members', { team: 'edge', person: CY.id });
    assert.equal(r.status, 200);
    s = await suggested(e);
    assert.equal(s.suggestions.some((p) => p.email === CY.email), false);
    assert.deepEqual(s.dismissed.find((d) => d.email === CY.email).why, 'removed');
    // Added back, the dismissal goes.
    await call(e, BOSS, 'POST', '/api/admin/members', { team: 'edge', email: CY.email });
    assert.equal((await suggested(e)).dismissed.some((d) => d.email === CY.email), false);
  });
});
