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
 * `npm run computer:dev`: an agent's computer in local workerd (scripts/dev-computer/worker.mjs),
 * with the images of scripts/computer-images.mjs in its local bucket.
 *
 *   npm run computer:dev              # http://localhost:8788
 *   PORT=9000 npm run computer:dev
 *
 * It starts `wrangler dev` and, once that answers, puts the objects of the images its
 * `IMAGES` bucket lacks there through the Worker itself (`syncImages`, scripts/dev-computer/
 * check.mjs), as `npm run computer:images` puts them into a deployment's.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, objectsOf } from '../computer-images.mjs';
import { syncImages } from './check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || '8788';
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

const built = await build();
await ready();
await syncImages(origin, built, { token: process.env.COMPUTER_TOKEN, log: () => {} });
console.log(`computer:dev: ${objectsOf(built).length} image objects are in the local bucket; try\n`
  + `  curl ${origin} -d '{"command":"uname -a; ls /usr/bin | wc -l"}'\n`
  + `  npm run computer:check -- ${origin}`);
