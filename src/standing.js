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

/*
 * The viewer's standing with each customer of their personal view, for the order of its
 * customer column (ui/inbox.js `simpleCustomers`):
 * - regulars: where they send most of their messages. In production a person's messages fall on
 *   a few customers (most send four in five of theirs to one to three of the twenty or so they
 *   post to), so they are the fewest customers that have REGULAR_SHARE of the viewer's messages
 *   of the last REGULAR_DAYS, but no more than REGULAR_MOST of the customers they posted to, and
 *   none with less than REGULAR_LEAST of them (someone whose messages spread evenly over many
 *   customers has few regulars, or one);
 * - inactives: where the viewer has neither posted nor been mentioned in the last QUIET_DAYS;
 * - all others.
 */

const DAY = 24 * 60 * 60 * 1000;
export const REGULAR_DAYS = 90;
export const REGULAR_SHARE = 0.8;
export const REGULAR_MOST = 0.2;
export const REGULAR_LEAST = 0.05;
export const QUIET_DAYS = 14;

/**
 * The regulars among `counts` (`[{ org, n }]`, the viewer's messages by customer): the fewest,
 * most posted to first, that together have REGULAR_SHARE of the messages: at most REGULAR_MOST
 * of the customers, and none with less than REGULAR_LEAST of the messages (the first always is
 * one). Ties go by slug. An array of org slugs.
 */
export function regularsOf(counts) {
  const rows = (counts || []).filter((r) => r.org && r.n > 0)
    .sort((a, b) => b.n - a.n || String(a.org).localeCompare(String(b.org)));
  const total = rows.reduce((s, r) => s + r.n, 0);
  if (!total) {
    return [];
  }
  const most = Math.max(1, Math.floor(rows.length * REGULAR_MOST));
  const out = [];
  let sum = 0;
  for (const r of rows) {
    if (sum >= total * REGULAR_SHARE || out.length >= most || r.n < total * REGULAR_LEAST) {
      break;
    }
    out.push(r.org);
    sum += r.n;
  }
  return out;
}

/**
 * The standing, from `posted` (`[{ org, n, last }]`: the person's messages of the last
 * REGULAR_DAYS by customer, and when they sent the latest) and `named` (the orgs of the
 * mentions of them in the last QUIET_DAYS), as of `now` (epoch ms): `regular`, the org slugs of
 * their regulars (see regularsOf), and `active`, those they posted in or were mentioned in in
 * the last QUIET_DAYS. A customer in neither is inactive; a regular that is not active is too.
 */
export function standingOf(posted, named, now = Date.now()) {
  const quiet = new Date(now - QUIET_DAYS * DAY).toISOString();
  const active = new Set((named || []).filter(Boolean));
  for (const r of posted || []) {
    if (r.org && r.last >= quiet) {
      active.add(r.org);
    }
  }
  return { regular: regularsOf(posted), active: [...active].sort() };
}

/**
 * Person `person`'s standing with customers, as of `now` (epoch ms; see standingOf). Both by
 * index: the person's messages (messages_person, migration 0030) and mentions
 * (mentions_person, migration 0004).
 */
export async function customerStanding(db, person, now = Date.now()) {
  const since = new Date(now - REGULAR_DAYS * DAY).toISOString();
  const quiet = new Date(now - QUIET_DAYS * DAY).toISOString();
  const [{ results: posted }, { results: named }] = await Promise.all([
    db.prepare(`SELECT t.org, COUNT(*) AS n, MAX(m.at) AS last FROM messages m
        JOIN threads t ON t.thread = m.thread
      WHERE m.person = ?1 AND m.deleted = 0 AND m.at >= ?2 AND t.org IS NOT NULL
      GROUP BY t.org`).bind(person, since).all(),
    db.prepare(`SELECT DISTINCT t.org FROM mentions n JOIN threads t ON t.thread = n.thread
      WHERE n.person = ?1 AND n.at >= ?2 AND t.org IS NOT NULL`).bind(person, quiet).all(),
  ]);
  return standingOf(posted, (named || []).map((r) => r.org), now);
}
