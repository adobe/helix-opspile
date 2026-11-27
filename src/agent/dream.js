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

/*
 * A dream (the dream experiment, src/experiments.js; started by src/dreams.js): the knowledge-base
 * agent of a team and customer (`kb:<team>:<org>`) reviews the customer's knowledge base, kb-org,
 * while its channels are quiet, and makes it a more concise picture: duplicates merged, misfiled
 * concepts moved, contradictions resolved by the newest source. Each dream is a session of its
 * own, pinned to kb-org as a seed's is (`seed-pin:<session>`, src/agent/seed.js), so kb_write
 * refuses anything else, and it starts without the context of the dreams before it.
 *
 * `agent` is the ThreadAgent (its `env`, `ctx.storage`, `syncTools`, `syncMcp` and `harness`);
 * these functions are its `dream`, `dreamState` and `dreamOf`, kept here so they run in Node
 * tests. In its storage: `dream-session:<id>` (the dream's session) and `dream-of:<session>` (the
 * dream a session is), both written before anything is submitted.
 */

const MAX_NOTE = 2000;

/** What the agent is told: a dream of kb-org, on `day` (YYYY-MM-DD). */
export function dreamPrompt(day) {
  return `It is ${day}, and nothing has been posted in this customer's channels for eight hours:`
    + ' time to dream. Review kb-org, the customer\'s knowledge base, and make it a more concise'
    + ' picture of what we know, without losing anything that is known. kb-org is the only'
    + ' knowledge base you can write here; nobody waits for an answer.\n\n'
    + '1. Orient: read index.md, and list every file (git_ls kb-org, recursive).\n'
    + '2. Look for overlap: concepts about the same thing (a site, an issue, a person, a decision)'
    + ' under different names or in different directories; facts repeated across concepts;'
    + ' concepts that contradict each other; concepts outside the directory of their type; and'
    + ' people with more than one Contact. git_grep finds a name or a host across files; read'
    + ' the candidates before you change them.\n'
    + '3. Consolidate: merge each set of duplicates into one concept, at the path its type'
    + ' belongs to, and delete the others in the same kb_write (with `base` for each file). Keep'
    + ' every `sources` entry, footnote and alias of what you merge, and fix the links that'
    + ' pointed at what moved. Where concepts disagree, keep what the newest dated source says and'
    + ' note the older claim as superseded, with its date; where you cannot tell which is right,'
    + ' keep both and say so. Turn relative dates ("last week") into dates where the source shows'
    + ' when it was said. Split a concept that is about unrelated things.\n'
    + '4. Prune: say once what a concept says twice; leave out nothing that is said once.\n\n'
    + 'Do not add anything the knowledge bases do not already say, look nothing up elsewhere, and'
    + ' leave stack.md and systemprompt.md alone. One kb_write per merge or move (up to 20 files'
    + ' each), its message saying what was merged into what. If kb-org is concise already,'
    + ' change nothing. End with one to three sentences: what you merged, moved and deleted.';
}

/** The dream session `session` is, or null (`dream-of:<session>`). */
export async function dreamOf(agent, session) {
  return (session && (await agent.ctx.storage.get(`dream-of:${session}`))) || null;
}

/** The session of dream `id`, made on first use: pinned to kb-org, and known as the dream's. */
async function dreamSession(agent, id) {
  const { storage } = agent.ctx;
  const known = await storage.get(`dream-session:${id}`);
  if (known) {
    return known;
  }
  const { id: session } = await agent.harness.sessions.create();
  await storage.put(`seed-pin:${session}`, 'org');
  await storage.put(`dream-of:${session}`, String(id));
  await storage.put(`dream-session:${id}`, session);
  return session;
}

/**
 * ThreadAgent.dream `{ id }`: dream `id` (a `kb_dreams` row) starts, in a session of its own. Asked
 * again, it is the same dream: the same session and operation, accepted once.
 */
export async function dream(agent, { id, now = new Date() } = {}) {
  if (!id) {
    return { error: 'no dream' };
  }
  if (!String(agent.name || '').startsWith('kb:')) {
    return { error: 'only a knowledge-base agent dreams' };
  }
  const problem = modelProblem(agent.env);
  if (problem) {
    return { error: problem };
  }
  await agent.syncTools();
  await agent.syncMcp();
  const session = await dreamSession(agent, id);
  const receipt = await agent.harness.submit(dreamPrompt(now.toISOString().slice(0, 10)), {
    operationId: `dream:${id}`, session, whenBusy: 'followUp',
  });
  return { ok: true, accepted: receipt.accepted };
}

/**
 * ThreadAgent.dreamState `{ id }`: where dream `id` stands. `{ state: 'unknown' }` (never
 * started here), `queued`, `running` or `parked` (pi's crash-loop guard stopped it), or `settled`
 * with its `status` (`done`, `unanswered`) and `note`, its closing sentences.
 */
export async function dreamState(agent, { id } = {}) {
  const session = id && await agent.ctx.storage.get(`dream-session:${id}`);
  if (!session) {
    return { state: 'unknown' };
  }
  const operationId = `dream:${id}`;
  const pending = await agent.harness.pending({ session });
  const mine = pending.find((p) => p.operationId === operationId);
  if (mine) {
    return { state: mine.status === 'parked' ? 'parked' : mine.status };
  }
  const signal = AbortSignal.timeout(5000);
  const settled = await agent.harness.wait(operationId, { session, signal }).catch(() => null);
  if (!settled) {
    return { state: 'running' };
  }
  return {
    state: 'settled',
    status: settled.status,
    ...(settled.reason ? { reason: settled.reason } : {}),
    note: settled.text ? String(settled.text).slice(0, MAX_NOTE) : null,
  };
}
