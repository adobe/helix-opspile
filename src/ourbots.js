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
 * Adobe's own bots, for the admin page's Bots (`/api/admin/bots`): the bots the inbox knows
 * (`identities` of kind `bot`: Teams apps, Slack bots and bot users, Discord bots, written when
 * one posts or is mentioned), and the admin team's say on whether one is Adobe's (`ours`,
 * migration 0078). Staff are decided by mail domain, and a bot has no mail address: an Adobe
 * bot counts as staff (src/lookup.js, toAuthor), so the inbox shows it on Adobe's side, as a
 * colleague, not as the customer. Its messages stay a bot's: the agents read them as untrusted
 * as any bot's (src/agent/deliver.js), and they do not count as a reply (`counted`).
 */

import { json } from './http.js';
import { toAuthor } from './lookup.js';

const KEY = "i.source || ':' || i.tenant || ':' || i.user_id";

/** `[source, tenant, userId]` of an identity key; a user id may have colons of its own. */
const splitKey = (key) => {
  const [source, tenant, ...rest] = String(key || '').split(':');
  return [source, tenant, rest.join(':')];
};

/** A bot's row as the page shows it. */
function botOf(env, r) {
  return {
    key: `${r.source}:${r.tenant}:${r.user_id}`,
    source: r.source,
    id: r.user_id,
    name: r.name || null,
    handle: r.handle || null,
    avatar: r.avatar || null,
    // true, false (an admin said it is not), or null (nobody said).
    ours: r.ours === null || r.ours === undefined ? null : Boolean(r.ours),
    oursBy: r.ours_by || null,
    oursAt: r.ours_at || null,
    // Whether its messages show as Adobe's: Adobe's, or staff by a Discord role.
    staff: toAuthor(env, { ...r, kind: 'bot' }).staff,
    messages: r.messages || 0,
    threads: r.threads || 0,
    latest: r.latest || null,
    channel: r.channel || null,
    group: r.group || null,
    org: r.org || null,
  };
}

const SELECT = `SELECT i.source, i.tenant, i.user_id, i.name, i.handle, i.avatar, i.email, i.staff,
    i.ours, i.ours_by, i.ours_at,
    (SELECT COUNT(*) FROM messages m WHERE m.author_key = ${KEY} AND m.deleted = 0) AS messages,
    (SELECT COUNT(DISTINCT m.thread) FROM messages m WHERE m.author_key = ${KEY}
      AND m.deleted = 0) AS threads,
    (SELECT MAX(m.at) FROM messages m WHERE m.author_key = ${KEY}) AS latest,
    (SELECT m.thread FROM messages m WHERE m.author_key = ${KEY}
      ORDER BY m.at DESC LIMIT 1) AS thread
  FROM identities i WHERE i.kind = 'bot'`;

/**
 * Where each bot posted last (`rows`' `thread`): the channel (on Teams with its team's name)
 * and the org, so an admin knows which bot it is.
 */
async function whereFrom(env, rows) {
  const threads = [...new Set(rows.map((r) => r.thread).filter(Boolean))];
  if (!threads.length) {
    return rows;
  }
  const { results } = await env.DB.prepare(`SELECT t.thread, t.channel_name, t.org, c.group_name
    FROM threads t LEFT JOIN channels c ON c.source = t.source AND c.tenant = t.tenant
      AND c.channel_id = t.channel_id
    WHERE t.thread IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(threads)).all();
  const by = new Map((results || []).map((t) => [t.thread, t]));
  return rows.map((r) => {
    const t = by.get(r.thread);
    return t ? {
      ...r, channel: t.channel_name, group: t.group_name, org: t.org,
    } : r;
  });
}

/**
 * GET /api/admin/bots: every bot the inbox knows, those that posted last first, then those
 * only mentioned, by name.
 */
export async function listBots(env) {
  const { results } = await env.DB.prepare(SELECT).all();
  const bots = (await whereFrom(env, results || [])).map((r) => botOf(env, r));
  bots.sort((a, b) => String(b.latest || '').localeCompare(String(a.latest || ''))
    || String(a.name || a.id).localeCompare(String(b.name || b.id)));
  return json({ bots });
}

/**
 * PUT /api/admin/bots `{ key, ours }`: says whether the bot `key` (its identity key, the
 * messages' `author_key`) is Adobe's. Its messages in D1 follow at once (`messages.staff`, the
 * thread list's participants); the thread view reads the account for those written before
 * (src/api.js, botAuthor), and the ones it writes from now on say so themselves.
 */
export async function setOurs(env, me, body) {
  if (typeof body.ours !== 'boolean') {
    return json({ error: 'say whether the bot is Adobe\'s: ours is true or false' }, 400);
  }
  const [source, tenant, userId] = splitKey(body.key);
  if (!source || !tenant || !userId) {
    return json({ error: 'give the bot\'s key' }, 400);
  }
  const { meta } = await env.DB.prepare(`UPDATE identities SET ours = ?, ours_by = ?, ours_at = ?
    WHERE source = ? AND tenant = ? AND user_id = ? AND kind = 'bot'`)
    .bind(
      Number(body.ours),
      me.email || String(me.id),
      new Date().toISOString(),
      source,
      tenant,
      userId,
    )
    .run();
  if (!meta.changes) {
    return json({ error: 'no such bot' }, 404);
  }
  const row = await env.DB.prepare(`${SELECT} AND i.source = ? AND i.tenant = ? AND i.user_id = ?`)
    .bind(source, tenant, userId).first();
  const [where] = await whereFrom(env, [row]);
  const bot = botOf(env, where);
  const { meta: moved } = await env.DB.prepare(`UPDATE messages SET staff = ?
    WHERE author_key = ? AND staff != ?`).bind(Number(bot.staff), bot.key, Number(bot.staff)).run();
  console.log(JSON.stringify({
    route: 'admin', bot: bot.ours ? 'ours' : 'not ours', by: me.id, messages: moved.changes || 0,
  }));
  return json({ ok: true, bot });
}
