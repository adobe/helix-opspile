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

/* eslint-disable max-classes-per-file -- the box and its two outbound handlers, together */

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { PROGRAM } from './boxprogram.js';

/**
 * Browser boxes: the global `browser` MCP server (src/agent/globals.js), Cloudflare Browser
 * Run through Chrome DevTools MCP, as https://developers.cloudflare.com/browser-run/cdp/mcp-clients/
 * sets it up for a desktop client, here for each thread agent.
 *
 * A box is a Durable Object with a container (one per agent, named like it). The container
 * runs the Cloudflare-managed Node image, with no Internet; its program (src/agent/boxprogram.js)
 * fetches the pinned chrome-devtools-mcp and serves it over Streamable HTTP, which the agent's
 * MCP client reaches through this object. chrome-devtools-mcp connects to
 * `ws://browser-run.internal/`, which the box's outbound handler (BrowserBoxCdp) answers with a
 * Browser Run session of the Worker's BROWSER binding: no API token anywhere, and the browser
 * is the only thing the container talks to. The tarball comes through the other handler
 * (BrowserBoxRegistry), which fetches nothing but that one URL.
 *
 * A box stops ten minutes after its last request, and its browser session with it.
 */

export const CDM_VERSION = '1.12.0';
export const CDM_TARBALL = `http://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-${CDM_VERSION}.tgz`;
export const CDM_INTEGRITY = 'sha512-lAGpH0zXT1ZdaPefP1KK/MvxwihOlu7VGQ7p4wbhD9OhN17vUC4KWk/ImUYR9DE4s+7r4r0ySV4xr2OkTa7ZMA==';

const IMAGE = 'cloudflare/debian-trixie';
// 1/2 vCPU and 4 GiB: chrome-devtools-mcp, and Lighthouse when it audits, are Node processes
// of a few hundred megabytes.
const INSTANCE = 'standard-1';
const IDLE_MS = 10 * 60 * 1000;
const READY_MS = 90_000;
const PORT = 8080;
const CDP_HOST = 'browser-run.internal';
const REGISTRY_HOST = new URL(CDM_TARBALL).hostname;

export const CDM_ARGS = [
  `--wsEndpoint=ws://${CDP_HOST}/`,
  '--no-usage-statistics',
  '--no-performance-crux',
  '--no-file-navigations',
  '--redact-network-headers',
];

const sleep = (ms) => new Promise((r) => {
  setTimeout(r, ms);
});

/** The box's way to npm: the pinned tarball, over HTTPS, and nothing else. */
export class BrowserBoxRegistry extends WorkerEntrypoint {
  // eslint-disable-next-line class-methods-use-this
  fetch(request) {
    if (request.method !== 'GET' || request.url !== CDM_TARBALL) {
      return new Response('not allowed from a browser box', { status: 403 });
    }
    const url = new URL(request.url);
    url.protocol = 'https:';
    return fetch(url);
  }
}

/** The box's browser: a Browser Run session for each CDP connection, closed with it. */
export class BrowserBoxCdp extends WorkerEntrypoint {
  async fetch(request) {
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('a CDP WebSocket only', { status: 426 });
    }
    let session;
    let res;
    try {
      session = await this.env.BROWSER.launch({ keepAlive: IDLE_MS });
      res = await session.webSocket.fetch('https://browser-binding.invalid', {
        headers: { Upgrade: 'websocket' },
      });
    } catch (e) {
      // Browser Run's limits, say: chrome-devtools-mcp reports that it could not connect.
      console.log(JSON.stringify({ route: 'browser', cdp: 'failed', error: e.message }));
      if (session) {
        await this.env.BROWSER.closeSession(session.sessionId).catch(() => {});
      }
      return new Response(`Browser Run: ${e.message}`, { status: 503 });
    }
    if (!res.webSocket) {
      await this.env.BROWSER.closeSession(session.sessionId).catch(() => {});
      return new Response('Browser Run did not open a WebSocket', { status: 502 });
    }
    // The binding's socket, handed on as is, lacks the headers a WebSocket client expects:
    // pipe it through a pair of our own.
    const upstream = res.webSocket;
    upstream.accept();
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    let closed = false;
    const close = (to, e) => {
      try {
        to.close(e.code && e.code !== 1005 && e.code !== 1006 ? e.code : 1000, e.reason || '');
      } catch {
        // already closed
      }
      if (!closed) {
        closed = true;
        this.ctx.waitUntil(this.env.BROWSER.closeSession(session.sessionId).catch(() => {}));
      }
    };
    server.addEventListener('message', (e) => upstream.send(e.data));
    upstream.addEventListener('message', (e) => server.send(e.data));
    server.addEventListener('close', (e) => close(upstream, e));
    upstream.addEventListener('close', (e) => close(server, e));
    server.addEventListener('error', () => close(upstream, {}));
    upstream.addEventListener('error', () => close(server, {}));
    return new Response(null, { status: 101, webSocket: client });
  }
}

const rpcError = (status, message) => new Response(JSON.stringify({
  jsonrpc: '2.0', id: null, error: { code: -32000, message },
}), { status, headers: { 'content-type': 'application/json' } });

/** One agent's browser box. */
export class BrowserBox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.healthy = false;
    if (ctx.container && ctx.container.running) {
      ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(IDLE_MS).catch(() => {}));
    }
  }

  /** Starts the container, with its outbound handlers. */
  async start() {
    const c = this.ctx.container;
    c.start({
      image: IMAGE,
      instance: INSTANCE,
      enableInternet: false,
      entrypoint: ['node', '-e', PROGRAM],
      env: {
        CDM_TARBALL,
        CDM_INTEGRITY,
        CDM_ARGS: JSON.stringify(CDM_ARGS),
      },
    });
    this.healthy = false;
    const { BrowserBoxRegistry: registry, BrowserBoxCdp: cdp } = this.ctx.exports;
    await c.interceptOutboundHttp(REGISTRY_HOST, registry({ props: {} }));
    await c.interceptOutboundHttp(CDP_HOST, cdp({ props: {} }));
    await c.setInactivityTimeout(IDLE_MS);
    this.ctx.waitUntil(c.monitor().catch((e) => {
      console.log(JSON.stringify({ route: 'browser', box: 'exited', error: String(e && e.message) }));
    }).finally(() => {
      this.healthy = false;
    }));
  }

  /** Waits until the box answers; starts it first when it is not running. */
  async ready() {
    const c = this.ctx.container;
    if (!c) {
      throw new Error('browser boxes have no container in this deployment');
    }
    if (!c.running) {
      this.starting ??= this.start().finally(() => {
        this.starting = null;
      });
      await this.starting;
    }
    if (this.healthy) {
      return;
    }
    const until = Date.now() + READY_MS;
    const port = c.getTcpPort(PORT);
    let last = 'starting';
    while (Date.now() < until) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await port.fetch('http://box/health');
        // eslint-disable-next-line no-await-in-loop
        last = await res.text();
        if (res.status === 200) {
          this.healthy = true;
          return;
        }
        if (res.status === 500) {
          // eslint-disable-next-line no-await-in-loop
          await c.destroy(last).catch(() => {});
          throw new Error(last);
        }
      } catch (e) {
        if (e.message === last) {
          throw e;
        }
        last = e.message;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(400);
    }
    throw new Error(`the browser box did not start: ${last}`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') {
      return new Response('not found', { status: 404 });
    }
    if (request.method === 'GET') {
      return new Response(null, { status: 405 });
    }
    try {
      await this.ready();
    } catch (e) {
      return rpcError(503, e.message);
    }
    const port = this.ctx.container.getTcpPort(PORT);
    const res = await port.fetch(new Request('http://box/mcp', request))
      .catch((e) => rpcError(502, `the browser box did not answer: ${e.message}`));
    if (res.status >= 500) {
      this.healthy = false;
    }
    return res;
  }
}
