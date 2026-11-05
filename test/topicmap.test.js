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
import {
  buildTopicMap, centered, coveredBy, KEEP, kmeans, latestTopicMap, MIN_THREADS, productKey,
  productsOf, sweepTopicMap, techIndex, topicCount,
} from '../src/topicmap.js';
import { threadVectorId } from '../src/vectors.js';
import { d1 } from './d1.js';

// Made-up people, customers, channels and titles only.
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin', 'helix'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['helix'],
};
const CY = {
  id: 3, email: 'cy@acme.example', name: 'Cy', staff: 0, teams: [],
};
const asMe = (p) => ({ ...p, teams: p.teams.map((slug) => ({ slug })) });
const NOW = new Date('2026-11-04T12:00:00Z');

// Three things the threads are about, each a direction of its own, and a little of the others.
const GROUPS = [
  { words: 'cache purge stale', org: 'acme', staff: 1 },
  { words: 'sidekick login sso', org: 'globex', staff: 2 },
  { words: 'checkout cart order', org: 'acme', staff: 1 },
];
const near = (g, i) => Array.from({ length: 12 }, (_, d) => (d % 3 === g ? 1 : 0)
  + ((i * 7 + d * 3) % 5) / 25);

/** D1 with ten threads of each group, and the ones a map leaves out; CONTENT; Workers AI. */
async function setup({ perGroup = 10 } = {}) {
  const DB = d1({
    people: [ADA, BO, CY],
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix ops' }],
  });
  DB.sqlite.exec(`INSERT INTO orgs (slug, name, type, updated_at) VALUES
    ('acme', 'ACME', 'customer', '2026-10-01T00:00:00Z'), ('globex', 'Globex', 'partner', '2026-10-01T00:00:00Z')`);
  const vectors = new Map();
  const thread = async (key, {
    org = 'acme', kind = 'channel', messages = 4, embedded = 'h', label = null, topics = null, title = 'A thread',
    vector = null,
  } = {}) => {
    DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind,
        title, path, root_at, last_at, any_at, messages, embedded, updated_at)
      VALUES (?, 'slack', 'E1', 'C1', ?, ?, 'helix', ?, ?, 'p/', '2026-10-20T00:00:00Z',
        '2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z', ?, ?, '2026-10-21T00:00:00Z')`)
      .run(key, key, org, kind, title, messages, embedded);
    if (label || topics) {
      DB.sqlite.prepare(`INSERT INTO labels (thread, kind, labeled_through, model, labeled_at, topics)
        VALUES (?, ?, '2026-10-21T00:00:00Z', 'clef', '2026-10-21T00:00:00Z', ?)`).run(key, label, topics);
    }
    if (vector) {
      vectors.set(await threadVectorId(key), vector);
    }
  };
  const post = (key, id, person, staff) => DB.sqlite.prepare(`INSERT INTO messages (source, tenant,
      channel_id, id, thread, at, person, staff, counted) VALUES ('slack', 'E1', 'C1', ?, ?,
      '2026-10-20T00:00:00Z', ?, ?, 1)`).run(`${key}-${id}`, key, person, staff);
  for (const [g, group] of GROUPS.entries()) {
    for (let i = 0; i < perGroup; i += 1) {
      const key = `slack:E1:C1:${g}.${i}`;
      // eslint-disable-next-line no-await-in-loop
      await thread(key, {
        org: group.org,
        title: `${group.words} ${i}`,
        vector: near(g, i),
        topics: g === 0 && i % 2 ? '{"cdn":0.93}' : null,
        label: 'question',
      });
      if (g === 0) {
        // The cache threads name a CDN the tech stack has, one it does not, and generic words.
        DB.sqlite.prepare(`INSERT INTO facts (thread, source, field, value, confidence)
          VALUES (?, 'clairic', 'product', ?, 0.9)`).run(key, i % 2 ? 'Akamai' : 'Jira');
        DB.sqlite.prepare(`INSERT INTO facts (thread, source, field, value, confidence)
          VALUES (?, 'clairic', 'product', 'CDN', 0.9)`).run(key);
      }
      post(key, 'a', group.staff, 1);
      post(key, 'b', group.staff, 1);
      post(key, 'c', CY.id, 0);
    }
  }
  // Left out: too short, a meeting, an alert, not vectorized, and one CONTENT does not have.
  await thread('slack:E1:C1:short', { messages: 2, vector: near(0, 1) });
  await thread('slack:E1:C1:meet', { label: 'meeting', vector: near(1, 1) });
  await thread('slack:E1:C1:alert', { kind: 'alert', vector: near(2, 1) });
  await thread('slack:E1:C1:novec', { embedded: null });
  await thread('slack:E1:C1:gone', {});
  const calls = { get: 0, ai: [] };
  return {
    DB,
    calls,
    CONTENT: {
      async getByIds(ids) {
        calls.get += 1;
        assert.ok(ids.length <= 20);
        return ids.filter((id) => vectors.has(id)).map((id) => ({ id, values: vectors.get(id) }));
      },
    },
    AI: {
      async run(model, { messages }) {
        assert.match(model, /llama/);
        const user = messages[1].content;
        calls.ai.push(user);
        if (user.includes('sidekick')) {
          return { response: '1. "Sidekick sign-in"\nAuthors cannot sign in after an SSO change.' };
        }
        // The same name twice, and one with nothing to say: the map tells them apart.
        return { response: user.includes('cache') || user.includes('checkout') ? 'Storefront\nThe site.' : '' };
      },
    },
  };
}

describe('topic map: clustering', () => {
  it('finds groups by cosine, the same ones from the same seed, and centres the vectors first', () => {
    const X = centered(GROUPS.flatMap((_, g) => Array.from({ length: 8 }, (__, i) => near(g, i))));
    X.forEach((v) => assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6));
    const a = kmeans(X, 3, { seed: 7 });
    const b = kmeans(X, 3, { seed: 7 });
    assert.deepEqual(a.labels, b.labels);
    for (let g = 0; g < 3; g += 1) {
      assert.equal(new Set(a.labels.slice(g * 8, g * 8 + 8)).size, 1, `group ${g} is one cluster`);
    }
    assert.equal(new Set(a.labels).size, 3);
    assert.ok(a.sims.every((s) => s > 0.5));
  });

  it('makes about one topic per twelve threads, at most thirty', () => {
    assert.equal(topicCount(10), 2);
    assert.equal(topicCount(30), 3);
    assert.equal(topicCount(377), 30);
    assert.equal(topicCount(2000), 30);
  });
});

describe('topic map: products and the tech stack', () => {
  const TECH = [
    { tech: 'akamai', name: 'Akamai', description: 'Akamai as CDN' },
    {
      tech: 'consent', name: 'Consent manager', description: 'a consent manager such as OneTrust or Cookiebot', product: 'Consent',
    },
    { tech: 'analytics', name: 'Analytics', description: 'Adobe Analytics, Web SDK or Experience Platform data collection' },
    { tech: 'aso', name: 'Sites Optimizer', description: 'AEM Sites Optimizer' },
  ];
  const index = techIndex(TECH);

  it('finds the entry that names a product: its name, a name in its description, or a part', () => {
    assert.equal(productKey('AEM Sites Optimizer'), 'sites optimizer');
    assert.equal(productKey('Adobe  Web-SDK'), 'web sdk');
    assert.equal(coveredBy('Akamai', index), 'akamai');
    assert.equal(coveredBy('akamai property manager', index), 'akamai');
    assert.equal(coveredBy('OneTrust', index), 'consent');
    assert.equal(coveredBy('Web SDK', index), 'analytics');
    assert.equal(coveredBy('AEM Sites Optimizer', index), 'aso');
    assert.equal(coveredBy('Google Tag Manager', index), null);
    assert.equal(coveredBy('', index), null);
  });

  it('names a covered product as its entry, a gap as most threads write it, and drops generic words', () => {
    const { of, products } = productsOf([
      { thread: 'a', value: 'OneTrust' }, { thread: 'a', value: 'Cookiebot' },
      { thread: 'a', value: 'Tealium' }, { thread: 'b', value: 'tealium' }, { thread: 'c', value: 'Tealium' },
      { thread: 'b', value: 'API' }, { thread: 'b', value: 'Slack' },
    ], TECH);
    assert.deepEqual(products, {
      'tech:consent': { name: 'Consent manager', tech: 'consent', product: 'Consent' },
      'new:tealium': { name: 'Tealium', tech: null, product: null },
    });
    assert.deepEqual(of.get('a'), ['tech:consent', 'new:tealium']);
    assert.deepEqual(of.get('b'), ['new:tealium']);
  });
});

describe('the tech stack after the product census (migration 0056)', () => {
  it('names what the threads were about, and keeps descriptions someone changed', async () => {
    const DB = d1();
    const rows = DB.sqlite.prepare("SELECT tech, name, description, product, changed_by FROM tech_stack WHERE team = 'admin'").all();
    const index = techIndex(rows);
    for (const [name, tech] of [['Admin Console', 'adobeims'], ['Edge Functions', 'edgefunctions'],
      ['Google Tag Manager', 'tagmanager'], ['Tealium', 'tagmanager'], ['Adobe Analytics', 'analytics'],
      ['Customer Journey Analytics', 'analytics'], ['Preflight', 'aso'], ['Bazaarvoice', 'reviews'],
      ['Content Fragments', 'aemcontent'], ['Workfront', 'workfront'], ['Dynamic Media', 'dm'],
      ['Claude', 'aiagents'], ['OpTel', 'rum'], ['CX Coworker', 'coworker'],
      ['Brand Concierge', 'brandconcierge'], ['Journey Optimizer', 'ajo'], ['Salesforce', 'crm']]) {
      assert.equal(coveredBy(name, index), tech, name);
    }
    assert.equal(rows.length, 58);
    // Every entry is part of a product: an Adobe product by the name on its list, or a category.
    assert.deepEqual(rows.filter((r) => !r.product).map((r) => r.tech), []);
    const of = Object.fromEntries(rows.map((r) => [r.tech, r.product]));
    assert.deepEqual(
      ['eds', 'da', 'ue', 'xw', 'aemcs', 'msm', 'edgefunctions'].map((t) => of[t]),
      Array(7).fill('Experience Manager Sites'),
    );
    assert.deepEqual(
      [of.dm, of.assets, of.coworker, of.brandconcierge, of.llmo, of.akamai],
      ['Experience Manager Assets', 'Experience Manager Assets', 'CX Enterprise Coworker',
        'Brand Concierge', 'Brand Visibility', 'CDN'],
    );
    assert.equal(rows.find((r) => r.tech === 'llmo').name, 'Brand Visibility');
    // Run on a tech stack as migration 0043 left it, but for one description changed on the
    // Agents page: that one stays, the others change.
    const before = d1();
    before.sqlite.exec(`UPDATE tech_stack SET description = 'our own words' WHERE tech = 'rum';
      UPDATE tech_stack SET description = 'Adobe Analytics, Web SDK or Experience Platform data collection',
        name = 'Analytics' WHERE tech = 'analytics';`);
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../migrations/0056_tech_census.sql', import.meta.url), 'utf8')
      .replace(/^ALTER TABLE.*$/m, '');
    before.sqlite.exec(sql);
    const get = (tech) => before.sqlite.prepare('SELECT name, description FROM tech_stack WHERE tech = ?').get(tech);
    assert.equal(get('rum').description, 'our own words');
    assert.match(get('analytics').description, /Customer Journey Analytics/);
    assert.equal(before.sqlite.prepare("SELECT COUNT(*) AS n FROM tech_stack WHERE team = 'admin'").get().n, 58);
  });
});

describe('topic map: building', () => {
  it('clusters the threads worth it, names the topics, and keeps who posted and for whom', async () => {
    const env = await setup();
    const built = await buildTopicMap(env, { now: NOW, by: 'Ada' });
    assert.equal(built.threads, 30);
    assert.equal(built.k, 3);
    const { map } = built;
    assert.deepEqual(map.topics.map((t) => t.size), [10, 10, 10]);
    // Each topic is one group's threads, the most typical first.
    for (const topic of map.topics) {
      const own = map.threads.filter((t) => t.topic === topic.id);
      assert.equal(new Set(own.map((t) => t.title.split(' ')[0])).size, 1);
      assert.ok(own.every((t, i) => i === 0 || own[i - 1].sim >= t.sim));
    }
    const labels = map.topics.map((t) => t.label).sort();
    assert.deepEqual(labels, ['Sidekick sign-in', 'Storefront', 'Storefront (2)'].sort());
    const signIn = map.topics.find((t) => t.label === 'Sidekick sign-in');
    assert.equal(signIn.theme, 'Authors cannot sign in after an SSO change.');
    // The namer read the titles of the topic's threads.
    assert.ok(env.calls.ai.every((u) => u.startsWith('Threads, the most typical first:\n- ')));
    // Not the short, the meeting, the alert, the unvectorized, nor the one CONTENT lacks.
    assert.ok(!map.threads.some((t) => /short|meet|alert|novec|gone/.test(t.key)));
    // Only Adobe people, with their messages; the customers' and the tags as Clef has them.
    assert.deepEqual(map.people, { 1: 'Ada', 2: 'Bo' });
    const one = map.threads.find((t) => t.key === 'slack:E1:C1:0.1');
    assert.deepEqual(one.staff, { 1: 2 });
    assert.deepEqual(one.tags, ['cdn']);
    assert.deepEqual(map.threads.find((t) => t.key === 'slack:E1:C1:0.2').tags, []);
    assert.deepEqual(map.orgs, {
      acme: { name: 'ACME', type: 'customer' }, globex: { name: 'Globex', type: 'partner' },
    });
    assert.equal(map.tags.cdn, 'Caching and delivery');
    // The products: Akamai is the tech stack's (migration 0043), Jira a gap, CDN generic.
    assert.deepEqual(map.products, {
      'tech:akamai': { name: 'Akamai', tech: 'akamai', product: 'CDN' },
      'new:jira': { name: 'Jira', tech: null, product: null },
    });
    assert.deepEqual(one.products, ['tech:akamai']);
    assert.deepEqual(map.threads.find((t) => t.key === 'slack:E1:C1:0.2').products, ['new:jira']);
    assert.deepEqual(map.threads.find((t) => t.key === 'slack:E1:C1:1.2').products, []);
    assert.equal(map.built_by, 'Ada');

    const latest = await latestTopicMap(env);
    assert.equal(latest.id, built.id);
    assert.deepEqual(latest.map, map);
  });

  it('needs enough threads, and the index and Workers AI', async () => {
    const env = await setup({ perGroup: 5 });
    assert.match((await buildTopicMap(env)).error, new RegExp(`15 threads.*needs ${MIN_THREADS}`));
    assert.match((await buildTopicMap({ DB: env.DB })).error, /CONTENT index/);
    assert.equal(await latestTopicMap(env), null);
  });

  it('keeps the newest few', async () => {
    const env = await setup();
    for (let i = 0; i < KEEP + 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await buildTopicMap(env, { now: new Date(NOW.getTime() + i * 1000) });
    }
    const rows = env.DB.sqlite.prepare('SELECT built_at FROM topic_maps ORDER BY built_at').all();
    assert.equal(rows.length, KEEP);
    const newest = new Date(NOW.getTime() + (KEEP + 1) * 1000).toISOString();
    assert.equal(rows[KEEP - 1].built_at, newest);
  });

  it('is built by the cron once the newest is a week old', async () => {
    const env = await setup();
    assert.deepEqual(await sweepTopicMap({ DB: env.DB }, NOW), { skipped: 'no CONTENT index' });
    const first = await sweepTopicMap(env, NOW);
    assert.equal(first.threads, 30);
    const later = (days) => new Date(NOW.getTime() + days * 86400000);
    assert.deepEqual(await sweepTopicMap(env, later(6)), { fresh: NOW.toISOString() });
    assert.equal((await sweepTopicMap(env, later(7))).k, 3);
  });
});

describe('topic map: the admin API', () => {
  const call = async (env, me, method) => {
    const url = new URL('https://opspile.example/api/admin/topics');
    const res = await api(new Request(url, { method }), env, url, { viewer: asMe(me) });
    return { status: res.status, body: await res.json() };
  };

  it('shows the newest map, and builds one, for the admin team only', async () => {
    const env = await setup();
    assert.deepEqual((await call(env, ADA, 'GET')).body, { latest: null, available: true });
    const built = await call(env, ADA, 'POST');
    assert.equal(built.status, 200);
    assert.equal(built.body.latest.built_by, 'Ada');
    assert.equal(built.body.latest.map.threads.length, 30);
    assert.equal((await call(env, ADA, 'GET')).body.latest.id, built.body.latest.id);
    assert.equal((await call(env, BO, 'GET')).status, 403);
    assert.equal((await call({ ...env, CONTENT: undefined }, ADA, 'POST')).status, 503);
  });
});
