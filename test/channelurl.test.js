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
import { channelUrlKey, channelUrlRef, channelUrlRefs } from '../src/channelurl.js';

// Made-up workspaces, channels and ids only.
const TEAMS = 'https://teams.microsoft.com/l/channel/19%3Aabc123def%40thread.tacv2/CDN%20tickets'
  + '?groupId=00000000-0000-0000-0000-000000000001&tenantId=00000000-0000-0000-0000-000000000002';

describe('channel links', () => {
  it('reads a Slack channel link, by its workspace host or its app link', () => {
    assert.deepEqual(channelUrlRef('https://acme-ws.slack.com/archives/C0AAAAAAAA1'), {
      source: 'slack', channel: 'C0AAAAAAAA1', tenant: null, host: 'acme-ws.slack.com',
    });
    assert.deepEqual(channelUrlRef('https://app.slack.com/client/T0AAAAAAAA1/C0AAAAAAAA1/'), {
      source: 'slack', channel: 'C0AAAAAAAA1', tenant: 'T0AAAAAAAA1', host: null,
    });
    // A message's permalink is a message, not the channel (src/slackurl.js).
    assert.equal(channelUrlRef('https://acme-ws.slack.com/archives/C0AAAAAAAA1/p1700000000000001'), null);
    assert.equal(channelUrlRef('https://acme-ws.slack.com/archives/D0AAAAAAAA1'), null);
    assert.equal(channelUrlRef('https://slack.example.com/archives/C0AAAAAAAA1'), null);
  });

  it('reads a Teams channel link, its channel id decoded', () => {
    assert.deepEqual(channelUrlRef(TEAMS), {
      source: 'teams',
      channel: '19:abc123def@thread.tacv2',
      tenant: '00000000-0000-0000-0000-000000000002',
      host: null,
    });
    assert.equal(channelUrlKey(TEAMS.replace('teams.microsoft.com', 'teams.cloud.microsoft')
      .replace(/&/g, '&amp;')), 'teams:19:abc123def@thread.tacv2');
    // A message's link is a message.
    assert.equal(channelUrlRef('https://teams.microsoft.com/l/message/19%3Aabc%40thread.tacv2/1700000000000'), null);
  });

  it('reads a Discord channel link, not a message link', () => {
    assert.deepEqual(channelUrlRef('https://discord.com/channels/1000000000000000001/1100000000000000001'), {
      source: 'discord', channel: '1100000000000000001', tenant: '1000000000000000001', host: null,
    });
    assert.equal(channelUrlRef('https://discord.com/channels/1000000000000000001/1100000000000000001/1200000000000000001'), null);
    assert.equal(channelUrlRef('https://discord.com/channels/@me/1100000000000000001'), null);
  });

  it('finds the channel links in texts, once each, not in code', () => {
    assert.deepEqual(channelUrlRefs([
      `see [the CDN channel](${TEAMS}) and https://acme-ws.slack.com/archives/C0AAAAAAAA1.`,
      'again https://other.slack.com/archives/C0AAAAAAAA1, not `https://acme-ws.slack.com/archives/C0BBBBBBBB2`',
      '```\nhttps://discord.com/channels/1/2\n```',
      null,
    ]).map((r) => `${r.source}:${r.channel}`), ['teams:19:abc123def@thread.tacv2', 'slack:C0AAAAAAAA1']);
  });
});
