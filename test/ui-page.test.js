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
import { appRule, checkFiles, personRule } from '../src/attach.js';
import { bellKey as serverBellKey, withDefaults } from '../src/settings.js';
import { CHANNEL_REF } from '../src/markdown.js';
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

  it('refuses the attachments the Worker would refuse, before they are sent', () => {
    const { attachProblem, withoutAttachments } = piece('const MB = 1024 * 1024;', '/** The 📎 button, paste', 'attachProblem, withoutAttachments', {
      state: { me: {} }, esc: (x) => String(x), toast: () => {}, $: () => null,
    });
    const MB = 1024 * 1024;
    const f = (name, type, size) => ({ name, type, size });
    const rules = [
      personRule('slack', 'chat:write'), personRule('slack', 'files:write'), personRule('teams', ''),
      personRule('teams', 'Files.ReadWrite.All'), appRule('teams'), appRule('discord'),
    ];
    const sets = [
      [f('a.png', 'image/png', 1000)],
      [f('a.pdf', 'application/pdf', 1000)],
      [f('a.webp', 'image/webp', 1000)],
      [f('big.png', 'image/png', 4 * MB)],
      [f('a.png', 'image/png', 9 * MB), f('b.png', 'image/png', 9 * MB)],
      [f('huge.mov', 'video/quicktime', 30 * MB)],
      Array(11).fill(f('a.png', 'image/png', 10)),
    ];
    for (const rule of rules) {
      for (const files of sets) {
        const server = checkFiles(rule, files);
        const page = attachProblem(rule, files);
        assert.equal(Boolean(page), Boolean(server), `${JSON.stringify(rule)} ${files.map((x) => x.name)}`);
        if (server) {
          assert.equal(page.toLowerCase().replace(/\.$/, ''), server.toLowerCase());
        }
      }
    }
    // A reply that arrived with its files matches the one being sent, by its text.
    assert.equal(withoutAttachments('See this\n\nAttachments:\n![a.png](https://x/a.png)').trim(), 'See this');
    assert.equal(withoutAttachments('\n\nAttachments:\n- [a.txt](https://x/a.txt)').trim(), '');
    assert.equal(withoutAttachments('Two\n\nAttachments:\n![a.png](https://x/a.png "10x10")\n![b.png](https://x/b.png)\n\n- [c.txt](https://x/c.txt)').trim(), 'Two');
    // A heading of the person's own is text, not a list of files.
    const own = 'Review note\n\nAttachments:\nThe logs are in the ticket.';
    assert.equal(withoutAttachments(own), own);
    assert.equal(withoutAttachments('No files here'), 'No files here');
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

  it('places a thread only bots posted in by its last message, not above every other', () => {
    const { activityOf } = piece('const lastOf', 'const favicon', 'activityOf');
    const threads = [
      { thread: 'person', last_at: '2026-10-29T09:00:00Z', any_at: '2026-10-29T09:00:00Z' },
      { thread: 'bot', last_at: null, any_at: '2026-10-28T17:00:00Z' },
      {
        thread: 'alert', kind: 'alert', last_at: null, any_at: '2026-10-29T10:00:00Z',
      },
      { thread: 'nothing', last_at: null, any_at: null },
    ];
    // As the personal view sorts its list.
    const order = [...threads].sort((a, b) => activityOf(b).localeCompare(activityOf(a)));
    assert.deepEqual(order.map((t) => t.thread), ['alert', 'person', 'bot', 'nothing']);
    assert.ok(html.includes('if (personal()) shown.sort((a, b) => activityOf(b).localeCompare(activityOf(a)));'));
  });

  it('links a channel a message names to the view that has it, with its customer picked', () => {
    let view = 'team';
    const state = { team: 'ops', teams: [{ slug: 'ops', name: 'Ops' }] };
    const { setChannelRefs, channelOf, channelNames } = piece('let channelRefs', '// Slack, Teams and Discord images', 'setChannelRefs, channelOf, channelNames', {
      state,
      personal: () => view === 'personal',
      customerName: (org) => org.toUpperCase(),
      viewName: (slug) => state.teams.find((t) => t.slug === slug)?.name || slug,
      platform: (t) => ({ slack: 'Slack' }[t.source]),
      Markdown: { CHANNEL_REF },
    });
    const refs = [
      {
        id: 'C0AAAAAAAA1', source: 'slack', name: 'acme-ops', org: 'acme', teams: ['ops'], personal: true, url: 'https://slack.com/archives/C0AAAAAAAA1',
      },
      {
        id: 'C0BBBBBBBB2', source: 'slack', name: 'beta', org: 'beta', teams: [], personal: false, url: 'https://slack.com/archives/C0BBBBBBBB2',
      },
    ];
    setChannelRefs(refs);
    assert.deepEqual(channelOf('C0AAAAAAAA1'), {
      name: 'acme-ops', href: '/inbox?team=ops&filters=1&f.customer=acme', inbox: true, title: '#acme-ops: ACME in Ops',
    });
    assert.equal(channelOf('Acme-Ops'), channelOf('C0AAAAAAAA1'));
    assert.deepEqual(channelOf('beta'), {
      name: 'beta', href: 'https://slack.com/archives/C0BBBBBBBB2', title: '#beta is not in your inbox: open it in Slack',
    });
    assert.equal(channelOf('unknown'), undefined);
    assert.equal(channelNames('New channel: #C0AAAAAAAA1, #C0ZZZZZZZZ9.'), 'New channel: #acme-ops, #C0ZZZZZZZZ9.');
    // In the personal view, a channel it has stays in it.
    view = 'personal';
    setChannelRefs(refs);
    assert.equal(channelOf('acme-ops').href, '/inbox?view=personal&filters=1&f.customer=acme');
  });

  it('ranks a thread just resolved below the open ones of its pile', () => {
    const me = 'me';
    const { baseScore } = piece('function baseScore', '\nconst tpl', 'baseScore', {
      lastOf: (t) => t.last_at,
      resolvedP: (t) => (t.resolved ? 1 : 0),
      viewerId: () => me,
      teamIds: () => new Set([me, 'mate']),
      signals: () => ({}),
    });
    const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
    // You wrote the last word and put ✅ on it a moment ago.
    const closed = {
      last_at: ago(0), resolved: true, posters: [me], waiting_on: 'nobody', label: { urgency: 1 },
    };
    // A colleague's thread, open for a week, nobody waiting, low urgency.
    const old = {
      last_at: ago(7 * 24), posters: ['mate'], waiting_on: 'nobody', label: { urgency: 0 },
    };
    assert.ok(baseScore(closed) < baseScore(old), 'resolved now < open for a week');
    // Among the open, recency still counts; so it does among the resolved.
    assert.ok(baseScore({ ...old, last_at: ago(1) }) > baseScore(old));
    assert.ok(baseScore(closed) > baseScore({ ...closed, last_at: ago(24) }));
  });
});
