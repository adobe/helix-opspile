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
import { DEFAULTS, withDefaults } from '../src/settings.js';
import { d1 } from './d1.js';

// Made-up people and teams only.
const PEOPLE = [{
  id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['helix', 'edge'],
}];
const TEAMS = [{ slug: 'helix', name: 'Helix' }, { slug: 'edge', name: 'Edge' }];
const me = { id: 1, name: 'A', teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'edge', name: 'Edge' }] };

async function call(DB, method, body, viewer = me) {
  const url = new URL('https://opspile.test/api/settings');
  const res = await api(new Request(url, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { DB }, url, { viewer });
  return { status: res.status, body: await res.json() };
}

describe('settings', () => {
  it('notifies of mentions and my threads by default, with no bells, and shows the agent\'s thinking', async () => {
    const DB = d1({ people: PEOPLE, teams: TEAMS });
    assert.deepEqual((await call(DB, 'GET')).body, {
      mentions: true, threads: true, bells: [], traces: true, channelTraces: {},
    });
    const url = new URL('https://opspile.test/api/me');
    const res = await api(new Request(url), { DB }, url, { viewer: me });
    assert.deepEqual((await res.json()).settings, { ...DEFAULTS });
  });

  it('keeps what is changed, and the rest as it was', async () => {
    const DB = d1({ people: PEOPLE, teams: TEAMS });
    const bell = { view: 'helix', sel: { type: ['conversation'], kind: ['incident', 'incident', 'access'] } };
    let r = await call(DB, 'PUT', { bells: [bell, { view: '~personal' }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      mentions: true,
      threads: true,
      bells: [
        { view: 'helix', sel: { kind: ['access', 'incident'], type: ['conversation'] }, not: {} },
        { view: '~personal', sel: {}, not: {} },
      ],
      traces: true,
      channelTraces: {},
    });
    r = await call(DB, 'PUT', { mentions: false });
    assert.deepEqual([r.body.mentions, r.body.bells.length], [false, 2]);
    assert.deepEqual((await call(DB, 'GET')).body, r.body);
    r = await call(DB, 'PUT', { threads: false });
    assert.deepEqual([r.body.mentions, r.body.threads, r.body.bells.length], [false, false, 2]);
  });

  it('turns my threads on for those whose settings were stored before it existed', () => {
    assert.equal(withDefaults(me, { mentions: false }).threads, true);
  });

  it('refuses bells on teams the person is not in, and malformed ones', async () => {
    const DB = d1({ people: PEOPLE, teams: TEAMS });
    for (const body of [
      { bells: [{ view: 'other' }] },
      { bells: [{ view: 'helix', sel: { kind: 'incident' } }] },
      { bells: [{ view: 'helix', sel: { 'bad id': ['x'] } }] },
      { bells: 'helix' },
      { mentions: 'no' },
      { threads: 'no' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await call(DB, 'PUT', body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual((await call(DB, 'GET')).body, { ...DEFAULTS });
  });

  it('drops the bells of a team the person left, and duplicates', () => {
    const bell = { view: 'edge', sel: {}, not: {} };
    const s = withDefaults({ teams: [{ slug: 'helix' }] }, { bells: [bell, { view: 'helix' }, { view: 'helix', sel: {}, not: {} }] });
    assert.deepEqual(s.bells, [{ view: 'helix', sel: {}, not: {} }]);
  });

  it('hide the agent\'s thinking everywhere, and per channel, where a channel\'s wins', async () => {
    const DB = d1({ people: PEOPLE, teams: TEAMS });
    let r = await call(DB, 'PUT', { traces: false });
    assert.deepEqual([r.body.traces, r.body.channelTraces, r.body.mentions], [false, {}, true]);
    r = await call(DB, 'PUT', { channelTraces: { C1: true, '19:abc@thread.tacv2': false } });
    assert.deepEqual(r.body.channelTraces, { C1: true, '19:abc@thread.tacv2': false });
    // Only the channels named change; null lets one follow `traces` again.
    r = await call(DB, 'PUT', { channelTraces: { '19:abc@thread.tacv2': null, 123456: false } });
    assert.deepEqual(r.body.channelTraces, { C1: true, 123456: false });
    assert.equal(r.body.traces, false);
    assert.deepEqual((await call(DB, 'GET')).body, r.body);
    for (const body of [
      { traces: 'no' },
      { channelTraces: ['C1'] },
      { channelTraces: { C1: 'off' } },
      { channelTraces: { 'a b': false } },
      { channelTraces: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`C${i}`, false])) },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await call(DB, 'PUT', body)).status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.deepEqual((await call(DB, 'GET')).body, r.body);
  });

  it('is read-only, and someone else\'s are not shown, while viewing as them', async () => {
    const DB = d1({ people: PEOPLE, teams: TEAMS });
    await call(DB, 'PUT', { mentions: false });
    const as = { ...me, readonly: true, viewer: { id: 9, name: 'Admin' } };
    assert.equal((await call(DB, 'PUT', { mentions: true }, as)).status, 403);
    assert.deepEqual((await call(DB, 'GET', undefined, as)).body, { ...DEFAULTS });
  });
});
