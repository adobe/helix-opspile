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
  edgeKind, label, mermaid, stackDiagram,
} from '../src/fmc.js';
import { FMC_PATH, fmcScript } from '../src/page.js';
import { parseStack, stackFile, stackView } from '../src/stack.js';
import FMC, { etag } from '../src/ui-fmc.bundle.js';
import { BUNDLES, bundle } from '../scripts/ui-markdown.mjs';
import { FIGURES, NOTATION_FIGURES, galleryStacks } from '../scripts/dev-ui-fmc.mjs';
import { SCRIPTS } from './ui.js';

// Made-up systems only.
const DRAWING = {
  summary: 'A shop.',
  parts: [
    { layer: 'edge', name: 'CDN', tech: 'akamai' },
    { layer: 'site', name: 'Shop', tech: 'eds' },
    { layer: 'site', name: 'Old shop' },
    { layer: 'content', name: 'Authors', kind: 'person' },
    { layer: 'content', name: 'Pages' },
    { layer: 'commerce', name: 'Catalog', kind: 'storage' },
    { layer: 'martech', name: 'Analytics' },
    { layer: 'identity', name: 'SSO' },
  ],
  flows: [
    { from: 'CDN', to: 'Shop', label: 'every page' },
    { from: 'CDN', to: 'Old shop', label: '/b2b' },
    { from: 'Pages', to: 'Shop', label: 'publish' },
    { from: 'Shop', to: 'Catalog', kind: 'read' },
    { from: 'Authors', to: 'Pages', kind: 'request' },
  ],
};
const ACME = stackView(parseStack(stackFile(DRAWING)));

describe('FMC block diagrams as Mermaid', () => {
  it('write every label as the text it is', () => {
    assert.equal(label('Edge <b>"Delivery"</b> #1'), 'Edge #60;b#62;#34;Delivery#34;#60;/b#62; #35;1');
    assert.equal(label('  two\n lines '), 'two lines');
    const { text } = mermaid({ nodes: [{ id: 'x', label: 'end"]\n  y((z' }, { id: 'c', label: 'a_b', code: true }] });
    // In double quotes, only a quote could end it.
    assert.match(text, /^ {2}n0\["end#34;\] y\(\(z"\]$/m);
    assert.match(text, /^ {2}n1\["#60;code#62;a_b#60;\/code#62;"\]$/m);
    // A blank label is one Mermaid takes.
    assert.match(mermaid({ nodes: [{ id: 'x', label: '' }] }).text, /^ {2}n0\[" "\]$/m);
  });

  it('draw FMC\'s notation: agents, storages, channels on edges between agents, accesses to storages', () => {
    const p = mermaid({
      nodes: [
        { id: 'c', label: 'Client', size: 'l' }, { id: 's', label: 'Server' },
        { id: 'db', label: 'Database', kind: 'storage' }, { id: 'log', label: 'Log', kind: 'storage' },
        { id: 'u', label: 'User', kind: 'person' }, { id: 'd', label: '…', kind: 'text' },
      ],
      edges: [
        {
          from: 'c', to: 's', kind: 'request', label: 'HTTP',
        },
        { from: 's', to: 'db', kind: 'modify' },
        { from: 's', to: 'log', kind: 'write' },
        { from: 'c', to: 'db', kind: 'read' },
        { from: 'u', to: 'c', kind: 'channel' },
        {
          from: 'u', to: 's', kind: 'flow', flow: 3,
        },
        { from: 'd', to: 's', kind: 'hidden' },
        { from: 'c', to: 'nobody' },
      ],
    });
    assert.match(p.text, /^---\nconfig:\n {2}layout: elk\n/);
    assert.match(p.text, /^flowchart TB$/m);
    assert.match(p.text, /^ {2}n2\(\["Database"\]\)$/m);
    assert.match(p.text, /^ {2}c0e\(\(" "\)\)$/m);
    assert.match(p.text, /^ {2}t5@\{ shape: text, label: "#8230;" \}$/m);
    // A request channel between agents: through a circle, named on its way in.
    assert.match(p.text, /^ {2}n0 ---\|"HTTP"\| c0e\n {2}c0e --- n1$/m);
    assert.match(p.text, /^ {2}n1 <--> n2$/m);
    assert.match(p.text, /^ {2}n1 --> n3$/m);
    // Read: the arrow points at the reader.
    assert.match(p.text, /^ {2}n2 --> n0$/m);
    assert.match(p.text, /^ {2}n4 --> c5e\n {2}c5e --> n1$/m);
    assert.match(p.text, /^ {2}t5 ~~~ n1$/m);
    assert.doesNotMatch(p.text, /nobody/);
    // Node lines twice as thick as edges, on GitHub too; no colors.
    assert.match(p.text, /classDef agent stroke-width:2px/);
    assert.match(p.text, /linkStyle default stroke-width:1px/);
    assert.doesNotMatch(p.text, /#[0-9a-f]{3,6}\b(?!;)|fill:|color:/i);
    assert.deepEqual(p.channels.get('c0e'), {
      kind: 'request', from: 'n0', to: 'n1', flow: null,
    });
    assert.deepEqual(p.edges.map((e) => [e.from, e.to, e.kind, e.flow]), [
      ['n0', 'c0e', 'request', null], ['c0e', 'n1', 'request', null], ['n1', 'n2', 'modify', null],
      ['n1', 'n3', 'write', null], ['n2', 'n0', 'read', null], ['n4', 'c4e', 'channel', null],
      ['c4e', 'n0', 'channel', null], ['n4', 'c5e', 'flow', 3], ['c5e', 'n1', 'flow', 3],
      ['t5', 'n1', 'hidden', null],
    ]);
  });

  it('lay an edge out from its from to its to, whichever way its arrows point', () => {
    const p = mermaid({
      nodes: [{ id: 'a', label: 'A' }, { id: 's', label: 'S', kind: 'storage' }, { id: 'b', label: 'B' }],
      edges: [
        { from: 'a', to: 's', kind: 'read' },
        {
          from: 'b', to: 's', kind: 'read', up: true,
        },
        {
          from: 'a', to: 'b', kind: 'flow', up: true,
        },
      ],
    });
    // A's read runs from S to A, laid out upwards so A is on top; B's the way it runs.
    assert.deepEqual(p.edges.map((e) => [e.from, e.to, e.up]), [
      ['n1', 'n0', true], ['n1', 'n2', false], ['n0', 'c2e', true], ['c2e', 'n2', true],
    ]);
  });

  it('take a flow into or out of a storage as an access, and a channel to a storage as modify', () => {
    assert.equal(edgeKind('flow', 'agent', 'storage'), 'write');
    assert.equal(edgeKind('flow', 'storage', 'agent'), 'read-by');
    assert.equal(edgeKind('request', 'person', 'storage'), 'read');
    assert.equal(edgeKind('channel', 'agent', 'storage'), 'modify');
    assert.equal(edgeKind('nonsense', 'agent', 'agent'), 'flow');
    assert.equal(edgeKind('line', 'storage', 'agent'), 'line');
    const p = mermaid({
      nodes: [{ id: 's', label: 'S', kind: 'storage' }, { id: 'a', label: 'A' }],
      edges: [{ from: 's', to: 'a' }],
    });
    assert.deepEqual(p.edges.map((e) => [e.from, e.to, e.kind]), [['n0', 'n1', 'read']]);
  });

  it('nest groups, put a channel in the innermost group both its ends are in, and reach groups', () => {
    const p = mermaid({
      direction: 'LR',
      groups: [
        { id: 'sys', label: 'System' }, {
          id: 'in', label: 'Inner', parent: 'sys', direction: 'TB',
        },
        { id: 'b', kind: 'bundle' }, { id: 'r', kind: 'row' },
      ],
      nodes: [
        { id: 'x', label: 'X', group: 'in' }, { id: 'y', label: 'Y', group: 'sys' },
        {
          id: 'm', label: 'M', kind: 'storage', group: 'b',
        }, { id: 'z', label: 'Z', group: 'r' },
      ],
      edges: [{ from: 'x', to: 'y', kind: 'channel' }, { from: 'y', to: 'b', kind: 'channel' }],
    });
    assert.match(p.text, /^flowchart LR$/m);
    assert.match(p.text, / {2}subgraph g0\["System"\]\n {4}subgraph g1\["Inner"\]\n {6}direction TB\n {6}n0\["X"\]\n {4}end\n {4}n1\["Y"\]\n {4}c0e\(\(" "\)\)\n {2}end/);
    assert.match(p.text, / {2}subgraph g3\[" "\]\n {4}direction LR\n/);
    // To a bundle of storages: modify access, to the bundle.
    assert.match(p.text, /^ {2}n1 <--> g2$/m);
    assert.equal(p.groups.get('g2').kind, 'bundle');
  });
});

describe('a stack drawing as an FMC block diagram', () => {
  it('is its layers as grey areas, top to bottom, its parts sized by their flows, the visitors on top', () => {
    const d = stackDiagram(ACME);
    assert.deepEqual(d.groups.map((g) => g.id), ['layer:edge', 'layer:site', 'layer:content', 'layer:commerce', 'layer:martech', 'layer:identity']);
    const node = (id) => d.nodes.find((n) => n.id === id);
    // Numbered as the layers list them, as ui/stack.js numbers them.
    assert.equal(node('part:1').label, 'Shop');
    assert.equal(node('part:1').size, 'l');
    assert.equal(node('part:0').size, 'm');
    assert.equal(node('part:5').kind, 'storage');
    // People are the environment: on top, outside the layers.
    assert.equal(node('part:3').group, null);
    assert.equal(node('visitors').kind, 'person');
    // Flows go down the layers; one from a lower layer up into a higher one is laid out upwards.
    const edge = (from, to) => d.edges.find((e) => e.from === from && e.to === to);
    assert.equal(edge('part:0', 'part:1').up, false);
    assert.equal(edge('part:4', 'part:1').up, true);
    assert.equal(edge('part:1', 'part:5').kind, 'read');
    assert.equal(edge('part:3', 'part:4').up, false);
    // The visitors ask what is in front that nothing else asks.
    assert.deepEqual(d.edges.filter((e) => e.from === 'visitors').map((e) => [e.to, e.kind]), [['part:0', 'request']]);
    // Layers without flows are held under the last one with some, in order.
    assert.deepEqual(d.edges.filter((e) => e.kind === 'hidden').map((e) => [e.from, e.to]), [
      ['layer:commerce', 'layer:martech'], ['layer:commerce', 'layer:identity'],
    ]);
    // The flows keep their index, for the inbox to light them.
    assert.deepEqual(d.edges.filter((e) => e.flow != null).map((e) => e.flow), [0, 1, 2, 3, 4]);
    const p = mermaid(d);
    assert.match(p.text, /subgraph g0\["Edge"\]/);
    assert.deepEqual([...p.nodes.values()].filter((n) => n.id === 'part:1').map((n) => n.size), ['l']);
  });

  it('draws what Clef saw, without flows, layer under layer and no visitors', () => {
    const d = stackDiagram({
      layers: [
        { id: 'edge', name: 'Edge', parts: [{ name: 'Fastly' }] },
        { id: 'site', name: 'Site', parts: [{ name: 'Edge Delivery' }, { name: 'AEM' }] },
        { id: 'other', name: 'Other', parts: [{ name: 'Jira' }] },
      ],
      flows: [],
    });
    assert.equal(d.nodes.some((n) => n.id === 'visitors'), false);
    assert.deepEqual(d.nodes.map((n) => n.size), ['m', 'm', 'm', 'm']);
    assert.deepEqual(d.edges.map((e) => [e.from, e.to, e.kind]), [
      ['layer:edge', 'layer:site', 'hidden'], ['layer:site', 'layer:other', 'hidden'],
    ]);
  });

  it('frames a group of parts in its layer, and leaves out a layer of people only', () => {
    const d = stackDiagram({
      layers: [
        { id: 'site', name: 'Site', parts: [{ name: 'Shop' }] },
        { id: 'content', name: 'Content', parts: [{ name: 'Authors', kind: 'person' }] },
        { id: 'commerce', name: 'Commerce and data', parts: [{ name: 'Catalog', kind: 'storage', group: 'Backend' }, { name: 'Orders', kind: 'storage', group: 'backend' }] },
      ],
      flows: [{ from: 'Shop', to: 'Catalog', kind: 'read' }, { from: 'Authors', to: 'Shop', kind: 'request' }],
    });
    assert.deepEqual(d.groups.map((g) => [g.id, g.parent || null]), [
      ['layer:site', null], ['layer:commerce', null], ['group:commerce:backend', 'layer:commerce'],
    ]);
    assert.deepEqual(d.nodes.map((n) => n.group), ['layer:site', null, 'group:commerce:backend', 'group:commerce:backend']);
    assert.doesNotThrow(() => mermaid(d));
  });
});

describe('the FMC renderer', () => {
  it('is served on its own, current with its source, flowcharts only', async () => {
    const file = readFileSync(new URL('../src/ui-fmc.bundle.js', import.meta.url), 'utf8');
    assert.equal(file, await bundle(BUNDLES.find((b) => b.name === 'ui-fmc')), 'run node scripts/ui-markdown.mjs');
    assert.match(FMC, /export\{[^}]*\bdrawStack\b/);
    // Mermaid's other diagrams, its other layouts and KaTeX are not in it (some 3 MB); ELK is.
    assert.ok(FMC.includes('not in this build'));
    assert.ok(!FMC.includes('katex-display'));
    assert.ok(FMC.includes('org.eclipse.elk'));
    assert.ok(FMC.length < 2.6 * 1024 * 1024, `${Math.round(FMC.length / 1024)} KB`);
    const get = (path, headers = {}, method = 'GET') => fmcScript({ method, headers: new Headers(headers) }, path);
    const ok = get(FMC_PATH);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(ok.headers.get('etag'), etag);
    assert.equal(await ok.text(), FMC);
    assert.equal(get(FMC_PATH, { 'if-none-match': etag }).status, 304);
    assert.equal(get(FMC_PATH, {}, 'POST'), null);
    assert.equal(get('/inbox/fmcx.js'), null);
    // The inbox imports it when it first draws a stack.
    assert.ok(SCRIPTS['stack.js'].includes(`'${FMC_PATH}'`));
  });

  it('has a gallery of the guidelines\' good examples, each a diagram it can plan', () => {
    const shown = FIGURES.map((f) => f.n);
    for (const n of [4, 5, 6, 7, 9, 13, 14, 17, 19, 21, 23, 24, 25, 26, 27, 29, 34, 35]) {
      assert.ok(shown.includes(n), `figure ${n}`);
    }
    for (const f of [...FIGURES, ...NOTATION_FIGURES]) {
      assert.match(f.src, /^https:\/\/www\.fmc-modeling\.org\/images\//);
      const p = mermaid(f.diagram);
      assert.ok(p.edges.length || p.nodes.size, f.n);
    }
    const stacks = galleryStacks(stackFile(DRAWING));
    assert.ok(stacks.every((s) => s.view.layers.length));
  });
});
