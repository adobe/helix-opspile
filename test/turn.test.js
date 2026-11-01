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
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import {
  createRegistry, defineExtension, defineTool, Harness, MemoryStorage,
} from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { latestTurn } from '../src/agent/turn.js';

const ctx = BACKGROUND_CONTEXT;

/** The transcript of one run against a faux model with `responses`, as the agent keeps it. */
async function transcript(inputs, responses) {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const tool = (name) => defineTool({
    name,
    description: name,
    parameters: Type.Object({}, { additionalProperties: true }),
    async execute() {
      return { output: [{ type: 'text', text: 'ok' }] };
    },
  });
  registry.install(defineExtension({ name: 'x', tools: ['update_draft', 'discard_draft', 'codemode', 'kb_write'].map(tool) }));
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

describe('the agent\'s latest turn', () => {
  it('is its closing note, for the last input only', async () => {
    const entries = await transcript(['first', 'second'], [
      () => fauxAssistantMessage('Nothing yet.'),
      () => fauxAssistantMessage([{ type: 'text', text: 'Checking.' }, fauxToolCall('codemode', { code: 'await tools.mcp__browser__get_url_markdown({})' })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage(fauxToolCall('update_draft', { text: 'hi' }), { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('The site answers 503; **updated the draft**.'),
    ]);
    const turn = latestTurn(entries);
    assert.equal(turn.state, 'done');
    assert.equal(turn.text, 'The site answers 503; **updated the draft**.');
    assert.ok(turn.startedAt <= turn.endedAt);
  });

  it('says what it is doing while it works', async () => {
    const entries = await transcript(['new message'], [
      () => fauxAssistantMessage([{ type: 'text', text: 'Checking.' }, fauxToolCall('codemode', { code: 'await tools.mcp__browser__get_url_markdown({})' })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('Done.'),
    ]);
    // Cut after the tool call, as a running turn looks.
    const running = entries.slice(0, entries.findIndex((e) => e.kind === 'pi.tool-result'));
    assert.deepEqual(
      { state: latestTurn(running).state, text: latestTurn(running).text },
      { state: 'working', text: 'Checking a web page' },
    );
    const started = entries.slice(0, entries.findIndex((e) => e.kind === 'pi.user') + 1);
    assert.equal(latestTurn(started).text, 'Reading the new messages');
    assert.equal(latestTurn(entries, { busy: true }).state, 'working', 'a run is pending');
  });

  it('counts a turn that stopped half way as failed, after a while', async () => {
    const entries = await transcript(['new message'], [
      () => fauxAssistantMessage([{ type: 'text', text: 'Checking.' }, fauxToolCall('codemode', { code: 'x' })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('Done.'),
    ]);
    const running = entries.slice(0, entries.findIndex((e) => e.kind === 'pi.tool-result'));
    const later = Date.now() + 16 * 60 * 1000;
    assert.equal(latestTurn(running).state, 'working');
    const turn = latestTurn(running, { now: later });
    assert.equal(turn.state, 'failed');
    assert.match(turn.text, /did not finish/);
    assert.ok(turn.endedAt);
    // A pending run is working, however long it takes.
    assert.equal(latestTurn(running, { busy: true, now: later }).state, 'working');
    // No answer at all, and no run pending.
    const started = entries.slice(0, entries.findIndex((e) => e.kind === 'pi.user') + 1);
    assert.equal(latestTurn(started, { now: later }).state, 'failed');
  });

  it('falls back to what it changed when it said nothing', async () => {
    const entries = await transcript(['m'], [
      () => fauxAssistantMessage(fauxToolCall('update_draft', { text: 'hi' }), { stopReason: 'toolUse' }),
      () => fauxAssistantMessage(''),
    ]);
    assert.equal(latestTurn(entries).text, 'Updated the draft.');
    const discarded = await transcript(['m'], [
      () => fauxAssistantMessage(fauxToolCall('discard_draft', { base: 'v' }), { stopReason: 'toolUse' }),
      () => fauxAssistantMessage(''),
    ]);
    assert.equal(latestTurn(discarded).text, 'Discarded the draft.');
    assert.equal(latestTurn([]), null);
    const failed = latestTurn([
      { kind: 'pi.user', model: [{ role: 'user', content: 'x', timestamp: 1 }] },
      {
        kind: 'pi.assistant',
        model: [{
          role: 'assistant', content: [], stopReason: 'error', errorMessage: 'overloaded', timestamp: 2,
        }],
      },
    ]);
    assert.deepEqual([failed.state, failed.text], ['failed', 'The turn did not finish: overloaded']);
  });
});
