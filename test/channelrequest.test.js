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
import { ruleWords } from '../src/agent/channelrequest.js';
import { opspileExtension } from '../src/agent/tools.js';
import { matching } from '../src/rules.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up people, channels and slugs only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
};
const RULES = [
  {
    id: 2, target: 'team', priority: 100, source: null, field: 'name', pattern: '^aem-', value: 'helix',
  },
  {
    id: 3, target: 'team', priority: 50, source: 'slack', field: 'channel_id', pattern: '^C1$', value: 'helix', note: 'listed at the start',
  },
  {
    id: 4, target: 'team', priority: 100, source: null, field: 'name', pattern: '^shop-', value: 'edge',
  },
  {
    id: 5, target: 'team', priority: 1000, source: null, field: 'channel_id', pattern: '.', value: 'admin',
  },
];
const KEY = 'slack:E1:C1:1.1';
const TARGET = {
  key: KEY, team: 'helix', org: 'acme', kind: 'channel', source: 'slack', tenant: 'E1', channelId: 'C1', channelName: 'shop-acme', threads: [KEY],
};

function env() {
  const DB = d1({
    rules: RULES,
    people: [ADA, BO],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }, { slug: 'edge', name: 'Edge ops' }],
  });
  DB.sqlite.exec(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
      VALUES ('slack', 'E1', 'C1', 'shop-acme', '2026-10-22T00:00:00Z');
    INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind, channel_name,
      path, root_at, last_at, any_at, messages, updated_at)
    VALUES ('${KEY}', 'slack', 'E1', 'C1', '1.1', 'acme', 'helix', 'channel', 'shop-acme',
      'channels/acme/helix/slack-C1/1.1/', '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z',
      '2026-10-22T00:00:00Z', 1, '2026-10-22T00:00:00Z');
    UPDATE team_members SET role = 'manager' WHERE person = 2;
    INSERT INTO sidebar_messages (id, thread, role, person, body, at)
      VALUES ('sb_1', '${KEY}', 'person', 2, 'why is this ours?', '2026-10-22T01:00:00Z')`);
  const queued = [];
  return {
    DB, queued, CHANNELS: fakeBucket(), NORMALIZE: { send: async (body) => queued.push(body) },
  };
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

async function asAdmin(e, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const viewer = { ...ADA, teams: ADA.teams.map((slug) => ({ slug })) };
  const res = await api(request, e, url, { viewer });
  return { status: res.status, body: await res.json() };
}

describe('rules: what decides and what would', () => {
  it('lists every matching rule in the order they are tried', () => {
    const channel = { source: 'slack', channelId: 'C1', name: 'shop-acme' };
    assert.deepEqual(matching(RULES, channel, 'team').map((m) => [m.rule.id, m.value]), [
      [3, 'helix'], [4, 'edge'], [5, 'admin'],
    ]);
    assert.deepEqual(matching(RULES, { ...channel, source: 'teams' }, 'team').map((m) => m.rule.id), [4, 5]);
  });

  it('says a rule in words', () => {
    assert.equal(ruleWords(RULES[0]), 'channel name starts with aem-');
    assert.equal(ruleWords(RULES[1]), 'channel id is C1 (Slack only)');
    assert.equal(ruleWords(RULES[3]), 'channel id is anything (every channel)');
    assert.equal(ruleWords({ field: 'name', pattern: '^(a|b)-' }), 'channel name matches /^(a|b)-/');
  });
});

describe('agent: the channel\'s assignment', () => {
  it('says which rule filed the channel and which would without it', async () => {
    const run = agentTools(env());
    const { text } = await run('channel_assignment');
    assert.match(text, /^Channel #shop-acme on Slack, id C1: filed under helix \(Helix ops\), customer acme, kind channel\./);
    assert.match(text, /- decided by rule 3: channel id is C1 \(Slack only\), priority 50 → helix \(Helix ops\); note: "listed at the start"/);
    assert.match(text, /- without it: rule 4: channel name starts with shop-, priority 100 → edge \(Edge ops\); then rule 5:/);
    assert.match(text, /Shared with no other team\./);
    assert.match(text, /No open request for this channel\./);
  });

  it('lists the teams, with their rules and members, and finds them', async () => {
    const run = agentTools(env());
    const all = (await run('list_teams')).text.split('\n');
    assert.deepEqual(all.map((l) => l.split(' | ')[0]), ['- admin', '- edge', '- helix']);
    assert.match(all[0], /holds the channels no ops team follows/);
    assert.match(all[2], /^- helix \| Helix ops \| files channels whose channel name starts with aem- \| 1 channel assigned by channel id \| holds 1 channel \| members: Bo \(manager\)$/);
    assert.equal((await run('list_teams', { query: 'shop-' })).text.split(' | ')[0], '- edge');
    assert.equal((await run('list_teams', { query: 'nobody' })).text, 'No team matches.');
  });
});

describe('agent: request_channel_reassignment', () => {
  it('is refused outside the sidebar, where customers write', async () => {
    const e = env();
    const res = await agentTools(e)('request_channel_reassignment', { team: 'edge', note: 'x' });
    assert.equal(res.error, true);
    assert.match(res.text, /^Only a person on the team can ask for this, in the sidebar/);
    // A sidebar message of another thread is not this one's.
    const other = await agentTools(e, 'sb_2')('request_channel_reassignment', { team: 'edge', note: 'x' });
    assert.equal(other.error, true);
    assert.equal(e.DB.rows('SELECT * FROM channel_requests').length, 0);
  });

  it('asks the admin team to move the channel, for the person who asked', async () => {
    const e = env();
    const run = agentTools(e, 'sb_1');
    const res = await quiet(() => run('request_channel_reassignment', { team: 'edge', note: 'A shop- channel' }));
    assert.deepEqual(res, {
      text: 'requested (request 1) for Bo: move the channel from helix to edge. The admin team confirms or declines it under Requests in the admin pages; nothing moved yet. Tell Bo so.',
      error: false,
    });
    const [row] = e.DB.rows('SELECT team, note, move, thread, requested_by, status FROM channel_requests');
    assert.deepEqual({ ...row }, {
      team: 'edge', note: 'A shop- channel', move: 1, thread: KEY, requested_by: 'bo@staff.example', status: 'open',
    });
    assert.match((await run('channel_assignment')).text, /Open requests for this channel: request 1, move to edge \(Edge ops\), by Bo on /);
    // Once at a time, and not to where it is, or to a team there is not.
    assert.match((await run('request_channel_reassignment', { team: 'edge', note: 'again' })).text, /^Nothing was requested: this channel is requested for the team already \(request 1, by Bo\)\.$/);
    assert.match((await run('request_channel_reassignment', { team: 'helix', note: 'x' })).text, /filed under helix already/);
    assert.match((await run('request_channel_reassignment', { team: 'nope', note: 'x' })).text, /no such team/);

    // Confirmed, it moves, although another team (helix) holds it: a request to add it would share.
    const { body } = await asAdmin(e, 'GET', '/api/admin/requests');
    assert.deepEqual([body.requests[0].move, body.requests[0].thread], [true, KEY]);
    const tried = await asAdmin(e, 'POST', '/api/admin/requests/confirm', { id: 1, dryRun: true });
    assert.equal(tried.body.shared, undefined);
    assert.deepEqual(tried.body.moves.map((m) => [m.channel.channelId, m.to.team]), [['C1', 'edge']]);
    const done = await quiet(() => asAdmin(e, 'POST', '/api/admin/requests/confirm', { id: 1 }));
    assert.deepEqual([done.status, done.body.request.status, done.body.request.outcome], [200, 'confirmed', 'moved']);
    assert.deepEqual(
      e.DB.rows("SELECT value, priority FROM rules WHERE note = 'manual assignment'").map((r) => [r.value, r.priority]),
      [['edge', 10]],
    );
  });

  it('with `share`, asks to add it to the team\'s inbox and leave it where it is', async () => {
    const e = env();
    const res = await quiet(() => agentTools(e, 'sb_1')('request_channel_reassignment', { team: 'edge', note: 'Both', share: true }));
    assert.match(res.text, /add the channel to edge's inbox, filed under helix still/);
    const tried = await asAdmin(e, 'POST', '/api/admin/requests/confirm', { id: 1, dryRun: true });
    assert.deepEqual(tried.body.shared, {
      source: 'slack', channelId: 'C1', team: 'edge', from: 'helix',
    });
  });
});
