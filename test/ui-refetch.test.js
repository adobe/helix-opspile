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
 * The open thread's fetch (ui/inbox.js, `get`, `transient`, `refetchLater`, `refetchDone`,
 * `fetchFailed`; docs/STATE-MACHINES.md, "Open thread's fetch"): a refresh that fails in a way
 * asking again may mend (D1 busy, a 5xx, the network) keeps what the pane shows and is asked
 * again after 1, 2, 4… s, 30 s at most, while the thread stays open. A 4xx replaces the pane,
 * and an expired sign-in keeps it without asking again.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];
const between = (from, to) => {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to}`);
  return js.slice(a, b);
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** `get` through to `fetchFailed`, with fake timers, `fetch`, and `openThread`. */
function load({ answer = null, random = 0 } = {}) {
  const timers = [];
  const opened = [];
  const state = { open: null, as: null };
  const fakeTimeout = (fn, ms) => {
    timers.push({ fn, ms, cleared: false });
    return timers.length;
  };
  const fakeClear = (id) => {
    if (timers[id - 1]) {
      timers[id - 1].cleared = true;
    }
  };
  const fakeFetch = async () => answer;
  const math = Object.create(Math, { random: { value: () => random } });
  // eslint-disable-next-line no-new-func
  const api = new Function('state', 'esc', 'fetch', 'setTimeout', 'clearTimeout', 'Math', 'openThread', `
    ${between('async function get(path)', '// Dates and times:')}
    ${between('/**\n * The open thread, when fetching it failed', 'async function openThread(')}
    return { get, transient, refetch, refetchLater, refetchDone, fetchFailed };`)(
    state,
    esc,
    fakeFetch,
    fakeTimeout,
    fakeClear,
    math,
    (key, opts) => opened.push([key, opts]),
  );
  const pending = () => timers.filter((t) => !t.cleared);
  return {
    ...api, state, timers, pending, opened,
  };
}
const res = (status, body) => ({ ok: status < 400, status, json: async () => body });
const pane = (key) => ({ __key: key, innerHTML: '<div class="ph"></div>' });
const busy = () => Object.assign(new Error('The inbox is busy: try again in a moment.'), { status: 503, busy: true });

describe('the open thread\'s fetch', () => {
  it('says how it failed: the status, and whether D1 was busy', async () => {
    const t = load({ answer: res(503, { error: 'The inbox is busy: try again in a moment.', busy: true }) });
    const e = await t.get('/api/thread?thread=x').catch((x) => x);
    assert.equal(e.message, 'The inbox is busy: try again in a moment.');
    assert.equal(e.status, 503);
    assert.equal(e.busy, true);
    const gone = await load({ answer: res(404, { error: 'not found' }) }).get('/x').catch((x) => x);
    assert.deepEqual([gone.message, gone.status, gone.busy], ['not found', 404, false]);
  });

  it('is asked again only for what asking again may mend', () => {
    const { transient } = load();
    for (const status of [500, 502, 503, 429]) {
      assert.equal(transient({ status }), true, status);
    }
    assert.equal(transient(new TypeError('Failed to fetch')), true, 'the network');
    for (const status of [400, 403, 404]) {
      assert.equal(transient({ status }), false, status);
    }
    assert.equal(transient(Object.assign(new Error('Signed out'), { signedOut: true })), false);
    assert.equal(transient(new SyntaxError('Unexpected token')), false, 'an answer that was no JSON');
  });

  it('keeps the thread on screen while D1 is busy, and asks again after 1, 2, 4… s, 30 s at most', () => {
    const t = load();
    t.state.open = 'a';
    const p = pane('a');
    assert.equal(t.fetchFailed(p, 'a', busy()), 'kept');
    assert.equal(p.innerHTML, '<div class="ph"></div>', 'the thread stays');
    assert.equal(p.__key, 'a'); // eslint-disable-line no-underscore-dangle
    for (let i = 1; i < 8; i += 1) {
      t.fetchFailed(p, 'a', busy());
    }
    const waits = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
    assert.deepEqual(t.timers.map((x) => x.ms), waits);
    assert.equal(t.pending().length, 1, 'one retry at a time');
    t.pending()[0].fn();
    assert.deepEqual(t.opened, [['a', { live: true }]]);
  });

  it('waits up to a second more at random, so tabs turned away together come back apart', () => {
    const t = load({ random: 0.5 });
    t.fetchFailed(pane('a'), 'a', busy());
    assert.equal(t.timers[0].ms, 1500);
  });

  it('says the inbox is busy with nothing of the thread on screen, and still asks again', () => {
    const t = load();
    const p = pane('b');
    assert.equal(t.fetchFailed(p, 'a', busy()), 'shown');
    assert.equal(p.innerHTML, '<div class="empty">The inbox is busy: trying again in a moment…</div>');
    assert.equal(p.__key, null); // eslint-disable-line no-underscore-dangle
    assert.equal(t.pending().length, 1);
  });

  it('replaces the thread when it is gone or not allowed, without asking again', () => {
    const t = load();
    const p = pane('a');
    assert.equal(t.fetchFailed(p, 'a', Object.assign(new Error('not found'), { status: 404 })), 'shown');
    assert.equal(p.innerHTML, '<div class="empty">not found</div>');
    assert.equal(t.timers.length, 0);
  });

  it('keeps the thread under the sign-in banner, without asking again', () => {
    const t = load();
    const p = pane('a');
    const out = Object.assign(new Error('Signed out: sign in again'), { signedOut: true });
    assert.equal(t.fetchFailed(p, 'a', out), 'kept');
    assert.equal(p.innerHTML, '<div class="ph"></div>');
    assert.equal(t.timers.length, 0);
  });

  it('stops asking once fetched, and does not ask for a thread no longer open', () => {
    const t = load();
    t.state.open = 'a';
    t.fetchFailed(pane('a'), 'a', busy());
    t.fetchFailed(pane('a'), 'a', busy());
    t.refetchDone('b');
    assert.equal(t.pending().length, 1, 'another thread\'s fetch is not this one\'s');
    t.refetchDone('a');
    assert.equal(t.pending().length, 0);
    assert.deepEqual([t.refetch.key, t.refetch.n], [null, 0]);
    // Failed again later: from 1 s again.
    t.fetchFailed(pane('a'), 'a', busy());
    assert.equal(t.pending()[0].ms, 1000);
    // Another thread opened before the retry: it is not opened over it.
    t.state.open = 'b';
    t.pending()[0].fn();
    assert.deepEqual(t.opened, []);
  });

  it('starts from 1 s again for a thread opened anew after another', () => {
    const t = load();
    t.fetchFailed(pane('a'), 'a', busy());
    t.fetchFailed(pane('a'), 'a', busy());
    // Opening another thread ends them (openThread, when it switches).
    t.refetchDone(t.refetch.key);
    t.fetchFailed(pane('a'), 'a', busy());
    assert.equal(t.pending()[0].ms, 1000);
  });

  it('is wired into openThread: a failure there goes through fetchFailed, a fetch ends the retries', () => {
    const open = between('async function openThread(', '\n}\n');
    assert.match(open, /if \(switching\) \{[^}]*refetchDone\(refetch\.key\)/);
    assert.match(open, /catch \(e\) \{\s*\/\/[^\n]*\n\s*if \(state\.open === key\) fetchFailed\(pane, key, e\);\s*return;/);
    assert.match(open, /if \(!hit\) refetchDone\(key\);/);
  });
});
