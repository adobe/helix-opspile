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

/** ui/app.js run against a page at https://pile.example, its fetches answered by `answer`. */
function page(answer, { opened = null, timers = null, storage = null } = {}) {
  const calls = [];
  const body = [];
  const listeners = {};
  const element = () => ({
    setAttribute() {},
    remove() { body.splice(body.indexOf(this), 1); },
    querySelector() { return this.button; },
    set innerHTML(html) {
      this.html = html;
      this.button = {};
    },
    get innerHTML() { return this.html; },
  });
  const window = {
    fetch: async (input, init) => {
      calls.push({ input, init });
      return answer(input, init);
    },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    dispatchEvent: (e) => listeners[e.type]?.(e),
    open: () => opened?.(),
  };
  const context = {
    window,
    navigator: {},
    location: { href: 'https://pile.example/inbox?team=t', origin: 'https://pile.example' },
    document: {
      createElement: element,
      head: { append() {} },
      body: { append: (el) => body.push(el) },
    },
    Request: function Request() {},
    Headers,
    ...(storage ? { localStorage: storage } : {}),
    Event: function Event(type) { this.type = type; },
    URL,
    setInterval: timers?.set || setInterval,
    clearInterval: timers?.clear || clearInterval,
    setTimeout: timers?.timeout || setTimeout,
  };
  vm.runInNewContext(SCRIPTS['app.js'], context);
  return {
    calls, body, listeners, fetch: window.fetch, window,
  };
}

describe('signed out', () => {
  it('says so when Access redirects a fetch of /api to its sign-in page', async () => {
    const p = page(async () => ({ type: 'opaqueredirect', ok: false, status: 0 }));
    await assert.rejects(p.fetch('/api/inbox?team=t'), /Signed out/);
    assert.equal(p.calls[0].init.redirect, 'manual');
    assert.equal(p.body.length, 1);
    assert.match(p.body[0].innerHTML, /Sign in again/);
    // Once, however many fetches fail.
    await assert.rejects(p.fetch('/api/thread?thread=x'), /Signed out/);
    assert.equal(p.body.length, 1);
  });

  it('leaves other answers and other fetches alone', async () => {
    const p = page(async () => ({ type: 'basic', ok: true, status: 200 }));
    assert.equal((await p.fetch('/api/me')).status, 200);
    await p.fetch('https://elsewhere.example/api/x');
    await p.fetch('/sw.js');
    assert.equal(p.calls[0].init.redirect, 'manual');
    assert.equal(p.calls[1].init.redirect, undefined);
    assert.equal(p.calls[2].init.redirect, undefined);
    assert.equal(p.body.length, 0);
  });

  it('goes away, and tells the page, once signed in again', async () => {
    let session = false;
    const p = page(async () => (session ? { type: 'basic', ok: true, status: 200 }
      : { type: 'opaqueredirect', ok: false, status: 0 }));
    let told = 0;
    p.listeners['opspile:signedin'] = () => {
      told += 1;
    };
    await assert.rejects(p.fetch('/api/inbox'));
    session = true;
    await p.listeners.focus();
    assert.equal(p.body.length, 0);
    assert.equal(told, 1);
  });

  it('stops watching its window when another tab signed in meanwhile', async () => {
    let session = false;
    let tick = null;
    let stopped = false;
    const win = {
      closed: false,
      close() {
        this.closed = true;
      },
    };
    const p = page(async () => (session ? { type: 'basic', ok: true, status: 200 }
      : { type: 'opaqueredirect', ok: false, status: 0 }), {
      opened: () => win,
      timers: {
        set: (f) => {
          tick = f;
          return 1;
        },
        clear: () => {
          stopped = true;
        },
      },
    });
    await assert.rejects(p.fetch('/api/inbox'));
    p.body[0].querySelector('button').onclick();
    // The window closes, this tab gets the focus, and it is signed in: the page forgets the window.
    win.closed = true;
    session = true;
    await p.listeners.focus();
    assert.equal(p.body.length, 0);
    // The watch runs on, and has to end without that window.
    await tick();
    assert.equal(stopped, true);
  });
});

describe('D1 busy', () => {
  const busy = { status: 503, ok: false, headers: new Headers({ 'retry-after': '2' }) };
  const fine = { status: 200, ok: true, headers: new Headers() };
  /** A page whose first fetch is answered 503, the next 200; and the waits it made. */
  const once = () => {
    const waits = [];
    let n = 0;
    const p = page(async () => {
      n += 1;
      return n > 1 ? fine : busy;
    }, {
      timers: {
        timeout: (fn, ms) => {
          waits.push(ms);
          fn();
        },
      },
    });
    return { p, waits };
  };

  it('asks a read again once, after Retry-After and a moment at random', async () => {
    const { p, waits } = once();
    assert.equal((await p.fetch('/api/thread?thread=x')).status, 200);
    assert.equal(p.calls.length, 2);
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 2000 && waits[0] < 3000, `waited ${waits[0]} ms`);
  });

  it('gives a second 503 to the caller, and never asks a write again', async () => {
    const p = page(async () => busy, { timers: { timeout: (fn) => fn() } });
    assert.equal((await p.fetch('/api/inbox')).status, 503);
    assert.equal(p.calls.length, 2);
    const w = once();
    assert.equal((await w.p.fetch('/api/post', { method: 'POST', body: '{}' })).status, 503);
    assert.equal(w.p.calls.length, 1);
    assert.deepEqual(w.waits, []);
  });

  it('leaves a 503 without Retry-After alone', async () => {
    const p = page(async () => ({ status: 503, ok: false, headers: new Headers() }));
    assert.equal((await p.fetch('/api/inbox')).status, 503);
    assert.equal(p.calls.length, 1);
  });
});

describe('D1 bookmark', () => {
  const OLD = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
  const NEW = '00000085-0000024d-00000001-0123456789abcdef0123456789abcdef';
  /** localStorage, shared by the pages (tabs) given it. */
  const shared = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  };
  const said = (b) => ({ status: 200, ok: true, headers: new Headers(b ? { 'x-d1-bookmark': b } : {}) });

  it('is sent with every fetch of /api once an answer said one, and only a newer one replaces it', async () => {
    const answers = [said(OLD), said(NEW), said(OLD), said(null)];
    const p = page(async () => answers.shift(), { storage: shared() });
    await p.fetch('/api/me');
    assert.equal(p.calls[0].init.headers, undefined, 'none yet');
    await p.fetch('/api/inbox', { headers: { 'x-opspile-as': '7' } });
    const sent = p.calls[1].init.headers;
    assert.equal(sent.get('x-d1-bookmark'), OLD);
    assert.equal(sent.get('x-opspile-as'), '7', 'the page\'s own headers stay');
    await p.fetch('/api/thread?thread=x');
    await p.fetch('/api/thread?thread=y');
    assert.equal(p.calls[3].init.headers.get('x-d1-bookmark'), NEW, 'an older one does not go back');
    assert.equal(p.window.D1Bookmark.get(), NEW);
  });

  it('is shared by the tabs, and taken from a room\'s event', async () => {
    const storage = shared();
    const a = page(async () => said(OLD), { storage });
    const b = page(async () => said(null), { storage });
    await a.fetch('/api/me');
    await b.fetch('/api/inbox');
    assert.equal(b.calls[0].init.headers.get('x-d1-bookmark'), OLD);
    b.window.D1Bookmark.see(NEW);
    b.window.D1Bookmark.see(undefined);
    b.window.D1Bookmark.see('');
    assert.equal(a.window.D1Bookmark.get(), NEW);
  });

  it('works without storage, and leaves other fetches alone', async () => {
    const p = page(async () => said(OLD));
    await p.fetch('/api/me');
    await p.fetch('/api/me');
    assert.equal(p.calls[1].init.headers.get('x-d1-bookmark'), OLD);
    await p.fetch('https://elsewhere.example/api/x');
    assert.equal(p.calls[2].init.headers, undefined);
  });
});
