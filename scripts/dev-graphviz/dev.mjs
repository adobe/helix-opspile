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
 * `npm run graphviz:dev`: the renderer Worker (src/graphviz/worker.js) in local workerd, with
 * the `graphviz` image of scripts/computer-images.mjs in its local bucket, as
 * `npm run computer:dev` runs an agent's computer.
 *
 *   npm run graphviz:dev              # http://localhost:8789
 *   PORT=9000 npm run graphviz:dev
 *   npm run graphviz:check -- http://localhost:8789
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, IMAGES } from '../computer-images.mjs';
import { syncImages } from '../dev-computer/check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || '8789';
const origin = `http://localhost:${port}`;

const child = spawn(join(here, '..', '..', 'node_modules', '.bin', 'wrangler'), [
  'dev', '-c', join(here, 'wrangler.json'), '--port', port, ...process.argv.slice(2),
], { stdio: 'inherit' });
child.once('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

async function ready() {
  for (let tries = 0; tries < 240; tries += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fetch(origin);
      return;
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
    }
  }
  throw new Error(`wrangler dev did not answer on ${origin}`);
}

// Only the renderer's image: dot, and nothing else.
const built = await build({ images: IMAGES.filter((i) => i.name === 'graphviz') });
await ready();
await syncImages(origin, built, { log: () => {} });
console.log('graphviz:dev: the graphviz image is in the local bucket; try\n'
  + `  curl ${origin}/render -d '{"dot":"digraph { a -> b }"}'\n`
  + `  npm run graphviz:check -- ${origin}`);
