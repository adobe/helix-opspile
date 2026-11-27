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

import {
  isEntry, scalar, splitFrontmatter, strings,
} from './agent/okf.js';
import { readBlobs, treeFiles } from './agent/repos.js';
import { sha256 } from './raw.js';
import { chunks, embed } from './vectors.js';

/**
 * The knowledge bases' concepts as the inbox's search finds them (src/kbsearch.js): a row of
 * `kb_concepts` per markdown entry, with its frontmatter's type, title, description, tags and
 * aliases and its body, and a vector of it in CONTENT (`type: kb`, the knowledge base's `team`
 * or `org` slug, `repo`, `path`). Every write updates the rows of the files it changed
 * (src/agent/kbwrite.js); the cron reads the knowledge bases not read yet
 * (`knowledge_bases.search_commit` NULL) in full, and makes the vectors of the rows that have
 * none (`embedded` NULL).
 */

/** How much of a concept's body is kept to search in. */
export const MAX_BODY = 8 * 1024;
/** A concept's vector is the mean of at most this many pieces of it. */
const MAX_CONCEPT_CHUNKS = 4;
/** Rows per D1 batch, blobs per read. */
const ROWS = 20;
const BLOBS = 50;

/** Whether a file of a knowledge base is a concept the search finds: an entry in markdown. */
export const isConcept = (path) => /\.md$/i.test(String(path)) && isEntry(path);

/** The id of a concept's vector in CONTENT. */
export const conceptVectorId = async (repo, path) => (await sha256(`kb:${repo}|${path}`)).slice(0, 48);

/**
 * What the search keeps of concept `path` with markdown `text`, or null for a file that is no
 * concept: its type, title (its frontmatter's, else its first heading, else its file name),
 * description, tags and aliases (comma-separated) and the first MAX_BODY characters of its body.
 */
export function conceptOf(path, text) {
  if (!isConcept(path)) {
    return null;
  }
  const fm = splitFrontmatter(text);
  const yaml = fm ? fm.yaml : '';
  const body = (fm ? fm.body : String(text || '')).trim();
  const heading = /^#[ \t]+(.+)$/m.exec(body);
  const list = (key) => strings(yaml, key).join(', ') || null;
  return {
    type: scalar(yaml, 'type') || null,
    title: scalar(yaml, 'title') || (heading && heading[1].trim())
      || String(path).split('/').pop().replace(/\.md$/i, ''),
    description: scalar(yaml, 'description') || null,
    tags: list('tags'),
    aliases: list('aliases'),
    body: body.slice(0, MAX_BODY),
  };
}

/** The text a concept's vector is made from: its names first, then what it says. */
export function conceptText(row) {
  return [row.title, row.aliases, row.type, row.tags, row.description, row.body]
    .filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
}

/**
 * Keeps the concepts of `files` (`{ path, hash, text }`) of knowledge base `repo` and forgets
 * those at `removed` (paths), in batches; with `commit` (a string), the last batch records it
 * as the commit the knowledge base was read from in full. A file that is no concept is left out;
 * a concept whose blob changed loses its vector's mark, so the cron makes it again. `was`
 * (a full read's: the rows' blob hashes by path, read before the tree) changes only the rows
 * that still have those hashes, so a write's update in between is not undone.
 */
export async function storeConcepts(env, repo, files, { removed = [], commit, was } = {}) {
  const kept = files.map((f) => ({ ...f, concept: conceptOf(f.path, f.text) }))
    .filter((f) => f.concept);
  const upsert = ({ path, hash, concept: c }) => {
    const before = was ? was.get(path) : undefined;
    let tail = `ON CONFLICT (repo, path) DO UPDATE SET hash = excluded.hash, type = excluded.type,
        title = excluded.title, description = excluded.description, tags = excluded.tags,
        aliases = excluded.aliases, body = excluded.body,
        embedded = CASE WHEN kb_concepts.hash = excluded.hash THEN kb_concepts.embedded END`;
    if (was) {
      tail = before === undefined ? 'ON CONFLICT (repo, path) DO NOTHING'
        : `${tail} WHERE kb_concepts.hash = ?10`;
    }
    const values = [repo, path, hash, c.type, c.title, c.description, c.tags, c.aliases, c.body];
    return env.DB.prepare(`INSERT INTO kb_concepts
        (repo, path, hash, type, title, description, tags, aliases, body, embedded)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL) ${tail}`)
      .bind(...values, ...(was && before !== undefined ? [before] : []));
  };
  const statements = [
    ...kept.map(upsert),
    ...removed.filter(isConcept).map((path) => (was
      ? env.DB.prepare('DELETE FROM kb_concepts WHERE repo = ? AND path = ? AND hash = ?')
        .bind(repo, path, was.get(path) ?? null)
      : env.DB.prepare('DELETE FROM kb_concepts WHERE repo = ? AND path = ?').bind(repo, path))),
  ];
  if (typeof commit === 'string') {
    statements.push(env.DB.prepare('UPDATE knowledge_bases SET search_commit = ? WHERE repo = ?')
      .bind(commit, repo));
  }
  for (let i = 0; i < statements.length; i += ROWS) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.batch(statements.slice(i, i + ROWS));
  }
  const gone = removed.filter(isConcept);
  if (gone.length && env.CONTENT) {
    // A vector left behind finds nothing: the search keeps only what kb_concepts has.
    await env.CONTENT.deleteByIds(await Promise.all(gone.map((p) => conceptVectorId(repo, p))))
      .catch((e) => console.error(JSON.stringify({
        route: 'kb', action: 'search', repo, error: `vectors kept: ${e.message}`,
      })));
  }
  return { stored: kept.length, removed: gone.length };
}

/**
 * After a write was pushed (src/agent/kbwrite.js): the rows of the files it changed, `files`
 * as `{ path, hash, text }` or `{ path, deleted: true }`. A failure is logged and leaves the
 * knowledge base to be read in full again by the cron; it never fails the write.
 */
export async function indexWrite(env, repo, files) {
  if (!env.DB || !files.some((f) => isConcept(f.path))) {
    return;
  }
  try {
    await storeConcepts(env, repo, files.filter((f) => !f.deleted), {
      removed: files.filter((f) => f.deleted).map((f) => f.path),
    });
  } catch (e) {
    console.error(JSON.stringify({
      route: 'kb', action: 'search', repo, error: e.message,
    }));
    await env.DB.prepare('UPDATE knowledge_bases SET search_commit = NULL WHERE repo = ?')
      .bind(repo).run().catch(() => {});
  }
}

/**
 * Reads knowledge base `kb` (`{ repo }`) in full: the concepts whose blob is not the row's,
 * the rows of files that are gone, and the watermark, written last. A blob that cannot be read
 * fails it, so the watermark stays NULL and the next run reads it again.
 */
export async function readConcepts(env, kb) {
  // The rows first, then the tree: a write that lands in between changes rows from these.
  const { results } = await env.DB.prepare('SELECT path, hash FROM kb_concepts WHERE repo = ?')
    .bind(kb.repo).all();
  const tree = await treeFiles(env, kb.repo, isConcept);
  const had = new Map((results || []).map((r) => [r.path, r.hash]));
  const changed = tree.files.filter((f) => had.get(f.path) !== f.hash);
  const texts = {};
  for (let i = 0; i < changed.length; i += BLOBS) {
    const hashes = changed.slice(i, i + BLOBS).map((f) => f.hash);
    // eslint-disable-next-line no-await-in-loop
    Object.assign(texts, await readBlobs(env, kb.repo, hashes));
  }
  const unread = changed.filter((f) => texts[f.hash] == null);
  if (unread.length) {
    throw new Error(`${unread.length} of ${changed.length} concepts could not be read`);
  }
  const present = new Set(tree.files.map((f) => f.path));
  return storeConcepts(env, kb.repo, changed.map((f) => ({ ...f, text: texts[f.hash] })), {
    removed: [...had.keys()].filter((p) => !present.has(p)),
    commit: tree.commit || '',
    was: had,
  });
}

/**
 * Makes the vectors of up to `limit` concepts that have none, `{ embedded }`. A row is marked
 * only while it still has the blob its vector was made from, so a write in between is made
 * again. Without CONTENT or Workers AI there are none, and the search goes by words alone.
 */
export async function embedConcepts(env, { limit = 100 } = {}) {
  if (!env.CONTENT || !env.AI) {
    return { embedded: 0 };
  }
  const { results } = await env.DB.prepare(`SELECT c.repo, c.path, c.hash, c.type, c.title,
      c.description, c.tags, c.aliases, c.body, k.kind, k.slug
    FROM kb_concepts c JOIN knowledge_bases k ON k.repo = c.repo
    WHERE c.embedded IS NULL LIMIT ?`).bind(limit).all();
  // Never empty: a concept has a title, its file name at least.
  const rows = (results || []).map((r) => ({ ...r, text: conceptText(r) }));
  if (!rows.length) {
    return { embedded: 0 };
  }
  const values = await embed(env, rows.map((r) => chunks(r.text).slice(0, MAX_CONCEPT_CHUNKS)));
  const items = await Promise.all(rows.map(async (r, i) => ({
    id: await conceptVectorId(r.repo, r.path),
    values: values[i],
    metadata: {
      type: 'kb', [r.kind === 'team' ? 'team' : 'org']: r.slug, repo: r.repo, path: r.path,
    },
  })));
  for (let i = 0; i < items.length; i += BLOBS) {
    // eslint-disable-next-line no-await-in-loop
    await env.CONTENT.upsert(items.slice(i, i + BLOBS));
  }
  const marks = await Promise.all(rows.map(async (r) => env.DB.prepare(`UPDATE kb_concepts
      SET embedded = ? WHERE repo = ? AND path = ? AND hash = ?`)
    .bind((await sha256(r.text)).slice(0, 32), r.repo, r.path, r.hash)));
  for (let i = 0; i < marks.length; i += ROWS) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.batch(marks.slice(i, i + ROWS));
  }
  return { embedded: rows.length };
}

/**
 * Cron: reads up to `limit` knowledge bases not read yet in full (the teams' first), then makes
 * the vectors of the concepts that have none. `{ read, failed, embedded }`.
 */
export async function syncConcepts(env, { limit = 30, parallel = 6, embedLimit = 100 } = {}) {
  if (!env.ARTIFACTS || !env.DB) {
    return { skipped: 'no knowledge bases' };
  }
  const { results } = await env.DB.prepare(`SELECT repo, kind, slug FROM knowledge_bases
    WHERE search_commit IS NULL ORDER BY kind = 'team' DESC, RANDOM() LIMIT ?`).bind(limit).all();
  const list = results || [];
  const out = { read: 0, failed: 0, embedded: 0 };
  const one = async (kb) => {
    try {
      await readConcepts(env, kb);
      out.read += 1;
    } catch (e) {
      out.failed += 1;
      console.error(JSON.stringify({
        route: 'cron', kb: 'search', repo: kb.repo, error: e.message,
      }));
    }
  };
  for (let i = 0; i < list.length; i += parallel) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(list.slice(i, i + parallel).map(one));
  }
  try {
    out.embedded = (await embedConcepts(env, { limit: embedLimit })).embedded;
  } catch (e) {
    console.error(JSON.stringify({ route: 'cron', kb: 'search', error: `vectors: ${e.message}` }));
  }
  return out;
}
