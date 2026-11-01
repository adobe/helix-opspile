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
  newer, putDiscord, reactionsOf, snowflakeAt, snowflakeMs, threadInfo,
} from './discord.js';

/**
 * The Discord poller: one Durable Object (`DISCORD`, named `poller`) reads the servers in
 * DISCORD_GUILDS through the REST API and stores what is new in pile 1, like the Slack and
 * Teams endpoints do. Discord has no webhooks for messages, and a gateway connection would
 * keep an object in memory around the clock for the few messages a support server gets.
 *
 * - Every minute (DISCORD_POLL_SECONDS), its alarm asks for each server's channels and
 *   active threads, which name their latest message, and reads the messages after the last
 *   one stored where there are any: two requests when nothing happened. The first poll reads
 *   DISCORD_HISTORY_DAYS back (default 30), archived threads included.
 * - Every fifth poll, the conversations active in the last day are read again, to find
 *   edits, deletions and reactions, which leave a channel's latest message as it is. A
 *   reaction is timed when it is first seen.
 * - The object remembers each thread's parent channel, each inline reply's root, the last
 *   message stored per channel and thread, and what it last saw of recent messages, and
 *   writes the thread and root into the envelope (see src/discord.js), so pile 1 needs no
 *   lookups later. The cron pokes it, so a deploy or a failed alarm does not stop it.
 */

const DEFAULT_POLL_SECONDS = 60;
const DEFAULT_HISTORY_DAYS = 30;
/** Edits, deletions and reactions: read again every this many polls, this far back. */
const RECHECK_EVERY = 5;
const RECHECK_MS = 24 * 60 * 60 * 1000;

/** Message types that start or continue a conversation; the rest are system notices. */
const CONTENT_TYPES = new Set([0, 19, 20, 23]);

const log = (fields) => console.log(JSON.stringify({ route: 'discord', ...fields }));

/**
 * The message an inline reply answers, or null: a reply (type 19) in the same channel; a
 * forward is not one.
 */
export function replyTarget(d) {
  const ref = d.message_reference;
  if (!ref || !ref.message_id || (ref.type || 0) !== 0 || Number(d.type) !== 19) {
    return null;
  }
  return ref.channel_id && ref.channel_id !== d.channel_id ? null : ref.message_id;
}

/** Reaction counts as a string, to tell whether a message's reactions changed. */
const reactionCounts = (m) => (m.reactions || [])
  .map((r) => `${r.emoji && (r.emoji.id || r.emoji.name)}:${r.count}`).sort().join('|');

export class DiscordPoller extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.running = null;
    this.channels = new Map();
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/poll') {
      await this.ensure();
      return Response.json(await this.poll({ recheck: true }));
    }
    if (pathname === '/status') {
      return Response.json(await this.status());
    }
    return Response.json(await this.ensure());
  }

  interval() {
    return Math.max(15, Number(this.env.DISCORD_POLL_SECONDS) || DEFAULT_POLL_SECONDS) * 1000;
  }

  async alarm() {
    // The next poll is due whatever happens to this one.
    await this.ctx.storage.setAlarm(Date.now() + this.interval());
    if (!discordEnabled(this.env)) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.poll();
  }

  async status() {
    return {
      enabled: discordEnabled(this.env),
      next: await this.ctx.storage.getAlarm(),
      last: (await this.ctx.storage.get('last')) || null,
      guilds: guildsOf(this.env).length,
    };
  }

  /** Keeps the alarm set while Discord is on (and takes it off when it is not). */
  async ensure() {
    if (!discordEnabled(this.env)) {
      await this.ctx.storage.deleteAlarm();
      return { ...(await this.status()), state: 'off' };
    }
    if (!(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
    return { ...(await this.status()), state: 'on' };
  }

  /** One poll of every guild; a poll already running is joined, not started twice. */
  poll({ recheck = false } = {}) {
    this.running = this.running || this.run(recheck).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async run(force) {
    const polls = ((await this.ctx.storage.get('polls')) || 0) + 1;
    await this.ctx.storage.put('polls', polls);
    const recheck = force || polls % RECHECK_EVERY === 0;
    const out = { at: new Date().toISOString(), recheck };
    // Each guild on its own: one that keeps failing must not stop the guilds after it.
    for (const guild of guildsOf(this.env)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const got = await this.pollGuild(guild, recheck);
        for (const [k, v] of Object.entries(got)) {
          out[k] = (out[k] || 0) + v;
        }
      } catch (e) {
        out.error = e.message;
        log({ poll: 'error', guild, error: e.message });
      }
    }
    await this.ctx.storage.put('last', out);
    if (out.messages || out.changed || out.error) {
      log({ poll: out.error ? 'partial' : 'ok', ...out });
    }
    return out;
  }

  async pollGuild(guild, recheck) {
    const initialized = await this.ctx.storage.get(`init:${guild}`);
    const days = Number(this.env.DISCORD_HISTORY_DAYS) || DEFAULT_HISTORY_DAYS;
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    // After the first poll, a channel or thread without a cursor is new: read all of it.
    const since = initialized ? '0' : snowflakeAt(sinceMs);
    const channels = await discordApi(this.env, `/guilds/${guild}/channels`);
    for (const ch of channels) {
      this.channels.set(ch.id, { type: ch.type, parent_id: ch.parent_id || null });
    }
    const threads = new Map();
    const active = await discordApi(this.env, `/guilds/${guild}/threads/active`, { allow: [403] });
    for (const th of (active && active.threads) || []) {
      threads.set(th.id, th);
    }
    if (!initialized) {
      // An archived thread that gets a message is active again, so this is needed once.
      for (const th of await this.archivedSince(channels, new Date(sinceMs).toISOString())) {
        threads.set(th.id, th);
      }
    }
    let messages = 0;
    const conversations = [...channels.filter((c) => hasMessages(c.type)), ...threads.values()];
    for (const conv of conversations) {
      if (isThread(conv.type)) {
        // eslint-disable-next-line no-await-in-loop
        await this.rememberThread(conv);
      }
      // eslint-disable-next-line no-await-in-loop
      messages += await this.catchupChannel(guild, conv, since, Boolean(initialized));
    }
    let changed = 0;
    if (recheck) {
      const from = snowflakeAt(Date.now() - RECHECK_MS);
      for (const conv of conversations.filter((c) => newer(c.last_message_id, from))) {
        // eslint-disable-next-line no-await-in-loop
        changed += await this.recheck(guild, conv, from);
      }
    }
    if (!initialized) {
      await this.ctx.storage.put(`init:${guild}`, new Date().toISOString());
    }
    return {
      channels: channels.length, threads: threads.size, messages, changed,
    };
  }

  /** The public threads of every channel archived since a time (ISO). */
  async archivedSince(channels, sinceIso) {
    const out = [];
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
        out.push(...list);
        const last = list[list.length - 1];
        before = last && last.thread_metadata && last.thread_metadata.archive_timestamp;
        if (!archived || !archived.has_more || !before || before < sinceIso) {
          break;
        }
      }
    }
    return out;
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

  /**
   * The root of a message's conversation: the thread it was posted in, or for an inline
   * reply in a channel the root of the message it answers; otherwise itself.
   */
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

  /** Writes one message (or its deletion) to pile 1, with the thread and root it needs. */
  async store(t, d, guild, extra = {}) {
    const thread = await this.threadOf(d.channel_id);
    const envelope = {
      t, via: 'history', guild, d, ...(thread ? { thread } : {}), ...extra,
    };
    const channel = thread ? thread.parent_id : d.channel_id;
    if (t === 'MESSAGE_DELETE') {
      envelope.root = (await this.knownRoot(guild, channel, thread ? thread.id : d.id))
        || (thread ? thread.id : d.id);
      envelope.at = new Date().toISOString();
    } else {
      envelope.root = await this.rootOf(guild, d, thread);
      if (envelope.root !== d.id) {
        await this.ctx.storage.put(`root:${d.id}`, envelope.root);
      }
    }
    await putDiscord(this.env, envelope);
  }

  /**
   * Who reacted to a message, timed: a reaction seen before keeps its time, a new one is
   * timed now (in the first read of history, it has none: it counts from the message).
   */
  async timedReactions(channelId, m, seen, timed) {
    if (!m.reactions || !m.reactions.length) {
      return [];
    }
    const now = new Date().toISOString();
    return (await reactionsOf(this.env, channelId, m)).map((r) => ({
      ...r,
      at: Object.fromEntries(r.users
        .map((u) => [u, (seen && seen[`${r.emoji} ${u}`]) || (timed ? now : null)])),
    }));
  }

  /** What a recheck compares: the edit, the reaction counts and the timed reactors. */
  // eslint-disable-next-line class-methods-use-this
  fingerprint(m, reactions) {
    const who = {};
    for (const r of reactions || []) {
      for (const u of r.users) {
        who[`${r.emoji} ${u}`] = r.at[u];
      }
    }
    return { e: m.edited_timestamp || null, r: reactionCounts(m), who };
  }

  async saveFingerprints(convId, update, from) {
    const key = `fp:${convId}`;
    const fps = { ...((await this.ctx.storage.get(key)) || {}), ...update };
    // Only recent messages are compared; older ones are forgotten.
    for (const id of Object.keys(fps)) {
      if (!newer(id, from)) {
        delete fps[id];
      }
    }
    await this.ctx.storage.put(key, fps);
  }

  /** The messages of one channel or thread after its cursor, stored oldest first. */
  async catchupChannel(guild, conv, since, timed) {
    const stored = await this.ctx.storage.get(`cursor:${conv.id}`);
    const cursor = stored || since;
    if (!stored && since !== '0') {
      await this.ctx.storage.put(`cursor:${conv.id}`, since);
    }
    if (!newer(conv.last_message_id, cursor)) {
      return 0;
    }
    const list = await messagesAfter(this.env, conv.id, cursor);
    const fps = {};
    for (const m of list) {
      // eslint-disable-next-line no-await-in-loop
      const reactions = await this.timedReactions(conv.id, m, null, timed);
      // eslint-disable-next-line no-await-in-loop
      await this.store('MESSAGE_CREATE', m, guild, reactions.length ? { reactions } : {});
      fps[m.id] = this.fingerprint(m, reactions);
      // Every type moves the cursor (a channel of joins only is read once).
      // eslint-disable-next-line no-await-in-loop
      await this.ctx.storage.put(`cursor:${conv.id}`, m.id);
    }
    await this.saveFingerprints(conv.id, fps, snowflakeAt(Date.now() - RECHECK_MS));
    return list.filter((m) => CONTENT_TYPES.has(Number(m.type || 0))).length;
  }

  /**
   * Reads a conversation's recent messages again and stores what changed: an edit, other
   * reactions, or a message that is gone.
   */
  async recheck(guild, conv, from) {
    const fps = (await this.ctx.storage.get(`fp:${conv.id}`)) || {};
    const list = await messagesAfter(this.env, conv.id, from, 500);
    const cursor = await this.ctx.storage.get(`cursor:${conv.id}`);
    const next = {};
    let changed = 0;
    for (const m of list.filter((x) => !newer(x.id, cursor))) {
      const prev = fps[m.id];
      const edited = prev && (m.edited_timestamp || null) !== prev.e;
      const reacted = prev && reactionCounts(m) !== prev.r;
      // eslint-disable-next-line no-await-in-loop
      const reactions = reacted ? await this.timedReactions(conv.id, m, prev.who, true) : null;
      next[m.id] = reactions ? this.fingerprint(m, reactions)
        : { ...(prev || this.fingerprint(m, [])), e: m.edited_timestamp || null };
      if (edited || reacted) {
        // eslint-disable-next-line no-await-in-loop
        await this.store('MESSAGE_CREATE', m, guild, reactions ? { reactions } : {});
        changed += 1;
      }
    }
    const present = new Set(list.map((m) => m.id));
    // A full page may have left messages out; only a complete read can tell what is gone.
    for (const id of list.length < 500 ? Object.keys(fps) : []) {
      if (!present.has(id) && newer(id, from) && !newer(id, cursor)) {
        // eslint-disable-next-line no-await-in-loop
        await this.store('MESSAGE_DELETE', { id, channel_id: conv.id }, guild);
        changed += 1;
      }
    }
    await this.ctx.storage.put(`fp:${conv.id}`, Object.fromEntries(Object.entries(next)
      .filter(([id]) => snowflakeMs(id) >= snowflakeMs(from))));
    return changed;
  }
}
