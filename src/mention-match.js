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
 * Who a typed `@…` means: the matching and the order of the composer's mention suggestions
 * (src/post.js `mentionable`, and the fake one of `npm run ui:dev`). No I/O.
 *
 * What is typed matches, ignoring case and accents, the start of any word of the name the
 * account shows, of its other names (the Slack login and display name, the Discord
 * username), or of its mail address before the @ — so "@K", "@kir", "@sel" and "@ksel" all
 * find "Kira Selby" whose login is "kselby". Several words match in any order
 * ("@selby k"). A word starts after anything that is not a letter or a digit, so the parts
 * of "Jean-Luc", "o'neil" and "first.last" count.
 */

/** Lower case, without accents: "Zoë" and "zoe" are the same. */
export const fold = (s) => String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();

const WORD = /[\p{L}\p{N}]+/gu;
const words = (s) => s.match(WORD) || [];

/** Where `q` starts a word of `text` (both folded): 0 at its start, 1 inside, -1 nowhere. */
function wordStart(text, q) {
  if (text.startsWith(q)) {
    return 0;
  }
  for (let i = text.indexOf(q, 1); i > 0; i = text.indexOf(q, i + 1)) {
    if (!/[\p{L}\p{N}]/u.test(text[i - 1])) {
      return 1;
    }
  }
  return -1;
}

/**
 * How well `q` names an account, lower is better, or -1 when it does not:
 * the start of the name (0), of another name or the mail (1), the start of a later word of
 * the name (2) or of the others (3), every typed word the start of some word of the name (4)
 * or of the others (5). An empty `q` matches everyone (0).
 *
 * @param {string} q what follows the @
 * @param {{ name: string, aliases?: string[] }} account `aliases`: other names, mail addresses
 */
export function mentionScore(q, { name, aliases = [] }) {
  const want = fold(q).trim();
  if (!want) {
    return 0;
  }
  const texts = [fold(name), ...aliases.filter(Boolean).map((a) => fold(String(a).split('@')[0]))];
  let best = -1;
  const better = (score) => {
    if (best < 0 || score < best) {
      best = score;
    }
  };
  texts.forEach((text, i) => {
    const other = i > 0 ? 1 : 0;
    const at = wordStart(text, want);
    if (at >= 0) {
      better(at * 2 + other);
      return;
    }
    const typed = words(want);
    const has = words(text);
    if (typed.length > 1 && typed.every((w) => has.some((h) => h.startsWith(w)))) {
      better(4 + other);
    }
  });
  if (best < 0 && words(want).length > 1) {
    // The words may be spread over the names: "@kira ksel".
    const all = texts.flatMap(words);
    if (words(want).every((w) => all.some((h) => h.startsWith(w)))) {
      best = 5;
    }
  }
  return best;
}

/**
 * The accounts `q` matches, best first: those who posted in the thread, then those in the
 * channel (or, on Teams, the team), then by how well they match, Adobe before others, by name.
 *
 * @template {{ name: string, aliases?: string[], here?: boolean, member?: boolean,
 *   staff?: boolean }} T
 * @param {T[]} accounts
 * @param {string} q
 * @param {number} [max]
 * @returns {T[]}
 */
export function rankMentions(accounts, q, max = Infinity) {
  return accounts
    .map((a) => ({ a, score: mentionScore(q, a) }))
    .filter((x) => x.score >= 0)
    .sort((x, y) => (Number(Boolean(y.a.here)) - Number(Boolean(x.a.here)))
      || (Number(Boolean(y.a.member)) - Number(Boolean(x.a.member)))
      || (x.score - y.score)
      || (Number(Boolean(y.a.staff)) - Number(Boolean(x.a.staff)))
      || fold(x.a.name).localeCompare(fold(y.a.name)))
    .slice(0, max)
    .map((x) => x.a);
}
