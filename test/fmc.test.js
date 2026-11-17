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
import { before, describe, it } from 'node:test';
import { instance } from '@viz-js/viz';
import {
  readGraph, renderFmc, roundedPath, route, stretchGraph, wrap,
} from '../src/fmc.js';
import { plainNote, stackDot } from '../src/fmcstack.js';
import { FMC_PATH, fmcScript } from '../src/page.js';
import { parseStack, stackFile, stackView } from '../src/stack.js';
import FMC, { etag } from '../src/ui-fmc.bundle.js';
import { BUNDLES, bundle } from '../scripts/ui-markdown.mjs';
import { ARCHITECTURES, FIGURES, stacks } from '../scripts/fmc-gallery.mjs';
import { ACME_STACK } from '../scripts/dev-ui-kb.mjs';
import { SCRIPTS } from './ui.js';

// Made-up systems only.
let viz;
before(async () => {
  viz = await instance();
});

/** The routes of `dot`, as the renderer draws them (after making room). */
function routes(dot) {
  const graph = readGraph(viz.renderJSON(dot));
  let routed = route(graph);
  for (let i = 0; i < 2 && routed.stretch.length; i += 1) {
    stretchGraph(graph, routed.stretch);
    routed = route(graph);
  }
  return { graph, routed };
}
const xyOf = (graph, r) => r.points.map(([u, v]) => graph.toXY(u, v));
const orthogonal = (pts) => pts.every((p, i) => !i
  || Math.abs(p[0] - pts[i - 1][0]) < 0.01 || Math.abs(p[1] - pts[i - 1][1]) < 0.01);

describe('FMC block diagrams (src/fmc.js)', () => {
  it('route edges across and down only, with rounded corners', () => {
    const { graph, routed } = routes('digraph { node [shape=box, fixedsize=true]; A -> B; A -> C; B -> D; C -> D; A -> D; }');
    assert.equal(routed.routes.length, 5);
    for (const r of routed.routes) {
      assert.ok(orthogonal(xyOf(graph, r)), JSON.stringify(r.points));
    }
    assert.match(roundedPath([[0, 0], [0, 20], [20, 20]]), /^M0,0 L0,14 Q0,20 6,20 L20,20$/);
  });

  it('merge the edges that leave a node the same way into a tree, with one arrowhead each', () => {
    const { graph, routed } = routes('digraph { node [shape=box, fixedsize=true]; A -> B; A -> C; }');
    const [b, c] = routed.routes.map((r) => xyOf(graph, r));
    // One port, one trunk down to one track, then a branch each.
    assert.deepEqual(b[0], c[0]);
    assert.equal(b[1][1], c[1][1]);
    const { svg } = renderFmc(viz, 'digraph { node [shape=box, fixedsize=true]; A -> B; A -> C; X -> B; }');
    assert.equal((svg.match(/class="fmc-arrow"/g) || []).length, 2, 'one arrowhead into B, one into C');
  });

  it('give an edge to a channel a port of its own, and keep ports and tracks apart', () => {
    const { graph, routed } = routes(`digraph { node [shape=box, fixedsize=true];
      S [width=2]; c1 [fmc=channel, width=0.16, height=0.16]; c2 [fmc=channel, width=0.16, height=0.16];
      A -> c1 -> S [dir=none]; B -> c2 -> S [dir=none]; }`);
    const into = routed.routes.filter((r) => r.edge.head.name === 'S').map((r) => xyOf(graph, r).at(-1));
    assert.equal(into.length, 2);
    assert.ok(Math.abs(into[0][0] - into[1][0]) >= 9, JSON.stringify(into));
    // Every corridor an edge passes is at least as wide as the others.
    const rows = graph.ranks;
    for (let k = 0; k + 1 < rows.length; k += 1) {
      assert.ok(rows[k + 1].v0 - rows[k].v1 >= 23.5, `corridor ${k}`);
    }
  });

  it('draw nodes by kind, lines twice as thick as the edges, and groups as grey frames', () => {
    const { svg } = renderFmc(viz, `digraph { node [shape=box, fixedsize=true];
      subgraph cluster_g { fmc=group; label="Site"; A; S [fmc=storage]; }
      P [fmc=person, label="Visitors"]; d [fmc=dots]; c [fmc=channel, request=true, label="HTTPS", width=1, height=0.16];
      P -> c -> A [dir=none]; A -> S; }`);
    assert.match(svg, /<g class="fmc-node fmc-agent"><rect class="fmc-shape"[^>]* rx="0"\/>/);
    assert.match(svg, /<g class="fmc-node fmc-storage"><rect class="fmc-shape"[^>]* rx="1\d(\.\d)?"\/>/);
    assert.match(svg, /<g class="fmc-node fmc-person"><rect [^>]*\/><circle class="fmc-figure"/);
    assert.match(svg, /<g class="fmc-node fmc-dots">(<circle class="fmc-dot"[^>]*\/>){3}<\/g>/);
    assert.match(svg, /<g class="fmc-frame fmc-frame-group fmc-depth-0"><rect class="fmc-shape"[^>]*\/><text class="fmc-flabel"[^>]*><tspan[^>]*>Site<\/tspan>/);
    // The R of a request channel, its arrow pointing down the way requests go.
    const r = /<g class="fmc-r"><text class="fmc-rlabel" [^>]*>R<\/text><path class="fmc-rarrow" d="M([\d.]+),([\d.]+) L([\d.]+),([\d.]+) L([\d.]+),([\d.]+) Z"\/><\/g>/.exec(svg);
    assert.ok(r, 'an R');
    assert.ok(Number(r[6]) > Number(r[2]), 'pointing down');
    assert.doesNotMatch(svg, /style=|fill="#|stroke="#/);
    const css = SCRIPTS['spectrum-inbox.css'];
    assert.match(css, /\.fmc \.fmc-node \.fmc-shape \{[^}]*stroke-width: var\(--spectrum-border-width-200\);/);
    assert.match(css, /\.fmc \.fmc-edge \{[^}]*stroke-width: var\(--spectrum-border-width-100\);/);
  });

  it('write labels as text, wrapped and cut to their node, code in monospace', () => {
    assert.deepEqual(wrap('Edge Delivery storefront', 80).map((l) => l.map((r) => r.text).join('')), ['Edge Delivery', 'storefront']);
    const cut = wrap('one two three four five six seven', 60, 12, 2);
    assert.equal(cut.length, 2);
    assert.match(cut[1].map((r) => r.text).join(''), /…$/);
    assert.deepEqual(wrap('in `acme/shop`', 200)[0], [{ text: 'in ', code: false }, { text: 'acme/shop', code: true }]);
    const { svg } = renderFmc(viz, 'digraph { A [shape=box, fixedsize=true, width=2, label="<img src=x> & `x<y`"]; }');
    assert.match(svg, /&lt;img src=x&gt; &amp; <tspan class="fmc-code">x&lt;y<\/tspan>/);
    assert.doesNotMatch(svg, /<img/);
  });

  it('stop compound edges at the frame they go to', () => {
    const { svg, graph } = renderFmc(viz, `digraph { compound=true; node [shape=box, fixedsize=true];
      X; subgraph cluster_s { fmc=storage; label=""; A; B; } X -> A [lhead=cluster_s, dir=back]; }`);
    const frame = graph.clusters[0];
    const d = /<path class="fmc-edge" d="([^"]+)"/.exec(svg)[1];
    const last = d.split(/[ML]/).filter(Boolean).at(-1).split(',')
      .map(Number);
    assert.ok(Math.abs(last[1] - frame.y0) < 0.5, `${last} at ${frame.y0}`);
  });

  it('draw every figure of the gallery, the same way every time', () => {
    for (const f of FIGURES) {
      for (const d of f.dots) {
        const a = renderFmc(viz, d).svg;
        assert.match(a, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="fmc"/, `figure ${f.n}`);
        assert.equal(renderFmc(viz, d).svg, a, `figure ${f.n}`);
      }
    }
    assert.ok(FIGURES.length >= 18);
  });

  it('draw Helix 6 as adobe/helix-home does: its zones, structured nodes and request channels', () => {
    const h6 = ARCHITECTURES.find((a) => a.id === 'helix6');
    const { svg, graph } = renderFmc(viz, h6.dot);
    assert.equal(renderFmc(viz, h6.dot).svg, svg);
    const node = (label) => graph.nodes.find((n) => n.attrs.label === label);
    const cluster = (name) => graph.clusters.find((c) => c.name === name);
    // Top to bottom: who asks, the CDNs, the services, the buses, the API, the content.
    const rank = (label) => node(label).rank;
    assert.ok(rank('Visitor') < rank('BYO CDN'));
    assert.ok(rank('BYO CDN') < node('Outer CDN\\n`*.aem.live`, `*.aem.page`').rank);
    assert.ok(rank('Config Service') < rank('<org-1>'));
    assert.ok(rank('<org-1>') < rank('Source'));
    assert.ok(rank('Source') < rank('Docs'));
    // The zones, tinted, and what is nested in them.
    for (const z of ['oversight', 'edge', 'pipe', 'author', 'dev']) {
      assert.match(svg, new RegExp(`fmc-frame fmc-frame-group [^"]*fmc-zone-${z}`), z);
    }
    for (const [c, kind] of [['cluster_api', 'agent'], ['cluster_s3', 'storage'], ['cluster_contentbus', 'storage'], ['cluster_byo', 'storage']]) {
      assert.ok(cluster(c), c);
      assert.match(svg, new RegExp(`fmc-frame fmc-frame-${kind}`), c);
    }
    // The inner CDNs' channels hang under each, as many as they are: 24 request channels in all.
    assert.equal((svg.match(/class="fmc-rlabel"/g) || []).length, 24);
    const x = (label) => node(label).x;
    const ch = graph.nodes.find((n) => n.name === 'c_med');
    assert.ok(Math.abs(ch.x - x('Media CDN\\n`media.aem.page`')) < 1, `${ch.x}`);
  });
});

describe('stack drawings as FMC block diagrams (src/fmcstack.js)', () => {
  const acme = () => stackView(parseStack(stackFile(ACME_STACK)));

  it('put the layers in order as rows, people above, external parts beside', () => {
    const { dot, parts } = stackDot(acme(), { title: 'ACME' });
    assert.equal(parts.length, ACME_STACK.parts.length);
    const { graph } = renderFmc(viz, dot);
    const rankOf = (name) => graph.nodes.find((n) => n.attrs.label === name).rank;
    assert.ok(rankOf('Shoppers') < rankOf('Akamai'));
    assert.ok(rankOf('Akamai') < rankOf('Edge Delivery'));
    assert.ok(rankOf('Edge Delivery') < rankOf('SharePoint'));
    assert.ok(rankOf('GitHub') < rankOf('Adobe Commerce'));
    assert.equal(rankOf('Adobe Commerce'), rankOf('Payments'));
    // The system of interest holds the layers, not the people or the external parts.
    const system = graph.clusters.find((c) => c.name === 'cluster_system');
    const inside = new Set(system.members.map((n) => n.attrs.label));
    assert.ok(inside.has('Akamai') && !inside.has('Shoppers') && !inside.has('Payments'));
    // The layers line up, on the left and on the right.
    const rows = graph.clusters.filter((c) => c.attrs.stretch === 'row');
    assert.equal(new Set(rows.filter((c) => c.rowlabel).map((c) => Math.round(c.x0))).size, 1);
    assert.equal(new Set(rows.filter((c) => c.name !== 'cluster_layer_martech').map((c) => Math.round(c.x1))).size, 1);
  });

  it('draw flows between agents through channels, and to storages as accesses', () => {
    const { dot } = stackDot(acme());
    // Akamai asks Edge Delivery: a request channel, R pointing from Akamai.
    assert.match(dot, /c1 \[fmc=channel, label="every page but \/b2b", flow=1, [^\]]*request=true\];/);
    assert.match(dot, /n1 -> c1 \[flow=1, dir=none, weight=3\];\n {2}c1 -> n2 \[flow=1, dir=none\];/);
    // Edge Delivery reads SharePoint, a storage: one arrow, into Edge Delivery.
    const eds = 2;
    const sp = 5;
    assert.match(dot, new RegExp(`n${eds} -> n${sp} \\[flow=4, dir=back\\];`));
    // Authors modify SharePoint: both ways.
    assert.match(dot, /-> n5 \[flow=3, dir=both\];/);
    // New orders go up from Adobe Commerce to App Builder: the arrows point up.
    assert.match(dot, /n8 -> c9 \[flow=9, dir=back, weight=3\];/);
  });

  it('draw a stack.md written before the Kind column, and what Clef saw', () => {
    for (const s of stacks()) {
      const { dot } = stackDot(s.view, { title: s.name });
      const { svg } = renderFmc(viz, dot);
      for (const p of s.view.layers.flatMap((l) => l.parts)) {
        assert.ok(svg.includes(`>${p.name.split(' ')[0]}`), p.name);
      }
    }
  });

  it('quote every name, so no name changes the diagram', () => {
    const view = {
      layers: [{ id: 'edge', name: 'Edge "x"', parts: [{ name: 'A"; B -> C; "', note: 'a \\ b' }, { name: 'B' }] }],
      flows: [{ from: 'A"; B -> C; "', to: 'B', label: '" -> x' }],
    };
    const { dot } = stackDot(view);
    const { graph, svg } = renderFmc(viz, dot);
    assert.equal(graph.nodes.filter((n) => n.attrs.part != null).length, 2);
    assert.match(svg, /A&quot;; B -&gt; C; &quot;/);
    assert.equal(plainNote('[www.acme.example](https://www.acme.example/), **bold**, `code`'), 'www.acme.example, bold, `code`');
  });

  it('draw ACME in a few milliseconds', () => {
    const { dot } = stackDot(acme());
    renderFmc(viz, dot);
    const t0 = performance.now();
    renderFmc(viz, dot);
    assert.ok(performance.now() - t0 < 500);
  });
});

describe('the stack renderer in the browser (src/ui-fmc.js)', () => {
  it('is served on its own, current with its source, and the inbox imports it', async () => {
    const file = readFileSync(new URL('../src/ui-fmc.bundle.js', import.meta.url), 'utf8');
    assert.equal(file, await bundle(BUNDLES.find((b) => b.name === 'ui-fmc')), 'run node scripts/ui-markdown.mjs');
    assert.ok(SCRIPTS['stack.js'].includes(`'${FMC_PATH}'`));
    const get = (path, headers = {}, method = 'GET') => fmcScript({ method, headers: new Headers(headers) }, path);
    const ok = get(FMC_PATH);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('etag'), etag);
    assert.equal(await ok.text(), FMC);
    assert.equal(get(FMC_PATH, { 'if-none-match': etag }).status, 304);
    assert.equal(get(FMC_PATH, {}, 'POST'), null);
    assert.equal(get('/inbox/other.js'), null);
  });

  it('draws in the browser bundle as it does here', async () => {
    const served = await import(`data:text/javascript;base64,${Buffer.from(FMC).toString('base64')}`);
    const view = stackView(parseStack(stackFile(ACME_STACK)));
    const out = await served.drawStack(view, { title: 'ACME' });
    assert.equal(out.svg, renderFmc(viz, stackDot(view, { title: 'ACME' }).dot).svg);
    await assert.rejects(served.render('digraph { a -> }'));
    // Drawn again after an error, with a new Graphviz.
    assert.match((await served.render('digraph { a -> b }')).svg, /^<svg/);
  });
});
