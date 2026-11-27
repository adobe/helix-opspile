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

import { fitResponses, predict } from './response-model.js';

/**
 * How long a customer waits for Adobe's next post (docs/ARCHITECTURE.md, "Listening and the
 * next answer"): what the customer portal tells its people to expect.
 *
 * It is the response model (src/response-model.js) asked another question. That model learns
 * how long a person takes to join a thread; here an answer is a **wait**, from a customer's
 * first message after Adobe's last post to Adobe's next one, by whoever writes it. The model's
 * two levels and its clock are used as they are, with other keys:
 *
 * - its first level (the model's channel) is the wait's **phase**, how the conversation stood
 *   when the customer wrote: a new thread, a live one (Adobe wrote in the half hour before), one
 *   of the last day, or an older one. Nothing else says as much: a live conversation is
 *   answered in minutes, a new thread in hours.
 * - its second level (the model's person) is the **team** the thread is filed under, and the
 *   clock is that team's: the hours its people post in, so a question asked as the team logs
 *   off waits for its morning.
 *
 * Nothing of the model is changed for it: the messages are handed to it as rows in which every
 * wait is a thread of its own, answered by its team. `npm run response:waits` says how well it
 * does on production.
 */

/** Adobe wrote this long before the customer at most, in minutes, for each phase. */
const LIVE = 30;
const DAY = 24 * 60;

/** The phase of a wait: how long before it Adobe last wrote in the thread (null: never). */
export function phaseOf(gap) {
  if (gap === null || gap === undefined) {
    return 'new';
  }
  if (gap <= LIVE) {
    return 'live';
  }
  return gap <= DAY ? 'day' : 'old';
}

/**
 * The waits in `rows` (`{ entry, team, at, staff }`, `at` in ms, a re-threaded group as one
 * entry): `{ team, at, minutes, phase, answer }`, `at` being the customer's first message since
 * Adobe's last post and `answer` the row that ended the wait. A customer's further messages
 * while they wait start no wait of their own.
 */
export function waitsOf(rows) {
  const entries = new Map();
  const out = [];
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    const e = entries.get(r.entry) || { asked: null, gap: null, last: null };
    entries.set(r.entry, e);
    if (!r.staff) {
      if (e.asked === null) {
        e.asked = r.at;
        e.gap = e.last === null ? null : (r.at - e.last) / 60000;
      }
    } else {
      if (e.asked !== null) {
        out.push({
          team: r.team,
          at: e.asked,
          minutes: (r.at - e.asked) / 60000,
          phase: phaseOf(e.gap),
          answer: r,
        });
        e.asked = null;
      }
      e.last = r.at;
    }
  }
  return out;
}

const teamKey = (team) => `team:${team || ''}`;

/**
 * The model of the waits in `rows` (see `waitsOf`), or null without any. Adobe's posts that
 * answer no wait are there for the teams' hours only, in a thread no customer wrote in.
 */
export function fitWaits(rows) {
  const waits = waitsOf(rows);
  if (!waits.length) {
    return null;
  }
  const answers = new Set(waits.map((w) => w.answer));
  const posts = rows.filter((r) => r.staff && !answers.has(r)).map((r) => ({
    entry: 'posts', channel: 'posts', at: r.at, staff: 1, person: teamKey(r.team),
  }));
  const asked = waits.flatMap((w, i) => [
    {
      entry: `wait:${i}`, channel: w.phase, at: w.at, staff: 0, person: null,
    },
    {
      entry: `wait:${i}`,
      channel: w.phase,
      at: w.at + w.minutes * 60000,
      staff: 1,
      person: teamKey(w.team),
    },
  ]);
  const fit = fitResponses([...posts, ...asked]);
  return fit && { fit, waits: waits.length };
}

/**
 * The typical minutes until Adobe's next post for a customer's message at `at` (ms), in a
 * thread of `team` that stood at `phase` (`phaseOf`).
 */
export function estimateWait(model, { team, phase, at }) {
  return predict(model.fit, { person: teamKey(team), channel: phase, at });
}
