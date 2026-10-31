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
 * Message bodies to markdown: Slack mrkdwn and Teams HTML. Both converters are small and
 * conservative; anything they do not understand is kept as text.
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * A URL as a markdown link destination. CommonMark ends a destination at a space or an
 * unbalanced parenthesis, and htmlToMarkdown would strip `<…>`: those are percent-encoded.
 */
export function mdUrl(url) {
  const s = String(url || '');
  let depth = 0;
  const balanced = [...s].every((c) => {
    depth += { '(': 1, ')': -1 }[c] || 0;
    return depth >= 0;
  }) && depth === 0;
  return s.replace(balanced ? /[\s<>]/g : /[\s<>()]/g, (c) => ({ '(': '%28', ')': '%29' }[c]
    || encodeURIComponent(c)));
}

/**
 * A channel named in a message: `#name`, or `#C…` (a Slack channel id, where Slack sent no
 * name), not inside a word, a URL (`/#…`), an entity (`&#39;`) or `##`. Names are what the
 * platforms allow: letters, digits, `-`, `_` and `.`, not ending in `-` or `.` (`#general.`
 * ends a sentence). src/channelrefs.js resolves them.
 */
export const CHANNEL_REF = /(^|[^\p{L}\p{N}_&/#])#([\p{L}\p{N}](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?)/gu;

/** A markdown link: brackets in the label are escaped, the URL is a safe destination. */
/** Width × height as an image title, so the inbox can reserve the space before it loads. */
export const sizeTitle = (w, h) => {
  const W = Math.round(Number(w));
  const H = Math.round(Number(h));
  return W > 0 && H > 0 && W < 100000 && H < 100000 ? `${W}x${H}` : null;
};

export const mdLink = (label, url, image = false, size = null) => `${image ? '!' : ''}[${String(label).replace(/[[\]\\]/g, '\\$&')}](${mdUrl(url)}${image && size ? ` "${size}"` : ''})`;

/**
 * The title of the link a quoted message starts with (quoteMarkdown): the inbox shows such a
 * quote as a card of the message, not as text someone quoted by hand.
 */
export const QUOTE_TITLE = 'Quoted message';

/** A quote's first line: `> [author](link "Quoted message, <ISO time>")`. */
export const QUOTE_HEAD = /^> \[((?:\\.|[^\]\\\n])*)\]\((\S+) "Quoted message(?:, ([^"\n]*))?"\)[ \t]*$/;

/**
 * A message that a message quotes (Slack: one forwarded, or the preview under a link to it), as
 * a markdown quote: its author, linked to it (the title says it is a quote, and when it was
 * posted), a blank line, then its text, itself markdown.
 *
 * @param {{ author?: string, url: string, at?: string, text?: string }} quote
 */
export function quoteMarkdown({
  author, url, at, text,
}) {
  const label = String(author || 'Message').replace(/\s+/g, ' ').replace(/[[\]\\]/g, '\\$&');
  const when = at && !/["\n]/.test(at) ? `, ${at}` : '';
  const head = `[${label}](${mdUrl(url)} "${QUOTE_TITLE}${when}")`;
  const body = String(text || '').trim();
  return [head, ...(body ? ['', ...body.split('\n')] : [])]
    .map((l) => (l ? `> ${l}` : '>')).join('\n');
}

/** Calls `fn(head, lines)` for each quote of a message (quoteMarkdown); the rest stays. */
function eachQuote(body, fn) {
  const lines = String(body || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = QUOTE_HEAD.exec(lines[i]);
    if (head) {
      let j = i + 1;
      while (j < lines.length && /^>/.test(lines[j]) && !QUOTE_HEAD.test(lines[j])) {
        j += 1;
      }
      out.push(...fn(head, lines.slice(i + 1, j)));
      i = j - 1;
    } else {
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}

/**
 * A message's body without the messages it quotes: what its author wrote, for mentions, the
 * vectors of what people talk about, and editing it.
 */
export function withoutQuotes(body) {
  return eachQuote(body, () => []).replace(/\n{3,}/g, '\n\n').trim();
}

/** A message's body with each quote's first line as `> <author> wrote:`, for plain text. */
export function quotesAsText(body) {
  return eachQuote(body, (head, rest) => [
    `> ${head[1].replace(/\\(.)/g, '$1')} wrote:`,
    ...rest.filter((l, k) => k > 0 || l.trim() !== '>'),
  ]);
}

/**
 * Slack mrkdwn to markdown.
 *
 * @param {string} text
 * @param {(id: string) => string|undefined} userName resolves `<@U…>` mentions
 */
/**
 * Slack's markup inside code: Slack links URLs and mentions in `text` even within backticks,
 * but shows what the person typed, so code keeps the label (or the bare URL, or @name).
 */
function unlinkCode(code, userName) {
  return code
    .replace(/<((?:https?|mailto):[^|>\s]+)(?:\|([^>]*))?>/g, (_, url, label) => label || url)
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => `@${label || userName(id) || id}`);
}

export function slackToMarkdown(text, userName = () => undefined) {
  if (!text) {
    return '';
  }
  const blocks = String(text).split(/(```[\s\S]*?```)/);
  return blocks.map((part, i) => {
    if (i % 2 === 1) {
      const code = part.slice(3, -3).replace(/^\n|\n$/g, '');
      return `\n\`\`\`\n${decodeEntities(unlinkCode(code, userName))}\n\`\`\`\n`;
    }
    return part
      .split(/(`[^`\n]+`)/)
      .map((seg, j) => {
        if (j % 2 === 1) {
          return decodeEntities(unlinkCode(seg, userName));
        }
        return seg
          .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => `@${label || userName(id) || id}`)
          .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `#${label || id}`)
          .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_, label) => (label || '@group'))
          .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
          .replace(/<!date\^\d+\^[^|>]*\|([^>]+)>/g, '$1')
          .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, url, label) => mdLink(label, url))
          .replace(/<((?:https?|mailto):[^>]+)>/g, '<$1>')
          .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1**$2**')
          .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1*$2*')
          .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:;]|$)/g, '$1~~$2~~')
          .replace(/^&gt;\s?/gm, '> ')
          .replace(/&(lt|gt|amp);/g, (m) => decodeEntities(m));
      })
      .join('');
  }).join('').trim();
}

/** A list with no list inside it. */
const INNER_LIST = /<(ul|ol)(?:\s[^>]*)?>((?:(?!<\/?(?:ul|ol)[\s>])[\s\S])*)<\/\1>/gi;

/** One list, in a line each item: what an item holds on further lines is indented under it. */
function listToMarkdown(tag, items) {
  let n = 0;
  return `\n\n${items.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => {
    n += 1;
    const marker = tag.toLowerCase() === 'ol' ? `${n}. ` : '- ';
    const text = t.trim().replace(/\n+(?=- |\d+\. )/g, '\n').replace(/\n/g, `\n${' '.repeat(marker.length)}`);
    return `${marker}${text}\n`;
  })}\n`;
}

/** HTML lists to markdown, the innermost first, so a list in an item stays in the item. */
function listsToMarkdown(html) {
  let before;
  let s = html;
  do {
    before = s;
    s = s.replace(INNER_LIST, (_, tag, items) => listToMarkdown(tag, items));
  } while (s !== before);
  return s;
}

const TABLE_RULE = {
  left: ':---', right: '---:', center: ':---:',
};

/** An HTML table to markdown: its first row is the header, each cell on one line. */
function tableToMarkdown(table) {
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(([, row]) => [...row.matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi)]);
  if (!rows.length || !rows[0].length) {
    return table;
  }
  const line = (cells) => `| ${cells.join(' | ')} |`;
  const text = (html) => html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
    .trim()
    .replace(/(?<!\\)\|/g, '\\|');
  const rule = rows[0].map(([, attrs]) => TABLE_RULE[(/\balign="(\w+)"/i.exec(attrs) || [])[1]] || '---');
  const [head, ...body] = rows.map((cells) => line(cells.map(([, , cell]) => text(cell))));
  return `\n\n${[head, line(rule), ...body].join('\n')}\n\n`;
}

/**
 * Teams message HTML to markdown. Handles the tags Teams produces: paragraphs, breaks,
 * emphasis, links, lists, tables, code, quotes, mentions (`<at>`) and images.
 */
export function htmlToMarkdown(html) {
  if (!html) {
    return '';
  }
  let s = String(html).replace(/\r\n?/g, '\n');
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    const inner = code.replace(/<\/?code[^>]*>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    return `\n\n\`\`\`\n${decodeEntities(inner).replace(/\n+$/, '')}\n\`\`\`\n\n`;
  });
  s = s
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${c.replace(/<[^>]+>/g, '')}\``)
    .replace(/<at[^>]*>([\s\S]*?)<\/at>/gi, (_, name) => `@${name.replace(/<[^>]+>/g, '')}`)
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      // Never `<href>`: the tag stripping below would remove it as if it were a tag.
      return mdLink(!text || text === href ? href : text, href);
    })
    .replace(/<img\s[^>]*>/gi, (tag) => {
      const attr = (name) => (new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag) || [])[1] || '';
      // Teams gives an image's size as attributes (and in its style).
      const px = (name) => attr(name) || (new RegExp(`${name}:\\s*(\\d+)px`, 'i').exec(attr('style')) || [])[1];
      return mdLink(attr('alt') || 'image', attr('src'), true, sizeTitle(px('width'), px('height')));
    })
    .replace(/<(b|strong)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '**$3**')
    .replace(/<(i|em)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '*$3*')
    .replace(/<(s|strike|del)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '~~$3~~')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${t}\n\n`)
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, q) => `\n\n${q.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim()
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')}\n\n`)
    .replace(/<table[^>]*>[\s\S]*?<\/table>/gi, tableToMarkdown)
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n');
  s = listsToMarkdown(s)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `- ${t.trim()}\n`)
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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

/**
 * Discord message content to markdown. Discord writes markdown already; what is left are its
 * tokens: user, role and channel mentions, custom emoji, timestamps, and `-#` small text.
 * Code keeps what was typed.
 *
 * @param {string} text
 * @param {{ user?: (id: string) => string|undefined, role?: (id: string) => string|undefined,
 *   channel?: (id: string) => string|undefined }} names
 */
export function discordToMarkdown(text, names = {}) {
  if (!text) {
    return '';
  }
  const user = names.user || (() => undefined);
  const role = names.role || (() => undefined);
  const channel = names.channel || (() => undefined);
  return String(text).split(/(```[\s\S]*?```|`[^`\n]+`)/).map((part, i) => {
    if (i % 2 === 1) {
      return part;
    }
    return part
      .replace(/<@!?(\d+)>/g, (_, id) => `@${user(id) || 'unknown'}`)
      .replace(/<@&(\d+)>/g, (_, id) => `@${role(id) || 'role'}`)
      .replace(/<#(\d+)>/g, (_, id) => `#${channel(id) || 'channel'}`)
      .replace(/<a?:(\w+):\d+>/g, ':$1:')
      .replace(/<t:(-?\d+)(?::([tTdDfFR]))?>/g, (_, s, style) => discordTime(s, style))
      .replace(/<\/([\w -]+):\d+>/g, '/$1')
      .replace(/^-# /gm, '');
  }).join('')
    .trim();
}

// Placeholders while markdownToMrkdwn works: kept spans (code, links), bold markers.
const KEEP = '\uE002';
const BOLD = '\uE001';
const slackEscape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// A link label in Slack ends at `|` or `>`; neither may stay in it.
const slackLabel = (s) => slackEscape(s.replace(/\|/g, '¦'));
const slackUrl = (s) => s.replace(/[\s<>|]/g, encodeURIComponent).replace(/&/g, '&amp;');

function mrkdwnInline(text, keep) {
  const kept = (s) => `${KEEP}${keep.push(s) - 1}${KEEP}`;
  return text
    // Code spans first: nothing inside them is markup, and Slack shows them as they are.
    .replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, (_, ticks, code) => kept(`\`${slackEscape(code.replace(/`/g, 'ˋ'))}\``))
    .replace(/!?\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, label, url) => kept(
      label && label !== url ? `<${slackUrl(url)}|${slackLabel(label)}>` : `<${slackUrl(url)}>`,
    ))
    .replace(/<((?:https?|mailto):[^\s>]+)>/g, (_, url) => kept(`<${slackUrl(url)}>`))
    .replace(/\*\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*\*/g, `${BOLD}_$1_${BOLD}`)
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, `${BOLD}$2${BOLD}`)
    .replace(/(^|[^\p{L}\p{N}*\\])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\p{L}\p{N}*])/gu, '$1_$2_')
    .replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '~$1~')
    .replace(/\\([\\`*_{}[\]()#+\-.!~|])/g, '$1')
    .replaceAll(BOLD, '*');
}

/**
 * Markdown to Slack mrkdwn, for the `text` of a message: `**bold**` → `*bold*`, `*italic*` →
 * `_italic_`, `~~struck~~` → `~struck~`, `[label](url)` → `<url|label>`, headings in bold,
 * bullets as `•`; code stays code, and `&`, `<` and `>` are escaped everywhere else (a `>`
 * starting a line stays a quote). Tables and the like are kept as text.
 */
export function markdownToMrkdwn(md) {
  const keep = [];
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null;
  for (const line of lines) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const closes = open && open[1][0] === fence[0] && open[1].length >= fence.length;
      if (closes && !line.trim().slice(open[1].length)) {
        fence = null;
        out.push('```');
      } else {
        out.push(slackEscape(line));
      }
    } else if (open) {
      [, fence] = open;
      out.push('```');
    } else {
      let m = /^ {0,3}(?:[-*_][ \t]*){3,}$/.exec(line);
      if (m) {
        out.push('──────────');
      } else {
        m = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
        if (m) {
          out.push(`*${slackEscape(mrkdwnInline(m[1], keep).replace(/\*/g, ''))}*`);
        } else {
          m = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:([-*+])[ \t]+(?:\[([ xX])\][ \t]+)?)?(.*)$/.exec(line);
          const quote = m[1] ? '> ' : '';
          const task = { ' ': '☐ ', x: '☑ ', X: '☑ ' }[m[4]] || '';
          const bullet = m[3] ? `${m[2]}• ${task}` : m[2];
          out.push(`${quote}${bullet}${slackEscape(mrkdwnInline(m[5], keep))}`);
        }
      }
    }
  }
  if (fence) {
    out.push('```');
  }
  return out.join('\n').replace(new RegExp(`${KEEP}(\\d+)${KEEP}`, 'g'), (_, i) => keep[Number(i)]);
}
