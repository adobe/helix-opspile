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

/**
 * How long Adobe people take to answer customers (docs/ARCHITECTURE.md, "Expert finder"): the
 * time from a customer's message to the first post of someone new to the thread.
 *
 * That time is counted on the person's own clock: each hour counts for as much as they usually
 * post in it (UTC hour of day, weekdays and weekends apart), so a question asked as they log
 * off has not waited all night by the morning. Their hours come from all their posts, pooled
 * with everyone's while there are few, which stands for their timezone with nothing to infer.
 * The logarithm of that time is a typical value, plus what the channel and then the person add,
 * each counting for as much as its own data can carry: a person with few answers gets their
 * channel's number, and a new channel everyone's. A prediction runs the person's clock forward
 * from the moment asked about, back to minutes on the wall.
 */

const HOUR = 60 * 60 * 1000;
/** Posts a person's own hours count as much as everyone's at. */
const OWN_HOURS = 20;
/** How fast the clock runs in an hour someone never posts in, against their busiest. */
const FLOOR = 0.05;
/** How far a prediction runs at most, in hours. */
const MAX_HOURS = 60 * 24;

const LEVELS = [(a) => a.channel, (a) => a.person];

const sum = (values) => values.reduce((a, b) => a + b, 0);
const mean = (values) => sum(values) / values.length;
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const weekend = (at) => [0, 6].includes(new Date(at).getUTCDay());

/**
 * The answers in `rows` (`{ entry, channel, at, staff, person }`, `at` in ms): for each person
 * new to an entry, `{ person, channel, at, minutes }`, `at` being the customer's message before
 * their first post. Someone already active in the entry is not answering anew, and a first post
 * with no customer before it answers nobody.
 */
export function joins(rows) {
  const entries = new Map();
  const out = [];
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    const entry = entries.get(r.entry) || { asked: null, active: new Set() };
    entries.set(r.entry, entry);
    if (!r.staff) {
      entry.asked = r.at;
    } else if (r.person !== null && !entry.active.has(r.person)) {
      entry.active.add(r.person);
      if (entry.asked !== null) {
        out.push({
          person: r.person,
          channel: r.channel,
          at: entry.asked,
          minutes: (r.at - entry.asked) / 60000,
        });
      }
    }
  }
  return out;
}

/** Posts per UTC hour, `[weekday[24], weekend[24]]`, as a share of all, per day of each kind. */
function rates(counts) {
  const total = sum(counts[0]) + sum(counts[1]);
  return counts.map((hours, end) => hours.map((n) => n / total / (end ? 2 : 5)))
    .map((hours) => hours.map((v, h) => (hours[(h + 23) % 24] + 2 * v + hours[(h + 1) % 24]) / 4));
}

/** Rates as clock speeds: 1 in the busiest hour, never under FLOOR. */
function speeds(rate) {
  const top = Math.max(...rate.flat());
  return rate.map((hours) => hours.map((v) => Math.max(FLOOR, Math.min(1, v / top))));
}

/**
 * Everyone's hours from their posts in `rows`: `of(person)` is their clock's speed
 * `[weekday[24], weekend[24]]` by UTC hour, everyone's for someone who never posted.
 */
export function hoursOf(rows) {
  const blank = () => [Array(24).fill(0), Array(24).fill(0)];
  const all = blank();
  const people = new Map();
  for (const r of rows) {
    if (r.staff && r.person !== null) {
      const h = new Date(r.at).getUTCHours();
      const w = weekend(r.at) ? 1 : 0;
      all[w][h] += 1;
      if (!people.has(r.person)) {
        people.set(r.person, blank());
      }
      people.get(r.person)[w][h] += 1;
    }
  }
  if (!sum(all[0]) && !sum(all[1])) {
    const flat = blank().map((hours) => hours.fill(1));
    return { of: () => flat };
  }
  const everyone = rates(all);
  const clocks = new Map([...people].map(([person, counts]) => {
    const n = sum(counts[0]) + sum(counts[1]);
    return [person, speeds(rates(counts).map((hours, w) => hours
      .map((v, h) => (n * v + OWN_HOURS * everyone[w][h]) / (n + OWN_HOURS))))];
  }));
  const usual = speeds(everyone);
  return { of: (person) => clocks.get(person) || usual };
}

const speedAt = (clock, at) => clock[weekend(at) ? 1 : 0][new Date(at).getUTCHours()];

/** The minutes on `clock` from `from` to `to` (ms). */
export function clockMinutes(clock, from, to) {
  let minutes = 0;
  for (let at = from; at < to;) {
    const next = Math.min(to, (Math.floor(at / HOUR) + 1) * HOUR);
    minutes += ((next - at) / 60000) * speedAt(clock, at);
    at = next;
  }
  return minutes;
}

/** The minutes on the wall from `from` (ms) until `clock` has run `minutes`. */
export function wallMinutes(clock, from, minutes) {
  let left = minutes;
  let at = from;
  for (let i = 0; i < MAX_HOURS; i += 1) {
    const next = (Math.floor(at / HOUR) + 1) * HOUR;
    const speed = speedAt(clock, at);
    const there = ((next - at) / 60000) * speed;
    if (there >= left) {
      return (at - from) / 60000 + left / speed;
    }
    left -= there;
    at = next;
  }
  return (at - from) / 60000;
}

/**
 * How many answers a group needs before it counts as much as the level above it: the spread
 * inside groups over the spread between them. Infinite when groups do not differ beyond chance,
 * which turns the level off.
 */
function weightOf(groups) {
  const enough = groups.filter((g) => g.length >= 2);
  if (enough.length < 3) {
    return Infinity;
  }
  const inside = sum(enough.flatMap((g) => {
    const m = mean(g);
    return g.map((v) => (v - m) ** 2);
  })) / sum(enough.map((g) => g.length - 1));
  const means = enough.map(mean);
  const m = mean(means);
  const between = sum(means.map((v) => (v - m) ** 2)) / (means.length - 1)
    - inside * mean(enough.map((g) => 1 / g.length));
  return between > 0 ? inside / between : Infinity;
}

/**
 * The model of the answers in `rows` (see `joins`), on the hours of the posts in them, or null
 * without any answer.
 */
export function fitResponses(rows) {
  const answers = joins(rows);
  if (!answers.length) {
    return null;
  }
  const hours = hoursOf(rows);
  const left = answers.map((a) => {
    const minutes = clockMinutes(hours.of(a.person), a.at, a.at + a.minutes * 60000);
    return Math.log(Math.max(1, minutes));
  });
  const base = median(left);
  left.forEach((_, i) => {
    left[i] -= base;
  });
  const levels = LEVELS.map((key) => {
    const groups = new Map();
    answers.forEach((a, i) => {
      groups.set(key(a), [...(groups.get(key(a)) || []), left[i]]);
    });
    const weight = weightOf([...groups.values()]);
    const effects = new Map(weight === Infinity ? [] : [...groups]
      .map(([g, values]) => [g, sum(values) / (values.length + weight)]));
    answers.forEach((a, i) => {
      left[i] -= effects.get(key(a)) || 0;
    });
    return effects;
  });
  const people = new Map();
  for (const a of answers) {
    people.set(a.person, (people.get(a.person) || 0) + 1);
  }
  return {
    base, levels, people, hours,
  };
}

/** The typical minutes for `person` to answer in `channel` a customer's message at `at`. */
export function predict(model, { person, channel, at }) {
  const a = { person, channel };
  const own = Math.exp(model.base + sum(LEVELS.map((key, i) => model.levels[i].get(key(a)) || 0)));
  return wallMinutes(model.hours.of(person), at, own);
}
