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
 * time from a customer's message to the first post of someone new to the thread. The logarithm
 * of that time is an average, plus what the hour and the day of the customer's message add, for
 * everyone, for the channel and for the person. Each level is fit to what the one before it
 * left over, and counts for as much as its own data can carry, so a person with few answers
 * gets their channel's number, and a new channel everyone's.
 *
 * Hours are UTC on purpose: a person's own hours show where they are, with nothing to infer.
 */

const hour = (c) => new Date(c.at).getUTCHours();
const day = (c) => new Date(c.at).getUTCDay();

/** What each level tells apart, general to particular. */
const LEVELS = [
  hour,
  day,
  (c) => c.channel,
  (c) => `${c.channel}|${hour(c)}`,
  (c) => `${c.channel}|${day(c)}`,
  (c) => c.person,
  (c) => `${c.person}|${hour(c)}`,
  (c) => `${c.person}|${day(c)}`,
];

const sum = (values) => values.reduce((a, b) => a + b, 0);
const mean = (values) => sum(values) / values.length;

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

/** The model of `answers` (see `joins`), or null without any. */
export function fitResponses(answers) {
  if (!answers.length) {
    return null;
  }
  const left = answers.map((a) => Math.log(Math.max(a.minutes, 1)));
  const base = mean(left);
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
  return { base, levels, people };
}

/** The typical minutes for `person` to answer in `channel` a customer's message at `at`. */
export function predict(model, { person, channel, at }) {
  const c = { person, channel, at };
  return Math.exp(model.base + sum(LEVELS.map((key, i) => model.levels[i].get(key(c)) || 0)));
}
