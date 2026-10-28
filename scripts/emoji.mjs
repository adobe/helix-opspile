#!/usr/bin/env node
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
 * Writes src/emoji.js, Slack's standard emoji names and the characters they stand for, the
 * names GitHub, Discord and Teams give the same emoji, and keywords for each.
 *
 *   node scripts/emoji.mjs                       # from emoji-datasource on npm
 *   node scripts/emoji.mjs --check slack.json    # and compare with Slack's own table
 *
 * Slack's names are those of iamcal/emoji-data, published on npm as emoji-datasource
 * (MIT). Its 16.0.0 release matches, name for name and code point for code point, the
 * table the Slack web client ships with (which serves 16.0 emoji images). To compare
 * with a newer client, save that table (a `{ name: { unicode, skinVariations } }` JSON
 * object in the client bundle) and pass it to --check.
 *
 * Aliases, other names for an emoji Slack has (`facepalm` for `face_palm`): GitHub's, from
 * emojibase-data (MIT), Discord's, from terminal-discord/discord-emoji (MIT, the table of
 * Discord's client), and the names of Teams reactions. Keywords (CLDR's name and tags, from
 * emojibase-data) help pick candidates for a name nobody has (src/shortcodes.js).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emojiLookup } from '../src/emojinames.js';

const VERSION = '16.0.0';
const SOURCE = `https://cdn.jsdelivr.net/npm/emoji-datasource@${VERSION}/emoji.json`;
const EMOJIBASE = 'https://cdn.jsdelivr.net/npm/emojibase-data@16.0.3/en';
const DISCORD_COMMIT = 'd8c126d67a475c65dcee27f8f3fcfc4c288e19ee';
const DISCORD = `https://raw.githubusercontent.com/terminal-discord/discord-emoji/${DISCORD_COMMIT}/discord_emojis.json`;
// Teams reaction types, as they are stored, by the Slack name of their emoji.
const TEAMS = {
  like: '+1', heart: 'heart', laugh: 'laughing', surprised: 'open_mouth', sad: 'cry', angry: 'angry',
};
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'emoji.js');
const TONES = ['1f3fb', '1f3fc', '1f3fd', '1f3fe', '1f3ff'];

const chars = (hex) => String.fromCodePoint(...hex.split('-').map((h) => parseInt(h, 16)));

/** What the inbox does with `name::skin-tone-N`: the modifier after the first code point. */
function withTone(hex, tone) {
  const [first, ...rest] = hex.split('-');
  if (rest[0] === 'fe0f') {
    rest.shift();
  }
  return [first, tone, ...rest].join('-');
}

async function load(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url}: ${res.status}`);
  }
  return res.json();
}

const [data, emojibase, github, discord] = await Promise.all([
  load(SOURCE), load(`${EMOJIBASE}/data.json`), load(`${EMOJIBASE}/shortcodes/github.json`),
  load(DISCORD),
]);
/** Code points without variation selectors, to match emoji across the tables. */
const bare = (hex) => hex.toLowerCase().split('-').filter((h) => h !== 'fe0f').join('-');
const charsBare = (c) => bare([...c].map((x) => x.codePointAt(0).toString(16)).join('-'));

const names = {};
const skin = [];
// The Slack name of each emoji (its first), by code points.
const slackName = new Map();
for (const e of data.sort((a, b) => a.sort_order - b.sort_order)) {
  const hex = e.unified.toLowerCase();
  const variations = Object.keys(e.skin_variations || {});
  // Two people with a tone each (handshake, couples) do not follow the rule; they show
  // without a tone.
  const toned = variations.length && variations.every((v) => !v.includes('-'));
  for (const v of toned ? variations : []) {
    const expected = e.skin_variations[v].unified.toLowerCase();
    if (withTone(hex, v.toLowerCase()) !== expected) {
      throw new Error(`${e.short_name}: ${v} is ${expected}, not ${withTone(hex, v)}`);
    }
  }
  if (!slackName.has(bare(hex))) {
    slackName.set(bare(hex), e.short_name);
  }
  for (const name of e.short_names) {
    names[name] = chars(hex);
    if (toned) {
      skin.push(name);
    }
  }
}

const check = process.argv.indexOf('--check');
if (check > 0) {
  const slack = JSON.parse(await readFile(process.argv[check + 1], 'utf8'));
  const problems = [];
  for (const [name, { unicode, skinVariations }] of Object.entries(slack)) {
    if (names[name] !== chars(unicode)) {
      problems.push(`${name}: Slack ${unicode}, here ${names[name] ? 'other' : 'missing'}`);
    }
    for (const [n, v] of Object.entries(skinVariations || {})) {
      if (!n.includes('-') && skin.includes(name) && withTone(unicode, TONES[n - 2]) !== v.unicode) {
        problems.push(`${name}::skin-tone-${n}: Slack ${v.unicode}`);
      }
    }
  }
  problems.push(...Object.keys(names).filter((n) => !slack[n]).map((n) => `${n}: not in Slack`));
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`matches Slack's table: ${Object.keys(slack).length} names`);
}

// Other names, for the Slack name of the same emoji. A name Slack gives one emoji is never an
// alias for another; GitHub's go before Discord's. Left out: names the inbox finds without
// them, by leaving out separators (`man_facepalming` for `man-facepalming`).
const aliases = {};
const loose = emojiLookup(names);
function alias(name, hex) {
  const to = slackName.get(bare(hex));
  const a = String(name).toLowerCase();
  if (to && !Object.hasOwn(names, a) && !Object.hasOwn(aliases, a) && /^[a-z0-9_+-]+$/.test(a)
    && names[loose(a)] !== names[to]) {
    aliases[a] = to;
  }
}
for (const [hex, list] of Object.entries(github)) {
  [list].flat().forEach((n) => alias(n, hex));
}
for (const e of Object.values(discord).flat()) {
  e.names.forEach((n) => alias(n, charsBare(e.surrogates)));
}
for (const [type, to] of Object.entries(TEAMS)) {
  if (!Object.hasOwn(names, type)) {
    aliases[type] = to;
  }
}

// CLDR's name and tags of each emoji, by its Slack name.
const keywords = {};
for (const e of emojibase) {
  const to = slackName.get(bare(e.hexcode));
  if (to && !keywords[to]) {
    const tags = (e.tags || []).filter((t) => /^[\p{L}\p{N}' -]+$/u.test(t) && !e.label.includes(t));
    keywords[to] = [e.label, ...tags].join(', ').replace(/'/g, '’');
  }
}

const key = (name) => (/^([a-z_][a-z0-9_]*|[1-9][0-9]*)$/.test(name) ? name : `'${name}'`);
const lines = Object.entries(names).map(([name, c]) => `  ${key(name)}: '${c}',`);
await writeFile(OUT, `/*
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

// Generated by scripts/emoji.mjs from emoji-datasource@${VERSION} (MIT); do not edit.

/** Slack's standard emoji names, and the characters they stand for. */
export const SLACK_EMOJI = {
${lines.join('\n')}
};

/** Names that take \`::skin-tone-2\` to \`::skin-tone-6\`. */
export const SKIN_TONES = [
${skin.map((n) => `  '${n}',`).join('\n')}
];

/** GitHub's, Discord's and Teams' other names for an emoji, and its Slack name. */
export const EMOJI_ALIASES = {
${Object.entries(aliases).map(([a, to]) => `  ${key(a)}: '${to}',`).join('\n')}
};

/** What each emoji is (CLDR's name, then its tags), by Slack name. */
export const EMOJI_KEYWORDS = {
${Object.entries(keywords).map(([n, k]) => `  ${key(n)}: '${k}',`).join('\n')}
};
`);
console.log(`wrote ${OUT}: ${lines.length} names, ${skin.length} with skin tones, `
  + `${Object.keys(aliases).length} aliases, ${Object.keys(keywords).length} with keywords`);
