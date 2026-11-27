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
  activityOf, coldMentions, fitMentions, HORIZON, postsOf, predictMention,
} from '../src/mention-model.js';

// Made-up ids and times only.
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.parse('2026-06-01T00:00:00Z');
const CH = 'slack:E1:C1';

const post = (entry, person, at, { staff = 1, channel = CH, team = 'helix' } = {}) => ({
  entry, channel, at, staff, person, team,
});
const mention = (entry, person, at, message = `${entry}:${at}`) => ({
  person, at, entry, channel: CH, message, staff: 1,
});

/**
 * Weeks of made-up threads: a customer asks at 10:00 UTC on weekdays, someone mentions people,
 * and each answers as `how` says (minutes, or null for never). Everyone posts elsewhere too,
 * during the day, so their clocks have hours.
 */
function history(how, { days = 60 } = {}) {
  const rows = [];
  const mentions = [];
  for (let d = 0; d < days; d += 1) {
    const day = START + d * DAY;
    if (![0, 6].includes(new Date(day).getUTCDay())) {
      Object.keys(how).forEach((person, i) => {
        const entry = `t${d}-${person}`;
        const asked = day + 10 * HOUR + i * MIN;
        rows.push(post(entry, null, asked, { staff: 0 }));
        rows.push(post(entry, 99, asked + MIN));
        mentions.push(mention(entry, Number(person), asked + MIN));
        const took = how[person];
        if (took !== null) {
          rows.push(post(entry, Number(person), asked + MIN + took * MIN));
        }
        rows.push(post(`busy${person}`, Number(person), day + (9 + (d % 8)) * HOUR));
      });
    }
  }
  return { rows, mentions };
}

describe('mention model', () => {
  it("counts a person's posts as the model does", () => {
    const at = START + 30 * DAY;
    const posts = [
      { at: at - 40 * DAY, channel: CH },
      { at: at - 3 * DAY, channel: 'slack:E1:C2' },
      { at: at - 2 * HOUR, channel: CH },
      { at: at + HOUR, channel: CH },
    ];
    assert.deepEqual(activityOf(posts, at, CH, 60), {
      since: 2, day: 1, week: 2, all: 3, inChannel: 2,
    });
    assert.deepEqual(activityOf(posts, at, CH, 30), {
      since: 2, day: 1, week: 2, all: 2, inChannel: 1,
    });
    assert.equal(activityOf([], at, CH).since, null);
  });

  it('learns from first mentions of people not in the thread yet', () => {
    const t = START;
    const rows = [
      post('a', null, t, { staff: 0 }),
      post('a', 1, t + MIN),
      post('a', 2, t + 30 * MIN),
      // Already in b when mentioned there.
      post('b', 3, t),
      post('b', 1, t + MIN),
      // A customer, mentioned: not Adobe's.
      post('c', 5, t, { staff: 0 }),
    ];
    const mentions = [
      mention('a', 2, t + MIN, 'm1'),
      mention('a', 4, t + MIN, 'm1'),
      // Mentioned again: only the first counts.
      mention('a', 2, t + 10 * MIN, 'm2'),
      mention('b', 3, t + MIN, 'm3'),
      { ...mention('c', 5, t + MIN, 'm4'), staff: 0 },
    ];
    const cold = coldMentions(rows, mentions, [{ team: 'helix', person: 2 }]);
    assert.deepEqual(cold.map((m) => [m.person, m.minutes, m.mentioned, m.member, m.staff]), [
      [2, 29, 2, true, 1],
      [4, null, 2, false, 1],
    ]);
    assert.equal(cold[0].opening, true);
    // An answer after a week is none.
    const late = coldMentions(
      [post('a', 1, t), post('a', 2, t + HORIZON + HOUR)],
      [mention('a', 2, t + MIN)],
      [],
    );
    assert.equal(late[0].minutes, null);
  });

  it('tells who answers from who does not, and the fast from the slow', () => {
    const { rows, mentions } = history({
      1: 10, 2: 15, 3: 600, 4: 900, 5: null, 6: null,
    });
    const now = START + 70 * DAY;
    const model = fitMentions(rows, mentions, [], { now });
    assert.equal(model.mentions, mentions.length);
    assert.equal(model.answered, mentions.length * (4 / 6));
    // A Thursday of the weeks it learnt from, as everyone posts as they did then.
    const at = START + 59 * DAY + 10 * HOUR;
    const input = (person) => ({
      person, channel: CH, at, activity: activityOf(postsOf(rows).get(person) || [], at, CH),
    });
    const [fast, slow, never] = [1, 3, 5].map((p) => predictMention(model, input(p)));
    assert.ok(fast.odds > 0.7 && slow.odds > 0.7, `${fast.odds} ${slow.odds}`);
    assert.ok(never.odds < 0.3, `${never.odds}`);
    assert.ok(fast.minutes < 60 && slow.minutes > 180, `${fast.minutes} ${slow.minutes}`);
    assert.deepEqual([fast.mentions, never.answered], [model.counts[1][0], 0]);
    // Kept as JSON, it says the same.
    const kept = JSON.parse(JSON.stringify(model));
    assert.deepEqual(predictMention(kept, input(1)), fast);
  });

  it('learns only from mentions whose week is over', () => {
    const { rows, mentions } = history({ 1: 10 }, { days: 5 });
    assert.equal(fitMentions(rows, mentions, [], { now: START + 5 * DAY }), null);
  });
});
