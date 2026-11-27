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

import { liveTurn } from './agent/kept.js';
import { entryFollowers } from './follows.js';
import { sharesOf, teamsOf } from './shares.js';
import { estimateWait, fitWaits, phaseOf } from './wait-model.js';

/**
 * What the customer portal tells a customer of Adobe's side of a thread (docs/ARCHITECTURE.md,
 * "Listening and the next answer"), asked by the portal through the `PortalSource` entrypoint:
 *
 * - `listening`: how many Adobe people have the thread in their inbox: the staff members of
 *   the teams it is in (the one its channel is filed under, those the channel is shared with,
 *   those that follow a technology it shows) and the people who follow such a technology
 *   themselves. A number, never who.
 * - `estimate`: `{ minutes, asked }`, the typical wait until Adobe's next post (src/wait-model.js).
 *   `asked` is when the customer's wait began (their first message since Adobe's last post);
 *   null while nobody waits, and then `minutes` is for a message written now.
 * - `working`: the thread's agent is at work on the thread (not on a sidebar message, which is
 *   the team's own). Only that it is: what it does stays in the inbox.
 * - `draft`: the thread has a draft, an agent's or a person's, while the customer waits.
 *
 * Without `root`, or for a thread the inbox does not have yet, it answers for the channel: who
 * listens there, and the estimate for a new thread.
 */

const WINDOW_DAYS = 180;
const DAY = 24 * 60 * 60 * 1000;
/** The wait model is kept this long per isolate: it learns slowly and reads every message. */
const MODEL_MS = 60 * 60 * 1000;
let model = null;
let fitting = null;

/** Reads the last 180 days' conversations and fits the model; one read at a time. */
function fitModel(env, now) {
  fitting = fitting || (async () => {
    try {
      const { results } = await env.DB.prepare(`SELECT
          COALESCE(t.logical_thread, t.thread) AS entry, t.team, x.at, x.staff
        FROM messages x JOIN threads t ON t.thread = x.thread
        WHERE x.at >= ? AND x.counted = 1 AND x.deleted = 0 AND t.kind = 'channel'`)
        .bind(new Date(now - WINDOW_DAYS * DAY).toISOString()).all();
      const rows = (results || []).map((r) => ({ ...r, at: Date.parse(r.at) }));
      model = { at: now, fit: fitWaits(rows) };
      return model.fit;
    } finally {
      fitting = null;
    }
  })();
  return fitting;
}

/**
 * The wait model of every channel's conversations lately, or null without any wait. An isolate
 * that has one answers with it and, once it is an hour old, fits the next behind the answer
 * (`waitUntil`): only an isolate's first status waits for the read.
 */
async function waitModel(env, now, waitUntil) {
  if (model && now - model.at < MODEL_MS) {
    return model.fit;
  }
  if (model && waitUntil) {
    waitUntil(fitModel(env, now).catch((e) => console.warn(JSON.stringify({
      route: 'portal', model: 'error', error: e.message,
    }))));
    return model.fit;
  }
  return fitModel(env, now);
}

/** Forgets the wait model (tests). */
export function clearWaitModel() {
  model = null;
  fitting = null;
}

/**
 * Where a portal thread's messages stand: `{ asked, gap, last }` in ms. `asked`: the customer's
 * first message since Adobe's last post, or null when nobody waits; `gap`: the minutes from
 * Adobe's post before it to it (null: Adobe had not written); `last`: Adobe's latest post. In
 * the portal, a message that is not a person's is the inbox's app: Adobe's too.
 */
export function standing(messages) {
  let asked = null;
  let gap = null;
  let last = null;
  for (const m of messages) {
    const at = Date.parse(m.at);
    if (m.staff || !m.counted) {
      last = at;
      asked = null;
      gap = null;
    } else if (asked === null) {
      asked = at;
      gap = last === null ? null : (at - last) / 60000;
    }
  }
  return { asked, gap, last };
}

/** How many staff are on `teams` (slugs) or among `people` (ids), each once. */
async function staffCount(env, teams, people) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM people p WHERE p.staff = 1
    AND (p.id IN (SELECT person FROM team_members WHERE team IN (SELECT value FROM json_each(?1)))
      OR p.id IN (SELECT value FROM json_each(?2)))`)
    .bind(JSON.stringify(teams), JSON.stringify(people)).first();
  return row ? row.n : 0;
}

/** The team a portal channel is filed under: its latest thread's, else whom it was opened for. */
async function channelTeam(env, domain, channel) {
  const row = await env.DB.prepare(`SELECT team FROM threads WHERE source = 'portal'
      AND tenant = ?1 AND channel_id = ?2 ORDER BY any_at DESC LIMIT 1`).bind(domain, channel).first()
    || await env.DB.prepare(`SELECT team FROM portal_requests WHERE domain = ?1 AND channel_id = ?2
      LIMIT 1`).bind(domain, channel).first();
  return row ? row.team : null;
}

/**
 * `{ domain, channel, root? }` to `{ listening, estimate, working, draft }`; `{ listening: 0 }`
 * for a channel the inbox does not know.
 */
export async function portalStatus(env, { domain, channel, root } = {}, {
  now = Date.now(), waitUntil,
} = {}) {
  const tenant = String(domain || '').toLowerCase();
  const id = String(channel || '');
  const none = {
    listening: 0, estimate: null, working: false, draft: false,
  };
  if (!env.DB || !tenant || !id) {
    return none;
  }
  const t = root ? await env.DB.prepare(`SELECT COALESCE(logical_thread, thread) AS entry, team,
      source, channel_id FROM threads WHERE thread = ? AND kind = 'channel'`)
    .bind(`portal:${tenant}:${id}:${root}`).first() : null;
  const team = t ? t.team : await channelTeam(env, tenant, id);
  if (!team) {
    return none;
  }
  const [teams, followers, fit] = await Promise.all([
    t ? teamsOf(env, { ...t, thread: t.entry })
      : sharesOf(env, 'portal', id).then((shares) => [...new Set([team, ...shares])]),
    t ? entryFollowers(env, t.entry) : [],
    waitModel(env, now, waitUntil),
  ]);
  const listening = await staffCount(env, teams, followers);
  if (!t) {
    return {
      ...none,
      listening,
      estimate: fit ? {
        minutes: Math.round(estimateWait(fit, { team, phase: 'new', at: now })), asked: null,
      } : null,
    };
  }
  const members = '(SELECT thread FROM threads WHERE thread = ?1 OR logical_thread = ?1)';
  const [messages, live, draft] = await env.DB.batch([
    env.DB.prepare(`SELECT at, staff, counted FROM messages WHERE thread IN ${members}
      AND deleted = 0 ORDER BY at`).bind(t.entry),
    env.DB.prepare('SELECT turn, at FROM agent_live WHERE thread = ?1').bind(t.entry),
    env.DB.prepare(`SELECT 1 AS there FROM drafts WHERE thread IN ${members} LIMIT 1`).bind(t.entry),
  ]);
  const { asked, gap, last } = standing(messages.results || []);
  const turn = liveTurn((live.results || [])[0] || null, now);
  // Nobody waits: what a message written now would wait, as the conversation stands now.
  const phase = asked === null ? phaseOf(last === null ? null : (now - last) / 60000)
    : phaseOf(gap);
  return {
    listening,
    estimate: fit ? {
      minutes: Math.round(estimateWait(fit, { team, phase, at: asked === null ? now : asked })),
      asked: asked === null ? null : new Date(asked).toISOString(),
    } : null,
    working: Boolean(turn && turn.state === 'working' && !turn.sidebar),
    draft: asked !== null && Boolean((draft.results || []).length),
  };
}
