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

import { UA } from './favicons.js';

/**
 * The sources of a shared draft: the pages its claims rest on, so the person reviewing it can
 * check them before sending. They are saved with the draft and shown in the inbox only; they
 * are never part of the reply. An agent chooses them, and what it reads is written by people
 * outside our control, so a source is treated like a link in a customer's message.
 *
 * `GET /api/draft/source?thread=&url=` says how the inbox can show one: in a frame where the
 * site lets it be framed (a page cannot tell from the browser, so the Worker looks at the
 * response headers), else as Markdown, from text or from what the page's HTML says. Only the
 * sources of the thread's current draft are fetched, so this is no proxy for anything else.
 */

export const MAX_SOURCES = 10;
const MAX_URL = 2000;
const MAX_TITLE = 200;
const MAX_QUOTE = 1000;

const MAX_BYTES = 512 * 1024;
const MAX_TEXT = 40000;
const MAX_HOPS = 4;
const FETCH_MS = 5000;

/** `sources` as saved, `{ sources }`, or `{ error }` saying which one cannot be used. */
export function cleanSources(list) {
  const given = Array.isArray(list) ? list : [];
  if (given.length > MAX_SOURCES) {
    return { error: `at most ${MAX_SOURCES} sources` };
  }
  const byUrl = new Map();
  for (const s of given) {
    let url = null;
    try {
      url = new URL(String(s?.url ?? ''));
    } catch {
      // Refused below.
    }
    if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password
      || url.href.length > MAX_URL) {
      return { error: `a source needs an http(s) address: ${String(s?.url ?? '').slice(0, 100)}` };
    }
    const title = String(s.title || '').trim().slice(0, MAX_TITLE);
    const quote = String(s.quote || '').trim().slice(0, MAX_QUOTE);
    byUrl.set(url.href, {
      url: url.href, ...(title ? { title } : {}), ...(quote ? { quote } : {}),
    });
  }
  return { sources: [...byUrl.values()] };
}

/** The saved `sources` column as a list. */
export function sourcesOf(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const NO_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|invalid|test|example)$/i;

/** Whether the Worker may fetch `u`: a public name, not an address or our own host. */
export function fetchable(u, own) {
  const host = u.hostname.toLowerCase();
  return /^https?:$/.test(u.protocol) && host !== String(own || '').toLowerCase()
    && host.includes('.') && !NO_HOST.test(host)
    && !/^\[|^\d+\.\d+\.\d+\.\d+$/.test(host);
}

/** Whether a response's headers let any site frame it. */
export function frameable(headers) {
  if (headers.get('x-frame-options')) {
    return false;
  }
  const policy = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(headers.get('content-security-policy') || '');
  if (!policy) {
    return true;
  }
  const allowed = policy[1].trim().toLowerCase().split(/\s+/);
  return allowed.includes('*') || allowed.includes('https:');
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decode(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, name) => {
    if (name[0] !== '#') {
      return ENTITIES[name.toLowerCase()] ?? all;
    }
    const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

/** What a page says, as Markdown: its main part, without scripts, menus and the like. */
export function pageMarkdown(html, base) {
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
  const text = (main ? main[2] : html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|nav|header|footer|aside|form|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (all, code) => `\n\n\`\`\`\n${code.replace(/<[^>]+>/g, '')}\n\`\`\`\n\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (all, n, t) => `\n\n${'#'.repeat(n)} ${t.replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<a\b[^>]*\shref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (all, href, label) => {
      let to = null;
      try {
        to = new URL(decode(href), base);
      } catch {
        // Not an address: the label alone.
      }
      const t = label.replace(/<[^>]+>/g, '').trim();
      return t && to && /^https?:$/.test(to.protocol) ? `[${t}](${to.href})` : t;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|ul|ol|table|tr|blockquote)>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decode(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT);
}

/** The start of a response's body, as text. */
async function bodyOf(res) {
  if (!res.body) {
    return '';
  }
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  while (size < MAX_BYTES) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    parts.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(await new Blob(parts).arrayBuffer());
}

/** Follows redirects itself, so every hop is checked as the first one was. */
async function follow(address, own, fetchImpl) {
  let u = new URL(address);
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    if (!fetchable(u, own)) {
      return { reason: 'This address is not one the inbox fetches.' };
    }
    // eslint-disable-next-line no-await-in-loop
    const res = await fetchImpl(u.href, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/markdown,text/html;q=0.9,text/plain;q=0.8,*/*;q=0.5' },
      signal: AbortSignal.timeout(FETCH_MS),
    });
    const to = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!to) {
      return { res, url: u };
    }
    // eslint-disable-next-line no-await-in-loop
    await res.body?.cancel().catch(() => {});
    u = new URL(to, u);
  }
  return { reason: 'This address redirects too often.' };
}

/** How the inbox can show the page at `address`: `{ view: frame|markdown|none, url, … }`. */
export async function lookAt(address, { own, fetchImpl = fetch } = {}) {
  const none = (reason, url = address) => ({ view: 'none', url, reason });
  let found;
  try {
    found = await follow(address, own, fetchImpl);
  } catch (e) {
    return none(e.name === 'TimeoutError' ? 'The site took too long to answer.' : 'The site could not be reached.');
  }
  const { res, url, reason } = found;
  if (!res) {
    return none(reason);
  }
  const final = url.href;
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return none(`The site answered ${res.status}: it may need a sign-in.`, final);
  }
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (/\.(md|markdown)$/i.test(url.pathname) || /^text\/(markdown|plain)$/.test(type)) {
    return { view: 'markdown', url: final, text: (await bodyOf(res)).slice(0, MAX_TEXT) };
  }
  const html = type === 'text/html' || type === 'application/xhtml+xml';
  if ((html || type.startsWith('image/')) && url.protocol === 'https:' && frameable(res.headers)) {
    await res.body?.cancel().catch(() => {});
    return { view: 'frame', url: final };
  }
  if (!html) {
    await res.body?.cancel().catch(() => {});
    return none('This kind of file cannot be shown here.', final);
  }
  const page = await bodyOf(res);
  const text = pageMarkdown(page, final);
  if (!text) {
    return none('This page shows nothing without running its scripts.', final);
  }
  const title = /<title\b[^>]*>([^<]*)<\/title>/i.exec(page);
  return {
    view: 'markdown', url: final, text, ...(title ? { title: decode(title[1]).trim() } : {}),
  };
}
