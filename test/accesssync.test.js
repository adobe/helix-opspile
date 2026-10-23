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
import { memberEmails, syncAccess, withEmails } from '../src/accesssync.js';
import { d1 } from './d1.js';

// Made-up domains, people and ids only.
const env = (people) => ({
  STAFF_DOMAINS: 'staff.example',
  ACCESS_API_TOKEN: 't',
  ACCESS_ACCOUNT_ID: 'acc',
  ACCESS_APP_ID: 'app',
  ACCESS_POLICY_ID: 'pol',
  DB: d1({ teams: [{ slug: 'helix', name: 'Helix' }], people }),
});
const POLICY = {
  name: 'members',
  decision: 'allow',
  precedence: 1,
  include: [{ email: { email: 'old@staff.example' } }, { email: { email: 'Ada@staff.example' } }, { group: { id: 'g1' } }],
  exclude: [],
  require: [],
};

describe('sign-in allow list', () => {
  it('lists staff members of any team, staff mail domain only', async () => {
    const e = env([
      {
        id: 1, email: 'Ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
      },
      {
        id: 2, email: 'cy@customer.example', name: 'Cy', staff: 1, teams: ['helix'],
      },
      {
        id: 3, email: 'bo@staff.example', name: 'Bo', staff: 1,
      },
    ]);
    assert.deepEqual(await memberEmails(e), ['ada@staff.example']);
  });

  it('replaces the email includes and keeps everything else', () => {
    const { added, removed, body } = withEmails(POLICY, ['ada@staff.example', 'new@staff.example']);
    assert.deepEqual([added, removed], [['new@staff.example'], ['old@staff.example']]);
    assert.deepEqual(body.include, [{ group: { id: 'g1' } }, { email: { email: 'ada@staff.example' } }, { email: { email: 'new@staff.example' } }]);
    assert.equal(body.precedence, 1);
  });

  it('puts the policy only when something changed, and never empties it', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push(init.method || 'GET');
      return Response.json({ success: true, result: POLICY });
    };
    const e = env([{
      id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
    }]);
    assert.deepEqual(await syncAccess(e, { fetchImpl }), { added: 0, removed: 1 });
    assert.deepEqual(calls, ['GET', 'PUT']);
    const nobody = env([]);
    assert.deepEqual(await syncAccess(nobody, { fetchImpl }), { skipped: 'no members' });
    assert.deepEqual(await syncAccess({ ...e, ACCESS_API_TOKEN: '' }, { fetchImpl }), { skipped: 'not configured' });
  });
});
