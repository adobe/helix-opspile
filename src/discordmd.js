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
 * Discord message content to markdown, through a syntax tree (mdast, written by
 * src/mdast.js). Discord writes markdown already, in its own flavor: the content is read as
 * markdown without what Discord does not have (tables, setext headings, rules, indented code,
 * HTML, images, link definitions, character references; their text stays text), and with what
 * it does differently: `__underline__` is no bold, `>>>` quotes the rest of the message, `-#`
 * small text is text, and a quote ends where its `>` lines do. Its tokens are names: user, role
 * and channel mentions, custom emoji, timestamps and commands. Code keeps what was typed.
 */

/* eslint-disable no-param-reassign -- the tree is made here and changed in place */

import { unlazy } from './markdown.js';
import { readMarkdown, writeMarkdown } from './mdast.js';

const pad2 = (n) => String(n).padStart(2, '0');

/** A Discord `<t:…>` timestamp as text: date and time in UTC. */
function discordTime(seconds, style) {
  const d = new Date(Number(seconds) * 1000);
  if (Number.isNaN(d.getTime())) {
    return seconds;
  }
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return /^[dD]$/.test(style || '') ? date : `${date} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** What markdown has and Discord does not: read as text. */
const NOT_DISCORD = [
  'setextUnderline', 'thematicBreak', 'codeIndented', 'htmlFlow', 'htmlText', 'definition',
  'labelStartImage', 'characterReference',
];

const HOLD = '\uE010';
const HELD = /\uE010(\d+)\uE010/g;

/** `>>> ` quotes the line it starts and every line after it; in a code block it is code. */
function quoteRest(src) {
  const lines = src.split('\n');
  let fence = null;
  const at = lines.findIndex((l) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) {
        fence = null;
      }
      return false;
    }
    if (f) {
      [, fence] = f;
      return false;
    }
    return /^>>> /.test(l);
  });
  return at < 0 ? src : [
    ...lines.slice(0, at),
    ...lines.slice(at).map((l, i) => `> ${i ? l : l.slice(4)}`),
  ].join('\n');
}

/**
 * Discord's tokens in text as names (`hold` makes each what goes in its place); code keeps
 * what was typed.
 */
function replaceTokens(text, names, hold = (s) => s) {
  const user = names.user || (() => undefined);
  const role = names.role || (() => undefined);
  const channel = names.channel || (() => undefined);
  return String(text || '').split(/(```[\s\S]*?```|`[^`\n]+`)/).map((part, i) => {
    if (i % 2 === 1) {
      return part;
    }
    return part
      .replace(/<@!?(\d+)>/g, (_, id) => hold(`@${user(id) || 'unknown'}`))
      .replace(/<@&(\d+)>/g, (_, id) => hold(`@${role(id) || 'role'}`))
      .replace(/<#(\d+)>/g, (_, id) => hold(`#${channel(id) || 'channel'}`))
      .replace(/<a?:(\w+):\d+>/g, (_, name) => hold(`:${name}:`))
      .replace(/<t:(-?\d+)(?::([tTdDfFR]))?>/g, (_, s, style) => hold(discordTime(s, style)))
      .replace(/<\/([\w -]+):\d+>/g, (_, name) => hold(`/${name}`))
      .replace(/^-# /gm, '');
  }).join('');
}

/**
 * Discord's tokens in markdown opspile wrote (a message's embeds), as names.
 *
 * @param {string} md
 * @param {object} names as for discordToMarkdown
 */
export const discordTokens = (md, names = {}) => replaceTokens(md, names).trim();

/**
 * Discord message content to markdown.
 *
 * @param {string} text
 * @param {{ user?: (id: string) => string|undefined, role?: (id: string) => string|undefined,
 *   channel?: (id: string) => string|undefined }} names
 */
export function discordToMarkdown(text, names = {}) {
  if (!text) {
    return '';
  }
  // Tokens are held as placeholders, so a name is text, whatever it has in it.
  const held = [];
  const src = replaceTokens(text, names, (value) => `${HOLD}${held.push(value) - 1}${HOLD}`);
  const source = unlazy(quoteRest(src));
  const tree = readMarkdown(source, { tables: false, tasks: false, disable: NOT_DISCORD });
  const walk = (node) => {
    if (node.type === 'text') {
      node.value = node.value.replace(HELD, (_, n) => held[Number(n)]);
      return [node];
    }
    if (!node.children) {
      return [node];
    }
    node.children = node.children.flatMap(walk);
    // `__underline__`: markdown has no underline.
    const start = node.position && node.position.start.offset;
    if (node.type === 'strong' && source.startsWith('__', start)) {
      return node.children;
    }
    return [node];
  };
  walk(tree);
  return writeMarkdown(tree);
}
