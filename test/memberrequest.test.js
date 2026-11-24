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
import { opspileExtension } from '../src/agent/tools.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up people, channels and slugs only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
};
const CY = {
  id: 3, email: 'cy@staff.example', name: 'Cy', staff: 1, teams: ['edge'],
};
const DEE = {
  id: 4, email: 'dee@staff.example', name: 'Dee Lee', staff: 1, teams: ['helix'],
};
const KEY = 'slack:E1:C1:1.1';
const TARGET = {
  key: KEY, team: 'helix', org: 'acme', kind: 'channel', source: 'slack', tenant: 'E1', channelId: 'C1', channelName: 'shop-acme', threads: [KEY],
};

function env() {
  const DB = d1({
    people: [ADA, BO, CY, DEE],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }, { slug: 'edge', name: 'Edge ops' }],
  });
  DB.sqlite.exec(`UPDATE team_members SET role = 'manager' WHERE person IN (2, 3);
    INSERT INTO sidebar_messages (id, thread, role, person, body, at)
      VALUES ('sb_1', '${KEY}', 'person', 4, 'add me to edge, please', '2026-10-22T01:00:00Z')`);
  return { DB, STAFF_DOMAINS: 'staff.example' };
}

/** The agent's channel tools, answering sidebar message `sidebar` (null: a turn on messages). */
function agentTools(e, sidebar = null) {
  const tools = Object.fromEntries(opspileExtension({
    env: e,
    hasThread: true,
    target: async () => TARGET,
    verdicts: async () => new Map(),
    sidebarMessage: async () => sidebar,
  }).tools.map((t) => [t.name, t]));
  return async (name, args = {}) => {
    const res = await tools[name].execute(args, {});
    return { text: res.output.map((o) => o.text).join(''), error: Boolean(res.isError) };
  };
}

async function as(person, e, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const role = (slug) => (e.DB.rows('SELECT role FROM team_members WHERE team = ? AND person = ?', slug, person.id)[0] || {}).role;
  const viewer = { ...person, teams: person.teams.map((slug) => ({ slug, role: role(slug) })) };
  const res = await api(request, e, url, { viewer });
  return { status: res.status, body: await res.json() };
}

const members = (e, slug) => e.DB.rows(`SELECT p.email FROM team_members m JOIN people p ON p.id = m.person
  WHERE m.team = ? ORDER BY p.email`, slug).map((r) => r.email);

describe('agent: request_team_membership', () => {
  it('is refused outside the sidebar, where customers write', async () => {
    const e = env();
    const res = await agentTools(e)('request_team_membership', { team: 'edge', note: 'x' });
    assert.equal(res.error, true);
    assert.match(res.text, /^Only a person on the team can ask for this, in the sidebar/);
    // A sidebar message of another thread is not this one's.
    const other = await agentTools(e, 'sb_2')('request_team_membership', { team: 'edge', note: 'x' });
    assert.equal(other.error, true);
    assert.equal(e.DB.rows('SELECT * FROM member_requests').length, 0);
  });

  it('asks for the person who asked, and once at a time', async () => {
    const e = env();
    const run = agentTools(e, 'sb_1');
    const res = await quiet(() => run('request_team_membership', { team: 'edge', note: 'Works on edge now' }));
    assert.deepEqual(res, {
      text: 'requested (membership request 1) for Dee Lee: add Dee Lee (themselves) to edge. An admin or one of edge\'s managers confirms or declines it, under Requests in the admin pages or on the team\'s page; nobody was added yet. Tell Dee Lee so.',
      error: false,
    });
    const [row] = e.DB.rows('SELECT team, email, note, thread, requested_by, status FROM member_requests');
    assert.deepEqual({ ...row }, {
      team: 'edge', email: 'dee@staff.example', note: 'Works on edge now', thread: KEY, requested_by: 'dee@staff.example', status: 'open',
    });
    assert.match((await run('request_team_membership', { team: 'edge', note: 'again' })).text, /^Nothing was requested: dee@staff\.example is requested for edge already \(request 1, by Dee Lee\)\.$/);
    assert.match((await run('request_team_membership', { team: 'helix', note: 'x' })).text, /dee@staff\.example is on helix already/);
    assert.match((await run('request_team_membership', { team: 'nope', note: 'x' })).text, /no such team/);
  });

  it('asks for someone else, by address or by the name the inbox knows', async () => {
    const e = env();
    const run = agentTools(e, 'sb_1');
    const byMail = await quiet(() => run('request_team_membership', { team: 'edge', email: 'New.Person@staff.example', note: 'joins' }));
    assert.match(byMail.text, /add new\.person@staff\.example to edge\./);
    const byName = await quiet(() => run('request_team_membership', { team: 'edge', name: 'bo', note: 'helps' }));
    assert.match(byName.text, /add Bo <bo@staff\.example> to edge\./);
    assert.match((await run('request_team_membership', { team: 'edge', name: 'Nobody Known', note: 'x' })).text, /knows nobody called Nobody Known/);
    // Team members are staff: no outside address gets on a team.
    assert.match((await run('request_team_membership', { team: 'edge', email: 'eve@customer.example', note: 'x' })).text, /not a staff address/);
    assert.deepEqual(e.DB.rows('SELECT email FROM member_requests ORDER BY id').map((r) => r.email), ['new.person@staff.example', 'bo@staff.example']);
  });
});

describe('membership requests: deciding them', () => {
  it('the team\'s manager confirms one, which adds the person', async () => {
    const e = env();
    await quiet(() => agentTools(e, 'sb_1')('request_team_membership', { team: 'edge', note: 'Works on edge now' }));
    // Listed for the team's managers and the admin team, counted as open; not for other managers.
    const mine = await as(CY, e, 'GET', '/api/admin/requests');
    assert.deepEqual([mine.body.memberRequests.length, mine.body.open], [1, 1]);
    assert.deepEqual(mine.body.memberRequests[0].person, {
      id: 4, email: 'dee@staff.example', name: 'Dee Lee', teams: ['helix'], member: false,
    });
    assert.equal((await as(BO, e, 'GET', '/api/admin/requests')).body.memberRequests.length, 0);
    assert.equal((await as(ADA, e, 'GET', '/api/admin/team?slug=edge')).body.memberRequests.length, 1);
    // Another team's manager may not decide it.
    const refused = await as(BO, e, 'POST', '/api/admin/member-requests/confirm', { id: 1 });
    assert.equal(refused.status, 403);
    const done = await quiet(() => as(CY, e, 'POST', '/api/admin/member-requests/confirm', { id: 1 }));
    assert.deepEqual([done.status, done.body.request.status, done.body.request.outcome, done.body.person.role], [200, 'confirmed', 'added', 'member']);
    assert.deepEqual(done.body.request.decidedBy, { email: 'cy@staff.example', name: 'Cy' });
    assert.deepEqual(members(e, 'edge'), ['cy@staff.example', 'dee@staff.example']);
    // Decided once.
    assert.equal((await as(ADA, e, 'POST', '/api/admin/member-requests/decline', { id: 1 })).status, 409);
  });

  it('an admin declines one, with a reason', async () => {
    const e = env();
    await quiet(() => agentTools(e, 'sb_1')('request_team_membership', { team: 'edge', note: 'x' }));
    const res = await quiet(() => as(ADA, e, 'POST', '/api/admin/member-requests/decline', { id: 1, reason: 'not this quarter' }));
    assert.deepEqual([res.status, res.body.request.status, res.body.request.reason], [200, 'declined', 'not this quarter']);
    assert.deepEqual(members(e, 'edge'), ['cy@staff.example']);
    // Declined, it may be asked again.
    const again = await quiet(() => agentTools(e, 'sb_1')('request_team_membership', { team: 'edge', note: 'y' }));
    assert.equal(again.error, false);
  });

  it('adding the person on the team\'s page answers the open request', async () => {
    const e = env();
    await quiet(() => agentTools(e, 'sb_1')('request_team_membership', { team: 'edge', note: 'x' }));
    const added = await quiet(() => as(CY, e, 'POST', '/api/admin/members', { team: 'edge', email: 'Dee@staff.example' }));
    assert.equal(added.status, 200);
    const [row] = e.DB.rows('SELECT status, outcome, decided_by FROM member_requests');
    assert.deepEqual({ ...row }, { status: 'confirmed', outcome: 'member', decided_by: 'cy@staff.example' });
  });
});
