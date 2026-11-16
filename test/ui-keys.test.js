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
 * The inbox's keyboard (ui/inbox.js, "keyboard"): Slack's shortcuts where the inbox has the
 * same thing. Formatting in a text box writes markdown as Slack's ⌘B and the like do, and takes
 * it off again; the sheet names the keys as the computer's keyboard does.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PAGES, SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];

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

const { formatText, formatKind } = piece('function formatText(', '/** The text boxes formatting works in', 'formatText, formatKind');
const { keyLabel, SHORTCUTS, sheetHtml } = piece('const MAC =', '/** The sheet of every shortcut', 'keyLabel, SHORTCUTS, sheetHtml', { esc });

/** `text` with `[` `]` around the selection, formatted as `kind`, the selection marked again. */
function fmt(text, kind) {
  const start = text.indexOf('[');
  const end = text.indexOf(']') - 1;
  const value = text.replace('[', '').replace(']', '');
  const r = formatText(value, start, end, kind);
  const out = value.slice(0, r.from) + r.insert + value.slice(r.to);
  return `${out.slice(0, r.start)}[${out.slice(r.start, r.end)}]${out.slice(r.end)}`;
}

describe('formatting in a text box', () => {
  it('wraps the words, and unwraps them again', () => {
    assert.equal(fmt('say [hello] now', 'bold'), 'say **[hello]** now');
    assert.equal(fmt('say **[hello]** now', 'bold'), 'say [hello] now');
    assert.equal(fmt('say [**hello**] now', 'bold'), 'say [hello] now');
    assert.equal(fmt('a [b] c', 'italic'), 'a _[b]_ c');
    assert.equal(fmt('a [b] c', 'strike'), 'a ~~[b]~~ c');
    assert.equal(fmt('run [npm ci]', 'code'), 'run `[npm ci]`');
  });

  it('keeps spaces at the ends outside the marks, and marks the caret in place', () => {
    assert.equal(fmt('say[ hello ]now', 'bold'), 'say **[hello]** now');
    assert.equal(fmt('x []', 'bold'), 'x **[]**');
  });

  it('makes a link of words or of a URL', () => {
    assert.equal(fmt('see [the docs]', 'link'), 'see [the docs]([])');
    assert.equal(fmt('see [https://example.com/x]', 'link'), 'see [[]](https://example.com/x)');
    assert.equal(fmt('[]', 'link'), '[[]]()');
  });

  it('puts a code block on lines of its own', () => {
    assert.equal(fmt('try [a = 1] now', 'block'), 'try \n```\n[a = 1]\n```\n now');
    assert.equal(fmt('[x\ny]', 'block'), '```\n[x\ny]\n```');
  });

  it('starts lines as a quote or a list, and stops again', () => {
    assert.equal(fmt('[one\ntwo]', 'bullet'), '[- one\n- two]');
    assert.equal(fmt('[- one\n- two]', 'bullet'), '[one\ntwo]');
    assert.equal(fmt('[- one\n\n- two]', 'number'), '[1. one\n\n2. two]');
    assert.equal(fmt('[one\ntwo]', 'quote'), '[> one\n> two]');
    assert.equal(fmt('first\nsec[]ond', 'quote'), 'first\n> sec[]ond');
    assert.equal(fmt('[]', 'number'), '1. []');
  });

  it('knows Slack\'s keys, by the layout\'s letters and the keyboard\'s digits', () => {
    const key = (k, code, mods = {}) => formatKind({
      key: k, code, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...mods,
    });
    assert.equal(key('b', 'KeyB'), 'bold');
    assert.equal(key('i', 'KeyI'), 'italic');
    assert.equal(key('X', 'KeyX', { shiftKey: true }), 'strike');
    assert.equal(key('C', 'KeyC', { shiftKey: true }), 'code');
    assert.equal(key('Ç', 'KeyC', { shiftKey: true, altKey: true }), 'block');
    assert.equal(key('U', 'KeyU', { shiftKey: true }), 'link');
    assert.equal(key('(', 'Digit9', { shiftKey: true }), 'quote');
    assert.equal(key('*', 'Digit8', { shiftKey: true }), 'bullet');
    assert.equal(key('&', 'Digit7', { shiftKey: true }), 'number');
    assert.equal(key('b', 'KeyB', { metaKey: false, ctrlKey: true }), 'bold');
    // Off a Mac, Ctrl+Shift+7…9 are lists and quote in a text box, not the views (globalKey).
    assert.equal(key('&', 'Digit7', { metaKey: false, ctrlKey: true, shiftKey: true }), 'number');
    assert.match(js, /e\.shiftKey !== MAC && !\(writable\(e\.target\) && formatKind\(e\)\)/);
    assert.equal(key('s', 'KeyS'), null);
    assert.equal(key('b', 'KeyB', { metaKey: false }), null);
  });
});

describe('the shortcut sheet', () => {
  it('names the keys as a Mac or another computer does', () => {
    assert.equal(keyLabel('⌘⇧K', true), '⌘⇧K');
    assert.equal(keyLabel('⌘⇧K', false), 'Ctrl+Shift+K');
    assert.equal(keyLabel('⌥↓', false), 'Alt+↓');
    assert.equal(keyLabel('⇧', false), 'Shift');
    assert.equal(keyLabel('j', false), 'j');
  });

  it('lists Slack\'s shortcuts beside the inbox\'s own', () => {
    const html = sheetHtml();
    for (const k of ['/', '⌘K', 'j', '⌥⇧↓', '⌘/', '⌘⇧A', '⌘⇧K', '⌘.', '⌘B', '⌘⇧X', '⌘⇧7', 'e', 'a', '⇧Esc', '⌘F6', '⌘↑', 'r', 'Esc']) {
      assert.ok(html.includes(`<kbd>${esc(keyLabel(k))}</kbd>`), k);
    }
    assert.ok(SHORTCUTS.every(([, rows]) => rows.every(([what, ...ways]) => what && ways.length)));
  });

  it('opens from your menu', () => {
    assert.match(PAGES['inbox.html'], /id="keysAll"/);
  });
});
