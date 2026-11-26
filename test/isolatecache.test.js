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
import { Meter } from '../src/cogs/meter.js';
import { isolateCache } from '../src/isolatecache.js';

const binding = { prepare() {}, batch() {} };
/** One request's env: its D1 metered anew, as src/index.js does. */
const request = () => new Meter({ DB: binding, USAGE: { writeDataPoint() {} } }).env({});
/** A load that resolves when told to. */
function loader() {
  const calls = [];
  const load = () => new Promise((resolve, reject) => {
    calls.push({ resolve, reject });
  });
  return { calls, load };
}
const tick = () => new Promise((r) => {
  setImmediate(r);
});

describe('isolateCache', () => {
  it('keeps what was loaded for every request of the isolate, for its time', async () => {
    const c = isolateCache(60000);
    const { calls, load } = loader();
    const first = c.get(request(), load);
    await tick();
    calls[0].resolve('v1');
    assert.equal(await first, 'v1');
    assert.equal(await c.get(request(), load), 'v1');
    assert.equal(calls.length, 1);
    // `fresh`: loaded anew.
    const again = c.get(request(), load, { fresh: true });
    await tick();
    calls[1].resolve('v2');
    assert.equal(await again, 'v2');
    assert.equal(await c.get(request(), load), 'v2');
  });

  it('shares a load on its way within its request only, never with another', async () => {
    const c = isolateCache(60000);
    const { calls, load } = loader();
    const a = request();
    const p1 = c.get(a, load);
    const p2 = c.get(a, load);
    const p3 = c.get(request(), load);
    await tick();
    assert.equal(calls.length, 2, 'the other request loads itself');
    calls[0].resolve('a');
    calls[1].resolve('b');
    assert.deepEqual(await Promise.all([p1, p2, p3]), ['a', 'a', 'b']);
  });

  it('keeps nothing that failed, and nothing loaded before it was forgotten', async () => {
    const c = isolateCache(60000);
    const { calls, load } = loader();
    const failed = c.get(request(), load);
    await tick();
    calls[0].reject(new Error('D1 DB is overloaded'));
    await assert.rejects(failed, /overloaded/);
    const before = c.get(request(), load);
    await tick();
    c.forget();
    calls[1].resolve('old');
    assert.equal(await before, 'old');
    const after = c.get(request(), load);
    await tick();
    assert.equal(calls.length, 3, 'not kept: loaded anew');
    calls[2].resolve('new');
    assert.equal(await after, 'new');
  });

  it('lets a value go after its time', async () => {
    const c = isolateCache(-1);
    const { calls, load } = loader();
    const one = c.get(request(), load);
    await tick();
    calls[0].resolve(1);
    await one;
    c.get(request(), load);
    await tick();
    assert.equal(calls.length, 2);
  });
});
