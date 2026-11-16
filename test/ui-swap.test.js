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
import vm from 'node:vm';
import { SCRIPTS } from './ui.js';

// Objects made in the script's context, as this one's.
const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * ui/app.js's Swap, run against a region whose content is set with `show(html, placeholder)`;
 * `fades` are the fades it started.
 */
function page({ reduced = false, visibility = 'visible' } = {}) {
  const observers = [];
  const fades = [];
  const region = {
    children: [],
    get firstElementChild() { return this.children[0] || null; },
    animate(keyframes, timing) {
      const fade = {
        keyframes,
        timing,
        cancelled: false,
        cancel() {
          this.cancelled = true;
        },
      };
      fades.push(fade);
      return fade;
    },
  };
  const env = { reduced, visibility };
  const context = {
    window: { fetch: async () => ({}), addEventListener() {} },
    navigator: {},
    location: { href: 'https://pile.example/inbox', origin: 'https://pile.example' },
    document: {
      createElement: () => ({}),
      head: { append() {} },
      get visibilityState() { return env.visibility; },
    },
    matchMedia: (q) => ({ matches: q.includes('reduced-motion') && env.reduced }),
    getComputedStyle: () => ({
      getPropertyValue: (name) => (name === '--s2-swap-in' ? ' 160ms cubic-bezier(0, 0, 0.4, 1)' : ''),
    }),
    MutationObserver: class {
      constructor(fn) {
        this.fn = fn;
        observers.push(this);
      }

      observe(target, options) {
        this.target = target;
        this.options = options;
      }
    },
  };
  context.window = Object.assign(context.window, context);
  vm.runInNewContext(SCRIPTS['app.js'], context);
  const show = (text, placeholder = false) => {
    region.children = [{ textContent: text, classList: { contains: (c) => placeholder && c === 'empty' } }];
    observers.filter((o) => o.target === region).forEach((o) => o.fn([]));
  };
  return {
    Swap: context.window.Swap, region, fades, show, env, observers,
  };
}

describe('content swaps', () => {
  it('fade in another subject, not the same one again', () => {
    const p = page();
    let subject = 'a';
    p.Swap.watch(p.region, () => subject, {});
    assert.deepEqual(plain(p.observers[0].options), { childList: true });
    p.show('thread a');
    assert.equal(p.fades.length, 0, 'what was there already is the same subject');
    subject = 'b';
    p.show('thread b');
    assert.equal(p.fades.length, 1);
    assert.deepEqual(plain(p.fades[0].keyframes), [{ opacity: 0 }, { opacity: 1 }]);
    assert.deepEqual(plain(p.fades[0].timing), { duration: 160, easing: 'cubic-bezier(0, 0, 0.4, 1)' });
    // A live update of the same thread.
    p.show('thread b, one more message');
    assert.equal(p.fades.length, 1);
  });

  it('shows a placeholder at once, and fades in what replaces it', () => {
    const p = page();
    let subject = 'a';
    p.Swap.watch(p.region, () => subject);
    subject = 'b';
    p.show('Loading…', true);
    assert.equal(p.fades.length, 0);
    p.show('thread b');
    assert.equal(p.fades.length, 1);
  });

  it('stops a fade under way when another subject or a placeholder comes', () => {
    const p = page();
    let subject = 'a';
    p.Swap.watch(p.region, () => subject);
    subject = 'b';
    p.show('thread b');
    subject = 'c';
    p.show('thread c');
    assert.equal(p.fades.length, 2);
    assert.equal(p.fades[0].cancelled, true);
    subject = 'd';
    p.show('Loading…', true);
    assert.equal(p.fades.length, 2);
    assert.equal(p.fades[1].cancelled, true);
  });

  it('does not fade with reduced motion, in a tab in the background, or where told to skip', () => {
    const p = page({ reduced: true });
    let subject = 'a';
    let skip = false;
    p.Swap.watch(p.region, () => subject, { skip: () => skip });
    subject = 'b';
    p.show('b');
    p.env.reduced = false;
    p.env.visibility = 'hidden';
    subject = 'c';
    p.show('c');
    p.env.visibility = 'visible';
    skip = true;
    subject = 'd';
    p.show('d');
    assert.equal(p.fades.length, 0);
    skip = false;
    subject = 'e';
    p.show('e');
    assert.equal(p.fades.length, 1);
  });

  it('watches a region once', () => {
    const p = page();
    p.Swap.watch(p.region, () => 'a');
    p.Swap.watch(p.region, () => 'a');
    assert.equal(p.observers.length, 1);
  });
});
