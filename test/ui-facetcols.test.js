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
 * The filters' columns (ui/inbox.js): where the filters flow into columns, the page says where
 * each starts, so a card does not jump into the next column when one above it grows by a row
 * (the older pages coming in after a reload).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];
const css = SCRIPTS['spectrum-inbox.css'];

function piece(from, to, expose) {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(`${js.slice(a, b)}\nreturn { ${expose} };`)();
}

const { tallest, bestCuts, pickCuts } = piece('function tallest(', 'const storedFacetCols', 'tallest, bestCuts, pickCuts');

describe('the filters\' columns', () => {
  it('cuts the cards where the tallest column is least', () => {
    assert.deepEqual(bestCuts([7, 5, 8, 17, 6, 14, 14, 5, 14, 4, 5], 2), [5]);
    assert.equal(tallest([7, 5, 8, 17, 6, 14, 14, 5, 14, 4, 5], [5]), 56);
    assert.deepEqual(bestCuts([10, 10, 10], 3), [1, 2]);
    assert.deepEqual(bestCuts([10, 10], 4), [1]);
    assert.deepEqual(bestCuts([10], 2), []);
  });

  it('keeps the cuts it had while they are close to the best', () => {
    // A card above the cut grew: the best cut moves, the one there was stays.
    assert.deepEqual(bestCuts([10, 10, 10, 10, 12], 2), [3]);
    assert.deepEqual(bestCuts([14, 10, 10, 10, 12], 2), [2]);
    assert.deepEqual(pickCuts([14, 10, 10, 10, 12], 2, [3], { slack: 4 }), [3]);
    // Far from the best, the cards are cut again.
    assert.deepEqual(pickCuts([30, 10, 10, 10, 12], 2, [3], { slack: 4 }), [2]);
  });

  it('keeps them as they are while the inbox is loading', () => {
    assert.deepEqual(pickCuts([7, 5, 8, 40, 6, 14, 14, 5, 14, 4, 5], 2, [5], { keep: true }), [5]);
  });

  it('cuts anew where what it had does not fit', () => {
    const heights = [10, 10, 10, 10];
    assert.deepEqual(pickCuts(heights, 2, [1, 2], { keep: true }), [2]);
    assert.deepEqual(pickCuts(heights, 2, [4], { keep: true }), [2]);
    assert.deepEqual(pickCuts(heights, 2, null, { keep: true }), [2]);
    assert.deepEqual(pickCuts(heights, 2, 'x', { keep: true }), [2]);
  });

  it('starts a column at a cut', () => {
    assert.match(css, /#facets > \.card\.cb \{ break-before: column; \}/);
  });
});
