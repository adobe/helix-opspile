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
  LIFETIME_MINUTES, RESOURCE, ensureSubscription, handleLifecycle,
} from '../src/subscription.js';

// Made-up values only.
const ORIGIN = 'https://opspile.test';
const ENV = { PUBLIC_ORIGIN: `${ORIGIN}/`, GRAPH_CLIENT_STATE: 'test-client-state' };
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const later = (min) => new Date(NOW + min * 60 * 1000).toISOString();

/** A fake Graph that holds a subscription list and records every call. */
function fakeGraph(subscriptions = [], { patchStatus = 200, listStatus = 200 } = {}) {
  const calls = [];
  const subs = subscriptions.map((s) => ({ ...s }));
  const graph = async (path, init = {}) => {
    const method = init.method || 'GET';
    const payload = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, payload });
    if (method === 'GET' && path === '/subscriptions') {
      const data = listStatus === 200 ? { value: subs } : { error: { code: 'x', message: 'y' } };
      return Response.json(data, { status: listStatus });
    }
    const id = path.split('/')[2];
    if (method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (method === 'PATCH') {
      const data = { id, expirationDateTime: payload.expirationDateTime };
      return Response.json(data, { status: patchStatus });
    }
    if (method === 'POST') {
      return Response.json({ id: 'new-sub', ...payload }, { status: 201 });
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { graph, calls };
}

const ours = (id, expiresIn, extra = {}) => ({
  id,
  resource: '/teams/getAllMessages',
  notificationUrl: `${ORIGIN}/teams/notify`,
  expirationDateTime: later(expiresIn),
  ...extra,
});

describe('ensureSubscription', () => {
  it('creates the subscription when there is none', async () => {
    const { graph, calls } = fakeGraph();
    const r = await ensureSubscription(ENV, { graph, now: NOW });
    assert.equal(r.action, 'created');
    const post = calls.find((c) => c.method === 'POST');
    assert.deepEqual(post.payload, {
      changeType: 'created,updated,deleted',
      notificationUrl: `${ORIGIN}/teams/notify`,
      lifecycleNotificationUrl: `${ORIGIN}/teams/lifecycle`,
      resource: RESOURCE,
      includeResourceData: false,
      expirationDateTime: later(LIFETIME_MINUTES),
      clientState: 'test-client-state',
    });
  });

  it('renews an existing subscription instead of creating one', async () => {
    const { graph, calls } = fakeGraph([ours('a', 10)]);
    const r = await ensureSubscription(ENV, { graph, now: NOW });
    assert.equal(r.action, 'renewed');
    assert.equal(r.id, 'a');
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /subscriptions', 'PATCH /subscriptions/a']);
    assert.equal(calls[1].payload.expirationDateTime, later(LIFETIME_MINUTES));
  });

  it('matches the resource regardless of its leading slash and case', async () => {
    const { graph } = fakeGraph([ours('a', 10, { resource: 'teams/getallmessages' })]);
    assert.equal((await ensureSubscription(ENV, { graph, now: NOW })).action, 'renewed');
  });

  it('keeps the newest of several and deletes the rest', async () => {
    const { graph, calls } = fakeGraph([ours('old', 5), ours('new', 30), ours('mid', 15)]);
    const r = await ensureSubscription(ENV, { graph, now: NOW });
    assert.equal(r.id, 'new');
    assert.equal(r.removed, 2);
    assert.deepEqual(
      calls.filter((c) => c.method === 'DELETE').map((c) => c.path).sort(),
      ['/subscriptions/mid', '/subscriptions/old'],
    );
  });

  it('ignores subscriptions for other URLs, such as the diag probe', async () => {
    const { graph, calls } = fakeGraph([
      ours('probe', 10, { notificationUrl: `${ORIGIN}/teams/notify?probe=1` }),
      ours('other', 10, { notificationUrl: 'https://elsewhere.test/teams/notify' }),
    ]);
    const r = await ensureSubscription(ENV, { graph, now: NOW });
    assert.equal(r.action, 'created');
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
  });

  it('recreates when the subscription is gone by the time it is renewed', async () => {
    const { graph } = fakeGraph([ours('a', 10)], { patchStatus: 404 });
    assert.equal((await ensureSubscription(ENV, { graph, now: NOW })).action, 'created');
  });

  it('recreates instead of renewing an expired subscription', async () => {
    const { graph, calls } = fakeGraph([ours('a', -1)]);
    assert.equal((await ensureSubscription(ENV, { graph, now: NOW })).action, 'created');
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
  });

  it('fails on a list error, a renew error or missing configuration', async () => {
    await assert.rejects(
      ensureSubscription(ENV, { graph: fakeGraph([], { listStatus: 403 }).graph, now: NOW }),
      /list 403/,
    );
    await assert.rejects(
      ensureSubscription(ENV, { graph: fakeGraph([ours('a', 10)], { patchStatus: 500 }).graph, now: NOW }),
      /renew 500/,
    );
    await assert.rejects(
      ensureSubscription({ ...ENV, PUBLIC_ORIGIN: '' }, { graph: fakeGraph().graph, now: NOW }),
      /PUBLIC_ORIGIN/,
    );
    await assert.rejects(
      ensureSubscription({ ...ENV, GRAPH_CLIENT_STATE: '' }, { graph: fakeGraph().graph, now: NOW }),
      /GRAPH_CLIENT_STATE/,
    );
  });
});

describe('handleLifecycle', () => {
  it('renews on reauthorizationRequired', async () => {
    const { graph } = fakeGraph([ours('a', 10)]);
    const item = { lifecycleEvent: 'reauthorizationRequired' };
    const r = await handleLifecycle(ENV, item, { graph, now: NOW });
    assert.equal(r.action, 'renewed');
  });

  it('recreates on subscriptionRemoved', async () => {
    const { graph } = fakeGraph([]);
    const r = await handleLifecycle(ENV, { lifecycleEvent: 'subscriptionRemoved' }, { graph, now: NOW });
    assert.equal(r.action, 'created');
  });

  it('does nothing yet on missed (catch-up is #8)', async () => {
    const { graph, calls } = fakeGraph([]);
    const r = await handleLifecycle(ENV, { lifecycleEvent: 'missed' }, { graph, now: NOW });
    assert.equal(r.action, 'none');
    assert.equal(calls.length, 0);
  });
});
