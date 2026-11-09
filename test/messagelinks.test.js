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
import { linkedMessage, messageRef, teamsMessageRef } from '../src/messagelinks.js';
import { d1 } from './d1.js';

// Made-up ids only.
const TEAMS_CHANNEL = '19:abc123@thread.tacv2';
const teamsLink = (id, { host = 'teams.microsoft.com', tenant = 'T1' } = {}) => `https://${host}/l/message/`
  + `${encodeURIComponent(TEAMS_CHANNEL)}/${id}?groupId=G1${tenant ? `&tenantId=${tenant}` : ''}`
  + '&parentMessageId=1700000000000';
const slackLink = (channel, id) => `https://acme.slack.com/archives/${channel}/p${id.replace('.', '')}`;

describe('message links', () => {
  it('reads Slack and Teams message links, and nothing else', () => {
    assert.deepEqual(messageRef(slackLink('C0AAAAAAAA1', '1700000000.000001')), {
      source: 'slack', channel: 'C0AAAAAAAA1', id: '1700000000.000001', tenant: null,
    });
    assert.deepEqual(messageRef(teamsLink('1700000000123')), {
      source: 'teams', channel: TEAMS_CHANNEL, id: '1700000000123', tenant: 'T1',
    });
    assert.equal(teamsMessageRef(teamsLink('1700000000123', { host: 'teams.cloud.microsoft', tenant: null })).tenant, null);
    assert.equal(messageRef('https://teams.microsoft.com/l/channel/19%3Aabc/General'), null);
    assert.equal(messageRef('https://teams.example.com/l/message/19%3Aabc/17'), null);
    assert.equal(messageRef('http://teams.microsoft.com/l/message/19%3Aabc/17'), null);
    assert.equal(messageRef('https://docs.example.org/purge'), null);
    assert.equal(messageRef('not a link'), null);
  });

  const fresh = () => {
    const DB = d1({
      teams: [{ slug: 'ops', name: 'Ops' }, { slug: 'other', name: 'Other' }],
      people: [],
    });
    const thread = (source, tenant, channel, root, team) => {
      const key = `${source}:${tenant}:${channel}:${root}`;
      DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org,
          team, path, any_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'acme', ?, 'p', '2026-10-02', '2026-10-02')`)
        .run(key, source, tenant, channel, root, team);
      return key;
    };
    const message = (source, tenant, channel, id, key, extra = {}) => DB.sqlite.prepare(`INSERT
        INTO messages (source, tenant, channel_id, id, thread, at, author, author_key, preview,
          deleted)
      VALUES (?, ?, ?, ?, ?, '2026-10-21T11:43:20.000Z', ?, ?, ?, ?)`)
      .run(
        source,
        tenant,
        channel,
        id,
        key,
        extra.author ?? 'Sam',
        extra.authorKey ?? null,
        extra.preview ?? 'Preview is down.',
        extra.deleted ?? 0,
      );
    const slack = thread('slack', 'E1', 'C0AAAAAAAA1', '1700000000.000001', 'ops');
    message('slack', 'E1', 'C0AAAAAAAA1', '1700000000.000001', slack, { authorKey: 'slack:E1:U1' });
    message('slack', 'E1', 'C0AAAAAAAA1', '1700000000.000002', slack, { deleted: 1 });
    const hidden = thread('slack', 'E1', 'C0BBBBBBBB2', '1700000000.000001', 'other');
    message('slack', 'E1', 'C0BBBBBBBB2', '1700000000.000001', hidden, { preview: 'secret' });
    const teams = thread('teams', 'T1', TEAMS_CHANNEL, '1700000000000', 'ops');
    message('teams', 'T1', TEAMS_CHANNEL, '1700000000123', teams, { author: 'Cy', preview: 'Hi' });
    return { DB, slack, teams };
  };
  const ops = async (teams) => teams.includes('ops');

  it('is the message opspile has, wherever the link is', async () => {
    const { DB, slack, teams } = fresh();
    const link = slackLink('C0AAAAAAAA1', '1700000000.000001');
    const want = {
      source: 'slack',
      channel: 'C0AAAAAAAA1',
      id: '1700000000.000001',
      thread: slack,
      at: '2026-10-21T11:43:20.000Z',
      author: 'Sam',
      authorKey: 'slack:E1:U1',
      preview: 'Preview is down.',
    };
    assert.deepEqual(await linkedMessage({ DB }, link, { near: { source: 'slack', tenant: 'E1' }, canSee: ops }), want);
    // Cited from a Teams thread, or from another workspace: the channel says which workspace.
    assert.deepEqual(await linkedMessage({ DB }, link, { near: { source: 'teams', tenant: 'T1' }, canSee: ops }), want);
    assert.deepEqual(await linkedMessage({ DB }, link, { near: { source: 'slack', tenant: 'E9' }, canSee: ops }), want);
    const cy = await linkedMessage({ DB }, teamsLink('1700000000123'), { canSee: ops });
    assert.deepEqual([cy.source, cy.thread, cy.author, cy.preview], ['teams', teams, 'Cy', 'Hi']);
    // A Teams link without its tenant: the channel's, as for Slack.
    assert.equal((await linkedMessage({ DB }, teamsLink('1700000000123', { tenant: null }), { canSee: ops })).thread, teams);
  });

  it('is nothing for a message the viewer may not see, a deleted one, or one opspile lacks', async () => {
    const { DB } = fresh();
    const look = (address) => linkedMessage({ DB }, address, { near: { source: 'slack', tenant: 'E1' }, canSee: ops });
    assert.equal(await look(slackLink('C0BBBBBBBB2', '1700000000.000001')), null);
    assert.equal(await look(slackLink('C0AAAAAAAA1', '1700000000.000002')), null);
    assert.equal(await look(slackLink('C0AAAAAAAA1', '1700000000.000009')), null);
    assert.equal(await look(teamsLink('1700000000123', { tenant: 'T2' })), null);
    assert.equal(await look('https://docs.example.org/purge'), null);
  });

  it('passes over a workspace where the viewer may not see it, to one where they may', async () => {
    const { DB, slack } = fresh();
    // The same channel and message ids in a second workspace, of a team the viewer is not in.
    const other = 'slack:E2:C0AAAAAAAA1:1700000000.000001';
    DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        path, any_at, updated_at) VALUES (?, 'slack', 'E2', 'C0AAAAAAAA1', '1700000000.000001',
        'acme', 'other', 'p', '2026-10-02', '2026-10-02')`).run(other);
    DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, preview)
      VALUES ('slack', 'E2', 'C0AAAAAAAA1', '1700000000.000001', ?, '2026-10-21T11:43:20.000Z',
        'secret')`).run(other);
    const found = await linkedMessage({ DB }, slackLink('C0AAAAAAAA1', '1700000000.000001'), {
      near: { source: 'slack', tenant: 'E2' }, canSee: ops,
    });
    assert.deepEqual([found.thread, found.preview], [slack, 'Preview is down.']);
  });
});
