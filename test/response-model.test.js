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
import { fitResponses, joins, predict } from '../src/response-model.js';

const NOON = Date.parse('2026-10-28T12:00:00Z');
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const post = (entry, at, person = null) => ({
  entry, at, person, staff: person === null ? 0 : 1, channel: 'c1',
});

/** `n` answers taking `minutes`, a week apart so they share an hour and a day. */
const answers = (n, person, channel, minutes, at = NOON) => Array.from({ length: n }, (_, i) => ({
  person, channel, minutes, at: at - i * 7 * DAY,
}));

describe('joins', () => {
  it('times a first post from the customer message before it', () => {
    assert.deepEqual(joins([
      post('e', NOON),
      post('e', NOON + 10 * MINUTE),
      post('e', NOON + 40 * MINUTE, 1),
    ]), [{
      person: 1, channel: 'c1', at: NOON + 10 * MINUTE, minutes: 30,
    }]);
  });

  it('leaves out who is already active, and first posts no customer came before', () => {
    assert.deepEqual(joins([
      post('e', NOON, 1),
      post('e', NOON + MINUTE),
      post('e', NOON + 2 * MINUTE, 1),
    ]), []);
  });

  it('counts each person new to an entry, in time order', () => {
    const got = joins([
      post('e', NOON + 20 * MINUTE, 2),
      post('e', NOON + 10 * MINUTE, 1),
      post('e', NOON),
      post('f', NOON + 5 * MINUTE, 1),
    ]);
    assert.deepEqual(got.map((a) => [a.person, a.minutes]), [[1, 10], [2, 20]]);
  });
});

describe('the response model', () => {
  it('has nothing to say without answers', () => {
    assert.equal(fitResponses([]), null);
  });

  it('is the typical time when groups do not differ', () => {
    const fit = fitResponses(answers(9, 1, 'c1', 30));
    assert.equal(Math.round(predict(fit, { person: 1, channel: 'c1', at: NOON })), 30);
    assert.equal(Math.round(predict(fit, { person: 9, channel: 'c9', at: NOON })), 30);
  });

  it('counts answers per person', () => {
    const fit = fitResponses([...answers(2, 1, 'c1', 30), ...answers(5, 2, 'c1', 30)]);
    assert.equal(fit.people.get(1), 2);
    assert.equal(fit.people.get(2), 5);
  });

  it('tells fast people from slow ones, and pools the ones it hardly knows', () => {
    const fit = fitResponses([
      ...[1, 2, 3, 4, 5, 6].flatMap((p) => {
        const typical = p % 2 ? 30 : 3000;
        return [...answers(3, p, 'c1', typical / 10), ...answers(3, p, 'c1', typical * 10)];
      }),
      ...answers(1, 7, 'c1', 3000),
    ]);
    const of = (person) => predict(fit, { person, channel: 'c1', at: NOON });
    assert.ok(of(1) < of(7) && of(7) < of(2), 'one answer counts for less than six');
    assert.ok(of(2) / of(1) > 10, 'six answers each tell them apart');
    assert.ok(of(9) > of(1) && of(9) < of(2), 'someone unknown gets the average');
  });

  it('learns a person\'s hours in UTC', () => {
    const quiet = NOON + 12 * HOUR;
    const fit = fitResponses([1, 2, 3, 4].flatMap((p) => [
      ...answers(8, p, 'c1', 10, NOON),
      ...answers(8, p, 'c1', 1000, quiet),
    ]));
    const of = (at) => predict(fit, { person: 1, channel: 'c1', at });
    assert.ok(of(quiet) / of(NOON) > 10);
  });
});
