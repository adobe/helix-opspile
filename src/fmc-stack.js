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
 * A customer's stack drawing (src/stack.js `stackView`) as an FMC block diagram for the runner
 * (src/fmc.js), in the guidelines' standard arrangement:
 *
 * - The people who use the site at the top: the parts of kind `person`, or, when there are
 *   none, its visitors, who request the pages from the first part of the Edge layer (or of
 *   the Site layer, without one) that nothing else sends to.
 * - The site itself, the system of interest, in the middle and taking most of the space: a grey
 *   frame around its layers, each layer a grey frame of its parts (and a part's Group a frame
 *   inside its layer), so the layers read as they always did.
 * - Someone else's systems (`external`) outside that frame, as the guidelines' environment.
 * - Top to bottom, the way the requests go (many at the top, few at the bottom): an agent above
 *   what it reads, writes or asks. The arrows still point the way the data goes.
 *
 * Nodes are one size, and the hubs (the parts with the most flows, at least three) twice as
 * wide: importance, which the guidelines say a node's size shows, is how much depends on it.
 * Each node has `data-part`, each edge `data-flow`, by their order in the view, for ui/stack.js
 * to light a part's flows.
 */

const FLOW = {
  request: 'request', send: 'send', read: 'read', write: 'write', modify: 'modify',
};

/** Markdown as plain text, its code kept in backticks (the runner writes it in monospace). */
const plain = (md) => String(md || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~]/g, '').trim();

/** A flow's label on the drawing: short, as plain text (the whole of it is in the caption). */
function short(md) {
  const text = plain(md);
  return text.length > 26 ? '' : text;
}

/** The flow's kind, as the drawing gives it or as its parts say. */
export function flowKind(flow, kindOf) {
  if (FLOW[flow.kind]) {
    return FLOW[flow.kind];
  }
  const a = kindOf(flow.from) === 'storage';
  const b = kindOf(flow.to) === 'storage';
  if (a && !b) {
    return 'read';
  }
  if (b && !a) {
    return 'write';
  }
  return 'send';
}

/**
 * The diagram of `view` (`{ layers: [{ id, name, parts }], flows, guess? }`). `guess` is a
 * drawing of what Clef saw: its parts say how sure Clef is, under their names.
 */
export function stackDiagram(view, { visitors = 'Visitors', title = '' } = {}) {
  const parts = view.layers.flatMap((l) => l.parts.map((p) => ({ ...p, layer: l.id })));
  const id = new Map(parts.map((p, i) => [p.name.toLowerCase(), `p${i}`]));
  const byName = new Map(parts.map((p) => [p.name.toLowerCase(), p]));
  const kindOf = (name) => byName.get(String(name).toLowerCase())?.kind || 'agent';
  const flows = (view.flows || []).map((f, i) => ({ ...f, i, kind: flowKind(f, kindOf) }))
    .filter((f) => id.has(String(f.from).toLowerCase()) && id.has(String(f.to).toLowerCase()));
  const degree = new Map();
  for (const f of flows) {
    for (const n of [f.from, f.to]) {
      degree.set(n.toLowerCase(), (degree.get(n.toLowerCase()) || 0) + 1);
    }
  }
  const most = Math.max(0, ...degree.values());
  const outside = (p) => p.kind === 'person' || p.kind === 'external';
  const people = parts.filter((p) => p.kind === 'person');
  const inside = parts.filter((p) => !outside(p));
  const env = parts.length > inside.length || !view.guess;

  const groups = [];
  if (env && inside.length) {
    groups.push({ id: 'site', kind: 'area', label: '' });
  }
  for (const l of view.layers) {
    if (!l.parts.some((p) => !outside(p))) {
      // eslint-disable-next-line no-continue
      continue;
    }
    groups.push({
      id: `l-${l.id}`, kind: 'area', label: l.name, parent: env && inside.length ? 'site' : undefined, data: { layer: l.id },
    });
    const named = [...new Set(l.parts.filter((p) => p.group && !outside(p)).map((p) => p.group))];
    for (const [j, g] of named.entries()) {
      groups.push({
        id: `g-${l.id}-${j}`, kind: 'area', label: g, parent: `l-${l.id}`,
      });
    }
  }
  const groupOf = (p) => {
    if (outside(p)) {
      return undefined;
    }
    const l = view.layers.find((x) => x.id === p.layer);
    const named = [...new Set(l.parts.filter((x) => x.group && !outside(x)).map((x) => x.group))];
    return p.group ? `g-${p.layer}-${named.indexOf(p.group)}` : `l-${p.layer}`;
  };
  const kindFor = (p) => ({
    storage: 'storage', channel: 'channel', person: 'person',
  }[p.kind] || 'agent');
  const nodes = [];
  const edges = [];
  if (!people.length && env && visitors) {
    nodes.push({
      id: 'visitors', label: visitors, kind: 'person', title: `${visitors} of the site`,
    });
  }
  for (const [i, p] of parts.entries()) {
    const hub = !view.guess && most >= 3 && degree.get(p.name.toLowerCase()) === most;
    nodes.push({
      id: `p${i}`,
      label: p.name,
      kind: kindFor(p),
      group: groupOf(p),
      size: hub && kindFor(p) !== 'channel' ? [2, 1] : undefined,
      sub: view.guess ? p.note : undefined,
      className: p.kind === 'external' ? 'fmc-ext' : undefined,
      title: p.tip || p.name,
      data: { part: i },
    });
  }
  if (nodes[0]?.id === 'visitors') {
    // The visitors ask the first part in front of the site that nothing sends to.
    const sent = new Set(flows.filter((f) => f.kind === 'request' || f.kind === 'send').map((f) => f.to.toLowerCase()));
    const front = ['edge', 'site'].map((l) => parts.find((p) => p.layer === l && !outside(p) && !sent.has(p.name.toLowerCase())))
      .find(Boolean);
    if (front) {
      edges.push({ from: 'visitors', to: id.get(front.name.toLowerCase()), kind: 'request' });
    } else {
      nodes.shift();
    }
  }
  // The layers stay in their order, top to bottom: a flow from a later layer to an earlier one
  // (content to the site) is laid out from the earlier one, its arrow still the data's way.
  const order = new Map(view.layers.map((l, i) => [l.id, i]));
  const rank = (name) => order.get(byName.get(name.toLowerCase()).layer);
  for (const f of flows) {
    const up = rank(f.from) > rank(f.to) && ['send', 'request'].includes(f.kind);
    edges.push({
      from: id.get(f.from.toLowerCase()),
      to: id.get(f.to.toLowerCase()),
      kind: f.kind,
      label: short(f.label),
      title: `${f.from} → ${f.to}${f.label ? `: ${plain(f.label)}` : ''}`,
      data: { flow: f.i },
      ...(up ? { flip: true } : {}),
    });
  }
  // A layer no flow reaches goes under the one before it.
  const frames = groups.filter((g) => g.id.startsWith('l-'));
  const linked = new Set();
  for (const f of flows) {
    const a = byName.get(f.from.toLowerCase()).layer;
    const b = byName.get(f.to.toLowerCase()).layer;
    if (a !== b) {
      linked.add(a);
      linked.add(b);
    }
  }
  for (let i = 1; i < frames.length; i += 1) {
    if (view.guess || !linked.has(frames[i].data.layer)) {
      edges.push({ from: frames[i - 1].id, to: frames[i].id, hidden: true });
    }
  }
  return {
    title, direction: 'DOWN', nodes, groups, edges, gapY: view.guess ? 16 : undefined,
  };
}
