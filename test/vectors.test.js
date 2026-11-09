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
import { render } from '../src/channels.js';
import {
  chunks, MAX_CHUNK, MAX_CHUNKS, mean, messageVectorId, sweepVectors, threadChunks,
  threadVectorId, vectorizeThread,
} from '../src/vectors.js';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

// Made-up channel, people and texts only.
const KEY = 'slack:E1:C1:1.1';
const PATH = 'channels/acme/helix/slack-C1/1.1/';
const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);
const iso = (minutes) => new Date(T0 + minutes * 60000).toISOString();

/** Workers AI (a bag-of-words embedding) and a Vectorize index in memory, with call counts. */
function fakes() {
  const vec = (text) => {
    const v = new Array(16).fill(0);
    for (const w of String(text).toLowerCase().split(/\W+/).filter(Boolean)) {
      v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 16, 7)] += 1;
    }
    return v;
  };
  const stored = new Map();
  const embedded = [];
  return {
    stored,
    embedded,
    AI: {
      async run(model, { text }) {
        assert.match(model, /bge-base/);
        text.forEach((t) => assert.ok(t.length <= MAX_CHUNK));
        embedded.push(...text);
        return { data: text.map(vec) };
      },
    },
    CONTENT: {
      async upsert(items) {
        items.forEach((i) => stored.set(i.id, i));
      },
      async deleteByIds(ids) {
        ids.forEach((id) => stored.delete(id));
      },
    },
  };
}

function setup({ kind = 'channel' } = {}) {
  const env = {
    DB: d1(), CHANNELS: fakeBucket(), ...fakes(), queued: [],
  };
  env.NORMALIZE = {
    async sendBatch(jobs) {
      env.queued.push(...jobs.map((j) => j.body));
    },
  };
  env.DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
    kind, title, path, root_at, last_at, any_at, updated_at)
    VALUES (?, 'slack', 'E1', 'C1', '1.1', 'acme', 'helix', ?, 'Cache purge fails', ?, ?, ?, ?, ?)`)
    .run(KEY, kind, PATH, iso(0), iso(0), iso(0), iso(0));
  return env;
}

async function post(env, id, minutes, body, { person = null, staff = 0, counted = 1 } = {}) {
  const at = iso(minutes);
  env.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person,
    staff, counted, author_key) VALUES ('slack', 'E1', 'C1', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, KEY, at, person, staff, counted, `slack:E1:U${person || 0}`);
  env.DB.sqlite.prepare('UPDATE threads SET last_at = ?, any_at = ? WHERE thread = ?').run(at, at, KEY);
  await env.CHANNELS.put(`${PATH}${id}.md`, render({
    source: 'slack', thread: KEY, id, at,
  }, body), { customMetadata: { version: '1', deleted: '0' } });
}

const byType = (env, type) => [...env.stored.values()].filter((v) => v.metadata.type === type);

describe('message and thread vectors', () => {
  it('embeds what people wrote, once, and the thread from all of it', async () => {
    const env = setup();
    await post(env, '1.1', 0, 'The cache purge fails with a 403 on the live site');
    await post(env, '1.2', 5, 'Purged it again with a fresh key, it works now', { person: 7, staff: 1 });
    await post(env, '1.3', 6, 'thanks!');
    await post(env, '1.4', 7, 'Build finished: deployment of main succeeded', { counted: 0 });

    const r = await vectorizeThread(env, KEY);
    assert.deepEqual(r, {
      result: 'vectorized', messages: 2, removed: 0, thread: 'embedded',
    });
    const messages = byType(env, 'message');
    assert.equal(messages.length, 2);
    const answer = env.stored.get(await messageVectorId('slack:E1:C1:1.2'));
    assert.deepEqual(answer.metadata, {
      type: 'message',
      channel: 'slack:E1:C1',
      thread: KEY,
      org: 'acme',
      team: 'helix',
      message: 'slack:E1:C1:1.2',
      at: Math.floor((T0 + 5 * 60000) / 1000),
      person: 7,
      staff: true,
      author: 'slack:E1:U7',
    });
    const [thread] = byType(env, 'thread');
    assert.equal(thread.id, await threadVectorId(KEY));
    assert.equal(thread.metadata.messages, 2);
    // The thread reads its title and what people wrote; not the bot, not "thanks!".
    const threadText = env.embedded[env.embedded.length - 1];
    assert.match(threadText, /^Cache purge fails\n\nThe cache purge fails.*\n\nPurged it again/s);
    assert.doesNotMatch(threadText, /thanks|Build finished/);
    assert.equal(env.DB.rows('SELECT vectorized_through FROM threads')[0].vectorized_through, iso(7));

    const calls = env.embedded.length;
    assert.deepEqual(await vectorizeThread(env, KEY), {
      result: 'vectorized', messages: 0, removed: 0, thread: 'unchanged',
    });
    assert.equal(env.embedded.length, calls);
  });

  it('embeds an edited message again, and takes a deleted one away', async () => {
    const env = setup();
    await post(env, '1.1', 0, 'The cache purge fails with a 403 on the live site');
    await post(env, '1.2', 5, 'Purged it again with a fresh key, it works now', { person: 7, staff: 1 });
    await vectorizeThread(env, KEY);

    await env.CHANNELS.put(`${PATH}1.1.md`, render({
      source: 'slack', thread: KEY, id: '1.1', at: iso(0), editedAt: iso(8),
    }, 'The cache purge fails with a 401 on the preview site'), {});
    env.embedded.length = 0;
    assert.deepEqual(await vectorizeThread(env, KEY), {
      result: 'vectorized', messages: 1, removed: 0, thread: 'embedded',
    });
    assert.match(env.embedded[0], /401 on the preview/);

    await env.CHANNELS.put(`${PATH}1.2.md`, render({
      source: 'slack', thread: KEY, id: '1.2', at: iso(5), deletedAt: iso(9),
    }, ''), {});
    env.DB.sqlite.prepare("UPDATE messages SET deleted = 1 WHERE id = '1.2'").run();
    assert.deepEqual(await vectorizeThread(env, KEY), {
      result: 'vectorized', messages: 0, removed: 1, thread: 'embedded',
    });
    assert.equal(env.stored.has(await messageVectorId('slack:E1:C1:1.2')), false);
    assert.equal(byType(env, 'thread')[0].metadata.messages, 1);
    assert.deepEqual(env.DB.rows("SELECT embedded FROM messages WHERE id = '1.2'"), [{ embedded: null }]);

    await env.CHANNELS.put(`${PATH}1.1.md`, render({
      source: 'slack', thread: KEY, id: '1.1', at: iso(0), deletedAt: iso(10),
    }, ''), {});
    assert.equal((await vectorizeThread(env, KEY)).thread, 'removed');
    assert.equal(env.stored.size, 0);
  });

  it('leaves alert threads alone', async () => {
    const env = setup({ kind: 'alert' });
    await post(env, '1.1', 0, 'The cache purge fails with a 403 on the live site', { counted: 0 });
    assert.deepEqual(await vectorizeThread(env, KEY), { result: 'skip', reason: 'alert' });
    assert.equal(env.stored.size, 0);
  });

  it('cuts long texts into pieces the model reads whole, and keeps the start of a long thread', () => {
    const long = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' ');
    const pieces = chunks(long);
    assert.ok(pieces.length > 1);
    pieces.forEach((p) => assert.ok(p.length <= MAX_CHUNK));
    assert.equal(pieces.join(' '), long);

    const thread = threadChunks('Title', Array.from({ length: 60 }, (_, i) => `message ${i} ${'x'.repeat(400)}`));
    assert.equal(thread.length, MAX_CHUNKS);
    thread.forEach((p) => assert.ok(p.length <= MAX_CHUNK));
    assert.match(thread[0], /^Title\n\nmessage 0 /);
    assert.match(thread[thread.length - 1], /message 59 /);

    const m = mean([[1, 0], [0, 1]]);
    assert.ok(Math.abs(Math.hypot(...m) - 1) < 1e-9);
  });

  it('sweeps up the channel threads whose vectors are behind, once they are quiet', async () => {
    const env = setup();
    await post(env, '1.1', 0, 'The cache purge fails with a 403 on the live site');
    const now = new Date(T0 + 60 * 60000);
    assert.deepEqual(await sweepVectors(env, now), { queued: 1 });
    assert.deepEqual(env.queued, [{ vectorize: KEY }]);
    await vectorizeThread(env, KEY);
    assert.deepEqual(await sweepVectors(env, now), { queued: 0 });
    await post(env, '1.2', 58, 'Purged it again with a fresh key, it works now', { person: 7, staff: 1 });
    assert.deepEqual(await sweepVectors(env, now), { queued: 0 }); // still settling
    assert.deepEqual(await sweepVectors(env, new Date(T0 + 70 * 60000)), { queued: 1 });
    assert.deepEqual(await sweepVectors({ ...env, CONTENT: undefined }), { skipped: 'no CONTENT index' });
  });

  it('sweeps up threads re-filed as alerts that still have vectors', async () => {
    const env = setup();
    await post(env, '1.1', 0, 'The cache purge fails with a 403 on the live site');
    await vectorizeThread(env, KEY);
    const now = new Date(T0 + 60 * 60000);
    assert.deepEqual(await sweepVectors(env, now), { queued: 0 });
    env.DB.sqlite.prepare("UPDATE threads SET kind = 'alert'").run();
    assert.deepEqual(await sweepVectors(env, now), { queued: 1 });
    await vectorizeThread(env, KEY);
    assert.deepEqual(await sweepVectors(env, now), { queued: 0 });
  });
});
