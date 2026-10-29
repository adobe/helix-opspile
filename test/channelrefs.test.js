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
import { channelRefs, channelTokens, nameChannelIds } from '../src/channelrefs.js';
import { d1 } from './d1.js';

// Made-up teams, customers, channels and ids only.
describe('channel references', () => {
  it('finds #names and Slack channel ids, not in code, URLs, entities or words', () => {
    assert.deepEqual(channelTokens([
      'New channel: #C0ABCDEFGH1, see #ops-acme. And #General!',
      'not `#in-code`, https://x.example/#anchor, &#39;, a#b, ##two',
      '```\n#fenced\n```',
    ]), { ids: ['C0ABCDEFGH1'], names: ['ops-acme', 'general'] });
    assert.deepEqual(channelTokens([null, '']), { ids: [], names: [] });
  });

  const fresh = () => {
    const DB = d1({
      teams: [{ slug: 'ops', name: 'Ops' }, { slug: 'other', name: 'Other' }],
      people: [{
        id: 1, email: 'a@staff.example', name: 'Ada', staff: 1, teams: ['ops'],
      }],
    });
    const thread = (channel, team, org, at) => DB.sqlite.prepare(`INSERT INTO threads (thread, source,
        tenant, channel_id, root_id, org, team, path, any_at, updated_at)
      VALUES (?, 'slack', 'E1', ?, '1.0', ?, ?, 'p', ?, ?)`)
      .run(`slack:E1:${channel}:${at}`, channel, org, team, at, at);
    DB.sqlite.exec(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at, domain) VALUES
      ('slack', 'E1', 'C0AAAAAAAA1', 'acme-ops', '2026-10-01', 'acme-ws'),
      ('slack', 'E1', 'C0BBBBBBBB2', 'beta-help', '2026-10-01', NULL),
      ('slack', 'E1', 'C0CCCCCCCC3', 'gamma', '2026-10-01', NULL),
      ('slack', 'E1', 'C0DDDDDDDD4', 'delta', '2026-10-01', NULL)`);
    thread('C0AAAAAAAA1', 'admin', '_unassigned', '2026-10-01');
    thread('C0AAAAAAAA1', 'ops', 'acme', '2026-10-02');
    thread('C0BBBBBBBB2', 'other', 'beta', '2026-10-02');
    thread('C0CCCCCCCC3', 'other', 'gamma', '2026-10-02');
    DB.sqlite.exec(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person)
      VALUES ('slack', 'E1', 'C0BBBBBBBB2', '2.0', 'slack:E1:C0BBBBBBBB2:2026-10-02', '2026-10-02', 1)`);
    return DB;
  };
  const me = { id: 1, teams: [{ slug: 'ops' }] };

  it('says where the viewer finds each channel: a team of theirs, Personal, or the platform', async () => {
    const DB = fresh();
    const refs = await channelRefs({ DB }, { source: 'slack', tenant: 'E1' }, [
      'see #C0AAAAAAAA1, #beta-help, #Gamma and #delta, not #unknown',
    ], me);
    const by = Object.fromEntries(refs.map((r) => [r.id, r]));
    assert.deepEqual(Object.keys(by).sort(), ['C0AAAAAAAA1', 'C0BBBBBBBB2', 'C0CCCCCCCC3', 'C0DDDDDDDD4']);
    // Filed by its latest thread; the link opens in its workspace.
    assert.deepEqual(by.C0AAAAAAAA1, {
      id: 'C0AAAAAAAA1',
      source: 'slack',
      name: 'acme-ops',
      org: 'acme',
      teams: ['ops'],
      personal: false,
      url: 'https://acme-ws.slack.com/archives/C0AAAAAAAA1',
    });
    // Another team's channel the viewer posted in: their personal view has it.
    assert.deepEqual([by.C0BBBBBBBB2.teams, by.C0BBBBBBBB2.personal], [[], true]);
    // Another team's channel, not theirs at all: only on Slack.
    assert.deepEqual([by.C0CCCCCCCC3.teams, by.C0CCCCCCCC3.personal], [[], false]);
    assert.equal(by.C0CCCCCCCC3.url, 'https://slack.com/archives/C0CCCCCCCC3');
    // Known to opspile, but no threads yet: no team, no customer.
    assert.deepEqual([by.C0DDDDDDDD4.org, by.C0DDDDDDDD4.teams], [null, []]);
  });

  it('follows the channel to the teams it is shared with', async () => {
    const DB = fresh();
    DB.sqlite.exec(`INSERT INTO channel_teams (source, channel_id, team, added_at)
      VALUES ('slack', 'C0CCCCCCCC3', 'ops', '2026-10-03')`);
    const [ref] = await channelRefs({ DB }, { source: 'slack', tenant: 'E1' }, ['#gamma'], me);
    assert.deepEqual(ref.teams, ['ops']);
  });

  it('names the channel ids in inbox titles and last texts, in their own workspace', async () => {
    const DB = fresh();
    const rows = [
      {
        thread: 'slack:E1:C0X:1.0', source: 'slack', title: 'New channel: #C0AAAAAAAA1.', last_text: 'see #C0ZZZZZZZZ9',
      },
      { thread: 'slack:E2:C0Y:1.0', source: 'slack', title: 'Other workspace: #C0AAAAAAAA1' },
      { thread: 'teams:T1:g:c:1', source: 'teams', title: '#C0AAAAAAAA1' },
    ];
    const named = await nameChannelIds({ DB }, rows);
    assert.equal(named[0].title, 'New channel: #acme-ops.');
    assert.equal(named[0].last_text, 'see #C0ZZZZZZZZ9');
    assert.equal(named[1].title, 'Other workspace: #C0AAAAAAAA1');
    assert.equal(named[2], rows[2]);
    // Nothing to name: no query.
    const none = [{ thread: 'slack:E1:C0X:1.0', source: 'slack', title: 'plain' }];
    assert.equal(await nameChannelIds({ DB: null }, none), none);
  });

  it('asks nothing for texts that name no channel, or on Teams', async () => {
    const DB = {
      prepare() {
        throw new Error('no query expected');
      },
    };
    assert.deepEqual(await channelRefs({ DB }, { source: 'slack', tenant: 'E1' }, ['no refs'], me), []);
    assert.deepEqual(await channelRefs({ DB }, { source: 'teams', tenant: 'T1' }, ['#general'], me), []);
  });
});
