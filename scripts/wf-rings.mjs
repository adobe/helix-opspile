#!/usr/bin/env node
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
 * The kinds' workflow icons ringed, as the draft's pencil is while the team has not read the
 * thread: the icon smaller, inside an outline of its own shape a gap away. Each is one mask
 * (`.wf-<name>.ringed`, in the color of the text around it, as `.wf` is), written into
 * ui/spectrum-inbox.css between the markers below from the icon's own mask there.
 *
 * The outline follows the icon's silhouette: the icon (smaller) filled on a fine grid, its gaps
 * narrower than twice CLOSE shut and its holes filled, so a line icon's inside is not outlined
 * too. The ring is where the distance from that silhouette is between GAP and GAP + RING,
 * traced (marching squares) and simplified into a path, so the mask stays vector.
 *
 *   node scripts/wf-rings.mjs           writes the block
 *   node scripts/wf-rings.mjs --check   fails when it is not current
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = fileURLToPath(new URL('../ui/spectrum-inbox.css', import.meta.url));
const JS = fileURLToPath(new URL('../ui/inbox.js', import.meta.url));
export const BEGIN = '/* Ringed kinds: written by scripts/wf-rings.mjs, do not edit. */';
export const END = '/* End of the ringed kinds. */';

// In the icon's 20 by 20 box, shown at 20 px: the icon at this scale, then a gap, then the ring.
const SCALE = 0.7;
const GAP = 1.3;
const RING = 1.25;
// Gaps in the icon narrower than twice this are shut before its holes are filled.
const CLOSE = 1.6;
// Grid cells per unit.
const K = 24;
// How far the traced path may stray from the ring's edge, in units.
const TOLERANCE = 0.025;

const ARGS = {
  m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0,
};

/** A path's commands: `{ c, args }`, one per group of arguments (`m` 1 2 3 4 is m, then l). */
function parse(d) {
  const out = [];
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i])) {
      i += 1;
    }
  };
  const num = () => {
    skip();
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(d.slice(i));
    if (!m) {
      throw new Error(`a number at ${i} of ${d.slice(i, i + 20)}`);
    }
    i += m[0].length;
    return Number(m[0]);
  };
  let cmd = null;
  for (skip(); i < d.length; skip()) {
    if (/[a-z]/i.test(d[i])) {
      cmd = d[i];
      i += 1;
    } else if (!cmd) {
      throw new Error('a path without a command');
    }
    const n = ARGS[cmd.toLowerCase()];
    if (cmd.toLowerCase() === 'a') {
      throw new Error('arcs are not drawn here');
    }
    out.push({ c: cmd, args: Array.from({ length: n }, num) });
    if (!n) {
      cmd = null;
    } else if (cmd === 'm') {
      cmd = 'l';
    } else if (cmd === 'M') {
      cmd = 'L';
    }
  }
  return out;
}

/** A cubic (4 points) or quadratic (3) Bézier curve in 16 straight steps, without its start. */
function bezier(pts) {
  const out = [];
  for (let s = 1; s <= 16; s += 1) {
    const t = s / 16;
    const u = 1 - t;
    const w = pts.length === 4
      ? [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
      : [u * u, 2 * u * t, t * t];
    out.push([0, 1].map((k) => w.reduce((sum, wi, i) => sum + wi * pts[i][k], 0)));
  }
  return out;
}

/** The control point s and t take: the last one mirrored, if the last command had one. */
const mirror = (p, ctl, had) => (had ? [2 * p[0] - ctl[0], 2 * p[1] - ctl[1]] : p);

/** A path as polygons, one per subpath, its curves in short straight steps. */
export function polygons(d) {
  const out = [];
  let p = [0, 0];
  let start = [0, 0];
  // The last control point, which s and t mirror.
  let ctl = [0, 0];
  let last = '';
  for (const { c, args } of parse(d)) {
    const k = c.toLowerCase();
    const o = c === k ? p : [0, 0];
    const abs = (i) => [o[0] + args[i], o[1] + args[i + 1]];
    if (k === 'm') {
      p = abs(0);
      start = p;
      out.push([p]);
    } else {
      if (!out.length || last === 'z') {
        out.push([p]);
      }
      const poly = out[out.length - 1];
      let to;
      if (k === 'z') {
        to = start;
      } else if (k === 'l') {
        to = abs(0);
        poly.push(to);
      } else if (k === 'h') {
        to = [o[0] + args[0], p[1]];
        poly.push(to);
      } else if (k === 'v') {
        to = [p[0], o[1] + args[0]];
        poly.push(to);
      } else if (k === 'c' || k === 's') {
        const c1 = k === 'c' ? abs(0) : mirror(p, ctl, 'cs'.includes(last));
        const r = k === 'c' ? 2 : 0;
        ctl = abs(r);
        to = abs(r + 2);
        poly.push(...bezier([p, c1, ctl, to]));
      } else {
        ctl = k === 'q' ? abs(0) : mirror(p, ctl, 'qt'.includes(last));
        to = abs(k === 'q' ? 2 : 0);
        poly.push(...bezier([p, ctl, to]));
      }
      p = to;
    }
    last = k;
  }
  return out.filter((poly) => poly.length > 2);
}

/** The cells (by their centers) inside any of the polygons, each filled on its own. */
function fill(polys, n) {
  const grid = new Uint8Array(n * n);
  for (const poly of polys) {
    const pts = poly.map(([x, y]) => [x * K, y * K]);
    for (let row = 0; row < n; row += 1) {
      const yc = row + 0.5;
      const xs = [];
      for (let i = 0; i < pts.length; i += 1) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        if ((y1 <= yc) !== (y2 <= yc)) {
          xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, Math.ceil(xs[i] - 0.5));
        for (let col = from; col < n && col + 0.5 <= xs[i + 1]; col += 1) {
          grid[row * n + col] = 1;
        }
      }
    }
  }
  return grid;
}

/** One line of the squared distance transform (Felzenszwalb and Huttenlocher). */
function line(g) {
  const n = g.length;
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const out = new Float64Array(n);
  let k = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q += 1) {
    let s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k -= 1;
      s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1] < q) {
      k += 1;
    }
    out[q] = (q - v[k]) ** 2 + g[v[k]];
  }
  return out;
}

/** Each cell's distance, in cells, to the nearest set cell. */
function distance(grid, n) {
  const f = Float64Array.from(grid, (x) => (x ? 0 : 1e20));
  for (let c = 0; c < n; c += 1) {
    const col = line(Float64Array.from({ length: n }, (_, r) => f[r * n + c]));
    for (let r = 0; r < n; r += 1) {
      f[r * n + c] = col[r];
    }
  }
  for (let r = 0; r < n; r += 1) {
    f.set(line(f.subarray(r * n, r * n + n)), r * n);
  }
  return f.map(Math.sqrt);
}

/** The silhouette: gaps narrower than twice `close` shut, then every hole filled. */
function silhouette(grid, n, close) {
  const r = close * K;
  const grown = distance(grid, n).map((d) => (d <= r ? 1 : 0));
  const back = distance(grown.map((x) => 1 - x), n);
  const shut = grid.map((x, i) => (x || back[i] > r ? 1 : 0));
  // The outside is what the edge of the grid reaches; the rest is the silhouette.
  const seen = new Uint8Array(n * n);
  const stack = [];
  for (let i = 0; i < n; i += 1) {
    stack.push(i, (n - 1) * n + i, i * n, i * n + n - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    if (!seen[i] && !shut[i]) {
      seen[i] = 1;
      const col = i % n;
      if (i >= n) {
        stack.push(i - n);
      }
      if (i < n * (n - 1)) {
        stack.push(i + n);
      }
      if (col > 0) {
        stack.push(i - 1);
      }
      if (col < n - 1) {
        stack.push(i + 1);
      }
    }
  }
  return seen.map((x) => 1 - x);
}

// Marching squares: a cell's corners are four cell centers, TL TR BR BL (bits 8 4 2 1, set
// inside); its edges top, right, bottom, left (0 to 3). Each case's segments go from one edge to
// another, the same way around the inside, so they join into closed loops.
const SEGMENTS = {
  1: [[3, 2]],
  2: [[2, 1]],
  3: [[3, 1]],
  4: [[1, 0]],
  6: [[2, 0]],
  7: [[3, 0]],
  8: [[0, 3]],
  9: [[0, 2]],
  11: [[0, 1]],
  12: [[1, 3]],
  13: [[1, 2]],
  14: [[2, 3]],
};
// The saddles, by whether the cell's middle is inside.
const SADDLES = {
  5: { true: [[3, 0], [1, 2]], false: [[3, 2], [1, 0]] },
  10: { true: [[0, 1], [2, 3]], false: [[0, 3], [2, 1]] },
};
const EDGE_CORNERS = [[[0, 0], [0, 1]], [[0, 1], [1, 1]], [[1, 0], [1, 1]], [[0, 0], [1, 0]]];

/** The closed outlines where `field` crosses `level`, in units. */
function trace(field, n, level) {
  const at = (r, c) => (r < 0 || c < 0 || r >= n || c >= n ? Infinity : field[r * n + c]);
  const point = (r, c, edge) => {
    const [[ra, ca], [rb, cb]] = EDGE_CORNERS[edge];
    const va = at(r + ra, c + ca);
    const vb = at(r + rb, c + cb);
    const t = Number.isFinite(va) && Number.isFinite(vb) ? (level - va) / (vb - va) : 0.5;
    return [(c + ca + t * (cb - ca) + 0.5) / K, (r + ra + t * (rb - ra) + 0.5) / K];
  };
  const key = (r, c, edge) => [`h${r},${c}`, `v${r},${c + 1}`, `h${r + 1},${c}`, `v${r},${c}`][edge];
  const next = new Map();
  const pos = new Map();
  for (let r = -1; r < n; r += 1) {
    for (let c = -1; c < n; c += 1) {
      const v = [at(r, c), at(r, c + 1), at(r + 1, c + 1), at(r + 1, c)];
      const idx = v.reduce((sum, x, i) => sum + (x < level ? [8, 4, 2, 1][i] : 0), 0);
      const mid = v.reduce((a, b) => a + b, 0) / 4 < level;
      for (const [e1, e2] of SEGMENTS[idx] || SADDLES[idx]?.[mid] || []) {
        const k1 = key(r, c, e1);
        const k2 = key(r, c, e2);
        next.set(k1, k2);
        if (!pos.has(k1)) {
          pos.set(k1, point(r, c, e1));
        }
        if (!pos.has(k2)) {
          pos.set(k2, point(r, c, e2));
        }
      }
    }
  }
  const loops = [];
  const done = new Set();
  for (const first of next.keys()) {
    const loop = [];
    for (let k = first; k && !done.has(k); k = next.get(k)) {
      done.add(k);
      loop.push(pos.get(k));
    }
    if (loop.length > 2) {
      loops.push(loop);
    }
  }
  return loops;
}

/** How far `p` is from the line through `a` and `b`. */
function off(a, b, p) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / (Math.hypot(dx, dy) || 1);
}

/** An open polyline with fewer points, none further than `tol` (Ramer–Douglas–Peucker). */
function rdp(pts, tol) {
  let best = 0;
  let at = 0;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const d = off(pts[0], pts[pts.length - 1], pts[i]);
    if (d > best) {
      best = d;
      at = i;
    }
  }
  if (best <= tol) {
    return [pts[0], pts[pts.length - 1]];
  }
  return [...rdp(pts.slice(0, at + 1), tol).slice(0, -1), ...rdp(pts.slice(at), tol)];
}

/** A closed polyline simplified: split at its point furthest from the first, both halves. */
function simplify(pts, tol) {
  const far = pts.reduce((best, p, i) => {
    const d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
    return d > best.d ? { d, i } : best;
  }, { d: 0, i: 0 }).i;
  const a = rdp(pts.slice(0, far + 1), tol);
  const b = rdp([...pts.slice(far), pts[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

const fmt = (x) => String(Number(x.toFixed(2)));
const pathOf = (loops) => loops.map((l) => `M${l.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L')}Z`).join('');

/** A `<rect>` as a polygon. */
function rect(el) {
  const [x, y, w, h] = ['x', 'y', 'width', 'height']
    .map((a) => Number(new RegExp(`\\b${a}="([^"]+)"`).exec(el)?.[1] || 0));
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

/** The ringed icon's SVG, from the icon's. */
export function ringed(svg) {
  const body = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)?.[1] || '';
  const rects = [...body.matchAll(/<rect\b[^>]*>/g)].map(([el]) => rect(el));
  const paths = [...body.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
  if (!paths.length && !rects.length) {
    throw new Error('an icon without paths');
  }
  const fit = ([x, y]) => [10 + (x - 10) * SCALE, 10 + (y - 10) * SCALE];
  const polys = [...paths.flatMap(polygons), ...rects].map((poly) => poly.map(fit));
  const n = 20 * K;
  const sil = silhouette(fill(polys, n), n, CLOSE);
  const d = distance(sil, n).map((x) => x / K);
  const loops = [...trace(d, n, GAP + RING), ...trace(d, n, GAP)]
    .map((l) => simplify(l, TOLERANCE));
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">'
    + `<path fill-rule="evenodd" d="${pathOf(loops)}"/>`
    + `<g transform="translate(10 10) scale(${SCALE}) translate(-10 -10)">${body}</g></svg>`;
}

/** The kinds' icon names, from `KIND_ICON` in ui/inbox.js. */
export function kindIcons(js) {
  const block = /const KIND_ICON = \{([^}]*)\}/.exec(js)?.[1] || '';
  return [...new Set([...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]))];
}

/** The stylesheet with its ringed block written from its icons. */
export function write(css, names) {
  const rules = names.map((name) => {
    const m = new RegExp(`\\.spectrum \\.wf-${name} \\{ --wf: url\\("data:image/svg\\+xml;base64,([^"]+)"\\); \\}`).exec(css);
    if (!m) {
      throw new Error(`no icon .wf-${name} in the stylesheet`);
    }
    const svg = Buffer.from(ringed(Buffer.from(m[1], 'base64').toString())).toString('base64');
    return `.spectrum .wf-${name}.ringed { --wf: url("data:image/svg+xml;base64,${svg}"); }`;
  });
  const block = `${BEGIN}\n${rules.join('\n')}\n${END}`;
  const a = css.indexOf(BEGIN);
  if (a < 0) {
    return `${css.replace(/\n*$/, '')}\n${block}\n`;
  }
  return css.slice(0, a) + block + css.slice(css.indexOf(END) + END.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const css = readFileSync(CSS, 'utf8');
  const next = write(css, kindIcons(readFileSync(JS, 'utf8')));
  if (process.argv.includes('--check')) {
    if (next !== css) {
      console.error('ui/spectrum-inbox.css: the ringed kinds are not current; run node scripts/wf-rings.mjs');
      process.exit(1);
    }
  } else if (next !== css) {
    writeFileSync(CSS, next);
  }
}
