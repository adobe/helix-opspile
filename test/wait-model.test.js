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
  estimateWait, fitWaits, phaseOf, waitsOf,
} from '../src/wait-model.js';

const NOON = Date.parse('2026-10-28T12:00:00Z');
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When the teams of `threads` are at work: they answer from 14:00 to 17:00 UTC. */
const AT_WORK = NOON + 3 * HOUR;

const customer = (entry, at, team = 'edge') => ({
  entry, team, at, staff: 0,
});
const adobe = (entry, at, team = 'edge') => ({
  entry, team, at, staff: 1,
});

/**
 * `n` threads of `team`, a day apart at the same hour: a customer starts each and Adobe answers
 * after `first` minutes (a new thread); the customer writes again five minutes later and Adobe
 * answers after `live` minutes (a live conversation); and once more two hours later, answered
 * after `later` minutes (one of the last day).
 */
const threads = (n, team, {
  first, live, later, at = NOON,
}) => Array.from({ length: n }, (_, i) => {
  const start = at - (i + 1) * DAY;
  const entry = `${team}|${start}`;
  const one = start + first * MINUTE;
  const two = one + 5 * MINUTE + live * MINUTE;
  const three = two + 2 * HOUR;
  return [
    customer(entry, start, team), adobe(entry, one, team),
    customer(entry, one + 5 * MINUTE, team), adobe(entry, two, team),
    customer(entry, three, team), adobe(entry, three + later * MINUTE, team),
  ];
}).flat();

describe('the customer\'s wait', () => {
  it('runs from their first message since Adobe wrote to Adobe\'s next post', () => {
    const answer = adobe('e', NOON + 40 * MINUTE);
    assert.deepEqual(waitsOf([
      customer('e', NOON),
      // Asking again while waiting starts no wait of its own.
      customer('e', NOON + 10 * MINUTE),
      answer,
    ]), [{
      team: 'edge', at: NOON, minutes: 40, phase: 'new', answer,
    }]);
  });

  it('has a phase: how the conversation stood when the customer wrote', () => {
    assert.deepEqual(
      [null, 0, 30, 31, 24 * 60, 24 * 60 + 1].map(phaseOf),
      ['new', 'live', 'live', 'day', 'day', 'old'],
    );
    const waits = waitsOf([
      customer('e', NOON), adobe('e', NOON + 5 * MINUTE),
      customer('e', NOON + 10 * MINUTE), adobe('e', NOON + 12 * MINUTE),
      customer('e', NOON + 3 * HOUR), adobe('e', NOON + 4 * HOUR),
      customer('e', NOON + 3 * DAY), adobe('e', NOON + 3 * DAY + HOUR),
    ]);
    assert.deepEqual(waits.map((w) => [w.phase, w.minutes]), [['new', 5], ['live', 2], ['day', 60], ['old', 60]]);
  });

  it('is nobody\'s where Adobe wrote first, or never answered', () => {
    assert.deepEqual(waitsOf([adobe('a', NOON), adobe('a', NOON + MINUTE), customer('b', NOON)]), []);
    assert.equal(fitWaits([adobe('a', NOON), customer('b', NOON)]), null);
  });
});

describe('the wait model', () => {
  it('tells a new thread from a live conversation', () => {
    const model = fitWaits(threads(30, 'edge', { first: 120, live: 4, later: 45 }));
    assert.equal(model.waits, 90);
    const fresh = estimateWait(model, { team: 'edge', phase: 'new', at: AT_WORK });
    const live = estimateWait(model, { team: 'edge', phase: 'live', at: AT_WORK });
    // At work, a new thread waits less than the two hours it took those asked before it began.
    assert.ok(fresh > 20 && fresh < 120, `a new thread: ${fresh}`);
    assert.ok(live < 15 && fresh > 3 * live, `a live conversation: ${live}`);
    const day = estimateWait(model, { team: 'edge', phase: 'day', at: AT_WORK });
    assert.ok(day > live && day < fresh, `one of the last day: ${day}`);
    // A team it has not seen gets everyone's number for the phase.
    const other = estimateWait(model, { team: 'nobody', phase: 'live', at: AT_WORK });
    assert.ok(other < 15, `another team: ${other}`);
  });

  it('waits for the team\'s morning: its clock is the hours its people post in', () => {
    // Everything this team writes is in the afternoon, UTC.
    const model = fitWaits(threads(40, 'edge', { first: 60, live: 4, later: 45 }));
    const working = estimateWait(model, { team: 'edge', phase: 'new', at: AT_WORK });
    const night = estimateWait(model, { team: 'edge', phase: 'new', at: NOON + 12 * HOUR });
    assert.ok(night > 3 * working, `at night ${night}, at noon ${working}`);
  });

  it('tells a slow team from a fast one, once it has seen enough of both', () => {
    const model = fitWaits([
      ...threads(40, 'fast', { first: 10, live: 1, later: 5 }),
      ...threads(40, 'slow', { first: 400, live: 40, later: 200 }),
      ...threads(40, 'mid', { first: 60, live: 6, later: 30 }),
    ]);
    const of = (team) => estimateWait(model, { team, phase: 'new', at: AT_WORK });
    assert.ok(of('fast') < of('mid') && of('mid') < of('slow'), `${of('fast')} ${of('mid')} ${of('slow')}`);
  });
});
