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
 * FMC block diagrams (the Fundamental Modeling Concepts, https://www.fmc-modeling.org) as
 * Mermaid flowcharts: what a diagram is, the Mermaid text that draws it (which a person can
 * paste into GitHub), and a customer's stack drawing (src/stack.js) as one. The browser draws
 * the text with Mermaid and ELK and makes it FMC's (src/ui-fmc.js); this file is what Node can
 * test.
 *
 * A diagram is `{ direction, nodes, groups, edges, order? }` (`order: true` keeps the nodes of
 * each layer in the order given, as an enumeration's dots need, at the cost of more crossings):
 *
 * - a node `{ id, label, kind, group?, size?, many?, code? }`: an agent (a rectangle), a
 *   storage (a rounded one), a person (a human agent: a rectangle with a figure), an external
 *   agent (one of the environment), a channel (a small circle), or text (an enumeration's dots);
 *   `size` is how important it is (s, m, l, xl), not how long its label is; `many` draws it as
 *   a stack of the same (FMC's enumeration); `code` writes the label in a monospace font.
 * - a group `{ id, label, kind, parent?, direction? }`: a grey area of related nodes (`area`),
 *   an agent or a storage that nests others (`agent`, `storage`, drawn as thick as nodes), a
 *   bundle of unrelated ones that share their edges (`bundle`, as thin as an edge), or no
 *   frame at all, only nodes laid out side by side (`row`). A group with a `direction` (TB,
 *   LR; a row's is LR) lays its nodes out that way, on their own, when no edge crosses it.
 * - an edge `{ from, to, kind, label?, flow?, up? }`: between two agents a channel, `channel`
 *   (both ways), `flow` (from → to) or `request` (from asks, to answers: R/R); between an agent
 *   and a storage an access, `read` (from reads to), `write` or `modify`; anywhere a plain
 *   `line` or `arrow`, and a `hidden` one that only places its nodes. An edge may end at a
 *   group: at a bundle, it is an edge to each of its nodes. Its `from` is laid out above its
 *   `to` (left of it, LR), whichever way its arrows point; `up` lays it out from `to` down to
 *   `from` (a flow from a lower layer up into a higher one). `flow` is the index of the stack
 *   flow it draws.
 *
 * `mermaid(diagram)` plans it: the Mermaid text, and what src/ui-fmc.js needs to make the
 * drawing FMC's (each Mermaid node's and edge's kind, which edges to lay out upwards).
 */

export const NODE_KINDS = ['agent', 'storage', 'person', 'external', 'channel', 'text'];
export const GROUP_KINDS = ['area', 'agent', 'storage', 'bundle', 'row'];
export const EDGE_KINDS = [
  'channel', 'flow', 'request', 'read', 'write', 'modify', 'line', 'arrow', 'hidden',
];
export const SIZES = ['s', 'm', 'l', 'xl'];

/** The kinds a stack drawing's parts and flows may have (src/stack.js, the Kind columns). */
export const PART_KINDS = ['agent', 'storage', 'channel', 'person', 'external'];
export const FLOW_KINDS = ['flow', 'request', 'read', 'write', 'modify'];

const ACTIVE = new Set(['agent', 'person', 'external']);

/**
 * Text as a Mermaid label in double quotes: every character that could end it or be read as
 * markup is an entity code (`#35;` for #), so a label is always the text it is.
 */
export function label(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
    .replace(/[^\w .,:;/()'+*?!@$%=~[\]{}|-]/gu, (c) => `#${c.codePointAt(0)};`);
}

/** A Mermaid label in a monospace font: `<code>` survives Mermaid's sanitizer. */
const codeLabel = (text) => `#60;code#62;${label(text)}#60;/code#62;`;

const SHAPES = {
  agent: (id, l) => `${id}["${l}"]`,
  person: (id, l) => `${id}["${l}"]`,
  external: (id, l) => `${id}["${l}"]`,
  storage: (id, l) => `${id}(["${l}"])`,
  channel: (id) => `${id}((" "))`,
  text: (id, l) => `${id}@{ shape: text, label: "${l}" }`,
};

/**
 * The Mermaid links of an edge between Mermaid nodes `a` and `b` (`c` the channel's, when it
 * has one), as `[start, link, end, label]`: one link, or two through the channel.
 */
function links(kind, a, b, c, text) {
  const t = text ? label(text) : '';
  switch (kind) {
    case 'channel':
    case 'request':
      return [[a, '---', c, t], [c, '---', b, '']];
    case 'flow':
      return [[a, '-->', c, t], [c, '-->', b, '']];
    case 'read':
      // The storage is read: the arrow points at the agent.
      return [[b, '-->', a, t]];
    case 'modify':
      return [[a, '<-->', b, t]];
    case 'line':
      return [[a, '---', b, t]];
    case 'hidden':
      return [[a, '~~~', b, '']];
    default:
      return [[a, '-->', b, t]];
  }
}

/** Whether an edge of `kind` between nodes of these kinds runs through a channel. */
function channelled(kind, from, to) {
  return ['channel', 'flow', 'request'].includes(kind) && ACTIVE.has(from) && ACTIVE.has(to);
}

/**
 * An edge's kind as FMC has it between nodes of these kinds: a flow into a storage writes it,
 * one out of it reads it; a channel between a storage and an agent is the access it is.
 */
export function edgeKind(kind, from, to) {
  const k = EDGE_KINDS.includes(kind) ? kind : 'flow';
  const wire = ['flow', 'channel', 'request'].includes(k);
  if (wire && from === 'storage' && ACTIVE.has(to)) {
    return k === 'channel' ? 'modify' : 'read-by';
  }
  if (wire && to === 'storage' && ACTIVE.has(from)) {
    return { flow: 'write', channel: 'modify', request: 'read' }[k];
  }
  return k;
}

/**
 * Plans a diagram as Mermaid: `{ text, nodes, groups, edges, channels }`. `nodes` and `groups`
 * map the Mermaid ids to the diagram's (`{ id, kind, size, many, code, group }`); `edges` are
 * the Mermaid links in the order of the text, each `{ kind, flow, up, from, to, part }` (`up`
 * when ELK is to lay it out from its end to its start; `part` which half of a channelled edge it
 * is); `channels` maps a channel's Mermaid id to its edge's
 * `{ kind, from, to, flow }` (Mermaid ids). Unknown kinds are agents and flows; edges between
 * nodes that are not there are left out.
 */
export function mermaid(diagram) {
  const direction = diagram.direction === 'LR' ? 'LR' : 'TB';
  const nodes = new Map();
  const groups = new Map();
  const mid = new Map();
  const gid = new Map();
  (diagram.groups || []).forEach((g, i) => {
    gid.set(g.id, `g${i}`);
  });
  for (const [i, g] of (diagram.groups || []).entries()) {
    groups.set(`g${i}`, {
      id: g.id,
      label: g.label || '',
      kind: GROUP_KINDS.includes(g.kind) ? g.kind : 'area',
      parent: gid.get(g.parent) || null,
      direction: ['TB', 'LR'].includes(g.direction) ? g.direction : (g.kind === 'row' && 'LR') || null,
    });
  }
  for (const [i, n] of (diagram.nodes || []).entries()) {
    const kind = NODE_KINDS.includes(n.kind) ? n.kind : 'agent';
    const id = `${{ channel: 'c', text: 't' }[kind] || 'n'}${i}`;
    mid.set(n.id, id);
    nodes.set(id, {
      id: n.id,
      label: n.label ?? '',
      kind,
      size: SIZES.includes(n.size) ? n.size : 'm',
      many: Boolean(n.many),
      code: Boolean(n.code),
      group: gid.get(n.group) || null,
    });
  }
  // What an edge's end is: a node's kind, or a group's: a nesting agent or storage, or what
  // the first node of a bundle or an area is.
  const kindOf = (id) => {
    if (nodes.has(id)) {
      return nodes.get(id).kind;
    }
    const g = groups.get(id);
    if (g.kind === 'agent' || g.kind === 'storage') {
      return g.kind;
    }
    const first = [...nodes.values()].find((n) => n.group === id);
    return first ? first.kind : 'agent';
  };
  const edges = [];
  const channels = new Map();
  const lines = [];
  for (const [i, e] of (diagram.edges || []).entries()) {
    const a = mid.get(e.from) || gid.get(e.from);
    const b = mid.get(e.to) || gid.get(e.to);
    if (!a || !b || a === b) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const ka = kindOf(a);
    const kb = kindOf(b);
    let kind = edgeKind(e.kind, ka, kb);
    let [from, to] = [a, b];
    if (kind === 'read-by') {
      // From a storage to an agent: the agent reads it.
      [from, to] = [b, a];
      kind = 'read';
    }
    let c = null;
    if (channelled(kind, ka, kb)) {
      c = `c${i}e`;
      channels.set(c, {
        kind, from, to, flow: e.flow ?? null,
      });
      nodes.set(c, {
        id: null, label: '', kind: 'channel', size: 's', many: false, code: false, group: null,
      });
    }
    const made = links(kind, from, to, c, e.label);
    // ELK lays a link out from its start down to its end: a link is laid out the other way
    // (`up`) when it runs neither from the end that is to be on top nor to the other one.
    const [top, bottom] = e.up ? [b, a] : [a, b];
    made.forEach(([s, link, t, text], part) => {
      edges.push({
        kind, flow: e.flow ?? null, up: s !== top && t !== bottom, from: s, to: t, part, edge: i,
      });
      lines.push(`  ${s} ${link}${text ? `|"${text}"|` : ''} ${t}`);
    });
  }
  // Nodes and groups, nested, in the order they were given (ELK keeps it where it can).
  const out = [];
  const decl = (id) => {
    const n = nodes.get(id);
    if (n.kind === 'channel') {
      return SHAPES.channel(id);
    }
    // A node without a label has a blank one: Mermaid takes no empty label.
    return SHAPES[n.kind](id, (n.code ? codeLabel(n.label) : label(n.label)) || ' ');
  };
  const channelOf = new Map();
  const chain = (g) => (g ? [g, ...chain(groups.get(g).parent)] : []);
  for (const [c, ch] of channels) {
    // A channel sits in the innermost group that holds both its agents: an edge that left it
    // and came back in would make ELK lay the group out as part of a cycle.
    const ga = nodes.has(ch.from) ? nodes.get(ch.from).group : groups.get(ch.from).parent;
    const gb = new Set(chain(nodes.has(ch.to) ? nodes.get(ch.to).group : groups.get(ch.to).parent));
    channelOf.set(c, chain(ga).find((g) => gb.has(g)) || null);
  }
  const groupOf = (id) => (nodes.get(id).kind === 'channel' ? channelOf.get(id) : nodes.get(id).group);
  const block = (parent, indent) => {
    for (const [id, g] of groups) {
      if (g.parent === parent) {
        out.push(`${indent}subgraph ${id}["${label(g.label) || ' '}"]`);
        if (g.direction) {
          out.push(`${indent}  direction ${g.direction}`);
        }
        block(id, `${indent}  `);
        out.push(`${indent}end`);
      }
    }
    for (const id of nodes.keys()) {
      if (groupOf(id) === parent) {
        out.push(`${indent}${decl(id)}`);
      }
    }
  };
  block(null, '  ');
  // Classes: what each node is, for GitHub, which draws nodes twice as thick as edges with
  // them (and no colors: its theme's). The drawing takes all it needs from the plan.
  const classes = new Map();
  const add = (cls, id) => {
    classes.set(cls, [...(classes.get(cls) || []), id]);
  };
  for (const [id, n] of nodes) {
    add(n.kind, id);
  }
  const defs = {
    agent: 'stroke-width:2px',
    person: 'stroke-width:2px',
    external: 'stroke-width:2px',
    storage: 'stroke-width:2px',
    channel: 'stroke-width:2px',
    text: 'stroke-width:0px',
  };
  const classLines = [...classes].map(([cls, ids]) => `  class ${ids.join(',')} ${cls}`);
  const defLines = [...classes.keys()].map((cls) => `  classDef ${cls} ${defs[cls]}`);
  const text = [
    '---',
    'config:',
    '  layout: elk',
    '  look: classic',
    '  theme: neutral',
    '  elk:',
    '    mergeEdges: true',
    '---',
    `flowchart ${direction}`,
    ...out,
    ...lines,
    ...defLines,
    ...classLines,
    ...(edges.length ? ['  linkStyle default stroke-width:1px'] : []),
  ].join('\n');
  return {
    text: `${text}\n`, direction, nodes, groups, edges, channels, order: Boolean(diagram.order),
  };
}

/**
 * A customer's stack drawing (src/stack.js `stackView`: `{ layers: [{ id, name, parts }],
 * flows }`) as an FMC diagram: each layer a grey area, top to bottom, and each group of parts
 * an area in it; each part a node (`part:<n>`, numbered as the layers list them), as important
 * as the flows it has (a person on top, outside the layers); each flow an edge (FMC's channel
 * or access, by the parts' kinds), laid out downwards from the higher layer, a layer without
 * flows under those with; and, where the
 * drawing has flows, the visitors on top, asking the parts in front (the edge, else the site)
 * that no other part asks.
 */
export function stackDiagram(view, { visitors = true } = {}) {
  const order = view.layers.map((l) => l.id);
  const groups = [];
  const nodes = [];
  const parts = [];
  for (const l of view.layers) {
    groups.push({ id: `layer:${l.id}`, label: l.name, kind: 'area' });
    for (const p of l.parts) {
      const at = parts.length;
      parts.push({ ...p, layer: l.id, at });
      if (p.group) {
        const id = `group:${l.id}:${String(p.group).toLowerCase()}`;
        if (!groups.some((g) => g.id === id)) {
          groups.push({
            id, label: p.group, kind: 'area', parent: `layer:${l.id}`,
          });
        }
      }
    }
  }
  const at = new Map(parts.map((p) => [p.name.toLowerCase(), p.at]));
  const flows = (view.flows || []).map((f, i) => ({
    ...f, i, a: at.get(String(f.from).toLowerCase()), b: at.get(String(f.to).toLowerCase()),
  })).filter((f) => f.a != null && f.b != null && f.a !== f.b);
  const degree = parts.map((p) => flows.filter((f) => f.a === p.at || f.b === p.at).length);
  const most = Math.max(0, ...degree);
  for (const p of parts) {
    // Importance by the flows a part has: the hubs are larger, all others the same size.
    const big = most >= 3 && degree[p.at] >= Math.max(3, Math.ceil(most * 0.75));
    const kind = PART_KINDS.includes(p.kind) ? p.kind : 'agent';
    nodes.push({
      id: `part:${p.at}`,
      label: p.name,
      kind,
      // People are the environment, on top with the visitors, not in a layer.
      group: (kind === 'person' ? null : p.group && `group:${p.layer}:${String(p.group).toLowerCase()}`) ?? (kind === 'person' ? null : `layer:${p.layer}`),
      size: big ? 'l' : 'm',
    });
  }
  // People are above every layer.
  const rank = (p) => (parts[p].kind === 'person' ? -1 : order.indexOf(parts[p].layer));
  const edges = flows.map((f) => ({
    from: `part:${f.a}`,
    to: `part:${f.b}`,
    kind: FLOW_KINDS.includes(f.kind) ? f.kind : 'flow',
    flow: f.i,
    up: rank(f.a) > rank(f.b),
  }));
  // A layer without flows is held under the last layer above it that has some (else the one
  // above it), so the layers keep their order, top to bottom, and do not float beside.
  const held = new Set(nodes.map((n) => n.group));
  const busy = new Set(flows.flatMap((f) => [parts[f.a], parts[f.b]])
    .filter((p) => p.kind !== 'person').map((p) => p.layer));
  const shown = order.filter((l) => held.has(`layer:${l}`) || groups.some((g) => g.parent === `layer:${l}` && held.has(g.id)));
  shown.forEach((l, i) => {
    if (i > 0 && !busy.has(l)) {
      const above = shown.slice(0, i).reverse();
      const from = above.find((x) => busy.has(x)) || above[0];
      edges.push({ from: `layer:${from}`, to: `layer:${l}`, kind: 'hidden' });
    }
  });
  if (visitors && flows.length) {
    const front = ['edge', 'site'].find((l) => order.includes(l));
    const asked = new Set(flows.map((f) => f.b));
    const entry = parts.filter((p) => p.layer === front && !asked.has(p.at)
      && !['storage', 'channel', 'person'].includes(p.kind));
    if (entry.length) {
      nodes.unshift({
        id: 'visitors', label: 'Visitors', kind: 'person', size: 'm',
      });
      for (const p of entry) {
        edges.push({ from: 'visitors', to: `part:${p.at}`, kind: 'request' });
      }
    }
  }
  // The groups that hold a node, or a group that does (a layer of people only holds none).
  const kept = new Set();
  for (const g of [...groups].reverse()) {
    if (held.has(g.id) || kept.has(g.id)) {
      kept.add(g.id);
      if (g.parent) {
        kept.add(g.parent);
      }
    }
  }
  return {
    direction: 'TB',
    nodes,
    groups: groups.filter((g) => kept.has(g.id)),
    edges: edges.filter((e) => e.kind !== 'hidden' || (kept.has(e.from) && kept.has(e.to))),
  };
}
