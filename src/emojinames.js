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
 * Emoji names as people type them, to the name Slack knows: the Worker uses it before posting
 * (src/shortcodes.js), the inbox to show `:codes:` (bundled into the page with
 * src/ui-markdown.js), and scripts/emoji.mjs to leave out aliases it finds anyway. No imports:
 * the tables come in as arguments.
 */

/**
 * A name without case and separators: `Face-Palm`, `face_palm` and `facepalm` are one. A
 * leading `-` is not a separator (`-1` is thumbs down).
 */
export const squash = (name) => String(name).toLowerCase().replace(/(?!^)[\s_-]+/g, '');

// Discord's and GitHub's tones: `thumbsup_tone3` is Slack's `thumbsup::skin-tone-4`.
const TONE = /^(.+?)[_-]tone([1-5])$/;

/**
 * The name Slack knows for an emoji name as Slack, GitHub, Discord or Teams write it, or with
 * other separators (`facepalm` and `face-palm` for `face_palm`, `thumbs-up` for `thumbsup`).
 * A skin tone stays on (`::skin-tone-N`, or Discord's `_toneN`), where the emoji takes one.
 *
 * @param {Record<string, string>} names name → character (Slack's, and any other known ones)
 * @param {Record<string, string>} [aliases] other name → its name in `names`
 * @param {Iterable<string>} [skin] names that take skin tones
 * @returns {(name: string) => string|undefined} the name in `names`, or undefined
 */
export function emojiLookup(names, aliases = {}, skin = []) {
  const tones = new Set(skin);
  const has = (n) => Object.hasOwn(names, n);
  // Squashed name → name; null where two emoji squash to the same name.
  const loose = new Map();
  const add = (key, name) => {
    const k = squash(key);
    const was = loose.get(k);
    if (was === undefined) {
      loose.set(k, name);
    } else if (was && names[was] !== names[name]) {
      loose.set(k, null);
    }
  };
  Object.keys(names).forEach((n) => add(n, n));
  Object.entries(aliases).forEach(([a, n]) => has(n) && add(a, n));
  const base = (n) => {
    if (has(n)) {
      return n;
    }
    if (Object.hasOwn(aliases, n) && has(aliases[n])) {
      return aliases[n];
    }
    return loose.get(squash(n)) || undefined;
  };
  return (name) => {
    const [typed, skinTone] = String(name || '').split('::skin-tone-');
    let b = typed;
    let tone = skinTone;
    let c = base(b);
    const m = !c && tone === undefined && TONE.exec(b);
    if (m) {
      [, b] = m;
      tone = String(Number(m[2]) + 1);
      c = base(b);
    }
    if (!c) {
      return undefined;
    }
    return /^[2-6]$/.test(tone || '') && tones.has(c) ? `${c}::skin-tone-${tone}` : c;
  };
}

/**
 * Where `q` is in `key` (both lower case): 0 the whole name, 1 its start, 2 the start of one
 * of its parts (after `_` or `-`), 3 anywhere; 1 or 2 also where it starts there once the
 * separators are left out; -1 nowhere.
 */
function place(key, q) {
  if (key === q) {
    return 0;
  }
  const i = key.indexOf(q);
  if (i === 0) {
    return 1;
  }
  if (i > 0) {
    for (let j = i; j > 0; j = key.indexOf(q, j + 1)) {
      if (key[j - 1] === '_' || key[j - 1] === '-') {
        return 2;
      }
    }
    return 3;
  }
  // Without separators, from the start of a part: `facep` is in `face_palm`.
  const flat = squash(q);
  const starts = [0, ...[...key.matchAll(/[_-]/g)].map((m) => m.index + 1)];
  const j = starts.find((at) => squash(key.slice(at)).startsWith(flat));
  if (j === undefined) {
    return -1;
  }
  return j === 0 ? 1 : 2;
}

/**
 * The emoji whose name has `q` in it, for the composer's `:` suggestions: at most `limit`
 * names of `names`, the whole name first, then those it starts, then those with a part it
 * starts (`:check` finds `white_check_mark`), then any; among them the shorter name first.
 * Another name (`aliases`) that has `q` stands for its emoji, after the names that have it
 * as much. One name per emoji, the first: `:thu` finds `thumbsup`, not `+1`.
 *
 * @param {Record<string, string>} names name → character
 * @param {Record<string, string>} aliases other name → its name in `names`
 * @param {string} q what was typed after the `:`
 * @param {number} [limit]
 * @returns {string[]} names in `names`
 */
export function matchEmoji(names, aliases, q, limit = 8) {
  const typed = String(q || '').toLowerCase();
  if (!typed) {
    return [];
  }
  const hits = [];
  const consider = (key, name, other) => {
    const at = place(key.toLowerCase(), typed);
    if (at >= 0) {
      hits.push({
        key, name, at, other,
      });
    }
  };
  Object.keys(names).forEach((n) => consider(n, n, 0));
  Object.entries(aliases || {}).forEach(([a, n]) => Object.hasOwn(names, n) && consider(a, n, 1));
  hits.sort((a, b) => a.at - b.at || a.other - b.other || a.key.length - b.key.length
    || (a.key < b.key ? -1 : 1));
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    if (out.length >= limit) {
      break;
    }
    const c = names[h.name];
    if (!seen.has(c)) {
      seen.add(c);
      out.push(h.name);
    }
  }
  return out;
}
