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
 * The FMC visualization runner: a block diagram, described as nodes, groups and edges, laid
 * out by ELK's layered algorithm (elkjs, given as `elk`) and drawn as SVG in the FMC notation
 * (https://www.fmc-modeling.org/notation_reference), following the FMC visualization
 * guidelines (https://www.fmc-modeling.org/visualization_guidelines). The inbox draws a
 * customer's stack with it (src/fmc-stack.js, ui/stack.js); scripts/fmc-gallery.mjs draws the
 * guidelines' figures with it.
 *
 *   {
 *     direction: 'DOWN',               // DOWN (n-tier: many at the top), RIGHT (a flow), auto
 *     nodes: [{ id, label, kind: 'agent', size: [cols, rows], group, enumerated, sub, data }],
 *     groups: [{ id, label, kind: 'area', parent }],
 *     edges: [{ from, to, kind: 'request', label }],
 *   }
 *
 * Nodes are `agent` (a rectangle), `storage` (rounded), `person` (a human agent: a rectangle
 * with a figure), `channel` (a small circle), `dots` and `vdots` (an enumeration's ellipsis).
 * Groups are `area` (a grey frame, its shade by depth), `agent` and `storage` (a structuring
 * node of related ones, as thick as a node, named), `set` (unrelated nodes grouped to save
 * edges, a thin double line) and `u` (an agent around the others, open at the top). Edges are
 * `line`, `arrow` (from → to), `read` and `write` (an arrow between an agent and a storage, the
 * way the data goes), `modify` (the double arrow), `channel` (a bidirectional channel: a
 * circle on the line), `send` (a unidirectional one: arrows through the circle) and `request`
 * (request/response: the circle with R and the request's direction).
 *
 * How the guidelines are kept, and what wins when they disagree:
 *
 * - Crossings: ELK's layer sweep, and of several layouts (model order kept or not, two node
 *   placements) the one with the fewest crossings, then bends, then length.
 * - Orthogonal edges with rounded corners, `RADIUS`; edges into or out of the same node with
 *   the same end (an arrowhead or none) share an ELK port, so they merge into an edge tree.
 * - Distance: ELK's spacing between edges, and between edges and nodes, is `SPACE`; layers are
 *   `GAP` apart, so an edge is never shorter than that, and a channel adds a layer, so a
 *   channel's edge is never too short to show its arrows. Long edges come only from the data.
 * - Harmonization over text: every node of a kind has the same size, from a grid of cells
 *   (`size` in cells); a label that does not fit wraps, then gets smaller, then is cut, and never
 *   grows its node. Importance is the one reason for a larger node: the caller gives it (the
 *   stack drawing widens its hubs), never to avoid a crossing, because a large node reads as
 *   important (the guidelines' own example of a conflict).
 * - Line weights: nodes and named groups twice the edges' (the stylesheet, `fmc-*` classes).
 * - Labels horizontal, one font, `code` in monospace; colors are classes, grey for groups.
 * - Arrangement: DOWN by default, people and the environment first (top), many over few;
 *   RIGHT where the edges form one chain (a real flow), or where the caller says so.
 */

export const NODE_KINDS = ['agent', 'storage', 'person', 'channel', 'dots', 'vdots'];
export const GROUP_KINDS = ['area', 'agent', 'storage', 'set', 'u'];
export const EDGE_KINDS = ['line', 'arrow', 'read', 'write', 'modify', 'channel', 'send', 'request'];

/** Corner radius of edges, the space around them, and between layers, at a 12px font. */
const RADIUS = 8;
const SPACE = 12;
const GAP = 28;
const CHANNEL = 14;
const HEAD = 8;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const num = (n) => String(Math.round(n * 10) / 10);

/** A character's width, in ems. */
function charWidth(ch, mono) {
  if (mono) {
    return 0.6;
  }
  if (/[ilj.,:;'|!I ()[\]/]/.test(ch)) {
    return 0.3;
  }
  if (/[mwMW@]/.test(ch)) {
    return 0.86;
  }
  return /[A-Z]/.test(ch) ? 0.66 : 0.54;
}

/**
 * The width of `text` in a sans-serif (or, `mono`, a monospace) font of `size` pixels, as an
 * estimate; the browser passes a measure of its own (src/ui-fmc.js).
 */

export function estimate(text, { mono = false, size = 12 } = {}) {
  let w = 0;
  for (const ch of String(text)) {
    w += charWidth(ch, mono);
  }
  return w * size;
}

/** A label's runs: the text, and what is `code` in it. */
export function runs(label) {
  const out = [];
  String(label ?? '').split('`').forEach((s, i) => {
    if (s) {
      out.push({ text: s, code: i % 2 === 1 });
    }
  });
  return out;
}

/**
 * A label in at most `lines` lines of at most `width`: `{ lines: [[run]], small }`, smaller
 * (`small`, the font a step down) when it does not fit otherwise, and cut with … at the end
 * when it does not fit at all.
 */
export function fit(label, width, { lines = 2, measure = estimate, size = 12 } = {}) {
  const words = [];
  for (const r of runs(label)) {
    for (const [i, w] of r.text.split(/(\s+)/).entries()) {
      if (i % 2 === 0 && w) {
        words.push({ text: w, code: r.code });
      }
    }
  }
  const wide = (ws, s) => ws.reduce((a, w, i) => a + measure(w.text, { mono: w.code, size: s })
    + (i ? measure(' ', { size: s }) : 0), 0);
  const wrap = (s) => {
    const out = [];
    let line = [];
    for (const w of words) {
      if (line.length && wide([...line, w], s) > width) {
        out.push(line);
        line = [];
      }
      line.push(w);
    }
    if (line.length) {
      out.push(line);
    }
    return out;
  };
  const fits = (ls, s) => ls.length <= lines && ls.every((l) => wide(l, s) <= width);
  let small = false;
  let got = wrap(size);
  if (!fits(got, size)) {
    const s = size * 0.9;
    const again = wrap(s);
    if (fits(again, s) || again.length <= got.length) {
      got = again;
      small = true;
    }
  }
  const s = small ? size * 0.9 : size;
  if (got.length > lines || got.some((l) => wide(l, s) > width)) {
    got = got.slice(0, lines);
    const last = got[got.length - 1];
    while (last.length > 1 && wide([...last, { text: '…' }], s) > width) {
      last.pop();
    }
    let w = last[last.length - 1];
    while (w.text.length > 1 && wide([...last.slice(0, -1), { ...w, text: `${w.text}…` }], s) > width) {
      w = { ...w, text: w.text.slice(0, -1) };
    }
    last[last.length - 1] = { ...w, text: `${w.text}…` };
  }
  return { lines: got, small };
}

/** The edges' order of arrows and circles, from the kind: what each end and the middle get. */
function ends(kind, fromStorage, toStorage) {
  switch (kind) {
    case 'arrow': return { head: 'to' };
    case 'write':
    case 'read':
      // The arrow goes the way the data goes: from the storage when reading, into it writing.
      if (fromStorage !== toStorage) {
        const storageEnd = fromStorage ? 'from' : 'to';
        const agentEnd = fromStorage ? 'to' : 'from';
        return { head: kind === 'read' ? agentEnd : storageEnd, active: agentEnd };
      }
      return { head: 'to' };
    // The agent's end is the active one; between two agents or two storages, From.
    case 'modify': return { modify: true, active: fromStorage && !toStorage ? 'to' : 'from' };
    case 'channel': return { channel: true };
    case 'send': return { channel: true, head: 'to', into: true };
    case 'request': return { channel: true, request: true };
    default: return {};
  }
}

/** Whether the edges, from → to, are one chain: a real flow, to be laid out left to right. */
function chain(nodes, edges) {
  if (edges.length < 2) {
    return false;
  }
  const out = new Map();
  const inn = new Map();
  for (const e of edges) {
    out.set(e.from, (out.get(e.from) || 0) + 1);
    inn.set(e.to, (inn.get(e.to) || 0) + 1);
  }
  return [...out.values(), ...inn.values()].every((n) => n === 1)
    && nodes.filter((n) => !out.has(n.id) && inn.has(n.id)).length === 1;
}

/**
 * The diagram as an ELK graph, and what drawing it needs: `{ graph, nodes, groups, edges }`.
 * `variant` changes what ELK is asked, for `layout` to pick the best of several.
 */
export function elkGraph(diagram, {
  measure = estimate, size = 12, variant = {},
} = {}) {
  const k = size / 12;
  const cell = diagram.cell || {};
  const nodes = (diagram.nodes || []).map((n) => ({ kind: 'agent', ...n }));
  const groups = (diagram.groups || []).map((g) => ({ kind: 'area', ...g }));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  // An edge may end at a group: at its frame, for all that is in it (Figures 24 and 25).
  const byId = new Map([
    ...groups.map((g) => [g.id, {
      id: g.id, kind: g.kind === 'storage' || (g.kind === 'set' && g.round) ? 'storage' : 'group', group: g.parent || null,
    }]),
    ...nodes.map((n) => [n.id, n]),
  ]);
  let { direction } = diagram;
  if (direction === 'auto' || !direction) {
    direction = chain(nodes, (diagram.edges || []).filter((e) => !e.hidden)) ? 'RIGHT' : 'DOWN';
  }
  const down = direction === 'DOWN';

  // The grid: a cell as wide as the longest single-line label of the cells' nodes, within
  // bounds, so that similar nodes are one size whatever their text.
  const boxes = nodes.filter((n) => ['agent', 'storage', 'person'].includes(n.kind));
  const pad = 10 * k;
  const longest = Math.max(0, ...boxes.filter((n) => !n.size || n.size[0] === 1)
    .map((n) => measure(String(n.label ?? n.id).replace(/`/g, ''), { size }) + 2 * pad + (n.kind === 'storage' ? 12 * k : 0)
      + (n.kind === 'person' ? 18 * k : 0)));
  const W = cell.w ? cell.w * k : Math.min(150 * k, Math.max(96 * k, longest));
  const H = cell.h ? cell.h * k : (nodes.some((n) => n.sub) ? 50 : 42) * k;
  const gapX = (diagram.gapX ?? 20) * k;
  const gapY = (diagram.gapY ?? GAP) * k;

  for (const n of nodes) {
    const [cols, rows] = n.size || [1, 1];
    if (n.kind === 'channel') {
      n.w = CHANNEL * k;
      n.h = CHANNEL * k;
    } else if (n.kind === 'dots' || n.kind === 'vdots') {
      n.w = (n.kind === 'dots' ? 24 : 12) * k;
      n.h = (n.kind === 'dots' ? 12 : 24) * k;
    } else {
      n.w = n.w ?? cols * W + Math.max(0, cols - 1) * gapX;
      n.h = n.h ?? rows * H + Math.max(0, rows - 1) * gapY;
    }
    // A storage's round ends take room from its text where they are left and right.
    const round = n.kind === 'storage' && n.w >= n.h ? n.h * 0.3 : 0;
    const room = n.w - 2 * (n.kind === 'storage' ? 6 * k : pad) - round - (n.kind === 'person' && n.label && n.h <= n.w * 1.2 ? 28 * k : 0);
    const many = Math.max(1, Math.floor((n.h - (n.sub ? 14 * k : 0) - 4 * k) / (13 * k)));
    n.fit = n.label && !['channel', 'dots', 'vdots'].includes(n.kind)
      ? fit(n.label, room, { lines: Math.min(many, n.lines || 3), measure, size }) : null;
  }

  function lca(x, y) {
    const chainOf = (n) => {
      const out = [];
      for (let g = n.group; g; g = groupById.get(g)?.parent) {
        out.push(g);
      }
      return out;
    };
    const ys = new Set(chainOf(y));
    return chainOf(x).find((g) => ys.has(g)) || null;
  } // Edges, with a channel node of their own where they have a channel.
  const edges = [];
  const elkEdges = [];
  const extra = [];
  const ports = new Map();
  const port = (node, key) => {
    const id = `${node}::${key}`;
    if (!ports.has(id)) {
      ports.set(id, { id, node, edges: 0 });
    }
    ports.get(id).edges += 1;
    return id;
  };
  for (const [i, e] of (diagram.edges || []).entries()) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) {
      throw new Error(`edge ${i}: no node ${a ? e.to : e.from}`);
    }
    const kind = e.kind || 'line';
    const end = ends(kind, a.kind === 'storage', b.kind === 'storage');
    // In an n-tier layout the active end is above what it uses; in a flow, the data leads.
    const follow = diagram.follow || (down ? 'control' : 'data');
    const flip = (follow === 'control' && end.active === 'to') !== Boolean(e.flip);
    const [src, dst] = flip ? [b, a] : [a, b];
    const headAtSrc = end.head && (end.head === 'to') === flip;
    const headAtDst = end.head && !headAtSrc;
    const edge = {
      id: e.id || `e${i}`,
      i,
      kind,
      from: a.id,
      to: b.id,
      src: src.id,
      dst: dst.id,
      label: e.label || '',
      hidden: Boolean(e.hidden),
      data: e.data,
      title: e.title,
      routes: [],
      heads: [],
      modify: end.modify,
    };
    edges.push(edge);
    if (e.hidden) {
      elkEdges.push({
        id: `${edge.id}`, sources: [src.id], targets: [dst.id], part: edge,
      });
      // eslint-disable-next-line no-continue
      continue;
    }
    if (groupById.get(a.id)?.kind === 'u' || groupById.get(b.id)?.kind === 'u') {
      // To the U-shaped node around it: straight out of the node to its inner wall (`stub`).
      const u = groupById.get(a.id)?.kind === 'u' ? a : b;
      const inner = u === a ? b : a;
      const named = u === a ? e.fromPort : e.toPort;
      const side = (groupById.get(u.id).ports || []).find((p) => p.id === named)?.side;
      edge.stub = {
        u: u.id, node: inner.id, side, head: end.head ? (end.head === 'to') === (u === b) : false,
      };
      // eslint-disable-next-line no-continue
      continue;
    }
    if (e.same) {
      // Between two nodes of one layer, side by side: ELK's layers have no such edges, so it
      // is drawn straight between them once they are placed (`sameRoute`).
      edge.same = {
        channel: end.channel, request: end.request, src: headAtSrc, dst: headAtDst, into: end.into,
      };
      // eslint-disable-next-line no-continue
      continue;
    }
    // Edges merge into a tree where they leave or reach a node the same way: same kind of
    // end, and the same side of the layout (a port per kind of end, per node).
    // Edges of one family only: plain and arrowed access, channels, and never a modify access.
    const family = (end.channel && 'c') || (end.modify && `m${i}`) || 'a';
    const tag = (hd) => `${family}${hd ? 'h' : 'p'}`;
    const fromP = e.fromPort && `${a.id}::${e.fromPort}`;
    const toP = e.toPort && `${b.id}::${e.toPort}`;
    // A channel of its own (a node) is reached at the middle of its sides.
    const sp = (flip ? toP : fromP) || (src.kind === 'channel' ? `${src.id}::out`
      : port(src.id, `out-${tag(headAtSrc)}${e.tree ? `-${e.tree}` : ''}`));
    const dp = (flip ? fromP : toP) || (dst.kind === 'channel' ? `${dst.id}::in`
      : port(dst.id, `in-${tag(headAtDst)}${e.tree ? `-${e.tree}` : ''}`));
    if (end.channel) {
      const ch = {
        id: `${edge.id}~ch`,
        kind: 'channel',
        w: CHANNEL * k,
        h: CHANNEL * k,
        group: e.group ?? lca(src, dst),
        edge,
        label: edge.label,
        request: end.request,
      };
      // In a ranked layout a channel has its source's rank, or its target's.
      ch.rank = src.rank ?? (byId.get(src.id) && groupById.get(src.id)?.rank) ?? dst.rank;
      extra.push(ch);
      edge.channel = ch;
      edge.request = end.request;
      elkEdges.push({
        id: `${edge.id}~1`, sources: [sp], targets: [`${ch.id}::in`], part: edge, seg: 0,
      });
      elkEdges.push({
        id: `${edge.id}~2`, sources: [`${ch.id}::out`], targets: [dp], part: edge, seg: 1,
      });
      // Arrows of a unidirectional channel: into the circle, and out of it into the node.
      if (end.into) {
        edge.heads.push(flip ? { seg: 0, at: 'start' } : { seg: 0, at: 'end' });
      }
    } else {
      elkEdges.push({
        id: edge.id, sources: [sp], targets: [dp], part: edge, seg: 0, label: edge.label,
      });
    }
    if (headAtSrc) {
      edge.heads.push({ seg: 0, at: 'start' });
    }
    if (headAtDst) {
      edge.heads.push({ seg: end.channel ? 1 : 0, at: 'end' });
    }
  }

  // The ELK nodes, in their groups.
  const all = [];
  for (const n of nodes) {
    all.push(n);
    all.push(...extra.filter((c) => c.edge.src === n.id));
  }
  all.push(...extra.filter((c) => !all.includes(c)));
  const layer = { DOWN: ['NORTH', 'SOUTH'], RIGHT: ['WEST', 'EAST'] }[direction] || ['NORTH', 'SOUTH'];
  const elkNode = (n) => {
    const out = {
      id: n.id, width: n.w, height: n.h, layoutOptions: {},
    };
    const mine = [...ports.values()].filter((p) => p.node === n.id);
    if (n.kind === 'channel') {
      // A channel's edges reach it in the middle of a side, on the circle.
      const lab = [];
      if (n.label) {
        const w = measure(n.label.replace(/`/g, ''), { size: size * 0.9 }) + 2;
        lab.push({
          id: `${n.id}::label`,
          text: n.label,
          width: w,
          height: 14 * k,
          layoutOptions: { 'elk.nodeLabels.placement': down ? '[OUTSIDE, H_LEFT, V_CENTER]' : '[OUTSIDE, H_CENTER, V_TOP]' },
        });
      }
      if (n.request) {
        lab.push({
          id: `${n.id}::r`,
          text: 'R',
          width: 16 * k,
          height: 14 * k,
          layoutOptions: { 'elk.nodeLabels.placement': down ? '[OUTSIDE, H_RIGHT, V_CENTER]' : '[OUTSIDE, H_CENTER, V_BOTTOM]' },
        });
      }
      out.labels = lab;
      out.layoutOptions['elk.portConstraints'] = 'FIXED_POS';
      if (n.rank != null) {
        out.layoutOptions['elk.partitioning.partition'] = String(n.rank);
      }
      out.ports = [
        {
          id: `${n.id}::in`, width: 0, height: 0, ...(down ? { x: n.w / 2, y: 0 } : { x: 0, y: n.h / 2 }), layoutOptions: { 'elk.port.side': layer[0] },
        },
        {
          id: `${n.id}::out`, width: 0, height: 0, ...(down ? { x: n.w / 2, y: n.h } : { x: n.w, y: n.h / 2 }), layoutOptions: { 'elk.port.side': layer[1] },
        },
      ];
      return out;
    }
    if (n.ports) {
      // Ports the caller placed, by side (self loops, a group's edges to its inside).
      out.layoutOptions['elk.portConstraints'] = 'FIXED_SIDE';
      out.ports = n.ports.map((p) => ({
        id: `${n.id}::${p.id}`, width: 0, height: 0, layoutOptions: { 'elk.port.side': p.side },
      }));
    } else if (mine.length) {
      out.layoutOptions['elk.portConstraints'] = 'FREE';
    }
    const given = out.ports || [];
    out.ports = [...given, ...mine.filter((p) => !given.some((q) => q.id === p.id))
      .map((p) => ({ id: p.id, width: 0, height: 0 }))];
    if (n.kind === 'person' && down && diagram.peopleFirst !== false && !n.group) {
      out.layoutOptions['elk.layered.layering.layerConstraint'] = 'FIRST';
    }
    // A rank: the nodes of a lower one are in layers before those of a higher one.
    if (n.rank != null) {
      out.layoutOptions['elk.partitioning.partition'] = String(n.rank);
    }
    return out;
  };
  const groupNode = (g) => {
    const labelled = g.label && g.kind !== 'u';
    const top = (labelled && g.labelAt !== 'bottom' ? 26 : 12) * k;
    const bottom = (labelled && g.labelAt === 'bottom' ? 26 : 12) * k;
    // A U's walls, and room for the edges from its inside to them.
    const side = (g.kind === 'u' ? 52 : 12) * k;
    return {
      id: g.id,
      layoutOptions: {
        'elk.padding': `[top=${top},left=${side},bottom=${g.kind === 'u' ? 62 * k : bottom},right=${side}]`,
        ...(g.direction ? { 'elk.direction': g.direction } : {}),
        ...(g.rank != null ? { 'elk.partitioning.partition': String(g.rank) } : {}),
        ...(g.options || {}),
      },
      ports: [
        ...(g.kind === 'u' ? [] : g.ports || []).map((p) => ({
          id: `${g.id}::${p.id}`, width: 0, height: 0, layoutOptions: { 'elk.port.side': p.side },
        })),
        ...[...ports.values()].filter((p) => p.node === g.id)
          .map((p) => ({ id: p.id, width: 0, height: 0 })),
      ],
      children: [],
      edges: [],
    };
  };
  const root = { id: '__root', children: [], edges: [] };
  const containers = new Map([[null, root]]);
  for (const g of groups) {
    containers.set(g.id, groupNode(g));
  }
  for (const g of groups) {
    (containers.get(g.parent || null) || root).children.push(containers.get(g.id));
  }
  for (const n of all) {
    (containers.get(n.group || null) || root).children.push(elkNode(n));
  }
  // Each edge in the innermost group that holds both its ends (ELK's coordinates are its).
  const parentOf = new Map();
  for (const n of all) {
    parentOf.set(n.id, n.group || null);
  }
  for (const g of groups) {
    parentOf.set(g.id, g.parent || null);
  }
  const owner = (ref) => {
    const id = ref.split('::')[0];
    return id;
  };
  const ancestors = (id) => {
    const out = [];
    for (let g = parentOf.get(id); g; g = parentOf.get(g)) {
      out.push(g);
    }
    out.push(null);
    return out;
  };
  for (const e of elkEdges) {
    const s = owner(e.sources[0]);
    const t = owner(e.targets[0]);
    const as = ancestors(s);
    const ts = new Set(ancestors(t));
    // An edge between a group and what is inside it belongs to the group.
    let c = as.find((g) => ts.has(g)) ?? null;
    if (groupById.has(t) && as.includes(t)) {
      c = t;
    }
    if (groupById.has(s) && ancestors(t).includes(s)) {
      c = s;
    }
    e.container = c;
    const out = { id: e.id, sources: e.sources, targets: e.targets };
    if (e.label && !e.part.channel) {
      out.labels = [{
        id: `${e.id}::label`, text: e.label, width: measure(e.label.replace(/`/g, ''), { size: size * 0.9 }) + 4, height: 14 * k,
      }];
    }
    (containers.get(c) || root).edges.push(out);
  }
  // Ranks hold within a group: where some of its nodes have one, the group's layers keep them.
  for (const [id, c] of containers) {
    if (c.children.some((x) => x.layoutOptions?.['elk.partitioning.partition'] != null)) {
      if (id) {
        c.layoutOptions['elk.partitioning.activate'] = 'true';
      } else {
        c.partitioned = true;
      }
    }
  }
  const placement = variant.placement || 'BRANDES_KOEPF';
  root.layoutOptions = {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.nodePlacement.strategy': placement,
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    'elk.layered.nodePlacement.favorStraightEdges': 'true',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.thoroughness': '40',
    'elk.layered.considerModelOrder.strategy': variant.order || 'NODES_AND_EDGES',
    ...(variant.force ? { 'elk.layered.crossingMinimization.forceNodeModelOrder': 'true' } : {}),
    'elk.layered.cycleBreaking.strategy': 'GREEDY_MODEL_ORDER',
    'elk.spacing.nodeNode': String(gapX),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(gapY),
    'elk.spacing.edgeNode': String(SPACE * k),
    'elk.spacing.edgeEdge': String(SPACE * k * 0.8),
    'elk.layered.spacing.edgeEdgeBetweenLayers': String(SPACE * k * 0.8),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(SPACE * k),
    'elk.spacing.componentComponent': String(gapX * 1.5),
    'elk.spacing.labelNode': String(4 * k),
    'elk.spacing.edgeLabel': String(3 * k),
    'elk.spacing.labelPortHorizontal': String(3 * k),
    'elk.edgeLabels.placement': 'CENTER',
    'elk.layered.edgeLabels.sideSelection': 'SMART_DOWN',
    'elk.layered.unnecessaryBendpoints': 'false',
    'elk.layered.mergeEdges': 'false',
    'elk.separateConnectedComponents': diagram.components === false ? 'false' : 'true',
    'elk.layered.compaction.connectedComponents': 'true',
    'elk.aspectRatio': String(diagram.aspect || 1.6),
    'elk.padding': `[top=${4 * k},left=${4 * k},bottom=${4 * k},right=${4 * k}]`,
    ...(root.partitioned ? { 'elk.partitioning.activate': 'true' } : {}),
    ...(diagram.options || {}),
  };
  delete root.partitioned;
  return {
    graph: root, nodes: all, groups, edges, elkEdges, direction, k,
  };
}

/** Points of an edge's sections, absolute. */
function sectionPoints(e, off) {
  const pts = [];
  for (const s of e.sections || []) {
    for (const p of [s.startPoint, ...(s.bendPoints || []), s.endPoint]) {
      const q = { x: p.x + off.x, y: p.y + off.y };
      const last = pts[pts.length - 1];
      if (!last || Math.abs(last.x - q.x) > 0.01 || Math.abs(last.y - q.y) > 0.01) {
        pts.push(q);
      }
    }
  }
  return pts;
}

/** Points without the ones in the middle of a straight run. */
function straighten(pts) {
  const out = [];
  for (const p of pts) {
    while (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const col = Math.abs((b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x)) < 0.01;
      if (!col) {
        break;
      }
      out.pop();
    }
    out.push(p);
  }
  return out;
}

/** The proper crossings between the segments of different edges, their bends and length. */
export function measureRoutes(edges) {
  const segs = [];
  let bends = 0;
  let length = 0;
  for (const e of edges) {
    for (const r of e.routes) {
      bends += Math.max(0, r.length - 2);
      for (let i = 1; i < r.length; i += 1) {
        segs.push({ e: e.id, a: r[i - 1], b: r[i] });
        length += Math.abs(r[i].x - r[i - 1].x) + Math.abs(r[i].y - r[i - 1].y);
      }
    }
  }
  let crossings = 0;
  const seen = new Set();
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const s = segs[i];
      const t = segs[j];
      if (s.e === t.e) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const sh = Math.abs(s.a.y - s.b.y) < 0.5;
      const th = Math.abs(t.a.y - t.b.y) < 0.5;
      if (sh === th) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const [h, v] = sh ? [s, t] : [t, s];
      const { x } = v.a;
      const { y } = h.a;
      const inside = (p, a, b) => p > Math.min(a, b) + 0.5 && p < Math.max(a, b) - 0.5;
      if (inside(x, h.a.x, h.b.x) && inside(y, v.a.y, v.b.y)) {
        const key = `${[s.e, t.e].sort().join('|')}@${Math.round(x)},${Math.round(y)}`;
        if (!seen.has(key)) {
          seen.add(key);
          crossings += 1;
        }
      }
    }
  }
  return { crossings, bends, length };
}

/** An edge from a node to the U-shaped node around it: out of its side, to the inner wall. */
function stubRoute(e, prepared) {
  const n = prepared.nodes.find((x) => x.id === e.stub.node);
  const u = prepared.groups.find((x) => x.id === e.stub.u);
  const { k } = prepared;
  const inner = {
    x: u.x + 30 * k, y: u.y, w: u.w - 60 * k, h: u.h - 36 * k,
  };
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  const side = e.stub.side || 'SOUTH';
  const route = {
    WEST: [{ x: n.x, y: cy }, { x: inner.x, y: cy }],
    EAST: [{ x: n.x + n.w, y: cy }, { x: inner.x + inner.w, y: cy }],
    SOUTH: [{ x: cx, y: n.y + n.h }, { x: cx, y: inner.y + inner.h }],
    NORTH: [{ x: cx, y: n.y }, { x: cx, y: u.y }],
  }[side];
  e.routes = [route];
  e.heads = e.stub.head ? [{ seg: 0, at: 'end' }] : [];
}

/**
 * An edge between two nodes of one layer: straight between the sides they face, with its
 * circle in the middle when it has a channel.
 */
function sameRoute(e, prepared) {
  const a = prepared.nodes.find((n) => n.id === e.src);
  const b = prepared.nodes.find((n) => n.id === e.dst);
  const { k } = prepared;
  const dx = Math.abs((a.x + a.w / 2) - (b.x + b.w / 2));
  const across = dx >= Math.abs((a.y + a.h / 2) - (b.y + b.h / 2));
  let p;
  let q;
  if (across) {
    const top = Math.max(a.y, b.y);
    const bottom = Math.min(a.y + a.h, b.y + b.h);
    const y = top < bottom ? (top + bottom) / 2 : (a.y + a.h / 2 + b.y + b.h / 2) / 2;
    const right = a.x < b.x;
    p = { x: right ? a.x + a.w : a.x, y };
    q = { x: right ? b.x : b.x + b.w, y };
  } else {
    const left = Math.max(a.x, b.x);
    const right = Math.min(a.x + a.w, b.x + b.w);
    const x = left < right ? (left + right) / 2 : (a.x + a.w / 2 + b.x + b.w / 2) / 2;
    const down = a.y < b.y;
    p = { x, y: down ? a.y + a.h : a.y };
    q = { x, y: down ? b.y : b.y + b.h };
  }
  e.heads = [];
  if (!e.same.channel) {
    e.routes = [[p, q]];
    if (e.same.src) {
      e.heads.push({ seg: 0, at: 'start' });
    }
    if (e.same.dst) {
      e.heads.push({ seg: 0, at: 'end' });
    }
    if (e.label) {
      const w = estimate(e.label, { size: prepared.k * 11 }) + 4;
      e.labelAt = across ? {
        x: (p.x + q.x) / 2 - w / 2, y: p.y - 16 * k, w, h: 14 * k,
      }
        : {
          x: p.x + 4 * k, y: (p.y + q.y) / 2 - 7 * k, w, h: 14 * k,
        };
      if (!across) {
        e.labelAt.x += w / 2;
      }
    }
    return;
  }
  const r = (CHANNEL * k) / 2;
  const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  const ux = Math.sign(q.x - p.x);
  const uy = Math.sign(q.y - p.y);
  e.routes = [[p, { x: m.x - ux * r, y: m.y - uy * r }], [{ x: m.x + ux * r, y: m.y + uy * r }, q]];
  const ch = {
    id: `${e.id}~ch`, kind: 'channel', edge: e, x: m.x - r, y: m.y - r, w: 2 * r, h: 2 * r, labels: [],
  };
  // The label above (or beside) the circle, R on the other side.
  if (e.label) {
    const w = estimate(e.label, { size: k * 11 }) + 2;
    ch.labels.push(across ? {
      id: `${ch.id}::label`, text: e.label, x: r - w, y: -16 * k, width: w, height: 14 * k,
    } : {
      id: `${ch.id}::label`, text: e.label, x: -w - 4 * k, y: r - 7 * k, width: w, height: 14 * k,
    });
  }
  if (e.same.request) {
    ch.labels.push(across ? {
      id: `${ch.id}::r`, text: 'R', x: r - 8 * k, y: 2 * r + 4 * k, width: 16 * k, height: 14 * k,
    } : {
      id: `${ch.id}::r`, text: 'R', x: 2 * r + 4 * k, y: r - 7 * k, width: 16 * k, height: 14 * k,
    });
  }
  e.channel = ch;
  prepared.nodes.push(ch);
  if (e.same.src) {
    e.heads.push({ seg: 0, at: 'start' });
  }
  if (e.same.into) {
    e.heads.push({ seg: 0, at: 'end' });
  }
  if (e.same.dst) {
    e.heads.push({ seg: 1, at: 'end' });
  }
}

/** ELK's result, absolute: where each node, group and edge is. */
function place(prepared, laid) {
  const abs = new Map();
  const walk = (n, ox, oy) => {
    const x = (n.x || 0) + ox;
    const y = (n.y || 0) + oy;
    abs.set(n.id, {
      x, y, w: n.width, h: n.height, labels: n.labels || [], ports: n.ports || [],
    });
    for (const c of n.children || []) {
      walk(c, x, y);
    }
  };
  walk(laid, -(laid.x || 0), -(laid.y || 0));
  const elkEdges = new Map();
  const collect = (n) => {
    for (const e of n.edges || []) {
      elkEdges.set(e.id, e);
    }
    for (const c of n.children || []) {
      collect(c);
    }
  };
  collect(laid);
  for (const n of prepared.nodes) {
    Object.assign(n, abs.get(n.id) || {});
  }
  for (const g of prepared.groups) {
    Object.assign(g, abs.get(g.id) || {});
  }
  for (const e of prepared.edges) {
    e.routes = [];
    e.labelAt = null;
  }
  for (const pe of prepared.elkEdges) {
    const got = elkEdges.get(pe.id);
    if (!got || pe.part.hidden) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // Sections are relative to the edge's container (elkjs says which).
    const c = got.container && got.container !== '__root' ? abs.get(got.container) : { x: 0, y: 0 };
    const off = c || { x: 0, y: 0 };
    pe.part.routes[pe.seg] = straighten(sectionPoints(got, off));
    const lab = (got.labels || []).find((l) => !l.id.endsWith('::room'));
    if (lab) {
      pe.part.labelAt = {
        x: lab.x + off.x, y: lab.y + off.y, w: lab.width, h: lab.height,
      };
    }
  }
  for (const e of prepared.edges) {
    if (e.same) {
      sameRoute(e, prepared);
    }
    if (e.stub) {
      stubRoute(e, prepared);
    }
    e.routes = e.routes.filter(Boolean);
  }
  const root = abs.get('__root');
  return { width: root.w, height: root.h };
}

/**
 * How far the layout is from harmony: how far nodes are from the middle of what hangs off
 * them on either side (symmetry), and how many pairs of siblings in a layer are not in the
 * order the diagram gives them (the reader's order, and the same layout for the same data).
 */
export function harmony(prepared) {
  const down = prepared.direction === 'DOWN';
  const at = new Map(prepared.nodes.map((n) => [n.id, n]));
  const cross = (n) => (down ? n.x + n.w / 2 : n.y + n.h / 2);
  const along = (n) => (down ? n.y + n.h / 2 : n.x + n.w / 2);
  const sides = new Map();
  for (const pe of prepared.elkEdges) {
    if (pe.part.hidden) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const s = pe.sources[0].split('::')[0];
    const t = pe.targets[0].split('::')[0];
    if (!at.has(s) || !at.has(t) || s === t) {
      // eslint-disable-next-line no-continue
      continue;
    }
    for (const [a, b] of [[s, t], [t, s]]) {
      const key = `${a}|${along(at.get(b)) > along(at.get(a)) ? 1 : 0}`;
      if (!sides.has(key)) {
        sides.set(key, { node: at.get(a), others: [] });
      }
      sides.get(key).others.push(at.get(b));
    }
  }
  let imbalance = 0;
  for (const { node, others } of sides.values()) {
    if (others.length < 2) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const xs = others.map(cross);
    imbalance += Math.abs(cross(node) - (Math.min(...xs) + Math.max(...xs)) / 2);
  }
  let inversions = 0;
  const given = prepared.nodes.filter((n) => n.kind !== 'channel');
  for (let i = 0; i < given.length; i += 1) {
    for (let j = i + 1; j < given.length; j += 1) {
      const a = given[i];
      const b = given[j];
      if ((a.group || null) !== (b.group || null) || Math.abs(along(a) - along(b)) > 1) {
        // eslint-disable-next-line no-continue
        continue;
      }
      if (cross(a) > cross(b)) {
        inversions += 1;
      }
    }
  }
  return { imbalance, inversions };
}

/**
 * Lays the diagram out: the best of a few of ELK's layouts by crossings, then bends, then
 * length. `elk` is an ELK instance (`new ELK()` from elkjs). Resolves to the model `svg` draws.
 */
export async function layout(diagram, {
  elk, measure = estimate, size = 12, variants,
} = {}) {
  const tries = variants || diagram.variants || [
    { order: 'NODES_AND_EDGES', placement: 'BRANDES_KOEPF' },
    { order: 'NONE', placement: 'BRANDES_KOEPF' },
    { order: 'NODES_AND_EDGES', placement: 'NETWORK_SIMPLEX' },
    { order: 'NONE', placement: 'NETWORK_SIMPLEX' },
    // The diagram's own order, kept: what harmonizes nodes that no edge orders.
    { order: 'NODES_AND_EDGES', placement: 'BRANDES_KOEPF', force: true },
  ];
  let best = null;
  for (const variant of tries) {
    const prepared = elkGraph(diagram, { measure, size, variant });
    // eslint-disable-next-line no-await-in-loop -- one layout after the other, to compare them
    const laid = await elk.layout(prepared.graph);
    const box = place(prepared, laid);
    const m = measureRoutes(prepared.edges);
    const h = harmony(prepared);
    const score = m.crossings * 1000 + m.bends * 8 + m.length / 20 + (box.width * box.height) / 4000
      + h.imbalance * 0.5 + h.inversions * 40;
    if (!best || score < best.score - 0.001) {
      best = {
        ...prepared, ...box, ...m, score, variant, size, measure, title: diagram.title || '',
      };
    }
  }
  return best;
}

/** The path of points, its corners rounded. */
export function roundedPath(pts, radius = RADIUS) {
  if (!pts.length) {
    return '';
  }
  let d = `M${num(pts[0].x)},${num(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y);
    const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const p = { x: b.x - ((b.x - a.x) / l1) * r, y: b.y - ((b.y - a.y) / l1) * r };
    const q = { x: b.x + ((c.x - b.x) / l2) * r, y: b.y + ((c.y - b.y) / l2) * r };
    d += ` L${num(p.x)},${num(p.y)} Q${num(b.x)},${num(b.y)} ${num(q.x)},${num(q.y)}`;
  }
  const z = pts[pts.length - 1];
  return `${d} L${num(z.x)},${num(z.y)}`;
}

/** An arrowhead with its tip at `tip`, pointing the way `from` → `tip`. */
function head(from, tip, k = 1) {
  const l = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const ux = (tip.x - from.x) / l;
  const uy = (tip.y - from.y) / l;
  const len = HEAD * k;
  const w = 3.6 * k;
  const bx = tip.x - ux * len;
  const by = tip.y - uy * len;
  return `<path class="fmc-head" d="M${num(tip.x)},${num(tip.y)} L${num(bx - uy * w)},${num(by + ux * w)} L${num(bx + uy * w)},${num(by - ux * w)} Z"/>`;
}

/** A route's end pulled back by `by`, so that the line stops where the arrowhead does. */
function trim(pts, at, by) {
  const out = pts.map((p) => ({ ...p }));
  const [i, j] = at === 'end' ? [out.length - 1, out.length - 2] : [0, 1];
  const a = out[i];
  const b = out[j];
  const l = Math.hypot(a.x - b.x, a.y - b.y);
  if (l > by) {
    a.x -= ((a.x - b.x) / l) * by;
    a.y -= ((a.y - b.y) / l) * by;
  }
  return out;
}

/** The modify access: two arcs with arrows, one each way, along the straight run p → q. */
function modifyArcs(p, q, k) {
  const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const ux = (q.x - p.x) / l;
  const uy = (q.y - p.y) / l;
  const nx = -uy;
  const ny = ux;
  const bow = Math.max(6 * k, Math.min(13 * k, l * 0.45));
  const sep = 2 * k;
  const arc = (a, b, side) => {
    const s = { x: a.x + nx * sep * side, y: a.y + ny * sep * side };
    const t = { x: b.x + nx * sep * side, y: b.y + ny * sep * side };
    const mx = (s.x + t.x) / 2 + nx * bow * side;
    const my = (s.y + t.y) / 2 + ny * bow * side;
    // The arrow's direction at the end of a quadratic curve is from its control point.
    const tip = t;
    const back = { x: mx, y: my };
    const lt = Math.hypot(tip.x - back.x, tip.y - back.y);
    const cut = (HEAD * k * 0.6) / lt;
    const end = { x: tip.x - (tip.x - back.x) * cut, y: tip.y - (tip.y - back.y) * cut };
    return `<path class="fmc-line" d="M${num(s.x)},${num(s.y)} Q${num(mx)},${num(my)} ${num(end.x)},${num(end.y)}"/>${head(back, tip, k * 0.85)}`;
  };
  return arc(p, q, 1) + arc(q, p, 1);
}

/** Text with its `code` in monospace, escaped. */
function textRuns(label) {
  return runs(label).map((r) => (r.code ? `<tspan class="fmc-code">${esc(r.text)}</tspan>` : esc(r.text))).join('');
}

/** Text in lines, centered on (x, y). */
function textLines(f, x, y, { size, k, cls = 'fmc-text' }) {
  if (!f) {
    return '';
  }
  const lh = (f.small ? 13 : 15) * k * (size / 12 / k);
  const top = y - ((f.lines.length - 1) * lh) / 2;
  return `<text class="${cls}${f.small ? ' fmc-small' : ''}" text-anchor="middle">${f.lines.map((line, i) => `<tspan x="${num(x)}" y="${num(top + i * lh)}" dy="0.35em">${line.map((w, j) => `${j ? ' ' : ''}${w.code ? `<tspan class="fmc-code">${esc(w.text)}</tspan>` : esc(w.text)}`).join('')}</tspan>`).join('')}</text>`;
}

/** A stick figure in the box (x, y, w, h). */
function figure(x, y, w, h) {
  const s = Math.min(w, h);
  const cx = x + w / 2;
  const top = y + (h - s) / 2;
  const r = s * 0.11;
  const hy = top + s * 0.18;
  const neck = hy + r;
  const hip = top + s * 0.6;
  return `<g class="fmc-figure"><circle cx="${num(cx)}" cy="${num(hy)}" r="${num(r)}"/><path d="M${num(cx)},${num(neck)} L${num(cx)},${num(hip)} M${num(cx - s * 0.2)},${num(neck + s * 0.12)} L${num(cx + s * 0.2)},${num(neck + s * 0.12)} M${num(cx - s * 0.17)},${num(top + s * 0.88)} L${num(cx)},${num(hip)} L${num(cx + s * 0.17)},${num(top + s * 0.88)}"/></g>`;
}

/** A board, the guidelines' picture in a storage (Figure 29). */
function board(x, y, s) {
  const lines = [];
  for (let i = 0; i <= 8; i += 1) {
    const t = (s * i) / 8;
    lines.push(`M${num(x + t)},${num(y)} L${num(x + t)},${num(y + s)} M${num(x)},${num(y + t)} L${num(x + s)},${num(y + t)}`);
  }
  const c = s / 8;
  const disc = (i, j, cls) => `<circle class="${cls}" cx="${num(x + c * (i + 0.5))}" cy="${num(y + c * (j + 0.5))}" r="${num(c * 0.38)}"/>`;
  return `<g class="fmc-board"><rect class="fmc-board-bg" x="${num(x)}" y="${num(y)}" width="${num(s)}" height="${num(s)}"/><path class="fmc-board-grid" d="${lines.join(' ')}"/>${disc(3, 3, 'fmc-disc-w')}${disc(4, 4, 'fmc-disc-w')}${disc(3, 4, 'fmc-disc-b')}${disc(4, 3, 'fmc-disc-b')}</g>`;
}

const attrs = (data) => Object.entries(data || {}).map(([key, v]) => ` data-${key}="${esc(v)}"`).join('');

/** The model `layout` made, as SVG: groups, then edges, then nodes, each with its classes. */
export function svg(model, { className = '', focusable = false } = {}) {
  const { k, size } = model;
  const out = [];
  const depth = (g) => {
    let d = 0;
    for (let p = g.parent; p; p = model.groups.find((x) => x.id === p)?.parent) {
      d += 1;
    }
    return d;
  };
  const segs = [];
  for (const e of model.edges) {
    for (const r of e.hidden ? [] : e.routes) {
      for (let i = 1; i < r.length; i += 1) {
        segs.push([r[i - 1], r[i]]);
      }
    }
  }
  // Groups: grey areas, shaded by depth, and the named structuring nodes around related ones.
  for (const g of [...model.groups].sort((a, b) => depth(a) - depth(b))) {
    const d = depth(g);
    const cls = `fmc-group fmc-g-${g.kind} fmc-d${Math.min(d, 3)}`;
    const r = g.kind === 'storage' ? Math.min(22 * k, g.h / 2) : 0;
    let shape;
    if (g.kind === 'u') {
      // Open at the top: the inside is what it encloses, down to above its name.
      const inner = {
        x: g.x + 30 * k, y: g.y, w: g.w - 60 * k, h: g.h - 36 * k,
      };
      shape = `<path class="fmc-shape" d="M${num(g.x)},${num(g.y)} H${num(inner.x)} V${num(inner.y + inner.h)} H${num(inner.x + inner.w)} V${num(g.y)} H${num(g.x + g.w)} V${num(g.y + g.h)} H${num(g.x)} Z"/>`;
    } else if (g.kind === 'set') {
      const o = 3 * k;
      shape = `<rect class="fmc-shape" x="${num(g.x)}" y="${num(g.y)}" width="${num(g.w)}" height="${num(g.h)}" rx="${num(g.round ? Math.min(22 * k, g.h / 2) : 0)}"/><rect class="fmc-shape fmc-inner" x="${num(g.x + o)}" y="${num(g.y + o)}" width="${num(g.w - 2 * o)}" height="${num(g.h - 2 * o)}" rx="${num(g.round ? Math.max(0, Math.min(22 * k, g.h / 2) - o) : 0)}"/>`;
    } else {
      shape = `<rect class="fmc-shape" x="${num(g.x)}" y="${num(g.y)}" width="${num(g.w)}" height="${num(g.h)}" rx="${num(r)}"/>`;
    }
    let label = '';
    if (g.label) {
      const f = { lines: [runs(g.label)], small: g.kind === 'area' };
      let y = g.labelAt === 'bottom' ? g.y + g.h - 13 * k : g.y + 13 * k;
      if (g.kind === 'u') {
        y = g.y + g.h - 18 * k;
      }
      // In the middle, or to a side where no edge crosses it.
      const tw = model.measure(g.label.replace(/`/g, ''), { size: size * 0.9 });
      const free = (x) => !segs.some(([a, b]) => {
        const v = Math.abs(a.x - b.x) < 0.5;
        const top = Math.min(a.y, b.y);
        const bottom = Math.max(a.y, b.y);
        const over = a.x > x - tw / 2 - 3 * k && a.x < x + tw / 2 + 3 * k;
        return v && over && top < y + 7 * k && bottom > y - 7 * k;
      });
      const xs = [g.x + g.w / 2, g.x + 10 * k + tw / 2, g.x + g.w - 10 * k - tw / 2];
      const x = xs.find(free) ?? xs[0];
      label = textLines(f, x, y, { size, k, cls: 'fmc-text fmc-glabel' });
    }
    out.push(`<g class="${cls}"${attrs(g.data)}>${g.title ? `<title>${esc(g.title)}</title>` : ''}${shape}${label}</g>`);
  }
  // Edges: rounded orthogonal lines, merged where they share a port; arrows, circles, labels.
  const edges = [];
  for (const e of model.edges) {
    if (e.hidden || !e.routes.length) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const parts = [];
    const trimmed = e.routes.map((r) => r.map((p) => ({ ...p })));
    const heads = [];
    for (const h of e.heads) {
      const r = trimmed[h.seg];
      if (!r || r.length < 2) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const [tip, from] = h.at === 'end' ? [r[r.length - 1], r[r.length - 2]] : [r[0], r[1]];
      heads.push(head(from, tip, k));
      trimmed[h.seg] = trim(r, h.at, HEAD * k * 0.7);
    }
    if (e.modify) {
      // The double arrow where the edge reaches the storage (or else its end), over the last
      // stretch of its last straight run; the rest of the route a plain line.
      let r = trimmed[0];
      const storageFirst = model.nodes.find((x) => x.id === e.src)?.kind === 'storage'
        && model.nodes.find((x) => x.id === e.dst)?.kind !== 'storage';
      if (storageFirst) {
        r = [...r].reverse();
      }
      const a = r[r.length - 2];
      const b = r[r.length - 1];
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      const span = Math.min(l, 34 * k);
      const f = span / (l || 1);
      const m = { x: b.x - (b.x - a.x) * f, y: b.y - (b.y - a.y) * f };
      const rest = [...r.slice(0, -1), m];
      if (span < l - 0.5 || rest.length > 2) {
        parts.push(`<path class="fmc-line" d="${roundedPath(rest)}"/>`);
      }
      parts.push(modifyArcs(m, b, k));
    } else {
      for (const r of trimmed) {
        parts.push(`<path class="fmc-line" d="${roundedPath(r)}"/>`);
      }
    }
    parts.push(...heads);
    if (e.channel) {
      const c = model.nodes.find((n) => n.id === e.channel.id);
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      parts.push(`<circle class="fmc-shape fmc-ch" cx="${num(cx)}" cy="${num(cy)}" r="${num(c.w / 2)}"/>`);
      for (const l of c.labels || []) {
        const lx = c.x + l.x;
        const ly = c.y + l.y;
        if (l.id.endsWith('::r')) {
          // R, and a small arrow the way the request goes.
          const r0 = e.routes[0];
          const into = r0[r0.length - 1];
          const from = r0[r0.length - 2] || r0[0];
          const forward = e.src === e.from;
          let dx = Math.sign(into.x - from.x);
          let dy = Math.sign(into.y - from.y);
          if (!forward) {
            dx = -dx;
            dy = -dy;
          }
          const ax = lx + 4 * k;
          const ay = ly + l.height / 2;
          const t = 4 * k;
          const tri = dy ? `M${num(ax - t)},${num(ay - (dy * t) / 1.2)} L${num(ax + t)},${num(ay - (dy * t) / 1.2)} L${num(ax)},${num(ay + (dy * t) / 1.2)} Z`
            : `M${num(ax - (dx * t) / 1.2)},${num(ay - t)} L${num(ax - (dx * t) / 1.2)},${num(ay + t)} L${num(ax + (dx * t) / 1.2)},${num(ay)} Z`;
          parts.push(`<path class="fmc-rr" d="${tri}"/><text class="fmc-text fmc-r" x="${num(ax + 6 * k)}" y="${num(ay - 4 * k)}">R</text>`);
        } else {
          parts.push(`<text class="fmc-text fmc-elabel" x="${num(lx + l.width)}" y="${num(ly + l.height / 2)}" dy="0.35em" text-anchor="end">${textRuns(l.text)}</text>`);
        }
      }
    } else if (e.label && e.labelAt) {
      const l = e.labelAt;
      parts.push(`<text class="fmc-text fmc-elabel" x="${num(l.x + l.w / 2)}" y="${num(l.y + l.h / 2)}" dy="0.35em" text-anchor="middle">${textRuns(e.label)}</text>`);
    }
    edges.push(`<g class="fmc-edge fmc-e-${e.kind}" data-edge="${esc(e.id)}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"${attrs(e.data)}>${e.title ? `<title>${esc(e.title)}</title>` : ''}${parts.join('')}</g>`);
  }
  out.push(`<g class="fmc-edges">${edges.join('')}</g>`);
  // Nodes, on top.
  for (const n of model.nodes) {
    if (n.kind === 'channel' && n.edge) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const cls = `fmc-node fmc-${n.kind}${n.className ? ` ${n.className}` : ''}`;
    const tab = focusable && n.data ? ' tabindex="0"' : '';
    const title = n.title ? `<title>${esc(n.title)}</title>` : '';
    let body = '';
    const cx = n.x + n.w / 2;
    const cy = n.y + n.h / 2;
    if (n.kind === 'channel') {
      body = `<circle class="fmc-shape fmc-ch" cx="${num(cx)}" cy="${num(cy)}" r="${num(n.w / 2)}"/>`;
      if (n.label) {
        body += `<text class="fmc-text fmc-elabel" x="${num(n.x - 4 * k)}" y="${num(cy)}" dy="0.35em" text-anchor="end">${textRuns(n.label)}</text>`;
      }
    } else if (n.kind === 'dots' || n.kind === 'vdots') {
      const dots = [-1, 0, 1].map((i) => (n.kind === 'dots' ? [cx + i * 6 * k, cy] : [cx, cy + i * 6 * k]));
      body = dots.map(([x, y]) => `<circle class="fmc-dot" cx="${num(x)}" cy="${num(y)}" r="${num(1.6 * k)}"/>`).join('');
    } else {
      const rx = n.kind === 'storage' ? Math.min(n.h, n.w) / 2 : 0;
      if (n.enumerated) {
        // One exemplar for the others: a node behind it, and dots (Figures 11 and 27).
        const o = 10 * k;
        body += `<rect class="fmc-shape fmc-behind" x="${num(n.x + o)}" y="${num(n.y - o)}" width="${num(n.w)}" height="${num(n.h)}" rx="${num(rx)}"/>`;
        body += [0, 1, 2].map((i) => `<circle class="fmc-dot" cx="${num(n.x + n.w + o - 12 * k + i * 4 * k)}" cy="${num(n.y - o + 10 * k - i * 4 * k)}" r="${num(1.3 * k)}"/>`).join('');
      }
      body += `<rect class="fmc-shape" x="${num(n.x)}" y="${num(n.y)}" width="${num(n.w)}" height="${num(n.h)}" rx="${num(rx)}"/>`;
      let tx = cx;
      let ty = cy;
      if (n.kind === 'person') {
        if (n.fit) {
          if (n.h > n.w * 1.2) {
            body += figure(n.x, n.y + 4 * k, n.w, n.h * 0.62);
            ty = n.y + n.h - 6 * k - (n.fit.lines.length * 14 * k) / 2;
          } else {
            const s = Math.min(n.h - 10 * k, 26 * k);
            body += figure(n.x + 6 * k, n.y + (n.h - s) / 2, s, s);
            tx = cx + (s + 2 * k) / 2;
          }
        } else {
          body += figure(n.x + 3 * k, n.y + 3 * k, n.w - 6 * k, n.h - 6 * k);
        }
      }
      if (n.icon === 'board') {
        const s = Math.min(n.w, n.h) * 0.5;
        body += board(cx - s / 2, n.y + 8 * k, s);
        ty = n.y + n.h - 16 * k;
      }
      if (n.sub) {
        body += textLines(n.fit, tx, ty - 7 * k, { size, k });
        body += `<text class="fmc-text fmc-sub" x="${num(tx)}" y="${num(ty + 7 * k + ((n.fit?.lines.length || 1) - 1) * 7 * k)}" dy="0.35em" text-anchor="middle">${textRuns(n.sub)}</text>`;
      } else {
        body += textLines(n.fit, tx, ty, { size, k });
      }
    }
    out.push(`<g class="${cls}" data-node="${esc(n.id)}"${attrs(n.data)}${tab}>${title}${body}</g>`);
  }
  const w = Math.ceil(model.width);
  const h = Math.ceil(model.height);
  return `<svg xmlns="http://www.w3.org/2000/svg" class="fmc${className ? ` ${className}` : ''}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img"${model.title ? ` aria-label="${esc(model.title)}"` : ''}>${out.join('')}</svg>`;
}

/** Lays the diagram out and draws it: `{ svg, model, ms }`. */
export async function render(diagram, options = {}) {
  const t = Date.now();
  const model = await layout(diagram, options);
  return { svg: svg(model, options), model, ms: Date.now() - t };
}
