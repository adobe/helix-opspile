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
 * The renderer Worker: Graphviz on the server. A Worker cannot compile WebAssembly from bytes,
 * so it runs dot as the agents' computers run their programs: a wasm build of it
 * (@ai-ecoverse/wasm-graphviz, the `graphviz` image of scripts/computer-images.mjs, from the
 * `IMAGES` bucket) in a SLICC kernel, whose processes are Dynamic Workers (`LOADER`). One
 * kernel per isolate, its root in memory, booted with the first layout and kept; a layout is
 * a run of `dot -K<engine> -T<format>` with the DOT on its stdin (src/graphviz/render.js).
 *
 * The inbox Worker reaches it through a service binding (`GRAPHVIZ`, the `Graphviz`
 * entrypoint) only: it has no public address. `layout` answers dot's output, `render` the FMC
 * drawing of src/fmc.js. With `DEV` set (scripts/dev-graphviz), it also answers HTTP, and
 * takes the images into its bucket, for local workerd.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  attachKernel, createCloudflareKernel, inProcessMount,
} from '@ai-ecoverse/slicc-kernel/cloudflare';
import {
  IMAGE_COMMANDS, IMAGE_ROOT, imageDriver, imageTree, readImage,
} from '../agent/image.js';
import { imageSpec } from '../agent/kernel.js';
import { layout, render } from './render.js';

// The image dot is in (scripts/computer-images.mjs). Not exported: a Worker's exports are its
// entrypoints.
const IMAGE = 'graphviz';

let booting = null;

/** The kernel of this isolate, booted once: the `graphviz` image mounted at IMAGE_ROOT. */
function kernel(env) {
  booting ??= (async () => {
    const started = Date.now();
    const image = await readImage(env.IMAGES, IMAGE);
    if (!image) {
      throw new Error(`there is no image ${IMAGE} in the images bucket (IMAGES)`);
    }
    const tree = await imageTree(env.IMAGES, image);
    const k = await createCloudflareKernel({
      loader: env.LOADER,
      commands: { append: [IMAGE_COMMANDS] },
      // dot needs no network: none is given.
      isolates: { memory: 96 * 2 ** 20 },
    });
    try {
      const client = await attachKernel(await k.connect(), { locks: null });
      try {
        await client.fs.mkdir(IMAGE_ROOT);
      } finally {
        await client.close();
      }
      await k.mount(inProcessMount(imageSpec(image, IMAGE_ROOT), imageDriver(env.IMAGES, tree)));
    } catch (e) {
      k.terminate();
      throw e;
    }
    console.log(JSON.stringify({
      route: 'graphviz', kernel: 'booted', digest: image.digest.slice(0, 12), ms: Date.now() - started,
    }));
    return k;
  })().catch((e) => {
    booting = null;
    throw e;
  });
  return booting;
}

/** A run of dot in the kernel; one that took too long ends the kernel, for the next boot. */
function runner(env) {
  return async (argv, options) => (await kernel(env)).run(argv, options);
}

async function settle(env, res) {
  if (res.timedOut && booting) {
    const k = await booting.catch(() => null);
    booting = null;
    k?.terminate();
  }
  return res;
}

/** The service binding's entrypoint (`GRAPHVIZ` in the inbox Worker). */
export class Graphviz extends WorkerEntrypoint {
  /** dot's output for `dot`: `{ ok, out, ms }` or `{ ok: false, error }`. */
  async layout(dot, options = {}) {
    return settle(this.env, await layout(runner(this.env), dot, options));
  }

  /** The FMC drawing of `dot`: `{ ok, svg, width, height, ms }` or `{ ok: false, error }`. */
  async render(dot, options = {}) {
    return settle(this.env, await render(runner(this.env), dot, options));
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

export default {
  async fetch(request, env) {
    if (!env.DEV) {
      return new Response('Not found\n', { status: 404 });
    }
    const url = new URL(request.url);
    // The images, into the local bucket (scripts/dev-graphviz/dev.mjs, as the dev computer's).
    if (url.pathname.startsWith('/images/')) {
      const key = url.pathname.slice('/images/'.length);
      if (request.method === 'PUT') {
        await env.IMAGES.put(key, request.body);
        return json({ ok: true });
      }
      const object = await env.IMAGES.get(key);
      return object ? new Response(object.body) : json({ error: 'no such object' }, 404);
    }
    if (request.method === 'POST' && ['/layout', '/render'].includes(url.pathname)) {
      const body = await request.json().catch(() => ({}));
      const run = runner(env);
      const res = url.pathname === '/layout' ? await layout(run, body.dot, body) : await render(run, body.dot, body);
      return json(await settle(env, res), res.ok ? 200 : 422);
    }
    return json({ usage: 'POST /layout or /render { dot, engine?, format? }' }, 405);
  },
};
