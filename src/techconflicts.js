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
 * Conflicts between the teams' technologies (src/catalog.js, docs/ARCHITECTURE.md "Labels and
 * facts"), for the admin team to settle under Requests and with the MCP server's
 * `list_tech_conflicts` and `resolve_tech_conflict`. They are computed from `tech_stack` each
 * time, never curated:
 *
 * - `diverging`: one id that two teams define otherwise (name, description, layer, product, or
 *   on in one and off in another). Each team's is what Clef asks in its channels, so it may be
 *   meant (an override).
 * - `name`: a name or alias that two ids have, so a thread that names it matches either.
 *
 * Settling one changes the files (a team's catalog, written as the admin who settles it), or D1
 * for a row saved there, or keeps the conflict as it is: a kept one stays hidden while its
 * definitions stay as they were kept (`tech_conflict_keeps.fingerprint`).
 */

import { withMovedFrom } from './catalog.js';
import { splitFrontmatter } from './agent/okf.js';
import { readText } from './agent/repos.js';
import { writeKnowledge } from './agent/kbwrite.js';
import { GLOBAL_TEAM } from './extract.js';
import { sha256 } from './raw.js';

const FIELDS = ['name', 'description', 'layer', 'product', 'enabled'];

/** A name as it is matched: lower case, words only. */
export const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.+#@]+/g, ' ').trim();

const aliasesOf = (r) => String(r.aliases || '').split(',').map((a) => a.trim()).filter(Boolean);

/** A definition as a conflict shows it. */
const definition = (r) => ({
  team: r.team,
  tech: r.tech,
  path: r.path || null,
  name: r.name,
  description: r.description,
  layer: r.layer || null,
  product: r.product || null,
  enabled: Boolean(r.enabled),
  aliases: aliasesOf(r),
});

/** The conflicts `rows` (tech_stack) have, each with a stable `key` and its `fingerprint`. */
export async function findConflicts(rows) {
  const out = [];
  const byTech = new Map();
  for (const r of rows || []) {
    byTech.set(r.tech, [...(byTech.get(r.tech) || []), r]);
  }
  for (const [tech, list] of byTech) {
    const defs = list.map(definition).sort((a, b) => (a.team === GLOBAL_TEAM ? -1 : 0)
      - (b.team === GLOBAL_TEAM ? -1 : 0) || a.team.localeCompare(b.team));
    const fields = FIELDS.filter((f) => new Set(defs.map((d) => JSON.stringify(d[f]))).size > 1);
    if (defs.length > 1 && fields.length) {
      out.push({
        key: `diverging:${tech}`, kind: 'diverging', tech, fields, definitions: defs,
      });
    }
  }
  // Names, of the definitions that are on: a name nobody asks about matches nothing.
  const byName = new Map();
  for (const r of (rows || []).filter((x) => x.enabled)) {
    for (const [as, n] of [['name', r.name], ...aliasesOf(r).map((a) => ['alias', a])]) {
      const k = nameKey(n);
      if (k) {
        const seen = byName.get(k) || { name: n, uses: [] };
        if (!seen.uses.some((u) => u.tech === r.tech && u.team === r.team && u.as === as)) {
          seen.uses.push({
            team: r.team, tech: r.tech, path: r.path || null, as, written: n,
          });
        }
        byName.set(k, seen);
      }
    }
  }
  for (const [k, { name, uses }] of byName) {
    const techs = [...new Set(uses.map((u) => u.tech))].sort();
    if (techs.length > 1) {
      out.push({
        key: `name:${k}`,
        kind: 'name',
        name,
        techs,
        uses: uses.sort((a, b) => a.tech.localeCompare(b.tech) || a.team.localeCompare(b.team)),
        definitions: techs.flatMap((t) => byTech.get(t).map(definition)),
      });
    }
  }
  for (const c of out) {
    // eslint-disable-next-line no-await-in-loop
    c.fingerprint = (await sha256(JSON.stringify(c.definitions))).slice(0, 16);
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

/** The conflicts as they are now, with whether each is kept (`kept`: who, when, why). */
export async function techConflicts(env, { kept: withKept = true } = {}) {
  const [{ results: rows }, { results: keeps }] = await Promise.all([
    env.DB.prepare(`SELECT team, tech, name, description, layer, product, enabled, aliases, path
      FROM tech_stack ORDER BY tech, team`).all(),
    env.DB.prepare('SELECT key, fingerprint, kept_by, kept_at, note FROM tech_conflict_keeps').all(),
  ]);
  const keptBy = new Map((keeps || []).map((k) => [k.key, k]));
  const all = (await findConflicts(rows)).map((c) => {
    const k = keptBy.get(c.key);
    return k && k.fingerprint === c.fingerprint
      ? { ...c, kept: { by: k.kept_by, at: k.kept_at, note: k.note || null } } : c;
  });
  return withKept ? all : all.filter((c) => !c.kept);
}

/** How many conflicts are waiting for the admin team: Requests counts them. */
export async function openConflictCount(env) {
  return (await techConflicts(env, { kept: false })).length;
}

const repoOf = (team) => `kb-team-${team}`;

/** A catalog concept with its `aliases` set to `list` (none: the line goes). */
export function withAliases(content, list) {
  const fm = splitFrontmatter(content);
  if (!fm) {
    return content;
  }
  const lines = fm.yaml.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^aliases:/.test(lines[i])) {
      while (i + 1 < lines.length && /^[ \t]+-[ \t]/.test(lines[i + 1])) {
        i += 1;
      }
    } else {
      out.push(lines[i]);
    }
  }
  if (list.length) {
    out.push(`aliases: [${list.join(', ')}]`);
  }
  return `---\n${out.join('\n')}\n---\n${fm.body}`;
}

/**
 * One change to a team's catalog file or D1 row of `tech`, as `me`: `edit(content)` gives the
 * new text (null: delete it), `d1` the same for a row saved in D1.
 */
async function change(env, me, def, { edit, d1, message }) {
  if (!def.path) {
    await d1();
    return { team: def.team, tech: def.tech, d1: true };
  }
  const repo = repoOf(def.team);
  const file = await readText(env, repo, def.path, { full: true });
  if (file.error) {
    return { error: `${repo} ${def.path}: ${file.error}` };
  }
  const content = edit(file.text);
  const res = await writeKnowledge(env, repo, [content === null
    ? { path: def.path, delete: true, base: file.hash }
    : { path: def.path, content, base: file.hash }], {
    message: `${message}\n\nOpspile-Editor: ${me.name || me.email}`,
    by: `human:${me.email}`,
    author: { name: me.name || me.email, email: me.email },
    logEntry: `**Update**: ${message} (${me.name || me.email})`,
    staff: true,
  });
  if (res.error || res.conflict) {
    return { error: `${repo} ${def.path}: ${res.error || res.conflict}` };
  }
  return {
    team: def.team, tech: def.tech, path: def.path, commit: res.commit || null,
  };
}

const deleteRow = (env, def) => () => env.DB.prepare('DELETE FROM tech_stack WHERE team = ? AND tech = ?')
  .bind(def.team, def.tech).run();

/**
 * Settles conflict `key` as `me` (an admin): `{ done, changes }` or `{ error, status }`.
 *
 * - `keep` (`note`): as it is, an intended override; hidden until a definition changes.
 * - `use` (`team`): a diverging id becomes `team`'s, in every channel: the other teams' files and
 *   rows of it are deleted.
 * - `delete` (`team`, `tech`): that team's definition of that id.
 * - `merge` (`from`, `into`): a name two ids share is one technology: every file and row of
 *   `from` goes, and a file of `into` lists `from` in `moved_from`, so what D1 keeps under it is
 *   `into`'s (src/catalog.js).
 * - `unalias` (`team`, `tech`): the shared name is no longer an alias of that team's `tech`.
 */
export async function resolveConflict(env, me, input) {
  const conflicts = await techConflicts(env);
  const c = conflicts.find((x) => x.key === String(input.key || ''));
  if (!c) {
    return { error: 'no such conflict: it may be settled already (list them again)', status: 404 };
  }
  const action = String(input.action || '');
  const defs = c.definitions;
  const find = (team, tech) => defs.find((d) => d.team === team && d.tech === (tech || d.tech));
  const changes = [];
  const run = async (def, how) => {
    const r = await change(env, me, def, how);
    changes.push(r);
    return r;
  };
  if (action === 'keep') {
    await env.DB.prepare(`INSERT INTO tech_conflict_keeps (key, fingerprint, kept_by, kept_at, note)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET fingerprint = excluded.fingerprint,
        kept_by = excluded.kept_by, kept_at = excluded.kept_at, note = excluded.note`)
      .bind(c.key, c.fingerprint, me.email, new Date().toISOString(), String(input.note || '').slice(0, 300) || null)
      .run();
    return { done: 'kept', changes };
  }
  if (action === 'use') {
    const keep = c.kind === 'diverging' && find(String(input.team || ''));
    if (!keep) {
      return { error: 'use takes the team whose definition of the id stays', status: 400 };
    }
    for (const d of defs.filter((x) => x !== keep)) {
      // eslint-disable-next-line no-await-in-loop
      const r = await run(d, {
        edit: () => null, d1: deleteRow(env, d), message: `Use ${keep.team}'s ${c.tech} (${keep.name})`,
      });
      if (r.error) {
        return { error: r.error, changes, status: 409 };
      }
    }
    return { done: 'used', changes };
  }
  if (action === 'delete') {
    const d = find(String(input.team || ''), input.tech ? String(input.tech) : null);
    if (!d) {
      return { error: 'delete takes a team and a technology of the conflict', status: 400 };
    }
    const r = await run(d, { edit: () => null, d1: deleteRow(env, d), message: `Delete ${d.tech} (${d.name})` });
    return r.error ? { error: r.error, changes, status: 409 } : { done: 'deleted', changes };
  }
  if (action === 'unalias') {
    const d = c.kind === 'name' && find(String(input.team || ''), String(input.tech || ''));
    if (!d) {
      return { error: 'unalias takes a team and a technology that has the name', status: 400 };
    }
    const k = c.key.slice('name:'.length);
    const left = d.aliases.filter((a) => nameKey(a) !== k);
    if (left.length === d.aliases.length) {
      return { error: `the name is ${d.tech}'s name there, not an alias: rename it or merge`, status: 400 };
    }
    const r = await run(d, {
      edit: (text) => withAliases(text, left),
      d1: () => env.DB.prepare('UPDATE tech_stack SET aliases = ? WHERE team = ? AND tech = ?')
        .bind(left.join(', ') || null, d.team, d.tech).run(),
      message: `${c.name} is not ${d.name} any more`,
    });
    return r.error ? { error: r.error, changes, status: 409 } : { done: 'unaliased', changes };
  }
  if (action === 'merge') {
    const from = String(input.from || '');
    const into = String(input.into || '');
    const target = defs.find((d) => d.tech === into && d.path);
    if (c.kind !== 'name' || from === into || !c.techs.includes(from) || !target) {
      return { error: 'merge takes two technologies of the conflict, `into` one kept in a team\'s catalog', status: 400 };
    }
    // First every file of `from` goes, so that the move is new when `into` lists it.
    for (const d of defs.filter((x) => x.tech === from && x.path)) {
      // eslint-disable-next-line no-await-in-loop
      const r = await run(d, { edit: () => null, message: `Merge ${from} into ${into}` });
      if (r.error) {
        return { error: r.error, changes, status: 409 };
      }
    }
    const r = await run(target, {
      edit: (text) => withMovedFrom(text, [from]),
      message: `Merge ${from} into ${into}`,
    });
    return r.error ? { error: r.error, changes, status: 409 } : { done: 'merged', changes };
  }
  return { error: 'action is keep, use, delete, unalias or merge', status: 400 };
}
