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
 * The gallery of the FMC renderer (src/ui-fmc.js), at /__dev/fmc in `npm run ui:dev` (its page
 * and script in scripts/fmc-gallery/): the good
 * examples of FMC's visualization guidelines, each the article's figure (loaded from
 * fmc-modeling.org, not kept here) beside the renderer's drawing of the same structure, then
 * the notation reference's block diagram elements, then stack drawings of the fake data
 * (scripts/dev-ui-kb.mjs) and of made-up ones.
 *
 * A figure is `{ n, title, good, diagram, how }`: its number in the article, which of its two
 * versions is the good one, the diagram as src/fmc.js has it, and how close the drawing is.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStack, stackFile, stackView } from '../src/stack.js';

const FIG = 'https://www.fmc-modeling.org/images/visualization_guidelines/FMC-VisualizationGuidelines-';
const NOTATION = 'https://www.fmc-modeling.org/images/notation_reference/compositional/';

const agents = (...names) => names.map((label) => ({ id: label, label, size: 's' }));

export const FIGURES = [{
  n: 4,
  title: 'Rounded vs. angular corners of edges',
  good: 'left',
  diagram: {
    nodes: agents('A', 'B', 'C'),
    edges: [{ from: 'A', to: 'B', kind: 'arrow' }, { from: 'A', to: 'C', kind: 'arrow' }],
  },
  how: 'Close: ELK routes the edges orthogonally and Mermaid rounds their corners. They leave A as one edge tree (mergeEdges), as in Figure 5.',
}, {
  n: 5,
  title: 'Edge tree vs. multiple edges',
  good: 'left',
  diagram: {
    nodes: [{ id: 'P', label: ' ', size: 's' }, ...['1', '2', '3'].map((id) => ({ id, label: ' ', size: 's' }))],
    edges: ['1', '2', '3'].map((id) => ({ from: 'P', to: id, kind: 'line' })),
  },
  how: 'Close: the three edges leave the top node as one trunk that branches. ELK makes the branch point; the boxes are harmonized (one size).',
}, {
  n: 6,
  title: 'Good vs. bad arrangement of edges',
  good: 'left',
  diagram: {
    groups: [{ id: 'row', kind: 'row' }],
    nodes: [{ id: 'T', label: ' ', size: 's' }, {
      id: 'L', label: ' ', size: 's', group: 'row',
    }, {
      id: 'R', label: ' ', size: 's', group: 'row',
    }],
    edges: [{ from: 'T', to: 'row', kind: 'hidden' }, { from: 'L', to: 'R', kind: 'arrow' }],
  },
  how: 'Close: the edge keeps its distance from the third node, which sits above it (ELK spaces edges from nodes; an invisible link holds the node there).',
}, {
  n: 7,
  title: 'Good vs. bad arrangement of edges (partial overlapping)',
  good: 'left',
  diagram: {
    nodes: agents('A', 'B', 'C', 'D'),
    edges: [
      { from: 'A', to: 'C', kind: 'arrow' }, { from: 'C', to: 'D', kind: 'arrow' },
      {
        from: 'D', to: 'B', kind: 'arrow', up: true,
      }, { from: 'B', to: 'A', kind: 'arrow' },
      { from: 'A', to: 'D', kind: 'arrow' }, {
        from: 'C', to: 'B', kind: 'arrow', up: true,
      },
    ],
  },
  how: 'Badly: the edges never overlap and keep their distance, but a layered layout has no edges within a layer, so the square of the original (A beside B, C beside D) becomes a column, and there are no diagonals.',
}, {
  n: 9,
  title: 'Good arrangement vs. bad arrangement of nodes',
  good: 'left',
  diagram: {
    nodes: agents('A', 'D', 'B', 'E', 'C'),
    edges: [
      { from: 'A', to: 'B', kind: 'line' }, { from: 'D', to: 'B', kind: 'line' }, { from: 'B', to: 'E', kind: 'line' },
      { from: 'B', to: 'C', kind: 'line' }, { from: 'A', to: 'D', kind: 'line' }, { from: 'A', to: 'E', kind: 'line' },
      { from: 'D', to: 'C', kind: 'line' }, { from: 'E', to: 'C', kind: 'line' },
    ],
  },
  how: 'Partly: no crossings, A on top and C at the bottom, the ring routed around in rounded corners; but D, B and E cannot be one row, since a layered layout has no edges within a layer.',
}, {
  n: 13,
  title: 'Harmonized vs. not harmonized diagram layout',
  good: 'left',
  diagram: {
    nodes: [
      { id: 'B', label: 'B', size: 'l' }, { id: 'A', label: 'A', size: 'l' }, { id: 'E', label: 'E', size: 's' },
      { id: 'F', label: 'F', size: 's' }, { id: 'C', label: 'C', size: 'l' }, { id: 'D', label: 'D', size: 'l' },
    ],
    edges: [
      { from: 'B', to: 'E', kind: 'line' }, { from: 'B', to: 'F', kind: 'line' }, { from: 'A', to: 'E', kind: 'line' },
      { from: 'A', to: 'F', kind: 'line' }, { from: 'E', to: 'C', kind: 'line' }, { from: 'F', to: 'C', kind: 'line' },
      { from: 'E', to: 'D', kind: 'line' }, { from: 'F', to: 'D', kind: 'line' },
    ],
  },
  how: 'Partly: equal sizes, spacing and alignment are there, but the original\'s symmetry around E and F (A and C tall at the sides) is not something a layered layout finds.',
}, {
  n: 14,
  title: 'Easy and difficult distinction of edges and nodes',
  good: 'left',
  diagram: {
    nodes: [{ id: 'b', label: 'b', size: 's' }, { id: 'c', label: 'c', size: 's' }, { id: 'a', label: 'a', size: 'xl' }, { id: 'd', label: 'd', size: 's' }, { id: 'e', label: 'e', size: 's' }],
    edges: [{ from: 'b', to: 'a', kind: 'line' }, { from: 'c', to: 'a', kind: 'line' }, { from: 'a', to: 'd', kind: 'line' }, { from: 'a', to: 'e', kind: 'line' }],
  },
  how: 'The guideline, not the picture: node lines are twice as thick as edges (2 px and 1 px tokens), and a is larger as the important one. The original\'s overlapping corner shapes are not a graph Mermaid can draw.',
}, {
  n: 17,
  title: 'Use of colors for enhancing the visibility of groups',
  good: 'left',
  diagram: {
    groups: [
      { id: 'all', label: ' ' },
      {
        id: 'left', label: ' ', parent: 'all', direction: 'TB',
      },
      {
        id: 'mid', label: ' ', parent: 'all', direction: 'TB',
      },
      {
        id: 'right', label: ' ', parent: 'all', direction: 'TB',
      },
      {
        id: 'low', label: ' ', parent: 'right', direction: 'LR',
      },
    ],
    nodes: [
      {
        id: 'l1', label: ' ', size: 's', group: 'left',
      }, {
        id: 'l2', label: ' ', size: 'l', group: 'left',
      },
      {
        id: 'm1', label: ' ', size: 'xl', group: 'mid',
      }, {
        id: 'm2', label: ' ', size: 's', group: 'mid',
      },
      {
        id: 'r1', label: ' ', size: 's', group: 'right',
      }, {
        id: 'r2', label: ' ', size: 's', group: 'right',
      },
      {
        id: 'r3', label: ' ', size: 's', group: 'low',
      }, {
        id: 'r4', label: ' ', size: 's', group: 'low',
      },
    ],
    edges: [
      { from: 'l1', to: 'l2', kind: 'hidden' }, { from: 'm1', to: 'm2', kind: 'hidden' },
      { from: 'r1', to: 'r2', kind: 'hidden' }, { from: 'r3', to: 'r4', kind: 'hidden' },
    ],
  },
  how: 'Close: nested groups as grey areas, darker as they nest, the nodes white on them. Only two greys and the text color.',
}, {
  n: 19,
  title: 'Layer models',
  good: 'only',
  diagram: {
    nodes: ['4', '3', '2', '1'].map((n) => ({ id: n, label: `Layer ${n}`, size: 'l' })),
    edges: [{ from: '4', to: '3', kind: 'hidden' }, { from: '3', to: '2', kind: 'hidden' }, { from: '2', to: '1', kind: 'hidden' }],
  },
  how: 'Badly: the layers are stacked in order, but ELK keeps a gap between nodes, so they do not touch as contiguous layers do.',
}, {
  n: 21,
  title: 'Usage of a u-shaped node to stress the intended semantics',
  good: 'only',
  diagram: {
    nodes: [...agents('A', 'C', 'B', 'D'), { id: 'Env', label: 'Environment', size: 'xl' }],
    edges: [
      { from: 'A', to: 'C', kind: 'line' }, { from: 'A', to: 'B', kind: 'line' }, { from: 'C', to: 'D', kind: 'line' },
      { from: 'A', to: 'Env', kind: 'line' }, { from: 'B', to: 'Env', kind: 'line' }, { from: 'D', to: 'Env', kind: 'line' }, { from: 'C', to: 'Env', kind: 'line' },
    ],
  },
  how: 'Badly: Mermaid has no U-shaped node, so the environment is a wide node under A to D; the enclosing is lost.',
}, {
  n: 23,
  title: 'Simple vs. complex way of read/write access to a channel',
  good: 'left',
  diagram: {
    nodes: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }],
    edges: [{ from: 'A', to: 'B', kind: 'channel' }],
  },
  how: 'Close: a channel between two agents is a small circle on an undirected edge.',
}, {
  n: 24,
  title: 'Grouping unrelated agents (top) and storages (bottom)',
  good: 'left',
  diagram: {
    direction: 'LR',
    groups: [{
      id: 'AB', kind: 'bundle', label: ' ', direction: 'TB',
    }, {
      id: 'MN', kind: 'bundle', label: ' ', direction: 'TB',
    }],
    nodes: [
      { id: 'X', label: 'X', size: 'l' }, { id: 'A', label: 'A', group: 'AB' }, { id: 'B', label: 'B', group: 'AB' },
      { id: 'L', label: 'L', size: 'xl' }, {
        id: 'M', label: 'M', kind: 'storage', group: 'MN',
      }, {
        id: 'N', label: 'N', kind: 'storage', group: 'MN',
      },
    ],
    edges: [{ from: 'X', to: 'AB', kind: 'channel' }, { from: 'L', to: 'MN', kind: 'modify' }],
  },
  how: 'Close: a bundle is a thin double frame, and one channel or one modify access (FMC\'s pair of arcs) reaches all it holds.',
}, {
  n: 25,
  title: 'Grouping of related nodes',
  good: 'only',
  diagram: {
    order: true,
    groups: [
      { id: 'u1', kind: 'agent', label: ' ' }, { id: 'u2', kind: 'agent', label: ' ' },
      // Without edges, a layered layout puts nodes in one layer: a column left to right (LR), a
      // row top to bottom (TB).
      {
        id: 'mat', kind: 'storage', label: 'Lecture and seminar material', direction: 'LR',
      },
      {
        id: 'se', kind: 'storage', label: 'Lecture Software Engineering', parent: 'mat', direction: 'TB',
      },
      {
        id: 'sa', kind: 'storage', label: 'Lecture Software Architecture', parent: 'mat', direction: 'TB',
      },
    ],
    nodes: [
      {
        id: 'p1', label: ' ', kind: 'person', size: 's', group: 'u1',
      }, { id: 'b1', label: 'Browser', group: 'u1' },
      { id: 'dots', label: '…', kind: 'text' },
      {
        id: 'p2', label: ' ', kind: 'person', size: 's', group: 'u2',
      }, { id: 'b2', label: 'Browser', group: 'u2' },
      { id: 'web', label: 'University web server', size: 'xl' },
      ...[1, 2, 3, 4].map((k) => ({
        id: `se${k}`, label: `Lecture ${k}`, kind: 'storage', size: 's', group: 'se',
      })),
      ...[1, 2, 3, 4].map((k) => ({
        id: `sa${k}`, label: `Lecture ${k}`, kind: 'storage', size: 's', group: 'sa',
      })),
    ],
    edges: [
      { from: 'p1', to: 'b1', kind: 'request' }, { from: 'p2', to: 'b2', kind: 'request' },
      {
        from: 'b1', to: 'web', kind: 'request', label: 'HTTP',
      }, {
        from: 'b2', to: 'web', kind: 'request', label: 'HTTP',
      },
      { from: 'dots', to: 'web', kind: 'hidden' },
      { from: 'web', to: 'mat', kind: 'read' },
    ],
  },
  how: 'Close in structure: the users as agents nesting a person and a browser, R/R channels named HTTP, a nesting storage of nesting storages that the server reads. The vertical dots between the lecture groups are left out, the lectures are one row, and the channel names sit on the edge rather than beside the circle.',
}, {
  n: 26,
  title: 'Arrangement showing a special flow',
  good: 'only',
  diagram: {
    direction: 'LR',
    groups: [{ id: 'compiler', label: 'Compiler' }],
    nodes: [
      {
        id: 'ch', label: 'Characters', kind: 'storage', size: 's',
      },
      {
        id: 'lex', label: 'Lexer', size: 's', group: 'compiler',
      },
      {
        id: 'tok', label: 'Tokens', kind: 'storage', size: 's', group: 'compiler',
      },
      {
        id: 'par', label: 'Parser', size: 's', group: 'compiler',
      },
      {
        id: 'phr', label: 'Phrases', kind: 'storage', size: 's', group: 'compiler',
      },
      {
        id: 'sem', label: 'Semantor', size: 's', group: 'compiler',
      },
      {
        id: 'cor', label: 'Correlated Phrases', kind: 'storage', size: 's', group: 'compiler',
      },
      {
        id: 'gen', label: 'Code Generator', size: 's', group: 'compiler',
      },
      {
        id: 'obj', label: 'Object Code', kind: 'storage', size: 's',
      },
    ],
    edges: [
      // Each agent reads what is left of it: laid out the way the data flows (`up`).
      {
        from: 'lex', to: 'ch', kind: 'read', up: true,
      }, { from: 'lex', to: 'tok', kind: 'write' },
      {
        from: 'par', to: 'tok', kind: 'read', up: true,
      }, { from: 'par', to: 'phr', kind: 'write' },
      {
        from: 'sem', to: 'phr', kind: 'read', up: true,
      }, { from: 'sem', to: 'cor', kind: 'write' },
      {
        from: 'gen', to: 'cor', kind: 'read', up: true,
      }, { from: 'gen', to: 'obj', kind: 'write' },
    ],
  },
  how: 'Close: left to right, as the data flows, agents and storages alternating, the compiler a grey area. Long labels wrap inside the one node size rather than widening their nodes.',
}, {
  n: 27,
  title: 'Enumeration of nodes (agents and channels)',
  good: 'both',
  diagram: {
    order: true,
    nodes: [
      { id: 'A', label: 'A', size: 'l' }, { id: 'B', label: 'B', many: true },
      { id: 'A2', label: 'A', size: 'xl' }, { id: 'B1', label: 'B1' }, { id: 'dots', label: '…', kind: 'text' }, { id: 'Bn', label: 'Bn' },
    ],
    edges: [
      { from: 'A', to: 'B', kind: 'channel' },
      { from: 'A2', to: 'B1', kind: 'channel' }, { from: 'A2', to: 'dots', kind: 'hidden' }, { from: 'A2', to: 'Bn', kind: 'channel' },
    ],
  },
  how: 'Close: both kinds, a node drawn as a stack of the same (many) with one channel for all, and B1 … Bn each with its own.',
}, {
  n: 29,
  title: 'Poor vs. good labeling of a block diagram',
  good: 'lower',
  diagram: {
    direction: 'LR',
    nodes: [
      { id: 'w', label: 'White Player', kind: 'person' },
      {
        id: 'board', label: 'Reversi Board', kind: 'storage', size: 'l',
      },
      { id: 'b', label: 'Black Player', kind: 'person' },
    ],
    edges: [{ from: 'w', to: 'board', kind: 'modify' }, {
      from: 'b', to: 'board', kind: 'modify', up: true,
    }],
  },
  how: 'Close: human agents with their figure, named by their task, modifying a storage named by its content. No picture of the board.',
}, {
  n: 34,
  title: 'Standard arrangement for block diagrams',
  good: 'only',
  diagram: {
    order: true,
    groups: [
      { id: 'env', label: 'Environment (external components)' },
      { id: 'in', label: 'e.g. Input', parent: 'env' },
      { id: 'soi', label: 'System of interest', parent: 'env' },
      { id: 'out', label: 'e.g. Output', parent: 'env' },
    ],
    nodes: [
      {
        id: 'u1', label: ' ', kind: 'person', size: 's', group: 'env',
      },
      {
        id: 'dots', label: '…', kind: 'text', group: 'env',
      },
      {
        id: 'u2', label: ' ', kind: 'person', size: 's', group: 'env',
      },
      {
        id: 'u3', label: ' ', kind: 'person', size: 's', group: 'env',
      },
      {
        id: 'exin', label: 'Ex. Comp.', kind: 'storage', size: 's', group: 'in',
      },
      {
        id: 'A', label: 'A', size: 'xl', group: 'soi',
      },
      {
        id: 'B', label: 'B', size: 'xl', group: 'soi',
      },
      {
        id: 'db', label: 'Database', kind: 'storage', size: 'l', group: 'soi',
      },
      {
        id: 'exout', label: 'Ex. Comp.', size: 's', group: 'out',
      },
      {
        id: 'exouts', label: 'Ex. Comp.', kind: 'storage', size: 's', group: 'out',
      },
    ],
    edges: [
      { from: 'u1', to: 'A', kind: 'channel' }, { from: 'dots', to: 'A', kind: 'hidden' }, { from: 'u2', to: 'A', kind: 'channel' },
      { from: 'u3', to: 'B', kind: 'channel' },
      {
        from: 'A', to: 'exin', kind: 'read', up: true,
      },
      { from: 'A', to: 'B', kind: 'request' },
      { from: 'A', to: 'db', kind: 'modify' },
      { from: 'B', to: 'exout', kind: 'flow' },
      { from: 'exout', to: 'exouts', kind: 'write' },
    ],
  },
  how: 'Partly: the users on top, the system of interest in the middle and largest, input and output as grey areas. A layered layout puts B below A (they are joined by a request channel) rather than beside it, and input and output above and below rather than at the sides.',
}, {
  n: 35,
  title: 'Client-Server Pattern',
  good: 'only',
  diagram: {
    order: true,
    nodes: [
      { id: 'c1', label: 'Client 1' }, { id: 'dots', label: '…', kind: 'text' }, { id: 'cn', label: 'Client n' },
      { id: 's', label: 'Server', size: 'xl' }, {
        id: 'db', label: 'Database', kind: 'storage', size: 'xl',
      },
    ],
    edges: [
      { from: 'c1', to: 's', kind: 'channel' }, { from: 'dots', to: 's', kind: 'hidden' }, { from: 'cn', to: 's', kind: 'channel' },
      { from: 's', to: 'db', kind: 'modify' },
    ],
  },
  how: 'Close: many at the top, few at the bottom, a channel each, the server modifying its database.',
}].map((f) => ({ ...f, src: `${FIG}${f.n}.gif` }));

/** The notation reference's block diagram elements (https://www.fmc-modeling.org/notation_reference). */
export const NOTATION_FIGURES = [
  ['read_access', 'Read access', [{ from: 'A', to: 'S', kind: 'read' }]],
  ['write_access', 'Write access', [{ from: 'A', to: 'S', kind: 'write' }]],
  ['modifying_access', 'Read / write (modifying) access', [{ from: 'A', to: 'S', kind: 'modify' }]],
  ['unidirectional_channel', 'Unidirectional channel', [{ from: 'A1', to: 'A2', kind: 'flow' }]],
  ['bidirectional_channel', 'Bidirectional channel', [{ from: 'A1', to: 'A2', kind: 'channel' }]],
  ['request-response_channel', 'Request / response channel', [{ from: 'A1', to: 'A2', kind: 'request' }]],
  ['shared_storage', 'Shared storage', [{ from: 'A1', to: 'S', kind: 'modify' }, {
    from: 'A2', to: 'S', kind: 'modify', up: true,
  }]],
].map(([file, title, edges]) => {
  const ids = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  return {
    n: file,
    title,
    good: 'only',
    src: `${NOTATION}${file}.gif`,
    diagram: {
      direction: 'LR',
      nodes: ids.map((id) => ({
        id, label: id, kind: id === 'S' ? 'storage' : 'agent', size: 's',
      })),
      edges,
    },
    how: '',
  };
});

/** A made-up stack in the extended format (Group and Kind columns), read as stack.md is. */
const EXTENDED = stackFile({
  summary: 'A made-up shop: a storefront on Edge Delivery behind a CDN, its catalog and orders in a commerce backend, authors in Document Authoring.',
  parts: [
    { layer: 'edge', name: 'CDN', tech: 'fastly' },
    { layer: 'site', name: 'Storefront', tech: 'eds' },
    { layer: 'site', name: 'Checkout', note: 'a single-page app' },
    {
      layer: 'content', name: 'Authors', kind: 'person',
    },
    { layer: 'content', name: 'Document Authoring', tech: 'da' },
    {
      layer: 'content', name: 'Content bus', kind: 'storage', note: 'what is previewed and published',
    },
    {
      layer: 'commerce', group: 'Commerce backend', name: 'Catalog service', tech: 'commerce',
    },
    {
      layer: 'commerce', group: 'Commerce backend', name: 'Catalog', kind: 'storage',
    },
    {
      layer: 'commerce', group: 'Commerce backend', name: 'Orders', kind: 'storage',
    },
    {
      layer: 'commerce', name: 'Payment provider', kind: 'external',
    },
    { layer: 'identity', name: 'IdP', tech: 'sso' },
  ],
  flows: [
    {
      from: 'CDN', to: 'Storefront', kind: 'request', label: 'every page',
    },
    {
      from: 'CDN', to: 'Checkout', kind: 'request', label: '/checkout',
    },
    { from: 'Authors', to: 'Document Authoring', kind: 'request' },
    {
      from: 'Document Authoring', to: 'Content bus', kind: 'write', label: 'publish',
    },
    {
      from: 'Storefront', to: 'Content bus', kind: 'read', label: 'pages',
    },
    {
      from: 'Storefront', to: 'Catalog service', kind: 'request', label: 'prices',
    },
    {
      from: 'Checkout', to: 'Catalog service', kind: 'request', label: 'cart',
    },
    { from: 'Catalog service', to: 'Catalog', kind: 'read' },
    { from: 'Catalog service', to: 'Orders', kind: 'modify' },
    { from: 'Checkout', to: 'Payment provider', kind: 'request' },
    {
      from: 'Authors', to: 'IdP', kind: 'request', label: 'sign in',
    },
  ],
}, { title: 'A made-up shop' });

/** A larger made-up stack, as the agents could draw one, for the layout under load. */
const LARGE = (() => {
  const parts = [
    ['edge', 'CDN A'], ['edge', 'WAF'], ['edge', 'Edge worker'],
    ['site', 'Site EU'], ['site', 'Site US'], ['site', 'Legacy site'], ['site', 'Search page'],
    ['content', 'SharePoint'], ['content', 'Assets'], ['content', 'Translation'], ['content', 'Forms'],
    ['code', 'GitHub'], ['code', 'Actions'], ['code', 'App Builder'],
    ['commerce', 'Commerce'], ['commerce', 'PIM'], ['commerce', 'ERP'], ['commerce', 'Search'], ['commerce', 'CRM'],
    ['martech', 'Analytics'], ['martech', 'Tags'], ['martech', 'Consent'], ['martech', 'Target'],
    ['identity', 'IMS'], ['identity', 'SSO'], ['other', 'Ticketing'],
  ].map(([layer, name]) => ({ layer, name }));
  const flows = [
    ['CDN A', 'WAF'], ['WAF', 'Edge worker'], ['Edge worker', 'Site EU'], ['Edge worker', 'Site US'],
    ['Edge worker', 'Legacy site'], ['CDN A', 'Search page'], ['SharePoint', 'Site EU'], ['SharePoint', 'Site US'],
    ['Assets', 'Site EU'], ['Assets', 'Site US'], ['Translation', 'SharePoint'], ['Forms', 'CRM'],
    ['GitHub', 'Site EU'], ['GitHub', 'Site US'], ['Actions', 'GitHub'], ['App Builder', 'ERP'],
    ['Site EU', 'Commerce'], ['Site US', 'Commerce'], ['Search page', 'Search'], ['PIM', 'Commerce'],
    ['Commerce', 'ERP'], ['PIM', 'Search'], ['Commerce', 'App Builder'], ['Site EU', 'Tags'],
    ['Site US', 'Tags'], ['Tags', 'Analytics'], ['Tags', 'Target'], ['Consent', 'Tags'],
    ['SSO', 'IMS'], ['SharePoint', 'SSO'],
  ].map(([from, to]) => ({ from, to }));
  return stackFile({ summary: 'A made-up, larger stack.', parts, flows });
})();

/**
 * The stacks of the gallery: ACME's drawing from the fake knowledge bases (`acme`, the text of
 * its stack.md), one of what Clef saw (no flows), and the made-up ones.
 */
export function galleryStacks(acme) {
  const view = (text) => stackView(parseStack(text));
  return [
    { title: 'ACME, the fake data\'s stack.md', view: view(acme) },
    {
      title: 'What Clef saw, for a customer without a drawing',
      view: {
        summary: '',
        flows: [],
        notes: '',
        layers: [
          { id: 'edge', name: 'Edge', parts: [{ name: 'Fastly', note: '90% sure' }] },
          { id: 'site', name: 'Site', parts: [{ name: 'Edge Delivery', note: '100% sure' }, { name: 'AEM 6.5', note: '60% sure' }] },
          { id: 'content', name: 'Content', parts: [{ name: 'Document Authoring', note: '80% sure' }] },
          { id: 'other', name: 'Other', parts: [{ name: 'Jira', note: '55% sure' }] },
        ],
      },
    },
    { title: 'A made-up shop in the extended format: kinds of parts and flows, a group', view: view(EXTENDED), text: EXTENDED },
    { title: 'A larger made-up stack: 26 parts, 30 flows', view: view(LARGE) },
  ];
}

const GALLERY = join(dirname(fileURLToPath(import.meta.url)), 'fmc-gallery');

/**
 * The gallery at `pathname` (/__dev/fmc and what it loads) as `{ type, body }`, or null: the
 * page (scripts/fmc-gallery/gallery.html, with ui/'s stylesheets, `scripts`, and its own) and
 * its data, with ACME's stack.md (`acme()`, its text).
 */
export async function gallery(pathname, { scripts, page, acme }) {
  if (pathname === '/__dev/fmc') {
    const [html, css, js] = await Promise.all(['gallery.html', 'gallery.css', 'gallery.js'].map((f) => readFile(join(GALLERY, f), 'utf8')));
    return { type: 'text/html; charset=utf-8', body: page(html, { ...scripts, 'gallery.css': css, 'gallery.js': js }) };
  }
  if (pathname === '/__dev/fmc/data.json') {
    return {
      type: 'application/json',
      body: JSON.stringify({
        figures: FIGURES, notation: NOTATION_FIGURES, stacks: galleryStacks(await acme()),
      }),
    };
  }
  return null;
}
