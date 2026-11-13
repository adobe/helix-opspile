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
import {
  mkdtemp, readdir, readFile, rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { computerEnv } from '../src/agent/computer.js';
import {
  DEFAULT_RUNTIME, gatewayFetch, installImage, isRuntime, overWorkspace, patientFs, runtimeFor,
  RUNTIMES, setTeamRuntime, teamRuntime, timedOut,
} from '../src/agent/kernel.js';
import { build, IMAGE, imagePackage } from '../scripts/computer-image.mjs';
import { d1 } from './d1.js';

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
  };
}

const pkg = (name, version, files) => ({
  name,
  manifest: JSON.stringify({ name, version }),
  files: Object.fromEntries(Object.entries(files)
    .map(([path, text]) => [path, new TextEncoder().encode(text).buffer])),
});

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

describe('the kernel\'s image', () => {
  it('is installed once, the manifest last, and again when a deploy brings another', async () => {
    const kernel = fakeKernel();
    const sed = pkg('@acme/sed', '1.0.0', { 'bin/sed': 'glue', 'bin/sed.wasm': 'wasm' });
    const awk = pkg('@acme/awk', '2.0.0', { 'bin/awk.wasm': 'wasm' });
    assert.equal(await installImage(kernel, [sed, awk]), 2);
    assert.deepEqual(kernel.wrote, [
      '/node_modules/@acme/sed/bin/sed',
      '/node_modules/@acme/sed/bin/sed.wasm',
      '/node_modules/@acme/sed/package.json',
      '/node_modules/@acme/awk/bin/awk.wasm',
      '/node_modules/@acme/awk/package.json',
    ]);
    assert.ok(kernel.have.get('/node_modules/@acme/sed/bin/sed.wasm') instanceof Uint8Array);
    assert.equal(kernel.have.get('/node_modules/@acme/sed/package.json'), sed.manifest);

    kernel.wrote.length = 0;
    assert.equal(await installImage(kernel, [sed, awk]), 0);
    assert.deepEqual(kernel.wrote, []);

    // Another version of one, and one that stopped half way (no manifest yet).
    const sed2 = pkg('@acme/sed', '1.0.1', { 'bin/sed': 'glue', 'bin/sed.wasm': 'wasm2' });
    kernel.have.delete('/node_modules/@acme/awk/package.json');
    assert.equal(await installImage(kernel, [sed2, awk]), 2);
    assert.equal(kernel.have.get('/node_modules/@acme/sed/package.json'), sed2.manifest);
    assert.equal(kernel.wrote.at(-1), '/node_modules/@acme/awk/package.json');
  });

  it('keeps of a package the commands asked for, and the files they need', () => {
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
    assert.deepEqual(wasi.paths, ['bin/rg.wasm']);
  });

  it('is built from the packages this repository pins, as the modules a Worker imports', async () => {
    const names = IMAGE.map((p) => p.name);
    assert.equal(new Set(names).size, names.length);
    const { dependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    for (const name of names) {
      assert.match(dependencies[name] || '', /^\d/, `${name} is pinned to one version`);
    }
    const out = await mkdtemp(join(tmpdir(), 'computer-image-'));
    try {
      const built = await build({ out });
      assert.equal(built.packages, IMAGE.length);
      const index = await readFile(join(out, 'index.js'), 'utf8');
      const imports = [...index.matchAll(/^import (f\d+) from '\.\/(f\d+\.bin)';$/gm)];
      assert.equal(imports.length, built.files);
      assert.deepEqual((await readdir(out)).sort(), ['index.js', ...imports.map((m) => m[2])].sort());
      // The shell, its tools and curl, each with the program a Dynamic Worker loads.
      for (const file of ['bin/bash.wasm', 'bin/coreutils.wasm', 'bin/grep.wasm', 'bin/curl.wasm']) {
        assert.match(index, new RegExp(`"${file}": f\\d+,`));
      }
      assert.match(index, /name: "@ai-ecoverse\/wasm-bash",\n {4}manifest: "\{/);
      assert.match(index, /export const PACKAGES = \[/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
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
