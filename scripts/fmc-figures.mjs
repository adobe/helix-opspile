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
 * The good examples of the FMC visualization guidelines
 * (https://www.fmc-modeling.org/visualization_guidelines), as diagrams for the runner
 * (src/fmc.js): each figure's structure, with what the original shows on its good side.
 * scripts/fmc-gallery.mjs draws them next to the original GIFs, which it loads from
 * fmc-modeling.org (they are not in this repository).
 */

const n = (id, label = id, more = {}) => ({ id, label, ...more });
const sq = { cell: { w: 46, h: 46 } };

export const FIGURES = [{
  fig: '4',
  title: 'Rounded vs. angular corners of edges',
  good: 'left',
  diagram: {
    ...sq,
    gapX: 46,
    gapY: 40,
    nodes: [n('A'), n('B'), n('C')],
    edges: [{ from: 'A', to: 'B', kind: 'arrow' }, { from: 'A', to: 'C', kind: 'arrow' }],
  },
}, {
  fig: '5',
  title: 'Edge tree vs. multiple edges',
  good: 'left',
  diagram: {
    cell: { w: 46, h: 14 },
    gapX: 14,
    gapY: 40,
    nodes: [n('T', ''), n('a', ''), n('b', ''), n('c', '')],
    edges: [{ from: 'T', to: 'a' }, { from: 'T', to: 'b' }, { from: 'T', to: 'c' }],
  },
}, {
  fig: '6',
  title: 'Good vs. bad arrangement of edges',
  good: 'left',
  note: 'The edge keeps its distance from the node above it.',
  diagram: {
    ...sq,
    direction: 'RIGHT',
    components: false,
    gapX: 30,
    gapY: 30,
    nodes: [n('A', '', { rank: 0 }), n('X', '', { rank: 1 }), n('B', '', { rank: 2 })],
    edges: [{ from: 'A', to: 'B', kind: 'arrow' }],
  },
}, {
  fig: '7',
  title: 'Good vs. bad arrangement of edges (partial overlapping)',
  good: 'left',
  note: 'Orthogonal instead of diagonal: the edges keep their distance, so their directions stay apart.',
  diagram: {
    ...sq,
    gapX: 70,
    gapY: 50,
    nodes: [n('A', 'A', { rank: 0 }), n('B', 'B', { rank: 0 }), n('C', 'C', { rank: 1 }), n('D', 'D', { rank: 1 })],
    edges: [
      { from: 'A', to: 'C', kind: 'arrow' }, {
        from: 'B', to: 'A', kind: 'arrow', same: true,
      },
      {
        from: 'C', to: 'D', kind: 'arrow', same: true,
      }, { from: 'D', to: 'B', kind: 'arrow' },
      { from: 'A', to: 'D', kind: 'arrow' }, { from: 'C', to: 'B', kind: 'arrow' },
    ],
  },
}, {
  fig: '9',
  title: 'Good vs. bad arrangement of nodes',
  good: 'left',
  diagram: {
    cell: { w: 46, h: 30 },
    gapX: 30,
    gapY: 30,
    nodes: [
      n('A', 'A', { ports: [{ id: 'w', side: 'WEST' }, { id: 's', side: 'SOUTH' }, { id: 'e', side: 'EAST' }] }),
      n('D'), n('B'), n('E'),
      n('C', 'C', { ports: [{ id: 'w', side: 'WEST' }, { id: 'n', side: 'NORTH' }, { id: 'e', side: 'EAST' }] }),
    ],
    edges: [
      { from: 'A', to: 'D', fromPort: 'w' }, { from: 'A', to: 'B', fromPort: 's' }, { from: 'A', to: 'E', fromPort: 'e' },
      { from: 'D', to: 'C', toPort: 'w' }, { from: 'B', to: 'C', toPort: 'n' }, { from: 'E', to: 'C', toPort: 'e' },
      { from: 'D', to: 'B', same: true }, { from: 'B', to: 'E', same: true },
    ],
  },
}, {
  fig: '10',
  title: 'Modified shape and area vs. unmodified shape and area of nodes',
  good: 'left',
  diagram: {
    cell: { w: 46, h: 30 },
    gapX: 30,
    gapY: 24,
    nodes: [n('A'), n('B'), n('D', 'D', { size: [1, 2] }), n('C', 'C', { size: [2, 1] })],
    edges: [{ from: 'A', to: 'C' }, { from: 'B', to: 'C' }, { from: 'B', to: 'D' }, { from: 'D', to: 'C', flip: true }],
  },
}, {
  fig: '11',
  title: 'Enumeration of several nodes of a well-known set',
  good: 'both',
  diagram: {
    cell: { w: 46, h: 46 },
    gapX: 30,
    gapY: 24,
    nodes: [n('A', 'A', { size: [3, 1] }), n('B'), n('C', 'C', { enumerated: true })],
    edges: [{ from: 'A', to: 'B' }, { from: 'A', to: 'C', tree: 'c' }],
  },
}, {
  fig: '13',
  title: 'Harmonized vs. not harmonized diagram layout',
  good: 'left',
  note: 'ELK\'s layers have no room for A and C beside E and F: the same symmetric structure, turned.',
  diagram: {
    cell: { w: 50, h: 50 },
    gapX: 50,
    gapY: 50,
    nodes: [
      n('A', 'A', { size: [1, 1.4] }), n('B', 'B', { size: [2, 1] }), n('E', 'E', { rank: 1 }), n('F', 'F', { rank: 1 }),
      n('D', 'D', { size: [2, 1], rank: 2 }), n('C', 'C', { size: [1, 1.4], rank: 2 }),
    ].map((x) => ({ rank: 0, ...x })),
    edges: [
      { from: 'A', to: 'E' }, { from: 'A', to: 'F' }, { from: 'B', to: 'E' }, { from: 'B', to: 'F' },
      { from: 'E', to: 'C' }, { from: 'F', to: 'C' }, { from: 'E', to: 'D' }, { from: 'F', to: 'D' },
    ],
  },
}, {
  fig: '14',
  title: 'Easy and difficult distinction of edges and nodes',
  good: 'left',
  note: 'The node\'s line is twice as thick as the edges\' (the four loops).',
  diagram: {
    cell: { w: 120, h: 120 },
    nodes: [n('a', 'a', {
      ports: [
        { id: 'n1', side: 'NORTH' }, { id: 'n2', side: 'NORTH' }, { id: 'e1', side: 'EAST' }, { id: 'e2', side: 'EAST' },
        { id: 's1', side: 'SOUTH' }, { id: 's2', side: 'SOUTH' }, { id: 'w1', side: 'WEST' }, { id: 'w2', side: 'WEST' },
      ],
    })],
    edges: [
      {
        from: 'a', to: 'a', fromPort: 'w1', toPort: 'n1', label: 'b',
      },
      {
        from: 'a', to: 'a', fromPort: 'n2', toPort: 'e1', label: 'c',
      },
      {
        from: 'a', to: 'a', fromPort: 'w2', toPort: 's1', label: 'd',
      },
      {
        from: 'a', to: 'a', fromPort: 'e2', toPort: 's2', label: 'e',
      },
    ],
  },
}, {
  fig: '17',
  title: 'Use of colors for enhancing the visibility of groups',
  good: 'left',
  diagram: {
    cell: { w: 50, h: 24 },
    gapX: 12,
    gapY: 12,
    groups: [
      { id: 'all', kind: 'area' }, { id: 'L', kind: 'area', parent: 'all' },
      { id: 'R', kind: 'area', parent: 'all' }, { id: 'R2', kind: 'area', parent: 'R' },
    ],
    nodes: [
      n('l1', '', { group: 'L', size: [2, 1] }), n('l2', '', { group: 'L', size: [2, 3] }),
      n('c1', '', { group: 'all', size: [3, 3] }), n('c2', '', { group: 'all', size: [1, 2] }),
      n('r1', '', { group: 'R' }), n('r2', '', { group: 'R', size: [1, 3] }),
      n('r3', '', { group: 'R2' }), n('r4', '', { group: 'R2', size: [1.4, 1] }),
    ],
    edges: [
      { from: 'l1', to: 'l2', hidden: true }, { from: 'c1', to: 'c2', hidden: true },
      { from: 'r1', to: 'r2', hidden: true }, { from: 'c1', to: 'r3', hidden: true },
    ],
  },
}, {
  fig: '19',
  title: 'Layer models',
  good: 'both',
  diagram: {
    cell: { w: 100, h: 28 },
    gapY: 0,
    nodes: [n('l4', 'Layer 4'), n('l3', 'Layer 3'), n('l2', 'Layer 2'), n('l1', 'Layer 1')],
    edges: [{ from: 'l4', to: 'l3', hidden: true }, { from: 'l3', to: 'l2', hidden: true }, { from: 'l2', to: 'l1', hidden: true }],
  },
}, {
  fig: '21',
  title: 'Usage of a u-shaped node to stress the intended semantics',
  good: 'both',
  diagram: {
    cell: { w: 46, h: 30 },
    gapX: 30,
    gapY: 30,
    direction: 'RIGHT',
    groups: [{
      id: 'env', kind: 'u', label: 'Environment', ports: [{ id: 'w', side: 'WEST' }, { id: 'e', side: 'EAST' }, { id: 's1', side: 'SOUTH' }, { id: 's2', side: 'SOUTH' }],
    }],
    nodes: [n('A', 'A', { group: 'env' }), n('B', 'B', { group: 'env' }), n('C', 'C', { group: 'env' }), n('D', 'D', { group: 'env' })],
    edges: [
      { from: 'A', to: 'C' }, { from: 'B', to: 'D', hidden: true },
      { from: 'A', to: 'B', same: true }, { from: 'C', to: 'D', same: true },
      { from: 'env', to: 'A', fromPort: 'w' }, { from: 'C', to: 'env', toPort: 'e' },
      { from: 'B', to: 'env', toPort: 's1' }, { from: 'D', to: 'env', toPort: 's2' },
    ],
  },
}, {
  fig: '23',
  title: 'Simple vs. complex way of read/write access to a channel',
  good: 'left',
  diagram: {
    cell: { w: 66, h: 30 },
    gapY: 34,
    nodes: [n('A'), n('B')],
    edges: [{ from: 'A', to: 'B', kind: 'channel' }],
  },
}, {
  fig: '24',
  title: 'Grouping unrelated agents (top) and storages (bottom)',
  good: 'left',
  diagrams: [{
    cell: { w: 66, h: 26 },
    gapX: 40,
    gapY: 30,
    direction: 'RIGHT',
    groups: [{ id: 'AB', kind: 'set' }],
    nodes: [n('X', 'X', { size: [0.5, 2] }), n('A', 'A', { group: 'AB' }), n('B', 'B', { group: 'AB' })],
    edges: [{ from: 'X', to: 'AB', kind: 'channel' }],
  }, {
    cell: { w: 66, h: 26 },
    gapX: 12,
    gapY: 30,
    groups: [{ id: 'MN', kind: 'set', round: true }],
    nodes: [n('L', 'L', { size: [2.3, 1] }), n('M', 'M', { kind: 'storage', group: 'MN' }), n('N', 'N', { kind: 'storage', group: 'MN' })],
    edges: [{ from: 'L', to: 'MN', kind: 'modify' }],
  }],
}, {
  fig: '25',
  title: 'Grouping of related nodes',
  good: 'both',
  diagram: {
    cell: { w: 76, h: 24 },
    gapX: 18,
    gapY: 20,
    groups: [
      { id: 'c1', kind: 'agent' }, { id: 'c2', kind: 'agent' },
      { id: 'mat', kind: 'storage', label: 'Lecture and seminar material' },
      {
        id: 'se', kind: 'storage', label: 'Lecture Software Engineering', parent: 'mat',
      },
      {
        id: 'sa', kind: 'storage', label: 'Lecture Software Architecture', parent: 'mat',
      },
    ],
    nodes: [
      n('u1', '', { kind: 'person', group: 'c1', size: [0.4, 1.4] }), n('b1', 'Browser', { group: 'c1' }),
      n('more', '', { kind: 'dots' }),
      n('u2', '', { kind: 'person', group: 'c2', size: [0.4, 1.4] }), n('b2', 'Browser', { group: 'c2' }),
      n('ws', 'University web server', { size: [4, 1] }),
      ...['se', 'sa'].flatMap((g) => [1, 2, 3, 4].map((i) => n(`${g}${i}`, `Lecture ${i}`, { kind: 'storage', group: g, size: [1.3, 1] }))),
      n('vd', '', { kind: 'vdots', group: 'mat' }),
    ],
    edges: [
      { from: 'u1', to: 'b1', kind: 'request' }, { from: 'u2', to: 'b2', kind: 'request' },
      {
        from: 'b1', to: 'ws', kind: 'request', label: 'HTTP',
      }, {
        from: 'b2', to: 'ws', kind: 'request', label: 'HTTP',
      },
      { from: 'more', to: 'ws', hidden: true },
      { from: 'mat', to: 'ws', kind: 'read' },
      { from: 'se1', to: 'se3', hidden: true }, { from: 'se2', to: 'se4', hidden: true },
      { from: 'sa1', to: 'sa3', hidden: true }, { from: 'sa2', to: 'sa4', hidden: true },
      { from: 'se3', to: 'vd', hidden: true }, { from: 'se4', to: 'vd', hidden: true },
      { from: 'vd', to: 'sa1', hidden: true }, { from: 'vd', to: 'sa2', hidden: true },
    ],
  },
}, {
  fig: '26',
  title: 'Arrangement showing a special flow',
  good: 'both',
  diagram: {
    cell: { w: 80, h: 34 },
    gapX: 14,
    gapY: 16,
    direction: 'RIGHT',
    groups: [{
      id: 'comp', kind: 'area', label: 'Compiler', labelAt: 'bottom',
    }],
    nodes: [
      n('ch', 'Characters', { kind: 'storage' }), n('lex', 'Lexer', { group: 'comp' }),
      n('tok', 'Tokens', { kind: 'storage', group: 'comp' }), n('par', 'Parser', { group: 'comp' }),
      n('phr', 'Phrases', { kind: 'storage', group: 'comp' }), n('sem', 'Semantor', { group: 'comp' }),
      n('cph', 'Correlated Phrases', { kind: 'storage', group: 'comp' }), n('gen', 'Code Generator', { group: 'comp' }),
      n('obj', 'Object Code', { kind: 'storage' }),
    ],
    edges: [
      ['ch', 'lex'], ['lex', 'tok'], ['tok', 'par'], ['par', 'phr'], ['phr', 'sem'], ['sem', 'cph'], ['cph', 'gen'], ['gen', 'obj'],
    ].map(([from, to], i) => ({ from, to, kind: i % 2 ? 'write' : 'read' })),
  },
}, {
  fig: '27',
  title: 'Enumeration of nodes (agents and channels)',
  good: 'both',
  diagram: {
    cell: { w: 90, h: 34 },
    gapY: 18,
    nodes: [n('A', 'A', { size: [1.2, 1] }), n('B', 'B', { enumerated: true })],
    edges: [{ from: 'A', to: 'B', kind: 'channel' }],
  },
}, {
  fig: '29',
  title: 'Poor vs. good labeling of a block diagram',
  good: 'bottom',
  diagram: {
    cell: { w: 70, h: 100 },
    gapX: 30,
    direction: 'RIGHT',
    nodes: [
      n('w', 'White Player', { kind: 'person' }),
      n('board', 'Reversi Board', { kind: 'storage', icon: 'board', size: [1.9, 1.3] }),
      n('b', 'Black Player', { kind: 'person' }),
    ],
    edges: [{ from: 'w', to: 'board', kind: 'modify' }, {
      from: 'b', to: 'board', kind: 'modify', flip: true,
    }],
  },
}, {
  fig: '34',
  title: 'Standard arrangement for block diagrams',
  good: 'both',
  diagram: {
    cell: { w: 60, h: 44 },
    gapX: 24,
    gapY: 24,
    groups: [
      { id: 'env', kind: 'area', label: 'Environment (external components)' },
      {
        id: 'in', kind: 'area', label: 'e.g. Input', labelAt: 'bottom', parent: 'env',
      },
      {
        id: 'sys', kind: 'area', label: 'System of interest', labelAt: 'bottom', parent: 'env',
      },
      {
        id: 'out', kind: 'area', label: 'e.g. Output', labelAt: 'bottom', parent: 'env',
      },
    ],
    nodes: [
      n('p1', '', { kind: 'person', group: 'env', size: [0.6, 1] }), n('pd', '', { kind: 'dots', group: 'env' }),
      n('p2', '', { kind: 'person', group: 'env', size: [0.6, 1] }), n('p3', '', { kind: 'person', group: 'env', size: [0.6, 1] }),
      n('in1', 'Ex. Comp.', { kind: 'storage', group: 'in', size: [1, 1.6] }),
      n('A', 'A', { group: 'sys', size: [3, 1.6] }), n('B', 'B', { group: 'sys', size: [2, 3] }),
      n('db', 'Database', { kind: 'storage', group: 'sys', size: [3, 0.8] }),
      n('o1', 'Ex. Comp.', { group: 'out', size: [1, 1.6] }), n('o2', 'Ex. Comp.', { kind: 'storage', group: 'out', size: [1, 1.2] }),
    ],
    edges: [
      { from: 'p1', to: 'A', kind: 'channel' }, { from: 'p2', to: 'A', kind: 'channel' }, { from: 'p3', to: 'B', kind: 'channel' },
      { from: 'pd', to: 'A', hidden: true },
      { from: 'in1', to: 'A', kind: 'read' },
      {
        from: 'A', to: 'B', kind: 'request', same: true,
      },
      { from: 'A', to: 'db', kind: 'modify' },
      { from: 'B', to: 'o1', kind: 'send' },
      { from: 'o1', to: 'o2', kind: 'write' },
    ],
  },
}, {
  fig: '35',
  title: 'Client-Server Pattern',
  good: 'both',
  diagram: {
    cell: { w: 70, h: 40 },
    gapX: 16,
    gapY: 26,
    components: false,
    nodes: [
      n('c1', 'Client 1', { rank: 0 }), n('cd', '', { kind: 'dots', rank: 0 }), n('cn', 'Client n', { rank: 0 }),
      n('s', 'Server', { size: [3, 1], rank: 1 }), n('db', 'Database', { kind: 'storage', size: [3, 1], rank: 2 }),
    ],
    edges: [
      { from: 'c1', to: 's', kind: 'channel' }, { from: 'cn', to: 's', kind: 'channel' },
      { from: 's', to: 'db', kind: 'modify' },
    ],
  },
}, {
  fig: 'notation',
  title: 'The block diagram notation (notation reference)',
  src: 'https://www.fmc-modeling.org/images/notation_reference/compositional/request-response_channel.gif',
  good: 'both',
  diagram: {
    cell: { w: 60, h: 30 },
    gapX: 30,
    gapY: 30,
    direction: 'RIGHT',
    nodes: [
      n('A1'), n('A2'), n('A3'), n('A4'), n('A5'), n('A6'), n('A7'),
      n('S1', 'S', { kind: 'storage' }), n('S2', 'S', { kind: 'storage' }), n('S3', 'S', { kind: 'storage' }),
      n('H', '', { kind: 'person', size: [0.5, 1] }), n('A8'),
    ],
    edges: [
      {
        from: 'S1', to: 'A1', kind: 'read', label: 'read',
      }, {
        from: 'A2', to: 'S2', kind: 'write', label: 'write',
      },
      { from: 'A3', to: 'S3', kind: 'modify' }, { from: 'A4', to: 'A5', kind: 'send' },
      { from: 'A6', to: 'A7', kind: 'request' }, { from: 'H', to: 'A8', kind: 'channel' },
    ],
  },
}];
