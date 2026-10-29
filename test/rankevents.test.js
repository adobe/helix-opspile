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
import { d1 } from './d1.js';
import {
  cleanPick, rankEvents, recordPick,
} from '../src/rankevents.js';

const PEOPLE = [{
  id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['helix'],
}];
const shown = [
  { thread: 't1', pos: 0, features: { recent2d: 0.9, urgency: 1 / 3 } },
  { thread: 't2', pos: 1, features: { recent2d: 0.5, urgency: 0 } },
];

describe('picks in the thread list (src/rankevents.js)', () => {
  it('keeps a pick with the threads on screen, rounded', () => {
    const p = cleanPick({
      view: 'helix', clicked: 't2', shown, model: '2026-10-29',
    });
    assert.equal(p.error, undefined);
    assert.equal(p.shown[0].features.urgency, 0.3333);
    assert.equal(p.model, '2026-10-29');
  });

  it('refuses what cannot be learned from', () => {
    const bad = (body) => assert.ok(cleanPick(body).error, JSON.stringify(body));
    bad(null);
    bad({ view: 'helix', clicked: 't3', shown });
    bad({ view: 'helix', clicked: 't1', shown: [shown[0]] });
    bad({ view: 'helix', clicked: 't1', shown: [shown[0], shown[0]] });
    bad({ view: 'helix', clicked: 't1', shown: [shown[0], { ...shown[1], pos: -1 }] });
    bad({ view: 'helix', clicked: 't1', shown: [shown[0], { ...shown[1], features: { x: 'y' } }] });
    bad({ view: 'helix', clicked: 't1', shown: [shown[0], { ...shown[1], features: { x: Infinity } }] });
    bad({ view: 'helix', clicked: 't1', shown: Array.from({ length: 61 }, (_, i) => ({ ...shown[0], thread: `t${i}` })) });
  });

  it('records picks and gives them back page by page', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix' }], people: PEOPLE });
    const env = { DB };
    for (const clicked of ['t1', 't2', 't1']) {
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await recordPick(env, { id: 1 }, { view: 'helix', clicked, shown }), { ok: true });
    }
    assert.ok((await recordPick(env, { id: 1 }, { view: 'helix', clicked: 'x', shown })).error);
    const first = await rankEvents(env, 0, 2);
    assert.equal(first.events.length, 2);
    assert.equal(first.events[1].clicked, 't2');
    assert.deepEqual(first.events[0].shown.map((s) => s.thread), ['t1', 't2']);
    const rest = await rankEvents(env, first.next, 2);
    assert.equal(rest.events.length, 1);
    assert.equal(rest.next, null);
  });
});
