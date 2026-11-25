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
import {
  browserAccount, browserConfigured, browserHost, cdpConnection, hasBrowser, KEEP_ALIVE_MS,
} from '../src/agent/browser.js';
import { quiet } from './fakes.js';

// A made-up account and token.
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const ENV = { BROWSER_RUN_TOKEN: 'made-up-token', BROWSER_RUN_ACCOUNT: ACCOUNT };
const ROOT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/devtools/browser`;

/** A Worker's WebSocket, as `fetch` answers an upgrade: what was sent, and a way to answer. */
function fakeSocket() {
  const listeners = {};
  return {
    sent: [],
    accepted: false,
    closed: null,
    accept() { this.accepted = true; },
    send(m) { this.sent.push(m); },
    close(code, reason) { this.closed = { code, reason }; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    emit(type, event) { (listeners[type] || []).forEach((fn) => fn(event)); },
  };
}

/** Browser Run, faked: sessions it made, the ones that ended, and every request. */
function fakeBrowserRun() {
  const run = {
    calls: [], sessions: 0, ended: new Set(), sockets: [],
  };
  run.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    run.calls.push({
      method, url: String(url), auth: init.headers.authorization, upgrade: init.headers.upgrade,
    });
    const u = new URL(url);
    if (method === 'POST' && u.pathname.endsWith('/devtools/browser')) {
      run.sessions += 1;
      return Response.json({ sessionId: `s${run.sessions}` });
    }
    if (method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    const id = u.pathname.split('/').pop();
    if (run.ended.has(id)) {
      return Response.json({ errors: [{ message: 'session not found' }] }, { status: 404 });
    }
    const ws = fakeSocket();
    run.sockets.push(ws);
    // Node's Response cannot be 101; a Worker's is, with its `webSocket`.
    return { status: 101, webSocket: ws, text: async () => '' };
  };
  return run;
}

describe('the computer\'s browser (Browser Run over CDP)', () => {
  it('is there with a token and an account, for an image with playwright-cli', () => {
    assert.equal(browserConfigured(ENV), true);
    assert.equal(browserConfigured({ BROWSER_RUN_TOKEN: 'x' }), false);
    assert.equal(browserConfigured({ BROWSER_RUN_TOKEN: 'x', CLOUDFLARE_ACCOUNT_ID: ACCOUNT }), true);
    assert.equal(browserConfigured({ BROWSER_RUN_TOKEN: 'x', BROWSER_RUN_ACCOUNT: 'nope' }), false);
    assert.equal(browserAccount({ BROWSER_RUN_ACCOUNT: ` ${ACCOUNT} ` }), ACCOUNT);
    assert.equal(hasBrowser({ commands: ['bash', 'playwright-cli'] }), true);
    assert.equal(hasBrowser({ commands: ['bash'] }), false);
    assert.equal(hasBrowser(null), false);
  });

  it('makes one Chromium session and connects every program to it', async () => {
    const run = fakeBrowserRun();
    const kept = new Map();
    const store = {
      get: async () => kept.get('id') || null,
      put: async (id) => kept.set('id', id),
      delete: async () => kept.delete('id'),
    };
    const host = browserHost(ENV, { fetch: run.fetch, store });
    const [a, b] = await quiet(() => Promise.all([host.hook({}), host.hook({ runtime: 'chromium' })]));
    assert.equal(run.sessions, 1);
    assert.equal(kept.get('id'), 's1');
    assert.deepEqual(run.calls.map((c) => `${c.method} ${c.url.replace(ROOT, '')}`), [
      `POST ?keep_alive=${KEEP_ALIVE_MS}`, 'GET /s1', 'GET /s1',
    ]);
    assert.ok(run.calls.every((c) => c.auth === 'Bearer made-up-token'));
    assert.deepEqual(run.calls.slice(1).map((c) => c.upgrade), ['websocket', 'websocket']);
    assert.ok(run.sockets.every((s) => s.accepted));
    assert.ok(a !== b);
    assert.equal(await host.session(), 's1');

    // Another object (an evicted one) finds the session in the store.
    const again = browserHost(ENV, { fetch: run.fetch, store });
    await again.hook({});
    assert.equal(run.sessions, 1);

    // The session ended: a new one, once.
    run.ended.add('s1');
    await quiet(() => again.hook({}));
    assert.equal(run.sessions, 2);
    assert.equal(kept.get('id'), 's2');

    await again.close();
    assert.equal(run.calls.at(-1).method, 'DELETE');
    assert.equal(run.calls.at(-1).url, `${ROOT}/s2`);
    assert.equal(kept.has('id'), false);
  });

  it('gives Kitesurf a browser of its own, and refuses another runtime', async () => {
    const run = fakeBrowserRun();
    const host = browserHost(ENV, { fetch: run.fetch });
    await host.hook({ runtime: 'kitesurf' });
    assert.deepEqual(run.calls.map((c) => c.url), [`${ROOT}?browser=kitesurf`]);
    assert.equal(run.sessions, 0);
    await assert.rejects(quiet(() => host.hook({ runtime: 'firefox' })), /^Error: no browser runtime firefox: chromium \(the default\) or kitesurf$/);
  });

  it('says why Browser Run gave no browser', async () => {
    const host = browserHost(ENV, {
      fetch: async () => Response.json({ errors: [{ message: 'Authentication error' }] }, { status: 403 }),
    });
    await assert.rejects(quiet(() => host.hook({})), /^Error: Browser Run gave no browser: 403 Authentication error$/);
  });

  it('relays messages both ways, those before onmessage too, and the close', () => {
    const ws = fakeSocket();
    const conn = cdpConnection(ws);
    ws.emit('message', { data: '{"id":1}' });
    const got = [];
    conn.onmessage = (m) => got.push(m);
    ws.emit('message', { data: new TextEncoder().encode('{"id":2}') });
    assert.deepEqual(got, ['{"id":1}', '{"id":2}']);
    conn.send('{"id":3,"method":"Target.getTargets"}');
    assert.deepEqual(ws.sent, ['{"id":3,"method":"Target.getTargets"}']);
    let why = null;
    conn.onclose = (reason) => {
      why = reason;
    };
    ws.emit('close', { code: 1011, reason: 'session ended' });
    assert.equal(why, 'session ended');
    conn.send('late');
    assert.equal(ws.sent.length, 1);
  });
});
