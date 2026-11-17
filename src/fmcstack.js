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
 * A customer's stack drawing (src/stack.js `stackView`) as an FMC block diagram in DOT, for
 * src/fmc.js to draw. How it reads the drawing:
 *
 *  - The layers are tiers, top to bottom in their order (the n-tier layout: what is in front at
 *    the top, the systems behind it below), each a grey frame with its name. A part's group is
 *    a frame in its layer's.
 *  - People (`person`) are above them all, the environment of the standard arrangement; the
 *    layers are then in a frame of their own, the system of interest, and `external` parts are
 *    beside it in their layer's tier.
 *  - A part is an agent unless it is a `storage` or a `channel`. Parts of about the same
 *    importance are the same size: those with the most flows are larger, whatever their names.
 *  - A flow between two agents goes through a channel, labeled with what passes; a request
 *    flow's channel has the R, pointing from the part that asks. A flow to or from a storage is
 *    its read, write or modify access. Flows within a layer run left to right.
 *
 * Every name is the drawing's own text: DOT strings are quoted here, never written raw.
 */

import { textWidth, wrap, FONT } from './fmc.js';

/* eslint-disable no-continue -- the loops skip the parts and flows that are drawn otherwise */

/** A note's Markdown as one line of text, its code spans kept in backticks. */
export function plainNote(md) {
  return String(md || '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w`])[*_]([^*_]+)[*_](?=[^\w`]|$)/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const q = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
const inch = (px) => (px / 72).toFixed(3);
const pct = (p) => `${Math.round(p * 100)}%`;
/** A row of a layer has at most this many parts; more go on another row. */
const ROW = 6;

const SIZE = {
  agent: [108, 44],
  major: [162, 54],
  person: [92, 52],
};

/** A flow's label on its channel: at most two short lines. */
function channelLabel(text) {
  const plain = String(text || '').replace(/\s+/g, ' ').trim();
  if (!plain) {
    return { text: '', w: 0, lines: 0 };
  }
  const lines = wrap(plain, 104, FONT.small, 2);
  const width = (l) => l.reduce((s, r) => s + textWidth(r.text, FONT.small, r.code), 0);
  const w = Math.max(...lines.map(width));
  return { text: plain, w: Math.min(104, w), lines: lines.length };
}

/**
 * DOT for `view` (`{ layers: [{ id, name, parts }], flows }`), and what its nodes and edges
 * are: `{ dot, parts, flows }`, `parts` in the order the view lists them (`data-part`), `flows`
 * the view's (`data-flow`). `detected`, the customer's technologies `[{ tech, name, p }]`,
 * marks the parts Clef saw; `title` names the system of interest.
 */
export function stackDot(view, { detected = [], title = '' } = {}) {
  const seen = new Map(detected.map((t) => [t.tech, t]));
  const parts = [];
  for (const l of view.layers || []) {
    for (const p of l.parts || []) {
      parts.push({ ...p, layer: l.id, layerName: l.name });
    }
  }
  const at = new Map(parts.map((p, i) => [String(p.name).toLowerCase(), i]));
  const flows = (view.flows || []).map((f, i) => ({
    ...f, i, a: at.get(String(f.from).toLowerCase()), b: at.get(String(f.to).toLowerCase()),
  })).filter((f) => f.a != null && f.b != null && f.a !== f.b);
  const degree = parts.map(() => 0);
  for (const f of flows) {
    degree[f.a] += 1;
    degree[f.b] += 1;
  }
  const most = Math.max(0, ...degree);
  const kindOf = (p) => {
    const k = String(p.kind || '').toLowerCase();
    return ['storage', 'channel', 'person', 'external'].includes(k) ? k : 'agent';
  };
  const layerIds = (view.layers || []).map((l) => l.id);
  const tierOf = (p) => (kindOf(p) === 'person' ? -1 : layerIds.indexOf(p.layer));
  const people = parts.map((p, i) => i).filter((i) => kindOf(parts[i]) === 'person');
  const outside = parts.some((p) => ['person', 'external'].includes(kindOf(p)));

  const lines = [
    'digraph stack {',
    '  graph [newrank=true, nodesep=0.3, ranksep=0.32, fontname="Helvetica", fontsize=12, labeljust=l, pad=0];',
    '  node [shape=box, fixedsize=true, label=""];',
    '  edge [arrowhead=normal];',
  ];
  const nodeLine = (i) => {
    const p = parts[i];
    const kind = kindOf(p);
    const t = p.tech && seen.get(p.tech);
    const note = plainNote(p.note);
    const tip = [p.name, note.replace(/`/g, ''), t ? `${t.name}: ${pct(t.p)} sure from their threads` : '']
      .filter(Boolean).join('\n');
    const attrs = [`label=${q(p.name)}`, `part=${i}`, `tooltip=${q(tip)}`];
    if (note) {
      attrs.push(`note=${q(note)}`);
    }
    if (t) {
      attrs.push('seen=1');
    }
    let [w, h] = degree[i] >= 3 && degree[i] >= most * 0.6 ? SIZE.major : SIZE.agent;
    if (kind === 'person') {
      [w, h] = SIZE.person;
    }
    if (kind === 'channel') {
      const lab = channelLabel(p.name);
      [w, h] = [2 * (6 + 4 + lab.w), Math.max(12, lab.lines * 12.2)];
      attrs[0] = `label=${q(lab.text)}`;
    }
    attrs.push(`fmc=${kind === 'external' ? 'agent' : kind}`, `width=${inch(w)}`, `height=${inch(h)}`);
    if (kind === 'storage') {
      attrs.push('style=rounded');
    }
    return `n${i} [${attrs.join(', ')}];`;
  };

  // The tiers: a rank (or a few, for a long layer) each, in order. Layers without flows that
  // follow one another share one, side by side, when they fit (in a drawing with flows: one
  // without, such as what Clef saw, stays a layer a row).
  const rows = [];
  const flowing = new Set(flows.flatMap((f) => [f.a, f.b]));
  const captions = new Map();
  let shared = null;
  for (const l of view.layers || []) {
    const inside = l.parts.map((p) => at.get(String(p.name).toLowerCase()))
      .filter((i) => kindOf(parts[i]) !== 'person');
    if (!inside.length) {
      continue;
    }
    const still = inside.every((i) => !flowing.has(i));
    if (still && flows.length && shared && shared.length + inside.length <= ROW) {
      // Its name beside its parts, as the row's label names only the first layer of the row.
      captions.set(l.id, inside[0]);
      shared.push(...inside);
      continue;
    }
    for (let k = 0; k < inside.length; k += ROW) {
      rows.push(inside.slice(k, k + ROW));
    }
    shared = still && inside.length < ROW ? rows[rows.length - 1] : null;
  }
  const rowOf = new Map();
  rows.forEach((r, k) => r.forEach((i) => rowOf.set(i, k)));
  const frameOf = (i) => (['person', 'external'].includes(kindOf(parts[i])) ? ''
    : `${parts[i].layer}\u0000${String(parts[i].group || '').trim()}`);

  // The flows: through a channel between agents, straight to a storage or a channel.
  const sameRank = rows.map(() => []);
  const channels = new Map();
  const edges = [];
  const location = (i) => ['storage', 'channel'].includes(kindOf(parts[i]));
  for (const f of flows) {
    const kind = String(f.kind || '').toLowerCase();
    const flat = rowOf.has(f.a) && rowOf.get(f.a) === rowOf.get(f.b);
    const ta = tierOf(parts[f.a]);
    const tb = tierOf(parts[f.b]);
    const ra = rowOf.has(f.a) ? rowOf.get(f.a) : -1;
    const rb = rowOf.has(f.b) ? rowOf.get(f.b) : -1;
    // Upper end first, so the DOT edges run with the ranks; within a row, From on the left.
    const down = flat || ta < tb || (ta === tb && ra <= rb);
    const [u, w] = down ? [f.a, f.b] : [f.b, f.a];
    // Which way the data goes: to To (the default, and write), to From (read), both (modify);
    // a request goes both ways, which its channel's R says.
    const toB = !['read', 'request'].includes(kind);
    const toA = ['read', 'modify'].includes(kind);
    const toW = down ? toB : toA;
    const toU = down ? toA : toB;
    let dir = 'none';
    if (toW && toU) {
      dir = 'both';
    } else if (toW) {
      dir = 'forward';
    } else if (toU) {
      dir = 'back';
    }
    const tag = `flow=${f.i}`;
    if (location(f.a) || location(f.b)) {
      edges.push(`  n${u} -> n${w} [${tag}, dir=${dir}];`);
      continue;
    }
    const lab = channelLabel(f.label);
    const c = `c${f.i}`;
    const req = kind === 'request' ? `, request=${down ? 'true' : 'back'}` : '';
    const [cw, ch] = flat
      ? [Math.max(12, lab.w + 4), 2 * (6 + 4 + lab.lines * 12.2)]
      : [2 * (6 + 4 + (req ? 16 : 0) + lab.w), Math.max(12, lab.lines * 12.2)];
    const line = `${c} [fmc=channel, label=${q(lab.text)}, flow=${f.i}, width=${inch(cw)}, height=${inch(ch)}${flat ? ', labelloc=t' : ''}${req}];`;
    // A channel within a frame when both its parts are, in the system of interest when both
    // are in it, else outside.
    let home = '';
    if (frameOf(f.a) && frameOf(f.b)) {
      home = flat && frameOf(f.a) === frameOf(f.b) ? frameOf(f.a) : 'system';
    }
    if (!channels.has(home)) {
      channels.set(home, []);
    }
    channels.get(home).push(line);
    // Arrows: into the channel and on into the part the data goes to; none on a modify's.
    const piece = dir === 'both' ? 'none' : dir;
    // The channel next to the upper part: the edge to it pulls harder.
    edges.push(`  n${u} -> ${c} [${tag}, dir=${piece}, weight=3];`, `  ${c} -> n${w} [${tag}, dir=${piece}];`);
    if (flat) {
      sameRank[rowOf.get(f.a)].push(c);
    }
  }

  // The system of interest, its layers, their groups.
  const indent = (n) => '  '.repeat(n);
  if (outside) {
    lines.push(`${indent(1)}subgraph cluster_system { fmc=group; label=${q(title)}; labeljust=l; labelloc=b;`);
  }
  const d = outside ? 2 : 1;
  for (const l of view.layers || []) {
    const mine = l.parts.map((p) => at.get(String(p.name).toLowerCase()))
      .filter((i) => frameOf(i));
    if (!mine.length) {
      continue;
    }
    const caption = captions.get(l.id);
    lines.push(`${indent(d)}subgraph ${q(`cluster_layer_${l.id}`)} { fmc=group; stretch=row; layer=${q(l.id)}; label=""${caption == null ? `; rowlabel=${q(l.name)}` : ''};`);
    if (caption != null) {
      const cw = Math.min(110, textWidth(l.name, FONT.label)) + 6;
      lines.push(`${indent(d + 1)}caption_${l.id} [fmc=caption, label=${q(l.name)}, width=${inch(cw)}, height=${inch(30)}];`);
      edges.push(`  caption_${l.id} -> n${caption} [style=invis];`);
      sameRank[rowOf.get(caption)].push(`caption_${l.id}`);
    }
    const groups = new Map();
    for (const i of mine) {
      const g = String(parts[i].group || '').trim();
      if (!groups.has(g)) {
        groups.set(g, []);
      }
      groups.get(g).push(i);
    }
    for (const [g, list] of groups) {
      const k = d + (g ? 2 : 1);
      if (g) {
        lines.push(`${indent(d + 1)}subgraph ${q(`cluster_group_${l.id}_${g}`)} { fmc=group; stretch=""; labelloc=t; labeljust=l; label=${q(g)};`);
      }
      for (const i of list) {
        lines.push(`${indent(k)}${nodeLine(i)}`);
      }
      for (const c of channels.get(`${l.id}\u0000${g}`) || []) {
        lines.push(`${indent(k)}${c}`);
      }
      if (g) {
        lines.push(`${indent(d + 1)}}`);
      }
    }
    lines.push(`${indent(d)}}`);
  }
  for (const c of (outside && channels.get('system')) || []) {
    lines.push(`${indent(2)}${c}`);
  }
  if (outside) {
    lines.push(`${indent(1)}}`);
  }
  for (const c of (!outside && channels.get('system')) || []) {
    lines.push(`  ${c}`);
  }
  for (const i of parts.keys()) {
    if (!frameOf(i)) {
      lines.push(`  ${nodeLine(i)}`);
    }
  }
  for (const c of channels.get('') || []) {
    lines.push(`  ${c}`);
  }
  lines.push(...edges);

  // The order of the tiers, top to bottom, whatever the flows say.
  rows.forEach((r, k) => {
    lines.push(`  { rank=same; ${[...r.map((i) => `n${i}`), ...sameRank[k]].join('; ')}; }`);
    if (k) {
      lines.push(`  n${rows[k - 1][0]} -> n${r[0]} [style=invis, weight=0];`);
    }
  });
  if (people.length) {
    lines.push(`  { rank=min; ${people.map((i) => `n${i}`).join('; ')}; }`);
    if (rows.length) {
      lines.push(`  n${people[0]} -> n${rows[0][0]} [style=invis, weight=0];`);
    }
  }
  lines.push('}');
  return { dot: lines.join('\n'), parts, flows };
}
