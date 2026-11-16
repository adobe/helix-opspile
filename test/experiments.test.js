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
  armModel, armOf, armTags, assignedArm, CACHE, cacheRetention, MODEL, running, tagOf, tagsOf,
  untagged,
} from '../src/experiments.js';
import { armApi, fallbackStream, resetUnusable } from '../src/agent/model.js';

// Made-up thread keys only.
const names = Array.from({ length: 2000 }, (_, i) => `slack:T0000:C${1000 + i}:${1700000000 + i * 37}.000100`);
const DURING = Date.parse('2026-11-10T12:00:00Z');
const MODEL_DURING = Date.parse('2026-11-20T12:00:00Z');
const ENV = { AGENT_MODEL: 'us.anthropic.claude-opus-5-5' };

describe('experiments', () => {
  it('runs the cache experiment for a week from midnight UTC', () => {
    assert.equal(Date.parse(CACHE.until) - Date.parse(CACHE.from), 7 * 86400000);
    assert.match(CACHE.from, /T00:00:00Z$/);
    assert.equal(running(CACHE, Date.parse(CACHE.from) - 1), false);
    assert.equal(running(CACHE, Date.parse(CACHE.from)), true);
    assert.equal(running(CACHE, Date.parse(CACHE.until) - 1), true);
    assert.equal(running(CACHE, Date.parse(CACHE.until)), false);
  });

  it('puts half the threads in each arm, each always in the same one', () => {
    const counts = {};
    for (const n of names) {
      const a = armOf(CACHE, n, DURING);
      counts[a.id] = (counts[a.id] || 0) + 1;
      assert.equal(armOf(CACHE, n, DURING + 86400000).id, a.id);
    }
    assert.deepEqual(Object.keys(counts).sort(), ['long', 'short']);
    assert.ok(Math.abs(counts.long - counts.short) < 200, JSON.stringify(counts));
  });

  it('asks for the one-hour cache outside the window and for knowledge bases', () => {
    const short = names.find((n) => armOf(CACHE, n, DURING).id === 'short');
    assert.equal(cacheRetention(short, DURING), 'short');
    assert.equal(armTags(short, DURING), '#cache=short');
    for (const at of [Date.parse(CACHE.from) - 1, Date.parse(CACHE.until)]) {
      assert.equal(cacheRetention(short, at), 'long');
      assert.equal(armTags(short, at), '');
    }
    assert.equal(armOf(CACHE, 'kb:helix:acme', DURING), null);
    assert.equal(cacheRetention('kb:helix:acme', DURING), 'long');
  });

  it('reads the arms in a metric\'s detail', () => {
    assert.deepEqual(tagOf('us.anthropic.claude-opus-5-5#cache=short'), {
      experiment: 'cache', arm: 'short', detail: 'us.anthropic.claude-opus-5-5',
    });
    assert.equal(tagOf('us.anthropic.claude-opus-5-5'), null);
    assert.equal(untagged('us.anthropic.claude-opus-5-5#cache=long'), 'us.anthropic.claude-opus-5-5');
    assert.deepEqual(tagsOf('m#cache=long#model=sonnet').map((t) => [t.experiment, t.arm, t.detail]), [
      ['cache', 'long', 'm'], ['model', 'sonnet', 'm'],
    ]);
  });

  it('runs the model experiment for two weeks from midnight UTC, after the cache experiment', () => {
    assert.equal(Date.parse(MODEL.until) - Date.parse(MODEL.from), 14 * 86400000);
    assert.match(MODEL.from, /T00:00:00Z$/);
    assert.ok(MODEL.from >= CACHE.until);
    const counts = {};
    for (const n of names) {
      const a = armOf(MODEL, n, MODEL_DURING, ENV);
      counts[a.id] = (counts[a.id] || 0) + 1;
      assert.equal(assignedArm(MODEL, n).id, a.id);
    }
    assert.ok(Math.abs(counts.opus - counts.sonnet) < 200, JSON.stringify(counts));
  });

  it('runs Sonnet at the deployed model\'s inference profile, only instead of Opus', () => {
    const sonnet = names.find((n) => assignedArm(MODEL, n).id === 'sonnet');
    const opus = names.find((n) => assignedArm(MODEL, n).id === 'opus');
    assert.equal(armModel(ENV, sonnet, MODEL_DURING), 'us.anthropic.claude-sonnet-5-5');
    assert.equal(armModel({ AGENT_MODEL: 'eu.anthropic.claude-opus-5-5' }, sonnet, MODEL_DURING), 'eu.anthropic.claude-sonnet-5-5');
    assert.equal(armModel(ENV, opus, MODEL_DURING), null);
    assert.equal(armTags(sonnet, MODEL_DURING, ENV), '#model=sonnet');
    assert.equal(armTags(opus, MODEL_DURING, ENV), '#model=opus');
    // Not where the deployed model is not Opus, nor outside the window, nor for knowledge bases.
    assert.equal(armModel({ AGENT_MODEL: 'us.anthropic.claude-haiku-5-5' }, sonnet, MODEL_DURING), null);
    assert.equal(armTags(sonnet, MODEL_DURING, { AGENT_MODEL: 'us.anthropic.claude-haiku-5-5' }), '');
    assert.equal(armModel(ENV, sonnet, Date.parse(MODEL.until)), null);
    assert.equal(armModel(ENV, sonnet, Date.parse(MODEL.from) - 1), null);
    assert.equal(armModel(ENV, 'kb:helix:acme', MODEL_DURING), null);
  });

  it('asks for the retention the agent is in at each request, but none where none was asked', () => {
    const seen = [];
    const api = {
      id: 'x',
      stream: (model, context, options) => seen.push(['stream', options]),
      streamSimple: (model, context, options) => seen.push(['simple', options]),
    };
    let arm = 'long';
    const wrapped = armApi(api, { retention: () => arm });
    wrapped.stream({}, {}, { cacheRetention: 'long', maxTokens: 5 });
    arm = 'short';
    wrapped.streamSimple({}, {}, { cacheRetention: 'long' });
    wrapped.stream({}, {}, { cacheRetention: 'none' });
    wrapped.stream({}, {}, undefined);
    assert.deepEqual(seen, [
      ['stream', { cacheRetention: 'long', maxTokens: 5 }],
      ['simple', { cacheRetention: 'short' }],
      ['stream', { cacheRetention: 'none' }],
      ['stream', { cacheRetention: 'short' }],
    ]);
    assert.equal(wrapped.id, 'x');
    assert.equal(armApi(api), api);
  });

  /** A stream of `events`, as pi-ai's are. */
  const streamOf = (events) => ({
    async* [Symbol.asyncIterator]() {
      yield* events;
    },
  });
  const failed = (errorMessage) => ({ type: 'error', reason: 'error', error: { stopReason: 'error', errorMessage } });
  const collect = async (s) => {
    const out = [];
    for await (const e of s) {
      out.push(e);
    }
    return out;
  };

  it('asks the arm\'s model as itself, and the session\'s when it cannot be used', async () => {
    resetUnusable();
    const asked = [];
    let refuse = true;
    const api = {
      stream: (model) => {
        asked.push(model.id);
        if (model.id.includes('sonnet')) {
          // As itself: its prices and limits, at the session model's address.
          assert.equal(model.cost.input, 2);
          assert.equal(model.baseUrl, 'https://gateway.example');
        }
        if (refuse && model.id.includes('sonnet')) {
          return streamOf([failed('403 AccessDeniedException: You don\'t have access to the model with the specified model ID.')]);
        }
        return streamOf([{ type: 'start' }, { type: 'done', message: { model: model.id } }]);
      },
    };
    const env = { ...ENV, AI_GATEWAY_ACCOUNT: 'a', AGENT_GATEWAY: 'g' };
    const base = { id: ENV.AGENT_MODEL, baseUrl: 'https://gateway.example' };
    const logs = [];
    const { log } = console;
    console.log = (line) => logs.push(line);
    try {
      const wrapped = armApi(api, { env, model: () => 'us.anthropic.claude-sonnet-5-5' });
      const events = await collect(wrapped.stream(base, {}, {}));
      assert.deepEqual(events.map((e) => e.type), ['start', 'done']);
      assert.equal(events[1].message.model, ENV.AGENT_MODEL);
      assert.deepEqual(asked, ['us.anthropic.claude-sonnet-5-5', ENV.AGENT_MODEL]);
      assert.match(logs[0], /model unusable/);
      // Not asked again for a while.
      refuse = false;
      await collect(wrapped.stream(base, {}, {}));
      assert.deepEqual(asked.slice(2), [ENV.AGENT_MODEL]);
      resetUnusable();
      const again = await collect(wrapped.stream(base, {}, {}));
      assert.equal(again[1].message.model, 'us.anthropic.claude-sonnet-5-5');
    } finally {
      console.log = log;
    }
  });

  it('passes other failures of the arm\'s model as they are', async () => {
    const overloaded = failed('529 overloaded');
    let fell = false;
    const events = await collect(fallbackStream(
      () => streamOf([overloaded]),
      () => streamOf([{ type: 'done', message: {} }]),
      () => { fell = true; },
    ));
    assert.deepEqual(events, [overloaded]);
    assert.equal(fell, false);
    // Nor once the answer has started.
    const late = await collect(fallbackStream(
      () => streamOf([{ type: 'start' }, failed('403 access denied')]),
      () => streamOf([{ type: 'done', message: {} }]),
    ));
    assert.deepEqual(late.map((e) => e.type), ['start', 'error']);
  });
});
