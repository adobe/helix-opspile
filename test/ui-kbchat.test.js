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
import { SCRIPTS } from './ui.js';

/** An element as far as ui/kbchat.js uses one: anything it asks for inside is another. */
function element(tag = 'div') {
  const classes = new Set();
  const props = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    hidden: false,
    innerHTML: '',
    value: '',
    dataset: {},
    offsetWidth: 400,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    attrs: {},
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on) => (on ?? !classes.has(c) ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    style: {
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k),
      getPropertyValue: (k) => props.get(k) ?? '',
    },
    setAttribute: (k, v) => { el.attrs[k] = v; },
    addEventListener: () => {},
    append: () => {},
    focus: () => {},
    contains: () => false,
    setPointerCapture: () => {},
    getBoundingClientRect: () => ({}),
    querySelector: () => element(),
    querySelectorAll: () => [],
  };
  return el;
}

/**
 * ui/kbchat.js in Node: `KbChat` on a window `width` wide, with `stored` as what the browser
 * kept, and the motion at once (as where motion is reduced).
 */
function load({ width = 1600, stored = null } = {}) {
  const main = element('main');
  const made = {};
  const store = new Map(stored ? [['opspile.kbchat', stored]] : []);
  const document = {
    querySelector: (s) => (s === 'main' ? main : null),
    createElement: (tag) => {
      const el = element(tag);
      made[tag] = el;
      return el;
    },
    addEventListener: () => {},
    activeElement: null,
  };
  const matchMedia = (q) => {
    const px = Number((q.match(/min-width: (\d+)px/) || [])[1]);
    return { matches: px ? width >= px : /reduced-motion/.test(q), addEventListener: () => {} };
  };
  const localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  const globals = {
    document,
    matchMedia,
    localStorage,
    getComputedStyle: () => ({ getPropertyValue: () => '0' }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    performance: { now: () => 0 },
    fetch: () => new Promise(() => {}),
    // At once: what the tab does after a pull, before the next click.
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    globalThis: {},
  };
  // eslint-disable-next-line no-new-func
  const KbChat = new Function(...Object.keys(globals), `${SCRIPTS['kbchat.js']}\nreturn globalThis.KbChat;`)(
    ...Object.values(globals),
  );
  KbChat.show({
    repo: 'kb-team-a', kind: 'team', slug: 'a', name: 'A', write: true,
  });
  const panel = made.aside;
  const tab = made.button;
  return {
    KbChat,
    main,
    panel,
    tab,
    store,
    open: () => !panel.hidden && main.classList.contains('kbchatting') && !main.classList.contains('kbchat-moving'),
  };
}

/** Pulls the tab `dx` px (right is positive), resting a moment before letting go. */
function pull(tab, dx) {
  const at = (x, t) => ({
    button: 0, pointerId: 1, clientX: x, timeStamp: t,
  });
  tab.onpointerdown(at(1000, 0));
  for (let i = 1; i <= 10; i += 1) {
    tab.onpointermove(at(1000 + (dx * i) / 10, i * 10));
  }
  tab.onpointerup(at(1000 + dx, 500));
}

describe('the knowledge base\'s sidebar (ui/kbchat.js)', () => {
  it('shows by itself where the page is wide enough, unless you closed it there', () => {
    assert.equal(load({ width: 1600 }).open(), true);
    assert.equal(load({ width: 1600, stored: 'closed' }).open(), false);
    // Beside the page, not wide enough: only as you left it.
    assert.equal(load({ width: 1200 }).open(), false);
    assert.equal(load({ width: 1200, stored: 'open' }).open(), true);
    // Over the page: only when you open it.
    assert.equal(load({ width: 1000, stored: 'open' }).open(), false);
  });

  it('settles back open when pulled part of the way in and let go where it stays', () => {
    const { tab, main, open } = load({ width: 1600 });
    assert.equal(open(), true);
    // A quarter of its width in, and let go: it stays open, all of it.
    pull(tab, 100);
    assert.equal(open(), true);
    assert.equal(main.style.getPropertyValue('--kbchat-open'), '');
    assert.equal(tab.attrs['aria-expanded'], 'true');
  });

  it('opens or closes by where a pull lets go, and keeps what you did', () => {
    const {
      tab, open, store,
    } = load({ width: 1600, stored: 'closed' });
    assert.equal(open(), false);
    pull(tab, -300);
    assert.equal(open(), true);
    assert.equal(store.get('opspile.kbchat'), 'open');
    pull(tab, 300);
    assert.equal(open(), false);
    assert.equal(store.get('opspile.kbchat'), 'closed');
    // A click that did not pull opens it again.
    tab.onclick();
    assert.equal(open(), true);
  });
});
