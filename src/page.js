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
import MARKDOWN from './ui-markdown.bundle.js';
import TOKENS from './ui-spectrum.bundle.js';

const PLACEHOLDER = '/* SLACK_EMOJI */ { names: {}, skin: [] }';

/** `<script src="name.js"></script>`, with or without `type="module"`, in a page of ui/. */
const SCRIPT = /<script( type="module")? src="([a-z-]+\.js)"><\/script>/g;

/** `<link rel="stylesheet" href="name.css">` in a page of ui/. */
const STYLE = /<link rel="stylesheet" href="([a-z-]+\.css)">/g;

/**
 * A page of ui/ as served: its scripts, ui/*.js, `markdown.js` (the markdown renderer,
 * src/ui-markdown.js, as the global `Markdown`) and `editor.js` (the knowledge-base editor's
 * text field, src/ui-editor.js, as the global `Editor`), and its shared stylesheets, ui/*.css,
 * inlined where the page names them. The scripts live in their own files, which lint checks,
 * and what every page shares (the header, ui/header.*) is written once, but the page stays
 * one request.
 *
 * @param {string} html the page, ui/<name>.html
 * @param {Record<string, string>} scripts ui/*.js and ui/*.css by file name
 */
export function page(html, scripts) {
  const files = { ...scripts, 'markdown.js': MARKDOWN, 'editor.js': EDITOR };
  const styled = html.replace(STYLE, (tag, name) => {
    if (typeof files[name] !== 'string') {
      throw new Error(`no stylesheet ${name} for the page`);
    }
    // In an inline <style>, `</style` would end it.
    return `<style>\n${files[name].replace(/<\/(style)/gi, '<\\/$1')}</style>`;
  });
  return styled.replace(SCRIPT, (tag, module, name) => {
    if (typeof files[name] !== 'string') {
      throw new Error(`no script ${name} for the page`);
    }
    // In an inline <script>, `</script` would end it.
    const code = files[name].replace(/<\/(script)/gi, '<\\/$1');
    return `<script${module || ''}>\n${code}</script>`;
  });
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

/** A Spectrum 2 token a stylesheet uses: `var(--spectrum-…)`. */
const TOKEN = /var\(--(spectrum-[a-z0-9-]+)/g;

/**
 * The Spectrum 2 tokens a stylesheet uses, and those they are made of, as custom properties
 * on :root: the light color scheme and the medium scale, the dark color scheme where the
 * browser prefers it and the large scale on a touch screen, as Spectrum's classes would set
 * them (@spectrum-css/tokens, src/ui-spectrum.bundle.js).
 *
 * @param {string} css
 * @param {Record<string, Record<string, string>>} tokens the sets, by `global`, `light`, …
 */
export function spectrumTokens(css, tokens = TOKENS) {
  const sets = ['global', 'light', 'dark', 'medium', 'large'];
  const used = new Set();
  const todo = [...css.matchAll(TOKEN)].map((m) => m[1]);
  while (todo.length) {
    const name = todo.pop();
    if (!used.has(name)) {
      used.add(name);
      for (const set of sets) {
        const value = tokens[set][name];
        if (value) {
          todo.push(...[...value.matchAll(TOKEN)].map((m) => m[1]));
        }
      }
    }
  }
  const missing = [...css.matchAll(TOKEN)].map((m) => m[1])
    .filter((name) => !sets.some((set) => tokens[set][name]));
  if (missing.length) {
    throw new Error(`no Spectrum 2 token ${[...new Set(missing)].join(', ')}`);
  }
  const block = (...from) => from.flatMap((set) => Object.entries(tokens[set]))
    .filter(([name]) => used.has(name))
    .map(([name, value]) => `  --${name}: ${value};`)
    .join('\n');
  const root = (from) => (block(...from) ? `:root {\n${block(...from)}\n}\n` : '');
  const media = (query, from) => (root(from) ? `@media ${query} {\n${root(from)}}\n` : '');
  return root(['global', 'light', 'medium'])
    + media('(prefers-color-scheme: dark)', ['dark'])
    + media('(hover: none) and (pointer: coarse)', ['large']);
}

/**
 * A color token as the browser draws it in one color scheme (for the pages' theme-color,
 * which takes no custom properties): its value with every `var()` filled in.
 */
export function spectrumColor(name, scheme, tokens = TOKENS) {
  const value = (n) => tokens[scheme][n] ?? tokens.global[n] ?? tokens.medium[n];
  let out = `var(--${name})`;
  for (let i = 0; i < 10 && out.includes('var('); i += 1) {
    out = out.replace(/var\(--(spectrum-[a-z0-9-]+)\)/g, (_, n) => value(n) ?? '');
  }
  return out;
}

/**
 * A page of ui/ as served under /spectrum (see `page`), in Spectrum 2's look: the same page
 * and scripts, with Spectrum 2's fonts (ui/spectrum-fonts.css), the tokens its stylesheets
 * use (`spectrumTokens`), and the stylesheets, ui/spectrum.css (what every page shares) and
 * ui/spectrum-<name>.css (the page's own), after the page's own styles, which they override.
 * The root has the class `spectrum`, and the browser's chrome Spectrum's background.
 *
 * @param {string} served the page as `page` or `inboxPage` serves it
 * @param {string} name the page, `inbox`, `admin`, `kb` or `cogs`
 * @param {Record<string, string>} scripts ui/*.js and ui/*.css by file name
 */
export function spectrumPage(served, name, scripts) {
  for (const file of ['spectrum-fonts.css', 'spectrum.css']) {
    if (typeof scripts[file] !== 'string') {
      throw new Error(`no stylesheet ${file} for the page`);
    }
  }
  const css = `${scripts['spectrum.css']}\n${scripts[`spectrum-${name}.css`] || ''}`;
  const style = `${scripts['spectrum-fonts.css']}\n${spectrumTokens(css)}\n${css}`
    .replace(/<\/(style)/gi, '<\\/$1');
  if (!served.includes('</head>')) {
    throw new Error('the page has no </head>');
  }
  const theme = (scheme) => spectrumColor('spectrum-background-base-color', scheme);
  return served
    .replace(/<html( lang="[^"]*")?>/, (tag, lang) => `<html${lang || ''} class="spectrum">`)
    .replace(
      /(<meta name="theme-color" content=")[^"]*(" media="\(prefers-color-scheme: (dark|light)\)">)/g,
      (tag, before, after, scheme) => `${before}${theme(scheme)}${after}`,
    )
    .replace('</head>', () => `<style>\n${style}</style>\n</head>`);
}
