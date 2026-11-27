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
 * The Markdown of a part of a rendered message: what someone selected in the inbox's draft
 * line (its text, as the page shows it), as the part of the draft's source it came from, so
 * that sending or editing it keeps its links, code and mentions.
 *
 * The text the page shows is the source without its markup, more or less: mentions and
 * links read as written, emoji and the page's cards do not. So the two are aligned as a
 * diff (Myers'), where the markup is what only the source has; the selection's first and last
 * characters say where in the source it starts and ends. A selection that starts or ends
 * inside some formatting (bold, code, a link) would leave half of its markup: the markup that is
 * missing is added at its ends, from the source's tree (mdast), so the formatting
 * is closed again. The markup right at its edges comes along when the part still reads as what
 * was selected (`textOf`, the page's rendering as text): the backticks of a code span selected
 * whole, the brackets and address of a link. All of what comes out is the source's, as written.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';

/**
 * Markdown as a tree, with what a selection can start or end inside of: CommonMark and GFM's
 * strike-through. Bare links have no markup, and tables are not cut (src/mdast.js reads all of
 * GFM, but bundled into the page it would bring the writer along).
 */
const readMarkdown = (src) => fromMarkdown(src, {
  extensions: [gfmStrikethrough()],
  mdastExtensions: [gfmStrikethroughFromMarkdown()],
});

/** At most this many characters of markup between the two: past it, the selection as text. */
const MAX_EDITS = 4000;

/** White space, run together and trimmed: the page's blocks put line ends where it likes. */
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * For each character of `a`, the index in `b` of the character it is aligned with, or -1:
 * the longest common subsequence, by Myers' diff. Null when more than `max` characters differ.
 *
 * @param {string} a
 * @param {string} b
 * @param {number} [max]
 * @returns {Int32Array|null}
 */
export function align(a, b, max = MAX_EDITS) {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, max);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]))
        ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) {
    return null;
  }
  const at = new Int32Array(n).fill(-1);
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d - 1];
    const V = (k) => prev[k + d - 1];
    const k = x - y;
    const pk = (k === -d || (k !== d && V(k - 1) < V(k + 1))) ? k + 1 : k - 1;
    const px = V(pk);
    const py = px - pk;
    while (x > px && y > py) {
      x -= 1;
      y -= 1;
      at[x] = y;
    }
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    at[x] = y;
  }
  return at;
}

/** The formatting whose markup is around its text: what a selection may start or end in. */
const WRAPS = new Set(['strong', 'emphasis', 'delete', 'link', 'inlineCode', 'code']);

/**
 * Where the markup of `node` (read from `source`) ends before its text, and starts again after
 * it: its children's, or its value's (code).
 */
function inner(node, source) {
  const from = node.position.start.offset;
  const to = node.position.end.offset;
  if (node.children?.length) {
    return [node.children[0].position.start.offset, node.children.at(-1).position.end.offset];
  }
  const at = source.slice(from, to).indexOf(node.value ?? '');
  return at < 0 ? null : [from + at, from + at + node.value.length];
}

/**
 * `source.slice(s, e)`, with the markup of the formatting it starts or ends inside of added
 * at its ends: the opening markup of what starts before it (outermost first), and the closing
 * markup of what ends after it (innermost first). All of it is the source's.
 */
function closed(source, tree, s, e) {
  const open = [];
  const close = [];
  const walk = (node) => {
    const at = node.position;
    if (!at || at.end.offset <= s || at.start.offset >= e) {
      return;
    }
    const text = WRAPS.has(node.type) && inner(node, source);
    if (text) {
      if (at.start.offset < s && s >= text[0]) {
        open.push(source.slice(at.start.offset, text[0]));
      }
      if (at.end.offset > e && e <= text[1]) {
        close.unshift(source.slice(text[1], at.end.offset));
      }
    }
    for (const c of node.children || []) {
      walk(c);
    }
  };
  walk(tree);
  return `${open.join('')}${source.slice(s, e)}${close.join('')}`.trim();
}

/**
 * The Markdown of `text.slice(start, end)`, where `text` is source `src` as the page shows it
 * (without tags), and `textOf` shows Markdown as that text. All of the text selected is the
 * source; if the two cannot be aligned, the selection as text. Null when nothing is selected.
 *
 * @param {string} src
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {(md: string) => string} textOf
 * @returns {string|null}
 */
export function pickSource(src, text, start, end, textOf) {
  const source = String(src || '');
  const want = norm(text.slice(start, end));
  if (!want) {
    return null;
  }
  if (want === norm(text)) {
    return source.trim();
  }
  const at = align(text, source);
  const first = at && at.slice(start, end).findIndex((i) => i >= 0);
  if (!at || first < 0) {
    return want;
  }
  let last = end - 1;
  while (at[last] < 0) {
    last -= 1;
  }
  const s = at[start + first];
  const e = at[last] + 1;
  const taken = new Uint8Array(source.length);
  for (const i of at) {
    if (i >= 0) {
      taken[i] = 1;
    }
  }
  // The markup next to its edges, on their lines.
  let s2 = s;
  while (s2 > 0 && !taken[s2 - 1] && source[s2 - 1] !== '\n') {
    s2 -= 1;
  }
  let e2 = e;
  while (e2 < source.length && !taken[e2] && source[e2] !== '\n') {
    e2 += 1;
  }
  const tree = readMarkdown(source);
  for (const [a, b] of [[s2, e2], [s2, e], [s, e2]]) {
    const md = closed(source, tree, a, b);
    if (norm(textOf(md)) === want) {
      return md;
    }
  }
  return closed(source, tree, s, e) || want;
}
