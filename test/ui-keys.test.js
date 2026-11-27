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

// Formatting is ui/writing.js, the inbox's and the customer portal's: its global, as the pages
// have it.
// eslint-disable-next-line no-new-func
const { formatText, formatKind } = new Function(`const globalThis = {};\n${SCRIPTS['writing.js']}\nreturn globalThis.Writing;`)();
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

// A few elements, enough for `closest()` with the simple selectors OWN_SPACE is written in: a
// tag, `#id`, `.class`, `[attr]`, `[attr="v"]`, `[attr^="v"]` and `:not(…)` of those.
function matches(node, compound) {
  let rest = compound.trim();
  const tag = /^[a-z][a-z0-9]*/i.exec(rest)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) {
    return false;
  }
  rest = rest.slice(tag?.length || 0);
  while (rest) {
    const not = /^:not\(([^()]+)\)/.exec(rest);
    const id = /^#([\w-]+)/.exec(rest);
    const cls = /^\.([\w-]+)/.exec(rest);
    const attr = /^\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/.exec(rest);
    const [m] = not || id || cls || attr || [];
    assert.ok(m, `selector not understood: ${rest}`);
    const has = (k) => Object.hasOwn(node.attrs, k);
    const ok = (not && !matches(node, not[1]))
      || (id && node.attrs.id === id[1])
      || (cls && String(node.attrs.class || '').split(' ').includes(cls[1]))
      || (attr && has(attr[1]) && (!attr[2]
        || (attr[2] === '=' ? node.attrs[attr[1]] === attr[3] : node.attrs[attr[1]].startsWith(attr[3]))));
    if (!ok) {
      return false;
    }
    rest = rest.slice(m.length);
  }
  return true;
}
function el(tag, attrs = {}, parent = null) {
  return {
    tagName: tag.toUpperCase(),
    attrs,
    parent,
    get id() { return attrs.id || ''; },
    closest(sel) {
      for (let n = this; n; n = n.parent) {
        if (sel.split(',').some((c) => matches(n, c))) {
          return n;
        }
      }
      return null;
    },
  };
}

describe('Space and Esc in the thread', () => {
  const body = el('body');
  const main = el('main', {}, body);
  const pane = el('section', { id: 'pane' }, main);
  const scrolls = [];
  const scroller = {
    clientHeight: 800,
    rects: [1],
    getClientRects() {
      return this.rects;
    },
    scrollBy: (o) => scrolls.push(o),
  };
  pane.querySelector = (sel) => (sel === ':scope > .scroller' ? scroller : null);
  const state = { open: 'thread-1' };
  const globals = {
    state, $: (id) => (id === 'pane' ? pane : null), REDUCED_MOTION: { matches: false }, document: { body },
  };
  const { pageKey, leaveReply } = piece('// What Space presses', 'function reactLast', 'pageKey, leaveReply', globals);
  const press = (target, init = {}) => {
    const e = {
      key: ' ', target, defaultPrevented: false, ...init, preventDefault() { this.defaultPrevented = true; },
    };
    scrolls.length = 0;
    return { took: pageKey(e), prevented: e.defaultPrevented, scrolls: [...scrolls] };
  };

  it('pages down and up through the open thread, a page less a little', () => {
    const msg = el('div', { class: 'msg', tabindex: '-1' }, el('div', { class: 'scroller' }, pane));
    for (const target of [body, msg, el('div', { class: 't' }, el('section', { id: 'threads' }, main))]) {
      assert.deepEqual(press(target), { took: true, prevented: true, scrolls: [{ top: 760, behavior: 'smooth' }] });
      assert.deepEqual(press(target, { shiftKey: true }).scrolls, [{ top: -760, behavior: 'smooth' }]);
    }
    assert.deepEqual(press(body, { repeat: true }).scrolls, [{ top: 760, behavior: 'auto' }]);
  });

  it('leaves Space to what presses, scrolls or types in it', () => {
    const side = el('section', { id: 'side' }, main);
    const targets = [
      el('input'), el('textarea'), el('select'), el('button'), el('a', { href: '/x' }), el('summary'),
      el('img', { class: 'att' }), el('div', { contenteditable: 'true' }), el('span', { role: 'button' }),
      el('a', { role: 'menuitem' }), el('li', { role: 'option' }), el('button', { role: 'radio' }),
      el('b', { tabindex: '0' }), el('div', { popover: '' }), el('ul', { class: 's2-float' }),
      el('p', {}, side), el('span', {}, el('div', { role: 'menuitemradio' }, pane)),
    ];
    for (const target of targets) {
      const none = { took: false, prevented: false, scrolls: [] };
      assert.deepEqual(press(target), none, JSON.stringify(target.attrs));
    }
    // Not on a link without an address, nor on something in focus only as the messages are.
    assert.equal(press(el('a', {}, pane)).took, true);
    assert.equal(press(el('div', { contenteditable: 'false' }, pane)).took, true);
  });

  it('is the browser\'s with a modifier, while composing, taken, or without a thread', () => {
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { isComposing: true }, { defaultPrevented: true }, { key: 'x' }]) {
      assert.equal(press(body, init).took, false, JSON.stringify(init));
    }
    state.open = null;
    assert.equal(press(body).took, false);
    state.open = 'thread-1';
    scroller.rects = [];
    assert.equal(press(body).took, false);
    scroller.rects = [1];
  });

  it('leaves the reply box with Esc, what was typed kept, and keeps the Escape from the browser', () => {
    const reply = {
      id: 'reply', value: 'half a reply', focused: true, blur() { this.focused = false; },
    };
    const escape = (init = {}) => {
      const e = {
        key: 'Escape', target: reply, defaultPrevented: false, ...init, preventDefault() { this.defaultPrevented = true; },
      };
      return { took: leaveReply(e), prevented: e.defaultPrevented };
    };
    assert.deepEqual(escape(), { took: true, prevented: true });
    assert.equal(reply.focused, false);
    assert.equal(reply.value, 'half a reply');
    reply.focused = true;
    // The suggestions, a new thread's box and one being started took it first; an IME has it.
    assert.deepEqual(escape({ defaultPrevented: true }), { took: false, prevented: true });
    assert.equal(escape({ isComposing: true }).took, false);
    assert.equal(escape({ key: 'Enter' }).took, false);
    const side = { id: 'side-reply', blur: () => assert.fail('blurred') };
    assert.equal(escape({ target: side }).took, false);
    assert.equal(reply.focused, true);
  });

  it('lists both in the sheet', () => {
    const html = sheetHtml();
    assert.ok(html.includes(`<kbd>Space</kbd> <kbd>${esc(keyLabel('⇧Space'))}</kbd>`));
    assert.match(html, /Leave the reply box/);
  });
});
