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
import { api } from '../src/api.js';
import { d1 } from './d1.js';

// The header's picture of the viewer, in /api/me. Made-up people and pictures.
const ME = {
  id: 1, email: 'a@staff.example', name: 'A', teams: [{ slug: 'helix', name: 'Helix' }],
};
const fresh = () => d1({
  teams: [{ slug: 'helix', name: 'Helix' }],
  people: [{
    id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['helix'],
  }],
});
const account = (DB, source, userId, avatar, { person = 1, email = null } = {}) => DB
  .prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, email, person,
    fetched_at, avatar) VALUES (?, 'T1', ?, 'person', 'A', ?, ?, '2026-10-21T10:00:00Z', ?)`)
  .bind(source, userId, email, person, avatar).run();
const avatar = async (DB) => {
  const url = new URL('https://opspile.test/api/me');
  return (await (await api(new Request(url), { DB }, url, { viewer: ME })).json()).avatar;
};

describe('/api/me avatar', () => {
  it('is the Slack picture of an account of theirs, before Teams\' and Gravatar\'s', async () => {
    const DB = fresh();
    await account(DB, 'teams', 'U0', 'https://gravatar.com/avatar/abc?s=96&d=404');
    await account(DB, 'discord', 'U1', 'https://cdn.discord.example/a.png');
    await account(DB, 'slack', 'U2', 'https://slack.example/a_72.png');
    assert.equal(await avatar(DB), 'https://slack.example/a_72.png');
  });

  it('is found by email where the account is not linked yet', async () => {
    const DB = fresh();
    await account(DB, 'slack', 'U2', 'https://slack.example/a_72.png', { person: null, email: 'A@staff.example' });
    assert.equal(await avatar(DB), 'https://slack.example/a_72.png');
  });

  it('is Gravatar\'s for their email when no account has one', async () => {
    const DB = fresh();
    await account(DB, 'slack', 'U2', '');
    assert.match(await avatar(DB), /^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?s=96&d=404$/);
  });
});
