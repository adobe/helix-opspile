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
 * The browser of an agent's computer: Cloudflare Browser Run, over the Chrome DevTools
 * Protocol. The kernel serves CDP to its programs at `ws://127.0.0.1:9222` (`SLICC_CDP_URL`),
 * where `playwright-cli` and `curlwright` (@ai-ecoverse/slicc-cdp, the `browser` layer of
 * scripts/computer-images.mjs) find it, and hands every connection to the hook of an attached
 * client (`serveCdp`, src/agent/agent.js). The hook here opens a WebSocket of the Worker's to
 * Browser Run with BROWSER_RUN_TOKEN, which never enters the computer.
 *
 * Chromium is the default: one browser session per computer, made with the first connection
 * (`POST …/devtools/browser`, kept alive KEEP_ALIVE_MS after the last one), so that each
 * command of `playwright-cli`, a process and a connection of its own, finds the tabs the one
 * before left. A program that asks for `runtime=kitesurf` gets Kitesurf instead, Browser Run's
 * browser that runs on Workers, without a container: a new one for each connection, since it
 * keeps no session.
 *
 * This file needs no Workers runtime but the WebSocket a `fetch` with `Upgrade: websocket`
 * answers, so it is tested in Node with a fake.
 */

export const KEEP_ALIVE_MS = 10 * 60 * 1000;
export const RUNTIMES = ['chromium', 'kitesurf'];
const API = 'https://api.cloudflare.com/client/v4/accounts';
const ACCOUNT = /^[0-9a-f]{32}$/;

/** The account Browser Run runs in: BROWSER_RUN_ACCOUNT, else the Worker's own. */
export const browserAccount = (env) => String(
  (env && (env.BROWSER_RUN_ACCOUNT || env.CLOUDFLARE_ACCOUNT_ID)) || '',
).trim();

/** Whether this deployment's computers can have a browser: a token and an account. */
export function browserConfigured(env) {
  return Boolean(env && env.BROWSER_RUN_TOKEN && ACCOUNT.test(browserAccount(env)));
}

/** Whether an image (a manifest of src/agent/image.js) has the browser's programs. */
export const hasBrowser = (image) => Boolean(image && Array.isArray(image.commands)
  && image.commands.includes('playwright-cli'));

const toText = (data) => (typeof data === 'string' ? data : new TextDecoder().decode(data));

/**
 * A Worker's WebSocket as the kernel's CdpConnection: `send`, `onmessage`, `onclose`, `close`.
 * What arrives before the kernel set `onmessage` waits for it.
 */
export function cdpConnection(ws) {
  let onmessage = null;
  let closed = false;
  const waiting = [];
  const conn = {
    send(message) {
      if (!closed) {
        ws.send(message);
      }
    },
    get onmessage() {
      return onmessage;
    },
    set onmessage(fn) {
      onmessage = fn;
      while (onmessage && waiting.length) {
        onmessage(waiting.shift());
      }
    },
    onclose: null,
    close() {
      if (!closed) {
        closed = true;
        try {
          ws.close(1000, 'done');
        } catch {
          // already closing
        }
      }
    },
  };
  ws.addEventListener('message', (event) => {
    const text = toText(event.data);
    if (onmessage) {
      onmessage(text);
    } else {
      waiting.push(text);
    }
  });
  const ended = (reason) => {
    const first = !closed;
    closed = true;
    if (first || conn.onclose) {
      conn.onclose?.(reason);
      conn.onclose = null;
    }
  };
  ws.addEventListener('close', (event) => ended(event.reason || `closed ${event.code}`));
  ws.addEventListener('error', () => ended('Browser Run closed the connection'));
  return conn;
}

/**
 * The CDP host of a computer: `{ hook, close, session }`. `hook` is the kernel's `CdpHook`;
 * `close` ends the Chromium session (a terminated kernel's), and `session` says which it is.
 * `fetch` is the Worker's (a test's fake). `store` (`get`, `put`, `delete`: the agent's
 * storage) keeps the session's id, so that the computer finds its tabs again after its object
 * was evicted, while the session lives.
 */
export function browserHost(env, {
  fetch = globalThis.fetch, keepAlive = KEEP_ALIVE_MS, store = null,
} = {}) {
  const root = `${API}/${browserAccount(env)}/browser-run/devtools/browser`;
  const auth = { authorization: `Bearer ${env.BROWSER_RUN_TOKEN}` };
  // The session in use: `{ id }`, a promise of its id.
  let session = null;

  async function failure(res, what) {
    const body = await res.text().catch(() => '');
    let message = body.slice(0, 300);
    try {
      const data = JSON.parse(body);
      message = (data.errors || []).map((e) => e.message).join('; ') || data.message || message;
    } catch {
      // not JSON
    }
    return new Error(`Browser Run ${what}: ${res.status}${message ? ` ${message}` : ''}`);
  }

  async function socket(url) {
    const res = await fetch(url, { headers: { upgrade: 'websocket', ...auth } });
    if (res.status !== 101 || !res.webSocket) {
      throw await failure(res, 'refused the connection');
    }
    res.webSocket.accept();
    return cdpConnection(res.webSocket);
  }

  async function acquire() {
    const res = await fetch(`${root}?keep_alive=${keepAlive}`, { method: 'POST', headers: auth });
    if (!res.ok) {
      throw await failure(res, 'gave no browser');
    }
    const { sessionId } = await res.json();
    if (!sessionId) {
      throw new Error('Browser Run gave no browser: no session id');
    }
    console.log(JSON.stringify({ route: 'agent', browser: 'session', session: sessionId }));
    await store?.put(sessionId);
    return sessionId;
  }

  /**
   * A connection to the computer's Chromium session, made (or taken from the store) first. A
   * session that refuses it has ended (its keep-alive ran out): once more, with a new one.
   */
  async function chromium(again = true) {
    if (!session) {
      // Set before anything is awaited, so that connections at once share one session.
      const made = {
        id: (async () => (store && await store.get()) || acquire())(),
      };
      session = made;
      made.id.catch(() => {
        if (session === made) {
          session = null;
        }
      });
    }
    const current = session;
    const id = await current.id;
    try {
      return await socket(`${root}/${id}`);
    } catch (e) {
      if (session === current) {
        session = null;
        await store?.delete();
      }
      if (!again) {
        throw e;
      }
      return chromium(false);
    }
  }

  async function open(runtime) {
    const name = runtime || 'chromium';
    if (name === 'kitesurf') {
      return socket(`${root}?browser=kitesurf`);
    }
    if (name !== 'chromium') {
      throw new Error(`no browser runtime ${name}: ${RUNTIMES.join(' (the default) or ')}`);
    }
    return chromium();
  }

  return {
    /** The kernel's CdpHook: a connection, or why there is none (the program gets a 502). */
    async hook({ runtime } = {}) {
      try {
        return await open(runtime);
      } catch (e) {
        console.log(JSON.stringify({ route: 'agent', browser: 'failed', error: e.message }));
        throw e;
      }
    },
    async session() {
      return session ? session.id.catch(() => null) : null;
    },
    async close() {
      const id = session && await session.id.catch(() => null);
      session = null;
      await store?.delete();
      if (id) {
        await fetch(`${root}/${id}`, { method: 'DELETE', headers: auth }).catch(() => {});
      }
    },
  };
}
