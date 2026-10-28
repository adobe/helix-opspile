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
import { searchInbox } from '../src/api.js';
import { render } from '../src/channels.js';
import {
  channelTag, itemName, itemText, MAX_UPLOADS,
} from '../src/fulltext.js';
import { refile } from '../src/refile.js';
import { TEXT_BONUS } from '../src/search.js';
import { sweepVectors, vectorizeThread } from '../src/vectors.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up teams, channels, people and texts only.
const KEY = 'slack:E1:C1:1.1';
const PATH = 'channels/acme/helix/slack-C1/1.1/';
const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);
const iso = (minutes) => new Date(T0 + minutes * 60000).toISOString();
const me = {
  id: 1, name: 'Ada', teams: [{ slug: 'helix', name: 'Helix' }],
};

/**
 * An AI Search instance in memory: items by name (a re-upload replaces one, as built-in
 * storage does), and a search that answers with `answers[JSON.stringify(filters)]`.
 */
function fakeSearch() {
  const items = new Map();
  const asked = [];
  let next = 0;
  return {
    items: {
      store: items,
      async upload(name, text, { metadata } = {}) {
        const id = items.get(name)?.id || `item-${(next += 1)}`;
        items.set(name, { id, text, metadata });
        return { id, key: name };
      },
      async delete(id) {
        const name = [...items].find(([, v]) => v.id === id)?.[0];
        if (!name) {
          throw new Error('not found');
        }
        items.delete(name);
      },
    },
    asked,
    answers: {},
    async search(request) {
      asked.push(request);
      const { filters } = request.ai_search_options.retrieval;
      return { chunks: this.answers[JSON.stringify(filters)] || [] };
    },
  };
}

function setup() {
  const env = {
    DB: d1({ people: [{ ...me, staff: 1, teams: ['helix'] }], teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'edge', name: 'Edge' }] }),
    CHANNELS: fakeBucket(),
    SEARCH: fakeSearch(),
    queued: [],
  };
  env.NORMALIZE = {
    async send(body) {
      env.queued.push(body);
    },
    async sendBatch(jobs) {
      env.queued.push(...jobs.map((j) => j.body));
    },
  };
  env.DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
    kind, title, channel_name, path, root_at, last_at, any_at, updated_at)
    VALUES (?, 'slack', 'E1', 'C1', '1.1', 'acme', 'helix', 'channel', 'Cache purge fails',
      'aem-acme', ?, ?, ?, ?, ?)`)
    .run(KEY, PATH, iso(0), iso(0), iso(0), iso(0));
  return env;
}

async function post(env, id, minutes, body, { kind = 'person', deleted = false } = {}) {
  const at = iso(minutes);
  env.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, counted,
      deleted, author) VALUES ('slack', 'E1', 'C1', ?, ?, ?, ?, ?, 'Cy Customer')
    ON CONFLICT DO UPDATE SET deleted = excluded.deleted`)
    .run(id, KEY, at, kind === 'person' ? 1 : 0, deleted ? 1 : 0);
  env.DB.sqlite.prepare('UPDATE threads SET last_at = ?, any_at = ? WHERE thread = ?').run(at, at, KEY);
  await env.CHANNELS.put(`${PATH}${id}.md`, render({
    source: 'slack',
    thread: KEY,
    id,
    at,
    author: { kind, name: kind === 'bot' ? 'Ticket bot' : 'Cy Customer' },
    deletedAt: deleted ? at : undefined,
  }, deleted ? '' : body), { customMetadata: { version: '1', deleted: deleted ? '1' : '0' } });
}

const item = async (env, id) => env.SEARCH.items.store.get(await itemName(`slack:E1:C1:${id}`));

describe('full-text items', () => {
  it('has a message\'s text, not a system notice or a deleted message', () => {
    assert.equal(itemText({ body: ' ERR_CONNECTION_REFUSED ', author: { kind: 'person' } }), 'ERR_CONNECTION_REFUSED');
    assert.equal(itemText({ body: 'Ada has joined the channel', author: { kind: 'system' } }), '');
    assert.equal(itemText({ body: 'x', deletedAt: iso(0) }), '');
    assert.equal(itemText(null), '');
  });

  it('uploads every message of a channel thread once, bots too, and takes deleted ones away', async () => {
    const env = setup();
    await post(env, '1.1', 0, 'The purge fails with **ERR_CONNECTION_REFUSED** on www.acme.example');
    await post(env, '1.2', 1, 'Created OPS-1234', { kind: 'bot' });
    await post(env, '1.3', 2, 'Ada has joined the channel', { kind: 'system' });
    // Only the full-text index is bound: the vectors are not touched, the thread is indexed.
    let r = await vectorizeThread(env, KEY);
    assert.deepEqual(r, { result: 'indexed', fulltext: { uploaded: 2, removed: 0, complete: true } });
    assert.equal(env.SEARCH.items.store.size, 2);
    const root = await item(env, '1.1');
    assert.equal(root.text, 'The purge fails with **ERR_CONNECTION_REFUSED** on www.acme.example');
    assert.deepEqual(root.metadata, {
      team: 'helix', channel: await channelTag('slack:E1:C1'), message: `${KEY}|1.1`, at: iso(0),
    });
    assert.ok((await itemName('teams:x:y:19:z@thread.tacv2:123')).length <= 128);
    assert.deepEqual(env.DB.rows('SELECT indexed_through, vectorized_through FROM threads'), [
      { indexed_through: iso(2), vectorized_through: null },
    ]);
    // Nothing changed: nothing uploaded.
    r = await vectorizeThread(env, KEY);
    assert.deepEqual(r.fulltext, { uploaded: 0, removed: 0, complete: true });
    // An edit uploads that one again, in place; a deletion takes it away.
    await post(env, '1.1', 0, 'The purge fails with ERR_CONNECTION_RESET');
    await post(env, '1.2', 1, '', { kind: 'bot', deleted: true });
    r = await vectorizeThread(env, KEY);
    assert.deepEqual(r.fulltext, { uploaded: 1, removed: 1, complete: true });
    assert.deepEqual([...env.SEARCH.items.store.values()].map((v) => [v.id, v.text]), [
      [root.id, 'The purge fails with ERR_CONNECTION_RESET'],
    ]);
    assert.deepEqual(env.DB.rows("SELECT indexed, search_item FROM messages WHERE id = '1.2'"), [
      { indexed: null, search_item: null },
    ]);
  });

  it('uploads a long thread over several jobs, and the sweep comes back for the rest', async () => {
    const env = setup();
    for (let i = 0; i < MAX_UPLOADS + 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await post(env, `1.${i + 1}`, i / 100, `message number ${i}`);
    }
    const now = new Date(T0 + 60 * 60000);
    assert.deepEqual((await vectorizeThread(env, KEY)).fulltext, {
      uploaded: MAX_UPLOADS, removed: 0, complete: false,
    });
    assert.deepEqual(await sweepVectors(env, now), { queued: 1 });
    assert.deepEqual((await vectorizeThread(env, KEY)).fulltext, {
      uploaded: 3, removed: 0, complete: true,
    });
    env.queued.length = 0;
    assert.deepEqual(await sweepVectors(env, now), { queued: 0 });
    assert.deepEqual(await sweepVectors({ ...env, SEARCH: undefined }, now), { skipped: 'no CONTENT index' });
  });

  it('uploads the items of a re-filed thread again, under its new team', async () => {
    const env = setup();
    env.DB.sqlite.exec(`INSERT INTO rules (id, target, priority, field, pattern, value) VALUES
      (1, 'team', 100, 'name', '^aem-', 'edge'), (2, 'org', 100, 'name', '^aem-(.+)$', '$1')`);
    env.DB.sqlite.exec(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
      VALUES ('slack', 'E1', 'C1', 'aem-acme', '${iso(0)}')`);
    await post(env, '1.1', 0, 'The purge fails');
    await vectorizeThread(env, KEY);
    await refile(env, {
      source: 'slack', tenant: 'E1', channelId: 'C1', threads: [[KEY, PATH]],
    });
    assert.deepEqual(env.queued, [{ vectorize: KEY }]);
    const r = await vectorizeThread(env, KEY);
    assert.deepEqual(r.fulltext, { uploaded: 1, removed: 0, complete: true });
    assert.equal((await item(env, '1.1')).metadata.team, 'edge');
  });

  it('tries a failed deletion again, and takes a not-found one as done', async () => {
    const env = setup();
    await post(env, '1.1', 0, 'The token is s3cr3t-abc');
    await post(env, '1.2', 1, 'Please rotate it');
    await vectorizeThread(env, KEY);
    const leaked = await item(env, '1.1');
    await post(env, '1.1', 0, '', { deleted: true });
    const { delete: del } = env.SEARCH.items;
    env.SEARCH.items.delete = async () => {
      const e = new Error('AI Search: 503 Service Unavailable');
      e.status = 503;
      throw e;
    };
    // Failed: the row keeps the item's id, the thread is left for the sweep.
    const r = await quiet(() => vectorizeThread(env, KEY));
    assert.deepEqual(r.fulltext, {
      uploaded: 0, removed: 0, complete: false, error: 'AI Search: 503 Service Unavailable',
    });
    assert.deepEqual(env.DB.rows("SELECT search_item FROM messages WHERE id = '1.1'"), [
      { search_item: leaked.id },
    ]);
    assert.deepEqual(env.DB.rows('SELECT indexed_through FROM threads'), [{ indexed_through: null }]);
    assert.deepEqual(await sweepVectors(env, new Date(T0 + 60 * 60000)), { queued: 1 });
    // Tried again, it works.
    env.SEARCH.items.delete = del;
    assert.deepEqual((await vectorizeThread(env, KEY)).fulltext, {
      uploaded: 0, removed: 1, complete: true,
    });
    assert.equal(await item(env, '1.1'), undefined);
    assert.deepEqual(env.DB.rows("SELECT indexed, search_item FROM messages WHERE id = '1.1'"), [
      { indexed: null, search_item: null },
    ]);
    // An item that is gone already is what a deletion is for.
    await post(env, '1.2', 1, '', { deleted: true });
    env.SEARCH.items.delete = async () => {
      const e = new Error('not found');
      e.name = 'AiSearchNotFoundError';
      throw e;
    };
    assert.deepEqual((await vectorizeThread(env, KEY)).fulltext, {
      uploaded: 0, removed: 1, complete: true,
    });
  });

  it('makes the vectors when the full-text index fails', async () => {
    const env = setup();
    const stored = new Map();
    env.AI = { run: async (model, { text }) => ({ data: text.map(() => [1, 0]) }) };
    env.CONTENT = {
      async upsert(items) {
        items.forEach((i) => stored.set(i.id, i));
      },
      async deleteByIds(ids) {
        ids.forEach((id) => stored.delete(id));
      },
    };
    env.SEARCH.items.upload = async () => {
      throw new Error('item limit reached');
    };
    await post(env, '1.1', 0, 'The cache purge fails with a 403 on the live site');
    const r = await quiet(() => vectorizeThread(env, KEY));
    assert.equal(r.result, 'vectorized');
    assert.equal(r.fulltext.error, 'item limit reached');
    assert.equal(stored.size, 2);
    assert.deepEqual(env.DB.rows('SELECT vectorized_through, indexed_through FROM threads'), [
      { vectorized_through: iso(0), indexed_through: null },
    ]);
  });

  it('takes the items of a thread re-filed as an alert away', async () => {
    const env = setup();
    await post(env, '1.1', 0, 'The purge fails');
    await vectorizeThread(env, KEY);
    env.DB.sqlite.exec("UPDATE threads SET kind = 'alert'");
    const r = await vectorizeThread(env, KEY);
    assert.deepEqual(r, {
      result: 'skip', reason: 'alert', fulltext: { uploaded: 0, removed: 1, complete: true },
    });
    assert.equal(env.SEARCH.items.store.size, 0);
  });
});

describe('full-text search', () => {
  it('never finds or shows a deleted message, whose item is still there', async () => {
    const env = setup();
    await post(env, '1.1', 0, 'The token is s3cr3t-abc');
    await vectorizeThread(env, KEY);
    // Deleted, and the job has not run yet: the item still answers.
    await post(env, '1.1', 0, '', { deleted: true });
    env.SEARCH.answers[JSON.stringify({ team: 'helix' })] = [{
      id: 'c', score: 1, text: 'The token is s3cr3t-abc', item: { key: 'x.md', metadata: { message: `${KEY}|1.1` } },
    }];
    const r = await searchInbox(env, me, 'helix', 's3cr3t-abc');
    assert.deepEqual(r.hits, []);
    assert.doesNotMatch(JSON.stringify({ ...r, q: null, words: null }), /s3cr3t/);
  });

  it('finds the messages with every word, in the team and its shared channels, recent first', async () => {
    const env = setup();
    await post(env, '1.1', 0, 'Since the deploy, the purge fails with ERR_CONNECTION_REFUSED on every request.');
    // A channel of another team, shared with helix.
    env.DB.sqlite.exec(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, title, path, root_at, last_at, any_at, messages, updated_at) VALUES
      ('slack:E1:C3:5.1', 'slack', 'E1', 'C3', '5.1', 'initech', 'edge', 'channel', 'Deploy',
        'channels/initech/edge/slack-C3/5.1/', '${iso(1)}', '${iso(1)}', '${iso(1)}', 1, '${iso(1)}')`);
    env.DB.sqlite.exec(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, counted,
        author, author_key) VALUES ('slack', 'E1', 'C3', '5.1', 'slack:E1:C3:5.1', '${iso(1)}', 1,
        'Cy', 'slack:E1:U1')`);
    env.DB.sqlite.exec(`INSERT INTO channel_teams (source, channel_id, team, added_at)
      VALUES ('slack', 'C3', 'helix', '${iso(0)}')`);
    const chunk = (message, score, text) => ({
      id: message, score, text, item: { key: 'x.md', metadata: { message } },
    });
    env.SEARCH.answers[JSON.stringify({ team: 'helix' })] = [chunk(`${KEY}|1.1`, 0.9, 'Since the deploy…')];
    env.SEARCH.answers[JSON.stringify({ channel: { $in: [await channelTag('slack:E1:C3')] } })] = [
      chunk('slack:E1:C3:5.1|5.1', 0.45, 'curl says ERR_CONNECTION_REFUSED too'),
    ];
    const r = await searchInbox(env, me, 'helix', 'err_connection_refused');
    // BM25 on the words, all of them, the recent boosted.
    assert.equal(env.SEARCH.asked.length, 2);
    assert.deepEqual(env.SEARCH.asked[0], {
      query: 'err_connection_refused',
      ai_search_options: {
        retrieval: {
          retrieval_type: 'keyword',
          keyword_match_mode: 'and',
          match_threshold: 0,
          max_num_results: 50,
          filters: { team: 'helix' },
          boost_by: [{ field: 'at', direction: 'desc' }],
        },
      },
    });
    assert.deepEqual(r.hits.map((h) => [h.thread, h.matched, h.score]), [
      [KEY, ['text'], TEXT_BONUS],
      ['slack:E1:C3:5.1', ['text'], TEXT_BONUS / 2],
    ]);
    // The snippet is the message from pile 2, around the words; without its file, the item's text.
    assert.deepEqual(r.hits[0].snippet, {
      message: `${KEY}|1.1`,
      author: 'Cy Customer',
      at: iso(0),
      text: 'Since the deploy, the purge fails with ERR_CONNECTION_REFUSED on every request.',
    });
    assert.deepEqual(r.hits[1].snippet, {
      message: 'slack:E1:C3:5.1|5.1', author: null, at: null, text: 'curl says ERR_CONNECTION_REFUSED too',
    });
  });

  it('asks for all of the viewer\'s teams in the personal view, and survives a failing index', async () => {
    const env = setup();
    const two = { ...me, teams: [{ slug: 'helix' }, { slug: 'edge' }] };
    await searchInbox(env, two, null, 'purge', { personal: true });
    assert.deepEqual(env.SEARCH.asked[0].ai_search_options.retrieval.filters, { team: { $in: ['helix', 'edge'] } });
    env.SEARCH.search = async () => {
      throw new Error('down');
    };
    // The title still matches.
    const r = await quiet(() => searchInbox(env, me, 'helix', 'purge'));
    assert.deepEqual(r.hits.map((h) => [h.thread, h.matched]), [[KEY, ['title']]]);
  });
});
