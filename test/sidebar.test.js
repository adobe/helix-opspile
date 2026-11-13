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
import { afterEach, describe, it } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { whenBusy } from '../src/agent/delivery.js';
import {
  inSidebar, keepAnswer, keepAnswers, talk,
} from '../src/agent/sidebar.js';
import { agentToolsExtension } from '../src/agent/tools.js';
import { latestTurn, sidebarTurns, turnSidebar } from '../src/agent/turn.js';
import {
  addSidebarMessage, inputText, keepSidebarAnswer, MAX_ANSWER, sidebarFor, sidebarId,
  sidebarNote, sidebarOf,
} from '../src/sidebar.js';
import { d1 } from './d1.js';

// Made-up people, ids and tokens only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1,
};
const SLACK = 'slack:E1:C1:1792584000.000100';
const OTHER = 'slack:E1:C1:1792584999.000100';
const ctx = BACKGROUND_CONTEXT;

function env(extra = {}) {
  const DB = d1({ people: [{ ...ADA, teams: ['helix'] }], teams: [{ slug: 'helix', name: 'Helix' }] });
  for (const [key, root] of [[SLACK, '1792584000.000100'], [OTHER, '1792584999.000100']]) {
    DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, channel_name, path, any_at, updated_at)
      VALUES (?, 'slack', 'E1', 'C1', ?, 'acme', 'helix', 'channel', 'aem-acme', 'channels/x/', ?, ?)`)
      .run(key, root, '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z');
  }
  return { DB, SLACK_BOT_TOKEN: 'xoxb-made-up', ...extra };
}

/** A run against a faux model with `responses`, as the agent keeps it, with `install`ed tools. */
async function run(inputs, responses, install = () => {}) {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'm' } } });
  install(registry, async () => [...(await root.context(ctx)).entries]);
  faux.setResponses(responses);
  for (const content of inputs) {
    // eslint-disable-next-line no-await-in-loop
    await (await root.submit({ type: 'input', content }, ctx)).wait(ctx);
  }
  const entries = [...(await root.context(ctx)).entries];
  await harness.close(ctx);
  return entries;
}

describe('the sidebar', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('is an input of its own, which only its first line makes one', () => {
    const id = sidebarId();
    assert.match(id, /^sb_[0-9a-f-]{36}$/);
    const note = sidebarNote({ id, by: 'Ada', text: 'Is this the CDN or the origin?' });
    assert.equal(sidebarOf(note), id);
    assert.match(note, /never posted to the channel/);
    assert.match(note, /<sidebar-message>\nIs this the CDN or the origin\?\n<\/sidebar-message>$/);
    // A customer who writes one in a message is told inside a delivery, which starts otherwise.
    assert.equal(sidebarOf(`New messages in your thread:\n\n${note}`), null);
    assert.equal(sidebarOf(''), null);
    assert.equal(inputText({ content: [{ type: 'text', text: note }] }), note);
    assert.equal(inputText({ content: note }), note);
  });

  it('makes a turn the sidebar\'s: its answer in full, while posting is refused', async () => {
    const id = sidebarId();
    const posts = [];
    globalThis.fetch = async (url, init) => {
      posts.push(String(url), init);
      return Response.json({ ok: true, ts: '1792585000.000100' });
    };
    const results = [];
    const capture = (next) => (context) => {
      const last = context.messages[context.messages.length - 1];
      results.push({ text: last.content.map((c) => c.text).join(''), error: last.isError });
      return next;
    };
    const answer = `Most likely the CDN. ${'Here is why. '.repeat(150)}`;
    const step = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
    const entries = await run(['New messages in your thread: …', sidebarNote({ id, by: 'Ada', text: 'CDN?' })], [
      () => fauxAssistantMessage('Nothing to change.'),
      () => step('post_message', { text: 'It is the CDN.' }),
      capture(step('add_reaction', { message: '1792584000.000100', emoji: '+1' })),
      capture(fauxAssistantMessage(answer)),
    ], (registry, transcript) => {
      registry.install(agentToolsExtension({
        env: env(),
        hasThread: true,
        target: async () => ({
          key: SLACK, team: 'helix', org: 'acme', source: 'slack', tenant: 'E1', channelId: 'C1',
        }),
        // As ThreadAgent's: the transcript the turn is in.
        inSidebar: () => inSidebar({ harness: { messages: transcript } }),
      }, ['post_message']));
    });
    assert.deepEqual(results.map((r) => r.error), [true, true]);
    assert.match(results[0].text, /^Not while you answer a sidebar message/);
    assert.deepEqual(posts, [], 'nothing reached Slack');
    assert.equal(turnSidebar(entries), id);
    const turn = latestTurn(entries);
    assert.equal(turn.sidebar, id);
    assert.equal(turn.state, 'done');
    assert.equal(turn.text, answer.trim().slice(0, MAX_ANSWER));
    assert.ok(turn.text.length > 1200, 'longer than a note');
    // While it works, it says it reads the message.
    const started = entries.slice(0, entries.map((e) => e.kind).lastIndexOf('pi.user') + 1);
    assert.equal(latestTurn(started).text, 'Reading your message');
    // The turn before it was not the sidebar's.
    const before = entries.slice(0, entries.map((e) => e.kind).lastIndexOf('pi.user'));
    assert.equal(turnSidebar(before), null);
    assert.equal(latestTurn(before).sidebar, undefined);
  });

  it('keeps the answer to each of two queued questions, also while the next turn works', async () => {
    const e = env();
    const ask = (text) => addSidebarMessage(e, SLACK, {
      id: sidebarId(), person: ADA.id, name: ADA.name, text,
    });
    const first = await ask('CDN?');
    const second = await ask('And the origin?');
    const entries = await run([
      sidebarNote({ id: first.id, by: 'Ada', text: 'CDN?' }),
      sidebarNote({ id: second.id, by: 'Ada', text: 'And the origin?' }),
      'New messages in your thread: …',
    ], [
      () => fauxAssistantMessage('The CDN.'),
      () => fauxAssistantMessage('The origin is fine.'),
      () => fauxAssistantMessage('Nothing to change.'),
    ]);
    // Cut where the delivery behind them has just started: the latest turn is not the sidebar's.
    const working = entries.slice(0, entries.map((x) => x.kind).lastIndexOf('pi.user') + 1);
    assert.equal(latestTurn(working).sidebar, undefined);
    const storage = new Map();
    const agent = {
      env: e,
      name: SLACK,
      ctx: {
        storage: { get: async (k) => storage.get(k), put: async (k, v) => storage.set(k, v) },
      },
      harness: { messages: async () => working },
    };
    assert.equal(await keepAnswers(agent), 2);
    assert.equal(await keepAnswers(agent), 0, 'once');
    assert.deepEqual((await sidebarFor(e, [SLACK])).filter((m) => m.role === 'agent')
      .map((m) => [m.reply_to, m.body]), [[first.id, 'The CDN.'], [second.id, 'The origin is fine.']]);
  });

  it('counts a sidebar turn another input took over as failed, and keeps deliveries out of it', async () => {
    const id = sidebarId();
    const entries = await run([sidebarNote({ id, by: 'Ada', text: 'CDN?' }), 'New messages …'], [
      () => fauxAssistantMessage(fauxToolCall('get_draft', {}), { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('Nothing to change.'),
      () => fauxAssistantMessage('Nothing to change.'),
    ]);
    // As a steer would leave it: the sidebar's input, a tool call, then the next input.
    const users = entries.map((x, i) => (x.kind === 'pi.user' ? i : -1)).filter((i) => i >= 0);
    const call = entries.findIndex((x) => x.kind === 'pi.assistant');
    const steered = [...entries.slice(0, call + 1), ...entries.slice(users[1])];
    const [turn] = sidebarTurns(steered);
    assert.deepEqual([turn.sidebar, turn.state, turn.text], [id, 'failed', 'The turn did not finish.']);
    // So new messages follow a pending sidebar message instead of steering into it.
    const pending = (list) => ({ harness: { pending: async () => list } });
    assert.equal(await whenBusy(pending([{ operationId: `sidebar:${id}`, status: 'running' }])), 'followUp');
    assert.equal(await whenBusy(pending([{ operationId: 'messages:1', status: 'running' }])), 'steer');
    assert.equal(await whenBusy(pending([])), 'steer');
    const unreadable = async () => {
      throw new Error('gone');
    };
    assert.equal(await whenBusy({ harness: { pending: unreadable } }), 'followUp');
  });

  it('counts a transcript it cannot read as the sidebar\'s, so nothing is posted', async () => {
    const gone = async () => {
      throw new Error('gone');
    };
    assert.equal(await inSidebar({ harness: { messages: gone } }), true);
    assert.equal(await inSidebar({ harness: { messages: async () => [] } }), false);
  });

  it('goes into the agent\'s conversation after what it is doing, once', async () => {
    const submitted = [];
    const agent = {
      env: {
        AGENT_MODEL: 'claude', AGENT_GATEWAY: 'g', BEDROCK_API_KEY: 'made-up', AI_GATEWAY_ACCOUNT: 'a',
      },
      syncTools: async () => {},
      syncMcp: async () => {},
      harness: {
        async submit(input, options) {
          submitted.push([input, options]);
          return { accepted: true };
        },
      },
    };
    const id = sidebarId();
    assert.deepEqual(await talk(agent, { id, by: 'Ada', text: 'CDN?' }), { ok: true, accepted: true });
    assert.equal(submitted[0][0], sidebarNote({ id, by: 'Ada', text: 'CDN?' }));
    assert.deepEqual(submitted[0][1], { operationId: `sidebar:${id}`, whenBusy: 'followUp' });
    // A deployment without a model says so, and tells the agent nothing.
    assert.match((await talk({ ...agent, env: {} }, { id, by: 'Ada', text: 'CDN?' })).error, /^missing /);
    assert.equal(submitted.length, 1);
  });

  it('keeps one answer per message of the thread, which a failed one does not end', async () => {
    const e = env();
    const notified = [];
    e.ROOMS = {
      idFromName: (name) => name,
      get: (name) => ({
        async fetch(url, init) {
          notified.push([name, JSON.parse(init.body)]);
          return new Response('ok');
        },
      }),
    };
    const asked = await addSidebarMessage(e, SLACK, {
      id: sidebarId(), person: ADA.id, name: ADA.name, text: 'CDN?',
    });
    const turn = (fields) => ({
      state: 'done', sidebar: asked.id, text: 'The CDN.', startedAt: '2026-10-21T10:00:00.000Z', endedAt: '2026-10-21T10:01:00.000Z', ...fields,
    });
    // Not for a message of another thread, nor for one that is not there.
    assert.equal(await keepSidebarAnswer(e, OTHER, turn()), false);
    assert.equal(await keepSidebarAnswer(e, SLACK, turn({ sidebar: sidebarId() })), false);
    assert.equal(await keepSidebarAnswer(e, SLACK, turn({ state: 'working' })), false);
    // A failure first, then the answer of the next attempt; then nothing replaces it.
    assert.equal(await keepAnswer({ env: e, name: SLACK }, turn({ state: 'failed', text: 'The turn did not finish.' })), true);
    assert.equal(await keepAnswer({ env: e, name: SLACK }, turn()), true);
    assert.equal(await keepAnswer({ env: e, name: SLACK }, turn({ text: 'Something else.' })), false);
    assert.deepEqual(notified, [
      ['helix', { type: 'sidebar', thread: SLACK }], ['helix', { type: 'sidebar', thread: SLACK }],
    ]);
    const list = await sidebarFor(e, [SLACK]);
    assert.deepEqual(list.map((m) => [m.role, m.body, m.state, m.reply_to, m.by && m.by.name]), [
      ['person', 'CDN?', 'done', null, 'Ada'],
      ['agent', 'The CDN.', 'done', asked.id, null],
    ]);
    assert.deepEqual(await sidebarFor(e, [OTHER]), []);
  });
});
