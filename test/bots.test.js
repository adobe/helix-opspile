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
  botIconPath, installedBots, syncInstalledBots, teamsBotIcon,
} from '../src/bots.js';
import { recordBots } from '../src/normalizer.js';
import { mentionable } from '../src/post.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up ids and names only.
const T = 'T';
const APP = '00000000-0000-4000-8000-000000000001';
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const app = (botId, displayName) => ({
  id: `inst-${displayName}`,
  teamsAppDefinition: { displayName, ...(botId ? { bot: { id: botId } } : { bot: null }) },
});

/** A fake Graph: installed apps by Teams team id, or a status for the whole team. */
function fakeGraph(teams) {
  const calls = [];
  const graph = async (path) => {
    calls.push(path);
    const m = path.match(/^\/teams\/([^/]+)\/installedApps\?\$expand=teamsAppDefinition\(\$expand=bot\)(&page=2)?$/);
    assert.ok(m, `unexpected ${path}`);
    const team = teams[decodeURIComponent(m[1])];
    if (typeof team === 'number') {
      return Response.json({ error: { code: 'Forbidden', message: 'no' } }, { status: team });
    }
    if (team.pages && !m[2]) {
      return Response.json({ value: team.pages[0], '@odata.nextLink': `${path}&page=2` });
    }
    return Response.json({ value: team.pages ? team.pages[1] : team });
  };
  return { graph, calls };
}

function env() {
  const DB = d1();
  const channel = (id, group) => DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id,
    name, group_id, fetched_at) VALUES ('teams', ?, ?, ?, ?, '2026-10-20T00:00:00Z')`)
    .run(T, id, id, group);
  channel('19:a', 'G1');
  channel('19:b', 'G1');
  channel('19:c', 'G2');
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
    path, any_at, updated_at) VALUES ('teams:T:G1:19:a:1', 'teams', ?, '19:a', '1', 'acme', 'helix',
    'p/', '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z')`).run(T);
  return { DB, MS_TENANT_ID: T };
}

const rows = (e) => e.DB.rows(`SELECT b.bot_id, b.group_id, b.at, b.installed, i.name, i.handle
  FROM bot_teams b JOIN identities i ON i.source = b.source AND i.tenant = b.tenant
    AND i.user_id = b.bot_id ORDER BY b.group_id, b.bot_id`);

describe('installedBots', () => {
  it('keeps the apps with a bot, across pages', async () => {
    const { graph } = fakeGraph({
      G1: { pages: [[app('b-1', 'helper'), app(null, 'A tab')], [app('b-2', 'other')]] },
    });
    assert.deepEqual(await installedBots(graph, 'G1'), {
      bots: [{ id: 'b-1', name: 'helper' }, { id: 'b-2', name: 'other' }],
    });
  });

  it('reports a failed request', async () => {
    const { graph } = fakeGraph({ G1: 404 });
    assert.deepEqual(await installedBots(graph, 'G1'), { status: 404, error: 'Forbidden: no' });
  });
});

describe('syncInstalledBots', () => {
  it('makes a bot mentionable in a Teams team before anyone has mentioned it there', async () => {
    const e = env();
    const inTeam = () => true;
    // A name nobody matches lists the Teams team's members again: nobody here.
    const learn = { graph: async () => Response.json({ value: [] }) };
    const names = async () => (await (await mentionable(e, 'teams:T:G1:19:a:1', 'help', inTeam, { learn }))
      .json()).people.filter((p) => p.kind === 'bot').map((p) => p.name);
    assert.deepEqual(await names(), []);

    const { graph, calls } = fakeGraph({ G1: [app('b-1', 'helper')], G2: [app('b-1', 'helper')] });
    assert.deepEqual(await syncInstalledBots(e, { graph, now: NOW }), {
      teams: 2, bots: 2, removed: 0, failed: 0,
    });
    // One request per Teams team, not per channel.
    assert.equal(calls.length, 2);
    assert.deepEqual(await names(), ['helper']);
  });

  it('keeps what messages taught, and drops a bot only the list knew once it is uninstalled', async () => {
    const e = env();
    // Seen in a message in G1, under the name it posts as and the handle it was mentioned by.
    await recordBots(e, {
      source: 'teams',
      tenant: T,
      groupId: 'G1',
      at: '2026-10-22T09:00:00Z',
      authorRef: { kind: 'bot', name: 'helper-agent', botId: 'b-1' },
      botMentions: [{ id: 'b-1', name: 'help' }],
    });
    const first = fakeGraph({ G1: [app('b-1', 'helper'), app('b-2', 'other')], G2: [app('b-2', 'other')] });
    await syncInstalledBots(e, { graph: first.graph, now: NOW });
    const at = new Date(NOW).toISOString();
    assert.deepEqual(rows(e), [
      {
        bot_id: 'b-1', group_id: 'G1', at: '2026-10-22T09:00:00Z', installed: at, name: 'helper-agent', handle: 'helper',
      },
      {
        bot_id: 'b-2', group_id: 'G1', at: '', installed: at, name: 'other', handle: 'other',
      },
      {
        bot_id: 'b-2', group_id: 'G2', at: '', installed: at, name: 'other', handle: 'other',
      },
    ]);

    // Both uninstalled from G1; G2 fails this time and stays as it was.
    const later = NOW + 20 * 60 * 1000;
    const second = fakeGraph({ G1: [], G2: 500 });
    assert.deepEqual(await syncInstalledBots(e, { graph: second.graph, now: later }), {
      teams: 1, bots: 0, removed: 1, failed: 1,
    });
    assert.deepEqual(rows(e), [
      {
        bot_id: 'b-1', group_id: 'G1', at: '2026-10-22T09:00:00Z', installed: null, name: 'helper-agent', handle: 'helper',
      },
      {
        bot_id: 'b-2', group_id: 'G2', at: '', installed: at, name: 'other', handle: 'other',
      },
    ]);
  });

  it('stops when the app may not list installed apps', async () => {
    const e = env();
    const { graph, calls } = fakeGraph({ G1: 403, G2: [] });
    await assert.rejects(syncInstalledBots(e, { graph, now: NOW }), /installedApps 403 Forbidden: no/);
    assert.equal(calls.length, 1);
  });

  it('gives a bot its app\'s icon, of the version installed, and keeps the name it posts as', async () => {
    const e = env();
    const versioned = (def) => ({
      id: 'inst-helper',
      teamsAppDefinition: {
        id: def, teamsAppId: APP, displayName: 'helper', bot: { id: 'b-1' },
      },
    });
    e.DB.sqlite.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, fetched_at)
      VALUES ('teams', ?, 'b-1', 'bot', 'helper-agent', '2026-10-01T00:00:00Z')`).run(T);
    await syncInstalledBots(e, { graph: fakeGraph({ G1: [versioned('ZGVmIzE=')], G2: [] }).graph, now: NOW });
    const avatar = () => e.DB.rows("SELECT name, avatar FROM identities WHERE user_id = 'b-1'")[0];
    assert.deepEqual(avatar(), { name: 'helper-agent', avatar: botIconPath(APP, 'ZGVmIzE=') });
    assert.equal(avatar().avatar, `/api/bots/icon?app=${APP}&def=ZGVmIzE%3D`);
    // A new version: a new definition, a new URL.
    await syncInstalledBots(e, { graph: fakeGraph({ G1: [versioned('ZGVmIzI=')], G2: [] }).graph, now: NOW });
    assert.equal(avatar().avatar, botIconPath(APP, 'ZGVmIzI='));
    // Listed without the ids: the picture stays.
    await syncInstalledBots(e, { graph: fakeGraph({ G1: [app('b-1', 'helper')], G2: [] }).graph, now: NOW });
    assert.equal(avatar().avatar, botIconPath(APP, 'ZGVmIzI='));
  });

  it('does nothing without Teams channels', async () => {
    const e = { DB: d1(), MS_TENANT_ID: T };
    assert.deepEqual(await syncInstalledBots(e, { graph: () => assert.fail('no call'), now: NOW }), {
      teams: 0, bots: 0, removed: 0, failed: 0,
    });
  });
});

describe('teamsBotIcon', () => {
  const DEF = 'ZGVmIzE=';
  const url = (id = APP, def = DEF) => new URL(`https://opspile.test${botIconPath(id, def) || '/api/bots/icon?app=x&def=y'}`);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  /** A fake Graph whose colorIcon names `webUrl`, and whose hosted content is `icon`. */
  const graphWith = (webUrl, icon = { type: 'image/png', bytes: PNG }) => {
    const calls = [];
    const graph = async (path, init = {}) => {
      calls.push(path);
      if (path.endsWith('/colorIcon')) {
        return Response.json({ webUrl });
      }
      assert.equal(init.headers.accept, 'image/*');
      return new Response(icon.bytes, { headers: { 'content-type': icon.type } });
    };
    return { graph, calls };
  };
  const fakeCache = () => {
    const kept = new Map();
    return {
      kept,
      match: async (req) => kept.get(req.url)?.clone(),
      put: async (req, res) => { kept.set(req.url, res); },
    };
  };

  it('passes on the hosted icon of an app of the tenant\'s own, fetched with the token', async () => {
    const hosted = `https://graph.microsoft.com/beta/appCatalogs/teamsApps/${APP}/appDefinitions/${DEF}/colorIcon/hostedContent/$value`;
    const { graph, calls } = graphWith(hosted);
    const cache = fakeCache();
    const res = await teamsBotIcon({}, url(), { graph, cache });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
    assert.deepEqual(calls, [
      `https://graph.microsoft.com/beta/appCatalogs/teamsApps/${APP}/appDefinitions/ZGVmIzE%3D/colorIcon`,
      hosted,
    ]);
    // Asked again: from the cache, Graph is not.
    const again = await teamsBotIcon({}, url(), { graph: () => assert.fail('no call'), cache });
    assert.deepEqual(new Uint8Array(await again.arrayBuffer()), PNG);
  });

  it('fetches a store app\'s public icon without the token', async () => {
    const { graph, calls } = graphWith('https://icons.example/helper.png');
    const real = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (u, init) => {
      seen.push([String(u), init]);
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    };
    try {
      const res = await teamsBotIcon({}, url(), { graph, cache: null });
      assert.equal(res.status, 200);
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(calls.length, 1);
    assert.deepEqual(seen, [['https://icons.example/helper.png', undefined]]);
  });

  it('passes on no SVG, no other ids and nothing Graph does not give', async () => {
    const hosted = 'https://graph.microsoft.com/beta/hosted/$value';
    const status = async (graph, u = url()) => {
      const res = await quiet(() => teamsBotIcon({}, u, { graph, cache: null }));
      return res.status;
    };
    assert.equal(await status(graphWith(hosted, { type: 'image/svg+xml', bytes: '<svg/>' }).graph), 404);
    assert.equal(await status(() => assert.fail('no call'), url('nope')), 404);
    assert.equal(await status(async () => Response.json({ error: {} }, { status: 403 })), 404);
    assert.equal(await status(graphWith('http://icons.example/helper.png').graph), 404);
  });
});
