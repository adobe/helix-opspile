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
  compileCatalog, inCatalog, PRODUCTS, storeCatalog,
} from './catalog.js';
import { AREAS, compileAreas, isArea } from './areas.js';
import { listFiles, readBlobs } from './agent/repos.js';

const BLOBS = 50;

/**
 * Cron: compiles the catalog of every team's knowledge base whose head is not the commit it was
 * compiled from (`knowledge_bases.catalog_commit`): a revert, a push from outside, a write whose
 * compile failed. Writes compile their own (src/agent/kbwrite.js). A knowledge base without
 * products/ leaves the team no catalog rows; one whose listing was cut short is left as it is.
 */
export async function syncCatalogs(env, { parallel = 4 } = {}) {
  if (!env.ARTIFACTS || !env.DB) {
    return { skipped: 'no knowledge bases' };
  }
  const { results } = await env.DB.prepare(`SELECT k.repo, k.slug, k.catalog_commit AS done,
      (SELECT COUNT(*) FROM tech_stack s WHERE s.team = k.slug AND s.path IS NOT NULL)
      + (SELECT COUNT(*) FROM tech_moves m WHERE m.team = k.slug)
      + (SELECT COUNT(*) FROM areas a WHERE a.team = k.slug) AS kept
    FROM knowledge_bases k WHERE k.kind = 'team'`).all();
  const out = { compiled: [], failed: 0 };
  // A directory's files, or none when it is not there; null when the listing was cut short.
  const listed = async (kb, dir) => {
    const res = await listFiles(env, kb.repo, dir, { recursive: true });
    if (res.error || res.empty) {
      if (!/no such path/.test(res.error || 'no such path')) {
        throw new Error(res.error);
      }
      return { commit: res.commit || null, entries: [] };
    }
    return res.truncated ? null : res;
  };
  const one = async (kb) => {
    try {
      const [products, areas] = await Promise.all([listed(kb, PRODUCTS), listed(kb, AREAS)]);
      if (!products || !areas) {
        return;
      }
      const commit = products.commit || areas.commit;
      const entries = [...products.entries, ...areas.entries];
      if (!entries.length) {
        if (kb.kept || kb.done) {
          const none = { rows: [], moves: [], areas: [] };
          await storeCatalog(env, { team: kb.slug, repo: kb.repo }, none);
          out.compiled.push(kb.slug);
        }
        return;
      }
      if (commit === kb.done) {
        return;
      }
      const blobs = entries.filter((e) => e.type === 'blob' && (inCatalog(e.path) || isArea(e.path)));
      const texts = {};
      for (let i = 0; i < blobs.length; i += BLOBS) {
        const hashes = blobs.slice(i, i + BLOBS).map((b) => b.hash);
        // eslint-disable-next-line no-await-in-loop
        Object.assign(texts, await readBlobs(env, kb.repo, hashes));
      }
      // A blob that could not be read is no file deleted: compile once every one is there, and
      // keep the rows and the watermark until then.
      const unread = blobs.filter((b) => texts[b.hash] == null);
      if (unread.length) {
        throw new Error(`${unread.length} of ${blobs.length} catalog files could not be read`);
      }
      const files = blobs.map((b) => ({ path: b.path, text: texts[b.hash] }));
      const where = { team: kb.slug, repo: kb.repo, commit };
      await storeCatalog(env, where, {
        ...compileCatalog(files.filter((f) => inCatalog(f.path))),
        areas: compileAreas(files.filter((f) => isArea(f.path))),
      });
      out.compiled.push(kb.slug);
    } catch (e) {
      out.failed += 1;
      console.error(JSON.stringify({
        route: 'cron', kb: 'catalog', repo: kb.repo, error: e.message,
      }));
    }
  };
  const list = results || [];
  for (let i = 0; i < list.length; i += parallel) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(list.slice(i, i + parallel).map(one));
  }
  return out;
}
