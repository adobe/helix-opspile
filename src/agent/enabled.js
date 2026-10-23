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
 * set it in the knowledge-base editor (a row in `agent_channels`); a channel nobody has set
 * yet follows `AGENT_CHANNELS`, the deployment's default.
 */

/** Channel ids (Slack or Teams) where thread agents run unless someone turned them off. */
export function agentChannels(env) {
  return new Set(String(env.AGENT_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * The agent state of each channel in `ids`: `{ enabled, set, by, at }`, where `set` says
 * whether somebody chose it (otherwise `AGENT_CHANNELS` did).
 */
export async function agentStates(env, ids) {
  const list = [...new Set([...ids].map(String))];
  const fallback = agentChannels(env);
  const out = new Map(list.map((id) => [id, {
    enabled: fallback.has(id), set: false, by: null, at: null,
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
      out.set(r.channel_id, {
        enabled: r.enabled === 1, set: true, by: r.changed_by, at: r.changed_at,
      });
    }
  }
  return out;
}

/** Whether a message in this channel gets an agent: agents are bound, and the channel's is on. */
export async function agentEnabled(env, channelId) {
  if (!env.AGENTS || !channelId) {
    return false;
  }
  return (await agentStates(env, [channelId])).get(String(channelId)).enabled;
}

/** Turns the agent of a channel on or off, as `by` (a name), now. */
export async function setAgent(env, channelId, enabled, by) {
  const at = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO agent_channels (channel_id, enabled, changed_by, changed_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (channel_id) DO UPDATE SET enabled = excluded.enabled,
      changed_by = excluded.changed_by, changed_at = excluded.changed_at`)
    .bind(String(channelId), enabled ? 1 : 0, by, at).run();
  return {
    enabled: Boolean(enabled), set: true, by, at,
  };
}
