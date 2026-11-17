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
import { describe, it } from 'node:test';
import { instance } from '@viz-js/viz';
import { complaint, layout, render } from '../src/graphviz/render.js';
import { checkDiagrams, drawDiagram } from '../src/diagrams.js';
import { renderFmc } from '../src/fmc.js';
import { FIGURES } from '../scripts/fmc-gallery.mjs';
import { build, IMAGES, indexOf } from '../scripts/computer-images.mjs';

const viz = await instance();
/** The kernel's `run` of dot, played by viz-js: what the renderer Worker gets. */
const calls = [];
const run = async (argv, { stdin }) => {
  calls.push(argv);
  const engine = argv.find((a) => a.startsWith('-K')).slice(2);
  const format = argv.find((a) => a.startsWith('-T')).slice(2);
  const r = viz.render(stdin, { engine, format });
  const stderr = r.errors.map((e) => `${e.level === 'error' ? 'Error' : 'Warning'}: ${e.message}`).join('\n');
  return r.status === 'success' ? { status: 0, stdout: r.output, stderr } : { status: 1, stdout: '', stderr };
};

describe('the renderer Worker (src/graphviz/render.js)', () => {
  it('runs dot with the engine and format asked for, on the DOT as stdin', async () => {
    const res = await layout(run, 'digraph { a -> b }', { engine: 'neato', format: 'svg' });
    assert.equal(res.ok, true);
    assert.match(res.out, /^<\?xml|<svg/);
    assert.deepEqual(calls.at(-1), ['dot', '-Kneato', '-Tsvg']);
    assert.match((await layout(run, 'x', { engine: 'rm -rf' })).error, /engine is one of dot, neato/);
    assert.match((await layout(run, 'x', { format: 'png' })).error, /format is one of json0, json, svg/);
    assert.match((await layout(run, 'digraph { a -> }')).error, /syntax error in line 1/);
  });

  it('gives up on a layout that takes too long', async () => {
    const slow = () => new Promise(() => {});
    const res = await layout(slow, 'digraph { a }', { timeout: 20 });
    assert.deepEqual(res, { ok: false, error: 'dot took longer than 0.02 s', timedOut: true });
  });

  it('says dot\'s complaint in a line, without its warnings about fonts', () => {
    assert.equal(complaint('Warning: no fontconfig\nError: <stdin>: syntax error in line 3 near \'}\'\n'), '<stdin>: syntax error in line 3 near \'}\'');
    assert.equal(complaint(''), 'dot could not lay it out');
  });

  it('draws what the page draws: every figure of the gallery, the same SVG', async () => {
    for (const f of FIGURES) {
      for (const d of f.dots) {
        // eslint-disable-next-line no-await-in-loop
        const res = await render(run, d);
        assert.equal(res.ok, true, `figure ${f.n}`);
        assert.equal(res.svg, renderFmc(viz, d).svg, `figure ${f.n}`);
      }
    }
    // As json0, dot's layout without its drawing instructions, which src/fmc.js does not read.
    assert.deepEqual(calls.at(-1), ['dot', '-Kdot', '-Tjson0']);
    // src/dot.js first, with its line.
    assert.match((await render(run, 'graph { a -> b }')).error, /^line 1: a graph joins nodes with --/);
  });
});

describe('diagrams with the renderer (src/diagrams.js)', () => {
  const GRAPHVIZ = {
    layout: (dot, o) => layout(run, dot, o),
    render: (dot, o) => render(run, dot, o),
  };

  it('refuse a write of what dot cannot lay out, and let one through without a renderer', async () => {
    // Passes src/dot.js, which does not read labels; dot says Error, and lays it out anyway.
    const bad = [{ path: 'reference/x.dot', content: 'digraph { node [shape=record, label="{a|"]; x }' }];
    assert.match(await checkDiagrams({ GRAPHVIZ }, bad), /^reference\/x\.dot: Graphviz cannot lay it out: bad label format \{a\|$/);
    assert.equal(await checkDiagrams({ GRAPHVIZ }, [{ path: 'reference/x.dot', content: 'digraph { a -> b }' }]), null);
    assert.equal(await checkDiagrams({ GRAPHVIZ }, [{ path: 'reference/x.md', content: 'not dot' }]), null);
    assert.equal(await checkDiagrams({}, bad), null);
    // A renderer that is down: src/dot.js has to do.
    const down = {
      layout: async () => {
        throw new Error('gone');
      },
    };
    const errors = [];
    const { error } = console;
    console.error = (m) => errors.push(m);
    try {
      assert.equal(await checkDiagrams({ GRAPHVIZ: down }, bad), null);
    } finally {
      console.error = error;
    }
    assert.match(errors[0], /"route":"graphviz","error":"gone"/);
  });

  it('draw on the server for POST /api/diagram, and answer 503 where there is no renderer', async () => {
    const ok = await drawDiagram({ GRAPHVIZ }, { dot: 'digraph { a -> b }', title: 'x' });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.match(body.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="fmc" [^>]*aria-label="x"/);
    assert.equal((await drawDiagram({ GRAPHVIZ }, { dot: 'graph { a -> b }' })).status, 422);
    assert.equal((await drawDiagram({ GRAPHVIZ }, {})).status, 400);
    assert.equal((await drawDiagram({}, { dot: 'digraph { a }' })).status, 503);
    // Out of time: 503 too, so the page draws it itself.
    const slow = { render: async () => ({ ok: false, error: 'dot took longer than 10 s', timedOut: true }) };
    assert.equal((await drawDiagram({ GRAPHVIZ: slow }, { dot: 'digraph { a }' })).status, 503);
  });
});

describe('dot in the images', () => {
  it('is in the agents\' Base image, and alone in the renderer\'s, which teams are not offered', async () => {
    const built = await build({ images: IMAGES.filter((i) => ['base', 'graphviz'].includes(i.name)) });
    const base = built.images.find((i) => i.name === 'base');
    const graphviz = built.images.find((i) => i.name === 'graphviz');
    assert.ok(base.commands.includes('dot'));
    assert.match(base.tools, /, dot \(Graphviz\)$/);
    assert.deepEqual(graphviz.commands, ['dot']);
    assert.equal(graphviz.internal, true);
    assert.deepEqual(indexOf(built.images).images.map((i) => i.name), ['base']);
  });
});
