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
  fromPreview, inboxPage, page, spectrumColor, spectrumTokens,
} from '../src/page.js';
import { PAGES, SCRIPTS } from './ui.js';

const NAMES = ['inbox', 'admin', 'kb', 'cogs', 'topics'];
const served = (name) => (name === 'inbox' ? inboxPage : page)(PAGES[`${name}.html`], SCRIPTS);
const STYLESHEETS = Object.keys(SCRIPTS).filter((f) => /^spectrum(-[a-z]+)?\.css$/.test(f) && f !== 'spectrum-fonts.css');

describe('Spectrum 2', () => {
  it('is every page\'s look: its stylesheets, the tokens they use, and nothing else', () => {
    for (const name of NAMES) {
      const html = served(name);
      assert.match(html, /^<!doctype html>\n<html lang="en" class="spectrum">/, name);
      assert.doesNotMatch(PAGES[`${name}.html`], /<style[\s>]|style="/, name);
      const fonts = html.indexOf(SCRIPTS['spectrum-fonts.css']);
      const shared = html.indexOf(SCRIPTS['spectrum.css']);
      const its = html.indexOf(SCRIPTS[`spectrum-${name}.css`]);
      assert.ok(fonts > 0 && shared > fonts && its > shared, name);
      assert.ok(its < html.indexOf('</head>'), name);
      // The tokens the stylesheets use, light and dark, between the fonts and the stylesheets.
      const tokens = spectrumTokens(`${SCRIPTS['spectrum-fonts.css']}\n${SCRIPTS['spectrum.css']}\n${SCRIPTS[`spectrum-${name}.css`]}`);
      const at = html.indexOf(tokens);
      assert.ok(at > fonts && at < shared, name);
      assert.match(tokens, /--spectrum-background-base-color:/, name);
      // The browser's chrome: the app frame's layer, light and dark.
      assert.ok(html.includes(`<meta name="theme-color" content="${spectrumColor('spectrum-background-layer-1-color', 'dark').replace('rgba', 'rgb')}" media="(prefers-color-scheme: dark)">`), name);
      assert.ok(html.includes(`<meta name="theme-color" content="${spectrumColor('spectrum-background-layer-1-color', 'light').replace('rgba', 'rgb')}" media="(prefers-color-scheme: light)">`), name);
    }
  });

  it('keeps zero lengths that calc() adds to lengths', () => {
    for (const file of STYLESHEETS) {
      // A custom property set to a unitless 0 breaks every calc() that adds it to a length.
      assert.doesNotMatch(SCRIPTS[file], /--[a-z0-9-]+:\s*0\s*[;}]/, file);
    }
  });

  it('frames every page as Spectrum 2\'s app frame does: a content area on the frame\'s layer', () => {
    const shared = SCRIPTS['spectrum.css'];
    assert.match(shared, /--frame: var\(--spectrum-background-layer-1-color\);\s*--content: var\(--spectrum-background-base-color\);/);
    assert.match(shared, /:where\(\.spectrum\) body \{ background: var\(--frame\);/);
    // The header is part of the frame: no fill of its own, and no line under it.
    assert.match(shared, /\.spectrum header \{[^}]*background: transparent;\s*border-bottom: 0;/);
    // The inbox's list and thread, and a knowledge base's files and editor, are one container.
    for (const file of ['spectrum-inbox.css', 'spectrum-kb.css']) {
      assert.match(SCRIPTS[file], /\.spectrum main::before \{ content: ""; grid-row: 1; grid-column: [^;]+; background: var\(--content\);\s*border-radius: var\(--content-radius\); box-shadow: var\(--content-shadow\); \}/, file);
    }
    assert.match(SCRIPTS['spectrum-admin.css'], /\.spectrum #detail \{[^}]*background: var\(--content\);\s*border-radius: var\(--content-radius\);\s*box-shadow: var\(--content-shadow\);/);
    // Nothing on a page hangs over another part of it at rest: the open thread's row is
    // selected where it is, and a filter group has no card or shadow until it slides out.
    assert.doesNotMatch(SCRIPTS['spectrum-inbox.css'], /#lift|--out\b/);
    assert.doesNotMatch(PAGES['inbox.html'], /id="lift"/);
    // Dashes are a DropZone's, and the agent's thought bubble's: not a card's edge.
    assert.doesNotMatch(SCRIPTS['spectrum-inbox.css'], /\.spectrum \.(draftbar|bashbar \.br|sidechat) \{[^}]*dashed/);
    // What deletes is a secondary Button on a page; the red fill confirms it in a dialog.
    assert.match(shared, /\.spectrum button\.danger \{[^}]*background: transparent;/);
    assert.match(shared, /\.spectrum dialog button\.danger \{[^}]*background: var\(--spectrum-negative-background-color-default\);/);
  });

  it('sends the preview\'s addresses, /spectrum…, to the same page under /inbox', () => {
    assert.equal(fromPreview('/spectrum', '?team=t&t=th1'), '/inbox?team=t&t=th1');
    assert.equal(fromPreview('/spectrum/'), '/inbox');
    assert.equal(fromPreview('/spectrum/kb', '?repo=r'), '/inbox/kb?repo=r');
    assert.equal(fromPreview('/spectrum/admin', '?tab=orgs'), '/inbox/admin?tab=orgs');
    assert.equal(fromPreview('/spectrum/cogs'), '/inbox/cogs');
    assert.equal(fromPreview('/spectrumx'), null);
    assert.equal(fromPreview('/spectrum/nope'), null);
    assert.equal(fromPreview('/inbox'), null);
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
:root:not([data-scheme="light"]) {
  --spectrum-b: rgba(var(--spectrum-b-rgb));
  --spectrum-b-rgb: 9, 9, 9;
}
}
:root[data-scheme="dark"] {
  --spectrum-b: rgba(var(--spectrum-b-rgb));
  --spectrum-b-rgb: 9, 9, 9;
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
      // Comments say what the values are; the rules must not have them. A media or container
      // query's breakpoint, which no custom property can be, is the page's own.
      const css = SCRIPTS[file].replace(/\/\*[\s\S]*?\*\//g, '').replace(/@(media|container)[^{]*\{/g, '');
      const raw = [
        ...css.matchAll(/#[0-9a-f]{3,8}\b(?![^{]*\{)/gi),
        ...css.matchAll(/\b(?:rgba?|hsla?|oklch|lab|lch)\(\s*[\d.]/gi),
        // em is a size relative to the text, as a percentage is. A zero keeps its unit (`0px`):
        // a unitless 0 is a number, which calc() cannot add to a length.
        ...[...css.matchAll(/(?<![\w-])-?\d*\.?\d+(?:px|rem|ms|s)\b/g)].filter((m) => !/^-?0*\.?0+[a-z]+$/.test(m[0])),
        ...css.matchAll(/(?<![\w-])(?:white|black|red|blue|green|yellow|gray|grey|orange|purple|pink)\b(?=\s*[;!)])/g),
      ].map((m) => m[0]);
      assert.deepEqual(raw, [], file);
    }
  });

  it('labels its fields, with no placeholder, and asks before a team is deleted', () => {
    const written = [...Object.entries(PAGES), ...Object.entries(SCRIPTS)].filter(([name]) => /\.(html|js)$/.test(name));
    for (const [name, text] of written) {
      // A placeholder is gone once you type and reads as a value until then: a field has a
      // label (`.fld`, a form's own <label>), a search field its magnifier and an aria-label.
      assert.doesNotMatch(text, /placeholder\s*[=:]/, name);
    }
    assert.match(SCRIPTS['admin.js'], /<label class="fld grow"><span>Name<\/span><input id="ntName" required><\/label>/);
    assert.match(SCRIPTS['admin.js'], /<label class="s2-search"><input class="search" id="filter" type="search" aria-label="Filter teams"/);
    assert.match(SCRIPTS['spectrum.css'], /\.spectrum \.s2-search::before \{[^}]*mask: var\(--s2-icon-search\)/);
    // Deleting a team is confirmed in an alert dialog; resetting an org is not.
    assert.match(SCRIPTS['admin.js'], /\$\('tDelete'\)\.onclick = async \(\) => \(await confirmFirst\(/);
    assert.match(SCRIPTS['admin.js'], /\$\('oDelete'\)\.onclick = \(\) => hold\(/);
    assert.match(SCRIPTS['admin.js'], /dlg\.setAttribute\('role', 'alertdialog'\)/);
  });

  it('shows what a filter\'s value or a thread is with Spectrum 2\'s workflow icons, not emoji', () => {
    const js = SCRIPTS['inbox.js'];
    const css = SCRIPTS['spectrum-inbox.css'];
    const maps = [...js.matchAll(/const (?:KIND|URGENCY|STATUS|RESOLVED|DRAFT|WAITING|TYPE)_ICON = \{([^}]*)\};/g)];
    assert.equal(maps.length, 7);
    for (const [, body] of maps) {
      const names = [...body.matchAll(/: '([^']+)'/g)].map((m) => m[1]);
      assert.ok(names.length > 1);
      // Each is an icon the stylesheet has, by name; none is a character.
      for (const name of names) {
        assert.match(name, /^[a-z-]+$/);
        assert.ok(css.includes(`.spectrum .wf-${name} { --wf: `), name);
      }
    }
    assert.match(css, /\.spectrum \.wf \{[^}]*background: currentColor;\s*mask: var\(--wf\) center \/ contain no-repeat;/);
  });

  it('draws its icons and checkboxes itself, and its overlays arrive', () => {
    const shared = SCRIPTS['spectrum.css'];
    // A chevron or a menu's checkmark is Spectrum 2's icon, a mask in the text's color, on an
    // empty span: not a triangle or a check mark of the typeface, which a screen reader reads.
    for (const icon of ['chevron', 'checkmark', 'close']) {
      assert.match(shared, new RegExp(`--s2-icon-${icon}: url\\("data:image/svg\\+xml;base64,`));
    }
    const written = [...Object.entries(PAGES), ...Object.entries(SCRIPTS)].filter(([name]) => /\.(html|js)$/.test(name));
    for (const [name, text] of written) {
      assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ''), /[▾▸▴◂]/, name);
      assert.doesNotMatch(text, /class="ck">|class="ck[^"]*"[^>]*>✓/, name);
    }
    assert.match(PAGES['inbox.html'], /<span class="ck s2-check" aria-hidden="true"><\/span>When someone mentions me/);
    // The header's mode (reviewing labels, viewing as someone) is one row: icon, label, cross.
    assert.match(shared, /header \.mode \{ display: inline-flex; align-items: center;/);
    // The checkbox is drawn here, in tokens, in place of the browser's.
    assert.match(shared, /input:where\(\[type="checkbox"\]\) \{\s*appearance: none;/);
    // Popovers and dialogs fade in from where they come from, and out; not for reduced motion,
    // which sets every transition's duration to none.
    assert.match(shared, /@starting-style \{\s*\.spectrum \[popover\]:popover-open \{ opacity: 0;/);
    assert.match(shared, /@starting-style \{\s*\.spectrum dialog:not\(\.lightbox\)\[open\] \{ opacity: 0;/);
    assert.match(shared, /prefers-reduced-motion: reduce\) \{\s*\.spectrum \*, [^{]*\{ transition-duration: var\(--spectrum-animation-duration-0\) !important; \}/);
    // New rows and messages do not slide in for reduced motion either.
    assert.match(SCRIPTS['spectrum-inbox.css'], /prefers-reduced-motion: reduce\) \{ \.t\.enter, \.msg\.enter, \.sys\.enter \{ animation: none; \} \}/);
  });
});
