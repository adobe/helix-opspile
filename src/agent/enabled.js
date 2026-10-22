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

/** Which channels have thread agents. Kept apart so the normalizer can ask cheaply. */

/** Channel ids (Slack or Teams) where thread agents run. */
export function agentChannels(env) {
  return new Set(String(env.AGENT_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** Whether a message in this channel gets an agent: agents are bound, and the channel listed. */
export function agentEnabled(env, channelId) {
  return Boolean(env.AGENTS && channelId) && agentChannels(env).has(String(channelId));
}
