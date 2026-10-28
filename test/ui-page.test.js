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
import { transform } from 'esbuild';
import { bellKey as serverBellKey, withDefaults } from '../src/settings.js';
import { PAGES, SCRIPTS } from './ui.js';

const html = SCRIPTS['inbox.js'];

/** A piece of the page's script, from the line starting with `from` up to `to`, run in Node. */
function piece(from, to, expose, globals = {}) {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${html.slice(a, b)}\nreturn { ${expose} };`)(
    ...Object.values(globals),
  );
}

describe('inbox page', () => {
  it('is a valid module script', async () => {
    await transform(html, { loader: 'js', format: 'esm' });
  });

  it('formats times and days as toLocale*String did', () => {
    const { ago, clock, dayLabel } = piece('// Dates and times', 'const platform', 'ago, clock, dayLabel');
    for (const iso of ['2024-03-01T07:05:00Z', '2023-12-31T23:59:00Z', '2024-06-15T13:30:00Z']) {
      const d = new Date(iso);
      assert.equal(clock(iso), d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
      assert.equal(dayLabel(iso), d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
      assert.equal(ago(iso), d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
    }
    assert.equal(dayLabel(new Date().toISOString()), 'Today');
    assert.equal(dayLabel(new Date(Date.now() - 86400000).toISOString()), 'Yesterday');
    assert.equal(ago(new Date(Date.now() - 2 * 3600000).toISOString()), '2h');
    assert.equal(clock('not a date'), 'Invalid Date');
    assert.equal(dayLabel(undefined), 'Invalid Date');
    assert.equal(ago(null), '');
  });

  it('renders each message text once per set of names', () => {
    const calls = [];
    const Markdown = {
      mentionPattern: (names) => (names.length ? new RegExp(names.join('|'), 'g') : null),
      render: (src, { mentions }) => {
        calls.push(src);
        return `<p>${src}${mentions ? ` [${mentions.source}]` : ''}</p>`;
      },
    };
    const { md, setMentionNames } = piece('let mentionNames = null;', '// ----', 'md, setMentionNames', {
      Markdown, emojiByName: () => undefined, location: {},
    });
    setMentionNames(['Ada']);
    assert.equal(md('hi @Ada'), '<p>hi @Ada [Ada]</p>');
    assert.equal(md('hi @Ada'), '<p>hi @Ada [Ada]</p>');
    assert.deepEqual(calls, ['hi @Ada']);
    // Other names (another thread) may mark other mentions: rendered again.
    setMentionNames(['Ada', 'Bo']);
    assert.equal(md('hi @Ada'), '<p>hi @Ada [Ada|Bo]</p>');
    setMentionNames(['Ada']);
    md('hi @Ada');
    assert.equal(calls.length, 2);
  });

  it('tells the filter drawer\'s swipes from scrolling, and where they leave it', () => {
    const { drawerOpens, drawerSwipe } = piece('const DRAWER', 'function wireDrawerSwipes', 'drawerOpens, drawerSwipe', {
      matchMedia: () => ({ matches: true }),
    });
    // Sideways towards where the drawer goes: right while shut, left while open.
    assert.equal(drawerSwipe(40, 5, false), true);
    assert.equal(drawerSwipe(-40, 5, false), false);
    assert.equal(drawerSwipe(-40, 5, true), true);
    assert.equal(drawerSwipe(40, 5, true), false);
    // More down than sideways: the list or the drawer scrolls.
    assert.equal(drawerSwipe(20, 30, false), false);
    assert.equal(drawerSwipe(-20, 30, true), false);
    // A flick goes its way; a slow drag to the nearer end.
    assert.equal(drawerOpens(0.2, 0.8), true);
    assert.equal(drawerOpens(0.9, -0.8), false);
    assert.equal(drawerOpens(0.6, 0.1), true);
    assert.equal(drawerOpens(0.4, -0.1), false);
  });

  it('opens the personal view unless the address names a team', () => {
    const { personalAsked } = piece('const personalAsked', 'function fromUrl', 'personalAsked');
    const asks = (search) => personalAsked(new URLSearchParams(search));
    for (const search of ['', '?view=personal', '?sort=personal', '?sort=recent', '?connected=slack', '?t=slack:E1:C1:1.1']) {
      assert.equal(asks(search), true, search);
    }
    // Team links and bookmarks keep their team; an explicit personal view wins over one.
    assert.equal(asks('?team=helix&filters=1'), false);
    assert.equal(asks('?team=helix&view=personal'), true);
  });

  it('shows only the viewer\'s own messages (and those being sent) as theirs', () => {
    const { message } = piece('const continues', '// ---------------------------------------------------------------- the thread agent', 'message', {
      dayLabel: () => 'Today',
      profileKey: () => 'k',
      avatar: () => '',
      esc: (x) => String(x ?? ''),
      clock: () => '10:00',
      md: (x) => x,
      canReact: () => false,
      canEdit: () => false,
      state: {},
      QUICK: [],
      emoji: (x) => x,
      SIGNAL_HINT: {},
      favicon: (x) => x,
      sendState: () => '',
    });
    const classes = (m) => /class="([^"]*)"/.exec(message({
      thread: 't', id: '1', at: '2026-10-21T10:00:00Z', body: 'hi', ...m,
    }, null, false))[1].split(/\s+/).filter(Boolean);
    const staff = { name: 'Ada', kind: 'person', staff: true };
    assert.deepEqual(classes({ author: staff, mine: true }), ['msg', 'adobe', 'mine']);
    assert.deepEqual(classes({ author: staff, pending: true }), ['msg', 'adobe', 'mine', 'pending']);
    // A colleague: on Adobe's side, but not blue.
    assert.deepEqual(classes({ author: { ...staff, name: 'Bo' }, mine: false }), ['msg', 'adobe']);
    assert.deepEqual(classes({ author: { name: 'Cy', kind: 'person', staff: false } }), ['msg']);
  });

  it('offers ✎ on messages you may edit, and turns the bubble into the editor', () => {
    const state = { editing: null };
    const { message } = piece('const continues', '// ---------------------------------------------------------------- the thread agent', 'message', {
      dayLabel: () => 'Today',
      profileKey: () => 'k',
      avatar: () => '',
      esc: (x) => String(x ?? ''),
      clock: () => '10:00',
      md: (x) => x,
      canReact: () => true,
      canEdit: (m) => Boolean(m.editable),
      state,
      QUICK: ['eyes'],
      emoji: (x) => x,
      SIGNAL_HINT: {},
      favicon: (x) => x,
    });
    const staff = { name: 'Ada', kind: 'person', staff: true };
    const m = {
      thread: 't', id: '1', at: '2026-10-21T10:00:00Z', body: 'hi', author: staff, mine: true,
    };
    assert.doesNotMatch(message(m, null, false), /data-edit=/);
    assert.match(message({ ...m, editable: 'user' }, null, false), /data-edit="1"[^>]*title="Edit your message"/);
    assert.match(message({ ...m, editable: 'app' }, null, false), /title="Edit, as the opspile app"/);
    // Edited on the platform, or here: "(edited)" under it.
    assert.match(message({ ...m, editedAt: '2026-10-21T10:05:00Z' }, null, false), /class="meta"[^>]*>\(edited\)</);
    state.editing = { id: 't|1' };
    const open = message({ ...m, editable: 'user' }, null, false);
    assert.match(open, /class="msg [^"]*editing/);
    assert.match(open, /<textarea class="editbox"/);
    // While editing: no reactions, no second ✎, and not the old text (the editor gets it).
    assert.doesNotMatch(open, /data-pick=|data-edit="1"|>hi</);
  });

  it('fills the sending bar towards 90%, then completes it and fades it out', () => {
    const { sendBar, sendState } = piece('// Sending, as in iMessage', 'const REDUCED_MOTION', 'sendBar, sendState', {
      esc: (x) => String(x ?? ''),
    });
    // Waiting for the replies before it: a sliver.
    assert.deepEqual(sendBar({}, 5000), { fill: 0.08, opacity: 1, over: false });
    const p = { startedAt: 1000 };
    const fills = [1000, 1500, 2000, 3000, 10000, 60000].map((t) => sendBar(p, t).fill);
    assert.equal(fills[0], 0.08);
    for (let i = 1; i < fills.length; i += 1) {
      assert.ok(fills[i] > fills[i - 1], `${fills}`);
    }
    // About two thirds at a typical send (0.9 s), and never full until the platform has it.
    assert.ok(sendBar(p, 1900).fill > 0.55 && sendBar(p, 1900).fill < 0.7);
    assert.ok(fills[5] < 0.9 + 1e-9);
    // Through after 900 ms: full 250 ms later, then fading for 300 ms, then gone.
    const done = { startedAt: 1000, doneAt: 1900 };
    assert.equal(sendBar(done, 1900).fill.toFixed(4), sendBar(p, 1900).fill.toFixed(4));
    assert.equal(sendBar(done, 2150).fill, 1);
    assert.equal(sendBar(done, 2150).opacity, 1);
    assert.ok(sendBar(done, 2300).opacity > 0 && sendBar(done, 2300).opacity < 1);
    assert.equal(sendBar(done, 2450).over, true);
    // The same markup while it fills and completes; a reason and Retry once it failed.
    assert.equal(sendState({ id: 'x', status: 'sending' }), sendState({ id: 'x', status: 'sent' }));
    assert.match(sendState({ id: 'x', status: 'sending' }), /role="progressbar"/);
    assert.match(sendState({ id: 'x', status: 'failed', error: 'Slack: is_archived' }), /Not sent: Slack: is_archived[\s\S]*data-retry="x"/);
    assert.equal(sendState({ id: 'x', status: 'delivered' }), '');
  });

  it('tells bells apart as the server does, whatever order the filters come in', () => {
    const { bellKey } = piece('// As src/settings.js compares them.', 'const bellOn', 'bellKey');
    const me = { teams: [{ slug: 'helix' }] };
    const a = { view: 'helix', sel: { type: ['conversation'], kind: ['incident'] }, not: { org: ['x'] } };
    const b = { view: 'helix', sel: { kind: ['incident'], type: ['conversation'] }, not: { org: ['x'] } };
    const [stored] = withDefaults(me, { bells: [a] }).bells;
    assert.equal(bellKey(a), bellKey(b));
    assert.equal(bellKey(a), serverBellKey(stored));
    assert.notEqual(bellKey(a), bellKey({ ...a, view: '~personal' }));
    assert.notEqual(bellKey(a), bellKey({ ...a, not: {} }));
  });

  it('names a filter row by its label, also in its tooltip, the folded rail\'s only text', () => {
    const { rowLabel } = piece('const rowLabel', 'function facetRows', 'rowLabel');
    const customer = { labelFn: (v) => (v === 'acme' ? 'Acme Corp' : null) };
    assert.equal(rowLabel(customer, 'acme'), 'Acme Corp');
    assert.equal(rowLabel(customer, 'unknown'), 'unknown');
    assert.equal(rowLabel({ label: { open: 'Unresolved' } }, 'open'), 'Unresolved');
    assert.equal(rowLabel({}, 'Slack'), 'Slack');
    const rows = html.slice(html.indexOf('function facetRows'), html.indexOf('const mentionBadge'));
    assert.match(rows, /title="\$\{esc\(\(f\.hint && f\.hint\[v\]\) \|\| label\)\}/);
  });

  it('shows every exclusion button of the slid-out rail on a touch screen', () => {
    const css = PAGES['inbox.html'];
    const touch = [...css.matchAll(/@media \(hover: none\) \{([^@]*?)\n {2}\}/g)].map((m) => m[1]).join('\n');
    assert.match(touch, /main\.rail\.railopen #filters[^{]*\.fr \.not \{[^}]*pointer-events: auto/);
  });

  it('folds the filter column by the screen\'s width, up to a 13" MacBook\'s, in every view', () => {
    const railAt = (width, view) => {
      // Only the min-width/max-width queries of RAIL_BAND and WIDE, against `width`.
      const matchMedia = (q) => ({
        matches: [...q.matchAll(/\((min|max)-width: (\d+)px\)/g)]
          .every(([, m, px]) => (m === 'min' ? width >= Number(px) : width <= Number(px))),
      });
      const classes = new Set();
      const classList = {
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
        remove: (c) => classes.delete(c),
      };
      const main = { classList };
      const document = { querySelector: () => main, documentElement: { dataset: {} } };
      const { syncRail } = piece('const RAIL_BAND', 'function wireRail', 'syncRail', {
        matchMedia, document, personal: () => view === 'personal',
      });
      syncRail();
      return classes.has('rail');
    };
    for (const view of ['personal', 'team']) {
      assert.equal(railAt(390, view), false, `iPhone, ${view}: the drawer`);
      assert.equal(railAt(1099, view), false, `under 1100px, ${view}: the drawer`);
      assert.equal(railAt(1440, view), true, `13" MacBook Pro, ${view}`);
      assert.equal(railAt(1470, view), true, `13" MacBook Air, ${view}`);
      assert.equal(railAt(1512, view), false, `14" MacBook Pro, ${view}`);
      assert.equal(railAt(1920, view), false, `desktop, ${view}`);
    }
  });
});
