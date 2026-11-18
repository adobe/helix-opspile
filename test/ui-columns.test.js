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

/*
 * Wide screens (ui/spectrum-inbox.css, "Wide screens"; ui/inbox.js, "the columns' widths"): the
 * ultrawide, megawide and hyperwide bands flow the filters into 2, 3 and 4 columns, and the
 * grips between the columns size them, kept per band.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PAGES, SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];
const css = SCRIPTS['spectrum-inbox.css'];

/** A piece of the page's script, from the line starting with `from` up to `to`, run in Node. */
function piece(from, to, expose, globals = {}) {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${js.slice(a, b)}\nreturn { ${expose} };`)(
    ...Object.values(globals),
  );
}

/** The columns' code, on a screen `width` px wide, with `rect` the elements' boxes. */
function columns(width, rect = {}) {
  const store = new Map();
  const classes = new Set();
  const props = new Map();
  const main = {
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
    getBoundingClientRect: () => ({ width: rect.main ?? width }),
  };
  const box = (id) => ({ hidden: id === 'side' && !rect.side, getBoundingClientRect: () => ({ width: rect[id] ?? 0 }) });
  const code = piece('const BANDS = ', 'function wireColumns', 'bandOf, keepColumn, sizeColumns, setColumn, mostColumn, COLUMNS_KEY', {
    matchMedia: (q) => ({ matches: width >= Number(q.match(/(\d+)px/)[1]) }),
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    document: { querySelector: () => main },
    $: box,
  });
  return {
    ...code, store, classes, props,
  };
}

describe('wide screens', () => {
  it('has three bands past a desktop: ultrawide, megawide and hyperwide', () => {
    assert.equal(columns(1920).bandOf(), 'wide');
    assert.equal(columns(2560).bandOf(), 'ultrawide');
    assert.equal(columns(3440).bandOf(), 'megawide');
    assert.equal(columns(5120).bandOf(), 'hyperwide');
    // The stylesheet's bands are the script's.
    for (const px of [2400, 3200, 4800]) {
      assert.match(css, new RegExp(`@media \\(min-width: ${px}px\\) \\{\\n {2}main:not\\(\\.simple\\) \\{ --filters-w: `));
    }
  });

  it('flows the filters into 2, 3 and 4 columns, as many as their width has room for', () => {
    assert.match(PAGES['inbox.html'], /<section id="filters" aria-label="Filters"><div id="facets"><\/div><\/section>/);
    assert.match(js, /const box = \$\('facets'\);/);
    assert.doesNotMatch(js, /\$\('filters'\)\.(innerHTML|children|__html)/);
    assert.match(css, /#facets \{ display: contents; \}/);
    assert.match(css, /main:not\(\.rail\):not\(\.simple\) #facets \{ display: block; columns: auto var\(--facet-w\);/);
    assert.match(css, /#facets > \.card \{ break-inside: avoid;/);
    for (const [n, gaps] of [[2, ''], [3, ' \\* 2'], [4, ' \\* 3']]) {
      assert.match(css, new RegExp(`--filters-w: calc\\(var\\(--facet-w\\) \\* ${n} \\+ var\\(--facet-gap\\)${gaps} \\+`));
    }
  });

  it('keeps the widths sized by hand per band, and gives a column back to its band', () => {
    const c = columns(3440);
    c.keepColumn('list', 700.4);
    c.keepColumn('filters', 900);
    const kept = JSON.parse(c.store.get(c.COLUMNS_KEY));
    assert.deepEqual(kept, { megawide: { list: 700, filters: 900 } });
    c.sizeColumns();
    assert.deepEqual([...c.classes].sort(), ['sized-f', 'sized-l']);
    assert.equal(c.props.get('--user-list-w'), '700px');
    c.sizeColumns(c.keepColumn('list', null));
    assert.deepEqual([...c.classes], ['sized-f']);
    assert.ok(!c.props.has('--user-list-w'));
    // Another band has its own.
    const laptop = columns(1920);
    laptop.store.set(c.COLUMNS_KEY, c.store.get(c.COLUMNS_KEY));
    laptop.sizeColumns();
    assert.deepEqual([...laptop.classes], []);
  });

  it('keeps the thread its least, the filters half the page, the sidebar half the thread\'s column', () => {
    const c = columns(3440, {
      main: 3400, threads: 800, pane: 1600, side: 600,
    });
    assert.equal(c.mostColumn('list'), 800 + 1600 - 440);
    assert.equal(c.mostColumn('filters'), 1700);
    assert.equal(c.mostColumn('side'), 1100);
    assert.equal(c.setColumn('list', 5000), 1960);
    assert.equal(c.setColumn('list', 10), 380);
    assert.equal(c.props.get('--user-list-w'), '380px');
  });

  it('keeps both conversations to a reading width, padded in the middle past it', () => {
    assert.match(css, /:root \{ --read-w: calc\(var\(--spectrum-spacing-100\) \* 130\); \}/);
    // The thread's header, messages, reply box and its rows (draft, commands); the sidebar's.
    const pad = 'padding-left: max\\(var\\(--read-edge\\), calc\\(\\(100% - var\\(--read-w\\)\\) / 2\\)\\);';
    assert.match(css, new RegExp(`:is\\(#pane > \\.ph, #pane \\.feed, #pane \\.composer\\) \\{[^}]*${pad}`));
    assert.match(css, new RegExp(`:is\\(#side \\.sc-body, #side \\.composer\\) \\{[^}]*${pad}`));
    // The draft line and the command cards are rows of the reply box.
    assert.match(js, /DRAFT_LINE = '<div class="draftbar"/);
  });

  it('has a grip on each edge between the columns, which a screen reader can size', () => {
    for (const [id, controls] of [['grip-filters', 'filters'], ['grip-list', 'threads'], ['grip-side', 'side']]) {
      assert.match(PAGES['inbox.html'], new RegExp(`<div class="grip" id="${id}" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="${controls}" aria-label="[^"]+"`));
    }
    assert.match(css, /main\.sized-l, main\.sized-l\.siding \{ grid-template-columns: var\(--nav-w\) minmax\(var\(--list-least\), min\(var\(--user-list-w\), 100% - var\(--nav-w\) - var\(--pane-least\)\)\) 1fr; \}/);
    assert.match(css, /main\.sized-s \{ --side-w: clamp\(calc\(var\(--spectrum-spacing-100\) \* 45\), var\(--user-side-w\), 50%\); \}/);
    // Under 1100px the filters are a drawer: no grips. Folded to the rail, none for them.
    assert.match(css, /\.grip \{ display: none; \}\n@media \(min-width: 1100px\) \{\n {2}\.grip \{ display: block;/);
    assert.match(css, /main\.rail #grip-filters, main:not\(\.siding\) #grip-side/);
  });
});
