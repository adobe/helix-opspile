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

import { EMOJI_ALIASES, SKIN_TONES, SLACK_EMOJI } from './emoji.js';
import EDITOR from './ui-editor.bundle.js';
import FMC, { etag as FMC_ETAG } from './ui-fmc.bundle.js';
import HIGHLIGHT, { etag as HIGHLIGHT_ETAG } from './ui-highlight.bundle.js';
import THREE, { etag as THREE_ETAG } from './ui-three.bundle.js';
import MARKDOWN from './ui-markdown.bundle.js';
import { assemble, spectrumColor, spectrumTokens } from './pagecore.js';

export { spectrumColor, spectrumTokens };

const PLACEHOLDER = '/* SLACK_EMOJI */ { names: {}, skin: [] }';

/**
 * A page of ui/ as served: its scripts, ui/*.js, `markdown.js` (the markdown renderer,
 * src/ui-markdown.js, as the global `Markdown`) and `editor.js` (the knowledge-base editor's
 * text field, src/ui-editor.js, as the global `Editor`), and its stylesheets, ui/*.css,
 * inlined where the page names them. `spectrum-tokens.css` is none of those: it is the
 * Spectrum 2 tokens the page's other stylesheets use (`spectrumTokens`). The scripts and
 * styles live in their own files, which lint and test/ui-spectrum.test.js check, and what
 * every page shares (the header, ui/header.js and ui/spectrum.css) is written once, but the
 * page stays one request.
 *
 * @param {string} html the page, ui/<name>.html
 * @param {Record<string, string>} scripts ui/*.js and ui/*.css by file name
 */
export function page(html, scripts) {
  return assemble(html, { ...scripts, 'markdown.js': MARKDOWN, 'editor.js': EDITOR });
}

/**
 * ui/inbox.html as served (see `page`), with Slack's emoji names filled in, and the names
 * GitHub, Discord and Teams give them.
 */
export function inboxPage(html, scripts) {
  const served = page(html, scripts);
  if (!served.includes(PLACEHOLDER)) {
    throw new Error('ui/inbox.js has no SLACK_EMOJI placeholder');
  }
  const emoji = JSON.stringify({ names: SLACK_EMOJI, skin: SKIN_TONES, aliases: EMOJI_ALIASES });
  return served.replace(PLACEHOLDER, () => emoji);
}

/** Where the inbox imports its code highlighter from (ui/inbox.js, `highlightCode`). */
export const HIGHLIGHT_PATH = '/inbox/highlight.js';

/** Where the inbox imports its stack drawing's renderer from (ui/stack.js, `Stack.wire`). */
export const FMC_PATH = '/inbox/fmc.js';

/** Where the Topics page imports three.js from (ui/topicview.js, `TopicView.mount`). */
export const THREE_PATH = '/inbox/three.js';

/** A module the inbox imports, for a GET or HEAD: kept by the browser, asked again by its hash. */
function moduleResponse(request, code, etag) {
  const headers = {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-cache',
    etag,
  };
  const seen = (request.headers.get('if-none-match') || '').split(/\s*,\s*/);
  if (seen.includes(etag) || seen.includes(`W/${etag}`)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : code, { headers });
}

/**
 * The code highlighter (src/ui-highlight.js, with @pierre/highlights) as an ES module, for a
 * GET or HEAD of `HIGHLIGHT_PATH`, or null. It is not in the page, which it would make some
 * 400 KB larger: the inbox imports it with the first code block it shows. The browser keeps
 * it, and asks whether it changed with its hash.
 *
 * @param {{ method: string, headers: Headers }} request
 * @param {string} pathname
 */
export function highlightScript(request, pathname) {
  if (pathname !== HIGHLIGHT_PATH || !['GET', 'HEAD'].includes(request.method)) {
    return null;
  }
  return moduleResponse(request, HIGHLIGHT, HIGHLIGHT_ETAG);
}

/**
 * The stack drawing's renderer (src/ui-fmc.js, with Graphviz) as an ES module, for a GET or
 * HEAD of `FMC_PATH`, or null; some 1.5 MB (500 KB compressed), which the inbox imports the
 * first time it shows a customer's stack, and the browser keeps as it does the highlighter.
 *
 * @param {{ method: string, headers: Headers }} request
 * @param {string} pathname
 */
export function fmcScript(request, pathname) {
  if (pathname !== FMC_PATH || !['GET', 'HEAD'].includes(request.method)) {
    return null;
  }
  return moduleResponse(request, FMC, FMC_ETAG);
}

/**
 * three.js (src/ui-three.js) as an ES module, for a GET or HEAD of `THREE_PATH`, or null; some
 * 570 KB (150 KB compressed), which the Topics page imports when it first draws its map, and the
 * browser keeps as it does the highlighter.
 *
 * @param {{ method: string, headers: Headers }} request
 * @param {string} pathname
 */
export function threeScript(request, pathname) {
  if (pathname !== THREE_PATH || !['GET', 'HEAD'].includes(request.method)) {
    return null;
  }
  return moduleResponse(request, THREE, THREE_ETAG);
}

/**
 * Where an address of the Spectrum 2 preview, /spectrum…, is now: the same page under /inbox
 * (/spectrum the inbox, /spectrum/kb the editor, …), with its query. Null for any other.
 */
export function fromPreview(pathname, search = '') {
  const m = /^\/spectrum(\/(?:kb|admin|cogs))?\/?$/.exec(pathname);
  return m ? `/inbox${m[1] || ''}${search}` : null;
}
