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
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  kindIcons, polygons, ringed, write,
} from '../scripts/wf-rings.mjs';

const css = readFileSync(new URL('../ui/spectrum-inbox.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('../ui/inbox.js', import.meta.url), 'utf8');

describe('ringed kinds (scripts/wf-rings.mjs)', () => {
  it('has every kind ringed, as the script writes them', () => {
    const names = kindIcons(js);
    assert.ok(names.includes('help') && names.length >= 8, names.join());
    for (const n of names) {
      assert.match(css, new RegExp(`\\.spectrum \\.wf-${n}\\.ringed \\{`), n);
    }
    assert.equal(write(css, names), css, 'run node scripts/wf-rings.mjs');
  });

  it('draws relative subpaths from where the last one closed', () => {
    const [a, b] = polygons('m2,2h4v4h-4zm1,1h2v2h-2z');
    assert.deepEqual(a, [[2, 2], [6, 2], [6, 6], [2, 6]]);
    assert.deepEqual(b, [[3, 3], [5, 3], [5, 5], [3, 5]]);
  });

  it('outlines a ring\'s silhouette, not its hole', () => {
    // A square ring: its outline is one square around it, a gap away, with no square inside.
    const svg = ringed('<svg viewBox="0 0 20 20"><path d="M4,4h12v12h-12zM6,6v8h8v-8z"/></svg>');
    const ring = /<path fill-rule="evenodd" d="([^"]+)"/.exec(svg)[1];
    assert.equal(ring.match(/M/g).length, 2, 'the outer and inner edge of one ring');
  });
});
