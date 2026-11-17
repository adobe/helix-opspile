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
 * FMC block diagrams (https://www.fmc-modeling.org/notation_reference) from Graphviz DOT, drawn
 * after the FMC visualization guidelines (https://www.fmc-modeling.org/visualization_guidelines).
 *
 * A diagram is DOT, so it can be written by hand: Graphviz's `dot` places the nodes (ranks,
 * crossing minimization, clusters, alignment), and this module draws them, because Graphviz
 * draws neither the notation nor the edges the guidelines ask for. What it does itself:
 *
 *  - Edges are orthogonal with rounded corners. Each runs from a port on its node's side through
 *    the corridors between the ranks, on a track of its own, and through a rank where `dot` put
 *    its virtual node. The tracks of a corridor are ordered to cross as few vertical segments as
 *    they can, and spread evenly over it, so edges keep the same distance to each other and to
 *    the nodes. A corridor too narrow for its tracks, or narrower than the least all get, gets
 *    the room it lacks between its frames (`stretchGraph`), the others staying as they are.
 *  - The edges that leave or enter a node's side in the same way (an arrow at the node or not)
 *    share a port and a track: an edge tree, with one arrowhead. An edge to a channel keeps a
 *    port of its own, as FMC draws them (`trees=all` on the graph joins those too). A single
 *    edge whose other end is in front of the side leaves straight towards it.
 *  - Nodes are drawn by their FMC kind, `fmc` on the node: `agent` (a rectangle, the default),
 *    `storage` (rounded), `channel` (a small circle; `request=true` adds the R and its arrow),
 *    `person` (a human agent), `dots` (enumeration, "…"); `multi=true` draws a node as one of
 *    many. Node lines are twice as thick as edge lines.
 *  - Clusters are grouping frames, `fmc` on the subgraph: `group` (a grey area, the default;
 *    nested ones a shade darker), `agent` or `storage` (a structured node, drawn as thick as
 *    one), `set` (unrelated nodes, thin) and `ushape` (an agent around the others, open at the
 *    top; its inner walls go through the invisible `wall` nodes in it).
 *  - Labels are horizontal, in one font; `code` in backticks is monospace. Nodes keep the size
 *    the DOT gives them (`fixedsize`): their size says how important they are, and a label too
 *    long for its node is wrapped, then cut, never the node made larger.
 *
 * `part` on a node and `flow` on an edge become `data-part` and `data-flow`, `tooltip` a title.
 * Colors are classes (`fmc-…`), which the page's stylesheet gives Spectrum 2 colors.
 *
 * Edges with `style=invis` only place the nodes. Edge labels are not drawn (in `dot` they would
 * also take a rank of their own): what passes over a connection is the label of its channel.
 */

/* eslint-disable no-continue -- the loops skip what they do not draw or route */
/* eslint-disable no-underscore-dangle -- Graphviz's own names (`_gvid`) */

const PT = 72;
/** Space between tracks, and between a track and a node, at the least. */
const TRACK = 9;
/** The least room in a corridor that edges pass, for every one alike. */
const MIN_FREE = 24;
/** The radius of an edge's corners. */
const CORNER = 6;
/** A virtual node this close to the column before or after it is moved onto that column. */
const SNAP = 28;
const CHANNEL_R = 5.5;
/** The widest a row's label is, at its left. */
const ROW_LABEL = 110;
const ARROW = 7;
const ARROW_W = 3.5;
/** Font sizes of labels and notes, as ui/spectrum-inbox.css sets them (for wrapping). */
export const FONT = { label: 12, note: 11, small: 11 };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const num = (n) => String(Math.round(n * 10) / 10);
/** The screen box `[x0, x1, y0, y1]` of two corners. */
const box = ([xa, ya], [xb, yb]) => [
  Math.min(xa, xb), Math.max(xa, xb), Math.min(ya, yb), Math.max(ya, yb),
];
const truthy = (v) => v === true || /^(true|yes|1)$/i.test(String(v ?? ''));

/** About how wide `s` is, in px, at `size` (sans serif, or monospace with `mono`). */
export function textWidth(s, size = FONT.label, mono = false) {
  let w = 0;
  for (const c of String(s)) {
    if (mono) {
      w += 0.6;
    } else if (/[ilj.,:;'|!()[\]{}]/.test(c)) {
      w += 0.28;
    } else if (/[mwMW@]/.test(c)) {
      w += 0.86;
    } else if (/[A-Z0-9#%&]/.test(c)) {
      w += 0.64;
    } else if (c === ' ') {
      w += 0.28;
    } else {
      w += 0.53;
    }
  }
  return w * size;
}

/** Runs of a label: `[{ text, code }]`, code in backticks. */
function runs(s) {
  return String(s).split(/(`[^`]*`)/).filter(Boolean)
    .map((t) => (/^`[^`]*`$/.test(t) ? { text: t.slice(1, -1), code: true } : { text: t, code: false }));
}
const runsWidth = (rs, size) => rs.reduce((w, r) => w + textWidth(r.text, size, r.code), 0);

/**
 * `text` in lines of at most `width` px at `size`, at most `max` of them, the last cut with an
 * ellipsis when it does not fit; each line its runs.
 */
export function wrap(text, width, size = FONT.label, max = 2) {
  const out = [];
  for (const para of String(text ?? '').split(/\\n|\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (!line || runsWidth(runs(next), size) <= width) {
        line = next;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  const lines = out.length > max ? [...out.slice(0, max - 1), out.slice(max - 1).join(' ')] : out;
  return lines.map((l, i) => {
    let s = l;
    const cut = i === lines.length - 1 && lines.length < out.length;
    if (cut || runsWidth(runs(s), size) > width) {
      while (s.length > 1 && runsWidth(runs(`${s}…`), size) > width) {
        s = s.slice(0, -1);
      }
      s = `${s.replace(/\s+$/, '')}…`;
      // A backtick cut off ends its code there.
      if ((s.match(/`/g) || []).length % 2) {
        s = `${s.slice(0, -1)}\`…`;
      }
    }
    return runs(s);
  });
}

/** Bezier points of a Graphviz edge `pos` ("e,x,y s,x,y x,y …"), in Graphviz coordinates. */
function splinePoints(pos) {
  const first = String(pos || '').split(';')[0];
  return first.trim().split(/\s+/).filter((t) => t && !/^[se],/.test(t))
    .map((t) => t.split(',').map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite));
}

/** Points along the cubic Bezier segments of `pts`. */
function sample(pts) {
  const out = [];
  for (let i = 0; i + 3 < pts.length; i += 3) {
    const [p0, p1, p2, p3] = pts.slice(i, i + 4);
    for (let k = 0; k <= 12; k += 1) {
      const t = k / 12;
      const s = 1 - t;
      out.push([
        s * s * s * p0[0] + 3 * s * s * t * p1[0] + 3 * s * t * t * p2[0] + t * t * t * p3[0],
        s * s * s * p0[1] + 3 * s * s * t * p1[1] + 3 * s * t * t * p2[1] + t * t * t * p3[1],
      ]);
    }
  }
  return out.length ? out : pts;
}

/**
 * The diagram of Graphviz's JSON output (`viz.renderJSON`), in "rank space": `v` along the
 * ranks (down in TB, right in LR) and `u` across them. `toXY` takes a point back.
 */
export function readGraph(json) {
  const lr = /^(LR|RL)$/i.test(json.rankdir || '');
  const [, , W, H] = String(json.bb || '0,0,0,0').split(',').map(Number);
  const xy = (x, y) => [x, H - y];
  const uv = ([x, y]) => (lr ? [y, x] : [x, y]);
  const toXY = (u, v) => (lr ? [v, u] : [u, v]);
  const objects = json.objects || [];
  const nodes = [];
  const byGvid = new Map();
  for (const o of objects) {
    if (!o.pos || o.bb) {
      continue;
    }
    const [x, y] = o.pos.split(',').map(Number);
    const [X, Y] = xy(x, y);
    const w = Number(o.width) * PT;
    const h = Number(o.height) * PT;
    const [cu, cv] = uv([X, Y]);
    const [du, dv] = lr ? [h, w] : [w, h];
    const n = {
      id: o._gvid,
      name: o.name,
      attrs: o,
      kind: String(o.fmc || (o.style === 'invis' ? 'invis' : 'agent')).toLowerCase(),
      x: X,
      y: Y,
      w,
      h,
      u: cu,
      v: cv,
      u0: cu - du / 2,
      u1: cu + du / 2,
      v0: cv - dv / 2,
      v1: cv + dv / 2,
    };
    if (n.kind === 'agent' && /rounded/.test(o.style || '')) {
      n.kind = 'storage';
    }
    if (n.kind === 'agent' && /^(circle|point|doublecircle)$/.test(o.shape || '')) {
      n.kind = 'channel';
    }
    nodes.push(n);
    byGvid.set(o._gvid, n);
  }
  // Ranks: the nodes whose centers are on the same line across.
  const centers = [...new Set(nodes.map((n) => Math.round(n.v)))].sort((a, b) => a - b);
  const rankOf = new Map();
  let r = -1;
  let last = -Infinity;
  for (const c of centers) {
    if (c - last > 1.5) {
      r += 1;
    }
    rankOf.set(c, r);
    last = c;
  }
  const ranks = Array.from({ length: r + 1 }, () => ({
    nodes: [], v0: Infinity, v1: -Infinity, v: 0,
  }));
  for (const n of nodes) {
    n.rank = rankOf.get(Math.round(n.v));
    const k = ranks[n.rank];
    k.nodes.push(n);
    k.v = n.v;
    if (!['invis', 'wall', 'caption'].includes(n.kind)) {
      k.v0 = Math.min(k.v0, n.v0);
      k.v1 = Math.max(k.v1, n.v1);
    }
  }
  for (const k of ranks) {
    if (!Number.isFinite(k.v0)) {
      k.v0 = k.v;
      k.v1 = k.v;
    }
    k.nodes.sort((a, b) => a.u - b.u);
  }
  // Clusters, with their depth and the ranks they span.
  const clusters = [];
  const parent = new Map();
  for (const o of objects) {
    for (const child of o.subgraphs || []) {
      parent.set(child, o);
    }
  }
  for (const o of objects) {
    if (!o.bb || !/^cluster/.test(o.name || '')) {
      continue;
    }
    const [llx, lly, urx, ury] = o.bb.split(',').map(Number);
    const [X0, Y0] = xy(llx, ury);
    const [X1, Y1] = xy(urx, lly);
    const [ua, va] = uv([X0, Y0]);
    const [ub, vb] = uv([X1, Y1]);
    let depth = 0;
    for (let p = parent.get(o._gvid); p; p = parent.get(p._gvid)) {
      if (/^cluster/.test(p.name || '')) {
        depth += 1;
      }
    }
    const members = (o.nodes || []).map((g) => byGvid.get(g)).filter(Boolean);
    const lp = o.lp ? o.lp.split(',').map(Number) : null;
    clusters.push({
      id: o._gvid,
      name: o.name,
      attrs: o,
      kind: String(o.fmc || 'group').toLowerCase(),
      depth,
      x0: X0,
      y0: Y0,
      x1: X1,
      y1: Y1,
      u0: Math.min(ua, ub),
      u1: Math.max(ua, ub),
      v0: Math.min(va, vb),
      v1: Math.max(va, vb),
      label: o.label && o.label !== '\\N' ? String(o.label) : '',
      lp: lp ? xy(lp[0], lp[1]) : null,
      members,
      rmin: Math.min(...members.map((n) => n.rank)),
      rmax: Math.max(...members.map((n) => n.rank)),
    });
  }
  clusters.sort((a, b) => a.depth - b.depth);
  // Rows (`stretch=row`): the frames of a parent, as wide as the widest, the outer ones of a
  // rank widened to the others' edges, so the rows line up.
  const rows = new Map();
  for (const c of clusters) {
    if (String(c.attrs.stretch || '') !== 'row') {
      continue;
    }
    const k = parent.get(c.id)?._gvid ?? 'root';
    if (!rows.has(k)) {
      rows.set(k, []);
    }
    rows.get(k).push(c);
  }
  for (const list of rows.values()) {
    // A row's label is at its left, in a column of its own that no edge crosses.
    const labels = list.map((c) => String(c.attrs.rowlabel || '').trim()).filter(Boolean);
    const room = labels.length && !lr
      ? Math.min(ROW_LABEL, Math.max(...labels.map((t) => textWidth(t, FONT.label)))) + 14 : 0;
    for (const c of list) {
      c.rowlabel = room ? String(c.attrs.rowlabel || '').trim() : '';
      c.room = room;
    }
    const lo = Math.min(...list.map((c) => c.u0)) - room;
    const hi = Math.max(...list.map((c) => c.u1));
    for (const c of list) {
      const beside = list.filter((o) => o.v0 < c.v1 && c.v0 < o.v1);
      if (beside.every((o) => o.u0 >= c.u0)) {
        c.u0 = lo;
      }
      if (beside.every((o) => o.u1 <= c.u1)) {
        c.u1 = hi;
      }
      [c.x0, c.y0] = toXY(c.u0, c.v0);
      [c.x1, c.y1] = toXY(c.u1, c.v1);
      if (c.x0 > c.x1) {
        [c.x0, c.x1] = [c.x1, c.x0];
      }
      if (c.y0 > c.y1) {
        [c.y0, c.y1] = [c.y1, c.y0];
      }
    }
  }
  // A frame around wider ones grows with them.
  const byId = new Map(clusters.map((c) => [c.id, c]));
  for (const c of [...clusters].sort((a, b) => b.depth - a.depth)) {
    const up = byId.get(parent.get(c.id)?._gvid);
    if (!up) {
      continue;
    }
    const m = 8;
    up.u0 = Math.min(up.u0, c.u0 - m);
    up.u1 = Math.max(up.u1, c.u1 + m);
    up.v0 = Math.min(up.v0, c.v0 - m);
    up.v1 = Math.max(up.v1, c.v1 + m);
    const corners = [toXY(up.u0, up.v0), toXY(up.u1, up.v1)];
    const [x0] = box(...corners);
    const shift = up.lp && x0 < up.x0 && up.attrs.labeljust === 'l';
    [up.x0, up.x1, up.y0, up.y1] = box(...corners);
    if (shift) {
      up.lp = [up.x0, up.lp[1]];
    }
  }
  const directed = json.directed !== false;
  const edges = [];
  for (const e of json.edges || []) {
    const tail = byGvid.get(e.tail);
    const head = byGvid.get(e.head);
    if (!tail || !head || tail === head || /invis/.test(e.style || '')) {
      continue;
    }
    const dir = String(e.dir || (directed ? 'forward' : 'none')).toLowerCase();
    edges.push({
      id: e._gvid,
      attrs: e,
      tail,
      head,
      arrowHead: (dir === 'forward' || dir === 'both') && e.arrowhead !== 'none',
      arrowTail: (dir === 'back' || dir === 'both') && e.arrowtail !== 'none',
      points: sample(splinePoints(e.pos).map(([x, y]) => uv(xy(x, y)))),
      lhead: e.lhead || null,
      ltail: e.ltail || null,
    });
  }
  return {
    lr, width: W, height: H, nodes, ranks, clusters, edges, toXY, trees: String(json.trees || ''),
  };
}

/** Where a node's edges attach: its box, or a channel's circle. */
function attach(n) {
  if (n.kind === 'channel') {
    return {
      u0: n.u - CHANNEL_R,
      u1: n.u + CHANNEL_R,
      v0: n.v - CHANNEL_R,
      v1: n.v + CHANNEL_R,
      fixed: true,
    };
  }
  if (n.kind === 'wall' || n.kind === 'invis') {
    return {
      u0: n.u, u1: n.u, v0: n.v, v1: n.v, fixed: true,
    };
  }
  return {
    u0: n.u0, u1: n.u1, v0: n.v0, v1: n.v1, fixed: false,
  };
}

/** The u where the polyline `pts` crosses `v`, or null. */
function crossAt(pts, v) {
  for (let i = 1; i < pts.length; i += 1) {
    const [ua, va] = pts[i - 1];
    const [ub, vb] = pts[i];
    if ((va - v) * (vb - v) <= 0 && va !== vb) {
      return ua + ((v - va) / (vb - va)) * (ub - ua);
    }
  }
  return null;
}

/**
 * The corridor between rank `g` and `g + 1` (-1 above the first, the last below the last): the
 * free stretch of v in it, past the nodes and the frames that end or start there.
 */
function corridor(graph, g) {
  const { ranks, clusters } = graph;
  const above = ranks[g];
  const below = ranks[g + 1];
  let top = above ? above.v1 : (below.v0 - 4 * TRACK);
  let bottom = below ? below.v0 : (above.v1 + 4 * TRACK);
  for (const c of clusters) {
    if (above && c.rmax === g && c.v1 < bottom) {
      top = Math.max(top, c.v1);
    }
    if (below && c.rmin === g + 1 && c.v0 > top) {
      bottom = Math.min(bottom, c.v0);
    }
  }
  if (!above) {
    bottom = Math.min(bottom, ...clusters.filter((c) => c.rmin === 0).map((c) => c.v0));
  }
  if (!below) {
    top = Math.max(top, ...clusters.filter((c) => c.rmax === g).map((c) => c.v1));
  }
  if (!above) {
    top = bottom - 4 * TRACK;
  }
  if (!below) {
    bottom = top + 4 * TRACK;
  }
  return { top, bottom };
}

/** Is the line across rank `k` at `u` clear of its nodes (other than `except`)? */
function clearAt(graph, k, u, except = []) {
  const rank = graph.ranks[k];
  return rank.nodes.every((n) => except.includes(n) || n.kind === 'invis' || n.kind === 'wall'
    || u < n.u0 - TRACK || u > n.u1 + TRACK);
}

/** Points without repeats and without the middle ones of a straight run. */
function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q[0] - p[0]) < 0.01 && Math.abs(q[1] - p[1]) < 0.01) {
      continue;
    }
    out.push(p);
  }
  for (let i = out.length - 2; i >= 1; i -= 1) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
    const straight = (Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - c[0]) < 0.01)
      || (Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - c[1]) < 0.01);
    if (straight) {
      out.splice(i, 1);
    }
  }
  return out;
}

/**
 * Routes every edge of `graph` (readGraph): `{ routes: [{ edge, points, arrowA, arrowB }],
 * stretch }`, the points in rank space from the upper end (a) to the lower (b), and `stretch`,
 * the room the corridors lack, `[{ at, by }]` (see `stretchGraph`), empty when all have it.
 */
export function route(graph) {
  const { ranks } = graph;
  const routes = [];
  const groups = new Map();
  // Each edge's ends: which node and side, and whether the arrow is there.
  const plan = [];
  for (const e of graph.edges) {
    const rt = e.tail.rank;
    const rh = e.head.rank;
    if (rt === rh) {
      const [a, b] = e.tail.u <= e.head.u ? [e.tail, e.head] : [e.head, e.tail];
      const arrowA = a === e.tail ? e.arrowTail : e.arrowHead;
      const arrowB = a === e.tail ? e.arrowHead : e.arrowTail;
      const between = ranks[rt].nodes.filter((n) => n !== a && n !== b && n.kind !== 'invis'
        && n.u > a.u && n.u < b.u);
      if (!between.length) {
        plan.push({
          e, flat: true, a, b, arrowA, arrowB,
        });
        continue;
      }
      // Around the nodes between them, through the corridor below (above on the last rank).
      const g = rt < ranks.length - 1 || rt === 0 ? rt : rt - 1;
      const side = g === rt ? 'after' : 'before';
      plan.push({
        e, around: true, g, side, a, b, arrowA, arrowB,
      });
      continue;
    }
    const down = rt < rh;
    const a = down ? e.tail : e.head;
    const b = down ? e.head : e.tail;
    const pts = down ? e.points : [...e.points].reverse();
    const cols = [null];
    for (let k = a.rank + 1; k < b.rank; k += 1) {
      const at = crossAt(pts, ranks[k].v);
      cols.push(at ?? (a.u + ((k - a.rank) / (b.rank - a.rank)) * (b.u - a.u)));
    }
    cols.push(null);
    plan.push({
      e,
      a,
      b,
      cols,
      arrowA: down ? e.arrowTail : e.arrowHead,
      arrowB: down ? e.arrowHead : e.arrowTail,
    });
  }
  // An edge to a channel has a port of its own, as FMC draws channels: a tree is for the
  // accesses and edges that run to one node (`trees=all` on the graph joins those too).
  const all = graph.trees === 'all';
  const groupOf = (node, side, arrow, p, other) => {
    const own = !all && other.kind === 'channel' && node.kind !== 'channel';
    const key = `${node.id}:${side}:${arrow ? 1 : 0}${own ? `:${p.e.id}` : ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key, node, side, arrow, members: [], u: node.u,
      });
    }
    return groups.get(key);
  };
  for (const p of plan) {
    if (p.flat) {
      continue;
    }
    const sideA = p.around ? p.side : 'after';
    const sideB = p.around ? p.side : 'before';
    p.ga = groupOf(p.a, sideA, p.arrowA, p, p.b);
    p.gb = groupOf(p.b, sideB, p.arrowB, p, p.a);
    p.ga.members.push(p);
    p.gb.members.push(p);
  }
  // Ports: the groups on a side, spread evenly along it in the order of where they go.
  const sides = new Map();
  for (const gr of groups.values()) {
    const k = `${gr.node.id}:${gr.side}`;
    if (!sides.has(k)) {
      sides.set(k, []);
    }
    sides.get(k).push(gr);
  }
  const towards = (gr) => {
    let sum = 0;
    for (const p of gr.members) {
      const other = gr === p.ga ? p.b : p.a;
      let next = other.u;
      if (p.cols && p.cols.length > 2) {
        next = gr === p.ga ? p.cols[1] : p.cols[p.cols.length - 2];
      }
      sum += next;
    }
    return sum / gr.members.length;
  };
  for (const list of sides.values()) {
    const side = attach(list[0].node);
    list.sort((x, y) => towards(x) - towards(y));
    // A single edge whose other end is in front of the side runs straight to it; the others
    // are spread evenly. Ports keep a track apart.
    let last = -Infinity;
    list.forEach((gr, i) => {
      const even = side.u0 + ((i + 1) * (side.u1 - side.u0)) / (list.length + 1);
      const to = towards(gr);
      let u = gr.members.length === 1 && to > side.u0 + CORNER && to < side.u1 - CORNER ? to : even;
      u = Math.min(side.u1 - CORNER, Math.max(u, last + TRACK));
      // eslint-disable-next-line no-param-reassign -- a group's port, set once here
      gr.u = side.fixed ? list[0].node.u : u;
      last = gr.u;
    });
  }
  // Columns: the ports at the ends, and virtual nodes moved onto a neighbor's column when the
  // line there is clear, so an edge bends only where it has to.
  const taken = new Map();
  for (const p of plan) {
    if (!p.cols) {
      continue;
    }
    p.cols[0] = p.ga.u;
    p.cols[p.cols.length - 1] = p.gb.u;
    for (let i = 1; i < p.cols.length - 1; i += 1) {
      const k = p.a.rank + i;
      if (!taken.has(k)) {
        taken.set(k, []);
      }
      taken.get(k).push(p);
    }
  }
  const free = (p, k, u) => clearAt(graph, k, u)
    && (taken.get(k) || []).every((q) => q === p || Math.abs(q.cols[k - q.a.rank] - u) >= TRACK);
  for (const p of plan) {
    if (!p.cols) {
      continue;
    }
    const { cols } = p;
    // One column all the way, where there is one: a port's (one bend), else a virtual node's.
    if (cols.length > 2) {
      const inner = cols.slice(1, -1);
      const one = [cols[0], cols[cols.length - 1], ...inner]
        .find((u) => inner.every((_, i) => free(p, p.a.rank + 1 + i, u)));
      if (one != null) {
        for (let i = 1; i < cols.length - 1; i += 1) {
          cols[i] = one;
        }
        continue;
      }
    }
    for (let i = 1; i < cols.length - 1; i += 1) {
      if (Math.abs(cols[i] - cols[i - 1]) <= SNAP && free(p, p.a.rank + i, cols[i - 1])) {
        cols[i] = cols[i - 1];
      }
    }
    for (let i = cols.length - 2; i >= 1; i -= 1) {
      if (Math.abs(cols[i] - cols[i + 1]) <= SNAP && free(p, p.a.rank + i, cols[i + 1])) {
        cols[i] = cols[i + 1];
      }
    }
  }
  // The horizontal segments of each corridor, joined into nets where they share a port.
  const tree = (gr) => gr.members.length > 1;
  const segments = new Map();
  const addSeg = (g, s) => {
    if (!segments.has(g)) {
      segments.set(g, []);
    }
    segments.get(g).push(s);
  };
  for (const p of plan) {
    if (p.cols) {
      p.segs = [];
      for (let i = 0; i < p.cols.length - 1; i += 1) {
        const g = p.a.rank + i;
        const s = {
          p,
          g,
          from: p.cols[i],
          to: p.cols[i + 1],
          top: `V${p.e.id}:${i}`,
          bottom: `V${p.e.id}:${i + 1}`,
        };
        // A segment at a port is on that port's tree. One between two ports is on one tree only
        // (the upper's, when both have one), and joins the other's at its port: two nodes'
        // trees on one line would read as one edge between all their nodes.
        const first = i === 0 && tree(p.ga);
        if (first) {
          s.top = `G${p.ga.key}`;
        }
        if (i === p.cols.length - 2 && tree(p.gb) && !(first && p.cols.length === 2)) {
          s.bottom = `G${p.gb.key}`;
        }
        p.segs.push(s);
        addSeg(g, s);
      }
    } else if (p.around) {
      const s = {
        p, g: p.g, from: p.ga.u, to: p.gb.u, around: p.side, top: `A${p.e.id}`, bottom: `B${p.e.id}`,
      };
      if (tree(p.ga)) {
        s.top = `G${p.ga.key}`;
      } else if (tree(p.gb)) {
        s.bottom = `G${p.gb.key}`;
      }
      p.segs = [s];
      addSeg(p.g, s);
    }
  }
  const stretch = [];
  const trackV = new Map();
  for (const [g, segs] of segments) {
    // Union-find over the segments that share an end.
    const root = new Map();
    const find = (k) => {
      let x = k;
      while (root.get(x) !== x) {
        x = root.get(x);
      }
      return x;
    };
    const unite = (a, b) => {
      if (!root.has(a)) {
        root.set(a, a);
      }
      if (!root.has(b)) {
        root.set(b, b);
      }
      root.set(find(a), find(b));
    };
    for (const s of segs) {
      unite(s.top, s.bottom);
    }
    const nets = new Map();
    for (const s of segs) {
      const k = find(s.top);
      if (!nets.has(k)) {
        nets.set(k, {
          segs: [], lo: Infinity, hi: -Infinity, up: new Set(), down: new Set(),
        });
      }
      const n = nets.get(k);
      n.segs.push(s);
      n.lo = Math.min(n.lo, s.from, s.to);
      n.hi = Math.max(n.hi, s.from, s.to);
      // Pins: where the net goes up to the rank above, and down to the rank below.
      if (s.around === 'after') {
        n.up.add(Math.round(s.from));
        n.up.add(Math.round(s.to));
      } else if (s.around === 'before') {
        n.down.add(Math.round(s.from));
        n.down.add(Math.round(s.to));
      } else {
        n.up.add(Math.round(s.from));
        n.down.add(Math.round(s.to));
      }
    }
    const list = [...nets.values()].filter((n) => n.hi - n.lo > 1.5);
    for (const n of nets.values()) {
      if (n.hi - n.lo <= 1.5) {
        n.track = null;
      }
    }
    const overlap = (a, b) => a.lo <= b.hi + TRACK && b.lo <= a.hi + TRACK;
    const within = (pins, n) => [...pins].filter((u) => u > n.lo - 0.5 && u < n.hi + 0.5).length;
    // What putting `a` above `b` costs: the verticals of each that cross the other.
    const cost = (a, b) => within(a.down, b) + within(b.up, a);
    for (const a of list) {
      a.score = 0;
      for (const b of list) {
        if (a !== b && overlap(a, b)) {
          a.score += cost(b, a) - cost(a, b);
        }
      }
    }
    list.sort((a, b) => b.score - a.score || a.lo - b.lo);
    const placed = [];
    for (const n of list) {
      n.track = 1 + Math.max(-1, ...placed.filter((m) => overlap(m, n)).map((m) => m.track));
      placed.push(n);
    }
    // An edge through a corridor is at least a track's length on each side, so a short one
    // is still seen, and its direction.
    const count = Math.max(1, 1 + Math.max(-1, ...list.map((n) => n.track)));
    const { top, bottom } = corridor(graph, g);
    const step = (bottom - top) / (count + 1);
    // Too narrow for its tracks, or narrower than the others: as much room as it lacks, put in
    // between its frames (`stretch`), so every edge is as far from its nodes as in the others.
    const want = Math.max((count + 1) * TRACK, MIN_FREE);
    if (bottom - top < want - 0.5) {
      stretch.push({ at: (top + bottom) / 2, by: want - (bottom - top) });
    }
    for (const n of nets.values()) {
      for (const s of n.segs) {
        trackV.set(s, n.track == null ? (top + bottom) / 2 : top + (n.track + 1) * step);
      }
    }
  }
  // The points of each edge, from end a to end b.
  for (const p of plan) {
    const A = attach(p.a);
    const B = attach(p.b);
    let pts;
    if (p.flat) {
      pts = [[A.u1, p.a.v], [B.u0, p.b.v]];
      if (Math.abs(p.a.v - p.b.v) > 0.5) {
        const mid = (A.u1 + B.u0) / 2;
        pts = [[A.u1, p.a.v], [mid, p.a.v], [mid, p.b.v], [B.u0, p.b.v]];
      }
    } else if (p.around) {
      const v = trackV.get(p.segs[0]);
      const va = p.side === 'after' ? A.v1 : A.v0;
      const vb = p.side === 'after' ? B.v1 : B.v0;
      pts = [[p.ga.u, va], [p.ga.u, v], [p.gb.u, v], [p.gb.u, vb]];
    } else {
      pts = [[p.cols[0], A.v1]];
      p.segs.forEach((s, i) => {
        const v = trackV.get(s);
        pts.push([p.cols[i], v], [p.cols[i + 1], v]);
      });
      pts.push([p.cols[p.cols.length - 1], B.v0]);
    }
    routes.push({
      plan: p, edge: p.e, points: simplify(pts), arrowA: p.arrowA, arrowB: p.arrowB,
    });
  }
  return { routes, stretch, groups };
}

/** The part of `pts` outside the box `c` from the start (`fromEnd` false) or the end. */
function clipOut(pts, c, fromEnd) {
  const inside = ([x, y]) => x > c.x0 && x < c.x1 && y > c.y0 && y < c.y1;
  const list = fromEnd ? [...pts].reverse() : [...pts];
  // Walk from the far end towards the node in the cluster: cut where the box is entered.
  for (let i = 1; i < list.length; i += 1) {
    if (inside(list[i]) && !inside(list[i - 1])) {
      const [a, b] = [list[i - 1], list[i]];
      let t = 1;
      for (const [k, edge] of [[0, c.x0], [0, c.x1], [1, c.y0], [1, c.y1]]) {
        const d = b[k] - a[k];
        if (d) {
          const s = (edge - a[k]) / d;
          if (s >= 0 && s <= t) {
            const o = 1 - k;
            const at = a[o] + s * (b[o] - a[o]);
            const lo = o === 0 ? c.x0 : c.y0;
            const hi = o === 0 ? c.x1 : c.y1;
            if (at >= lo - 0.01 && at <= hi + 0.01) {
              t = s;
            }
          }
        }
      }
      const cut = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      const kept = [...list.slice(0, i), cut];
      return fromEnd ? kept.reverse() : kept;
    }
  }
  return pts;
}

/** An SVG path through orthogonal `pts`, its corners rounded. */
export function roundedPath(pts) {
  if (pts.length < 2) {
    return '';
  }
  let d = `M${num(pts[0][0])},${num(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const r = Math.min(CORNER, l1 / 2, l2 / 2);
    const p = [b[0] - ((b[0] - a[0]) / l1) * r, b[1] - ((b[1] - a[1]) / l1) * r];
    const q = [b[0] + ((c[0] - b[0]) / l2) * r, b[1] + ((c[1] - b[1]) / l2) * r];
    d += ` L${num(p[0])},${num(p[1])} Q${num(b[0])},${num(b[1])} ${num(q[0])},${num(q[1])}`;
  }
  const z = pts[pts.length - 1];
  return `${d} L${num(z[0])},${num(z[1])}`;
}

/** An arrowhead whose tip is the last of `pts`. */
function arrowAt(pts) {
  const b = pts[pts.length - 1];
  const a = pts[pts.length - 2];
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const [dx, dy] = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  const base = [b[0] - dx * ARROW, b[1] - dy * ARROW];
  return `M${num(b[0])},${num(b[1])} L${num(base[0] - dy * ARROW_W)},${num(base[1] + dx * ARROW_W)} L${num(base[0] + dy * ARROW_W)},${num(base[1] - dx * ARROW_W)} Z`;
}

/** A label's lines as SVG text, centered on `x`, the block centered on `y`. */
function textBlock(lines, x, y, size, cls, anchor = 'middle') {
  if (!lines.length || (lines.length === 1 && !lines[0].length)) {
    return '';
  }
  const lead = size * 1.22;
  const first = y - ((lines.length - 1) * lead) / 2 + size * 0.35;
  return `<text class="${cls}" x="${num(x)}" y="${num(first)}" text-anchor="${anchor}">${lines.map((l, i) => `<tspan x="${num(x)}"${i ? ` dy="${num(lead)}"` : ''}>${l.map((r) => (r.code ? `<tspan class="fmc-code">${esc(r.text)}</tspan>` : esc(r.text))).join('')}</tspan>`).join('')}</text>`;
}

const PERSON = (cx, cy, s) => {
  const h = s;
  const head = h * 0.14;
  return `<circle class="fmc-figure" cx="${num(cx)}" cy="${num(cy - h / 2 + head)}" r="${num(head)}"/>`
    + `<path class="fmc-figure" d="M${num(cx)},${num(cy - h / 2 + 2 * head)} V${num(cy + h * 0.12)} M${num(cx - h * 0.25)},${num(cy - h * 0.12)} H${num(cx + h * 0.25)} M${num(cx - h * 0.22)},${num(cy + h / 2)} L${num(cx)},${num(cy + h * 0.12)} L${num(cx + h * 0.22)},${num(cy + h / 2)}"/>`;
};

/** A node as SVG. */
function nodeSvg(n, graph) {
  const { attrs } = n;
  const x0 = n.x - n.w / 2;
  const y0 = n.y - n.h / 2;
  const label = String(attrs.label === '\\N' || attrs.label == null ? n.name : attrs.label).trim();
  const note = String(attrs.note || '').trim();
  const data = `${attrs.part != null ? ` data-part="${esc(attrs.part)}" tabindex="0"` : ''}${attrs.flow != null ? ` data-flow="${esc(attrs.flow)}"` : ''}${attrs.seen ? ' data-seen="1"' : ''}`;
  const title = attrs.tooltip ? `<title>${esc(attrs.tooltip)}</title>` : '';
  const cls = `fmc-node fmc-${n.kind}${attrs.class ? ` ${esc(attrs.class)}` : ''}`;
  if (n.kind === 'invis' || n.kind === 'wall') {
    return '';
  }
  if (n.kind === 'caption') {
    return textBlock(wrap(label, n.w, FONT.label, 2), x0, n.y, FONT.label, 'fmc-flabel', 'start');
  }
  if (n.kind === 'dots') {
    // Along its longer side: "…" across, "⋮" down.
    const s = Math.min(2, Math.max(n.w, n.h) / 16);
    const [dx, dy] = n.h > n.w ? [0, 1] : [1, 0];
    const dot = (k) => `<circle class="fmc-dot" cx="${num(n.x + k * s * 3 * dx)}" cy="${num(n.y + k * s * 3 * dy)}" r="${num(s)}"/>`;
    return `<g class="${cls}"${data}>${[-1, 0, 1].map(dot).join('')}</g>`;
  }
  if (n.kind === 'channel') {
    let out = `<g class="${cls}"${data}>${title}<circle class="fmc-shape" cx="${num(n.x)}" cy="${num(n.y)}" r="${CHANNEL_R}"/>`;
    const loc = String(attrs.labelloc || (graph.lr ? 't' : 'r')).toLowerCase();
    const req = attrs.request && !/^(false|no|0)$/i.test(attrs.request);
    let lx = n.x + CHANNEL_R + 4;
    let ly = n.y;
    let anchor = 'start';
    if (loc === 't') {
      [lx, ly, anchor] = [n.x, n.y - CHANNEL_R - 4 - FONT.small * 0.6, 'middle'];
    } else if (loc === 'b') {
      [lx, ly, anchor] = [n.x, n.y + CHANNEL_R + 4 + FONT.small * 0.6, 'middle'];
    } else if (loc === 'l') {
      [lx, anchor] = [n.x - CHANNEL_R - 4, 'end'];
    }
    if (req) {
      // The R, and the arrow beside it that points the way requests go (set by `svg`).
      out += `<g class="fmc-r" data-r="${esc(n.id)}"></g>`;
      if (loc === 'r') {
        lx += 16;
      }
    }
    if (label) {
      const room = Math.max(40, (loc === 't' || loc === 'b' ? n.w : n.w / 2 - CHANNEL_R - 4 - (req ? 16 : 0)));
      out += textBlock(wrap(label, room, FONT.small, 2), lx, ly, FONT.small, 'fmc-clabel', anchor);
    }
    return `${out}</g>`;
  }
  const storage = n.kind === 'storage';
  const rx = storage ? Math.min(n.h / 2, 16) : 0;
  const multi = truthy(attrs.multi);
  let out = `<g class="${cls}"${data}>${title}`;
  if (multi) {
    for (const k of [2, 1]) {
      out += `<rect class="fmc-shape fmc-behind" x="${num(x0 + 5 * k)}" y="${num(y0 - 5 * k)}" width="${num(n.w)}" height="${num(n.h)}" rx="${num(rx)}"/>`;
    }
  }
  out += `<rect class="fmc-shape" x="${num(x0)}" y="${num(y0)}" width="${num(n.w)}" height="${num(n.h)}" rx="${num(rx)}"/>`;
  const pad = storage ? Math.max(8, rx * 0.7) : 6;
  const room = n.w - 2 * pad;
  if (n.kind === 'person') {
    const fig = Math.min(n.h - 10, 30);
    if (label) {
      const lines = wrap(label, room, FONT.label, 1);
      out += PERSON(n.x, y0 + 5 + fig / 2, fig);
      out += textBlock(lines, n.x, y0 + n.h - 4 - FONT.label * 0.5, FONT.label, 'fmc-label');
    } else {
      out += PERSON(n.x, n.y, fig);
    }
    return `${out}</g>`;
  }
  const fit = note || n.h < 30 ? 1 : Math.max(1, Math.floor((n.h - 6) / 14));
  const lines = wrap(label, room, FONT.label, fit);
  if (note && n.h >= 34) {
    const more = Math.max(1, Math.floor((n.h - 12 - lines.length * 15) / 13));
    const noteLines = wrap(note, room, FONT.note, more);
    const total = lines.length * 14.6 + noteLines.length * 12.8;
    const top = n.y - total / 2;
    out += textBlock(lines, n.x, top + (lines.length * 14.6) / 2, FONT.label, 'fmc-label');
    out += textBlock(noteLines, n.x, top + lines.length * 14.6 + 1 + (noteLines.length * 12.8) / 2, FONT.note, 'fmc-note');
  } else {
    out += textBlock(lines, n.x, n.y, FONT.label, 'fmc-label');
  }
  return `${out}</g>`;
}

/** A cluster as SVG: its frame, its label. */
function clusterSvg(c, graph) {
  const { attrs } = c;
  const w = c.x1 - c.x0;
  const h = c.y1 - c.y0;
  const { kind } = c;
  const data = attrs.layer != null ? ` data-layer="${esc(attrs.layer)}"` : '';
  const cls = `fmc-frame fmc-frame-${kind} fmc-depth-${Math.min(c.depth, 3)}${truthy(attrs.dashed) ? ' fmc-dashed' : ''}${attrs.class ? ` ${esc(attrs.class)}` : ''}`;
  let shape;
  if (kind === 'ushape') {
    const walls = c.members.filter((n) => n.kind === 'wall');
    const left = Math.min(...walls.map((n) => n.x));
    const right = Math.max(...walls.map((n) => n.x));
    const bottom = Math.max(...walls.map((n) => n.y));
    const ok = walls.length && left < right && bottom > c.y0;
    const [l, r, b] = ok ? [left, right, bottom] : [c.x0 + 18, c.x1 - 18, c.y1 - 24];
    shape = `<path class="fmc-shape" d="M${num(c.x0)},${num(c.y0)} H${num(l)} V${num(b)} H${num(r)} V${num(c.y0)} H${num(c.x1)} V${num(c.y1)} H${num(c.x0)} Z"/>`;
  } else {
    const rx = kind === 'storage' || /rounded/.test(attrs.style || '') ? 16 : 0;
    shape = `<rect class="fmc-shape" x="${num(c.x0)}" y="${num(c.y0)}" width="${num(w)}" height="${num(h)}" rx="${rx}"/>`;
    if (kind === 'set') {
      shape += `<rect class="fmc-inner" x="${num(c.x0 + 3)}" y="${num(c.y0 + 3)}" width="${num(w - 6)}" height="${num(h - 6)}" rx="${rx ? rx - 3 : 0}"/>`;
    }
  }
  let label = '';
  if (c.rowlabel) {
    const lines = wrap(c.rowlabel, c.room - 14, FONT.label, 2);
    label = textBlock(lines, c.x0 + 8, (c.y0 + c.y1) / 2, FONT.label, 'fmc-flabel', 'start');
  } else if (c.label && c.lp) {
    const just = String(attrs.labeljust || graph.labeljust || 'c').toLowerCase();
    const room = w - 12;
    const lines = wrap(c.label, room, FONT.label, 1);
    let [x, anchor] = [c.lp[0], 'middle'];
    if (just === 'l') {
      [x, anchor] = [c.x0 + 8, 'start'];
    }
    if (just === 'r') {
      [x, anchor] = [c.x1 - 8, 'end'];
    }
    label = textBlock(lines, x, c.lp[1], FONT.label, 'fmc-flabel', anchor);
  }
  return `<g class="${cls}"${data}>${shape}${label}</g>`;
}

/**
 * The SVG of a routed diagram. Each edge is a path of its own (`data-flow` its flow), drawn
 * along the others of its tree where they share a port, and each arrowhead is drawn once.
 */
export function svg(graph, routed, { title = '', pad = 10, className = '' } = {}) {
  const { toXY } = graph;
  // What is drawn, wherever it is: the frames may be wider than Graphviz's drawing, and an
  // edge around a rank may run outside it.
  const xs = [0, graph.width];
  const ys = [0, graph.height];
  for (const c of graph.clusters) {
    xs.push(c.x0, c.x1);
    ys.push(c.y0, c.y1);
  }
  for (const r of routed.routes) {
    for (const [u, v] of r.points) {
      const [x, y] = toXY(u, v);
      xs.push(x);
      ys.push(y);
    }
  }
  const X0 = Math.min(...xs) - pad;
  const Y0 = Math.min(...ys) - pad;
  const W = Math.max(...xs) + pad - X0;
  const H = Math.max(...ys) + pad - Y0;
  const frames = graph.clusters.map((c) => clusterSvg(c, { ...graph, labeljust: graph.labeljust })).join('');
  const edges = [];
  const arrows = new Map();
  const rDirs = new Map();
  for (const r of routed.routes) {
    let pts = r.points.map(([u, v]) => toXY(u, v));
    const { edge, plan } = r;
    // Compound edges stop at the cluster's frame.
    const aIsTail = plan.a === edge.tail;
    for (const [name, atTail] of [[edge.lhead, false], [edge.ltail, true]]) {
      const c = name && graph.clusters.find((k) => k.name === name);
      if (c) {
        pts = clipOut(pts, c, atTail === aIsTail);
      }
    }
    const flow = edge.attrs.flow != null ? ` data-flow="${esc(edge.attrs.flow)}"` : '';
    const cls = `fmc-edge${edge.attrs.class ? ` ${esc(edge.attrs.class)}` : ''}`;
    edges.push(`<path class="${cls}"${flow} d="${roundedPath(pts)}"/>`);
    const add = (list, key) => {
      const k = `${key}`;
      if (!arrows.has(k)) {
        arrows.set(k, { d: arrowAt(list), flows: new Set() });
      }
      if (edge.attrs.flow != null) {
        arrows.get(k).flows.add(String(edge.attrs.flow));
      }
    };
    const end = (list) => list[list.length - 1].map((x) => Math.round(x)).join(',');
    if (r.arrowB && pts.length > 1) {
      add(pts, end(pts));
    }
    if (r.arrowA && pts.length > 1) {
      add([...pts].reverse(), end([...pts].reverse()));
    }
    // The way requests go, at a request channel: away from the requester.
    const ends = [[plan.a, pts.slice(0, 2)], [plan.b, [...pts].reverse().slice(0, 2)]];
    for (const [node, out] of ends) {
      if (node.kind === 'channel' && node.attrs.request && !/^(false|no|0)$/i.test(node.attrs.request) && out.length === 2) {
        const back = String(node.attrs.request).toLowerCase() === 'back';
        const leaving = (node === edge.tail) !== back;
        const [p, q] = out;
        const d = leaving ? [q[0] - p[0], q[1] - p[1]] : [p[0] - q[0], p[1] - q[1]];
        if (leaving || !rDirs.has(node.id)) {
          rDirs.set(node.id, d);
        }
      }
    }
  }
  const arrowSvg = [...arrows.values()].map((a) => `<path class="fmc-arrow"${a.flows.size ? ` data-flows="${[...a.flows].join(' ')}"` : ''} d="${a.d}"/>`).join('');
  let nodes = graph.nodes.map((n) => nodeSvg(n, graph)).join('');
  nodes = nodes.replace(/<g class="fmc-r" data-r="(\d+)"><\/g>/g, (m, id) => {
    const n = graph.nodes.find((k) => String(k.id) === id);
    const [dx, dy] = rDirs.get(Number(id)) || [0, 1];
    const loc = String(n.attrs.labelloc || (graph.lr ? 't' : 'r')).toLowerCase();
    const vertical = Math.abs(dy) >= Math.abs(dx);
    let [x, y] = [n.x + CHANNEL_R + 3, n.y + CHANNEL_R + 3];
    // Beside the circle, across the edge: right of it, or under it on an edge across.
    if (loc === 'r' || loc === 'l') {
      [x, y] = [n.x + CHANNEL_R + 3, n.y + 4];
    }
    if (!vertical) {
      [x, y] = [n.x + CHANNEL_R + 1, n.y + CHANNEL_R + 9];
    }
    const s = 3.2;
    const tx = x + 11;
    const ty = y - 3.5;
    let tri;
    if (vertical) {
      const k = dy >= 0 ? 1 : -1;
      tri = `M${num(tx - s)},${num(ty - k * s)} L${num(tx + s)},${num(ty - k * s)} L${num(tx)},${num(ty + k * s)} Z`;
    } else {
      const k = dx >= 0 ? 1 : -1;
      tri = `M${num(tx - k * s)},${num(ty - s)} L${num(tx - k * s)},${num(ty + s)} L${num(tx + k * s)},${num(ty)} Z`;
    }
    return `<g class="fmc-r"><text class="fmc-rlabel" x="${num(x)}" y="${num(y)}">R</text><path class="fmc-rarrow" d="${tri}"/></g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" class="fmc${className ? ` ${esc(className)}` : ''}" viewBox="${num(X0)} ${num(Y0)} ${num(W)} ${num(H)}" width="${num(W)}" height="${num(H)}" role="img"${title ? ` aria-label="${esc(title)}"` : ''}>`
    + `${title ? `<title>${esc(title)}</title>` : ''}<g class="fmc-frames">${frames}</g><g class="fmc-edges">${edges.join('')}</g>`
    + `<g class="fmc-arrows">${arrowSvg}</g><g class="fmc-nodes">${nodes}</g></svg>`;
}

/**
 * `graph` with room put in along the ranks: `by` px at each `at` (v in rank space), everything
 * past it moved on, the frames across it longer. Graphviz has one distance between ranks for
 * all; this gives each corridor what it needs without making the others longer too.
 */
export function stretchGraph(graph, list) {
  const cuts = [...list].sort((a, b) => a.at - b.at);
  const f = (v) => v + cuts.reduce((d, c) => (c.at < v ? d + c.by : d), 0);
  const { toXY } = graph;
  const fromXY = (x, y) => (graph.lr ? [y, x] : [x, y]);
  const g = graph;
  for (const n of g.nodes) {
    [n.v, n.v0, n.v1] = [f(n.v), f(n.v0), f(n.v1)];
    [n.x, n.y] = toXY(n.u, n.v);
  }
  for (const k of g.ranks) {
    [k.v, k.v0, k.v1] = [f(k.v), f(k.v0), f(k.v1)];
  }
  for (const c of g.clusters) {
    [c.v0, c.v1] = [f(c.v0), f(c.v1)];
    [c.x0, c.x1, c.y0, c.y1] = box(toXY(c.u0, c.v0), toXY(c.u1, c.v1));
    if (c.lp) {
      const [u, v] = fromXY(...c.lp);
      c.lp = toXY(u, f(v));
    }
  }
  for (const e of g.edges) {
    e.points = e.points.map(([u, v]) => [u, f(v)]);
  }
  const total = cuts.reduce((d, c) => d + c.by, 0);
  if (g.lr) {
    g.width += total;
  } else {
    g.height += total;
  }
  return g;
}

/**
 * Draws `dot` (an FMC block diagram as DOT, see above) with `viz`, an instance of @viz-js/viz:
 * `{ svg, width, height, passes, graph }`. Graphviz lays it out once; `passes` counts the
 * routings (a second when a corridor needed more room). Throws Graphviz's error when the DOT is
 * not valid.
 */
export function renderFmc(viz, dot, options = {}) {
  const base = viz.renderJSON(dot);
  const graph = readGraph(base);
  let routed = route(graph);
  let passes = 1;
  while (routed.stretch.length && passes < 3) {
    stretchGraph(graph, routed.stretch);
    routed = route(graph);
    passes += 1;
  }
  graph.labeljust = base.labeljust;
  const out = svg(graph, routed, options);
  const [, width, height] = /width="([\d.]+)" height="([\d.]+)"/.exec(out).map(Number);
  return {
    svg: out, width, height, passes, graph,
  };
}
