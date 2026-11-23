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

import { reliable, responseTimes, share } from './experts.js';
import { slackLinkIn, slackPermalink } from './normalize.js';
import { channelPlace, target } from './post.js';

/**
 * Whom a post mentions who may never see it, for the inbox to say so and to suggest a personal
 * reminder with a link to the post (docs/ARCHITECTURE.md, "Mention reminders"): Adobe people
 * who have not posted for QUIET_DAYS, and those the mention model (src/mention-model.js) gives
 * odds under UNLIKELY of an answer within a week. The odds are for people not in the thread
 * yet, so someone who posted in it is only asked whether they are quiet.
 */

export const QUIET_DAYS = 14;
export const UNLIKELY = 0.5;
const DAY = 24 * 60 * 60 * 1000;
/** Mentions of a post looked at, at most. */
const MAX_PEOPLE = 20;

/** "3 weeks", "10 days", "2 months": how long ago a post was, roughly. */
export function roughlyAgo(days) {
  if (days < 21) {
    return `${Math.round(days)} days`;
  }
  if (days < 60) {
    return `${Math.round(days / 7)} weeks`;
  }
  return days < 365 ? `${Math.round(days / 30)} months` : 'over a year';
}

/**
 * The link of message `id` on the platform of `t` (a thread as `target` reads it, `root_id`
 * the platform thread's first message), or null where there is none to give: Slack's in the
 * channel's workspace (`domain`), Teams' as Graph's `webUrl`.
 */
export function messageLink(t, id, domain = null) {
  if (!t || !id) {
    return null;
  }
  const root = t.root_id || id;
  if (t.source === 'slack') {
    return slackLinkIn(domain, slackPermalink(t.channel_id, id, root));
  }
  if (t.source === 'teams' && t.group_id) {
    const q = new URLSearchParams({ groupId: t.group_id, tenantId: t.tenant });
    if (root !== id) {
      q.set('parentMessageId', root);
    }
    const path = [t.channel_id, id].map(encodeURIComponent).join('/');
    return `https://teams.microsoft.com/l/message/${path}?${q}`;
  }
  return null;
}

/**
 * What a post `request` of `me` (`{ thread | channel, root?, mentions }`, as POST /api/post
 * takes it), answered by `answer` (`{ id, thread? }`), says of whom it mentions: `{ reminders,
 * permalink }`, `reminders` being `[{ id, name, why, said, days, odds }]` for those who may
 * never see it (`why`: `quiet` or `unlikely`; `said` in words; `days` since their last post,
 * null for never) and `permalink` the post's link on its platform. Nothing without mentions.
 */
export async function mentionReminders(env, me, request, answer, { now = Date.now() } = {}) {
  const ids = [...new Set((Array.isArray(request?.mentions) ? request.mentions : [])
    .map((m) => String((m && m.id) || m || '')).filter(Boolean))].slice(0, MAX_PEOPLE);
  const key = request.thread || answer.thread || null;
  const started = !request.thread;
  const t = request.thread ? await target(env, request.thread)
    : await channelPlace(env, request.channel);
  if (!ids.length || !t) {
    return { reminders: [] };
  }
  const place = started ? { ...t, root_id: request.root ? String(request.root) : answer.id } : t;
  const { results: accounts } = await env.DB.prepare(`SELECT i.user_id AS id, i.person,
      COALESCE(p.name, i.name) AS name
    FROM identities i JOIN people p ON p.id = i.person
    WHERE i.source = ? AND i.tenant = ? AND i.user_id IN (SELECT value FROM json_each(?))
      AND p.staff = 1 AND i.person <> ?`)
    .bind(t.source, t.tenant, JSON.stringify(ids), me.id).all();
  const byPerson = new Map((accounts || []).map((a) => [a.person, a]));
  const people = [...byPerson.keys()];
  if (!people.length) {
    return { reminders: [] };
  }
  const { results: threads } = key ? await env.DB.prepare(`SELECT thread FROM threads
    WHERE thread = ?1 OR logical_thread = ?1`).bind(key).all() : { results: [] };
  const keys = (threads || []).map((r) => r.thread);
  const list = JSON.stringify(people);
  const [{ results: last }, { results: here }, odds, channel] = await Promise.all([
    env.DB.prepare(`SELECT person, MAX(at) AS at FROM messages
      WHERE person IN (SELECT value FROM json_each(?)) AND deleted = 0 GROUP BY person`)
      .bind(list).all(),
    env.DB.prepare(`SELECT DISTINCT person FROM messages
      WHERE thread IN (SELECT value FROM json_each(?))
        AND person IN (SELECT value FROM json_each(?)) AND deleted = 0`)
      .bind(JSON.stringify(keys), list).all(),
    responseTimes(env, people, {
      t, threads: keys, now, mentioned: ids.length, opening: started && !request.root,
    }),
    t.source === 'slack' ? env.DB.prepare(`SELECT domain FROM channels
      WHERE source = ? AND tenant = ? AND channel_id = ?`).bind(t.source, t.tenant, t.channel_id)
      .first() : null,
  ]);
  const lastOf = new Map((last || []).map((r) => [r.person, Date.parse(r.at)]));
  const inThread = new Set((here || []).map((r) => r.person));
  const reminders = people.flatMap((person) => {
    const { id, name } = byPerson.get(person);
    const at = lastOf.get(person);
    const days = at === undefined ? null : (now - at) / DAY;
    const r = odds.get(person);
    if (days === null || days >= QUIET_DAYS) {
      return [{
        id,
        name,
        why: 'quiet',
        said: days === null ? 'has never posted where the inbox reads'
          : `has not posted for ${roughlyAgo(days)}`,
        days: days === null ? null : Math.floor(days),
        odds: r ? r.odds : null,
      }];
    }
    if (!inThread.has(person) && reliable(r) && r.odds < UNLIKELY) {
      return [{
        id,
        name,
        why: 'unlikely',
        said: `answers ${share(r.odds)} mentions`,
        days: Math.floor(days),
        odds: r.odds,
      }];
    }
    return [];
  });
  return {
    reminders,
    permalink: messageLink(place, answer.id || place.root_id, channel && channel.domain),
  };
}
