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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  armOf, armTags, assignedArm, DREAM, unitOf,
} from '../src/experiments.js';
import { experimentDrafts } from '../src/cogs/report.js';
import {
  dueDreams, MAX_DREAM_MS, QUIET_MS, runDreams, STARTS_PER_RUN, sweepDreams,
} from '../src/dreams.js';
import {
  dream, dreamOf, dreamPrompt, dreamState,
} from '../src/agent/dream.js';
import { d1 } from './d1.js';

// Made-up customer slugs and channel ids only.
const slugs = Array.from({ length: 400 }, (_, i) => `acme-${i}`);
const NOW = Date.parse('2026-11-25T12:00:00Z');
const DREAMING = slugs.filter((s) => armOf(DREAM, s, NOW).id === 'dream');
const AWAKE = slugs.filter((s) => armOf(DREAM, s, NOW).id === 'off');
const ENV = {
  AGENT_MODEL: 'made-up',
  AGENT_BASE_URL: 'https://made-up.example',
  BEDROCK_API_KEY: 'made-up',
};
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600000;

/** The knowledge-base agents, as the Worker reaches them, answering with `answers`. */
function fakeAgents(answers = {}) {
  const calls = [];
  return {
    calls,
    idFromName: (name) => name,
    get: (name) => ({
      // eslint-disable-next-line no-underscore-dangle
      __unsafe_ensureInitialized: async () => {},
      dream: async (note) => {
        calls.push([name, 'dream', note]);
        return answers.dream ? answers.dream(note) : { ok: true, accepted: true };
      },
      dreamState: async (q) => {
        calls.push([name, 'dreamState', q]);
        return answers.dreamState ? answers.dreamState(q) : { state: 'running' };
      },
    }),
  };
}

/** A customer with a channel quiet since `at` (ms), its kb-org with `entries` concepts. */
function customer(DB, org, at, { entries = 12, channel = `C-${org}`, on = true } = {}) {
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      kind, path, last_at, any_at, updated_at)
    VALUES (?, 'slack', 'E1', ?, '1', ?, 'helix', 'channel', 'p', ?, ?, ?)`)
    .run(`slack:E1:${channel}:1`, channel, org, iso(at), iso(at), iso(at));
  DB.sqlite.prepare(`INSERT INTO knowledge_bases (repo, kind, slug, created_at, entries)
    VALUES (?, 'org', ?, ?, ?) ON CONFLICT DO NOTHING`).run(`kb-org-${org}`, org, iso(at), entries);
  if (on) {
    DB.sqlite.prepare(`INSERT INTO agent_channels (channel_id, enabled, changed_by, changed_at)
      VALUES (?, 1, 'Bo', ?) ON CONFLICT DO NOTHING`).run(channel, iso(at));
  }
}

const envOf = (DB, agents = fakeAgents()) => ({ ...ENV, DB, AGENTS: agents });

describe('the dream experiment', () => {
  it('splits the customers, not the threads, and tags their agents\' use with the arm', () => {
    assert.ok(Math.abs(DREAMING.length - AWAKE.length) < 60, `${DREAMING.length} ${AWAKE.length}`);
    assert.equal(unitOf(DREAM, { name: 'slack:E1:C1:1', org: 'acme-1' }), 'acme-1');
    const org = DREAMING[0];
    assert.match(armTags('slack:E1:C1:1', NOW, ENV, {}, org), /#dream=dream/);
    assert.match(armTags(`kb:helix:${org}`, NOW, ENV, {}, org), /#dream=dream/);
    assert.match(armTags('slack:E1:C1:1', NOW, ENV, {}, AWAKE[0]), /#dream=off/);
    assert.doesNotMatch(armTags('slack:E1:C1:1', NOW, ENV), /dream/);
    assert.doesNotMatch(armTags('slack:E1:C1:1', Date.parse(DREAM.until), ENV, {}, org), /dream/);
  });

  it('counts a customer\'s drafts in its arm', async () => {
    const DB = d1();
    const draft = iso(NOW);
    for (const [org, action] of [[DREAMING[0], 'saved'], [DREAMING[0], 'sent'], [AWAKE[0], 'saved']]) {
      DB.sqlite.prepare(`INSERT INTO draft_events (thread, draft, version, action, by_agent, origin_agent,
          org, team, at) VALUES (?, ?, ?, ?, 0, 1, ?, 'helix', ?)`)
        .run(`slack:E1:C-${org}:1`, draft, draft, action, org, draft);
    }
    const drafts = await experimentDrafts({ DB }, { from: '2026-11-25', to: '2026-11-25' });
    assert.equal(drafts.dream.dream.started, 1);
    assert.equal(drafts.dream.dream.sent, 1);
    assert.equal(drafts.dream.off.started, 1);
    assert.equal(assignedArm(DREAM, DREAMING[0]).id, 'dream');
  });
});

describe('dreams', () => {
  it('is due for a quiet customer in the arm, with a knowledge base and an agent', async () => {
    const DB = d1();
    const [quiet, busy, small, off, old] = DREAMING;
    customer(DB, quiet, NOW - QUIET_MS - HOUR);
    customer(DB, busy, NOW - HOUR);
    customer(DB, small, NOW - QUIET_MS - HOUR, { entries: 2 });
    customer(DB, off, NOW - QUIET_MS - HOUR, { on: false });
    customer(DB, old, NOW - 30 * 24 * HOUR);
    customer(DB, AWAKE[0], NOW - QUIET_MS - HOUR);
    assert.deepEqual(await dueDreams({ ...ENV, DB }, NOW), [{
      org: quiet, team: 'helix', quietSince: iso(NOW - QUIET_MS - HOUR), entries: 12,
    }]);
  });

  it('starts once per quiet spell, asks the customer\'s knowledge-base agent, and spreads them out', async () => {
    const DB = d1();
    const quiet = DREAMING.slice(0, STARTS_PER_RUN + 1);
    quiet.forEach((org, i) => customer(DB, org, NOW - QUIET_MS - (i + 1) * HOUR));
    const agents = fakeAgents();
    assert.deepEqual(await runDreams(envOf(DB, agents), NOW), {
      open: 0, ended: 0, submitted: 0, started: STARTS_PER_RUN,
    });
    const asked = quiet.slice(-STARTS_PER_RUN).reverse().map((org) => [`kb:helix:${org}`, 'dream']);
    assert.deepEqual(agents.calls.map(([name, what]) => [name, what]), asked);
    const rows = DB.rows('SELECT org, submitted_at, entries_before FROM kb_dreams ORDER BY id');
    assert.ok(rows.every((r) => r.submitted_at && r.entries_before === 12));
    // The next run asks the open ones and starts the last.
    const later = NOW + 20 * 60000;
    assert.equal((await runDreams(envOf(DB, agents), later)).started, 1);
    assert.equal(DB.rows('SELECT org FROM kb_dreams').length, STARTS_PER_RUN + 1);
    // No new message: no new dream, also once they ended.
    DB.sqlite.exec(`UPDATE kb_dreams SET ended_at = '${iso(later)}', outcome = 'done'`);
    assert.equal((await runDreams(envOf(DB, agents), later + HOUR)).started, 0);
    // A message, and eight quiet hours after it: the next dream.
    DB.sqlite.prepare('UPDATE threads SET last_at = ?, any_at = ? WHERE org = ?')
      .run(iso(later + HOUR), iso(later + HOUR), quiet[0]);
    assert.equal((await runDreams(envOf(DB, agents), later + 2 * HOUR + QUIET_MS)).started, 1);
  });

  it('ends a dream that settled, asks again one not taken, and gives up after a while', async () => {
    const DB = d1();
    const [a, b, c] = DREAMING;
    // Started in this order, the longest quiet first: dreams 1, 2 and 3.
    [a, b, c].forEach((org, i) => customer(DB, org, NOW - QUIET_MS - (3 - i) * HOUR));
    let refuse = true;
    const agents = fakeAgents({
      dream: ({ id }) => (refuse && id === 2 ? { error: 'missing AGENT_MODEL' } : { ok: true }),
      dreamState: ({ id }) => (id === 1
        ? { state: 'settled', status: 'done', note: 'Merged two.' } : { state: 'running' }),
    });
    await runDreams(envOf(DB, agents), NOW);
    const taken = 'SELECT id, submitted_at IS NOT NULL AS taken, error FROM kb_dreams ORDER BY id';
    assert.deepEqual(DB.rows(taken), [
      { id: 1, taken: 1, error: null },
      { id: 2, taken: 0, error: 'missing AGENT_MODEL' },
      { id: 3, taken: 1, error: null },
    ]);
    refuse = false;
    DB.sqlite.exec(`UPDATE knowledge_bases SET entries = 9 WHERE slug = '${a}'`);
    assert.deepEqual(await sweepDreams(envOf(DB, agents), NOW + 20 * 60000), {
      open: 2, ended: 1, submitted: 1,
    });
    const ended = 'SELECT id, outcome, note, entries_after, error FROM kb_dreams WHERE ended_at IS NOT NULL';
    assert.deepEqual(DB.rows(ended), [
      {
        id: 1, outcome: 'done', note: 'Merged two.', entries_after: 9, error: null,
      },
    ]);
    assert.deepEqual(await sweepDreams(envOf(DB, agents), NOW + MAX_DREAM_MS + 1), {
      open: 0, ended: 2, submitted: 0,
    });
    assert.deepEqual(DB.rows('SELECT outcome FROM kb_dreams ORDER BY id').map((r) => r.outcome), [
      'done', 'timeout', 'timeout',
    ]);
  });

  it('does nothing without agents', async () => {
    assert.deepEqual(await runDreams({ DB: d1() }, NOW), { skipped: 'agents off' });
  });
});

/** A knowledge-base agent as far as dreams go: its storage, sessions and harness. */
function fakeAgent(name = 'kb:helix:acme-1', { pending = [], settled = null } = {}) {
  const kept = new Map();
  const agent = {
    name,
    env: ENV,
    kept,
    submitted: [],
    ctx: {
      storage: {
        get: async (k) => kept.get(k),
        put: async (k, v) => { kept.set(k, v); },
        delete: async (k) => kept.delete(k),
      },
    },
    syncTools: async () => {},
    syncMcp: async () => {},
    harness: {
      sessions: { create: async () => ({ id: `session-${kept.size}` }) },
      submit: async (input, options) => {
        agent.submitted.push([input, options]);
        return { accepted: agent.submitted.length === 1 };
      },
      pending: async () => pending,
      wait: async () => settled,
    },
  };
  return agent;
}

describe('a knowledge-base agent dreaming', () => {
  it('dreams in a session of its own, pinned to kb-org, the same one when asked again', async () => {
    const agent = fakeAgent();
    const now = new Date('2026-11-25T12:00:00Z');
    assert.deepEqual(await dream(agent, { id: 7, now }), { ok: true, accepted: true });
    assert.deepEqual(await dream(agent, { id: 7, now }), { ok: true, accepted: false });
    const [[input, options], [, again]] = agent.submitted;
    assert.equal(input, dreamPrompt('2026-11-25'));
    assert.match(input, /^It is 2026-11-25/);
    assert.deepEqual(options, { operationId: 'dream:7', session: 'session-0', whenBusy: 'followUp' });
    assert.deepEqual(again, options);
    assert.equal(agent.kept.get('seed-pin:session-0'), 'org');
    assert.equal(await dreamOf(agent, 'session-0'), '7');
    assert.equal(await dreamOf(agent, 'another'), null);
  });

  it('is only a knowledge-base agent\'s, with a model', async () => {
    assert.match((await dream(fakeAgent('slack:E1:C1:1'), { id: 1 })).error, /knowledge-base agent/);
    const agent = fakeAgent();
    agent.env = {};
    assert.match((await dream(agent, { id: 1 })).error, /missing/);
  });

  it('says where a dream stands', async () => {
    assert.deepEqual(await dreamState(fakeAgent(), { id: 7 }), { state: 'unknown' });
    const running = fakeAgent('kb:helix:acme-1', { pending: [{ operationId: 'dream:7', status: 'running' }] });
    await dream(running, { id: 7 });
    assert.deepEqual(await dreamState(running, { id: 7 }), { state: 'running' });
    const done = fakeAgent('kb:helix:acme-1', { settled: { status: 'done', text: 'Merged two contacts.' } });
    await dream(done, { id: 7 });
    assert.deepEqual(await dreamState(done, { id: 7 }), { state: 'settled', status: 'done', note: 'Merged two contacts.' });
  });
});
