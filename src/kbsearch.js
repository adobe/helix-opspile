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

import { access } from './kbaccess.js';
import { likePattern as like } from './like.js';
import {
  cleanQuery, inParts, MIN_SIMILAR, SIMILAR_WINDOW, snippet, terms, TITLE_BONUS,
} from './search.js';
import { ownedCustomers } from './shares.js';

/**
 * The knowledge bases' part of the inbox's search (GET /api/search, src/search.js): the
 * concepts about the query, of the knowledge bases of the teams searched (a team's view: that
 * team; the personal view: the viewer's teams) and of the customers those teams own
 * (src/shares.js), as far as the viewer may read them (src/kbaccess.js). Found by their words
 * (title, aliases, type, tags, description and body, as src/kbindex.js keeps them in
 * `kb_concepts`) and by meaning (their CONTENT vectors, `type: kb`), best first.
 */

/** How many concepts a search answers. */
export const KB_RESULTS = 10;
/** What every word somewhere in a concept adds, and every word in its tags or description. */
export const KB_WORDS_BONUS = 0.4;
export const KB_TAG_BONUS = 0.3;
const KEYWORD_ROWS = 200;
const VECTOR_K = 20;

/** How many of the words are in `text`, case aside, as a fraction. */
const share = (text, words) => {
  const t = String(text || '').toLowerCase();
  return words.length ? words.filter((w) => t.includes(w)).length / words.length : 0;
};

/**
 * The knowledge bases searched for `teams` (slugs), `[{ repo, kind, slug, name }]`: the teams'
 * own, then those of the customers they own, those that exist and `me` may read. A merged
 * customer's is the one it was merged into now (src/orgmerge.js). None for no teams.
 */
export async function searchedBases(env, me, teams) {
  const list = [...new Set([].concat(teams || []).filter(Boolean))];
  if (!list.length) {
    return [];
  }
  const [owned, may] = await Promise.all([ownedCustomers(env, list), access(env, me)]);
  const { results } = await env.DB.prepare(`SELECT k.repo, k.kind, k.slug,
      COALESCE(t.name, o.name, k.slug) AS name
    FROM knowledge_bases k LEFT JOIN teams t ON k.kind = 'team' AND t.slug = k.slug
      LEFT JOIN orgs o ON k.kind = 'org' AND o.slug = k.slug
    WHERE ((k.kind = 'team' AND k.slug IN (SELECT value FROM json_each(?1)))
        OR (k.kind = 'org' AND k.slug IN (SELECT value FROM json_each(?2))))
      AND NOT (k.kind = 'org' AND k.slug IN (SELECT slug FROM org_merges))
    ORDER BY CASE k.kind WHEN 'team' THEN 0 ELSE 1 END, k.slug`)
    .bind(JSON.stringify(list), JSON.stringify([...owned])).all();
  return (results || []).filter((b) => may.read(b));
}

/** Filters for the concept vectors of `bases`: the teams' at once, the customers' in parts. */
export function kbFilters(bases) {
  const teams = bases.filter((b) => b.kind === 'team').map((b) => b.slug);
  const orgs = bases.filter((b) => b.kind === 'org').map((b) => b.slug);
  return [
    ...(teams.length ? [{ type: 'kb', team: teams.length === 1 ? teams[0] : { $in: teams } }] : []),
    ...inParts(orgs, (part) => ({ type: 'kb', org: part.length === 1 ? part[0] : { $in: part } })),
  ];
}

const COLUMNS = 'c.repo, c.path, c.type, c.title, c.description, c.tags, c.aliases, c.body';

/** The concepts of `repos` with every word in their names, type, tags, description or body. */
async function withWords(env, repos, words) {
  const hay = `(COALESCE(c.title, '') || ' ' || COALESCE(c.aliases, '') || ' '
    || COALESCE(c.type, '') || ' ' || COALESCE(c.tags, '') || ' '
    || COALESCE(c.description, '') || ' ' || COALESCE(c.body, ''))`;
  const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM kb_concepts c
    WHERE c.repo IN (SELECT value FROM json_each(?1))
      ${words.map((w, i) => `AND ${hay} LIKE ?${i + 3} ESCAPE '\\'`).join(' ')}
    ORDER BY c.repo, c.path LIMIT ?2`)
    .bind(JSON.stringify(repos), KEYWORD_ROWS, ...words.map(like)).all();
  return results || [];
}

/** The concepts of `bases` about the query's vector: `[{ key, score }]`, `key` `<repo>|<path>`. */
async function similarConcepts(env, bases, vectorP) {
  if (!env.CONTENT || !bases.length) {
    return [];
  }
  try {
    const vector = await vectorP;
    if (!vector) {
      return [];
    }
    const found = await Promise.all(kbFilters(bases).map((filter) => env.CONTENT.query(vector, {
      topK: VECTOR_K, filter, returnMetadata: 'all',
    })));
    const repos = new Set(bases.map((b) => b.repo));
    const matches = found.flatMap((f) => f.matches || [])
      .filter((m) => m.metadata && m.metadata.type === 'kb' && repos.has(m.metadata.repo)
        && typeof m.metadata.path === 'string')
      .sort((a, b) => b.score - a.score);
    const best = matches.length ? matches[0].score : 0;
    return matches.filter((m) => m.score >= MIN_SIMILAR && m.score >= best - SIMILAR_WINDOW)
      .map((m) => ({ key: `${m.metadata.repo}|${m.metadata.path}`, score: m.score }));
  } catch (e) {
    console.log(JSON.stringify({ route: 'search', error: `knowledge vector search failed: ${e.message}` }));
    return [];
  }
}

/** The rows of the concepts `keys` (`<repo>|<path>`) of `repos` that kb_concepts has. */
async function conceptsAt(env, repos, keys) {
  if (!keys.length) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM kb_concepts c
    WHERE c.repo IN (SELECT value FROM json_each(?1))
      AND c.repo || '|' || c.path IN (SELECT value FROM json_each(?2))`)
    .bind(JSON.stringify(repos), JSON.stringify(keys)).all();
  return results || [];
}

/**
 * A concept row of `kb_concepts` as a hit of knowledge base `b`: `all` whether every word of
 * `words` is in it somewhere, `about` its vector's similarity to the query (0 for none).
 */
export function conceptHit(r, b, words, { all = false, about = 0 } = {}) {
  const named = all ? share(`${r.title} ${r.aliases || ''}`, words) : 0;
  const tagged = all ? share(`${r.tags || ''} ${r.type || ''}`, words) : 0;
  const described = all ? share(r.description, words) : 0;
  // A body that starts with its title as a heading says it once, in the title.
  const body = String(r.body || '').replace(/^#[ \t]+.*(?:\r?\n)+/, '');
  const said = all ? share(body, words) : 0;
  const score = about + (all ? KB_WORDS_BONUS + TITLE_BONUS * named
    + KB_TAG_BONUS * Math.max(tagged, described) : 0);
  let text = null;
  if (said > 0) {
    text = snippet(body, words);
  } else if (!r.description && body) {
    text = snippet(body);
  }
  return {
    repo: r.repo,
    kind: b.kind,
    slug: b.slug,
    name: b.name,
    path: r.path,
    type: r.type || null,
    title: r.title,
    description: r.description || null,
    score: Math.round(score * 1000) / 1000,
    matched: [named > 0 && 'title', tagged > 0 && 'tags', described > 0 && 'description',
      said > 0 && 'text', about > 0 && 'topic'].filter(Boolean),
    snippet: text || null,
  };
}

/** Hits best first, as good ones by title, at most `limit`. */
export const bestHits = (hits, limit = KB_RESULTS) => hits
  .sort((x, y) => y.score - x.score || x.title.localeCompare(y.title))
  .slice(0, Math.max(1, Math.min(50, Number(limit) || KB_RESULTS)));

/**
 * The concepts about `q` in the knowledge bases searched for `teams` (`searchedBases`), best
 * first, at most `limit`: `[{ repo, kind, slug, name, path, type, title, description, score,
 * matched, snippet }]`, `matched` saying why (`title`: the title or an alias, `tags`: the tags or
 * the type, `description`, `text`: the body, `topic`: by meaning), `snippet` the part of the
 * body around the first word (or its start, when it has no description), else null. `vector`:
 * the query's (src/search.js `queryVector`), a promise.
 */
export async function findKnowledge(env, me, teams, q, { vector = null, limit = KB_RESULTS } = {}) {
  const query = cleanQuery(q);
  const words = terms(query);
  if (!words.length || !env.DB) {
    return [];
  }
  const bases = await searchedBases(env, me, teams);
  if (!bases.length) {
    return [];
  }
  const repos = bases.map((b) => b.repo);
  const [worded, similar] = await Promise.all([
    withWords(env, repos, words),
    similarConcepts(env, bases, vector),
  ]);
  const topic = new Map();
  for (const s of similar) {
    topic.set(s.key, Math.max(topic.get(s.key) || 0, s.score));
  }
  const keyOf = (r) => `${r.repo}|${r.path}`;
  const byWords = new Set(worded.map(keyOf));
  const rows = [...worded,
    ...await conceptsAt(env, repos, [...topic.keys()].filter((k) => !byWords.has(k)))];
  const base = new Map(bases.map((b) => [b.repo, b]));
  return bestHits(rows.map((r) => conceptHit(r, base.get(r.repo), words, {
    all: byWords.has(keyOf(r)), about: topic.get(keyOf(r)) || 0,
  })), limit);
}
