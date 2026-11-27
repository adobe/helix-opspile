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
import { armIdle } from '../src/agent/delivery.js';
import { opspileExtension } from '../src/agent/tools.js';
import {
  MAX_WAKEUPS, parseAfter, setWakeup, spanText, wakeupDue,
} from '../src/agent/wakeups.js';
import { quiet } from './fakes.js';

const THREAD = 'slack:E1:C1:1792584000.000100';
const NOW = new Date('2026-10-21T10:00:00.000Z');

/** A ThreadAgent as far as wake-ups go: its storage, schedules and harness. */
function fakeAgent({ enabled = true } = {}) {
  const kept = new Map();
  const agent = {
    env: {
      AGENT_CHANNELS: enabled ? 'C1' : '',
      AGENT_MODEL: 'made-up',
      AGENT_BASE_URL: 'https://made-up.example',
      BEDROCK_API_KEY: 'made-up',
      AGENTS: {},
    },
    submitted: [],
    schedules: [],
    cancelled: [],
    kept,
    ctx: {
      storage: {
        get: async (k) => kept.get(k),
        put: async (k, v) => { kept.set(k, v); },
        delete: async (k) => kept.delete(k),
      },
    },
    target: async () => ({
      key: THREAD, kind: 'channel', channelId: 'C1', team: 'helix',
    }),
    syncTools: async () => {},
    syncMcp: async () => {},
    async schedule(when, name, payload) {
      const id = `s${this.schedules.length}`;
      this.schedules.push({
        id, when, name, payload,
      });
      return { id };
    },
    async cancelSchedule(id) {
      this.cancelled.push(id);
      return true;
    },
    harness: {
      submit: async (input, options) => {
        agent.submitted.push([input, options]);
        return { accepted: true };
      },
    },
  };
  return agent;
}

describe('wake-ups an agent sets itself', () => {
  it('reads a duration, or with `time` an ISO time, within a minute and 7 days', () => {
    assert.deepEqual(parseAfter('30m', NOW), { seconds: 1800 });
    assert.deepEqual(parseAfter(' 4H ', NOW), { seconds: 4 * 3600 });
    assert.deepEqual(parseAfter('2d', NOW), { seconds: 2 * 86400 });
    assert.match(parseAfter('2026-10-21T12:00:00Z', NOW).error, /duration \(30m/);
    assert.deepEqual(parseAfter('2026-10-21T12:00:00Z', NOW, { time: true }), { seconds: 7200 });
    assert.match(parseAfter('soon', NOW, { time: true }).error, /ISO 8601/);
    assert.match(parseAfter('0m', NOW).error, /at least a minute/);
    assert.match(parseAfter('8d', NOW).error, /at most 7 days/);
    assert.match(parseAfter(undefined, NOW).error, /duration/);
    assert.deepEqual([spanText(5400), spanText(7200), spanText(172800)], ['90m', '2h', '2d']);
  });

  it('wakes it at the time with its message, once, whatever is posted meanwhile', async () => {
    const agent = fakeAgent();
    agent.kept.set('mark', 'm1');
    const set = await quiet(() => setWakeup(agent, 'after', {
      after: '2h', message: 'Post the PR link from bb in the thread.',
    }, NOW));
    assert.equal(set.wakeup.due, '2026-10-21T12:00:00.000Z');
    assert.deepEqual(set.others, []);
    const [armed] = agent.schedules;
    assert.equal(armed.name, 'wakeupDue');
    assert.equal(armed.when.toISOString(), '2026-10-21T12:00:00.000Z');

    // A message comes: an `after` wake-up stays as it is.
    await armIdle(agent, 'm2');
    assert.deepEqual(agent.cancelled, []);

    assert.equal((await quiet(() => wakeupDue(agent, armed.payload))).result, 'told');
    const [input, options] = agent.submitted[0];
    assert.match(input, /wakeup_after at 2026-10-21T10:00:00.000Z, for 2026-10-21T12:00:00.000Z/);
    assert.match(input, /<wakeup>\nPost the PR link from bb in the thread.\n<\/wakeup>/);
    assert.deepEqual(options, { operationId: `wakeup:${set.wakeup.id}`, whenBusy: 'followUp' });
    assert.equal(agent.kept.has('wakeups'), false);

    assert.equal((await wakeupDue(agent, armed.payload)).result, 'skip');
    assert.equal(agent.submitted.length, 1);
  });

  it('counts an idle one from every later message again', async () => {
    const agent = fakeAgent();
    agent.kept.set('mark', 'm1');
    const { wakeup } = await quiet(() => setWakeup(agent, 'idle', {
      after: '4h', message: 'Ask the customer whether the purge worked.',
    }, NOW));
    const first = agent.schedules.find((s) => s.name === 'wakeupDue');
    assert.deepEqual([first.when, first.payload], [4 * 3600, { id: wakeup.id, mark: 'm1' }]);

    // The wrap-up is armed for the next message, and the wake-up counts from it again.
    await armIdle(agent, 'm2');
    assert.deepEqual(agent.cancelled, [first.id]);
    const again = agent.schedules.filter((s) => s.name === 'wakeupDue')[1];
    assert.deepEqual([again.when, again.payload], [4 * 3600, { id: wakeup.id, mark: 'm2' }]);
    assert.ok(agent.schedules.some((s) => s.name === 'idle'));

    assert.equal((await wakeupDue(agent, first.payload)).result, 'skip');
    assert.equal((await quiet(() => wakeupDue(agent, again.payload))).result, 'told');
    assert.match(agent.submitted[0][0], /wakeup_after_idle .*nothing has been posted in the thread for 4h/);
    assert.match(agent.submitted[0][0], /Ask the customer whether the purge worked/);
  });

  it('refuses a wake-up without a message, past its limits, or past the ones waiting', async () => {
    const agent = fakeAgent();
    assert.match((await setWakeup(agent, 'after', { after: '1h' }, NOW)).error, /Give the message/);
    assert.match((await setWakeup(agent, 'after', { after: '1h', message: 'x'.repeat(1001) }, NOW)).error, /at most 1000/);
    assert.match((await setWakeup(agent, 'idle', { after: '9d', message: 'x' }, NOW)).error, /at most 7 days/);
    for (let i = 0; i < MAX_WAKEUPS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await quiet(() => setWakeup(agent, 'after', { after: `${i + 1}h`, message: `check ${i}` }, NOW));
    }
    const full = await setWakeup(agent, 'after', { after: '1h', message: 'one more' }, NOW);
    assert.match(full.error, /5 of your wake-ups are waiting already/);
    assert.match(full.error, /check 4/);
    assert.equal(agent.kept.get('wakeups').length, MAX_WAKEUPS);
  });

  it('drops a wake-up that is due once the agent is turned off', async () => {
    const agent = fakeAgent({ enabled: false });
    await quiet(() => setWakeup(agent, 'after', { after: '1h', message: 'check' }, NOW));
    const { payload } = agent.schedules[0];
    assert.deepEqual(await wakeupDue(agent, payload), { result: 'skip', reason: 'no agent' });
    assert.equal(agent.submitted.length, 0);
    assert.equal(agent.kept.has('wakeups'), false);
  });

  it('are tools of a thread\'s agent, which list the ones waiting', async () => {
    const agent = fakeAgent();
    const ctx = {
      env: agent.env,
      hasThread: true,
      target: agent.target,
      verdicts: async () => new Map(),
      wakeup: (kind, args) => setWakeup(agent, kind, args, NOW),
    };
    const tools = Object.fromEntries(opspileExtension(ctx).tools.map((t) => [t.name, t]));
    const run = async (name, args) => {
      const res = await quiet(() => tools[name].execute(args, {}));
      return { text: res.output.map((o) => o.text).join(''), error: Boolean(res.isError) };
    };
    const first = await run('wakeup_after', { after: '2h', message: 'Post the PR link.' });
    assert.equal(first.error, false);
    assert.match(first.text, /you will be woken at 2026-10-21T12:00:00.000Z with your message, once\.$/);
    const second = await run('wakeup_after_idle', { after: '1d', message: 'Wrap up the purge question.' });
    assert.match(second.text, /once nothing has been posted for 1d \(2026-10-22T10:00:00.000Z if nothing is\)/);
    assert.match(second.text, /Also waiting:\n- [0-9a-f]{8}, at 2026-10-21T12:00:00.000Z: Post the PR link\./);
    assert.deepEqual(await run('wakeup_after', { after: 'later', message: 'x' }), {
      text: 'give `after` as a duration from now (30m, 4h, 2d) or an ISO 8601 time. Nothing was set.',
      error: true,
    });

    const filer = opspileExtension({ ...ctx, hasThread: false });
    assert.equal(filer.tools.some((t) => t.name.startsWith('wakeup_')), false);
  });
});
