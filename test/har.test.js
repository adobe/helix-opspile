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
  harRequests, hideSecrets, MAX_REQUESTS_BYTES, requestLine,
} from '../src/har.js';

// Made-up hosts and tokens only.
const JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
const entry = (i, more = {}) => ({
  startedDateTime: '2026-01-01T00:00:00.000Z',
  time: 8214.4,
  request: {
    method: 'GET',
    url: `https://a.example/p/${i}?limit=5&access_token=made-up`,
    headers: [{ name: 'Authorization', value: `Bearer ${JWT}` }, { name: 'accept', value: '*/*' }],
    queryString: [{ name: 'limit', value: '5' }, { name: 'access_token', value: 'made-up' }],
    cookies: [{ name: 'session', value: 'made-up' }],
    postData: { mimeType: 'text/plain', text: 'a body "with quotes" \\ and ümlauts' },
  },
  response: {
    status: 200,
    headers: [{ name: 'set-cookie', value: 'session=made-up' }, { name: 'server', value: 'Ünicode' }],
    content: { size: 12, mimeType: 'application/json', text: '{"secret":"body"}' },
  },
  timings: { wait: 8200 },
  _resourceType: 'fetch',
  _webSocketMessages: [{ type: 'send', data: 'x'.repeat(100) }],
  ...more,
});
const har = (entries) => JSON.stringify({
  log: { creator: { name: 'x', entries: [] }, pages: [{ id: 'p' }], entries },
}, null, 1);
/** A stream of `text` in pieces of `size` bytes. */
const stream = (text, size) => {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) {
        c.close();
        return;
      }
      c.enqueue(bytes.subarray(at, at + size));
      at += size;
    },
  });
};
const parsed = (text) => text.trim().split('\n').map((l) => JSON.parse(l));

describe('a HAR as lines of requests', () => {
  it('writes a line per request, however the bytes arrive', async () => {
    const text = har([entry(1), entry(2)]);
    const whole = await harRequests(stream(text, text.length));
    const [first, second] = parsed(whole);
    assert.equal(first.url, 'https://a.example/p/1?limit=5&access_token=[hidden]');
    assert.equal(second.url, 'https://a.example/p/2?limit=5&access_token=[hidden]');
    assert.equal(first.ms, 8214);
    assert.equal(first.status, 200);
    assert.equal(first.type, 'fetch');
    assert.deepEqual(first.timings, { wait: 8200 });
    assert.equal(first.response.headers[1].value, 'Ünicode');
    for (const size of [1, 2, 3, 7, 64]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await harRequests(stream(text, size)), whole);
    }
  });

  it('keeps out bodies, cookies and credentials', async () => {
    const text = await harRequests(stream(har([entry(1)]), 1000));
    for (const leak of ['"secret"', 'with quotes', 'made-up', JWT, 'xxxx']) {
      assert.ok(!text.includes(leak), leak);
    }
    const [line] = parsed(text);
    assert.deepEqual(line.request.headers[0], { name: 'Authorization', value: '[hidden]' });
    assert.deepEqual(line.request.query, [{ name: 'limit', value: '5' }, { name: 'access_token', value: '[hidden]' }]);
    assert.equal(line.response.headers[0].value, '[hidden]');
  });

  it('hides credentials wherever a value carries them', () => {
    assert.equal(hideSecrets('https://a.example/cb#access_token=abc&state=x'), 'https://a.example/cb#access_token=[hidden]&state=x');
    assert.equal(hideSecrets(`see ${JWT} here`), 'see [hidden] here');
    assert.equal(hideSecrets('https://a.example/?q=1'), 'https://a.example/?q=1');
    const line = requestLine(entry(1, {
      request: { headers: [{ name: 'location', value: 'https://a.example/#id_token=abc' }] },
    }));
    assert.equal(line.request.headers[0].value, 'https://a.example/#id_token=[hidden]');
  });

  it('says why a request failed', () => {
    const line = requestLine({ response: { status: 0, _error: 'net::ERR_CONNECTION_RESET' } });
    assert.equal(line.status, 0);
    assert.equal(line.error, 'net::ERR_CONNECTION_RESET');
  });

  it('holds no body in memory while it reads', async () => {
    const body = 'x'.repeat(4 * 1024 * 1024);
    const text = har([entry(1, {
      response: { status: 200, headers: [], content: { size: body.length, text: body } },
    })]);
    const out = await harRequests(stream(text, 65536));
    assert.ok(out.length < 2000);
  });

  it('is nothing for what is no HAR', async () => {
    assert.equal(await harRequests(stream('{"log":{}}', 4)), null);
    assert.equal(await harRequests(stream('{"entries":[{"a":1}]}', 4)), null);
    assert.equal(await harRequests(stream('not json', 4)), null);
  });

  it('leaves out a broken entry and goes on', async () => {
    const text = `{"log":{"entries":[{"a":},${JSON.stringify(entry(2))}]}}`;
    assert.equal(parsed(await harRequests(stream(text, 16))).length, 1);
  });

  it('stops at its limit and says so', async () => {
    const big = entry(1, {
      request: { method: 'GET', url: `https://a.example/${'x'.repeat(1024 * 1024)}` },
    });
    const count = Math.ceil(MAX_REQUESTS_BYTES / (1024 * 1024)) + 2;
    const lines = parsed(await harRequests(stream(har(Array(count).fill(big)), 65536)));
    assert.deepEqual(lines.at(-1), { truncated: true, requests: count, shown: count - 2 });
  });
});
