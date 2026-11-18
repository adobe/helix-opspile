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
import { armOf, armTags, COMPACT } from '../src/experiments.js';
import {
  armCompact, COMPACT_IDLE_SECONDS, COMPACT_INSTRUCTIONS, COMPACT_MIN_TOKENS, compactIdle,
  compacting, contextTokens,
} from '../src/agent/idlecompact.js';

// Made-up thread keys only.
const names = Array.from({ length: 400 }, (_, i) => `slack:T0000:C${2000 + i}:${1790000000 + i * 41}.000100`);
const DURING = Date.parse('2026-11-25T12:00:00Z');
const IDLE = names.find((n) => armOf(COMPACT, n, DURING).id === 'idle');
const OFF = names.find((n) => armOf(COMPACT, n, DURING).id === 'off');
const ENV = {
  AGENT_MODEL: 'made-up',
  AGENT_BASE_URL: 'https://made-up.example',
  BEDROCK_API_KEY: 'made-up',
};

const at = (t) => new Date(t).getTime();
const user = (t) => ({ kind: 'pi.user', model: [{ role: 'user', content: 'new messages', timestamp: at(t) }] });
const answer = (t, totalTokens) => ({
  kind: 'pi.assistant',
  model: [{
    role: 'assistant', stopReason: 'stop', content: [], timestamp: at(t), usage: { totalTokens },
  }],
});
const summary = (t) => ({ kind: 'pi.compaction', model: [{ role: 'user', content: 'summary', timestamp: at(t) }] });

/** A ThreadAgent as far as idle compaction goes: its storage, schedules and harness. */
function fakeAgent(name, { entries = [], pending = [] } = {}) {
  const kept = new Map();
  return {
    name,
    env: ENV,
    kept,
    schedules: [],
    cancelled: [],
    compacted: [],
    ctx: {
      storage: {
        get: async (k) => kept.get(k),
        put: async (k, v) => { kept.set(k, v); },
        delete: async (k) => kept.delete(k),
      },
    },
    async schedule(when, callback, payload) {
      const id = `s${this.schedules.length}`;
      this.schedules.push({
        id, when, callback, payload,
      });
      return { id };
    },
    async cancelSchedule(id) {
      this.cancelled.push(id);
      return true;
    },
    harness: {
      pending: async () => pending,
      messages: async () => entries,
    },
    async compactRoot(instructions) {
      this.compacted.push(instructions);
      return 'completed';
    },
  };
}

describe('the compaction experiment', () => {
  it('splits the threads in two for two weeks, and leaves knowledge-base agents out', () => {
    assert.equal(Date.parse(COMPACT.until) - Date.parse(COMPACT.from), 14 * 86400000);
    const counts = {};
    for (const n of names) {
      const a = armOf(COMPACT, n, DURING);
      counts[a.id] = (counts[a.id] || 0) + 1;
    }
    assert.ok(Math.abs(counts.idle - counts.off) < 60, JSON.stringify(counts));
    assert.equal(armOf(COMPACT, 'kb:helix:acme', DURING), null);
    assert.equal(compacting(IDLE, ENV, Date.parse(COMPACT.until)), false);
    assert.equal(compacting(IDLE, ENV, DURING), true);
    assert.equal(compacting(OFF, ENV, DURING), false);
  });

  it('tags model use with the arm, both arms', () => {
    assert.match(armTags(IDLE, DURING, ENV), /#compact=idle/);
    assert.match(armTags(OFF, DURING, ENV), /#compact=off/);
    assert.doesNotMatch(armTags(IDLE, Date.parse(COMPACT.until), ENV), /compact/);
  });
});

describe('compacting an idle thread', () => {
  it('counts the context of the latest request, none from before the compaction heading it', () => {
    assert.equal(contextTokens([]), 0);
    assert.equal(contextTokens([user('2026-11-25T10:00:00Z'), answer('2026-11-25T10:01:00Z', 150000)]), 150000);
    assert.equal(contextTokens([
      summary('2026-11-25T11:00:00Z'), user('2026-11-25T10:00:00Z'), answer('2026-11-25T10:01:00Z', 150000),
    ]), 0);
    assert.equal(contextTokens([
      summary('2026-11-25T11:00:00Z'), answer('2026-11-25T10:01:00Z', 150000),
      user('2026-11-25T12:00:00Z'), answer('2026-11-25T12:01:00Z', 31000),
    ]), 31000);
  });

  it('waits 65 minutes from the end of the latest turn, in the idle arm only', async () => {
    const off = fakeAgent(OFF);
    await armCompact(off, DURING);
    assert.deepEqual(off.schedules, []);
    const agent = fakeAgent(IDLE);
    await armCompact(agent, DURING);
    await armCompact(agent, DURING + 60000);
    assert.equal(COMPACT_IDLE_SECONDS, 65 * 60);
    assert.deepEqual(agent.schedules.map((s) => [s.when, s.callback]), [
      [COMPACT_IDLE_SECONDS, 'compactIdle'], [COMPACT_IDLE_SECONDS, 'compactIdle'],
    ]);
    assert.deepEqual(agent.cancelled, ['s0']);
    assert.equal(agent.kept.get('compact-idle').schedule, 's1');
  });

  it('compacts a large idle context once, with the thread\'s instructions', async () => {
    const entries = [user('2026-11-25T10:00:00Z'), answer('2026-11-25T10:01:00Z', 230000)];
    const agent = fakeAgent(IDLE, { entries });
    await armCompact(agent, DURING);
    const { payload } = agent.schedules[0];
    assert.deepEqual(await compactIdle(agent, payload, DURING), { compacted: 'completed', tokens: 230000 });
    assert.deepEqual(agent.compacted, [COMPACT_INSTRUCTIONS]);
    assert.deepEqual(await compactIdle(agent, payload, DURING), { skipped: 'superseded' });
    assert.equal(agent.compacted.length, 1);
  });

  it('leaves a small context, a busy agent and an earlier wait alone', async () => {
    const small = fakeAgent(IDLE, { entries: [answer('2026-11-25T10:01:00Z', COMPACT_MIN_TOKENS - 1)] });
    await armCompact(small, DURING);
    assert.deepEqual(await compactIdle(small, small.schedules[0].payload, DURING), {
      skipped: 'small', tokens: COMPACT_MIN_TOKENS - 1,
    });
    const busy = fakeAgent(IDLE, {
      entries: [answer('2026-11-25T10:01:00Z', 300000)],
      pending: [{ operationId: 'deliver:1', session: '0', status: 'queued' }],
    });
    await armCompact(busy, DURING);
    assert.deepEqual(await compactIdle(busy, busy.schedules[0].payload, DURING), { skipped: 'busy' });
    const again = fakeAgent(IDLE, { entries: [answer('2026-11-25T10:01:00Z', 300000)] });
    await armCompact(again, DURING);
    await armCompact(again, DURING + 1000);
    assert.deepEqual(await compactIdle(again, again.schedules[0].payload, DURING), { skipped: 'superseded' });
    assert.deepEqual(await compactIdle(again, again.schedules[1].payload, Date.parse(COMPACT.until)), { skipped: 'off' });
    assert.deepEqual([small, busy, again].flatMap((a) => a.compacted), []);
  });
});
