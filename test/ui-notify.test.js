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
 * A click on a notification (ui/inbox.js, noteView and openFromNote; src/pwa.js, the service
 * worker's notificationclick): it keeps you in the view on screen, with its filters, when that
 * view can show the thread, and only otherwise switches, to the closest view, Personal first.
 * The page's own code, in pieces, run in Node with what they need of the rest of the page stubbed.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';
import { SERVICE_WORKER } from '../src/pwa.js';

const js = SCRIPTS['inbox.js'];
const slice = (from, to) => {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  return js.slice(a, b);
};

const PERSONAL_VIEW = '~personal';
let state;
let switched;
let opened;
let shown;

/** The notification pieces of the page, on `state`. */
function page(extra = {}) {
  const src = [
    slice('const noteUrl = ', "/**\n * The notifications' sound"),
    slice('async function openFromNote', '/** Text for a notification'),
    slice('async function noteMessage', '/**\n * Whether thread `t` of inbox `data`'),
    slice('function checkBells', '/** A room announced activity'),
  ].join('\n');
  const personal = () => state.sort === 'personal';
  const globals = {
    state: new Proxy({}, {
      get: (_, k) => state[k],
      set: (_, k, v) => {
        state[k] = v;
        return true;
      },
    }),
    PERSONAL_VIEW,
    personal,
    scopeKey: () => (personal() ? PERSONAL_VIEW : state.team),
    switchView: async (slug) => {
      switched.push(slug);
      state.sort = slug ? 'team' : 'personal';
      if (slug) {
        state.team = slug;
      }
      state.data = { threads: [] };
    },
    openThread: (key) => opened.push([key, personal() ? PERSONAL_VIEW : state.team, state.sel]),
    window: { focus: () => {} },
    location: { href: 'https://inbox.example/inbox' },
    notifying: () => true,
    get: async () => extra.thread || null,
    plain: (s) => s,
    orgName: () => 'ACME',
    noteText: () => ({ title: 't', body: 'b' }),
    showNote: (n) => shown.push(n),
    watch: { known: new Map(), since: '2026-01-01T00:00Z' },
    lastOf: (t) => t.last_at,
    inBell: () => true,
    preview: () => null,
  };
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${src}\nreturn { noteUrl, noteView, openFromNote, noteMessage, checkBells };`)(
    ...Object.values(globals),
  );
}

const TEAMS = [{ slug: 'helix' }, { slug: 'edge' }];
const entry = (thread, more = {}) => ({ thread, members: [{ thread }], ...more });

beforeEach(() => {
  switched = [];
  opened = [];
  shown = [];
  state = {
    teams: TEAMS,
    team: 'helix',
    sort: 'personal',
    sel: { customer: new Set(['acme']) },
    data: { threads: [] },
    me: { id: 7 },
    settings: { mentions: true, threads: true },
  };
});

describe('a click on a notification', () => {
  it('stays in Personal for a mention a team inbox has too', async () => {
    const { openFromNote } = page();
    await openFromNote('/inbox?team=helix&t=x', [PERSONAL_VIEW, 'helix']);
    assert.deepEqual(switched, [], 'no other view');
    assert.deepEqual(opened.map(([k, v]) => [k, v]), [['x', PERSONAL_VIEW]]);
  });

  it('stays in the team inbox on screen, with its filters, when it has the thread', async () => {
    state.sort = 'team';
    state.team = 'edge';
    const { openFromNote } = page();
    const { sel } = state;
    await openFromNote('/inbox?view=personal&t=x', [PERSONAL_VIEW, 'helix', 'edge']);
    assert.deepEqual(switched, []);
    assert.deepEqual(opened, [['x', 'edge', sel]]);
  });

  it('stays in a view that has the thread loaded, though the notification did not name it', async () => {
    state.sort = 'team';
    state.team = 'edge';
    state.data = { threads: [entry('root', { members: [{ thread: 'root' }, { thread: 'x' }] })] };
    const { openFromNote } = page();
    await openFromNote('/inbox?team=helix&t=x', ['helix']);
    assert.deepEqual(switched, []);
    assert.deepEqual(opened.map(([k, v]) => [k, v]), [['x', 'edge']]);
  });

  it('switches to the closest view that can show it, Personal first', async () => {
    state.sort = 'team';
    state.team = 'edge';
    const { openFromNote } = page();
    await openFromNote('/inbox?team=helix&t=x', [PERSONAL_VIEW, 'helix']);
    assert.deepEqual(switched, [null]);
    assert.deepEqual(opened.map(([k, v]) => [k, v]), [['x', PERSONAL_VIEW]]);
  });

  it('switches to a bell\'s team, which Personal cannot show', async () => {
    const { openFromNote } = page();
    await openFromNote('/inbox?team=helix&t=x', ['helix']);
    assert.deepEqual(switched, ['helix']);
    assert.deepEqual(opened.map(([k, v]) => [k, v]), [['x', 'helix']]);
  });

  it('does not take an alert loaded in Personal for one it shows', async () => {
    state.data = { threads: [entry('x', { kind: 'alert' })] };
    const { openFromNote } = page();
    await openFromNote('/inbox?team=helix&t=x', ['helix']);
    assert.deepEqual(switched, ['helix']);
  });

  it('reads a notification without views from its address, and stays if that is the view', async () => {
    const { openFromNote } = page();
    await openFromNote('/inbox?view=personal&t=x');
    assert.deepEqual(switched, []);
    await openFromNote('/inbox?team=edge&t=y');
    assert.deepEqual(switched, ['edge']);
    assert.deepEqual(opened.map(([k]) => k), ['x', 'y']);
  });

  it('opens it on screen when no view of yours can show it', async () => {
    state.sort = 'team';
    const { openFromNote } = page();
    state.teams = [{ slug: 'edge' }];
    state.team = 'edge';
    await openFromNote('/inbox?team=helix&t=x', ['helix']);
    // The view on screen cannot show it, and no view of yours can: it stays, and opens it there.
    assert.deepEqual(switched, []);
    assert.deepEqual(opened.map(([k, v]) => [k, v]), [['x', 'edge']]);
  });
});

describe('a notification\'s views and address', () => {
  it('a mention: Personal, then the room\'s team and the other teams that have it', async () => {
    state.sort = 'team';
    state.team = 'edge';
    const { noteMessage } = page({ thread: { thread: { kind: 'channel', teams: ['helix', 'edge', 'other'] }, messages: [] } });
    await noteMessage({
      type: 'thread', thread: 'x', mentions: [7], involved: [], by: 8, at: '2026-11-05T10:00Z',
    }, 'helix');
    assert.deepEqual(shown[0].views, [PERSONAL_VIEW, 'helix', 'edge']);
  });

  it('an alert is not in Personal', async () => {
    const { noteMessage } = page({ thread: { thread: { kind: 'alert', teams: ['helix'] }, messages: [] } });
    await noteMessage({
      type: 'thread', thread: 'x', mentions: [7], by: 8, at: '2026-11-05T10:00Z',
    }, 'helix');
    assert.deepEqual(shown[0].views, ['helix']);
  });

  it('a room of a team you are not on: Personal', async () => {
    const { noteMessage } = page();
    await noteMessage({
      type: 'thread', thread: 'x', involved: [7], by: 8, at: '2026-11-05T10:00Z',
    }, 'elsewhere');
    assert.deepEqual(shown[0].views, [PERSONAL_VIEW]);
  });

  it('a bell: its view, then the team the thread is filed under', () => {
    state.settings.bells = [{ view: 'edge', sel: {}, not: {} }];
    const { checkBells } = page();
    checkBells('edge', {
      threads: [{
        thread: 'x', team: 'helix', unread: true, last_at: '2026-11-05T10:00Z',
      }],
    });
    assert.deepEqual(shown[0].views, ['edge', 'helix']);
  });

  it('the address a new window opens: the view on screen if it can show it, else the closest', () => {
    const { noteUrl, noteView } = page();
    const url = (views) => noteUrl(noteView(views, 'x'), 'x');
    assert.equal(url([PERSONAL_VIEW, 'helix']), '/inbox?view=personal&t=x');
    assert.equal(url(['helix']), '/inbox?team=helix&t=x');
    state.sort = 'team';
    state.team = 'edge';
    assert.equal(url([PERSONAL_VIEW, 'edge']), '/inbox?team=edge&t=x');
    assert.equal(url([PERSONAL_VIEW, 'helix']), '/inbox?view=personal&t=x');
  });
});

describe('the service worker\'s notification click', () => {
  /** The worker, run on a fake `self` with `windows` open; a click on a notification of `data`. */
  async function click(windows, data) {
    const on = {};
    const posted = [];
    const openedWindows = [];
    const self = {
      location: { origin: 'https://inbox.example' },
      addEventListener: (type, f) => { on[type] = f; },
      skipWaiting: () => {},
      clients: {
        claim: () => {},
        matchAll: async () => windows.map((w) => ({
          ...w, focus: async () => {}, postMessage: (m) => posted.push([w.url, m]),
        })),
        openWindow: async (u) => openedWindows.push(u),
      },
    };
    // eslint-disable-next-line no-new-func
    new Function('self', SERVICE_WORKER)(self);
    let done;
    on.notificationclick({
      notification: { data, close: () => {} },
      waitUntil: (p) => {
        done = p;
      },
    });
    await done;
    return { posted, openedWindows };
  }

  it('hands the views to the inbox open, which decides where it opens', async () => {
    const data = { url: '/inbox?view=personal&t=x', views: [PERSONAL_VIEW, 'helix'] };
    const { posted, openedWindows } = await click([
      { url: 'https://inbox.example/inbox/kb' },
      { url: 'https://inbox.example/inbox?team=edge', focused: true },
    ], data);
    assert.deepEqual(openedWindows, []);
    assert.deepEqual(posted, [['https://inbox.example/inbox?team=edge', {
      type: 'opspile:open', url: 'https://inbox.example/inbox?view=personal&t=x', views: [PERSONAL_VIEW, 'helix'],
    }]]);
  });

  it('opens the notification\'s address in a new window when no inbox is open', async () => {
    const { posted, openedWindows } = await click([], { url: '/inbox?team=helix&t=x', views: ['helix'] });
    assert.deepEqual(posted, []);
    assert.deepEqual(openedWindows, ['https://inbox.example/inbox?team=helix&t=x']);
  });
});
