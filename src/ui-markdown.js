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
 *   (src/emojinames.js) finds an emoji by any platform's name for it, `matchEmoji` those
 *   whose name has what was typed (the composer's `:` suggestions)
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

import { CHANNEL_REF, QUOTE_TITLE } from './markdown.js';

export { emojiLookup, matchEmoji } from './emojinames.js';
export { CHANNEL_REF, withoutQuotes } from './markdown.js';

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
 * A quoted message (src/markdown.js quoteMarkdown) is a card: its author's line, linked to the
 * message, with when it was posted, above its text. A quote typed by hand stays a quote.
 */
const QUOTE_CARD = new RegExp(`<blockquote>\\s*<p><a href="([^"]*)" title="${QUOTE_TITLE}(?:, ([^"]*))?">([\\s\\S]*?)</a>(?:<br />)?\\s*</p>`, 'g');
let quoteTime = null;
function quotedAt(iso) {
  const d = new Date(String(iso).replace(/&amp;/g, '&'));
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  quoteTime = quoteTime || new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return ` <time datetime="${encode(d.toISOString())}">${encode(quoteTime.format(d))}</time>`;
}
const cards = (html) => html.replace(QUOTE_CARD, (_, href, at, name) => '<blockquote class="quote">'
  + `<p class="quote-by"><a href="${href}" title="Open the quoted message"><b>${name}</b></a>${at ? quotedAt(at) : ''}</p>`);

/**
 * The list of files ingestion puts at the end of a message (src/normalize.js): an
 * "Attachments:" line, then only images (`![name](url "WxH")`), links to files
 * (`- [name](url)`) and files of another Slack workspace the app cannot see. Text of the
 * person's own that starts a line with "Attachments:" is not one.
 */
const ATTACHMENTS = /(^|\n)[ \t]*Attachments:[ \t]*(?=\n|$)/g;
const FILE_IMAGE = /^!\[(?:\\.|[^\]\\\n])*\]\(\S*(?: "[^"\n]*")?\)$/;
const FILE_LINK = /^- \[(?:\\.|[^\]\\\n])*\]\(\S*\)$/;
const FILE_UNSEEN = /^- (.+) \(shared from another workspace; opspile cannot see it\)$/;

/**
 * A message split into its text and the files listed at its end, or null when it lists none:
 * `{ text, images, links, unseen }`, the images and links as the markdown lines they are, the
 * files opspile cannot see by what Slack says they are ("CSV file").
 *
 * @param {string} src
 */
export function splitAttachments(src) {
  const text = String(src || '');
  let at = -1;
  for (const m of text.matchAll(ATTACHMENTS)) {
    at = m.index + m[1].length;
  }
  if (at < 0) {
    return null;
  }
  const lines = text.slice(at).replace(/^[ \t]*Attachments:[ \t]*/, '').split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const ok = (l) => FILE_IMAGE.test(l) || FILE_LINK.test(l) || FILE_UNSEEN.test(l);
  if (!lines.length || !lines.every(ok)) {
    return null;
  }
  return {
    text: text.slice(0, at),
    images: lines.filter((l) => FILE_IMAGE.test(l)),
    links: lines.filter((l) => FILE_LINK.test(l)),
    unseen: lines.map((l) => (FILE_UNSEEN.exec(l) || [])[1]).filter(Boolean),
  };
}

/**
 * What a file is, by its name: `{ kind, label, ext }`. `table` and `text` files can be shown
 * in the page (ui/table.js, through GET /api/file).
 */
const FILE_KINDS = [
  ['table', /^(csv|tsv)$/, 'Table'],
  ['text', /^(txt|log|json|ndjson|jsonl|har|md|markdown|ya?ml|xml|ini|conf|cfg|toml|env|properties|sql|sh|diff|patch)$/, 'Text'],
  ['video', /^(mov|mp4|m4v|webm|avi|mkv|wmv)$/, 'Video'],
  ['audio', /^(mp3|wav|m4a|aac|ogg|oga|flac)$/, 'Audio'],
  ['image', /^(png|jpe?g|gif|webp|heic|heif|svg|bmp|tiff?)$/, 'Image'],
  ['pdf', /^pdf$/, 'PDF'],
  ['doc', /^(docx?|pages|odt|rtf)$/, 'Document'],
  ['sheet', /^(xlsx?|xlsm|numbers|ods)$/, 'Spreadsheet'],
  ['slides', /^(pptx?|key|odp)$/, 'Presentation'],
  ['archive', /^(zip|gz|tgz|tar|7z|rar|bz2|xz)$/, 'Archive'],
];
export function fileKind(name) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(String(name || '').trim());
  const ext = m ? m[1].toLowerCase() : '';
  const [kind, , label] = FILE_KINDS.find(([, re]) => re.test(ext)) || ['file', null, 'File'];
  return { kind, label, ext };
}

/** Where a file lives, by its link: what "Open in …" names. */
function fileHome(href) {
  const host = (/^https:\/\/([^/]+)/i.exec(href) || [])[1] || '';
  if (/(^|\.)slack\.com$/i.test(host)) {
    return 'Slack';
  }
  if (/(^|\.)(sharepoint\.com|microsoft\.com)$/i.test(host)) {
    return 'Teams';
  }
  if (/(^|\.)(discordapp\.com|discordapp\.net|discord\.com)$/i.test(host)) {
    return 'Discord';
  }
  return '';
}

/**
 * A file as a card: its kind (the extension, in the kind's colour), its name, linked to where
 * it lives, and for tables and text a Preview button (ui/inbox.js opens it). Without `href`, a
 * file that is not there to open (one being sent, one opspile cannot see), `note` says why.
 *
 * @param {{ name: string, href?: string, note?: string, preview?: boolean, type?: string }}
 *   file `name` and `href` as HTML (escaped, the link sanitized), as micromark writes them;
 *   `type`: its extension, where the name has none
 */
export function fileCard({
  name, href = '', note = '', preview = true, type = '',
}) {
  const { kind, label, ext } = fileKind(type ? `.${type}` : decode(name));
  const home = href ? fileHome(decode(href)) : '';
  const badge = encode((ext || 'file').slice(0, 4).toUpperCase());
  const title = encode(`${home ? `Open in ${home}` : 'Open'}: ${decode(name)}`);
  const nm = href
    ? `<a class="file-name" href="${href}" target="_blank" rel="noopener" title="${title}">${name}</a>`
    : `<span class="file-name">${name}</span>`;
  const sub = note || [label, home].filter(Boolean).join(' · ');
  const viewable = preview && href && (kind === 'table' || kind === 'text');
  const act = viewable
    ? `<button type="button" class="file-act" data-preview="${kind}" aria-expanded="false" title="${kind === 'table' ? 'Show the table here' : 'Show the text here'}">Preview</button>`
    : '';
  // The same link as the name's, as a button for the eye (the name is the one to tab to).
  const go = href ? `<a class="file-go" href="${href}" target="_blank" rel="noopener" title="${title}" tabindex="-1" aria-hidden="true">↗</a>` : '';
  return `<div class="file" data-kind="${kind}"${home ? ` data-home="${home}"` : ''}><span class="file-ico" aria-hidden="true">${badge}</span>`
    + `<span class="file-nm">${nm}<span class="file-sub">${encode(sub)}</span></span>${act}${go}</div>`;
}

/** The cards of a message's linked files and the ones opspile cannot see. */
function fileCards({ links, unseen }) {
  const list = links.map((line) => {
    // micromark writes the link, so its address is sanitized as any other link's.
    const html = micromark(repair(line.slice(2)), OPTIONS);
    const a = /<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(html);
    return a ? fileCard({ name: a[2], href: a[1] }) : '';
  });
  for (const what of unseen) {
    // Slack says what kind of file it is ("CSV file").
    const type = (/^([a-z0-9]{1,8}) file$/i.exec(what) || [])[1] || '';
    list.push(fileCard({ name: encode(what), note: 'Shared from another workspace; opspile cannot see it', type }));
  }
  const shown = list.filter(Boolean);
  return shown.length ? `<div class="files">${shown.join('')}</div>` : '';
}

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
 * @param {(token: string) => ({ name: string, href: string, title?: string,
 *   inbox?: boolean })|undefined} [options.channel] the channel a `#name` or `#C…` names: a
 *   link to it, as `#name` (`inbox`: the link is to the inbox, and opens in this tab)
 */
export function render(src, {
  mentions = null, emoji = () => undefined, proxy = (u) => u, kindOf = () => undefined,
  channel = () => undefined,
} = {}) {
  const mark = (_, before, at) => {
    const kind = MENTION_KINDS[kindOf(decode(at.slice(1)))];
    return kind
      ? `${before}<span class="mention ${kind.cls}" title="${kind.title}">${at}</span>`
      : `${before}<span class="mention">${at}</span>`;
  };
  // The files listed at the end: images as images (one paragraph each, so two or more are a
  // gallery), the others as cards, without the "Attachments:" line.
  const files = splitAttachments(String(src || '').replaceAll(BREAK, ''));
  const body = files ? [files.text.trimEnd(), ...files.images].join('\n\n')
    : String(src || '').replaceAll(BREAK, '');
  const html = cards(micromark(repair(body), OPTIONS)
    .replace(BLOCK_END, '$1\n')
    .replaceAll(BREAK, '<br />\n'));
  const channelLink = (m, before, token) => {
    const c = channel(token);
    if (!c || !c.href) {
      return m;
    }
    const attrs = c.inbox ? ' data-inbox' : ' target="_blank" rel="noopener"';
    const title = c.title ? ` title="${encode(c.title)}"` : '';
    return `${before}<a class="channel" href="${encode(c.href)}"${attrs}${title}>`
      + `#${encode(c.name || token)}</a>`;
  };
  let code = 0;
  let link = 0;
  return galleries(html.split(/(<[^>]*>)/).map((part, i) => {
    if (i % 2) {
      if (/^<(code|pre)[\s>]/.test(part)) {
        code += 1;
      } else if (/^<\/(code|pre)>/.test(part)) {
        code -= 1;
      } else if (part === '</a>') {
        link -= 1;
      } else if (part.startsWith('<a ')) {
        link += 1;
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
    if (!link) {
      text = text.replace(CHANNEL_REF, channelLink);
    }
    if (mentions) {
      text = text.replace(mentions, mark);
    }
    return text
      .replace(MENTION, mark)
      .replace(EMOJI_CODE, (m, name) => emoji(name) || m);
  }).join('')).trim() + (files ? fileCards(files) : '');
}
