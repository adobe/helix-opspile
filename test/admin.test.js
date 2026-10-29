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
import { consume } from '../src/normalizer.js';
import { movedFolder } from '../src/refile.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, channels and slugs only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin', 'helix'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
};
const asMe = (p) => ({ ...p, teams: p.teams.map((slug) => ({ slug })) });
const RULES = [
  {
    id: 1, target: 'org', priority: 100, source: null, field: 'name', pattern: '^aem-(.+)$', value: '$1',
  },
  {
    id: 2, target: 'team', priority: 100, source: null, field: 'name', pattern: '^aem-', value: 'helix',
  },
];

function env() {
  const queued = [];
  const DB = d1({
    rules: RULES,
    people: [ADA, BO],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }, { slug: 'edge', name: 'Edge ops' }],
  });
  const CHANNELS = fakeBucket();
  const channel = (id, name) => {
    DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
      VALUES ('slack', 'E1', ?, ?, '2026-10-22T00:00:00Z')`).run(id, name);
  };
  const thread = (id, root, org, team, files = 2) => {
    const path = `channels/${org}/${team}/slack-${id}/${root}/`;
    DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, channel_name, path, root_at, last_at, any_at, messages, updated_at)
      VALUES (?, 'slack', 'E1', ?, ?, ?, ?, 'channel', ?, ?, '2026-10-22T00:00:00Z',
        '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z', ?, '2026-10-22T00:00:00Z')`)
      .run(`slack:E1:${id}:${root}`, id, root, org, team, `aem-${org}`, path, files);
    for (let i = 0; i < files; i += 1) {
      CHANNELS.objects.set(`${path}${root}.${i}.md`, { body: `---\nid: "${i}"\n---\nmessage ${i}`, options: {} });
    }
  };
  channel('C1', 'aem-acme');
  channel('C2', 'aem-globex');
  channel('C3', 'random');
  thread('C1', '1.1', 'acme', 'helix');
  thread('C1', '2.1', 'acme', 'helix', 3);
  thread('C2', '3.1', 'globex', 'helix');
  thread('C3', '4.1', '_unassigned', '_unassigned', 1);
  return {
    queued, DB, CHANNELS, NORMALIZE: { send: async (body) => queued.push(body) },
  };
}

async function call(e, me, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await api(request, e, url, { viewer: asMe(me) });
  return { status: res.status, body: await res.json() };
}

/** Runs the queued refile jobs, as the queue consumer would. */
async function drain(e) {
  while (e.queued.length) {
    const messages = e.queued.splice(0).map((body) => ({ body, ack() {}, retry() {} }));
    // eslint-disable-next-line no-await-in-loop
    await quiet(() => consume({ messages }, e));
  }
}

describe('admin: teams and members', () => {
  it('is for the admin team only, and read-only while viewing as someone else', async () => {
    const e = env();
    assert.equal((await call(e, BO, 'GET', '/api/admin/teams')).status, 403);
    assert.equal((await call(e, { ...ADA, readonly: true }, 'POST', '/api/admin/teams', { slug: 'x', name: 'X' })).status, 403);
  });

  it('creates, renames and deletes teams, and adds and removes members', async () => {
    const e = env();
    let r = await call(e, ADA, 'GET', '/api/admin/teams');
    assert.deepEqual(r.body.teams.map((t) => [t.slug, t.members, t.channels, t.threads]), [
      ['admin', 1, 0, 0], ['edge', 0, 0, 0], ['helix', 2, 2, 3],
    ]);
    assert.deepEqual(r.body.unassigned, { channels: 1, threads: 1 });
    assert.equal((await call(e, ADA, 'POST', '/api/admin/teams', { slug: 'Bad Slug', name: 'x' })).status, 400);
    assert.equal((await call(e, ADA, 'POST', '/api/admin/teams', { slug: 'helix', name: 'Again' })).status, 409);
    r = await call(e, ADA, 'POST', '/api/admin/teams', { slug: 'search', name: 'Search ops' });
    assert.equal(r.status, 200);
    assert.equal((await call(e, ADA, 'PUT', '/api/admin/teams', { slug: 'search', name: 'Search' })).status, 200);

    // Finding people to add: people in D1 and platform accounts not linked yet, staff first,
    // without the team's members.
    e.DB.sqlite.exec(`INSERT INTO identities (source, tenant, user_id, kind, name, email, fetched_at) VALUES
      ('slack', 'E1', 'U9', 'person', 'Cy Platform', 'cy@staff.example', '2026-10-22T00:00:00Z'),
      ('slack', 'E1', 'U8', 'person', 'Cyd Customer', 'cyd@customer.example', '2026-10-22T00:00:00Z')`);
    e.STAFF_DOMAINS = 'staff.example';
    r = await call(e, ADA, 'GET', '/api/admin/people?team=search&q=cy');
    assert.deepEqual(r.body.people.map((p) => [p.name, p.id, p.staff]), [['Cy Platform', null, true], ['Cyd Customer', null, false]]);
    r = await call(e, ADA, 'GET', '/api/admin/people?team=helix&q=staff.example');
    assert.deepEqual(r.body.people.map((p) => p.email), ['cy@staff.example']);
    assert.deepEqual((await call(e, ADA, 'GET', '/api/admin/people?q=c')).body.people, []);

    // Added: a person, staff, named after their account, linked to it.
    r = await call(e, ADA, 'POST', '/api/admin/members', { team: 'search', email: 'Cy@Staff.example' });
    assert.equal(r.status, 200);
    const cy = r.body.person;
    assert.deepEqual([cy.email, cy.name, cy.staff], ['cy@staff.example', 'Cy Platform', 1]);
    assert.deepEqual(e.DB.rows("SELECT person FROM identities WHERE user_id = 'U9'"), [{ person: cy.id }]);
    r = await call(e, ADA, 'GET', '/api/admin/team?slug=search');
    assert.deepEqual(r.body.members.map((m) => m.name), ['Cy Platform']);
    r = await call(e, ADA, 'GET', '/api/admin/people?team=search&q=cy');
    assert.deepEqual(r.body.people.map((p) => p.name), ['Cyd Customer']);
    // Names are not edited here: PUT members sets a role, and nothing else.
    assert.equal((await call(e, ADA, 'PUT', '/api/admin/members', { team: 'search', person: cy.id, name: 'Cyril' })).status, 400);
    assert.equal((await call(e, ADA, 'DELETE', '/api/admin/members', { team: 'search', person: cy.id })).status, 200);

    // The admin team keeps a member; a team with threads or rules stays.
    assert.match((await call(e, ADA, 'DELETE', '/api/admin/members', { team: 'admin', person: 1 })).body.error, /at least one/);
    assert.match((await call(e, ADA, 'DELETE', '/api/admin/teams', { slug: 'helix' })).body.error, /1 rule\(s\) and 3 thread\(s\)/);
    assert.equal((await call(e, ADA, 'DELETE', '/api/admin/teams', { slug: 'admin' })).status, 400);
    assert.equal((await call(e, ADA, 'DELETE', '/api/admin/teams', { slug: 'search' })).status, 200);
  });
});

describe('admin: team managers', () => {
  // Bo manages helix; Cy is a member of edge only.
  const CY = {
    id: 3, email: 'cy@staff.example', name: 'Cy', staff: 1, teams: ['edge'],
  };
  const managers = () => {
    const e = env();
    e.DB.sqlite.exec(`INSERT INTO people (id, email, name, staff) VALUES (3, 'cy@staff.example', 'Cy', 1);
      INSERT INTO team_members (team, person) VALUES ('edge', 3);
      UPDATE team_members SET role = 'manager' WHERE team = 'helix' AND person = 2`);
    return e;
  };
  const bo = { ...BO, manages: ['helix'] };
  const asBo = (p) => ({ ...asMe(p), teams: [{ slug: 'helix', role: 'manager' }] });

  async function as(e, who, method, path, body) {
    const url = new URL(`https://opspile.example${path}`);
    const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    const res = await api(request, e, url, { viewer: who });
    return { status: res.status, body: await res.json() };
  }

  it('manage the members of their teams, and nothing else', async () => {
    const e = managers();
    const me = asBo(bo);
    let r = await as(e, me, 'GET', '/api/admin/teams');
    assert.deepEqual([r.body.teams.map((t) => t.slug), r.body.admin, r.body.unassigned], [['helix'], false, null]);
    r = await as(e, me, 'GET', '/api/admin/team?slug=helix');
    assert.deepEqual(r.body.members.map((m) => [m.name, m.role]), [['Ada', 'member'], ['Bo', 'manager']]);
    assert.equal((await as(e, me, 'GET', '/api/admin/team?slug=edge')).status, 403);
    assert.equal((await as(e, me, 'GET', '/api/admin/people?team=edge&q=cy')).status, 403);
    assert.equal((await as(e, me, 'GET', '/api/admin/people?team=helix&q=cy')).body.people[0].name, 'Cy');

    // Add, promote, demote, remove in their own team.
    r = await as(e, me, 'POST', '/api/admin/members', { team: 'helix', email: 'cy@staff.example' });
    assert.equal(r.body.person.role, 'member');
    assert.equal((await as(e, me, 'PUT', '/api/admin/members', { team: 'helix', person: 3, role: 'manager' })).status, 200);
    assert.equal((await as(e, me, 'PUT', '/api/admin/members', { team: 'helix', person: 3, role: 'member' })).status, 200);
    assert.equal((await as(e, me, 'DELETE', '/api/admin/members', { team: 'helix', person: 3 })).status, 200);
    // Not in another team, and not the rest of the admin API.
    assert.equal((await as(e, me, 'POST', '/api/admin/members', { team: 'edge', email: 'x@staff.example' })).status, 403);
    assert.equal((await as(e, me, 'DELETE', '/api/admin/members', { team: 'edge', person: 3 })).status, 403);
    for (const [method, path, body] of [
      ['PUT', '/api/admin/teams', { slug: 'helix', selfManaged: true }],
      ['POST', '/api/admin/teams', { slug: 'x', name: 'X' }],
      ['POST', '/api/admin/rules', {
        target: 'team', field: 'name', pattern: '^x', value: 'helix',
      }],
      ['POST', '/api/admin/assign', { target: 'team', channelId: 'C3', value: 'helix' }],
      ['GET', '/api/admin/orgs'],
      ['GET', '/api/admin/org-icons?slug=acme'],
      ['GET', '/api/admin/favicon?domain=acme.example'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await as(e, me, method, path, body)).status, 403, `${method} ${path}`);
    }
    // They search every channel, to ask for one (see the requests below).
    r = await as(e, me, 'GET', '/api/admin/channels?q=random');
    assert.deepEqual(r.body.channels.map((c) => [c.channelId, c.team]), [['C3', '_unassigned']]);
    // A plain member has no admin pages at all, and sees the agents read-only.
    assert.equal((await as(e, asMe(CY), 'GET', '/api/admin/teams')).status, 403);
    assert.equal((await as(e, asMe(CY), 'GET', '/api/kb')).status, 200);
    assert.equal((await as(e, asMe(CY), 'PUT', '/api/kb/agent', { team: 'edge', enabled: true })).status, 403);
  });

  it('edit their teams\' knowledge base, and no other', async () => {
    const e = managers();
    e.ARTIFACTS = {};
    e.DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at) VALUES
      ('kb-team-helix', 'team', 'helix', 'r', 'x'), ('kb-team-edge', 'team', 'edge', 'r', 'x'),
      ('kb-org-acme', 'org', 'acme', 'r', 'x')`);
    const me = asBo(bo);
    const r = await as(e, me, 'GET', '/api/kb');
    assert.deepEqual(r.body.bases.map((b) => b.repo), ['kb-team-helix']);
    assert.equal((await as(e, me, 'GET', '/api/kb/files?repo=kb-team-edge')).status, 404);
    assert.equal((await as(e, me, 'GET', '/api/kb/files?repo=kb-org-acme')).status, 404);
    assert.equal((await as(e, asMe(ADA), 'GET', '/api/kb')).body.bases.length, 3);
    // A member of edge reads edge's, and changes none.
    const cy = await as(e, asMe(CY), 'GET', '/api/kb');
    assert.deepEqual(cy.body.bases.map((b) => [b.repo, b.may]), [['kb-team-edge', false]]);
    assert.deepEqual(r.body.bases.map((b) => b.may), [true]);
    assert.equal((await as(e, asMe(CY), 'GET', '/api/kb/files?repo=kb-team-helix')).status, 404);
    assert.equal((await as(e, asMe(CY), 'PUT', '/api/kb/file', { repo: 'kb-team-edge', path: 'a.md', content: 'x' })).status, 403);
  });

  it('are everyone in a self-managed team; turning it off keeps the roles', async () => {
    const e = managers();
    let r = await call(e, ADA, 'PUT', '/api/admin/teams', { slug: 'edge', selfManaged: true });
    assert.equal(r.body.team.self_managed, true);
    r = await call(e, ADA, 'GET', '/api/admin/team?slug=edge');
    assert.deepEqual(r.body.members.map((m) => m.role), ['manager']);
    // Newcomers are managers too, and nobody can be demoted.
    r = await call(e, ADA, 'POST', '/api/admin/members', { team: 'edge', email: 'bo@staff.example' });
    assert.equal(r.body.person.role, 'manager');
    assert.equal((await call(e, ADA, 'PUT', '/api/admin/members', { team: 'edge', person: 2, role: 'member' })).status, 409);
    // A manager of edge now sees it in the admin pages.
    const cy = { ...asMe(CY), teams: [{ slug: 'edge', role: 'manager' }] };
    assert.deepEqual((await as(e, cy, 'GET', '/api/admin/teams')).body.teams.map((t) => t.slug), ['edge']);

    // Off again: roles stay, newcomers are members, demotion works.
    await call(e, ADA, 'PUT', '/api/admin/teams', { slug: 'edge', selfManaged: false });
    r = await call(e, ADA, 'POST', '/api/admin/members', { team: 'edge', email: 'new@staff.example' });
    assert.equal(r.body.person.role, 'member');
    r = await call(e, ADA, 'GET', '/api/admin/team?slug=edge');
    assert.deepEqual(r.body.members.map((m) => [m.name, m.role]), [[null, 'member'], ['Bo', 'manager'], ['Cy', 'manager']]);
    assert.equal((await call(e, ADA, 'PUT', '/api/admin/members', { team: 'edge', person: 2, role: 'member' })).status, 200);
  });
});

describe('admin: channel assignment requests', () => {
  // Bo manages helix, Cy manages edge; Ada is in the admin team.
  const CY = {
    id: 3, email: 'cy@staff.example', name: 'Cy', staff: 1, teams: ['edge'],
  };
  const withManagers = () => {
    const e = env();
    e.DB.sqlite.exec(`INSERT INTO people (id, email, name, staff) VALUES (3, 'cy@staff.example', 'Cy', 1);
      INSERT INTO team_members (team, person, role) VALUES ('edge', 3, 'manager');
      UPDATE team_members SET role = 'manager' WHERE team = 'helix' AND person = 2`);
    return e;
  };
  const bo = { ...asMe(BO), teams: [{ slug: 'helix', role: 'manager' }] };
  const cy = { ...asMe(CY), teams: [{ slug: 'edge', role: 'manager' }] };
  async function as(e, who, method, path, body) {
    const url = new URL(`https://opspile.example${path}`);
    const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    const res = await api(request, e, url, { viewer: who });
    return { status: res.status, body: await res.json() };
  }
  const ask = (e, who, channelId, team, note) => as(e, who, 'POST', '/api/admin/requests', {
    team, source: 'slack', channelId, note,
  });

  it('are made by a team\'s managers, for their teams only, once at a time', async () => {
    const e = withManagers();
    let r = await ask(e, cy, 'C3', 'edge', 'Our customer');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.request.status, r.body.request.team, r.body.request.note], ['open', 'edge', 'Our customer']);
    assert.deepEqual([r.body.request.channel.name, r.body.request.channel.team], ['random', '_unassigned']);
    assert.equal(r.body.request.requestedBy.email, 'cy@staff.example');
    // The same one again is the open one; a channel in the team's inbox needs no request.
    r = await ask(e, cy, 'C3', 'edge');
    assert.deepEqual([r.status, r.body.request.note], [409, 'Our customer']);
    assert.equal((await ask(e, bo, 'C1', 'helix')).status, 409);
    assert.equal((await ask(e, cy, 'C9', 'edge')).status, 404);
    assert.equal((await ask(e, cy, 'C3', 'nope')).status, 403);
    // Not for a team they do not manage, and not by a plain member.
    assert.equal((await ask(e, bo, 'C3', 'edge')).status, 403);
    assert.equal((await ask(e, cy, 'C3', 'admin')).status, 403);
    assert.equal((await ask(e, asMe(BO), 'C3', 'helix')).status, 403);
    // A manager sees their teams' requests; the admin team sees all of them, and the count.
    await ask(e, bo, 'C3', 'helix');
    r = await as(e, cy, 'GET', '/api/admin/requests');
    assert.deepEqual([r.body.requests.map((x) => x.team), r.body.open], [['edge'], 1]);
    r = await as(e, cy, 'GET', '/api/admin/team?slug=edge');
    assert.deepEqual(r.body.requests.map((x) => [x.channel.channelId, x.status]), [['C3', 'open']]);
    r = await call(e, ADA, 'GET', '/api/admin/requests');
    assert.deepEqual([r.body.requests.map((x) => x.team), r.body.open], [['edge', 'helix'], 2]);
    assert.deepEqual((await call(e, ADA, 'GET', '/api/admin/requests?count=1')).body, { open: 2 });
    assert.equal((await call(e, ADA, 'GET', '/api/admin/teams')).body.requests, 2);
    assert.equal((await as(e, cy, 'GET', '/api/admin/teams')).body.requests, 1);

    // Withdrawn by a manager of its team, and only while it is open.
    const { id } = (await as(e, bo, 'GET', '/api/admin/requests')).body.requests[0];
    assert.equal((await as(e, cy, 'DELETE', '/api/admin/requests', { id, team: 'edge' })).status, 403);
    assert.equal((await as(e, cy, 'DELETE', '/api/admin/requests', { id, team: 'helix' })).status, 403);
    r = await as(e, bo, 'DELETE', '/api/admin/requests', { id, team: 'helix' });
    assert.deepEqual([r.status, r.body.request.status], [200, 'withdrawn']);
    assert.equal((await as(e, bo, 'DELETE', '/api/admin/requests', { id, team: 'helix' })).status, 409);
  });

  it('are confirmed by the admin team, with the assignment\'s dry run first, or declined', async () => {
    const e = withManagers();
    const { id } = (await ask(e, cy, 'C3', 'edge')).body.request;
    // Only the admin team decides; read-only while viewing as someone else.
    assert.equal((await as(e, cy, 'POST', '/api/admin/requests/confirm', { id })).status, 403);
    assert.equal((await as(e, cy, 'POST', '/api/admin/requests/decline', { id })).status, 403);
    assert.equal((await call(e, { ...ADA, readonly: true }, 'POST', '/api/admin/requests/confirm', { id })).status, 403);
    assert.equal((await as(e, { ...cy, readonly: true }, 'POST', '/api/admin/requests', {
      team: 'edge', source: 'slack', channelId: 'C1',
    })).status, 403);
    assert.equal((await as(e, { ...cy, readonly: true }, 'GET', '/api/admin/requests')).status, 200);

    // The dry run says what would move, and changes nothing.
    let r = await call(e, ADA, 'POST', '/api/admin/requests/confirm', { id, dryRun: true });
    assert.deepEqual(r.body.moves.map((m) => [m.channel.channelId, m.to.team]), [['C3', 'edge']]);
    assert.equal(r.body.request.status, 'open');
    assert.equal(e.DB.rows("SELECT * FROM rules WHERE field = 'channel_id'").length, 0);
    assert.equal(e.queued.length, 0);
    // Confirmed: the same manual assignment as on the team's page, and who confirmed it.
    r = await call(e, ADA, 'POST', '/api/admin/requests/confirm', { id });
    assert.deepEqual([r.status, r.body.closed, r.body.jobs], [200, true, 1]);
    const { request } = r.body;
    assert.deepEqual([request.status, request.outcome, request.decidedBy.email], [
      'confirmed', 'moved', 'ada@staff.example',
    ]);
    assert.deepEqual(e.DB.rows("SELECT value, priority, note FROM rules WHERE field = 'channel_id'"), [
      { value: 'edge', priority: 10, note: 'manual assignment' },
    ]);
    await drain(e);
    assert.deepEqual(e.DB.rows("SELECT team FROM threads WHERE channel_id = 'C3'"), [{ team: 'edge' }]);
    assert.equal((await call(e, ADA, 'POST', '/api/admin/requests/confirm', { id })).status, 409);
    assert.equal((await call(e, ADA, 'POST', '/api/admin/requests/decline', { id })).status, 409);
    assert.equal((await call(e, ADA, 'POST', '/api/admin/requests/confirm', { id: 99 })).status, 404);

    // Declined, with a reason; the manager sees it, and may ask again.
    const c1 = (await ask(e, cy, 'C1', 'edge', 'We follow it')).body.request;
    r = await call(e, ADA, 'POST', '/api/admin/requests/decline', { id: c1.id, reason: 'Not yours' });
    assert.deepEqual([r.body.request.status, r.body.request.reason], ['declined', 'Not yours']);
    r = await as(e, cy, 'GET', '/api/admin/team?slug=edge');
    const answer = (x) => [x.channel.channelId, x.status, x.outcome || x.reason];
    assert.deepEqual(r.body.requests.map(answer), [
      ['C1', 'declined', 'Not yours'], ['C3', 'confirmed', 'moved'],
    ]);
    assert.equal((await as(e, cy, 'GET', '/api/admin/requests')).body.open, 0);

    // A channel another team holds is shared, as an assignment by hand would.
    const again = (await ask(e, cy, 'C1', 'edge')).body.request;
    r = await call(e, ADA, 'POST', '/api/admin/requests/confirm', { id: again.id });
    assert.deepEqual([r.body.moves, r.body.shared.added, r.body.request.outcome], [[], true, 'shared']);
    assert.deepEqual(e.DB.rows('SELECT channel_id, team FROM channel_teams'), [{ channel_id: 'C1', team: 'edge' }]);
  });

  it('are answered when the admin team assigns the channel by hand', async () => {
    const e = withManagers();
    const { id } = (await ask(e, cy, 'C2', 'edge')).body.request;
    await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C2', source: 'slack', value: 'edge', dryRun: true,
    });
    assert.equal((await call(e, ADA, 'GET', '/api/admin/requests?count=1')).body.open, 1);
    await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C2', source: 'slack', value: 'edge',
    });
    const r = await as(e, cy, 'GET', '/api/admin/requests');
    assert.deepEqual(r.body.requests.map((x) => [x.id, x.status, x.outcome]), [[id, 'confirmed', 'shared']]);
  });
});

describe('admin: rules and re-filing', () => {
  it('moves folders and thread rows', () => {
    assert.equal(movedFolder('channels/acme/helix/slack-C1/1.1/', 'acme', 'edge'), 'channels/acme/edge/slack-C1/1.1/');
    assert.equal(movedFolder('elsewhere/x', 'a', 'b'), null);
  });

  it('tries a rule first, then files the channels it moves under their new team', async () => {
    const e = env();
    const rule = {
      target: 'team', field: 'name', pattern: '^aem-acme', value: 'edge', priority: 50,
    };
    let r = await call(e, ADA, 'POST', '/api/admin/rules', { ...rule, dryRun: true });
    assert.deepEqual(r.body.moves.map((m) => [m.channel.channelId, m.from.map((f) => f.team), m.to.team]), [['C1', ['helix'], 'edge']]);
    assert.equal(e.DB.rows('SELECT * FROM rules').length, 2);
    assert.equal(e.queued.length, 0);

    assert.equal((await call(e, ADA, 'POST', '/api/admin/rules', { ...rule, value: 'nope' })).status, 400);
    assert.equal((await call(e, ADA, 'POST', '/api/admin/rules', { ...rule, pattern: '(' })).status, 400);

    r = await call(e, ADA, 'POST', '/api/admin/rules', rule);
    assert.deepEqual([r.status, r.body.moves.length, r.body.jobs], [200, 1, 1]);
    assert.equal(r.body.rule.updated_by, 'ada@staff.example');
    // A message of the moved channel that arrived meanwhile is at the new place already.
    e.CHANNELS.objects.set('channels/acme/edge/slack-C1/1.1/1.1.0.md', { body: 'newer', options: {} });
    // The snapshot of a moved folder (src/filecache.js) goes with it.
    e.CHANNELS.objects.set('snapshots/channels/acme/helix/slack-C1/1.1.json', { body: '{}', options: {} });
    await drain(e);
    assert.deepEqual(e.DB.rows("SELECT DISTINCT team, path FROM threads WHERE channel_id = 'C1' ORDER BY path"), [
      { team: 'edge', path: 'channels/acme/edge/slack-C1/1.1/' },
      { team: 'edge', path: 'channels/acme/edge/slack-C1/2.1/' },
    ]);
    const keys = [...e.CHANNELS.objects.keys()].filter((k) => k.includes('slack-C1')).sort();
    assert.deepEqual(keys, [
      'channels/acme/edge/slack-C1/1.1/1.1.0.md', 'channels/acme/edge/slack-C1/1.1/1.1.1.md',
      'channels/acme/edge/slack-C1/2.1/2.1.0.md', 'channels/acme/edge/slack-C1/2.1/2.1.1.md',
      'channels/acme/edge/slack-C1/2.1/2.1.2.md',
    ]);
    assert.equal(e.CHANNELS.objects.get('channels/acme/edge/slack-C1/1.1/1.1.0.md').body, 'newer');

    // Deleting the rule moves the channel back.
    const { id } = r.body.rule;
    r = await call(e, ADA, 'DELETE', '/api/admin/rules', { id });
    assert.deepEqual(r.body.moves.map((m) => m.to.team), ['helix']);
    await drain(e);
    assert.deepEqual(e.DB.rows("SELECT DISTINCT team FROM threads WHERE channel_id = 'C1'"), [{ team: 'helix' }]);
  });

  it('re-files from where a thread is now, when an earlier job moved it since', async () => {
    const e = env();
    const r = await call(e, ADA, 'POST', '/api/admin/rules', {
      target: 'team', field: 'name', pattern: '^aem-acme', value: 'edge', priority: 50,
    });
    // The job as queued, with the folders the threads had then.
    const [queued] = e.queued;
    await drain(e);
    // A second change right after the first, whose job (or one queued before the first ran)
    // still names the old folders.
    await call(e, ADA, 'PUT', '/api/admin/rules', {
      id: r.body.rule.id, target: 'team', field: 'name', pattern: '^aem-acme', value: 'admin', priority: 50,
    });
    e.queued.splice(0, e.queued.length, queued);
    await drain(e);
    assert.deepEqual(e.DB.rows("SELECT DISTINCT team, path FROM threads WHERE channel_id = 'C1' ORDER BY path"), [
      { team: 'admin', path: 'channels/acme/admin/slack-C1/1.1/' },
      { team: 'admin', path: 'channels/acme/admin/slack-C1/2.1/' },
    ]);
    const keys = [...e.CHANNELS.objects.keys()].filter((k) => k.includes('slack-C1'));
    assert.equal(keys.length, 5);
    assert.ok(keys.every((k) => k.startsWith('channels/acme/admin/')), keys.join());
  });

  it('assigns one channel to a team or an org by hand, and takes it back', async () => {
    const e = env();
    let r = await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C3', source: 'slack', value: 'edge',
    });
    assert.deepEqual(r.body.moves.map((m) => [m.channel.name, m.to.team, m.to.org]), [['random', 'edge', '_unassigned']]);
    r = await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'org', channelId: 'C3', source: 'slack', value: 'Initech Corp',
    });
    assert.equal(r.body.rule.value, 'initech-corp');
    await drain(e);
    assert.deepEqual(e.DB.rows("SELECT team, org, path FROM threads WHERE channel_id = 'C3'"), [
      { team: 'edge', org: 'initech-corp', path: 'channels/initech-corp/edge/slack-C3/4.1/' },
    ]);
    // Moving it on changes the same rule (adding a team to it would share it: see below).
    r = await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C3', source: 'slack', value: 'helix', move: true,
    });
    assert.deepEqual(r.body.moves.map((m) => m.to.team), ['helix']);
    assert.equal(e.DB.rows("SELECT * FROM rules WHERE field = 'channel_id'").length, 2);
    await drain(e);
    r = await call(e, ADA, 'GET', '/api/admin/team?slug=helix');
    const c3 = r.body.channels.find((c) => c.channelId === 'C3');
    assert.equal(c3.manual.team.value, 'helix');
    r = await call(e, ADA, 'DELETE', '/api/admin/assign', { target: 'team', channelId: 'C3' });
    assert.deepEqual(r.body.moves.map((m) => m.to.team), ['_unassigned']);
    assert.equal((await call(e, ADA, 'DELETE', '/api/admin/assign', { target: 'team', channelId: 'C3' })).status, 404);
  });

  it('hands a channel a rule files under a team back to the admin team', async () => {
    const e = env();
    const r = await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C1', source: 'slack', value: 'admin',
    });
    assert.deepEqual(r.body.moves.map((m) => [m.channel.name, m.to.team, m.to.org]), [['aem-acme', 'admin', 'acme']]);
    await drain(e);
    assert.deepEqual(e.DB.rows("SELECT DISTINCT team, org FROM threads WHERE channel_id = 'C1'"), [
      { team: 'admin', org: 'acme' },
    ]);
    const helix = await call(e, ADA, 'GET', '/api/admin/team?slug=helix');
    assert.deepEqual(helix.body.channels.map((c) => c.channelId), ['C2']);
    const back = await call(e, ADA, 'GET', '/api/admin/team?slug=admin');
    assert.equal(back.body.channels.find((c) => c.channelId === 'C1').manual.team.value, 'admin');
  });
});

describe('admin: shared channels', () => {
  const C3 = 'slack:E1:C3:4.1';
  const CY = {
    id: 3, email: 'cy@staff.example', name: 'Cy', staff: 1, teams: ['edge'],
  };
  const withCy = () => {
    const e = env();
    e.DB.sqlite.exec("INSERT INTO people (id, email, name, staff) VALUES (3, 'cy@staff.example', 'Cy', 1)");
    e.DB.sqlite.exec("INSERT INTO team_members (team, person) VALUES ('edge', 3)");
    return e;
  };

  it('moves a channel for its first team, and shares it with the next', async () => {
    const e = withCy();
    // Nobody holds it: adding a team moves it there.
    let r = await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C3', source: 'slack', value: 'edge',
    });
    assert.deepEqual(r.body.moves.map((m) => m.to.team), ['edge']);
    await drain(e);
    assert.equal((await call(e, BO, 'GET', `/api/thread?thread=${C3}`)).status, 404);

    // Edge holds it: adding helix shares it, and nothing moves.
    r = await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C3', source: 'slack', value: 'helix', dryRun: true,
    });
    assert.deepEqual([r.body.moves, r.body.shared], [[], {
      source: 'slack', channelId: 'C3', team: 'helix', from: 'edge',
    }]);
    assert.deepEqual(e.DB.rows('SELECT * FROM channel_teams'), []);
    r = await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C3', source: 'slack', value: 'helix',
    });
    assert.deepEqual([r.status, r.body.moves, r.body.shared.added], [200, [], true]);
    assert.equal(e.queued.length, 0);
    assert.equal(e.DB.rows("SELECT * FROM rules WHERE field = 'channel_id'").length, 1);
    assert.deepEqual(e.DB.rows("SELECT DISTINCT team, path FROM threads WHERE channel_id = 'C3'"), [
      { team: 'edge', path: 'channels/_unassigned/edge/slack-C3/4.1/' },
    ]);
    r = await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C3', source: 'slack', value: 'helix',
    });
    assert.equal(r.body.shared.added, false);

    // Both teams' pages and inboxes have it; it is filed under edge.
    r = await call(e, ADA, 'GET', '/api/admin/teams');
    assert.deepEqual(r.body.teams.map((t) => [t.slug, t.channels, t.shared]), [
      ['admin', 0, 0], ['edge', 1, 0], ['helix', 2, 1],
    ]);
    for (const slug of ['edge', 'helix']) {
      // eslint-disable-next-line no-await-in-loop
      r = await call(e, ADA, 'GET', `/api/admin/team?slug=${slug}`);
      const c = r.body.channels.find((x) => x.channelId === 'C3');
      assert.deepEqual([c.team, c.sharedWith], ['edge', ['helix']], slug);
    }
    r = await call(e, BO, 'GET', '/api/inbox?team=helix');
    assert.ok(r.body.threads.some((t) => t.thread === C3));
    r = await call(e, CY, 'GET', '/api/inbox?team=edge');
    assert.deepEqual(r.body.threads.map((t) => t.thread), [C3]);
    r = await call(e, BO, 'GET', `/api/thread?thread=${C3}&team=helix`);
    assert.deepEqual([r.status, r.body.thread.team, r.body.thread.teams], [200, 'edge', ['edge', 'helix']]);

    // Its draft is shared by both teams.
    r = await call(e, BO, 'PUT', '/api/draft', { thread: C3, text: 'On it', base: null });
    assert.equal(r.status, 200);
    r = await call(e, CY, 'GET', `/api/draft?thread=${C3}`);
    assert.equal(r.body.draft.body, 'On it');

    // Already in helix's inbox: not suggested to helix.
    e.DB.sqlite.exec("UPDATE threads SET team = 'admin' WHERE channel_id = 'C3'");
    r = await call(e, ADA, 'GET', '/api/admin/team?slug=helix');
    assert.ok(!(r.body.suggestions || []).some((x) => x.channelId === 'C3'));
    e.DB.sqlite.exec("UPDATE threads SET team = 'edge' WHERE channel_id = 'C3'");

    // Taken out of helix's inbox again, it stays with edge.
    r = await call(e, ADA, 'DELETE', '/api/admin/share', { source: 'slack', channelId: 'C3', team: 'helix' });
    assert.equal(r.status, 200);
    assert.equal((await call(e, ADA, 'DELETE', '/api/admin/share', { source: 'slack', channelId: 'C3', team: 'helix' })).status, 404);
    assert.equal((await call(e, BO, 'GET', `/api/thread?thread=${C3}`)).status, 404);
    assert.equal((await call(e, BO, 'PUT', '/api/draft', { thread: C3, text: 'x', base: null })).status, 404);
    assert.equal((await call(e, CY, 'GET', `/api/thread?thread=${C3}`)).status, 200);
  });

  it('moves a shared channel when asked, or to the admin team, and drops what is moved', async () => {
    const e = env();
    // Helix holds C1 by rule: adding edge shares it, moving it there files it under edge.
    let r = await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C1', source: 'slack', value: 'edge',
    });
    assert.equal(r.body.shared.from, 'helix');
    r = await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C1', source: 'slack', value: 'edge', move: true,
    });
    assert.deepEqual(r.body.moves.map((m) => m.to.team), ['edge']);
    assert.deepEqual(e.DB.rows('SELECT team FROM channel_teams'), []);
    await drain(e);
    // Handing it to the admin team is a move too, never a share.
    r = await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C2', source: 'slack', value: 'admin',
    });
    assert.deepEqual([r.body.shared, r.body.moves.map((m) => m.to.team)], [undefined, ['admin']]);
    // A deleted team's shares go with it.
    await call(e, ADA, 'POST', '/api/admin/teams', { slug: 'search', name: 'Search' });
    await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C1', source: 'slack', value: 'search',
    });
    assert.equal((await call(e, ADA, 'DELETE', '/api/admin/teams', { slug: 'search' })).status, 200);
    assert.deepEqual(e.DB.rows('SELECT team FROM channel_teams'), []);
  });
});

describe('admin: orgs', () => {
  it('lists every org, and keeps its display name, icon and type', async () => {
    const e = env();
    let r = await call(e, ADA, 'GET', '/api/admin/orgs');
    assert.deepEqual(r.body.orgs.map((o) => [o.slug, o.type, o.threads]), [['acme', 'customer', 2], ['globex', 'customer', 1]]);
    r = await call(e, ADA, 'PUT', '/api/admin/orgs', {
      slug: 'acme', name: 'ACME Corp', type: 'partner', icon: 'https://acme.example/',
    });
    assert.deepEqual([r.body.org.name, r.body.org.type, r.body.org.icon], ['ACME Corp', 'partner', 'acme.example']);
    assert.equal((await call(e, ADA, 'PUT', '/api/admin/orgs', { slug: 'acme', type: 'friend' })).status, 400);
    assert.equal((await call(e, ADA, 'PUT', '/api/admin/orgs', { slug: 'acme', icon: 'not an icon' })).status, 400);
    r = await call(e, ADA, 'POST', '/api/admin/orgs', { name: 'Umbrella Inc', type: 'vendor' });
    assert.equal(r.body.org.slug, 'umbrella-inc');
    assert.equal((await call(e, ADA, 'POST', '/api/admin/orgs', { name: 'Umbrella Inc' })).status, 409);
    r = await call(e, ADA, 'GET', '/api/admin/org?slug=acme');
    assert.deepEqual([r.body.org.name, r.body.channels.map((c) => c.channelId)], ['ACME Corp', ['C1']]);
    assert.equal(r.body.rules.length, 1);

    // The inbox shows the name, icon and type.
    const inbox = await call(e, ADA, 'GET', '/api/inbox?team=helix');
    const acme = inbox.body.threads.find((t) => t.org === 'acme');
    assert.deepEqual([acme.org_name, acme.org_icon, acme.org_type], ['ACME Corp', 'acme.example', 'partner']);
    assert.equal(inbox.body.threads.find((t) => t.org === 'globex').org_name, null);
    // Adobe's own channels are internal (the inbox groups them apart from customers).
    r = await call(e, ADA, 'PUT', '/api/admin/orgs', { slug: 'globex', type: 'internal' });
    assert.equal(r.body.org.type, 'internal');
    const again = await call(e, ADA, 'GET', '/api/inbox?team=helix');
    assert.equal(again.body.threads.find((t) => t.org === 'globex').org_type, 'internal');

    assert.equal((await call(e, ADA, 'DELETE', '/api/admin/orgs', { slug: 'acme' })).status, 200);
    assert.equal((await call(e, ADA, 'DELETE', '/api/admin/orgs', { slug: 'acme' })).status, 404);
    assert.equal((await call(e, ADA, 'GET', '/api/admin/org?slug=nothing')).status, 404);
  });

  it('names the usual mail domain of an org\'s people, whose favicon it has without an icon', async () => {
    const e = { ...env(), STAFF_DOMAINS: 'staff.example' };
    const person = (id, email, staff, threads) => {
      e.DB.sqlite.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, email, fetched_at)
        VALUES ('slack', 'E1', ?, 'person', ?, ?, '2026-10-22T00:00:00Z')`).run(id, id, email);
      threads.forEach((root, i) => e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at,
          staff, counted, deleted, author_key) VALUES ('slack', 'E1', 'C1', ?, ?, '2026-10-22T00:00:00Z', ?, 1, 0, ?)`)
        .run(`${id}-${i}`, `slack:E1:C1:${root}`, staff, `slack:E1:${id}`));
    };
    person('U1', 'wile@acme.example', 0, ['1.1']);
    person('U2', 'road@runner.example', 0, ['1.1', '2.1']);
    person('U3', 'bugs@runner.example', 0, ['2.1']);
    person('U4', 'ada@staff.example', 1, ['1.1', '2.1']);
    person('U5', 'someone@gmail.com', 0, ['1.1', '2.1']);
    const r = await call(e, ADA, 'GET', '/api/admin/orgs');
    assert.deepEqual(r.body.orgs.map((o) => [o.slug, o.domain]), [['acme', 'runner.example'], ['globex', null]]);
    const one = await call(e, ADA, 'GET', '/api/admin/org?slug=acme');
    assert.deepEqual(one.body.domains, ['runner.example', 'acme.example']);
    assert.equal((await call(e, ADA, 'GET', '/api/admin/org-icons?slug=Not%20a%20slug')).status, 400);
  });
});

describe('admin: channel search', () => {
  const teamsChannel = (e, id, name, group) => e.DB.sqlite.prepare(`INSERT INTO channels
      (source, tenant, channel_id, name, group_name, fetched_at)
    VALUES ('teams', 'T1', ?, ?, ?, '2026-10-22T00:00:00Z')`).run(id, name, group);
  const found = async (e, q) => (await call(e, ADA, 'GET', `/api/admin/channels?q=${encodeURIComponent(q)}`))
    .body.channels.map((c) => c.channelId);

  it('finds a channel by anything the picker shows of it', async () => {
    const e = env();
    teamsChannel(e, '19:a@thread.tacv2', 'Main', 'aem-initech');
    teamsChannel(e, '19:b@thread.tacv2', 'Main', 'Hooli Support');
    teamsChannel(e, '19:c@thread.tacv2', 'General', 'aem-initech');
    // The Teams team, alone or with the channel, as shown or typed loosely.
    assert.deepEqual(await found(e, 'initech'), ['19:a@thread.tacv2', '19:c@thread.tacv2']);
    for (const q of ['aem-initech › Main', 'aem-initech > main', 'initech main', 'initech/main', 'aem initech main']) {
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await found(e, q), ['19:a@thread.tacv2'], q);
    }
    assert.deepEqual(await found(e, 'hooli-support'), ['19:b@thread.tacv2']);
    // The whole name as shown comes first.
    assert.equal((await found(e, 'main'))[0], '19:a@thread.tacv2');
    // The platform, the team it is filed under (slug or name) and the customer.
    assert.deepEqual(await found(e, 'teams general'), ['19:c@thread.tacv2']);
    assert.deepEqual(await found(e, 'helix ops globex'), ['C2']);
    assert.deepEqual(await found(e, '#aem-acme'), ['C1']);
    assert.deepEqual(await found(e, 'initech nothing'), []);
  });
});
