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
 * The catalog: the products each team supports, one concept per file under `products/` of its
 * knowledge base (docs/ARCHITECTURE.md, "Labels and facts"):
 *
 *   products/<vendor>.md                     Vendor    its name; never asked
 *   products/<vendor>/<product>.md           Product   asked, unless it only groups features
 *   products/<vendor>/<product>/<feature>.md Feature   asked
 *   products/categories/<category>.md        Category  asked: any vendor's, the ones no file lists
 *
 * A technology's id is its path under products/ without `.md` (src/techid.js). Clef asks about
 * the union of every team's (src/extract.js techFor): in a team's channels its own file of a path
 * replaces the others', elsewhere the admin team's (else the first team's by name) is asked, with
 * the synonyms of all of them. The files are the source, and tech_stack the compiled copy every
 * reader reads: each write of a team's knowledge base that touches products/ compiles it
 * (src/agent/kbwrite.js), and the cron compiles any whose head moved since (a revert, a push).
 *
 * A file that was moved lists the ids it had in `moved_from` (code adds them on a move): the
 * compile rewrites what D1 stores under an old id once (`tech_moves`), and `stack.md` is read
 * through the map.
 */

import { LAYER_IDS } from './stack.js';
import { scalar, splitFrontmatter, strings } from './agent/okf.js';
import { isTechId } from './techid.js';

export const PRODUCTS = 'products';
export const CATEGORIES = 'categories';
export const ADOBE = 'adobe';
export const CATALOG_TYPES = ['Vendor', 'Product', 'Feature', 'Category'];
const MAX_NAME = 80;
const MAX_DESCRIPTION = 300;
const MAX_ALIASES = 1000;

/** Whether `path` is a file of the catalog: a concept under products/ (not an index or the log). */
export const inCatalog = (path) => {
  const p = String(path || '');
  return p.startsWith(`${PRODUCTS}/`) && p.endsWith('.md') && !/(^|\/)(index|log)\.md$/.test(p);
};

/** The id of a catalog file: its path under products/ without `.md`; null for another. */
export const catalogId = (path) => (inCatalog(path)
  ? String(path).slice(PRODUCTS.length + 1, -3) : null);

/** The type a catalog file's path calls for, or null: what its depth and directory say. */
function typeOfPath(path) {
  const segs = catalogId(path)?.split('/') || [];
  if (segs[0] === CATEGORIES) {
    return segs.length === 2 ? 'Category' : null;
  }
  return ['Vendor', 'Product', 'Feature'][segs.length - 1] || null;
}

const WHERE = {
  Vendor: `${PRODUCTS}/<vendor>.md`,
  Product: `${PRODUCTS}/<vendor>/<product>.md`,
  Feature: `${PRODUCTS}/<vendor>/<product>/<feature>.md`,
  Category: `${PRODUCTS}/${CATEGORIES}/<category>.md`,
};

const flag = (yaml, key) => {
  const v = scalar(yaml, key);
  return v === null ? null : /^(true|yes|on)$/i.test(v);
};

/**
 * Why a file under products/ of a team's knowledge base is not a catalog entry, or null. Every
 * write is held to it, people's too: what is under products/ is what Clef is asked.
 */
export function checkCatalog(path, content) {
  if (!inCatalog(path)) {
    return null;
  }
  const fm = splitFrontmatter(content);
  const type = fm && scalar(fm.yaml, 'type');
  if (!type || !CATALOG_TYPES.includes(type)) {
    return `${PRODUCTS}/ holds the catalog only: a ${CATALOG_TYPES.join(', a ')} (${CATALOG_TYPES.map((t) => `${t} at ${WHERE[t]}`).join('; ')})`;
  }
  if (typeOfPath(path) !== type) {
    return `a ${type} goes at ${WHERE[type]}`;
  }
  const title = scalar(fm.yaml, 'title');
  if (!title) {
    return `a ${type} has a title: the name the inbox shows`;
  }
  if (title.length > MAX_NAME) {
    return `a title has at most ${MAX_NAME} characters`;
  }
  const description = scalar(fm.yaml, 'description');
  if (type !== 'Vendor' && !description) {
    return `a ${type} has a description: what Clef is asked about, as in "Does this thread show that the customer uses <description>?"`;
  }
  if (description && description.length > MAX_DESCRIPTION) {
    return `a description has at most ${MAX_DESCRIPTION} characters`;
  }
  const layer = scalar(fm.yaml, 'layer');
  if (layer && !LAYER_IDS.includes(layer)) {
    return `layer is one of ${LAYER_IDS.join(', ')}, or none`;
  }
  const bad = strings(fm.yaml, 'moved_from').find((id) => !isTechId(id));
  if (bad) {
    return `moved_from lists ids a technology had, such as eds or adobe/aem-sites/edge-delivery (not ${bad})`;
  }
  return null;
}

/** `aem-sites` as a name, for a directory without a concept of its own. */
const named = (slug) => slug.split(/[-_]+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

/** `generated: { by, at }` of a concept (src/agent/okf.js stampGenerated), or nulls. */
function stampOf(yaml) {
  const m = /\{\s*by:\s*([^,}]+),\s*at:\s*([^}\s]+)\s*\}/.exec(scalar(yaml, 'generated') || '');
  // A person's edit is stamped `human:<email>`: the address is who changed it.
  return m ? { by: m[1].trim().replace(/^human:/, ''), at: m[2].trim() } : { by: null, at: null };
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** A catalog file, read: `{ id, type, segs, title, description, … }`, or null for another. */
export function parseEntry(path, text) {
  if (checkCatalog(path, text)) {
    return null;
  }
  const { yaml } = splitFrontmatter(text);
  const id = catalogId(path);
  const aliases = strings(yaml, 'aliases').map((a) => a.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return {
    id,
    path,
    type: scalar(yaml, 'type'),
    segs: id.split('/'),
    title: scalar(yaml, 'title'),
    description: scalar(yaml, 'description'),
    // Each once, as it is first written.
    aliases: aliases.filter((a, i) => aliases.findIndex((x) => same(x, a)) === i),
    layer: scalar(yaml, 'layer'),
    enabled: flag(yaml, 'enabled') !== false,
    asked: flag(yaml, 'asked'),
    moved: strings(yaml, 'moved_from').filter((m) => m !== id),
    ...stampOf(yaml),
  };
}

/**
 * A team's catalog files (`[{ path, text }]`) as tech_stack rows and moves: `{ rows, moves,
 * skipped }`. A Feature is part of its Product (its name, and its layer when it has none); a
 * Product of Adobe's is a product of its own, another company's is its vendor's; a Category is
 * one of its own. A Product with features is asked only with `asked: true`. What the portal
 * offers is Adobe's (`portal`).
 */
export function compileCatalog(files) {
  const entries = [];
  const skipped = [];
  for (const f of files || []) {
    const e = inCatalog(f.path) ? parseEntry(f.path, String(f.text ?? '')) : null;
    if (e) {
      entries.push(e);
    } else if (inCatalog(f.path)) {
      skipped.push(f.path);
    }
  }
  const vendors = new Map(entries.filter((e) => e.type === 'Vendor').map((e) => [e.segs[0], e]));
  const products = new Map(entries.filter((e) => e.type === 'Product').map((e) => [e.id, e]));
  const grouping = new Set(entries.filter((e) => e.type === 'Feature').map((e) => e.segs.slice(0, 2).join('/')));
  const rows = [];
  const moves = [];
  for (const e of entries) {
    if (e.type === 'Vendor' || (e.type === 'Product' && grouping.has(e.id) && !e.asked)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const [v] = e.segs;
    const vendor = e.type === 'Category' ? null : (vendors.get(v)?.title || named(v));
    const parent = e.type === 'Feature' ? products.get(e.segs.slice(0, 2).join('/')) : null;
    let product = e.title;
    if (e.type === 'Feature') {
      product = parent?.title || named(e.segs[1]);
    } else if (e.type === 'Product' && v !== ADOBE) {
      product = vendor;
    }
    rows.push({
      tech: e.id,
      name: e.title,
      description: e.description,
      product,
      aliases: e.aliases.join(', ').slice(0, MAX_ALIASES) || null,
      layer: e.layer || parent?.layer || null,
      enabled: e.enabled && (!parent || parent.enabled),
      portal: v === ADOBE && e.type !== 'Category',
      path: e.path,
      kind: e.type,
      vendor,
      by: e.by,
      at: e.at,
    });
    e.moved.forEach((old) => moves.push({ old, tech: e.id }));
  }
  rows.sort((a, b) => a.tech.localeCompare(b.tech));
  return { rows, moves, skipped };
}

/**
 * Sets `moved_from` of a catalog concept to its ids so far and `ids`, once each: what a file that
 * moved keeps, so what D1 and the stack drawings store under its old ids stays its.
 */
export function withMovedFrom(content, ids) {
  const fm = splitFrontmatter(content);
  if (!fm) {
    return content;
  }
  const all = [...new Set([...strings(fm.yaml, 'moved_from'), ...ids].filter(Boolean))];
  const lines = fm.yaml.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^moved_from:/.test(lines[i])) {
      while (i + 1 < lines.length && /^[ \t]+-[ \t]/.test(lines[i + 1])) {
        i += 1;
      }
    } else {
      out.push(lines[i]);
    }
  }
  if (all.length) {
    out.push(`moved_from: [${all.join(', ')}]`);
  }
  return `---\n${out.join('\n')}\n---\n${fm.body}`;
}

/**
 * The moves of one write of a team's knowledge base: each catalog file it deletes and one it
 * creates of the same type and title, `[{ from, to, ids }]`: `to` keeps `from`'s id and the ids it
 * had (`ids`). `old` reads a deleted file's text. Nothing else pairs them: a move rewrites what D1
 * keeps under the old id for good, so a file that replaces an unrelated one (Target for Workfront)
 * must not inherit its labels. A rename that changes the title lists the old id in `moved_from`.
 */
export async function movesOf(changes, { old, present }) {
  const gone = [];
  const born = [];
  for (const c of changes) {
    if (!inCatalog(c.path)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (c.delete) {
      // eslint-disable-next-line no-await-in-loop
      const e = parseEntry(c.path, await old(c.path));
      if (e) {
        gone.push(e);
      }
    // eslint-disable-next-line no-await-in-loop
    } else if (!await present(c.path)) {
      const e = parseEntry(c.path, String(c.content ?? ''));
      if (e) {
        born.push(e);
      }
    }
  }
  const pairs = [];
  const take = (match) => {
    for (const b of [...born]) {
      const g = gone.find((x) => x.type === b.type && match(x, b));
      if (g) {
        pairs.push({ from: g.path, to: b.path, ids: [g.id, ...g.moved] });
        gone.splice(gone.indexOf(g), 1);
        born.splice(born.indexOf(b), 1);
      }
    }
  };
  take((g, b) => same(g.title, b.title));
  return pairs;
}

/**
 * What D1 keeps under id `old`, rewritten to `tech`: the statements of one move, across every
 * team's rows (the D1 rows of that id too, another team's own among them).
 */
function rewrites(db, old, tech) {
  const swap = (table) => [
    db.prepare(`UPDATE OR IGNORE ${table} SET tech = ?2 WHERE tech = ?1`).bind(old, tech),
    db.prepare(`DELETE FROM ${table} WHERE tech = ?1`).bind(old),
  ];
  return [
    // A row written in D1 under the old id is the file now.
    db.prepare('DELETE FROM tech_stack WHERE path IS NULL AND tech = ?1').bind(old),
    ...swap('team_follows'),
    ...swap('person_follows'),
    ...swap('thread_tech'),
    ...swap('channel_tech'),
    db.prepare('UPDATE extraction_rules SET field = ?2 WHERE target = \'tech\' AND field = ?1')
      .bind(old, tech),
    db.prepare(`UPDATE portal_requests SET tech = (SELECT json_group_array(CASE WHEN value = ?1
        THEN ?2 ELSE value END) FROM json_each(portal_requests.tech))
      WHERE EXISTS (SELECT 1 FROM json_each(portal_requests.tech) WHERE value = ?1)`).bind(old, tech),
  ];
}

/**
 * Stores what `compileCatalog` made of team `team`'s files, compiled from `commit` of `repo`:
 * its catalog rows of tech_stack and its moves replaced, the moves that are new rewritten (one
 * whose old id is still a file of the catalog is no move: it is only mapped), all in one batch.
 */
export async function storeCatalog(env, kb, { rows, moves }, now = new Date()) {
  const { team, repo, commit = null } = kb;
  const db = env.DB;
  const at = now.toISOString();
  const [before, live] = await Promise.all([
    db.prepare('SELECT old, tech FROM tech_moves WHERE team = ?').bind(team).all(),
    db.prepare('SELECT DISTINCT tech FROM tech_stack WHERE path IS NOT NULL AND team != ?').bind(team).all(),
  ]);
  const had = new Map((before.results || []).map((m) => [m.old, m.tech]));
  const ids = new Set([...(live.results || []).map((r) => r.tech), ...rows.map((r) => r.tech)]);
  const fresh = moves.filter((m) => had.get(m.old) !== m.tech && !ids.has(m.old));
  const statements = [
    db.prepare('DELETE FROM tech_stack WHERE team = ? AND path IS NOT NULL').bind(team),
    ...rows.map((r) => db.prepare(`INSERT INTO tech_stack (team, tech, name, description, product,
        aliases, layer, enabled, portal, path, kind, vendor, changed_by, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (team, tech) DO UPDATE SET name = excluded.name,
        description = excluded.description, product = excluded.product,
        aliases = excluded.aliases, layer = excluded.layer, enabled = excluded.enabled,
        portal = excluded.portal, path = excluded.path, kind = excluded.kind,
        vendor = excluded.vendor, changed_by = excluded.changed_by,
        changed_at = excluded.changed_at`)
      .bind(
        team,
        r.tech,
        r.name,
        r.description,
        r.product,
        r.aliases,
        r.layer,
        r.enabled ? 1 : 0,
        r.portal ? 1 : 0,
        r.path,
        r.kind,
        r.vendor,
        r.by || `kb:${repo}`,
        r.at || at,
      )),
    db.prepare('DELETE FROM tech_moves WHERE team = ?').bind(team),
    ...moves.map((m) => db.prepare('INSERT OR IGNORE INTO tech_moves (team, old, tech) VALUES (?, ?, ?)')
      .bind(team, m.old, m.tech)),
  ];
  let cursor = statements.length;
  const each = fresh.map((m) => rewrites(db, m.old, m.tech));
  statements.push(...each.flat());
  statements.push(db.prepare('UPDATE knowledge_bases SET catalog_commit = ? WHERE repo = ?')
    .bind(commit, repo));
  const results = await db.batch(statements);
  // Every new move, with the rows it rewrote: one nobody meant is traced, and reversed, from this.
  for (const [i, m] of fresh.entries()) {
    const changed = results.slice(cursor, cursor + each[i].length)
      .reduce((n, r) => n + Number(r?.meta?.changes || 0), 0);
    cursor += each[i].length;
    console.log(JSON.stringify({
      route: 'catalog', action: 'move', team, repo, commit, old: m.old, tech: m.tech, changed,
    }));
  }
  return { rows: rows.length, moves: moves.length, rewritten: fresh.length };
}

/**
 * Every move, `{ [old]: tech }`, followed to its end (a file moved twice), the admin team's
 * first where two teams say otherwise.
 */
export async function techMoves(env) {
  if (!env?.DB) {
    return {};
  }
  const { results } = await env.DB.prepare(`SELECT old, tech FROM tech_moves
    ORDER BY team = 'admin', team DESC`).all();
  const map = {};
  for (const m of results || []) {
    map[m.old] = m.tech;
  }
  const end = (id) => {
    let cur = id;
    for (let i = 0; i < 8 && map[cur] && map[cur] !== cur; i += 1) {
      cur = map[cur];
    }
    return cur;
  };
  return Object.fromEntries(Object.keys(map).map((k) => [k, end(k)]));
}

/** `id` as it is now: through `moves` (techMoves), or as it is. */
export const resolveTech = (id, moves) => (id && moves && moves[id]) || id;
