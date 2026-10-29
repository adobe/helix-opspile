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
 * How the inbox shows message bodies (markdown, from src/markdown.js) in the browser:
 * micromark, CommonMark with GitHub's strike-through, tables, task lists and bare links,
 * plus what chat needs on top of it:
 *
 * - a single line break is a break, as in Slack and Teams
 * - no raw HTML (shown as text), no indented code (chat indents prose), no footnotes
 * - links open in a new tab; Slack and Teams images go through the inbox's media proxy
 * - `@Full Name` mentions and `:emoji:` codes, outside code; `emojiLookup`
 *   (src/emojinames.js) finds an emoji by any platform's name for it
 *
 * The page does not load this file: scripts/ui-markdown.mjs bundles it, with micromark,
 * into src/ui-markdown.bundle.js, which src/page.js puts into the page as `Markdown`.
 */

import { micromark } from 'micromark';
import {
  gfmAutolinkLiteral, gfmAutolinkLiteralHtml,
} from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough, gfmStrikethroughHtml } from 'micromark-extension-gfm-strikethrough';
import { gfmTable, gfmTableHtml } from 'micromark-extension-gfm-table';
import { gfmTaskListItem, gfmTaskListItemHtml } from 'micromark-extension-gfm-task-list-item';

export { emojiLookup } from './emojinames.js';

/** Stands in for a line ending until it is known to be inside a paragraph. */
const BREAK = '\uE000';

/** Line endings as micromark writes them, except that they are marked (outside code). */
const breaks = {
  exit: {
    lineEnding() {
      if (this.getData('slurpAllLineEndings')) {
        return;
      }
      if (this.getData('slurpOneLineEnding')) {
        this.setData('slurpOneLineEnding');
        return;
      }
      if (this.getData('inCodeText')) {
        this.raw(' ');
        return;
      }
      this.raw(this.getData('fencesCount') === undefined ? BREAK : '\n');
    },
  },
};

// Slack puts its link markup (`<https://…|label>`) into code too, where it is not
// translated: code shows what the person typed, the label (or the bare URL).
const SLACK_LINK = /<((?:https?|mailto):[^|>\s]+)(?:\|([^>]*))?>/g;
export const unslackCode = (s) => s.replace(SLACK_LINK, (_, url, label) => label || url);
const slackCode = {
  exit: {
    codeTextData(token) {
      this.raw(this.encode(unslackCode(this.sliceSerialize(token))));
    },
    codeFlowValue(token) {
      this.raw(this.encode(unslackCode(this.sliceSerialize(token))));
      this.setData('flowCodeSeenData', true);
    },
  },
};

const OPTIONS = {
  extensions: [
    gfmAutolinkLiteral(),
    gfmStrikethrough({ singleTilde: false }),
    gfmTable(),
    gfmTaskListItem(),
    { disable: { null: ['codeIndented', 'htmlFlow', 'htmlText'] } },
  ],
  htmlExtensions: [
    gfmAutolinkLiteralHtml(),
    gfmStrikethroughHtml(),
    gfmTableHtml(),
    gfmTaskListItemHtml(),
    breaks,
    slackCode,
  ],
};

/** Escapes text the way micromark does, so names match what it writes. */
const encode = (s) => String(s).replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The pattern for `@Full Name` mentions of these people, longest name first, or null. Teams
 * mentions some directories' people as `@Last, First`, so that form counts too.
 *
 * @param {string[]} names
 */
export function mentionPattern(names) {
  const list = [...new Set(names.filter((n) => n && n.length <= 60).flatMap((n) => {
    const parts = n.trim().split(/\s+/);
    return parts.length < 2 ? [n] : [n, `${parts[parts.length - 1]}, ${parts[0]}`];
  }))].sort((a, b) => b.length - a.length);
  return list.length
    ? new RegExp(`(^|\\s)(@(?:${list.map((n) => reEscape(encode(n))).join('|')}))(?![\\p{L}\\p{N}_])`, 'gu')
    : null;
}

/** The classes and hints of mentions, by who the person is. */
const MENTION_KINDS = {
  adobe: { cls: 'adobe', title: 'Adobe' },
  partner: { cls: 'external partner', title: 'Partner, not Adobe' },
  customer: { cls: 'external customer', title: 'Customer, not Adobe' },
  bot: { cls: 'bot', title: 'Bot' },
};
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, e) => ({
  amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'",
}[e]));

/** `@Name` of someone the thread does not know: one to three words. */
const MENTION = /(^|\s)(@[\p{L}][\p{L}.' -]{0,40}?[\p{L}])(?=[\s,.:;!?]|$)/gu;
/** `:name:` with an optional `::skin-tone-N`. */
const EMOJI_CODE = /:([a-z0-9_+-]+(?:::skin-tone-[2-6])?):/g;
/** Where a marked line ending ends a block, rather than breaking a line. */
const BLOCK_END = /(<\/(?:p|li|ul|ol|blockquote|h[1-6]|table|thead|tbody|tr|pre)>|<hr \/>)\uE000/g;

/**
 * Links with a space in their address, as pile 2 stored them before src/markdown.js encoded
 * it: CommonMark does not take them for links.
 */
const repair = (src) => src.replace(
  /\]\((https?:\/\/[^()"\n]*?\s[^()"\n]*?)\)/g,
  (_, url) => `](${url.trim().replace(/\s/g, '%20')})`,
);

// Images are shown at most this tall (the bubble limits the width).
export const IMAGE_MAX_HEIGHT = 360;

function image(tag, proxy) {
  const src = (/ src="([^"]*)"/.exec(tag) || [])[1] || '';
  const url = proxy(src.replace(/&amp;/g, '&'));
  // A `WxH` title is the image's size: the space is reserved before it loads, so the
  // thread does not jump when it arrives.
  const size = / title="(\d{1,5})x(\d{1,5})"/.exec(tag);
  let dims = '';
  if (size) {
    const [w, h] = [Number(size[1]), Number(size[2])];
    const scale = Math.min(1, IMAGE_MAX_HEIGHT / h);
    dims = ` width="${Math.max(1, Math.round(w * scale))}" height="${Math.max(1, Math.round(h * scale))}"`;
  }
  return tag
    .replace(/ title="\d{1,5}x\d{1,5}"/, '')
    .replace(/ src="[^"]*"/, ` class="att${size ? ' sized' : ''}" src="${encode(url)}"${dims}`)
    .replace(/ ?\/>$/, ' loading="lazy" tabindex="0">');
}

/**
 * Paragraphs of nothing but images, one after the other (Teams and Slack attach images so):
 * two or more images in such a run are a gallery, a grid the page shows them in.
 */
const IMAGE_RUN = /(?:<p>(?:\s*(?:<img class="att[^>]*>|<br \/>))+\s*<\/p>\s*)+/g;
const galleries = (html) => html.replace(IMAGE_RUN, (run) => {
  const images = run.match(/<img [^>]*>/g);
  return images.length < 2 ? run : `<div class="gallery">${images.join('')}</div>\n`;
});

/**
 * Markdown to HTML, safe to put in the page.
 *
 * @param {string} src
 * @param {object} [options]
 * @param {RegExp|null} [options.mentions] from mentionPattern()
 * @param {(name: string) => string|undefined} [options.emoji] the character for an emoji name
 * @param {(url: string) => string} [options.proxy] the address to load an image from
 * @param {(name: string) => string|undefined} [options.kindOf] who a mentioned name is
 *   (`adobe`, `partner`, `customer`, `bot`): a class on the mention, and a hint
 */
export function render(src, {
  mentions = null, emoji = () => undefined, proxy = (u) => u, kindOf = () => undefined,
} = {}) {
  const mark = (_, before, at) => {
    const kind = MENTION_KINDS[kindOf(decode(at.slice(1)))];
    return kind
      ? `${before}<span class="mention ${kind.cls}" title="${kind.title}">${at}</span>`
      : `${before}<span class="mention">${at}</span>`;
  };
  const html = micromark(repair(String(src || '').replaceAll(BREAK, '')), OPTIONS)
    .replace(BLOCK_END, '$1\n')
    .replaceAll(BREAK, '<br />\n');
  let code = 0;
  return galleries(html.split(/(<[^>]*>)/).map((part, i) => {
    if (i % 2) {
      if (/^<(code|pre)[\s>]/.test(part)) {
        code += 1;
      } else if (/^<\/(code|pre)>/.test(part)) {
        code -= 1;
      } else if (part.startsWith('<a ')) {
        return part.replace('<a ', '<a target="_blank" rel="noopener" ');
      } else if (part.startsWith('<img ')) {
        return image(part, proxy);
      }
      return part;
    }
    if (code || !part) {
      return part;
    }
    let text = part;
    if (mentions) {
      text = text.replace(mentions, mark);
    }
    return text
      .replace(MENTION, mark)
      .replace(EMOJI_CODE, (m, name) => emoji(name) || m);
  }).join('')).trim();
}
