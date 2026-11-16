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
 * A markdown tree (mdast) to the markdown pile 2 keeps, the same for every platform: the
 * converters of Teams HTML (src/html.js), Slack's blocks and mrkdwn (src/slackmd.js) and
 * Discord's markdown (src/discordmd.js) build the tree, and this writes it with
 * mdast-util-to-markdown, which puts markers and escapes where markdown wants them.
 *
 * Before it writes, the tree is tidied: spans next to each other are one, white space at the
 * ends of bold, italics or strike-through goes outside the markers (markdown does not close
 * `**same **`), list items are loose only with paragraphs, and web addresses in text are
 * links. Links and images are always `[label](url)`, never `<url>`: what reads messages after
 * this (file links, the attachments list, the inbox) looks for that form. A line break is a
 * new line, as the inbox shows one.
 */

/* eslint-disable no-param-reassign -- the trees are the callers' own, changed in place */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { gfmStrikethroughFromMarkdown, gfmStrikethroughToMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown, gfmTableToMarkdown } from 'mdast-util-gfm-table';
import { gfmTaskListItemFromMarkdown, gfmTaskListItemToMarkdown } from 'mdast-util-gfm-task-list-item';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import { codeLines, mdUrl } from './markdown.js';

const SPANS = new Set(['strong', 'emphasis', 'delete']);

/**
 * A web address in text, as GFM links one by itself (micromark-extension-gfm-autolink-literal),
 * up to what ends it: white space, `<`, or punctuation at its end.
 */
const BARE_URL = /(?<![\p{L}\p{N}_\-./:@\\])(?:https?:\/\/|www\.)(?=[\p{L}\p{N}])[^\s<]+/gu;

/** A web address in text without what ends a sentence after it, nor an unmatched `)`. */
function bareUrl(match) {
  let url = match.replace(/[?!.,:;*_~'"]+$/, '');
  while (url.endsWith(')') && url.split('(').length < url.split(')').length) {
    url = url.slice(0, -1).replace(/[?!.,:;*_~'"]+$/, '');
  }
  return url;
}

/**
 * A text's web addresses as links: written as text, their characters would be escaped (`\&`,
 * `\_`), and the escape would end up in the address the inbox links.
 */
function linkUrls(text) {
  const out = [];
  let at = 0;
  for (const m of text.value.matchAll(BARE_URL)) {
    const url = bareUrl(m[0]);
    if (url.includes('.')) {
      out.push({ type: 'text', value: text.value.slice(at, m.index) }, {
        type: 'link',
        url: url.startsWith('www.') ? `http://${url}` : url,
        title: null,
        children: [{ type: 'text', value: url }],
      });
      at = m.index + url.length;
    }
  }
  return at ? [...out, { type: 'text', value: text.value.slice(at) }].filter((x) => x.type !== 'text' || x.value)
    : [text];
}

/** Spans next to each other are one (`<b>Hi </b><b>there</b>`), from the top down. */
function merge(node) {
  if (!node.children) {
    return;
  }
  node.children = node.children.reduce((all, c) => {
    const prev = all[all.length - 1];
    if (prev && SPANS.has(c.type) && prev.type === c.type) {
      prev.children.push(...c.children);
    } else {
      all.push(c);
    }
    return all;
  }, []);
  node.children.forEach(merge);
}

/**
 * Tidies a markdown tree (after merge): white space at either end of bold, italics or
 * strike-through goes outside its markers, since markdown does not close `**same **` (a span
 * of nothing but space is that space); web addresses in text are links; list items are loose
 * only with paragraphs in them; no paragraph or line starts or ends in white space.
 */
function tidy(node, inLink = false) {
  if (!node.children) {
    return;
  }
  const linked = inLink || node.type === 'link';
  if (!linked) {
    node.children = node.children.flatMap((c) => (c.type === 'text' ? linkUrls(c) : [c]));
  }
  node.children.forEach((c) => tidy(c, linked));
  // A list item is loose with paragraphs in it, not with a list (hast-util-to-mdast's is).
  if (node.type === 'listItem') {
    // `[ ]` or `[x]` starting an item is a task (as messageHtml writes one).
    const text = node.children[0] && node.children[0].type === 'paragraph'
      && node.children[0].children[0];
    const task = text && text.type === 'text' && /^\[([ xX])\]\s+/.exec(text.value);
    if (task) {
      node.checked = task[1] !== ' ';
      text.value = text.value.slice(task[0].length);
    }
    node.spread = node.children.filter((c) => c.type !== 'list').length > 1;
  } else if (node.type === 'list') {
    node.spread = node.children.some((c) => c.spread);
  }
  node.children = node.children.flatMap((c) => {
    if (!SPANS.has(c.type)) {
      return [c];
    }
    const first = c.children[0];
    const last = c.children[c.children.length - 1];
    const lead = first && first.type === 'text' ? /^\s*/.exec(first.value)[0] : '';
    if (lead) {
      first.value = first.value.slice(lead.length);
    }
    const trail = last && last.type === 'text' ? /\s*$/.exec(last.value)[0] : '';
    if (trail) {
      last.value = last.value.slice(0, -trail.length);
    }
    c.children = c.children.filter((x) => x.type !== 'text' || x.value);
    const pad = (value) => (value ? [{ type: 'text', value: ' ' }] : []);
    return [...pad(lead), ...(c.children.length ? [c] : []), ...pad(trail)];
  });
  // A paragraph, heading or cell neither starts nor ends in white space, nor does a line.
  if (['paragraph', 'heading', 'tableCell'].includes(node.type)) {
    const { children } = node;
    children.forEach((c, i) => {
      if (c.type !== 'text') {
        return;
      }
      if (i === 0 || children[i - 1].type === 'break') {
        c.value = c.value.trimStart();
      }
      if (i === children.length - 1 || children[i + 1].type === 'break') {
        c.value = c.value.trimEnd();
      }
    });
    node.children = children.filter((x) => x.type !== 'text' || x.value);
  }
  node.children = node.children.filter((c) => c.type !== 'paragraph' || c.children.length);
}

/**
 * The tables of mdast-util-gfm-table, with `---` under each header cell (it writes `-`
 * when the pipes are not aligned).
 */
const tableWriter = gfmTableToMarkdown({ tablePipeAlign: false });
const writeTable = tableWriter.handlers.table;
tableWriter.handlers.table = (...args) => {
  const [head, rule, ...rows] = writeTable(...args).split('\n');
  return [head, rule && rule.replace(/(:?)-+(:?)/g, '$1---$2'), ...rows].join('\n');
};

/** Writes a link or an image as `[label](url "title")`, its URL safe as a destination. */
function linkTo(prefix) {
  return (node, _, state, info) => {
    const tracker = state.createTracker(info);
    const exit = state.enter(prefix ? 'image' : 'link');
    const label = state.enter('label');
    let value = tracker.move(`${prefix}[`);
    value += tracker.move(prefix
      ? state.safe(node.alt, { before: value, after: ']', ...tracker.current() })
      : state.containerPhrasing(node, { before: value, after: '](', ...tracker.current() }));
    label();
    value += tracker.move(`](${mdUrl(node.url)}`);
    if (node.title) {
      value += tracker.move(` "${node.title.replace(/["\\]/g, '\\$&')}"`);
    }
    value += tracker.move(')');
    exit();
    return value;
  };
}

const OPTIONS = {
  bullet: '-',
  emphasis: '*',
  strong: '*',
  fences: true,
  rule: '-',
  listItemIndent: 'one',
  tablePipeAlign: false,
  handlers: {
    link: linkTo(''),
    image: linkTo('!'),
    // A line break is a new line, as the inbox shows one; in a table cell, a space.
    break: (node, _, state) => (state.stack.includes('tableCell') ? ' ' : '\n'),
  },
  extensions: [tableWriter, gfmStrikethroughToMarkdown(), gfmTaskListItemToMarkdown()],
};

/**
 * A markdown tree as markdown text, tidied first (the tree is changed).
 *
 * @param {object} tree an mdast root
 */
export function writeMarkdown(tree) {
  merge(tree);
  tidy(tree);
  // No line ends in white space, but in code (in a quote or a list item too).
  const lines = toMarkdown(tree, OPTIONS).split('\n');
  // A line is read without the quote markers, list markers and indents it is written under.
  const code = codeLines(lines, (l) => l.replace(/^(?:[ ]*(?:>|[-*+]|\d+[.)])(?=[ ]|$)[ ]?)*[ ]*/, ''));
  return lines.map((line, i) => (code[i] === 'code' ? line : line.trimEnd())).join('\n')
    .trim();
}

/**
 * Markdown (CommonMark and GFM, as the inbox renders it) as a markdown tree.
 *
 * @param {string} src
 * @param {{ tables?: boolean, tasks?: boolean, disable?: string[] }} [options] whether GFM
 *   tables and task lists are read, and the micromark constructs that are not (their text
 *   stays text)
 */
export function readMarkdown(src, { tables = true, tasks = true, disable = [] } = {}) {
  return fromMarkdown(String(src || ''), {
    extensions: [
      gfmAutolinkLiteral(), gfmStrikethrough(), ...(tables ? [gfmTable()] : []),
      ...(tasks ? [gfmTaskListItem()] : []),
      ...(disable.length ? [{ disable: { null: disable } }] : []),
    ],
    mdastExtensions: [
      gfmAutolinkLiteralFromMarkdown(), gfmStrikethroughFromMarkdown(),
      ...(tables ? [gfmTableFromMarkdown()] : []),
      ...(tasks ? [gfmTaskListItemFromMarkdown()] : []),
    ],
  });
}
