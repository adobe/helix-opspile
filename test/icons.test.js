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
import { readFileSync } from 'node:fs';
import { ICONS } from '../src/icons.js';

const bytes = (path) => Buffer.from(ICONS[path].base64, 'base64');

describe('icons', () => {
  it('serves a favicon.ico with 16, 32 and 48 px images', () => {
    const ico = bytes('/favicon.ico');
    assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0]);
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => ico[6 + i * 16]);
    assert.deepEqual(sizes, [16, 32, 48]);
    // True colour with alpha: a palette and a 1-bit mask make the Adobe icon's edges jagged.
    const depths = Array.from({ length: count }, (_, i) => ico.readUInt16LE(6 + i * 16 + 6));
    assert.deepEqual(depths, [32, 32, 32]);
    assert.equal(ICONS['/favicon.ico'].type, 'image/x-icon');
  });

  it('serves a 180 px apple-touch-icon.png', () => {
    const png = bytes('/apple-touch-icon.png');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 180);
    assert.equal(png.readUInt32BE(20), 180);
    assert.equal(ICONS['/apple-touch-icon.png'].type, 'image/png');
  });

  it('serves the Adobe icon as it is, and every page\'s header shows it with the name', () => {
    const svg = readFileSync(new URL('../scripts/adobe-icon.svg', import.meta.url));
    assert.deepEqual(bytes('/icon.svg'), svg);
    assert.equal(ICONS['/icon.svg'].type, 'image/svg+xml');
    for (const page of ['inbox', 'kb', 'admin']) {
      const html = readFileSync(new URL(`../ui/${page}.html`, import.meta.url), 'utf8');
      assert.match(html, /<title>Enterprise Support/);
      assert.match(html, /<h1><a [^>]*><img src="\/icon\.svg" alt="Adobe"><span>Enterprise Support<\/span><\/a><\/h1>/);
    }
  });
});
