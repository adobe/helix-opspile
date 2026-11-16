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
 * A prototype: FMC block diagrams drawn by D2 (https://d2lang.com) instead of Graphviz and
 * src/fmc.js. It takes what src/fmc.js takes, an FMC block diagram as DOT (and a stack drawing
 * through src/fmcstack.js), writes it as D2 source, and after D2 has laid it out and drawn it,
 * makes D2's SVG an FMC one. Nothing here imports D2: the renderer that runs it
 * (scripts/dev-ui-d2.mjs in `npm run ui:dev`, a rendering Worker later) passes its output in.
 *
 * What D2 does itself: the layout (ELK by default, orthogonal edges with rounded corners), the
 * frames as containers (labels where `label.near` puts them), agents and storages (rectangles,
 * rounded), channels (small circles, their labels `outside-…`), enumerations (`multiple`, a text
 * node "…"), sets (`double-border`), structure variance (`stroke-dash`), compound edges (an edge
 * to a container), layers without flows (a grid), and the classes the kinds are.
 *
 * What the SVG is given afterwards (`finishSvg`), as D2 cannot draw it: the colors (D2's theme
 * is taken out, the classes of src/fmc.js put in, so the page's Spectrum 2 stylesheet colors it,
 * light and dark), the arrowheads (small, one per edge tree), edge trees (the edges that leave a
 * node's side the same way share a port and a trunk), the modify access (two arcs), the R of a
 * request channel and its arrow, the human agent's figure, the u-shaped agent, and rows of a
 * layer as wide as each other.
 *
 * Sizes are D2's px times `zoom`, and the SVG is drawn 1/zoom as large: D2's ELK keeps 70 px
 * between ranks and 40 between edges and nodes, whatever the diagram, and its JavaScript API
 * takes no options for them, so a larger drawing scaled down is the way to tighten them.
 */

import { FONT, wrap } from './fmc.js';

/* eslint-disable no-continue -- the loops skip what they do not draw */

// ---------------------------------------------------------------- DOT

/** DOT's tokens: `{ t: 'id', v }` (names, numbers, quoted strings) and `{ t: 'op', v }`. */
function tokenize(src) {
  const out = [];
  const s = String(src);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (s.startsWith('//', i) || (c === '#' && (i === 0 || s[i - 1] === '\n'))) {
      while (i < s.length && s[i] !== '\n') {
        i += 1;
      }
    } else if (s.startsWith('/*', i)) {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
    } else if (s.startsWith('->', i) || s.startsWith('--', i)) {
      out.push({ t: 'op', v: s.slice(i, i + 2) });
      i += 2;
    } else if ('{}[];,=:'.includes(c)) {
      out.push({ t: 'op', v: c });
      i += 1;
    } else if (c === '"') {
      let v = '';
      i += 1;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && s[i + 1] === '"') {
          v += '"';
          i += 2;
        } else if (s[i] === '\\' && s[i + 1] === '\n') {
          i += 2;
        } else {
          v += s[i];
          i += 1;
        }
      }
      i += 1;
      // "a" + "b" is one string.
      const last = out[out.length - 1];
      if (last?.plus) {
        out.pop();
        out[out.length - 1].v += v;
      } else {
        out.push({ t: 'id', v });
      }
    } else if (c === '+' && out[out.length - 1]?.t === 'id') {
      out.push({ t: 'op', v: '+', plus: true });
      i += 1;
    } else if (c === '<') {
      // An HTML label: kept as its text.
      let depth = 0;
      const start = i;
      do {
        if (s[i] === '<') {
          depth += 1;
        } else if (s[i] === '>') {
          depth -= 1;
        }
        i += 1;
      } while (i < s.length && depth > 0);
      out.push({ t: 'id', v: s.slice(start + 1, i - 1).replace(/<[^>]*>/g, '') });
    } else {
      const m = /^(-?(?:\.\d+|\d+(?:\.\d*)?)|[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)/.exec(s.slice(i));
      if (!m) {
        throw new Error(`DOT: unexpected "${c}" at ${i}`);
      }
      out.push({ t: 'id', v: m[1] });
      i += m[1].length;
    }
  }
  return out;
}

/**
 * An FMC block diagram in DOT (src/fmc.js), as its structure: `{ directed, attrs, nodes, edges,
 * root, clusters, ranks }`. `nodes` is a Map of name to `{ name, attrs, cluster, order }`, each
 * with the defaults of where it was first named; a node belongs to the innermost cluster that
 * names it. `root` and `clusters` are `{ name, attrs, parent, children, nodes, depth }`, `ranks`
 * the `{ rank=… }` subgraphs: `{ rank, nodes }`. Throws on DOT it cannot read.
 */
export function parseDot(dot) {
  const toks = tokenize(dot);
  let i = 0;
  const is = (v) => toks[i]?.t === 'op' && toks[i].v === v;
  const expect = (v) => {
    if (!is(v)) {
      throw new Error(`DOT: expected "${v}"${toks[i] ? ` before "${toks[i].v}"` : ' at the end'}`);
    }
    i += 1;
  };
  const id = () => {
    const t = toks[i];
    if (t?.t !== 'id') {
      throw new Error(`DOT: expected a name${t ? ` before "${t.v}"` : ' at the end'}`);
    }
    i += 1;
    return t.v;
  };
  if (toks[i]?.t === 'id' && /^strict$/i.test(toks[i].v)) {
    i += 1;
  }
  const kind = id();
  if (!/^(di)?graph$/i.test(kind)) {
    throw new Error('DOT: a graph starts with "graph" or "digraph"');
  }
  if (toks[i]?.t === 'id') {
    i += 1;
  }
  const root = {
    name: '', attrs: {}, parent: null, children: [], nodes: [], depth: -1,
  };
  const g = {
    directed: /^digraph$/i.test(kind), attrs: root.attrs, nodes: new Map(), edges: [], root, clusters: [], ranks: [],
  };
  const inside = (c, of) => {
    for (let p = c; p; p = p.parent) {
      if (p === of) {
        return true;
      }
    }
    return false;
  };
  const attrList = () => {
    const a = {};
    while (is('[')) {
      i += 1;
      while (!is(']')) {
        const k = id();
        a[k] = is('=') ? (i += 1, id()) : 'true';
        if (is(',') || is(';')) {
          i += 1;
        }
      }
      i += 1;
    }
    return a;
  };
  const node = (name, scope, attrs = {}) => {
    let n = g.nodes.get(name);
    if (!n) {
      n = {
        name, attrs: { ...scope.node }, cluster: scope.cluster, order: g.nodes.size,
      };
      g.nodes.set(name, n);
    } else if (inside(scope.cluster, n.cluster) && scope.cluster !== n.cluster) {
      n.cluster = scope.cluster;
    }
    Object.assign(n.attrs, attrs);
    for (const set of scope.sets) {
      set.add(name);
    }
    return n;
  };
  let stmts;
  const subgraph = (scope) => {
    let name = '';
    if (toks[i]?.t === 'id' && /^subgraph$/i.test(toks[i].v)) {
      i += 1;
      if (toks[i]?.t === 'id') {
        name = id();
      }
    }
    expect('{');
    const set = new Set();
    let { cluster } = scope;
    let attrs = {};
    if (/^cluster/.test(name)) {
      cluster = {
        name,
        attrs: {},
        parent: scope.cluster,
        children: [],
        nodes: [],
        depth: scope.cluster.depth + 1,
      };
      scope.cluster.children.push(cluster);
      g.clusters.push(cluster);
      attrs = cluster.attrs;
    }
    stmts({
      cluster, attrs, node: { ...scope.node }, edge: { ...scope.edge }, sets: [...scope.sets, set],
    });
    expect('}');
    if (attrs.rank && cluster === scope.cluster) {
      g.ranks.push({ rank: attrs.rank, nodes: [...set] });
    }
    return [...set];
  };
  const endpoint = (scope) => {
    if (is('{') || (toks[i]?.t === 'id' && /^subgraph$/i.test(toks[i].v))) {
      return subgraph(scope);
    }
    const name = id();
    if (is(':')) {
      // A port: not drawn.
      i += 1;
      id();
      if (is(':')) {
        i += 1;
        id();
      }
    }
    node(name, scope);
    return [name];
  };
  stmts = (scope) => {
    while (i < toks.length && !is('}')) {
      if (is(';') || is(',')) {
        i += 1;
        continue;
      }
      const t = toks[i];
      if (t.t === 'id' && /^(graph|node|edge)$/i.test(t.v) && toks[i + 1]?.v === '[') {
        i += 1;
        const a = attrList();
        const what = t.v.toLowerCase();
        Object.assign(what === 'graph' ? scope.attrs : scope[what], a);
        continue;
      }
      if (t.t === 'id' && toks[i + 1]?.v === '=' && toks[i + 1]?.t === 'op') {
        i += 2;
        // eslint-disable-next-line no-param-reassign -- the attributes of the (sub)graph read
        scope.attrs[t.v] = id();
        continue;
      }
      const ends = [endpoint(scope)];
      const ops = [];
      while (is('->') || is('--')) {
        ops.push(toks[i].v);
        i += 1;
        ends.push(endpoint(scope));
      }
      const a = attrList();
      if (!ops.length) {
        if (ends[0].length === 1 && Object.keys(a).length) {
          node(ends[0][0], scope, a);
        }
        continue;
      }
      for (let k = 1; k < ends.length; k += 1) {
        for (const tail of ends[k - 1]) {
          for (const head of ends[k]) {
            g.edges.push({
              tail, head, attrs: { ...scope.edge, ...a }, order: g.edges.length,
            });
          }
        }
      }
    }
  };
  expect('{');
  stmts({
    cluster: root, attrs: root.attrs, node: {}, edge: {}, sets: [],
  });
  expect('}');
  for (const n of g.nodes.values()) {
    n.cluster.nodes.push(n);
  }
  return g;
}

// ---------------------------------------------------------------- D2 source

const PT = 72;
const truthy = (v) => v === true || /^(true|yes|1)$/i.test(String(v ?? ''));
const falsy = (v) => /^(false|no|0)$/i.test(String(v ?? ''));

/** A node's FMC kind, as src/fmc.js reads it. */
export function nodeKind(attrs) {
  let k = String(attrs.fmc || (attrs.style === 'invis' ? 'invis' : 'agent')).toLowerCase();
  if (k === 'agent' && /rounded/.test(attrs.style || '')) {
    k = 'storage';
  }
  if (k === 'agent' && /^(circle|point|doublecircle)$/.test(attrs.shape || '')) {
    k = 'channel';
  }
  return k;
}

/** A D2 string: double quoted, its escapes and substitutions escaped. */
export function d2String(s) {
  return `"${String(s ?? '').replace(/[\\"$]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n')}"`;
}

/** A label's text without its code backticks, wrapped as src/fmc.js wraps it. */
function lines(text, width, size, max) {
  if (!String(text ?? '').trim()) {
    return [];
  }
  return wrap(text, width, size, max).map((l) => l.map((r) => r.text).join(''));
}

/** The D2 classes, one per FMC kind; the SVG's colors are the page's (`finishSvg`). */
function classes(z) {
  const f = Math.round(FONT.label * z);
  const small = Math.round(FONT.small * z);
  const text = `font-size: ${f}; bold: false`;
  return [
    'classes: {',
    `  fmc-agent: { shape: rectangle; style: { stroke-width: 2; ${text} } }`,
    `  fmc-storage: { shape: rectangle; style: { stroke-width: 2; border-radius: ${Math.round(16 * z)}; ${text} } }`,
    `  fmc-person: { shape: rectangle; label.near: bottom-center; style: { stroke-width: 2; ${text} } }`,
    `  fmc-channel: { shape: circle; style: { stroke-width: 2; font-size: ${small}; bold: false } }`,
    `  fmc-dots: { shape: text; style: { font-size: ${Math.round(18 * z)}; bold: true } }`,
    `  fmc-caption: { shape: text; style: { ${text} } }`,
    `  fmc-group: { style: { stroke-width: 0; ${text} } }`,
    `  fmc-frame-agent: { style: { stroke-width: 2; ${text} } }`,
    `  fmc-frame-storage: { style: { stroke-width: 2; border-radius: ${Math.round(16 * z)}; ${text} } }`,
    `  fmc-frame-set: { style: { stroke-width: 1; double-border: true; ${text} } }`,
    `  fmc-frame-ushape: { style: { stroke-width: 2; ${text} } }`,
    `  fmc-edge: { style: { stroke-width: 1; border-radius: ${Math.round(6 * z)} } }`,
    '  fmc-hidden: { style: { opacity: 0 } }',
    '}',
  ];
}

/** A cluster's label position, as D2's `label.near`. */
function frameNear(attrs, graph) {
  const loc = /^b/i.test(attrs.labelloc || '') ? 'bottom' : 'top';
  const just = String(attrs.labeljust || graph.labeljust || 'c').toLowerCase();
  const side = { l: 'left', r: 'right' }[just] || 'center';
  return `${loc}-${side}`;
}

/**
 * The D2 source of `g` (parseDot), and what the SVG needs to be made an FMC one: `{ source,
 * zoom, shapes, edges, direction }`. `shapes` is a Map of D2 id to `{ node | cluster, kind,
 * lines }`, `edges` the connections in the order the source declares them (D2 keeps it), each
 * `{ tail, head, from, to, arrowA, arrowB, hidden, modify, flow }`. `layout` is D2's layout
 * engine (`elk`, `dagre`); `zoom` how much larger than drawn D2 lays it out.
 */
export function toD2(g, { zoom = 2, layout = 'elk' } = {}) {
  const z = zoom;
  const px = (inches, fallback) => Math.round((Number(inches) || fallback) * PT * z);
  const shapes = new Map();
  const ids = new Map();
  const pathOf = new Map();
  // Ids of our own: DOT names can be anything, and D2 reserves some (top, near, label…).
  const keyOf = (c) => {
    if (!ids.has(c)) {
      ids.set(c, `${c.nodes ? 'g' : 'n'}${ids.size}`);
    }
    return ids.get(c);
  };
  const lr = /^(LR|RL)$/i.test(g.attrs.rankdir || '');
  const direction = {
    LR: 'right', RL: 'left', BT: 'up',
  }[String(g.attrs.rankdir || '').toUpperCase()] || 'down';
  const kinds = new Map([...g.nodes.values()].map((n) => [n.name, nodeKind(n.attrs)]));
  // A caption names the frame it is in (Graphviz has no label beside a row; D2 has its own).
  const absorbed = new Set();
  for (const c of g.clusters) {
    const cap = c.nodes.find((n) => kinds.get(n.name) === 'caption');
    if (cap && !String(c.attrs.label || c.attrs.rowlabel || '').trim()) {
      c.attrs.rowlabel = String(cap.attrs.label || '');
      absorbed.add(cap.name);
    }
  }
  const drawn = (name) => !['invis', 'wall'].includes(kinds.get(name)) && !absorbed.has(name);
  // Nodes in one rank: an invisible edge between two of them only orders them in Graphviz.
  const rankGroup = new Map();
  g.ranks.forEach((r, k) => r.nodes.forEach((name) => rankGroup.set(name, k)));
  const sameRank = (a, b) => rankGroup.has(a) && rankGroup.get(a) === rankGroup.get(b);
  const hiddenEdge = (e) => /invis/.test(e.attrs.style || '');
  const visible = g.edges.filter((e) => !hiddenEdge(e) && drawn(e.tail) && drawn(e.head)
    && e.tail !== e.head);
  // Without flows and nested frames, a grid: its rows the ranks (D2's layouts have none).
  const grid = !visible.length && g.clusters.every((c) => c.depth === 0);
  const rankOf = new Map();
  if (grid) {
    for (const n of g.nodes.values()) {
      rankOf.set(n.name, 0);
    }
    const same = new Map();
    for (const r of g.ranks) {
      for (const name of r.nodes) {
        same.set(name, r.nodes);
      }
    }
    for (let pass = 0; pass < g.nodes.size; pass += 1) {
      let moved = false;
      for (const e of g.edges) {
        const want = rankOf.get(e.tail) + 1;
        if (rankOf.get(e.head) < want) {
          for (const name of same.get(e.head) || [e.head]) {
            rankOf.set(name, Math.max(rankOf.get(name), want));
          }
          moved = true;
        }
      }
      if (!moved) {
        break;
      }
    }
  }

  const out = [
    `vars: { d2-config: { layout-engine: ${layout} } }`,
    `direction: ${direction}`,
    ...classes(z),
  ];
  const ind = (d) => '  '.repeat(d);
  const nodeLines = (n, d) => {
    const { attrs } = n;
    const kind = kinds.get(n.name);
    if (!drawn(n.name)) {
      return [];
    }
    const key = keyOf(n);
    const path = [...pathOf.get(n.cluster) || [], key].join('.');
    pathOf.set(n, path);
    const w = Number(attrs.width) || 0.75;
    const h = Number(attrs.height) || 0.5;
    const label = String(attrs.label == null || attrs.label === '\\N' ? n.name : attrs.label).trim();
    const props = [];
    let text = [];
    let labelLines = 0;
    if (kind === 'channel') {
      const size = Math.round(11 * z);
      const loc = String(attrs.labelloc || (lr ? 't' : 'r')).toLowerCase();
      const near = {
        t: 'outside-top-center', b: 'outside-bottom-center', l: 'outside-left-center',
      }[loc] || 'outside-right-center';
      text = lines(label, 104, FONT.small, 2);
      props.push('class: fmc-channel', `width: ${size}`, `height: ${size}`);
      if (text.length) {
        props.push(`label.near: ${near}`);
      }
      shapes.set(path, {
        node: n, kind, near: text.length ? near : '', lines: text.length,
      });
    } else if (kind === 'dots') {
      text = [h > w ? '\u22ee' : '\u2026'];
      props.push('class: fmc-dots');
      shapes.set(path, { node: n, kind, lines: 1 });
    } else if (kind === 'caption') {
      text = lines(label, w * PT, FONT.label, 2);
      props.push('class: fmc-caption');
      shapes.set(path, { node: n, kind, lines: text.length });
    } else {
      const cls = { storage: 'fmc-storage', person: 'fmc-person' }[kind] || 'fmc-agent';
      const pad = kind === 'storage' ? Math.max(8, Math.min((h * PT) / 2, 16) * 0.7) : 6;
      const room = w * PT - 2 * pad;
      const note = String(attrs.note || '').trim();
      const fit = kind === 'person' || note || h * PT < 30 ? 1 : Math.max(1, Math.floor((h * PT - 6) / 14));
      text = lines(label, room, FONT.label, fit);
      labelLines = text.length;
      if (note && h * PT >= 34) {
        const more = Math.max(1, Math.floor((h * PT - 12 - text.length * 15) / 13));
        text.push(...lines(note, room, FONT.note, more));
      }
      props.push(`class: ${cls}`, `width: ${px(w)}`, `height: ${px(h)}`);
      if (truthy(attrs.multi)) {
        props.push('style.multiple: true');
      }
      shapes.set(path, {
        node: n, kind, lines: text.length, labelLines,
      });
    }
    return [`${ind(d)}${key}: ${d2String(text.join('\n'))} { ${props.join('; ')} }`];
  };
  const clusterLines = (c, d, rows) => {
    const key = keyOf(c);
    const path = [...pathOf.get(c.parent) || [], key];
    pathOf.set(c, path);
    const { attrs } = c;
    const kind = String(attrs.fmc || 'group').toLowerCase();
    const cls = kind === 'group' ? 'fmc-group' : `fmc-frame-${kind}`;
    const label = String(attrs.rowlabel || attrs.label || '').trim();
    const props = [`${ind(d + 1)}class: ${cls}`];
    if (label) {
      props.push(`${ind(d + 1)}label.near: ${attrs.rowlabel ? 'top-left' : frameNear(attrs, g.attrs)}`);
    }
    if (truthy(attrs.dashed)) {
      props.push(`${ind(d + 1)}style.stroke-dash: 4`);
    }
    if (kind === 'set' && /rounded/.test(attrs.style || '')) {
      props.push(`${ind(d + 1)}style.border-radius: ${Math.round(16 * z)}`);
    }
    const inner = [];
    const mine = c.nodes.filter((n) => drawn(n.name));
    if (rows) {
      // In a grid: the frame's parts in rows, by rank.
      const ranks = [...new Set(mine.map((n) => rankOf.get(n.name)))].sort((a, b) => a - b);
      const inRank = (r) => mine.filter((n) => rankOf.get(n.name) === r);
      const width = Math.max(1, ...ranks.map((r) => inRank(r).length));
      props.push(`${ind(d + 1)}grid-columns: ${width}`, `${ind(d + 1)}grid-gap: ${Math.round(12 * z)}`);
      for (const r of ranks) {
        const row = mine.filter((n) => rankOf.get(n.name) === r);
        for (const n of row) {
          inner.push(...nodeLines(n, d + 1));
        }
        for (let k = row.length; k < width; k += 1) {
          inner.push(`${ind(d + 1)}${keyOf({})}: "" { class: fmc-caption }`);
        }
      }
    } else {
      for (const n of mine) {
        inner.push(...nodeLines(n, d + 1));
      }
      for (const k of c.children) {
        inner.push(...clusterLines(k, d + 1, false));
      }
    }
    shapes.set(path.join('.'), {
      cluster: c, kind, label: Boolean(label), depth: c.depth,
    });
    return [`${ind(d)}${key}: ${d2String(label)} {`, ...props, ...inner, `${ind(d)}}`];
  };
  pathOf.set(g.root, []);
  if (grid) {
    // Rows of the ranks, top to bottom, each row's frames and nodes side by side.
    const items = [
      ...g.root.nodes.filter((n) => drawn(n.name)).map((n) => ({ n, r: rankOf.get(n.name) })),
      ...g.root.children.map((c) => ({
        c, r: Math.min(...c.nodes.map((n) => rankOf.get(n.name))),
      })),
    ];
    const ranks = [...new Set(items.map((x) => x.r))].sort((a, b) => a - b);
    out.push('grid-columns: 1', `grid-gap: ${g.clusters.length ? Math.round(8 * z) : 0}`);
    for (const r of ranks) {
      const row = items.filter((x) => x.r === r);
      if (row.length === 1) {
        out.push(...(row[0].n ? nodeLines(row[0].n, 0) : clusterLines(row[0].c, 0, true)));
        continue;
      }
      // A row: a frame of its own, not drawn.
      const fake = {
        nodes: [], attrs: {}, parent: g.root, children: [],
      };
      const key = keyOf(fake);
      pathOf.set(fake, [key]);
      for (const x of row) {
        if (x.n) {
          x.n.cluster = fake;
        } else {
          x.c.parent = fake;
        }
      }
      const cells = row.map((x) => (x.n ? nodeLines(x.n, 1) : clusterLines(x.c, 1, true)));
      out.push(`${key}: "" {`, '  class: fmc-hidden', '  grid-rows: 1', `  grid-gap: ${Math.round(12 * z)}`, ...cells.flat(), '}');
      shapes.set(key, { cluster: fake, kind: 'row', hidden: true });
    }
  } else {
    for (const n of g.root.nodes) {
      out.push(...nodeLines(n, 0));
    }
    for (const c of g.root.children) {
      out.push(...clusterLines(c, 0, false));
    }
  }

  // The edges, all at the top, in their order: those with style=invis only place the nodes.
  const edges = [];
  const clusterByName = new Map(g.clusters.map((c) => [c.name, c]));
  if (!grid) {
    for (const e of g.edges) {
      if (!drawn(e.tail) || !drawn(e.head) || e.tail === e.head
        || (hiddenEdge(e) && (sameRank(e.tail, e.head) || falsy(e.attrs.constraint)))) {
        continue;
      }
      const tailNode = g.nodes.get(e.tail);
      const headNode = g.nodes.get(e.head);
      const lhead = clusterByName.get(e.attrs.lhead);
      const ltail = clusterByName.get(e.attrs.ltail);
      const from = ltail ? pathOf.get(ltail).join('.') : pathOf.get(tailNode);
      const to = lhead ? pathOf.get(lhead).join('.') : pathOf.get(headNode);
      const hidden = hiddenEdge(e);
      const dir = String(e.attrs.dir || (g.directed ? 'forward' : 'none')).toLowerCase();
      const arrowB = !hidden && (dir === 'forward' || dir === 'both') && e.attrs.arrowhead !== 'none';
      const arrowA = !hidden && (dir === 'back' || dir === 'both') && e.attrs.arrowtail !== 'none';
      let op = '--';
      if (arrowA && arrowB) {
        op = '<->';
      } else if (arrowB) {
        op = '->';
      } else if (arrowA) {
        op = '<-';
      }
      const storage = (n, c) => (c ? /storage/.test(String(c.attrs.fmc || '')) || /rounded/.test(c.attrs.style || '')
        : kinds.get(n.name) === 'storage');
      const modify = arrowA && arrowB && (storage(tailNode, ltail) || storage(headNode, lhead));
      edges.push({
        tail: e.tail,
        head: e.head,
        from,
        to,
        arrowA,
        arrowB,
        hidden,
        modify,
        flow: e.attrs.flow,
        cls: e.attrs.class || '',
      });
      out.push(`${from} ${op} ${to}: { class: ${hidden ? 'fmc-hidden' : 'fmc-edge'} }`);
    }
  }
  // An enumeration's dots in a rank go where the others of the rank are: after what they come
  // from (D2's layouts put a node without edges first).
  if (!grid) {
    for (const r of g.ranks) {
      for (const name of r.nodes) {
        if (kinds.get(name) !== 'dots' || !drawn(name)) {
          continue;
        }
        const mates = new Set(r.nodes.filter((m) => m !== name));
        const from = new Set(visible.filter((e) => mates.has(e.head) && !mates.has(e.tail))
          .map((e) => e.tail));
        for (const t of from) {
          const a = pathOf.get(g.nodes.get(t));
          const b = pathOf.get(g.nodes.get(name));
          edges.push({
            from: a, to: b, hidden: true, arrowA: false, arrowB: false,
          });
          out.push(`${a} -- ${b}: { class: fmc-hidden }`);
        }
      }
    }
  }
  // Rows (`stretch=row`, a stack's layers) in their order, top to bottom: D2 has no ranks.
  if (!grid) {
    for (const c of [g.root, ...g.clusters]) {
      const list = c.children.filter((k) => String(k.attrs.stretch || '') === 'row');
      for (let k = 1; k < list.length; k += 1) {
        const [from, to] = [pathOf.get(list[k - 1]).join('.'), pathOf.get(list[k]).join('.')];
        edges.push({
          from, to, hidden: true, arrowA: false, arrowB: false,
        });
        out.push(`${from} -- ${to}: { class: fmc-hidden }`);
      }
    }
  }
  return {
    source: `${out.join('\n')}\n`, zoom: z, layout, shapes, edges, direction, trees: String(g.attrs.trees || ''), lr,
  };
}

/** D2 source for an FMC block diagram in DOT (see toD2). */
export function dotD2(dot, options = {}) {
  return toD2(parseDot(dot), options);
}

// ---------------------------------------------------------------- SVG

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const unesc = (s) => String(s).replace(/&(#\d+|lt|gt|amp|quot|#39);/g, (m, e) => ({
  lt: '<', gt: '>', amp: '&', quot: '"',
}[e] ?? String.fromCharCode(Number(e.slice(1)))));
const num = (n) => String(Math.round(n * 10) / 10);
const fromBase64 = (s) => {
  try {
    return typeof atob === 'function' ? new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))) : '';
  } catch {
    return '';
  }
};

/** The groups at the top of D2's drawing, `<g class="…">…</g>`, in their order. */
function topGroups(body) {
  const out = [];
  const re = /<(\/?)g\b[^>]*>/g;
  let depth = 0;
  let start = -1;
  let m = re.exec(body);
  while (m) {
    if (!m[1]) {
      if (depth === 0) {
        start = m.index;
      }
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(body.slice(start, m.index + m[0].length));
        start = -1;
      }
    }
    m = re.exec(body);
  }
  return out;
}

/** An element's attributes without D2's theme: its fill, stroke, classes and style. */
function plain(tag, cls) {
  let t = tag.replace(/\s(fill|stroke|class|style|mask|stroke-width|marker-start|marker-end)="[^"]*"/g, '');
  const style = /style="([^"]*)"/.exec(tag)?.[1] || '';
  const anchor = /text-anchor:\s*(\w+)/.exec(style)?.[1];
  const size = /font-size:\s*([\d.]+)px/.exec(style)?.[1];
  const extra = `${cls ? ` class="${cls}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''}${size ? ` font-size="${size}"` : ''}`;
  t = t.replace(/\s*\/?>$/, (end) => `${extra}${end.includes('/') ? '/>' : '>'}`);
  return t;
}

/** A `<text>` element with its opening tag (and its tspans) without D2's theme. */
function openTag(el, cls) {
  return el.replace(/^<text\b[^>]*>/, (o) => plain(o, cls)).replace(/<tspan\b[^>]*>/g, (o) => plain(o, ''));
}

/** An SVG path through orthogonal `pts`, its corners rounded by `r`. */
export function rounded(pts, r) {
  if (pts.length < 2) {
    return '';
  }
  let d = `M${num(pts[0][0])},${num(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
    const k = Math.min(r, l1 / 2, l2 / 2);
    const p = [b[0] - ((b[0] - a[0]) / l1) * k, b[1] - ((b[1] - a[1]) / l1) * k];
    const q = [b[0] + ((c[0] - b[0]) / l2) * k, b[1] + ((c[1] - b[1]) / l2) * k];
    d += ` L${num(p[0])},${num(p[1])} Q${num(b[0])},${num(b[1])} ${num(q[0])},${num(q[1])}`;
  }
  const e = pts[pts.length - 1];
  return `${d} L${num(e[0])},${num(e[1])}`;
}

/** Points without repeats and without the middle ones of a straight run. */
function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 0.01 || Math.abs(q[1] - p[1]) > 0.01) {
      out.push(p);
    }
  }
  for (let i = out.length - 2; i >= 1; i -= 1) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
    if ((Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - c[0]) < 0.01)
      || (Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - c[1]) < 0.01)) {
      out.splice(i, 1);
    }
  }
  return out;
}

/** Orthogonal `pts` moved `by` to their left (in their direction), corners kept square. */
function offset(pts, by) {
  const normal = (a, b) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[1] - a[1]) / l, -(b[0] - a[0]) / l];
  };
  return pts.map((p, i) => {
    const n1 = i > 0 ? normal(pts[i - 1], p) : null;
    const n2 = i < pts.length - 1 ? normal(p, pts[i + 1]) : null;
    const [nx, ny] = n1 && n2 ? [n1[0] + n2[0], n1[1] + n2[1]] : n1 || n2;
    return [p[0] + nx * by, p[1] + ny * by];
  });
}

/** An arrowhead whose tip is `b`, coming from `a`, `size` long. */
function arrowHead(a, b, size) {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const [dx, dy] = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  const w = size / 2;
  const base = [b[0] - dx * size, b[1] - dy * size];
  return `M${num(b[0])},${num(b[1])} L${num(base[0] - dy * w)},${num(base[1] + dx * w)} L${num(base[0] + dy * w)},${num(base[1] - dx * w)} Z`;
}

/** Which side of `box` the point `p` is on. */
function sideOf(box, [x, y]) {
  const d = {
    top: Math.abs(y - box.y0),
    bottom: Math.abs(y - box.y1),
    left: Math.abs(x - box.x0),
    right: Math.abs(x - box.x1),
  };
  return Object.keys(d).reduce((a, b) => (d[b] < d[a] ? b : a));
}

/**
 * Edge trees: the edges that leave `node`'s side the same way, `members` (`{ pts }`, each from
 * that node out), from one port in the middle of the side, along one trunk to the nearest of
 * their bends, and from there each its own way. Returns the port.
 */
function joinTree(box, side, members, min) {
  const vertical = side === 'top' || side === 'bottom';
  const out = side === 'bottom' || side === 'right' ? 1 : -1;
  const [first] = members[0].pts;
  const port = vertical ? [(box.x0 + box.x1) / 2, first[1]] : [first[0], (box.y0 + box.y1) / 2];
  const a = vertical ? 1 : 0;
  // The track: the first bend nearest the side, but no nearer than `min`.
  let track = Infinity;
  for (const m of members) {
    track = Math.min(track, out * (m.pts[1][a] - port[a]));
  }
  track = port[a] + out * Math.max(min, track);
  for (const m of members) {
    const [, second, ...rest] = m.pts;
    const join = vertical ? [m.pts[0][0], track] : [track, m.pts[0][1]];
    const trunk = vertical ? [port[0], track] : [track, port[1]];
    // eslint-disable-next-line no-param-reassign -- the member's points, joined to the tree
    m.pts = simplify(out * (second[a] - track) >= 0
      ? [port, trunk, join, second, ...rest]
      : [port, trunk, [vertical ? second[0] : track, vertical ? track : second[1]], ...rest]);
  }
  return port;
}

const PERSON = (cx, cy, s) => {
  const head = s * 0.14;
  return `<circle class="fmc-figure" cx="${num(cx)}" cy="${num(cy - s / 2 + head)}" r="${num(head)}"/>`
    + `<path class="fmc-figure" d="M${num(cx)},${num(cy - s / 2 + 2 * head)} V${num(cy + s * 0.12)} M${num(cx - s * 0.25)},${num(cy - s * 0.12)} H${num(cx + s * 0.25)} M${num(cx - s * 0.22)},${num(cy + s / 2)} L${num(cx)},${num(cy + s * 0.12)} L${num(cx + s * 0.22)},${num(cy + s / 2)}"/>`;
};

/**
 * A request channel's R, and the arrow beside it that points the way requests go: away from the
 * part that asks (`request=true`: the edge's tail; `back`: its head). Beside the circle, on the
 * side its label is not.
 */
function requestMark(id, s, b, conns, z, request) {
  const back = String(request).toLowerCase() === 'back';
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const r = (b.x1 - b.x0) / 2;
  // The way the request goes on from the channel: along the edge the channel is the tail of
  // (back: the head of), from the channel out; else back along the other.
  let dir = null;
  let other = [0, 1];
  for (const x of conns) {
    const out = x.c.src === id;
    if (!out && x.c.dst !== id) {
      continue;
    }
    const mine = out ? x.pts : [...x.pts].reverse();
    const d = [mine[1][0] - mine[0][0], mine[1][1] - mine[0][1]];
    if (out !== back) {
      dir = dir || d;
    } else {
      other = [-d[0], -d[1]];
    }
  }
  dir = dir || other;
  const vertical = Math.abs(dir[1]) >= Math.abs(dir[0]);
  const sz = 3.2 * z;
  const font = Math.round(9 * z);
  let x;
  let y;
  if (vertical) {
    const left = /right/.test(s.near || '');
    x = left ? cx - r - 3 * z - 17 * z : cx + r + 3 * z;
    y = cy + 4 * z;
  } else {
    x = cx + r + 1 * z;
    y = cy + r + 10 * z;
  }
  const tx = x + 11 * z;
  const ty = y - 3.5 * z;
  let tri;
  if (vertical) {
    const k = dir[1] >= 0 ? 1 : -1;
    tri = `M${num(tx - sz)},${num(ty - k * sz)} L${num(tx + sz)},${num(ty - k * sz)} L${num(tx)},${num(ty + k * sz)} Z`;
  } else {
    const k = dir[0] >= 0 ? 1 : -1;
    tri = `M${num(tx - k * sz)},${num(ty - sz)} L${num(tx - k * sz)},${num(ty + sz)} L${num(tx + k * sz)},${num(ty)} Z`;
  }
  return `<g class="fmc-r"><text class="fmc-d2-rlabel" x="${num(x)}" y="${num(y)}" font-size="${font}">R</text><path class="fmc-rarrow" d="${tri}"/></g>`;
}

/**
 * D2's SVG of `d2` (toD2's output), drawn from `diagram` (D2's compiled diagram, for where it put
 * things), as an FMC block diagram: `{ svg, width, height }`. See the top of this file for what
 * it changes. `title` names it for assistive technology.
 */
export function finishSvg(raw, diagram, d2, { title = '', pad = 6, className = '' } = {}) {
  const z = d2.zoom;
  const inner = /<svg class="d2-\d+ d2-svg"[^>]*viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"[^>]*>([\s\S]*)<\/svg>\s*<\/svg>\s*$/.exec(raw);
  if (!inner) {
    throw new Error('not an SVG of D2');
  }
  const [vx, vy, vw, vh] = inner.slice(1, 5).map(Number);
  const body = inner[5].replace(/<style[\s\S]*?<\/style>/g, '').replace(/<mask[\s\S]*?<\/mask>/g, '')
    .replace(/<rect[^>]*class=" fill-N7"[^>]*\/>/, '');
  const box = new Map(diagram.shapes.map((s) => [s.id, {
    x0: s.pos.x, y0: s.pos.y, x1: s.pos.x + s.width, y1: s.pos.y + s.height, shape: s,
  }]));
  const bounds = {
    x0: vx, y0: vy, x1: vx + vw, y1: vy + vh,
  };
  const grow = (x, y) => {
    bounds.x0 = Math.min(bounds.x0, x);
    bounds.x1 = Math.max(bounds.x1, x);
    bounds.y0 = Math.min(bounds.y0, y);
    bounds.y1 = Math.max(bounds.y1, y);
  };

  // Rows of a layer, as wide as each other (src/fmc.js `stretch=row`), when they are stacked.
  const rows = new Map();
  for (const [id, s] of d2.shapes) {
    if (s.cluster && String(s.cluster.attrs?.stretch || '') === 'row' && box.has(id)) {
      const up = id.split('.').slice(0, -1).join('.');
      if (!rows.has(up)) {
        rows.set(up, []);
      }
      rows.get(up).push(box.get(id));
    }
  }
  const shift = new Map();
  for (const list of rows.values()) {
    const stacked = list.every((a) => list.every((b) => a === b || a.y1 <= b.y0 || b.y1 <= a.y0));
    if (!stacked || d2.lr) {
      continue;
    }
    const lo = Math.min(...list.map((b) => b.x0));
    const hi = Math.max(...list.map((b) => b.x1));
    for (const b of list) {
      shift.set(b, b.x0 - lo);
      b.x0 = lo;
      b.x1 = hi;
    }
  }

  // The edges' points, from D2's routes; trees joined, then each drawn.
  const conns = diagram.connections.map((c, i) => ({
    c, e: d2.edges[i], pts: (c.route || []).map((p) => [p.x, p.y]),
  })).filter((x) => x.e && !x.e.hidden && x.pts.length >= 2);
  const kindOfId = (id) => d2.shapes.get(id)?.kind;
  const groups = new Map();
  const all = d2.trees === 'all';
  for (const x of conns) {
    if (x.e.modify || !/^(elk|tala)$/.test(d2.layout)) {
      continue;
    }
    const ends = [[x.c.src, x.c.dst, x.e.arrowA], [x.c.dst, x.c.src, x.e.arrowB]];
    for (const [end, other, arrow] of ends) {
      const b = box.get(end);
      const k = kindOfId(end);
      if (!b || k === 'channel' || (!all && kindOfId(other) === 'channel')) {
        continue;
      }
      const at = end === x.c.src ? x.pts[0] : x.pts[x.pts.length - 1];
      const key = `${end}\u0000${sideOf(b, at)}\u0000${arrow ? 1 : 0}`;
      if (!groups.has(key)) {
        groups.set(key, {
          end, side: sideOf(b, at), arrow, members: [],
        });
      }
      groups.get(key).members.push(x);
    }
  }
  const arrows = new Map();
  const addArrow = (a, b, flow) => {
    const k = b.map((v) => Math.round(v)).join(',');
    if (!arrows.has(k)) {
      arrows.set(k, { d: arrowHead(a, b, 7 * z), flows: new Set() });
    }
    if (flow != null) {
      arrows.get(k).flows.add(String(flow));
    }
  };
  const done = new Set();
  for (const gr of groups.values()) {
    if (gr.members.length < 2) {
      continue;
    }
    const b = box.get(gr.end);
    const views = gr.members.map((x) => ({ x, fromSrc: x.c.src === gr.end }));
    const members = views.map((v) => ({ pts: v.fromSrc ? v.x.pts : [...v.x.pts].reverse() }));
    const port = joinTree(b, gr.side, members, 10 * z);
    members.forEach((m, i) => {
      const v = views[i];
      v.x.pts = v.fromSrc ? m.pts : [...m.pts].reverse();
      done.add(`${v.x.c.id}\u0000${v.fromSrc ? 'a' : 'b'}`);
    });
    if (gr.arrow) {
      const m = members[0].pts;
      for (const v of views) {
        addArrow(m[1], port, v.x.e.flow);
      }
    }
  }
  const edges = [];
  for (const x of conns) {
    const { e } = x;
    const flow = e.flow != null ? ` data-flow="${esc(e.flow)}"` : '';
    const cls = `fmc-edge${e.cls ? ` ${esc(e.cls)}` : ''}`;
    const { pts } = x;
    if (e.modify) {
      // Modify access: two arcs, one each way, bowed apart.
      const [p, q] = [pts[0], pts[pts.length - 1]];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const [nx, ny] = [-(q[1] - p[1]) / l, (q[0] - p[0]) / l];
      const o = 4 * z;
      const bow = Math.min(14 * z, l / 3);
      const arc = (s, from, to) => {
        const a = [from[0] + s * nx * o, from[1] + s * ny * o];
        const b = [to[0] + s * nx * o, to[1] + s * ny * o];
        const c = [(a[0] + b[0]) / 2 + s * nx * bow, (a[1] + b[1]) / 2 + s * ny * bow];
        edges.push(`<path class="${cls}"${flow} d="M${num(a[0])},${num(a[1])} Q${num(c[0])},${num(c[1])} ${num(b[0])},${num(b[1])}"/>`);
        addArrow(c, b, e.flow);
      };
      if (pts.length === 2) {
        arc(1, p, q);
        arc(1, q, p);
      } else {
        // Along a bent route: two lines beside each other, one each way.
        for (const sgn of [1, -1]) {
          const line = offset(pts, sgn * 2.5 * z);
          const way = sgn > 0 ? line : [...line].reverse();
          edges.push(`<path class="${cls}"${flow} d="${rounded(way, 6 * z)}"/>`);
          addArrow(way[way.length - 2], way[way.length - 1], e.flow);
        }
      }
      continue;
    }
    edges.push(`<path class="${cls}"${flow} d="${rounded(pts, 6 * z)}"/>`);
    if (e.arrowB && !done.has(`${x.c.id}\u0000b`)) {
      addArrow(pts[pts.length - 2], pts[pts.length - 1], e.flow);
    }
    if (e.arrowA && !done.has(`${x.c.id}\u0000a`)) {
      addArrow(pts[1], pts[0], e.flow);
    }
  }

  // The shapes, as D2 drew them, in the page's classes.
  const frames = [];
  const nodes = [];
  for (const grp of topGroups(body)) {
    const head = /^<g class="([^"]*)"/.exec(grp);
    const token = head ? head[1].split(' ')[0] : '';
    const id = unesc(fromBase64(token));
    const s = d2.shapes.get(id);
    const b = box.get(id);
    if (!s || !b || s.hidden) {
      continue;
    }
    const at = b.shape;
    const inside = grp.replace(/^<g[^>]*>/, '').replace(/<\/g>$/, '');
    const texts = [...inside.matchAll(/<text\b[^>]*>[\s\S]*?<\/text>/g)].map((m) => m[0]);
    const drawnShapes = [...inside.matchAll(/<(rect|ellipse|path|polygon|circle)\b[^>]*\/>/g)].map((m) => m[0]);
    if (s.cluster) {
      const { attrs } = s.cluster;
      const dx = shift.get(b) || 0;
      const cls = `fmc-frame fmc-frame-${s.kind} fmc-depth-${Math.min(s.depth, 3)}${truthy(attrs.dashed) ? ' fmc-dashed' : ''}${attrs.class ? ` ${esc(attrs.class)}` : ''}`;
      const data = attrs.layer != null ? ` data-layer="${esc(attrs.layer)}"` : '';
      const rx = at.borderRadius || 0;
      let shape = `<rect class="fmc-shape" x="${num(b.x0)}" y="${num(b.y0)}" width="${num(b.x1 - b.x0)}" height="${num(b.y1 - b.y0)}" rx="${num(rx)}"/>`;
      if (s.kind === 'set') {
        const g3 = 3 * z;
        shape += `<rect class="fmc-inner" x="${num(b.x0 + g3)}" y="${num(b.y0 + g3)}" width="${num(b.x1 - b.x0 - 2 * g3)}" height="${num(b.y1 - b.y0 - 2 * g3)}" rx="${num(Math.max(0, rx - g3))}"/>`;
      }
      if (s.kind === 'ushape') {
        // An agent around the others, open at the top down to below them.
        const kids = [...box.entries()].filter(([k]) => k.startsWith(`${id}.`)).map(([, v]) => v);
        const m = 12 * z;
        const l = Math.max(b.x0 + m, Math.min(...kids.map((k) => k.x0)) - m);
        const r = Math.min(b.x1 - m, Math.max(...kids.map((k) => k.x1)) + m);
        const bot = Math.min(b.y1 - m, Math.max(...kids.map((k) => k.y1)) + m);
        shape = `<path class="fmc-shape" d="M${num(b.x0)},${num(b.y0)} H${num(l)} V${num(bot)} H${num(r)} V${num(b.y0)} H${num(b.x1)} V${num(b.y1)} H${num(b.x0)} Z"/>`;
      }
      const label = texts.map((t) => openTag(t.replace(/<text\b[^>]*>/, (o) => o.replace(/\bx="([-\d.]+)"/, (m2, v) => `x="${num(Number(v) - dx)}"`)), 'fmc-d2-flabel')).join('');
      frames.push(`<g class="${cls}"${data}>${shape}${label}</g>`);
      continue;
    }
    const n = s.node;
    const { attrs } = n;
    const data = `${attrs.part != null ? ` data-part="${esc(attrs.part)}" tabindex="0"` : ''}${attrs.flow != null ? ` data-flow="${esc(attrs.flow)}"` : ''}${attrs.seen ? ' data-seen="1"' : ''}`;
    const tip = attrs.tooltip ? `<title>${esc(attrs.tooltip)}</title>` : '';
    const cls = `fmc-node fmc-${s.kind}${attrs.class ? ` ${esc(attrs.class)}` : ''}`;
    let out = '';
    if (s.kind === 'dots') {
      out = texts.map((t) => openTag(t, 'fmc-d2-dots')).join('');
    } else {
      const multi = drawnShapes.length > 1;
      out = drawnShapes.map((t, k) => plain(t, `fmc-shape${multi && k < drawnShapes.length - 1 ? ' fmc-behind' : ''}`)).join('');
      for (const t of texts) {
        let tcls = 'fmc-d2-label';
        if (s.kind === 'channel') {
          tcls = 'fmc-d2-clabel';
        } else if (s.kind === 'caption') {
          tcls = 'fmc-d2-flabel';
        }
        let text = openTag(t, tcls);
        if (s.labelLines && s.lines > s.labelLines) {
          // The note: the lines after the label's, smaller, muted.
          let k = 0;
          const small = Math.round(FONT.note * z);
          text = text.replace(/<tspan\b([^>]*)>/g, (m, a) => {
            k += 1;
            return k > s.labelLines ? `<tspan${a} class="fmc-d2-note" font-size="${small}">` : m;
          });
        }
        out += text;
      }
      if (s.kind === 'person') {
        const label = s.lines ? FONT.label * 1.4 * z : 0;
        const fig = Math.min(at.height - 10 * z - label, 30 * z);
        const free = label ? 0 : (at.height - 10 * z - fig) / 2;
        out += PERSON(b.x0 + at.width / 2, b.y0 + 5 * z + fig / 2 + free, fig);
      }
    }
    if (s.kind === 'channel' && attrs.request && !falsy(attrs.request)) {
      out += requestMark(id, s, b, conns, z, attrs.request);
      grow(b.x0 - 22 * z, b.y1 + 12 * z);
      grow(b.x1 + 22 * z, b.y1 + 12 * z);
    }
    nodes.push(`<g class="${cls}"${data}>${tip}${out}</g>`);
  }
  for (const b of box.values()) {
    grow(b.x0, b.y0);
    grow(b.x1, b.y1);
  }
  const X0 = bounds.x0 - pad * z;
  const Y0 = bounds.y0 - pad * z;
  const W = bounds.x1 - bounds.x0 + 2 * pad * z;
  const H = bounds.y1 - bounds.y0 + 2 * pad * z;
  const arrowSvg = [...arrows.values()].map((a) => `<path class="fmc-arrow"${a.flows.size ? ` data-flows="${[...a.flows].join(' ')}"` : ''} d="${a.d}"/>`).join('');
  const width = W / z;
  const height = H / z;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="fmc fmc-d2${className ? ` ${esc(className)}` : ''}" viewBox="${num(X0)} ${num(Y0)} ${num(W)} ${num(H)}" width="${num(width)}" height="${num(height)}" role="img"${title ? ` aria-label="${esc(title)}"` : ''}>`
    + `${title ? `<title>${esc(title)}</title>` : ''}<g class="fmc-frames">${frames.join('')}</g><g class="fmc-edges">${edges.join('')}</g>`
    + `<g class="fmc-arrows">${arrowSvg}</g><g class="fmc-nodes">${nodes.join('')}</g></svg>`;
  return { svg, width, height };
}
