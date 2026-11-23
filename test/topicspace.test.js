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
import { parts, principal, topicPlaces } from '../src/topicspace.js';

const unit = (v) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
const axis = (d, k = 1, dims = 8) => Array.from({ length: dims }, (_, i) => (i === d ? k : 0));
const plus = (...vs) => vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0));
const dist = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));

describe('the topics\' places (src/topicspace.js)', () => {
  it('finds the principal components, the same way round every time', () => {
    // Points on a line, and a little off it.
    const points = [-2, -1, 0, 1, 2].map((x, i) => [x, (i % 2) * 0.1, 0]);
    const coords = principal(points, 3);
    const first = coords.map((c) => c[0]);
    const up = first.every((x, i) => i === 0 || x > first[i - 1]);
    const down = first.every((x, i) => i === 0 || x < first[i - 1]);
    assert.ok(up || down, first.join());
    assert.ok(coords.every((c) => Math.abs(c[1]) < 0.1 && Math.abs(c[2]) < 1e-6));
    assert.deepEqual(principal(points, 3), coords);
  });

  it('takes a thread\'s people out of its topic: topics apart however their people are', () => {
    // Three topics, each its own direction; A's and B's threads are one person's, who writes
    // the same way in both, and C's another's.
    const X = [];
    const topicOf = [];
    const people = [];
    for (const [t, who] of [[0, 'p'], [1, 'p'], [2, 'q']]) {
      for (let i = 0; i < 12; i += 1) {
        const style = who === 'p' ? axis(3, 2) : axis(4, 0.5);
        X.push(unit(plus(axis(t), style, axis(5 + (i % 3), 0.2))));
        topicOf.push(t);
        people.push([who]);
      }
    }
    // The plain means: A and B together, C far off.
    const mean = (t) => X.filter((_, i) => topicOf[i] === t).reduce((s, x) => plus(s, x));
    const plain = principal([0, 1, 2].map(mean), 2);
    const before = dist(plain[0], plain[1]) / dist(plain[0], plain[2]);
    // Their own parts: much farther apart.
    const at = topicPlaces(X, topicOf, { people });
    const after = dist(at[0], at[1]) / dist(at[0], at[2]);
    assert.ok(after > before + 0.2, `${before} ${after}`);
    assert.equal(Math.round(Math.max(...at.map((p) => Math.hypot(...p))) * 100) / 100, 1);
    assert.ok(at.flat().every((x) => !Object.is(x, -0)));
  });

  it('gives every entity of the first block its part', () => {
    const X = [axis(0), axis(0), axis(1)];
    const own = parts(X, [[['a'], ['a'], ['b']], [[], [], []]], { ridge: 0 });
    assert.deepEqual([...own.keys()], ['a', 'b']);
    assert.ok(Math.abs(own.get('a')[0] - 1) < 1e-9 && Math.abs(own.get('b')[1] - 1) < 1e-9);
  });
});
