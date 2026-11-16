#!/usr/bin/env node
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

/**
 * `npm run computer:check`: what Node's tests cannot run, checked on an agent's computer in
 * local workerd. It starts `npm run computer:dev` (scripts/dev-computer/dev.mjs) on a free
 * port, runs commands in both shells, and stops it. Run it after updating
 * `@ai-ecoverse/slicc-kernel`, `@cloudflare/computer` or the images.
 *
 *   npm run computer:check
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import {
  after, before, describe, it,
} from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, 'localhost', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

let dev;
let origin;
let log = '';

before(async () => {
  const port = await freePort();
  origin = `http://localhost:${port}`;
  dev = spawn(process.execPath, [join(here, 'dev.mjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`computer:dev did not start:\n${log}`)), 120_000);
    const seen = (chunk) => {
      log += chunk;
      if (log.includes('image objects are in the local bucket')) {
        clearTimeout(timer);
        resolve();
      }
    };
    dev.stdout.on('data', seen);
    dev.stderr.on('data', seen);
    dev.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`computer:dev exited (${code}):\n${log}`));
    });
  });
}, { timeout: 130_000 });

after(() => {
  dev?.kill('SIGTERM');
});

/** POSTs `body` to `path` of the computer of `thread`: what it answers. */
async function post(thread, path, body) {
  const res = await fetch(`${origin}${path}?thread=${thread}`, {
    method: 'POST', body: JSON.stringify(body),
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json;
}

const ORIGINAL = 'line 1\nERROR boom\n';

/** Commands that change an upload, or the uploads, each of which the shell must refuse. */
const CHANGES = [
  'echo overwrite > uploads/sample.log',
  ': > uploads/sample.log',
  'echo more >> uploads/sample.log',
  'exec 3>uploads/sample.log',
  'echo new > uploads/new.log',
  'rm uploads/sample.log',
];

for (const runtime of ['just-bash', 'slicc-kernel']) {
  describe(`the uploads, in ${runtime}`, () => {
    const thread = `check-${randomUUID()}`;
    const run = (command) => post(thread, '/', { command, runtime });

    before(async () => {
      await post(thread, '/uploads', { 'sample.log': ORIGINAL });
    }, { timeout: 60_000 });

    for (const command of CHANGES) {
      it(`refuse \`${command}\`, with an exit code and an error`, async () => {
        const res = await run(command);
        assert.notEqual(res.exitCode, 0, JSON.stringify(res));
        assert.match(res.stderr, /read-only/i, JSON.stringify(res));
        assert.equal((await run('cat uploads/sample.log')).stdout, ORIGINAL);
      }, { timeout: 60_000 });
    }

    it('are read, and the files next to them written', async () => {
      const res = await run('cat uploads/sample.log && echo ok > notes.txt && cat notes.txt');
      assert.equal(res.exitCode, 0, JSON.stringify(res));
      assert.equal(res.stdout, `${ORIGINAL}ok\n`);
    }, { timeout: 60_000 });

    it('are read-only still once they change, which takes a new Workspace', async () => {
      await post(thread, '/uploads', { 'sample.log': ORIGINAL, 'other.log': 'other\n' });
      const res = await run('echo overwrite > uploads/other.log');
      assert.notEqual(res.exitCode, 0, JSON.stringify(res));
      assert.match(res.stderr, /read-only/i, JSON.stringify(res));
      const read = await run('cat uploads/other.log uploads/sample.log notes.txt');
      assert.equal(read.stdout, `other\n${ORIGINAL}ok\n`, JSON.stringify(read));
    }, { timeout: 60_000 });
  });
}
