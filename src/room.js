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
import { recipients } from './shares.js';
import { advanceWatermark } from './threads.js';

/** Read events are written to D1 at most this long after they happen. */
export const FLUSH_MS = 2000;

/**
 * One room per ops team. Inboxes of the team's members connect over WebSocket (with
 * hibernation); a read event from one member is fanned out to everyone at once and
 * written to D1 in batches. The normalizer posts new activity and inferred reads to
 * `/notify`, which is only fanned out (it has already written D1).
 *
 * People who are not on the team connect too (`x-opspile-scoped`), for the channels of the
 * team's that are in their personal view: they hear only about those (src/shares.js,
 * `recipients`).
 */
export class TeamRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async broadcast(event) {
    const data = JSON.stringify(event);
    const sockets = this.ctx.getWebSockets().map((ws) => {
      const [person, , scope] = this.ctx.getTags(ws);
      return { ws, person: Number(person), scoped: scope === 'scoped' };
    });
    for (const { ws } of await recipients(this.env, event, sockets)) {
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
    await this.broadcast({
      type: 'read', person, thread, at,
    });
    if (!(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
    }
  }

  async alarm() {
    const pending = await this.ctx.storage.list({ prefix: 'read:' });
    let newer = false;
    for (const [key, r] of pending) {
      // eslint-disable-next-line no-await-in-loop
      await advanceWatermark(this.env.DB, r.person, r.thread, r.at, 'open');
      // D1 lets other events in: a newer read of the same thread may be waiting by now.
      // eslint-disable-next-line no-await-in-loop
      const now = await this.ctx.storage.get(key);
      if (now && now.at !== r.at) {
        newer = true;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await this.ctx.storage.delete(key);
      }
    }
    if (newer && !(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      const person = Number(request.headers.get('x-opspile-person'));
      const readonly = request.headers.get('x-opspile-readonly') === '1';
      const scoped = request.headers.get('x-opspile-scoped') === '1';
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [
        String(person), readonly ? 'readonly' : 'readwrite', scoped ? 'scoped' : 'team',
      ]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/notify' && request.method === 'POST') {
      await this.broadcast(await request.json());
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
    const [tag, mode, scope] = this.ctx.getTags(ws);
    // An admin looking as someone else must not move their read state. Someone not on the team
    // reads only the threads of the channels they hear about.
    const person = Number(tag);
    if (msg.type !== 'read' || mode === 'readonly') {
      return;
    }
    const sockets = [{ person, scoped: scope === 'scoped' }];
    if ((await recipients(this.env, msg, sockets)).length) {
      await this.read(person, msg.thread, msg.at);
    }
  }

  // eslint-disable-next-line class-methods-use-this
  async webSocketClose(ws, code) {
    // 1005 (no status) and 1006 (abnormal) are reported to us but may not be sent back.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closing');
    } catch {
      // already closed
    }
  }
}
