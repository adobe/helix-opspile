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
import { traceSteps } from '../src/agent/trace.js';

const ctx = BACKGROUND_CONTEXT;

/** The transcript of one input against a faux model with `responses`, as the agent keeps it. */
async function transcript(input, responses) {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({
    name: 'x',
    tools: [defineTool({
      name: 'update_draft',
      description: 'update_draft',
      parameters: Type.Object({}, { additionalProperties: true }),
      async execute() {
        return { output: [{ type: 'text', text: 'saved (version 1)' }] };
      },
    })],
  }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'm' } } });
  faux.setResponses(responses);
  await (await root.submit({ type: 'input', content: input }, ctx)).wait(ctx);
  const entries = [...(await root.context(ctx)).entries];
  await harness.close(ctx);
  return entries;
}

describe('agent traces', () => {
  it('shows what the agent was told, thought, said, called and got back', async () => {
    const entries = await transcript('A message posted by Cy', [
      () => fauxAssistantMessage([
        { type: 'thinking', thinking: 'The customer waits.' },
        { type: 'text', text: 'Drafting.' },
        fauxToolCall('update_draft', { text: 'We are on it' }),
      ], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('Updated the draft.'),
    ]);
    const { steps, earlier, usage } = traceSteps(entries);
    assert.equal(earlier, 0);
    assert.deepEqual(steps.map((s) => s.type), ['agent_input', 'agent_system', 'agent_step', 'tool_result', 'agent_step']);
    assert.equal(steps[0].text, 'A message posted by Cy');
    assert.deepEqual(steps[1].tools_added, ['update_draft']);
    const [, , call, result, done] = steps;
    assert.deepEqual([call.thinking, call.text, call.stop], ['The customer waits.', 'Drafting.', 'toolUse']);
    assert.deepEqual(call.calls.map((c) => [c.tool, c.arguments]), [['update_draft', { text: 'We are on it' }]]);
    assert.deepEqual([result.call, result.tool, result.error], [call.calls[0].id, 'update_draft', false]);
    assert.match(result.text, /^saved \(version 1\)/);
    assert.equal(done.text, 'Updated the draft.');
    assert.ok(steps.every((s) => /^\d{4}-\d\d-\d\dT/.test(s.at)));
    assert.ok(usage.tokens > 0);
  });

  it('shows the calls a script made, clips long text, and keeps the latest steps', () => {
    const long = 'x'.repeat(50);
    const entries = [
      { kind: 'pi.user', model: [{ role: 'user', content: long, timestamp: 1 }] },
      {
        kind: 'pi.tool-result',
        model: [{
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'codemode',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 2,
          nestedCalls: {
            complete: false,
            calls: [
              { name: 'mcp__github__get_file', arguments: { path: 'a' }, status: 'ok' },
              {
                name: 'mcp__browser__get_url_markdown', argumentsBytes: 90000, status: 'error', error: 'timeout',
              },
            ],
          },
        }],
      },
      { kind: 'pi.reset' },
    ];
    const { steps } = traceSteps(entries, { chars: 10 });
    assert.equal(steps[0].text, `${'x'.repeat(9)}…`);
    assert.deepEqual(steps[1].nested_calls, [
      // Arguments too long for `chars` come as clipped JSON.
      { tool: 'mcp__github__get_file', status: 'ok', arguments: '{"path":"…' },
      {
        tool: 'mcp__browser__get_url_markdown', status: 'error', arguments_bytes: 90000, error: 'timeout',
      },
    ]);
    assert.equal(steps[1].nested_complete, false);
    // A step without a time takes the one before it.
    assert.deepEqual([steps[2].type, steps[2].at], ['agent_reset', steps[1].at]);
    const latest = traceSteps(entries, { max: 1 });
    assert.deepEqual([latest.steps.map((s) => s.type), latest.earlier], [['agent_reset'], 2]);
  });

  it('lays the MCP calls the scripts made in by time, from the transcript\'s start', () => {
    const iso = (ms) => new Date(ms).toISOString();
    const entries = [
      { kind: 'pi.user', model: [{ role: 'user', content: 'm', timestamp: 1000 }] },
      {
        kind: 'pi.assistant',
        model: [{
          role: 'assistant',
          content: [{
            type: 'toolCall', id: 'c1', name: 'codemode', arguments: {},
          }],
          stopReason: 'toolUse',
          timestamp: 2000,
        }],
      },
      {
        kind: 'pi.tool-result',
        model: [{
          role: 'toolResult', toolCallId: 'c1', toolName: 'codemode', content: [], isError: false, timestamp: 5000,
        }],
      },
    ];
    const calls = [
      { at: iso(500), tool: 'mcp__github__old', status: 'ok' },
      { at: iso(3000), tool: 'mcp__browser__get_url_markdown', status: 'ok' },
      {
        at: iso(4000), tool: 'mcp__github__get_file', status: 'failed', error: 'timeout',
      },
    ];
    const { steps } = traceSteps(entries, { calls });
    assert.deepEqual(steps.map((s) => s.tool || s.type), ['agent_input', 'agent_step', 'mcp__browser__get_url_markdown', 'mcp__github__get_file', 'codemode']);
    assert.deepEqual([steps[3].type, steps[3].error], ['mcp_call', 'timeout']);
  });
});
