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

  it('shows only the thread agents\' suggestions, not the expert finder\'s own list', () => {
    const asked = html.match(/(?<=(?:get|fetch)\(\s*[`'"])\/api\/experts[^`'"]*/g);
    assert.equal(asked.length, 1, asked.join(', '));
    assert.match(asked[0], /^\/api\/experts\?thread=.*&suggested=1$/);
  });

  describe('the channel of a new thread', () => {
    const CHANNELS = [
      {
        ref: 'a', source: 'slack', name: 'aem-acme', org: 'acme', orgName: 'ACME', teams: ['t1'], personal: true,
      },
      {
        ref: 'b', source: 'teams', name: 'Acme ops', group: 'Support', org: 'acme', orgName: 'ACME', teams: ['t1'], personal: false,
      },
      {
        ref: 'c', source: 'slack', name: 'aem-globex', org: 'globex', orgName: 'Globex', teams: ['t2'], personal: true,
      },
      {
        ref: 'd', source: 'slack', name: 'internal', org: null, orgName: null, teams: ['t1'], personal: false,
      },
    ];
    const pick = (view) => {
      const { channelsInView, channelOptions } = piece('function channelsInView', 'const channelIcon', 'channelsInView, channelOptions', {
        PLATFORM: { slack: 'Slack', teams: 'Teams' },
        personal: () => !view.team,
        state: { sel: {}, not: {}, ...view },
      });
      return { inView: channelsInView(CHANNELS).map((c) => c.ref), channelsInView, channelOptions };
    };
    const set = (...v) => new Set(v);

    it('knows it from the customer and platform of the view on screen', () => {
      assert.deepEqual(pick({ sel: { customer: set('acme') } }).inView, ['a']);
      assert.deepEqual(pick({ team: 't1', sel: { customer: set('acme'), platform: set('Teams') } }).inView, ['b']);
      assert.deepEqual(pick({ team: 't1', sel: { customer: set('(none)') } }).inView, ['d']);
      assert.deepEqual(pick({ team: 't1', sel: { customer: set('acme') }, not: { platform: set('Slack') } }).inView, ['b']);
    });

    it('does not know it from filters that pick threads', () => {
      const sel = { type: set('conversation'), status: set('waiting', 'hot') };
      assert.deepEqual(pick({ sel }).inView, ['a', 'c']);
      assert.deepEqual(pick({ team: 't1', sel: { ...sel, customer: set('acme') } }).inView, ['a', 'b']);
    });

    it('finds every channel by any word, the view\'s first', () => {
      const { channelOptions, channelsInView } = pick({ team: 't2' });
      const inView = channelsInView(CHANNELS);
      const found = (q) => channelOptions(CHANNELS, inView, q).map((c) => c.ref);
      assert.deepEqual(found(''), ['c', 'a', 'b', 'd']);
      assert.deepEqual(found('aem'), ['c', 'a']);
      assert.deepEqual(found('acme support'), ['b']);
      assert.deepEqual(found('nothing'), []);
    });
  });

  it('formats times and days as toLocale*String did', () => {
    const { ago, clock, dayLabel } = piece('// Dates and times', 'const platform', 'ago, clock, dayLabel');
    for (const iso of ['2024-03-01T07:05:00Z', '2023-12-31T23:59:00Z', '2024-06-15T13:30:00Z']) {
      const d = new Date(iso);
      assert.equal(clock(iso), d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
      // The day of a message, on another day of its year, and looked at in a later year.
      const then = new Date(d.getFullYear(), 6, 4);
      assert.equal(dayLabel(iso, then), d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
      assert.equal(dayLabel(iso), d.toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      }));
      assert.equal(ago(iso), d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
    }
    assert.equal(dayLabel(new Date().toISOString()), 'Today');
    const today = new Date();
    const noonBefore = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12);
    assert.equal(dayLabel(noonBefore.toISOString()), 'Yesterday');
    assert.equal(ago(new Date(Date.now() - 2 * 3600000).toISOString()), '2h');
    assert.equal(clock('not a date'), 'Invalid Date');
    assert.equal(dayLabel(undefined), 'Invalid Date');
    assert.equal(ago(null), '');
  });

  describe('a workspace\'s own emoji', () => {
    const load = (answers = {}) => {
      const asked = [];
      const shown = [];
      const timers = [];
      const parts = piece('// Slack\'s custom emoji (GET', '// Reactions by Slack name', 'ownEmoji, emojiHtml, emojiChip, loadOwnEmoji, askClosest', {
        SLACK_EMOJI: { names: { eyes: '👀' }, aliases: { glasses: 'eyes' } },
        esc: (x) => String(x).replace(/"/g, '&quot;'),
        emojiBare: (n) => String(n).replace(/^:|:$/g, ''),
        emojiByName: (n) => ({ eyes: '👀', white_check_mark: '✅' }[n]),
        emoji: (n) => `:${n}:`,
        state: { open: 'slack:E1:C1:1' },
        render: () => shown.push('list'),
        openThread: (key, how) => shown.push([key, how]),
        setTimeout: (f) => timers.push(f),
        get: async (path) => {
          asked.push(path);
          return answers[path.split('?')[0]] || {};
        },
      });
      return {
        ...parts, asked, shown, timers,
      };
    };
    const CUSTOM = {
      images: { approved: 'https://emoji.example/a.png' },
      aliases: { ok_check: 'white_check_mark' },
      complete: true,
    };

    it('shows an image, an alias\'s emoji, a character, or nothing', async () => {
      const { emojiHtml, emojiChip, loadOwnEmoji } = load({ '/api/emoji/custom': CUSTOM });
      await loadOwnEmoji();
      assert.match(emojiHtml('approved'), /^<img class="emoji" src="https:\/\/emoji\.example\/a\.png" alt=":approved:"/);
      assert.equal(emojiHtml('ok_check'), '✅');
      assert.equal(emojiHtml('eyes'), '👀');
      assert.equal(emojiHtml('✅'), '✅');
      assert.equal(emojiHtml('nothing'), undefined);
      // A Discord custom reaction keeps its colons; a tone falls away on an image.
      assert.match(emojiHtml(':approved:'), /^<img /);
      assert.match(emojiHtml('approved::skin-tone-3'), /^<img /);
      // Teams stores reaction types: never a Slack workspace's emoji.
      assert.equal(emojiHtml('approved', { slack: false }), undefined);
      assert.equal(emojiChip('approved', 'teams'), ':approved:');
      assert.match(emojiChip('approved', 'slack'), /^<img /);
    });

    it('renders what names them again, and fills the composer\'s tables', async () => {
      const { ownEmoji, loadOwnEmoji, shown } = load({ '/api/emoji/custom': CUSTOM });
      await loadOwnEmoji();
      assert.equal(ownEmoji.version, 1);
      assert.deepEqual(shown, ['list', ['slack:E1:C1:1', { live: true, cached: true }]]);
      assert.equal(ownEmoji.names.approved, CUSTOM.images.approved);
      assert.equal(ownEmoji.names.eyes, '👀');
      assert.equal(ownEmoji.alike.ok_check, 'white_check_mark');
      assert.equal(ownEmoji.alike.glasses, 'eyes');
    });

    it('asks Clef only for names on their own, once, after Slack\'s list', async () => {
      const {
        emojiHtml, loadOwnEmoji, askClosest, asked, timers,
      } = load({
        '/api/emoji/custom': CUSTOM,
        '/api/emoji/closest': { emoji: { completed: 'white_check_mark' } },
      });
      emojiHtml('completed');
      assert.equal(timers.length, 0, 'it may be on the list');
      await loadOwnEmoji();
      emojiHtml('aem', { alone: false });
      emojiHtml('1234');
      emojiHtml('completed');
      emojiHtml('completed');
      assert.equal(timers.length, 1);
      await askClosest();
      assert.deepEqual(asked, ['/api/emoji/custom', '/api/emoji/closest?names=completed']);
      const near = emojiHtml('completed');
      assert.match(near, /^<span class="emoji-near" title=":completed: has no image here/);
      assert.match(near, />✅<\/span>$/);
    });

    it('stays by name when the inbox cannot get them', async () => {
      const failing = load();
      assert.equal(failing.emojiHtml('approved'), undefined);
      await failing.loadOwnEmoji();
      assert.equal(failing.ownEmoji.complete, false);
      failing.emojiHtml('completed');
      assert.equal(failing.timers.length, 0);
    });
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
      Markdown, emojiByName: () => undefined, location: {}, ownEmoji: { version: 0 },
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

  it('moves the thread\'s header away on a phone as the thread scrolls, and back', () => {
    const { headAway } = piece('const headAway', 'function wireHeadAway', 'headAway');
    // Down: as far as the thread went, until it is gone; up: back as far, until it is all there.
    assert.equal(headAway(0, 40, 140), 40);
    assert.equal(headAway(120, 40, 140), 140);
    assert.equal(headAway(140, -30, 140), 110);
    assert.equal(headAway(20, -30, 140), 0);
  });

  it('leaves the address alone on Back and Forward: the entry gone back to keeps its list', () => {
    // The popstate handler asks for the entry's search without writing the address, which still
    // has the thread gone back from (a second Back would reopen it instead of the list).
    const pop = html.slice(html.indexOf("window.addEventListener('popstate'"));
    assert.match(pop.slice(0, pop.indexOf('\n  });')), /runSearch\(query, \{ asked: true \}\)/);
    const run = html.slice(html.indexOf('async function runSearch'));
    assert.match(run.slice(0, run.indexOf('\n}')), /if \(!asked\) toUrl\(false\);/);
  });

  it('never scrolls the list sideways on a phone, which would take the drawer\'s swipe', () => {
    const css = SCRIPTS['spectrum-inbox.css'];
    assert.match(css, /\n#threads \{ overflow-x: hidden; \}/);
    // The controls' row is no wider than the list; the view switch scrolls in it instead.
    assert.match(css, /#threads \.count \.ctl \{[^}]*min-width: 0;/);
    assert.match(css, /@container \(max-width: 559px\) \{[^@]*#threads \.count \.order \{ overflow-x: auto;/);
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

  it('names the other teams\' unread at the end, smallest first and admin last', () => {
    const { orderElsewhere, endSentence } = piece(
      'function orderElsewhere',
      'function endHtml',
      'orderElsewhere, endSentence',
    );
    const endCopy = (teams) => endSentence(teams);
    const teams = [
      {
        slug: 'platform', name: 'Platform ops', members: 4, unread: 3,
      },
      {
        slug: 'admin', name: 'Admin', members: 1, unread: 2,
      },
      {
        slug: 'edge', name: 'Edge ops', members: 2, unread: 1,
      },
      {
        slug: 'quiet', name: 'Quiet', members: 1, unread: 0,
      },
    ];
    assert.deepEqual(orderElsewhere(teams).map((t) => t.slug), ['edge', 'platform', 'admin']);
    assert.equal(
      endCopy(teams),
      "You've reached the end. But there is 1 more unread thread for your Edge ops team, "
      + '3 more unread threads for your Platform ops team, and 2 more unread threads for your Admin team.',
    );
    assert.equal(
      endCopy([{
        slug: 'edge', name: 'Edge ops', members: 2, unread: 4,
      }]),
      "You've reached the end. But there are 4 more unread threads for your Edge ops team.",
    );
    assert.equal(
      endCopy([
        {
          slug: 'edge', name: 'Edge ops', members: 2, unread: 1,
        },
        {
          slug: 'platform', name: 'Platform ops', members: 4, unread: 2,
        },
      ]),
      "You've reached the end. But there is 1 more unread thread for your Edge ops team "
      + 'and 2 more unread threads for your Platform ops team.',
    );
    assert.equal(endCopy([]), "You've reached the end.");
    assert.equal(endCopy(null), "You've reached the end.");
    // The same size sorts by name. Admin stays last however large it is.
    assert.deepEqual(orderElsewhere([
      {
        slug: 'zed', name: 'Zed', members: 3, unread: 1,
      },
      {
        slug: 'admin', name: 'Admin', members: 9, unread: 1,
      },
      {
        slug: 'amy', name: 'Amy', members: 3, unread: 4,
      },
    ]).map((t) => t.slug), ['amy', 'zed', 'admin']);
  });

  it('shows a search\'s knowledge-base entries, each a link to it in the editor, a few until asked', () => {
    const state = { search: { kbAll: false } };
    const { kbSection } = piece('const KB_SHOWN', '/** Asks for `q`', 'kbSection', {
      state,
      esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
      marked: (s) => s,
      reEscape: (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      emojiHtml: () => '',
      Markdown: { render: (src) => `<p>${src.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')}</p>` },
      kbFileHref: (repo, path) => `/inbox/admin?${new URLSearchParams({ repo, view: 'kb', path })}`,
    });
    const hit = (i) => ({
      repo: 'kb-team-helix', path: `playbooks/p${i}.md`, name: 'Helix', type: 'Playbook', title: `P${i}`, description: 'What to do', snippet: null,
    });
    assert.equal(kbSection([], []), '');
    // Four: all of them, rather than "1 more".
    let out = kbSection([1, 2, 3, 4].map(hit), ['p']);
    assert.equal(out.match(/class="kbhit"/g).length, 4);
    assert.match(out, /href="\/inbox\/admin\?repo=kb-team-helix&amp;view=kb&amp;path=playbooks%2Fp1\.md"/);
    assert.match(out, /<span class="tag">Playbook<\/span>/);
    assert.match(out, /<div class="l3 md"><p>What to do<\/p><\/div>/);
    // The excerpt is markdown, rendered; a link in it is text (the entry is the link), and the
    // words are marked in its text, not in its tags or entities.
    out = kbSection([{ ...hit(1), snippet: 'Check **the purge**, see [the site](../sites/www.md) &amp; more' }], ['purge', 'amp']);
    assert.match(out, /<p>Check <strong>the <mark>purge<\/mark><\/strong>, see <span class="ln">the site<\/span> &amp; more<\/p>/);
    out = kbSection([1, 2, 3, 4, 5].map(hit), ['p']);
    assert.equal(out.match(/class="kbhit"/g).length, 3);
    assert.match(out, /data-kbmore>2 more in the knowledge bases</);
    state.search.kbAll = true;
    assert.equal(kbSection([1, 2, 3, 4, 5].map(hit), ['p']).match(/class="kbhit"/g).length, 5);
  });

  it('forgets the empty list when a search paints it, and a team name there drops the type filter', () => {
    const state = {
      search: {
        data: { hits: [{ thread: 'waf' }] }, loading: false, error: null, q: 'WAF',
      },
      unread: true,
      hitNodes: null,
      order: [],
      sel: { type: new Set(['conversation']) },
      not: { type: new Set(['alert']) },
    };
    const remembered = '__empty';
    const list = {
      children: [],
      innerHTML: '<div class="empty">Nothing matches these filters.</div>',
      classList: { toggle() {} },
    };
    list[remembered] = list.innerHTML;
    const head = { innerHTML: '', __html: '' };
    const { searchRows } = piece('function searchRows', 'function openHit', 'searchRows', {
      state,
      searchEntry: () => null,
      passes: () => false,
      viewFacets: () => [],
      filterCount: () => 0,
      filtButton: () => '',
      mentionsOn: () => false,
      esc: (s) => s,
      viewSwitch: () => '',
      toNode: () => ({}),
      row: () => '',
      kbSection: () => '',
      preload: { observe() {}, unobserve() {} },
      cardGone: () => {},
    });
    searchRows({
      querySelector(sel) { return sel === '.rows' ? list : head; },
    });
    // Clear would otherwise see the old empty message and leave the search's text up.
    assert.equal(list[remembered], '');
    assert.match(list.innerHTML, /hidden by the filters/);

    const { endTeam } = piece('function endTeam', 'function endNote', 'endTeam', { state });
    endTeam({ closest: (sel) => (sel === '.end' ? {} : null) });
    assert.equal(state.sel.type, undefined);
    assert.equal(state.not.type, undefined);
    state.sel.type = new Set(['conversation']);
    endTeam({ closest: () => null });
    assert.equal([...state.sel.type].join(), 'conversation');
  });

  it('shows only the viewer\'s own messages (and those being sent) as theirs', () => {
    const { message } = piece('const continues', '// ---------------------------------------------------------------- the thread agent', 'message', {
      dayLabel: () => 'Today',
      profileKey: () => 'k',
      avatar: () => '',
      esc: (x) => String(x ?? ''),
      timeTag: () => '10:00',
      md: (x) => x,
      canReact: () => false,
      canEdit: () => false,
      state: {},
      QUICK: [],
      emoji: (x) => x,
      SIGNAL_HINT: {},
      favImg: (x) => x,
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
      timeTag: () => '10:00',
      md: (x) => x,
      canReact: () => true,
      canEdit: (m) => Boolean(m.editable),
      state,
      QUICK: ['eyes'],
      emoji: (x) => x,
      SIGNAL_HINT: {},
      favImg: (x) => x,
    });
    const staff = { name: 'Ada', kind: 'person', staff: true };
    const m = {
      thread: 't', id: '1', at: '2026-10-21T10:00:00Z', body: 'hi', author: staff, mine: true,
    };
    assert.doesNotMatch(message(m, null, false), /data-edit=/);
    assert.match(message({ ...m, editable: 'user' }, null, false), /data-edit="1"[^>]*title="Edit your message"/);
    assert.match(message({ ...m, editable: 'app' }, null, false), /title="Edit, as the bot"/);
    // Edited on the platform, or here: "(edited)" under it.
    assert.match(message({ ...m, editedAt: '2026-10-21T10:05:00Z' }, null, false), /class="meta"[^>]*>\(edited\)</);
    state.editing = { id: 't|1' };
    const open = message({ ...m, editable: 'user' }, null, false);
    assert.match(open, /class="msg [^"]*editing/);
    assert.match(open, /<textarea class="editbox"/);
    // While editing: no reactions, no second ✎, and not the old text (the editor gets it).
    assert.doesNotMatch(open, /data-pick=|data-edit="1"|>hi</);
  });

  it('catches up after a socket comes back, and not when it first connects', () => {
    const sockets = [];
    class FakeSocket {
      constructor() {
        this.readyState = 1;
        sockets.push(this);
      }
    }
    const reloads = [];
    const state = {
      sockets: [],
      live: 1,
      open: 'b',
      cache: new Map([['a', 1], ['b', 2]]),
      offline: 1,
      experts: new Map([['b', []]]),
    };
    const experts = [];
    const { listen } = piece('/**\n * A socket is back', '// ---------------------------------------------------------------- notifications', 'listen', {
      WebSocket: FakeSocket,
      location: { protocol: 'https:', host: 'x' },
      state,
      GAP: 'gap',
      reloadSoon: (k) => reloads.push(k),
      $: () => ({}),
      setTimeout: (f) => f(),
      clearTimeout: () => {},
      noteEvent: () => {},
      screenTeams: () => ['helix'],
      loadExperts: (k) => experts.push(k),
      fetch: async () => {},
    });
    listen('notifications', 1);
    sockets[0].onclose();
    sockets[1].onopen();
    assert.deepEqual(reloads, [], 'a room that is not on screen changes nothing there');
    sockets.length = 0;
    state.sockets.length = 0;

    listen('helix', 1);
    sockets[0].onopen();
    assert.deepEqual(reloads, []);
    assert.deepEqual([...state.cache.keys()], ['a', 'b']);

    sockets[0].onclose();
    assert.equal(sockets.length, 2);
    sockets[1].onopen();
    assert.deepEqual(reloads, ['b']);
    assert.deepEqual([...state.cache.keys()], ['b']);
    assert.deepEqual(experts, ['b']);
    assert.equal(state.experts.has('b'), false);

    // With no thread open, a tab in the background still has something to catch up on.
    state.open = null;
    sockets[1].onclose();
    sockets[2].onopen();
    assert.deepEqual(reloads, ['b', 'gap']);
  });

  it('shows your reads from another tab or device once the room has written them, and not this tab\'s own again', () => {
    const at = (h) => `2026-11-05T${String(h).padStart(2, '0')}:00:00Z`;
    const state = {
      sockets: [],
      live: 1,
      open: null,
      cache: new Map(),
      me: { id: 1 },
      data: {
        threads: [
          { thread: 'a', unread: true, last_at: at(9) },
          { thread: 'b', unread: false, last_at: at(9) },
          // A folded entry: each member is read up to its own end.
          {
            thread: 'g',
            unread: true,
            last_at: at(11),
            members: [{ thread: 'g', last_at: at(8) }, { thread: 'h', last_at: at(11) }],
          },
        ],
      },
    };
    const memberLast = (m) => m.last_at || m.any_at;
    const sockets = [];
    const reloads = [];
    const reloadSoon = (k) => reloads.push(k);
    const { heardRead } = piece('function readHere(', '// Live updates reload the inbox', 'heardRead', { state, memberLast, reloadSoon });
    const { listen } = piece('function listen(', '// ---------------------------------------------------------------- notifications', 'listen', {
      WebSocket: function FakeSocket() { sockets.push(this); },
      location: { protocol: 'https:', host: 'x' },
      state,
      reloadSoon,
      noteEvent: () => {},
      screenTeams: () => ['helix'],
      heardRead,
      heardRequest: () => {},
    });
    listen('helix', 1);
    const send = (ev) => sockets[0].onmessage({ data: JSON.stringify(ev) });
    // Said at once, before D1 has it: an inbox loaded now would still have it unread.
    send({
      type: 'read', person: 1, thread: 'a', at: at(9),
    });
    send({
      type: 'read', person: 2, thread: 'b', at: at(9),
    });
    assert.deepEqual(reloads, [], 'not written yet');
    const flushed = (...reads) => send({ type: 'reads', reads: reads.map(([person, thread, h]) => ({ person, thread, at: at(h) })) });
    flushed([1, 'b', 9]);
    assert.deepEqual(reloads, [], 'read here already (this tab marked it)');
    flushed([1, 'a', 8]);
    assert.deepEqual(reloads, [], 'not up to its last message');
    flushed([1, 'a', 9]);
    assert.deepEqual(reloads, ['a'], 'read on another device');
    flushed([1, 'g', 8], [1, 'elsewhere', 9], [2, 'b', 9]);
    assert.deepEqual(reloads, ['a', 'g', 'b'], 'a member of a folded entry, read to its end, and a teammate\'s read');
  });

  describe('\u2191 to edit your last message', () => {
    /** The page's editLast and editArrived, with a thread `messages` and an outbox `sending`. */
    function keys({ messages = [], sending = [], pane = [] } = {}) {
      const state = {
        open: 't', cache: new Map([['t', { data: { messages } }]]), sending, editing: null, editArriving: null,
      };
      const reply = { value: '', blur: () => {} };
      const doc = { activeElement: reply, body: {} };
      const did = {
        edited: [], focused: [], toasts: [], later: [],
      };
      const fns = piece('function editLast', 'function globalKey', 'editLast, editArrived', {
        state,
        document: doc,
        canEdit: (m) => Boolean(m.editable) && !m.pending,
        sendLate: (p) => Boolean(p.late),
        paneMessages: () => pane.map((id) => ({ dataset: { id } })),
        focusMessage: (el) => did.focused.push(el.dataset.id),
        toast: (text) => did.toasts.push(text),
        startEdit: (id) => did.edited.push(id),
        $: (id) => (id === 'reply' ? reply : null),
        setTimeout: (fn) => did.later.push(fn),
        SEND_ARRIVE_MS: 60000,
        SEND_APP_ARRIVE_MS: 180000,
      });
      const settle = () => did.later.splice(0).forEach((fn) => fn());
      return {
        state, did, reply, doc, settle, ...fns,
      };
    }
    const mine = (id, at) => ({
      thread: 't', id, at, body: `reply ${id}`, editable: 'user',
    });
    const out = (id, at, status = 'sending', more = {}) => ({
      thread: 't', id, at, body: 'just sent', status, ...more,
    });

    it('edits your last message of the thread', () => {
      const p = keys({ messages: [mine('1', '2026-10-21T10:00:00Z'), mine('2', '2026-10-21T10:01:00Z')] });
      assert.equal(p.editLast('t'), true);
      assert.deepEqual(p.did.edited, ['t|2']);
      assert.equal(p.state.editArriving, null);
    });

    it('waits for the reply just sent instead of editing the message before it, and opens it once it is back', () => {
      for (const status of ['sending', 'sent', 'delivered']) {
        const p = keys({
          messages: [mine('1', '2026-10-21T10:00:00Z')],
          sending: [out('pending-1', '2026-10-21T10:05:00Z', status)],
        });
        assert.equal(p.editLast('t'), true);
        assert.deepEqual(p.did.edited, [], `${status}: not the message before it`);
        assert.equal(p.state.editArriving.id, 'pending-1');
        assert.match(p.did.toasts[0], /on its way/);
        p.editArrived('t', mine('2', '2026-10-21T10:05:01Z'));
        p.settle();
        assert.deepEqual(p.did.edited, ['t|2'], status);
        assert.equal(p.state.editArriving, null);
      }
    });

    it('waits as long for a reply as the bot as it takes to come back', () => {
      const p = keys({ sending: [out('pending-1', '2026-10-21T10:05:00Z', 'sent', { app: true })] });
      const before = Date.now();
      p.editLast('t');
      assert.ok(p.state.editArriving.until >= before + 180000);
    });

    it('does not open the reply once you went on: typed, left the box, an edit, too late', () => {
      const cases = [
        [({ reply }) => Object.assign(reply, { value: 'next' }), 'typed the next reply'],
        [({ doc }) => Object.assign(doc, { activeElement: {} }), 'left the box'],
        [({ state }) => Object.assign(state, { editing: { id: 't|1' } }), 'editing another message'],
        [({ state }) => Object.assign(state.editArriving, { until: Date.now() - 1 }), 'too late'],
        [({ state }) => Object.assign(state, { open: 'u' }), 'another thread'],
      ];
      for (const [how, why] of cases) {
        const p = keys({ sending: [out('pending-1', '2026-10-21T10:05:00Z')] });
        p.editLast('t');
        how(p);
        p.editArrived('t', mine('2', '2026-10-21T10:05:01Z'));
        p.settle();
        assert.deepEqual(p.did.edited, [], why);
        assert.equal(p.state.editArriving, null, why);
      }
    });

    it('puts a reply that did not go out in focus, not the message before it', () => {
      for (const status of ['failed', 'unknown']) {
        const p = keys({
          messages: [mine('1', '2026-10-21T10:00:00Z')],
          sending: [out('pending-1', '2026-10-21T10:05:00Z', status)],
          pane: ['t|1', 't|pending-1'],
        });
        assert.equal(p.editLast('t'), true);
        assert.deepEqual(p.did.edited, [], status);
        assert.deepEqual(p.did.focused, ['t|pending-1'], status);
        assert.equal(p.state.editArriving, null, status);
      }
    });

    it('edits a message newer than a reply in the outbox, and ignores other threads\' replies', () => {
      const late = keys({
        messages: [mine('1', '2026-10-21T10:00:00Z'), mine('2', '2026-10-21T10:10:00Z')],
        sending: [out('pending-1', '2026-10-21T10:05:00Z', 'failed')],
        pane: ['t|1', 't|pending-1', 't|2'],
      });
      late.editLast('t');
      assert.deepEqual(late.did.edited, ['t|2']);
      const other = keys({
        messages: [mine('1', '2026-10-21T10:00:00Z')],
        sending: [{ ...out('pending-1', '2026-10-21T10:05:00Z'), thread: 'u' }],
      });
      other.editLast('t');
      assert.deepEqual(other.did.edited, ['t|1']);
    });
  });

  describe('live reloads', () => {
    /** The inbox's reloadSoon with fake timers: `due()` is how long until the reload set. */
    function live({ types = ['conversation'], view = 'team', open = null } = {}) {
      const state = {
        sel: { type: new Set(types) }, not: {}, open, settings: { bells: [] },
      };
      let timer = null;
      const FACETS = [{ id: 'type', value: (t) => (t.kind === 'alert' ? 'alert' : 'conversation') }];
      const facetPasses = (f, t) => !state.sel[f.id]?.size || state.sel[f.id].has(f.value(t));
      const fns = piece('let reload;', '\nasync function reloadChanged() {', 'reloadSoon, changed', {
        state,
        document: { visibilityState: 'visible' },
        notifying: () => false,
        scopeKey: () => 'helix',
        personal: () => view === 'personal',
        FACETS,
        facetPasses,
        reloadChanged: () => {},
        setTimeout: (fn, ms) => {
          timer = { ms };
          return timer;
        },
        clearTimeout: (t) => {
          if (t === timer) {
            timer = null;
          }
        },
      });
      return { ...fns, due: () => timer && timer.ms };
    }

    it('reloads soon for a conversation, and waits for more for an alert the list does not show', () => {
      const a = live();
      a.reloadSoon('c1');
      assert.equal(a.due(), 500);
      const b = live();
      b.reloadSoon('alert1', { alert: true });
      assert.equal(b.due(), 30000);
      // More alerts wait with it; a conversation's message does not.
      b.reloadSoon('alert2', { alert: true });
      assert.equal(b.due(), 30000);
      b.reloadSoon('c1');
      assert.equal(b.due(), 500);
      assert.deepEqual([...b.changed], ['alert1', 'alert2', 'c1']);
      // And an alert does not put off a reload already on its way.
      b.reloadSoon('alert3', { alert: true });
      assert.equal(b.due(), 500);
    });

    it('reloads soon for an alert the list shows, or the one open', () => {
      const all = live({ types: [] });
      all.reloadSoon('alert1', { alert: true });
      assert.equal(all.due(), 500);
      const alerts = live({ types: ['alert'] });
      alerts.reloadSoon('alert1', { alert: true });
      assert.equal(alerts.due(), 500);
      const opened = live({ open: 'alert1' });
      opened.reloadSoon('alert1', { alert: true });
      assert.equal(opened.due(), 500);
      // The personal view has no alerts, whatever the filter.
      const mine = live({ types: [], view: 'personal' });
      mine.reloadSoon('alert1', { alert: true });
      assert.equal(mine.due(), 30000);
    });
  });

  it('asks for the older pages of the inbox 300 entries at a time', () => {
    const { pageUrl } = piece('const BACKFILL = 1000;', '\n/**', 'pageUrl', {
      state: { team: 'helix' }, personal: () => false,
    });
    assert.equal(pageUrl(), '/api/inbox?team=helix');
    assert.equal(pageUrl('2026-01-01|k'), '/api/inbox?team=helix&before=2026-01-01%7Ck&limit=300');
  });

  it('lists the admin team\'s requests in its inbox, as they are now, with its threads', async () => {
    const state = { team: 'admin', data: null, scores: new Map() };
    const pages = [
      { team: 'admin', threads: [{ thread: 'a' }, { thread: 'b' }], page: { next: null } },
      { team: 'admin', threads: [{ thread: 'a' }], page: { next: null } },
    ];
    const asked = [
      [{ thread: 'request:channel:1' }, { thread: 'request:bot:slack:T:B1' }],
      [{ thread: 'request:channel:1' }],
    ];
    let shown = true;
    const { loadInbox } = piece('const BACKFILL = 1000;', '\nlet paging = null;', 'loadInbox', {
      state,
      personal: () => false,
      scopeKey: () => 'admin',
      scopeOf: (d) => d.team,
      get: async () => pages.shift(),
      syncSockets: () => {},
      checkBells: () => {},
      mergeProfiles: () => {},
      renderUser: () => {},
      renderFollowMenu: () => {},
      coParticipants: () => new Map(),
      inPass: (f) => f(),
      smartScore: () => 0,
      render: () => {},
      backfill: () => {},
      keepReads: () => {},
      mergeStacks: (a, b) => ({ ...a, ...b }),
      requestsShown: () => shown,
      requestHere: (t) => state.team === 'admin' || t.team === state.team,
      loadRequests: async () => asked.shift(),
      isRequestKey: (k) => k.startsWith('request:'),
    });
    const keys = () => state.data.threads.map((t) => t.thread);
    await loadInbox();
    assert.deepEqual(keys(), ['a', 'b', 'request:channel:1', 'request:bot:slack:T:B1']);
    // The older entries stay, but a request that is not listed any more goes.
    await loadInbox();
    assert.deepEqual(keys(), ['a', 'b', 'request:channel:1']);
    // Another team's inbox has none.
    shown = false;
    pages.push({ team: 'admin', threads: [{ thread: 'a' }], page: { next: null } });
    await loadInbox();
    assert.deepEqual(keys(), ['a', 'b']);
  });

  it('lists the questions asked of you in the inbox of their thread\'s team, not in another', async () => {
    const state = { team: 'edge', data: null, scores: new Map() };
    const page = () => ({ team: 'edge', threads: [{ thread: 'a' }], page: { next: null } });
    const pages = [page(), page()];
    const asked = [
      [{ thread: 'request:question:q1', team: 'edge' }, { thread: 'request:question:q2', team: 'forms' }],
      [{ thread: 'request:question:q1', team: 'edge' }],
    ];
    const { loadInbox } = piece('const BACKFILL = 1000;', '\nlet paging = null;', 'loadInbox', {
      state,
      personal: () => false,
      scopeKey: () => state.team,
      scopeOf: (d) => d.team,
      get: async () => pages.shift(),
      syncSockets: () => {},
      checkBells: () => {},
      mergeProfiles: () => {},
      renderUser: () => {},
      renderFollowMenu: () => {},
      coParticipants: () => new Map(),
      inPass: (f) => f(),
      smartScore: () => 0,
      render: () => {},
      backfill: () => {},
      keepReads: () => {},
      mergeStacks: (a, b) => ({ ...a, ...b }),
      requestsShown: () => true,
      requestHere: (t) => t.team === state.team,
      loadRequests: async () => asked.shift(),
      isRequestKey: (k) => k.startsWith('request:'),
    });
    await loadInbox();
    assert.deepEqual(state.data.threads.map((t) => t.thread), ['a', 'request:question:q1']);
    // Shown once, however often it is listed.
    await loadInbox();
    assert.deepEqual(state.data.threads.map((t) => t.thread), ['a', 'request:question:q1']);
  });

  describe('a thread folded into a group (re-threading)', () => {
    const entry = (thread, members = [thread]) => ({
      thread, members: members.map((m) => ({ thread: m })),
    });
    const page = (threads, next = null) => ({ team: 'helix', threads, page: { next } });
    /** The inbox's loading, with `answers` as the pages GET /api/inbox gives, in turn. */
    function inbox(answers) {
      const state = { team: 'helix', data: null, scores: new Map() };
      const got = [...answers];
      const fns = piece('const BACKFILL = 1000;', '\nlet paging = null;', 'loadInbox, addPage, foldInto, splitFrom', {
        state,
        personal: () => false,
        scopeKey: () => 'helix',
        scopeOf: (d) => d.team,
        get: async () => got.shift(),
        syncSockets: () => {},
        checkBells: () => {},
        mergeProfiles: () => {},
        renderUser: () => {},
        renderFollowMenu: () => {},
        coParticipants: () => new Map(),
        inPass: (f) => f(),
        smartScore: () => 0,
        render: () => {},
        backfill: () => {},
        keepReads: () => {},
        mergeStacks: (a, b) => ({ ...a, ...b }),
        // Not the admin team's inbox: no requests (see "the admin team's requests").
        requestsShown: () => false,
        isRequestKey: () => false,
      });
      return { state, keys: () => state.data.threads.map((t) => t.thread), ...fns };
    }

    it('takes the folded thread\'s own entry off the list when the inbox reloads', async () => {
      const { keys, loadInbox } = inbox([
        page([entry('stub'), entry('group'), entry('old')], 'cursor'),
        // The stub is a member of the group now: the first page has only the group.
        page([entry('group', ['group', 'stub'])], 'cursor'),
      ]);
      await loadInbox();
      assert.deepEqual(keys(), ['stub', 'group', 'old']);
      await loadInbox();
      assert.deepEqual(keys(), ['group', 'old'], 'no stub that opens its group');
    });

    it('takes it off when an older page brings its group', async () => {
      const { keys, loadInbox, addPage } = inbox([page([entry('a'), entry('stub')], 'cursor')]);
      await loadInbox();
      addPage(page([entry('group', ['group', 'stub']), entry('a')]));
      assert.deepEqual(keys(), ['a', 'group']);
    });

    /** `listen` on the inbox of `inbox()`: the room's events, as its socket gets them. */
    function room(state, foldInto, splitFrom = () => {}) {
      const sockets = [];
      const reloads = [];
      const { listen } = piece('function listen(', '// ---------------------------------------------------------------- notifications', 'listen', {
        WebSocket: function FakeSocket() { sockets.push(this); },
        location: { protocol: 'https:', host: 'x' },
        state: Object.assign(state, {
          sockets: [], live: 1, open: null, cache: new Map(), me: { id: 1 },
        }),
        reloadSoon: (k) => reloads.push(k),
        noteEvent: () => {},
        stalePools: () => {},
        screenTeams: () => ['helix'],
        heardRead: () => {},
        heardRequest: () => {},
        foldInto,
        splitFrom,
      });
      listen('helix', 1);
      return { send: (ev) => sockets[0].onmessage({ data: JSON.stringify(ev) }), reloads };
    }

    it('takes it off when the room says so, also when its group is on an older page', async () => {
      const {
        state, keys, loadInbox, foldInto,
      } = inbox([page([entry('stub'), entry('a'), entry('group')], 'cursor')]);
      await loadInbox();
      const { send, reloads } = room(state, foldInto);
      send({ type: 'thread', thread: 'group', folded: ['stub'] });
      assert.deepEqual(keys(), ['a', 'group']);
      // Until the reload, the group's entry has it, so opening or reading the group covers it.
      assert.deepEqual(state.data.threads[1].members.map((m) => m.thread), ['group', 'stub']);
      assert.deepEqual(reloads, ['group']);
    });

    it('keeps it until its group is in the inbox, so the conversation stays listed', async () => {
      const {
        state, keys, loadInbox, addPage, foldInto,
      } = inbox([
        page([entry('stub'), entry('a')], 'cursor'),
        // The group is on an older page, which the reload does not bring.
        page([entry('a')], 'cursor'),
      ]);
      await loadInbox();
      room(state, foldInto).send({ type: 'thread', thread: 'group', folded: ['stub'] });
      assert.deepEqual(keys(), ['stub', 'a']);
      await loadInbox();
      assert.deepEqual(keys(), ['a', 'stub']);
      addPage(page([entry('group')]));
      assert.deepEqual(keys(), ['a', 'group']);
    });

    it('lists a thread split back out of its group on its own (de-threading)', async () => {
      const {
        state, keys, loadInbox, foldInto, splitFrom,
      } = inbox([
        page([entry('group', ['group', 'b']), entry('a')], 'cursor'),
        page([entry('b'), entry('group'), entry('a')], 'cursor'),
      ]);
      await loadInbox();
      const { send, reloads } = room(state, foldInto, splitFrom);
      state.cache.set('group', 1).set('b', 2).set('a', 3);
      send({ type: 'thread', thread: 'group', split: ['b'] });
      assert.deepEqual(state.data.threads[0].members.map((m) => m.thread), ['group']);
      assert.deepEqual([...state.cache.keys()], ['a'], 'the group\'s copy has its messages');
      assert.deepEqual(reloads, ['group']);
      await loadInbox();
      assert.deepEqual(keys(), ['b', 'group', 'a']);
    });

    it('drops a fold still waiting for its group when the thread is split out', async () => {
      const {
        state, keys, loadInbox, addPage, foldInto, splitFrom,
      } = inbox([page([entry('b'), entry('a')], 'cursor')]);
      await loadInbox();
      const { send } = room(state, foldInto, splitFrom);
      send({ type: 'thread', thread: 'group', folded: ['b'] });
      send({ type: 'thread', thread: 'group', split: ['b'] });
      addPage(page([entry('group')]));
      assert.deepEqual(keys(), ['b', 'a', 'group']);
    });
  });

  it('shows a reaction made here at once, and one taken off as gone', () => {
    const glyphs = {
      eyes: 'E', pray: 'P', thumbsup: 'U', '+1': 'U',
    };
    const { withReaction } = piece('function withReaction', 'async function react(', 'withReaction', {
      emoji: (n) => glyphs[n] || `:${n}:`,
    });
    const list = [{
      emoji: '+1', count: 1, names: ['Ann'], mine: false,
    }];
    // Added to someone else's, under the name the thread has it.
    assert.deepEqual(withReaction(list, 'thumbsup', false, 'Me'), [{
      emoji: '+1', count: 2, names: ['Ann', 'Me'], mine: true,
    }]);
    // A new one goes last; the thread's list is left as it was.
    assert.deepEqual(withReaction(list, 'eyes', false, 'Me').map((r) => [r.emoji, r.count, r.mine]), [['+1', 1, false], ['eyes', 1, true]]);
    assert.equal(list[0].count, 1);
    // Taken off: one fewer, or gone when it was the only one; nothing to take off, no change.
    const mine = withReaction(list, 'pray', false, 'Me');
    assert.deepEqual(withReaction(mine, 'pray', true, 'Me'), list);
    assert.deepEqual(withReaction(withReaction(list, '+1', false, 'Me'), '+1', true, 'Me'), list);
    assert.deepEqual(withReaction(list, '+1', true, 'Me'), list);
    // Twice is once.
    assert.deepEqual(withReaction(mine, 'pray', false, 'Me'), mine);
  });

  it('sends a reply as the bot looking like the bot\'s replies in that workspace', () => {
    const ours = (thread, name) => ({
      thread, editable: 'app', author: { kind: 'bot', name }, avatar: `${name}.png`, authorKey: `k-${name}`,
    });
    const state = {
      cache: new Map([
        ['slack:T1:C1:1', { data: { messages: [ours('slack:T1:C1:1', 'Ops'), { thread: 'slack:T1:C1:1', author: { kind: 'bot', name: 'Other' } }] } }],
        ['slack:T2:C2:1', { data: { messages: [ours('slack:T2:C2:1', 'Elsewhere')] } }],
      ]),
    };
    const { appLook } = piece('function appLook', '/** Shows the thread', 'appLook', { state });
    assert.deepEqual(appLook('slack:T1:C9:2'), { author: { kind: 'bot', name: 'Ops' }, avatar: 'Ops.png', authorKey: 'k-Ops' });
    assert.equal(appLook('teams:T1:C1:1').unnamed, true);
    assert.equal(appLook('teams:T1:C1:1').author.name, 'The bot');
  });

  it('fills the sending bar towards 90%, then completes it and fades it out', () => {
    const {
      sendBar, sendDecides, sendOutcome, sendState,
    } = piece('// Sending, as in iMessage', 'const REDUCED_MOTION', 'sendBar, sendDecides, sendOutcome, sendState', {
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
    // Refused means it did not go out; a lost answer means nobody knows.
    assert.equal(sendOutcome({ status: 502, data: { error: 'Slack: is_archived' } }), 'failed');
    assert.equal(sendOutcome({ status: 409, data: { error: 'connect first' } }), 'failed');
    assert.equal(sendOutcome({ status: 0, data: { error: 'could not send' } }), 'unknown');
    assert.equal(sendOutcome(null), 'unknown');
    assert.equal(sendOutcome({ status: 500, data: {} }), 'unknown');
    assert.equal(sendOutcome({ status: 409, data: { unknown: true, error: 'may have' } }), 'unknown');
    assert.match(sendState({ id: 'x', status: 'unknown', error: 'e' }), /Not sure it was sent.*data-retry="x">Retry/s);
    assert.match(sendState({
      id: 'x', status: 'unknown', error: 'e', asked: true,
    }), /May have been sent.*title="It may go out twice[^>]*>Send again/s);
    // A key lasts a day: after that, only the person can decide.
    const at = '2026-10-21T10:00:00Z';
    assert.equal(sendDecides({ at }, Date.parse('2026-10-21T20:00:00Z')), false);
    assert.equal(sendDecides({ at }, Date.parse('2026-10-22T10:00:00Z')), true);
    assert.equal(sendDecides({ at, asked: true }, Date.parse(at)), true);
    assert.match(sendState({
      id: 'x', status: 'unknown', error: 'e', at,
    }, Date.parse('2026-10-22T10:00:00Z')), />Send again</);
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

  it('keeps asking about the agent\'s turn after a request failed, for a while', async () => {
    const timers = [];
    const state = { open: 't', agents: new Map() };
    let down = false;
    const placed = [];
    const { loadAgent } = piece('/** Asks the thread\'s agent how its latest turn went', '// ---------------------------------------------------------------- the thread\'s header', 'loadAgent', {
      state,
      get: async () => {
        if (down) {
          throw new Error('offline');
        }
        return { enabled: true, turn: { state: 'working', startedAt: 'x' } };
      },
      tracesShown: () => true,
      threadRow: () => ({}),
      placeAgent: (k) => placed.push(state.agents.get(k).turn),
      agentDid: () => {},
      showSide: () => {},
      hidden: () => false,
      AGENT_POLL_MS: 1,
      AGENT_WAIT_MS: 1,
      AGENT_FAILS: 3,
      setTimeout: (f) => {
        timers.push(f);
        return timers.length;
      },
      clearTimeout: () => {},
    });
    await loadAgent('t');
    assert.equal(timers.length, 1);
    down = true;
    await loadAgent('t');
    assert.equal(timers.length, 2, 'asks again after a failure');
    await loadAgent('t');
    assert.equal(timers.length, 3);
    // The third failure: the spinner goes, and nothing is left running.
    await loadAgent('t');
    assert.equal(timers.length, 3);
    assert.equal(state.agents.get('t').turn, null);
    assert.equal(placed.pop(), null);
  });

  it('wiggles the sidebar\'s tab as the agent sets to work or is done, not as a thread opens', () => {
    const state = { open: 't' };
    let wiggles = 0;
    const { agentDid } = piece('// The open thread\'s agent, as the tab last knew it', '/** The tab wiggles, once', 'agentDid', {
      state, wiggleSideTab: () => { wiggles += 1; },
    });
    const working = { startedAt: 'a', state: 'working', text: 'Reading the thread' };
    agentDid('t', working);
    assert.equal(wiggles, 0, 'the thread just opened: where its agent was');
    agentDid('t', { ...working, text: 'Checking a web page' });
    assert.equal(wiggles, 0, 'not for what it says while it works');
    agentDid('t', { startedAt: 'a', state: 'done' });
    assert.equal(wiggles, 1, 'done');
    agentDid('t', { startedAt: 'b', state: 'working' });
    assert.equal(wiggles, 2, 'at work again');
    agentDid('u', { startedAt: 'c', state: 'working' });
    assert.equal(wiggles, 2, 'not another thread\'s');
    state.open = 'u';
    agentDid('u', { startedAt: 'c', state: 'working' });
    assert.equal(wiggles, 2, 'another thread opened');
    const { agentDid: fresh } = piece('// The open thread\'s agent, as the tab last knew it', '/** The tab wiggles, once', 'agentDid', {
      state, wiggleSideTab: () => { wiggles += 1; },
    });
    fresh('u', null);
    fresh('u', null);
    assert.equal(wiggles, 2, 'no agent, no wiggle');
  });

  it('puts the sidebar\'s tab on the thread\'s edge, and on the panel\'s while it is open', () => {
    const css = SCRIPTS['spectrum-inbox.css'];
    assert.match(css, /main\.siding #side-tab \{ margin-right: calc\(var\(--side-w\) \* var\(--side-open, 1\)\); \}/);
    assert.match(css, /#side-tab\[hidden\] \{ display: none; \}/);
    assert.match(css, /\.spectrum #side-tab\.wiggle \{ animation: side-tab-wiggle /);
    // Pulled, the panel's motion is where the pointer is: placeSidePanel leaves it there.
    assert.match(html, /if \(coming && side\.pulling\) drawSide\(\);/);
  });

  it('talks to the agent in the sidebar through its own route only, and says who did', () => {
    const from = html.indexOf('async function askSide');
    const ask = html.slice(from, html.indexOf('\n}\n', from));
    assert.match(ask, /request\('POST', '\/api\/agent\/sidebar'/);
    assert.doesNotMatch(ask, /\/api\/post|sendAsApp|postPending/);
    const { sidePeople } = piece('/** "Lena Berg", "You"', '/** One message of a sidebar conversation', 'sidePeople', {
      state: { me: { id: 1 } },
    });
    const said = (...people) => people.map((by) => ({ role: 'person', by }));
    const lena = { id: 2, name: 'Lena Berg' };
    const me = { id: 1, name: 'Dana Ops' };
    assert.equal(sidePeople([...said(lena), { role: 'agent' }, ...said(lena)]), 'Lena Berg');
    assert.equal(sidePeople(said(me)), 'You');
    assert.equal(sidePeople(said(me, lena)), 'Lena Berg and you');
    assert.equal(sidePeople(said(lena, { id: 3, name: 'Tom' }, me)), 'Lena Berg, Tom and you');
  });

  it('keeps a sidebar conversation one line, whoever joins it and whatever the thread says meanwhile', () => {
    const { sideConversations } = piece('// A pause this long between two sidebar messages', '/** "Lena Berg", "You"', 'sideConversations');
    const lena = { id: 2, name: 'Lena Berg' };
    const me = { id: 1, name: 'Dana Ops' };
    const at = (hm) => `2026-10-21T${hm}:00.000Z`;
    const ask = (id, by, hm) => ({
      id, role: 'person', by, at: at(hm),
    });
    const answer = (to, hm) => ({
      id: `${to}:answer`, role: 'agent', reply_to: to, at: at(hm),
    });
    const ids = (convs) => convs.map((c) => [c.run.map((m) => m.id), c.at, c.trailing, c.last]);
    // Lena asks, the thread goes on, you join an hour later: one conversation, where it was
    // last talked in, after the thread's message between.
    const joined = [ask('a', lena, '10:00'), answer('a', '10:01'), ask('b', me, '11:00'), answer('b', '11:01')];
    assert.deepEqual(ids(sideConversations(joined, [at('09:00'), at('10:30'), at('11:30')])), [
      [['a', 'a:answer', 'b', 'b:answer'], 2, false, true],
    ]);
    // After the thread's latest message: trailing, so that the sidebar goes on with it.
    assert.deepEqual(ids(sideConversations(joined, [at('09:00'), at('10:30')])), [
      [['a', 'a:answer', 'b', 'b:answer'], 2, true, true],
    ]);
    // Asked before the thread's message, answered after it: the answer goes with it.
    assert.deepEqual(ids(sideConversations(joined.slice(0, 2), ['2026-10-21T10:00:30.000Z'])), [
      [['a', 'a:answer'], 1, true, true],
    ]);
    // A long pause, with the thread's messages in it: a conversation of its own.
    const later = [...joined, ask('c', lena, '16:00'), answer('c', '16:01')];
    assert.deepEqual(ids(sideConversations(later, [at('10:30'), at('12:00')])), [
      [['a', 'a:answer', 'b', 'b:answer'], 1, false, false],
      [['c', 'c:answer'], 2, true, true],
    ]);
    // A long pause with nothing in the thread between is still one line, as it always was.
    assert.equal(sideConversations(later, [at('09:00')]).length, 1);
    // The agent's follow-up after the thread moved on: a line of its own.
    const followup = {
      id: 'a:followup:1', role: 'agent', reply_to: 'a', at: at('10:40'),
    };
    assert.deepEqual(ids(sideConversations([...joined.slice(0, 2), followup], [at('10:30')])), [
      [['a', 'a:answer'], 0, false, false],
      [['a:followup:1'], 1, true, true],
    ]);
    assert.deepEqual(sideConversations([], [at('10:00')]), []);
  });

  describe('the sidebar beside the thread, where there is room', () => {
    const lena = { id: 2, name: 'Lena Berg' };
    const run = [
      {
        id: 'sb1', role: 'person', by: lena, body: 'Seen before?', at: '2026-10-21T10:00:00.000Z',
      },
      {
        id: 'sb1:answer', role: 'agent', body: 'Twice.', state: 'done', reply_to: 'sb1', at: '2026-10-21T10:00:30.000Z',
      },
    ];
    /**
     * The sidebar's markup with `side` as it stands, for who may talk to the agent, or not, and
     * who may work the thread (`work`), or only see it.
     */
    const sidebar = (side, { may = true, work = true } = {}) => {
      const base = {
        side: { open: new Set(), ...side },
        state: { me: { id: 1 }, agents: new Map(), cache: new Map([['t', { data: { can_work: work } }]]) },
        canSide: () => may,
        avatar: (name) => `<i>${name}</i>`,
        AGENT_NAME: 'Thread Agent',
        SIDE_ICON: '',
        SIDE_HINT: '',
        PLATFORM: { slack: 'Slack' },
        esc: (x) => String(x),
        md: (x) => x,
        clock: () => '10:00 AM',
        timeTag: () => '<time>10:00 AM</time>',
        dayLabel: () => 'Today',
        // The commands and scripts the agent asked for there (test/ui-bashline.test.js).
        bashSideCards: () => [],
      };
      const globals = {
        ...base,
        ...piece('/**\n * Whether you may work thread `key`', '/** Whether thread `key` is in sidebar mode', 'canWork, sideOff, sideAudience, onlyTeam', base),
      };
      return {
        ...globals,
        ...piece('/** Whether thread `key` is in sidebar mode in the thread itself', '/** The reply box in sidebar mode', 'sideInline, sidePaneled, sideRun, sideGroup', globals),
        ...piece('/** The panel\'s top:', '/** The panel goes, with what it showed.', 'sidePanelHead, sidePanelItems, sidePanelBox', {
          ...globals, sideRun: (key, r) => r.map((m) => `<p>${m.body}</p>`),
        }),
      };
    };

    it('unfolds a conversation in the thread on a narrower screen, as before', () => {
      const { sideGroup, sideInline, sidePaneled } = sidebar({ wide: false, key: 't', open: new Set(['sb1']) });
      assert.equal(sideInline('t'), true);
      assert.equal(sidePaneled('t'), false);
      const line = sideGroup('t', run, { last: true, trailing: false });
      assert.match(line, /class="sidechat open /);
      assert.match(line, /aria-expanded="true"/);
      assert.doesNotMatch(line, /aria-controls/);
      assert.match(line, /<div class="sc-body">.*Seen before\?.*Twice\./s);
      // The one you are in stays open under the thread.
      assert.match(sideGroup('t', run, { last: true, trailing: true }), /class="sidechat open live /);
      // Nothing said yet: the place where it will show.
      assert.match(sideGroup('t', [], { last: true, trailing: true }), /class="sidechat open live blank"/);
    });

    it('keeps one line per conversation in the thread on a wide screen, for everyone, and shows the rest in the panel', () => {
      for (const may of [true, false]) {
        // Not in the sidebar: the line is all there is, and it opens the panel.
        const shut = sidebar({ wide: true, key: null, open: new Set(['sb1']) }, { may });
        const line = shut.sideGroup('t', run, { last: true, trailing: true });
        assert.match(line, /data-side-toggle="sb1" aria-expanded="false" aria-controls="side">/);
        assert.match(line, /Lena Berg had a sidebar conversation with <b>Thread Agent<\/b>/);
        assert.match(line, /2 messages · 10:00 AM · not posted/);
        assert.doesNotMatch(line, /sc-body|Seen before\?| open | live /);
        // In it: the same line, marked as shown beside the thread; never unfolded there too.
        const { sideGroup, sideInline, sidePaneled } = sidebar({ wide: true, key: 't' }, { may });
        assert.equal(sideInline('t'), false);
        assert.equal(sidePaneled('t'), true);
        assert.equal(sidePaneled('u'), false);
        const shown = sideGroup('t', run, { last: true, trailing: true });
        assert.match(shown, /class="sidechat {3}paneled /);
        assert.match(shown, /aria-expanded="true" aria-controls="side">/);
        assert.doesNotMatch(shown, /sc-body|Seen before\?|aria-disabled|joined/);
        // The line that opened the panel is one shape with it.
        const picked = sidebar({ wide: true, key: 't', joined: 'sb1' }, { may });
        assert.match(picked.sideGroup('t', run, { last: true, trailing: true }), /class="sidechat {3}paneled {2}joined" data-side="sb1">/);
        assert.doesNotMatch(sidebar({ wide: true, key: null, joined: 'sb1' }, { may }).sideGroup('t', run, { last: true, trailing: true }), /joined/);
      }
      // No thread, no panel.
      assert.equal(sidebar({ wide: true, key: null }).sidePaneled(null), false);
    });

    it('gives the panel every conversation, each under when it started, and a box of its own', () => {
      const { sidePanelHead, sidePanelItems, sidePanelBox } = sidebar({ wide: true, key: 't' });
      const later = [{
        id: 'sb2', role: 'person', by: lena, body: 'And now?', at: '2026-10-21T11:00:00.000Z',
      }];
      const items = sidePanelItems('t', [{ run, last: false }, { run: later, last: true }]).map((i) => i.html);
      assert.deepEqual(items.map((h) => (/^<div class="sp-when" data-run="(\w+)">/.exec(h) || [])[1] || h), [
        'sb1', '<p>Seen before?</p>', '<p>Twice.</p>', 'sb2', '<p>And now?</p>',
      ]);
      assert.match(items[0], /Today · 10:00 AM/);
      assert.match(sidePanelItems('t', [])[0].html, /class="sc-wait blank".*It is never posted\./);
      // It says who sees it, and where nothing goes, as the box in the thread does.
      assert.match(sidePanelHead('t', { source: 'slack' }), /Sidebar with Thread Agent<\/b><small>Only your team sees this\. Nothing goes to Slack\.<\/small>/);
      assert.match(sidePanelHead('t', { source: 'slack' }), /<button type="button" class="sp-close" data-side-exit [^>]*aria-label="Close the sidebar">/);
      // The thread keeps its reply box, with the draft's and the commands' lines: the panel's
      // box is the sidebar's only.
      const box = sidePanelBox('t');
      assert.equal(box.match(/id="side-reply"/g).length, 1);
      assert.match(box, /id="side-send"/);
      assert.doesNotMatch(box, /id="(draftbar|bashbar|reply|send)"|data-side-exit/);
      // Someone who may not talk to the agent reads there, and is told why, where the box was.
      const off = sidebar({ wide: true, key: 't' }, { may: false }).sidePanelBox('t');
      assert.doesNotMatch(off, /side-reply|side-send/);
      assert.match(off, /<div class="composer sidebar off" role="note"><p class="side-off">Thread Agent is off in this channel now, so it cannot be asked here\.<\/p><\/div>/);
    });

    it('tells who only sees the thread that its team sees the sidebar too, and why a folded one stops', () => {
      // An admin, or who talked in it before the channel moved to another team: they talk, and
      // the head says who else sees it.
      const seen = sidebar({ wide: true, key: 't' }, { work: false });
      assert.match(seen.sidePanelHead('t', { source: 'slack' }), /<small>Only the thread's team and you see this\. Nothing goes to Slack\.<\/small>/);
      assert.match(seen.sidePanelBox('t'), /id="side-reply"/);
      assert.match(seen.onlyTeam('grant it'), /^Only the thread's team can grant it: it is filed under a team you are not on\.$/);
      // Folded under the thread, where it cannot go on: why, instead of Continue.
      const shut = sidebar({ wide: false, key: null, open: new Set(['sb1']) }, { may: false });
      const line = shut.sideGroup('t', run, { last: true, trailing: false });
      assert.doesNotMatch(line, /sc-continue/);
      assert.match(line, /<div class="sc-foot"><span class="sc-wait">Thread Agent is off in this channel now, so it cannot be asked here\.<\/span><\/div>/);
      const open = sidebar({ wide: false, key: null, open: new Set(['sb1']) });
      assert.match(open.sideGroup('t', run, { last: true, trailing: false }), /data-side-enter>Continue in the sidebar/);
    });

    it('shows the panel where the list, the thread and it have room, measured from the list\'s left edge', () => {
      const room = (width, wideEnough = true) => {
        const main = { getBoundingClientRect: () => ({ right: 1000 + width + 16 }) };
        return piece('const SIDE_ROOM = ', '/** The room changed', 'sideRoom, SIDE_ROOM', {
          WIDE: { matches: wideEnough },
          document: { querySelector: () => main },
          getComputedStyle: () => ({ paddingRight: '16px' }),
          // The list's edge: the thread's moves as the panel shows, which must not matter.
          $: (id) => ({ getBoundingClientRect: () => ({ left: id === 'threads' ? 1000 : 0 }) }),
        });
      };
      const { SIDE_ROOM } = room(0);
      assert.equal(room(SIDE_ROOM).sideRoom(), true);
      assert.equal(room(SIDE_ROOM - 1).sideRoom(), false);
      // Under 1100px the filters are a drawer and the thread may be off the screen: never there.
      assert.equal(room(SIDE_ROOM, false).sideRoom(), false);
      // The list's and the panel's least widths leave the thread more than a phone gives it.
      assert.ok(SIDE_ROOM - 380 - 360 >= 440, 'the thread between the least list and panel');
    });

    it('shares the content area 3 : 5 : 3 between the list, the thread and the panel', () => {
      const css = SCRIPTS['spectrum-inbox.css'];
      // The list: 3 of the 11, of what the filters (or their rail) leave, not under its least.
      const least = 'calc\\(var\\(--spectrum-spacing-100\\) \\* 47 \\+ var\\(--spectrum-spacing-75\\)\\)';
      assert.match(css, new RegExp(`main\\.siding \\{ grid-template-columns: var\\(--nav-w\\) minmax\\(${least}, calc\\(34% \\+ \\(\\(100% - var\\(--nav-w\\)\\) \\* 3 / 11 - 34%\\) \\* var\\(--side-open, 1\\)\\)\\) 1fr; \\}`));
      assert.match(css, new RegExp(`\\nmain \\{ flex: 1; display: grid; grid-template-columns: var\\(--filters-w\\) minmax\\(${least}, 34%\\) 1fr;`));
      assert.match(css, /main \{ --nav-w: var\(--filters-w\); --side-w: /);
      assert.match(css, /main\.rail \{ --nav-w: var\(--rail\); \}/);
      // The panel: 3 of the 8 that are left, 360px to 560px.
      assert.match(css, /--side-w: clamp\(calc\(var\(--spectrum-spacing-100\) \* 45\), 37\.5%, calc\(var\(--spectrum-spacing-100\) \* 70\)\); \}/);
      assert.equal(3 / 8, 0.375);
    });

    it('puts the panel beside the thread, in the content area, and hides it everywhere else', () => {
      const css = SCRIPTS['spectrum-inbox.css'];
      assert.match(PAGES['inbox.html'], /<section id="pane" [^>]*>.*<\/section>\n {2}<section id="side" aria-label="Sidebar with Thread Agent" hidden><\/section>\n {2}<div id="side-join" aria-hidden="true" hidden><svg>.*<\/svg><\/div>\n {2}<button id="side-tab" [^>]*hidden><\/button>\n<\/main>/);
      assert.match(css, /#side \{ grid-row: 1; grid-column: 3; justify-self: end; width: var\(--side-w\);/);
      assert.match(css, /#side\[hidden\] \{ display: none; \}/);
      // It comes out of the line that opened it, and goes back into it.
      assert.match(PAGES['inbox.html'], /<div id="side-join" aria-hidden="true" hidden><svg><clipPath id="side-join-clip"><rect><\/rect><rect><\/rect><\/clipPath><path clip-path="url\(#side-join-clip\)"><\/path><\/svg><\/div>/);
      assert.match(css, /#side-join \{ position: absolute; z-index: 2; overflow: hidden; pointer-events: none; \}/);
      assert.match(css, /main\.side-veiled #side \{ opacity: 0; pointer-events: none; \}/);
      assert.match(css, /main \{ --side-motion: var\(--spectrum-animation-duration-1000\); \}/);
      // Another thread opens: the panel slides out, quicker, inert, its box not wired to that one.
      assert.match(css, /main \{ --side-leave: var\(--spectrum-animation-duration-300\); \}/);
      assert.match(html, /if \(away && !REDUCED_MOTION\.matches\) \{[^}]*panel\.inert = true;[^}]*moveSide\(0, \{ animate: true, leave: true \}\);/);
      assert.match(html, /getPropertyValue\(leave \? '--side-leave' : '--side-motion'\)/);
      assert.match(html, /if \(!box \|\| box\.closest\('\[inert\]'\)\) return;/);
      // The bridge from the joined line closes the panel: only its path takes the pointer.
      assert.match(css, /#side-join path \{ pointer-events: visiblePainted; cursor: pointer; \}/);
      assert.match(html, /\$\('side-join'\)\.onclick = \(e\) => \{\s*if \(e\.clientX >= panel\.getBoundingClientRect\(\)\.left\) return;\s*if \(sideMotion\.p === 1 && !sideMotion\.raf && sidePaneled\(state\.open\)\) exitSide\(\);/);
      assert.match(css, /\.spectrum #side \{[^}]*background: var\(--spectrum-purple-subtle-background-color-default\);/);
      assert.match(css, /main\.siding #pane \{ margin-right: calc\(var\(--side-w\) \* var\(--side-open, 1\)\); \}/);
      // The thread's reply box is the sidebar's only in the thread itself.
      assert.match(html, /const reply = sideInline\(key\) \? sideComposer\(key, thread\)\s*: composer\(/);
      // The panel is the open thread's: gone with it, and with the room.
      assert.match(html, /if \(!sidePaneled\(state\.open\)\) hideSidePanel\(\);/);
      assert.match(html, /if \(!sidePaneled\(key\)\) \{ hideSidePanel\(\); return; \}/);
      // A line in the thread opens the panel at its conversation, for anyone who sees it.
      assert.match(html, /if \(side\.wide\) \{ enterSide\(state\.open, \{ at: id \}\); return; \}/);
      // The line joined to the open panel is part of it: picked, it closes the panel.
      assert.match(html, /if \(side\.wide && sidePaneled\(state\.open\) && side\.joined === id\) \{ exitSide\(\); return; \}/);
      assert.match(html, /if \(!key \|\| !\(canSide\(key\) \|\| \(side\.wide && sideList\(key\)\.length\)\)\) return;/);
      // The icon beside the reply box, still there while the panel is open, closes it again.
      assert.match(html, /if \(enter\.matches\('\.sidebtn'\) && side\.key === state\.open\) exitSide\(\); else enterSide\(\);/);
    });
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

  it('counts what is unread still on the filter cards in unread only, the rows staying put', () => {
    // Unread only keeps the threads the list has shown, read ones too (keptUnread): a row's count
    // went down only on the next reload, not as you stepped through the list reading them.
    const state = {
      unread: true, sel: {}, not: {}, list: { held: new Set() },
    };
    let threads = [];
    const kept = (t) => t.unread || state.list.held.has(t.thread);
    const { facetRows } = piece('function facetRows', 'const cardFacets', 'facetRows', {
      state,
      listed: () => threads,
      passes: (t) => !state.unread || kept(t),
      unreadNow: (t) => t.unread,
      valuesOf: (f, t) => [f.value(t)],
      youCount: (t) => (t.unread ? t.you || 0 : 0),
      youTitle: (n) => `${n}`,
      statusOf: () => 'quiet',
      rowLabel: (f, v) => v,
      notButton: () => '',
      bar: () => '',
      esc: (s) => s,
      withOrg: (h) => h,
    });
    const customer = { id: 'customer', value: (t) => t.org };
    const counts = () => [...facetRows(customer).matchAll(/data-v="([^"]+)"[\s\S]*?<span class="n">(\d+)<\/span>/g)]
      .map((m) => `${m[1]}=${m[2]}`);
    const t = (thread, org, more = {}) => ({
      thread, org, unread: true, ...more,
    });
    threads = [t('a1', 'acme'), t('a2', 'acme'), t('a3', 'acme'), t('g1', 'globex'), t('g2', 'globex')];
    state.list.held = new Set(threads.map((x) => x.thread));
    assert.deepEqual(counts(), ['acme=3', 'globex=2']);
    // You read two of acme's: its count goes down, and it stays above globex until the list
    // lets go of them.
    threads[0].unread = false;
    threads[1].unread = false;
    assert.deepEqual(counts(), ['acme=1', 'globex=2']);
    threads[2].unread = false;
    assert.deepEqual(counts(), ['acme=0', 'globex=2']);
    // After a while away (forgetRead), the list lets go of them, and so does the card.
    state.list.held = new Set(['g1', 'g2']);
    assert.deepEqual(counts(), ['globex=2']);
    // Without unread only, a card counts every thread, read or not.
    state.unread = false;
    assert.deepEqual(counts(), ['acme=3', 'globex=2']);
  });

  it('looks at the list again as time passes, while it is on screen', () => {
    let tick = null;
    let every = 0;
    let renders = 0;
    let away = false;
    piece('// A thread\'s status depends on the time too', '// Away from the inbox', 'state', {
      setInterval: (f, ms) => {
        tick = f;
        every = ms;
      },
      hidden: () => away,
      state: { data: {} },
      render: () => {
        renders += 1;
      },
      STATUS_TICK_MS: 60000,
    });
    assert.equal(every, 60000);
    tick();
    assert.equal(renders, 1);
    away = true;
    tick();
    assert.equal(renders, 1);
  });

  it('lets go of the threads read meanwhile, and reloads, only after five minutes away', () => {
    // Not 0, which is "not away".
    let now = 1;
    let focused = true;
    let timer = null;
    let forgets = 0;
    let probes = 0;
    const changed = new Set();
    const on = {};
    const { awayOrBack } = piece('// Away from the inbox', 'document.addEventListener(\'visibilitychange\'', 'awayOrBack', {
      hidden: () => false,
      document: { hasFocus: () => focused },
      window: { addEventListener: (type, f) => { on[type] = f; } },
      setTimeout: (f, ms) => {
        if (!ms) {
          f();
          return null;
        }
        timer = { f, at: now + ms };
        return timer;
      },
      clearTimeout: () => { timer = null; },
      Date: { now: () => now },
      forgetRead: () => {
        forgets += 1;
        return true;
      },
      forgetColumn: () => {
        forgets += 1;
        return false;
      },
      render: () => {},
      probeSockets: () => { probes += 1; },
      changed,
      GAP: 'gap',
      state: { data: null },
    });
    // Another window for a minute, and back: nothing is let go of, nor reloaded; the sockets
    // are asked whether they are still there.
    focused = false;
    on.blur();
    now = 60 * 1000;
    focused = true;
    on.focus();
    assert.equal(timer, null);
    assert.equal(forgets, 0);
    assert.equal(probes, 1);
    assert.deepEqual([...changed], []);
    // Focus again without having left: not asked again.
    on.focus();
    assert.equal(probes, 1);
    // Away for longer: let go of while away, and again when back (for a timer that was late).
    focused = false;
    on.blur();
    assert.equal(timer.at, now + 5 * 60 * 1000);
    now = timer.at;
    timer.f();
    assert.equal(forgets, 2);
    focused = true;
    awayOrBack();
    assert.equal(forgets, 4);
    // And reloads, whatever was heard meanwhile: a socket may have lost it.
    assert.equal(probes, 2);
    assert.deepEqual([...changed], ['gap']);
  });

  it('outlines neighboring picked values as one, with no edge between them', () => {
    const css = SCRIPTS['spectrum-inbox.css'];
    assert.match(css, /\.fr\.on:has\(\+ \.fr\.on\)::after \{ border-bottom: 0; \}/);
    assert.match(css, /\.fr\.on \+ \.fr\.on::after \{ border-top: 0; \}/);
    assert.doesNotMatch(css, /\.fr\.on \{[^}]*box-shadow/);
  });

  it('shows every exclusion button of the slid-out rail on a touch screen', () => {
    const css = SCRIPTS['spectrum-inbox.css'];
    const touch = [...css.matchAll(/@media \(hover: none\) \{([^@]*?)\n\}/g)].map((m) => m[1]).join('\n');
    assert.match(touch, /main\.rail\.railopen #filters[^{]*\.fr \.not \{[^}]*pointer-events: auto/);
  });

  it('folds the filter column by the screen\'s width, up to a 13" MacBook\'s, but in the simple personal view', () => {
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
        matchMedia, document, simple: () => view === 'simple',
      });
      syncRail();
      assert.equal(classes.has('simple'), view === 'simple');
      return classes.has('rail');
    };
    for (const width of [390, 1099, 1440, 1470, 1512, 1920]) {
      assert.equal(railAt(width, 'simple'), false, `${width}px, the simple personal view`);
    }
    for (const view of ['expert', 'team']) {
      assert.equal(railAt(390, view), false, `iPhone, ${view}: the drawer`);
      assert.equal(railAt(1099, view), false, `under 1100px, ${view}: the drawer`);
      assert.equal(railAt(1440, view), true, `13" MacBook Pro, ${view}`);
      assert.equal(railAt(1470, view), true, `13" MacBook Air, ${view}`);
      assert.equal(railAt(1512, view), false, `14" MacBook Pro, ${view}`);
      assert.equal(railAt(1920, view), false, `desktop, ${view}`);
    }
  });

  it('tells what a reply box holds', () => {
    const { boxState } = piece('/**\n * What a reply box holds', '/** The composer state of a thread', 'boxState');
    assert.equal(boxState(undefined), 'empty');
    assert.equal(boxState({ text: '  ', from: '', base: null }), 'empty');
    assert.equal(boxState({ text: 'mine', from: '', base: null }), 'own');
    assert.equal(boxState({ text: 'draft', from: 'draft', base: 'v1' }), 'draft');
    assert.equal(boxState({ text: 'draft, edited', from: 'draft', base: 'v1' }), 'diverged');
  });

  it('tells where the file open in a knowledge base stands', () => {
    const kb = SCRIPTS['agent.js'];
    const from = kb.indexOf('/**\n * Where the open file stands');
    const to = kb.indexOf('/** Saves a pause after the last keystroke');
    // eslint-disable-next-line no-new-func
    const at = (f, { dirty = true, saving = null } = {}) => new Function('state', 'edited', `${kb.slice(from, to)}\nreturn fileState;`)({ file: f, saving }, () => dirty)();
    assert.equal(at({}, { dirty: false }), 'clean');
    assert.equal(at({ conflict: {} }, { dirty: false }), 'clean');
    assert.equal(at({}), 'editing');
    assert.equal(at({}, { saving: Promise.resolve() }), 'saving');
    assert.equal(at({ conflict: {}, problem: 'x' }), 'conflict');
    assert.equal(at({ choosePath: true }), 'unnamed');
    assert.equal(at({ problem: 'refused' }), 'problem');
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
    assert.ok(html.includes('if (personal()) return ts.sort((a, b) => activityOf(b).localeCompare(activityOf(a)));'));
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

  describe('the thread\'s header', () => {
    const header = () => piece('const HEAD_POSTS', 'const pct =', 'headLinks, headTech, headPosts, urlParts');
    const fact = (field, value) => ({ field, value });

    it('names the links by the page mentioned, else the site\'s production URL', () => {
      const { headLinks } = header();
      const site = fact('site', 'acme/www');
      // Only a site: its production URL.
      assert.deepEqual(headLinks([site]).map((l) => [l.group, l.href]), [['site', 'https://main--www--acme.aem.live/']]);
      // A page mentioned comes first, the one Clairic says is affected before the others; a
      // link to documentation or code is a reference, after the site; the ids come last.
      const links = headLinks([
        fact('cve', 'CVE-2026-1234'), fact('ticket', 'OPS-1'), site,
        fact('url', 'https://github.com/acme/www'), fact('url', 'https://www.aem.live/docs/cdn'),
        fact('url', 'https://www.acme.example/pricing'),
        fact('url', 'https://main--www--acme.aem.page/en/'),
        fact('affected_url', 'main--www--acme.aem.page/en'),
      ]);
      assert.deepEqual(links.map((l) => [l.group, l.text, l.note]), [
        ['mentioned', 'main--www--acme.aem.page/en', 'Affected page'],
        ['mentioned', 'www.acme.example/pricing', ''],
        ['site', 'main--www--acme.aem.live', 'Production'],
        ['reference', 'github.com/acme/www', ''],
        ['reference', 'www.aem.live/docs/cdn', ''],
        ['id', 'OPS-1', 'Ticket'],
        ['id', 'CVE-2026-1234', 'CVE'],
      ]);
      assert.equal(links.find((l) => l.text === 'OPS-1').href, null);
      assert.equal(links.find((l) => l.group === 'id' && l.href).href, 'https://www.cve.org/CVERecord?id=CVE-2026-1234');
      // What is no URL, and a site that is no `org/site`, are left out.
      assert.deepEqual(headLinks([fact('affected_url', 'the homepage'), fact('site', 'acme')]), []);
      assert.equal(links[0].host, 'main--www--acme.aem.page');
      assert.equal(links.find((l) => l.text === 'OPS-1').host, '');
    });

    it('lists a link once, however it is written, and not cut off where it is there whole', () => {
      const { headLinks } = header();
      const doc = 'https://acme.example/sites/web/Shared%20Documents/Plan.pdf';
      const links = headLinks([
        fact('url', doc),
        fact('url', 'http://ACME.example/sites/web/Shared%20Documents/Plan.pdf/'),
        fact('url', `${doc}%20`),
        fact('url', `${doc}.`),
        fact('url', 'https://acme.example/sites/web/Shared%20Doc…'),
        fact('url', 'https://acme.example/sites/web/Shared%20Documents/Plan.PDF'),
        fact('url', 'https://da.example/edit#…'),
        fact('url', 'https://da.example/edit#…'),
      ]);
      assert.deepEqual(links.map((l) => l.href), [
        doc,
        'https://acme.example/sites/web/Shared%20Documents/Plan.PDF',
        'https://da.example/edit#…',
      ]);
    });

    it('splits a link\'s address into its path and the page it names, decoded', () => {
      const { urlParts } = header();
      assert.deepEqual(urlParts('https://acme.example/sites/web/Shared%20Documents/Plan%20A.pdf'), {
        lead: 'acme.example/sites/web/Shared Documents', tail: '/Plan A.pdf',
      });
      assert.deepEqual(urlParts('https://acme.example/en/?q=a%20b#top'), { lead: 'acme.example', tail: '/en?q=a b#top' });
      assert.deepEqual(urlParts('https://acme.example/'), { lead: 'acme.example', tail: '' });
      assert.deepEqual(urlParts('https://da.example/#/org/site'), { lead: 'da.example', tail: '/#/org/site' });
    });

    it('names the tech stack by what the thread shows, then its topics; nothing of the channel\'s', () => {
      const { headTech } = header();
      const vocab = { tech: { eds: 'Edge Delivery', akamai: 'Akamai' }, topics: { cdn: 'CDN and caching' } };
      const data = {
        vocab,
        thread_tech: [{ tech: 'akamai', p: 0.9 }],
        tech: [{ tech: 'eds', p: 1 }, { tech: 'akamai', p: 0.95 }, { tech: 'fastly', p: 0.8 }],
        topics: ['cdn'],
      };
      const t = headTech(data);
      assert.equal(t.label, 'Akamai');
      assert.deepEqual(t.here.map((x) => [x.name, x.p]), [['Akamai', 0.9]]);
      // The channel's technologies are not the thread's: the customer's stack is its drawing.
      assert.deepEqual(t.also, []);
      assert.deepEqual(t.topics.map((x) => x.name), ['CDN and caching']);
      assert.equal(t.count, 2);
      // Nothing the thread shows: its first topic; with no topic either, nothing.
      assert.equal(headTech({ ...data, thread_tech: [] }).label, 'CDN and caching');
      assert.equal(headTech({ ...data, thread_tech: [], topics: [] }).label, '');
      assert.equal(headTech({ vocab, topics: ['cdn'] }).label, 'CDN and caching');
      assert.equal(headTech({ vocab }).count, 0);
    });

    it('lists a large group\'s first post and its latest', () => {
      const { headPosts } = header();
      const members = Array.from({ length: 30 }, (_, i) => ({ thread: `t${i}` }));
      const { posts, skipped } = headPosts(members);
      assert.equal(skipped, 18);
      assert.deepEqual(posts.map((m) => m.thread), ['t0', ...members.slice(19).map((m) => m.thread)]);
      assert.deepEqual(headPosts(members.slice(0, 2)), { posts: members.slice(0, 2), skipped: 0 });
    });
  });

  it('does not count weekends against normal threads waiting too long', () => {
    // Local times, so the test holds in any time zone. 6 November 2026 is a Friday.
    const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).getTime();
    const H = 3600000;
    const { waitedFor, computeStatus } = piece('const MIN = 60000;', 'const STATUS_ORDER', 'waitedFor, computeStatus', {
      viewerId: () => 'me',
      urgencyOf: (t) => t.urgency,
      signals: () => ({}),
      checked: () => false,
      waitingOn: (t) => t.on,
      lastOf: (t) => new Date(t.last).toISOString(),
      teamIds: () => new Set(),
    });
    assert.equal(waitedFor(at(6, 16), at(6, 18)), 2 * H);
    // Friday 16:00 to Monday 9:00: Friday's last eight hours and Monday's first nine.
    assert.equal(waitedFor(at(6, 16), at(9, 9)), 17 * H);
    // Asked on Saturday: the clock starts on Monday.
    assert.equal(waitedFor(at(7, 11), at(9, 2)), 2 * H);
    assert.equal(waitedFor(at(7, 11), at(8, 23)), 0);
    // Over two weekends: ten working days.
    assert.equal(waitedFor(at(6, 0), at(20, 0)), 10 * 24 * H);
    assert.equal(waitedFor(at(9, 9), at(9, 8)), 0);

    const real = Date.now;
    try {
      Date.now = () => at(9, 1);
      const t = (o) => ({
        on: 'Us', urgency: 'normal', last: at(7, 10), ...o,
      });
      // Asked on Saturday, Monday 1:00: an hour of the three a normal thread may wait.
      assert.equal(computeStatus(t()), 'quiet');
      assert.equal(computeStatus(t({ last: at(6, 20) })), 'waiting');
      // Critical and high run on the wall clock.
      assert.equal(computeStatus(t({ urgency: 'high' })), 'waiting');
      // The customer's day of silence does not pass on a weekend either.
      assert.equal(computeStatus(t({ on: 'Customer', last: at(6, 10) })), 'quiet');
      Date.now = () => at(9, 11);
      assert.equal(computeStatus(t({ on: 'Customer', last: at(6, 10) })), 'silent');
      // A vendor that has not answered for as long has gone silent too: chase it.
      assert.equal(computeStatus(t({ on: 'Vendor', last: at(6, 10) })), 'silent');
    } finally {
      Date.now = real;
    }
  });

  it('ranks a thread just resolved below the open ones of its pile', () => {
    const me = 'me';
    const { classicScore: baseScore } = piece('function closeness', '\nconst tpl', 'classicScore', {
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

  describe('thread list', () => {
    // The list's functions, on a fake inbox: `passes` filters on `customer` (and unread only, as
    // the page's does), `statusOf` is the thread's `status`, and a team's scores are `score`.
    function list({ personal = false } = {}) {
      let api;
      const state = {
        data: { team: 'ops', as: null, threads: [] },
        sel: {},
        not: {},
        unread: false,
        open: null,
        scores: new Map(),
      };
      const passes = (t) => (!state.unread || api.keptUnread(t))
        && (!state.mentions || t.mentionedMe)
        && (!state.sel.customer?.size || state.sel.customer.has(t.org));
      const names = 'newList, keptUnread, syncList, onList, viewSort, placeRows, forgetRead';
      api = piece('function newList(', '/** The rows in view', names, {
        state,
        passes,
        personal: () => personal,
        mentionsOn: () => personal && Boolean(state.mentions),
        scopeOf: (d) => d.team,
        activityOf: (t) => String(t.last_at || t.any_at || ''),
        smartScore: (t) => t.score,
        statusOf: (t) => t.status || 'quiet',
        sideCount: (t) => (t.sideNew || []).length,
      });
      state.list = api.newList();
      const shown = () => {
        api.syncList();
        const sorted = api.viewSort(state.data.threads.filter(api.onList));
        return api.placeRows(sorted).map((t) => t.thread);
      };
      const see = (...keys) => keys.forEach((k) => state.list.seen.add(k));
      return {
        state, shown, see, forgetRead: api.forgetRead,
      };
    }
    const thread = (key, o = {}) => ({
      thread: key, org: 'acme', unread: true, last_at: '2026-01-01T10:00:00Z', score: 1, ...o,
    });

    it('keeps a read row where it was, in a team view and in unread only', () => {
      const { state, shown, see } = list();
      state.unread = true;
      state.data.threads = [thread('a', { score: 3 }), thread('b', { score: 2 }), thread('c', { score: 1 })];
      assert.deepEqual(shown(), ['a', 'b', 'c']);
      see('a', 'b', 'c');
      // Read, it drops in score and is no longer unread (a live update after the read).
      state.data.threads[0] = thread('a', { score: 0, unread: false });
      assert.deepEqual(shown(), ['a', 'b', 'c']);
      // Unread only, turned off and on again: a new list, without the read thread.
      state.unread = false;
      shown();
      state.unread = true;
      assert.deepEqual(shown(), ['b', 'c']);
    });

    it('keeps a read thread with an answer to you in its sidebar you have not seen in unread only', () => {
      const { state, shown } = list();
      state.unread = true;
      state.data.threads = [
        thread('a', { score: 3, unread: false, sideNew: ['sb_1:answer'] }),
        thread('b', { score: 2, unread: false }),
      ];
      assert.deepEqual(shown(), ['a']);
    });

    it('lets go of the threads read meanwhile, after a while away, but not of the open one', () => {
      const {
        state, shown, see, forgetRead,
      } = list();
      state.unread = true;
      state.data.threads = [thread('a', { score: 3 }), thread('b', { score: 2 }), thread('c', { score: 1 })];
      assert.deepEqual(shown(), ['a', 'b', 'c']);
      see('a', 'b', 'c');
      state.open = 'b';
      state.data.threads[0] = thread('a', { score: 3, unread: false });
      state.data.threads[1] = thread('b', { score: 2, unread: false });
      assert.deepEqual(shown(), ['a', 'b', 'c']);
      assert.equal(forgetRead(), true);
      assert.deepEqual(shown(), ['b', 'c']);
      // Nothing more to let go of; and nothing without unread only.
      assert.equal(forgetRead(), false);
      state.unread = false;
      assert.equal(forgetRead(), false);
    });

    it('sorts the rows below the ones seen, and adds arrivals at the end of a team list', () => {
      const { state, shown, see } = list();
      state.data.threads = [thread('a', { score: 3 }), thread('b', { score: 2 }), thread('c', { score: 1 })];
      shown();
      see('a');
      state.data.threads[2] = thread('c', { score: 5 });
      state.data.threads.push(thread('new', { score: 9, last_at: '2026-01-01T11:00:00Z' }));
      assert.deepEqual(shown(), ['a', 'c', 'b', 'new']);
      // A critical one, though, comes in right below the rows seen.
      state.data.threads.push(thread('fire', { status: 'critical', last_at: '2026-01-01T12:00:00Z' }));
      assert.deepEqual(shown(), ['a', 'fire', 'c', 'b', 'new']);
    });

    it('puts arrivals at the top of the personal view, without moving the rows seen', () => {
      const { state, shown, see } = list({ personal: true });
      state.data.threads = [thread('a', { last_at: '2026-01-01T10:02:00Z' }),
        thread('b', { last_at: '2026-01-01T10:01:00Z' }), thread('c', { last_at: '2026-01-01T10:00:00Z' })];
      assert.deepEqual(shown(), ['a', 'b', 'c']);
      see('a', 'b');
      // b has a new message: seen, it stays; c, below, comes up to the top, and so does a new one.
      state.data.threads[1] = thread('b', { last_at: '2026-01-01T11:00:00Z' });
      state.data.threads[2] = thread('c', { last_at: '2026-01-01T11:01:00Z' });
      state.data.threads.push(thread('new', { last_at: '2026-01-01T11:02:00Z' }));
      assert.deepEqual(shown(), ['new', 'c', 'a', 'b']);
    });

    it('keeps the open thread through a filter change only if it passes the new filters', () => {
      const { state, shown } = list();
      state.unread = true;
      state.data.threads = [thread('acme1', { unread: false }), thread('globex1', { org: 'globex' }),
        thread('globex2', { org: 'globex', unread: false })];
      state.open = 'acme1';
      state.sel.customer = new Set(['globex']);
      assert.deepEqual(shown(), ['globex1']);
      state.open = 'globex2';
      state.sel.customer = new Set(['globex', 'initech']);
      assert.deepEqual(shown(), ['globex1', 'globex2']);
    });

    it('is a new list when Mentions goes on or off in the personal view', () => {
      const { state, shown, see } = list({ personal: true });
      state.data.threads = [thread('a', { last_at: '2026-01-01T10:02:00Z' }),
        thread('b', { last_at: '2026-01-01T10:01:00Z', mentionedMe: true })];
      assert.deepEqual(shown(), ['a', 'b']);
      see('a', 'b');
      // The rows the list has shown would stay; Mentions starts it afresh, with only b.
      state.mentions = true;
      assert.deepEqual(shown(), ['b']);
      state.mentions = false;
      assert.deepEqual(shown(), ['a', 'b']);
    });
  });
});
