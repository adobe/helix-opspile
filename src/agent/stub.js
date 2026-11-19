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
  AGENT_EMAIL, ENTRY_ROW, entryFields, entryOf,
} from '../drafts.js';
import { requestOf } from '../bashrequests.js';
import { json } from '../http.js';
import { ensureKnowledgeBase, repoName } from '../kb.js';
import { notifyRoom } from '../notify.js';
import {
  addSidebarMessage, MAX_SIDEBAR, seeSidebar, sidebarId,
} from '../sidebar.js';
import {
  denyToolRequest, grantToolRequest, revokeToolRequest, toolRequestOf,
} from '../toolrequests.js';
import { denyText, grantText } from './toolrequest.js';
import { switchedOn } from './enabled.js';
import { liveTurn } from './kept.js';

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

/**
 * Queue job `{ agent: thread }`: the thread's agent reads what is new. With `retry`, the queue
 * will deliver this job again, so a failed injection check throws instead of telling the agent
 * that the messages are withheld.
 */
export async function pokeAgent(env, thread, { retry = false } = {}) {
  if (!env.AGENTS) {
    return { result: 'skip', reason: 'no AGENTS binding' };
  }
  const entry = await entryOf(env, thread);
  if (!entry) {
    return { result: 'skip', reason: 'unknown thread' };
  }
  const agent = await agentStub(env, entry.key);
  return { agent: entry.key, ...await agent.deliver({ retry }) };
}

/**
 * Thread `key`'s entry (`entryOf`, without its members' keys), whose knowledge bases its agent
 * has, whether it has one, and what its agent last kept as doing (`live`, its `agent_live` row,
 * or null), in one round trip: the inbox asks for this whenever a thread opens (GET /api/agent),
 * and it took five in a row.
 */
async function threadTarget(env, key) {
  if (!key) {
    return null;
  }
  const row = await env.DB.prepare(`${ENTRY_ROW}, a.team AS a_team, a.org AS a_org,
      a.kind AS a_kind, a.channel_id AS a_channel,
      (SELECT enabled FROM agent_channels WHERE channel_id = a.channel_id) AS channel,
      (SELECT enabled FROM agent_teams WHERE team = a.team) AS on_team,
      l.turn AS live_turn, l.at AS live_at
    FROM t LEFT JOIN threads a ON a.thread = t.k LEFT JOIN agent_live l ON l.thread = t.k`)
    .bind(String(key)).first();
  if (!row) {
    return null;
  }
  const anchor = row.a_kind != null;
  return {
    entry: entryFields(row),
    // Whose knowledge bases its agent has: as ThreadAgent.target reads them.
    team: anchor ? row.a_team : null,
    org: anchor ? row.a_org : null,
    enabled: anchor && row.a_kind === 'channel'
      && switchedOn(env, row.a_channel, { channel: row.channel, team: row.on_team }),
    live: row.live_at ? { turn: row.live_turn, at: row.live_at } : null,
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
 * POST /api/agent/sidebar `{ thread, text }`: a person on the team talks to the thread's agent in
 * the inbox's sidebar (src/sidebar.js). The message goes into the thread's sidebar and into the
 * agent's conversation, and nowhere else: never to the platform. The agent answers it when it is
 * done with what it is doing; the inboxes of the thread's teams hear of both. Only who may work
 * the thread. Answers 202 with the message.
 */
export async function talkToAgent(env, me, body, inTeam) {
  const text = String((body && body.text) || '').trim();
  if (!text || text.length > MAX_SIDEBAR) {
    return json({ error: `write what to ask the agent (up to ${MAX_SIDEBAR} characters)` }, 400);
  }
  if (me.readonly) {
    return json({ error: 'read-only while viewing as someone else' }, 403);
  }
  if (!env.AGENTS) {
    return json({ error: 'agents are not configured' }, 503);
  }
  const t = await threadTarget(env, body.thread);
  if (!t || !await inTeam(t.entry.teams, t.entry)) {
    return json({ error: 'not found' }, 404);
  }
  if (!t.enabled) {
    return json({ error: 'this thread has no agent' }, 409);
  }
  const by = me.name || me.email || 'staff';
  // Written first: the agent's answer is kept only for a message the thread has.
  const message = await addSidebarMessage(env, t.entry.key, {
    id: sidebarId(), person: me.id, name: by, text,
  });
  const agent = await agentStub(env, t.entry.key);
  const res = await agent.sidebar({ id: message.id, by, text })
    .catch((e) => ({ error: e.message }));
  if (res.error) {
    await env.DB.prepare('DELETE FROM sidebar_messages WHERE id = ?').bind(message.id).run();
    return json({ error: res.error }, 503);
  }
  await notifyRoom(env, t.entry.teams, { type: 'sidebar', thread: t.entry.key });
  return json({ message }, 202);
}

/**
 * POST /api/agent/sidebar/seen `{ thread, ids }`: the person was shown the agent's answers `ids`
 * to them in the sidebar of thread `thread` (src/sidebar.js, seeSidebar), so the inbox marks it
 * no more. Their other inboxes hear of it (`sidebar-seen`, with the person), and only they act on
 * it. Answers 204.
 */
export async function sawSidebar(env, me, body, inTeam) {
  const ids = body && body.ids;
  if (!Array.isArray(ids) || !ids.length) {
    return json({ error: 'name the answers seen' }, 400);
  }
  const t = await threadTarget(env, body.thread);
  if (!t || !await inTeam(t.entry.teams, t.entry)) {
    return json({ error: 'not found' }, 404);
  }
  if (await seeSidebar(env, me.id, ids)) {
    await notifyRoom(env, t.entry.teams, { type: 'sidebar-seen', thread: t.entry.key, person: me.id });
  }
  return new Response(null, { status: 204 });
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

/**
 * POST /api/bash/run `{ thread, id, env }` and POST /api/bash/deny `{ thread, id }`: a person
 * runs, with the values they filled in for its variables (`env`: `{ NAME: value }`), or denies
 * a command the thread's agent asked for (src/agent/bashrequest.js). Only who may work the
 * thread. The agent that asked decides the rest, in its own object: whether the request can
 * still be run, and the run itself, on its computer; `run` answers 202 once the command has
 * started, and the inbox hears how it ended through the team's room. The values go to the
 * agent's object and from there to the shell, and are neither kept nor logged.
 */
export async function decideBash(env, me, body, inTeam, { run }) {
  if (!env.AGENTS) {
    return json({ error: 'agents are not configured' }, 503);
  }
  const entry = await entryOf(env, body && body.thread);
  if (!entry || !await inTeam(entry.teams, entry)) {
    return json({ error: 'not found' }, 404);
  }
  const request = await requestOf(env, body.id);
  // Of this entry: one of its member threads asked (a thread folded into a group since).
  if (!request || !entry.keys.includes(request.thread)) {
    return json({ error: 'not found' }, 404);
  }
  const by = { id: me.id, name: me.name || me.email || 'staff' };
  const agent = await agentStub(env, request.thread);
  const res = run
    ? await agent.runBash({ id: request.id, values: body.env || {}, by })
    : await agent.denyBash({ id: request.id, by });
  const { status, ...rest } = res;
  return json(rest, status || (run ? 202 : 200));
}

/** Why tool request `r` can no longer be decided as asked. */
function toolDecided(r) {
  const by = (p) => (p && p.name) || 'Someone';
  return {
    granted: `${by(r.by)} granted it already`,
    denied: `${by(r.by)} denied it already`,
    revoked: `${by(r.revoked_by)} ended it already`,
    expired: 'Nobody decided before its deadline: the agent can ask again',
    ended: 'Its day is over: the agent can ask again',
    pending: 'It was not granted yet',
  }[r.status] || 'It was decided already';
}

/**
 * POST /api/agent/tools/grant, …/deny and …/revoke `{ thread, id }`: a person decides on a tool
 * the thread's agent asked for in its sidebar (src/agent/toolrequest.js), or ends a grant. Only
 * who may work the thread. A grant or a denial is said to the agent in the sidebar, as the
 * person's sidebar message (`grantText`, `denyText`), and the agent answers it there; it has a
 * granted tool from that message on, as its tools are read before each one. Ended early, the
 * agent goes without it from its next message. Answers with the request, and the sidebar
 * message when there is one.
 */
export async function decideTool(env, me, body, inTeam, action) {
  if (me.readonly) {
    return json({ error: 'read-only while viewing as someone else' }, 403);
  }
  if (!env.AGENTS) {
    return json({ error: 'agents are not configured' }, 503);
  }
  const t = await threadTarget(env, body && body.thread);
  if (!t || !await inTeam(t.entry.teams, t.entry)) {
    return json({ error: 'not found' }, 404);
  }
  const request = await toolRequestOf(env, body.id);
  // The agent that asked is the one that gets it: the entry's.
  if (!request || request.thread !== t.entry.key) {
    return json({ error: 'not found' }, 404);
  }
  if (action !== 'revoke' && !t.enabled) {
    return json({ error: 'this thread has no agent', request }, 409);
  }
  const by = me.name || me.email || 'staff';
  const change = {
    grant: grantToolRequest, deny: denyToolRequest, revoke: revokeToolRequest,
  }[action];
  if (!await change(env, request.id, me.id)) {
    const now = await toolRequestOf(env, request.id);
    return json({ error: toolDecided(now), request: now }, 409);
  }
  const decided = await toolRequestOf(env, request.id);
  console.log(JSON.stringify({
    route: 'agent', action: `tool_${action}`, id: request.id, kind: request.kind, name: request.name,
  }));
  const agent = await agentStub(env, t.entry.key);
  if (action === 'revoke') {
    // At once where the agent is at work; else at its next message, which reads them anyway.
    await Promise.all([agent.syncTools(), agent.syncMcp()]).catch(() => {});
    await notifyRoom(env, t.entry.teams, { type: 'sidebar', thread: t.entry.key });
    return json({ request: decided });
  }
  const text = action === 'grant' ? grantText(decided) : denyText(decided);
  const message = await addSidebarMessage(env, t.entry.key, {
    id: sidebarId(), person: me.id, name: by, text,
  });
  const res = await agent.sidebar({ id: message.id, by, text })
    .catch((e) => ({ error: e.message }));
  if (res.error) {
    // Decided all the same: the agent has a granted tool at its next message.
    await env.DB.prepare('DELETE FROM sidebar_messages WHERE id = ?').bind(message.id).run();
    await notifyRoom(env, t.entry.teams, { type: 'sidebar', thread: t.entry.key });
    return json({ request: decided, error: `the agent was not told: ${res.error}` });
  }
  await notifyRoom(env, t.entry.teams, { type: 'sidebar', thread: t.entry.key });
  return json({ request: decided, message }, 202);
}

/**
 * GET /api/agent?thread=…: whether the thread has an agent, and what it is doing (`turn`), as the
 * agent last kept it in D1 (`agent_live`, src/agent/kept.js): the agent's object is not started
 * for it. Only an agent that has kept none, or one whose turn has worked for longer than a run
 * takes without a word (its object stopped half way), is asked itself, which keeps it again.
 */
export async function agentStatus(env, key, canSee, { now = Date.now() } = {}) {
  const t = await threadTarget(env, key);
  if (!t || !await canSee(t.entry.teams, t.entry)) {
    return json({ error: 'not found' }, 404);
  }
  if (!t.enabled || !env.AGENTS) {
    return json({ enabled: false });
  }
  const turn = liveTurn(t.live, now);
  if (turn !== undefined) {
    return json({ enabled: true, turn });
  }
  // One call to the agent's object, not two: `status` waits for the agent's startup itself
  // (agentStub's first call). In `Server-Timing` as `agent`.
  const agent = env.AGENTS.get(env.AGENTS.idFromName(t.entry.key));
  const ask = () => agent.status();
  return json({ enabled: true, ...await (env.timing ? env.timing.time('agent', ask) : ask()) });
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
