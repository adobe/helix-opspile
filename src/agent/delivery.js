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

import {
  agentEnabled, deliveryText, entryMessages, markOf, screen, untrusted,
} from './deliver.js';
import { mentionedOutside } from './members.js';
import { modelProblem } from './model.js';

/**
 * How a thread agent is told about messages. `agent` is the ThreadAgent (its `env`, `ctx`,
 * `schedule`, `cancelSchedule`, `target`, `syncTools`, `syncMcp`, `syncUploads` and `harness`);
 * these functions are its `verdicts`, `deliver`, `armIdle` and `idle`, kept here so they run in
 * Node tests.
 */

// A day after the latest message, once more: file what was learned.
export const IDLE_SECONDS = 24 * 60 * 60;

export const IDLE_PROMPT = 'Nothing has been posted in the thread for a day. Look at where it stands:'
  + ' if something worth remembering came out of it, put it into the knowledge bases; if the'
  + ' team owes the customer an answer or a follow-up, make sure the draft has it; otherwise'
  + ' change nothing.';

/**
 * Clef verdicts for the untrusted ones among `messages`, by message id. A verdict is kept, so a
 * message is checked once. A check that failed is not a verdict: the message is withheld for
 * now, and asked about again the next time it is read.
 */
export async function verdictsOf(agent, messages) {
  const out = new Map();
  const checks = messages.filter(untrusted);
  for (let i = 0; i < checks.length; i += 100) {
    const batch = checks.slice(i, i + 100);
    // eslint-disable-next-line no-await-in-loop
    const stored = await agent.ctx.storage.get(batch.map((m) => `verdict:${m.id}`));
    for (const m of batch) {
      let v = stored.get(`verdict:${m.id}`);
      // Kept before this was so: not a verdict either.
      if (!v || v.p === null) {
        // eslint-disable-next-line no-await-in-loop
        v = await screen(agent.env, m);
        if (v.p !== null) {
          // eslint-disable-next-line no-await-in-loop
          await agent.ctx.storage.put(`verdict:${m.id}`, v);
        }
        console.log(JSON.stringify({
          route: 'agent', check: 'injection', message: m.id, p: v.p, flagged: v.flagged,
        }));
      }
      out.set(m.id, v);
    }
  }
  return out;
}

/** Wakes the agent a day after message `mark`, unless another one comes first. */
export async function armIdle(agent, mark) {
  const previous = await agent.ctx.storage.get('idle');
  if (previous) {
    await agent.cancelSchedule(previous).catch(() => false);
  }
  const s = await agent.schedule(IDLE_SECONDS, 'idle', { mark });
  await agent.ctx.storage.put('idle', s.id);
}

/** Schedule callback: a day without messages. */
export async function idle(agent, payload) {
  const mark = await agent.ctx.storage.get('mark');
  if (!payload || payload.mark !== mark || modelProblem(agent.env)) {
    return;
  }
  // Turned off since: no wrap-up either.
  const t = await agent.target();
  if (!t.key || !await agentEnabled(agent.env, t.channelId, t.team)) {
    return;
  }
  await agent.ctx.storage.delete('idle');
  await agent.syncTools();
  await agent.syncMcp();
  await agent.harness.submit(IDLE_PROMPT, { operationId: `idle:${mark}`, whenBusy: 'followUp' });
}

async function tell(agent, { retry }) {
  const { env, ctx: { storage } } = agent;
  const problem = modelProblem(env);
  if (problem) {
    return { result: 'skip', reason: problem };
  }
  const t = await agent.target();
  if (!t.key || t.kind !== 'channel' || !await agentEnabled(env, t.channelId, t.team)) {
    return { result: 'skip', reason: 'no agent for this thread' };
  }
  const entry = await entryMessages(env, t.key);
  const mark = await storage.get('mark');
  const unseen = (entry ? entry.messages : []).filter((m) => !mark || markOf(m) > mark);
  // Its own posts (post_message) come back as messages; it is not told about them.
  const own = new Set((await storage.get('posted')) || []);
  const fresh = unseen.filter((m) => !own.has(String(m.id)));
  if (!unseen.length) {
    return { result: 'unchanged' };
  }
  const last = markOf(unseen[unseen.length - 1]);
  if (!fresh.length) {
    await storage.put('mark', last);
    // The wrap-up counts from the latest message, its own too, and looks for this mark.
    await armIdle(agent, last);
    return { result: 'unchanged', own: unseen.length };
  }
  const verdicts = await agent.verdicts(fresh);
  // Before the mark moves past them: the queue asks again, a while later.
  if (retry && [...verdicts.values()].some((v) => v.p === null)) {
    throw new Error('the injection check failed');
  }
  const outside = await mentionedOutside(
    env,
    entry,
    fresh.filter((m) => !(verdicts.get(m.id) && verdicts.get(m.id).flagged)),
  ).catch((e) => {
    console.log(JSON.stringify({ route: 'agent', members: 'failed', error: e.message }));
    return null;
  });
  const input = deliveryText(entry, fresh, verdicts, { first: !mark, outside });
  await agent.syncTools();
  await agent.syncMcp();
  await agent.syncUploads(entry);
  const receipt = await agent.harness.submit(input, {
    operationId: `messages:${last}`,
    whenBusy: 'steer',
  });
  await storage.put('mark', last);
  await armIdle(agent, last);
  const flagged = [...verdicts.values()].filter((v) => v.flagged).length;
  return {
    result: 'delivered', messages: fresh.length, flagged, accepted: receipt.accepted,
  };
}

/**
 * Tells the agent about the messages it has not seen. One at a time: two pokes that overlap
 * would both read the same mark, and tell it the same messages twice. With `retry`, a failed
 * injection check throws, so that the queue tries again before the messages are told withheld.
 */
export function deliver(agent, { retry = false } = {}) {
  const run = (agent.delivering || Promise.resolve()).catch(() => {})
    .then(() => tell(agent, { retry }));
  // eslint-disable-next-line no-param-reassign
  agent.delivering = run;
  return run;
}
