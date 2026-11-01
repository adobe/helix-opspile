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
import { quoteMarkdown } from '../src/markdown.js';
import { ago, rethread, skeleton } from '../src/rethread.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

// Made-up alert texts and ids only.
const DAY = 86400 * 1000;
const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);

/**
 * A Vectorize stand-in with real cosine similarity, and an embedding model that maps a
 * text to a bag-of-words vector, so near-identical texts score near 1.
 */
function fakes({ clefChoice = 'new', clefP = 0.9, clefProbabilities = null } = {}) {
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
              choice: clefChoice,
              probabilities: clefProbabilities || { [clefChoice]: clefP },
              confidence: clefP,
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

  it('tells open inboxes which threads it folded into which group', async () => {
    const notified = [];
    const ROOMS = {
      idFromName: (n) => n,
      get: (team) => ({
        fetch: async (u, init) => {
          notified.push({ team, ...JSON.parse(init.body) });
          return new Response(null, { status: 204 });
        },
      }),
    };
    const env = {
      DB: d1(), CHANNELS: fakeBucket(), ROOMS, ...fakes(),
    };
    const keys = [];
    for (const [i, ray] of ['a4e16b8edcc84c7a', 'b5f27c9fedd95d8b'].entries()) {
      const at = new Date(T0 + i * 3600 * 1000).toISOString();
      // eslint-disable-next-line no-await-in-loop
      keys.push(await seed(env, `9.${i}`, alert(422, ray, at), at));
    }
    await rethread(env, keys[0]);
    assert.deepEqual(notified, []); // a new topic changes no group
    await rethread(env, keys[1]);
    assert.deepEqual(notified, [{
      team: 'helix', type: 'thread', thread: keys[0], folded: [keys[1]],
    }]);
    // Decided again, the same way: nothing moved.
    await rethread(env, keys[1], { force: true });
    assert.equal(notified.length, 1);
  });

  it('matches exact repeats by skeleton even when vector search has not caught up', async () => {
    const f = fakes();
    f.VECTORS.query = async () => ({ matches: [] }); // nothing visible yet
    for (const order of [[0, 1, 2], [2, 0, 1]]) {
      const env = { DB: d1(), CHANNELS: fakeBucket(), ...f };
      const keys = [];
      for (const [i, ray] of ['a4e16b8edcc84c7a', 'b5f27c9fedd95d8b', 'c6038da0fee06e9c'].entries()) {
        const at = new Date(T0 + i * 3600 * 1000).toISOString();
        // eslint-disable-next-line no-await-in-loop
        keys.push(await seed(env, `4.${i}`, alert(422, ray, at), at));
      }
      for (const i of order) {
        // eslint-disable-next-line no-await-in-loop
        await rethread(env, keys[i]);
      }
      const rows = env.DB.rows('SELECT logical_thread, logical_via FROM threads ORDER BY root_at');
      assert.deepEqual(rows.map((r) => r.logical_thread), [null, keys[0], keys[0]], `order ${order}`);
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

describe('a re-threading job that fails half way', () => {
  it('is finished by its retry, in the file too', async () => {
    const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes() };
    const keys = [];
    for (const [i, ray] of ['a4e16b8edcc84c7a', 'b5f27c9fedd95d8b'].entries()) {
      const at = new Date(T0 + i * 3600 * 1000).toISOString();
      // eslint-disable-next-line no-await-in-loop
      keys.push(await seed(env, `1.${i}`, alert(422, ray, at), at));
    }
    await rethread(env, keys[0]);

    // R2 fails just as the match is written into the root's file.
    const { put } = env.CHANNELS;
    let failing = true;
    env.CHANNELS.put = async (...args) => {
      if (failing) {
        failing = false;
        throw new Error('R2 is down');
      }
      return put.apply(env.CHANNELS, args);
    };
    await assert.rejects(rethread(env, keys[1]), /R2 is down/);
    const undecided = env.DB.rows('SELECT rethreaded_at FROM threads WHERE thread = ?', keys[1]);
    assert.equal(undecided[0].rethreaded_at, null);

    const r = await rethread(env, keys[1]);
    assert.equal(r.result, 'rethreaded');
    const [row] = env.DB.rows('SELECT logical_thread, rethreaded_at FROM threads WHERE thread = ?', keys[1]);
    assert.equal(row.logical_thread, keys[0]);
    assert.ok(row.rethreaded_at);
    const file = await env.CHANNELS.get('channels/acme/helix/slack-C1/1.1/1.1.md');
    assert.match(await file.text(), new RegExp(`logicalThread: ?"?${keys[0]}`));
    assert.equal((await rethread(env, keys[1])).result, 'unchanged');
  });
});

describe('bursts', () => {
  it('folds a second root by the same person minutes later, in any order', async () => {
    for (const order of [[0, 1], [1, 0]]) {
      const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes() };
      const at0 = new Date(T0).toISOString();
      const at1 = new Date(T0 + 12000).toISOString();
      // eslint-disable-next-line no-await-in-loop
      const a = await seed(env, '5.0', 'Hi Amol', at0);
      // eslint-disable-next-line no-await-in-loop
      const b = await seed(env, '5.1', 'we are on call, can you join?', at1);
      env.DB.sqlite.prepare("UPDATE threads SET kind = 'channel'").run();
      for (const [k, at, id] of [[a, at0, '5.0'], [b, at1, '5.1']]) {
        env.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author_key, counted)
          VALUES ('slack', 'E1', 'C1', ?, ?, ?, 'slack:E1:U7', 1)`).run(id, k, at);
      }
      for (const i of order) {
        // eslint-disable-next-line no-await-in-loop
        await rethread(env, [a, b][i]);
      }
      const rows = env.DB.rows('SELECT logical_thread, logical_via FROM threads ORDER BY root_at');
      assert.deepEqual(rows, [{ logical_thread: null, logical_via: null }, { logical_thread: a, logical_via: 'burst' }], `order ${order}`);
    }
  });
});

describe('conversations', () => {
  const conversation = (env, messages) => {
    env.DB.sqlite.prepare("UPDATE threads SET kind = 'channel'").run();
    for (const [k, at, id, user] of messages) {
      env.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author_key, counted)
        VALUES ('slack', 'E1', 'C1', ?, ?, ?, ?, 1)`).run(id, k, at, `slack:E1:${user}`);
    }
  };
  const reply = (env, n, id, text, at) => env.CHANNELS.put(`channels/acme/helix/slack-C1/${n}/${id}.md`, render({
    source: 'slack', thread: `slack:E1:C1:${n}`, id, at,
  }, text));
  const ask = (env) => env.clefCalls[0].questions.continues;

  it('asks Clef which of the latest conversations a root continues, reading them as a transcript', async () => {
    const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes({ clefChoice: 'c0', clefP: 0.9 }) };
    const at0 = new Date(T0).toISOString();
    const atReply = new Date(T0 + 20 * 60000).toISOString();
    const at1 = new Date(T0 + 5 * 3600000).toISOString();
    const a = await seed(env, '7.0', 'Publishing a page from author fails with a permission error', at0);
    await reply(env, '7.0', '7.5', 'Which page? Send me the URL', atReply);
    const b = await seed(env, '7.1', 'This is a BLOCKER for our go live, please help asap', at1);
    conversation(env, [[a, at0, '7.0', 'U1'], [a, atReply, '7.5', 'U3'], [b, at1, '7.1', 'U2']]);
    await rethread(env, a);
    const r = await rethread(env, b);
    assert.deepEqual([r.result, r.via], ['rethreaded', 'clef']);
    assert.equal(env.clefCalls.length, 1);
    const { state } = env.clefCalls[0];
    assert.match(state, /^Earlier messages in the channel, by conversation:\n\[A, 5 hours before\] Publishing/);
    assert.match(state, /\n\[A, 5 hours before\] Which page\? Send me the URL\n/);
    assert.match(state, /\n\nNew message: This is a BLOCKER/);
    assert.deepEqual(Object.keys(ask(env).criteria), ['new', 'c0']);
    assert.match(ask(env).criteria.c0, /^Continues conversation A \(Publishing/);
    assert.equal(env.DB.rows('SELECT logical_thread FROM threads WHERE thread = ?', b)[0].logical_thread, a);
  });

  it('does not ask about an unrelated conversation that has been quiet for more than three days', async () => {
    const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes({ clefChoice: 'c0', clefP: 0.9 }) };
    const at0 = new Date(T0).toISOString();
    const at1 = new Date(T0 + 3 * DAY + 60000).toISOString();
    const a = await seed(env, '8.0', 'Publishing a page from author fails with a permission error', at0);
    const b = await seed(env, '8.1', 'This is a BLOCKER for our go live, please help asap', at1);
    conversation(env, [[a, at0, '8.0', 'U1'], [b, at1, '8.1', 'U2']]);
    await rethread(env, a);
    assert.equal((await rethread(env, b)).result, 'new-topic');
    assert.equal(env.clefCalls.length, 0);
  });

  it('offers a group once, with its first and latest messages', async () => {
    const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes({ clefChoice: 'c0', clefP: 0.85 }) };
    const at0 = new Date(T0).toISOString();
    const at1 = new Date(T0 + 5 * 60000).toISOString();
    const at2 = new Date(T0 + 30 * 60000).toISOString();
    const a = await seed(env, '9.0', 'Publishing a page from author fails with a permission error', at0);
    const b = await seed(env, '9.1', 'yes, I can look into it, send me the page', at1);
    const c = await seed(env, '9.2', 'Done, the page is published now', at2);
    conversation(env, [[a, at0, '9.0', 'U1'], [b, at1, '9.1', 'U3'], [c, at2, '9.2', 'U1']]);
    await rethread(env, a);
    env.DB.sqlite.prepare('UPDATE threads SET logical_thread = ?, rethreaded_at = ? WHERE thread = ?').run(a, at1, b);
    const r = await rethread(env, c);
    assert.deepEqual(Object.keys(ask(env).criteria), ['new', 'c0']);
    assert.match(env.clefCalls[0].state, /\[A, 30 minutes before\] Publishing.*\n\[A, 25 minutes before\] yes, I can/);
    assert.deepEqual([r.result, r.via, r.p], ['rethreaded', 'clef', 0.85]);
    assert.equal(env.DB.rows('SELECT logical_thread FROM threads WHERE thread = ?', c)[0].logical_thread, a);
  });

  it('says how sure Clef was when it said no, and needs it surer than for alerts', async () => {
    for (const p of [0.57, 0.75]) {
      const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes({ clefChoice: 'c0', clefP: p }) };
      const at0 = new Date(T0).toISOString();
      const at1 = new Date(T0 + 25 * 60000).toISOString();
      // eslint-disable-next-line no-await-in-loop
      const a = await seed(env, '10.0', 'Publishing a page from author fails', at0);
      // eslint-disable-next-line no-await-in-loop
      const b = await seed(env, '10.1', 'Can someone help please', at1);
      conversation(env, [[a, at0, '10.0', 'U1'], [b, at1, '10.1', 'U2']]);
      // eslint-disable-next-line no-await-in-loop
      await rethread(env, a);
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await rethread(env, b), {
        result: 'new-topic', via: null, p: null, clef: p,
      });
    }
  });

  it('asks Clef about a second root by the same person more than three minutes later', async () => {
    const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes({ clefChoice: 'new' }) };
    const at0 = new Date(T0).toISOString();
    const at1 = new Date(T0 + 4 * 60000).toISOString();
    const a = await seed(env, '11.0', 'See you on the call then', at0);
    const b = await seed(env, '11.1', 'The fix for the cache headers is deployed', at1);
    conversation(env, [[a, at0, '11.0', 'U1'], [b, at1, '11.1', 'U1']]);
    await rethread(env, a);
    assert.equal((await rethread(env, b)).result, 'new-topic');
    assert.equal(env.clefCalls.length, 1);
  });

  it('does not take the same words for a repeat', async () => {
    const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes({ clefChoice: 'new' }) };
    const at0 = new Date(T0).toISOString();
    const at1 = new Date(T0 + 2 * DAY).toISOString();
    const a = await seed(env, '12.0', 'Thank you!!', at0);
    const b = await seed(env, '12.1', 'Thank you!!', at1);
    conversation(env, [[a, at0, '12.0', 'U1'], [b, at1, '12.1', 'U2']]);
    await rethread(env, a);
    assert.equal((await rethread(env, b)).result, 'new-topic');
    assert.equal(env.clefCalls.length, 1);
  });

  it('leaves a root that quotes a message on its own, and out of a burst', async () => {
    const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes({ clefChoice: 'c0', clefP: 0.99 }) };
    const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();
    const quote = (id) => quoteMarkdown({
      author: 'Ada', url: `https://example.slack.com/archives/C1/p${id}`, at: at(0), text: 'We should rank people by what they know',
    });
    const a = await seed(env, '14.0', `I just merged the change that lets everyone in.\n\n${quote(1)}`, at(0));
    const b = await seed(env, '14.1', 'Looks good on stage', at(59));
    const c = await seed(env, '14.2', `First step in that direction\n\n${quote(2)}`, at(60));
    const d = await seed(env, '14.3', 'and the next one is up for review', at(61));
    conversation(env, [[a, at(0), '14.0', 'U1'], [b, at(59), '14.1', 'U1'], [c, at(60), '14.2', 'U1'],
      [d, at(61), '14.3', 'U1']]);
    await rethread(env, a);
    // Clef would have put the quoting root into the first one, and it follows a root by the
    // same person within minutes: it is new all the same.
    assert.deepEqual(await rethread(env, c), {
      result: 'new-topic', via: null, p: null, reason: 'quotes a message',
    });
    assert.equal(env.clefCalls.length, 0);
    // The root before it, re-threaded later, does not pull it in either.
    await rethread(env, b);
    assert.equal(env.DB.rows('SELECT logical_thread FROM threads WHERE thread = ?', c)[0].logical_thread, null);
    // What follows it within minutes continues it, as any burst.
    assert.deepEqual(env.DB.rows('SELECT logical_thread, logical_via FROM threads WHERE thread = ?', d), [
      { logical_thread: c, logical_via: 'burst' },
    ]);
  });

  it('reads a quote in the transcript as who wrote it, not as a link', async () => {
    const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes({ clefChoice: 'new' }) };
    const at0 = new Date(T0).toISOString();
    const at1 = new Date(T0 + 30 * 60000).toISOString();
    const a = await seed(env, '15.0', `Look at this\n\n${quoteMarkdown({
      author: 'Ada', url: 'https://example.slack.com/archives/C1/p1', at: at0, text: 'Preview is down',
    })}`, at0);
    const b = await seed(env, '15.1', 'Is preview back?', at1);
    conversation(env, [[a, at0, '15.0', 'U1'], [b, at1, '15.1', 'U2']]);
    await rethread(env, a);
    await rethread(env, b);
    assert.match(env.clefCalls[0].state, /\[A, 30 minutes before\] Look at this\n\n> Ada wrote:\n> Preview is down\n/);
  });

  it('leaves platform notices alone', async () => {
    const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes({ clefChoice: 'c0', clefP: 0.99 }) };
    const at0 = new Date(T0).toISOString();
    const at1 = new Date(T0 + 60000).toISOString();
    const a = await seed(env, '13.0', 'Could you invite our new developer?', at0);
    const b = 'slack:E1:C1:13.1';
    env.DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      kind, path, root_at, any_at, updated_at) VALUES (?, 'slack', 'E1', 'C1', '13.1', 'acme', 'helix',
      'channel', 'channels/acme/helix/slack-C1/13.1/', ?, ?, ?)`).run(b, at1, at1, at1);
    await env.CHANNELS.put('channels/acme/helix/slack-C1/13.1/13.1.md', render({
      source: 'slack', thread: b, id: '13.1', at: at1, author: { kind: 'system', name: 'Slack' },
    }, '@Someone has joined the channel'));
    conversation(env, [[a, at0, '13.0', 'U1']]);
    assert.deepEqual(await rethread(env, b), { result: 'skip', reason: 'system message' });
    assert.equal(env.clefCalls.length, 0);
  });
});

describe('ago', () => {
  it('says minutes, hours or days', () => {
    assert.deepEqual([ago(60000), ago(25 * 60000), ago(3 * 3600000), ago(5 * DAY)], [
      '1 minute', '25 minutes', '3 hours', '5 days',
    ]);
  });
});

describe('bursts and bots', () => {
  it('never treats a bot posting different alerts as a burst', async () => {
    const env = { DB: d1(), CHANNELS: fakeBucket(), ...fakes() };
    const at0 = new Date(T0).toISOString();
    const at1 = new Date(T0 + 60000).toISOString();
    const a = await seed(env, '6.0', alert(422, 'a4e16b8edcc84c7a', at0), at0);
    const b = await seed(env, '6.1', 'Disk full on build-7', at1);
    for (const [k, at, id] of [[a, at0, '6.0'], [b, at1, '6.1']]) {
      env.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author_key, counted)
        VALUES ('slack', 'E1', 'C1', ?, ?, ?, 'slack:E1:B1', 0)`).run(id, k, at);
    }
    await rethread(env, a);
    await rethread(env, b);
    assert.deepEqual(env.DB.rows('SELECT logical_via FROM threads ORDER BY root_at').map((r) => r.logical_via), [null, null]);
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
      t('a', '2026-10-20T10:00:00Z', { title: 'first', attention: 'me', last_text: 'older' }),
      t('b', '2026-10-21T10:00:00Z', {
        logical_thread: 'a', attention: 'adobe', label: { next_actor: 'us' }, last_text: 'newer',
      }),
      t('c', '2026-10-19T10:00:00Z', { title: 'other' }),
    ]);
    assert.deepEqual([g.thread, g.title, g.last_at, g.messages, g.attention, g.label.next_actor], [
      'a', 'first', '2026-10-21T10:00:00Z', 2, 'adobe', 'us',
    ]);
    assert.equal(g.last_text, 'newer'); // the latest member's
    assert.deepEqual(g.members.map((m) => m.thread), ['a', 'b']);
    assert.equal(solo.thread, 'c');
  });
});
