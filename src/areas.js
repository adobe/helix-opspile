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
 * Areas: what a thread is about, across kinds and products (caching and delivery, SEO, sign-in),
 * as people author them (docs/ARCHITECTURE.md, "Labels and facts"). Each is a concept of type
 * `Area` at `areas/<id>.md` of a team's knowledge base: its `title` the name the inbox shows,
 * its `description` what Clef is asked ("Is this thread about <description>?"), `enabled:
 * false` to stop asking it. The id is the file's name; renaming an area changes its title, and
 * its labels stay its. Clef asks the union of every team's (`areasFor`), each id once, the admin
 * team's first; a thread keeps those it answers at TOPIC_MIN or above (`labels.topics`). The
 * files are the source and `areas` in D1 the compiled copy, compiled with the team's catalog
 * (src/catalog.js): on every write that touches them, and by the cron.
 *
 * Until a team has written any, the areas are the list the inbox started with (src/label.js
 * TOPICS), so labels go on as they were.
 */

import { scalar, splitFrontmatter } from './agent/okf.js';

export const AREAS = 'areas';
export const AREA_TYPE = 'Area';
const MAX_NAME = 80;
const MAX_WHAT = 500;
const ID = /^[a-z][a-z0-9-]{0,39}$/;

/** Whether `path` is an area's file: `areas/<id>.md` (not an index or the log). */
export const isArea = (path) => {
  const m = /^areas\/([^/]+)\.md$/.exec(String(path || ''));
  return Boolean(m) && !['index', 'log'].includes(m[1]);
};

/** The id of an area's file, or null. */
export const areaId = (path) => (isArea(path) ? String(path).slice(AREAS.length + 1, -3) : null);

const off = (yaml) => /^(false|no|off)$/i.test(scalar(yaml, 'enabled') || '');

/** Why a file under areas/ of a team's knowledge base is not an area, or null. */
export function checkArea(path, content) {
  const p = String(path || '');
  if (!p.startsWith(`${AREAS}/`) || /(^|\/)(index|log)\.md$/.test(p)) {
    return null;
  }
  if (!isArea(p)) {
    return `${AREAS}/ holds one Area per file, at ${AREAS}/<id>.md (no directories)`;
  }
  if (!ID.test(areaId(p))) {
    return 'an area\'s file name is its id: lower case letters, digits and -, at most 40';
  }
  const fm = splitFrontmatter(content);
  if (!fm || scalar(fm.yaml, 'type') !== AREA_TYPE) {
    return `${AREAS}/ holds areas only: type ${AREA_TYPE}`;
  }
  const title = scalar(fm.yaml, 'title');
  if (!title || title.length > MAX_NAME) {
    return `an area has a title, the name the inbox shows, of at most ${MAX_NAME} characters`;
  }
  const what = scalar(fm.yaml, 'description');
  if (!what || what.length > MAX_WHAT) {
    return `an area has a description of at most ${MAX_WHAT} characters: what Clef is asked, as in "Is this thread about <description>?"`;
  }
  return null;
}

/** A team's area files (`[{ path, text }]`) as rows of `areas`; those that are not are left out. */
export function compileAreas(files) {
  const rows = [];
  for (const f of files || []) {
    if (isArea(f.path) && !checkArea(f.path, String(f.text ?? ''))) {
      const { yaml } = splitFrontmatter(f.text);
      const stamp = /\{\s*by:\s*([^,}]+),\s*at:\s*([^}\s]+)\s*\}/.exec(scalar(yaml, 'generated') || '');
      rows.push({
        id: areaId(f.path),
        name: scalar(yaml, 'title'),
        what: scalar(yaml, 'description'),
        enabled: !off(yaml),
        path: f.path,
        by: stamp ? stamp[1].trim().replace(/^human:/, '') : null,
        at: stamp ? stamp[2].trim() : null,
      });
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/** The statements that make team `team`'s rows of `areas` what `rows` says. */
export function areaStatements(db, team, rows, at) {
  return [
    db.prepare('DELETE FROM areas WHERE team = ?').bind(team),
    ...rows.map((r) => db.prepare(`INSERT INTO areas (team, id, name, what, enabled, path,
        changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(team, r.id, r.name, r.what, r.enabled ? 1 : 0, r.path, r.by, r.at || at)),
  ];
}

/**
 * The areas Clef asks about, `[{ id, name, what }]`: every team's, each id once (the admin
 * team's, else the first team's by name, that is on); in `order` (the ids in the order they were
 * measured in, src/label.js TOPICS), the others after them by id. `fallback` when no team has
 * written any yet.
 */
export async function areasFor(env, { order = [], fallback = [] } = {}) {
  const { results } = await env.DB.prepare(`SELECT team, id, name, what, enabled FROM areas
    ORDER BY id, team = 'admin' DESC, team`).all().catch(() => ({ results: [] }));
  if (!(results || []).length) {
    return fallback;
  }
  const by = new Map();
  for (const r of results) {
    if (r.enabled && !by.has(r.id)) {
      by.set(r.id, { id: r.id, name: r.name, what: r.what });
    }
  }
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
  return [...by.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** The names of every area any team has, by id (off ones too: labels from before name them). */
export async function areaNames(env, fallback = {}) {
  const { results } = await env.DB.prepare(`SELECT id, name FROM areas
    ORDER BY team = 'admin' DESC, team`).all().catch(() => ({ results: [] }));
  if (!(results || []).length) {
    return fallback;
  }
  const out = {};
  for (const r of results) {
    out[r.id] = out[r.id] || r.name;
  }
  return out;
}

/** An area's file, as the Topics page and the bootstrap write it. */
export function areaFile({ title, what, enabled = true }, body = '') {
  const q = (s) => (/^[\w ,.()'/-]+$/.test(s) && !/: /.test(s) ? s : JSON.stringify(s));
  return `---\ntype: ${AREA_TYPE}\ntitle: ${q(title)}\ndescription: ${q(what)}\n${enabled ? '' : 'enabled: false\n'}---\n\n${body || 'What threads of this area are about.'}\n`;
}
