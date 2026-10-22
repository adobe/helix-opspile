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

import { isStaffDomain } from './lookup.js';

/**
 * ✅ on a thread's root message, by a staff member, means "resolved". It overrides Clef's
 * `resolved_p` until a customer writes again after it: the thread is then reopened, and is
 * open until Clef has labeled the thread with that message in it (then Clef decides again,
 * so a customer's "thanks, works now" does not keep it open) or until staff resolve it again.
 */

/** The reaction each platform uses for "resolved". */
export const RESOLVED_EMOJI = { slack: 'white_check_mark', teams: '✅' };

const RESOLVED = new Set(Object.values(RESOLVED_EMOJI));

/** Whether a reaction, as stored, is the "resolved" one (Teams may add a variation selector). */
export const isResolvedEmoji = (emoji) => RESOLVED.has(String(emoji || '').replace(/\ufe0f/g, ''));

const RESOLVED_FORMS = [...RESOLVED].flatMap((e) => [e, `${e}\ufe0f`]);

/**
 * What D1 knows about the resolution of each thread: the staff ✅ on its root (`checks`:
 * when, by whom), and the time of the latest customer message (`customerAt`).
 *
 * @param {object} env
 * @param {string[]} keys platform thread keys
 * @returns {Promise<Map<string, { checks: object[], customerAt: string|null }>>}
 */
export async function resolutionFacts(env, keys) {
  const list = JSON.stringify(keys);
  const { results: checks } = await env.DB.prepare(`SELECT r.thread, r.user_key,
      COALESCE(r.at, t.root_at) AS at, COALESCE(p.name, i.name) AS name, i.person,
      p.staff, i.email
    FROM reactions r JOIN threads t ON t.thread = r.thread
    LEFT JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = r.user_key
    LEFT JOIN people p ON p.id = i.person
    WHERE r.thread IN (SELECT value FROM json_each(?))
      AND r.emoji IN (SELECT value FROM json_each(?))
      AND r.message = t.source || ':' || t.tenant || ':' || t.channel_id || ':' || t.root_id`)
    .bind(list, JSON.stringify(RESOLVED_FORMS)).all();
  const { results: customer } = await env.DB.prepare(`SELECT thread, MAX(at) AS at FROM messages
    WHERE thread IN (SELECT value FROM json_each(?)) AND counted = 1 AND staff = 0
      AND deleted = 0 GROUP BY thread`).bind(list).all();
  const facts = new Map(keys.map((k) => [k, { checks: [], customerAt: null }]));
  for (const c of checks || []) {
    if (facts.has(c.thread) && (c.staff || isStaffDomain(env, c.email))) {
      facts.get(c.thread).checks.push({
        at: c.at || null, name: c.name || null, person: c.person || null, userKey: c.user_key,
      });
    }
  }
  for (const m of customer || []) {
    if (facts.has(m.thread)) {
      facts.get(m.thread).customerAt = m.at;
    }
  }
  return facts;
}

/**
 * The resolution of an inbox entry (one thread, or a re-threaded group: the checks and
 * customer messages of all its members).
 *
 * @param {{ checks: object[], customerAt: string|null }} facts
 * @param {object|null} label the entry's effective label (`labeled_through`)
 * @param {number} me the viewer's person id
 * @returns {null|{ state: 'resolved'|'reopened', verdict: 'resolved'|'open'|null, at: string,
 *   by: string[], mine: boolean, reopenedAt?: string }} null without a staff ✅; `verdict`
 *   is what the Resolved facet shows, null meaning "as Clef says"
 */
export function resolution(facts, label, me) {
  const { checks = [], customerAt = null } = facts || {};
  if (!checks.length) {
    return null;
  }
  const at = checks.map((c) => c.at || '').sort().pop() || null;
  const by = [...new Set(checks.map((c) => c.name).filter(Boolean))];
  const mine = checks.some((c) => me != null && c.person === me);
  if (customerAt && (!at || customerAt > at)) {
    const through = label && label.labeled_through;
    const relabeled = Boolean(through && through >= customerAt);
    return {
      state: 'reopened', verdict: relabeled ? null : 'open', at, by, mine, reopenedAt: customerAt,
    };
  }
  return {
    state: 'resolved', verdict: 'resolved', at, by, mine,
  };
}

/** The facts of several threads as one (a re-threaded group). */
export function mergeFacts(list) {
  return {
    checks: list.flatMap((f) => (f && f.checks) || []),
    customerAt: list.map((f) => f && f.customerAt).filter(Boolean).sort().pop() || null,
  };
}
