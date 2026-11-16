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
 * The FMC gallery, at /__dev/fmc in `npm run ui:dev`: the figures of the FMC visualization
 * guidelines (https://www.fmc-modeling.org/visualization_guidelines), each original next to the
 * same structure as DOT, drawn by src/fmc.js as the inbox draws a stack and by D2 (the prototype,
 * POST /__dev/d2, scripts/dev-ui-d2.mjs), and the stack drawings of the fake data, both ways.
 * `?layout=dagre` has D2 lay them out with dagre instead of ELK. The originals load from
 * fmc-modeling.org; nothing of theirs is in here
 * but what the figures show, written again as DOT.
 */

import { parseStack, stackFile, stackView } from '../src/stack.js';
import { ACME_STACK } from './dev-ui-kb.mjs';

const FIG = (n) => `https://www.fmc-modeling.org/images/visualization_guidelines/FMC-VisualizationGuidelines-${n}.gif`;

/** Each figure: what it shows, which of its sides is the good one, and the good one as DOT. */
export const FIGURES = [{
  n: 4,
  title: 'Rounded vs. angular corners of edges',
  good: 'left',
  dots: [`digraph f4 {
  graph [nodesep=0.6, ranksep=0.45];
  node [shape=box, fixedsize=true, width=0.55, height=0.55];
  A -> B; A -> C;
}`],
}, {
  n: 5,
  title: 'Edge tree vs. multiple edges',
  good: 'left',
  dots: [`graph f5 {
  graph [nodesep=0.35, ranksep=0.4];
  node [shape=box, fixedsize=true, width=0.7, height=0.2, label=""];
  top -- a; top -- b; top -- c;
}`],
}, {
  n: 6,
  title: 'Good vs. bad arrangement of edges: not too close to a node',
  good: 'left',
  dots: [`digraph f6 {
  graph [nodesep=0.9, ranksep=0.35];
  node [shape=box, fixedsize=true, width=0.6, height=0.6, label=""];
  T; { rank=same; L; R; }
  T -> L [style=invis]; T -> R [style=invis];
  L -> R;
}`],
}, {
  n: 7,
  title: 'Good vs. bad arrangement of edges: distance between edges',
  good: 'left',
  dots: [`digraph f7 {
  graph [nodesep=1.1, ranksep=0.6];
  node [shape=box, fixedsize=true, width=0.55, height=0.55];
  { rank=same; A; B; } { rank=same; C; D; }
  A -> C; A -> B [dir=back]; C -> B; A -> D; C -> D; D -> B;
}`],
}, {
  n: 8,
  title: 'Good vs. bad length of edges',
  good: 'left',
  dots: [`digraph f8 {
  graph [nodesep=0.7];
  node [shape=box, fixedsize=true, width=0.55, height=0.55];
  { rank=same; A; B; } A -> B;
}`],
}, {
  n: 9,
  title: 'Good vs. bad arrangement of nodes: none of the edges cross',
  good: 'left',
  dots: [`graph f9 {
  graph [nodesep=0.35, ranksep=0.3];
  node [shape=box, fixedsize=true, width=0.6, height=0.35];
  A; { rank=same; D; B; E; } C;
  A -- B; D -- B; B -- E; B -- C; A -- D; A -- E; D -- C; E -- C;
}`],
}, {
  n: 10,
  title: 'Modified vs. unmodified shape and area of nodes',
  good: 'left',
  dots: [`graph f10 {
  graph [nodesep=0.25, ranksep=0.3];
  node [shape=box, fixedsize=true, width=0.55, height=0.35];
  { rank=same; A; B; D [width=0.6, height=1.1]; }
  C [width=1.5];
  A -- C; B -- C; B -- D; C -- D [constraint=false];
}`],
}, {
  n: 11,
  title: 'Enumeration of several nodes of a well-known set',
  good: 'both',
  dots: [`graph f11a {
  graph [nodesep=0.3, ranksep=0.3];
  node [shape=box, fixedsize=true, width=0.6, height=0.5];
  A [width=1.7, height=0.3]; C [multi=true];
  A -- B; A -- C;
}`, `graph f11b {
  graph [nodesep=0.2, ranksep=0.3];
  node [shape=box, fixedsize=true, width=0.6, height=0.5];
  A [width=2.4, height=0.3]; dots [fmc=dots, width=0.3, height=0.2];
  C1 [label="C\u2081"]; C6 [label="C\u2086"];
  { rank=same; B; C1; dots; C6; }
  C1 -- dots -- C6 [style=invis];
  A -- B; A -- C1; A -- C6;
}`],
}, {
  n: 13,
  title: 'Harmonized vs. not harmonized layout',
  good: 'left',
  note: 'Graphviz puts E and F on one rank between the tall A and C; the original has F a row below E.',
  dots: [`graph f13 {
  graph [nodesep=0.3, ranksep=0.3];
  node [shape=box, fixedsize=true, width=0.55, height=0.55];
  B [width=1.4, height=0.45]; D [width=1.4, height=0.45];
  A [width=0.55, height=1.4]; C [width=0.55, height=1.4];
  { rank=same; A; E; F; C; }
  B -- E; B -- F; A -- E; E -- F [style=invis]; F -- C; E -- D; F -- D; A -- F; E -- C;
}`],
}, {
  n: 14,
  title: 'Easy vs. difficult distinction of edges and nodes: node lines twice as thick',
  good: 'left',
  note: 'The corner nodes overlap a in the original; here they are connected to it.',
  dots: [`graph f14 {
  graph [nodesep=0.9, ranksep=0.3];
  node [shape=box, fixedsize=true, width=0.55, height=0.45];
  a [width=1.3, height=1.1];
  { rank=same; b; c; } { rank=same; d; e; }
  b -- a; c -- a; a -- d; a -- e;
}`],
}, {
  n: 17,
  title: 'Colors for the visibility of groups: grey areas, nested ones darker',
  good: 'left',
  dots: [`digraph f17 {
  graph [nodesep=0.2, ranksep=0.2];
  node [shape=box, fixedsize=true, label="", width=0.55, height=0.4];
  subgraph cluster_all { fmc=group; label="";
    subgraph cluster_left { fmc=group; label=""; l1 [width=0.8, height=0.3]; l2 [width=0.8, height=0.75]; }
    big [width=1.1, height=1.0];
    subgraph cluster_right { fmc=group; label=""; r1 [width=0.3, height=0.25]; r2 [width=0.3, height=0.5]; }
    m1 [width=0.5, height=0.5];
    subgraph cluster_bottom { fmc=group; label=""; b1 [width=0.3, height=0.25]; b2 [width=0.55, height=0.25]; }
  }
  l1 -> l2 [style=invis]; r1 -> r2 [style=invis]; big -> m1 [style=invis]; big -> b1 [style=invis]; big -> b2 [style=invis];
}`],
}, {
  n: 19,
  title: 'Layer models: the higher layer depends on the lower one',
  good: 'both',
  dots: [`digraph f19 {
  graph [ranksep=0.02];
  node [shape=box, fixedsize=true, width=1.3, height=0.32];
  l4 [label="Layer 4"]; l3 [label="Layer 3"]; l2 [label="Layer 2"]; l1 [label="Layer 1"];
  l4 -> l3 -> l2 -> l1 [style=invis];
}`],
}, {
  n: 21,
  title: 'A u-shaped node stresses that it is the environment of the others',
  good: 'both',
  dots: [`graph f21 {
  graph [nodesep=0.5, ranksep=0.35];
  node [shape=box, fixedsize=true, width=0.7, height=0.35];
  subgraph cluster_env { fmc=ushape; label="Environment"; labelloc=b; margin=18;
    node [fmc=wall, width=0.01, height=0.01, label=""];
    { rank=same; wl; A [fmc=agent, width=0.7, height=0.35, label="A"]; C [fmc=agent, width=0.7, height=0.35, label="C"]; wr; }
    { rank=same; B [fmc=agent, width=0.7, height=0.35, label="B"]; D [fmc=agent, width=0.7, height=0.35, label="D"]; }
    { rank=same; w1; w2; }
  }
  wl -- A -- C -- wr; A -- B; C -- D; B -- w1; D -- w2;
}`],
}, {
  n: 23,
  title: 'Simple vs. complex read/write access to a channel',
  good: 'left',
  dots: [`digraph f23 {
  graph [ranksep=0.5];
  node [shape=box, fixedsize=true, width=0.7, height=0.35];
  c [fmc=channel, label="", width=0.16, height=0.16];
  A -> c -> B [dir=none];
}`],
}, {
  n: 24,
  title: 'Grouping unrelated agents (top) and storages (bottom) to reduce edges',
  good: 'left',
  dots: [`digraph f24a {
  graph [rankdir=LR, nodesep=0.15, ranksep=0.4, compound=true];
  node [shape=box, fixedsize=true, width=0.9, height=0.35];
  X [width=0.4, height=0.9];
  c [fmc=channel, label="", width=0.16, height=0.16];
  subgraph cluster_ab { fmc=set; label=""; A; B; }
  X -> c [dir=none]; c -> A [dir=none, lhead=cluster_ab];
}`, `digraph f24b {
  graph [nodesep=0.15, ranksep=0.45, compound=true];
  node [shape=box, fixedsize=true, width=0.75, height=0.35, fmc=storage, style=rounded];
  L [fmc=agent, style="", width=1.6];
  subgraph cluster_mn { fmc=set; style=rounded; label=""; M; N; }
  L -> M [dir=both, lhead=cluster_mn];
}`],
}, {
  n: 25,
  title: 'Grouping of related nodes: structured agents and storages',
  good: 'both',
  dots: [`digraph f25 {
  graph [nodesep=0.25, ranksep=0.25, compound=true, fontsize=12];
  node [shape=box, fixedsize=true, width=0.95, height=0.32];
  subgraph cluster_b1 { fmc=agent; label="";
    p1 [fmc=person, label="", width=0.4, height=0.5];
    r1 [fmc=channel, label="", request=true, width=0.5, height=0.16];
    b1 [label="Browser"];
  }
  dots [fmc=dots, width=0.3, height=0.3];
  subgraph cluster_b2 { fmc=agent; label="";
    p2 [fmc=person, label="", width=0.4, height=0.5];
    r2 [fmc=channel, label="", request=true, width=0.5, height=0.16];
    b2 [label="Browser"];
  }
  h1 [fmc=channel, label="HTTP", labelloc=l, request=true, width=1.1, height=0.16];
  h2 [fmc=channel, label="HTTP", labelloc=l, request=true, width=1.1, height=0.16];
  ws [label="University web server", width=3.6];
  subgraph cluster_mat { fmc=storage; label="Lecture and seminar material";
    node [fmc=storage, style=rounded, width=1.2, height=0.28];
    subgraph cluster_se { fmc=storage; label="Lecture Software Engineering";
      { rank=same; s1 [label="Lecture 1"]; s2 [label="Lecture 2"]; }
      { rank=same; s3 [label="Lecture 3"]; s4 [label="Lecture 4"]; }
    }
    vdots [fmc=dots, width=0.2, height=0.3];
    subgraph cluster_sa { fmc=storage; label="Lecture Software Architecture";
      { rank=same; a1 [label="Lecture 1"]; a2 [label="Lecture 2"]; }
      { rank=same; a3 [label="Lecture 3"]; a4 [label="Lecture 4"]; }
    }
  }
  p1 -> dots -> p2 [style=invis, constraint=false];
  p1 -> r1 -> b1 [dir=none]; p2 -> r2 -> b2 [dir=none];
  b1 -> h1 -> ws [dir=none]; b2 -> h2 -> ws [dir=none];
  ws -> s1 [dir=back, lhead=cluster_mat];
  s1 -> s3 [style=invis]; s2 -> s4 [style=invis]; s3 -> vdots -> a1 [style=invis]; a1 -> a3 [style=invis]; a2 -> a4 [style=invis];
}`],
}, {
  n: 26,
  title: 'Arrangement showing a special flow: left to right',
  good: 'both',
  dots: [`digraph f26 {
  graph [rankdir=LR, nodesep=0.2, ranksep=0.18, fontsize=12];
  node [shape=box, fixedsize=true, width=1.15, height=0.5];
  node [fmc=storage, style=rounded];
  chars [label="Characters"]; tokens [label="Tokens"]; phrases [label="Phrases"]; corr [label="Correlated Phrases"]; obj [label="Object Code"];
  node [fmc=agent, style=""];
  subgraph cluster_compiler { fmc=group; label="Compiler"; labelloc=b;
    lexer [label="Lexer"]; tokens; parser [label="Parser"]; phrases; semantor [label="Semantor"]; corr; gen [label="Code Generator"];
  }
  chars -> lexer -> tokens -> parser -> phrases -> semantor -> corr -> gen -> obj;
}`],
}, {
  n: 27,
  title: 'Enumeration of nodes (agents and channels)',
  good: 'both',
  dots: [`digraph f27a {
  graph [ranksep=0.25];
  node [shape=box, fixedsize=true, width=1.2, height=0.45];
  c [fmc=channel, label="", width=0.16, height=0.16];
  B [multi=true];
  A -> c -> B [dir=none];
}`, `digraph f27b {
  graph [nodesep=0.15, ranksep=0.25];
  node [shape=box, fixedsize=true, width=1.2, height=0.45];
  A [width=2.4];
  c1 [fmc=channel, label="", width=0.16, height=0.16]; c2 [fmc=channel, label="", width=0.16, height=0.16];
  B1 [label="B1"]; dots [fmc=dots, width=0.25, height=0.2]; Bn [label="Bn"];
  { rank=same; B1; dots; Bn; } B1 -> dots -> Bn [style=invis];
  A -> c1 -> B1 [dir=none]; A -> c2 -> Bn [dir=none];
}`],
}, {
  n: 28,
  title: 'Structure variance: a dashed storage where the structure changes',
  good: 'both',
  dots: [`digraph f28 {
  graph [nodesep=0.45, ranksep=0.35, compound=true, newrank=true];
  node [shape=box, fixedsize=true, width=0.75, height=0.45];
  A [height=1.6];
  subgraph cluster_var { fmc=storage; dashed=true; class="fmc-grey"; label="";
    { rank=same; B; r [fmc=channel, label="", request=true, width=0.16, height=0.16]; C; }
    { rank=same; E [fmc=storage, style=rounded]; D; }
    c [fmc=channel, label="", width=0.16, height=0.16];
  }
  { rank=same; A; B; }
  B -> r -> C [dir=none]; C -> c -> D [dir=none]; B -> E [dir=both]; E -> D [dir=both, dir=both];
  A -> B [dir=both, lhead=cluster_var];
}`],
}, {
  n: 29,
  title: 'Poor vs. good labeling of a block diagram (the good one, below)',
  good: 'lower',
  dots: [`digraph f29 {
  graph [nodesep=0.3];
  node [shape=box, fixedsize=true, width=1.0, height=0.9];
  white [fmc=person, label="White Player", width=1.25];
  board [fmc=storage, style=rounded, label="Reversi Board", width=1.5, height=0.9];
  black [fmc=person, label="Black Player", width=1.25];
  { rank=same; white; board; black; }
  white -> board -> black [dir=both];
}`],
}, {
  n: 34,
  title: 'Standard arrangement: the environment above and beside, the system of interest in the center',
  good: 'both',
  dots: [`digraph f34 {
  graph [nodesep=0.3, ranksep=0.25, fontsize=12, newrank=true];
  node [shape=box, fixedsize=true, width=0.75, height=0.5];
  subgraph cluster_env { fmc=group; label="Environment (external components)"; labeljust=l;
    node [fmc=person, label="", width=0.45, height=0.55];
    u1; udots [fmc=dots, width=0.3, height=0.3]; u2; u3;
    subgraph cluster_in { fmc=group; label="e.g. Input"; labelloc=b; labeljust=l;
      exin [fmc=storage, style=rounded, label="Ex. Comp.", width=0.75, height=0.6];
    }
    subgraph cluster_band { fmc=group; class="fmc-white"; label="";
      subgraph cluster_sys { fmc=group; class=""; label="System of interest"; labelloc=b;
        node [fmc=agent, label=""];
        A [label="A", width=1.7, height=0.9];
        cab [fmc=channel, request=back, width=0.16, height=0.16];
        B [label="B", width=1.5, height=1.5];
        db [fmc=storage, style=rounded, label="Database", width=1.7, height=0.4];
      }
    }
    subgraph cluster_out { fmc=group; label="e.g. Output"; labelloc=b; labeljust=l;
      exa [fmc=agent, label="Ex. Comp.", width=0.75, height=0.55];
      exs [fmc=storage, style=rounded, label="Ex. Comp.", width=0.75, height=0.5];
    }
    c1 [fmc=channel, label="", width=0.16, height=0.16]; c2 [fmc=channel, label="", width=0.16, height=0.16]; c3 [fmc=channel, label="", width=0.16, height=0.16];
    cbo [fmc=channel, label="", width=0.16, height=0.16];
  }
  { rank=same; u1; udots; u2; u3; }
  { rank=same; exin; A; cab; B; cbo; exa; }
  u1 -> c1 -> A [dir=none]; u2 -> c2 -> A [dir=none]; u3 -> c3 -> B [dir=none];
  exin -> A; A -> cab -> B [dir=none]; B -> cbo -> exa; exa -> exs; A -> db [dir=both];
}`],
}, {
  n: 35,
  title: 'Client-server: many at the top, few at the bottom',
  good: 'both',
  dots: [`digraph f35 {
  graph [nodesep=0.2, ranksep=0.25];
  node [shape=box, fixedsize=true, width=0.85, height=0.42];
  c1n [label="Client 1"]; dots [fmc=dots, width=0.3, height=0.2]; cnn [label="Client n"];
  { rank=same; c1n; dots; cnn; } c1n -> dots -> cnn [style=invis];
  k1 [fmc=channel, label="", width=0.16, height=0.16]; k2 [fmc=channel, label="", width=0.16, height=0.16];
  server [label="Server", width=2.0];
  db [fmc=storage, style=rounded, label="Database", width=2.0];
  c1n -> k1 -> server [dir=none]; cnn -> k2 -> server [dir=none];
  server -> db [dir=both];
}`],
}].map((f) => ({ ...f, gif: FIG(f.n) }));

/** The stack drawings of the fake data: ACME's, one written before Kind, and what Clef saw. */
export function stacks() {
  const legacy = {
    summary: 'A stack.md from before the Kind and Group columns: every part an agent.',
    parts: ACME_STACK.parts.filter((p) => !['person', 'external'].includes(p.kind))
      .map((p) => ({ ...p, kind: undefined })),
    flows: ACME_STACK.flows.filter((f) => !/Shoppers|Authors|Payments/.test(`${f.from}${f.to}`))
      .map((f) => (f.kind === 'read' ? { ...f, from: f.to, to: f.from } : f))
      .map((f) => ({ ...f, kind: undefined })),
  };
  return [{
    title: 'ACME, as the inbox shows it (fake data, scripts/dev-ui-kb.mjs)',
    view: stackView(parseStack(stackFile(ACME_STACK))),
    name: 'ACME',
  }, {
    title: 'The same parts in a stack.md without the Kind column',
    view: stackView(parseStack(stackFile(legacy))),
    name: 'ACME',
  }, {
    title: 'A customer without a drawing: what Clef saw, by layer',
    view: {
      summary: '',
      flows: [],
      layers: [
        { id: 'edge', name: 'Edge', parts: [{ name: 'Fastly', tech: 'fastly', note: '92% sure' }] },
        { id: 'site', name: 'Site', parts: [{ name: 'Edge Delivery', tech: 'eds', note: '88% sure' }, { name: 'AEM Sites', tech: 'aem', note: '40% sure' }] },
        { id: 'content', name: 'Content', parts: [{ name: 'Document Authoring', tech: 'da', note: '75% sure' }] },
        { id: 'martech', name: 'Marketing and insights', parts: [{ name: 'Adobe Target', tech: 'target', note: '30% sure' }] },
      ],
    },
    name: '',
  }];
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/**
 * The gallery page, through `page` (src/page.js, with the pages' stylesheets `scripts`): it
 * imports the renderer the inbox does (/inbox/fmc.js) and draws every figure and stack with it.
 */
export function galleryPage(page, scripts, { layout = 'elk' } = {}) {
  const figures = FIGURES.map((f) => `<section class="fig" id="fig${f.n}"><h2>Figure ${f.n}: ${esc(f.title)}</h2>
<div class="pair"><figure><img src="${esc(f.gif)}" alt="Figure ${f.n} of the FMC visualization guidelines"><figcaption>The original; the ${esc(f.good === 'both' ? 'whole figure is the good example' : `${f.good} one is the good one`)}</figcaption></figure>
<figure><div class="draws">${f.dots.map((d, i) => `<div class="draw" data-dot="${f.n}:${i}"></div>`).join('')}</div><figcaption class="ms"></figcaption></figure>
<figure><div class="draws">${f.dots.map((d, i) => `<div class="draw" data-d2="${f.n}:${i}"></div>`).join('')}</div><figcaption class="ms2"></figcaption></figure></div>
${f.note ? `<p class="note">${esc(f.note)}</p>` : ''}<details><summary>DOT</summary>${f.dots.map((d) => `<pre>${esc(d)}</pre>`).join('')}</details><details><summary>D2</summary>${f.dots.map((d, i) => `<pre data-d2-source="${f.n}:${i}"></pre>`).join('')}</details></section>`).join('\n');
  const views = stacks();
  const stackHtml = views.map((s, i) => `<section class="fig" id="stack${i}"><h2>${esc(s.title)}</h2><div class="pair two"><div><h3>Graphviz</h3><div class="stk-draw"><div class="draw" data-stack="${i}"></div></div><p class="ms"></p></div><div><h3>D2</h3><div class="stk-draw"><div class="draw" data-stack-d2="${i}"></div></div><p class="ms2"></p></div></div><details><summary>DOT</summary><pre data-stack-dot="${i}"></pre></details><details><summary>D2</summary><pre data-stack-d2-source="${i}"></pre></details></section>`).join('\n');
  const data = JSON.stringify({
    dots: Object.fromEntries(FIGURES.flatMap((f) => f.dots.map((d, i) => [`${f.n}:${i}`, d]))),
    stacks: views,
  }).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="en" class="spectrum">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FMC gallery</title>
<link rel="stylesheet" href="spectrum-fonts.css">
<link rel="stylesheet" href="spectrum-tokens.css">
<link rel="stylesheet" href="spectrum.css">
<link rel="stylesheet" href="spectrum-inbox.css">
<style>
body { overflow: auto; background: var(--content); }
main.gallery { display: block; max-width: 1400px; margin: 0px auto; padding: var(--spectrum-spacing-400); }
.gallery h1 { font-size: var(--spectrum-font-size-500); }
.gallery h2 { font-size: var(--spectrum-font-size-200); margin: var(--spectrum-spacing-300) 0px var(--spectrum-spacing-100); }
.gallery .fig { padding: var(--spectrum-spacing-300) 0px; border-top: var(--spectrum-border-width-100) solid var(--line); }
.gallery .pair { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--spectrum-spacing-400); align-items: start; }
.gallery .pair.two { grid-template-columns: 1fr 1fr; }
.gallery h3 { margin: 0px 0px var(--spectrum-spacing-100); font-size: var(--spectrum-font-size-100); color: var(--mute); }
.gallery .cols { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--spectrum-spacing-400); position: sticky; top: 0px; z-index: 1; padding: var(--spectrum-spacing-100) 0px; background: var(--content); font-weight: var(--spectrum-bold-font-weight); }
.gallery figure { margin: 0px; }
.gallery img { max-width: 100%; background: var(--spectrum-gray-50); }
.gallery figcaption, .gallery .ms, .gallery .note { color: var(--mute); font-size: var(--spectrum-font-size-75); }
.gallery .draws { display: flex; flex-wrap: wrap; gap: var(--spectrum-spacing-400); align-items: flex-start; }
.gallery pre { font-size: var(--spectrum-font-size-75); overflow: auto; }
.gallery .fmc { margin: 0px; }
</style>
</head>
<body>
<main class="gallery">
<h1>FMC block diagrams: Graphviz and D2</h1>
<p>Left, each figure of the <a href="https://www.fmc-modeling.org/visualization_guidelines">FMC visualization guidelines</a> as it is there; in the middle, the same structure written as DOT, laid out by Graphviz (<code>@viz-js/viz</code>) and drawn by the inbox's renderer (src/fmc.js); right, the same DOT as D2 source (src/fmcd2.js), laid out and drawn by D2 (<code>@terrastruct/d2</code>, ${layout === 'dagre' ? 'dagre' : 'ELK'}, in Node: POST /__dev/d2), then given the FMC notation D2 has not. Below, the stack drawings of the fake data. Hover a part to light its flows. <a href="?layout=${layout === 'dagre' ? 'elk' : 'dagre'}">D2 with ${layout === 'dagre' ? 'ELK' : 'dagre'}</a></p>
<div class="cols"><span>The original</span><span>Graphviz</span><span>D2</span></div>
${figures}
<h1>Stack drawings</h1>
${stackHtml}
</main>
<script type="module">
const data = ${data};
const layout = ${JSON.stringify(layout === 'dagre' ? 'dagre' : 'elk')};
const d2 = async (body) => {
  const r = await fetch('/__dev/d2?format=json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, layout }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
};
const lightUp = (el, s) => {
  const parts = s.view.layers.flatMap((l) => l.parts);
  const draw = el.closest('.stk-draw');
  el.addEventListener('pointerover', (e) => {
    const g = e.target.closest('[data-part]');
    if (!g) return;
    const i = Number(g.dataset.part);
    const name = parts[i].name.toLowerCase();
    const mine = new Set(s.view.flows.map((f, k) => [f, k]).filter(([f]) => [f.from, f.to].some((x) => x.toLowerCase() === name)).map(([, k]) => String(k)));
    draw.classList.add('lit');
    el.querySelectorAll('[data-flow]').forEach((x) => x.classList.toggle('on', mine.has(x.dataset.flow)));
    el.querySelectorAll('[data-flows]').forEach((x) => x.classList.toggle('on', x.dataset.flows.split(' ').some((k) => mine.has(k))));
    el.querySelectorAll('[data-part]').forEach((x) => x.classList.toggle('on', x === g));
  });
  el.addEventListener('pointerleave', () => draw.classList.remove('lit'));
};
// D2's drawings, all at once (each is a request to the dev server).
const d2Figures = Promise.all([...document.querySelectorAll('[data-d2]')].map(async (el) => {
  try {
    const r = await d2({ dot: data.dots[el.dataset.d2] });
    el.innerHTML = r.svg;
    const svg = el.querySelector('svg');
    svg.setAttribute('width', String(r.width * 1.35));
    svg.setAttribute('height', String(r.height * 1.35));
    document.querySelector('[data-d2-source="' + el.dataset.d2 + '"]').textContent = r.source;
    const ms = el.closest('figure').querySelector('.ms2');
    ms.textContent = (ms.textContent ? ms.textContent + ', ' : 'Drawn in ') + r.ms.toFixed(1) + ' ms (Node)';
  } catch (e) { el.textContent = String(e.message || e); }
}));
const d2Stacks = Promise.all([...document.querySelectorAll('[data-stack-d2]')].map(async (el) => {
  const s = data.stacks[Number(el.dataset.stackD2)];
  try {
    const r = await d2({ view: s.view, title: s.name });
    el.innerHTML = r.svg;
    el.closest('.pair > div').querySelector('.ms2').textContent = 'Drawn in ' + r.ms.toFixed(1) + ' ms (Node), ' + Math.round(r.width) + ' by ' + Math.round(r.height) + ' px';
    document.querySelector('[data-stack-d2-source="' + el.dataset.stackD2 + '"]').textContent = r.source;
    lightUp(el, s);
  } catch (e) { el.textContent = String(e.message || e); }
}));
const m = await import('/inbox/fmc.js');
for (const el of document.querySelectorAll('[data-dot]')) {
  try {
    const r = await m.render(data.dots[el.dataset.dot]);
    el.innerHTML = r.svg;
    // As large as the originals are, about.
    const svg = el.querySelector('svg');
    svg.setAttribute('width', String(r.width * 1.35));
    svg.setAttribute('height', String(r.height * 1.35));
    const ms = el.closest('figure').querySelector('.ms');
    ms.textContent = (ms.textContent ? ms.textContent + ', ' : 'Drawn in ') + r.ms.toFixed(1) + ' ms';
  } catch (e) { el.textContent = String(e.message || e); }
}
for (const el of document.querySelectorAll('[data-stack]')) {
  const s = data.stacks[Number(el.dataset.stack)];
  const r = await m.drawStack(s.view, { title: s.name });
  el.innerHTML = r.svg;
  el.closest('.pair > div').querySelector('.ms').textContent = 'Drawn in ' + r.ms.toFixed(1) + ' ms, ' + Math.round(r.width) + ' by ' + Math.round(r.height) + ' px';
  document.querySelector('[data-stack-dot="' + el.dataset.stack + '"]').textContent = r.dot;
  lightUp(el, s);
}
await Promise.all([d2Figures, d2Stacks]);
document.body.dataset.done = '1';
</script>
</body>
</html>`;
  return page(html, scripts);
}
