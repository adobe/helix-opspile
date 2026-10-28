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
function page(answer) {
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
    open: () => null,
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
    Event: function Event(type) { this.type = type; },
    URL,
    setInterval,
    clearInterval,
  };
  vm.runInNewContext(SCRIPTS['app.js'], context);
  return {
    calls, body, listeners, fetch: window.fetch,
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
});
