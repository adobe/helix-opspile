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
 * Slack mrkdwn to markdown.
 *
 * @param {string} text
 * @param {(id: string) => string|undefined} userName resolves `<@U…>` mentions
 */
export function slackToMarkdown(text, userName = () => undefined) {
  if (!text) {
    return '';
  }
  const blocks = String(text).split(/(```[\s\S]*?```)/);
  return blocks.map((part, i) => {
    if (i % 2 === 1) {
      const code = part.slice(3, -3).replace(/^\n|\n$/g, '');
      return `\n\`\`\`\n${decodeEntities(code)}\n\`\`\`\n`;
    }
    return part
      .split(/(`[^`\n]+`)/)
      .map((seg, j) => {
        if (j % 2 === 1) {
          return decodeEntities(seg);
        }
        return seg
          .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => `@${label || userName(id) || id}`)
          .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `#${label || id}`)
          .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_, label) => (label || '@group'))
          .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
          .replace(/<!date\^\d+\^[^|>]*\|([^>]+)>/g, '$1')
          .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, url, label) => `[${label}](${url})`)
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

/**
 * Teams message HTML to markdown. Handles the tags Teams produces: paragraphs, breaks,
 * emphasis, links, lists, code, quotes, mentions (`<at>`) and images.
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
      return `[${!text || text === href ? href : text}](${href})`;
    })
    .replace(/<img\s[^>]*?(?:alt="([^"]*)")?[^>]*>/gi, (_, alt) => `![${alt || 'image'}]()`)
    .replace(/<(b|strong)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '**$3**')
    .replace(/<(i|em)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '*$3*')
    .replace(/<(s|strike|del)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '~~$3~~')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${t}\n\n`)
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, q) => `\n\n${q.replace(/<[^>]+>/g, '').trim().split('\n').map((l) => `> ${l}`)
      .join('\n')}\n\n`)
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, items) => {
      let n = 0;
      return `\n\n${items.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, t) => {
        n += 1;
        return `${n}. ${t.trim()}\n`;
      })}\n`;
    })
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
