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

// ui/topicgraph.js as the page runs it: its global `TopicGraph`.
// eslint-disable-next-line no-new-func
const TopicGraph = new Function('globalThis', `${SCRIPTS['topicgraph.js']}\nreturn globalThis.TopicGraph;`)({});

const ALL = ['person', 'topic', 'tag', 'org'];

/** A map of `threads`: `[topic, org, people, tags]` each, on team `a`. */
function mapOf(threads) {
  return {
    topics: [{ label: 'T0' }, { label: 'T1' }, { label: 'T2' }],
    people: { 1: 'P1', 2: 'P2', 3: 'P3' },
    tags: { cdn: 'CDN', seo: 'SEO' },
    orgs: { acme: { name: 'Acme', type: 'customer' }, beta: { name: 'Beta', type: 'customer' }, us: { name: 'Us', type: 'internal' } },
    threads: threads.map(([topic, org, people, tags = []], i) => ({
      key: `k${i}`,
      team: 'a',
      topic,
      org,
      staff: Object.fromEntries(people.map((p) => [p, 1])),
      tags,
    })),
  };
}

const lines = (g) => g.edges.map((e) => `${[e.a.id, e.b.id].sort().join(' ')} ${e.w}`).sort();
const drawn = (g) => g.nodes.map((n) => n.id).sort();

describe('the Topics graph (ui/topicgraph.js)', () => {
  it('joins people by the threads they share when they are shown alone', () => {
    const g = TopicGraph.build(mapOf([
      [0, 'acme', [1, 2]], [1, 'acme', [1, 2]], [2, 'beta', [2, 3]], [0, 'beta', [3]],
    ]), { shown: ['person'], min: 2 });
    assert.deepEqual(lines(g), ['person:1 person:2 2']);
    // Person 3 shares one thread only: no line, not drawn.
    assert.deepEqual(drawn(g), ['person:1', 'person:2']);
  });

  it('joins tags by the threads they share when they are shown alone', () => {
    const g = TopicGraph.build(mapOf([
      [0, 'acme', [1], ['cdn', 'seo']], [1, 'acme', [1], ['cdn', 'seo']], [2, 'acme', [1], ['cdn']],
    ]), { shown: ['tag'], min: 2 });
    assert.deepEqual(lines(g), ['tag:cdn tag:seo 2']);
  });

  it('joins topics by min people, each with min threads in both', () => {
    const threads = [
      // People 1 and 2 have two threads in topic 0 and two in topic 1.
      [0, 'acme', [1, 2]], [0, 'acme', [1, 2]], [1, 'acme', [1, 2]], [1, 'acme', [1, 2]],
      // Person 3 has two in topic 1 and two in topic 2, alone: not enough people.
      [1, 'beta', [3]], [1, 'beta', [3]], [2, 'beta', [3]], [2, 'beta', [3]],
    ];
    const g = TopicGraph.build(mapOf(threads), { shown: ['topic'], min: 2 });
    assert.deepEqual(lines(g), ['topic:0 topic:1 2']);
    // Topics are drawn without a line too.
    assert.deepEqual(drawn(g), ['topic:0', 'topic:1', 'topic:2']);
    // At 1+, one person with one thread in both is enough.
    assert.deepEqual(
      lines(TopicGraph.build(mapOf(threads), { shown: ['topic'], min: 1 })),
      ['topic:0 topic:1 2', 'topic:1 topic:2 1'],
    );
  });

  it('joins one person with one thread in each topic only at 1+', () => {
    const threads = [[0, 'acme', [1, 2]], [1, 'acme', [1, 2]]];
    assert.deepEqual(lines(TopicGraph.build(mapOf(threads), { shown: ['topic'], min: 2 })), []);
    assert.deepEqual(
      lines(TopicGraph.build(mapOf(threads), { shown: ['topic'], min: 1 })),
      ['topic:0 topic:1 2'],
    );
  });

  it('joins customers by their people too, and leaves out internal ones and those without a line', () => {
    const g = TopicGraph.build(mapOf([
      [0, 'acme', [1, 2]], [0, 'acme', [1, 2]], [1, 'beta', [1, 2]], [1, 'beta', [1, 2]],
      [2, 'us', [1, 2]], [2, 'us', [1, 2]], [2, 'gamma', [3]],
    ]), { shown: ['org'], min: 2 });
    assert.deepEqual(lines(g), ['org:acme org:beta 2']);
    assert.deepEqual(drawn(g), ['org:acme', 'org:beta']);
  });

  it('keeps the lines between kinds as they were with several shown', () => {
    const map = mapOf([[0, 'acme', [1, 2], ['cdn']], [0, 'acme', [1, 2], ['cdn']]]);
    // With the topics, they are the hubs: no person–person, person–tag or tag–customer lines.
    assert.deepEqual(lines(TopicGraph.build(map, { shown: ALL, min: 2 })), [
      'org:acme person:1 2', 'org:acme person:2 2', 'org:acme topic:0 2',
      'person:1 topic:0 2', 'person:2 topic:0 2', 'tag:cdn topic:0 2',
    ]);
    // Without them, any two kinds, but never two of one.
    assert.deepEqual(lines(TopicGraph.build(map, { shown: ['person', 'tag'], min: 2 })), [
      'person:1 tag:cdn 2', 'person:2 tag:cdn 2',
    ]);
  });

  it('takes the team\'s threads only', () => {
    const map = mapOf([[0, 'acme', [1, 2]], [1, 'acme', [1, 2]]]);
    map.threads[1].team = 'b';
    const g = TopicGraph.build(map, { team: 'a', shown: ['person'], min: 1 });
    assert.equal(g.threads.length, 1);
    assert.deepEqual(lines(g), ['person:1 person:2 1']);
  });
});
