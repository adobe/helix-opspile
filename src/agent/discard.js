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

import { AGENT_EMAIL, draftOf, draftsFor } from '../drafts.js';
import { agentEnabled } from './enabled.js';
import { modelProblem } from './model.js';

/**
 * A draft of the thread agent's that a person discarded (DELETE /api/draft, src/agent/stub.js
 * tellDiscarded): the agent hears who did and what it said, as feedback. `agent` is the
 * ThreadAgent (its `env`, `schedule`, `target`, `syncTools`, `syncMcp` and `harness`); these
 * functions are its `discarded` and `discardNote`, kept here so they run in Node tests.
 */

// After the inbox's Undo (8 s) has run out.
export const DISCARD_SECONDS = 30;

/**
 * The input for a discarded draft (`by`, `body`). `now` is the thread's draft since, if any;
 * `mine` says the agent saved that one itself.
 */
export function discardText({ by, body }, now, { mine = false } = {}) {
  let since = '';
  if (now && mine) {
    since = ' You have saved a new draft since: check it against this feedback.';
  } else if (now) {
    since = ` ${(now.by && now.by.name) || 'A colleague'} has saved another draft since: leave it alone.`;
  }
  return `${by} (Adobe staff) discarded the shared draft you saved, without sending it.${since}`
    + ' Take it as feedback on your draft. Look at the thread for why it was not wanted: Adobe'
    + ' staff answering themselves, nothing to reply to yet, or something in it that was'
    + ' wrong, premature or not what the team would say. Do not save it again, and save a new'
    + ' draft only when something new in the thread calls for one. If there is a lesson that'
    + ' holds beyond this thread, file it in kb-team; if you cannot tell why, file nothing.'
    + `\n\n<discarded-draft>\n${body}\n</discarded-draft>`;
}

/** ThreadAgent.discarded: tells the agent once Undo is no longer possible. */
export async function discarded(agent, { by, body, version }) {
  const problem = modelProblem(agent.env);
  if (problem) {
    return { error: problem };
  }
  await agent.schedule(DISCARD_SECONDS, 'discardNote', { by, body, version });
  return { ok: true };
}

/**
 * ThreadAgent.discardNote, the schedule callback: submits the feedback, unless the agent was
 * turned off since or the draft came back. Undo saves the same text again as the person who
 * discarded it; the same text saved by the agent itself is not an Undo, and is told.
 */
export async function discardNote(agent, payload) {
  const { env } = agent;
  const t = await agent.target();
  if (!payload || !t.key || modelProblem(env) || !await agentEnabled(env, t.channelId, t.team)) {
    return { result: 'skip', reason: 'no agent' };
  }
  const keys = [t.key, ...(t.threads || [])];
  const now = draftOf(await draftsFor(env, keys), keys);
  const me = now && await env.DB.prepare('SELECT id FROM people WHERE email = ?')
    .bind(AGENT_EMAIL).first();
  const mine = Boolean(me && now.by && now.by.id === me.id);
  if (now && !mine && now.body === payload.body) {
    return { result: 'skip', reason: 'undone' };
  }
  await agent.syncTools();
  await agent.syncMcp();
  await agent.harness.submit(discardText(payload, now, { mine }), {
    operationId: `discard:${payload.version}`,
    whenBusy: 'followUp',
  });
  return { result: 'told' };
}
