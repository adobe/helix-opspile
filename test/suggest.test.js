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
import { channelMatch } from '../src/admin.js';
import { api } from '../src/api.js';
import {
  channelState, classifyChannels, NONE, suggestionsFor,
} from '../src/suggest.js';
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
const DI = {
  id: 4, email: 'di@staff.example', name: 'Di', staff: 1, teams: ['helix'],
};
const T0 = '2026-10-22T00:00:00Z';

function env() {
  const DB = d1({
    people: [ADA, BO, CY, DI],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'edge', name: 'Edge ops' }, { slug: 'helix', name: 'Helix ops' }],
    rules: [
      {
        id: 1, target: 'team', priority: 100, source: 'teams', field: 'group_name', pattern: '^ex-', value: 'edge',
      },
      {
        id: 2, target: 'team', priority: 1000, source: null, field: 'channel_id', pattern: '.', value: 'admin',
      },
    ],
  });
  const db = DB.sqlite;
  const channel = (source, id, name, group, groupId = null) => db.prepare(`INSERT INTO channels
    (source, tenant, channel_id, name, group_id, group_name, fetched_at) VALUES (?, 'X1', ?, ?, ?, ?, ?)`)
    .run(source, id, name, groupId, group, T0);
  const thread = (source, id, root, team, org, title, at = T0) => db.prepare(`INSERT INTO threads
    (thread, source, tenant, channel_id, root_id, org, team, kind, channel_name, title, path, root_at,
      last_at, any_at, messages, updated_at) VALUES (?, ?, 'X1', ?, ?, ?, ?, 'channel', ?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(`${source}:X1:${id}:${root}`, source, id, root, org, team, id, title, `channels/${org}/${team}/${source}-${id}/${root}/`, at, at, at, at);
  // Edge ops has a channel; the admin team holds four.
  channel('teams', 'CE', 'Main', 'ex-acme', 'G-ACME');
  thread('teams', 'CE', 'r0', 'edge', 'acme', 'Cache keeps the old page');
  channel('teams', 'C1', 'Main', 'globex-support', 'G-GLOBEX');
  thread('teams', 'C1', 'r1', 'admin', 'globex', 'Preview is blank');
  channel('slack', 'C2', 'cust-initech', null);
  thread('slack', 'C2', 'r2', 'admin', 'initech', 'Forms submit twice');
  channel('slack', 'C3', 'cust-hooli', null);
  thread('slack', 'C3', 'r3', 'admin', 'hooli', 'Kick-off');
  channel('slack', 'C4', 'test-sandbox', null);
  thread('slack', 'C4', 'r4', 'admin', '_unassigned', 'test');
  db.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES ('globex', 'Globex Corporation', 'customer', '${T0}');
    INSERT INTO identities (source, tenant, user_id, kind, name, email, person, fetched_at) VALUES
      ('slack', 'X1', 'UB', 'person', 'Bo', 'bo@staff.example', 2, '${T0}'),
      ('slack', 'X1', 'UC', 'person', 'Cy', 'cy@staff.example', 3, '${T0}'),
      ('slack', 'X1', 'UZ', 'person', 'Zed', 'zed@initech.example', NULL, '${T0}');
    -- Bo posts in Globex's channel, Cy reacts in Initech's.
    INSERT INTO messages (source, tenant, channel_id, id, thread, at, person, staff, counted, author_key)
      VALUES ('teams', 'X1', 'C1', 'm1', 'teams:X1:C1:r1', '${T0}', 2, 1, 1, 'teams:X1:TB'),
        ('teams', 'X1', 'C1', 'm2', 'teams:X1:C1:r1', '${T0}', 2, 1, 1, 'teams:X1:TB'),
        ('slack', 'X1', 'C2', 'm3', 'slack:X1:C2:r2', '${T0}', NULL, 0, 1, 'slack:X1:UZ');
    INSERT INTO reactions (message, thread, emoji, user_key, at)
      VALUES ('slack:X1:C2:m3', 'slack:X1:C2:r2', 'eyes', 'slack:X1:UC', '${T0}');`);
  return { DB, STAFF_DOMAINS: 'staff.example' };
}

/** Clef, made up: the team with the most words of its option in the state wins. */
function fakeAI(answers = {}) {
  const calls = [];
  return {
    calls,
    async run(model, body) {
      calls.push({ model, body });
      const name = /Channel: (.*)/.exec(body.state)[1];
      const probabilities = answers[name] || { [NONE]: 0.9, edge: 0.05, helix: 0.05 };
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
      return {
        model: 'clef',
        answers: {
          team: { choice, probabilities },
          kind: { choice: 'channel', probabilities: { channel: 0.9, alert: 0.05, ignore: 0.05 } },
        },
      };
    },
  };
}

const slackMembers = (byChannel) => async (method, params) => {
  assert.equal(method, 'conversations.members');
  return { ok: true, members: byChannel[params.channel] || [] };
};

describe('channel suggestions', () => {
  it('match every word of a search in the name, the Teams team, the customer or the id', () => {
    const c = {
      name: 'Main', group_name: 'globex-support', org: 'globex', org_name: 'Globex Corporation', channel_id: '19:abc',
    };
    assert.deepEqual(channelMatch(c, ['globex']), ['groupName', 'orgName', 'org']);
    assert.deepEqual(channelMatch(c, ['main', 'corporation']), ['name', 'orgName']);
    assert.equal(channelMatch(c, ['main', 'initech']), null);
    assert.deepEqual(channelMatch(c, ['19:a']), ['channelId']);
  });

  it('tell Clef where the channel is, who of which team is in it, and what it is about', () => {
    const state = channelState({
      source: 'teams',
      name: 'Main',
      groupName: 'globex-support',
      topic: 'Globex site launch',
      shared: false,
      org: { slug: 'globex', name: 'Globex Corporation', type: 'customer' },
      threads: 2,
      latest: T0,
      recent: [{
        at: T0, title: 'Preview is blank', messages: 3, kind: 'incident',
      }],
      posters: [{
        name: 'Bo', staff: true, n: 2, teams: ['Edge ops'],
      }, {
        name: 'Zed', staff: false, n: 1, teams: [],
      }],
      members: [{ name: 'Bo', staff: true, teams: ['Edge ops'] }, { name: 'Ed', staff: true, teams: [] },
        { name: null, staff: false, teams: [] }],
      membersListed: true,
      tech: ['Universal Editor'],
    });
    assert.match(state, /Channel: "Main" in the Microsoft Teams team "globex-support"/);
    assert.match(state, /Topic: Globex site launch/);
    assert.match(state, /Customer, from the channel's name: Globex Corporation/);
    assert.match(state, /2 messages by Adobe staff and 1 by others/);
    assert.match(state, /Adobe people who posted: Bo \(Edge ops\), 2 messages/);
    assert.match(state, /Members on Microsoft Teams: 3 \(2 Adobe staff, 1 others/);
    assert.match(state, /Adobe staff in the channel: Bo \(Edge ops\); Ed \(no ops team\)/);
    assert.match(state, /- \[2026-10-22\] Preview is blank \(3 messages, incident\)/);
  });

  it('classify the admin team\'s channels once, and again when something changed', async () => {
    const e = env();
    e.AI = fakeAI({ '#cust-hooli on Slack': { edge: 0.85, helix: 0.1, [NONE]: 0.05 } });
    const graph = async (path) => {
      assert.match(path, /^\/teams\/G-GLOBEX\/members/);
      return Response.json({ value: [{ userId: 'TC', email: 'Cy@staff.example', displayName: 'Cy' }] });
    };
    let r = await classifyChannels(e, { slack: slackMembers({ C3: ['UB', 'UZ', 'U-NEW'] }), graph });
    assert.deepEqual(r, {
      classified: 4, members: 4, failed: 0, pending: 0,
    });
    // The options are the ops teams but the admin team, described by their rules, channels
    // and members, and `none`.
    const { questions, state } = e.AI.calls.find((c) => /globex/.test(c.body.state)).body;
    assert.deepEqual(Object.keys(questions.team.criteria), ['edge', 'helix', NONE]);
    assert.match(questions.team.criteria.edge, /Teams team name starts with ex- \(Teams only\).*ex-acme \/ Main.*Bo, Cy/);
    assert.match(state, /Adobe people who posted: Bo \(Edge ops\), 2 messages/);
    assert.match(state, /Adobe staff in the channel: Cy \(Edge ops\)/);
    assert.deepEqual(e.DB.rows("SELECT user_id, email, name FROM channel_members WHERE channel_id = 'C3' ORDER BY user_id"), [
      { user_id: 'U-NEW', email: null, name: null },
      { user_id: 'UB', email: 'bo@staff.example', name: 'Bo' },
      { user_id: 'UZ', email: 'zed@initech.example', name: 'Zed' },
    ]);
    assert.deepEqual(e.DB.rows("SELECT team, team_p, kind FROM channel_labels WHERE channel_id = 'C3'"), [{ team: 'edge', team_p: 0.85, kind: 'channel' }]);

    // Nothing changed: nothing to do. New activity, or a new team, and Clef looks again.
    e.AI.calls.length = 0;
    r = await classifyChannels(e, { slack: slackMembers({}), graph });
    assert.equal(r.classified, 0);
    e.DB.sqlite.exec("UPDATE threads SET any_at = '2026-10-23T00:00:00Z' WHERE channel_id = 'C2'");
    r = await classifyChannels(e, { slack: slackMembers({}), graph });
    assert.equal(r.classified, 1);
    e.DB.sqlite.exec("INSERT INTO teams (slug, name) VALUES ('search', 'Search ops')");
    r = await classifyChannels(e, { limit: 2, slack: slackMembers({}), graph });
    assert.deepEqual([r.classified, r.pending], [2, 2]);
  });

  it('remember when a platform will not list the members, and still classify', async () => {
    const e = env();
    e.AI = fakeAI();
    let asked = 0;
    const graph = async () => {
      asked += 1;
      return Response.json({ error: { code: 'Forbidden' } }, { status: 403 });
    };
    e.DB.sqlite.exec(`INSERT INTO channels (source, tenant, channel_id, name, group_id, group_name, fetched_at)
      VALUES ('teams', 'X1', 'C5', 'General', 'G-UMBRELLA', 'umbrella', '${T0}')`);
    e.DB.sqlite.exec(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, path, any_at, updated_at)
      VALUES ('teams:X1:C5:r5', 'teams', 'X1', 'C5', 'r5', 'umbrella', 'admin', 'p/', '${T0}', '${T0}')`);
    const r = await quiet(() => classifyChannels(e, {
      slack: async () => { throw new Error('slack conversations.members: missing_scope'); },
      graph,
    }));
    assert.deepEqual([r.classified, r.members, r.failed], [5, 0, 0]);
    // One Teams team answered 403; the other was not asked.
    assert.equal(asked, 1);
    assert.deepEqual(e.DB.rows("SELECT members_error FROM channels WHERE channel_id IN ('C1', 'C2') ORDER BY channel_id"), [
      { members_error: 'graph members 403 Forbidden' }, { members_error: 'slack conversations.members: missing_scope' },
    ]);
  });

  it('suggest the channels a team\'s members are active in, and the ones Clef gives it', async () => {
    const e = env();
    e.AI = fakeAI({
      '#cust-hooli on Slack': { edge: 0.85, helix: 0.1, [NONE]: 0.05 },
      '"Main" in the Microsoft Teams team "globex-support"': { edge: 0.6, helix: 0.3, [NONE]: 0.1 },
    });
    await classifyChannels(e, {
      slack: slackMembers({ C4: ['UC'] }),
      graph: async () => Response.json({ value: [] }),
    });
    const { suggestions, coverage } = await suggestionsFor(e, 'edge');
    const who = (s) => s.people.map((p) => [p.name, p.posted, p.reacted, p.member]);
    assert.deepEqual(suggestions.map((s) => [s.channelId, who(s), s.clef.here]), [
      ['C1', [['Bo', 2, 0, false]], 0.6],
      ['C2', [['Cy', 0, 1, false]], 0.05],
      ['C4', [['Cy', 0, 0, true]], 0.05],
      // Nobody from the team, but Clef is sure enough.
      ['C3', [], 0.85],
    ]);
    assert.deepEqual(coverage, { channels: 4, classified: 4, membersListed: 4 });
    assert.equal(suggestions[0].orgName, 'Globex Corporation');
    assert.deepEqual((await suggestionsFor(e, 'helix')).suggestions, []);
  });

  it('are on a team\'s page for the admin team, and the search finds channels by customer', async () => {
    const e = env();
    const call = async (me, path) => {
      const url = new URL(`https://opspile.example${path}`);
      const res = await api(new Request(url), e, url, { viewer: { ...me, teams: me.teams.map((slug) => ({ slug, role: 'manager' })) } });
      return res.json();
    };
    let r = await call(ADA, '/api/admin/team?slug=edge');
    assert.deepEqual(r.suggestions.map((s) => s.channelId), ['C1', 'C2']);
    assert.equal(r.coverage.classified, 0);
    // Team managers see their members, not the admin team's channels.
    r = await call(BO, '/api/admin/team?slug=edge');
    assert.equal(r.suggestions, undefined);
    // The admin team's own page has none.
    assert.equal((await call(ADA, '/api/admin/team?slug=admin')).suggestions, undefined);

    r = await call(ADA, '/api/admin/channels?q=globex%20corp');
    assert.deepEqual(r.channels.map((c) => [c.channelId, c.groupName, c.orgName, c.match]), [
      ['C1', 'globex-support', 'Globex Corporation', ['groupName', 'orgName', 'org']],
    ]);
    // A Teams team's name first, then the rest by activity.
    r = await call(ADA, '/api/admin/channels?q=main');
    assert.deepEqual(r.channels.map((c) => c.channelId).sort(), ['C1', 'CE']);
  });
});
