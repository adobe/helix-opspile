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

const ALL = ['person', 'topic', 'product'];

/**
 * A map of `threads`: `[topic, org, people, tags, customers]` each, on team `a`. Topics 0 and 1
 * are in area cdn, topic 2 in none; people 1 and 2 are on team a, 3 on team b; 9 is Acme's.
 */
function mapOf(threads) {
  return {
    version: 2,
    topics: [{ label: 'T0', area: 'cdn' }, { label: 'T1', area: 'cdn' }, { label: 'T2', area: null }],
    people: {
      1: 'P1', 2: 'P2', 3: 'P3', 9: 'C9',
    },
    peopleOf: {
      1: { staff: true, team: 'a' }, 2: { staff: true, team: 'a' }, 3: { staff: true, team: 'b' }, 9: { staff: false, org: 'acme' },
    },
    tags: { cdn: 'CDN', seo: 'SEO' },
    orgs: { acme: { name: 'Acme', type: 'customer' }, beta: { name: 'Beta', type: 'customer' }, us: { name: 'Us', type: 'internal' } },
    threads: threads.map(([topic, org, people, tags = [], customers = []], i) => ({
      key: `k${i}`,
      team: 'a',
      topic,
      org,
      staff: Object.fromEntries(people.map((p) => [p, 1])),
      customers: Object.fromEntries(customers.map((p) => [p, 1])),
      tags,
    })),
  };
}

const lines = (g) => g.edges.map((e) => `${[e.a.id, e.b.id].sort().join(' ')} ${e.w}`).sort();
const drawn = (g) => g.nodes.map((n) => n.id).sort();

describe('the Topics graph (ui/topicgraph.js)', () => {
  it('draws the topics in their areas, and an area opened as its topics', () => {
    const map = mapOf([[0, 'acme', [1]], [1, 'acme', [1]], [2, 'beta', [3]]]);
    const shut = TopicGraph.build(map, { shown: ['topic'], min: 1 });
    // Area cdn has two topics: drawn as itself; "Not in an area" has one: drawn as it.
    assert.deepEqual(drawn(shut), ['tag:cdn', 'topic:2']);
    assert.equal(shut.all.get('tag:cdn').threads.length, 2);
    assert.deepEqual(shut.all.get('tag:cdn').children.sort(), ['topic:0', 'topic:1']);
    assert.equal(shut.all.get('topic:0').parent, 'tag:cdn');
    assert.equal(shut.all.get('topic:2').parent, null);
    assert.equal(shut.all.get('tag:_none').label, 'Not in an area');
    const opened = TopicGraph.build(map, { shown: ['topic'], min: 1, open: ['tag:cdn'] });
    assert.deepEqual(drawn(opened), ['topic:0', 'topic:1', 'topic:2']);
    assert.equal(opened.all.get('tag:cdn').open, true);
  });

  it('puts a topic of a map from before areas in the tag most of its threads have', () => {
    const map = mapOf([[0, 'acme', [1], ['seo']], [0, 'acme', [1], ['seo', 'cdn']], [1, 'acme', [1]]]);
    map.topics = map.topics.map(({ label }) => ({ label }));
    delete map.peopleOf;
    const g = TopicGraph.build(map, { shown: ['topic'], min: 1 });
    assert.deepEqual(g.areas, ['seo', '_none', '_none']);
    // And Adobe's people in the team of most of their threads.
    assert.equal(g.all.get('person:1').parent, null);
    assert.equal(g.all.get('team:a').children.length, 1);
  });

  it('draws Adobe\'s people in their teams, the others in their customers', () => {
    const map = mapOf([
      [0, 'acme', [1, 2], [], [9]], [0, 'acme', [1, 2]], [1, 'beta', [1, 3]], [1, 'us', [3]],
    ]);
    const g = TopicGraph.build(map, { shown: ['person'], min: 1, teamName: (t) => `Team ${t}` });
    // Team a (two people) is a bubble, team b (one) is its person; a customer is a bubble
    // whether or not its people posted; internal customers are none.
    assert.deepEqual(drawn(g), ['org:acme', 'org:beta', 'person:3', 'team:a']);
    assert.equal(g.all.get('team:a').label, 'Team a');
    assert.deepEqual(g.all.get('org:acme').children, ['person:9']);
    assert.equal(g.all.get('org:acme').threads.length, 2);
    assert.deepEqual(lines(g), [
      'org:acme team:a 2', 'org:beta person:3 1', 'org:beta team:a 1', 'person:3 team:a 1',
    ]);
    const open = TopicGraph.build(map, { shown: ['person'], min: 1, open: ['team:a', 'org:acme'] });
    assert.deepEqual(drawn(open), ['org:beta', 'person:1', 'person:2', 'person:3', 'person:9']);
    assert.ok(lines(open).includes('person:1 person:9 1'));
  });

  it('joins topics by min people, each with min threads in both', () => {
    const threads = [
      // People 1 and 2 have two threads in topic 0 and two in topic 2.
      [0, 'acme', [1, 2]], [0, 'acme', [1, 2]], [2, 'acme', [1, 2]], [2, 'acme', [1, 2]],
      // Person 3 has two in topic 1 and two in topic 2, alone: not enough people.
      [1, 'beta', [3]], [1, 'beta', [3]], [2, 'beta', [3]], [2, 'beta', [3]],
    ];
    const open = ['tag:cdn'];
    const g = TopicGraph.build(mapOf(threads), { shown: ['topic'], min: 2, open });
    assert.deepEqual(lines(g), ['topic:0 topic:2 2']);
    // Topics are drawn without a line too.
    assert.deepEqual(drawn(g), ['topic:0', 'topic:1', 'topic:2']);
    // At 1+, one person with one thread in both is enough.
    assert.deepEqual(
      lines(TopicGraph.build(mapOf(threads), { shown: ['topic'], min: 1, open })),
      ['topic:0 topic:2 2', 'topic:1 topic:2 1'],
    );
  });

  it('keeps the topics the hubs with several kinds shown', () => {
    const map = mapOf([[2, 'acme', [1, 2]], [2, 'acme', [1, 2]]]);
    // A line from the topic to the others, none between people and customers.
    assert.deepEqual(lines(TopicGraph.build(map, { shown: ALL, min: 2, open: ['team:a'] })), [
      'org:acme topic:2 2', 'person:1 topic:2 2', 'person:2 topic:2 2',
    ]);
  });

  it('puts a person in a team they are on now, and one on none in none', () => {
    const map = mapOf([[0, 'acme', [1, 2, 3]], [1, 'acme', [1, 2, 3]]]);
    // The map put 2 on team a, but 2 is on team b only now; 3 is on no team.
    const g = TopicGraph.build(map, { shown: ['person'], min: 1, members: { 1: ['a', 'b'], 2: ['b'] } });
    assert.equal(g.all.get('person:1').parent, null);
    assert.deepEqual(g.all.get('team:a').children, ['person:1']);
    assert.deepEqual(g.all.get('team:b').children, ['person:2']);
    assert.deepEqual(g.all.get('team:_none').children, ['person:3']);
  });

  it('draws the features in their products or vendors, a thread once in each', () => {
    const map = mapOf([[0, 'acme', [1]], [1, 'acme', [1]], [2, 'acme', [1]]]);
    map.products = {
      'tech:adobe/sites/ue': { name: 'Universal Editor', tech: 'adobe/sites/ue', product: 'Sites' },
      'tech:adobe/sites/eds': { name: 'Edge Delivery', tech: 'adobe/sites/eds', product: 'Sites' },
      'tech:akamai/cdn': { name: 'Akamai', tech: 'akamai/cdn', product: 'Akamai' },
      Fastly: { name: 'Fastly' },
    };
    map.threads[0].products = ['tech:adobe/sites/ue', 'tech:akamai/cdn'];
    map.threads[1].products = ['tech:adobe/sites/eds', 'tech:adobe/sites/ue', 'tech:akamai/cdn'];
    map.threads[2].products = ['Fastly'];
    const g = TopicGraph.build(map, { shown: ['product'], min: 2 });
    // Sites is a product of two features; Akamai, a vendor of one, is its technology.
    assert.deepEqual(lines(g), ['product:group:Sites product:tech:akamai/cdn 2']);
    assert.equal(g.all.get('product:group:Sites').threads.length, 2);
    assert.equal(g.all.get('product:group:Sites').one, 'Product');
    assert.equal(g.all.get('product:tech:adobe/sites/ue').one, 'Feature');
    assert.equal(g.all.get('product:Fastly').gap, true);
    assert.equal(g.all.get('product:tech:akamai/cdn').gap, false);
    const open = TopicGraph.build(map, { shown: ['product'], min: 2, open: ['product:group:Sites'] });
    assert.deepEqual(lines(open), [
      'product:tech:adobe/sites/ue product:tech:akamai/cdn 2',
    ]);
  });

  it('takes the team\'s threads only', () => {
    const map = mapOf([[0, 'acme', [1, 2]], [1, 'acme', [1, 2]]]);
    map.threads[1].team = 'b';
    const g = TopicGraph.build(map, {
      team: 'a', shown: ['person'], min: 1, open: ['team:a'],
    });
    assert.equal(g.threads.length, 1);
    assert.ok(lines(g).includes('person:1 person:2 1'));
  });

  it('leaves out what has no line, but not a topic or an area', () => {
    const map = mapOf([
      [0, 'acme', [1, 2]], [0, 'acme', [1, 2]],
      // Topic 2's one thread: under the cutoff, so none of it has a line.
      [2, 'beta', [3]],
    ]);
    const g = TopicGraph.build(map, { shown: ALL, min: 2 });
    // Area cdn has one topic on these threads: it is drawn as that topic.
    assert.deepEqual(drawn(g), ['org:acme', 'team:a', 'topic:0', 'topic:2']);
    // Every node is there to point at and find, drawn or not.
    assert.ok(g.all.has('person:3') && g.all.has('org:beta') && g.all.has('person:1'));
  });

  it('names the groups, and the people and products of most threads, and only them', () => {
    const people = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i + 1, `P${i + 1}`]));
    // Person n is on n threads, all in topic 2, with customer acme, and on no team.
    const threads = [];
    for (let n = 1; n <= 16; n += 1) {
      for (let i = 0; i < n; i += 1) {
        threads.push([2, 'acme', [n]]);
      }
    }
    const map = { ...mapOf(threads), people, peopleOf: {} };
    // On no team: in "Not on an ops team", opened.
    const g = TopicGraph.build(map, { shown: ALL, min: 1, open: ['team:_none'] });
    assert.equal(g.all.get('team:_none').label, 'Not on an ops team');
    const named = g.nodes.filter((n) => n.named && n.family === 'person').map((n) => n.id).sort();
    const top = Array.from({ length: 13 }, (_, i) => `person:${i + 4}`);
    assert.deepEqual(named, ['org:acme', ...top].sort());
    assert.equal(g.all.get('topic:2').named, true);
  });

  it('lists a group of one as its one, once', () => {
    // Area cdn has topics 0 and 1; "Not in an area" only topic 2.
    const map = mapOf([[0, 'acme', [1]], [1, 'acme', [1]], [2, 'beta', [3]]]);
    const g = TopicGraph.build(map, { shown: ['topic'], min: 1 });
    assert.equal(TopicGraph.standsFor(g, `tag:${TopicGraph.NONE}`).id, 'topic:2');
    assert.equal(TopicGraph.standsFor(g, 'tag:cdn').id, 'tag:cdn');
    assert.equal(TopicGraph.standsFor(g, 'topic:9'), null);
    const ids = ['topic:2', `tag:${TopicGraph.NONE}`, 'tag:cdn', 'topic:0', 'topic:9'];
    assert.deepEqual(TopicGraph.distinct(g, ids).map((n) => n.id), ['topic:2', 'tag:cdn', 'topic:0']);
  });
});
