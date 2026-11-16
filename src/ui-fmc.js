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
 * Draws FMC block diagrams (src/fmc.js) with Mermaid and its ELK layout, as FMC's
 * visualization guidelines have them (https://www.fmc-modeling.org/visualization_guidelines).
 * Mermaid parses the text src/fmc.js writes, which GitHub draws too, and ELK lays it out:
 * layered, so the crossings are few; orthogonal, with rounded corners; edges into the same node
 * merged into edge trees; the spacing between edges and nodes kept. What makes the drawing
 * FMC's is done around Mermaid, from the plan of the text:
 *
 * - before the layout (`layout`, which takes the place of Mermaid's `elk` layout): each node's
 *   size by its importance (`size`), the same for all of a size and kind, wide and tall enough
 *   for the longest label of them, never sized by its own label; storages as rounded
 *   rectangles, channels as small circles; and an edge from a lower layer up into a higher one
 *   laid out downwards, so the layers stay in their order.
 * - after it (`finish`): Mermaid's styles and colors taken out, so ui/spectrum-inbox.css styles
 *   the drawing by its classes (`fmc-*`) with Spectrum 2 tokens, node lines twice as thick as
 *   edges; storages rounded, request channels marked R with the direction of the request,
 *   modify access as FMC's pair of arcs, persons with a figure, enumerations as a stack.
 *
 * The page does not load this file: scripts/ui-markdown.mjs bundles it, with Mermaid and ELK,
 * into src/ui-fmc.bundle.js, which the Worker serves at /inbox/fmc.js, and the inbox imports
 * that when it first shows a stack drawing (ui/stack.js).
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import mermaidApi from 'mermaid';
// Mermaid's own ELK layout, which `layout` wraps (scripts/ui-markdown.mjs resolves it).
import { render as elkRender } from 'mermaid-elk-render';
import {
  mermaid as plan, stackDiagram,
} from './fmc.js';

export { plan, stackDiagram };

const SVG = 'http://www.w3.org/2000/svg';

/**
 * The sizes of nodes by importance, `[width, height]` in pixels: few, so similar nodes are the
 * same size. A person is taller, for the figure above its label.
 */
export const SIZES = {
  s: [96, 36], m: [132, 40], l: [176, 56], xl: [240, 88],
};
const PAD = 8;
const PERSON = 1.8;
const CHANNEL = 14;

/**
 * ELK's options for the whole drawing (Mermaid sets those inside groups): the gaps between the
 * layers make the edges neither too short nor too long, the others keep edges off each other
 * and off nodes; the crossing minimization is thorough, the placement favors straight edges.
 */
const ELK_OPTIONS = {
  'elk.layered.spacing.nodeNodeBetweenLayers': 36,
  'elk.spacing.nodeNode': 32,
  'elk.layered.spacing.edgeNodeBetweenLayers': 20,
  'elk.spacing.edgeEdge': 14,
  'elk.spacing.edgeNode': 16,
  'elk.layered.thoroughness': 28,
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.nodePlacement.favorStraightEdges': true,
};

/**
 * ELK's options inside groups, which Mermaid sets for its own look (wide gaps, deep padding):
 * set again on every group of an FMC drawing before ELK lays it out (`tune`), tighter, so a
 * stack fits the popover; the edges still keep their distance from each other and from nodes.
 */
const GROUP_OPTIONS = {
  'spacing.baseValue': 16,
  'spacing.nodeNode': 28,
  'elk.layered.spacing.nodeNodeBetweenLayers': 28,
  'elk.layered.spacing.edgeNodeBetweenLayers': 16,
  'elk.spacing.edgeEdge': 12,
  'elk.spacing.edgeNode': 14,
  'elk.padding': '[top=12,left=12,bottom=12,right=12]',
};

/** Sets `GROUP_OPTIONS` on every group of an ELK graph, where Mermaid has set its own. */
function tune(node) {
  for (const child of node.children || []) {
    if (child.children && child.children.length) {
      child.layoutOptions = { ...child.layoutOptions };
      for (const [k, v] of Object.entries(GROUP_OPTIONS)) {
        // ELK reads `spacing.nodeNode` and `elk.spacing.nodeNode` as one option: set the one
        // Mermaid set, so there are not two.
        const short = k.replace(/^elk\./, '');
        const long = `elk.${short}`;
        const at = [short, long].find((name) => name in child.layoutOptions) || k;
        child.layoutOptions[at] = v;
      }
      tune(child);
    }
  }
}

/** The plan of the drawing being laid out, for `layout`; one drawing at a time. */
let current = null;
let queue = Promise.resolve();
let count = 0;

/** How wide `text` is in `font`, in pixels. */
let ruler = null;
function measure(text, font) {
  ruler = ruler || document.createElement('canvas').getContext('2d');
  ruler.font = font;
  return ruler.measureText(text).width;
}

/**
 * The size of each node of the plan: the size of its importance, made wide enough for the
 * longest word and tall enough for the most lines of any node of the same size and kind, so
 * they stay alike. `{ [mermaid id]: { w, h } }`.
 */
export function nodeSizes(p, { font, line }) {
  const out = {};
  const sets = new Map();
  for (const [id, n] of p.nodes) {
    if (n.kind !== 'channel' && n.kind !== 'text') {
      const k = `${n.kind === 'person' ? 'person' : 'node'}:${n.size}`;
      sets.set(k, [...(sets.get(k) || []), id]);
    }
  }
  for (const [k, ids] of sets) {
    const [base, tall] = SIZES[p.nodes.get(ids[0]).size];
    const person = k.startsWith('person');
    const words = Math.max(0, ...ids.flatMap((id) => String(p.nodes.get(id).label).split(/\s+/)
      .map((wd) => measure(wd, font))));
    const w = Math.ceil(Math.max(base, words + 2 * PAD + 2));
    const inner = w - 2 * PAD;
    const lines = Math.max(1, ...ids.map((id) => Math.ceil(
      measure(p.nodes.get(id).label, font) / inner,
    )));
    const h = Math.ceil(Math.max(tall * (person ? PERSON : 1), lines * line + 2 * PAD
      + (person ? tall * (PERSON - 1) : 0)));
    for (const id of ids) {
      out[id] = { w, h };
    }
  }
  return out;
}

/** Mermaid's ELK layout, with the nodes sized and shaped as FMC's and its edges laid out. */
async function layout(data, svg, helpers, options) {
  const p = current;
  if (p) {
    const { sizes } = p;
    for (const node of data.nodes) {
      const n = p.nodes.get(node.id);
      if (n && n.kind === 'channel') {
        node.shape = 'stateStart';
        node.width = CHANNEL;
        node.height = CHANNEL;
      } else if (n && sizes[node.id]) {
        const { w, h } = sizes[node.id];
        node.shape = n.kind === 'storage' ? 'roundedRect' : 'squareRect';
        node.padding = PAD;
        node.labelPaddingX = PAD;
        node.wrappingWidth = w - 2 * PAD;
        node.minWidth = w - 2 * PAD;
        node.height = h;
        // A blank label has no width for the minimum to widen: the node takes its own.
        if (!String(n.label).trim()) {
          node.width = w;
        }
      }
    }
    // The Mermaid edges are the plan's, in order: an edge laid out upwards swaps its ends.
    p.ids = [];
    data.edges.forEach((edge, i) => {
      p.ids.push(edge.id);
      if (p.edges[i]?.up) {
        Object.assign(edge, {
          start: edge.end,
          end: edge.start,
          arrowTypeStart: edge.arrowTypeEnd,
          arrowTypeEnd: edge.arrowTypeStart,
        });
      }
    });
    Object.assign(data.config.elk, {
      mergeEdges: true, lineHops: false, straightenEdges: true, forceNodeModelOrder: p.order,
    });
  }
  return elkRender(data, svg, helpers, {
    ...options,
    rootLayoutOptions: p ? ELK_OPTIONS : undefined,
  });
}

// Mermaid's ELK layout creates its own ELK: its layout is ours while an FMC drawing is laid out.
const elkLayout = ELK.prototype.layout;
ELK.prototype.layout = function layoutFmc(graph, ...rest) {
  if (current) {
    tune(graph);
  }
  return elkLayout.call(this, graph, ...rest);
};

mermaidApi.registerLayoutLoaders([{ name: 'elk', algorithm: 'elk.layered', loader: async () => ({ render: layout }) }]);

const make = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
};

/** `translate(x, y)` as `{ x, y }`. */
const at = (el) => {
  const m = /translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)/.exec(el?.getAttribute('transform') || '');
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
};

/** An edge's points, as Mermaid keeps them on its path (`data-points`, base64 JSON). */
const pointsOf = (path) => {
  try {
    return JSON.parse(atob(path.getAttribute('data-points') || ''));
  } catch {
    return [];
  }
};

/** The stick figure of a person, for a node `w` wide whose top is at `top`, `size` tall. */
function figure(top, size) {
  const s = size / 24;
  const y = (v) => (top + v * s).toFixed(1);
  const x = (v) => (v * s).toFixed(1);
  return make('path', {
    class: 'fmc-figure',
    d: `M${x(0)},${y(6.5)} m${x(-3)},0 a${x(3)},${x(3)} 0 1,0 ${x(6)},0 a${x(3)},${x(3)} 0 1,0 ${x(-6)},0`
      + ` M${x(0)},${y(9.5)} L${x(0)},${y(16)} M${x(-6)},${y(12)} L${x(6)},${y(12)}`
      + ` M${x(0)},${y(16)} L${x(-5)},${y(22)} M${x(0)},${y(16)} L${x(5)},${y(22)}`,
  });
}

/**
 * Makes Mermaid's drawing FMC's (see the top of this file), in place: classes for the
 * stylesheet, no styles of Mermaid's, and FMC's shapes where Mermaid has none.
 */
function finish(svg, p, id) {
  svg.querySelectorAll('style, filter, linearGradient').forEach((el) => el.remove());
  svg.querySelectorAll('[style]').forEach((el) => {
    if (!el.closest('foreignObject')) {
      el.removeAttribute('style');
    }
  });
  svg.querySelectorAll('foreignObject [style]').forEach((el) => {
    // A label's layout stays; its colors go.
    el.style.removeProperty('color');
    el.style.removeProperty('fill');
    el.style.removeProperty('background-color');
  });
  // A node's label as wide as Mermaid measured it, centered in it.
  svg.querySelectorAll('g.node > g.label > foreignObject').forEach((fo) => {
    const div = fo.firstElementChild;
    if (div) {
      div.style.width = `${fo.getAttribute('width')}px`;
      div.style.maxWidth = `${fo.getAttribute('width')}px`;
      div.style.textAlign = 'center';
    }
  });
  svg.removeAttribute('style');
  svg.removeAttribute('width');
  const box = (svg.getAttribute('viewBox') || '0 0 0 0').split(/\s+/).map(Number);
  svg.setAttribute('width', String(Math.ceil(box[2])));
  svg.setAttribute('height', String(Math.ceil(box[3])));
  svg.classList.add('fmc');
  svg.setAttribute('data-direction', p.direction);
  const nodeEls = new Map();
  for (const el of svg.querySelectorAll('g.node')) {
    const m = new RegExp(`^${id}-flowchart-(.+)-\\d+$`).exec(el.id);
    const n = m && p.nodes.get(m[1]);
    if (n) {
      nodeEls.set(m[1], el);
      el.classList.add('fmc-node', `fmc-${n.kind}`);
      if (n.kind !== 'channel' && n.kind !== 'text') {
        el.classList.add(`fmc-size-${n.size}`);
      }
      if (n.code) {
        el.classList.add('fmc-code');
      }
      if (n.id && /^part:\d+$/.test(n.id)) {
        el.setAttribute('data-part', n.id.slice(5));
        el.setAttribute('tabindex', '0');
      }
    }
  }
  const names = [];
  for (const el of svg.querySelectorAll('g.cluster')) {
    const g = p.groups.get(el.id.slice(id.length + 1));
    if (g) {
      let depth = 0;
      for (let up = g.parent; up; up = p.groups.get(up)?.parent) {
        depth += 1;
      }
      el.classList.add('fmc-group', `fmc-group-${g.kind}`, `fmc-depth-${Math.min(depth, 3)}`);
      const rect = el.querySelector(':scope > rect');
      // The group's name at its top left, over the edges that come in there (on the group's
      // grey, ui/spectrum-inbox.css), so none runs through it.
      const name = el.querySelector(':scope > g.cluster-label');
      if (rect && name) {
        const fo = name.querySelector('foreignObject');
        const text = make('text', {
          class: `fmc-group-name fmc-depth-${Math.min(depth, 3)} fmc-group-${g.kind}`,
          x: Number(rect.getAttribute('x')) + PAD,
          y: at(name).y + Number(fo?.getAttribute('height') || 18) * 0.72,
        });
        text.textContent = name.textContent.trim();
        if (text.textContent) {
          names.push(text);
        }
        name.remove();
      }
      if (rect && g.kind === 'storage') {
        rect.setAttribute('rx', '16');
        rect.setAttribute('ry', '16');
      }
      if (rect && g.kind === 'bundle') {
        const inner = rect.cloneNode();
        const inset = (k, d) => String(Number(rect.getAttribute(k)) + d);
        inner.setAttribute('x', inset('x', 3));
        inner.setAttribute('y', inset('y', 3));
        inner.setAttribute('width', inset('width', -6));
        inner.setAttribute('height', inset('height', -6));
        inner.setAttribute('class', 'fmc-bundle-inner');
        rect.after(inner);
      }
    }
  }
  const root = svg.querySelector('g.root') || svg;
  if (names.length) {
    const layer = make('g', { class: 'fmc-group-names' });
    layer.append(...names);
    root.append(layer);
    // Each on its group's grey, so an edge that comes in there runs under it, not through it.
    for (const text of names) {
      const b = text.getBBox();
      if (b.width) {
        text.before(make('rect', {
          class: text.getAttribute('class').replace('fmc-group-name', 'fmc-group-name-bg'),
          x: b.x - 3,
          y: b.y,
          width: b.width + 6,
          height: b.height,
        }));
      }
    }
  }
  // Storages are rounded at their ends; persons have a figure over their label; a node of
  // many is a stack of them; text has no frame.
  for (const [mid, el] of nodeEls) {
    const n = p.nodes.get(mid);
    const rect = el.querySelector(':scope > rect, :scope > g > rect.basic');
    if (n.kind === 'channel') {
      const c = el.querySelector('circle');
      if (c) {
        c.setAttribute('r', String(CHANNEL / 2));
        c.setAttribute('class', 'fmc-channel-circle');
      }
    } else if (rect) {
      const w = Number(rect.getAttribute('width'));
      const h = Number(rect.getAttribute('height'));
      rect.classList.add('fmc-shape');
      if (n.kind === 'storage') {
        const r = Math.min(w, h) / 2;
        rect.setAttribute('rx', String(r));
        rect.setAttribute('ry', String(r));
      }
      if (n.kind === 'text') {
        rect.remove();
      }
      if (n.kind === 'person') {
        const lab = el.querySelector(':scope > g.label');
        const fo = lab?.querySelector('foreignObject');
        const lh = Number(fo?.getAttribute('height') || 0);
        const size = Math.min(h - lh - 3 * PAD, 40);
        el.insertBefore(figure(-h / 2 + PAD, size), lab);
        if (lab) {
          lab.setAttribute('transform', `translate(${at(lab).x}, ${(h / 2 - PAD - lh).toFixed(1)})`);
        }
      }
      if (n.many) {
        const back = rect.cloneNode();
        back.setAttribute('x', String(Number(rect.getAttribute('x')) + 6));
        back.setAttribute('y', String(Number(rect.getAttribute('y')) - 6));
        back.setAttribute('class', 'fmc-shape fmc-many-back');
        rect.before(back);
        for (let k = 0; k < 3; k += 1) {
          el.insertBefore(make('circle', {
            class: 'fmc-dot', r: 1.2, cx: w / 2 - 4 + k * 3, cy: -h / 2 - 1 - k * 2.6,
          }), rect);
        }
      }
    }
  }
  // Edges: classes by kind and the flow they draw; modify access as a pair of arcs.
  const paths = new Map([...svg.querySelectorAll('path[data-id]')].map((el) => [el.getAttribute('data-id'), el]));
  p.ids.forEach((eid, i) => {
    const e = p.edges[i];
    const el = paths.get(eid);
    if (!e || !el) {
      return;
    }
    el.classList.add('fmc-edge', `fmc-edge-${e.kind}`);
    if (e.flow != null) {
      el.setAttribute('data-flow', String(e.flow));
    }
    const label = svg.querySelector(`g.edgeLabel [data-id="${eid}"]`)?.closest('g.edgeLabel');
    if (label && e.flow != null) {
      label.setAttribute('data-flow', String(e.flow));
    }
    const pts = pointsOf(el);
    const [a, b] = [pts[0], pts[pts.length - 1]];
    if (e.kind === 'modify' && pts.length && (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1)) {
      const vertical = Math.abs(a.x - b.x) < 1;
      const d = 7;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const bow = Math.min(14, len / 2);
      const arc = (s, t, side) => {
        const [ox, oy] = vertical ? [side * d, 0] : [0, side * d];
        const [bx, by] = vertical ? [side * bow, 0] : [0, side * bow];
        return `M${s.x + ox},${s.y + oy} Q${(s.x + t.x) / 2 + ox + bx},${(s.y + t.y) / 2 + oy + by} ${t.x + ox},${t.y + oy}`;
      };
      const end = el.getAttribute('marker-end');
      const back = el.cloneNode();
      el.setAttribute('d', arc(a, b, -1));
      back.setAttribute('d', arc(b, a, 1));
      el.removeAttribute('marker-start');
      back.removeAttribute('marker-start');
      if (end) {
        back.setAttribute('marker-end', end);
      }
      back.removeAttribute('data-id');
      el.after(back);
    }
  });
  // Request channels: an R by the circle, and an arrow the way the request goes.
  for (const [c, ch] of p.channels) {
    const el = nodeEls.get(c);
    if (el) {
      if (ch.flow != null) {
        el.setAttribute('data-flow', String(ch.flow));
      }
      el.classList.add(`fmc-channel-${ch.kind}`);
      if (ch.kind === 'request') {
        const o = at(el);
        const from = at(nodeEls.get(ch.from));
        const to = at(nodeEls.get(ch.to));
        const vertical = Math.abs(to.y - from.y) >= Math.abs(to.x - from.x);
        const sign = vertical ? Math.sign(to.y - from.y) || 1 : Math.sign(to.x - from.x) || 1;
        const mark = make('g', { class: 'fmc-request', transform: vertical ? 'translate(11, -3)' : 'translate(-3, 11)' });
        const tri = vertical
          ? `M2,${sign > 0 ? 3 : 9} l6,0 l-3,${sign > 0 ? 6 : -6} z`
          : `M${sign > 0 ? 0 : 6},9 l0,6 l${sign > 0 ? 6 : -6},-3 z`;
        mark.append(make('path', { class: 'fmc-request-arrow', d: tri }));
        const r = make('text', vertical ? { x: 9, y: 0 } : { x: 8, y: 6 });
        r.textContent = 'R';
        mark.append(r);
        if (o) {
          el.append(mark);
        }
      }
    }
  }
  svg.querySelectorAll('marker').forEach((m) => m.classList.add('fmc-marker'));
}

/** The font of `host`, as canvas and Mermaid take it, and its line height. */
function fontOf(host) {
  const cs = window.getComputedStyle(host);
  const size = parseFloat(cs.fontSize) || 14;
  return {
    family: cs.fontFamily,
    size,
    font: `${cs.fontWeight} ${size}px ${cs.fontFamily}`,
    line: Math.ceil(size * 1.5),
  };
}

async function drawNow(host, diagram) {
  const started = performance.now();
  const p = plan(diagram);
  const f = fontOf(host);
  p.sizes = nodeSizes(p, f);
  count += 1;
  const id = `fmc${count}`;
  mermaidApi.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'neutral',
    look: 'classic',
    htmlLabels: true,
    fontFamily: f.family,
    themeVariables: { fontFamily: f.family, fontSize: `${f.size}px` },
    flowchart: { htmlLabels: true, padding: PAD },
  });
  current = p;
  let svg;
  try {
    ({ svg } = await mermaidApi.render(id, p.text));
  } finally {
    current = null;
  }
  const made = document.createElement('template');
  made.innerHTML = svg;
  host.replaceChildren(made.content);
  const el = host.querySelector('svg');
  finish(el, p, id);
  return { plan: p, text: p.text, ms: performance.now() - started };
}

/**
 * Draws `diagram` (src/fmc.js) into `host`, as an SVG element it holds alone, in its font:
 * `{ plan, text, ms }`, the plan, the Mermaid text and how long it took. One at a time.
 */
export function draw(host, diagram) {
  const run = queue.then(() => drawNow(host, diagram));
  queue = run.catch(() => {});
  return run;
}

/**
 * Draws Mermaid `text` into `host` as Mermaid itself does, with none of FMC's sizes, shapes or
 * classes: how GitHub would draw the text of a plan (its own colors, ELK or not).
 */
export function drawText(host, text) {
  const run = queue.then(async () => {
    count += 1;
    mermaidApi.initialize({ startOnLoad: false, securityLevel: 'strict' });
    const { svg } = await mermaidApi.render(`mmd${count}`, text);
    const made = document.createElement('template');
    made.innerHTML = svg;
    host.replaceChildren(made.content);
  });
  queue = run.catch(() => {});
  return run;
}

/** Draws a stack drawing (src/stack.js `stackView`) into `host`, as `draw` does. */
export function drawStack(host, view, options) {
  return draw(host, stackDiagram(view, options));
}
