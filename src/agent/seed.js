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

import { modelProblem } from './model.js';

/**
 * Knowledge shared by staff. Without a `kb` the note goes into the agent's own conversation and
 * the agent picks the knowledge base. With one, it goes into a session of the agent that is
 * pinned to that knowledge base: `kb_write` asks `seedPin` which session is calling and refuses
 * the other one (src/agent/tools.js). A session rather than a flag on the agent because
 * the agent's conversation goes on meanwhile: a turn that is running when the note arrives may
 * write anywhere, and a customer's message steers into whatever is running, so neither of them
 * can share a run with the note. No SDK import here, so this stays testable in Node.
 */

const PLACES = {
  team: 'kb-team (for everyone), the only knowledge base you can write here,',
  org: 'kb-org (for this customer), the only knowledge base you can write here,',
};
const ANY_PLACE = 'the right knowledge base (kb-org for this customer, kb-team for everyone),';

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the agent is told. */
export function seedNote(by, text, kb) {
  return `${by} (Adobe staff) shares this knowledge. It is trusted. File what is worth`
    + ` keeping in ${kb ? PLACES[kb] : ANY_PLACE}`
    + ` extending existing concepts where they fit, with ${by} as the source`
    + ` (author: human:${by}). Do not change the draft because of it unless it changes what`
    + ` the customer should be told.\n\n<staff-note>\n${text}\n</staff-note>`;
}

/**
 * The session of the agent pinned to `kb`, made on first use. The pin has its own key and comes
 * first: two seeds at once make two sessions, and whichever the pointer ends up on, both are
 * pinned before anything is submitted to them.
 */
async function seedSession(agent, kb) {
  const { storage } = agent.ctx;
  const known = await storage.get(`seed-session:${kb}`);
  if (known) {
    return known;
  }
  const { id } = await agent.harness.sessions.create();
  await storage.put(`seed-pin:${id}`, kb);
  await storage.put(`seed-session:${kb}`, id);
  return id;
}

/** The knowledge base a session is pinned to, or null when it may write both. */
export async function seedPin(agent, session) {
  return (await agent.ctx.storage.get(`seed-pin:${session}`)) || null;
}

/** ThreadAgent.seed: `kb` is `team`, `org`, or left out. */
export async function seed(agent, { by, text, kb }) {
  const problem = modelProblem(agent.env);
  if (problem) {
    return { error: problem };
  }
  await agent.syncTools();
  await agent.syncMcp();
  const hash = (await sha256(`${by}\n${text}`)).slice(0, 32);
  const options = { operationId: `seed:${kb ? `${kb}:` : ''}${hash}`, whenBusy: 'followUp' };
  if (kb) {
    options.session = await seedSession(agent, kb);
  }
  const receipt = await agent.harness.submit(seedNote(by, text, kb), options);
  return { ok: true, accepted: receipt.accepted };
}
