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
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { build, objectsOf } from '../scripts/computer-images.mjs';
import {
  cachesOf, CHECKS, commandsCheck, GITHUB_SESSION, measure, measuredOf, rangeChecks, request,
  runCheck, summaryOf, syncImages, waitForReady,
} from '../scripts/dev-computer/check.mjs';

const ORIGIN = 'https://computer.example';
const realFetch = globalThis.fetch;

/** What undici throws when a connection is reset. */
const reset = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
});

/** `request`'s options for a test: no waiting, and the pauses it would have made in `slept`. */
const quick = (slept = [], lines = []) => ({
  sleep: async (ms) => {
    slept.push(ms);
  },
  log: (line) => lines.push(line),
});

/**
 * Wraps the fetch so that the calls `fails` numbers (from 1) answer what its function returns
 * instead, or throw it when that is an error.
 */
function failing(fails) {
  const inner = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => {
    calls += 1;
    const res = fails[calls]?.();
    if (res instanceof Error) {
      throw res;
    }
    return res || inner(...args);
  };
}

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
    const retry = quick();
    await assert.rejects(
      syncImages(ORIGIN, built, { token: 'wrong', log, retry }),
      /^Error: PUT \/images\/\S+: HTTP 403, 6 tries$/,
    );
  });

  it('put the images through connection resets and a Worker not there yet', async () => {
    const built = await build();
    const bucket = new Map();
    fakeWorker(bucket, { token: 't' });
    // Cloudflare's 503 before the Worker is there, then resets: at the start, and halfway.
    failing({ 1: () => new Response('', { status: 503 }), 2: reset, 20: reset });
    const slept = [];
    const lines = [];
    const retry = quick(slept, lines);
    const put = await syncImages(ORIGIN, built, { token: 't', log: () => {}, retry });
    assert.equal(put, objectsOf(built).length);
    assert.deepEqual([...bucket.keys()].sort(), objectsOf(built).map((o) => o.key).sort());
    assert.deepEqual(slept, [1000, 2000, 1000]);
    assert.ok(lines.some((l) => /^ {2}GET \/images\/\S+: HTTP 503, again in 1000 ms$/.test(l)));
    assert.ok(lines.some((l) => /: fetch failed \(ECONNRESET\), again in/.test(l)));
    assert.ok(lines.every((l) => !l.includes(ORIGIN)));
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
      throw reset();
    };
    const retry = quick();
    const failed = await runCheck(ORIGIN, check, { run: 'r1', retry });
    assert.deepEqual(
      [failed.ok, failed.error],
      [false, 'POST /?thread=check-r1-base: fetch failed (ECONNRESET), 6 tries'],
    );
  });

  it('try a command again when the network fails it, but not when it fails', async () => {
    const check = CHECKS.find((c) => c.name === 'qjs');
    const answers = [{ exitCode: 0, stdout: '42\n' }, { exitCode: 3, stdout: '' }];
    const seen = fakeWorker(new Map(), { exec: () => answers.shift() });
    failing({ 1: reset, 2: reset });
    const retry = quick();
    assert.equal((await runCheck(ORIGIN, check, { run: 'r1', retry })).ok, true);
    // A broken program: one answer, and the check fails on it.
    const broken = await runCheck(ORIGIN, check, { run: 'r1', retry });
    assert.deepEqual([broken.ok, broken.exitCode, seen.length], [false, 3, 2]);
    // The Worker's 500 is what the command did: not tried again either.
    let posts = 0;
    globalThis.fetch = async () => {
      posts += 1;
      return Response.json({ error: 'EIO' }, { status: 500 });
    };
    const threw = await runCheck(ORIGIN, check, { run: 'r1', retry });
    assert.deepEqual([threw.ok, threw.error, posts], [false, 'EIO', 1]);
  });

  it('try a request again a bounded number of times, with a bounded backoff', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response('busy', { status: 429 });
    };
    const slept = [];
    await assert.rejects(
      request('GET /x', `${ORIGIN}/x`, {}, { ...quick(slept), tries: 7 }),
      /^Error: GET \/x: HTTP 429, 7 tries$/,
    );
    assert.deepEqual([calls, slept], [7, [1000, 2000, 4000, 8000, 8000, 8000]]);
    // A body cut off while it comes is tried again, an error of its reader is not.
    let left = 1;
    globalThis.fetch = async () => new Response('ok');
    const read = async (res) => {
      if (left > 0) {
        left -= 1;
        throw new TypeError('terminated');
      }
      return res.text();
    };
    assert.equal(await request('GET /y', `${ORIGIN}/y`, {}, { ...quick(), read }), 'ok');
    await assert.rejects(request('GET /y', `${ORIGIN}/y`, {}, {
      ...quick(),
      read: () => {
        throw new Error('bad');
      },
    }), /^Error: bad$/);
  });

  it('wait for a Worker just deployed to answer with the token, for a while at most', async () => {
    let t = 0;
    const now = () => t;
    const sleep = async (ms) => {
      t += ms;
    };
    const answers = [() => {
      throw reset();
    }, () => new Response('', { status: 404 }),
    () => new Response('forbidden\n', { status: 403 }), () => new Response('ok\n')];
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push([new URL(url).pathname, new Headers(init.headers).get('x-opspile-computer-token')]);
      return answers.shift()();
    };
    await waitForReady(ORIGIN, {
      token: 't', now, sleep, log: () => {},
    });
    assert.deepEqual([t, seen.length, seen[0]], [6000, 4, ['/health', 't']]);
    globalThis.fetch = async () => new Response('forbidden\n', { status: 403 });
    t = 0;
    await assert.rejects(waitForReady(ORIGIN, {
      token: 'old', now, sleep, limit: 10_000, log: () => {},
    }), /^Error: GET \/health: HTTP 403, still after 10 s$/);
    assert.ok(t <= 10_000);
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

  it('run an agent\'s GitHub session on a computer of its own, its commands in order', () => {
    const session = CHECKS.filter((c) => c.thread === 'github-session');
    assert.deepEqual(session.map((c) => c.command), GITHUB_SESSION);
    assert.ok(session.every((c) => c.image === 'github'));
    const at = CHECKS.indexOf(session[0]);
    assert.equal(CHECKS[at + 1], session[1]);
    assert.match('gh version\n{"a":1}\nb\n200\n2\n42\nOpenSSL\n', session[0].match);
    assert.match('1\n1\ngh version\ntar (GNU\ngzip\ndiff\ntree\nhi\n68690a\nJSON text data\n', session[1].match);
  });

  it('measure each cache on an agent of its own, its steps and what the isolate kept', async () => {
    assert.deepEqual(cachesOf('default,48/24'), [
      { label: 'default', mib: null, fileMib: null }, { label: '48/24', mib: 48, fileMib: 24 },
    ]);
    const asked = [];
    let gets = 10;
    globalThis.fetch = async (url, init) => {
      const { pathname, searchParams } = new URL(url);
      const body = JSON.parse(init.body);
      asked.push([pathname, searchParams.get('thread'), body.cache ?? null]);
      if (pathname === '/reads') {
        return Response.json({ images: { gets, fetched: gets * 1e6, bytes: 5e6 } });
      }
      if (pathname === '/drop') {
        return Response.json({ dropped: true });
      }
      // A cache of its own resets the isolate's counters (forgetImages), as the Worker does.
      gets = (body.cache ? 0 : gets) + 2;
      // The kernel booted again is too much for the object.
      return asked.filter(([p]) => p === '/').length === 3
        ? Response.json({ error: 'Durable Object\'s isolate exceeded its memory limit and was reset.' }, { status: 500 })
        : Response.json({ exitCode: 0, images: { gets, fetched: gets * 1e6, bytes: 5e6 } });
    };
    const lines = [];
    const [r] = await measure('https://computer.example', cachesOf('48/24'), {
      run: 'r1', log: (l) => lines.push(l),
    });
    assert.deepEqual(r.steps.map((s) => [s.name, s.ok, s.gets, s.fetchedMB, s.keptMB]), [
      ['command 1', true, 2, 2, 5], ['command 2', true, 2, 2, 5],
      ['command 1, its kernel booted again', false, undefined, 0, 0],
    ]);
    assert.match(r.steps[2].error, /exceeded its memory limit/);
    assert.ok(asked.every(([, thread]) => thread === 'measure-r1-48-24'));
    // The cache is sized with the first command only.
    assert.deepEqual(asked.filter(([p]) => p === '/').map(([, , c]) => c), [
      { mib: 48, fileMib: 24 }, null, null,
    ]);
    const table = measuredOf([r]);
    assert.match(table, /\| 48\/24 \| ✅ command 1 \| \d+ ms \| 2 \(2 MB\) \| 5 MB \|/);
    assert.match(table, /\| 48\/24 \| ❌ command 1, its kernel booted again \| .* exceeded its memory limit/);
    assert.doesNotMatch(table, /https?:/);
  });

  it('measure the first command by what it answers, its counters reset by its cache', async () => {
    // The isolate read 100 files for agents before; the first command's cache resets that.
    const images = { gets: 100, fetched: 100e6, bytes: 50e6 };
    const asked = [];
    globalThis.fetch = async (url, init) => {
      const { pathname } = new URL(url);
      const body = JSON.parse(init.body);
      asked.push(pathname);
      if (pathname === '/reads') {
        return Response.json({ images });
      }
      if (pathname === '/drop') {
        return Response.json({ dropped: true, images });
      }
      if (body.cache) {
        Object.assign(images, { gets: 0, fetched: 0, bytes: 0 });
      }
      Object.assign(images, {
        gets: images.gets + 2, fetched: images.fetched + 2e6, bytes: images.bytes + 2e6,
      });
      return Response.json({ exitCode: 0, images });
    };
    const [r] = await measure('https://computer.example', cachesOf('default'), {
      run: 'r1', log: () => {},
    });
    assert.deepEqual(r.steps.map((s) => [s.name, s.gets, s.fetchedMB, s.keptMB]), [
      ['command 1', 2, 2, 2], ['command 2', 2, 2, 4],
      ['command 1, its kernel booted again', 2, 2, 6],
    ]);
    assert.deepEqual(asked, ['/', '/', '/drop', '/']);
  });

  it('read files of the image whole and in parts, in a piece of their own and over the limit', async () => {
    const built = await build();
    const checks = rangeChecks(built);
    assert.deepEqual(checks.map((c) => c.name), [
      'base: magic.mgc read whole and in parts', 'base: yq.wasm read whole and in parts',
    ]);
    const files = [...built.layers.values()].flatMap((l) => l.layer.files);
    const sizes = checks.map((c) => files.find((f) => c.command.includes(`/opt/image/${f.path};`)));
    // One under the isolate's limit (16 MiB) and one over it, both in pieces.
    assert.ok(sizes[0].size < 16 * 2 ** 20 && sizes[1].size > 16 * 2 ** 20);
    assert.ok(sizes.every((f) => f.pieces));
    // What sha256sum prints of each part, and nothing else.
    const sha = (data) => createHash('sha256').update(data).digest('hex');
    const body = built.blobs.get(sizes[0].sha256);
    const printed = [body, body.subarray(0, 1500000), body.subarray(body.length - 3000000),
      body.subarray(2000000, 2100000)].map((p) => `${sha(p)}  -\n`).join('');
    assert.match(printed, checks[0].match);
    assert.doesNotMatch(`${printed}x`, checks[0].match);
    assert.doesNotMatch(printed, checks[1].match);
  });
});
