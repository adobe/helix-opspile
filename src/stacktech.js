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
 * A customer's stack drawing names its parts' technologies by the catalog's ids (src/catalog.js):
 * on every write of `stack.md`, a part's Tech is a technology some team has, `own` (what the
 * customer built) or empty. An id from before a move is written as the id it moved to; a part
 * without one whose name a technology covers (src/products.js `coveredBy`, "Cloudflare",
 * "SharePoint Online") gets that one; an id no team has is refused for an agent and left as it
 * is for a person (who sees it on the drawing).
 */

import { splitFrontmatter } from './agent/okf.js';
import { resolveTech, techMoves } from './catalog.js';
import { coveredBy, techIndex } from './products.js';
import { parseStack, STACK_PATH, withPartTech } from './stack.js';

export const OWN = 'own';

/**
 * `text` (a stack.md) with its parts' Tech as the catalog has them: `{ text, filled, moved,
 * unknown }`, `text` unchanged when nothing changed. `rows`: tech_stack, `moves`: techMoves.
 */
export function fixStackTech(text, rows, moves = {}) {
  const fm = splitFrontmatter(text);
  const drawing = fm && parseStack(fm.body);
  if (!drawing || drawing.error) {
    return {
      text, filled: [], moved: [], unknown: [],
    };
  }
  const known = new Set((rows || []).map((r) => r.tech));
  const index = techIndex((rows || []).filter((r) => r.enabled));
  const filled = [];
  const moved = [];
  const unknown = [];
  const parts = drawing.parts.map((p) => {
    if (p.tech === OWN) {
      return p;
    }
    if (p.tech) {
      const now = resolveTech(p.tech, moves);
      if (now !== p.tech && known.has(now)) {
        moved.push({ part: p.name, from: p.tech, tech: now });
        return { ...p, tech: now };
      }
      if (!known.has(p.tech)) {
        unknown.push({ part: p.name, tech: p.tech });
      }
      return p;
    }
    if (p.kind === 'person') {
      return p;
    }
    const covered = coveredBy(p.name, index);
    if (covered) {
      filled.push({ part: p.name, tech: covered });
      return { ...p, tech: covered };
    }
    return p;
  });
  if (!filled.length && !moved.length) {
    return {
      text, filled, moved, unknown,
    };
  }
  // Only the Tech cells: a person's description, and text where they put it, stay as they were.
  const out = withPartTech(text, parts.map((p) => p.tech));
  return {
    text: out, filled, moved, unknown,
  };
}

/**
 * The `changes` of a write of a customer's knowledge base with each stack.md's Tech fixed
 * (`fixStackTech`): `{ changes, filled, error }`. `staff`: a person's write, which keeps an id
 * no team has (an agent's is refused).
 */
export async function checkStackTech(env, changes, { staff = false } = {}) {
  const stacks = (changes || []).filter((c) => c.path === STACK_PATH && !c.delete);
  if (!stacks.length || !env.DB) {
    return { changes, filled: [] };
  }
  const [{ results: rows }, moves] = await Promise.all([
    env.DB.prepare('SELECT tech, name, description, aliases, enabled FROM tech_stack').all(),
    techMoves(env),
  ]);
  const filled = [];
  const out = [];
  for (const c of changes) {
    if (c.path !== STACK_PATH || c.delete) {
      out.push(c);
      // eslint-disable-next-line no-continue
      continue;
    }
    const r = fixStackTech(String(c.content ?? ''), rows || [], moves);
    if (r.unknown.length && !staff) {
      return {
        error: `${STACK_PATH}: no team has the technology ${r.unknown.map((u) => `${u.tech} (part ${u.part})`).join(', ')}; Tech is a technology's id as the stack-drawing section and the inbox name it, ${OWN} for what the customer built, or empty`,
      };
    }
    filled.push(...r.filled, ...r.moved);
    out.push({ ...c, content: r.text });
  }
  return { changes: out, filled };
}
