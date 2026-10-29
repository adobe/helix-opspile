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
 * Which channels have thread agents. Kept apart so the normalizer can ask cheaply.
 *
 * A channel's agent is on or off as the admin team or a manager of the channel's team last
 * set it in the knowledge-base editor (a row in `agent_channels`). A channel nobody has set
 * yet follows its team's default (a row in `agent_teams`, set in the same editor), and
 * `AGENT_CHANNELS`, the deployment's default: it is on when either turns it on.
 */

/** Channel ids (Slack or Teams) where thread agents run unless someone turned them off. */
export function agentChannels(env) {
  return new Set(String(env.AGENT_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean));
}

const shown = (r) => ({
  enabled: r.enabled === 1, by: r.changed_by || null, at: r.changed_at || null,
});

/** The teams in `teams` whose channels have agents unless switched off, as a Set of slugs. */
export async function agentTeams(env, teams) {
  const list = [...new Set([...teams].filter(Boolean).map(String))];
  const on = new Set();
  if (!env.DB || !list.length) {
    return on;
  }
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    // eslint-disable-next-line no-await-in-loop
    const { results } = await env.DB.prepare(`SELECT team FROM agent_teams
      WHERE enabled = 1 AND team IN (${part.map(() => '?').join(', ')})`).bind(...part).all();
    for (const r of results || []) {
      on.add(r.team);
    }
  }
  return on;
}

/** A team's default for its channels: `{ enabled, by, at }` (off when nobody set it). */
export async function teamDefault(env, team) {
  const row = env.DB && team && await env.DB.prepare(`SELECT enabled, changed_by, changed_at
    FROM agent_teams WHERE team = ?`).bind(String(team)).first();
  return row ? shown(row) : { enabled: false, by: null, at: null };
}

/**
 * The agent state of each channel in `ids`: `{ enabled, set, by, at, via }`, where `set`
 * says whether somebody chose it, and `via` what turned an unset one on: `team` (its team's
 * default; `teams` maps channel ids to their team) or `deployment` (`AGENT_CHANNELS`).
 */
export async function agentStates(env, ids, { teams = new Map() } = {}) {
  const list = [...new Set([...ids].map(String))];
  const fallback = agentChannels(env);
  const teamsOn = await agentTeams(env, list.map((id) => teams.get(id)));
  const viaOf = (id) => {
    if (fallback.has(id)) {
      return 'deployment';
    }
    return teamsOn.has(teams.get(id)) ? 'team' : null;
  };
  const out = new Map(list.map((id) => [id, {
    enabled: Boolean(viaOf(id)), set: false, by: null, at: null, via: viaOf(id),
  }]));
  if (!env.DB || !list.length) {
    return out;
  }
  // D1 allows 100 bound parameters per statement.
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    // eslint-disable-next-line no-await-in-loop
    const { results } = await env.DB.prepare(`SELECT channel_id, enabled, changed_by, changed_at
      FROM agent_channels WHERE channel_id IN (${part.map(() => '?').join(', ')})`).bind(...part).all();
    for (const r of results || []) {
      out.set(r.channel_id, { ...shown(r), set: true, via: null });
    }
  }
  return out;
}

/**
 * Whether a message in this channel gets an agent: agents are bound, and the channel's is on.
 * `team` is the team that owns the channel, when the caller knows it; otherwise it is the team
 * of the channel's latest thread.
 */
export async function agentEnabled(env, channelId, team) {
  if (!env.AGENTS || !channelId) {
    return false;
  }
  const id = String(channelId);
  if (!env.DB) {
    return agentChannels(env).has(id);
  }
  const row = await env.DB.prepare(`SELECT
      (SELECT enabled FROM agent_channels WHERE channel_id = ?1) AS channel,
      (SELECT enabled FROM agent_teams WHERE team = COALESCE(?2, (SELECT team FROM threads
        WHERE channel_id = ?1 ORDER BY COALESCE(last_at, any_at) DESC LIMIT 1))) AS team`)
    .bind(id, team || null).first();
  if (row && row.channel !== null && row.channel !== undefined) {
    return row.channel === 1;
  }
  return agentChannels(env).has(id) || Boolean(row && row.team === 1);
}

/** Turns the agent of a channel on or off, as `by` (a name), now. */
export async function setAgent(env, channelId, enabled, by) {
  const at = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO agent_channels (channel_id, enabled, changed_by, changed_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (channel_id) DO UPDATE SET enabled = excluded.enabled,
      changed_by = excluded.changed_by, changed_at = excluded.changed_at`)
    .bind(String(channelId), enabled ? 1 : 0, by, at).run();
  return {
    enabled: Boolean(enabled), set: true, by, at, via: null,
  };
}

/**
 * Sets a team's default, as `by` (a name), now: on, every channel of the team nobody switched
 * has an agent, the ones it gets later too.
 */
export async function setTeamDefault(env, team, enabled, by) {
  const at = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO agent_teams (team, enabled, changed_by, changed_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (team) DO UPDATE SET enabled = excluded.enabled,
      changed_by = excluded.changed_by, changed_at = excluded.changed_at`)
    .bind(String(team), enabled ? 1 : 0, by, at).run();
  return { enabled: Boolean(enabled), by, at };
}
