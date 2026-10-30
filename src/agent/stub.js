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

import { AGENT_EMAIL, entryOf } from '../drafts.js';
import { json } from '../http.js';
import { ensureKnowledgeBase, repoName } from '../kb.js';
import { agentEnabled } from './enabled.js';

/**
 * Reaching thread agents from the Worker: the queue pokes them, the inbox API seeds them and
 * asks how they are. No Agents SDK import here, so these paths stay testable in Node.
 */

export const AGENT_DELAY_SECONDS = 15;
const MAX_SEED = 8000;
const KBS = ['team', 'org'];

/** The started agent named `name` (an inbox entry key, or `kb:<team>:<org>`). */
export async function agentStub(env, name) {
  const stub = env.AGENTS.get(env.AGENTS.idFromName(name));
  // What the SDK's getAgentByName does: wait for the agent's startup before calling it.
  // eslint-disable-next-line no-underscore-dangle
  await stub.__unsafe_ensureInitialized();
  return stub;
}

/** Queue job `{ agent: thread }`: the thread's agent reads what is new. */
export async function pokeAgent(env, thread) {
  if (!env.AGENTS) {
    return { result: 'skip', reason: 'no AGENTS binding' };
  }
  const entry = await entryOf(env, thread);
  if (!entry) {
    return { result: 'skip', reason: 'unknown thread' };
  }
  const agent = await agentStub(env, entry.key);
  return { agent: entry.key, ...await agent.deliver() };
}

async function threadTarget(env, key) {
  const entry = await entryOf(env, key);
  if (!entry) {
    return null;
  }
  const row = await env.DB.prepare('SELECT channel_id, team, org, kind FROM threads WHERE thread = ?')
    .bind(entry.key).first();
  return {
    entry,
    // Whose knowledge bases its agent has: as ThreadAgent.target reads them.
    team: row ? row.team : null,
    org: row ? row.org : null,
    enabled: Boolean(row && row.kind === 'channel' && await agentEnabled(env, row.channel_id, row.team)),
  };
}

/**
 * POST /api/agent/seed `{ thread, text }` or `{ team, org, text }`: shares knowledge with the
 * thread's agent, or with the knowledge-base agent of a team and customer, which files it in
 * the knowledge bases. Only members of the team.
 *
 * `kb` (`team` or `org`, on either form) chooses the knowledge base, and the agent cannot write
 * the other one (src/agent/seed.js). `{ team, kb: 'team', text }` needs no customer. Only the
 * chosen knowledge base is created when it is missing.
 */
export async function seedAgent(env, me, body, inTeam) {
  const text = String((body && body.text) || '').trim();
  if (!text || text.length > MAX_SEED) {
    return json({ error: `write what the agent should know (up to ${MAX_SEED} characters)` }, 400);
  }
  const kb = body.kb ?? null;
  if (kb !== null && !KBS.includes(kb)) {
    return json({ error: 'kb is "team" or "org"' }, 400);
  }
  if (me.readonly) {
    return json({ error: 'read-only while viewing as someone else' }, 403);
  }
  if (!env.AGENTS) {
    return json({ error: 'agents are not configured' }, 503);
  }
  let name;
  if (body.thread) {
    const t = await threadTarget(env, body.thread);
    if (!t || !await inTeam(t.entry.teams, t.entry)) {
      return json({ error: 'not found' }, 404);
    }
    if (!t.enabled) {
      return json({ error: 'this thread has no agent' }, 409);
    }
    if (kb) {
      // Only ever the thread's own: naming another team or customer is a mistake, not a target.
      if ((body.team && body.team !== t.team) || (body.org && body.org !== t.org)) {
        return json({ error: 'kb goes to the thread\'s own team and customer' }, 400);
      }
      if (!repoName(kb, t[kb])) {
        return json({ error: `this thread has no ${kb === 'org' ? 'customer' : 'team'} knowledge base` }, 400);
      }
      await ensureKnowledgeBase(env, kb, t[kb]);
    }
    name = t.entry.key;
  } else {
    const team = String(body.team || '');
    const org = String(body.org || '');
    if (kb === 'org' && !org) {
      return json({ error: 'kb "org" needs a customer slug' }, 400);
    }
    const orgFits = org ? repoName('org', org) : kb === 'team';
    if (!repoName('team', team) || !orgFits || !await inTeam(team)) {
      return json({ error: 'give a thread, or one of your teams and a customer slug (only kb "team" goes without one)' }, 400);
    }
    name = `kb:${team}:${org}`;
    // A customer that has no channel yet has no knowledge base yet either.
    if (kb) {
      await ensureKnowledgeBase(env, kb, kb === 'team' ? team : org);
    } else {
      await ensureKnowledgeBase(env, 'team', team);
      await ensureKnowledgeBase(env, 'org', org);
    }
  }
  const agent = await agentStub(env, name);
  const by = me.name || me.email || 'staff';
  const res = await agent.seed(kb ? { by, text, kb } : { by, text });
  return json(res, res.error ? 503 : 202);
}

/**
 * After DELETE /api/draft (`result`: what discardDraft answered): when the draft a person
 * discarded was the agent's, the thread's agent hears who discarded it and what it said, so it
 * learns which drafts are not wanted. A draft a person saved last, or one a reply used up, is
 * not the agent's business.
 */
export async function tellDiscarded(env, me, key, result) {
  const draft = result && result.discarded && result.draft;
  if (!env.AGENTS || !draft) {
    return { result: 'skip', reason: 'nothing discarded' };
  }
  const saver = await env.DB.prepare('SELECT email FROM people WHERE id = ?')
    .bind(draft.by && draft.by.id).first();
  if (!saver || saver.email !== AGENT_EMAIL) {
    return { result: 'skip', reason: 'not the agent\'s draft' };
  }
  const t = await threadTarget(env, key);
  if (!t || !t.enabled) {
    return { result: 'skip', reason: 'no agent' };
  }
  const agent = await agentStub(env, t.entry.key);
  return agent.discarded({
    by: me.name || me.email || 'staff', body: draft.body, version: draft.updated_at,
  });
}

/** GET /api/agent?thread=…: whether the thread has an agent, and what it is doing. */
export async function agentStatus(env, key, canSee) {
  const t = await threadTarget(env, key);
  if (!t || !await canSee(t.entry.teams, t.entry)) {
    return json({ error: 'not found' }, 404);
  }
  if (!t.enabled || !env.AGENTS) {
    return json({ enabled: false });
  }
  const agent = await agentStub(env, t.entry.key);
  return json({ enabled: true, ...await agent.status() });
}

/**
 * The trace of a thread's agent (src/agent/trace.js), for the admin team: `{ enabled: false }`
 * when its channel has no agent (an agent is not started just to be looked at), else
 * `{ enabled: true, status, steps, earlier, usage }`. Null for an unknown thread.
 */
export async function agentTrace(env, key, options = {}) {
  const t = await threadTarget(env, key);
  if (!t) {
    return null;
  }
  if (!t.enabled || !env.AGENTS) {
    return { enabled: false };
  }
  const agent = await agentStub(env, t.entry.key);
  return { enabled: true, ...await agent.trace(options) };
}
