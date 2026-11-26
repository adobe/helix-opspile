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
 * What the Topics page's panel says of a technology, or of a product of several (ui/topics.js),
 * beside what its threads are joined to: `GET /api/topics/tech?tech=<id>&tech=…&name=`, for every
 * internal user, as the map.
 *
 * - `tech`: its entries of the teams' catalogs (`tech_stack`, src/catalog.js): what Clef is asked,
 *   the names it goes by, its layer, and the teams whose knowledge base has its file, with what
 *   that file says (`entry`, from `kb_concepts`): the team's record of it, for who reads it.
 * - `product`: the file of the product the features are part of (`products/<vendor>/<product>.md`),
 *   with what it says the same way.
 * - `knowledge`: the entries about it in the knowledge bases the viewer reads, as the inbox's
 *   search finds them (src/kbsearch.js, by its name's words and by meaning); not the catalog's.
 * - `rules`: the extraction rules that detect it (`target` tech, src/extract.js), of the teams
 *   whose knowledge base the viewer reads; `hiddenRules` counts the others.
 * - `follows`: the teams that follow it, and how many people do (src/following.js).
 * - `stacks`: the customers whose stack drawing names it (`org_stacks`, src/orgstacks.js), of those
 *   whose knowledge base the viewer reads.
 * - `agents`: the knowledge bases whose agent to talk to about it (ui/kbchat.js): the teams' whose
 *   catalog has it, the viewer's first, then those that follow it, then the admin team's; for a
 *   name no catalog has, the viewer's own teams', else the admin team's.
 *
 * An id from before a catalog file moved is read as the one it moved to. Everything but the
 * catalog's names is read as the viewer may (src/kbaccess.js).
 */

import { resolveTech, techMoves } from './catalog.js';
import { access } from './kbaccess.js';
import { MAX_BODY } from './kbindex.js';
import { findKnowledge } from './kbsearch.js';
import { queryVector, terms } from './search.js';
import { isTechId } from './techid.js';
import { ADMIN_TEAM } from './roles.js';

export const MAX_TECH = 40;
export const MAX_KNOWLEDGE = 12;
export const MAX_STACKS = 40;
const MAX_NAME = 80;

const PRODUCTS = 'products/';

/** The names an entry also goes by (`tech_stack.aliases`: a comma-separated list). */
const aliasesOf = (text) => String(text || '').split(/\s*[,\n]\s*/).map((s) => s.trim())
  .filter(Boolean);

/** The path of the product file a feature's id is under, or null: `adobe/aem-sites/x` → its. */
const productPath = (id) => {
  const segs = String(id).split('/');
  return segs.length === 3 ? `${PRODUCTS}${segs[0]}/${segs[1]}.md` : null;
};

/** What `rows` say of the catalog's technologies, one each, the admin team's entry first. */
function techOf(rows, bases, may) {
  const by = new Map();
  for (const r of rows) {
    const base = bases.get(r.team);
    const team = {
      team: r.team,
      name: r.team_name || r.team,
      enabled: Boolean(r.enabled),
      // What Clef is asked in its channels: its own file's words.
      description: r.description || '',
      path: r.path || null,
      repo: base ? base.repo : null,
      readable: Boolean(base && may.read(base)),
    };
    const had = by.get(r.tech);
    if (had) {
      had.teams.push(team);
      // eslint-disable-next-line no-continue
      continue;
    }
    by.set(r.tech, {
      tech: r.tech,
      name: r.name,
      kind: r.kind || null,
      vendor: r.vendor || null,
      product: r.product || null,
      layer: r.layer || null,
      description: r.description || '',
      aliases: aliasesOf(r.aliases),
      teams: [team],
    });
  }
  return [...by.values()];
}

/**
 * The knowledge bases to talk to about it (`agents`), best first: of the teams in `teams`, those
 * the viewer may read.
 */
function agentsOf(me, teams, { followers, bases, may }) {
  const mine = new Set((me.teams || []).map((t) => t.slug));
  const rank = (slug) => {
    if (mine.has(slug)) {
      return 0;
    }
    if (followers.has(slug)) {
      return 1;
    }
    return slug === ADMIN_TEAM ? 2 : 3;
  };
  return [...new Set(teams)].map((slug) => bases.get(slug)).filter((b) => b && may.read(b))
    .sort((a, b) => rank(a.slug) - rank(b.slug) || a.name.localeCompare(b.name))
    .map((b) => ({
      repo: b.repo, kind: 'team', slug: b.slug, name: b.name, write: Boolean(may.write(b)),
    }));
}

/**
 * GET /api/topics/tech: `{ tech, product, knowledge, rules, hiddenRules, follows, stacks,
 * moreStacks, agents }` of the technologies `tech` (ids), named `name` on the map.
 */
export async function techInfo(env, me, { tech = [], name = '' } = {}) {
  const asked = [...new Set([].concat(tech || []))].filter(isTechId).slice(0, MAX_TECH);
  const q = String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  const db = env.DB;
  // A map built before a catalog file moved names it by its id then: what D1 stores is the new.
  const moves = asked.length ? await techMoves(env) : {};
  const ids = [...new Set(asked.map((id) => resolveTech(id, moves)))];
  const list = JSON.stringify(ids);
  const IN = 'IN (SELECT value FROM json_each(?1))';
  const [rows, rules, follows, people, stacks, kbs, may] = await Promise.all([
    db.prepare(`SELECT s.team, s.tech, s.name, s.description, s.aliases, s.kind, s.vendor,
        s.product, s.path, s.layer, s.enabled, t.name AS team_name
      FROM tech_stack s LEFT JOIN teams t ON t.slug = s.team
      WHERE s.tech ${IN} ORDER BY s.tech, s.team = ?2 DESC, s.team`).bind(list, ADMIN_TEAM).all(),
    db.prepare(`SELECT r.id, r.team, r.name, r.kind, r.field, r.pattern, r.flags, r.enabled,
        r.changed_by, r.changed_at, t.name AS team_name
      FROM extraction_rules r LEFT JOIN teams t ON t.slug = r.team
      WHERE r.target = 'tech' AND r.field ${IN}
      ORDER BY r.team = ?2 DESC, r.team, r.position, r.id`).bind(list, ADMIN_TEAM).all(),
    db.prepare(`SELECT f.team, COALESCE(t.name, f.team) AS name, f.tech FROM team_follows f
      LEFT JOIN teams t ON t.slug = f.team WHERE f.tech ${IN} ORDER BY name`).bind(list).all(),
    db.prepare(`SELECT COUNT(DISTINCT person) AS n FROM person_follows WHERE tech ${IN}`)
      .bind(list).first(),
    db.prepare(`SELECT s.org, COALESCE(o.name, s.org) AS name, json_extract(j.value, '$.name') AS part,
        json_extract(j.value, '$.tech') AS tech
      FROM org_stacks s JOIN json_each(CASE WHEN json_valid(s.parts) THEN s.parts ELSE '[]' END) j
        LEFT JOIN orgs o ON o.slug = s.org
      WHERE json_extract(j.value, '$.tech') ${IN}
        AND s.org NOT IN (SELECT slug FROM org_merges)
      ORDER BY name, part`).bind(list).all(),
    db.prepare(`SELECT k.repo, k.kind, k.slug, COALESCE(t.name, k.slug) AS name
      FROM knowledge_bases k LEFT JOIN teams t ON t.slug = k.slug WHERE k.kind = 'team'`).all(),
    access(env, me),
  ]);
  const bases = new Map((kbs.results || []).map((b) => [b.slug, b]));
  const techs = techOf(rows.results || [], bases, may);

  // The product the features are part of: its file, in the knowledge base of a team that has
  // one of them (their compile wrote it there), the one that has the most first.
  const productAt = new Map();
  for (const t of techs) {
    const path = productPath(t.tech);
    for (const team of path ? t.teams : []) {
      if (team.repo) {
        const key = `${team.repo}|${path}`;
        productAt.set(key, (productAt.get(key) || 0) + 1);
      }
    }
  }
  const productKeys = [...productAt.keys()];
  // Each team's file of it, the record of it in that knowledge base, as the search keeps it.
  const fileKeys = techs.flatMap((t) => t.teams.filter((x) => x.repo && x.path)
    .map((x) => `${x.repo}|${x.path}`));
  const keys = [...new Set([...productKeys, ...fileKeys])];
  const [files, knowledge] = await Promise.all([
    keys.length ? db.prepare(`SELECT repo, path, title, description, body FROM kb_concepts
      WHERE repo || '|' || path IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(keys)).all() : { results: [] },
    terms(q).length ? findKnowledge(env, me, [...bases.keys()], q, {
      vector: queryVector(env, q), limit: MAX_KNOWLEDGE + techs.length + 2,
    }) : [],
  ]);
  const teamOfRepo = new Map([...bases.values()].map((b) => [b.repo, b]));
  const fileAt = new Map((files.results || []).map((r) => [`${r.repo}|${r.path}`, r]));
  // What a file says, for who reads its knowledge base: its description and its markdown, which
  // the index keeps the first MAX_BODY characters of (`truncated`: open it for the rest).
  const said = (r, b) => (r && b && may.read(b) ? {
    title: r.title,
    description: r.description || null,
    body: r.body || '',
    truncated: String(r.body || '').length >= MAX_BODY,
  } : null);
  for (const t of techs) {
    for (const x of t.teams) {
      x.entry = x.path ? said(fileAt.get(`${x.repo}|${x.path}`), bases.get(x.team)) : null;
    }
  }
  const product = productKeys.map((k) => fileAt.get(k)).filter(Boolean)
    .sort((a, b) => (productAt.get(`${b.repo}|${b.path}`) || 0) - (productAt.get(`${a.repo}|${a.path}`) || 0))
    .map((r) => {
      const b = teamOfRepo.get(r.repo);
      return {
        title: r.title,
        description: r.description || null,
        path: r.path,
        repo: r.repo,
        team: b.slug,
        teamName: b.name,
        readable: Boolean(may.read(b)),
        entry: said(r, b),
      };
    })[0] || null;

  const readable = (team) => {
    const b = bases.get(team);
    return Boolean(b && may.read(b));
  };
  const allRules = rules.results || [];
  const shown = allRules.filter((r) => readable(r.team));
  const followers = new Set((follows.results || []).map((f) => f.team));
  const teamsFollowing = new Map();
  for (const f of follows.results || []) {
    const had = teamsFollowing.get(f.team) || { team: f.team, name: f.name, tech: [] };
    had.tech.push(f.tech);
    teamsFollowing.set(f.team, had);
  }
  // A customer's stack drawing is its knowledge base's: only of the customers the viewer reads
  // (as src/orgprofile.js shows it), the others not even counted.
  const byOrg = new Map();
  for (const s of (stacks.results || []).filter((r) => may.read({ kind: 'org', slug: r.org }))) {
    const had = byOrg.get(s.org) || { org: s.org, name: s.name, parts: [] };
    had.parts.push({ name: s.part, tech: s.tech });
    byOrg.set(s.org, had);
  }
  const catalogTeams = techs.flatMap((t) => t.teams.map((x) => x.team));
  const mine = (me.teams || []).map((t) => t.slug);
  return {
    tech: techs,
    product,
    // The catalog's files are the panel's already; an area's file is not about a product.
    knowledge: knowledge.filter((k) => !k.path.startsWith(PRODUCTS) && !k.path.startsWith('areas/'))
      .slice(0, MAX_KNOWLEDGE),
    rules: shown.map((r) => ({
      id: r.id,
      team: r.team,
      teamName: r.team_name || r.team,
      name: r.name,
      kind: r.kind,
      tech: r.field,
      // A script's code is the extraction section's to show.
      pattern: r.kind === 'regex' ? r.pattern : null,
      flags: r.kind === 'regex' ? r.flags || '' : null,
      enabled: Boolean(r.enabled),
      by: r.changed_by || null,
      at: r.changed_at || null,
    })),
    hiddenRules: allRules.length - shown.length,
    follows: { teams: [...teamsFollowing.values()], people: (people && people.n) || 0 },
    stacks: [...byOrg.values()].slice(0, MAX_STACKS),
    moreStacks: Math.max(0, byOrg.size - MAX_STACKS),
    agents: agentsOf(me, catalogTeams.length ? catalogTeams : [...mine, ADMIN_TEAM], {
      followers, bases, may,
    }),
  };
}
