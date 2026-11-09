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
  armOf, armTag, CACHE, cacheRetention, running, tagOf, untagged,
} from '../src/experiments.js';
import { retainingApi } from '../src/agent/model.js';

// Made-up thread keys only.
const names = Array.from({ length: 2000 }, (_, i) => `slack:T0000:C${1000 + i}:${1700000000 + i * 37}.000100`);
const DURING = Date.parse('2026-11-10T12:00:00Z');

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
    assert.equal(armTag(short, DURING), '#cache=short');
    for (const at of [Date.parse(CACHE.from) - 1, Date.parse(CACHE.until)]) {
      assert.equal(cacheRetention(short, at), 'long');
      assert.equal(armTag(short, at), '');
    }
    assert.equal(armOf(CACHE, 'kb:helix:acme', DURING), null);
    assert.equal(cacheRetention('kb:helix:acme', DURING), 'long');
  });

  it('reads the arm in a metric\'s detail', () => {
    assert.deepEqual(tagOf('us.anthropic.claude-opus-5-5#cache=short'), {
      experiment: 'cache', arm: 'short', detail: 'us.anthropic.claude-opus-5-5',
    });
    assert.equal(tagOf('us.anthropic.claude-opus-5-5'), null);
    assert.equal(untagged('us.anthropic.claude-opus-5-5#cache=long'), 'us.anthropic.claude-opus-5-5');
  });

  it('asks for the retention the agent is in at each request, but none where none was asked', () => {
    const seen = [];
    const api = {
      id: 'x',
      stream: (model, context, options) => seen.push(['stream', options]),
      streamSimple: (model, context, options) => seen.push(['simple', options]),
    };
    let arm = 'long';
    const wrapped = retainingApi(api, () => arm);
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
    assert.equal(retainingApi(api), api);
  });
});
