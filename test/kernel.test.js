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
import { beforeEach, describe, it } from 'node:test';
import { computerEnv } from '../src/agent/computer.js';
import {
  commandsOf, DEFAULT_IMAGE, forgetImages, IMAGE_COMMANDS, IMAGE_ROOT, imageDriver, imageTree,
  isImageName, listImages, readImage,
} from '../src/agent/image.js';
import {
  DEFAULT_RUNTIME, gatewayFetch, imageMount, isRuntime, overWorkspace, patientFs, runtimeFor,
  RUNTIMES, setTeamImage, setTeamRuntime, shellFor, teamImage, teamRuntime, timedOut,
} from '../src/agent/kernel.js';
import {
  bucketOf, build, buildLayer, IMAGES, imagePackage, indexOf, layerNames, LAYERS, missingFrom,
  objectsOf, toolNames,
} from '../scripts/computer-images.mjs';
import { d1 } from './d1.js';
import { fakeBucket } from './fakes.js';

// Made-up teams, packages and hosts only.

const fsError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

const sha = (text) => createHash('sha256').update(text).digest('hex');
const put = (bucket, key, body) => bucket.objects.set(key, { body, options: {}, version: 'v' });

/**
 * Puts a layer of `files` (`{ path: text }`; a text of 40 characters or more is a blob, a
 * shorter one is in the layer itself) into `bucket`: what an image's manifest says of it.
 */
function layer(bucket, name, files) {
  const list = Object.entries(files).map(([path, text]) => {
    const blob = text.length >= 40;
    if (blob) {
      put(bucket, `blobs/${sha(text)}`, text);
    }
    return {
      path,
      mode: path.endsWith('.json') ? 0o444 : 0o555,
      size: text.length,
      ...(blob ? { sha256: sha(text) } : { data: Buffer.from(text).toString('base64') }),
    };
  });
  const body = `${JSON.stringify({ v: 1, name, files: list })}\n`;
  put(bucket, `layers/${sha(body)}.json`, body);
  return { name, digest: sha(body), bytes: list.reduce((n, f) => n + f.size, 0) };
}

/** Puts an image of `layers` (from `layer`), bottom first, into `bucket`: its manifest. */
function image(bucket, name, layers, commands = []) {
  const manifest = {
    v: 2,
    name,
    title: name,
    description: `the ${name} image`,
    tools: commands.join(', '),
    commands,
    digest: sha(layers.map((l) => l.digest).join('\n')),
    bytes: layers.reduce((n, l) => n + l.bytes, 0),
    layers,
  };
  put(bucket, `images/${name}.json`, JSON.stringify(manifest));
  return manifest;
}

const PROGRAM = 'a program of forty characters or more, a blob';
const utf8 = (bytes) => new TextDecoder().decode(bytes);

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
  beforeEach(() => forgetImages());

  /** A bucket with a shell layer, a text layer over it, and the images `base` and `data`. */
  function stack() {
    const bucket = fakeBucket();
    const shell = layer(bucket, 'shell', {
      'node_modules/@acme/sh/package.json': '{"name":"@acme/sh"}',
      'node_modules/@acme/sh/bin/sh': '',
      'node_modules/@acme/sh/bin/sh.wasm': PROGRAM,
      'etc/motd': 'from the shell layer',
    });
    const text = layer(bucket, 'text', {
      'node_modules/@acme/sed/package.json': '{"name":"@acme/sed"}',
      'node_modules/@acme/sed/bin/sed.wasm': `${PROGRAM}: sed`,
      'etc/motd': 'from the text layer',
    });
    return {
      bucket,
      shell,
      text,
      base: image(bucket, 'base', [shell], ['sh']),
      data: image(bucket, 'data', [shell, text], ['sed', 'sh']),
    };
  }

  it('is its layers merged from the bottom up: the upper layer\'s file is the image\'s', async () => {
    const { bucket, base, data } = stack();
    const lower = await imageTree(bucket, base);
    assert.deepEqual([...lower.files.keys()].sort(), [
      '/etc/motd',
      '/node_modules/@acme/sh/bin/sh',
      '/node_modules/@acme/sh/bin/sh.wasm',
      '/node_modules/@acme/sh/package.json',
    ]);
    assert.equal(utf8(lower.files.get('/etc/motd').bytes), 'from the shell layer');
    const tree = await imageTree(bucket, data);
    assert.equal(utf8(tree.files.get('/etc/motd').bytes), 'from the text layer');
    assert.deepEqual([...tree.dirs.get('/')].sort(), ['etc', 'node_modules']);
    assert.deepEqual([...tree.dirs.get('/node_modules/@acme')].sort(), ['sed', 'sh']);
    // A small file is in its layer, a large one a blob by its hash, a glue an empty file.
    assert.deepEqual(tree.files.get('/node_modules/@acme/sh/bin/sh.wasm'), {
      size: PROGRAM.length, mode: 0o555, sha256: sha(PROGRAM),
    });
    assert.equal(tree.files.get('/node_modules/@acme/sh/bin/sh').bytes.length, 0);
    assert.equal(tree.files.get('/node_modules/@acme/sh/package.json').mode, 0o444);
    // The same image again is the tree this isolate kept, and asks the bucket for nothing.
    const silent = { get: async () => assert.fail('asked the bucket') };
    assert.equal(await imageTree(silent, data), tree);
    assert.equal(await imageTree(silent, base), lower);
  });

  it('fails on a layer that is missing, or is not what its name says', async () => {
    const { bucket, data, text } = stack();
    const key = `layers/${text.digest}.json`;
    const { body } = bucket.objects.get(key);
    bucket.objects.delete(key);
    await assert.rejects(imageTree(bucket, data), /has no layers\/[0-9a-f]{64}\.json \(text\)/);
    put(bucket, key, body.replace('"mode":365', '"mode":511'));
    await assert.rejects(imageTree(bucket, data), /is not the layer it names \(text\)/);
    put(bucket, key, body);
    assert.equal((await imageTree(bucket, data)).files.size, 6);
  });

  it('is a read-only file system: listings, attributes, and files read from the bucket', async () => {
    const { bucket, data } = stack();
    const gets = [];
    const counting = {
      get: (key) => {
        gets.push(key);
        return bucket.get(key);
      },
    };
    const { handlers, capabilities } = imageDriver(counting, await imageTree(bucket, data));
    assert.equal(capabilities.readonly, true);
    assert.equal(capabilities.ranges, true);
    assert.deepEqual(await handlers.getattr('/'), {
      kind: 'directory', size: 0, mtime: 0, mode: 0o555,
    });
    assert.deepEqual(await handlers.getattr('/node_modules/@acme/sh/bin/sh.wasm'), {
      kind: 'file', size: PROGRAM.length, mtime: 0, mode: 0o555,
    });
    await assert.rejects(handlers.getattr('/nope'), { code: 'ENOENT' });
    assert.deepEqual(await handlers.readdir('/'), [
      { name: 'etc', kind: 'directory' }, { name: 'node_modules', kind: 'directory' },
    ]);
    assert.deepEqual(await handlers.readdir('/node_modules/@acme/sh/bin'), [
      { name: 'sh', kind: 'file' }, { name: 'sh.wasm', kind: 'file' },
    ]);
    await assert.rejects(handlers.readdir('/etc/motd'), { code: 'ENOTDIR' });
    await assert.rejects(handlers.readdir('/nope'), { code: 'ENOENT' });

    // Nothing was asked of the bucket yet: a file is read when a program reads it.
    assert.deepEqual(gets, []);
    const fh = await handlers.open('/node_modules/@acme/sh/bin/sh.wasm', {});
    assert.equal(utf8(await handlers.read(fh, 0, 9)), 'a program');
    assert.equal(utf8(await handlers.read(fh, 10, 1000)), PROGRAM.slice(10));
    assert.equal((await handlers.read(fh, 5000, 10)).length, 0);
    assert.deepEqual(gets, [`blobs/${sha(PROGRAM)}`]);
    // What is read is a copy: the kernel may take its buffer.
    const first = await handlers.read(fh, 0, 1000);
    first.fill(0);
    assert.equal(utf8(await handlers.read(fh, 0, 1000)), PROGRAM);
    await handlers.release(fh);
    await assert.rejects(handlers.read(fh, 0, 1), { code: 'EBADF' });
    // A small file and a glue come from the layer itself.
    const motd = await handlers.open('/etc/motd', {});
    assert.equal(utf8(await handlers.read(motd, 0, 100)), 'from the text layer');
    const glue = await handlers.open('/node_modules/@acme/sh/bin/sh', {});
    assert.equal((await handlers.read(glue, 0, 100)).length, 0);
    await assert.rejects(handlers.open('/etc', {}), { code: 'EISDIR' });
    await assert.rejects(handlers.open('/nope', {}), { code: 'ENOENT' });
    // Another agent's kernel in this isolate reads the blob from memory.
    const other = imageDriver(counting, await imageTree(bucket, data)).handlers;
    const again = await other.open('/node_modules/@acme/sh/bin/sh.wasm', {});
    assert.equal(utf8(await other.read(again, 0, 1000)), PROGRAM);
    assert.equal(gets.length, 1);
    assert.deepEqual(await handlers.statfs(), { bsize: 4096, blocks: 5, bfree: 0 });
  });

  it('refuses every change', async () => {
    const { bucket, data } = stack();
    const { handlers } = imageDriver(bucket, await imageTree(bucket, data));
    const refused = { code: 'EROFS' };
    for (const flags of [{ write: true }, { create: true }, { truncate: true }]) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(handlers.open('/etc/motd', flags), refused);
    }
    await assert.rejects(handlers.open('/etc/new', { create: true, write: true }), refused);
    await assert.rejects(handlers.write(1, 0, new Uint8Array(1)), refused);
    await assert.rejects(handlers.mkdir('/etc/d'), refused);
    await assert.rejects(handlers.rmdir('/etc'), refused);
    await assert.rejects(handlers.unlink('/etc/motd'), refused);
    await assert.rejects(handlers.rename('/etc/motd', '/etc/motd2'), refused);
    await assert.rejects(handlers.setattr('/etc/motd', { mode: 0o777 }), refused);
  });

  it('fails a read of a blob that is missing, or is not what its name says', async () => {
    const { bucket, data } = stack();
    const { handlers } = imageDriver(bucket, await imageTree(bucket, data));
    const key = `blobs/${sha(PROGRAM)}`;
    const fh = await handlers.open('/node_modules/@acme/sh/bin/sh.wasm', {});
    bucket.objects.delete(key);
    await assert.rejects(handlers.read(fh, 0, 10), { code: 'EIO', message: /has no blobs\// });
    put(bucket, key, `${PROGRAM} and more`);
    await assert.rejects(handlers.read(fh, 0, 10), { code: 'EIO', message: /is not the file it names/ });
    // Neither was kept: the read works once the bucket has the file.
    put(bucket, key, PROGRAM);
    assert.equal(utf8(await handlers.read(fh, 0, 9)), 'a program');
  });

  it('keeps the blobs it read up to a limit, the least recently used going first', async () => {
    const bucket = fakeBucket();
    const big = (c) => c.repeat(12 * 1024 * 1024);
    const files = Object.fromEntries(['a', 'b', 'c'].map((c) => [`bin/${c}`, big(c)]));
    const manifest = image(bucket, 'big', [layer(bucket, 'big', files)]);
    const gets = [];
    const counting = {
      get: (key) => {
        gets.push(key);
        return bucket.get(key);
      },
    };
    const { handlers } = imageDriver(counting, await imageTree(bucket, manifest));
    const first = async (name) => {
      const fh = await handlers.open(`/bin/${name}`, {});
      const [byte] = await handlers.read(fh, 0, 1);
      await handlers.release(fh);
      return String.fromCharCode(byte);
    };
    assert.equal(await first('a'), 'a');
    assert.equal(await first('b'), 'b');
    // a is used again, so the third file pushes b out, not a.
    assert.equal(await first('a'), 'a');
    assert.equal(await first('c'), 'c');
    assert.equal(gets.length, 3);
    assert.equal(await first('a'), 'a');
    assert.equal(gets.length, 3);
    assert.equal(await first('b'), 'b');
    assert.equal(gets.length, 4);
  });

  it('is mounted read-only, at the place the kernel looks for its commands', async () => {
    const { bucket, data } = stack();
    const driver = imageDriver(bucket, await imageTree(bucket, data));
    const spec = imageMount(data, IMAGE_ROOT, driver);
    assert.deepEqual([spec.type, spec.source, spec.target, spec.options], [
      'image', `data@${data.digest.slice(0, 12)}`, '/opt/image', { ro: '' },
    ]);
    assert.equal(IMAGE_COMMANDS, '/opt/image/node_modules');
    // The kernel finds the driver under the key its bundles share (its inProcessMount).
    const inProcess = spec[Symbol.for('slicc-kernel.mount.in-process')];
    assert.equal(inProcess.handlers, driver.handlers);
    assert.equal(inProcess.capabilities, driver.capabilities);
    assert.equal(typeof inProcess.served, 'function');
  });

  it('is read from the bucket by name, and listed by its index', async () => {
    const { bucket, base } = stack();
    assert.deepEqual(await readImage(bucket, 'base'), base);
    assert.deepEqual(commandsOf(base), ['sh']);
    assert.equal(await readImage(bucket, 'gpu'), null);
    assert.equal(await readImage(bucket, '../base'), null);
    assert.equal(await readImage(undefined, 'base'), null);
    // A manifest of another format is not one this Worker mounts.
    put(bucket, 'images/old.json', JSON.stringify({ ...base, v: 1 }));
    assert.equal(await readImage(bucket, 'old'), null);

    assert.deepEqual(await listImages(bucket), []);
    assert.deepEqual(await listImages(undefined), []);
    put(bucket, 'images/index.json', JSON.stringify(indexOf([base, { ...base, name: 'Bad Name' }])));
    assert.deepEqual(await listImages(bucket), [{
      name: 'base',
      title: 'base',
      description: 'the base image',
      digest: base.digest,
      bytes: base.bytes,
      layers: ['shell'],
    }]);
    put(bucket, 'images/index.json', 'not json');
    assert.deepEqual(await listImages(bucket), []);
    put(bucket, 'images/index.json', JSON.stringify({ v: 1, images: [{ name: 'base' }] }));
    assert.deepEqual(await listImages(bucket), []);
  });
});

describe('the images this repository builds', () => {
  beforeEach(() => forgetImages());

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

  it('stack their layers on those of the image they are from', () => {
    const images = [
      { name: 'base', layers: ['shell', 'text'] },
      { name: 'data', from: 'base', layers: ['data'] },
      { name: 'more', from: 'data', layers: ['js', 'docs'] },
      { name: 'lost', from: 'gone', layers: [] },
      { name: 'loop', from: 'pool', layers: [] },
      { name: 'pool', from: 'loop', layers: [] },
    ];
    assert.deepEqual(layerNames(images[0], images), ['shell', 'text']);
    assert.deepEqual(layerNames(images[2], images), ['shell', 'text', 'data', 'js', 'docs']);
    assert.throws(() => layerNames(images[3], images), /is from gone, which there is none of/);
    assert.throws(() => layerNames(images[4], images), /is from itself/);
    // The real ones: data is base and one layer more, and every package is in one layer.
    const [base, data] = IMAGES;
    assert.deepEqual(layerNames(data), [...layerNames(base), 'data']);
    const packages = Object.values(LAYERS).flat().map((p) => p.name);
    assert.equal(new Set(packages).size, packages.length);
  });

  it('are built from the packages it pins, by content, with what the agent is told checked', async () => {
    const { devDependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    for (const { name } of Object.values(LAYERS).flat()) {
      assert.match(devDependencies[name] || '', /^\d/, `${name} is pinned to one version`);
    }
    const built = await build();
    assert.deepEqual(built.images.map((i) => i.name), ['base', 'data']);
    assert.ok(IMAGES.every((i) => isImageName(i.name) && i.title && i.description));
    const [base, data] = built.images;
    assert.equal(base.v, 2);
    assert.deepEqual(base.layers.map((l) => l.name), ['shell', 'text', 'archive', 'net', 'js']);
    // The second image is the first one's layers, the same ones, and one more.
    assert.deepEqual(data.layers.slice(0, 5), base.layers);
    assert.deepEqual(data.layers.map((l) => l.name).slice(5), ['data']);
    assert.notEqual(base.digest, data.digest);
    assert.equal(data.bytes, base.bytes + data.layers[5].bytes);
    // A layer and a blob are named by what they are.
    for (const l of built.layers.values()) {
      assert.equal(sha(l.body), l.digest);
      assert.deepEqual(JSON.parse(l.body), l.layer);
    }
    for (const [hash, body] of built.blobs) {
      assert.equal(sha(body), hash);
    }
    // An Emscripten program comes with its glue as an empty file, its wasm as a blob, and
    // its manifest in the layer.
    const shell = built.layers.get('shell').layer.files
      .filter((f) => f.path.startsWith('node_modules/@ai-ecoverse/wasm-bash/'));
    assert.deepEqual(shell.map((f) => [f.path.split('/').pop(), f.mode, Boolean(f.sha256), f.size > 0]), [
      ['bash', 0o555, false, false], ['bash.wasm', 0o555, true, true], ['package.json', 0o444, false, true],
    ]);
    const manifest = JSON.parse(Buffer.from(shell[2].data, 'base64').toString());
    assert.equal(manifest.slicc.commands.bash.wasm, 'bin/bash.wasm');
    // What the agent is told names commands the image has, and the second image more of them.
    for (const i of built.images) {
      assert.deepEqual(toolNames(i.tools).filter((w) => !commandsOf(i).includes(w)), []);
    }
    assert.ok(toolNames(base.tools).length > 20);
    assert.ok(commandsOf(base).includes('jq'));
    // A WASI program has no glue: the JavaScript interpreter is its wasm and its manifest.
    const js = built.layers.get('js').layer.files.map((f) => [f.path, Boolean(f.sha256)]);
    assert.deepEqual(js, [
      ['node_modules/@ai-ecoverse/wasi-quickjs/bin/qjs.wasm', true],
      ['node_modules/@ai-ecoverse/wasi-quickjs/package.json', false],
    ]);
    assert.ok(commandsOf(base).includes('qjs'));
    assert.ok(['rg', 'sqlite3', 'strings'].every((c) => commandsOf(data).includes(c)
      && !commandsOf(base).includes(c)));
    await assert.rejects(build({ images: [{ ...IMAGES[0], tools: 'cat, rg' }] }), /tells the agent of rg/);
    await assert.rejects(build({ images: [{ ...IMAGES[0], layers: ['gpu'] }] }), /has a layer gpu, which there is none of/);

    // A kernel's file system serves what was built, from a bucket with its objects.
    const objects = objectsOf(built);
    const bucket = fakeBucket(Object.fromEntries(objects.map((o) => [o.key, o.body])));
    const digests = (list) => list.map((i) => [i.name, i.digest]);
    assert.deepEqual(digests(await listImages(bucket)), digests(built.images));
    assert.deepEqual((await listImages(bucket))[1].layers, ['shell', 'text', 'archive', 'net', 'js', 'data']);
    const tree = await imageTree(bucket, await readImage(bucket, 'data'));
    const { handlers } = imageDriver(bucket, tree);
    const packages = await handlers.readdir('/node_modules/@ai-ecoverse');
    assert.equal(packages.length, Object.values(LAYERS).flat().length);
    const fh = await handlers.open('/node_modules/@ai-ecoverse/wasm-bash/bin/bash.wasm', {});
    assert.deepEqual([...await handlers.read(fh, 0, 4)], [0, 0x61, 0x73, 0x6d]);
    const { size } = await handlers.getattr('/node_modules/@ai-ecoverse/wasm-bash/bin/bash.wasm');
    assert.ok(size > 1e6);
  });

  it('are in one layer what they are in another: a layer\'s digest follows its files alone', async () => {
    const modules = new URL('../node_modules', import.meta.url).pathname;
    const one = await buildLayer('net', LAYERS.net, modules);
    const same = await buildLayer('net', LAYERS.net, modules);
    assert.equal(one.digest, same.digest);
    assert.deepEqual(one.commands, ['curl']);
    const other = await buildLayer('net', [...LAYERS.net, ...LAYERS.archive], modules);
    assert.notEqual(one.digest, other.digest);
    const paths = other.layer.files.map((f) => f.path);
    assert.deepEqual(paths, [...paths].sort());
  });

  it('are uploaded as the objects the bucket lacks: blobs, layers, manifests, then the index', async () => {
    const built = await build();
    const objects = objectsOf(built);
    const keys = objects.map((o) => o.key);
    const kinds = keys.map((k) => k.split('/')[0]);
    assert.deepEqual([...new Set(kinds)], ['blobs', 'layers', 'images']);
    assert.equal(keys.at(-1), 'images/index.json');
    assert.deepEqual(keys.slice(-3, -1), ['images/base.json', 'images/data.json']);
    assert.equal(kinds.filter((k) => k === 'layers').length, 6);
    assert.deepEqual(JSON.parse(objects.at(-1).body), indexOf(built.images));
    // An empty bucket lacks them all, and one that fails to answer too.
    assert.equal((await missingFrom(objects, async () => null)).length, objects.length);
    const failing = async () => {
      throw new Error('404');
    };
    assert.equal((await missingFrom(objects, failing)).length, objects.length);
    // One that has them all lacks none, and is asked for no blob.
    const have = new Map(objects.map((o) => [o.key, String(o.body)]));
    const asked = [];
    const read = async (key) => {
      asked.push(key);
      return have.get(key) ?? null;
    };
    assert.deepEqual(await missingFrom(objects, read), []);
    assert.equal(asked.some((k) => k.startsWith('blobs/')), false);
    // A bucket without one layer lacks it and its blobs, and no other layer's.
    const data = objects.find((o) => o.key === `layers/${built.layers.get('data').digest}.json`);
    have.delete(data.key);
    have.set('images/data.json', 'an older manifest');
    const missing = (await missingFrom(objects, read)).map((o) => o.key);
    assert.deepEqual(missing, [...[...data.blobs].sort(), data.key, 'images/data.json']);
    assert.equal(data.blobs.length, 3);
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
