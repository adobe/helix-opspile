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
import {
  joinOnEvent, joinPublicChannels, joinTeams, RETRY_MS,
} from '../src/autojoin.js';
import { d1 } from './d1.js';

// Made-up ids and names only.
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const ch = (id, name, more = {}) => ({
  id, name, is_member: false, created: Number(id.replace(/\D/g, '')), ...more,
});

/** A fake Slack Web API: channels by team, two pages each; joins answered from `refuse`. */
function fakeSlack(byTeam, refuse = {}) {
  const calls = [];
  const slack = async (method, params) => {
    calls.push([method, params]);
    if (method === 'conversations.list') {
      assert.equal(params.types, 'public_channel');
      const list = byTeam[params.team_id] || [];
      const half = Math.ceil(list.length / 2);
      return params.cursor
        ? { ok: true, channels: list.slice(half) }
        : { ok: true, channels: list.slice(0, half), response_metadata: { next_cursor: half < list.length ? 'p2' : '' } };
    }
    assert.equal(method, 'conversations.join');
    if (refuse[params.channel]) {
      throw new Error(`slack conversations.join: ${refuse[params.channel]}`);
    }
    return { ok: true };
  };
  return { slack, calls, joins: () => calls.filter(([m]) => m === 'conversations.join').map(([, p]) => p.channel) };
}

const env = (more = {}) => ({
  DB: d1({
    rules: [{
      id: 1, target: 'kind', priority: 10, field: 'name', pattern: '^random$', value: 'ignore',
    }],
  }),
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_JOIN_TEAMS: 'T1, T2',
  ...more,
});

describe('joinTeams', () => {
  it('reads the comma-separated workspace ids', () => {
    assert.deepEqual(joinTeams({ SLACK_JOIN_TEAMS: ' T1,,T2 ' }), ['T1', 'T2']);
    assert.deepEqual(joinTeams({}), []);
  });
});

describe('joinPublicChannels', () => {
  it('is off without SLACK_JOIN_TEAMS', async () => {
    const { slack, calls } = fakeSlack({});
    assert.deepEqual(await joinPublicChannels(env({ SLACK_JOIN_TEAMS: '' }), { slack }), { off: true });
    assert.equal(calls.length, 0);
  });

  it('joins the public channels it is not in, oldest first, across workspaces and pages', async () => {
    const { slack, joins } = fakeSlack({
      T1: [ch('C3', 'aem-acme'), ch('C1', 'aem-beta', { is_member: true }), ch('C2', 'random'), ch('C5', 'aso-gamma')],
      T2: [ch('C4', 'commerce-delta')],
    });
    const r = await joinPublicChannels(env(), { slack, now: NOW });
    assert.deepEqual(joins(), ['C3', 'C5', 'C4']); // C1 already in, C2 ignored by the rules
    assert.deepEqual(r, {
      teams: 2, missing: 3, refused: 0, joined: 3, failed: {}, left: 0,
    });
  });

  it('stops at the limit and at a rate limit', async () => {
    const list = [ch('C1', 'a'), ch('C2', 'b'), ch('C3', 'c'), ch('C4', 'd')];
    const limited = fakeSlack({ T1: list });
    assert.equal((await joinPublicChannels(env(), { slack: limited.slack, limit: 2 })).left, 2);
    assert.deepEqual(limited.joins(), ['C1', 'C2']);

    const rated = fakeSlack({ T1: list }, { C2: 'ratelimited' });
    const r = await joinPublicChannels(env(), { slack: rated.slack, now: NOW });
    assert.deepEqual(rated.joins(), ['C1', 'C2']);
    assert.deepEqual(r.failed, { ratelimited: 1 });
    assert.equal(r.left, 2);
  });

  it('remembers channels Slack refuses for a week, and forgets them once joined', async () => {
    const e = env();
    const list = [ch('C1', 'a'), ch('C2', 'b')];
    const first = fakeSlack({ T1: list }, { C1: 'app_cannot_join_channel', C2: 'internal_error' });
    const r = await joinPublicChannels(e, { slack: first.slack, now: NOW });
    assert.deepEqual(r.failed, { app_cannot_join_channel: 1, internal_error: 1 });
    assert.deepEqual(e.DB.sqlite.prepare('SELECT channel_id, error FROM slack_joins').all()
      .map((x) => ({ ...x })), [{ channel_id: 'C1', error: 'app_cannot_join_channel' }]);

    const second = fakeSlack({ T1: list });
    const r2 = await joinPublicChannels(e, { slack: second.slack, now: NOW + 1000 });
    assert.deepEqual(second.joins(), ['C2']); // C1 waits, the transient error does not
    assert.equal(r2.refused, 1);

    const third = fakeSlack({ T1: list });
    await joinPublicChannels(e, { slack: third.slack, now: NOW + RETRY_MS + 1000 });
    assert.deepEqual(third.joins(), ['C1', 'C2']);
    assert.equal(e.DB.sqlite.prepare('SELECT COUNT(*) n FROM slack_joins').get().n, 0);
  });
});

describe('joinOnEvent', () => {
  const created = (team, channel) => ({ team_id: team, event: { type: 'channel_created', channel } });

  it('joins a channel created in one of the workspaces', async () => {
    const { slack, joins } = fakeSlack({});
    assert.deepEqual(
      await joinOnEvent(env(), created('T1', { id: 'C9', name: 'aem-acme' }), { slack }),
      { joined: 'C9' },
    );
    assert.deepEqual(joins(), ['C9']);
  });

  it('joins an unarchived channel', async () => {
    const { slack, joins } = fakeSlack({});
    await joinOnEvent(env(), { team_id: 'T2', event: { type: 'channel_unarchive', channel: 'C8' } }, { slack });
    assert.deepEqual(joins(), ['C8']);
  });

  it('leaves other workspaces, ignored channels and other events alone', async () => {
    const { slack, calls } = fakeSlack({});
    assert.equal(await joinOnEvent(env(), created('T3', { id: 'C9', name: 'aem-acme' }), { slack }), null);
    assert.equal(await joinOnEvent(env(), created('T1', { id: 'C9', name: 'random' }), { slack }), null);
    assert.equal(await joinOnEvent(env(), { team_id: 'T1', event: { type: 'message', channel: 'C9' } }, { slack }), null);
    assert.equal(calls.length, 0);
  });

  it('reports a refusal without throwing', async () => {
    const { slack } = fakeSlack({}, { C9: 'missing_scope' });
    const { warn } = console;
    console.warn = () => {};
    try {
      const r = await joinOnEvent(env(), created('T1', { id: 'C9', name: 'x' }), { slack });
      assert.match(r.error, /missing_scope/);
    } finally {
      console.warn = warn;
    }
  });
});
