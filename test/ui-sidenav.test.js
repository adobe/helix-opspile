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
import { ACTIVE_DAYS, activeSince } from '../src/listactivity.js';

/** ui/sidenav.js in a sandbox, with a localStorage of its own. */
function load() {
  const kept = new Map();
  const ctx = {
    window: {
      localStorage: {
        getItem: (k) => kept.get(k) ?? null,
        setItem: (k, v) => kept.set(k, String(v)),
      },
    },
    Intl,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPTS['sidenav.js'], ctx);
  return { SideNav: ctx.SideNav, kept };
}

describe('the sidebar of Teams, Customers and Topics', () => {
  it('ranks by activity, then by the latest message, then by name; or by name', () => {
    const { SideNav } = load();
    const list = [
      { name: 'Beta', recent: 2, latest: '2026-01-01' },
      { name: 'alpha', recent: 2, latest: '2026-02-01' },
      { name: 'Gamma', recent: 9 },
      { name: 'Delta', recent: 0 },
      { name: 'Epsilon' },
    ];
    const by = { activity: (x) => x.recent, latest: (x) => x.latest, name: (x) => x.name };
    assert.deepEqual([...SideNav.rank(list, 'activity', by).map((x) => x.name)], ['Gamma', 'alpha', 'Beta', 'Delta', 'Epsilon']);
    assert.deepEqual([...SideNav.rank(list, 'name', by).map((x) => x.name)], ['alpha', 'Beta', 'Delta', 'Epsilon', 'Gamma']);
    assert.equal(list[0].name, 'Beta', 'the list itself stays as it was');
  });

  it('sorts by activity unless asked for names, per list, and remembers it', () => {
    const { SideNav, kept } = load();
    assert.equal(SideNav.sortOf('orgs'), 'activity');
    kept.set('opspile.sidenav', JSON.stringify({ 'sort:orgs': 'name' }));
    assert.equal(SideNav.sortOf('orgs'), 'name');
    assert.equal(SideNav.sortOf('teams'), 'activity');
  });

  it('draws every row on one line: a visual, the name, one number', () => {
    const { SideNav } = load();
    const html = SideNav.row({
      sel: 'acme', on: true, lead: SideNav.tile('acme <b>'), label: 'ACME <Corp>', title: 'ACME · 3 channels', count: 12,
    });
    assert.match(html, /^<button type="button" class="navrow on" data-sel="acme" aria-current="page" title="ACME · 3 channels">/);
    assert.match(html, /<span class="navtile" aria-hidden="true">A<\/span><span class="nm">ACME &lt;Corp&gt;<\/span><span class="n">12<\/span><\/button>$/);
    assert.doesNotMatch(html, /class="sub"/);
    // No number, no column for it.
    assert.doesNotMatch(SideNav.row({ sel: 'x', label: 'X' }), /class="n"/);
    // The footer: the filter on the left, the sort on the right.
    const foot = SideNav.foot('orgs', { filter: { label: 'All types' } });
    assert.ok(foot.indexOf('data-nav-filter') < foot.indexOf('class="fill"'));
    assert.ok(foot.indexOf('class="fill"') < foot.indexOf('data-nav-sort="orgs"'));
    assert.match(foot, /<span>Activity<\/span>/);
  });

  it('opens a group of what waits when asked, or when what is open is in it', () => {
    const { SideNav, kept } = load();
    const args = {
      key: 'orgs:dups', label: 'Likely duplicates', count: 2, body: '<i>rows</i>',
    };
    assert.match(SideNav.group(args), /aria-expanded="false"/);
    assert.doesNotMatch(SideNav.group(args), /<i>rows<\/i>/);
    assert.match(SideNav.group({ ...args, holds: true }), /<i>rows<\/i>/);
    kept.set('opspile.sidenav', JSON.stringify({ 'open:orgs:dups': true }));
    assert.match(SideNav.group(args), /aria-expanded="true"[\s\S]*<span class="navbadge">2<\/span>[\s\S]*<i>rows<\/i>/);
  });

  it('counts the threads active in the last 30 days', () => {
    assert.equal(ACTIVE_DAYS, 30);
    assert.equal(activeSince(Date.parse('2026-03-31T12:00:00.000Z')), '2026-03-01T12:00:00.000Z');
  });
});
