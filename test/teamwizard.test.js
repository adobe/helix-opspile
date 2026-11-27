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
  groupRules, prefixesOf, prefixGroups, rankPeople, teamFor,
} from '../src/teamwizard.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up people, channels, customers and teams only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['edge'],
};
const CY = {
  id: 3, email: 'cy@staff.example', name: 'Cy', staff: 1, teams: ['edge'],
};
const T0 = '2026-10-22T00:00:00Z';
const asMe = (p) => ({ ...p, teams: p.teams.map((t) => ({ slug: t })) });

function env() {
  const DB = d1({
    people: [ADA, BO, CY],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'edge', name: 'Edge ops' }],
    rules: [{
      id: 1, target: 'team', priority: 1000, source: null, field: 'channel_id', pattern: '.', value: 'admin',
    }],
  });
  const db = DB.sqlite;
  const channel = (source, id, name, group = null) => {
    db.prepare(`INSERT INTO channels (source, tenant, channel_id, name, group_name, members_at, fetched_at)
      VALUES (?, 'X1', ?, ?, ?, ?, ?)`).run(source, id, name, group, T0, T0);
    db.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind,
        channel_name, path, root_at, last_at, any_at, messages, updated_at)
      VALUES (?, ?, 'X1', ?, 'r', '_unassigned', 'admin', 'channel', ?, ?, ?, ?, ?, 1, ?)`)
      .run(`${source}:X1:${id}:r`, source, id, name, `channels/_unassigned/admin/${source}-${id}/r/`, T0, T0, T0, T0);
  };
  const member = (id, user, email) => db.prepare(`INSERT INTO channel_members (source, tenant, channel_id, user_id, email, name)
    VALUES ((SELECT source FROM channels WHERE channel_id = ?1), 'X1', ?1, ?2, ?3, ?2)`).run(id, user, email);
  channel('slack', 'S1', 'widget-acme');
  channel('slack', 'S2', 'widget-globex');
  channel('slack', 'S3', 'widget-initech');
  channel('teams', 'T1', 'Main', 'widget-hooli');
  channel('slack', 'S4', 'other-umbrella');
  channel('slack', 'S5', 'other-wonka');
  channel('slack', 'S6', 'loner');
  // Ada is everywhere; Bo and Cy in the widget channels; a customer too.
  ['S1', 'S2', 'S3', 'T1', 'S4', 'S5', 'S6'].forEach((id) => member(id, 'Ada', ADA.email));
  ['S1', 'S2', 'T1'].forEach((id) => member(id, 'Bo', BO.email));
  ['S1', 'S2', 'S3'].forEach((id) => member(id, 'Zed', 'zed@customer.example'));
  db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person, staff, counted, author_key)
    VALUES ('slack', 'X1', 'S3', 'm1', 'slack:X1:S3:r', ?, 3, 1, 1, 'slack:X1:UC')`).run(T0);
  db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person, staff, counted, author_key)
    VALUES ('slack', 'X1', 'S2', 'm2', 'slack:X1:S2:r', ?, 3, 1, 1, 'slack:X1:UC')`).run(T0);
  const queued = [];
  return {
    DB, STAFF_DOMAINS: 'staff.example', queued, NORMALIZE: { send: async (b) => queued.push(b) },
  };
}

async function call(e, me, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await quiet(() => api(request, e, url, { viewer: asMe(me) }));
  return { status: res.status, body: await res.json() };
}

describe('team wizard', () => {
  it('reads up to two prefixes of a name', () => {
    assert.deepEqual(prefixesOf('Workfront-Frame-acme'), ['workfront-', 'workfront-frame-']);
    assert.deepEqual(prefixesOf('champion_cdp_offboarding'), ['champion_', 'champion_cdp_']);
    assert.deepEqual(prefixesOf('a-b-c'), ['a-b-']);
    assert.deepEqual(prefixesOf('loner'), []);
    assert.deepEqual(prefixesOf('trailing-'), []);
  });

  it('groups channels by prefix, the narrower prefix where it has them all', () => {
    const ch = (name, group = null) => ({
      source: group ? 'teams' : 'slack', tenant: 'X', channel_id: name, name, group_name: group,
    });
    const groups = prefixGroups([
      ch('app-isv-a'), ch('app-isv-b'), ch('app-isv-c'),
      ch('wf-frame-a'), ch('wf-frame-b'), ch('wf-frame-c'), ch('wf-x'),
      ch('Main', 'acs-one'), ch('Main', 'acs-two'), ch('acs-three'), ch('few-a'), ch('few-b'),
    ]);
    assert.deepEqual(groups.map((g) => [g.prefix, g.channels.length, g.parent]), [
      ['wf-', 4, null], ['acs-', 3, null], ['app-isv-', 3, null], ['wf-frame-', 3, 'wf-'],
    ]);
    assert.deepEqual(groupRules(groups[1]), [
      { field: 'name', source: null, pattern: '^acs-' },
      { field: 'group_name', source: 'teams', pattern: '^acs-' },
    ]);
    assert.deepEqual(teamFor('wf-frame-'), { slug: 'wf-frame', name: 'Wf Frame' });
  });

  it('checks who is in most of a group, unless they are as much everywhere', () => {
    const presence = new Map([
      ['a', new Map([['ada', { email: 'ada' }], ['bo', { email: 'bo' }]])],
      ['b', new Map([['ada', { email: 'ada' }], ['bo', { email: 'bo' }]])],
      ['c', new Map([['ada', { email: 'ada' }]])],
    ]);
    const ranked = rankPeople(['a', 'b', 'c'], presence, new Map([['ada', 10], ['bo', 2]]), 10);
    assert.deepEqual(ranked.map((p) => [p.email, p.channels, p.everywhere, p.suggested]), [
      ['bo', 2, 2, true], ['ada', 3, 10, false],
    ]);
  });

  it('lists the groups with their people, and makes one a team with its members and rules', async () => {
    const e = env();
    assert.equal((await call(e, BO, 'GET', '/api/admin/team-groups')).status, 403);
    let r = await call(e, ADA, 'GET', '/api/admin/team-groups');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.groups.map((g) => [g.prefix, g.size]), [['widget-', 4]]);
    const [g] = r.body.groups;
    // Ada is in every channel: not checked. Bo and Cy are on Edge ops: offered as its group.
    assert.deepEqual(g.people.map((p) => [p.name, p.channels, p.suggested, p.teams]), [
      ['Bo', 3, true, ['edge']], ['Cy', 2, true, ['edge']], ['Ada', 4, false, []],
    ]);
    assert.deepEqual(g.team, { slug: 'edge', people: 2 });
    assert.equal(g.slug, 'widget');
    assert.deepEqual(g.rules.map((x) => x.field), ['name', 'group_name']);
    assert.deepEqual(r.body.coverage, { channels: 7, membersListed: 7 });

    // Dismissed, it stays away until the group grows.
    assert.equal((await call(e, ADA, 'POST', '/api/admin/team-wizard/dismiss', { prefix: 'widget-' })).status, 200);
    r = await call(e, ADA, 'GET', '/api/admin/team-groups');
    assert.deepEqual([r.body.groups.length, r.body.dismissed.map((x) => x.prefix)], [0, ['widget-']]);
    assert.equal((await call(e, ADA, 'DELETE', '/api/admin/team-wizard/dismiss', { prefix: 'widget-' })).status, 200);
    assert.equal((await call(e, ADA, 'GET', '/api/admin/team-groups')).body.groups.length, 1);

    // A dry run says what moves; then the team is made.
    r = await call(e, ADA, 'POST', '/api/admin/team-wizard', {
      prefix: 'widget-', slug: 'widget', name: 'Widget', dryRun: true,
    });
    assert.deepEqual(r.body.moves.map((m) => [m.channel.channelId, m.to.team]).sort(), [
      ['S1', 'widget'], ['S2', 'widget'], ['S3', 'widget'], ['T1', 'widget'],
    ]);
    assert.equal(e.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM teams WHERE slug = 'widget'").get().n, 0);
    r = await call(e, ADA, 'POST', '/api/admin/team-wizard', {
      prefix: 'widget-',
      slug: 'widget',
      name: 'Widget',
      people: [{ email: BO.email }, { email: CY.email }, { email: 'nope' }],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.members.map((m) => m.email), [BO.email, CY.email]);
    assert.equal(r.body.refused.length, 1);
    assert.equal(r.body.moves.length, 4);
    assert.deepEqual(e.DB.sqlite.prepare("SELECT field, source, pattern, value FROM rules WHERE value = 'widget' ORDER BY id")
      .all().map((x) => ({ ...x })), [
      {
        field: 'name', source: null, pattern: '^widget-', value: 'widget',
      },
      {
        field: 'group_name', source: 'teams', pattern: '^widget-', value: 'widget',
      },
    ]);
    assert.equal(e.queued.length > 0, true);
    // Taken: a second one fails before it adds anything.
    r = await call(e, ADA, 'POST', '/api/admin/team-wizard', { prefix: 'widget-', slug: 'widget', name: 'Again' });
    assert.equal(r.status, 409);
    assert.equal((await call(e, ADA, 'POST', '/api/admin/team-wizard', { prefix: 'nothing-', slug: 'x', name: 'X' })).status, 404);
  });

  it('gives an existing team the rules instead', async () => {
    const e = env();
    const r = await call(e, ADA, 'POST', '/api/admin/team-wizard', { prefix: 'widget-', team: 'edge', people: [] });
    assert.equal(r.status, 200);
    assert.equal(e.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM rules WHERE value = 'edge'").get().n, 2);
    assert.equal((await call(e, ADA, 'POST', '/api/admin/team-wizard', { prefix: 'widget-', team: 'admin' })).status, 400);
  });

  it('answers what it did when clearing the dismissal fails after the rules are saved', async () => {
    const e = env();
    const { prepare } = e.DB;
    // As D1 overloaded, on the last statement only: the rules and moves are in by then.
    e.DB.prepare = (sql) => (sql.startsWith('DELETE FROM team_prefix_dismissals')
      ? { bind: () => ({ run: async () => { throw new Error('D1_ERROR: D1 DB is overloaded.'); } }) }
      : prepare(sql));
    const r = await call(e, ADA, 'POST', '/api/admin/team-wizard', { prefix: 'widget-', team: 'edge', people: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.team.slug, 'edge');
    assert.equal(e.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM rules WHERE value = 'edge'").get().n, 2);
  });
});
