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
 * The D2 prototype's renderer, in `npm run ui:dev` only: src/fmcd2.js's D2 source, laid out and
 * drawn by D2 (`@terrastruct/d2`, its WebAssembly build, in a Node worker thread), then made an
 * FMC block diagram by src/fmcd2.js. The inbox Worker does not have D2; a Worker of its own
 * would run this (see the pull request for what it would need).
 *
 * `POST /__dev/d2` takes `{ dot }` (an FMC block diagram as DOT, as src/fmc.js takes it) or
 * `{ view, detected, title }` (a stack drawing, as src/fmcstack.js takes it), and `layout`
 * (`elk`, the default, or `dagre`); it answers with the SVG, or with `{ svg, width, height, ms,
 * source }` as JSON with `?format=json`.
 */

// eslint-disable-next-line import/no-unresolved -- its exports nest conditions the resolver skips
import { D2 } from '@terrastruct/d2';
import { dotD2, finishSvg, parseDot } from '../src/fmcd2.js';
import { stackDot } from '../src/fmcstack.js';

let d2 = null;
let queue = Promise.resolve();

/** D2's compile and render, one at a time (its worker answers one request at a time). */
function serial(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

/** Draws `{ dot } | { view, detected, title }` with D2: `{ svg, width, height, ms, source }`. */
export async function renderD2({
  dot, view, detected = [], title = '', layout = 'elk', zoom,
} = {}) {
  d2 = d2 || new D2();
  const src = dot || stackDot(view, { detected, title }).dot;
  const t0 = performance.now();
  const model = dotD2(src, { layout: layout === 'dagre' ? 'dagre' : 'elk', zoom });
  const { diagram, raw } = await serial(async () => {
    const r = await d2.compile(model.source, { layout: model.layout });
    const svg = await d2.render(r.diagram, { ...r.renderOptions, noXMLTag: true, pad: 0 });
    return { diagram: r.diagram, raw: svg };
  });
  const out = finishSvg(raw, diagram, model, { title });
  return {
    ...out, ms: performance.now() - t0, source: model.source,
  };
}

/** Ends D2's worker thread (for tests: it keeps Node running). */
export async function closeD2() {
  if (d2) {
    await d2.ready.catch(() => {});
    await d2.worker?.terminate();
    d2 = null;
  }
}

/** The request body as JSON. */
async function body(req) {
  let s = '';
  for await (const c of req) {
    s += c;
  }
  return JSON.parse(s || '{}');
}

/** Answers `POST /__dev/d2`; false for any other request. */
export async function d2Route(req, res, url) {
  if (url.pathname !== '/__dev/d2' || req.method !== 'POST') {
    return false;
  }
  try {
    const asked = await body(req);
    if (asked.dot) {
      parseDot(asked.dot);
    }
    const r = await renderD2(asked);
    if (url.searchParams.get('format') === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r));
    } else {
      res.writeHead(200, {
        'content-type': 'image/svg+xml', 'x-render-ms': r.ms.toFixed(1), 'cache-control': 'no-store',
      }).end(r.svg);
    }
  } catch (e) {
    res.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e.message || e) }));
  }
  return true;
}
