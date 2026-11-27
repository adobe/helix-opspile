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
import { api } from '../src/api.js';
import { buildTopicMap } from '../src/topicmap.js';
import {
  assignPending, assignTopic, factTerms, mapVectors, matchTerm, mondayOf, packVectors,
  semanticFloor, sweepTrends, trendsData, trendThreads, unpackVectors, weeksTo,
} from '../src/trends.js';
import { threadVectorId } from '../src/vectors.js';
import { d1 } from './d1.js';

// Made-up customers, teams, people and threads only.
const NOW = new Date('2026-11-25T12:00:00Z');
const DIM = 768;

/** A unit vector near direction `axis`, a little off it by `jitter`. */
function near(axis, jitter = 0, salt = 0) {
  const v = new Array(DIM).fill(0.01);
  v[axis] = 1;
  v[(axis + 7 + salt) % DIM] += jitter;
  const s = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / s);
}

/**
 * A DB with `threads`: `{ key, org, team, root, kind, topic (its vector's axis), title, msgs:
 * [[at, preview]], group }`, and a CONTENT index with their vectors.
 */
async function world(threads, { orgs = [] } = {}) {
  const DB = d1({ teams: [{ slug: 'edge', name: 'Edge' }, { slug: 'admin', name: 'Admin' }] });
  const q = (sql, ...args) => DB.sqlite.prepare(sql).run(...args);
  for (const o of orgs) {
    q('INSERT INTO orgs (slug, name, type, updated_at) VALUES (?, ?, ?, ?)', o.slug, o.name, o.type, 'x');
  }
  const vectors = new Map();
  for (const t of threads) {
    const [, tenant, channel] = t.key.split(':');
    q(
      `INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind, title,
        path, root_at, messages, updated_at, embedded, logical_thread)
      VALUES (?, 'slack', ?, ?, ?, ?, ?, 'channel', ?, 'p', ?, ?, 'x', ?, ?)`,
      t.key,
      tenant,
      channel,
      t.key.split(':').pop(),
      t.org,
      t.team || 'edge',
      t.title || '',
      t.root,
      t.msgs.length,
      t.topic === undefined ? null : `h${t.topic}`,
      t.group || null,
    );
    q(
      `INSERT INTO labels (thread, kind, topics, about, labeled_through, model, labeled_at, title)
      VALUES (?, ?, ?, ?, 'x', 'm', 'x', ?)`,
      t.key,
      t.kind || 'question',
      JSON.stringify(t.areas || {}),
      JSON.stringify(t.tech || {}),
      t.title || '',
    );
    t.msgs.forEach(([at, preview], i) => q(
      `INSERT INTO messages (source, tenant, channel_id, id, thread,
        at, counted, deleted, preview) VALUES ('slack', ?, ?, ?, ?, ?, 1, 0, ?)`,
      tenant,
      channel,
      `${t.key}-${i}`,
      t.key,
      at,
      preview || '',
    ));
    if (t.topic !== undefined) {
      // eslint-disable-next-line no-await-in-loop
      vectors.set(await threadVectorId(t.key), {
        key: t.key, values: near(t.topic, 0.2, t.salt || 0),
      });
    }
  }
  const queries = [];
  const CONTENT = {
    async getByIds(ids) {
      return ids.filter((id) => vectors.has(id))
        .map((id) => ({ id, values: vectors.get(id).values }));
    },
    async query(vector, opts) {
      queries.push(opts);
      const matches = [...vectors].map(([id, v]) => ({
        id, score: v.values.reduce((a, x, i) => a + x * vector[i], 0),
      })).sort((a, b) => b.score - a.score).slice(0, opts.topK);
      return { matches };
    },
  };
  const AI = {
    async run(model, input) {
      if (input.text) {
        return { data: input.text.map(() => near(1)) };
      }
      // The namer: every topic its name.
      const n = (input.messages[1].content.match(/^Topic \d+/gm) || []).length;
      return { response: JSON.stringify(Array.from({ length: n }, (_, id) => ({ id, name: `Named topic ${id}`, theme: 'A theme.' }))) };
    },
  };
  return {
    env: { DB, CONTENT, AI }, queries,
  };
}

const day = (d) => new Date(NOW.getTime() - d * 864e5).toISOString();

describe('trends: weeks and vectors (src/trends.js)', () => {
  it('counts weeks from Mondays', () => {
    assert.equal(mondayOf('2026-11-25T23:00:00Z'), '2026-11-23');
    assert.equal(mondayOf('2026-11-23T00:00:00Z'), '2026-11-23');
    assert.equal(mondayOf('2026-11-22T10:00:00Z'), '2026-11-16');
    const w = weeksTo(NOW);
    assert.equal(w.length, 52);
    assert.equal(w.at(-1), '2026-11-23');
    assert.equal(w.at(-2), '2026-11-16');
  });

  it('keeps vectors as float32s, and assigns a thread to the nearest centre', () => {
    const a = near(3);
    const b = near(9);
    const [x, y] = unpackVectors(packVectors([a, b]));
    assert.ok(Math.abs(x[3] - a[3]) < 1e-6 && Math.abs(y[9] - b[9]) < 1e-6);
    const mean = new Float32Array(DIM);
    const space = mapVectors(packVectors([mean, a, b, near(5)]), 2);
    assert.equal(space.centroids.length, 2);
    assert.equal(space.sample.length, 1);
    assert.equal(assignTopic(near(9, 0.1), space).topic, 1);
    // Near none: in no topic.
    assert.equal(assignTopic(near(200), space).topic, null);
  });

  it('sets the floor of a phrase by how alike it is to threads by chance', () => {
    const sample = Array.from({ length: 50 }, (_, i) => near(10 + i));
    const floor = semanticFloor(Float32Array.from(near(10)), sample, 3);
    assert.ok(floor > 0.05 && floor < 1, floor);
  });
});

describe('trends: the topics, the threads and the matches (src/trends.js)', () => {
  const ORGS = [
    { slug: 'acme', name: 'Acme', type: 'customer' }, { slug: 'beta', name: 'Beta', type: 'partner' },
    { slug: 'us', name: 'Us', type: 'internal' },
  ];
  // Three kinds of threads, every week for ten weeks: about axis 1, 2 and 3.
  const threads = [];
  for (let w = 0; w < 10; w += 1) {
    for (const topic of [1, 2, 3]) {
      for (const c of [0, 1, 2]) {
        threads.push({
          key: `slack:E1:C${c}:${w}.${topic}`,
          org: c === 2 ? 'beta' : 'acme',
          root: day(7 * w + 1),
          topic,
          salt: w,
          title: topic === 1 ? 'CDN purge is slow' : `Thread ${w} ${topic}`,
          areas: topic === 1 ? { cdn: 0.9 } : {},
          tech: topic === 2 ? { 'acme/editor': 0.8 } : {},
          // Three messages, so the topic map has it; the third week's one, so it does not.
          msgs: Array.from({ length: w === 3 ? 1 : 3 }, () => [day(7 * w + 1), topic === 3 ? 'the cdns are fine' : 'hello']),
        });
      }
    }
  }
  // Not counted: an internal org's, a meeting, a group's later member (its messages are its
  // first's), and one without a label kind.
  threads.push({
    key: 'slack:E1:C9:1.1', org: 'us', root: day(3), topic: 1, msgs: [[day(3), 'internal']],
  }, {
    key: 'slack:E1:C0:2.9', org: 'acme', root: day(3), kind: 'meeting', topic: 1, msgs: [[day(3), 'meet']],
  }, {
    key: 'slack:E1:C0:3.9', org: 'acme', root: day(2), group: 'slack:E1:C0:0.1', msgs: [[day(2), 'more on the CDN purge']],
  });

  it('gives the threads the topic map does not have the topic of the nearest centre', async () => {
    const { env } = await world(threads, { orgs: ORGS });
    // Before a map with its space, nothing.
    assert.equal((await assignPending(env, { now: NOW })).assigned, 0);
    const built = await buildTopicMap(env, { now: NOW, by: 'Ada' });
    assert.ok(built.id, JSON.stringify(built));
    // The map's threads (three messages and more) have their own topic; the others none yet.
    const own = env.DB.rows('SELECT thread, topic FROM trend_threads');
    assert.equal(own.length, built.threads);
    assert.ok(own.every((r) => !r.thread.includes(':3.')));
    const first = await assignPending(env, { now: NOW });
    assert.ok(first.assigned >= 9, JSON.stringify(first));
    // Each of them in the topic of its kind's threads.
    const rows = env.DB.rows('SELECT thread, topic FROM trend_threads');
    const byAxis = new Map();
    for (const r of rows.filter((x) => x.topic !== null)) {
      const axis = r.thread.split('.').pop();
      byAxis.set(axis, new Set([...(byAxis.get(axis) || []), r.topic]));
    }
    const all = [...byAxis.values()].flatMap((x) => [...x]);
    assert.equal(new Set(all).size, all.length);
    // A thread whose vector changed is assigned again; nothing is left after.
    env.DB.sqlite.exec('UPDATE threads SET embedded = \'new\' WHERE thread = \'slack:E1:C0:0.1\'');
    assert.deepEqual(await assignPending(env, { now: NOW }), { assigned: 1, left: 0 });
    assert.deepEqual(await assignPending(env, { now: NOW }), { assigned: 0, left: 0 });
    assert.ok((await sweepTrends(env, NOW)).assigned);
    // A newer map: all of them again.
    await buildTopicMap(env, { now: NOW });
    assert.ok((await assignPending(env, { now: NOW })).assigned >= 9);
    assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM topic_maps WHERE vectors IS NOT NULL')[0].n, 1);
  });

  it('sends every counted thread, small, with its messages by week', async () => {
    const { env } = await world(threads, { orgs: ORGS });
    const built = await buildTopicMap(env, { now: NOW });
    await assignPending(env, { now: NOW });
    const d = await trendsData(env, { now: NOW });
    assert.equal(d.weeks.length, 52);
    assert.equal(d.threads.length, 90);
    assert.equal(d.channels, 3);
    assert.deepEqual(d.orgs.map((o) => o.slug).sort(), ['acme', 'beta']);
    assert.equal(d.map.id, built.id);
    assert.ok(d.map.assigned >= 90);
    assert.ok(d.threads.every((r) => r[7] >= 0));
    assert.deepEqual(d.tech, [{ id: 'acme/editor', name: 'acme/editor', product: null }]);
    // The group's first has its member's message too, in the member's week.
    const first = env.DB.rows('SELECT rowid AS id FROM threads WHERE thread = \'slack:E1:C0:0.1\'')[0].id;
    const row = d.threads.find((r) => r[0] === first);
    assert.deepEqual(row[10], [51, 4]);
    assert.deepEqual(row[8].map((i) => d.areas[i].id), ['cdn']);
    // And some of them, to list.
    const [listed] = await trendThreads(env, [first, 'x']);
    assert.equal(listed.title, 'CDN purge is slow');
  });

  it('finds whole words, and what a phrase is about, month by month', async () => {
    const { env, queries } = await world(threads, { orgs: ORGS });
    await buildTopicMap(env, { now: NOW });
    await assignPending(env, { now: NOW });
    const ids = (keys) => env.DB.rows(`SELECT rowid AS id FROM threads WHERE thread IN (${keys.map(() => '?').join(',')})`, ...keys)
      .map((r) => r.id).sort((a, b) => a - b);
    const purge = await matchTerm(env, 'purge', { now: NOW });
    assert.equal(purge.semantic, false);
    assert.deepEqual(purge.ids.sort((a, b) => a - b), ids(threads.filter((t) => t.topic === 1 && t.org !== 'us' && !t.kind).map((t) => t.key)));
    // Not in "cdns".
    assert.equal((await matchTerm(env, 'cdn', { now: NOW })).ids.length, 30);
    assert.equal((await matchTerm(env, '%%', { now: NOW })).error.length > 0, true);
    // By chance, threads are far less alike than these three kinds: a sample of many others.
    const [map] = env.DB.rows('SELECT id, k, vectors FROM topic_maps WHERE vectors IS NOT NULL');
    const space = mapVectors(map.vectors, map.k);
    const others = Array.from({ length: 60 }, (_, i) => near(100 + i));
    env.DB.sqlite.prepare('UPDATE topic_maps SET vectors = ? WHERE id = ?')
      .run(packVectors([space.mean, ...space.centroids, ...others]), map.id);
    const about = await matchTerm(env, '~purging the cache', { now: NOW });
    assert.equal(about.semantic, true);
    assert.ok(about.ids.length >= 30, about.ids.length);
    assert.ok(queries.length >= 12 && queries.every((q) => q.filter.type === 'thread' && q.filter.at.$gte));
  });

  it('counts docs and links as facts, and matches a doc path or a URL', async () => {
    const { env } = await world(threads, { orgs: ORGS });
    const fact = (thread, field, value, source = 'rule') => env.DB.sqlite.prepare(`INSERT INTO facts
      (thread, source, field, value) VALUES (?, ?, ?, ?)`).run(thread, source, field, value);
    for (let w = 0; w < 5; w += 1) {
      // The limits doc, in Acme's and Beta's threads, as the doc rule and as a link.
      fact(`slack:E1:C0:${w}.1`, 'doc', 'docs/limits');
      fact(`slack:E1:C2:${w}.1`, 'url', 'https://www.aem.live/docs/limits#rate-limits');
      // Acme's own shop, in Acme's threads only: no topic of anyone's.
      fact(`slack:E1:C1:${w}.2`, 'url', 'https://shop.acme.example/cart');
    }
    // A doc two in three of the threads with a doc have weighs too little to count; a status
    // every thread has weighs nothing; a problem in someone's words is no fact here.
    for (let w = 0; w < 10; w += 1) {
      fact(`slack:E1:C0:${w}.2`, 'doc', 'developer/byo-git');
      fact(`slack:E1:C2:${w}.2`, 'doc', 'developer/byo-git');
    }
    for (const t of threads) {
      fact(t.key, 'http_status', '404');
    }
    fact('slack:E1:C0:5.1', 'problem', 'Pages are slow', 'clairic');
    // A pull request in a group's later member (its first's) and in a Beta thread.
    fact('slack:E1:C0:3.9', 'url', 'https://github.com/fake-org/edge/pull/5/files');
    fact('slack:E1:C2:6.3', 'url', 'https://github.com/fake-org/edge/pull/5');
    const d = await trendsData(env, { now: NOW });
    assert.deepEqual(d.facts.map((f) => f.key).sort(), ['doc:docs/limits', 'url:github.com/fake-org/edge/pull/5']);
    const limits = d.facts.find((f) => f.key === 'doc:docs/limits');
    assert.equal(limits.href, 'https://www.aem.live/docs/limits');
    assert.equal(limits.threads, 10);
    assert.equal(limits.orgs, 2);
    const id = (key) => env.DB.rows('SELECT rowid AS id FROM threads WHERE thread = ?', key)[0].id;
    const factsOf = (key) => d.threads.find((r) => r[0] === id(key))[11].map((i) => d.facts[i].key);
    assert.deepEqual(factsOf('slack:E1:C2:0.1'), ['doc:docs/limits']);
    assert.deepEqual(factsOf('slack:E1:C0:0.1'), ['doc:docs/limits', 'url:github.com/fake-org/edge/pull/5']);
    assert.deepEqual(factsOf('slack:E1:C1:0.2'), []);
    // A term that is a doc path or a URL is matched as a fact, whichever form it is written in.
    const limitIds = (await matchTerm(env, 'docs/limits', { now: NOW })).ids.sort();
    assert.equal(limitIds.length, 10);
    assert.deepEqual((await matchTerm(env, 'https://aem.live/docs/limits/', { now: NOW })).ids.sort(), limitIds);
    const pr = await matchTerm(env, 'github.com/fake-org/edge/pull/5', { now: NOW });
    assert.deepEqual(pr.fact, ['url:github.com/fake-org/edge/pull/5']);
    assert.deepEqual(pr.ids.sort(), [id('slack:E1:C0:0.1'), id('slack:E1:C2:6.3')].sort());
    assert.equal((await matchTerm(env, 'http_status:404', { now: NOW })).ids.length, 90);
    // A word with a dot that no thread has as a fact is looked for as a word.
    assert.equal((await matchTerm(env, 'node.js', { now: NOW })).fact, undefined);
    assert.deepEqual(factTerms('purge'), []);
    assert.deepEqual(factTerms('404'), []);
    assert.deepEqual(factTerms('cdn.yaml').sort(), ['config_file:cdn.yaml', 'url:cdn.yaml']);
  });

  it('is for every internal user', async () => {
    const { env } = await world([...threads.slice(0, 30), threads.find((t) => t.org === 'us')], { orgs: ORGS });
    const call = async (me, method, path) => {
      const url = new URL(`https://opspile.example${path}`);
      const res = await api(new Request(url, { method }), env, url, { viewer: me });
      return { status: res.status, body: await res.json() };
    };
    const member = {
      id: 3, email: 'mo@staff.example', name: 'Mo', teams: [{ slug: 'edge', role: 'member' }],
    };
    // Not someone on no team who is not Adobe's; staff on none, yes.
    assert.equal((await call({ ...member, email: 'x@partner.example', teams: [] }, 'GET', '/api/topics/trends')).status, 403);
    assert.equal((await call({ ...member, staff: true, teams: [] }, 'GET', '/api/topics/trends')).status, 200);
    const r = await call(member, 'GET', '/api/topics/trends');
    assert.equal(r.status, 200);
    assert.equal(r.body.map, null);
    assert.equal(r.body.threads.length, 30);
    // Kept a few minutes, though every request wraps the database anew (src/d1batch.js).
    let asked = 0;
    const raw = env.DB;
    env.DB = new Proxy(raw, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql) => {
            asked += 1;
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await call(member, 'GET', '/api/topics/trends');
    const once = asked;
    assert.ok(once > 0);
    assert.equal((await call(member, 'GET', '/api/topics/trends')).body.threads.length, 30);
    assert.equal(asked, once);
    env.DB = raw;
    // Only the threads it counts are listed, whatever ids are asked for: not an internal org's.
    const ids = env.DB.rows('SELECT rowid AS id, org FROM threads');
    const listed = (await call(member, 'GET', `/api/topics/trends/threads?ids=${ids.map((x) => x.id).join(',')}`)).body.threads;
    assert.ok(listed.length > 0 && listed.every((x) => x.org !== 'us'));
    assert.equal((await call(member, 'POST', '/api/topics/trends')).status, 405);
    assert.equal((await call(member, 'GET', '/api/topics/trends/match?term=~')).status, 503);
  });
});
