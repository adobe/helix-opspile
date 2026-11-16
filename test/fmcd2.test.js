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
import { readdirSync, readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import {
  d2String, dotD2, nodeKind, parseDot, rounded, toD2,
} from '../src/fmcd2.js';
import { stackDot } from '../src/fmcstack.js';
import { parseStack, stackFile, stackView } from '../src/stack.js';
import { closeD2, renderD2 } from '../scripts/dev-ui-d2.mjs';
import { FIGURES, stacks } from '../scripts/fmc-gallery.mjs';
import { ACME_STACK } from '../scripts/dev-ui-kb.mjs';

// Made-up systems only.
const acme = () => stackView(parseStack(stackFile(ACME_STACK)));
/** The D2 source's lines that declare a connection. */
const connections = (source) => source.split('\n').filter((l) => /^\S.* (--|->|<-|<->) \S.*: \{ class: /.test(l));

after(closeD2);

describe('DOT, read for D2', () => {
  it('reads nodes, their defaults and attributes, edge chains and comments', () => {
    const g = parseDot(`digraph x {
      // a comment
      graph [rankdir=LR]; /* and another */
      node [shape=box, width=0.5];
      A [label="Say \\"hi\\"", width=1]; B;
      A -> B -> C [dir=none];
      node [fmc=storage];
      D; A -> D;
    }`);
    assert.equal(g.directed, true);
    assert.equal(g.attrs.rankdir, 'LR');
    assert.deepEqual([...g.nodes.keys()], ['A', 'B', 'C', 'D']);
    assert.equal(g.nodes.get('A').attrs.label, 'Say "hi"');
    assert.equal(g.nodes.get('A').attrs.width, '1');
    assert.equal(g.nodes.get('B').attrs.width, '0.5');
    assert.equal(g.nodes.get('D').attrs.fmc, 'storage');
    assert.equal(g.nodes.get('B').attrs.fmc, undefined);
    assert.deepEqual(g.edges.map((e) => [e.tail, e.head, e.attrs.dir]), [['A', 'B', 'none'], ['B', 'C', 'none'], ['A', 'D', undefined]]);
  });

  it('puts a node in the innermost cluster that names it, and keeps the ranks', () => {
    const g = parseDot(`graph y {
      t [fmc=storage];
      subgraph cluster_a { label="A"; fmc=agent;
        subgraph cluster_b { t; u; }
        { rank=same; v; w; }
      }
      x -- u;
    }`);
    assert.equal(g.directed, false);
    assert.deepEqual(g.clusters.map((c) => [c.name, c.depth, c.nodes.map((n) => n.name)]), [
      ['cluster_a', 0, ['v', 'w']], ['cluster_b', 1, ['t', 'u']],
    ]);
    assert.equal(g.nodes.get('x').cluster, g.root);
    assert.deepEqual(g.ranks, [{ rank: 'same', nodes: ['v', 'w'] }]);
  });

  it('reads every figure of the gallery and the stacks', () => {
    for (const f of FIGURES) {
      for (const dot of f.dots) {
        assert.doesNotThrow(() => parseDot(dot), `figure ${f.n}`);
      }
    }
    for (const s of stacks()) {
      assert.doesNotThrow(() => parseDot(stackDot(s.view, { title: s.name }).dot));
    }
    assert.throws(() => parseDot('tree { a -> b }'), /graph/);
    assert.throws(() => parseDot('digraph { a -> }'), /expected a name/);
  });

  it('knows the FMC kinds as src/fmc.js does', () => {
    assert.equal(nodeKind({}), 'agent');
    assert.equal(nodeKind({ style: 'rounded' }), 'storage');
    assert.equal(nodeKind({ shape: 'circle' }), 'channel');
    assert.equal(nodeKind({ style: 'invis' }), 'invis');
    assert.equal(nodeKind({ fmc: 'Person' }), 'person');
  });
});

describe('D2 source', () => {
  it('quotes every name: escapes, substitutions and newlines', () => {
    // eslint-disable-next-line no-template-curly-in-string -- D2's substitution, not ours
    assert.equal(d2String('a "b" $c ${d} \\ e\nf'), '"a \\"b\\" \\$c \\${d} \\\\ e\\nf"');
  });

  it('draws each kind with its class, in our own ids (D2 reserves some names)', () => {
    const d = dotD2(`digraph k {
      top [label="Agent", width=1, height=0.5]; near [fmc=storage, label="S"];
      c [fmc=channel, label="HTTP", labelloc=l]; p [fmc=person, label="Who"];
      dots [fmc=dots, width=0.3, height=0.2]; m [multi=true];
      top -> c -> near [dir=none]; p -> top;
    }`, { zoom: 2 });
    const line = (name) => d.source.split('\n').find((l) => l.includes(`"${name}"`));
    assert.match(line('Agent'), /^n\d+: "Agent" \{ class: fmc-agent; width: 144; height: 72 \}$/);
    assert.match(line('S'), /class: fmc-storage/);
    assert.match(line('HTTP'), /class: fmc-channel; width: 22; height: 22; label.near: outside-left-center/);
    assert.match(line('Who'), /class: fmc-person/);
    assert.match(d.source, /: "\u2026" \{ class: fmc-dots \}/);
    assert.match(d.source, /style.multiple: true/);
    assert.doesNotMatch(d.source, /^(top|near)[ :]/m);
    assert.match(d.source, /^vars: \{ d2-config: \{ layout-engine: elk \} \}$/m);
    assert.match(d.source, /^direction: down$/m);
    assert.equal(connections(d.source).length, 3);
    const arrows = d.edges.map((e) => [e.arrowA, e.arrowB]);
    assert.deepEqual(arrows, [[false, false], [false, false], [false, true]]);
  });

  it('wraps labels to their node and keeps a note on lines of its own', () => {
    const d = dotD2('digraph n { a [label="A rather long name for a node", note="what it does, and more", width=1.5, height=0.75]; }');
    const [, label] = /: ("[^"]*") \{ class: fmc-agent/.exec(d.source);
    const lines = JSON.parse(label).split('\n');
    assert.ok(lines.length >= 2, label);
    assert.ok(lines.some((l) => l.startsWith('what it does')), label);
    const [s] = [...d.shapes.values()];
    assert.ok(s.labelLines >= 1 && s.lines > s.labelLines);
  });

  it('writes frames as containers, compound edges to them, modify access to storages', () => {
    const d = dotD2(`digraph f {
      graph [compound=true];
      L; subgraph cluster_s { fmc=set; style=rounded; label=""; M [fmc=storage]; N [fmc=storage]; }
      subgraph cluster_sys { label="System"; labelloc=b; labeljust=l; A; B; }
      L -> M [dir=both, lhead=cluster_s]; A -> B;
    }`);
    assert.match(d.source, /^g\d+: "" \{\n {2}class: fmc-frame-set\n {2}style.border-radius: 32$/m);
    assert.match(d.source, /^g\d+: "System" \{\n {2}class: fmc-group\n {2}label.near: bottom-left$/m);
    const [toSet] = connections(d.source);
    assert.match(toSet, /^n\d+ <-> g\d+: \{ class: fmc-edge \}$/);
    assert.deepEqual(d.edges.map((e) => e.modify), [true, false]);
  });

  it('keeps the order of a stack\'s layers, which D2 has no ranks for', () => {
    const d = dotD2(stackDot(acme(), { title: 'ACME' }).dot);
    const layers = [...d.shapes.entries()].filter(([, s]) => s.cluster?.attrs.layer)
      .map(([id, s]) => [id, s.cluster.attrs.layer]);
    assert.deepEqual(layers.map(([, l]) => l), ['edge', 'site', 'content', 'code', 'commerce', 'martech', 'identity']);
    const hidden = connections(d.source).filter((l) => /fmc-hidden/.test(l));
    for (let k = 1; k < layers.length; k += 1) {
      const [a, b] = [layers[k - 1][0], layers[k][0]];
      assert.ok(hidden.some((l) => l.startsWith(`${a} -- ${b}:`)), `${a} before ${b}`);
    }
    // A caption (Identity shares Graphviz's rank with Marketing) names its frame instead.
    assert.doesNotMatch(d.source, /class: fmc-caption/);
    assert.match(d.source, /: "Identity" \{\n\s+class: fmc-group\n\s+label.near: top-left/);
    // Every part once, every flow: an edge to a storage, or two through a channel.
    for (const p of ACME_STACK.parts) {
      assert.equal(d.source.split(`"${p.name}`).length - 1, 1, p.name);
    }
    const flows = d.edges.filter((e) => !e.hidden);
    const drawn = [...new Set(flows.map((e) => Number(e.flow)))].sort((a, b) => a - b);
    assert.deepEqual(drawn, ACME_STACK.flows.map((f, i) => i));
  });

  it('draws a stack without flows (what Clef saw) as a grid of layers', () => {
    const [, , saw] = stacks();
    const d = dotD2(stackDot(saw.view).dot);
    assert.match(d.source, /^grid-columns: 1$/m);
    assert.equal((d.source.match(/grid-columns: \d+/g) || []).length, 1 + saw.view.layers.length);
    assert.equal(connections(d.source).length, 0);
  });

  it('lays out left to right where the DOT does, with dagre if asked', () => {
    const d = toD2(parseDot('digraph r { rankdir=LR; a -> b; }'), { layout: 'dagre' });
    assert.match(d.source, /^direction: right$/m);
    assert.match(d.source, /layout-engine: dagre/);
  });

  it('rounds the corners of orthogonal paths', () => {
    assert.equal(rounded([[0, 0], [0, 20], [20, 20]], 6), 'M0,0 L0,14 Q0,20 6,20 L20,20');
  });
});

describe('D2, drawn (in Node, as ui:dev does)', () => {
  it('draws ACME as an FMC block diagram in the page\'s classes', async () => {
    const view = acme();
    const { svg, width, height } = await renderD2({ view, title: 'ACME' });
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" class="fmc fmc-d2" viewBox="[-\d. ]+" width="[\d.]+" height="[\d.]+" role="img" aria-label="ACME">/);
    assert.ok(width > 100 && height > 100);
    // No theme of D2's: colors, fonts and styles are the page's.
    assert.doesNotMatch(svg, /#[0-9A-Fa-f]{6}|<style|style="|font-face|marker|mask/);
    const parts = view.layers.flatMap((l) => l.parts);
    for (const i of parts.keys()) {
      assert.equal((svg.match(new RegExp(`data-part="${i}"`, 'g')) || []).length, 1, parts[i].name);
    }
    // An R at each request channel; two arcs for the modify access.
    const requests = ACME_STACK.flows.filter((f) => f.kind === 'request').length;
    assert.equal((svg.match(/class="fmc-r"/g) || []).length, requests);
    const modify = ACME_STACK.flows.findIndex((f) => f.kind === 'modify');
    assert.equal((svg.match(new RegExp(`class="fmc-edge" data-flow="${modify}"`, 'g')) || []).length, 2);
    // Edge Delivery's reads are one tree: one arrowhead for all three.
    const reads = ACME_STACK.flows.map((f, i) => [f, i]).filter(([f]) => f.kind === 'read' && f.from === 'Edge Delivery').map(([, i]) => String(i));
    const heads = [...svg.matchAll(/class="fmc-arrow" data-flows="([^"]*)"/g)].map((m) => m[1].split(' '));
    assert.ok(heads.some((h) => reads.every((r) => h.includes(r))), JSON.stringify(heads));
    // Its layers' frames as wide as each other.
    const frames = [...svg.matchAll(/<g class="fmc-frame fmc-frame-group fmc-depth-1" data-layer="[^"]+"><rect class="fmc-shape" x="([-\d.]+)" y="[-\d.]+" width="([\d.]+)"/g)];
    assert.equal(frames.length, 7);
    assert.equal(new Set(frames.map((m) => `${m[1]}:${m[2]}`)).size, 1);
  });

  it('draws the figures: a u-shaped agent, a set, a person', async () => {
    const fig = (n) => FIGURES.find((f) => f.n === n).dots;
    const u = await renderD2({ dot: fig(21)[0] });
    assert.match(u.svg, /fmc-frame-ushape[^>]*><path class="fmc-shape" d="M[-\d.]+,[-\d.]+ H[-\d.]+ V/);
    const set = await renderD2({ dot: fig(24)[0] });
    assert.match(set.svg, /fmc-frame-set[^>]*><rect class="fmc-shape"[^>]*\/><rect class="fmc-inner"/);
    const people = await renderD2({ dot: fig(29)[0] });
    assert.equal((people.svg.match(/<circle class="fmc-figure"/g) || []).length, 2);
    await assert.rejects(renderD2({ dot: 'digraph { a -> }' }), /expected a name/);
  });
});

describe('the inbox Worker', () => {
  it('has no D2: nothing it serves imports it', () => {
    for (const f of readdirSync(new URL('../src/', import.meta.url)).filter((n) => n.endsWith('.js'))) {
      const text = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
      assert.doesNotMatch(text, /from '@terrastruct\/d2'|import\('@terrastruct\/d2'\)/, f);
      assert.doesNotMatch(text, /from '[^']*fmcd2\.js'/, f);
    }
  });
});
