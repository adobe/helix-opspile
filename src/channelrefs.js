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
 * Channels that messages name (`#name`, or a Slack channel id `#C…` that Slack sent without
 * its name): which channel each is, and where the viewer finds its threads in the inbox. Slack
 * sends a channel mention as `<#C…|name>`, often with the name left out (always so from bots
 * and apps); src/markdown.js writes `#name`, else `#C…`, and pile 2 keeps what it wrote then.
 * Resolving them when a thread is read names channels opspile learned about later, too.
 * Links to a channel (src/channelurl.js) are resolved the same way, on every platform.
 */

import { CHANNEL_REF } from './markdown.js';
import { channelUrlRefs } from './channelurl.js';
import { slackLinkIn } from './normalize.js';
import { memberOf } from './shares.js';

/** Code (fenced or inline): what was typed, not channel mentions. */
const CODE = /```[\s\S]*?```|`[^`\n]+`/g;
/** A Slack channel id: public (`C`) or private (`G`) channel. */
export const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/;
/** At most this many tokens are looked up per thread. */
const MAX_REFS = 50;

/** The `#…` tokens in markdown texts, outside code: `{ ids, names }`, each at most MAX_REFS. */
export function channelTokens(texts) {
  const ids = new Set();
  const names = new Set();
  for (const text of texts || []) {
    for (const m of String(text || '').replace(CODE, ' ').matchAll(CHANNEL_REF)) {
      if (SLACK_CHANNEL_ID.test(m[2])) {
        ids.add(m[2]);
      } else {
        names.add(m[2].toLowerCase());
      }
    }
  }
  return { ids: [...ids].slice(0, MAX_REFS), names: [...names].slice(0, MAX_REFS) };
}

/** The channel on its platform, for someone who cannot see it in the inbox. */
function platformUrl(row) {
  if (row.source === 'slack') {
    return slackLinkIn(row.domain, `https://slack.com/archives/${row.channel_id}`);
  }
  if (row.source === 'discord') {
    return `https://discord.com/channels/${row.tenant}/${row.channel_id}`;
  }
  if (row.source === 'teams' && row.group_id) {
    const q = new URLSearchParams({ groupId: row.group_id, tenantId: row.tenant });
    return `https://teams.microsoft.com/l/channel/${encodeURIComponent(row.channel_id)}/`
      + `${encodeURIComponent(row.name || '')}?${q}`;
  }
  return null;
}

/**
 * `channels` rows with what the viewer needs to find them: a channel's team and customer are
 * those of its latest thread (the rules file a channel's threads together).
 */
const CHANNEL_ROWS = `SELECT c.source, c.tenant, c.channel_id, c.name, c.domain, c.group_id,
    (SELECT t.team FROM threads t WHERE t.channel_id = c.channel_id AND t.source = c.source
      ORDER BY t.any_at DESC LIMIT 1) AS team,
    (SELECT t.org FROM threads t WHERE t.channel_id = c.channel_id AND t.source = c.source
      ORDER BY t.any_at DESC LIMIT 1) AS org
  FROM channels c`;

/**
 * `channels` rows (CHANNEL_ROWS) as the viewer `me` finds them: see channelRefs. The rows
 * may be of more than one platform.
 */
async function placed(env, rows, me) {
  if (!rows.length) {
    return [];
  }
  const key = (r) => `${r.source}:${r.channel_id}`;
  const sources = JSON.stringify([...new Set(rows.map((r) => r.source))]);
  const channelIds = JSON.stringify([...new Set(rows.map((r) => String(r.channel_id)))]);
  const [{ results: shares }, { results: mine }] = await Promise.all([
    env.DB.prepare(`SELECT source, channel_id, team FROM channel_teams
      WHERE source IN (SELECT value FROM json_each(?1))
        AND channel_id IN (SELECT value FROM json_each(?2)) ORDER BY added_at, team`)
      .bind(sources, channelIds).all(),
    // The personal view's channels among them (src/shares.js personalChannels).
    me && me.id ? env.DB.prepare(`SELECT source, channel_id FROM messages
        WHERE person = ?1 AND source IN (SELECT value FROM json_each(?2))
          AND channel_id IN (SELECT value FROM json_each(?3))
      UNION SELECT c.source, c.channel_id FROM mentions n JOIN threads c ON c.thread = n.thread
        WHERE n.person = ?1 AND c.source IN (SELECT value FROM json_each(?2))
          AND c.channel_id IN (SELECT value FROM json_each(?3))`)
      .bind(me.id, sources, channelIds).all() : { results: [] },
  ]);
  const personal = new Set((mine || []).map(key));
  const mayView = memberOf(me || {});
  return rows.map((r) => {
    const id = String(r.channel_id);
    const teams = [...new Set([r.team, ...(shares || [])
      .filter((s) => key(s) === key(r)).map((s) => s.team)].filter(Boolean))];
    return {
      id,
      source: r.source,
      name: r.name || null,
      org: r.org || null,
      teams: teams.filter((t) => mayView(t)),
      personal: personal.has(key(r)),
      url: platformUrl(r),
    };
  });
}

/**
 * The channels the texts of a thread in `{ source, tenant }` name, as the viewer `me` finds
 * them: `[{ id, source, name, org, teams, personal, url }]`. `teams` are the viewer's teams
 * whose inbox has the channel (the team it is filed under first, then those it is shared with),
 * `personal` whether it is in their personal view (they posted or were mentioned there), `org`
 * the customer its threads are filed under, and `url` the channel on its platform. Channels
 * opspile does not know are left out.
 *
 * @param {object} env bindings
 * @param {{ source: string, tenant: string }} where the thread's platform and workspace
 * @param {string[]} texts the messages' markdown
 * @param {object} me the viewer
 */
export async function channelRefs(env, { source, tenant }, texts, me) {
  if (source !== 'slack' && source !== 'discord') {
    return [];
  }
  const { ids, names } = channelTokens(texts);
  if (!env.DB || (!ids.length && !names.length)) {
    return [];
  }
  const { results: rows } = await env.DB.prepare(`${CHANNEL_ROWS}
    WHERE c.source = ?1 AND c.tenant = ?2
      AND (c.channel_id IN (SELECT value FROM json_each(?3))
        OR lower(c.name) IN (SELECT value FROM json_each(?4)))`)
    .bind(source, String(tenant), JSON.stringify(ids), JSON.stringify(names)).all();
  return placed(env, rows || [], me);
}

/** A Slack workspace's host name for a `channels.domain` (src/normalize.js slackLinkIn). */
const slackHost = (domain) => (domain ? `${domain}.slack.com` : null);

/**
 * The row of `candidates` (one channel id, perhaps in more than one workspace) that the link
 * `ref` is to: the workspace the link names, else the one its host is, else the open thread's.
 */
function rowFor(ref, candidates, { source, tenant }) {
  if (ref.tenant) {
    return candidates.find((r) => String(r.tenant) === ref.tenant) || null;
  }
  return candidates.find((r) => ref.host && slackHost(r.domain) === ref.host)
    || candidates.find((r) => r.source === source && String(r.tenant) === String(tenant))
    || candidates[0] || null;
}

/**
 * The channels that links in the texts of a thread in `{ source, tenant }` are to
 * (src/channelurl.js), on any platform: a Teams channel's link in a Slack message, a Slack
 * channel's in a Teams post. As channelRefs: `[{ id, source, name, org, teams, personal,
 * url }]`, channels opspile does not know left out. A link names its workspace (Teams and
 * Discord always, Slack by its host, if at all); one that does not is to the channel in the
 * open thread's workspace, if it has one by that id.
 *
 * @param {object} env bindings
 * @param {{ source: string, tenant: string }} where the thread's platform and workspace
 * @param {string[]} texts the messages' markdown
 * @param {object} me the viewer
 */
export async function channelLinks(env, where, texts, me) {
  const refs = channelUrlRefs(texts);
  if (!env.DB || !refs.length) {
    return [];
  }
  const { results } = await env.DB.prepare(`${CHANNEL_ROWS}
    WHERE c.source IN (SELECT value FROM json_each(?1))
      AND c.channel_id IN (SELECT value FROM json_each(?2))`)
    .bind(
      JSON.stringify([...new Set(refs.map((r) => r.source))]),
      JSON.stringify([...new Set(refs.map((r) => r.channel))]),
    ).all();
  const rows = refs.map((ref) => rowFor(ref, (results || [])
    .filter((r) => r.source === ref.source && String(r.channel_id) === ref.channel), where))
    .filter(Boolean);
  return placed(env, rows, me);
}

/** `#C…` Slack channel ids in a text, outside code. */
const idsIn = (text) => channelTokens([text]).ids;

/**
 * Inbox entries (`thread`, `source`, `title`, `last_text`) with the Slack channel ids in their
 * title and last text (`#C…`, Slack sent no name) as the channels' names, where opspile knows
 * them. One query, and only when there are such ids.
 *
 * @param {object} env bindings
 * @param {object[]} rows inbox entries
 * @returns {Promise<object[]>} the rows, those with ids it could name copied
 */
export async function nameChannelIds(env, rows) {
  const fields = ['title', 'last_text'];
  const ids = [...new Set((rows || []).filter((r) => r.source === 'slack')
    .flatMap((r) => fields.flatMap((f) => (r[f] ? idsIn(r[f]) : []))))];
  if (!env.DB || !ids.length) {
    return rows;
  }
  const { results } = await env.DB.prepare(`SELECT tenant, channel_id, name FROM channels
    WHERE source = 'slack' AND channel_id IN (SELECT value FROM json_each(?))
      AND name IS NOT NULL`).bind(JSON.stringify(ids.slice(0, 200))).all();
  const names = new Map((results || []).map((r) => [`${r.tenant}:${r.channel_id}`, r.name]));
  if (!names.size) {
    return rows;
  }
  const rename = (tenant, text) => String(text).replace(CHANNEL_REF, (m, before, token) => {
    const name = SLACK_CHANNEL_ID.test(token) && names.get(`${tenant}:${token}`);
    return name ? `${before}#${name}` : m;
  });
  // The workspace is in the thread's key: `slack:<tenant>:<channel>:<root>`.
  return rows.map((r) => (r.source !== 'slack' ? r : {
    ...r,
    ...Object.fromEntries(fields.filter((f) => r[f])
      .map((f) => [f, rename(String(r.thread).split(':')[1], r[f])])),
  }));
}
