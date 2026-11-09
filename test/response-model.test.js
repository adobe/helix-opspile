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
  clockMinutes, fitResponses, hoursOf, joins, predict, wallMinutes,
} from '../src/response-model.js';

const NOON = Date.parse('2026-10-28T12:00:00Z');
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const post = (entry, at, person = null) => ({
  entry, at, person, staff: person === null ? 0 : 1, channel: 'c1',
});

/**
 * `n` answers of `person` taking `minutes`, each a customer's message in an entry of its own and
 * their first post there, a week apart so they share an hour and a day.
 */
const answers = (n, person, channel, minutes, at = NOON) => Array.from({ length: n }, (_, i) => {
  const asked = at - i * 7 * DAY;
  const entry = `${channel}|${person}|${asked}|${minutes}`;
  return [
    { ...post(entry, asked), channel },
    { ...post(entry, asked + minutes * MINUTE, person), channel },
  ];
}).flat();

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
  const of = (fit, person, at = NOON, channel = 'c1') => predict(fit, { person, channel, at });

  it('has nothing to say without answers', () => {
    assert.equal(fitResponses([]), null);
    assert.equal(fitResponses([post('e', NOON), post('f', NOON)]), null);
  });

  it('is the typical time when groups do not differ', () => {
    const fit = fitResponses(answers(9, 1, 'c1', 30));
    assert.equal(Math.round(of(fit, 1)), 30);
    assert.equal(Math.round(of(fit, 9, NOON, 'c9')), 30);
  });

  it('counts answers per person', () => {
    const fit = fitResponses([...answers(2, 1, 'c1', 30), ...answers(5, 2, 'c1', 30)]);
    assert.equal(fit.people.get(1), 2);
    assert.equal(fit.people.get(2), 5);
  });

  it('tells fast people from slow ones, and pools the ones it hardly knows', () => {
    const fit = fitResponses([
      ...[1, 2, 3, 4, 5, 6].flatMap((p) => {
        const typical = p % 2 ? 3 : 30;
        return [...answers(3, p, 'c1', typical / 3), ...answers(3, p, 'c1', typical * 3)];
      }),
      ...answers(1, 7, 'c1', 30),
    ]);
    assert.ok(of(fit, 1) < of(fit, 7) && of(fit, 7) < of(fit, 2), 'one answer counts for less');
    assert.ok(of(fit, 2) / of(fit, 1) > 5, 'six answers each tell them apart');
    assert.ok(of(fit, 9) > of(fit, 1) && of(fit, 9) < of(fit, 2), 'someone unknown: the average');
  });

  it('runs a person\'s clock in their own hours, wherever they are', () => {
    // 1 posts at 08-11 UTC, 2 at 20-23 UTC, on weekdays, and both answer in half an hour.
    const monday = NOON - 2 * DAY;
    const day = (n) => monday - 4 * HOUR - Math.floor(n / 5) * 7 * DAY + (n % 5) * DAY;
    const rows = Array.from({ length: 200 }, (_, n) => [
      ...answers(1, 1, 'c1', 30, day(n) + (n % 3) * HOUR),
      ...answers(1, 2, 'c1', 30, day(n) + 12 * HOUR + (n % 3) * HOUR),
    ]).flat();
    const fit = fitResponses(rows);
    const night = NOON + 9 * HOUR;
    assert.ok(of(fit, 1, NOON - 3 * HOUR) < 60, 'asked in their hours');
    assert.ok(of(fit, 1, night) > 4 * 60, 'asked after they left, it waits for their morning');
    assert.ok(of(fit, 2, night) < 60, 'while someone whose evening it is answers it');
  });
});

describe('a person\'s clock', () => {
  it('runs slower out of their hours, and back again', () => {
    const { of } = hoursOf(answers(30, 1, 'c1', 10));
    const clock = of(1);
    assert.equal(clockMinutes(clock, NOON, NOON + 10 * MINUTE), 10);
    const nightly = clockMinutes(clock, NOON, NOON + DAY);
    assert.ok(nightly < 6 * 60, 'a day is a few busy hours');
    assert.ok(Math.abs(wallMinutes(clock, NOON, nightly) - 24 * 60) < 1);
  });

  it('is everyone\'s for someone who never posted, and runs on the wall without posts', () => {
    const { of } = hoursOf(answers(30, 1, 'c1', 10));
    assert.deepEqual(of(2), hoursOf(answers(30, 3, 'c1', 10)).of(4));
    assert.equal(wallMinutes(hoursOf([]).of(1), NOON, 90), 90);
  });
});
