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
import {
  afterEach, beforeEach, describe, it,
} from 'node:test';
import { parseResource, teamsNotify } from '../src/teams.js';
import { fakeCtx, fakeEnv, quiet } from './fakes.js';

// Made-up ids and secrets only.
const STATE = 'test-client-state';
const VARS = {
  GRAPH_CLIENT_STATE: STATE, MS_TENANT_ID: 'tenant-1', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's',
};
const TEAM = 'team-1';
const CHANNEL = '19:chan@thread.tacv2';
const ROOT = '1792584000000';
const REPLY = '1792584060000';
const resource = (reply) => `teams('${TEAM}')/channels('${CHANNEL}')/messages('${ROOT}')${
  reply ? `/replies('${reply}')` : ''}`;

function notifyRequest(items, path = '/teams/notify') {
  return {
    url: new URL(`https://opspile.test${path}`),
    request: new Request(`https://opspile.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: items }),
    }),
  };
}

function fakeToken() {
  const claims = btoa(JSON.stringify({ roles: [] })).replace(/=+$/, '');
  return `x.${claims}.y`;
}

describe('parseResource', () => {
  it('parses a root message', () => {
    const r = parseResource(resource());
    assert.equal(r.teamId, TEAM);
    assert.equal(r.channelId, CHANNEL);
    assert.equal(r.messageId, ROOT);
    assert.equal(r.path, `/teams/${TEAM}/channels/19%3Achan%40thread.tacv2/messages/${ROOT}`);
  });

  it('parses a reply', () => {
    const r = parseResource(resource(REPLY));
    assert.equal(r.rootId, ROOT);
    assert.equal(r.messageId, REPLY);
    assert.match(r.path, new RegExp(`/messages/${ROOT}/replies/${REPLY}$`));
  });

  it('rejects other resources', () => {
    assert.equal(parseResource('users/x/chats/y'), null);
    assert.equal(parseResource(undefined), null);
  });
});

describe('teamsNotify', () => {
  const realFetch = globalThis.fetch;
  let graphCalls;

  beforeEach(() => {
    graphCalls = [];
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('https://login.microsoftonline.com/')) {
        return Response.json({ access_token: fakeToken(), expires_in: 3600 });
      }
      graphCalls.push(u);
      if (u.endsWith('/gone')) {
        return new Response('{}', { status: 404 });
      }
      const id = u.split('/').pop();
      return Response.json({
        id,
        replyToId: u.includes('/replies/') ? ROOT : null,
        createdDateTime: '2026-10-21T12:00:00Z',
        lastModifiedDateTime: '2026-10-21T12:01:00Z',
        body: { contentType: 'html', content: '<p>made up</p>' },
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const item = (extra = {}) => ({
    subscriptionId: 'sub-1',
    clientState: STATE,
    changeType: 'created',
    resource: resource(REPLY),
    tenantId: 'tenant-1',
    ...extra,
  });

  it('echoes the validation token', async () => {
    const url = new URL('https://opspile.test/teams/notify?validationToken=abc');
    const res = await teamsNotify(new Request(url, { method: 'POST' }), url, fakeEnv(VARS), fakeCtx());
    assert.equal(await res.text(), 'abc');
  });

  it('stores the notification without its clientState, then the fetched message', async () => {
    const env = fakeEnv(VARS);
    const ctx = fakeCtx();
    const { request, url } = notifyRequest([item()]);
    const res = await quiet(() => teamsNotify(request, url, env, ctx));
    assert.equal(res.status, 202);
    await quiet(() => ctx.settle());

    const keys = [...env.objects.keys()];
    assert.equal(keys.length, 2);
    const [nKey, mKey] = keys;
    assert.match(nKey, /^teams\/tenant-1\/team-1\/19:chan@thread\.tacv2\/\d{4}\/\d{2}\/\d{2}\/notification-[0-9a-f]{32}\.json$/);
    assert.equal(
      mKey,
      `teams/tenant-1/team-1/19:chan@thread.tacv2/2026/10/21/${Date.parse('2026-10-21T12:01:00Z')}-${REPLY}.json`,
    );
    const stored = JSON.parse(env.objects.get(nKey).body);
    assert.equal(stored.clientState, undefined);
    assert.equal(stored.resource, resource(REPLY));
    assert.equal(env.objects.get(mKey).options.customMetadata.notification, nKey);
    assert.deepEqual(env.queued, [{ key: nKey }, { key: mKey }]);
    assert.equal(graphCalls.length, 1);
  });

  it('rewrites the same notification key on redelivery', async () => {
    const env = fakeEnv(VARS);
    for (let i = 0; i < 2; i += 1) {
      const ctx = fakeCtx();
      const { request, url } = notifyRequest([item()]);
      // eslint-disable-next-line no-await-in-loop
      await quiet(() => teamsNotify(request, url, env, ctx));
      // eslint-disable-next-line no-await-in-loop
      await quiet(() => ctx.settle());
    }
    assert.equal(env.objects.size, 2);
  });

  it('drops notifications with a wrong or missing clientState', async () => {
    const env = fakeEnv(VARS);
    const ctx = fakeCtx();
    const { request, url } = notifyRequest([item({ clientState: 'forged' }), item({ clientState: undefined })]);
    const res = await quiet(() => teamsNotify(request, url, env, ctx));
    assert.equal(res.status, 202);
    assert.equal(env.objects.size, 0);
    assert.equal(ctx.pending.length, 0);
  });

  it('drops everything when no GRAPH_CLIENT_STATE is configured', async () => {
    const env = fakeEnv({ ...VARS, GRAPH_CLIENT_STATE: undefined });
    const { request, url } = notifyRequest([item({ clientState: undefined })]);
    await quiet(() => teamsNotify(request, url, env, fakeCtx()));
    assert.equal(env.objects.size, 0);
  });

  it('keeps only the notification when the message is gone', async () => {
    const env = fakeEnv(VARS);
    const ctx = fakeCtx();
    const { request, url } = notifyRequest([item({ changeType: 'deleted', resource: resource('gone') })]);
    await quiet(() => teamsNotify(request, url, env, ctx));
    await quiet(() => ctx.settle());
    assert.equal(env.objects.size, 1);
  });

  it('stores lifecycle notifications and renews instead of fetching', async () => {
    const env = fakeEnv(VARS);
    const ctx = fakeCtx();
    const { request, url } = notifyRequest(
      [item({ lifecycleEvent: 'reauthorizationRequired', resource: '/teams/getAllMessages' })],
      '/teams/lifecycle',
    );
    await quiet(() => teamsNotify(request, url, env, ctx));
    assert.match([...env.objects.keys()][0], /^teams\/tenant-1\/_lifecycle\/_\//);
    assert.equal(ctx.pending.length, 1); // the renewal, not a message fetch
    await quiet(() => ctx.settle());
    assert.equal(graphCalls.filter((u) => u.includes('/messages/')).length, 0);
  });

  it('answers 500 when storing fails, so Graph redelivers', async () => {
    const env = fakeEnv(VARS, { failPut: true });
    const { request, url } = notifyRequest([item()]);
    const res = await quiet(() => teamsNotify(request, url, env, fakeCtx()));
    assert.equal(res.status, 500);
  });
});
