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
import { SCRIPTS } from './ui.js';

// ui/topicgraph.js and ui/topicspace.js as the page runs them: their globals.
// eslint-disable-next-line no-new-func
const load = (name, global) => new Function('globalThis', `${SCRIPTS[name]}\nreturn globalThis.${global};`)({});
const TopicGraph = load('topicgraph.js', 'TopicGraph');
const TopicSpace = load('topicspace.js', 'TopicSpace');
const ALL = ['topic', 'person', 'product'];

/** Two topics far apart, an area of both and one of none; people, a customer and products. */
function mapOf({ at = true } = {}) {
  const threads = [];
  const thread = (topic, staff, org, products = [], customers = []) => threads.push({
    key: `k${threads.length}`,
    team: 'a',
    topic,
    org,
    staff: Object.fromEntries(staff.map((p) => [p, 1])),
    customers: Object.fromEntries(customers.map((p) => [p, 1])),
    products,
    tags: [],
  });
  for (let i = 0; i < 6; i += 1) {
    thread(0, [1], 'acme', ['tech:akamai'], [9]);
    thread(1, [2], 'beta', ['tech:github']);
  }
  thread(2, [1, 2], 'acme');
  return {
    version: 2,
    topics: [
      { label: 'T0', area: 'cdn', ...(at ? { at: [-1, 0, 0] } : {}) },
      { label: 'T1', area: 'cdn', ...(at ? { at: [1, 0, 0] } : {}) },
      { label: 'T2', area: null, ...(at ? { at: [0, 1, 0] } : {}) },
    ],
    people: { 1: 'P1', 2: 'P2', 9: 'C9' },
    peopleOf: { 1: { staff: true, team: 'a' }, 2: { staff: true, team: 'b' }, 9: { staff: false, org: 'acme' } },
    tags: { cdn: 'CDN' },
    orgs: { acme: { name: 'Acme', type: 'customer' }, beta: { name: 'Beta', type: 'customer' } },
    products: {
      'tech:akamai': { name: 'Akamai', tech: 'akamai', product: 'CDN' },
      'tech:github': { name: 'GitHub', tech: 'github', product: 'Code' },
    },
    threads,
  };
}

const dist = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));

describe('the Topics space (ui/topicspace.js)', () => {
  it('fixes the topics where the map put them, and pulls the rest to what they share threads with', () => {
    const map = mapOf();
    const g = TopicGraph.build(map, { shown: ALL, min: 1 });
    const pos = TopicSpace.places(map, g);
    assert.deepEqual(pos.get('topic:0'), [-TopicSpace.SCALE, 0, 0]);
    assert.deepEqual(pos.get('topic:1'), [TopicSpace.SCALE, 0, 0]);
    // Akamai's threads are T0's, GitHub's T1's; P1 posts in T0's, P2 in T1's, C9 in T0's.
    const nearer = (id, a, b) => dist(pos.get(id), pos.get(a)) < dist(pos.get(id), pos.get(b));
    assert.ok(nearer('product:tech:akamai', 'topic:0', 'topic:1'));
    assert.ok(nearer('product:tech:github', 'topic:1', 'topic:0'));
    assert.ok(nearer('person:1', 'topic:0', 'topic:1'));
    assert.ok(nearer('person:2', 'topic:1', 'topic:0'));
    assert.ok(nearer('person:9', 'topic:0', 'topic:1'));
    // A group is where its members are, by their threads: the area between its two topics.
    const area = TopicSpace.centre(g.all.get('tag:cdn'), g.all, pos);
    assert.ok(Math.abs(area[0]) < 1);
    // The same threads, the same places.
    assert.deepEqual(TopicSpace.places(map, TopicGraph.build(map, { shown: ALL, min: 1 })), pos);
  });

  it('puts the topics of a map from before by their areas', () => {
    const map = mapOf({ at: false });
    const pos = TopicSpace.places(map, TopicGraph.build(map, { shown: ALL, min: 1 }));
    // The two of area cdn together, the one of none apart.
    assert.ok(dist(pos.get('topic:0'), pos.get('topic:1')) < dist(pos.get('topic:0'), pos.get('topic:2')));
  });

  it('draws what is closed, and of what is opened its children around it', () => {
    const map = mapOf();
    const g = TopicGraph.build(map, { shown: ALL, min: 1 });
    const ids = (d) => d.items.map((n) => n.id).sort();
    const shut = TopicSpace.drawn(g, { open: new Set(), shown: ['topic'], min: 1 });
    assert.deepEqual(ids(shut), ['tag:cdn', 'topic:2']);
    const opened = TopicSpace.drawn(g, { open: new Set(['tag:cdn']), shown: ['topic'], min: 1 });
    assert.deepEqual(ids(opened), ['topic:0', 'topic:1', 'topic:2']);
    assert.deepEqual(opened.shells.map((n) => n.id), ['tag:cdn']);
    // A customer is a bubble even of one person; a team of one is that one.
    const people = TopicSpace.drawn(g, { open: new Set(), shown: ['person'], min: 1 });
    assert.deepEqual(ids(people), ['org:acme', 'org:beta', 'person:1', 'person:2']);
    // Too few threads: not drawn.
    assert.deepEqual(ids(TopicSpace.drawn(g, { open: new Set(), shown: ['topic'], min: 2 })), ['tag:cdn']);
  });

  it('packs a closed bubble\'s children inside it, at their size when they fit', () => {
    const fits = TopicSpace.pack([0.3, 0.2, 0.2]);
    assert.deepEqual(fits.map((k) => k.r), [0.3, 0.2, 0.2]);
    const many = TopicSpace.pack(Array.from({ length: 30 }, (_, i) => 0.5 - i / 100));
    assert.ok(many[0].r < 0.5);
    for (const list of [fits, many]) {
      list.forEach((a, i) => {
        assert.ok(Math.hypot(...a.p) + a.r <= 1 + 1e-9, 'inside');
        list.slice(i + 1).forEach((b) => assert.ok(dist(a.p, b.p) >= (a.r + b.r) * 0.97, 'apart'));
      });
      // Scaled alike: the biggest stays the biggest.
      assert.ok(list.every((k) => k.r <= list[0].r + 1e-9));
    }
  });

  it('pushes overlapping bubbles apart, the bigger less', () => {
    const big = { to: [0, 0, 0], home: [0, 0, 0], r: 4 };
    const small = { to: [1, 0, 0], home: [1, 0, 0], r: 1 };
    const far = { to: [50, 0, 0], home: [50, 0, 0], r: 1 };
    for (let i = 0; i < 5; i += 1) {
      TopicSpace.collide([big, small, far]);
    }
    assert.ok(dist(big.to, small.to) >= 5);
    assert.ok(Math.abs(big.to[0]) < Math.abs(small.to[0] - 1));
    assert.deepEqual(far.to, [50, 0, 0]);
    // And back towards home, a share of the way.
    small.home = [20, 0, 0];
    const before = small.to[0];
    TopicSpace.collide([small], 0.5);
    assert.ok(small.to[0] > before);
  });
});

describe('three.js for the Topics map (src/ui-three.js)', () => {
  it('is served as a module the page imports, kept by the browser until it changes', async () => {
    const { THREE_PATH, threeScript } = await import('../src/page.js');
    assert.ok(SCRIPTS['topicview.js'].includes(`'${THREE_PATH}'`));
    const get = (path, headers = {}, method = 'GET') => threeScript({ method, headers: new Headers(headers) }, path);
    const ok = get(THREE_PATH);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /^text\/javascript/);
    assert.match(await ok.text(), /OrbitControls/);
    const etag = ok.headers.get('etag');
    assert.equal(get(THREE_PATH, { 'if-none-match': etag }).status, 304);
    assert.equal(get(THREE_PATH, {}, 'POST'), null);
    assert.equal(get('/inbox/nope.js'), null);
  });
});
