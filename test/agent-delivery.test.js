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
import { formatMessage } from '../src/agent/deliver.js';
import {
  deliver, idle, IDLE_PROMPT, IDLE_SECONDS, verdictsOf,
} from '../src/agent/delivery.js';
import { processKey } from '../src/normalizer.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

const THREAD = 'slack:E1:C1:1792584000.000100';
const ROOT = '1792584000.000100';
const NEXT = '1792584060.000200';
const USERS = {
  U1: {
    id: 'U1', real_name: 'Ada', profile: { email: 'ada@staff.example' }, team_id: 'T1',
  },
  U2: {
    id: 'U2', real_name: 'Cy', profile: { email: 'cy@customer.example' }, team_id: 'T9',
  },
};

function fetchSlack(url) {
  const { pathname, searchParams } = new URL(String(url));
  const reply = {
    '/api/users.info': () => ({ ok: true, user: USERS[searchParams.get('user')] }),
    '/api/conversations.info': () => ({ ok: true, channel: { id: 'C1', name: 'aem-acme', is_channel: true } }),
    '/api/team.info': () => ({ ok: true, team: { domain: 'made-up' } }),
  }[pathname];
  return Response.json(reply ? reply() : { ok: false, error: 'not_found' });
}

function clef(answer) {
  return {
    calls: 0,
    async run() {
      this.calls += 1;
      return answer();
    },
  };
}

function env(AI) {
  return {
    NORMALIZE: { send: async () => {} },
    RAW: fakeBucket(),
    CHANNELS: fakeBucket(),
    DB: d1({
      rules: [
        {
          id: 1, target: 'org', priority: 100, source: null, field: 'name', pattern: '^aem-(.+)$', value: '$1',
        },
        {
          id: 2, target: 'team', priority: 100, source: null, field: 'name', pattern: '^aem-', value: 'helix',
        },
      ],
      people: [{
        id: 7, email: 'ada@staff.example', name: 'Ada Staff', staff: 1, teams: ['helix'],
      }],
      teams: [{ slug: 'helix', name: 'Helix' }],
    }),
    SLACK_BOT_TOKEN: 'xoxb-made-up',
    STAFF_DOMAINS: 'staff.example',
    AGENTS: {},
    AGENT_CHANNELS: 'C1',
    AGENT_MODEL: 'made-up',
    AGENT_BASE_URL: 'https://made-up.example',
    BEDROCK_API_KEY: 'made-up',
    AI,
  };
}

async function ingest(e, messages) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => fetchSlack(url);
  try {
    for (const [i, m] of messages.entries()) {
      const key = `slack/E1/C1/2026/10/21/${m.ts}-Ev${m.ts}.json`;
      // eslint-disable-next-line no-await-in-loop
      await e.RAW.put(key, JSON.stringify({
        type: 'event_callback', enterprise_id: 'E1', team_id: 'T1', event_id: `Ev${i}${m.ts}`, event: { type: 'message', channel: 'C1', ...m },
      }));
      // eslint-disable-next-line no-await-in-loop
      await processKey(e, key);
    }
  } finally {
    globalThis.fetch = real;
  }
}

/** A ThreadAgent as far as delivery goes: its storage, schedules and harness. */
function fakeAgent(e, { problem = false } = {}) {
  const kept = new Map();
  const agent = {
    env: e,
    submitted: [],
    schedules: [],
    cancelled: [],
    ctx: {
      storage: {
        get: async (k) => (Array.isArray(k)
          ? new Map(k.filter((x) => kept.has(x)).map((x) => [x, kept.get(x)])) : kept.get(k)),
        put: async (k, v) => { kept.set(k, v); },
        delete: async (k) => kept.delete(k),
      },
    },
    kept,
    target: async () => ({
      key: THREAD, kind: 'channel', channelId: 'C1', team: 'helix',
    }),
    syncTools: async () => {},
    syncMcp: async () => {},
    syncUploads: async () => {},
    verdicts: (messages) => verdictsOf(agent, messages),
    async schedule(seconds, name, payload) {
      const id = `s${this.schedules.length}`;
      this.schedules.push({
        id, seconds, name, payload,
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
        return { accepted: !problem };
      },
    },
  };
  return agent;
}

const fine = () => ({ answers: { injection: { noul: 0.01 } } });
const down = () => {
  throw new Error('Clef is down');
};

describe('telling a thread agent', () => {
  it('asks about a failed injection check again, and keeps only real verdicts', async () => {
    let answer = down;
    const AI = clef(() => answer());
    const e = env(AI);
    const agent = fakeAgent(e);
    const m = { id: 'm1', body: 'hello', author: { kind: 'person', staff: false } };

    const first = await verdictsOf(agent, [m]);
    assert.equal(first.get('m1').flagged, true);
    assert.equal(first.get('m1').p, null);
    assert.equal(agent.kept.has('verdict:m1'), false);
    assert.match(formatMessage(m, first.get('m1')), /could not run/);

    answer = fine;
    const second = await verdictsOf(agent, [m]);
    assert.equal(second.get('m1').flagged, false);
    assert.equal(agent.kept.get('verdict:m1').p, 0.01);

    await verdictsOf(agent, [m]);
    assert.equal(AI.calls, 2);
  });

  it('checks again what an earlier version kept as a failed check', async () => {
    const AI = clef(fine);
    const agent = fakeAgent(env(AI));
    agent.kept.set('verdict:m1', { p: null, flagged: true, error: 'down' });
    const m = { id: 'm1', body: 'hello', author: { kind: 'person', staff: false } };
    assert.equal((await verdictsOf(agent, [m])).get('m1').flagged, false);
  });

  it('leaves messages unseen while the queue can still retry a failed check', async () => {
    const e = env(clef(down));
    await quiet(() => ingest(e, [{ ts: ROOT, user: 'U2', text: 'Please help' }]));
    const agent = fakeAgent(e);

    await assert.rejects(deliver(agent, { retry: true }), /injection check failed/);
    assert.equal(agent.submitted.length, 0);
    assert.equal(agent.kept.has('mark'), false);

    // The last delivery goes on without them.
    const told = await quiet(() => deliver(agent));
    assert.equal(told.result, 'delivered');
    assert.match(agent.submitted[0][0], /could not run/);
    assert.ok(agent.kept.has('mark'));
  });

  it('tells overlapping pokes about a message once', async () => {
    const e = env(clef(fine));
    await quiet(() => ingest(e, [{ ts: ROOT, user: 'U2', text: 'Please help' }]));
    const agent = fakeAgent(e);
    const results = await quiet(() => Promise.all([deliver(agent), deliver(agent)]));
    assert.deepEqual(results.map((r) => r.result), ['delivered', 'unchanged']);
    assert.equal(agent.submitted.length, 1);
  });

  it('goes on after a poke that failed', async () => {
    const AI = clef(down);
    const e = env(AI);
    await quiet(() => ingest(e, [{ ts: ROOT, user: 'U2', text: 'Please help' }]));
    const agent = fakeAgent(e);
    const failed = deliver(agent, { retry: true });
    const next = deliver(agent);
    await assert.rejects(failed);
    assert.equal((await quiet(() => next)).result, 'delivered');
  });

  it('still wraps up when its own post is the latest message', async () => {
    const e = env(clef(fine));
    await quiet(() => ingest(e, [{ ts: ROOT, user: 'U2', text: 'Please help' }]));
    const agent = fakeAgent(e);
    await quiet(() => deliver(agent));
    const [armed] = agent.schedules;
    assert.equal(armed.seconds, IDLE_SECONDS);
    assert.equal(armed.payload.mark, agent.kept.get('mark'));

    // Its own post comes back: not told, but the wrap-up now counts from it.
    agent.kept.set('posted', [NEXT]);
    await quiet(() => ingest(e, [{
      ts: NEXT, thread_ts: ROOT, bot_id: 'B1', text: 'Answered.',
    }]));
    const own = await quiet(() => deliver(agent));
    assert.deepEqual(own, { result: 'unchanged', own: 1 });
    assert.equal(agent.submitted.length, 1);
    assert.deepEqual(agent.cancelled, [armed.id]);
    const again = agent.schedules[1];
    assert.equal(again.payload.mark, agent.kept.get('mark'));

    await idle(agent, armed.payload);
    assert.equal(agent.submitted.length, 1);
    await idle(agent, again.payload);
    assert.equal(agent.submitted[1][0], IDLE_PROMPT);
    assert.equal(agent.submitted[1][1].whenBusy, 'followUp');
  });
});
