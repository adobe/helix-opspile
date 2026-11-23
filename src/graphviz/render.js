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
 * What the renderer Worker (src/graphviz/worker.js) does with a run of dot, apart from the
 * kernel that runs it, so that Node tests it: which arguments dot gets, how long it may take,
 * what its answer means, and drawing the layout as an FMC block diagram (src/fmc.js).
 *
 * `run(argv, { stdin })` is the kernel's: `{ status, stdout, stderr }`.
 */

import { checkDot, MAX_DOT } from '../dot.js';
import { drawLayout } from '../fmc.js';

export const ENGINES = ['dot', 'neato', 'fdp', 'sfdp', 'circo', 'twopi', 'osage', 'patchwork'];
// json0 is json without dot's drawing instructions (_draw_, _ldraw_, …), which src/fmc.js does
// not read: the same layout at a third of the size, and dot's output crosses the kernel's pipe.
export const FORMATS = ['json0', 'json', 'svg', 'xdot', 'dot', 'plain'];
/** How long one layout may take: dot is fast, a pathological graph is not. */
export const LAYOUT_MS = 10000;

/** dot's complaint, as a person reads it: its first lines, without the program's name. */
export function complaint(stderr) {
  const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^Warning: .*(fontconfig|font)/i.test(l));
  return lines.slice(0, 3).map((l) => l.replace(/^(dot|Error):\s*/i, '')).join(' ').slice(0, 400)
    || 'dot could not lay it out';
}

/**
 * Lays out `dot` with `run`: `{ ok: true, out, ms }`, `out` dot's output in `format`, or
 * `{ ok: false, error }` (the DOT is not valid, too large, or dot failed or took too long).
 */
export async function layout(run, dot, { engine = 'dot', format = 'json', timeout = LAYOUT_MS } = {}) {
  const text = String(dot ?? '');
  if (!ENGINES.includes(engine)) {
    return { ok: false, error: `engine is one of ${ENGINES.join(', ')}` };
  }
  if (!FORMATS.includes(format)) {
    return { ok: false, error: `format is one of ${FORMATS.join(', ')}` };
  }
  if (text.length > MAX_DOT) {
    return { ok: false, error: `a diagram is at most ${MAX_DOT / 1024} KB` };
  }
  const started = Date.now();
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeout);
  });
  try {
    const res = await Promise.race([run(['dot', `-K${engine}`, `-T${format}`], { stdin: text }), late]);
    if (!res) {
      return { ok: false, error: `dot took longer than ${timeout / 1000} s`, timedOut: true };
    }
    // dot says Error and still lays out what it could (a record label it cannot read): what it
    // calls an error is one.
    if (res.status !== 0 || !res.stdout || /^Error:/m.test(res.stderr || '')) {
      return { ok: false, error: complaint(res.stderr) };
    }
    return { ok: true, out: res.stdout, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Draws `dot` as the inbox draws a diagram: dot's layout (`-Tjson0`), drawn by src/fmc.js.
 * `{ ok: true, svg, width, height, ms }` or `{ ok: false, error }`. What src/dot.js refuses is
 * refused here first, with its line, as a write of the diagram would be.
 */
export async function render(run, dot, options = {}) {
  const why = checkDot(dot);
  if (why) {
    return { ok: false, error: why };
  }
  const res = await layout(run, dot, { ...options, format: 'json0' });
  if (!res.ok) {
    return res;
  }
  let json;
  try {
    json = JSON.parse(res.out);
  } catch {
    return { ok: false, error: 'dot gave no layout' };
  }
  const drawn = drawLayout(json, { title: options.title || '' });
  return {
    ok: true, svg: drawn.svg, width: drawn.width, height: drawn.height, ms: res.ms,
  };
}
