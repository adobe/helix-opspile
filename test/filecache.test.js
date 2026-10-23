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
import { fileCache, folderFiles } from '../src/filecache.js';
import { fakeBucket } from './fakes.js';

const file = (id, body) => render({ source: 'slack', thread: 'slack:E1:C1:1.1', id }, body);

/** The bucket, counting the reads that reach it. */
function counted(bucket) {
  const reads = [];
  return {
    reads,
    bucket: {
      ...bucket,
      list: bucket.list,
      get: async (key) => {
        reads.push(key);
        return bucket.get(key);
      },
    },
  };
}

describe('thread files', () => {
  it('reads a file again only when R2 has a new version of it', async () => {
    const r2 = fakeBucket({
      't/1.1.md': file('1.1', 'first'),
      't/1.2.md': file('1.2', 'second'),
      'other/9.9.md': file('9.9', 'elsewhere'),
    });
    const { bucket, reads } = counted(r2);
    const cache = fileCache();
    const bodies = async () => (await folderFiles(bucket, 't/', cache)).map((f) => f.body);
    assert.deepEqual(await bodies(), ['first', 'second']);
    assert.deepEqual(reads, ['t/1.1.md', 't/1.2.md']);
    assert.deepEqual(await bodies(), ['first', 'second']);
    assert.equal(reads.length, 2);
    // An edit and a new message: those two are read, the unchanged one is not.
    await r2.put('t/1.2.md', file('1.2', 'second, edited'));
    await r2.put('t/1.3.md', file('1.3', 'third'));
    assert.deepEqual(await bodies(), ['first', 'second, edited', 'third']);
    assert.deepEqual(reads.slice(2), ['t/1.2.md', 't/1.3.md']);
    // Gone from R2: gone from the thread.
    r2.objects.delete('t/1.1.md');
    assert.deepEqual(await bodies(), ['second, edited', 'third']);
  });

  it('always reads files without a version, and files that vanished are null', async () => {
    const r2 = fakeBucket({ 't/1.1.md': file('1.1', 'first') });
    const { bucket, reads } = counted({
      ...r2,
      list: async (o) => ({ objects: (await r2.list(o)).objects.map(({ key }) => ({ key })) }),
    });
    const cache = fileCache();
    await folderFiles(bucket, 't/', cache);
    await folderFiles(bucket, 't/', cache);
    assert.equal(reads.length, 2);
    const gone = { list: async () => ({ objects: [{ key: 't/x.md', version: 'v-x' }] }), get: async () => null };
    assert.deepEqual(await folderFiles(gone, 't/', cache), [null]);
  });

  it('keeps the most recently used files within its size', () => {
    const cache = fileCache(100);
    cache.set('a', 'v1', 40, 'A');
    cache.set('b', 'v1', 40, 'B');
    assert.equal(cache.get('a', 'v1'), 'A');
    cache.set('c', 'v1', 40, 'C');
    // `b` was used least recently.
    assert.equal(cache.get('b', 'v1'), undefined);
    assert.equal(cache.get('a', 'v1'), 'A');
    assert.equal(cache.get('a', 'v2'), undefined);
    assert.equal(cache.bytes, 80);
    cache.set('huge', 'v1', 1000, 'H');
    assert.equal(cache.get('huge', 'v1'), undefined);
    assert.equal(cache.size, 2);
  });
});
