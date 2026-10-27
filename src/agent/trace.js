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

/**
 * An agent's trace, for the admin team (the MCP tool `get_thread_trace`): the steps of its
 * active transcript (pi's entries since its newest reset), each as a small JSON object with its
 * time, so they can be laid out next to the thread's messages. What it was told, what it
 * thought and said, every tool call with its arguments, every result, and the calls a tool made
 * in turn (a code mode script's MCP calls). Long text is clipped; nothing is left out.
 */

export const MAX_STEPS = 400;
export const MAX_STEP_TEXT = 4000;

const clip = (s, n) => {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};
const at = (m) => (m && m.timestamp ? new Date(m.timestamp).toISOString() : null);
const textOf = (content) => (typeof content === 'string' ? content
  : (Array.isArray(content) ? content : []).map((c) => {
    if (c.type === 'text') {
      return c.text;
    }
    return c.type === 'image' ? '[image]' : '';
  }).filter(Boolean).join('\n\n'));
/** Arguments as JSON, clipped as a whole when they are long. */
const argsOf = (args, n) => {
  const s = JSON.stringify(args ?? {});
  return s.length > n ? clip(s, n) : args ?? {};
};
const usageOf = (u) => u && ({
  tokens: u.totalTokens || 0,
  cost: (u.cost && u.cost.total) || 0,
});

/** One transcript entry as trace steps (an entry has one model message, or none). */
function stepsOf(entry, n) {
  const m = (entry.model || [])[0];
  switch (entry.kind) {
    case 'pi.user':
      return [{ type: 'agent_input', at: at(m), text: clip(textOf(m && m.content), n) }];
    case 'pi.assistant': {
      if (!m) {
        return [];
      }
      const content = Array.isArray(m.content) ? m.content : [];
      const step = {
        type: 'agent_step',
        at: at(m),
        model: m.model || null,
        stop: m.stopReason || null,
      };
      const thinking = content.filter((c) => c.type === 'thinking' && c.thinking)
        .map((c) => c.thinking).join('\n\n');
      const said = textOf(content.filter((c) => c.type === 'text'));
      if (thinking) {
        step.thinking = clip(thinking, n);
      }
      if (said) {
        step.text = clip(said, n);
      }
      const calls = content.filter((c) => c.type === 'toolCall');
      if (calls.length) {
        step.calls = calls.map((c) => ({
          id: c.id, tool: c.name, arguments: argsOf(c.arguments, n),
        }));
      }
      if (m.errorMessage) {
        step.error = clip(m.errorMessage, 500);
      }
      if (m.durationMs != null) {
        step.duration_ms = m.durationMs;
      }
      if (m.usage) {
        step.usage = usageOf(m.usage);
      }
      return [step];
    }
    case 'pi.tool-result': {
      if (!m) {
        return [];
      }
      const step = {
        type: 'tool_result',
        at: at(m),
        call: m.toolCallId,
        tool: m.toolName,
        error: Boolean(m.isError),
        text: clip(textOf(m.content), n),
      };
      if (m.durationMs != null) {
        step.duration_ms = m.durationMs;
      }
      const nested = m.nestedCalls && m.nestedCalls.calls;
      if (nested && nested.length) {
        step.nested_calls = nested.map((c) => ({
          tool: c.name,
          status: c.status,
          ...(c.arguments ? { arguments: argsOf(c.arguments, Math.min(n, 1000)) } : {}),
          ...(c.argumentsBytes ? { arguments_bytes: c.argumentsBytes } : {}),
          ...(c.error ? { error: clip(c.error, 500) } : {}),
          ...(c.durationMs != null ? { duration_ms: c.durationMs } : {}),
        }));
        if (m.nestedCalls.complete === false) {
          step.nested_complete = false;
        }
      }
      return [step];
    }
    case 'pi.system': {
      if (!m) {
        return [];
      }
      const step = { type: 'agent_system', at: at(m) };
      const text = textOf(m.content);
      if (text) {
        step.text = clip(text, n);
      }
      if (m.sections) {
        step.sections = Object.keys(m.sections);
      }
      if (m.toolsAdded && m.toolsAdded.length) {
        step.tools_added = m.toolsAdded.map((t) => t.name);
      }
      if (m.toolsRemoved && m.toolsRemoved.length) {
        step.tools_removed = m.toolsRemoved.map((t) => t.name || String(t));
      }
      return [step];
    }
    case 'pi.compaction':
    case 'pi.reset':
      return [{
        type: entry.kind === 'pi.reset' ? 'agent_reset' : 'agent_compaction',
        at: at(m),
        ...(m ? { text: clip(textOf(m.content), n) } : {}),
      }];
    default:
      return [{ type: 'agent_other', kind: entry.kind, at: at(m) }];
  }
}

/**
 * The latest `max` steps of a transcript, with long text clipped to `chars`: `{ steps, earlier,
 * usage }`, `earlier` the steps left out before them, `usage` the tokens and cost of all of it.
 */
export function traceSteps(entries, { max = MAX_STEPS, chars = MAX_STEP_TEXT } = {}) {
  const all = (entries || []).flatMap((e) => stepsOf(e, chars));
  // Steps without a time (a reset without a handoff) take the one before them.
  let last = null;
  for (const s of all) {
    s.at = s.at || last;
    last = s.at;
  }
  const usage = all.reduce((u, s) => (s.usage ? {
    tokens: u.tokens + s.usage.tokens, cost: u.cost + s.usage.cost,
  } : u), { tokens: 0, cost: 0 });
  const steps = all.slice(-max);
  return { steps, earlier: all.length - steps.length, usage };
}
