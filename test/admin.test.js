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
      ['GET', '/api/admin/channels?q=aem'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await as(e, me, method, path, body)).status, 403, `${method} ${path}`);
    }
    // A plain member has no admin pages at all.
    assert.equal((await as(e, asMe(CY), 'GET', '/api/admin/teams')).status, 403);
    assert.equal((await as(e, asMe(CY), 'GET', '/api/kb')).status, 403);
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
    // Assigning again changes the same rule.
    r = await call(e, ADA, 'POST', '/api/admin/assign', {
      target: 'team', channelId: 'C3', source: 'slack', value: 'helix',
    });
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

    assert.equal((await call(e, ADA, 'DELETE', '/api/admin/orgs', { slug: 'acme' })).status, 200);
    assert.equal((await call(e, ADA, 'DELETE', '/api/admin/orgs', { slug: 'acme' })).status, 404);
    assert.equal((await call(e, ADA, 'GET', '/api/admin/org?slug=nothing')).status, 404);
  });
});
