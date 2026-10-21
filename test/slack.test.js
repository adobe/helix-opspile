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
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { slackEvents, slackKey, verifySlackSignature } from '../src/slack.js';
import { fakeEnv, quiet } from './fakes.js';

// Fixed, made-up values. Never use a real signing secret here.
const SECRET = 'test-signing-secret';
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const TS = String(NOW / 1000);

function sign(body, ts = TS, secret = SECRET) {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
}

function request(body, headers = {}) {
  return new Request('https://opspile.test/slack/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('verifySlackSignature', () => {
  const body = '{"type":"event_callback"}';
  const verify = (overrides = {}) => verifySlackSignature({
    secret: SECRET, timestamp: TS, signature: sign(body), body, now: NOW, ...overrides,
  });

  it('accepts a valid signature', async () => {
    assert.equal(await verify(), null);
  });

  it('accepts a timestamp at the edge of the window', async () => {
    const ts = String(NOW / 1000 - 300);
    assert.equal(await verify({ timestamp: ts, signature: sign(body, ts) }), null);
  });

  it('rejects a timestamp outside the window', async () => {
    const ts = String(NOW / 1000 - 301);
    assert.equal(await verify({ timestamp: ts, signature: sign(body, ts) }), 'stale timestamp');
  });

  it('rejects a timestamp from the future', async () => {
    const ts = String(NOW / 1000 + 301);
    assert.equal(await verify({ timestamp: ts, signature: sign(body, ts) }), 'stale timestamp');
  });

  it('rejects a modified body', async () => {
    assert.equal(await verify({ body: '{"type":"event_callbacK"}' }), 'bad signature');
  });

  it('rejects a signature made with another secret', async () => {
    assert.equal(await verify({ signature: sign(body, TS, 'other') }), 'bad signature');
  });

  it('rejects a signature for another timestamp', async () => {
    assert.equal(await verify({ signature: sign(body, String(NOW / 1000 - 1)) }), 'bad signature');
  });

  it('rejects missing or malformed signatures', async () => {
    assert.equal(await verify({ signature: null }), 'missing signature');
    assert.equal(await verify({ signature: sign(body).slice(3) }), 'missing signature');
    assert.equal(await verify({ signature: 'v0=zz' }), 'missing signature');
    assert.equal(await verify({ signature: 'v0=' }), 'missing signature');
  });

  it('rejects missing or malformed timestamps', async () => {
    assert.equal(await verify({ timestamp: null }), 'missing timestamp');
    assert.equal(await verify({ timestamp: '12a' }), 'missing timestamp');
  });

  it('fails closed without a secret', async () => {
    assert.equal(await verify({ secret: undefined }), 'no signing secret configured');
  });
});

describe('slackEvents', () => {
  const vars = { SLACK_SIGNING_SECRET: SECRET };
  const env = fakeEnv(vars);
  const realNow = Date.now;
  const atNow = async (fn) => {
    Date.now = () => NOW;
    try {
      return await fn();
    } finally {
      Date.now = realNow;
    }
  };
  it('answers a signed url_verification with the challenge', async () => {
    const body = '{"type":"url_verification","challenge":"c-123"}';
    const res = await atNow(() => slackEvents(request(body, {
      'x-slack-request-timestamp': TS, 'x-slack-signature': sign(body),
    }), env));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'c-123');
  });

  it('rejects an unsigned url_verification', async () => {
    const body = '{"type":"url_verification","challenge":"c-123"}';
    const res = await quiet(() => atNow(() => slackEvents(request(body), env)));
    assert.equal(res.status, 401);
    assert.notEqual(await res.text(), 'c-123');
  });

  const signed = (body, headers = {}) => request(body, {
    'x-slack-request-timestamp': TS, 'x-slack-signature': sign(body), ...headers,
  });
  const callback = JSON.stringify({
    type: 'event_callback',
    enterprise_id: 'E1',
    team_id: 'T1',
    event_id: 'Ev1',
    event_time: NOW / 1000,
    event: {
      type: 'message', channel: 'C1', ts: '1792584000.000100', event_ts: '1792584000.000100',
    },
  });

  it('stores a signed event callback as delivered and enqueues it', async () => {
    const e = fakeEnv(vars);
    const res = await quiet(() => atNow(() => slackEvents(signed(callback), e)));
    assert.equal(res.status, 200);
    const key = 'slack/E1/C1/2026/10/21/1792584000.000100-Ev1.json';
    assert.deepEqual([...e.objects.keys()], [key]);
    assert.equal(e.objects.get(key).body, callback);
    assert.equal(e.objects.get(key).options.customMetadata.via, 'events');
    assert.deepEqual(e.queued, [{ key }]);
  });

  it('rewrites the same key when Slack retries', async () => {
    const e = fakeEnv(vars);
    await quiet(() => atNow(() => slackEvents(signed(callback), e)));
    await quiet(() => atNow(() => slackEvents(signed(callback, { 'x-slack-retry-num': '1' }), e)));
    assert.equal(e.objects.size, 1);
    assert.equal([...e.objects.values()][0].options.customMetadata.retry, '1');
  });

  it('answers 500 when storing fails, so Slack retries', async () => {
    const e = fakeEnv(vars, { failPut: true });
    const res = await quiet(() => atNow(() => slackEvents(signed(callback), e)));
    assert.equal(res.status, 500);
    assert.equal(e.queued.length, 0);
  });

  it('acknowledges other signed payloads without storing them', async () => {
    const e = fakeEnv(vars);
    const res = await quiet(() => atNow(() => slackEvents(signed('{"type":"app_rate_limited"}'), e)));
    assert.equal(res.status, 200);
    assert.equal(e.objects.size, 0);
  });

  it('rejects a signed request whose body is not JSON', async () => {
    const body = 'not json';
    const res = await atNow(() => slackEvents(request(body, {
      'x-slack-request-timestamp': TS, 'x-slack-signature': sign(body),
    }), env));
    assert.equal(res.status, 400);
  });
});

describe('slackKey', () => {
  const base = {
    enterprise_id: 'E1', team_id: 'T1', event_id: 'Ev9', event_time: 1792584000,
  };
  const key = (event, extra = {}) => slackKey({ ...base, ...extra, event });

  it('files a message under its channel and day', () => {
    assert.equal(
      key({ type: 'message', channel: 'C1', event_ts: '1792584000.5' }),
      'slack/E1/C1/2026/10/21/1792584000.5-Ev9.json',
    );
  });

  it('uses the item channel of a reaction', () => {
    assert.match(key({ type: 'reaction_added', item: { channel: 'C2' }, event_ts: '1' }), /^slack\/E1\/C2\//);
  });

  it('uses the channel id of channel_created and channel_rename', () => {
    assert.match(key({ type: 'channel_rename', channel: { id: 'C3', name: 'x' }, event_ts: '1' }), /^slack\/E1\/C3\//);
  });

  it('falls back to the team id and _ for workspace events', () => {
    assert.equal(
      slackKey({
        team_id: 'T1', event_id: 'Ev8', event_time: 1792584000, event: { type: 'tokens_revoked' },
      }),
      'slack/T1/_/2026/10/21/1792584000-Ev8.json',
    );
  });

  it('keeps / out of key segments', () => {
    assert.match(key({ type: 'message', channel: 'C/../x', event_ts: '1' }), /^slack\/E1\/C_\.\._x\//);
  });
});
