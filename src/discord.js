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

import {
  dayPath, putRaw, segment, sha256,
} from './raw.js';

/**
 * Discord: the REST API (bot token), snowflakes, and the pile-1 objects the gateway
 * (src/gateway.js) and the history fetches write.
 *
 * A pile-1 object is an envelope around what Discord delivered:
 *
 * ```
 * { t: 'MESSAGE_CREATE', via: 'gateway' | 'history', guild: '<id>', d: { …as delivered… },
 *   thread?: { id, parent_id, name, type }, root?: '<message id>', reactions?: [{ emoji, users }] }
 * ```
 *
 * `d` is exactly what the gateway or REST API sent. The rest is what the ingester knew when
 * it stored the event and Discord does not say in it: the thread a message was posted in
 * (Discord names only the thread's channel id), the root of an inline reply's conversation,
 * and who reacted to a message fetched from history (REST gives counts only). Storing it
 * keeps pile 1 self-contained, so a replay needs no Discord calls to file a message.
 */

const API = 'https://discord.com/api/v10';

/** Discord's epoch (2015-01-01), in ms; a snowflake is its ms since then times 2^22, plus bits. */
const EPOCH = 1420070400000n;

/** Milliseconds since 1970 of a snowflake. */
export const snowflakeMs = (id) => Number(BigInt(id) / 4194304n + EPOCH);

/** The smallest snowflake at a time: messages after it were posted at or after `ms`. */
export const snowflakeAt = (ms) => String(
  (BigInt(Math.max(Number(EPOCH), Math.floor(ms))) - EPOCH) * 4194304n,
);

/** Whether snowflake a is newer than b (either may be missing). */
export const newer = (a, b) => Boolean(a) && (!b || BigInt(a) > BigInt(b));

/** Channel types (https://discord.com/developers/docs/resources/channel#channel-object-channel-types). */
export const CHANNEL = {
  TEXT: 0,
  VOICE: 2,
  CATEGORY: 4,
  ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  FORUM: 15,
  MEDIA: 16,
};

export const isThread = (type) => [
  CHANNEL.ANNOUNCEMENT_THREAD, CHANNEL.PUBLIC_THREAD, CHANNEL.PRIVATE_THREAD,
].includes(Number(type));

/** Channels whose own messages are read: text and announcement channels. */
export const hasMessages = (type) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT].includes(Number(type));

/** Channels that hold threads: those, forums and media channels. */
export const hasThreads = (type) => [
  CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT, CHANNEL.FORUM, CHANNEL.MEDIA,
].includes(Number(type));

/** The guild ids opspile ingests (`DISCORD_GUILDS`, comma-separated). */
export const guildsOf = (env) => String(env.DISCORD_GUILDS || '').split(',')
  .map((g) => g.trim()).filter(Boolean);

/** Discord ingestion is on when there are guilds and a bot token. */
export const discordEnabled = (env) => guildsOf(env).length > 0 && Boolean(env.DISCORD_BOT_TOKEN);

/** The role ids whose members count as staff (`DISCORD_STAFF_ROLES`, comma-separated). */
export const staffRolesOf = (env) => new Set(String(env.DISCORD_STAFF_ROLES || '').split(',')
  .map((r) => r.trim()).filter(Boolean));

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * One REST call with the bot token. Rate limits (429) are waited out and retried a few
 * times; any other error throws with the status and Discord's error code, never the body.
 * `allow` lists statuses that are answered with null instead (e.g. 404 for a lookup).
 */
export async function discordApi(env, path, { method = 'GET', body, allow = [] } = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'user-agent': 'DiscordBot (https://github.com/adobe/helix-opspile, 1)',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      // eslint-disable-next-line no-await-in-loop
      const data = await res.json().catch(() => ({}));
      const wait = Math.min(Number(data.retry_after || res.headers.get('retry-after') || 1), 30);
      // eslint-disable-next-line no-await-in-loop
      await sleep(wait * 1000 + 50);
      // eslint-disable-next-line no-continue
      continue;
    }
    if (allow.includes(res.status)) {
      return null;
    }
    if (!res.ok) {
      // eslint-disable-next-line no-await-in-loop
      const data = await res.json().catch(() => ({}));
      const route = path.split('?')[0].replace(/\d{15,}/g, ':id');
      throw new Error(`discord ${res.status} ${route}${data.code ? ` (${data.code})` : ''}`);
    }
    return res.status === 204 ? null : res.json();
  }
  throw new Error(`discord 429 ${path.split('?')[0].replace(/\d{15,}/g, ':id')}`);
}

/** Messages of a channel or thread after a snowflake, oldest first, up to `max`. */
export async function messagesAfter(env, channelId, after, max = 1000) {
  const out = [];
  let cursor = after || '0';
  while (out.length < max) {
    // eslint-disable-next-line no-await-in-loop
    const page = await discordApi(env, `/channels/${channelId}/messages?limit=100&after=${cursor}`, {
      allow: [403, 404],
    });
    if (!page || !page.length) {
      break;
    }
    page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    out.push(...page);
    cursor = page[page.length - 1].id;
    if (page.length < 100) {
      break;
    }
  }
  return out;
}

/** The emoji of a reaction as stored: the character, or `:name:` for a custom emoji. */
export const emojiName = (emoji) => (emoji && emoji.id ? `:${emoji.name}:` : (emoji && emoji.name) || '');

/** The emoji as the reactions endpoint wants it in the path. */
const emojiPath = (emoji) => encodeURIComponent(emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name);

/**
 * Who reacted to a message, per emoji (REST messages carry counts only). At most 100 users
 * per emoji, which is plenty for a support channel.
 */
export async function reactionsOf(env, channelId, message) {
  const out = [];
  for (const r of message.reactions || []) {
    if (r && r.emoji && r.emoji.name) {
      // eslint-disable-next-line no-await-in-loop
      const users = await discordApi(
        env,
        `/channels/${channelId}/messages/${message.id}/reactions/${emojiPath(r.emoji)}?limit=100`,
        { allow: [403, 404] },
      );
      out.push({ emoji: emojiName(r.emoji), users: (users || []).map((u) => u.id) });
    }
  }
  return out;
}

/** The thread an envelope's channel is, as stored: `{ id, parent_id, name, type }`. */
export const threadInfo = (ch) => (ch && isThread(ch.type) ? {
  id: ch.id, parent_id: ch.parent_id, name: ch.name, type: ch.type,
} : undefined);

/**
 * Pile-1 key of an envelope:
 * `discord/<guild>/<channel>/<yyyy>/<mm>/<dd>/<message id>-<what>.json`, filed under the
 * channel (a thread's parent) and the day of the message. A message's create, every
 * distinct update and its deletion each get their own object; the same event stored
 * twice (a gateway resume, a history fetch of an unchanged message) shares a key.
 */
export async function discordKey(envelope) {
  const { t, d = {} } = envelope;
  const channel = (envelope.thread && envelope.thread.parent_id) || d.channel_id;
  const id = d.message_id || d.id || '0';
  let what;
  if (t === 'MESSAGE_CREATE' && envelope.via !== 'history') {
    what = 'create';
  } else if (t === 'MESSAGE_DELETE') {
    what = 'delete';
  } else {
    const hash = (await sha256(JSON.stringify({ ...envelope, via: undefined }))).slice(0, 16);
    what = `${String(t || 'event').toLowerCase().replace(/^message_/, '')}-${hash}`;
  }
  const day = /^\d+$/.test(String(id)) ? new Date(snowflakeMs(id)) : new Date();
  return ['discord', segment(envelope.guild), segment(channel), dayPath(day), `${segment(id)}-${what}.json`]
    .join('/');
}

/** Stores one envelope in pile 1 (and queues it for normalization). */
export async function putDiscord(env, envelope) {
  return putRaw(env, await discordKey(envelope), JSON.stringify(envelope), {
    source: 'discord', via: envelope.via || 'gateway',
  });
}

/** `https://discord.com/channels/<guild>/<channel or thread>/<message>`. */
export const discordPermalink = (guild, channelId, id) => `https://discord.com/channels/${guild}/${channelId}${id ? `/${id}` : ''}`;

/** A user's avatar on Discord's CDN (guild avatar first), or '' for the default one. */
export function discordAvatar(user, guild, member) {
  if (member && member.avatar && guild) {
    return `https://cdn.discordapp.com/guilds/${guild}/users/${user.id}/avatars/${member.avatar}.png?size=96`;
  }
  return user && user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=96` : '';
}

/**
 * Fresh URLs for Discord attachment links, which expire after a day: the media proxy asks
 * for a refreshed one before it fetches an image.
 */
export async function refreshAttachment(env, url) {
  const data = await discordApi(env, '/attachments/refresh-urls', {
    method: 'POST', body: { attachment_urls: [url] },
  });
  const hit = data && (data.refreshed_urls || []).find((r) => r.original === url);
  return (hit && hit.refreshed) || url;
}
