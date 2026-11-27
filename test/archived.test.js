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
import {
  afterEach, beforeEach, describe, it,
} from 'node:test';
import { api } from '../src/api.js';
import { sweepChannels } from '../src/channelsweep.js';
import { getChannel, resetSlackDomains } from '../src/lookup.js';
import { isChannelNotice } from '../src/normalize.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up people, channels and slugs only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin'],
};
const viewer = { ...ADA, teams: [{ slug: 'admin' }] };
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-20T12:00:00Z');

function env() {
  const DB = d1({ people: [ADA], teams: [{ slug: 'admin', name: 'Admin' }] });
  return { DB, SLACK_BOT_TOKEN: 'xoxb-made-up' };
}

const channel = (e, id, { fetchedAt = '2026-11-20T00:00:00Z', archivedAt = null, source = 'slack' } = {}) => {
  e.DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, name, domain, fetched_at,
      archived_at) VALUES (?, 'E1', ?, ?, 'example', ?, ?)`).run(source, id, `chan-${id}`, fetchedAt, archivedAt);
  e.DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      kind, channel_name, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, ?, 'E1', ?, '1.1', '_unassigned', 'admin', 'channel', ?, ?, '2026-11-01T00:00:00Z',
      '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 1, '2026-11-01T00:00:00Z')`)
    .run(`${source}:E1:${id}:1.1`, source, id, `chan-${id}`, `channels/_unassigned/admin/${source}-${id}/1.1/`);
};
const row = (e, id) => ({ ...e.DB.sqlite.prepare('SELECT * FROM channels WHERE channel_id = ?').get(id) });

describe('archived channels', () => {
  const realFetch = globalThis.fetch;
  let archived;
  let gone;
  let asked;
  beforeEach(() => {
    archived = new Set();
    gone = new Map([['CGONE', 'channel_not_found']]);
    asked = [];
    resetSlackDomains();
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/conversations.info') {
        const id = u.searchParams.get('channel');
        asked.push(id);
        if (gone.has(id)) {
          return Response.json({ ok: false, error: gone.get(id) });
        }
        return Response.json({
          ok: true,
          channel: {
            id, name: `chan-${id}`, context_team_id: 'T1', is_archived: archived.has(id),
          },
        });
      }
      if (u.pathname === '/api/team.info') {
        return Response.json({ ok: true, team: { id: 'T1', domain: 'example' } });
      }
      if (u.hostname === 'login.microsoftonline.com') {
        const jwt = `x.${btoa(JSON.stringify({ roles: [] }))}.y`;
        return Response.json({ access_token: jwt, expires_in: 3600 });
      }
      const teams = /^\/v1\.0\/teams\/([^/]+)(?:\/channels\/([^/]+))?$/.exec(u.pathname);
      if (teams) {
        const [, team, id] = teams;
        return Response.json(id
          ? { displayName: `chan-${id}`, isArchived: archived.has(id) }
          : { displayName: `team-${team}`, isArchived: archived.has(team) });
      }
      throw new Error(`unexpected ${url}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('are recorded by a lookup, kept from the first one that saw them, and restored', async () => {
    const e = env();
    const ref = { source: 'slack', tenant: 'E1', channelId: 'C1' };
    await getChannel(e, ref, NOW);
    assert.equal(row(e, 'C1').archived_at, null);
    archived.add('C1');
    await getChannel(e, { ...ref, refresh: true }, NOW);
    assert.equal(row(e, 'C1').archived_at, new Date(NOW).toISOString());
    await getChannel(e, { ...ref, refresh: true }, NOW + DAY);
    assert.equal(row(e, 'C1').archived_at, new Date(NOW).toISOString());
    archived.delete('C1');
    await getChannel(e, { ...ref, refresh: true }, NOW + DAY);
    assert.equal(row(e, 'C1').archived_at, null);
  });

  it('are looked up again for a message from after they were archived, not for an older one', async () => {
    const e = env();
    channel(e, 'C1', { archivedAt: '2026-11-20T06:00:00Z' });
    const ref = { source: 'slack', tenant: 'E1', channelId: 'C1' };
    // A replay of a message from before: the row stands.
    await getChannel(e, { ...ref, at: '2026-11-19T00:00:00Z' }, NOW);
    assert.deepEqual(asked, []);
    await getChannel(e, { ...ref, at: '2026-11-20T11:00:00Z' }, NOW);
    assert.deepEqual(asked, ['C1']);
    assert.equal(row(e, 'C1').archived_at, null);
  });

  it('are asked about on a notice of an archive or a restore', () => {
    assert.equal(isChannelNotice({ source: 'slack', subtype: 'channel_archive' }), true);
    assert.equal(isChannelNotice({ source: 'slack', subtype: 'group_unarchive' }), true);
    assert.equal(isChannelNotice({ source: 'slack', subtype: 'channel_join' }), false);
    const notice = (type) => ({ event: { '@odata.type': `#microsoft.graph.${type}EventMessageDetail` } });
    assert.equal(isChannelNotice(notice('teamArchived')), true);
    assert.equal(isChannelNotice(notice('teamUnarchived')), true);
  });

  it('are every channel of a Teams team seen archived', async () => {
    const e = env();
    channel(e, 'M1', { source: 'teams' });
    channel(e, 'M2', { source: 'teams' });
    channel(e, 'M3', { source: 'teams' });
    e.DB.sqlite.prepare("UPDATE channels SET group_id = CASE channel_id WHEN 'M3' THEN 'G2' ELSE 'G1' END").run();
    archived.add('G1');
    await getChannel(e, {
      source: 'teams', tenant: 'E1', channelId: 'M1', refresh: true,
    }, NOW);
    assert.deepEqual(['M1', 'M2', 'M3'].map((id) => Boolean(row(e, id).archived_at)), [true, true, false]);
    // Restored: each channel is restored by its own lookup, as one may be archived on its own.
    archived.delete('G1');
    archived.add('M2');
    await getChannel(e, {
      source: 'teams', tenant: 'E1', channelId: 'M1', refresh: true,
    }, NOW);
    await getChannel(e, {
      source: 'teams', tenant: 'E1', channelId: 'M2', refresh: true,
    }, NOW);
    assert.deepEqual(['M1', 'M2'].map((id) => Boolean(row(e, id).archived_at)), [false, true]);
  });

  it('are found by the sweep, which asks about week-old rows only, failed or not', async () => {
    const e = env();
    const old = new Date(NOW - 8 * DAY).toISOString();
    channel(e, 'C1', { fetchedAt: old });
    channel(e, 'CGONE', { fetchedAt: new Date(NOW - 9 * DAY).toISOString() });
    channel(e, 'C3');
    channel(e, 'P1', { fetchedAt: old, source: 'portal' });
    archived.add('C1');
    const r = await quiet(() => sweepChannels(e, { now: NOW }));
    assert.deepEqual(r, { checked: 2, more: false });
    assert.deepEqual(asked, ['CGONE', 'C1']);
    assert.equal(row(e, 'C1').archived_at, new Date(NOW).toISOString());
    // Not found: gone, so archived, and asked again in a week, not on every run.
    assert.equal(row(e, 'CGONE').checked_at, new Date(NOW).toISOString());
    assert.equal(row(e, 'CGONE').archived_at, new Date(NOW).toISOString());
    const next = await quiet(() => sweepChannels(e, { now: NOW + DAY }));
    assert.deepEqual(next, { checked: 0, more: false });
  });

  it('are the Slack channels the app can no longer read, until a lookup finds them again', async () => {
    const e = env();
    channel(e, 'CX');
    channel(e, 'CY');
    channel(e, 'CZ');
    gone.set('CX', 'channel_not_found');
    // A disconnected Slack Connect channel, the other org's side, in a workspace not granted.
    gone.set('CY', 'team_access_not_granted');
    gone.set('CZ', 'ratelimited');
    const ref = (id) => ({
      source: 'slack', tenant: 'E1', channelId: id, refresh: true,
    });
    await quiet(() => Promise.all(['CX', 'CY', 'CZ'].map((id) => getChannel(e, ref(id), NOW))));
    assert.deepEqual(['CX', 'CY', 'CZ'].map((id) => row(e, id).archived_at), [
      new Date(NOW).toISOString(), new Date(NOW).toISOString(), null]);
    // Kept from the first lookup that found it gone.
    await quiet(() => getChannel(e, ref('CX'), NOW + DAY));
    assert.equal(row(e, 'CX').archived_at, new Date(NOW).toISOString());
    gone.delete('CX');
    await getChannel(e, ref('CX'), NOW + DAY);
    assert.equal(row(e, 'CX').archived_at, null);
  });

  it('are not gone for a message\'s lookup, whatever Slack says', async () => {
    const e = env();
    channel(e, 'CX', { fetchedAt: '2026-11-01T00:00:00Z' });
    gone.set('CX', 'channel_not_found');
    await quiet(() => getChannel(e, {
      source: 'slack', tenant: 'E1', channelId: 'CX', at: '2026-11-20T11:00:00Z',
    }, NOW));
    assert.deepEqual(asked, ['CX']);
    assert.equal(row(e, 'CX').archived_at, null);
  });

  it('are not on the admin pages', async () => {
    const e = env();
    channel(e, 'C1');
    channel(e, 'C2', { archivedAt: '2026-11-20T06:00:00Z' });
    const call = async (path) => {
      const url = new URL(`https://opspile.example${path}`);
      const res = await api(new Request(url), e, url, { viewer });
      return res.json();
    };
    const teams = await call('/api/admin/teams');
    assert.equal(teams.teams.find((t) => t.slug === 'admin').channels, 1);
    const team = await call('/api/admin/team?slug=admin');
    assert.deepEqual(team.channels.map((c) => c.channelId), ['C1']);
    const found = await call('/api/admin/channels?q=chan');
    assert.deepEqual(found.channels.map((c) => c.channelId), ['C1']);
  });
});
