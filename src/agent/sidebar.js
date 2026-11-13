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

import { entryOf } from '../drafts.js';
import { notifyRoom } from '../notify.js';
import { keepSidebarAnswer, sidebarNote } from '../sidebar.js';
import { modelProblem } from './model.js';
import { sidebarTurns, turnSidebar } from './turn.js';

// The sidebar answers last kept, by message, in the agent's storage: at most this many.
const MAX_KEPT = 100;

/**
 * The agent's side of the sidebar (src/sidebar.js). `agent` is the ThreadAgent (its `env`,
 * `name`, `syncTools`, `syncMcp` and `harness`); these functions are its `sidebar`, `inSidebar`
 * and the sidebar half of `keepTurn`, kept here so they run in Node tests.
 */

/**
 * ThreadAgent.sidebar: a person's sidebar message, `{ id, by, text }`, into the agent's own
 * conversation, after the run it is in (a run on new messages, say): never steered into one,
 * whose posts would then be the sidebar's. Once per message.
 */
export async function talk(agent, { id, by, text }) {
  const problem = modelProblem(agent.env);
  if (problem) {
    return { error: problem };
  }
  await agent.syncTools();
  await agent.syncMcp();
  const receipt = await agent.harness.submit(sidebarNote({ id, by, text }), {
    operationId: `sidebar:${id}`,
    whenBusy: 'followUp',
  });
  return { ok: true, accepted: receipt.accepted };
}

/**
 * ThreadAgent.inSidebar: whether the turn running now answers a sidebar message, so that
 * nothing it does reaches the channel. A transcript that cannot be read counts as one: posting
 * waits for the next turn rather than risk it.
 */
export async function inSidebar(agent) {
  try {
    return Boolean(turnSidebar(await agent.harness.messages()));
  } catch {
    return true;
  }
}

/**
 * The agent's finished answer to a sidebar message (`turn`, with its `sidebar` id), into the
 * thread's sidebar; the inboxes of the thread's teams hear of it. Whether it was written.
 */
export async function keepAnswer(agent, turn) {
  const { env } = agent;
  if (!await keepSidebarAnswer(env, agent.name, turn)) {
    return false;
  }
  const entry = await entryOf(env, agent.name).catch(() => null);
  if (entry) {
    await notifyRoom(env, entry.teams, { type: 'sidebar', thread: entry.key });
  }
  return true;
}

/**
 * The agent's finished answers to sidebar messages in its transcript, each into the thread's
 * sidebar (`keepAnswer`) once it has changed since it was last kept (`sidebar-kept` in storage):
 * every one, not only the latest turn's, since another input may be queued right behind one. If
 * writing one fails, none of them is marked kept, and the next call tries again.
 */
export async function keepAnswers(agent) {
  const { storage } = agent.ctx;
  const turns = sidebarTurns(await agent.harness.messages()).filter((t) => t.state !== 'working');
  if (!turns.length) {
    return 0;
  }
  const kept = new Map((await storage.get('sidebar-kept')) || []);
  let written = 0;
  for (const turn of turns) {
    const sig = `${turn.state}:${turn.endedAt}:${turn.text}`;
    if (kept.get(turn.sidebar) !== sig) {
      // eslint-disable-next-line no-await-in-loop
      if (await keepAnswer(agent, turn)) {
        written += 1;
      }
      kept.delete(turn.sidebar);
      kept.set(turn.sidebar, sig);
    }
  }
  await storage.put('sidebar-kept', [...kept].slice(-MAX_KEPT));
  return written;
}
