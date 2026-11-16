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

/*
 * The inbox's WebMCP tools (ui/inbox.js, WEBMCP_TOOLS): open_thread gives an agent each
 * message's whole text, within a budget for the thread, and says which it had to cut. The
 * page's own code, run in Node with what it needs of the rest of the page stubbed.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];

/** A piece of the page's script, from the line starting with `from` up to `to`, run in Node. */
function piece(from, to, expose, globals = {}) {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${js.slice(a, b)}\nreturn { ${expose} };`)(
    ...Object.values(globals),
  );
}

const KEY = 'slack:T1:C1:1700000000.000100';
const thread = {
  thread: KEY, title: 'The report', org: 'acme', source: 'slack',
};

let state;
let tools;

// What open_thread's messages share (THREAD_TEXT_BUDGET): at least one Slack message, whole.
const budget = 40000;

/** A message of the thread: `body` as the API sends it. */
const message = (id, body, more = {}) => ({
  thread: KEY, id, at: '2026-11-09T10:00:00Z', author: { name: `Person ${id}` }, body, ...more,
});

/** open_thread's answer for a thread of these messages. */
async function open(messages, args = {}) {
  state.data.threads = [thread];
  state.thread = { thread, messages, resolution: null };
  const tool = tools.find((t) => t.name === 'open_thread');
  return JSON.parse(await tool.execute({ thread: KEY, ...args }));
}

beforeEach(() => {
  state = { data: { threads: [], me: {} }, me: { connected: { slack: true } }, cache: new Map() };
  const page = piece('// ---------------------------------------------------------------- WebMCP', '/**\n * Asks the person on the page', 'WEBMCP_TOOLS', {
    state,
    STATUS_ORDER: ['critical'],
    KIND_ICON: { question: 'help' },
    PICKER: ['eyes'],
    searchEntry: (k) => state.data.threads.find((t) => t.thread === k),
    openThread: async (k) => {
      state.open = k;
      state.cache.set(k, { data: state.thread });
    },
    document: { querySelector: () => null },
    CSS: { escape: (s) => s },
    platform: () => 'Slack',
    resolvedOf: () => 'open',
    draftBy: () => 'someone',
    accountOf: () => 'Slack',
    $: () => ({}),
  });
  tools = page.WEBMCP_TOOLS;
});

// A long customer report and a long reply, of the lengths that were cut at 400 characters.
const report = `The root cause is a bug in the client.\n\n${'Steps and details. '.repeat(47)}`.trim();
const reply = `Thanks, here is what we found:\n\n- ${'One finding after another. '.repeat(60)}`.trim();

describe('open_thread', () => {
  it('returns every message whole, line breaks and all', async () => {
    assert.ok(report.length > 850 && reply.length > 1500);
    const res = await open([message('1', report), message('2', reply), message('3', 'ok')]);
    assert.deepEqual(res.messages.map((m) => m.text), [report, reply, 'ok']);
    assert.ok(res.messages.every((m) => !m.truncated && !('length' in m)));
  });

  it('cuts only the longest messages, to the same length, when the thread is over budget', async () => {
    const long = 'x'.repeat(budget);
    const res = await open([message('1', long), message('2', reply), message('3', long)]);
    const [a, b, c] = res.messages;
    assert.equal(b.text, reply);
    assert.equal(b.truncated, undefined);
    for (const m of [a, c]) {
      assert.equal(m.truncated, true);
      assert.equal(m.length, budget);
      assert.ok(m.text.endsWith('\u2026'));
    }
    assert.equal(a.text.length, c.text.length);
    const total = res.messages.reduce((n, m) => n + m.text.length, 0);
    assert.ok(total <= budget && total > budget - 3, `${total} of ${budget}`);
  });

  it('returns one message of Slack\'s greatest length whole', async () => {
    const res = await open([message('1', report), message('2', 'y'.repeat(budget))], { limit: 1 });
    assert.equal(res.messages.length, 1);
    assert.equal(res.messages[0].text.length, budget);
    assert.equal(res.earlier_messages, 1);
  });

  it('still says a deleted message is deleted', async () => {
    const res = await open([message('1', 'gone', { deletedAt: '2026-11-09T11:00:00Z' })]);
    assert.equal(res.messages[0].text, '(deleted)');
  });

  it('marks its output as untrusted, and names the thread `thread` as list_threads does', () => {
    const tool = tools.find((t) => t.name === 'open_thread');
    assert.equal(tool.annotations.untrustedContentHint, true);
    assert.match(tool.description, /written by customers and colleagues/);
    for (const t of tools) {
      const all = [t.description, ...Object.values(t.inputSchema.properties || {})
        .map((p) => p.description || '')].join(' ');
      assert.doesNotMatch(all, /\bkey\b/i, `${t.name} calls the thread a key`);
    }
    assert.match(tools.find((t) => t.name === 'list_threads').description, /`thread`/);
  });
});
