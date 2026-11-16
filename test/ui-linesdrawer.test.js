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
 * The drawer of the draft's line and the command cards on a phone (ui/inbox.js, `renderLines`):
 * under the reply box only its tab shows, and a tap opens the lines as a sheet over the thread.
 * On a wider screen there is no drawer: the lines are the reply box's own.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

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

const { linesChips, linesTab, linesTitle } = piece('const linesDrawer = { key: null };', '/** The drawer\'s tab and whether it is open', 'linesChips, linesTab, linesTitle', {
  esc, BASH_ICON: '<svg class="i-cmd"/>', DRAFT_ICONS: { draft: '<svg class="i-draft"/>' }, draftBy: (d) => d.by.name,
});

const request = (status) => ({ status });
const draft = { by: { name: 'opspile <agent>' } };
const said = (requests, d) => linesChips(requests, d).map((c) => `${c.kind}: ${c.text}`);

describe('the drawer\'s tab', () => {
  it('says what waits in the drawer: of the commands, what matters most', () => {
    assert.deepEqual(said([request('done'), request('pending'), request('running')], draft), [
      'cmd ask: 1 command to decide', 'draft: Draft by opspile <agent>',
    ]);
    assert.deepEqual(said([request('pending'), request('pending')]), ['cmd ask: 2 commands to decide']);
    assert.deepEqual(said([request('done'), request('running')]), ['cmd: 1 command running']);
    assert.deepEqual(said([request('done'), request('denied'), request('expired')]), ['cmd: 3 past commands']);
    assert.deepEqual(said([request('timeout')]), ['cmd: 1 past command']);
    assert.deepEqual(said([], draft), ['draft: Draft by opspile <agent>']);
    // Nothing in it: no chips, and so no tab.
    assert.deepEqual(said(), []);
    assert.deepEqual(said(undefined, null), []);
  });

  it('is a row of chips, each with its icon, and a chevron', () => {
    const html = linesTab(linesChips([request('pending')], draft));
    assert.match(html, /^<span class="chip cmd ask"><svg class="i-cmd"\/><span>1 command to decide<\/span><\/span><span class="chip draft"><svg class="i-draft"\/><span>Draft by opspile &lt;agent&gt;<\/span><\/span><svg class="chev"/);
  });

  it('names the sheet by what is in it', () => {
    assert.equal(linesTitle(linesChips([request('pending')], draft)), 'Commands and draft');
    assert.equal(linesTitle(linesChips([request('done')])), 'Commands');
    assert.equal(linesTitle(linesChips([], draft)), 'Draft');
  });
});

describe('the drawer', () => {
  it('holds the command cards and the draft\'s line, under a tab, in every reply box', () => {
    const lines = js.match(/const LINES = `([^`]*)`;/)[1];
    assert.match(lines, /^<button type="button" class="linestab" id="linestab" aria-controls="linesdrawer" aria-expanded="false" hidden><\/button>/);
    assert.match(lines, /<div class="linesdrawer" id="linesdrawer"><div class="sheet" tabindex="-1"><div class="lineshead"><b id="lines-title"><\/b><button type="button" class="linesclose" data-lines="close" aria-label="Close" title="Close">✕<\/button><\/div>\$\{BASH_LINE\}\$\{DRAFT_LINE\}<\/div><\/div>$/);
    // Both lines draw the tab again when they change.
    assert.equal(js.match(/\n {2}renderLines\(key\);\n\}/g).length, 2);
  });

  it('is a drawer only on a phone: on a wider screen it is no box, and has no tab', () => {
    assert.match(css, /\n\.linestab, \.lineshead \{ display: none; \}\n\.linesdrawer, \.linesdrawer \.sheet \{ display: contents; \}\n@media \(max-width: 699px\) \{/);
    const phone = css.slice(css.indexOf('.linesdrawer, .linesdrawer .sheet { display: contents; }'));
    const rules = phone.slice(phone.indexOf('@media (max-width: 699px) {'), phone.indexOf('/* A source beside the draft'));
    assert.match(rules, /\.linestab \{ flex-basis: 100%; display: flex;/);
    assert.match(rules, /\.linestab\[hidden\] \{ display: none; \}/);
    // Closed, the lines take no room; open, a sheet at the screen's bottom edge, the rest dimmed.
    assert.match(rules, /\n {2}\.linesdrawer \{ display: none; \}/);
    assert.match(rules, /\.linesdrawer\.open \{ position: fixed; inset: 0; z-index: 9; display: flex; flex-direction: column; justify-content: flex-end; \}/);
    assert.match(rules, /\.linesdrawer \.sheet \{ display: flex; flex-direction: column;[^}]*max-height: 85dvh; overflow: hidden auto;/);
    assert.match(css, /\.spectrum \.linesdrawer\.open \{ background: var\(--spectrum-transparent-black-500\); \}/);
    // Under a toast: Undo of a discarded draft is in one.
    const toast = Number(css.match(/\n\.toast \{[^}]*z-index: (\d+)/)[1]);
    assert.ok(toast > 9);
    // The sheet scrolls, not the cards in it.
    assert.match(rules, /\.linesdrawer \.bashbar \{ flex: none; max-height: none; overflow: visible; \}/);
    assert.match(rules, /\.linesdrawer \.bashbar \.acts \{ position: static; \}/);
  });

  it('marks its tab as a command\'s card is marked, while one waits for a decision', () => {
    assert.match(css, /\.spectrum \.linestab:has\(\.chip\.ask\) \{\s+border: var\(--spectrum-border-width-100\) dashed var\(--spectrum-notice-visual-color\);/);
  });

  it('closes for another thread, for nothing left in it, and stays as it is while the thread is fetched', () => {
    const render = js.slice(js.indexOf('function renderLines(key)'), js.indexOf('/** Opens or closes the drawer'));
    assert.match(render, /if \(!tab \|\| !el \|\| !hit \|\| state\.open !== key\) return;/);
    assert.match(render, /if \(linesDrawer\.key !== key \|\| !chips\.length\) linesDrawer\.key = null;/);
    // From what the thread has, not from what the lines happen to show: a draft on its way is
    // not on its line, and so not in the tab.
    assert.match(render, /linesChips\(hit\.data\?\.bash_requests, lineDraft\(key\)\)/);
    // A modal dialog only while it is open.
    assert.match(render, /const dialog = \{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lines-title' \};/);
    assert.match(render, /if \(open\) sheet\.setAttribute\(name, value\); else sheet\.removeAttribute\(name\);/);
    // A screen that grows past the phone's breakpoint has no drawer left to be open.
    assert.match(js, /const LINES_DRAWER = matchMedia\('\(max-width: 699px\)'\);\nLINES_DRAWER\.addEventListener\('change', \(\) => \{ if \(!LINES_DRAWER\.matches && linesDrawer\.key\) setLines\(linesDrawer\.key, false\); \}\);/);
  });

  it('opens on its tab, and closes on ✕, a tap beside the sheet, Escape, and the draft going to the thread', () => {
    const document = { activeElement: null };
    const { wireLines } = piece('function wireLines(tab, el)', '// Sending, as in iMessage', 'wireLines', {
      linesDrawer: { key: 'k' },
      setLines: (...args) => wireLines.calls.push(args),
      document,
    });
    wireLines.calls = [];
    const on = {};
    const listen = (name) => ({
      addEventListener: (type, f) => {
        on[`${name}.${type}`] = f;
      },
    });
    // What Tab stops at in the sheet: a hidden line's button and a disabled one are left out.
    const focused = [];
    const stop = (name, more = {}) => ({
      name, offsetParent: {}, focus: () => focused.push(name), ...more,
    });
    const stops = [stop('close'), stop('hidden', { offsetParent: null }), stop('field'),
      stop('busy', { disabled: true }), stop('send')];
    const asked = [];
    const el = {
      ...listen('sheet'),
      __key: 'k',
      querySelectorAll: (selector) => {
        asked.push(selector);
        return stops;
      },
    };
    wireLines(listen('tab'), el);
    assert.deepEqual(Object.keys(on).sort(), ['sheet.click', 'sheet.keydown', 'tab.click']);
    const target = (matches) => ({ closest: (sel) => (sel.includes(matches) ? {} : null) });

    // The tab closes an open drawer (and opens a closed one).
    on['tab.click']();
    assert.deepEqual(wireLines.calls.pop(), ['k', false]);
    // Beside the sheet, and ✕: closed, with the focus back on the tab.
    on['sheet.click']({ target: el });
    assert.deepEqual(wireLines.calls.pop(), ['k', false, { back: true }]);
    on['sheet.click']({ target: target('[data-lines="close"]') });
    assert.deepEqual(wireLines.calls.pop(), ['k', false, { back: true }]);
    // Edit and the sends: closed, the focus where the action put it.
    for (const act of ['edit', 'me', 'bot']) {
      on['sheet.click']({ target: target(`[data-draft="${act}"]`) });
      assert.deepEqual(wireLines.calls.pop(), ['k', false], act);
    }
    // Anything else in the sheet leaves it open: Run, Deny, View draft, Discard.
    on['sheet.click']({ target: target('[data-bash="run"]') });
    assert.equal(wireLines.calls.length, 0);
    // Tab goes round in the open sheet, not on into the thread behind it.
    const tab = (at, shiftKey = false) => {
      document.activeElement = stops.find((x) => x.name === at) || {};
      let stayed = false;
      on['sheet.keydown']({
        key: 'Tab',
        shiftKey,
        preventDefault: () => {
          stayed = true;
        },
      });
      return stayed ? focused.pop() : 'on';
    };
    assert.equal(tab('send'), 'close');
    // Everything Tab can land on, a person's chip (`tabindex="0"`) too; not the sheet itself.
    assert.deepEqual(asked, ['button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])']);
    assert.equal(tab('field'), 'on');
    assert.equal(tab('close', true), 'send');
    assert.equal(tab('field', true), 'on');
    // From the sheet itself, which has the focus as it opens: back to its last stop.
    assert.equal(tab('the sheet', true), 'send');
    assert.equal(tab('the sheet'), 'on');
    // Escape, unless the draft's line took it for what it had open.
    on['sheet.keydown']({ key: 'Escape', defaultPrevented: true, preventDefault: () => {} });
    on['sheet.keydown']({ key: 'Enter', defaultPrevented: false, preventDefault: () => {} });
    assert.equal(wireLines.calls.length, 0);
    on['sheet.keydown']({ key: 'Escape', defaultPrevented: false, preventDefault: () => {} });
    assert.deepEqual(wireLines.calls.pop(), ['k', false, { back: true }]);
  });
});
