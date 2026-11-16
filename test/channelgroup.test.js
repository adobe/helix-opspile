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
import { thread } from '../src/api.js';
import { indexMessage } from '../src/threads.js';
import { d1 } from './d1.js';

// Made-up teams, channels and ids only.
const ME = {
  id: 1, email: 'a@staff.example', name: 'A', teams: [{ slug: 'ops', name: 'Ops' }],
};
const CHANNELS = { list: async () => ({ objects: [] }), get: async () => null };

const say = (DB, source, channelId, rootId) => indexMessage(DB, {
  source,
  tenant: 'T1',
  channelId,
  org: 'acme',
  team: 'ops',
  kind: 'channel',
  counted: true,
  staff: false,
  person: null,
  rootId,
  id: rootId,
  thread: `${source}:T1:${channelId}:${rootId}`,
  at: '2026-10-21T10:00:00Z',
  title: 'Hello',
  channelName: 'Main',
  path: `${rootId}/`,
});

describe('the open thread\'s channel', () => {
  it('names the Teams team its channel is in', async () => {
    const DB = d1({
      teams: [{ slug: 'ops', name: 'Ops' }],
      people: [{
        id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['ops'],
      }],
    });
    DB.sqlite.exec(`INSERT INTO channels (source, tenant, channel_id, name, group_id, group_name,
        fetched_at) VALUES ('teams', 'T1', '19:abc', 'Main', 'G1', 'acme-support', '2026-10-21')`);
    await say(DB, 'teams', '19:abc', '1');
    await say(DB, 'slack', 'C1', '2.0');
    const teams = await thread({ DB, CHANNELS }, ME, 'teams:T1:19:abc:1');
    assert.equal(teams.thread.channel_group, 'acme-support');
    // A channel not looked up yet (no `channels` row) has none.
    const slack = await thread({ DB, CHANNELS }, ME, 'slack:T1:C1:2.0');
    assert.equal(slack.thread.channel_group, null);
  });
});
