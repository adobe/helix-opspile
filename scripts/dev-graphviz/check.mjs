#!/usr/bin/env node
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

/**
 * `npm run graphviz:check -- <origin>`: draws every figure of the FMC gallery
 * (scripts/fmc-gallery.mjs) with the renderer Worker at `origin` (`npm run graphviz:dev`), and
 * with viz-js here, as the page draws them, and checks that both drew the same: as many nodes,
 * edges, arrows and frames. The wasm build of dot may be a newer Graphviz than viz-js's, so
 * the places may differ by a little; what is drawn may not. Also checks that what dot cannot
 * lay out comes back as an error, and how long a drawing takes. Exits 1 on a difference.
 */

import { instance } from '@viz-js/viz';
import { renderFmc } from '../../src/fmc.js';
import { FIGURES } from '../fmc-gallery.mjs';

const origin = process.argv[2] || 'http://localhost:8789';
const viz = await instance();
const count = (svg) => Object.fromEntries(['fmc-node ', 'fmc-edge', 'fmc-arrow', 'fmc-frame ', 'fmc-rlabel']
  .map((c) => [c.trim(), (svg.match(new RegExp(`class="${c}`, 'g')) || []).length]));
const post = async (path, body) => {
  const res = await fetch(`${origin}${path}`, { method: 'POST', body: JSON.stringify(body) });
  return res.json();
};

let failed = 0;
const times = [];
for (const f of FIGURES) {
  for (const [i, dot] of f.dots.entries()) {
    const name = `figure ${f.n}${f.dots.length > 1 ? `.${i + 1}` : ''}`;
    // eslint-disable-next-line no-await-in-loop
    const res = await post('/render', { dot });
    if (!res.ok) {
      failed += 1;
      console.log(`✖ ${name}: ${res.error}`);
      // eslint-disable-next-line no-continue
      continue;
    }
    times.push(res.ms);
    const ours = count(res.svg);
    const theirs = count(renderFmc(viz, dot).svg);
    const same = JSON.stringify(ours) === JSON.stringify(theirs);
    if (!same) {
      failed += 1;
    }
    console.log(`${same ? '✔' : '✖'} ${name}: ${JSON.stringify(ours)}${same ? '' : ` (viz-js: ${JSON.stringify(theirs)})`}, ${res.ms} ms, ${Math.round(res.width)}×${Math.round(res.height)}`);
  }
}
for (const [dot, why] of [['digraph { a -> }', /line 1/], ['graph { a -> b }', /a graph joins nodes with --/]]) {
  // eslint-disable-next-line no-await-in-loop
  const res = await post('/render', { dot });
  const ok = !res.ok && why.test(res.error);
  if (!ok) {
    failed += 1;
  }
  console.log(`${ok ? '✔' : '✖'} refuses ${JSON.stringify(dot)}: ${res.error}`);
}
const layoutErr = await post('/layout', { dot: 'digraph { a -> b [lhead=nope }' });
console.log(`${layoutErr.ok ? '✖' : '✔'} dot's own error: ${layoutErr.error}`);
if (layoutErr.ok) {
  failed += 1;
}
times.sort((a, b) => a - b);
console.log(`\n${times.length} drawings, ${times[Math.floor(times.length / 2)]} ms median, ${times.at(-1)} ms slowest; ${failed} failed`);
process.exit(failed ? 1 : 0);
