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
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { agentTool, toolProblem, toolsFor } from '../src/agent/agenttools.js';
import { agentToolsExtension } from '../src/agent/tools.js';
import {
  gatewayOf, providerOf, searchProblem, webSearch,
} from '../src/agent/websearch.js';
import { Meter } from '../src/cogs/meter.js';
import { costOf } from '../src/cogs/prices.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up teams, channels, threads, pages and request ids only.
const SLACK = 'slack:E1:C1:1792584000.000100';
const target = {
  key: SLACK, team: 'helix', org: 'acme', channelId: 'C1', source: 'slack', threads: [SLACK],
};

/** A Workers AI binding whose `websearch` answers `answer(opts)`, and the calls it got. */
function fakeAI(answer) {
  const calls = [];
  return {
    calls,
    websearch: async (opts) => {
      calls.push(opts);
      return answer(opts);
    },
  };
}

const ITEMS = [
  {
    url: 'https://docs.example/publishing', title: 'Publishing  a page', description: `${'word '.repeat(200)}end`, lastModifiedDate: '2026-11-01',
  },
  { url: 'https://status.example/', description: 'All systems operational' },
  { title: 'no address, left out' },
];

describe('web search', () => {
  it('goes through the deployment\'s gateway and provider, ceramic and AGENT_GATEWAY by default', async () => {
    const AI = fakeAI(() => Response.json({ items: ITEMS, metadata: { query: 'eds publish 404', requestId: 'req-1' } }));
    const res = await webSearch({ AI, AGENT_GATEWAY: 'agents-gw' }, { query: '  eds publish 404 ', limit: 3 });
    assert.deepEqual(AI.calls, [{
      gatewayId: 'agents-gw', query: 'eds publish 404', limit: 3, provider: 'ceramic', byokAlias: undefined,
    }]);
    assert.equal(res.ok, true);
    assert.equal(res.results, 2);
    assert.equal(res.requestId, 'req-1');
    const lines = res.text.split('\n');
    assert.equal(lines[0], '2 results for "eds publish 404":');
    assert.equal(lines[2], '1. Publishing  a page');
    assert.equal(lines[3], 'https://docs.example/publishing');
    // Descriptions are cut, at a word.
    assert.ok(lines[4].length <= 600 && lines[4].endsWith('…'), lines[4]);
    assert.equal(lines[5], 'Modified: 2026-11-01');
    // A result without a title is named by its address.
    assert.match(res.text, /2\. https:\/\/status\.example\/\nhttps:\/\/status\.example\/\nAll systems operational/);

    assert.equal(gatewayOf({}), 'default');
    assert.equal(gatewayOf({ AGENT_GATEWAY: 'a', WEB_SEARCH_GATEWAY: 'w' }), 'w');
    assert.equal(providerOf({ WEB_SEARCH_PROVIDER: ' Linkup ' }), 'linkup');
    await webSearch({ AI, WEB_SEARCH_PROVIDER: 'exa' }, { query: 'q', limit: 50 });
    assert.deepEqual([AI.calls[1].provider, AI.calls[1].gatewayId, AI.calls[1].limit], ['exa', 'default', 10]);
    await webSearch({ AI }, { query: 'q' });
    assert.equal(AI.calls[2].limit, 5);
  });

  it('tells the agent whether to fix the query, retry once, or go on without it', async () => {
    const run = (answer) => webSearch({ AI: fakeAI(answer) }, { query: 'q' });
    let res = await run(() => Response.json({
      ok: false, error: { code: 'web_search_payment_required', status: 402, gatewayRequestId: 'gw-1' },
    }, { status: 402 }));
    assert.equal(res.ok, false);
    assert.deepEqual([res.error.code, res.error.status, res.error.requestId], ['web_search_payment_required', 402, 'gw-1']);
    assert.match(res.text, /does not work here at the moment \(web_search_payment_required\): do not search again/);
    res = await run(() => new Response('busy', { status: 503 }));
    assert.match(res.text, /failed for now \(web_search_unavailable\): you may try once more/);
    res = await run(() => Response.json({ success: false, errors: [{ code: 7000, message: 'query too long' }] }, { status: 400 }));
    assert.match(res.text, /refused \(query too long\): fix the query/);
    res = await webSearch({ AI: fakeAI(() => Response.json({})) }, { query: '   ' });
    assert.match(res.text, /refused \(Query must not be empty\)/);
    // A runtime without web search, and a binding that throws.
    res = await webSearch({ AI: {} }, { query: 'q' });
    assert.equal(res.error.code, 'web_search_unsupported_runtime');
    res = await run(() => {
      throw new Error('network lost');
    });
    assert.deepEqual([res.error.code, res.error.message], ['web_search_unavailable', 'network lost']);
  });

  it('stops when the turn is cancelled', async () => {
    const stop = new AbortController();
    const AI = fakeAI(() => new Promise(() => {}));
    const pending = webSearch({ AI }, { query: 'q' }, { signal: stop.signal });
    stop.abort(new Error('cancelled'));
    await assert.rejects(pending, /cancelled/);
  });

  it('is a switchable tool, on for new teams, that needs the AI binding and a known provider', async () => {
    assert.equal(agentTool('web_search').newTeams, true);
    assert.equal(searchProblem({ AI: {} }), null);
    assert.match(searchProblem({}), /Workers AI binding \(AI\) is missing/);
    assert.match(searchProblem({ AI: {}, WEB_SEARCH_PROVIDER: 'bing' }), /WEB_SEARCH_PROVIDER is bing: it is one of ceramic, linkup, exa/);
    assert.equal(toolProblem({}, 'web_search'), searchProblem({}));

    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix' }] });
    DB.sqlite.exec(`INSERT INTO agent_tool_switches (tool, scope, target, enabled, changed_at)
      VALUES ('web_search', 'team', 'helix', 1, '2026-11-18T00:00:00Z')`);
    assert.deepEqual(await toolsFor({ DB, AI: {} }, target), ['web_search']);
    assert.deepEqual(await toolsFor({ DB }, target), []);
  });

  it('is turned on for every team there is by migration 0077, and stays off where a team turned it off', () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'edge', name: 'Edge' }] });
    DB.sqlite.exec(`INSERT INTO agent_tool_switches (tool, scope, target, enabled, changed_at)
      VALUES ('web_search', 'team', 'edge', 0, '2026-11-17T00:00:00Z')`);
    DB.sqlite.exec(readFileSync(new URL('../migrations/0077_web_search.sql', import.meta.url), 'utf8'));
    const rows = DB.sqlite.prepare(`SELECT target, enabled, changed_by FROM agent_tool_switches
      WHERE tool = 'web_search' ORDER BY target`).all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { target: 'edge', enabled: 0, changed_by: null },
      { target: 'helix', enabled: 1, changed_by: 'migration 0077' },
    ]);
  });

  it('gives the agent web_search with its guidance, and never logs the query', async () => {
    const AI = fakeAI(() => Response.json({ items: ITEMS.slice(0, 1), metadata: { requestId: 'req-2' } }));
    const ext = agentToolsExtension({ env: { AI }, hasThread: true, target: async () => target }, ['web_search']);
    assert.deepEqual(ext.tools.map((t) => t.name), ['web_search']);
    assert.equal(ext.tools[0].replay, 'safe');
    const guide = await ext.sections.find((s) => s.key === 'web-search').render({});
    assert.match(guide, /Every query leaves Adobe/);
    assert.match(guide, /never with the customer's name/);
    assert.match(guide, /give update_draft only pages you read as sources/);

    const logs = [];
    const { log } = console;
    console.log = (line) => logs.push(line);
    let res;
    try {
      res = await ext.tools[0].execute({ query: 'secret customer words', limit: 2 }, {}, {});
    } finally {
      console.log = log;
    }
    assert.equal(res.isError, undefined);
    assert.match(res.output[0].text, /^1 result for "secret customer words":/);
    assert.equal(AI.calls[0].limit, 2);
    assert.deepEqual(logs.map((l) => JSON.parse(l)), [{
      route: 'agent', action: 'web_search', team: 'helix', provider: 'ceramic', results: 1, request: 'req-2',
    }]);

    const broken = agentToolsExtension({
      env: { AI: fakeAI(() => new Response('', { status: 402 })) }, hasThread: true, target: async () => target,
    }, ['web_search']);
    res = await quiet(() => broken.tools[0].execute({ query: 'q' }, {}, {}));
    assert.equal(res.isError, true);
    assert.match(res.output[0].text, /web_search_payment_required/);
  });

  it('is counted for COGS once a search answered, at its provider\'s price', async () => {
    const points = [];
    const USAGE = { writeDataPoint: (p) => points.push(p) };
    let status = 200;
    const m = new Meter({ USAGE, AI: fakeAI(() => Response.json({ items: [] }, { status })) }, { via: 'queue' });
    const env = m.env({ org: 'acme', team: 'helix' });
    await webSearch(env, { query: 'q' });
    await webSearch({ ...env, WEB_SEARCH_PROVIDER: 'linkup' }, { query: 'q' });
    status = 402;
    await webSearch(env, { query: 'q' });
    await m.flush();
    const counted = Object.fromEntries(points.filter((p) => p.blobs[0] === 'web_search')
      .map((p) => [p.blobs[1], p.doubles[0]]));
    assert.deepEqual(counted, { ceramic: 1, linkup: 1 });
    assert.equal(costOf('web_search', 'ceramic', '', 1000), 0.25);
    assert.equal(costOf('web_search', 'exa', '', 1000), 7);
  });
});
