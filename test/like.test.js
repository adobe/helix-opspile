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
import { likePattern, MAX_LIKE_BYTES } from '../src/like.js';

const size = (s) => new TextEncoder().encode(s).length;

describe('likePattern', () => {
  it('escapes LIKE\'s own characters', () => {
    assert.equal(likePattern('100%_a\\b'), '%100\\%\\_a\\\\b%');
  });

  it('keeps the start of text that is longer than D1 takes', () => {
    assert.equal(likePattern('x'.repeat(48)), `%${'x'.repeat(48)}%`);
    const long = likePattern('y'.repeat(200));
    assert.equal(long, `%${'y'.repeat(48)}%`);
    assert.equal(size(long), MAX_LIKE_BYTES);
  });

  it('counts bytes, and never cuts an escape or a character in two', () => {
    for (const s of ['é'.repeat(40), '😀'.repeat(20), `${'a'.repeat(46)}%%`, `${'a'.repeat(47)}_`]) {
      const p = likePattern(s);
      assert.ok(size(p) <= MAX_LIKE_BYTES, s);
      assert.ok(!/(^|[^\\])(\\\\)*\\%$/.test(p), p);
      assert.ok(s.startsWith(p.slice(1, -1).replace(/\\(.)/g, '$1')), p);
    }
  });
});
