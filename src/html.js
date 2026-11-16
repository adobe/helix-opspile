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
 * Teams message HTML to markdown, through a syntax tree: the HTML is parsed (hast), turned
 * into a markdown tree (mdast) and written out by mdast-util-to-markdown, which knows where
 * markdown takes its markers and what it has to escape. What Teams adds to HTML is handled
 * here: mentions (`<at>`), emoji, code blocks (`<codeblock>`), the blank paragraphs it writes
 * for empty lines, and the size it gives an image.
 *
 * The markdown shows what Teams shows: markdown someone typed into Teams as text (`**`, a
 * backtick, `1.` at the start of a line) is escaped, since Teams shows it as typed.
 *
 * Links and images are always `[label](url)`, never `<url>`: what reads messages after this
 * (file links, the attachments list, the inbox) looks for that form. A web address in text is
 * a link too, as the inbox would show it anyway: as text, its `&` or `_` would be escaped,
 * and the escape would end up in the address.
 */

/* eslint-disable no-param-reassign -- the trees are made here and changed in place */

import { fromHtml } from 'hast-util-from-html';
import { toMdast } from 'hast-util-to-mdast';
import { toText } from 'hast-util-to-text';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfmStrikethroughToMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableToMarkdown } from 'mdast-util-gfm-table';
import { gfmTaskListItemToMarkdown } from 'mdast-util-gfm-task-list-item';
import { mdUrl, sizeTitle } from './markdown.js';

const NBSP = /\u00a0/g;

/** An element's classes, as hast keeps them. */
const classes = (node) => [].concat((node.properties && node.properties.className) || [])
  .map(String);

/** Whether an element has a table cell in it. */
const hasCell = (node) => (node.children || []).some((c) => c.type === 'element'
  && (c.tagName === 'td' || c.tagName === 'th' || hasCell(c)));

/**
 * Teams' markup to what hast-util-to-mdast knows, before it runs (it collapses the white space
 * of what it does not know as code): a code block is a `pre`, its language on its `code`;
 * mentions and emoji are text; a no-break space is a space, and a paragraph of nothing else
 * (Teams' empty line) goes; a table's first row is its header, and a table without cells goes.
 */
function prepare(node) {
  if (node.type === 'text') {
    node.value = node.value.replace(NBSP, ' ');
    return;
  }
  if (!node.children) {
    return;
  }
  const el = (c, ...tags) => c.type === 'element' && tags.includes(c.tagName);
  if (el(node, 'codeblock')) {
    const lang = String(classes(node)[0] || '').toLowerCase();
    const code = node.children.find((c) => el(c, 'code'));
    if (code && lang && lang !== 'plaintext' && !classes(code).some((c) => c.startsWith('language-'))) {
      code.properties.className = [...classes(code), `language-${lang}`];
    }
    Object.assign(node, { tagName: 'pre', properties: {} });
  }
  // A table without cells is none.
  node.children = node.children.filter((c) => !el(c, 'table') || hasCell(c));
  if (el(node, 'table') && !node.children.some((c) => el(c, 'thead'))) {
    // The first row is the header, as Teams shows it.
    const body = node.children.find((c) => el(c, 'tbody')) || node;
    const first = body.children.find((c) => el(c, 'tr'));
    if (first && !first.children.some((c) => el(c, 'th'))) {
      first.children.filter((c) => el(c, 'td')).forEach((c) => Object.assign(c, { tagName: 'th' }));
    }
  }
  // Mentions and emoji are text: as elements, the white space around them would go.
  node.children = node.children.map((c) => {
    if (el(c, 'at')) {
      return { type: 'text', value: `@${toText(c)}` };
    }
    if (el(c, 'emoji')) {
      return { type: 'text', value: String(c.properties.alt || '') };
    }
    return c;
  });
  node.children.forEach(prepare);
  node.children = node.children.filter((c) => !(c.type === 'element' && c.tagName === 'p'
    && !c.children.some((x) => x.type !== 'text' || x.value.trim())));
}

/** A pixel size from an attribute, or from the element's style. */
function px(node, name) {
  const p = node.properties || {};
  return p[name] || (new RegExp(`${name}:\\s*(\\d+)px`, 'i').exec(String(p.style || '')) || [])[1];
}

/** hast to mdast, for Teams' elements and the ones written differently here. */
const fromHast = {
  // Markdown has no underline.
  u: (state, node) => state.all(node),
  img: (state, node) => ({
    type: 'image',
    url: String(node.properties.src || ''),
    alt: String(node.properties.alt || '') || 'image',
    title: sizeTitle(px(node, 'width'), px(node, 'height')),
  }),
  a: (state, node) => {
    const url = String(node.properties.href || '');
    const children = state.all(node);
    if (!url) {
      return children;
    }
    return {
      type: 'link',
      url,
      title: null,
      children: children.length ? children : [{ type: 'text', value: url }],
    };
  },
};

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

/**
 * Tidies the markdown tree: spans next to each other are one (`<b>Hi </b><b>there</b>`); white
 * space at either end of bold, italics or strike-through goes outside its markers, since
 * markdown does not close `**same **` (a span of nothing but space is that space); web
 * addresses in text are links.
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
  // Spans next to each other are one (`<b>Hi </b><b>there</b>`).
  node.children = node.children.reduce((all, c) => {
    const prev = all[all.length - 1];
    if (prev && SPANS.has(c.type) && prev.type === c.type) {
      prev.children.push(...c.children);
    } else {
      all.push(c);
    }
    return all;
  }, []);
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
  // A paragraph, heading or cell neither starts nor ends in white space.
  if (['paragraph', 'heading', 'tableCell'].includes(node.type)) {
    const { children } = node;
    if (children.length && children[0].type === 'text') {
      children[0].value = children[0].value.trimStart();
    }
    if (children.length && children[children.length - 1].type === 'text') {
      children[children.length - 1].value = children[children.length - 1].value.trimEnd();
    }
    node.children = children.filter((x) => x.type !== 'text' || x.value);
  }
  node.children = node.children.filter((c) => c.type !== 'paragraph' || c.children.length);
}

/**
 * The tables of mdast-util-gfm-table, with `---` under each header cell (it writes `-`
 * when the pipes are not aligned).
 */
const gfmTable = gfmTableToMarkdown({ tablePipeAlign: false });
const writeTable = gfmTable.handlers.table;
gfmTable.handlers.table = (...args) => {
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
  extensions: [gfmTable, gfmStrikethroughToMarkdown(), gfmTaskListItemToMarkdown()],
};

/**
 * Teams message HTML to markdown.
 *
 * @param {string} html
 */
export function htmlToMarkdown(html) {
  if (!html) {
    return '';
  }
  const tree = fromHtml(String(html), { fragment: true });
  prepare(tree);
  const mdast = toMdast(tree, { handlers: fromHast });
  tidy(mdast);
  // No line ends in white space, but in code.
  let fence = null;
  return toMarkdown(mdast, OPTIONS).split('\n').map((line) => {
    const open = /^(?:>[ ]?)*[ ]*(`{3,}|~{3,})/.exec(line);
    if (open && (!fence || open[1].startsWith(fence))) {
      fence = fence ? null : open[1];
      return line;
    }
    return fence ? line : line.trimEnd();
  }).join('\n')
    .trim();
}
