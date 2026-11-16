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
import { afterEach, describe, it } from 'node:test';
import { build, objectsOf } from '../scripts/computer-images.mjs';
import {
  CHECKS, commandsCheck, runCheck, summaryOf, syncImages,
} from '../scripts/dev-computer/check.mjs';

const ORIGIN = 'https://computer.example';
const realFetch = globalThis.fetch;

/** A fetch that answers as the computer's Worker does, from `bucket` (a Map). */
function fakeWorker(bucket, { token, exec } = {}) {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const headers = new Headers(init.headers);
    seen.push({ method: init.method || 'GET', pathname, thread: searchParams.get('thread') });
    if (token && headers.get('x-opspile-computer-token') !== token) {
      return new Response('forbidden\n', { status: 403 });
    }
    const key = pathname.slice('/images/'.length);
    if (init.method === 'PUT') {
      bucket.set(key, String(init.body));
      return new Response('ok\n');
    }
    if (init.method === 'POST') {
      return Response.json(exec(JSON.parse(init.body)));
    }
    return bucket.has(key) ? new Response(bucket.get(key)) : new Response('', { status: 404 });
  };
  return seen;
}

describe('the checks of the stage computer', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('put into its bucket what it lacks, with the token, and nothing when it has it all', async () => {
    const built = await build();
    const bucket = new Map();
    const seen = fakeWorker(bucket, { token: 't' });
    const log = () => {};
    assert.equal(await syncImages(ORIGIN, built, { token: 't', log }), objectsOf(built).length);
    assert.equal(bucket.get('images/index.json'), objectsOf(built).at(-1).body);
    seen.length = 0;
    assert.equal(await syncImages(ORIGIN, built, { token: 't', log }), 0);
    assert.ok(seen.every((r) => r.method === 'GET' && !r.pathname.startsWith('/images/blobs/')));
    await assert.rejects(syncImages(ORIGIN, built, { token: 'wrong', log }), /could not put .*: 403/);
  });

  it('pass on exit 0 with the output they expect, on a computer of their image', async () => {
    const check = CHECKS.find((c) => c.name === 'qjs');
    const answers = [{ exitCode: 0, stdout: '42\n' }, { exitCode: 0, stdout: '41\n' },
      { exitCode: 1, stdout: '42\n' }, { error: 'timeout', message: 'too slow' }];
    const seen = fakeWorker(new Map(), { exec: () => answers.shift() });
    const run = () => runCheck(ORIGIN, check, { run: 'r1' });
    assert.equal((await run()).ok, true);
    assert.equal((await run()).ok, false);
    assert.equal((await run()).ok, false);
    assert.deepEqual([(await run()).error, seen[0].thread], ['timeout: too slow', 'check-r1-base']);
    globalThis.fetch = async () => {
      throw new Error('fetch failed');
    };
    assert.equal((await run()).error, 'fetch failed');
  });

  it('run on a computer of their own when they name a thread, before grep runs anywhere', async () => {
    const check = CHECKS.find((c) => c.thread === 'first-read');
    assert.ok(check.command.includes('git clone') && check.command.endsWith('grep -c "{"'));
    assert.ok(CHECKS.indexOf(check) < CHECKS.findIndex((c) => /\bgrep\b/.test(c.command) && !c.thread));
    const seen = fakeWorker(new Map(), { exec: () => ({ exitCode: 0, stdout: '3\n1\n' }) });
    assert.equal((await runCheck(ORIGIN, check, { run: 'r1' })).ok, true);
    assert.equal(seen[0].thread, 'check-r1-first-read');
  });

  it('look for every command of an image, and say where the computer is nowhere', async () => {
    const { images } = await build();
    const check = commandsCheck(images[0]);
    assert.equal(check.image, 'base');
    assert.ok(images[0].commands.every((c) => check.command.includes(`'${c}'`)));
    const summary = summaryOf([
      { name: 'boots', ok: true, ms: 5 },
      {
        name: 'dig', ok: false, ms: 9, exitCode: 9, output: 'no servers could be reached\n',
      },
    ]);
    assert.match(summary, /\| ✅ \| boots \| 5 ms \|\n\| ❌ \| dig \| 9 ms \|/);
    assert.match(summary, /\*\*dig\*\* \(exit 9\):\n\n```\nno servers could be reached\n```/);
    assert.doesNotMatch(summary, /https?:/);
  });
});
