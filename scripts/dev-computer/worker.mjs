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
 * with its Workspace, its shells (just-bash, and the SLICC kernel with an image from its local
 * `IMAGES` bucket) and the gateway's `forward`, but no model, no inbox and no D1, so no
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
 * does at the agent's next message (`changeShell`), and stay until the next change. `/uploads`
 * puts files into the read-only uploads of the thread. Each `thread` is an agent of its own,
 * with its own files. `PUT /images/<key>` writes an object of the images bucket.
 */

import { ThreadAgent } from '../../src/agent/agent.js';
import { mountList } from '../../src/threadfiles.js';

export { WorkspaceServiceProxy } from '@cloudflare/computer';
export { SecretGateway } from '../../src/agent/gateway.js';

export class ComputerAgent extends ThreadAgent {
  /** Runs `command` as pi's bash tool does: what it answers, and what the command printed. */
  async exec({
    command, runtime, image, timeout, env,
  }) {
    await this.shell({ runtime, image });
    this.tools = ['computer'];
    const output = { stdout: '', stderr: '' };
    const started = Date.now();
    const res = await this.computer().exec(String(command), {
      ...(timeout ? { timeout: Number(timeout) } : {}),
      ...(env ? { env } : {}),
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
    };
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'PUT' && url.pathname.startsWith('/images/')) {
      await env.IMAGES.put(url.pathname.slice('/images/'.length), request.body);
      return new Response('ok\n');
    }
    if (request.method !== 'POST') {
      return new Response('POST { command, runtime?, image?, timeout?, env? }, /uploads { name: text } or /shell\n', { status: 405 });
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
      return Response.json(url.pathname === '/shell'
        ? await agent.shell(body) : await agent.exec(body));
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  },
};
