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
 * as any bot's (src/agent/deliver.js), and they do not count as a reply (`counted`). The admin
 * team also gives a bot the name and picture the inbox shows (`display_name`, `display_avatar`,
 * migration 0081), where the platform's say nothing to people (a Teams app has no picture).
 *
 * The admin page has no list of bots of its own: they are under Requests. A bot nobody said
 * anything of yet (`ours` NULL) that has posted is a request there, until an admin says it is
 * Adobe's or external; the others are listed below the requests. A bot may also only post
 * alerts (`alerts`, migration 0088): the threads it starts are alerts (src/alertbots.js).
 */

import { json } from './http.js';
import { toAuthor } from './lookup.js';
import { enqueueMoves } from './refile.js';

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
    // The platform's name and picture, and the ones an admin gave it, which the inbox shows.
    name: r.name || null,
    handle: r.handle || null,
    avatar: r.avatar || null,
    displayName: r.display_name || null,
    displayAvatar: r.display_avatar || null,
    // true, false (an admin said it is not), or null (nobody said).
    ours: r.ours === null || r.ours === undefined ? null : Boolean(r.ours),
    oursBy: r.ours_by || null,
    oursAt: r.ours_at || null,
    // Whether it only posts alerts: the threads it starts are alerts (src/alertbots.js).
    alerts: Boolean(r.alerts),
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
    i.ours, i.ours_by, i.ours_at, i.display_name, i.display_avatar, i.alerts,
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
  const named = (b) => String(b.displayName || b.name || b.id);
  bots.sort((a, b) => String(b.latest || '').localeCompare(String(a.latest || ''))
    || named(a).localeCompare(named(b)));
  return json({ bots });
}

/**
 * How many bots are waiting for an admin to say whose they are: nobody did (`ours` NULL), and they
 * posted (a bot only mentioned changes nothing in the inbox). They are requests, under Requests.
 */
export async function unreviewedCount(env) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM identities i
    WHERE i.kind = 'bot' AND i.ours IS NULL
      AND EXISTS (SELECT 1 FROM messages m WHERE m.author_key = ${KEY} AND m.deleted = 0)`).first();
  return r ? r.n : 0;
}

/** How many of a bot's latest messages its page shows. */
export const RECENT = 3;

/**
 * GET /api/admin/bot?key=: the bot `key` (its identity key), with its latest messages
 * (`recent`, at most RECENT, deleted ones left out), each with its preview (the text the thread
 * list shows, `messages.preview`) and where it was posted, so an admin sees what it says before
 * saying whose it is.
 */
export async function getBot(env, key) {
  const [source, tenant, userId] = splitKey(key);
  if (!source || !tenant || !userId) {
    return json({ error: 'give the bot\'s key' }, 400);
  }
  const row = await env.DB.prepare(`${SELECT} AND i.source = ? AND i.tenant = ? AND i.user_id = ?`)
    .bind(source, tenant, userId).first();
  if (!row) {
    return json({ error: 'no such bot' }, 404);
  }
  const [where] = await whereFrom(env, [row]);
  const { results } = await env.DB.prepare(`SELECT m.thread, m.id, m.at, m.preview, m.permalink,
      t.team, t.org, t.channel_name, t.title, c.group_name
    FROM messages m JOIN threads t ON t.thread = m.thread
    LEFT JOIN channels c ON c.source = t.source AND c.tenant = t.tenant
      AND c.channel_id = t.channel_id
    WHERE m.author_key = ? AND m.deleted = 0 ORDER BY m.at DESC LIMIT ?`)
    .bind(`${source}:${tenant}:${userId}`, RECENT).all();
  return json({
    bot: botOf(env, where),
    recent: (results || []).map((m) => ({
      thread: m.thread,
      id: m.id,
      at: m.at,
      preview: m.preview || '',
      permalink: m.permalink || null,
      team: m.team,
      org: m.org,
      channel: m.channel_name || null,
      group: m.group_name || null,
      title: m.title || null,
    })),
  });
}

/** The longest name an admin may give a bot, and the longest picture URL. */
const MAX_NAME = 80;
const MAX_URL = 500;

/**
 * `{ name, avatar }` of what an admin gave a bot, as given (`undefined`: left as it is; `null`:
 * the platform's again), or `{ error }`. A picture is an https:// image URL.
 */
function looks(body) {
  const out = {};
  for (const [field, max] of [['name', MAX_NAME], ['avatar', MAX_URL]]) {
    if (body[field] === undefined) {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (body[field] !== null && typeof body[field] !== 'string') {
      return { error: `${field} is a string, or null for the platform's` };
    }
    const v = String(body[field] ?? '').trim();
    if (v.length > max) {
      return { error: `${field} is at most ${max} characters` };
    }
    out[field] = v || null;
  }
  if (out.avatar) {
    let url;
    try {
      url = new URL(out.avatar);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'https:') {
      return { error: 'the picture is an https:// image URL' };
    }
    out.avatar = url.href;
  }
  return out;
}

/**
 * The channels the bot `key` started threads in, re-filed (src/refile.js): a thread it started is
 * an alert there now, or a conversation again (src/alertbots.js). Returns the number of jobs.
 */
async function refileStarted(env, key) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT t.source, t.tenant, t.channel_id
    FROM messages m JOIN threads t ON t.thread = m.thread AND t.root_id = m.id
    WHERE m.author_key = ?`).bind(key).all();
  return enqueueMoves(env, (results || []).map((c) => ({
    channel: { source: c.source, tenant: c.tenant, channelId: c.channel_id },
  })));
}

/**
 * PUT /api/admin/bots `{ key, ours?, alerts?, name?, avatar? }`: what the admin team says of the
 * bot `key` (its identity key, the messages' `author_key`).
 *
 * `ours`: whether it is Adobe's (true) or external (false); a bot nobody said either of is a
 * request under Requests. Its messages in D1 follow at once (`messages.staff`, the thread
 * list's participants); the thread view reads the account for those written before
 * (src/api.js, botAuthor), and the ones it writes from now on say so themselves.
 *
 * `alerts`: whether it only posts alerts. The threads it started are re-filed as alerts (or as
 * conversations again, where their channel is one), and so are the ones it starts from now on
 * (src/alertbots.js).
 *
 * `name` and `avatar`: the name and picture (an https:// image URL) the inbox shows for it,
 * instead of the platform's (null: the platform's again). Teams gives an app's messages no
 * picture, and names a bot by its registration. Its messages in D1 take the name at once
 * (`messages.author`, and a thread's `last_author` that was the bot's); the thread view, the
 * profile cards and the replies it writes from now on read it from the account.
 */
export async function setBot(env, me, body) {
  const look = looks(body);
  if (look.error) {
    return json({ error: look.error }, 400);
  }
  const naming = Object.keys(look).length > 0;
  if (body.ours !== undefined && typeof body.ours !== 'boolean') {
    return json({ error: 'say whether the bot is Adobe\'s: ours is true or false' }, 400);
  }
  if (body.alerts !== undefined && typeof body.alerts !== 'boolean') {
    return json({ error: 'say whether the bot only posts alerts: alerts is true or false' }, 400);
  }
  if (body.ours === undefined && body.alerts === undefined && !naming) {
    return json({ error: 'say whether the bot is Adobe\'s (ours), whether it only posts alerts (alerts), or give it a name or a picture' }, 400);
  }
  const [source, tenant, userId] = splitKey(body.key);
  if (!source || !tenant || !userId) {
    return json({ error: 'give the bot\'s key' }, 400);
  }
  const where = 'WHERE source = ? AND tenant = ? AND user_id = ? AND kind = \'bot\'';
  const before = await env.DB.prepare(`SELECT name, display_name, alerts FROM identities ${where}`)
    .bind(source, tenant, userId).first();
  if (!before) {
    return json({ error: 'no such bot' }, 404);
  }
  const sets = [];
  const args = [];
  if (body.ours !== undefined) {
    sets.push('ours = ?', 'ours_by = ?', 'ours_at = ?');
    args.push(Number(body.ours), me.email || String(me.id), new Date().toISOString());
  }
  if (body.alerts !== undefined) {
    sets.push('alerts = ?');
    args.push(Number(body.alerts));
  }
  if (look.name !== undefined) {
    sets.push('display_name = ?');
    args.push(look.name);
  }
  if (look.avatar !== undefined) {
    sets.push('display_avatar = ?');
    args.push(look.avatar);
  }
  await env.DB.prepare(`UPDATE identities SET ${sets.join(', ')} ${where}`)
    .bind(...args, source, tenant, userId).run();
  const row = await env.DB.prepare(`${SELECT} AND i.source = ? AND i.tenant = ? AND i.user_id = ?`)
    .bind(source, tenant, userId).first();
  const [at] = await whereFrom(env, [row]);
  const bot = botOf(env, at);
  let moved = 0;
  if (body.ours !== undefined) {
    const { meta } = await env.DB.prepare(`UPDATE messages SET staff = ?
      WHERE author_key = ? AND staff != ?`).bind(Number(bot.staff), bot.key, Number(bot.staff)).run();
    moved = meta.changes || 0;
  }
  let renamed = 0;
  const was = before.display_name || before.name;
  const shown = bot.displayName || bot.name;
  if (look.name !== undefined && shown && shown !== was) {
    const { meta } = await env.DB.prepare(`UPDATE messages SET author = ?
      WHERE author_key = ? AND author IS NOT ?`).bind(shown, bot.key, shown).run();
    renamed = meta.changes || 0;
    await env.DB.prepare(`UPDATE threads SET last_author = ?1 WHERE last_author = ?2
      AND thread IN (SELECT thread FROM messages WHERE author_key = ?3)`)
      .bind(shown, was, bot.key).run();
  }
  // Its threads follow, re-filed: only when the say changed, since that moves nothing otherwise.
  const refiled = body.alerts !== undefined && body.alerts !== Boolean(before.alerts)
    ? await refileStarted(env, bot.key) : 0;
  let said = 'look';
  if (body.ours !== undefined) {
    said = bot.ours ? 'ours' : 'not ours';
  } else if (body.alerts !== undefined) {
    said = bot.alerts ? 'alerts' : 'not alerts';
  }
  console.log(JSON.stringify({
    route: 'admin',
    bot: said,
    by: me.id,
    messages: moved,
    ...(body.alerts !== undefined ? { alerts: bot.alerts, refile: refiled } : {}),
    ...(naming ? {
      named: look.name !== undefined, pictured: look.avatar !== undefined, renamed,
    } : {}),
  }));
  return json({ ok: true, bot, ...(refiled ? { refile: refiled } : {}) });
}
