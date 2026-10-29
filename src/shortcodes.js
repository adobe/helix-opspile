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
  EMOJI_ALIASES, EMOJI_KEYWORDS, SKIN_TONES, SLACK_EMOJI,
} from './emoji.js';
import { emojiLookup, squash } from './emojinames.js';
import { CLEF } from './label.js';

/**
 * `:shortcodes:` in a reply, as the platform it goes to wants them, before it is posted:
 *
 * - a name Slack knows stays; another platform's name or spelling becomes Slack's
 *   (`:facepalm:` is `:face_palm:`, `:thumbs-up:` is `:thumbsup:`; src/emojinames.js)
 * - a custom emoji of the workspace (one somebody reacted with) stays as it is
 * - for any other name, Clef picks the closest emoji from a short list of candidates
 *   (`:completed:` is ✅), or none; then the name stays as typed
 *
 * Slack gets `:name:`, Teams and Discord the character. Code is left alone.
 */

// Clef is asked about at most this many names per reply, each once per isolate.
export const MAX_ASK = 3;
export const CLEF_TIMEOUT_MS = 2500;
export const SUGGEST_TIMEOUT_MS = 4000;
export const MIN_CLEF = 0.5;
const MAX_SIMILAR = 8;
const MAX_CANDIDATES = 16;
const CACHE_MAX = 500;
const CUSTOM_TTL_MS = 10 * 60 * 1000;

/**
 * Emoji people mean most in a reply; always candidates, after the names that look alike.
 */
export const COMMON = [
  'white_check_mark', 'heavy_check_mark', 'x', '+1', '-1', 'eyes', 'pray', 'tada', 'rocket',
  'heart', 'joy', 'face_palm', 'thinking_face', 'warning', 'fire', 'wave',
];

/** A `:name:`, with an optional `::skin-tone-N`, not inside a word, a time or a URL. */
const CODE = /(?<![\p{L}\p{N}]):([a-z0-9_+-]{1,60}(?:::skin-tone-[2-6])?):(?![\p{L}\p{N}])/gu;
/** Fenced and inline code. */
const CODE_SPAN = /(```[\s\S]*?```|`[^`\n]+`)/;

const lookup = emojiLookup(SLACK_EMOJI, EMOJI_ALIASES, SKIN_TONES);

/** The character of a Slack name, with its skin tone. */
export function emojiChar(name) {
  const [base, tone] = String(name).split('::skin-tone-');
  const c = SLACK_EMOJI[base];
  if (!c || !tone || !SKIN_TONES.includes(base)) {
    return c;
  }
  const [first, ...rest] = [...c];
  if (rest[0] === '\uFE0F') {
    rest.shift();
  }
  return [first, String.fromCodePoint(0x1f3fb + Number(tone) - 2), ...rest].join('');
}

// Names to compare a typed name with, and words, per emoji (its Slack name).
let index = null;
function emojiIndex() {
  if (!index) {
    const other = new Map();
    for (const [a, to] of Object.entries(EMOJI_ALIASES)) {
      other.set(to, [...(other.get(to) || []), a]);
    }
    index = Object.entries(EMOJI_KEYWORDS).map(([name, keywords]) => ({
      name,
      names: [name, ...(other.get(name) || [])].map(squash),
      words: new Set([name, ...(other.get(name) || []), keywords].join(' ')
        .toLowerCase().split(/[^\p{L}\p{N}+]+/u).filter((w) => w.length > 1)),
    }));
  }
  return index;
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i += 1) {
    const b = s.slice(i, i + 2);
    out.set(b, (out.get(b) || 0) + 1);
  }
  return out;
}

/** Dice's coefficient of two strings' letter pairs: 1 for the same, 0 for nothing alike. */
export function similarity(a, b) {
  if (a === b) {
    return 1;
  }
  const x = bigrams(a);
  const y = bigrams(b);
  let both = 0;
  for (const [k, n] of x) {
    both += Math.min(n, y.get(k) || 0);
  }
  const total = Math.max(0, a.length - 1) + Math.max(0, b.length - 1);
  return total ? (2 * both) / total : 0;
}

/** A typed word and a keyword: the same, or one the other's stem (`complete`, `completed`). */
function wordMatch(w, k) {
  if (w === k) {
    return 1;
  }
  let i = 0;
  while (i < w.length && i < k.length && w[i] === k[i]) {
    i += 1;
  }
  return i >= 4 && i >= 0.75 * Math.min(w.length, k.length) ? 0.8 : 0;
}

/**
 * Emoji `code` (a name nobody has) may stand for: the most alike by name or keyword, then
 * COMMON, at most MAX_CANDIDATES Slack names.
 */
export function candidates(code) {
  const typed = squash(code);
  const words = [...new Set([typed, ...code.toLowerCase().split(/[_-]+/)])]
    .filter((w) => w.length > 1);
  const scored = emojiIndex().map((e) => {
    let score = Math.max(...e.names.map((n) => similarity(typed, n)));
    for (const w of words) {
      for (const k of e.words) {
        score = Math.max(score, 0.9 * wordMatch(w, k));
      }
    }
    return { name: e.name, score };
  }).filter((e) => e.score >= 0.35).sort((a, b) => b.score - a.score)
    .slice(0, MAX_SIMILAR)
    .map((e) => e.name);
  return [...new Set([...scored, ...COMMON])].slice(0, MAX_CANDIDATES);
}

// Clef's answers by typed name: a Slack name, or null for none.
const answers = new Map();
// Clef's rankings for the composer's suggestions, by what was typed.
const rankings = new Map();
// Custom emoji by workspace (`<source>:<tenant>`): `{ names, at }`.
const customs = new Map();

/** Forgets what Clef said and which custom emoji there are (for tests). */
export function forget() {
  answers.clear();
  rankings.clear();
  customs.clear();
}

function remember(code, name, cache = answers) {
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(code, name);
  return name;
}

/** The choices of a Clef question over `list` (Slack names): `e<i>` for `list[i]`. */
function emojiCriteria(list) {
  const criteria = {};
  list.forEach((name, i) => {
    criteria[`e${i}`] = `${emojiChar(name)} :${name}: (${EMOJI_KEYWORDS[name] || name})`;
  });
  return criteria;
}

/** `run()`, or null once `timeoutMs` passed. */
async function inTime(run, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clef: the emoji `code` stands for, as a Slack name from `list`, or null when it is none of
 * them, Clef is not sure enough, or does not answer in time.
 */
export async function askClef(env, code, list, timeoutMs = CLEF_TIMEOUT_MS) {
  if (answers.has(code)) {
    return answers.get(code);
  }
  const criteria = {
    none: 'None of these emoji: the name means something else',
    ...emojiCriteria(list),
  };
  try {
    const res = await inTime(() => env.AI.run(CLEF, {
      model: 'clef',
      state: `A person wrote the emoji shortcode :${code}: in a chat message, but no emoji has`
        + ' that name.',
      questions: {
        emoji: {
          type: 'choice',
          instructions: `Which emoji did the person mean with :${code}:?`,
          criteria,
        },
      },
    }), timeoutMs);
    if (!res) {
      // Too slow this time: not remembered, so a later reply asks again.
      return null;
    }
    const a = res.answers && res.answers.emoji;
    const p = a && ((a.probabilities && a.probabilities[a.choice]) ?? a.confidence ?? 0);
    const i = a && /^e(\d+)$/.exec(a.choice || '');
    return remember(code, i && p >= MIN_CLEF ? list[Number(i[1])] : null);
  } catch (e) {
    console.log(JSON.stringify({ route: 'shortcodes', error: String(e && e.message) }));
    return null;
  }
}

/**
 * The composer's emoji suggestions for `typed`, what follows a `:` being typed: the
 * `candidates` of it, as Slack names, most likely first by Clef's probabilities, all of them
 * (no threshold: the composer fills its list with them after the names that have `typed`
 * in them). Empty when Clef fails or takes longer than `timeoutMs`; rankings are remembered.
 */
export async function rankEmoji(env, typed, timeoutMs = SUGGEST_TIMEOUT_MS) {
  const q = String(typed || '').toLowerCase().replace(/^:+|:+$/g, '').slice(0, 60);
  if (!env.AI || q.length < 2 || !/[a-z]/.test(q)) {
    return [];
  }
  if (rankings.has(q)) {
    return rankings.get(q);
  }
  const list = candidates(q);
  try {
    const res = await inTime(() => env.AI.run(CLEF, {
      model: 'clef',
      state: `A person is typing an emoji shortcode in a chat message and has typed :${q} so`
        + ' far; they have not finished the name, and may not know its exact spelling.',
      questions: {
        emoji: {
          type: 'choice',
          instructions: `Which emoji is the person most likely looking for with :${q}?`,
          criteria: emojiCriteria(list),
        },
      },
    }), timeoutMs);
    const a = res && res.answers && res.answers.emoji;
    if (!a) {
      return [];
    }
    const p = a.probabilities || { [a.choice]: a.confidence ?? 1 };
    const ranked = list.map((name, i) => ({ name, p: Number(p[`e${i}`]) || 0 }))
      .sort((x, y) => y.p - x.p) // stable: candidates' order where Clef is unsure
      .map((e) => e.name);
    return remember(q, ranked, rankings);
  } catch (e) {
    console.log(JSON.stringify({ route: 'emoji', error: String(e && e.message) }));
    return [];
  }
}

/**
 * The workspace's own emoji opspile has seen: the names people reacted with that are not
 * standard ones (Slack stores the name, Discord `:name:`).
 */
async function customEmoji(env, source, tenant) {
  const k = `${source}:${tenant}`;
  const hit = customs.get(k);
  if (hit && Date.now() - hit.at < CUSTOM_TTL_MS) {
    return hit.names;
  }
  const names = new Set();
  try {
    const { results } = await env.DB.prepare(`SELECT DISTINCT emoji FROM reactions
      WHERE thread >= ? AND thread < ? LIMIT 5000`).bind(`${k}:`, `${k};`).all();
    for (const r of results || []) {
      names.add(String(r.emoji).replace(/^:|:$/g, '').split('::skin-tone-')[0]);
    }
  } catch {
    // None known.
  }
  customs.set(k, { names, at: Date.now() });
  return names;
}

/**
 * `text` (Markdown) with its emoji names as `source` (slack, teams, discord) shows them:
 * `{ text, changed }`, `changed` a list of `{ from, to }` (typed name, Slack name). `tenant`
 * is the workspace, whose custom emoji count as known. With `clef: false`, names nobody has
 * stay as they are; `timeoutMs` is how long Clef may take.
 */
export async function resolveShortcodes(env, text, {
  source, tenant, clef = true, timeoutMs = CLEF_TIMEOUT_MS,
} = {}) {
  const body = String(text || '');
  const parts = body.split(CODE_SPAN);
  const typed = new Set();
  parts.forEach((p, i) => {
    if (i % 2 === 0) {
      for (const m of p.matchAll(CODE)) {
        typed.add(m[1]);
      }
    }
  });
  if (!typed.size) {
    return { text: body, changed: [] };
  }
  // Typed name → Slack name, or null to leave it.
  const to = new Map();
  const unknown = [];
  for (const code of typed) {
    const name = lookup(code);
    if (name) {
      to.set(code, name);
    } else {
      unknown.push(code);
    }
  }
  if (unknown.length && env.DB && tenant) {
    const own = await customEmoji(env, source, tenant);
    unknown.splice(0, unknown.length, ...unknown.filter((c) => {
      if (own.has(c.split('::skin-tone-')[0])) {
        to.set(c, null);
        return false;
      }
      return true;
    }));
  }
  // Clef only for what looks like a name: letters, more than one character.
  const ask = clef && env.AI ? unknown.filter((c) => /[a-z]/.test(c) && c.length > 1) : [];
  await Promise.all(ask.slice(0, MAX_ASK).map(async (code) => {
    const name = await askClef(env, code, candidates(code), timeoutMs);
    if (name) {
      to.set(code, name);
    }
  }));
  const changed = [];
  const out = parts.map((p, i) => (i % 2 ? p : p.replace(CODE, (m, code) => {
    const name = to.get(code);
    if (!name) {
      return m;
    }
    const c = emojiChar(name);
    const now = source === 'slack' || !c ? `:${name}:` : c;
    if (now !== m) {
      changed.push({ from: code, to: name });
    }
    return now;
  }))).join('');
  return { text: out, changed };
}
