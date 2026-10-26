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
import { moved } from '../src/moved.js';

// Made-up origins only.
const ENV = { PUBLIC_ORIGIN: 'https://new.test', RETIRED_ORIGINS: 'https://old.test/' };
const at = (u, method = 'GET') => moved(new Request(u, { method }), ENV, new URL(u));

describe('a moved origin', () => {
  it('sends pages opened at the old origin to the new one, with path and query', () => {
    for (const path of ['/', '/inbox?team=a&t=b', '/inbox/kb?repo=x', '/inbox/admin', '/oauth/authorize?client_id=c',
      '/api/oauth/consent/abc.def', '/api/auth/slack/start', '/api/auth/teams/callback?code=1']) {
      const res = at(`https://old.test${path}`);
      assert.equal(res.status, 301, path);
      assert.equal(res.headers.get('location'), `https://new.test${path}`);
    }
  });

  it('keeps answering what machines call there, and leaves other hosts alone', () => {
    for (const path of ['/slack/events', '/teams/notify', '/mcp', '/oauth/token', '/.well-known/oauth-authorization-server',
      '/api/inbox?team=a', '/api/media?u=x', '/favicon.ico', '/inboxes']) {
      assert.equal(at(`https://old.test${path}`), null, path);
    }
    assert.equal(at('https://old.test/inbox', 'POST'), null);
    assert.equal(at('https://new.test/inbox'), null);
    assert.equal(at('https://other.test/inbox'), null);
    assert.equal(moved(new Request('https://old.test/'), { PUBLIC_ORIGIN: 'https://new.test' }, new URL('https://old.test/')), null);
  });
});
