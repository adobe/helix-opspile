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
 * Bots that only post alerts (`identities.alerts`, migration 0089; an admin says so under
 * Requests, src/ourbots.js). A thread one of them starts is an alert, whatever its channel's
 * rules say: a channel the rules make a conversation (`kind: channel`) can have both, the
 * people's conversations and a monitoring bot's alerts. Only the thread's root decides, so a
 * bot's reply in a person's thread leaves the thread a conversation, and a person's reply to an
 * alert leaves it an alert. A channel the rules make an alert feed or ignore stays so.
 *
 * The thread rows keep the kind (`threads.kind`): the message index writes it
 * (src/normalizer.js, `threadKind`), and a re-filing (src/refile.js) writes it again, so an
 * admin's change re-files the channels the bot started threads in.
 */

/** The identity keys (`messages.author_key`) of the bots that only post alerts, as a Set. */
export async function alertBots(env) {
  const { results } = await env.DB.prepare(`SELECT source || ':' || tenant || ':' || user_id AS key
    FROM identities WHERE kind = 'bot' AND alerts = 1`).all();
  return new Set((results || []).map((r) => r.key));
}

/**
 * SQL that is 1 when thread `t`'s root was posted by one of the bots in the JSON array bound to
 * `param` (`?1`, or `?`), 0 otherwise: the root message is found by its primary key.
 */
export const alertRoot = (t, param = '?') => `EXISTS (SELECT 1 FROM messages r
  WHERE r.source = ${t}.source AND r.tenant = ${t}.tenant AND r.channel_id = ${t}.channel_id
    AND r.id = ${t}.root_id AND r.author_key IN (SELECT value FROM json_each(${param})))`;

/** A thread's kind: its channel's (`kind`), but an alert where an alert bot started it. */
export const kindOf = (kind, alert) => (kind === 'channel' && alert ? 'alert' : kind);

/**
 * The kind of `message`'s thread, its channel's `kind` as the rules give it: an alert when the
 * thread's root is by one of the alert bots (`cache.alertBots`, read once per batch). The root is
 * `message` itself (its author's key `authorKey`), or the message D1 has; a reply that arrives
 * before its root is filed as a conversation, and the root, when it comes, files the thread as
 * what it is.
 */
export async function threadKind(env, kind, message, authorKey, cache = {}) {
  if (kind !== 'channel') {
    return kind;
  }
  // eslint-disable-next-line no-param-reassign
  cache.alertBots = cache.alertBots || await alertBots(env);
  if (!cache.alertBots.size) {
    return kind;
  }
  let root = authorKey;
  if (message.id !== message.rootId) {
    const row = await env.DB.prepare(`SELECT author_key FROM messages
      WHERE source = ? AND tenant = ? AND channel_id = ? AND id = ?`)
      .bind(message.source, message.tenant, message.channelId, message.rootId).first();
    root = row && row.author_key;
  }
  return kindOf(kind, Boolean(root) && cache.alertBots.has(root));
}
