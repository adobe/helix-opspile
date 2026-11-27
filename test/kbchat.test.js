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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import {
  chatOf, chatState, keepChats, talkInChat, tellChat,
} from '../src/agent/kbchat.js';
import { insertRequest } from '../src/bashrequests.js';
import { accessibleRepos } from '../src/agent/repos.js';
import { customerTeams } from '../src/shares.js';
import { seedPin } from '../src/agent/seed.js';
import { sidebarOf } from '../src/sidebar.js';
import {
  addChatMessage, chatAgentName, chatId, chatMessageId, chatMessages, chatNote, chatsOf, isChatId,
  isChatOf, keepChatAnswer, latestChat, waiting,
} from '../src/kbchat.js';
import { api } from '../src/api.js';
import { d1 } from './d1.js';

// Made-up people and slugs only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'admin' }, { slug: 'helix' }],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', teams: [{ slug: 'helix' }],
};
const CY = {
  id: 3, email: 'cy@staff.example', name: 'Cy', teams: [{ slug: 'edge' }],
};
const REPO = 'kb-team-helix';
const MODEL = {
  AGENT_MODEL: 'claude', AGENT_GATEWAY: 'g', BEDROCK_API_KEY: 'made-up', AI_GATEWAY_ACCOUNT: 'a',
};
const ctx = BACKGROUND_CONTEXT;

function env(extra = {}) {
  const DB = d1({
    people: [{ ...ADA, teams: ['admin', 'helix'] }, { ...BO, teams: ['helix'] }, { ...CY, teams: ['edge'] }],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix' }, { slug: 'edge', name: 'Edge' }],
  });
  DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at) VALUES
    ('kb-team-helix', 'team', 'helix', 'r', '2026-10-22T00:00:00Z'),
    ('kb-org-acme', 'org', 'acme', 'r', '2026-10-22T00:00:00Z')`);
  return { DB, ...extra };
}

/** A storage as a Durable Object's, in memory. */
function memory() {
  const map = new Map();
  return {
    map,
    get: async (k) => map.get(k),
    put: async (k, v) => {
      map.set(k, v);
    },
  };
}

/** The transcript of a faux run of `inputs` answered with `responses`, as a session keeps it. */
async function transcript(inputs, responses) {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'm' } } });
  faux.setResponses(responses);
  for (const content of inputs) {
    // eslint-disable-next-line no-await-in-loop
    await (await root.submit({ type: 'input', content }, ctx)).wait(ctx);
  }
  const entries = [...(await root.context(ctx)).entries];
  await harness.close(ctx);
  return entries;
}

function call(e, me, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  return api(request, e, url, { viewer: me });
}

describe('the knowledge base\'s sidebar', () => {
  it('talks to the team\'s or the customer\'s knowledge-base agent, as a sidebar message', () => {
    assert.equal(chatAgentName({ kind: 'team', slug: 'helix' }), 'kb:helix:');
    assert.equal(chatAgentName({ kind: 'org', slug: 'acme' }), 'kb::acme');
    assert.equal(chatAgentName(null), null);
    const chat = chatId();
    assert.ok(isChatId(chat));
    assert.equal(isChatId('sb_x'), false);
    const id = chatMessageId();
    const note = chatNote({
      id, by: 'Ada', text: 'Merge the CDN playbooks.', kb: 'team', repo: REPO,
    });
    // Its turns are read as a thread's sidebar's (src/agent/turn.js).
    assert.equal(sidebarOf(note), id);
    assert.match(note, /the ops team's knowledge base, kb-team/);
    assert.match(note, /<sidebar-message>\nMerge the CDN playbooks\.\n<\/sidebar-message>$/);
  });

  it('keeps each person\'s conversations their own, and one answer per message', async () => {
    const e = env();
    const chat = chatId();
    assert.equal(await latestChat(e, REPO, ADA.id), null);
    const asked = await addChatMessage(e, {
      id: chatMessageId(), repo: REPO, chat, person: ADA.id, text: 'What do we know about CDNs?',
    });
    assert.equal(await latestChat(e, REPO, ADA.id), chat);
    assert.equal(await isChatOf(e, REPO, ADA.id, chat), true);
    assert.equal(await isChatOf(e, REPO, BO.id, chat), false, 'not Bo\'s');
    assert.equal(await isChatOf(e, 'kb-org-acme', ADA.id, chat), false, 'not another knowledge base\'s');
    assert.deepEqual(await chatMessages(e, REPO, BO.id, chat), []);
    assert.equal(waiting(await chatMessages(e, REPO, ADA.id, chat)), true);
    const turn = (fields) => ({
      state: 'done', sidebar: asked.id, text: 'Two playbooks.', endedAt: '2026-10-21T10:01:00.000Z', ...fields,
    });
    // Not for a message of another conversation, nor while it works.
    assert.equal(await keepChatAnswer(e, chatId(), turn()), false);
    assert.equal(await keepChatAnswer(e, chat, turn({ state: 'working' })), false);
    // A failure, replaced by the next attempt's answer, which nothing replaces.
    assert.equal(await keepChatAnswer(e, chat, turn({ state: 'failed', text: 'The turn did not finish.' })), true);
    assert.equal(await keepChatAnswer(e, chat, turn()), true);
    assert.equal(await keepChatAnswer(e, chat, turn({ text: 'Something else.' })), false);
    const list = await chatMessages(e, REPO, ADA.id, chat);
    assert.deepEqual(list.map((m) => [m.role, m.body, m.state, m.reply_to]), [
      ['person', 'What do we know about CDNs?', 'done', null],
      ['agent', 'Two playbooks.', 'done', asked.id],
    ]);
    // Never before the message, whatever the clocks say.
    assert.ok(list[1].at >= list[0].at);
    assert.equal(waiting(list), false);
    const later = chatId();
    await addChatMessage(e, {
      id: chatMessageId(), repo: REPO, chat: later, person: ADA.id, text: 'Another question',
    });
    assert.equal(await latestChat(e, REPO, ADA.id), later);
    assert.deepEqual((await chatsOf(e, REPO, ADA.id)).map((c) => [c.chat, c.first, c.messages]), [
      [later, 'Another question', 1], [chat, 'What do we know about CDNs?', 2],
    ]);
  });

  it('is a session of the agent pinned to the knowledge base, whose answers go to D1', async () => {
    const e = { ...env(), ...MODEL };
    const storage = memory();
    const submitted = [];
    let sessions = 0;
    const agent = {
      env: e,
      name: 'kb:helix:',
      ctx: { storage },
      syncTools: async () => {},
      syncMcp: async () => {},
      harness: {
        sessions: {
          create: async () => {
            sessions += 1;
            return { id: `s${sessions}` };
          },
        },
        async submit(input, options) {
          submitted.push([input, options]);
          return { accepted: true };
        },
        messages: async () => [],
        pending: async () => [],
      },
    };
    const chat = chatId();
    const asked = await addChatMessage(e, {
      id: chatMessageId(), repo: REPO, chat, person: ADA.id, text: 'CDN?',
    });
    const note = {
      id: asked.id, chat, by: 'Ada', person: ADA.id, write: true, text: 'CDN?', kb: 'team', repo: REPO,
    };
    assert.deepEqual(await talkInChat(agent, note), { ok: true, accepted: true });
    assert.deepEqual(submitted[0][1], { operationId: `chat:${asked.id}`, session: 's1', whenBusy: 'followUp' });
    assert.equal(submitted[0][0], chatNote(note));
    assert.match(submitted[0][0], /Ada is on its team: they may change/);
    assert.match(chatNote({ ...note, write: false }), /Ada is not on its team: they may read .* kb_write, draw_stack, bash, request_bash/);
    // Pinned, so kb_write and draw_stack write kb-team only, and known as the conversation.
    assert.equal(await seedPin(agent, 's1'), 'team');
    assert.deepEqual(await chatOf(agent, 's1'), {
      chat, kb: 'team', repo: REPO, by: 'Ada', person: ADA.id, write: true,
    });
    assert.equal(await chatOf(agent, 'other'), null);
    // The same conversation goes on in the same session, as who they are now.
    await talkInChat(agent, { ...note, id: chatMessageId(), write: false });
    assert.equal(submitted[1][1].session, 's1');
    assert.equal(sessions, 1);
    assert.equal((await chatOf(agent, 's1')).write, false);
    await talkInChat(agent, { ...note, id: chatMessageId() });
    submitted.length = 1;
    // Only a knowledge-base agent, and only a conversation's id.
    assert.match((await talkInChat({ ...agent, name: 'slack:E1:C1:1.000100' }, note)).error, /knowledge-base agent/);
    assert.match((await talkInChat(agent, { ...note, chat: 'nope' })).error, /no such conversation/);
    assert.match((await talkInChat({ ...agent, env: env() }, note)).error, /^missing /);

    // Its answer, once the turn is done; nothing while it works.
    const entries = await transcript([chatNote(note)], [() => fauxAssistantMessage('Two CDN playbooks, merged.')]);
    agent.harness.messages = async ({ session }) => (session === 's1' ? entries.slice(0, 1) : []);
    agent.harness.pending = async () => [{ operationId: `chat:${asked.id}`, session: 's1', status: 'running' }];
    assert.deepEqual(await keepChats(agent), { written: 0, working: true });
    assert.deepEqual(await chatState(agent, { chat }), { working: 'Reading your message' });
    agent.harness.messages = async ({ session }) => (session === 's1' ? entries : []);
    agent.harness.pending = async () => [];
    assert.deepEqual(await keepChats(agent), { written: 1, working: false });
    assert.deepEqual(storage.map.get('chats-open'), [], 'done with it');
    assert.deepEqual(await keepChats(agent), { written: 0, working: false });
    assert.deepEqual((await chatMessages(e, REPO, ADA.id, chat)).map((m) => [m.role, m.body]), [
      ['person', 'CDN?'], ['agent', 'Two CDN playbooks, merged.'],
    ]);
    assert.deepEqual(await chatState(agent, { chat }), { working: null });
    assert.deepEqual(await chatState(agent, { chat: chatId() }), { working: null });
  });

  it('reads the knowledge bases of the teams a customer works with first, on its page', async () => {
    const e = env();
    e.DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at) VALUES
        ('kb-team-edge', 'team', 'edge', 'r', '2026-10-22T00:00:00Z');
      INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind, path,
          any_at, updated_at) VALUES
        ('slack:E1:C1:1', 'slack', 'E1', 'C1', '1', 'acme', 'edge', 'channel', 'p', 'x', 'x'),
        ('slack:E1:C2:1', 'slack', 'E1', 'C2', '1', 'acme', 'admin', 'ignore', 'p', 'x', 'x');
      INSERT INTO channel_teams (source, channel_id, team, added_at) VALUES ('slack', 'C1', 'helix', 'x')`);
    const owners = await customerTeams(e, 'acme');
    assert.deepEqual(owners, ['edge', 'helix']);
    const repos = await accessibleRepos(e, {
      key: null, team: null, org: 'acme', owners,
    });
    assert.deepEqual(repos.filter((r) => r.kind === 'kb').map((r) => [r.id, r.writable, r.via]), [
      ['kb-org', true, undefined], ['kb-team-edge', false, 'owner'], ['kb-team-helix', false, 'owner'],
    ]);
    assert.match(repos[1].what, /works with this customer/);
  });

  it('tells the conversation how a command the agent asked for there ended', async () => {
    const e = { ...env(), ...MODEL };
    const storage = memory();
    const submitted = [];
    const agent = {
      env: e,
      name: 'kb:helix:',
      ctx: { storage },
      syncTools: async () => {},
      syncMcp: async () => {},
      harness: {
        sessions: { create: async () => ({ id: 's1' }) },
        async submit(input, options) {
          submitted.push([input, options]);
          return { accepted: true };
        },
      },
    };
    const chat = chatId();
    const asked = await addChatMessage(e, {
      id: chatMessageId(), repo: REPO, chat, person: ADA.id, text: 'Check the CDN',
    });
    await talkInChat(agent, {
      id: asked.id, chat, by: 'Ada', person: ADA.id, write: true, text: 'Check the CDN', kb: 'team', repo: REPO,
    });
    const request = { id: 'r1', chat };
    assert.deepEqual(await tellChat(agent, request, { status: 'done', exitCode: 0 }, 'Ada ran it: ok'), { result: 'told' });
    const [line] = (await chatMessages(e, REPO, ADA.id, chat)).slice(-1);
    assert.deepEqual([line.role, line.body], ['person', 'Ran the command (request r1); it exited with code 0.']);
    const [input, options] = submitted.at(-1);
    // A sidebar message of theirs, so the agent's answer is kept as any.
    assert.equal(sidebarOf(input), line.id);
    assert.match(input, /<sidebar-message>\nAda ran it: ok\n<\/sidebar-message>$/);
    assert.deepEqual(options, { operationId: 'bash:r1', session: 's1', whenBusy: 'followUp' });
    assert.deepEqual(await tellChat(agent, { id: 'r2', chat: chatId() }, { status: 'denied' }, 'x'), { result: 'skip', reason: 'no conversation' });
  });

  it('is for who sees the knowledge base; its team has it changed, each in their own conversations', async () => {
    const calls = [];
    const agentStub = {
      __unsafe_ensureInitialized: async () => {},
      async chat(note) {
        calls.push(['chat', note]);
        return { ok: true, accepted: true };
      },
      async chatState(q) {
        calls.push(['state', q]);
        return { working: 'Looking things up in the knowledge bases and repositories' };
      },
    };
    const names = [];
    const e = {
      ...env(),
      AGENTS: {
        idFromName: (name) => {
          names.push(name);
          return name;
        },
        get: () => agentStub,
      },
    };
    // Bo is on the team, not its manager: he talks to it, and has it changed. Cy, of another
    // team, reads it and talks to it; it changes nothing for him.
    const bo = await (await call(e, BO, 'GET', `/api/kb/chat?repo=${REPO}`)).json();
    assert.deepEqual([bo.may, bo.write], [true, true]);
    const cy = await (await call(e, CY, 'GET', `/api/kb/chat?repo=${REPO}`)).json();
    assert.deepEqual([cy.may, cy.write], [true, false]);
    assert.equal((await call(e, CY, 'POST', '/api/kb/chat', { repo: REPO, text: 'Hi' })).status, 202);
    assert.deepEqual([calls[0][1].by, calls[0][1].write, calls[0][1].person], ['Cy', false, CY.id]);
    assert.equal((await call(e, BO, 'POST', '/api/kb/chat', { repo: REPO, text: 'Hi' })).status, 202);
    assert.equal(calls[1][1].write, true);
    // A customer's knowledge base their teams do not own the same way: they see its page, so
    // they talk to its agent, which changes nothing for them.
    const theirs = await (await call(e, CY, 'GET', '/api/kb/chat?repo=kb-org-acme')).json();
    assert.deepEqual([theirs.may, theirs.write], [true, false]);
    assert.equal((await call(e, CY, 'POST', '/api/kb/chat', { repo: 'kb-org-acme', text: 'Who is who?' })).status, 202);
    assert.deepEqual([names.at(-1), calls[2][1].kb, calls[2][1].write], ['kb::acme', 'org', false]);
    // Nor do they run the commands its agent asks for.
    assert.equal((await call(e, CY, 'POST', '/api/kb/chat/bash', {
      repo: 'kb-org-acme', chat: theirs.chat || chatId(), id: 'r1', run: true,
    })).status, 403);
    // Adobe's people on no team the same, a customer's and a team's: they see their pages.
    const DEE = {
      id: 4, email: 'dee@staff.example', name: 'Dee', staff: true, teams: [],
    };
    for (const repo of ['kb-org-acme', REPO]) {
      // eslint-disable-next-line no-await-in-loop
      const view = await (await call(e, DEE, 'GET', `/api/kb/chat?repo=${repo}`)).json();
      assert.deepEqual([view.may, view.write], [true, false], repo);
    }
    e.DB.sqlite.exec("INSERT OR IGNORE INTO people (id, email, name, staff) VALUES (4, 'dee@staff.example', 'Dee', 1)");
    assert.equal((await call(e, DEE, 'POST', '/api/kb/chat', { repo: 'kb-org-acme', text: 'Who is who?' })).status, 202);
    assert.deepEqual([calls.at(-1)[1].by, calls.at(-1)[1].write], ['Dee', false]);
    assert.equal((await call(e, DEE, 'POST', '/api/kb/chat/bash', {
      repo: 'kb-org-acme', chat: chatId(), id: 'r1', run: true,
    })).status, 403);
    // Someone signed in from SIGNIN_DOMAINS who is not Adobe's sees neither.
    assert.equal((await call(e, { ...CY, teams: [] }, 'GET', '/api/kb/chat?repo=kb-org-acme')).status, 404);
    assert.equal((await call(e, { ...CY, teams: [] }, 'POST', '/api/kb/chat', { repo: REPO, text: 'x' })).status, 404);
    calls.length = 0;
    names.length = 0;
    assert.equal((await call(e, ADA, 'GET', '/api/kb/chat?repo=kb-team-nope')).status, 404);
    const empty = await (await call(e, ADA, 'GET', `/api/kb/chat?repo=${REPO}`)).json();
    assert.deepEqual(
      [empty.may, empty.chat, empty.messages, empty.working],
      [true, null, [], null],
    );
    assert.equal((await call(e, ADA, 'POST', '/api/kb/chat', { repo: REPO, text: '' })).status, 400);
    const sent = await call(e, ADA, 'POST', '/api/kb/chat', { repo: REPO, text: 'What is missing?' });
    assert.equal(sent.status, 202);
    const { chat, message } = await sent.json();
    assert.ok(isChatId(chat));
    assert.deepEqual(names, ['kb:helix:']);
    assert.deepEqual(calls[0], ['chat', {
      id: message.id, chat, by: 'Ada', person: ADA.id, write: true, text: 'What is missing?', kb: 'team', repo: REPO,
    }]);
    // While it answers, what it is doing.
    const now = await (await call(e, ADA, 'GET', `/api/kb/chat?repo=${REPO}`)).json();
    assert.equal(now.chat, chat);
    assert.deepEqual(now.messages.map((m) => m.body), ['What is missing?']);
    assert.equal(now.working, 'Looking things up in the knowledge bases and repositories');
    assert.deepEqual(calls[1], ['state', { chat }]);
    // The same conversation by default; a new one when asked; never someone else's.
    await call(e, ADA, 'POST', '/api/kb/chat', { repo: REPO, text: 'And?' });
    assert.equal(calls[2][1].chat, chat);
    const fresh = await (await call(e, ADA, 'POST', '/api/kb/chat', { repo: REPO, text: 'New topic', fresh: true })).json();
    assert.notEqual(fresh.chat, chat);
    const back = await (await call(e, ADA, 'GET', `/api/kb/chat?repo=${REPO}&chat=${chat}`)).json();
    assert.deepEqual(back.messages.map((m) => m.body), ['What is missing?', 'And?']);
    assert.deepEqual(back.chats.map((c) => c.chat).sort(), [chat, fresh.chat].sort());
    assert.equal((await call(e, ADA, 'POST', '/api/kb/chat', { repo: REPO, text: 'x', chat: chatId() })).status, 404);
    // A customer's goes to the customer's agent, which no team has.
    await call(e, ADA, 'POST', '/api/kb/chat', { repo: 'kb-org-acme', text: 'Who is who?' });
    assert.equal(names.at(-1), 'kb::acme');
    assert.equal(calls.at(-1)[1].kb, 'org');
    // An agent that does not take it: the message goes again.
    agentStub.chat = async () => ({ error: 'missing AGENT_MODEL' });
    assert.equal((await call(e, ADA, 'POST', '/api/kb/chat', { repo: REPO, text: 'Lost', chat })).status, 503);
    assert.deepEqual((await chatMessages(e, REPO, ADA.id, chat)).map((m) => m.body), ['What is missing?', 'And?']);
    // Viewing as someone else talks to nobody.
    assert.equal((await call(e, { ...ADA, readonly: true }, 'POST', '/api/kb/chat', { repo: REPO, text: 'x' })).status, 403);
  });

  it('lets the person of a conversation run or deny a command its agent asked for there', async () => {
    const calls = [];
    const stub = {
      __unsafe_ensureInitialized: async () => {},
      async runBash(q) {
        calls.push(['run', q]);
        return { ok: true };
      },
      async denyBash(q) {
        calls.push(['deny', q]);
        return { ok: true };
      },
    };
    const e = { ...env(), AGENTS: { idFromName: (n) => n, get: () => stub } };
    const chat = chatId();
    await addChatMessage(e, {
      id: chatMessageId(), repo: REPO, chat, person: BO.id, text: 'Check the CDN',
    });
    await insertRequest(e, 'r1', 'kb:helix:', {
      command: 'curl -s https://example.com', reason: 'To check', env: [{ name: 'T' }], timeout: 30, deadline: new Date(Date.now() + 3600000).toISOString(),
    }, new Date(), chat);
    const view = await (await call(e, BO, 'GET', `/api/kb/chat?repo=${REPO}&chat=${chat}`)).json();
    assert.deepEqual(view.bash.map((r) => [r.id, r.status, r.chat]), [['r1', 'pending', chat]]);
    const decide = (me, body) => call(e, me, 'POST', '/api/kb/chat/bash', {
      repo: REPO, chat, id: 'r1', ...body,
    });
    assert.equal((await decide(BO, { run: true, env: { T: 'secret' } })).status, 202);
    assert.deepEqual(calls[0], ['run', { id: 'r1', values: { T: 'secret' }, by: { id: BO.id, name: 'Bo' } }]);
    assert.equal((await decide(BO, { run: false })).status, 200);
    assert.equal(calls[1][0], 'deny');
    // Only theirs, only of their conversation, and only who is on the team.
    assert.equal((await decide(ADA, { run: true })).status, 404);
    assert.equal((await call(e, BO, 'POST', '/api/kb/chat/bash', {
      repo: REPO, chat: chatId(), id: 'r1', run: true,
    })).status, 404);
    assert.equal((await decide(CY, { run: true })).status, 403);
    assert.equal(calls.length, 2);
  });
});
