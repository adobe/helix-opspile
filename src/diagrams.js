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
 * The inbox Worker's side of the renderer Worker (src/graphviz/worker.js), bound as
 * `GRAPHVIZ` where it is deployed:
 * - `checkDiagrams`: a write of a `.dot` to a knowledge base is laid out by Graphviz itself
 *   first, after src/dot.js passed it, so what dot cannot lay out is refused with dot's words;
 * - `POST /api/diagram { dot, title? }`: the FMC drawing of `dot`, drawn on the server, for the
 *   knowledge-base editor, which then needs no Graphviz of its own (ui/kb.js).
 * Without the binding (local `cf dev`, `npm run ui:dev`) both do without: src/dot.js alone
 * checks, and the endpoint answers 503, so the page draws with /inbox/fmc.js.
 */

import { isDiagram, MAX_DOT } from './dot.js';
import { json } from './http.js';

/** Why one of `changes` is a diagram dot cannot lay out, or null (also without a renderer). */
export async function checkDiagrams(env, changes) {
  if (!env.GRAPHVIZ) {
    return null;
  }
  for (const c of changes || []) {
    if (!c.delete && isDiagram(c.path)) {
      let res;
      try {
        // Only whether dot can: its smallest output that is still the whole layout.
        // eslint-disable-next-line no-await-in-loop
        res = await env.GRAPHVIZ.layout(String(c.content ?? ''), { format: 'plain' });
      } catch (e) {
        // The renderer is down: src/dot.js has checked it, which has to do.
        console.error(JSON.stringify({ route: 'graphviz', error: e.message }));
        return null;
      }
      if (!res.ok && !res.timedOut) {
        return `${c.path}: Graphviz cannot lay it out: ${res.error}`;
      }
    }
  }
  return null;
}

/** POST /api/diagram: `{ svg, width, height, ms }`, or `{ error }` (422, 503 without one). */
export async function drawDiagram(env, body) {
  if (!env.GRAPHVIZ) {
    return json({ error: 'no renderer here' }, 503);
  }
  const dot = typeof body?.dot === 'string' ? body.dot : '';
  if (!dot || dot.length > MAX_DOT) {
    return json({ error: `give the diagram, as DOT of at most ${MAX_DOT / 1024} KB` }, 400);
  }
  let res;
  try {
    res = await env.GRAPHVIZ.render(dot, { title: String(body.title || '').slice(0, 200) });
  } catch (e) {
    console.error(JSON.stringify({ route: 'graphviz', error: e.message }));
    return json({ error: 'the renderer is not answering' }, 503);
  }
  return res.ok
    ? json({
      svg: res.svg, width: res.width, height: res.height, ms: res.ms,
    })
    : json({ error: res.error }, 422);
}
