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
 * Asking the thread's agent about someone (ui/inbox.js, `askAbout` and `askSide`): a click on
 * their picture, or the card's question, opens the thread and its sidebar and sends "What should
 * I know about …?". What you had typed in the sidebar's box stays there, and stays kept for the
 * next time you enter the sidebar.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];

/** A piece of the page's script, from `from` up to `to`, run in Node with these globals. */
function piece(from, to, expose, globals = {}) {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${js.slice(a, b)}\nreturn { ${expose} };`)(
    ...Object.values(globals),
  );
}

/** The page's state for one open thread with an agent, and what was sent. */
function page({ open = 'slack:T:C:1', typed = '' } = {}) {
  const posted = [];
  const calls = [];
  const box = { value: typed };
  const side = { key: null, sending: [], typed: new Map(typed ? [[open, typed]] : []) };
  const state = {
    open, me: { id: 1, name: 'Lena Berg' }, cache: new Map(), agents: new Map(),
  };
  const globals = {
    side,
    state,
    $: (id) => (id === 'side-reply' && side.key ? box : null),
    growReply: () => {},
    showSide: () => {},
    sidePaneled: () => false,
    loadAgent: () => {},
    toast: (t) => calls.push(['toast', t]),
    AGENT_NAME: 'Thread Agent',
    request: async (method, path, body) => {
      posted.push([method, path, body]);
      return { ok: true, data: { message: { id: 'sb_1', at: '2026-11-16T10:00:00Z' } } };
    },
    hideCard: () => calls.push(['hideCard']),
    recordPick: (k) => calls.push(['recordPick', k]),
    openThread: async (k) => {
      calls.push(['openThread', k]);
      state.open = k;
    },
    canSide: () => true,
    enterSide: async (k) => {
      side.key = k;
      box.value = side.typed.get(k) || '';
    },
  };
  const { askSide } = piece('async function askSide(', '\n// -------', 'askSide', globals);
  const { askAbout } = piece('async function askAbout(', '\nfunction cardHtml', 'askAbout', { ...globals, askSide });
  return {
    askAbout, askSide, box, side, state, posted, calls,
  };
}

/** After what the page does next. */
function settled() {
  return new Promise((r) => {
    setTimeout(r, 0);
  });
}

describe('asking the agent about someone', () => {
  it('sends the question in the sidebar of the open thread', async () => {
    const p = page();
    await p.askAbout('slack:T:C:1', 'Dana Ops');
    await settled();
    assert.deepEqual(p.posted, [['POST', '/api/agent/sidebar', { thread: 'slack:T:C:1', text: 'What should I know about Dana Ops?' }]]);
    assert.equal(p.side.key, 'slack:T:C:1');
    assert.ok(!p.calls.some(([c]) => c === 'openThread'));
  });

  it('opens another thread first', async () => {
    const p = page();
    await p.askAbout('slack:T:C:2', 'Sam Reyes');
    await settled();
    assert.deepEqual(p.calls.slice(1), [['recordPick', 'slack:T:C:2'], ['openThread', 'slack:T:C:2']]);
    assert.equal(p.posted[0][2].thread, 'slack:T:C:2');
  });

  it('leaves what was typed in the sidebar\'s box, and keeps it for next time', async () => {
    const p = page({ typed: 'Half a question' });
    await p.askAbout('slack:T:C:1', 'Dana Ops');
    await settled();
    assert.equal(p.posted[0][2].text, 'What should I know about Dana Ops?');
    assert.equal(p.box.value, 'Half a question');
    assert.equal(p.side.typed.get('slack:T:C:1'), 'Half a question');
  });

  it('still sends what is typed, and empties the box, when you ask yourself', async () => {
    const p = page({ typed: 'Is the CDN purged?' });
    p.side.key = 'slack:T:C:1';
    p.box.value = 'Is the CDN purged?';
    await p.askSide('slack:T:C:1');
    assert.equal(p.posted[0][2].text, 'Is the CDN purged?');
    assert.equal(p.box.value, '');
    assert.equal(p.side.typed.has('slack:T:C:1'), false);
  });
});
