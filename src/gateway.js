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
import {
  discordApi, discordEnabled, guildsOf, hasMessages, hasThreads, isThread, messagesAfter,
  newer, putDiscord, reactionsOf, snowflakeAt, threadInfo,
} from './discord.js';

/**
 * The Discord gateway: one Durable Object (`DISCORD`, named `gateway`) holds the bot's
 * WebSocket to Discord and stores every message, edit, deletion and reaction of the guilds
 * in DISCORD_GUILDS in pile 1, like the Slack and Teams endpoints do. Discord has no
 * webhooks for messages, so this is the one place opspile keeps a connection open.
 *
 * - An alarm every minute is the watchdog: it connects when there is no connection, and
 *   reconnects when Discord stopped acknowledging heartbeats. The cron pokes it too, so a
 *   deploy (which resets the object) is back within a minute.
 * - A dropped connection resumes the session where Discord allows it, and Discord replays
 *   what was missed. A new session catches up from the REST API instead: every channel's
 *   and thread's messages after the last one stored (on the first run, DISCORD_HISTORY_DAYS
 *   back, default 30).
 * - The object remembers each thread's parent channel and each inline reply's root, and
 *   writes them into the envelope (see src/discord.js), so pile 1 needs no lookups later.
 */

/** Intents: GUILDS, GUILD_MESSAGES, GUILD_MESSAGE_REACTIONS and MESSAGE_CONTENT (privileged). */
export const INTENTS = 2 ** 0 + 2 ** 9 + 2 ** 10 + 2 ** 15;

const WATCHDOG_MS = 60 * 1000;
const DEFAULT_HISTORY_DAYS = 30;
/** Close codes after which reconnecting cannot help until the configuration changes. */
const FATAL = new Map([
  [4004, 'authentication failed (DISCORD_BOT_TOKEN)'],
  [4010, 'invalid shard'],
  [4011, 'sharding required'],
  [4012, 'invalid API version'],
  [4013, 'invalid intents'],
  [4014, 'disallowed intents: turn on the Message Content intent for the bot'],
]);
/** How long a fatal error stops reconnecting (a fixed token or intent is picked up then). */
const FATAL_PAUSE_MS = 60 * 60 * 1000;

const MESSAGE_EVENTS = new Set([
  'MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_DELETE_BULK',
  'MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE',
]);

/** Message types that start or continue a conversation; the rest are system notices. */
const CONTENT_TYPES = new Set([0, 19, 20, 23]);

function send(ws, op, d) {
  try {
    ws.send(JSON.stringify({ op, d }));
  } catch (e) {
    console.log(JSON.stringify({ route: 'discord', send: op, error: e.message }));
  }
}

const log = (fields) => console.log(JSON.stringify({ route: 'discord', ...fields }));

/**
 * The root of a message's conversation: the thread it was posted in, or for an inline
 * reply in a channel the root of the message it replies to; otherwise itself.
 */
export function replyTarget(d) {
  const ref = d.message_reference;
  if (!ref || !ref.message_id || (ref.type || 0) !== 0 || Number(d.type) !== 19) {
    return null;
  }
  return ref.channel_id && ref.channel_id !== d.channel_id ? null : ref.message_id;
}

export class DiscordGateway extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ws = null;
    this.heartbeat = null;
    this.lastAck = 0;
    this.interval = 41250;
    this.seq = null;
    this.session = null;
    this.fresh = false;
    this.catchups = new Map();
    this.channels = new Map();
    this.connecting = null;
    // Events are handled one after the other, in the order Discord sent them: a reply's
    // root is known once the message it replies to has been stored.
    this.queue = Promise.resolve();
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/status') {
      return Response.json(await this.status());
    }
    if (pathname === '/catchup') {
      // Catch up every guild now, as after a new session.
      await this.ensure();
      for (const guild of guildsOf(this.env)) {
        this.startCatchup(guild);
      }
      return Response.json(await this.status());
    }
    return Response.json(await this.ensure());
  }

  async alarm() {
    try {
      await this.ensure();
    } catch (e) {
      log({ watchdog: 'error', error: e.message });
    }
  }

  async status() {
    const fatal = await this.ctx.storage.get('fatal');
    return {
      enabled: discordEnabled(this.env),
      connected: Boolean(this.ws),
      session: Boolean(this.session),
      lastAck: this.lastAck ? new Date(this.lastAck).toISOString() : null,
      catchingUp: [...this.catchups.keys()],
      fatal: fatal || null,
      guilds: guildsOf(this.env).length,
    };
  }

  /** Keeps the watchdog alarm set and the connection up. */
  async ensure() {
    if (!discordEnabled(this.env)) {
      this.close(1000);
      return { ...(await this.status()), state: 'off' };
    }
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    const fatal = await this.ctx.storage.get('fatal');
    if (fatal && Date.parse(fatal.at) > Date.now() - FATAL_PAUSE_MS) {
      return { ...(await this.status()), state: 'stopped' };
    }
    const alive = this.ws && Date.now() - this.lastAck < this.interval * 2.5;
    if (!alive) {
      // One connection at a time, however many callers (alarm, cron, a close) ask at once.
      this.connecting = this.connecting || this.connect().finally(() => {
        this.connecting = null;
      });
      await this.connecting;
    }
    return { ...(await this.status()), state: alive ? 'connected' : 'connecting' };
  }

  close(code = 4000) {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    const { ws } = this;
    this.ws = null;
    if (ws) {
      try {
        ws.close(code, 'reconnect');
      } catch {
        // already closed
      }
    }
  }

  async connect() {
    this.close();
    const saved = await this.ctx.storage.get('session');
    const base = (saved && saved.url) || (await discordApi(this.env, '/gateway/bot')).url;
    const url = `${String(base).replace(/^wss:/, 'https:').replace(/\/+$/, '')}/?v=10&encoding=json`;
    const res = await fetch(url, { headers: { upgrade: 'websocket' } });
    const ws = res.webSocket;
    if (!ws) {
      throw new Error(`gateway did not upgrade (${res.status})`);
    }
    ws.accept();
    this.ws = ws;
    this.lastAck = Date.now();
    this.session = saved || null;
    this.seq = saved ? saved.seq : null;
    ws.addEventListener('message', (e) => {
      this.queue = this.queue.then(() => this.onMessage(ws, e.data))
        .catch((err) => log({ error: err.message }));
    });
    const closed = (code) => this.onClose(ws, code)
      .catch((e) => log({ close: code, error: e.message }));
    ws.addEventListener('close', (e) => closed(e.code));
    ws.addEventListener('error', () => closed(1006));
    log({ connect: saved ? 'resume' : 'identify' });
  }

  async onClose(ws, code) {
    if (ws !== this.ws) {
      return; // an old socket we replaced
    }
    this.close(1000);
    log({ closed: code });
    if (FATAL.has(code)) {
      await this.ctx.storage.put('fatal', { code, reason: FATAL.get(code), at: new Date().toISOString() });
      return;
    }
    if ([4007, 4009].includes(code)) {
      await this.ctx.storage.delete('session'); // the session cannot be resumed
    }
    // The watchdog reconnects within a minute; try once sooner.
    setTimeout(() => this.ensure().catch((e) => log({ reconnect: 'error', error: e.message })), 5000);
  }

  async onMessage(ws, data) {
    if (ws !== this.ws) {
      return;
    }
    const msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    if (msg.s !== null && msg.s !== undefined) {
      this.seq = msg.s;
    }
    if (msg.op === 10) {
      this.interval = msg.d.heartbeat_interval;
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => send(ws, 1, this.seq), this.interval);
      if (this.session) {
        send(ws, 6, {
          token: this.env.DISCORD_BOT_TOKEN, session_id: this.session.id, seq: this.session.seq,
        });
      } else {
        send(ws, 2, {
          token: this.env.DISCORD_BOT_TOKEN,
          intents: INTENTS,
          properties: { os: 'linux', browser: 'opspile', device: 'opspile' },
          // Read-only and out of the way: the bot does not show as online in the server.
          presence: {
            status: 'invisible', since: null, activities: [], afk: false,
          },
        });
      }
      return;
    }
    if (msg.op === 11) {
      this.lastAck = Date.now();
      return;
    }
    if (msg.op === 1) {
      send(ws, 1, this.seq);
      return;
    }
    if (msg.op === 7) {
      this.close(4000); // Discord asks for a reconnect; the session resumes
      setTimeout(() => this.ensure().catch((e) => log({ reconnect: 'error', error: e.message })), 500);
      return;
    }
    if (msg.op === 9) {
      if (!msg.d) {
        this.session = null;
        await this.ctx.storage.delete('session');
      }
      this.close(4000);
      setTimeout(() => this.ensure().catch((e) => log({ reconnect: 'error', error: e.message })), 2000);
      return;
    }
    if (msg.op === 0) {
      await this.dispatch(msg.t, msg.d || {});
      if (this.session) {
        this.session.seq = this.seq;
        await this.ctx.storage.put('session', this.session);
      }
    }
  }

  async dispatch(t, d) {
    if (t === 'READY') {
      this.session = { id: d.session_id, url: d.resume_gateway_url, seq: this.seq };
      this.fresh = true;
      await this.ctx.storage.delete('fatal');
      log({ ready: (d.guilds || []).length });
      return;
    }
    if (t === 'RESUMED') {
      this.fresh = false;
      log({ resumed: true });
      return;
    }
    const guild = d.guild_id || (t === 'GUILD_CREATE' ? d.id : null);
    if (!guild || !guildsOf(this.env).includes(guild)) {
      return;
    }
    if (t === 'GUILD_CREATE') {
      for (const ch of d.channels || []) {
        this.channels.set(ch.id, { type: ch.type, parent_id: ch.parent_id || null });
      }
      for (const th of d.threads || []) {
        // eslint-disable-next-line no-await-in-loop
        await this.rememberThread(th);
      }
      if (this.fresh) {
        this.startCatchup(guild);
      }
      return;
    }
    if (t === 'THREAD_CREATE' || t === 'THREAD_UPDATE') {
      await this.rememberThread(d);
      return;
    }
    if (t === 'THREAD_LIST_SYNC') {
      for (const th of d.threads || []) {
        // eslint-disable-next-line no-await-in-loop
        await this.rememberThread(th);
      }
      return;
    }
    if (t === 'CHANNEL_CREATE' || t === 'CHANNEL_UPDATE') {
      this.channels.set(d.id, { type: d.type, parent_id: d.parent_id || null });
      await putDiscord(this.env, {
        t,
        via: 'gateway',
        guild,
        d: {
          id: d.id, name: d.name, type: d.type, guild_id: guild,
        },
      });
      return;
    }
    if (!MESSAGE_EVENTS.has(t)) {
      return;
    }
    if (t === 'MESSAGE_DELETE_BULK') {
      for (const id of d.ids || []) {
        // eslint-disable-next-line no-await-in-loop
        await this.store('MESSAGE_DELETE', { id, channel_id: d.channel_id, guild_id: guild }, guild);
      }
      return;
    }
    let event = d;
    if (t === 'MESSAGE_UPDATE' && !d.author) {
      // A partial update: store the whole message as it is now.
      event = await discordApi(this.env, `/channels/${d.channel_id}/messages/${d.id}`, { allow: [403, 404] });
      if (!event) {
        return;
      }
    }
    await this.store(t, event, guild);
  }

  async rememberThread(th) {
    if (th && th.id && isThread(th.type)) {
      const info = threadInfo(th);
      this.channels.set(th.id, { type: th.type, parent_id: th.parent_id, thread: info });
      await this.ctx.storage.put(`thread:${th.id}`, info);
    }
  }

  /** The thread a channel id is, or undefined for a channel (looked up once if unknown). */
  async threadOf(channelId) {
    const known = this.channels.get(channelId);
    if (known) {
      return known.thread
        || (isThread(known.type) ? this.ctx.storage.get(`thread:${channelId}`) : undefined);
    }
    const stored = await this.ctx.storage.get(`thread:${channelId}`);
    if (stored) {
      return stored;
    }
    const ch = await discordApi(this.env, `/channels/${channelId}`, { allow: [403, 404] });
    if (ch && isThread(ch.type)) {
      await this.rememberThread(ch);
      return threadInfo(ch);
    }
    this.channels.set(channelId, { type: ch ? ch.type : -1, parent_id: ch ? ch.parent_id : null });
    return undefined;
  }

  /** The root a message is known to belong to, if it is not its own root. */
  async knownRoot(guild, channelId, id) {
    const stored = await this.ctx.storage.get(`root:${id}`);
    if (stored) {
      return stored;
    }
    const row = await this.env.DB.prepare(`SELECT thread FROM messages
      WHERE source = 'discord' AND tenant = ? AND channel_id = ? AND id = ?`)
      .bind(guild, channelId, id).first();
    const root = row && String(row.thread).split(':').pop();
    return root && root !== id ? root : null;
  }

  async rootOf(guild, d, thread) {
    if (thread) {
      // A thread started from an inline reply continues the reply's conversation.
      return (await this.knownRoot(guild, thread.parent_id, thread.id)) || thread.id;
    }
    const target = replyTarget(d);
    if (target) {
      return (await this.knownRoot(guild, d.channel_id, target)) || target;
    }
    return d.id;
  }

  /** Writes one event to pile 1, with the thread, root and (history) reactors it needs. */
  async store(t, d, guild, extra = {}) {
    const thread = await this.threadOf(d.channel_id);
    const envelope = {
      t, via: 'gateway', guild, d, ...(thread ? { thread } : {}), ...extra,
    };
    const channel = thread ? thread.parent_id : d.channel_id;
    if (t === 'MESSAGE_CREATE' || t === 'MESSAGE_UPDATE') {
      envelope.root = await this.rootOf(guild, d, thread);
      if (envelope.root !== d.id) {
        await this.ctx.storage.put(`root:${d.id}`, envelope.root);
      }
    } else if (t === 'MESSAGE_DELETE') {
      envelope.root = thread
        ? ((await this.knownRoot(guild, channel, thread.id)) || thread.id)
        : ((await this.knownRoot(guild, channel, d.id)) || d.id);
      envelope.at = new Date().toISOString();
    } else {
      // Reactions carry no time; when it arrived orders an add and a removal on replay.
      envelope.at = new Date().toISOString();
    }
    await putDiscord(this.env, envelope);
    if (t === 'MESSAGE_CREATE' && CONTENT_TYPES.has(Number(d.type))) {
      const cursor = await this.ctx.storage.get(`cursor:${d.channel_id}`);
      if (newer(d.id, cursor)) {
        await this.ctx.storage.put(`cursor:${d.channel_id}`, d.id);
      }
    }
  }

  startCatchup(guild) {
    if (this.catchups.has(guild)) {
      return;
    }
    const run = this.catchup(guild)
      .then((r) => log({ catchup: 'done', ...r }))
      .catch((e) => log({ catchup: 'error', error: e.message }))
      .finally(() => this.catchups.delete(guild));
    this.catchups.set(guild, run);
    this.ctx.waitUntil(run);
  }

  /**
   * Everything posted since the last message stored, from the REST API: the messages of
   * every text and announcement channel, and of every thread (active, or archived since
   * then) with newer messages.
   */
  async catchup(guild) {
    const days = Number(this.env.DISCORD_HISTORY_DAYS) || DEFAULT_HISTORY_DAYS;
    const since = snowflakeAt(Date.now() - days * 24 * 60 * 60 * 1000);
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const channels = await discordApi(this.env, `/guilds/${guild}/channels`);
    for (const ch of channels) {
      this.channels.set(ch.id, { type: ch.type, parent_id: ch.parent_id || null });
    }
    let messages = 0;
    for (const ch of channels.filter((c) => hasMessages(c.type))) {
      // eslint-disable-next-line no-await-in-loop
      messages += await this.catchupChannel(guild, ch, since);
    }
    const threads = new Map();
    const active = await discordApi(this.env, `/guilds/${guild}/threads/active`, { allow: [403] });
    for (const th of (active && active.threads) || []) {
      threads.set(th.id, th);
    }
    for (const ch of channels.filter((c) => hasThreads(c.type))) {
      let before = '';
      for (let page = 0; page < 20; page += 1) {
        // eslint-disable-next-line no-await-in-loop
        const archived = await discordApi(
          this.env,
          `/channels/${ch.id}/threads/archived/public?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`,
          { allow: [403, 404] },
        );
        const list = (archived && archived.threads) || [];
        for (const th of list) {
          threads.set(th.id, th);
        }
        const last = list[list.length - 1];
        before = last && last.thread_metadata && last.thread_metadata.archive_timestamp;
        if (!archived || !archived.has_more || !before || before < sinceIso) {
          break;
        }
      }
    }
    for (const th of threads.values()) {
      // eslint-disable-next-line no-await-in-loop
      await this.rememberThread(th);
      // eslint-disable-next-line no-await-in-loop
      messages += await this.catchupChannel(guild, th, since);
    }
    return {
      guild: 'ok', channels: channels.length, threads: threads.size, messages,
    };
  }

  /** The messages of one channel or thread after its cursor, stored oldest first. */
  async catchupChannel(guild, ch, since) {
    const cursor = (await this.ctx.storage.get(`cursor:${ch.id}`)) || since;
    if (!newer(ch.last_message_id, cursor)) {
      return 0;
    }
    const list = await messagesAfter(this.env, ch.id, newer(cursor, since) ? cursor : since);
    for (const m of list) {
      const reactions = m.reactions && m.reactions.length
        // eslint-disable-next-line no-await-in-loop
        ? await reactionsOf(this.env, ch.id, m) : undefined;
      // eslint-disable-next-line no-await-in-loop
      await this.store('MESSAGE_CREATE', m, guild, {
        via: 'history', ...(reactions ? { reactions } : {}),
      });
      // History messages of every type move the cursor (a channel of joins only is caught up).
      // eslint-disable-next-line no-await-in-loop
      await this.ctx.storage.put(`cursor:${ch.id}`, m.id);
    }
    return list.length;
  }
}
