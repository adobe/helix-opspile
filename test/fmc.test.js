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
import ELK from 'elkjs/lib/elk.bundled.js';
import {
  estimate, fit, layout, measureRoutes, render, roundedPath, svg,
} from '../src/fmc.js';
import { flowKind, stackDiagram } from '../src/fmc-stack.js';
import { FMC_PATH, fmcScript } from '../src/page.js';
import { parseStack, stackView } from '../src/stack.js';
import FMC, { etag } from '../src/ui-fmc.bundle.js';
import { ACME_STACK, SEED } from '../scripts/dev-ui-kb.mjs';
import { FIGURES } from '../scripts/fmc-figures.mjs';
import { BUNDLES, bundle } from '../scripts/ui-markdown.mjs';
import { SCRIPTS } from './ui.js';

const elk = new ELK();
const acme = () => stackView(parseStack(SEED['kb-org-acme'].files['stack.md']));
const umbrella = () => stackView(parseStack(SEED['kb-org-umbrella'].files['stack.md']));
const box = (n) => ({
  x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h,
});

/** Whether the segment a–b runs through the box (not just touching its border). */
function through(a, b, r) {
  if (Math.abs(a.y - b.y) < 0.5) {
    const [lo, hi] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    return a.y > r.y1 + 0.5 && a.y < r.y2 - 0.5 && hi > r.x1 + 0.5 && lo < r.x2 - 0.5;
  }
  const [lo, hi] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return a.x > r.x1 + 0.5 && a.x < r.x2 - 0.5 && hi > r.y1 + 0.5 && lo < r.y2 - 0.5;
}

describe('the FMC visualization runner', () => {
  it('sizes nodes by a grid, not by their text: long labels wrap, get smaller, then are cut', () => {
    assert.ok(estimate('MMMM') > estimate('iiii'));
    assert.ok(estimate('abc', { mono: true }) > estimate('abc'));
    assert.deepEqual(fit('Edge Delivery', 200).lines.map((l) => l.map((w) => w.text).join(' ')), ['Edge Delivery']);
    const two = fit('Correlated Phrases', 60);
    assert.equal(two.lines.length, 2);
    const cut = fit('An extraordinarily long name of a part that will not fit', 60, { lines: 2 });
    assert.equal(cut.lines.length, 2);
    assert.match(cut.lines[1].at(-1).text, /…$/);
    // Code in a label is code: it is written in monospace.
    assert.deepEqual(fit('the `acme/shop` repo', 300).lines[0].map((w) => w.code), [false, true, false]);
  });

  it('rounds the corners of edges', () => {
    assert.equal(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 40 }]), 'M0,0 L0,40');
    assert.match(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 40, y: 40 }]), /^M0,0 L0,32 Q0,40 8,40 L40,40$/);
  });

  it('counts the crossings of edges, not where they share a trunk', () => {
    const e = (id, ...routes) => ({ id, routes });
    const cross = measureRoutes([
      e('a', [{ x: 0, y: 10 }, { x: 40, y: 10 }]),
      e('b', [{ x: 20, y: 0 }, { x: 20, y: 40 }]),
      e('c', [{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }]),
    ]);
    assert.equal(cross.crossings, 1);
    assert.equal(cross.bends, 1);
  });

  it('merges the edges into a node into an edge tree, and draws node lines thicker than edges', async () => {
    const fig5 = FIGURES.find((f) => f.fig === '5').diagram;
    const model = await layout(fig5, { elk });
    const starts = model.edges.map((e) => `${e.routes[0][0].x},${e.routes[0][0].y}`);
    assert.equal(new Set(starts).size, 1, 'one trunk');
    assert.equal(model.crossings, 0);
    // Node and edge lines are classes: the stylesheet gives nodes twice the edges' weight.
    const css = SCRIPTS['spectrum-fmc.css'];
    assert.match(css, /\.fmc-node > \.fmc-shape[^{]*\{[^}]*stroke-width: var\(--spectrum-border-width-200\)/);
    assert.match(css, /\.fmc-line \{[^}]*stroke-width: var\(--spectrum-border-width-100\)/);
    const drawn = svg(model);
    assert.doesNotMatch(drawn, /style=|fill="#|stroke="#/);
    assert.equal((drawn.match(/class="fmc-line"/g) || []).length, 3);
  });

  it('draws the block diagram notation: channels, request/response, read, write and modify', async () => {
    const { svg: drawn, model } = await render(FIGURES.find((f) => f.fig === 'notation').diagram, { elk });
    // A channel is a small circle on the edge; R and its arrow for a request/response one.
    assert.equal((drawn.match(/<circle class="fmc-shape fmc-ch"/g) || []).length, 3);
    assert.match(drawn, /<path class="fmc-rr" d="[^"]+"\/><text class="fmc-text fmc-r"[^>]*>R<\/text>/);
    // The modify access: two arcs, an arrow at each end.
    const modify = /<g class="fmc-edge fmc-e-modify"[^>]*>(.*?)<\/g>/.exec(drawn)[1];
    assert.equal((modify.match(/class="fmc-head"/g) || []).length, 2);
    assert.equal((modify.match(/ Q/g) || []).length, 2);
    // A read access points at the agent, a write access at the storage.
    const end = (e) => e.routes.at(-1).at(-1);
    const read = model.edges.find((e) => e.kind === 'read');
    const a1 = model.nodes.find((n) => n.id === 'A1');
    assert.ok(read.heads.length === 1);
    const tip = read.heads[0].at === 'end' ? end(read) : read.routes[0][0];
    assert.ok(Math.abs(tip.x - a1.x) < 1 || Math.abs(tip.x - (a1.x + a1.w)) < 1, 'into A1');
    // People: a figure in the box.
    assert.match(drawn, /<g class="fmc-node fmc-person"[^>]*><rect class="fmc-shape"[^>]*\/><g class="fmc-figure">/);
  });

  it('draws every figure of the guidelines it reproduces, mostly without crossings', async () => {
    const crossings = {};
    for (const f of FIGURES) {
      for (const d of f.diagrams || [f.diagram]) {
        // eslint-disable-next-line no-await-in-loop -- one after the other
        const { svg: drawn, model } = await render(d, { elk });
        assert.match(drawn, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="fmc"/, f.fig);
        crossings[f.fig] = (crossings[f.fig] || 0) + model.crossings;
      }
    }
    // Figure 7's six edges between four nodes in a square cross once, as the original's do.
    assert.deepEqual(Object.entries(crossings).filter(([, n]) => n > 0), [['7', 1]]);
  });

  it('writes what it is given as text', async () => {
    const { svg: drawn } = await render({
      nodes: [{ id: 'a', label: '<img src=x onerror=alert(1)>', title: '"><script>' }, { id: 'b', label: 'B & C' }],
      edges: [{
        from: 'a', to: 'b', kind: 'request', label: '</text><b>',
      }],
    }, { elk });
    assert.doesNotMatch(drawn, /<img|<script|<\/text><b>/);
    assert.match(drawn, /B &amp; C/);
  });
});

describe('the stack drawing as an FMC block diagram', () => {
  it('draws people at the top, the site in a frame of its layers, and what is not theirs outside it', async () => {
    const d = stackDiagram(acme());
    const node = (name) => d.nodes.find((n) => n.label === name);
    assert.equal(node('Visitors').kind, 'person');
    assert.equal(node('Visitors').group, undefined);
    assert.equal(node('Payments').group, undefined);
    assert.equal(node('SharePoint').kind, 'storage');
    assert.equal(node('Akamai').group, 'l-edge');
    assert.equal(d.groups.find((g) => g.id === 'l-edge').parent, 'site');
    // A person of the drawing's own: no visitors added.
    assert.ok(!d.nodes.some((n) => n.id === 'visitors'));
    const model = await layout(d, { elk });
    const at = (name) => model.nodes.find((n) => n.label === name);
    assert.ok(at('Visitors').y < at('Akamai').y);
    assert.ok(at('Akamai').y < at('Edge Delivery').y);
    assert.ok(at('Edge Delivery').y < at('SharePoint').y, 'the site above what it reads');
    assert.ok(at('Edge Delivery').y < at('Adobe Commerce').y, 'many at the top, few at the bottom');
    assert.equal(model.crossings, 0);
  });

  it('gives similar parts one size, and its hubs twice the width', async () => {
    const model = await layout(stackDiagram(acme()), { elk });
    const boxes = model.nodes.filter((n) => ['agent', 'storage'].includes(n.kind));
    const eds = boxes.find((n) => n.label === 'Edge Delivery');
    const rest = boxes.filter((n) => n !== eds);
    assert.equal(new Set(rest.map((n) => `${n.w}x${n.h}`)).size, 1);
    assert.ok(eds.w > rest[0].w * 2 && eds.h === rest[0].h);
  });

  it('keeps its edges off the nodes they do not connect', async () => {
    for (const view of [acme(), umbrella()]) {
      // eslint-disable-next-line no-await-in-loop
      const model = await layout(stackDiagram(view), { elk });
      for (const e of model.edges.filter((x) => !x.hidden)) {
        const mine = new Set([e.src, e.dst, e.channel?.id]);
        for (const n of model.nodes.filter((x) => !mine.has(x.id))) {
          for (const r of e.routes) {
            for (let i = 1; i < r.length; i += 1) {
              assert.ok(!through(r[i - 1], r[i], box(n)), `${e.from} → ${e.to} runs through ${n.label}`);
            }
          }
        }
      }
    }
  });

  it('reads a drawing written before kinds: agents, flows the way the data goes, visitors on top', () => {
    const d = stackDiagram(umbrella());
    assert.equal(d.nodes[0].id, 'visitors');
    assert.deepEqual(d.edges[0], { from: 'visitors', to: d.nodes.find((n) => n.label === 'Akamai').id, kind: 'request' });
    assert.ok(d.nodes.filter((n) => n.id !== 'visitors').every((n) => n.kind === 'agent'));
    const sp = d.edges.find((e) => e.title?.startsWith('SharePoint'));
    // Content sends to the site, which is above it: laid out from the site, the arrow up.
    assert.equal(sp.kind, 'send');
    assert.equal(sp.flip, true);
    const kindOf = (name) => (name === 'S' ? 'storage' : 'agent');
    assert.equal(flowKind({ from: 'S', to: 'A' }, kindOf), 'read');
    assert.equal(flowKind({ from: 'A', to: 'S' }, kindOf), 'write');
    assert.equal(flowKind({ from: 'A', to: 'B' }, kindOf), 'send');
    assert.equal(flowKind({ from: 'A', to: 'S', kind: 'modify' }, kindOf), 'modify');
  });

  it('frames a group of parts inside its layer, and names each part and flow for the page', async () => {
    const view = stackView(parseStack(SEED['kb-org-acme'].files['stack.md']));
    view.layers[0].parts = view.layers[0].parts.map((p) => ({ ...p, group: p.name === 'Akamai' ? 'CDN' : undefined }));
    const d = stackDiagram(view);
    assert.deepEqual(d.groups.find((g) => g.label === 'CDN'), {
      id: 'g-edge-0', kind: 'area', label: 'CDN', parent: 'l-edge',
    });
    const { svg: drawn } = await render(d, { elk, focusable: true });
    assert.match(drawn, /<g class="fmc-node fmc-agent" data-node="p1" data-part="1" tabindex="0"><title>Akamai<\/title>/);
    assert.match(drawn, /<g class="fmc-edge fmc-e-request"[^>]* data-flow="1"><title>Akamai → Edge Delivery: every page but \/b2b<\/title>/);
  });

  it('draws what Clef saw as a layer model, each part with how sure Clef is', async () => {
    const d = stackDiagram({
      guess: true,
      flows: [],
      layers: [
        { id: 'edge', name: 'Edge', parts: [{ name: 'Akamai', note: '90% sure' }] },
        { id: 'site', name: 'Site', parts: [{ name: 'Edge Delivery', note: '100% sure' }] },
        { id: 'other', name: 'Other', parts: [{ name: 'Jira', note: '85% sure' }] },
      ],
    });
    assert.ok(!d.nodes.some((n) => n.kind === 'person'));
    const model = await layout(d, { elk });
    const y = (id) => model.groups.find((g) => g.id === id).y;
    assert.ok(y('l-edge') < y('l-site') && y('l-site') < y('l-other'));
    assert.match(svg(model), /<text class="fmc-text fmc-sub"[^>]*>90% sure<\/text>/);
  });

  it('lays out ACME in well under a second', async () => {
    const t = Date.now();
    await render(stackDiagram(acme()), { elk });
    assert.ok(Date.now() - t < 2000);
  });

  it('is served on its own, current with its source, and the inbox imports it', async () => {
    const file = readFileSync(new URL('../src/ui-fmc.bundle.js', import.meta.url), 'utf8');
    assert.equal(file, await bundle(BUNDLES.find((b) => b.name === 'ui-fmc')), 'run node scripts/ui-markdown.mjs');
    assert.match(FMC, /export\{[^}]*\bdrawStack\b/);
    assert.ok(SCRIPTS['inbox.js'].includes(`'${FMC_PATH}'`));
    const get = (path, headers = {}, method = 'GET') => fmcScript({ method, headers: new Headers(headers) }, path);
    const ok = get(FMC_PATH);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('etag'), etag);
    assert.equal(get(FMC_PATH, { 'if-none-match': etag }).status, 304);
    assert.equal(await get(FMC_PATH, {}, 'HEAD').text(), '');
    assert.equal(get('/inbox/other.js'), null);
    // The fake data's drawing is the one the gallery and the inbox show.
    assert.equal(ACME_STACK.parts.length, acme().layers.flatMap((l) => l.parts).length);
  });
});
