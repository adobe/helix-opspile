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

const ORIGIN = 'https://pile.example';

/** ui/header.js on a page at `path`, with a browser tab's sessionStorage and history. */
function tab(path, storage = new Map()) {
  const location = new URL(path, ORIGIN);
  const element = () => ({
    dataset: {},
    hidden: true,
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const go = (url) => {
    const u = new URL(url, location.href);
    location.href = u.href;
  };
  const listeners = {};
  const context = {
    window: {},
    location,
    URL,
    history: { pushState: (s, t, url) => go(url), replaceState: (s, t, url) => go(url) },
    sessionStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    matchMedia: () => ({ matches: false }),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    document: {
      getElementById: element,
      querySelector: element,
      querySelectorAll: () => [],
    },
  };
  vm.runInNewContext(SCRIPTS['header.js'], context);
  return {
    Header: context.window.Header, history: context.history, storage, location,
  };
}

describe('the header', () => {
  it('knows which page an address is, on this origin only', () => {
    const { Header } = tab('/inbox');
    assert.equal(Header.pageOf('/inbox?team=t'), 'inbox');
    assert.equal(Header.pageOf('/inbox/kb?repo=r'), 'agents');
    assert.equal(Header.pageOf('/inbox/admin'), 'teams');
    assert.equal(Header.pageOf('/inbox/admin?tab=orgs&org=o'), 'orgs');
    assert.equal(Header.pageOf('/inbox/admin?tab=requests'), 'requests');
    assert.equal(Header.pageOf('/inbox/admin?tab=nope'), 'teams');
    assert.equal(Header.pageOf('https://elsewhere.example/inbox'), null);
    assert.equal(Header.pageOf('/api/me'), null);
  });

  it('opens every page as it was left in the tab', () => {
    const { Header, history, storage } = tab('/inbox?team=t&filters=1&f.type=conversation');
    assert.equal(Header.href('inbox'), '/inbox?team=t&filters=1&f.type=conversation');
    // Changing the address (filters, the open thread) keeps it.
    history.replaceState(null, '', '/inbox?team=t&filters=1&f.type=conversation&t=th1');
    // Off to Teams, a team picked there, then Orgs.
    const admin = tab('/inbox/admin?tab=teams', storage);
    admin.history.replaceState(null, '', '/inbox/admin?tab=teams&team=edge');
    admin.history.pushState(null, '', '/inbox/admin?tab=orgs&org=acme');
    assert.equal(admin.Header.href('inbox'), '/inbox?team=t&filters=1&f.type=conversation&t=th1');
    assert.equal(admin.Header.href('teams'), '/inbox/admin?tab=teams&team=edge');
    assert.equal(admin.Header.href('orgs'), '/inbox/admin?tab=orgs&org=acme');
    // Never opened: where it starts.
    assert.equal(admin.Header.href('requests'), '/inbox/admin?tab=requests');
    assert.equal(admin.Header.href('agents'), '/inbox/kb');
    // Back in the inbox, as it was.
    assert.equal(tab('/inbox/kb', storage).Header.href('inbox'), '/inbox?team=t&filters=1&f.type=conversation&t=th1');
  });

  it('asks the page where a page opens that was not opened yet', () => {
    const { Header } = tab('/inbox?team=t');
    Header.init({ admin: true }, { count: false, fallback: { agents: () => '/inbox/kb?org=acme' } });
    assert.equal(Header.href('agents'), '/inbox/kb?org=acme');
    Header.remember('/inbox/kb?repo=r');
    assert.equal(Header.href('agents'), '/inbox/kb?repo=r');
  });

  it('opens a page where the page on screen sends it, before where it was left', () => {
    const { Header } = tab('/inbox?team=t');
    let customer = 'acme';
    Header.init({ admin: true }, {
      count: false,
      prefer: { agents: () => (customer ? `/inbox/kb?org=${customer}` : null) },
    });
    Header.remember('/inbox/kb?repo=r');
    assert.equal(Header.href('agents'), '/inbox/kb?org=acme');
    customer = null;
    assert.equal(Header.href('agents'), '/inbox/kb?repo=r');
  });

  it('keeps nothing from another origin or another path', () => {
    const { Header, storage } = tab('/inbox');
    storage.clear();
    Header.remember('https://elsewhere.example/inbox?team=x');
    Header.remember('/api/inbox');
    assert.equal(storage.size, 0);
  });
});
