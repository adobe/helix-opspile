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
 * Filters out of view (ui/inbox.js, "filters out of view"): the filter column scrolls without a
 * scrollbar, so a filter set where it does not show is named by a hint at its top or bottom
 * edge, which scrolls to it or clears it, and is its arrow and a count in the rail. The page's
 * own code, in pieces, run in Node with what they need of the rest of the page stubbed.
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

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const cap = (v) => v[0].toUpperCase() + v.slice(1);
const NAMES = { acme: 'ACME', globex: 'Globex' };
const FACETS = [
  { id: 'urgency', title: 'Urgency' },
  { id: 'customer', title: 'Customer', labelFn: (v) => NAMES[v] },
  { id: 'kind', title: 'Kind' },
];
const rowLabel = (f, v) => (f.labelFn && f.labelFn(v)) || v;

/** A hint's boxes, as `$` finds them. */
function boxes() {
  const el = (id) => {
    const classes = new Set();
    let writes = 0;
    return {
      id,
      classes,
      get writes() { return writes; },
      set innerHTML(html) {
        writes += 1;
        this.html = html;
      },
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    };
  };
  return { 'offview-up': el('offview-up'), 'offview-down': el('offview-down') };
}

/** The hints' code, the filter column from `top` to `bottom` on screen, its set rows `rows`. */
function hints(rows, top = 100, bottom = 500) {
  const els = boxes();
  const $ = (id) => {
    if (id === 'filters') {
      return { getBoundingClientRect: () => ({ top, bottom }) };
    }
    if (id === 'facets') {
      return {
        querySelectorAll: (sel) => {
          assert.equal(sel, '.fr[data-v]:is(.on, .off)');
          return rows.map((r) => ({
            dataset: { f: r.f, v: r.v },
            classList: { contains: (c) => c === 'off' && Boolean(r.out) },
            getBoundingClientRect: () => ({ top: r.top, bottom: r.top + 28 }),
          }));
        },
      };
    }
    return els[id];
  };
  const code = piece('function offView(', 'let offViewFrame', 'offView, offViewSay, offViewHtml, syncOffView, offViewLists', {
    FACETS, rowLabel, esc, cap, $,
  });
  return { ...code, els };
}

describe('filters out of view', () => {
  it('counts a row out of view when less than half of it shows', () => {
    const { offView } = hints([]);
    const rows = [
      { top: 60, bottom: 90 }, // above, all of it
      { top: 90, bottom: 120 }, // above by less than half: in view
      { top: 80, bottom: 110 }, // above by more than half
      { top: 480, bottom: 510 }, // below by less than half: in view
      { top: 490, bottom: 520 }, // below by more than half
      { top: 700, bottom: 730 }, // below, all of it
    ];
    const { up, down } = offView(rows, 100, 500);
    assert.deepEqual(up, [rows[0], rows[2]]);
    assert.deepEqual(down, [rows[4], rows[5]]);
  });

  it('names the nearest filter out of view, with its card\'s title, and counts the others', () => {
    const { offViewHtml } = hints([]);
    assert.equal(offViewHtml([], 'down'), '');
    const one = offViewHtml([{ f: 'customer', v: 'acme', out: false }], 'down');
    assert.match(one, /<span class="s2-chevron" aria-hidden="true"><\/span><span class="ov-n" aria-hidden="true">1<\/span>/);
    assert.match(one, /<span class="ov-say" aria-hidden="true"><b>Customer:<\/b> <span class="">ACME<\/span><\/span>/);
    assert.doesNotMatch(one, /ov-more/);
    assert.match(one, /aria-label="1 filter set below, out of view: Customer: ACME\. Show"/);
    assert.match(one, /data-ov-clear title="Clear this filter" aria-label="Clear this filter"/);

    // Above, the nearest is the last of them; an excluded value is struck through, after ≠.
    const three = offViewHtml([
      { f: 'urgency', v: 'high', out: false },
      { f: 'customer', v: 'globex', out: false },
      { f: 'kind', v: 'alert', out: true },
    ], 'up');
    assert.match(three, /<span class="s2-chevron up" aria-hidden="true"><\/span><span class="ov-n" aria-hidden="true">3<\/span>/);
    assert.match(three, /<b>Kind<\/b> ≠ <span class="ov-out">Alert<\/span>/);
    assert.match(three, /<span class="ov-more" aria-hidden="true">\+2<\/span>/);
    assert.match(three, /title="3 filters set above, out of view:\nUrgency: High\nCustomer: Globex\nKind ≠ Alert\nClick to show"/);
    assert.match(three, /title="Clear these 3 filters"/);
  });

  it('keeps a customer\'s name as it is and escapes what it shows', () => {
    const { offViewSay, offViewHtml } = hints([]);
    assert.deepEqual(offViewSay({ f: 'customer', v: 'initech', out: false }), { title: 'Customer', label: 'initech', out: false });
    assert.deepEqual(offViewSay({ f: 'kind', v: 'incident', out: true }), { title: 'Kind', label: 'Incident', out: true });
    assert.match(offViewHtml([{ f: 'customer', v: '<b>&', out: false }], 'down'), /&lt;b&gt;&amp;/);
  });

  it('shows a hint at each edge with filters past it, and writes it only when it changes', () => {
    const rows = [
      { f: 'urgency', v: 'high', top: 20 },
      {
        f: 'kind', v: 'alert', top: 300, out: true,
      },
      { f: 'customer', v: 'acme', top: 800 },
    ];
    const { syncOffView, offViewLists, els } = hints(rows);
    syncOffView();
    const up = els['offview-up'];
    const down = els['offview-down'];
    assert.ok(up.classes.has('on') && down.classes.has('on'));
    assert.match(up.html, /Urgency:<\/b> <span class="">High</);
    assert.match(down.html, /Customer:<\/b> <span class="">ACME</);
    assert.deepEqual(offViewLists.up.map((r) => r.v), ['high']);
    assert.deepEqual(offViewLists.down.map((r) => [r.f, r.v, r.out]), [['customer', 'acme', false]]);
    syncOffView();
    assert.equal(up.writes, 1);
    assert.equal(down.writes, 1);
    // Every row in view: no hint.
    rows[0].top = 200;
    rows[2].top = 400;
    syncOffView();
    assert.ok(!up.classes.has('on') && !down.classes.has('on'));
    assert.equal(up.html, '');
  });

  it('clears what a hint names, picked or excluded, and scrolls to the nearest', () => {
    const state = { sel: { customer: new Set(['acme', 'globex']) }, not: { kind: new Set(['alert']) } };
    const { toggleFilter } = piece('function toggleFilter(', '/** A facet row\'s ≠ button', 'toggleFilter', {
      state, single: () => false,
    });
    for (const r of [{ f: 'customer', v: 'acme', out: false }, { f: 'kind', v: 'alert', out: true }]) {
      toggleFilter(r.f, r.v, r.out);
    }
    assert.deepEqual([...state.sel.customer], ['globex']);
    assert.equal(state.not.kind, undefined);
    // The page: the hint's clear goes through toggleFilter, as above; a click on it scrolls to
    // the row nearest the edge, and on a touch screen slides the rail out first.
    assert.match(js, /for \(const r of list\) toggleFilter\(r\.f, r\.v, r\.out\);\n\s*render\(\);\n\s*toUrl\(\);/);
    assert.match(js, /showFilterRow\(\(dir === 'up' \? list\[list\.length - 1\] : list\[0\]\)\.el\);/);
    assert.match(js, /if \(main\.classList\.contains\('rail'\) && lastPointer !== 'mouse'\) main\.classList\.add\('railopen'\);/);
  });

  it('follows the column as it scrolls, changes size and is drawn again', () => {
    assert.match(PAGES['inbox.html'], /<section id="filters" aria-label="Filters"><div class="offview up" id="offview-up"><\/div><div id="facets"><\/div><div class="offview down" id="offview-down"><\/div><\/section>/);
    assert.match(js, /function filterCards\(\) \{\n {2}syncList\(\);\n {2}offViewSoon\(\);/);
    assert.match(js, /box\.addEventListener\('scroll', offViewSoon, \{ passive: true \}\);/);
    assert.match(js, /new ResizeObserver\(offViewSoon\)\.observe\(\$\('facets'\)\);/);
    assert.match(js, /\n {2}wireOffView\(\);\n/);
  });

  it('hangs the hint off an empty box at each edge, and folds it to its arrow and count in the rail', () => {
    assert.match(css, /\.offview \{ position: sticky; z-index: 2; height: 0px; display: flex; pointer-events: none; \}/);
    assert.match(css, /\.offview\.up \{ top: 0px; align-items: flex-start; margin-bottom: calc\(-1 \* var\(--spectrum-spacing-200\)\); \}/);
    assert.match(css, /\.offview\.down \{ bottom: 0px; align-items: flex-end; margin-top: calc\(-1 \* var\(--spectrum-spacing-200\)\); \}/);
    // The column's gap, which the boxes take back, is the one it has.
    assert.match(css, /#filters \{[^}]*gap: var\(--spectrum-spacing-200\); \}/);
    assert.match(css, /\.offview > button \{ pointer-events: auto;/);
    assert.match(css, /main\.rail \.offview :is\(\.ov-say, \.ov-more\), main\.rail \.offview > \.ov-x \{ display: none; \}/);
    assert.match(css, /main\.rail \.offview \.ov-n \{ display: inline; \}/);
    assert.match(css, /:is\(main\.rail #filters:hover, main\.rail\.railopen #filters, main\.rail #filters:has\(:focus-visible\)\) \.offview :is\(\.ov-say, \.ov-more\) \{ display: inline; \}/);
  });
});
