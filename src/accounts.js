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
 * One account a person, for a thread (docs/ARCHITECTURE.md, "One account a person"). Someone
 * can have several accounts in one workspace or tenant: a second account in another workspace
 * of a Slack Enterprise Grid, their own workspace's account seen through Slack Connect, a guest
 * account. Wherever people are listed or ranked for a thread (the mention suggestions, the
 * mentions a reply or an agent's `@Name` makes, the expert finder and the agents' suggestions),
 * only the best of them for that thread is offered, and the others count as that one.
 *
 * Accounts are one person's when D1 links them to one (`identities.person`, by mail address,
 * or a Discord account its person connected), else when they have one mail address (people
 * outside Adobe have no `people` row).
 */

/** "Has posted recently": within this long. */
export const RECENT_DAYS = 90;
/** How active an account is: its messages over this long. */
export const ACTIVE_DAYS = 180;

const day = 24 * 60 * 60 * 1000;

/**
 * Who counts as a member of the thread's channel: whoever is listed in it or posted there; on
 * Teams, in any channel of its team (`?4`, its Teams team, or '' for none). One query, so the
 * suggestions wait for one round trip less.
 */
export const CHANNEL_PEOPLE = `WITH chans(id) AS (SELECT ?3 UNION SELECT channel_id FROM channels
    WHERE ?4 != '' AND source = 'teams' AND tenant = ?2 AND group_id = ?4)
  SELECT user_id FROM channel_members
    WHERE source = ?1 AND tenant = ?2 AND channel_id IN (SELECT id FROM chans)
  UNION SELECT DISTINCT SUBSTR(author_key, LENGTH(source || ':' || tenant || ':') + 1) FROM messages
    WHERE source = ?1 AND tenant = ?2 AND channel_id IN (SELECT id FROM chans)
      AND author_key IS NOT NULL`;

/** `CHANNEL_PEOPLE`'s ?1 to ?4 for the thread or channel `t`. */
export const placeArgs = (t) => [
  t.source, t.tenant, t.channel_id, t.source === 'teams' && t.group_id ? t.group_id : '',
];

/** Whose account `i` is: `p<person>`, else `e<mail address>`, else null (an account alone). */
const OWNER = (i) => `COALESCE('p' || ${i}.person, 'e' || LOWER(${i}.email))`;

/** The accounts that can be listed at all (src/post.js `ACCOUNTS`), of identities `i`. */
const LISTED = (i, p) => `${i}.source = ?1 AND ${i}.tenant = ?2 AND ${i}.kind = 'person'
  AND COALESCE(${p}.name, ${i}.name) IS NOT NULL`;

/**
 * The accounts of everyone `which` picks (a condition on `w`, an identity, with ?6) who has more
 * than one in the place's workspace or tenant (?1 to ?4, as `CHANNEL_PEOPLE`; ?5 the start of
 * `ACTIVE_DAYS`), each with what `better` goes by.
 */
const SIBLINGS = (which) => `SELECT i.user_id AS id, ${OWNER('i')} AS owner,
    i.user_id IN (${CHANNEL_PEOPLE}) AS here,
    (i.home IS NULL OR i.home = i.tenant OR i.home = (SELECT c.group_id FROM channels c
      WHERE c.source = ?1 AND c.tenant = ?2 AND c.channel_id = ?3)) AS own,
    COALESCE(i.guest, 0) AS guest,
    (SELECT MAX(x.at) FROM messages x
      WHERE x.author_key = i.source || ':' || i.tenant || ':' || i.user_id AND x.deleted = 0)
      AS last,
    (SELECT COUNT(*) FROM messages x
      WHERE x.author_key = i.source || ':' || i.tenant || ':' || i.user_id AND x.at >= ?5
        AND x.deleted = 0 AND x.counted = 1) AS posts,
    (SELECT COUNT(*) FROM channel_members m
      WHERE m.source = ?1 AND m.tenant = ?2 AND m.user_id = i.user_id) AS channels
  FROM identities i LEFT JOIN people p ON p.id = i.person
  WHERE ${LISTED('i', 'p')} AND ${OWNER('i')} IN (
    SELECT ${OWNER('o')} FROM identities o LEFT JOIN people q ON q.id = o.person
    WHERE ${LISTED('o', 'q')} AND ${OWNER('o')} IN (
      SELECT ${OWNER('w')} FROM identities w WHERE w.source = ?1 AND w.tenant = ?2 AND (${which}))
    GROUP BY ${OWNER('o')} HAVING COUNT(*) > 1)`;

/** What `keptAccounts` picks the accounts of: their ids, their people, or everyone. */
const WHICH = {
  ids: 'w.user_id IN (SELECT value FROM json_each(?6))',
  people: 'w.person IN (SELECT value FROM json_each(?6))',
  all: '?6 IS NOT NULL',
};

/**
 * Which of two accounts of one person is the one for the thread, below 0 for `a`: the one of
 * the thread's own workspace or tenant in its channel, else any in its channel, else one of its
 * own workspace; a full member before a guest; the one that posted in the last `RECENT_DAYS`;
 * the one with more messages in the last `ACTIVE_DAYS`; in more channels; that posted last.
 * `standing`: `{ id, here, own, guest, last, posts, channels }`, as `SIBLINGS` has them.
 */
export function better(a, b, now = Date.now()) {
  const recent = (x) => Boolean(x.last) && Date.parse(x.last) >= now - RECENT_DAYS * day;
  const keys = (x) => [
    Boolean(x.here && x.own), Boolean(x.here), Boolean(x.own), !x.guest, recent(x),
    Number(x.posts) || 0, Number(x.channels) || 0, x.last ? Date.parse(x.last) : 0,
  ].map(Number);
  const ka = keys(a);
  const kb = keys(b);
  const at = ka.findIndex((v, i) => v !== kb[i]);
  return at >= 0 ? kb[at] - ka[at] : String(a.id).localeCompare(String(b.id));
}

/**
 * The account each of `accounts` (`SIBLINGS` rows) counts as: of each owner's, the `better`
 * one. A map from every one of them to that one's id.
 */
export function keptOf(accounts, now = Date.now()) {
  const byOwner = new Map();
  for (const r of accounts || []) {
    byOwner.set(r.owner, [...(byOwner.get(r.owner) || []), r]);
  }
  const out = new Map();
  for (const list of byOwner.values()) {
    const [best] = [...list].sort((a, b) => better(a, b, now));
    list.forEach((a) => out.set(a.id, best.id));
  }
  return out;
}

/**
 * For the thread or channel `t`, the account each account of someone with several in its
 * workspace or tenant counts as (`keptOf`): those of `ids` (accounts), of `people` (person ids),
 * or with neither, everyone's. Accounts of people with one are not in it: they count as
 * themselves (`kept`).
 *
 * @returns {Promise<Map<string, string>>}
 */
export async function keptAccounts(env, t, { ids, people, now = Date.now() } = {}) {
  let which = 'all';
  let list = '[]';
  if (ids) {
    which = 'ids';
    list = JSON.stringify([...new Set(ids.map(String))]);
  } else if (people) {
    which = 'people';
    list = JSON.stringify([...new Set(people)]);
  }
  if (which !== 'all' && list === '[]') {
    return new Map();
  }
  const { results } = await env.DB.prepare(SIBLINGS(WHICH[which]))
    .bind(...placeArgs(t), new Date(now - ACTIVE_DAYS * day).toISOString(), list).all();
  return keptOf(results, now);
}

/** The account `id` counts as, by a `keptAccounts` map. */
export const kept = (map, id) => (map && map.get(id)) || id;
