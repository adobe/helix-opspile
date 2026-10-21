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
import { fold } from '../src/api.js';
import { parse, render } from '../src/channels.js';
import { rethread, skeleton } from '../src/rethread.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

// Made-up alert texts and ids only.
const DAY = 86400 * 1000;
const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);

/**
 * A Vectorize stand-in with real cosine similarity, and an embedding model that maps a
 * text to a bag-of-words vector, so near-identical texts score near 1.
 */
function fakes({ clefChoice = 'new', clefP = 0.9 } = {}) {
  const vocab = new Map();
  const vec = (text) => {
    const v = new Array(64).fill(0);
    for (const w of String(text).toLowerCase().split(/\W+/).filter(Boolean)) {
      if (!vocab.has(w)) {
        vocab.set(w, vocab.size % 64);
      }
      v[vocab.get(w)] += 1;
    }
    return v;
  };
  const cos = (a, b) => {
    const dot = a.reduce((s, x, i) => s + x * b[i], 0);
    const n = (x) => Math.sqrt(x.reduce((s, y) => s + y * y, 0)) || 1;
    return dot / n(a) / n(b);
  };
  const stored = new Map();
  const clefCalls = [];
  return {
    clefCalls,
    VECTORS: {
      async upsert(items) {
        items.forEach((i) => stored.set(i.id, i));
      },
      async query(values, { filter, topK }) {
        return {
          matches: [...stored.values()]
            .filter((i) => i.metadata.channel === filter.channel)
            .map((i) => ({ id: i.id, score: cos(values, i.values), metadata: i.metadata }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK),
        };
      },
    },
    AI: {
      async run(model, input) {
        if (model.includes('bge')) {
          return { data: input.text.map(vec) };
        }
        clefCalls.push(input);
        return {
          answers: {
            continues: {
              choice: clefChoice, probabilities: { [clefChoice]: clefP }, confidence: clefP,
            },
          },
        };
      },
    },
  };
}

async function seed(env, n, text, at) {
  const thread = `slack:E1:C1:${n}`;
  const path = `channels/acme/helix/slack-C1/${n}/`;
  env.DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
    kind, path, root_at, last_at, any_at, updated_at) VALUES (?, 'slack', 'E1', 'C1', ?, 'acme', 'helix',
    'alert', ?, ?, ?, ?, ?)`).run(thread, n, path, at, at, at, at);
  await env.CHANNELS.put(`${path}${n}.md`, render({
    source: 'slack', thread, id: n, at,
  }, text), {
    customMetadata: { version: '1', deleted: '0' },
  });
  return thread;
}

const alert = (status, ray, time) => `*:rotating_light: [PROD] Ops alert — acme/site*

*Method:* POST
*Path:* /estimate/price
*Status:* ${status}
*Time:* ${time}
*Ray ID:* \`${ray}\`
*User-Agent:* Mozilla/5.0 (X11; Linux) Chrome/155.0`;

describe('skeleton', () => {
  it('drops what differs between repeats and keeps status codes', () => {
    const a = skeleton(alert(422, 'a4e16b8edcc84c7a', '2026-10-21T15:50:49.420Z'));
    const b = skeleton(alert(422, 'ffe1aa8edcc84c00', '2026-10-22T01:02:03.000Z'));
    assert.equal(a, b);
    assert.notEqual(a, skeleton(alert(500, 'a4e16b8edcc84c7a', '2026-10-21T15:50:49.420Z')));
    assert.match(a, /<time>/);
    assert.match(a, /<user-agent>/);
  });
});

describe('rethread', () => {
  it('folds repeats of the same alert into the first thread, in any order', async () => {
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
      const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes() };
      const keys = [];
      for (const [i, ray] of ['a4e16b8edcc84c7a', 'b5f27c9fedd95d8b', 'c6038da0fee06e9c'].entries()) {
        const at = new Date(T0 + i * 3600 * 1000).toISOString();
        // eslint-disable-next-line no-await-in-loop
        keys.push(await seed(env, `1.${i}`, alert(422, ray, at), at));
      }
      for (const i of order) {
        // eslint-disable-next-line no-await-in-loop
        await rethread(env, keys[i]);
      }
      const rows = env.DB.rows('SELECT thread, logical_thread FROM threads ORDER BY root_at');
      assert.deepEqual(rows.map((r) => r.logical_thread), [null, keys[0], keys[0]], `order ${order}`);
      assert.equal(env.clefCalls.length, 0); // identical skeletons need no Clef
      // eslint-disable-next-line no-await-in-loop
      const file = await env.CHANNELS.get('channels/acme/helix/slack-C1/1.2/1.2.md');
      // eslint-disable-next-line no-await-in-loop
      const root = parse(await file.text());
      assert.equal(root.meta.logicalThread, keys[0]);
    }
  });

  it('keeps different failures apart, and lets Clef decide the unclear cases', async () => {
    const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes({ clefChoice: 'new' }) };
    const at0 = new Date(T0).toISOString();
    const at1 = new Date(T0 + DAY).toISOString();
    const a = await seed(env, '2.0', alert(422, 'a4e16b8edcc84c7a', at0), at0);
    const b = await seed(env, '2.1', alert(500, 'b5f27c9fedd95d8b', at1), at1);
    await rethread(env, a);
    const r = await rethread(env, b);
    assert.equal(r.result, 'new-topic');
    assert.equal(env.clefCalls.length, 1);
    assert.deepEqual(Object.keys(env.clefCalls[0].questions.continues.criteria), ['new', 'c0']);
  });

  it('follows Clef when it is sure, and ignores roots outside the window', async () => {
    const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes({ clefChoice: 'c0', clefP: 0.85 }) };
    const old = new Date(T0 - 30 * DAY).toISOString();
    const at0 = new Date(T0).toISOString();
    const at1 = new Date(T0 + DAY).toISOString();
    const ancient = await seed(env, '3.0', alert(500, 'aaaaaaaaaaaaaaaa', old), old);
    const a = await seed(env, '3.1', alert(422, 'a4e16b8edcc84c7a', at0), at0);
    const b = await seed(env, '3.2', alert(500, 'b5f27c9fedd95d8b', at1), at1);
    await rethread(env, ancient);
    await rethread(env, a);
    const r = await rethread(env, b);
    assert.deepEqual([r.result, r.via], ['rethreaded', 'clef']);
    assert.equal(env.DB.rows('SELECT logical_thread FROM threads WHERE thread = ?', b)[0].logical_thread, a);
    assert.equal((await rethread(env, b)).result, 'unchanged');
  });
});

describe('fold', () => {
  it('shows a group as one entry with the latest activity and the most pressing attention', () => {
    const t = (thread, at, extra = {}) => ({
      thread,
      root_at: at,
      last_at: at,
      any_at: at,
      messages: 1,
      attention: null,
      participants: [],
      ...extra,
    });
    const [g, solo] = fold([
      t('a', '2026-10-20T10:00:00Z', { title: 'first', attention: 'me' }),
      t('b', '2026-10-21T10:00:00Z', { logical_thread: 'a', attention: 'adobe', label: { next_actor: 'us' } }),
      t('c', '2026-10-19T10:00:00Z', { title: 'other' }),
    ]);
    assert.deepEqual([g.thread, g.title, g.last_at, g.messages, g.attention, g.label.next_actor], [
      'a', 'first', '2026-10-21T10:00:00Z', 2, 'adobe', 'us',
    ]);
    assert.deepEqual(g.members.map((m) => m.thread), ['a', 'b']);
    assert.equal(solo.thread, 'c');
  });
});
