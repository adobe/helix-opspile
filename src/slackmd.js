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
 * Slack messages to markdown, through a syntax tree (mdast, written by src/mdast.js).
 *
 * A message's blocks are read first: `rich_text` (what Slack's composer sends) is a tree
 * already, with the styles, lists, quotes and code Slack shows; the other Block Kit blocks
 * (headers, sections, context, dividers, images) are what apps send, and `markdown` blocks
 * are markdown. The mrkdwn `text` is read where there are no blocks to read (old messages,
 * some bots, the messages a message quotes): code first, then Slack's `<…>` tokens, then
 * `*bold*`, `_italics_` and `~strike-through~` where Slack takes them (after white space or
 * punctuation, around something that is not space). What Slack shows as text stays text, and
 * is escaped where markdown would read it as markup.
 */

import { readMarkdown, writeMarkdown } from './mdast.js';

const SLACK_ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const decode = (s) => String(s).replace(/&(lt|gt|amp);/g, (m) => SLACK_ENTITIES[m]);

const text = (value) => ({ type: 'text', value });

/**
 * What resolves the names a message refers to: `user(id)` a person's, and the labels Slack
 * wrote into the message's mrkdwn for channels and user groups (blocks name only their ids).
 *
 * @typedef {{ user?: (id: string) => string|undefined, channels?: Map<string, string>,
 *   groups?: Map<string, string> }} Names
 */

/** The labels of channels and user groups in mrkdwn, by id, for its blocks. */
export function slackLabels(mrkdwn) {
  const channels = new Map();
  const groups = new Map();
  for (const [, id, label] of String(mrkdwn || '').matchAll(/<#([CG][A-Z0-9]+)\|([^>]+)>/g)) {
    channels.set(id, label);
  }
  for (const [, id, label] of String(mrkdwn || '').matchAll(/<!subteam\^([A-Z0-9]+)\|([^>]+)>/g)) {
    groups.set(id, label);
  }
  return { channels, groups };
}

// mrkdwn

/**
 * One of Slack's `<…>` tokens as nodes: a link, a mention, a channel, a group, @here, a date.
 * Anything else is its text.
 */
function token(inner, names) {
  let m = /^@([UW][A-Z0-9]+)(?:\|([^>]+))?$/.exec(inner);
  if (m) {
    return [text(`@${m[2] || (names.user && names.user(m[1])) || m[1]}`)];
  }
  m = /^#([CG][A-Z0-9]+)(?:\|([^>]*))?$/.exec(inner);
  if (m) {
    return [text(`#${m[2] || m[1]}`)];
  }
  m = /^!subteam\^[A-Z0-9]+(?:\|([^>]+))?$/.exec(inner);
  if (m) {
    return [text(m[1] || '@group')];
  }
  m = /^!(here|channel|everyone)(?:\|[^>]*)?$/.exec(inner);
  if (m) {
    return [text(`@${m[1]}`)];
  }
  m = /^!date\^\d+\^[^|>]*\|(.+)$/.exec(inner);
  if (m) {
    return [text(decode(m[1]))];
  }
  m = /^((?:https?|mailto):[^|]+)(?:\|(.*))?$/.exec(inner);
  if (m) {
    const url = decode(m[1]);
    return [{
      type: 'link', url, title: null, children: [text(m[2] ? decode(m[2]) : url)],
    }];
  }
  return [text(decode(`<${inner}>`))];
}

/** Slack's markup inside code: Slack links URLs and mentions in `text` even within backticks,
 * but shows what the person typed, so code keeps the label (or the bare URL, or @name). */
function unlinkCode(code, names) {
  return decode(code
    .replace(/<((?:https?|mailto):[^|>\s]+)(?:\|([^>]*))?>/g, (_, url, label) => label || url)
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => `@${label || (names.user && names.user(id)) || id}`));
}

const HOLD = '\uE010';
const HELD = /\uE010(\d+)\uE010/g;

/**
 * Bold, italics or strike-through as Slack reads them: the marker after the start, white
 * space, punctuation or another marker, then something that is not space, the same marker
 * before the end, white space, punctuation or another marker.
 */
const SPAN = /(^|[^\p{L}\p{N}\\])([*_~])(?=[^\s*_~]|[*_~]\S)((?:(?!\2).)*?\S)\2(?![\p{L}\p{N}])/u;
const SPAN_TYPE = { '*': 'strong', _: 'emphasis', '~': 'delete' };

/** A line of mrkdwn, its tokens held (`held`), as phrasing nodes. */
function spans(line, held) {
  const m = SPAN.exec(line);
  if (!m) {
    return line.split(HELD).map((part, i) => (i % 2 ? held[Number(part)] : part))
      .flatMap((part) => (typeof part === 'string' ? (part && [text(part)]) || [] : part));
  }
  const start = m.index + m[1].length;
  return [
    ...spans(line.slice(0, start), held),
    { type: SPAN_TYPE[m[2]], children: spans(m[3], held) },
    ...spans(line.slice(start + m[2].length * 2 + m[3].length), held),
  ];
}

/** A line of mrkdwn as phrasing nodes: code and tokens first, then spans, then text. */
function mrkdwnLine(line, names) {
  const held = [];
  const hold = (nodes) => `${HOLD}${held.push(nodes) - 1}${HOLD}`;
  const marked = line
    .replace(/`([^`\n]+)`/g, (_, code) => hold([{ type: 'inlineCode', value: unlinkCode(code, names) }]))
    .replace(/<([^<>\n]+)>/g, (_, inner) => hold(token(inner, names)));
  // Slack escapes `<`, `>` and `&` in text, so the tokens are held before they are decoded.
  return spans(decode(marked), held);
}

/** Lines of mrkdwn as paragraphs: a blank line between them, a break within. */
function paragraphs(lines, names) {
  const out = [];
  let current = null;
  for (const line of lines) {
    if (!line.trim()) {
      current = null;
    } else {
      if (!current) {
        current = { type: 'paragraph', children: [] };
        out.push(current);
      } else {
        current.children.push({ type: 'break' });
      }
      current.children.push(...mrkdwnLine(line, names));
    }
  }
  return out;
}

/**
 * mrkdwn as markdown block nodes: code blocks, quotes (lines starting with `>`) and
 * paragraphs.
 *
 * @param {string} mrkdwn
 * @param {Names} [names]
 */
export function mrkdwnNodes(mrkdwn, names = {}) {
  const out = [];
  String(mrkdwn || '').split(/(```[\s\S]*?```)/).forEach((part, i) => {
    if (i % 2) {
      const value = unlinkCode(part.slice(3, -3).replace(/^\n|\n$/g, ''), names);
      out.push({
        type: 'code', lang: null, meta: null, value,
      });
      return;
    }
    const lines = part.split('\n');
    for (let j = 0; j < lines.length;) {
      const quoted = (l) => /^(&gt;|>)/.test(l);
      let k = j;
      while (k < lines.length && quoted(lines[k]) === quoted(lines[j])) {
        k += 1;
      }
      const group = lines.slice(j, k);
      if (quoted(lines[j])) {
        out.push({
          type: 'blockquote',
          children: paragraphs(group.map((l) => l.replace(/^(&gt;|>) ?/, '')), names),
        });
      } else {
        out.push(...paragraphs(group, names));
      }
      j = k;
    }
  });
  return out;
}

/**
 * Slack mrkdwn to markdown.
 *
 * @param {string} mrkdwn
 * @param {Names|((id: string) => string|undefined)} [names] or how to name a user by id
 */
export function slackToMarkdown(mrkdwn, names = {}) {
  const n = typeof names === 'function' ? { user: names } : names;
  return writeMarkdown({ type: 'root', children: mrkdwnNodes(mrkdwn, n) });
}

// rich_text

/** Text split at its line ends, with a break for each. */
const lines = (value) => value.split('\n').flatMap((l, i) => [
  ...(i ? [{ type: 'break' }] : []), ...(l ? [text(l)] : []),
]);

/** Nodes in a rich text element's style: code, then strike-through, italics, bold. */
function styled(nodes, style = {}) {
  let out = nodes;
  for (const [key, type] of [['strike', 'delete'], ['italic', 'emphasis'], ['bold', 'strong']]) {
    if (style[key]) {
      // A span does not cross a line end.
      out = out.map((n) => (n.type === 'break' ? n : { type, children: [n] }));
    }
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** A rich text date: its fallback, or the date in UTC. */
function dateText(e) {
  if (e.fallback) {
    return e.fallback;
  }
  const d = new Date(Number(e.timestamp) * 1000);
  return Number.isNaN(d.getTime()) ? '' : `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** The text an element of rich text shows, for code blocks. */
function plain(e, names) {
  switch (e.type) {
    case 'text': return e.text || '';
    case 'link': return e.text || e.url || '';
    case 'user': return `@${(names.user && names.user(e.user_id)) || e.user_id}`;
    case 'usergroup': return (names.groups && names.groups.get(e.usergroup_id)) || '@group';
    case 'channel': return `#${(names.channels && names.channels.get(e.channel_id)) || e.channel_id}`;
    case 'broadcast': return `@${e.range}`;
    case 'emoji': return `:${e.name}:${e.skin_tone ? `:skin-tone-${e.skin_tone}:` : ''}`;
    case 'date': return dateText(e);
    case 'color': return e.value || '';
    default: return e.text || '';
  }
}

/** An element of rich text as phrasing nodes. */
function element(e, names) {
  const style = e.style || {};
  if (e.type === 'text' && style.code) {
    return styled(e.text.split('\n').flatMap((l, i) => [
      ...(i ? [{ type: 'break' }] : []), ...(l ? [{ type: 'inlineCode', value: l }] : []),
    ]), style);
  }
  if (e.type === 'link') {
    const label = e.text || e.url || '';
    return styled([{
      type: 'link',
      url: e.url || '',
      title: null,
      children: [style.code ? { type: 'inlineCode', value: label } : text(label)],
    }], style);
  }
  const value = plain(e, names);
  return styled(style.code ? [{ type: 'inlineCode', value }] : lines(value), style);
}

/**
 * Phrasing as paragraphs: a blank line (two breaks) starts a new one; a paragraph neither
 * starts nor ends with a break.
 */
function toParagraphs(nodes) {
  const out = [[]];
  for (const n of nodes) {
    const para = out[out.length - 1];
    if (n.type === 'break' && para.length && para[para.length - 1].type === 'break') {
      para.pop();
      out.push([]);
    } else if (n.type !== 'break' || para.length) {
      para.push(n);
    }
  }
  return out.map((children) => {
    while (children.length && children[children.length - 1].type === 'break') {
      children.pop();
    }
    return children;
  }).filter((c) => c.length).map((children) => ({ type: 'paragraph', children }));
}

const phrasing = (elements, names) => (elements || []).flatMap((e) => element(e, names));

/** A `rich_text` block as block nodes, its lists nested by their indent. */
function richText(rich, names) {
  const out = [];
  // The lists open at each indent, for the next list one deeper.
  let open = [];
  for (const e of rich.elements || []) {
    if (e.type === 'rich_text_list') {
      const indent = Math.max(0, Number(e.indent) || 0);
      const list = {
        type: 'list',
        ordered: e.style === 'ordered',
        start: e.style === 'ordered' ? (Number(e.offset) || 0) + 1 : null,
        spread: false,
        children: (e.elements || []).map((item) => ({
          type: 'listItem',
          spread: false,
          checked: null,
          children: toParagraphs(phrasing(item.elements, names)),
        })),
      };
      const parent = open.slice(0, indent).reverse().find(Boolean);
      const lastItem = parent && parent.children[parent.children.length - 1];
      const same = open[indent];
      if (same && same.ordered === list.ordered) {
        // Slack splits a list where a deeper one is in it: back at its indent, it goes on.
        same.children.push(...list.children);
      } else if (indent && lastItem) {
        lastItem.children.push(list);
      } else {
        out.push(list);
      }
      open = [...open.slice(0, indent), same && same.ordered === list.ordered ? same : list];
    } else {
      open = [];
      if (e.type === 'rich_text_preformatted') {
        out.push({
          type: 'code',
          lang: null,
          meta: null,
          value: (e.elements || []).map((x) => plain(x, names)).join('').replace(/\n+$/, ''),
        });
      } else if (e.type === 'rich_text_quote') {
        out.push({ type: 'blockquote', children: toParagraphs(phrasing(e.elements, names)) });
      } else {
        out.push(...toParagraphs(phrasing(e.elements, names)));
      }
    }
  }
  return out;
}

// Block Kit

/** A text object's nodes: mrkdwn read as mrkdwn, plain text as text. */
function textObject(t, names) {
  if (!t || typeof t.text !== 'string') {
    return [];
  }
  return t.type === 'mrkdwn' ? mrkdwnNodes(t.text, names) : toParagraphs(lines(t.text));
}

/** The phrasing of block nodes, their paragraphs joined by `sep` (for one line of them). */
function inline(nodes, sep) {
  return nodes.flatMap((n, i) => [...(i ? sep() : []), ...(n.type === 'paragraph' ? n.children : [text(n.value || '')])]);
}

/** One Block Kit block as block nodes. */
function block(b, names) {
  switch (b.type) {
    case 'rich_text':
      return richText(b, names);
    case 'markdown':
      return readMarkdown(String(b.text || '')).children;
    case 'header':
      return [{ type: 'paragraph', children: [{ type: 'strong', children: lines(b.text ? b.text.text || '' : '') }] }];
    case 'section': {
      const out = textObject(b.text, names);
      if (Array.isArray(b.fields) && b.fields.length) {
        // "*Label:*\nvalue" fields are one "*Label:* value" line each.
        out.push({
          type: 'paragraph',
          children: inline(b.fields.map((f) => textObject({
            ...f, text: String(f.text || '').replace(/^(\*[^*\n]+\*)\n/, '$1 '),
          }, names)).map((nodes) => ({ type: 'paragraph', children: inline(nodes, () => [{ type: 'break' }]) })), () => [{ type: 'break' }]),
        });
      }
      return out;
    }
    case 'context': {
      const parts = (b.elements || []).map((e) => textObject(e, names)).filter((n) => n.length);
      return parts.length ? [{
        type: 'paragraph',
        children: inline(parts.map((nodes) => ({ type: 'paragraph', children: inline(nodes, () => [text(' ')]) })), () => [text(' · ')]),
      }] : [];
    }
    case 'divider':
      return [{ type: 'thematicBreak' }];
    case 'table': {
      const cell = (c) => ({
        type: 'tableCell',
        children: c && c.type === 'rich_text'
          ? inline(richText(c, names), () => [{ type: 'break' }])
          : lines(String((c && c.text) || '')),
      });
      const rows = (Array.isArray(b.rows) ? b.rows : [])
        .filter((r) => Array.isArray(r) && r.length);
      return rows.length ? [{
        type: 'table',
        align: (b.column_settings || []).map((s) => (s && s.align) || null),
        children: rows.map((r) => ({ type: 'tableRow', children: r.map(cell) })),
      }] : [];
    }
    case 'image':
      return b.image_url ? [{
        type: 'paragraph',
        children: [{
          type: 'link', url: b.image_url, title: null, children: [text(b.alt_text || 'image')],
        }],
      }] : [];
    default:
      return [];
  }
}

/**
 * A Slack message's blocks as markdown, or null when they show nothing (then its mrkdwn
 * `text` is what to read).
 *
 * @param {object[]} blocks
 * @param {Names} [names]
 */
export function slackBlocksToMarkdown(blocks, names = {}) {
  if (!Array.isArray(blocks) || !blocks.length) {
    return null;
  }
  const md = writeMarkdown({ type: 'root', children: blocks.flatMap((b) => block(b, names)) });
  return md || null;
}

/**
 * The ids of the users a message's blocks mention: rich text's `user` elements, and `<@…>` in
 * the mrkdwn of text objects (sections, fields, context), anywhere in the blocks (tables too).
 */
export function blockUsers(blocks) {
  const ids = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const [, id] of v.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) {
        ids.add(id);
      }
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      if (v.type === 'user' && v.user_id) {
        ids.add(v.user_id);
      }
      Object.values(v).forEach(walk);
    }
  };
  walk(Array.isArray(blocks) ? blocks : []);
  return [...ids];
}
