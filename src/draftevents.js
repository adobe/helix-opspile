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
 * What became of the shared drafts (`draft_events`, migration 0058), for the COGS dashboard
 * (src/cogs/report.js): how many of the agents' drafts were sent, as they were or edited, how many
 * a person discarded or the agent withdrew, and how many replies the agents posted themselves.
 * src/drafts.js records an event for every save, send and discard; the agent's `post_message`
 * one for a post that sent no draft. Recording never fails what it records.
 */

/**
 * The person drafts by thread agents are saved as (src/agent/tools.js agentPerson). Here, so that
 * src/drafts.js, which records the events, can export it without a cycle.
 */
export const AGENT_EMAIL = 'agent@opspile.invalid';

/** How long after a discard the same text saved again by the same person is its Undo. */
export const UNDO_SECONDS = 60;
/** Words compared at most, from the start of each text. */
const MAX_WORDS = 1500;

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean)
  .slice(0, MAX_WORDS);

/**
 * How much of `sent` differs from `proposed`, by word: their edit distance over the longer one's
 * words, 0 (the same, but for spacing) to 1 (nothing in common), to three decimals.
 */
export function changeOf(proposed, sent) {
  const a = words(proposed);
  const b = words(sent);
  if (a.join(' ') === b.join(' ')) {
    return 0;
  }
  if (!a.length || !b.length) {
    return 1;
  }
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return Math.round((prev[b.length] / Math.max(a.length, b.length)) * 1000) / 1000;
}

/** A text's fingerprint, to tell it again without keeping it: SHA-256, 16 hex digits. */
export async function textHash(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '').trim()));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Records what happened to a draft of `entry` (src/drafts.js entryOf: `key`, `org`, `team`):
 * `action`, the `draft` (its created_at) and `version`, `person` who did it, its `origin`, and
 * `how`, `changed` and `hash` where they apply. Whether the person and the origin are the agent
 * is looked up as it is written.
 */
export async function recordDraftEvent(env, entry, {
  action, draft = '', version = null, how = null, person = null, origin = null,
  changed = null, hash = null,
}, now = new Date()) {
  try {
    await env.DB.prepare(`INSERT INTO draft_events (thread, draft, version, action, how, person,
        by_agent, origin, origin_agent, changed, hash, org, team, at)
      VALUES (?, ?, ?, ?, ?, ?,
        COALESCE((SELECT email = ? FROM people WHERE id = ?), 0), ?,
        (SELECT email = ? FROM people WHERE id = ?), ?, ?, ?, ?, ?)`)
      .bind(
        entry.key,
        draft || '',
        version,
        action,
        how,
        person,
        AGENT_EMAIL,
        person,
        origin,
        AGENT_EMAIL,
        origin,
        changed,
        hash,
        entry.org || '',
        entry.team || '',
        now.toISOString(),
      )
      .run();
  } catch (e) {
    console.log(JSON.stringify({ route: 'draft', action: 'record', error: e.message }));
  }
}

/**
 * The discard a save of `text` by `me` on the entry's `keys` undoes, if it is one: the same
 * text, discarded by the same person within UNDO_SECONDS. Its event is deleted, since the draft
 * came back, and returned (`draft`, `origin`), so the draft goes on as the one it was.
 */
export async function undoneDiscard(env, me, keys, text, now = Date.now()) {
  try {
    const ev = await env.DB.prepare(`SELECT id, draft, origin FROM draft_events
      WHERE thread IN (SELECT value FROM json_each(?)) AND action = 'discarded' AND person = ?
        AND hash = ? AND at >= ? ORDER BY at DESC LIMIT 1`)
      .bind(
        JSON.stringify(keys),
        me.id,
        await textHash(text),
        new Date(now - UNDO_SECONDS * 1000).toISOString(),
      )
      .first();
    if (!ev) {
      return null;
    }
    await env.DB.prepare('DELETE FROM draft_events WHERE id = ?').bind(ev.id).run();
    return ev;
  } catch (e) {
    console.log(JSON.stringify({ route: 'draft', action: 'undo', error: e.message }));
    return null;
  }
}

/**
 * The agents' drafts in the dashboard's terms, per customer and team, from `since` (an ISO time,
 * included) to `until` (excluded):
 *
 * - `agent_drafts`: drafts an agent started (their first version);
 * - `drafts_sent`, `drafts_edited`: an agent's drafts a person sent, as they were (but for
 *   spacing) or changed (in the reply box, or saved over before);
 * - `drafts_discarded`: those a person threw away; `drafts_withdrawn`: those the agent did;
 * - `agent_posts`: replies an agent posted itself (`post_message`), from its draft or not.
 */
export async function draftCounts(env, since, until) {
  const { results } = await env.DB.prepare(`SELECT org, team,
      SUM(action = 'saved' AND origin_agent = 1 AND version = draft) AS agent_drafts,
      SUM(action = 'sent' AND origin_agent = 1 AND by_agent = 0 AND COALESCE(changed, 0) = 0) AS drafts_sent,
      SUM(action = 'sent' AND origin_agent = 1 AND by_agent = 0 AND changed > 0) AS drafts_edited,
      SUM(action = 'discarded' AND origin_agent = 1 AND by_agent = 0) AS drafts_discarded,
      SUM(action = 'discarded' AND origin_agent = 1 AND by_agent = 1) AS drafts_withdrawn,
      SUM(by_agent = 1 AND action IN ('sent', 'posted')) AS agent_posts
    FROM draft_events WHERE at >= ? AND at < ? GROUP BY org, team`).bind(since, until).all();
  return results || [];
}

/** The agents' drafts open now, per customer and team. */
export async function openDrafts(env) {
  const { results } = await env.DB.prepare(`SELECT COALESCE(t.org, '') AS org,
      COALESCE(t.team, '') AS team, COUNT(*) AS n
    FROM drafts d JOIN people p ON p.id = d.origin LEFT JOIN threads t ON t.thread = d.thread
    WHERE p.email = ? GROUP BY 1, 2`).bind(AGENT_EMAIL).all();
  return results || [];
}

/** When the first draft event was recorded (ISO), or null. */
export async function draftsSince(env) {
  const row = await env.DB.prepare('SELECT MIN(at) AS at FROM draft_events').first();
  return (row && row.at) || null;
}
