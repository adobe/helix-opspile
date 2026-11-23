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
 * The inbox's favicons (ui/inbox.js, `favImg`, `keepFavicons`, `wireFavicons`): one address
 * per domain on the inbox's own origin (GET /api/favicon, src/favicons.js), drawn at once, kept
 * through a re-render (no flash on a click), and one that does not load gives way to its
 * stand-in, then and on every re-render for a while, instead of staying a broken image.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** Just enough of the DOM: elements with attributes and children, and fragments. */
class Node {
  constructor(attrs = {}, { complete = false, naturalWidth = 0 } = {}) {
    this.attrs = new Map(Object.entries(attrs));
    this.children = [];
    this.parentNode = null;
    Object.assign(this, { complete, naturalWidth });
  }

  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }

  get dataset() { return { fb: this.attrs.get('data-fb') }; }

  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }

  hasAttribute(n) { return this.attrs.has(n); }

  setAttribute(n, v) { this.attrs.set(n, String(v)); }

  removeAttribute(n) { this.attrs.delete(n); }

  matches(sel) { return !this.html && sel === 'img[data-fav]' && this.attrs.has('data-fav'); }

  append(...nodes) {
    for (const n of nodes) {
      if (n.parentNode) {
        n.parentNode.children.splice(n.parentNode.children.indexOf(n), 1);
      }
      n.parentNode = this;
      this.children.push(n);
    }
    return this;
  }

  replaceWith(x) {
    const p = this.parentNode;
    const nodes = x instanceof Node ? [x] : x.children;
    for (const n of nodes) {
      if (n.parentNode) {
        n.parentNode.children.splice(n.parentNode.children.indexOf(n), 1);
      }
      n.parentNode = p;
    }
    p.children.splice(p.children.indexOf(this), 1, ...nodes);
    this.parentNode = null;
  }

  querySelectorAll(sel) {
    return this.children.flatMap((c) => [
      ...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel),
    ]);
  }
}
/** A stand-in, as `createContextualFragment` makes it: its HTML, as one node. */
const stand = (html) => Object.assign(new Node(), { html });

function load() {
  const listeners = [];
  const document = {
    createRange: () => ({
      createContextualFragment: (html) => ({ children: html ? [stand(html)] : [] }),
    }),
  };
  // eslint-disable-next-line no-new-func
  const api = new Function('esc', 'document', 'addEventListener', `${js.slice(js.indexOf('const favicon = (domain)'), js.indexOf('/** `el.innerHTML = html`, keeping'))}
    return { favicon, favImg, keepFavicons, wireFavicons };`)(esc, document, (type, fn, capture) => listeners.push({ type, fn, capture }));
  return { ...api, listeners };
}
const img = (src, attrs = {}, state = {}) => new Node({
  src, alt: '', 'data-fav': '', ...attrs,
}, state);

describe('the inbox\'s favicons', () => {
  it('come from the Worker, one address per domain, and are not lazy', () => {
    const { favicon, favImg } = load();
    assert.equal(favicon('acme.example'), '/api/favicon?domain=acme.example');
    assert.equal(favicon('https://cdn.example/logo.png'), 'https://cdn.example/logo.png');
    assert.equal(favImg('acme.example', { cls: 'ico', title: 'a&b' }), '<img class="ico" src="/api/favicon?domain=acme.example" alt="" title="a&amp;b" data-fav>');
    assert.equal(favImg(null, { fallback: '<span></span>' }), '<span></span>');
    assert.equal(favImg('acme.example', { fallback: '<span class="fav"></span>' }), '<img src="/api/favicon?domain=acme.example" alt="" data-fav data-fb="&lt;span class=&quot;fav&quot;&gt;&lt;/span&gt;">');
    // Not Google's address (a redirect to another host each time) and not lazy, anywhere.
    for (const page of ['inbox.js', 'admin.js']) {
      assert.doesNotMatch(SCRIPTS[page], /google\.com\/s2|gstatic/, page);
    }
    assert.doesNotMatch(js.slice(js.indexOf('function favImg'), js.indexOf('// A favicon that failed')), /lazy/);
    // Every favicon of the page is drawn by favImg.
    assert.equal([...js.matchAll(/[^.\w`]favicon\(/g)].length, 1);
  });

  it('keep their image through a re-render, also with new attributes', () => {
    const { keepFavicons } = load();
    const loaded = img('/api/favicon?domain=acme.example', { title: 'old', class: 'ico' }, { complete: true, naturalWidth: 64 });
    const other = img('/api/favicon?domain=globex.example', {}, { complete: true, naturalWidth: 64 });
    const prev = new Node().append(new Node().append(loaded), other);
    const fresh = img('/api/favicon?domain=acme.example', { title: 'new' });
    const another = img('/api/favicon?domain=initech.example');
    const next = new Node().append(fresh, another);
    keepFavicons(prev, next);
    assert.equal(next.children[0], loaded, 'the loaded image moved over');
    assert.equal(loaded.getAttribute('title'), 'new');
    assert.equal(loaded.hasAttribute('class'), false, 'and lost what the new one does not have');
    assert.equal(next.children[1], another, 'another domain is drawn anew');
    // Several of the same: as many are kept as there were.
    const a = img('/api/favicon?domain=acme.example', {}, { complete: true, naturalWidth: 64 });
    const two = new Node().append(img('/api/favicon?domain=acme.example'), img('/api/favicon?domain=acme.example'));
    keepFavicons([new Node().append(a)], [two]);
    assert.equal(two.children.filter((c) => c === a).length, 1);
  });

  it('give way to their stand-in when they do not load, and stay so for a while', () => {
    const {
      favImg, keepFavicons, wireFavicons, listeners,
    } = load();
    wireFavicons();
    const [{ type, fn, capture }] = listeners; // eslint-disable-line object-curly-newline
    assert.deepEqual([type, capture], ['error', true]);
    const box = new Node();
    const broken = img('/api/favicon?domain=globex.example', { 'data-fb': '<span></span>' });
    box.append(broken);
    fn({ target: broken });
    assert.deepEqual(box.children.map((c) => c.html), ['<span></span>']);
    // Drawn again, it is its stand-in at once, not a broken image.
    assert.equal(favImg('globex.example', { fallback: '<span></span>' }), '<span></span>');
    assert.equal(favImg('globex.example'), '');
    // Other images are not its business.
    const emoji = new Node({ src: 'x' });
    box.append(emoji);
    fn({ target: emoji });
    assert.ok(box.children.includes(emoji));

    // One that failed out of the page (no error event reached it) is found broken when its
    // place is drawn again.
    const out = img('/api/favicon?domain=initech.example', {}, { complete: true, naturalWidth: 0 });
    const next = new Node().append(img('/api/favicon?domain=initech.example', { 'data-fb': '<i></i>' }));
    keepFavicons(new Node().append(out), next);
    assert.deepEqual(next.children.map((c) => c.html), ['<i></i>']);
    assert.equal(favImg('initech.example'), '');
    // A row back in the page mends its own.
    const row = new Node().append(img('/api/favicon?domain=umbrella.example', { 'data-fb': '<b></b>' }, { complete: true }));
    keepFavicons(null, row);
    assert.deepEqual(row.children.map((c) => c.html), ['<b></b>']);
  });
});
