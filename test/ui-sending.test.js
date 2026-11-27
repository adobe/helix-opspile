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
 * Replies being sent, kept in localStorage until they are back from the platform (ui/inbox.js,
 * "replies kept until they arrive"): a reload shows them again, one that was on its way as
 * unsure, one the platform took as waiting; other tabs follow. The page's own code, its block
 * cut out and run in Node with what it needs of the page stubbed. Made-up threads and people.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-21T12:00:00Z');

let storage;
let listeners;
let opened;
let timers;

/** What a tab of `state` has of the browser: the store it shares with other tabs, and `window`. */
function tab(state) {
  const tell = (e) => {
    for (const [l, from] of listeners) {
      if (from !== state) {
        l(e);
      }
    }
  };
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => {
      storage.set(k, v);
      tell({ key: k, newValue: v });
    },
    removeItem: (k) => {
      storage.delete(k);
      tell({ key: k, newValue: null });
    },
  };
  const window = { addEventListener: (type, l) => listeners.push([l, state]) };
  return { localStorage, window };
}

/** A page: its state, the store it shares with other tabs, and the block's functions. */
function page(state) {
  const a = js.indexOf('// ---------------------------------------------------------------- replies kept until they arrive');
  const b = js.indexOf('// Leaving the page (a reload', a);
  assert.ok(a >= 0 && b > a);
  const { localStorage, window } = tab(state);
  // eslint-disable-next-line no-new-func
  return new Function('state', 'localStorage', 'window', 'openThread', 'showSending', 'setTimeout', 'Date', 'STARTED', 'NEW', 'SEND_KEEP_MS', 'SEND_ARRIVE_MS', 'SEND_APP_ARRIVE_MS', `${js.slice(a, b)}
return { keptReply, restoredReply, saveSending, restoreSending };`)(
    state,
    localStorage,
    window,
    (key) => opened.push(key),
    (key) => opened.push(`shown ${key}`),
    (fn, ms) => timers.push({ fn, ms }),
    { now: () => NOW, parse: Date.parse },
    'started',
    'new',
    DAY,
    60 * 1000,
    3 * 60 * 1000,
  );
}

/**
 * A page's sending, from a reply's bubble to its post ("Sending, as in iMessage" up to new
 * threads), on the real clock: `post` answers its POSTs, which `posts` records.
 */
function sender(state, post, posts = []) {
  const a = js.indexOf('// Sending, as in iMessage');
  const b = js.indexOf('// ---------------------------------------------------------------- new threads', a);
  assert.ok(a >= 0 && b > a);
  const globals = {
    state,
    ...tab(state),
    matchMedia: () => ({ matches: true }),
    postWith: (path, payload, files) => {
      posts.push({ path, payload, files });
      return post(path, payload, files);
    },
    openThread: () => {},
    setTimeout: () => {},
    toast: () => {},
    startedShown: () => false,
    started: null,
    STARTED: 'started',
    NEW: 'new',
    mentionKindOf: () => null,
    invitedSaying: () => '',
    remindSaying: () => '',
    missedMention: () => false,
    setCachedDraft: () => {},
  };
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${js.slice(a, b)}
return { sendAsApp, retrySend, restoreSending, sendQueue };`)(...Object.values(globals));
}

const reply = (more = {}) => ({
  thread: 'slack:E1:C1:1.1',
  body: 'On it.',
  mentions: [],
  kinds: {},
  at: new Date(NOW - 5000).toISOString(),
  id: 'pending-1',
  key: 'k-1',
  source: 'slack',
  status: 'sending',
  author: { kind: 'person', name: 'Ada' },
  files: [],
  uploads: [],
  ...more,
});
const fresh = () => ({
  me: { id: 7 }, as: null, sending: [], open: null, cache: new Map(),
});

beforeEach(() => {
  storage = new Map();
  listeners = [];
  opened = [];
  timers = [];
});

describe('replies kept until they arrive', () => {
  it('shows a reply that was on its way after a reload, unsure, with its key', () => {
    const before = fresh();
    page(before);
    before.sending.push(reply());
    page(before).saveSending();
    assert.ok(storage.has('opspile.sending.7'));

    const after = fresh();
    page(after).restoreSending();
    assert.equal(after.sending.length, 1);
    const [p] = after.sending;
    assert.equal(p.status, 'unknown');
    assert.equal(p.key, 'k-1');
    assert.equal(p.asked, false);
    assert.match(p.error, /page was left/);
    assert.equal(p.filesLost, undefined);
  });

  it('says when a restored reply is late to come back', () => {
    const before = fresh();
    before.sending.push(reply({ status: 'sent', postedId: '1.9', sentAt: NOW - 20 * 1000 }));
    page(before).saveSending();
    page(fresh()).restoreSending();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 40 * 1000 + 500);
    timers[0].fn();
    assert.deepEqual(opened, ['shown slack:E1:C1:1.1']);
  });

  it('keeps one the platform took waiting for its message, for a day', () => {
    const sent = reply({ status: 'sent', postedId: '1.9', sentAt: NOW - 1000 });
    const { restoredReply } = page(fresh());
    const p = restoredReply(page(fresh()).keptReply(sent));
    assert.equal(p.status, 'delivered');
    assert.equal(p.postedId, '1.9');
    assert.equal(restoredReply({ ...sent, sentAt: NOW - DAY }), null);
    // One that did not go out stays up to a week, for the person to decide.
    assert.ok(restoredReply(reply({ status: 'failed', at: new Date(NOW - 3 * DAY).toISOString() })));
    assert.equal(restoredReply(reply({ status: 'failed', at: new Date(NOW - 8 * DAY).toISOString() })), null);
  });

  it('keeps no file bytes: one with files that did not go out cannot go again', () => {
    const { keptReply, restoredReply } = page(fresh());
    const o = keptReply(reply({ files: [{ name: 'a.png', type: 'image/png', url: 'blob:x' }], uploads: [{}] }));
    assert.deepEqual(o.files, [{ name: 'a.png', type: 'image/png' }]);
    assert.equal(o.uploads, undefined);
    assert.equal(restoredReply(o).filesLost, true);
    assert.equal(restoredReply({ ...o, status: 'sent', sentAt: NOW }).filesLost, undefined);
  });

  it('keeps no new thread, and nothing while viewing as someone else', () => {
    const s = fresh();
    s.sending.push(reply({ thread: 'started', id: 'pending-2' }), reply({ id: 'pending-3', started: {} }));
    page(s).saveSending();
    assert.equal(storage.size, 0);
    const as = { ...fresh(), as: 9 };
    as.sending.push(reply());
    page(as).saveSending();
    assert.equal(storage.size, 0);
  });

  it('drops a reply from the store once it is gone here, and leaves other tabs\' alone', () => {
    const one = fresh();
    const two = fresh();
    const p1 = page(one);
    const p2 = page(two);
    one.sending.push(reply());
    p1.saveSending();
    two.sending.push(reply({ id: 'pending-9', body: 'Other tab.' }));
    p2.saveSending();
    assert.deepEqual(Object.keys(JSON.parse(storage.get('opspile.sending.7'))).sort(), ['pending-1', 'pending-9']);
    // It arrived here.
    one.sending = [];
    p1.saveSending();
    assert.deepEqual(Object.keys(JSON.parse(storage.get('opspile.sending.7'))), ['pending-9']);
  });

  it('follows another tab: a reply gone there goes here, one that went out there shows so', () => {
    const one = fresh();
    const p1 = page(one);
    one.sending.push(reply({ status: 'failed', error: 'Slack: x' }), reply({ id: 'pending-2', status: 'failed', error: 'Slack: y' }));
    p1.saveSending();
    const two = fresh();
    two.open = 'slack:E1:C1:1.1';
    two.cache.set(two.open, {});
    const p2 = page(two);
    p2.restoreSending();
    assert.equal(two.sending.length, 2);
    // The first tab retried one, which went out, and discarded the other.
    one.sending[0] = {
      ...one.sending[0], status: 'sent', postedId: '1.9', sentAt: NOW,
    };
    one.sending.pop();
    p1.saveSending();
    assert.equal(two.sending.length, 1);
    assert.equal(two.sending[0].status, 'delivered');
    assert.equal(two.sending[0].postedId, '1.9');
    assert.ok(opened.includes('slack:E1:C1:1.1'));
  });
});

describe('a reply as the bot that a page left behind', () => {
  const THREAD = 'slack:E1:C1:1.1';
  const ok = { ok: true, status: 200, data: { ok: true, id: '1.9', text: 'On it.' } };

  /** Sends "On it." as the bot and leaves the page while it goes: the post it made. */
  function left(files = []) {
    const posts = [];
    sender(fresh(), () => new Promise(() => {}), posts)
      .sendAsApp(THREAD, 'On it.', null, { mentions: [], files });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, '/api/post/app');
    assert.equal(typeof posts[0].payload.key, 'string');
    return posts[0];
  }

  /** The next page, answering its posts with `answers` in turn: its reply restored, retried. */
  function next(...answers) {
    const state = fresh();
    const posts = [];
    const page2 = sender(state, async () => answers.shift(), posts);
    page2.restoreSending();
    assert.equal(state.sending.length, 1);
    const [p] = state.sending;
    const retry = async () => {
      page2.retrySend(p.id);
      await Promise.all(page2.sendQueue.values());
    };
    return { p, posts, retry };
  }

  it('is retried as the bot, under the key it was sent with', async () => {
    const first = left();
    const { p, posts, retry } = next(ok);
    assert.equal(p.status, 'unknown');
    assert.equal(p.app, true);
    assert.equal(p.key, first.payload.key);
    await retry();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, '/api/post/app');
    assert.equal(posts[0].payload.key, first.payload.key);
    assert.equal(posts[0].payload.thread, THREAD);
    assert.equal(posts[0].payload.text, 'On it.');
    assert.equal(p.status, 'delivered');
    assert.equal(p.postedId, '1.9');
  });

  it('goes under a new key, still as the bot, once only the person can decide', async () => {
    const first = left();
    const unfinished = {
      ok: false, status: 409, data: { error: 'this reply may have gone out: the first try did not finish', unknown: true },
    };
    const { p, posts, retry } = next(unfinished, ok);
    await retry();
    assert.equal(p.status, 'unknown');
    assert.equal(p.asked, true);
    await retry();
    assert.deepEqual(posts.map((x) => x.path), ['/api/post/app', '/api/post/app']);
    assert.equal(posts[0].payload.key, first.payload.key);
    assert.notEqual(posts[1].payload.key, first.payload.key);
    assert.equal(p.status, 'delivered');
  });

  it('cannot go again with files, which stayed with the page it left', async () => {
    const first = left([{ name: 'a.png', type: 'image/png', size: 3 }]);
    assert.deepEqual(first.files.map((f) => f.name), ['a.png']);
    const { p, posts, retry } = next(ok);
    assert.equal(p.filesLost, true);
    assert.deepEqual(p.files, [{ name: 'a.png', type: 'image/png' }]);
    await retry();
    assert.equal(posts.length, 0);
  });

  it('leaves a reply as you to go as you', async () => {
    storage.set('opspile.sending.7', JSON.stringify({ 'pending-1': reply({ at: new Date().toISOString() }) }));
    const { posts, retry } = next(ok);
    await retry();
    assert.equal(posts[0].path, '/api/post');
    assert.equal(posts[0].payload.key, 'k-1');
  });
});
