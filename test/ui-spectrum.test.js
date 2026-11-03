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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  inboxPage, page, spectrumColor, spectrumPage, spectrumTokens,
} from '../src/page.js';
import { PAGES, SCRIPTS } from './ui.js';

const NAMES = ['inbox', 'admin', 'kb', 'cogs'];
const served = (name) => spectrumPage(
  (name === 'inbox' ? inboxPage : page)(PAGES[`${name}.html`], SCRIPTS),
  name,
  SCRIPTS,
);
const STYLESHEETS = Object.keys(SCRIPTS).filter((f) => /^spectrum(-[a-z]+)?\.css$/.test(f) && f !== 'spectrum-fonts.css');

describe('Spectrum 2 look (/spectrum)', () => {
  it('serves every page with the stylesheets after its own, and the root marked', () => {
    for (const name of NAMES) {
      const html = served(name);
      assert.match(html, /^<!doctype html>\n<html lang="en" class="spectrum">/, name);
      const own = html.lastIndexOf(SCRIPTS['header.css']);
      const shared = html.indexOf(SCRIPTS['spectrum.css']);
      const its = html.indexOf(SCRIPTS[`spectrum-${name}.css`]);
      assert.ok(own > 0 && shared > own && its > shared, name);
      assert.ok(html.indexOf(SCRIPTS['spectrum-fonts.css']) < shared, name);
      assert.ok(shared < html.indexOf('</head>'), name);
      // The browser's chrome: Spectrum 2's base background, light and dark.
      assert.ok(html.includes(`<meta name="theme-color" content="${spectrumColor('spectrum-background-base-color', 'dark')}" media="(prefers-color-scheme: dark)">`), name);
      assert.ok(html.includes(`<meta name="theme-color" content="${spectrumColor('spectrum-background-base-color', 'light')}" media="(prefers-color-scheme: light)">`), name);
    }
    assert.throws(() => spectrumPage('<html></html>', 'inbox', SCRIPTS), /no <\/head>/);
  });

  it('puts in the tokens the stylesheets use and what they are made of, in both schemes and scales', () => {
    const tokens = {
      global: { 'spectrum-a': 'var(--spectrum-b)', 'spectrum-unused': '1px' },
      light: { 'spectrum-b': 'rgba(var(--spectrum-b-rgb))', 'spectrum-b-rgb': '1, 1, 1' },
      dark: { 'spectrum-b': 'rgba(var(--spectrum-b-rgb))', 'spectrum-b-rgb': '9, 9, 9' },
      medium: { 'spectrum-size': '14px' },
      large: { 'spectrum-size': '17px' },
    };
    const css = spectrumTokens('a { color: var(--spectrum-a); font-size: var(--spectrum-size); }', tokens);
    assert.equal(css, `:root {
  --spectrum-a: var(--spectrum-b);
  --spectrum-b: rgba(var(--spectrum-b-rgb));
  --spectrum-b-rgb: 1, 1, 1;
  --spectrum-size: 14px;
}
@media (prefers-color-scheme: dark) {
:root {
  --spectrum-b: rgba(var(--spectrum-b-rgb));
  --spectrum-b-rgb: 9, 9, 9;
}
}
@media (hover: none) and (pointer: coarse) {
:root {
  --spectrum-size: 17px;
}
}
`);
    assert.throws(() => spectrumTokens('a { color: var(--spectrum-nope); }', tokens), /no Spectrum 2 token spectrum-nope/);
    assert.equal(spectrumColor('spectrum-a', 'dark', tokens), 'rgba(9, 9, 9)');
  });

  it('styles with Spectrum 2 tokens only: no raw colors, lengths or durations', () => {
    for (const file of STYLESHEETS) {
      // Comments say what the values are; the rules must not have them. A media query's
      // breakpoint, which no custom property can be, is the page's own.
      const css = SCRIPTS[file].replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
      const raw = [
        ...css.matchAll(/#[0-9a-f]{3,8}\b(?![^{]*\{)/gi),
        ...css.matchAll(/\b(?:rgba?|hsla?|oklch|lab|lch)\(\s*[\d.]/gi),
        ...css.matchAll(/(?<![\w-])-?\d*\.?\d+(?:px|rem|em|ms|s)\b/g),
        ...css.matchAll(/(?<![\w-])(?:white|black|red|blue|green|yellow|gray|grey|orange|purple|pink)\b(?=\s*[;!)])/g),
      ].map((m) => m[0]);
      assert.deepEqual(raw, [], file);
    }
  });
});
