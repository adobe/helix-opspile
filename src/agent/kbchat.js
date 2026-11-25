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
  addChatMessage, chatEventLine, chatEventNote, chatMessageId, chatNote, dropChatMessage, isChatId,
  keepChatAnswer,
} from '../kbchat.js';
import { modelProblem } from './model.js';
import { latestTurn, sidebarTurns } from './turn.js';

/*
 * The knowledge-base agent's side of the knowledge base's sidebar (src/kbchat.js). `agent` is
 * the ThreadAgent (its `env`, `name`, `ctx.storage`, `syncTools`, `syncMcp` and `harness`);
 * these functions are its `chat` (`talkInChat`), `chatState` and `chatOf`, and the sidebar
 * half of its `keepTurn`, kept here so they run in Node tests.
 *
 * Each conversation is a session of its own, pinned to the knowledge base as a seed's is
 * (`seed-pin:<session>`, src/agent/seed.js), so kb_write and draw_stack refuse any other one, and
 * known as the conversation's (`chat-of:<session>`: its id, the knowledge base, who talks in it,
 * `person` and `by`, and whether they may have it changed, `write`, as of their latest message),
 * which gives it the tools that read every thread (src/agent/tools.js `kbChatExtension`) and,
 * for `write`, those that change it. In storage: `chat-session:<chat>`, `chat-of:<session>`,
 * both written before anything is submitted, `chats-open` (the conversations with an answer
 * not kept yet) and `chat-kept:<chat>` (what was kept of each answer).
 */

const KBS = ['team', 'org'];

/** The conversation `session` is, `{ chat, kb, repo, by, person, write }`, or null. */
export async function chatOf(agent, session) {
  return (session && (await agent.ctx.storage.get(`chat-of:${session}`))) || null;
}

/** The session of conversation `chat`, made on first use: pinned to `kb`, known as the chat's. */
async function chatSession(agent, who) {
  const { storage } = agent.ctx;
  const known = await storage.get(`chat-session:${who.chat}`);
  if (known) {
    // Who they are now: whether they may have it changed is asked at every message.
    await storage.put(`chat-of:${known}`, who);
    return known;
  }
  const { id: session } = await agent.harness.sessions.create();
  await storage.put(`seed-pin:${session}`, who.kb);
  await storage.put(`chat-of:${session}`, who);
  await storage.put(`chat-session:${who.chat}`, session);
  return session;
}

async function markOpen(agent, chat, open) {
  const { storage } = agent.ctx;
  const list = (await storage.get('chats-open')) || [];
  const next = open ? [...new Set([...list, chat])] : list.filter((c) => c !== chat);
  if (next.length !== list.length) {
    await storage.put('chats-open', next);
  }
}

/**
 * ThreadAgent.chat `{ id, chat, by, person, write, text, kb, repo }`: a person's message in
 * conversation `chat` of the knowledge base's sidebar, into its session, after the run it is in;
 * `write`, whether they may have the knowledge base changed. Only a knowledge-base agent talks
 * there. Once per message.
 */
export async function talkInChat(agent, {
  id, chat: chatKey, by, person = null, write = false, text, kb, repo,
}) {
  if (!String(agent.name || '').startsWith('kb:')) {
    return { error: 'only a knowledge-base agent talks on a knowledge base\'s page' };
  }
  if (!isChatId(chatKey) || !KBS.includes(kb)) {
    return { error: 'no such conversation' };
  }
  const problem = modelProblem(agent.env);
  if (problem) {
    return { error: problem };
  }
  await agent.syncTools();
  await agent.syncMcp();
  const session = await chatSession(agent, {
    chat: chatKey, kb, repo, by, person, write: Boolean(write),
  });
  await markOpen(agent, chatKey, true);
  const receipt = await agent.harness.submit(chatNote({
    id, by, text, kb, repo, write: Boolean(write),
  }), { operationId: `chat:${id}`, session, whenBusy: 'followUp' });
  return { ok: true, accepted: receipt.accepted };
}

/**
 * How a command the agent asked for in a conversation (`request.chat`, src/agent/bashrequest.js)
 * ended, `text` as its tool would say it, into that conversation: a line of its person's in it
 * (`chatEventLine`), and the same as a sidebar message of theirs to the session, so the agent's
 * answer is kept as any. `{ result: 'told' }`, or a `skip` when the conversation is gone.
 */
export async function tellChat(agent, request, outcome, text) {
  const { storage } = agent.ctx;
  const session = await storage.get(`chat-session:${request.chat}`);
  const who = session && await storage.get(`chat-of:${session}`);
  if (!who || !who.person) {
    return { result: 'skip', reason: 'no conversation' };
  }
  const id = chatMessageId();
  await addChatMessage(agent.env, {
    id, repo: who.repo, chat: who.chat, person: who.person, text: chatEventLine(request, outcome),
  });
  try {
    await agent.syncTools();
    await agent.syncMcp();
    await markOpen(agent, who.chat, true);
    await agent.harness.submit(chatEventNote({ id, by: who.by, what: text }), {
      operationId: `bash:${request.id}`, session, whenBusy: 'followUp',
    });
  } catch (e) {
    await dropChatMessage(agent.env, id);
    throw e;
  }
  return { result: 'told' };
}

/**
 * The finished answers of conversation `chat` into D1 (keepChatAnswer), each once it changed
 * since it was last kept. `{ written, working }`: `working` while a turn of it still runs or
 * waits.
 */
async function keepChat(agent, chatKey) {
  const { storage } = agent.ctx;
  const session = await storage.get(`chat-session:${chatKey}`);
  if (!session) {
    return { written: 0, working: false };
  }
  const [entries, pending] = await Promise.all([
    agent.harness.messages({ session }),
    agent.harness.pending({ session }),
  ]);
  const turns = sidebarTurns(entries);
  const before = new Map((await storage.get(`chat-kept:${chatKey}`)) || []);
  const kept = new Map();
  let written = 0;
  let working = pending.some((p) => p.status !== 'parked');
  for (const turn of turns) {
    if (turn.state === 'working') {
      working = true;
    } else {
      const sig = `${turn.state}:${turn.endedAt}:${turn.text}`;
      if (before.get(turn.sidebar) !== sig) {
        // eslint-disable-next-line no-await-in-loop
        if (await keepChatAnswer(agent.env, chatKey, turn)) {
          written += 1;
        }
      }
      kept.set(turn.sidebar, sig);
    }
  }
  await storage.put(`chat-kept:${chatKey}`, [...kept]);
  return { written, working };
}

/**
 * The finished answers of every conversation that has one not kept yet (`chats-open`); a
 * conversation leaves the list once nothing of it works. `{ written, working }`. A
 * conversation whose transcript cannot be read stays, for the next call.
 */
export async function keepChats(agent) {
  const open = (await agent.ctx.storage.get('chats-open')) || [];
  let written = 0;
  let working = false;
  for (const chatKey of open) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await keepChat(agent, chatKey);
      written += r.written;
      if (r.working) {
        working = true;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await markOpen(agent, chatKey, false);
      }
    } catch (e) {
      working = true;
      console.log(JSON.stringify({ route: 'agent', keep: 'chat failed', error: e.message }));
    }
  }
  return { written, working };
}

/**
 * ThreadAgent.chatState `{ chat }`: what the agent is doing in conversation `chat`, for the
 * page while it waits for an answer: `{ working: 'Reading …' }`, or `{ working: null }` when
 * nothing runs; the answers it finished are kept first, so the page finds them in D1.
 */
export async function chatState(agent, { chat: chatKey } = {}) {
  const session = isChatId(chatKey) && await agent.ctx.storage.get(`chat-session:${chatKey}`);
  if (!session) {
    return { working: null };
  }
  await keepChats(agent).catch(() => {});
  const [entries, pending] = await Promise.all([
    agent.harness.messages({ session }).catch(() => []),
    agent.harness.pending({ session }).catch(() => []),
  ]);
  const busy = pending.some((p) => p.status !== 'parked');
  const turn = latestTurn(entries, { busy });
  if (turn && turn.state === 'working') {
    return { working: turn.text };
  }
  // Submitted, but not in the transcript yet.
  return { working: busy ? 'Reading your message' : null };
}
