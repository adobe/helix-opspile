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
 * into a markdown tree (mdast) and written by src/mdast.js. What Teams adds to HTML is handled
 * here: mentions (`<at>`), emoji, code blocks (`<codeblock>`), the blank paragraphs it writes
 * for empty lines, and the size it gives an image.
 *
 * The markdown shows what Teams shows: markdown someone typed into Teams as text (`**`, a
 * backtick, `1.` at the start of a line) is escaped, since Teams shows it as typed. *
 * Markdown has no colours: `htmlDropped` names what the markdown loses (text in more than one
 * colour, highlights), so an agent knows to read the message as it was sent.
 */

/* eslint-disable no-param-reassign -- the trees are made here and changed in place */

import { fromHtml } from 'hast-util-from-html';
import { toMdast } from 'hast-util-to-mdast';
import { toText } from 'hast-util-to-text';
import { sizeTitle } from './markdown.js';
import { writeMarkdown } from './mdast.js';

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

/** A colour that is the one around it: none of its own. */
const SAME = /^(?:inherit|initial|unset|revert|currentcolor|transparent|none)$/;

/** A CSS property's value in an element's style, lower case without spaces, or ''. */
function styled(node, names) {
  const style = String((node.properties && node.properties.style) || '');
  let value = '';
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i > 0 && names.includes(decl.slice(0, i).trim().toLowerCase())) {
      value = decl.slice(i + 1).replace(/!important/i, '').replace(/\s+/g, '').toLowerCase();
    }
  }
  return SAME.test(value) ? '' : value;
}

/**
 * What a Teams message's HTML shows that its markdown cannot: `color` when its text is in more
 * than one colour, `highlight` when some of it has a background and some not. A colour all of
 * the text has (pasted from a document) says nothing, so it is not counted.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function htmlDropped(html) {
  if (!html) {
    return [];
  }
  const colors = new Set();
  const backgrounds = new Set();
  const walk = (node, color, background) => {
    if (node.type === 'text') {
      if (node.value.replace(NBSP, ' ').trim()) {
        colors.add(color);
        backgrounds.add(background);
      }
      return;
    }
    let c = color;
    let b = background;
    if (node.type === 'element') {
      const font = node.tagName === 'font' ? String(node.properties.color || '').toLowerCase() : '';
      c = styled(node, ['color']) || (SAME.test(font) ? '' : font) || color;
      b = styled(node, ['background-color', 'background']) || (node.tagName === 'mark' ? 'mark' : '') || background;
    }
    (node.children || []).forEach((x) => walk(x, c, b));
  };
  walk(fromHtml(String(html), { fragment: true }), '', '');
  return [colors.size > 1 && 'color', backgrounds.size > 1 && 'highlight'].filter(Boolean);
}

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

/**
 * What a person's own rich text may say (the customer portal's text box): no image, since a
 * message's images are its files, and no link but to the web or a mail address; its words stay.
 */
const typed = {
  ...fromHast,
  img: () => undefined,
  a: (state, node) => (/^(https?:\/\/|mailto:)/i.test(String(node.properties.href || ''))
    ? fromHast.a(state, node) : state.all(node)),
};

/**
 * Teams message HTML to markdown. With `typed`, the HTML is a text box's, which a person (or
 * whatever writes in their name) sends: its images and its links to anything but the web or a
 * mail address are left out.
 *
 * @param {string} html
 * @param {{ typed?: boolean }} [options]
 */
export function htmlToMarkdown(html, options = {}) {
  if (!html) {
    return '';
  }
  const tree = fromHtml(String(html), { fragment: true });
  prepare(tree);
  const mdast = toMdast(tree, { handlers: options.typed ? typed : fromHast });
  return writeMarkdown(mdast);
}
