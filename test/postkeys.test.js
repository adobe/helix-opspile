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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claimPost, prunePostKeys, settlePost } from '../src/postkeys.js';
import { d1 } from './d1.js';

const ME = { id: 7 };
const OTHER = { id: 8 };
const env = () => ({
  DB: d1({
    people: [
      {
        id: 7, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: [],
      },
      {
        id: 8, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: [],
      },
    ],
  }),
});
const sent = () => Response.json({
  ok: true, platform: 'slack', id: '1.9', text: 'the customer\'s words',
});

describe('a reply\'s key', () => {
  it('lets a post without a key through, as before', async () => {
    const e = env();
    assert.equal(await claimPost(e, ME, undefined), null);
    assert.equal(await claimPost(e, ME, undefined), null);
    assert.equal(await claimPost(e, ME, 'x'.repeat(101)), null);
    await settlePost(e, ME, undefined, sent());
  });

  it('answers a retry with the first answer, without its text', async () => {
    const e = env();
    assert.equal(await claimPost(e, ME, 'k1'), null);
    await settlePost(e, ME, 'k1', sent());
    const again = await claimPost(e, ME, 'k1');
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), {
      ok: true, platform: 'slack', id: '1.9', again: true,
    });
  });

  it('says nobody knows when the first try did not finish', async () => {
    const e = env();
    assert.equal(await claimPost(e, ME, 'k1'), null);
    const again = await claimPost(e, ME, 'k1');
    assert.equal(again.status, 409);
    assert.equal((await again.json()).unknown, true);
  });

  it('lets a refused post be sent again', async () => {
    const e = env();
    assert.equal(await claimPost(e, ME, 'k1'), null);
    await settlePost(e, ME, 'k1', Response.json({ error: 'Slack: is_archived' }, { status: 502 }));
    assert.equal(await claimPost(e, ME, 'k1'), null);
  });

  it('stays claimed when the Worker says nobody knows', async () => {
    const e = env();
    assert.equal(await claimPost(e, ME, 'k1'), null);
    await settlePost(e, ME, 'k1', Response.json({ error: 'dropped', unknown: true }, { status: 502 }));
    assert.equal((await claimPost(e, ME, 'k1')).status, 409);
  });

  it('is one person\'s', async () => {
    const e = env();
    assert.equal(await claimPost(e, ME, 'k1'), null);
    assert.equal(await claimPost(e, OTHER, 'k1'), null);
  });

  it('is claimed by one of two requests at once', async () => {
    const e = env();
    const both = await Promise.all([claimPost(e, ME, 'k1'), claimPost(e, ME, 'k1')]);
    assert.equal(both.filter((r) => r === null).length, 1);
  });

  it('goes after a day', async () => {
    const e = env();
    await claimPost(e, ME, 'k1');
    const later = new Date(Date.now() + 25 * 3600 * 1000);
    assert.deepEqual(await prunePostKeys(e, new Date()), { deleted: 0 });
    assert.deepEqual(await prunePostKeys(e, later), { deleted: 1 });
    assert.equal(await claimPost(e, ME, 'k1'), null);
  });
});
