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
import git from 'isomorphic-git';
import { instance } from '@viz-js/viz';
import {
  checkDot, dotInfo, MAX_DOT_NODES,
} from '../src/dot.js';
import { checkChanges, commitChanges } from '../src/agent/kbwrite.js';
import { memfs } from '../src/agent/memfs.js';
import { checkConcept } from '../src/agent/okf.js';
import { renderFmc } from '../src/fmc.js';
import { FIGURES } from '../scripts/fmc-gallery.mjs';

// Made-up systems only.
const DIAGRAM = `// The path of a request through the CDNs.
// Two lines of it.
digraph delivery {
  label="How a page\\nis delivered";
  node [shape=box, fixedsize=true, width=1.2, height=0.6];
  visitor [fmc=person, label="Visitor"];
  { node [fmc=channel, label="", width=0.16, height=0.16, request=true]; c1; }
  subgraph cluster_edge { fmc=group; label="Edge"; cdn [label="CDN\\n\`*.example.live\`"]; }
  store [fmc=storage, style=rounded, label="Content"];
  /* a block comment */
  visitor -> c1 -> cdn [dir=none];
  cdn -> store [dir=back, lhead=cluster_edge];
}
`;

describe('diagrams (src/dot.js)', () => {
  it('pass DOT the FMC renderer draws: every figure of the gallery, and one by hand', async () => {
    for (const f of FIGURES) {
      for (const d of f.dots) {
        assert.equal(checkDot(d), null, `figure ${f.n}`);
      }
    }
    assert.equal(checkDot(DIAGRAM), null);
    assert.equal(checkDot('strict graph { a -- b -- c; d:n -- e:s:w }'), null);
    assert.equal(checkDot('digraph { "node" -> b; <b>html</b> -> c }'), null);
    // And Graphviz draws it.
    const { svg } = renderFmc(await instance(), DIAGRAM);
    assert.match(svg, /^<svg /);
  });

  it('say what is wrong and on which line', () => {
    const cases = [
      ['digraph { a -- b }', /line 1: a digraph joins nodes with ->, not --/],
      ['graph g {\n a -> b }', /line 2: a graph joins nodes with --, not ->/],
      ['digraph {\n\n a [fmc=box] }', /line 3: fmc on a node is one of agent, storage, channel/],
      ['digraph { subgraph cluster_x { fmc=channel; a } }', /fmc on a subgraph is one of group, agent, storage, set, ushape/],
      ['digraph { c [request=maybe] }', /request is true, back or false, not "maybe"/],
      ['digraph { a -> b', /expected "}" at the end/],
      ['digraph { a } x', /nothing may follow the diagram's closing "}"/],
      ['digraph { a [label="x] }', /a "string" is not closed/],
      ['digraph { a /* b }', /a \/\* comment is not closed/],
      ['# not dot\nflowchart TD;\n A; B', /line 2: a diagram starts with digraph/],
      ['flowchart TD\n A --> B', /line 2: unexpected ">"/],
      ['digraph { a [label=] }', /expected a value for label/],
    ];
    for (const [d, why] of cases) {
      assert.match(checkDot(d) || '', why, d);
    }
    const many = `digraph { ${Array.from({ length: MAX_DOT_NODES + 1 }, (_, i) => `n${i};`).join(' ')} }`;
    assert.match(checkDot(many), /at most 400 nodes/);
    assert.match(checkDot(`digraph { a [label="${'x'.repeat(70000)}"] }`), /at most 64 KB/);
  });

  it('say what they are as the index lists them: the graph label and the leading comment', () => {
    assert.deepEqual(dotInfo('reference/delivery.dot', DIAGRAM), {
      title: 'How a page is delivered', description: 'The path of a request through the CDNs. Two lines of it.',
    });
    assert.deepEqual(dotInfo('reference/edge-stack.dot', 'digraph { a }'), { title: 'edge stack', description: '' });
    assert.deepEqual(dotInfo('x.dot', 'not dot'), { title: 'x', description: '' });
  });
});

describe('diagrams in the knowledge bases', () => {
  const OPTS = {
    message: 'Draw the delivery', by: 'opspile-agent/m', at: '2026-11-17T10:00:00.000Z', logEntry: '**Update**: Draw the delivery',
  };
  const CONCEPT = '---\ntype: Reference\ntitle: Delivery\ndescription: How pages are delivered.\n---\n\nSee [the diagram](/reference/delivery.dot).\n';

  it('are files of their own, checked as DOT, by agents and people alike', () => {
    assert.equal(checkConcept('reference/delivery.dot', DIAGRAM), null);
    assert.match(checkConcept('reference/delivery.dot', 'digraph { a -- b }'), /^not a diagram the inbox can draw: line 1: a digraph joins/);
    assert.match(checkConcept('reference/delivery.svg', '<svg/>'), /end in \.md \(a concept\) or \.dot \(a diagram\)/);
    assert.match(checkChanges([{ path: 'reference/x.dot', content: 'graph { a -> b }' }], { kind: 'team' }), /^reference\/x\.dot: not a diagram/);
    assert.match(checkChanges([{ path: 'reference/x.dot', content: 'graph { a -> b }' }], { staff: true }), /not a diagram/);
    // No frontmatter, and no layout: a diagram goes beside the concept it belongs to.
    assert.equal(checkChanges([{ path: 'sites/www.dot', content: DIAGRAM }], { kind: 'org' }), null);
  });

  it('are committed as written, and listed in their directory\'s index as diagrams', async () => {
    const fs = memfs();
    await fs.mkdirp('/kb');
    await git.init({ fs, dir: '/kb', defaultBranch: 'main' });
    await commitChanges(fs, [
      { path: 'reference/delivery.md', content: CONCEPT },
      { path: 'reference/delivery.dot', content: DIAGRAM },
    ], OPTS);
    // Not stamped: the commit says who wrote it.
    assert.equal(await fs.promises.readFile('/kb/reference/delivery.dot', 'utf8'), DIAGRAM);
    const index = await fs.promises.readFile('/kb/reference/index.md', 'utf8');
    assert.match(index, /^\* \[How a page is delivered\]\(delivery\.dot\) \(Diagram\) - The path of a request through the CDNs\. Two lines of it\.$/m);
    assert.match(index, /^\* \[Delivery\]\(delivery\.md\) \(Reference\) - How pages are delivered\.$/m);
    assert.match(await fs.promises.readFile('/kb/index.md', 'utf8'), /\[reference\]\(reference\/\) - 2 concepts/);
  });
});
