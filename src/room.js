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

import { DurableObject } from 'cloudflare:workers';
import { advanceWatermark } from './threads.js';

/** Read events are written to D1 at most this long after they happen. */
export const FLUSH_MS = 2000;

/**
 * One room per ops team. Inboxes of the team's members connect over WebSocket (with
 * hibernation); a read event from one member is fanned out to everyone at once and
 * written to D1 in batches. The normalizer posts new activity and inferred reads to
 * `/notify`, which is only fanned out (it has already written D1).
 */
export class TeamRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  broadcast(event) {
    const data = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // closed sockets are dropped by the runtime
      }
    }
  }

  async read(person, thread, at) {
    if (!person || typeof thread !== 'string' || typeof at !== 'string') {
      return;
    }
    const key = `read:${person}:${thread}`;
    const pending = await this.ctx.storage.get(key);
    if (!pending || at > pending.at) {
      await this.ctx.storage.put(key, { person, thread, at });
    }
    this.broadcast({
      type: 'read', person, thread, at,
    });
    if (!(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
    }
  }

  async alarm() {
    const pending = await this.ctx.storage.list({ prefix: 'read:' });
    for (const [key, r] of pending) {
      // eslint-disable-next-line no-await-in-loop
      await advanceWatermark(this.env.DB, r.person, r.thread, r.at, 'open');
      // eslint-disable-next-line no-await-in-loop
      await this.ctx.storage.delete(key);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      const person = Number(request.headers.get('x-opspile-person'));
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [String(person)]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/notify' && request.method === 'POST') {
      this.broadcast(await request.json());
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/read' && request.method === 'POST') {
      const { person, thread, at } = await request.json();
      await this.read(person, thread, at);
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    // The person comes from the authenticated connection, never from the message.
    const [tag] = this.ctx.getTags(ws);
    if (msg.type === 'read') {
      await this.read(Number(tag), msg.thread, msg.at);
    }
  }

  // eslint-disable-next-line class-methods-use-this
  async webSocketClose(ws, code) {
    ws.close(code, 'closing');
  }
}
