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
 * A customer's stack, as the inbox's list by customer shows it: the parts of its stack drawing
 * (`stack.md` in kb-org-<slug>, src/stack.js), kept in D1 (`org_stacks`) so that a page of the
 * inbox reads every customer's at once. The drawing is the only customer-level record of what a
 * customer runs (docs/ARCHITECTURE.md, "Stack drawing"): Clef's answers are per thread.
 */

import { parseStack, STACK_PATH } from './stack.js';
import { readText } from './agent/repos.js';

/** The parts of a stack.md that are not people, `[{ name, tech, layer }]`; [] for none. */
export function stackParts(text) {
  if (!text) {
    return [];
  }
  const d = parseStack(text);
  if (d.error) {
    return [];
  }
  return d.parts.filter((p) => p.kind !== 'person')
    .map((p) => ({ name: p.name, tech: p.tech || null, layer: p.layer }));
}

/** Keeps customer `org`'s parts, from `text` (its stack.md; null: it has none). */
export async function storeOrgStack(env, org, text, now = new Date()) {
  await env.DB.prepare(`INSERT INTO org_stacks (org, parts, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (org) DO UPDATE SET parts = excluded.parts, updated_at = excluded.updated_at`)
    .bind(org, JSON.stringify(stackParts(text)), now.toISOString()).run();
}

/** The stacks of `orgs`, `{ [org]: [{ name, tech, layer }] }`, those with parts only. */
export async function orgStacksOf(env, orgs) {
  const list = [...new Set((orgs || []).filter(Boolean))];
  if (!list.length || !env.DB) {
    return {};
  }
  const { results } = await env.DB.prepare(`SELECT org, parts FROM org_stacks
    WHERE org IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(list)).all();
  const out = {};
  for (const r of results || []) {
    let parts = [];
    try {
      parts = JSON.parse(r.parts);
    } catch {
      parts = [];
    }
    if (Array.isArray(parts) && parts.length) {
      out[r.org] = parts;
    }
  }
  return out;
}

/**
 * Cron: the customers' knowledge bases that have no row in `org_stacks` yet, `limit` of them:
 * their stack.md read and kept (`[]` when they have none). Writes keep it after that.
 */
export async function syncOrgStacks(env, { limit = 100, parallel = 8 } = {}) {
  if (!env.ARTIFACTS || !env.DB) {
    return { skipped: 'no knowledge bases' };
  }
  const { results } = await env.DB.prepare(`SELECT k.repo, k.slug FROM knowledge_bases k
    WHERE k.kind = 'org' AND NOT EXISTS (SELECT 1 FROM org_stacks s WHERE s.org = k.slug)
    LIMIT ?`).bind(limit).all();
  const list = results || [];
  const tally = { stored: 0, failed: 0 };
  const one = async (kb) => {
    try {
      const file = await readText(env, kb.repo, STACK_PATH, { full: true });
      // A knowledge base without the file, or still empty, has no drawing; any other error
      // is asked again on the next run.
      if (file.error && !/no such file|empty/.test(file.error)) {
        throw new Error(file.error);
      }
      await storeOrgStack(env, kb.slug, file.error ? null : file.text);
      tally.stored += 1;
    } catch (e) {
      tally.failed += 1;
      console.error(JSON.stringify({
        route: 'cron', kb: 'stacks', repo: kb.repo, error: e.message,
      }));
    }
  };
  for (let i = 0; i < list.length; i += parallel) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(list.slice(i, i + parallel).map(one));
  }
  return tally;
}
