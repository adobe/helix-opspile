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

import { armOf, COMPACT } from '../experiments.js';
import { modelProblem } from './model.js';

/*
 * Compacting an idle thread (the compaction experiment, src/experiments.js): a thread agent in
 * the `idle` arm whose turn ended 65 minutes ago, with nothing since, has pi summarize its
 * transcript (pi-durable's manual compaction: the older entries become one summary, the latest
 * ~20k tokens stay as they are), so its next turn starts from a short context. 65 minutes,
 * because the agents ask for the one-hour prompt cache: before that, the next turn would read the
 * whole transcript from the cache for a tenth of the input price, and a summary would only cost.
 *
 * `agent` is the ThreadAgent (its `name`, `env`, `ctx.storage`, `schedule`, `cancelSchedule`,
 * `harness` and `compactRoot`); these functions are its `armCompact` and `compactIdle`, kept
 * here so they run in Node tests. The wait is `compact-idle` in its storage:
 * `{ schedule, token, set }`, the schedule's payload naming the token, so only the latest fires.
 */

export const COMPACT_IDLE_SECONDS = 65 * 60;
// Below this a summary costs more than it saves: the summary reads the context once at the input
// price, and keeps ~20k tokens besides.
export const COMPACT_MIN_TOKENS = 100_000;
const KEY = 'compact-idle';

/** What the summary keeps, in place of pi's focus on a coding session. */
export const COMPACT_INSTRUCTIONS = 'This is a support thread between a customer and Adobe\'s team,'
  + ' worked by you, the thread\'s agent; not a coding session. Keep: what the customer asked and'
  + ' what is still open; what the team or you told the customer or promised, and when; where the'
  + ' draft stands; what you wrote to the knowledge bases (repository and path) and drew; the'
  + ' wake-ups you set and the follow-ups owed; the people involved, by name, with their role;'
  + ' message ids, permalinks, URLs, ticket numbers, versions and error messages exactly, as'
  + ' given. What read_thread shows again in full (the messages themselves) needs no more than a'
  + ' line each.';

/** Whether the agent `name` is in the experiment's `idle` arm now. */
export const compacting = (name, env, now = Date.now()) => armOf(COMPACT, name, now, env)?.id === 'idle';

const timeOf = (entry) => {
  const m = entry && (entry.model || [])[0];
  return m && m.timestamp ? new Date(m.timestamp).getTime() : 0;
};

/**
 * How many tokens the agent's context holds, as its latest request counted them (`totalTokens`
 * of the newest answer, its prompt and output), from the active transcript `entries`. An answer
 * older than the compaction that heads them counted the context before it: none, then.
 */
export function contextTokens(entries) {
  const list = entries || [];
  const head = list[0] && list[0].kind === 'pi.compaction' ? timeOf(list[0]) : 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = (list[i].model || [])[0];
    if (list[i].kind === 'pi.assistant' && m && m.usage) {
      return timeOf(list[i]) > head ? Number(m.usage.totalTokens) || 0 : 0;
    }
  }
  return 0;
}

/**
 * A turn of the agent ended: compact in COMPACT_IDLE_SECONDS, unless another turn ends first
 * (which waits again from its own end). Only in the `idle` arm.
 */
export async function armCompact(agent, now = Date.now()) {
  if (!compacting(agent.name, agent.env, now)) {
    return;
  }
  const { storage } = agent.ctx;
  const previous = await storage.get(KEY);
  if (previous) {
    await agent.cancelSchedule(previous.schedule).catch(() => false);
  }
  const token = `${now}`;
  const s = await agent.schedule(COMPACT_IDLE_SECONDS, 'compactIdle', { token });
  await storage.put(KEY, { schedule: s.id, token, set: new Date(now).toISOString() });
}

/**
 * Schedule callback: the thread's turn ended COMPACT_IDLE_SECONDS ago. Compacts once, when the
 * agent is still in the arm, nothing waits for it, and its context holds COMPACT_MIN_TOKENS;
 * `{ compacted, tokens }` or `{ skipped }`.
 */
export async function compactIdle(agent, payload, now = Date.now()) {
  const { storage } = agent.ctx;
  const kept = await storage.get(KEY);
  if (!kept || !payload || payload.token !== kept.token) {
    return { skipped: 'superseded' };
  }
  await storage.delete(KEY);
  if (!compacting(agent.name, agent.env, now) || modelProblem(agent.env)) {
    return { skipped: 'off' };
  }
  // Work waiting, or running: its turn's end waits again.
  const pending = await agent.harness.pending();
  if (pending.some((p) => p.status !== 'parked')) {
    return { skipped: 'busy' };
  }
  const tokens = contextTokens(await agent.harness.messages());
  if (tokens < COMPACT_MIN_TOKENS) {
    return { skipped: 'small', tokens };
  }
  const outcome = await agent.compactRoot(COMPACT_INSTRUCTIONS);
  return { compacted: outcome, tokens };
}
