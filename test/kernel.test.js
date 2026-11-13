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
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { computerEnv } from '../src/agent/computer.js';
import {
  commandsOf, DEFAULT_IMAGE, installImage, isImageName, listImages, readImage,
} from '../src/agent/image.js';
import {
  DEFAULT_RUNTIME, gatewayFetch, isRuntime, overWorkspace, patientFs, runtimeFor, RUNTIMES,
  setTeamImage, setTeamRuntime, shellFor, teamImage, teamRuntime, timedOut,
} from '../src/agent/kernel.js';
import {
  bucketOf, build, IMAGES, imagePackage, indexOf, missingFrom, objectsOf, toolNames,
} from '../scripts/computer-images.mjs';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

// Made-up teams, packages and hosts only.

const fsError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

/** A kernel's `readFile` and `writeFile` over a Map, with the order files were written in. */
function fakeKernel(files = {}) {
  const have = new Map(Object.entries(files));
  const wrote = [];
  return {
    have,
    wrote,
    async readFile(path) {
      if (!have.has(path)) {
        throw fsError('ENOENT', path);
      }
      const data = have.get(path);
      return typeof data === 'string' ? new TextEncoder().encode(data) : data;
    },
    async writeFile(path, data) {
      have.set(path, data);
      wrote.push(path);
    },
    /** As the agent removes a package: the directory and what is in it. */
    remove: async (path) => {
      [...have.keys()].filter((k) => k.startsWith(`${path}/`)).forEach((k) => have.delete(k));
    },
  };
}

const sha = (text) => createHash('sha256').update(text).digest('hex');

/** A package of an image's manifest, with its files' blobs for the bucket. */
function pkg(name, version, files) {
  return {
    name,
    version,
    manifest: JSON.stringify({ name, version }),
    commands: Object.keys(files).map((path) => path.split('/').pop().replace('.wasm', '')),
    files: Object.entries(files)
      .map(([path, text]) => ({ path, sha256: sha(text), size: text.length })),
    blobs: Object.fromEntries(Object.values(files).filter(Boolean)
      .map((text) => [`blobs/${sha(text)}`, text])),
  };
}

/** An image's manifest of `packages` (pkg), and a bucket with it and its blobs. */
function image(name, packages, bucket = fakeBucket()) {
  const manifest = {
    v: 1,
    name,
    title: name,
    description: `the ${name} image`,
    tools: packages.flatMap((p) => p.commands).join(', '),
    digest: sha(JSON.stringify(packages.map((p) => [p.name, p.version, p.files]))),
    bytes: 1,
    packages: packages.map((p) => ({
      name: p.name, version: p.version, manifest: p.manifest, commands: p.commands, files: p.files,
    })),
  };
  for (const p of packages) {
    for (const [key, text] of Object.entries(p.blobs)) {
      bucket.objects.set(key, { body: text, options: {}, version: 'v' });
    }
  }
  bucket.objects.set(`images/${name}.json`, { body: JSON.stringify(manifest), options: {}, version: 'v' });
  return { manifest, bucket };
}

describe('the computer\'s shells', () => {
  it('are just-bash unless the team has another, and one this deployment knows', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'edge', name: 'Edge' }] });
    const env = { DB };
    assert.equal(DEFAULT_RUNTIME, 'just-bash');
    assert.deepEqual(RUNTIMES.map((r) => r.runtime), ['just-bash', 'slicc-kernel']);
    assert.equal(isRuntime('slicc-kernel'), true);
    assert.equal(isRuntime('docker'), false);
    assert.deepEqual(await teamRuntime(env, 'helix'), { runtime: 'just-bash' });
    assert.equal(await runtimeFor(env, { team: 'helix' }), 'just-bash');
    assert.equal(await runtimeFor(env, { team: null }), 'just-bash');
    assert.equal(await runtimeFor({}, { team: 'helix' }), 'just-bash');

    const chosen = await setTeamRuntime(env, { team: 'helix', runtime: 'slicc-kernel', by: 'Ada' });
    assert.equal(chosen.runtime, 'slicc-kernel');
    assert.equal(chosen.by, 'Ada');
    assert.deepEqual(await teamRuntime(env, 'helix'), chosen);
    assert.equal(await runtimeFor(env, { team: 'helix' }), 'slicc-kernel');
    // Another team's is its own.
    assert.equal(await runtimeFor(env, { team: 'edge' }), 'just-bash');

    await setTeamRuntime(env, { team: 'helix', runtime: 'just-bash', by: 'Bo' });
    assert.equal((await teamRuntime(env, 'helix')).by, 'Bo');
    assert.equal(DB.rows('SELECT COUNT(*) AS n FROM agent_tool_options')[0].n, 1);

    // What a later deployment wrote, read after a rollback.
    DB.sqlite.exec("UPDATE agent_tool_options SET value = 'firecracker'");
    assert.deepEqual(await teamRuntime(env, 'helix'), { runtime: 'just-bash' });
  });

  it('have an image with the kernel, the base one unless the team has another', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'edge', name: 'Edge' }] });
    const env = { DB };
    assert.equal(DEFAULT_IMAGE, 'base');
    assert.deepEqual(await teamImage(env, 'helix'), { image: 'base' });
    // just-bash has no image, whatever was chosen.
    await setTeamImage(env, { team: 'helix', image: 'data', by: 'Ada' });
    assert.deepEqual(await shellFor(env, { team: 'helix' }), { runtime: 'just-bash' });
    assert.equal((await teamImage(env, 'helix')).by, 'Ada');
    await setTeamRuntime(env, { team: 'helix', runtime: 'slicc-kernel', by: 'Ada' });
    assert.deepEqual(await shellFor(env, { team: 'helix' }), { runtime: 'slicc-kernel', image: 'data' });
    assert.equal(await runtimeFor(env, { team: 'helix' }), 'slicc-kernel');
    // The two are rows of their own.
    assert.deepEqual(DB.rows('SELECT name, value FROM agent_tool_options ORDER BY name'), [
      { name: 'image', value: 'data' }, { name: 'runtime', value: 'slicc-kernel' },
    ]);
    await setTeamRuntime(env, { team: 'edge', runtime: 'slicc-kernel', by: 'Bo' });
    assert.deepEqual(await shellFor(env, { team: 'edge' }), { runtime: 'slicc-kernel', image: 'base' });
    // A name no image can have is the default.
    DB.sqlite.exec("UPDATE agent_tool_options SET value = '../etc' WHERE name = 'image'");
    assert.deepEqual(await teamImage(env, 'helix'), { image: 'base' });
    assert.equal(isImageName('data-2'), true);
    assert.equal(isImageName('Data'), false);
    assert.equal(isImageName(''), false);
  });

  it('say when they stopped a run whose time was up', () => {
    // just-bash says 124 and nothing else.
    assert.equal(timedOut('just-bash', 124, 0, 5), true);
    assert.equal(timedOut(undefined, 124, 0, 5), true);
    assert.equal(timedOut('just-bash', 143, 9, 5), false);
    // The kernel ends bash with SIGTERM, then SIGKILL; a command can end that way by itself.
    assert.equal(timedOut('slicc-kernel', 143, 5.1, 5), true);
    assert.equal(timedOut('slicc-kernel', 137, 10.2, 5), true);
    assert.equal(timedOut('slicc-kernel', 143, 0.4, 5), false);
    assert.equal(timedOut('slicc-kernel', 124, 9, 5), false);
    assert.equal(timedOut('slicc-kernel', 0, 9, 5), false);
  });

  it('report a run the kernel stopped as a timeout, by its time', async () => {
    const ws = (exitCode, ms) => async () => ({
      runtime: {
        exec: async () => ({
          result: async () => {
            await new Promise((resolve) => {
              setTimeout(resolve, ms);
            });
            return { exitCode, stdout: '', stderr: '' };
          },
        }),
      },
    });
    const runtime = () => 'slicc-kernel';
    const stopped = await computerEnv(ws(143, 30), { runtime }).exec('sleep 9', { timeout: 0.02 });
    assert.equal(stopped.ok, false);
    assert.equal(stopped.error.code, 'timeout');
    // `kill $$` in a command that had time left is the command's own end.
    const own = await computerEnv(ws(143, 0), { runtime }).exec('kill $$', { timeout: 30 });
    assert.deepEqual(own, { ok: true, value: { exitCode: 143 } });
    const none = await computerEnv(ws(143, 0), { runtime }).exec('kill $$', {});
    assert.deepEqual(none, { ok: true, value: { exitCode: 143 } });
  });
});

describe('a kernel\'s image, from the bucket', () => {
  const sed = pkg('@acme/sed', '1.0.0', { 'bin/sed': '', 'bin/sed.wasm': 'sed program' });
  const awk = pkg('@acme/awk', '2.0.0', { 'bin/awk.wasm': 'awk program' });
  const rg = pkg('@acme/rg', '3.0.0', { 'bin/rg.wasm': 'rg program' });

  it('is installed once, each package\'s manifest last, and what is there is left alone', async () => {
    const { manifest, bucket } = image('base', [sed, awk]);
    const kernel = fakeKernel();
    const first = await installImage(kernel, bucket, manifest, kernel);
    assert.deepEqual(first, { wrote: 2, removed: 0 });
    assert.deepEqual(kernel.wrote, [
      '/node_modules/@acme/sed/bin/sed',
      '/node_modules/@acme/sed/bin/sed.wasm',
      '/node_modules/@acme/sed/package.json',
      '/node_modules/@acme/awk/bin/awk.wasm',
      '/node_modules/@acme/awk/package.json',
      '/node_modules/.opspile-image.json',
    ]);
    assert.equal(new TextDecoder().decode(kernel.have.get('/node_modules/@acme/sed/bin/sed.wasm')), 'sed program');
    // A glue the image has as an empty file is written empty, and asks the bucket for nothing.
    assert.equal(kernel.have.get('/node_modules/@acme/sed/bin/sed').length, 0);
    assert.equal(kernel.have.get('/node_modules/@acme/sed/package.json'), sed.manifest);
    assert.deepEqual(JSON.parse(kernel.have.get('/node_modules/.opspile-image.json')), {
      digest: manifest.digest, packages: ['@acme/sed', '@acme/awk'],
    });

    // The same image again reads its state and nothing else.
    kernel.wrote.length = 0;
    const silent = { get: async () => assert.fail('asked the bucket') };
    const again = await installImage(kernel, silent, manifest, kernel);
    assert.deepEqual(again, { wrote: 0, removed: 0 });
    assert.deepEqual(kernel.wrote, []);
  });

  it('follows a change: new packages come, new versions replace, others go', async () => {
    const bucket = fakeBucket();
    const base = image('base', [sed, awk], bucket).manifest;
    const data = image('data', [sed, awk, rg], bucket).manifest;
    const kernel = fakeKernel();
    await installImage(kernel, bucket, base, kernel);
    kernel.wrote.length = 0;
    assert.deepEqual(await installImage(kernel, bucket, data, kernel), { wrote: 1, removed: 0 });
    assert.deepEqual(kernel.wrote, [
      '/node_modules/@acme/rg/bin/rg.wasm',
      '/node_modules/@acme/rg/package.json',
      '/node_modules/.opspile-image.json',
    ]);
    // Back to the smaller one: what only the other had goes, and nothing is written again.
    kernel.wrote.length = 0;
    assert.deepEqual(await installImage(kernel, bucket, base, kernel), { wrote: 0, removed: 1 });
    assert.deepEqual(kernel.wrote, ['/node_modules/.opspile-image.json']);
    assert.equal(kernel.have.has('/node_modules/@acme/rg/package.json'), false);
    assert.equal(kernel.have.has('/node_modules/@acme/sed/package.json'), true);

    // A deploy brings another version of one, and one stopped half way (no manifest yet).
    const sed2 = pkg('@acme/sed', '1.0.1', { 'bin/sed': '', 'bin/sed.wasm': 'sed program 2' });
    const next = image('base', [sed2, awk], bucket).manifest;
    kernel.have.delete('/node_modules/@acme/awk/package.json');
    assert.deepEqual(await installImage(kernel, bucket, next, kernel), { wrote: 2, removed: 0 });
    assert.equal(kernel.have.get('/node_modules/@acme/sed/package.json'), sed2.manifest);
    assert.equal(new TextDecoder().decode(kernel.have.get('/node_modules/@acme/sed/bin/sed.wasm')), 'sed program 2');

    // Where nothing can be removed, what should go is remembered for the next change.
    const lone = fakeKernel();
    await installImage(lone, bucket, data);
    assert.deepEqual(await installImage(lone, bucket, next), { wrote: 1, removed: 0 });
    assert.deepEqual(JSON.parse(lone.have.get('/node_modules/.opspile-image.json')).packages, ['@acme/sed', '@acme/awk', '@acme/rg']);
    assert.deepEqual(await installImage(lone, bucket, data, lone), { wrote: 1, removed: 0 });
  });

  it('fails, and leaves no state, on a blob that is missing or is not what its name says', async () => {
    const { manifest, bucket } = image('base', [sed, awk]);
    const kernel = fakeKernel({ '/node_modules/.opspile-image.json': 'not json' });
    bucket.objects.delete(`blobs/${sha('awk program')}`);
    await assert.rejects(installImage(kernel, bucket, manifest, kernel), /has no blobs\/[0-9a-f]{64} \(bin\/awk\.wasm\)/);
    assert.equal(kernel.have.get('/node_modules/.opspile-image.json'), 'not json');
    // The package before it is whole, and not written again by the next boot.
    assert.equal(kernel.have.get('/node_modules/@acme/sed/package.json'), sed.manifest);
    assert.equal(kernel.have.has('/node_modules/@acme/awk/package.json'), false);
    bucket.objects.set(`blobs/${sha('awk program')}`, { body: 'another program', options: {}, version: 'v' });
    await assert.rejects(installImage(kernel, bucket, manifest, kernel), /is not the file it names/);
    bucket.objects.set(`blobs/${sha('awk program')}`, { body: 'awk program', options: {}, version: 'v' });
    const mended = await installImage(kernel, bucket, manifest, kernel);
    assert.deepEqual(mended, { wrote: 1, removed: 0 });
  });

  it('is read from the bucket by name, and listed by its index', async () => {
    const { manifest, bucket } = image('base', [sed, awk]);
    assert.deepEqual(await readImage(bucket, 'base'), manifest);
    assert.deepEqual(commandsOf(manifest), ['awk', 'sed']);
    assert.equal(await readImage(bucket, 'data'), null);
    assert.equal(await readImage(bucket, '../base'), null);
    assert.equal(await readImage(undefined, 'base'), null);
    // A manifest of a later format is not one this Worker installs.
    bucket.objects.set('images/next.json', { body: JSON.stringify({ ...manifest, v: 2 }), options: {}, version: 'v' });
    assert.equal(await readImage(bucket, 'next'), null);

    assert.deepEqual(await listImages(bucket), []);
    assert.deepEqual(await listImages(undefined), []);
    const index = indexOf([manifest, { ...manifest, name: 'Bad Name' }]);
    bucket.objects.set('images/index.json', { body: JSON.stringify(index), options: {}, version: 'v' });
    assert.deepEqual(await listImages(bucket), [{
      name: 'base', title: 'base', description: 'the base image', digest: manifest.digest, bytes: 1,
    }]);
    bucket.objects.set('images/index.json', { body: 'not json', options: {}, version: 'v' });
    assert.deepEqual(await listImages(bucket), []);
  });
});

describe('the images this repository builds', () => {
  it('keeps of a package the commands asked for, the files they need, and which are glue', () => {
    const manifest = {
      name: '@acme/utils',
      version: '1.2.3',
      license: 'MIT',
      description: 'left out',
      scripts: { postinstall: 'left out' },
      slicc: {
        abi: 'emscripten',
        env: { TERMINFO: 'share/terminfo' },
        commands: {
          rev: { glue: 'bin/rev', wasm: 'bin/rev.wasm' },
          look: { glue: 'bin/look', wasm: 'bin/look.wasm' },
          zipinfo: { glue: 'bin/unzip', wasm: 'bin/unzip.wasm', argv0: 'zipinfo' },
          unzip: { glue: 'bin/unzip', wasm: 'bin/unzip.wasm' },
        },
      },
    };
    const all = imagePackage(manifest);
    assert.deepEqual(all.paths, [
      'bin/look', 'bin/look.wasm', 'bin/rev', 'bin/rev.wasm', 'bin/unzip', 'bin/unzip.wasm',
    ]);
    assert.deepEqual(all.glue, ['bin/look', 'bin/rev', 'bin/unzip']);
    assert.deepEqual(Object.keys(all.manifest), ['name', 'version', 'license', 'slicc']);
    const some = imagePackage(manifest, { commands: ['rev', 'zipinfo'] });
    assert.deepEqual(some.paths, ['bin/rev', 'bin/rev.wasm', 'bin/unzip', 'bin/unzip.wasm']);
    assert.deepEqual(Object.keys(some.manifest.slicc.commands), ['rev', 'zipinfo']);
    assert.deepEqual(some.manifest.slicc.env, manifest.slicc.env);
    assert.throws(() => imagePackage(manifest, { commands: ['rev', 'jq'] }), /no command jq/);
    // A WASI program has no glue.
    const wasi = imagePackage({
      name: '@acme/rg', version: '1', slicc: { abi: 'wasi', commands: { rg: { wasm: 'bin/rg.wasm' } } },
    });
    assert.deepEqual([wasi.paths, wasi.glue], [['bin/rg.wasm'], []]);
  });

  it('are built from the packages it pins, by content, with what the agent is told checked', async () => {
    const { devDependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    for (const { name } of IMAGES.flatMap((i) => i.packages)) {
      assert.match(devDependencies[name] || '', /^\d/, `${name} is pinned to one version`);
    }
    const built = await build();
    assert.deepEqual(built.images.map((i) => i.name), ['base', 'data']);
    assert.ok(IMAGES.every((i) => isImageName(i.name) && i.title && i.description));
    const [base, data] = built.images;
    assert.equal(base.v, 1);
    assert.match(base.digest, /^[0-9a-f]{64}$/);
    assert.notEqual(base.digest, data.digest);
    // The images share the files they both have, and each is in the bucket once.
    const hashes = (i) => i.packages.flatMap((p) => p.files).filter((f) => f.size)
      .map((f) => f.sha256);
    assert.ok(hashes(base).every((h) => hashes(data).includes(h)));
    assert.deepEqual([...built.blobs.keys()].sort(), [...new Set(hashes(data))].sort());
    for (const [hash, body] of built.blobs) {
      assert.equal(sha(body), hash);
    }
    assert.equal(base.bytes, base.packages.flatMap((p) => p.files).reduce((n, f) => n + f.size, 0));
    // An Emscripten program comes with its glue as an empty file, and its wasm whole.
    const bash = base.packages.find((p) => p.name === '@ai-ecoverse/wasm-bash');
    assert.deepEqual(bash.commands, ['bash']);
    assert.deepEqual(bash.files.map((f) => [f.path, f.size > 0]), [['bin/bash', false], ['bin/bash.wasm', true]]);
    assert.equal(JSON.parse(bash.manifest).slicc.commands.bash.wasm, 'bin/bash.wasm');
    // What the agent is told names commands the image has, and the second image more of them.
    for (const i of built.images) {
      assert.deepEqual(toolNames(i.tools).filter((w) => !commandsOf(i).includes(w)), []);
    }
    assert.ok(toolNames(base.tools).length > 20);
    assert.ok(['rg', 'sqlite3', 'strings'].every((c) => commandsOf(data).includes(c)
      && !commandsOf(base).includes(c)));
    await assert.rejects(build({ images: [{ ...IMAGES[0], tools: 'cat, jq' }] }), /tells the agent of jq/);

    // A kernel installs what was built, from a bucket with its objects.
    const objects = objectsOf(built);
    const bucket = fakeBucket(Object.fromEntries(objects.map((o) => [o.key, o.body])));
    const digests = (list) => list.map((i) => [i.name, i.digest]);
    assert.deepEqual(digests(await listImages(bucket)), digests(built.images));
    const kernel = fakeKernel();
    const installed = await installImage(kernel, bucket, await readImage(bucket, 'base'), kernel);
    assert.deepEqual(installed, { wrote: base.packages.length, removed: 0 });
    assert.ok(kernel.have.get('/node_modules/@ai-ecoverse/wasm-bash/bin/bash.wasm').length > 1e6);
  });

  it('are uploaded as the objects the bucket lacks: blobs first, the index last', async () => {
    const built = await build();
    const objects = objectsOf(built);
    const keys = objects.map((o) => o.key);
    assert.equal(keys.at(-1), 'images/index.json');
    assert.deepEqual(keys.slice(-3, -1), ['images/base.json', 'images/data.json']);
    assert.ok(keys.slice(0, -3).every((k) => /^blobs\/[0-9a-f]{64}$/.test(k)));
    assert.deepEqual(JSON.parse(objects.at(-1).body), indexOf(built.images));
    // An empty bucket lacks them all, and one that fails to answer too.
    assert.equal((await missingFrom(objects, async () => null)).length, objects.length);
    const failing = async () => {
      throw new Error('404');
    };
    assert.equal((await missingFrom(objects, failing)).length, objects.length);
    // One that has them all lacks none.
    const have = new Map(objects.map((o) => [o.key, String(o.body)]));
    const read = async (key) => have.get(key) ?? null;
    assert.deepEqual(await missingFrom(objects, read), []);
    // A change of one image: its manifest, the index, and the blobs no manifest there names.
    const [base] = built.images;
    const changed = { ...base, digest: 'x'.repeat(64), packages: base.packages.slice(1) };
    have.set('images/base.json', `${JSON.stringify(changed)}\n`);
    have.set('images/data.json', `${JSON.stringify({ ...built.images[1], packages: [] })}\n`);
    const missing = (await missingFrom(objects, read)).map((o) => o.key);
    const bash = base.packages[0].files.filter((f) => f.size).map((f) => `blobs/${f.sha256}`);
    assert.ok(bash.length && bash.every((k) => missing.includes(k)));
    assert.ok(missing.includes('images/base.json') && missing.includes('images/data.json'));
    assert.equal(missing.includes('images/index.json'), false);
    assert.equal(missing.includes(`blobs/${base.packages[1].files.find((f) => f.size).sha256}`), false);
    assert.equal(bucketOf('prod'), 'helix-opspile-images');
    assert.equal(bucketOf('stage'), 'helix-opspile-images-stage');
  });
});

describe('the kernel\'s way to the network', () => {
  it('hands the gateway a Request, without what only a page\'s fetch takes', async () => {
    const seen = [];
    const send = async (request) => {
      seen.push(request);
      return new Response('ok');
    };
    const fetch = gatewayFetch(send);
    const res = await fetch('http://api.example.com/v1?x=1', {
      method: 'POST',
      headers: new Headers({ authorization: 'Bearer opspile-secret-ACME_KEY' }),
      body: 'a=1',
      redirect: 'manual',
      credentials: 'omit',
      mode: 'cors',
    });
    assert.equal(await res.text(), 'ok');
    const [request] = seen;
    assert.ok(request instanceof Request);
    assert.equal(request.url, 'http://api.example.com/v1?x=1');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'manual');
    assert.equal(request.headers.get('authorization'), 'Bearer opspile-secret-ACME_KEY');
    assert.equal(await request.text(), 'a=1');
    await fetch('http://example.com/');
    assert.equal(seen[1].method, 'GET');
  });
});

describe('the kernel on a Workspace', () => {
  /** A Workspace's fs with a read-only mount: no change to a directory the mount is in. */
  function workspaceFs({ dirs = [], files = [], readOnly = [] } = {}) {
    const made = [];
    return {
      made,
      name: 'fs',
      async stat(path) {
        if (dirs.includes(path)) {
          return { isDirectory: true, isFile: false };
        }
        if (files.includes(path)) {
          return { isDirectory: false, isFile: true };
        }
        throw fsError('ENOENT', path);
      },
      async mkdir(path, options) {
        const root = readOnly.find((r) => r === path || r.startsWith(`${path}/`));
        if (root) {
          throw fsError('EROFS', `read-only mount at ${root}: cannot modify: ${path}`);
        }
        if (files.includes(path)) {
          throw fsError('EEXIST', path);
        }
        made.push([path, options]);
      },
      async readdir() {
        return [this.name];
      },
    };
  }

  it('leaves a directory that is there alone, where the kernel makes its mount point', async () => {
    const fs = workspaceFs({ dirs: ['/workspace'], readOnly: ['/workspace/uploads'] });
    await assert.rejects(fs.mkdir('/workspace', { recursive: true }), { code: 'EROFS' });
    const patient = patientFs(fs);
    await patient.mkdir('/workspace', { recursive: true });
    assert.deepEqual(fs.made, []);
    // One that is not there is made, and a plain mkdir is the Workspace's to answer.
    await patient.mkdir('/workspace/out', { recursive: true });
    await patient.mkdir('/workspace/new');
    assert.deepEqual(fs.made, [['/workspace/out', { recursive: true }], ['/workspace/new', undefined]]);
    await assert.rejects(patient.mkdir('/workspace'), { code: 'EROFS' });
    // Everything else is the Workspace's own, on the Workspace.
    assert.deepEqual(await patient.readdir('/'), ['fs']);
    assert.equal(patient.name, 'fs');
  });

  it('lets a file in the way, and a failing stat, come through', async () => {
    const fs = workspaceFs({ files: ['/workspace'] });
    await assert.rejects(patientFs(fs).mkdir('/workspace', { recursive: true }), { code: 'EEXIST' });
    const broken = {
      stat: async () => {
        throw fsError('EIO', 'gone');
      },
      mkdir: async () => undefined,
    };
    await assert.rejects(patientFs(broken).mkdir('/workspace', { recursive: true }), { code: 'EIO' });
  });

  it('connects the kernel\'s backend to the Workspace through it', async () => {
    const fs = workspaceFs({ dirs: ['/workspace'], readOnly: ['/workspace/uploads'] });
    const host = { fs, db: 'db' };
    const backend = overWorkspace({
      id: 'slicc',
      type: 'slicc-kernel',
      callable: false,
      description: 'GNU bash',
      async connect(h) {
        await h.fs.mkdir('/workspace', { recursive: true });
        return { db: h.db, close: async () => undefined };
      },
    });
    assert.equal(backend.id, 'slicc');
    assert.equal(backend.type, 'slicc-kernel');
    assert.equal(backend.callable, false);
    assert.equal(backend.description, 'GNU bash');
    assert.equal((await backend.connect(host)).db, 'db');
    assert.deepEqual(fs.made, []);
  });
});
