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
 * An agent's computer by itself, in local workerd: the real ThreadAgent (src/agent/agent.js)
 * with its Workspace, its shells (just-bash, and the SLICC kernel with an image mounted from its
 * local `IMAGES` bucket) and the gateway's `forward`, but no model, no inbox and no D1, so no
 * secrets. For trying a shell, an image, and a new version of the kernel or of its programs,
 * which Node's tests cannot run. scripts/dev-computer/dev.mjs starts it and fills the bucket
 * with the images of scripts/computer-images.mjs.
 *
 *   npm run computer:dev                     # http://localhost:8788
 *   curl localhost:8788 -d '{"command":"uname -a","runtime":"slicc-kernel"}'
 *   curl localhost:8788 -d '{"command":"sqlite3 --version","image":"data"}'
 *   curl localhost:8788 -d '{"command":"sleep 9","timeout":2}'
 *   curl 'localhost:8788?thread=other' -d '{"command":"ls -la"}'
 *   curl localhost:8788/uploads -d '{"a.log":"line 1\nERROR boom\n"}'
 *   curl localhost:8788/shell -d '{}'        # what the agent is told its shell has
 *
 * `runtime` changes the computer's shell and `image` its kernel's image, as a team's choice
 * does at the agent's next message (`changeShell`), and stay until the next change; `cache`
 * (`{ mib, fileMib }`) sizes the isolate's image cache (src/agent/image.js). `/uploads`
 * puts files into the read-only uploads of the thread. `/probe { mib }` allocates that much in
 * the agent's object and lets it go (how much memory is free), and `/drop` ends its kernel.
 * Each `thread` is an agent of its own, with its own files. With the secret `GITHUB_TOKEN`,
 * git sends it to github.com, through the gateway (`devSecrets`, `devEnv`). `PUT /images/<key>`
 * writes an object of the images bucket, and `GET /images/<key>` reads it (404 when there is
 * none). `GET /health` answers `ok`.
 *
 * Deployed (`--env stage`, .github/workflows/computer-stage.yml), it is a shell on the
 * internet: `REQUIRE_TOKEN` is set there, and every request needs the secret `COMPUTER_TOKEN`
 * in `x-opspile-computer-token`. Without the secret, it answers nothing but 403.
 */

/* eslint-disable max-classes-per-file */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { ThreadAgent } from '../../src/agent/agent.js';
import { forgetImages, imageReads, sizeImageCache } from '../../src/agent/image.js';
import { forward } from '../../src/agent/secrets.js';
import { mountList } from '../../src/threadfiles.js';
import { devEnv, devSecrets } from './secrets.mjs';

export { WorkspaceServiceProxy } from '@cloudflare/computer';

/** The Worker's SecretGateway (src/agent/gateway.js), with the dev computer's secrets. */
export class SecretGateway extends WorkerEntrypoint {
  async fetch(request) {
    return forward(this.env, this.ctx.props || {}, request, { secrets: devSecrets(this.env) });
  }
}

const MiB = 1024 * 1024;

export class ComputerAgent extends ThreadAgent {
  /** The kernel's programs reach the network with the dev computer's secrets. */
  kernelFetch(request) {
    return forward(this.env, { agent: this.name }, request, { secrets: devSecrets(this.env) });
  }

  /**
   * Runs `command` as pi's bash tool does: what it answers, what the command printed, and what
   * the isolate read of the images bucket and keeps (`images`, src/agent/image.js).
   * `cache` (`{ mib, fileMib }`, `{}` for the Worker's own) empties what the isolate keeps and
   * sizes it first.
   */
  async exec({
    command, runtime, image, timeout, env, cache,
  }) {
    if (cache) {
      // A cache of its own: what the isolate kept for another agent is forgotten first.
      forgetImages();
      sizeImageCache({
        ...(cache.mib ? { bytes: cache.mib * MiB } : {}),
        ...(cache.fileMib ? { fileMax: cache.fileMib * MiB } : {}),
      });
    }
    await this.shell({ runtime, image });
    this.tools = ['computer'];
    const output = { stdout: '', stderr: '' };
    const started = Date.now();
    const vars = { ...devEnv(this.env), ...(env || {}) };
    const res = await this.computer().exec(String(command), {
      ...(timeout ? { timeout: Number(timeout) } : {}),
      ...(Object.keys(vars).length ? { env: vars } : {}),
      onOutput: (chunk, context, info) => {
        output[info.stream] += chunk;
      },
    });
    return {
      runtime: this.runtime,
      ...(this.runtime === 'slicc-kernel' ? { image: this.image } : {}),
      ms: Date.now() - started,
      ...(res.ok ? res.value : { error: res.error.code, message: res.error.message }),
      ...output,
      sqliteBytes: this.ctx.storage.sql.databaseSize,
      images: imageReads(),
    };
  }

  /**
   * How much more this object's isolate holds: `mib` MiB, allocated and written, then let go.
   * Past its memory limit the isolate is reset, and the request fails: so the largest `mib`
   * that answers is what was free (check.mjs `measure`).
   */
  async probe({ mib }) {
    const held = [];
    for (let i = 0; i < Number(mib); i += 1) {
      held.push(new Uint8Array(MiB).fill((i % 255) + 1));
    }
    // Held a while: the runtime counts an isolate's memory now and then, not at each allocation.
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
    const sqliteBytes = this.ctx.storage.sql.databaseSize;
    return {
      mib: held.reduce((n, b) => n + (b[0] ? 1 : 0), 0), images: imageReads(), sqliteBytes,
    };
  }

  /** Ends the kernel, as when the agent's object lets it go: the next command boots another. */
  async drop() {
    await this.changeShell(this.runtime, this.image);
    return { dropped: true, images: imageReads() };
  }

  /** Changes the shell or the image, if asked: what the agent is told of it then. */
  async shell({ runtime, image } = {}) {
    const before = await this.currentRuntime();
    const next = runtime || (image ? 'slicc-kernel' : before);
    if (next !== before || (image && image !== this.image)) {
      await this.changeShell(next, image || this.image);
    }
    return this.shellInfo();
  }

  /** Puts `files` (`{ name: text }`) into the thread's uploads, as copies of attachments. */
  async upload(files) {
    const copies = [];
    for (const [name, text] of Object.entries(files)) {
      const key = `dev/${name}`;
      // eslint-disable-next-line no-await-in-loop
      const stored = await this.env.FILES.put(key, String(text));
      copies.push({
        key, name, size: stored.size, expires: Date.now() + 24 * 60 * 60 * 1000,
      });
    }
    await this.setUploads(mountList(copies));
    return this.ctx.storage.get('uploads');
  }
}

/** Whether `given` is `token`, in a time that does not tell how much of it matched. */
function sameToken(given, token) {
  const a = new TextEncoder().encode(String(given || ''));
  const b = new TextEncoder().encode(String(token || ''));
  // eslint-disable-next-line no-bitwise
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i += 1) {
    // eslint-disable-next-line no-bitwise
    diff |= (a[i] || 0) ^ b[i];
  }
  return b.length > 0 && diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.REQUIRE_TOKEN
      && !sameToken(request.headers.get('x-opspile-computer-token'), env.COMPUTER_TOKEN)) {
      return new Response('forbidden\n', { status: 403 });
    }
    if (url.pathname === '/health') {
      return new Response('ok\n');
    }
    if (url.pathname.startsWith('/images/')) {
      const key = url.pathname.slice('/images/'.length);
      if (request.method === 'PUT') {
        await env.IMAGES.put(key, request.body);
        return new Response('ok\n');
      }
      if (request.method === 'GET') {
        const object = await env.IMAGES.get(key);
        return object ? new Response(object.body) : new Response('not found\n', { status: 404 });
      }
    }
    if (request.method !== 'POST') {
      return new Response('POST { command, runtime?, image?, timeout?, env?, cache? }, /uploads { name: text }, /shell, /probe { mib } or /drop\n', { status: 405 });
    }
    const thread = url.searchParams.get('thread') || 'dev';
    const agent = env.AGENTS.get(env.AGENTS.idFromName(`dev:${thread}`));
    try {
      // What the SDK's getAgentByName does (src/agent/stub.js).
      // eslint-disable-next-line no-underscore-dangle
      await agent.__unsafe_ensureInitialized();
      const body = await request.json();
      if (url.pathname === '/uploads') {
        return Response.json(await agent.upload(body));
      }
      if (url.pathname === '/probe') {
        return Response.json(await agent.probe(body));
      }
      if (url.pathname === '/drop') {
        return Response.json(await agent.drop());
      }
      return Response.json(url.pathname === '/shell'
        ? await agent.shell(body) : await agent.exec(body));
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  },
};
