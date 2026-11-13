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
 * The mention pools the composer keeps (ui/inbox.js, `mentionPools`): someone the admin bot
 * just added to the channel is suggested without reloading the page, once a message comes in
 * there or the name typed matches nobody the kept pool has.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { suggestMentions } from '../src/mention-match.js';
import { SCRIPTS } from './ui.js';

const js = SCRIPTS['inbox.js'];

// Made-up threads and people only.
const THREAD = 'teams:T:G1:19:c@thread.tacv2:5';
const OTHER = 'teams:T:G1:19:c@thread.tacv2:9';
const ELSEWHERE = 'teams:T:G1:19:d@thread.tacv2:9';
const BOB = { id: 'u-bob', name: 'Bob Builder', member: true };
const ASH = { id: 'u-ash', name: 'Ash Newcomer', member: true };
const pool = (...accounts) => ({ accounts, bots: [] });

let page;
let clock;
let asked;
let answers;
let mention;
let shown;
let typed;
let open;

/** Lets the Worker's answers (and what follows them) happen. */
const settle = () => new Promise((resolve) => {
  setImmediate(resolve);
});

beforeEach(() => {
  clock = 1_000_000;
  asked = [];
  // What the Worker has for whoever asks: its pool, by then.
  answers = pool(BOB);
  shown = [];
  typed = '@';
  open = THREAD;
  mention = {
    kind: 'person', list: [], i: 0, from: -1, seq: 0, timer: null, waiting: null, pooled: null,
  };
  const a = js.indexOf('const mentionPools = new Map();');
  const b = js.indexOf('// Typing : and two more characters', a);
  assert.ok(a >= 0 && b > a);
  const deps = {
    state: { as: null },
    mention,
    Markdown: { suggestMentions },
    get: async (url) => {
      asked.push(url);
      const q = new URLSearchParams(url.split('?')[1]);
      return {
        people: suggestMentions(answers, q.get('q')),
        ...(q.get('pool') ? { pool: answers } : {}),
      };
    },
    inPane: (key) => key === open,
    mentionScope: (key) => `thread=${encodeURIComponent(key)}`,
    mentionBox: () => ({}),
    mentionQuery: () => ({ q: typed.slice(1), from: 0 }),
    emojiQuery: () => null,
    suggestEmoji: () => {},
    renderMentions: () => { shown.push(mention.list.map((p) => p.name)); },
    closeMentions: () => {
      Object.assign(mention, {
        list: [], waiting: null, pooled: null, seq: mention.seq + 1,
      });
    },
    Date: { now: () => clock },
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    clearTimeout: () => {},
  };
  // eslint-disable-next-line no-new-func
  page = new Function(...Object.keys(deps), `${js.slice(a, b)}\nreturn { suggest, stalePools, mentionPools };`)(
    ...Object.values(deps),
  );
});

/** Types `text` in the reply box of the open thread. */
async function type(text) {
  typed = text;
  page.suggest(open);
  await settle();
}

describe('mention pools', () => {
  it('asks for the pool with the first suggestions, and then asks the Worker nothing', async () => {
    await type('@');
    assert.equal(asked.length, 1);
    assert.match(asked[0], /pool=1/);
    await type('@b');
    await type('@bo');
    assert.equal(asked.length, 1);
    assert.deepEqual(shown.at(-1), ['Bob Builder']);
  });

  it('suggests someone just added once a message comes in in the channel', async () => {
    await type('@');
    // The admin bot adds Ash; its confirmation (or the platform's notice) comes in, in another
    // thread of the channel. A message in another channel changes nothing.
    answers = pool(BOB, ASH);
    page.stalePools(ELSEWHERE);
    clock += 1000;
    await type('@');
    assert.equal(asked.length, 1);
    page.stalePools(OTHER);
    await type('@');
    // Shown from the kept pool at once, asked again, and shown from the new one when it comes.
    assert.equal(asked.length, 2);
    assert.match(asked[1], /q=&pool=1/);
    assert.deepEqual(shown.slice(-2), [['Bob Builder'], ['Ash Newcomer', 'Bob Builder']]);
    await type('@as');
    assert.equal(asked.length, 2);
    assert.deepEqual(shown.at(-1), ['Ash Newcomer']);
  });

  it('asks the Worker for a name its pool has nobody for, unless the pool is just here', async () => {
    await type('@');
    answers = pool(BOB, ASH);
    // Just asked: the name is someone else's to find.
    clock += 1000;
    await type('@as');
    assert.equal(asked.length, 1);
    assert.deepEqual(shown.at(-1), []);
    // A few seconds on: the Worker is asked, with the name (it may list the channel again), and
    // what is typed by the time it answers is suggested from its pool.
    clock += 5000;
    typed = '@as';
    page.suggest(open);
    await type('@ash');
    assert.equal(asked.length, 2);
    assert.match(asked[1], /q=as&pool=1/);
    assert.deepEqual(shown.at(-1), ['Ash Newcomer']);
  });

  it('opens nothing again when the suggestions were closed or the thread left meanwhile', async () => {
    await type('@');
    answers = pool(BOB, ASH);
    page.stalePools(OTHER);
    typed = '@';
    page.suggest(open);
    const before = shown.length;
    mention.pooled = null; // Escape
    await settle();
    assert.equal(asked.length, 2);
    assert.equal(shown.length, before);

    page.stalePools(OTHER);
    typed = '@';
    page.suggest(open);
    open = 'teams:T:G1:19:c@thread.tacv2:7';
    await settle();
    assert.equal(asked.length, 3);
    assert.equal(shown.length, before + 1);
  });
});
