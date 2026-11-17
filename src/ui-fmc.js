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
 * How the inbox draws a customer's stack: as an FMC block diagram (src/fmcstack.js makes it
 * DOT, src/fmc.js draws it), laid out by Graphviz, which @viz-js/viz runs as WebAssembly.
 *
 * The page does not load this file: scripts/ui-markdown.mjs bundles it, with Graphviz, into
 * src/ui-fmc.bundle.js, which the Worker serves at /inbox/fmc.js, and the inbox imports that the
 * first time it shows a drawing (ui/stack.js `Stack.wire`).
 */

import { instance } from '@viz-js/viz';
import { renderFmc } from './fmc.js';
import { stackDot } from './fmcstack.js';

let viz = null;
const ready = async () => {
  viz = viz || await instance();
  return viz;
};

/** An FMC block diagram in DOT as SVG: `{ svg, width, height, ms }`. */
export async function render(dot, options = {}) {
  const v = await ready();
  const t0 = performance.now();
  let out;
  try {
    out = renderFmc(v, dot, options);
  } catch (e) {
    // Graphviz may be left in a bad state by what failed: the next drawing gets a new one.
    viz = null;
    throw e;
  }
  return {
    svg: out.svg, width: out.width, height: out.height, ms: performance.now() - t0,
  };
}

/**
 * A stack drawing (src/stack.js `stackView`) as SVG: `{ svg, width, height, ms, dot }`. Options
 * are stackDot's (`detected`, `title`) and the SVG's (`title` too).
 */
export async function drawStack(view, options = {}) {
  const { dot } = stackDot(view, options);
  return { ...await render(dot, { title: options.label || '' }), dot };
}

export { stackDot };
