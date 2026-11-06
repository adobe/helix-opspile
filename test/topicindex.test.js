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
import { findTopic, indexTopicMap, topicsOfThreads } from '../src/topicindex.js';

// A made-up topic map, as src/topicmap.js keeps one.
const MAP = {
  built_at: '2026-11-01T00:00:00.000Z',
  topics: [
    {
      id: 0, label: 'Assistant panel errors', theme: 'Customers need it back.', size: 2,
    },
    {
      id: 1, label: 'Cache purges', theme: 'Customers need purges to finish.', size: 1,
    },
  ],
  threads: [
    {
      key: 'a', topic: 0, last: '2026-10-01T00:00:00Z', staff: { 1: 3, 2: 1 },
    },
    {
      key: 'b', topic: 0, last: '2026-10-05T00:00:00Z', staff: { 1: 1 },
    },
    {
      key: 'c', topic: 1, last: '2026-10-02T00:00:00Z', staff: {},
    },
  ],
};

describe('topic index', () => {
  const index = indexTopicMap({ id: 7, map: MAP });

  it('says who worked how many threads of each topic, and when last', () => {
    assert.equal(index.id, 7);
    assert.deepEqual(index.topics.get(0).people.get(1), { threads: 2, last: '2026-10-05T00:00:00Z' });
    assert.deepEqual(index.topics.get(0).people.get(2), { threads: 1, last: '2026-10-01T00:00:00Z' });
    assert.equal(index.topics.get(1).people.size, 0);
    assert.equal(index.topicOf.get('c'), 1);
  });

  it('finds a topic by its name, in any case and accents, part of it, or its id', () => {
    assert.equal(findTopic(index, 'cache PURGES').id, 1);
    assert.equal(findTopic(index, 'Assistänt panel').id, 0);
    assert.equal(findTopic(index, '1').id, 1);
    assert.equal(findTopic(index, 'nothing'), null);
    assert.equal(findTopic(null, 'cache'), null);
  });

  it('gives the topics a set of threads is in, the most weight first', () => {
    assert.deepEqual(topicsOfThreads(index, [
      { thread: 'c', gain: 0.01 }, { thread: 'a', gain: 0.05 }, { thread: 'b' }, { thread: 'z' },
    ]).map((t) => [t.label, t.threads]), [['Assistant panel errors', 2], ['Cache purges', 1]]);
    assert.deepEqual(topicsOfThreads(null, [{ thread: 'a' }]), []);
  });
});
