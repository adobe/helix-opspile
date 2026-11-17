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

import { domainOf } from './ids.js';
import {
  channelOf, declineLobby, editMessage, ensureBot, ensureUser, openChannel, reactTo, resend,
  writeMessage,
} from './store.js';

/**
 * What the inbox does in the portal, as it calls Slack's API to post in Slack: the methods of
 * the `PortalPlatform` entrypoint (src/portal/worker.js), which only a Worker of the same
 * account can bind (the inbox's `PORTAL`). Each takes one object and answers `{ ok, … }` or
 * `{ error, status }`; none throws for what the caller got wrong.
 *
 * The inbox says who acts: `author: { email, name }` for one of its people (they get an
 * account here, `staff`, by their mail address), or `{ bot: true, name }` for its app.
 * Nothing here checks who that is. The binding is the trust.
 *
 * What these write comes back to the inbox as events, like anybody's message.
 */

const fail = (error, status = 400) => ({ error, status });

/** The account of whoever the inbox acts as, made when first needed. */
async function actor(env, author, now) {
  if (author && author.bot) {
    return ensureBot(env, author.name, now);
  }
  if (!author || !domainOf(author.email)) {
    return null;
  }
  return ensureUser(env, { email: author.email, name: author.name, kind: 'staff' }, now);
}

async function place(env, { domain, channel }) {
  return channelOf(env, String(domain || '').toLowerCase(), channel);
}

/**
 * `{ domain, channel, root?, text, author }`: posts in a thread of the channel, or without
 * `root` starts one. `{ ok, id, root }`.
 */
export async function post(env, args = {}, now = Date.now()) {
  const channel = await place(env, args);
  if (!channel) {
    return fail('no such channel', 404);
  }
  const author = await actor(env, args.author, now);
  if (!author) {
    return fail('say who posts: author { email, name } or { bot, name }');
  }
  return writeMessage(env, channel, author, { root: args.root, text: args.text }, now);
}

/** `{ domain, channel, id, text, author }`: changes the text of a message `author` wrote. */
export async function edit(env, args = {}, now = Date.now()) {
  const channel = await place(env, args);
  if (!channel) {
    return fail('no such channel', 404);
  }
  const author = await actor(env, args.author, now);
  if (!author) {
    return fail('say who edits: author { email, name } or { bot, name }');
  }
  return editMessage(env, channel, author, { id: args.id, text: args.text }, now);
}

/** `{ domain, channel, id, emoji, removed?, author }`: a reaction on a message, or off it. */
export async function react(env, args = {}, now = Date.now()) {
  const channel = await place(env, args);
  if (!channel) {
    return fail('no such channel', 404);
  }
  const author = await actor(env, args.author, now);
  if (!author) {
    return fail('say who reacts: author { email, name } or { bot, name }');
  }
  return reactTo(env, channel, author, {
    id: args.id, emoji: args.emoji, removed: Boolean(args.removed),
  }, now);
}

/**
 * `{ domain, name, topic?, by: { email, name } }`: opens a channel for a lobby, which is
 * `open` from then on. `{ ok, channel: { id, name } }`.
 */
export async function open(env, args = {}, now = Date.now()) {
  return openChannel(env, String(args.domain || '').toLowerCase(), {
    name: args.name, topic: args.topic, by: args.by,
  }, now);
}

/** `{ domain, reason? }`: declines what a lobby asked for. */
export async function decline(env, args = {}, now = Date.now()) {
  return declineLobby(env, String(args.domain || '').toLowerCase(), { reason: args.reason }, now);
}

/** `{ domain, channel, root? }`: the events of a thread's messages (or a channel's) again. */
export async function again(env, args = {}, now = Date.now()) {
  const channel = await place(env, args);
  if (!channel) {
    return fail('no such channel', 404);
  }
  return resend(env, channel, args.root || null, now);
}
