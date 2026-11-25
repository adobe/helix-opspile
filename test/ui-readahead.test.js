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

/*
 * What the Teams and Customers pages read ahead (ui/admin.js, `cached`; docs/STATE-MACHINES.md,
 * "Teams and Customers read ahead") and what the agent keeps between its sections (ui/agent.js,
 * `loadMeta`, `loadFiles`): an answer is kept, a failure is not, so a section shown after a
 * passing outage (a 503, D1 overloaded) reads again and shows what is there.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const between = (js, from, to) => {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to}`);
  return js.slice(a, b);
};

/** `cached` and `forget` of ui/admin.js, over a `call` that answers from `answers`, in order. */
function admin(answers) {
  const asked = [];
  const call = async (path) => {
    asked.push(path);
    return answers.shift();
  };
  const Agent = { stale: () => {} };
  // eslint-disable-next-line no-new-func -- the page script, as the browser runs it
  const api = new Function('call', 'Agent', `${between(SCRIPTS['admin.js'], 'const KEEP_MS', '/**\n * Once the section shown')}
    return { cached, forget };`)(call, Agent);
  return { ...api, asked };
}

/** `loadMeta` and `loadFiles` of ui/agent.js, over loaders that answer from `oks`, in order. */
function agent(oks) {
  const state = { repo: 'kb-team-edge', loads: {} };
  const asked = [];
  const load = (name) => async () => {
    asked.push(name);
    return oks.shift();
  };
  const call = async (path) => {
    asked.push(path);
    return oks.shift() ? { ok: true, body: { files: [], hasSystemPrompt: false } } : { ok: false, body: { error: 'busy' } };
  };
  // eslint-disable-next-line no-new-func -- the page script, as the browser runs it
  const api = new Function(
    'state',
    'call',
    'counted',
    'loadChannels',
    'loadMcp',
    'loadTools',
    'loadExtraction',
    `${between(SCRIPTS['agent.js'], 'const META_MAX_AGE', '/**\n * Reads what the page counts')}
    return { loadMeta, loadFiles };`,
  )(state, call, () => {}, load('channels'), load('mcp'), load('tools'), load('extraction'));
  return { ...api, state, asked };
}

describe('reading ahead on the Teams and Customers pages', () => {
  it('keeps an answer, gives each caller a copy, and forgets it on a change', async () => {
    const page = admin([{ ok: true, body: { n: 1 } }, { ok: true, body: { n: 2 } }]);
    const a = await page.cached('/api/admin/team?slug=edge');
    a.body.n = 99;
    assert.equal((await page.cached('/api/admin/team?slug=edge')).body.n, 1);
    assert.equal(page.asked.length, 1);
    page.forget();
    assert.equal((await page.cached('/api/admin/team?slug=edge')).body.n, 2);
    assert.equal(page.asked.length, 2);
  });

  it('keeps no failure, and no answer asked for before a change', async () => {
    const page = admin([{ ok: false, status: 503, body: {} }, { ok: true, body: { n: 1 } },
      { ok: true, body: { n: 2 } }]);
    assert.equal((await page.cached('/api/admin/org?slug=acme')).ok, false);
    const before = page.cached('/api/admin/org?slug=acme');
    page.forget();
    assert.equal((await before).body.n, 1);
    assert.equal((await page.cached('/api/admin/org?slug=acme')).body.n, 2);
    assert.equal(page.asked.length, 3);
  });
});

describe('the agent between its sections', () => {
  it('reads what it counts once while every read succeeded', async () => {
    const a = agent([true, true, true, true]);
    await a.loadMeta('kb-team-edge');
    await a.loadMeta('kb-team-edge');
    assert.deepEqual(a.asked, ['channels', 'mcp', 'tools', 'extraction']);
  });

  it('reads it again after one failed (a 503 from /api/kb/tools)', async () => {
    const a = agent([true, true, false, true, true, true, true, true]);
    await a.loadMeta('kb-team-edge');
    await a.loadMeta('kb-team-edge');
    assert.deepEqual(a.asked, ['channels', 'mcp', 'tools', 'extraction', 'channels', 'mcp', 'tools', 'extraction']);
  });

  it('lists the knowledge base again after a failed listing', async () => {
    const a = agent([false, true]);
    await a.loadFiles('kb-team-edge');
    assert.equal(a.state.filesError, 'busy');
    await a.loadFiles('kb-team-edge');
    assert.deepEqual(a.state.files, []);
    assert.equal(a.state.filesError, null);
    assert.equal(a.asked.length, 2);
  });
});
