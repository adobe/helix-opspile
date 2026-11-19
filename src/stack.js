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
 * A customer's stack drawing: `stack.md` at the root of its knowledge base (`kb-org-<slug>`), a
 * concept of type `Stack Drawing` that the thread agents keep (draw_stack, src/agent/tools.js) and
 * people edit in the knowledge-base editor. It is Markdown that reads as it is: a summary, then
 * two tables, the parts of the stack by layer and the flows between them, then any notes.
 *
 *   ## Parts
 *
 *   | Layer | Part | Tech | Note |
 *   | --- | --- | --- | --- |
 *   | Edge | Akamai | akamai | www.example.com, in front of everything |
 *   | Site | Edge Delivery | eds | the storefront |
 *
 *   ## Flows
 *
 *   | From | To | What |
 *   | --- | --- | --- |
 *   | Akamai | Edge Delivery | every page but /checkout |
 *
 * Optional columns say more, for the inbox to draw it as an FMC block diagram (src/fmcstack.js):
 * a part's Kind (`PART_KINDS`: an agent, the default, does something; a storage keeps what is
 * written to it; a person uses the site; an external part is outside the customer's site) and
 * Group (a frame around the parts of its layer that have the same), and a flow's Kind
 * (`FLOW_KINDS`: by default what is named goes from From to To; `read` is From reading To,
 * `write` From writing To, `modify` both, `request` From asking To, which answers). A file
 * without them reads as it always did.
 *
 * The tables are read and written through a markdown tree (src/mdast.js), never by regular
 * expressions. A write of `stack.md` that is not a drawing is refused (src/agent/okf.js
 * `checkConcept`), whoever writes it, so the inbox can always draw it (GET /api/kb/stack,
 * ui/stack.js).
 *
 * A part's Tech is a technology's id (its path in a team's catalog, src/catalog.js, which readers
 * take through the catalog's moves: a short id from before is the path that lists it), `own` for
 * what the customer built, or empty.
 *
 * The layers are fixed, so every customer's drawing reads the same way, top to bottom. The tech
 * stack's technologies are in one each too (`tech_stack.layer`, migration 0068), and the list by
 * customer names the likeliest of each, in this order (ui/inbox.js `stackLine`).
 */

import { readMarkdown, writeMarkdown } from './mdast.js';
import { isTechId } from './techid.js';

export const STACK_PATH = 'stack.md';
export const STACK_TYPE = 'Stack Drawing';

export const LAYERS = [
  { id: 'edge', name: 'Edge', hint: 'in front of the site: CDN, WAF and bot protection, code at the edge' },
  { id: 'site', name: 'Site', hint: 'what serves the pages: Edge Delivery, AEM publish, a legacy site or storefront' },
  { id: 'content', name: 'Content', hint: 'where authors write and assets live: Document Authoring, SharePoint, Universal Editor, AEM author, Assets, translation' },
  { id: 'code', name: 'Code', hint: 'code hosting, builds and serverless code: GitHub, App Builder, CI jobs' },
  { id: 'commerce', name: 'Commerce and data', hint: 'commerce, product and order data, payments, search, feeds, ERP, PIM, CRM' },
  { id: 'martech', name: 'Marketing and insights', hint: 'analytics, tags, consent, personalization, monitoring, SEO' },
  { id: 'identity', name: 'Identity', hint: 'how people sign in: SSO, Adobe IMS' },
  { id: 'other', name: 'Other', hint: 'anything else the team works with' },
];
export const LAYER_IDS = LAYERS.map((l) => l.id);

/** What a part is (FMC: agents, storages and channels; people and the world outside). */
export const PART_KINDS = ['agent', 'storage', 'channel', 'person', 'external'];
/** What a flow is: data from From to To (empty), or one of these. */
export const FLOW_KINDS = ['read', 'write', 'modify', 'request'];

export const MAX_PARTS = 40;
export const MAX_FLOWS = 60;
const MAX_NAME = 60;
const MAX_NOTE = 300;

const layerById = new Map(LAYERS.map((l) => [l.id, l]));
const key = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The layer a cell names, by its id or its name ("Commerce and data", "commerce"), or null. */
export function layerOf(name) {
  const k = key(name);
  return LAYERS.find((l) => l.id === k || key(l.name) === k) || null;
}

/** A node's text, without its markup. */
function textOf(node) {
  if (!node) {
    return '';
  }
  if (typeof node.value === 'string') {
    return node.value;
  }
  return (node.children || []).map(textOf).join('');
}

/** A table cell's content as one line of Markdown (links and code kept). */
const cellMarkdown = (cell) => writeMarkdown({
  type: 'root', children: [{ type: 'paragraph', children: cell.children || [] }],
}).replace(/\s*\n\s*/g, ' ');

/** Markdown as the inline content of a table cell: one paragraph's, on one line. */
function inline(md) {
  const text = String(md || '').replace(/\s*\n\s*/g, ' ').trim();
  if (!text) {
    return [];
  }
  const first = readMarkdown(text, { tables: false, tasks: false }).children[0];
  return first && first.type === 'paragraph' ? first.children : [{ type: 'text', value: text }];
}

const cell = (children) => ({ type: 'tableCell', children });
const textCell = (s) => cell(s ? [{ type: 'text', value: String(s) }] : []);
const row = (cells) => ({ type: 'tableRow', children: cells });

/** A table's header cells by what they say, `{ part: 1, … }`, and its other rows. */
function columns(table) {
  const [head, ...rows] = table.children || [];
  const at = {};
  (head ? head.children : []).forEach((c, i) => {
    at[key(textOf(c))] = i;
  });
  return { at, rows };
}

/**
 * A drawing from the text of `stack.md` (frontmatter or not): `{ summary, parts, flows, notes }`,
 * where a part is `{ layer, name, tech, note }` and a flow `{ from, to, label }` (the names of
 * its parts), or `{ error }` saying what is wrong, for whoever wrote it.
 */
export function parseStack(text) {
  const body = String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const tree = readMarkdown(body, { tasks: false });
  const summary = [];
  const notes = [];
  const tables = {};
  let section = null;
  for (const node of tree.children) {
    if (node.type === 'heading') {
      const title = key(textOf(node));
      section = title === 'parts' || title === 'flows' ? title : 'notes';
      if (section === 'notes') {
        notes.push(node);
      }
    } else if (!section) {
      summary.push(node);
    } else if (section === 'notes') {
      notes.push(node);
    } else if (node.type === 'table' && !tables[section]) {
      tables[section] = node;
    } else {
      // Text between a heading and its table, or after it, is kept with the notes.
      notes.push(node);
    }
  }
  if (!tables.parts) {
    return { error: 'a stack drawing has a "## Parts" heading with a table under it: | Layer | Part | Tech | Note |' };
  }
  const parts = [];
  const names = new Map();
  const { at: p, rows: partRows } = columns(tables.parts);
  if (p.layer === undefined || p.part === undefined) {
    return { error: 'the parts table needs the columns Layer and Part (Tech and Note are optional)' };
  }
  for (const [i, r] of partRows.entries()) {
    const c = r.children || [];
    const line = `parts, row ${i + 1}`;
    const layer = layerOf(textOf(c[p.layer]));
    const name = textOf(c[p.part]).trim();
    const tech = p.tech === undefined ? '' : textOf(c[p.tech]).trim().toLowerCase();
    const note = p.note === undefined || !c[p.note] ? '' : cellMarkdown(c[p.note]);
    const kind = p.kind === undefined ? '' : key(textOf(c[p.kind]));
    const group = p.group === undefined ? '' : textOf(c[p.group]).trim();
    if (!layer) {
      return { error: `${line}: the layer is one of ${LAYERS.map((l) => l.name).join(', ')}` };
    }
    if (!name || name.length > MAX_NAME) {
      return { error: `${line}: a part has a name of at most ${MAX_NAME} characters` };
    }
    if (names.has(key(name))) {
      return { error: `${line}: there is another part called ${name}; the flows name parts, so each name is once` };
    }
    if (tech && !isTechId(tech)) {
      return { error: `${line}: Tech is the id of a technology of the tech stack (its path in a team's catalog, such as fastly/cdn, or a short id such as akamai), own for what the customer built, or empty` };
    }
    if (note.length > MAX_NOTE) {
      return { error: `${line}: a note has at most ${MAX_NOTE} characters` };
    }
    if (kind && !PART_KINDS.includes(kind)) {
      return { error: `${line}: Kind is one of ${PART_KINDS.join(', ')}, or empty (an agent)` };
    }
    if (group.length > MAX_NAME) {
      return { error: `${line}: a group has a name of at most ${MAX_NAME} characters` };
    }
    names.set(key(name), name);
    parts.push({
      layer: layer.id,
      name,
      tech: tech || null,
      note,
      ...(kind && kind !== 'agent' ? { kind } : {}),
      ...(group ? { group } : {}),
    });
  }
  if (!parts.length) {
    return { error: 'the parts table has no parts' };
  }
  if (parts.length > MAX_PARTS) {
    return { error: `a drawing has at most ${MAX_PARTS} parts: draw the parts that matter` };
  }
  const flows = [];
  if (tables.flows) {
    const { at: f, rows: flowRows } = columns(tables.flows);
    if (f.from === undefined || f.to === undefined) {
      return { error: 'the flows table needs the columns From and To (What is optional)' };
    }
    for (const [i, r] of flowRows.entries()) {
      const c = r.children || [];
      const line = `flows, row ${i + 1}`;
      const from = names.get(key(textOf(c[f.from])));
      const to = names.get(key(textOf(c[f.to])));
      const label = f.what === undefined || !c[f.what] ? '' : cellMarkdown(c[f.what]);
      const kind = f.kind === undefined ? '' : key(textOf(c[f.kind]));
      if (!from || !to) {
        return { error: `${line}: From and To are the names of parts of the parts table` };
      }
      if (from === to) {
        return { error: `${line}: a flow goes from one part to another` };
      }
      if (label.length > MAX_NOTE) {
        return { error: `${line}: What has at most ${MAX_NOTE} characters` };
      }
      if (kind && !FLOW_KINDS.includes(kind)) {
        return { error: `${line}: Kind is one of ${FLOW_KINDS.join(', ')}, or empty (what is named goes from From to To)` };
      }
      flows.push({
        from, to, label, ...(kind ? { kind } : {}),
      });
    }
    if (flows.length > MAX_FLOWS) {
      return { error: `a drawing has at most ${MAX_FLOWS} flows` };
    }
  }
  const md = (children) => (children.length ? writeMarkdown({ type: 'root', children }) : '');
  return {
    summary: md(summary), parts, flows, notes: md(notes),
  };
}

/** Why `text` is not a stack drawing, or null. */
export function checkStack(text) {
  const { error } = parseStack(text);
  return error || null;
}

/**
 * A drawing as the body of `stack.md`: the summary, the parts and flows tables, the notes. Parts
 * are `{ layer, name, kind?, group?, tech?, note? }` (`layer` an id or a name), flows
 * `{ from, to, kind?, label? }`. The Kind and Group columns are written only when a row has one.
 */
export function stackBody({
  summary = '', parts = [], flows = [], notes = '',
}) {
  const order = (x) => LAYER_IDS.indexOf((layerOf(x.layer) || {}).id);
  const sorted = parts.map((x, i) => ({ ...x, i }))
    .sort((a, b) => order(a) - order(b) || a.i - b.i);
  const kindOf = (x) => {
    const k = key(x.kind);
    return k === 'agent' ? '' : k;
  };
  const kinds = sorted.some((x) => kindOf(x));
  const groups = sorted.some((x) => String(x.group || '').trim());
  const partCols = ['Layer', 'Part', ...(kinds ? ['Kind'] : []), ...(groups ? ['Group'] : []), 'Tech', 'Note'];
  const partsTable = {
    type: 'table',
    align: partCols.map(() => null),
    children: [
      row(partCols.map(textCell)),
      ...sorted.map((x) => row([
        textCell((layerOf(x.layer) || { name: x.layer }).name),
        textCell(String(x.name || '').trim()),
        ...(kinds ? [textCell(kindOf(x))] : []),
        ...(groups ? [textCell(String(x.group || '').trim())] : []),
        textCell(String(x.tech || '').trim()),
        cell(inline(x.note)),
      ])),
    ],
  };
  const flowKinds = flows.some((x) => key(x.kind));
  const flowCols = ['From', 'To', ...(flowKinds ? ['Kind'] : []), 'What'];
  const children = [
    ...readMarkdown(String(summary || '').trim()).children,
    { type: 'heading', depth: 2, children: [{ type: 'text', value: 'Parts' }] },
    partsTable,
  ];
  if (flows.length) {
    children.push(
      { type: 'heading', depth: 2, children: [{ type: 'text', value: 'Flows' }] },
      {
        type: 'table',
        align: flowCols.map(() => null),
        children: [
          row(flowCols.map(textCell)),
          ...flows.map((x) => row([
            textCell(String(x.from || '').trim()),
            textCell(String(x.to || '').trim()),
            ...(flowKinds ? [textCell(key(x.kind))] : []),
            cell(inline(x.label)),
          ])),
        ],
      },
    );
  }
  children.push(...readMarkdown(String(notes || '').trim()).children);
  return `${writeMarkdown({ type: 'root', children })}\n`;
}

/** A YAML scalar that is always read back as the string it is (JSON's quoting is YAML's). */
const yamlString = (s) => (/^[\w][\w .,()/&+-]*$/.test(s) && !/:\s|\s#/.test(s) ? s : JSON.stringify(s));

/**
 * The whole of `stack.md`: frontmatter (`type`, `title`, `description`, then the lines of
 * `keep`, the earlier file's frontmatter but those, such as its `sources`) and the drawing.
 */
export function stackFile(drawing, { title = 'Tech stack', keep = '' } = {}) {
  const summary = String(drawing.summary || '').trim();
  const first = summary.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0] || 'How the customer\'s site is put together.';
  const own = new Set(['type', 'title', 'description', 'generated']);
  const kept = [];
  let skip = false;
  for (const line of String(keep || '').split(/\r?\n/)) {
    const top = /^([A-Za-z_][\w-]*):/.exec(line);
    if (top) {
      skip = own.has(top[1]);
    }
    if (!skip && line.trim()) {
      kept.push(line);
    }
  }
  const yaml = [
    `type: ${STACK_TYPE}`,
    `title: ${yamlString(title)}`,
    `description: ${yamlString(first.slice(0, 300))}`,
    ...kept,
  ];
  return `---\n${yaml.join('\n')}\n---\n\n${stackBody(drawing)}`;
}

/**
 * A drawing as the inbox draws it: the layers that have parts, in order, each with its name and
 * its parts, and the flows. `{ summary, layers: [{ id, name, parts }], flows, notes }`.
 */
export function stackView(drawing) {
  const layers = LAYERS.map((l) => ({
    id: l.id, name: l.name, parts: drawing.parts.filter((x) => x.layer === l.id),
  })).filter((l) => l.parts.length);
  return {
    summary: drawing.summary, layers, flows: drawing.flows, notes: drawing.notes,
  };
}

/** The layer of each technology, `{ [tech]: layer }`, from tech_stack rows (`layer` set). */
export function techLayers(rows) {
  const out = {};
  for (const r of rows || []) {
    if (r.layer && layerById.has(r.layer) && !out[r.tech]) {
      out[r.tech] = r.layer;
    }
  }
  return out;
}
