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

import { loadRules, slackApi } from './lookup.js';
import { classify } from './rules.js';

/**
 * The Slack app joins every public channel of the workspaces in SLACK_JOIN_TEAMS
 * (comma-separated Slack team ids), so nobody has to invite it: a new channel as it is
 * created, and the cron catches every other one it is not in (created while this was off,
 * unarchived, or left). Needs the bot scope `channels:join`. Private channels still need an
 * invite, and channels the rules mark `ignore` are left alone.
 */

/** Joins per cron run: conversations.join is Tier 3 (50+ a minute). */
export const JOIN_PER_RUN = 40;

/** A channel Slack refused is tried again after this long. */
export const RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Errors that say nothing about the channel: the next run tries it again. */
const TRANSIENT = new Set([
  'ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout',
]);

/** The workspaces whose public channels the app joins; empty when this is off. */
export function joinTeams(env) {
  return String(env.SLACK_JOIN_TEAMS || '').split(',').map((t) => t.trim()).filter(Boolean);
}

const ignored = (rules, channel) => classify(rules, {
  source: 'slack', channelId: channel.id, name: channel.name, connected: [],
}).kind === 'ignore';

/** The public channels of one workspace the app is not in, oldest first. */
async function notJoined(slack, team) {
  const out = [];
  let cursor = '';
  do {
    // eslint-disable-next-line no-await-in-loop
    const data = await slack('conversations.list', {
      team_id: team,
      types: 'public_channel',
      exclude_archived: 'true',
      limit: '1000',
      ...(cursor ? { cursor } : {}),
    });
    out.push(...(data.channels || []).filter((c) => !c.is_member && !c.is_archived));
    cursor = data.response_metadata?.next_cursor || '';
  } while (cursor);
  return out.sort((a, b) => (a.created || 0) - (b.created || 0));
}

/**
 * Cron: joins up to `limit` public channels the app is not in yet. A rate limit ends the run
 * (the next one goes on); other errors are counted by Slack's error code.
 *
 * @returns {Promise<object>} counts, for the log; never channel names
 */
export async function joinPublicChannels(env, {
  slack = (method, params) => slackApi(env, method, params), limit = JOIN_PER_RUN, now = Date.now(),
} = {}) {
  const teams = joinTeams(env);
  if (!teams.length || !env.SLACK_BOT_TOKEN) {
    return { off: true };
  }
  const rules = await loadRules(env);
  const { results } = await env.DB.prepare('SELECT channel_id FROM slack_joins WHERE tried_at > ?')
    .bind(new Date(now - RETRY_MS).toISOString()).all();
  const refused = new Set((results || []).map((r) => r.channel_id));
  const missing = [];
  for (const team of teams) {
    // eslint-disable-next-line no-await-in-loop
    missing.push(...(await notJoined(slack, team)).filter((c) => !ignored(rules, c)));
  }
  const todo = missing.filter((c) => !refused.has(c.id));
  const joined = [];
  let tried = 0;
  const failed = {};
  for (const channel of todo.slice(0, limit)) {
    tried += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      await slack('conversations.join', { channel: channel.id });
      joined.push(channel.id);
    } catch (e) {
      const code = String(e.message).split(': ').pop();
      failed[code] = (failed[code] || 0) + 1;
      if (code === 'ratelimited') {
        break;
      }
      if (!TRANSIENT.has(code)) {
        // eslint-disable-next-line no-await-in-loop
        await env.DB.prepare(`INSERT INTO slack_joins (channel_id, error, tried_at) VALUES (?, ?, ?)
          ON CONFLICT (channel_id) DO UPDATE SET error = excluded.error, tried_at = excluded.tried_at`)
          .bind(channel.id, code, new Date(now).toISOString()).run();
      }
    }
  }
  if (joined.length) {
    // Refused once, joined on a later try.
    await env.DB.prepare('DELETE FROM slack_joins WHERE channel_id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(joined)).run();
  }
  return {
    teams: teams.length,
    missing: missing.length,
    refused: missing.length - todo.length,
    joined: joined.length,
    failed,
    left: todo.length - tried,
  };
}

/**
 * Events: a public channel created (or unarchived) in one of SLACK_JOIN_TEAMS is joined at
 * once, so its first thread is not missed. Errors are logged; the cron tries again.
 */
export async function joinOnEvent(env, payload, {
  slack = (method, params) => slackApi(env, method, params),
} = {}) {
  const event = payload.event || {};
  if (!['channel_created', 'channel_unarchive'].includes(event.type)) {
    return null;
  }
  const id = typeof event.channel === 'string' ? event.channel : event.channel?.id;
  const team = event.channel?.context_team_id || payload.team_id;
  if (!id || !joinTeams(env).includes(team) || !env.SLACK_BOT_TOKEN) {
    return null;
  }
  if (event.channel?.name && ignored(await loadRules(env), event.channel)) {
    return null;
  }
  try {
    await slack('conversations.join', { channel: id });
    return { joined: id };
  } catch (e) {
    console.warn(JSON.stringify({ route: 'slack', join: id, error: e.message }));
    return { error: e.message };
  }
}
