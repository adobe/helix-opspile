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
  channelId as newChannelId, domainOf, mailOf, messageId, portalBotId, portalUserId,
} from './ids.js';
import { emit, eventStatement } from './events.js';

/**
 * The customer portal's record (portal/migrations): people, lobbies, channels, messages,
 * reactions and how far each customer has read. A **lobby** is one customer, by its mail
 * domain: the first of the domain to sign in founds it, its members invite colleagues of the
 * same domain, pick what they use of Adobe's, and ask for a channel. The inbox's admins open
 * one (src/portal/platform.js); from then on its members write there, and Adobe answers from
 * the inbox.
 *
 * Every change the inbox has to hear of writes an event with it (src/portal/events.js).
 */

export const MAX_TEXT = 8000;
export const MAX_MEMBERS = 200;
export const MAX_TECH = 60;
const MAX_NAME = 120;
const MAX_NOTE = 2000;
const THREADS = 200;
const MESSAGES = 1000;

/** The emoji a staff member marks a thread resolved with (src/resolve.js, for Teams). */
const RESOLVED = ['✅', '✔️'];

const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const iso = (now) => new Date(now).toISOString();

/** The mail domains this portal is open to (`PORTAL_DOMAINS`, comma-separated). */
export const portalDomains = (env) => String(env.PORTAL_DOMAINS || '').toLowerCase().split(',')
  .map((d) => d.trim())
  .filter(Boolean);

/** Whether someone with this mail address may use the portal: their domain is one of its. */
export function allowed(env, email) {
  const domain = domainOf(email);
  return domain !== null && portalDomains(env).includes(domain);
}

/** A name for someone who has not given one: `ada.lovelace@…` is Ada Lovelace. */
export function nameFromMail(email) {
  const local = mailOf(email).split('@')[0].replace(/\+.*$/, '');
  return local.split(/[._-]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || mailOf(email);
}

/** A company's name from its mail domain, until its people say: `acme-corp.com` is Acme Corp. */
export function companyFromDomain(domain) {
  const [first] = String(domain || '').split('.');
  return first.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

const publicUser = (u) => (u ? {
  id: u.id, name: u.name || nameFromMail(u.email), email: u.email || null, kind: u.kind,
} : null);

/**
 * The account of a mail address, made when it is first seen. A name given replaces the one
 * kept; `staff` (someone who answers from the inbox) stays, whatever comes later.
 */
export async function ensureUser(env, { email, name, kind = 'customer' }, now = Date.now()) {
  const mail = mailOf(email);
  const id = await portalUserId(mail);
  const given = clean(name, MAX_NAME) || null;
  await env.DB.prepare(`INSERT INTO users (id, email, name, domain, kind, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (id) DO UPDATE SET name = COALESCE(?7, users.name),
      kind = CASE WHEN ?5 = 'staff' THEN 'staff' ELSE users.kind END`)
    .bind(id, mail, given || nameFromMail(mail), domainOf(mail), kind, iso(now), given).run();
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

/** The account the inbox's app posts under, by its name. */
export async function ensureBot(env, name, now = Date.now()) {
  const called = clean(name, MAX_NAME) || 'Enterprise Support';
  const id = await portalBotId(called);
  await env.DB.prepare(`INSERT INTO users (id, email, name, domain, kind, created_at)
    VALUES (?, NULL, ?, NULL, 'bot', ?) ON CONFLICT (id) DO NOTHING`)
    .bind(id, called, iso(now)).run();
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

const parseTech = (s) => {
  try {
    const list = JSON.parse(s || '[]');
    return Array.isArray(list) ? list.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
};

/** A lobby's members, founder first, then as they were invited. */
export async function membersOf(env, domain) {
  const { results } = await env.DB.prepare(`SELECT u.id, u.name, u.email, u.kind, m.invited_by,
      m.invited_at, m.joined_at FROM members m JOIN users u ON u.id = m.user
    WHERE m.lobby = ? ORDER BY m.invited_by IS NOT NULL, m.invited_at, u.email`)
    .bind(domain).all();
  return (results || []).map((r) => ({
    ...publicUser(r), joined: Boolean(r.joined_at), invitedBy: r.invited_by || null,
  }));
}

/** A lobby as its people see it, or null. */
export async function lobbyOf(env, domain) {
  const l = await env.DB.prepare('SELECT * FROM lobbies WHERE domain = ?').bind(domain).first();
  return l ? {
    domain: l.domain,
    company: l.company || companyFromDomain(l.domain),
    tech: parseTech(l.tech),
    note: l.note || '',
    status: l.status,
    requestedAt: l.requested_at,
    requestedBy: l.requested_by,
    decidedAt: l.decided_at,
    reason: l.reason || null,
  } : null;
}

/**
 * Tells the inbox how a lobby is now: what it asks for and who is in it. A snapshot, so one
 * that is lost is made up for by the next. Nothing is told of a lobby nobody has asked from
 * yet (`draft`).
 */
export async function tellLobby(env, domain, now = Date.now()) {
  const lobby = await lobbyOf(env, domain);
  if (!lobby || lobby.status === 'draft') {
    return false;
  }
  const members = await membersOf(env, domain);
  const by = members.find((m) => m.id === lobby.requestedBy) || null;
  await emit(env, {
    type: 'lobby',
    domain,
    lobby: {
      company: lobby.company,
      tech: lobby.tech,
      note: lobby.note,
      status: lobby.status,
      requestedAt: lobby.requestedAt,
      requestedBy: by && { id: by.id, name: by.name, email: by.email },
      members: members.map((m) => ({
        id: m.id, name: m.name, email: m.email, joined: m.joined,
      })),
    },
  }, new Date(now));
  return true;
}

/**
 * Someone signed in (their mail address is verified by then): their account, their lobby,
 * and whether they are in it. The first of a domain founds its lobby; someone invited joins
 * it; anyone else of the domain is not in it until a member invites them.
 */
export async function signIn(env, email, now = Date.now()) {
  const domain = domainOf(email);
  // Someone who is in their lobby already: one read.
  const known = await env.DB.prepare(`SELECT u.* FROM users u JOIN members m ON m.user = u.id
    WHERE u.id = ? AND m.lobby = ? AND m.joined_at IS NOT NULL`)
    .bind(await portalUserId(email), domain).first();
  if (known) {
    return { user: publicUser(known), domain, member: true };
  }
  const user = await ensureUser(env, { email }, now);
  const at = iso(now);
  // The founder: whoever's lobby row is written. One written at the same moment keeps its own.
  const founded = await env.DB.prepare(`INSERT INTO lobbies (domain, created_by, created_at,
      updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (domain) DO NOTHING`)
    .bind(domain, user.id, at, at).run();
  if (founded.meta.changes) {
    await env.DB.prepare(`INSERT INTO members (lobby, user, invited_by, invited_at, joined_at)
      VALUES (?, ?, NULL, ?, ?) ON CONFLICT DO NOTHING`).bind(domain, user.id, at, at).run();
  }
  const member = await env.DB.prepare('SELECT * FROM members WHERE lobby = ? AND user = ?')
    .bind(domain, user.id).first();
  if (member && !member.joined_at) {
    await env.DB.prepare(`UPDATE members SET joined_at = ? WHERE lobby = ? AND user = ?
      AND joined_at IS NULL`).bind(at, domain, user.id).run();
    await tellLobby(env, domain, now);
  }
  return { user: publicUser(user), domain, member: Boolean(member) };
}

/** PUT /api/profile: what the person is called. */
export async function rename(env, user, name) {
  const given = clean(name, MAX_NAME);
  if (!given) {
    return { error: 'give your name', status: 400 };
  }
  await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(given, user.id).run();
  return { ok: true, name: given };
}

/**
 * PUT /api/lobby `{ company?, tech?, note? }`: what the lobby says of itself. `known` are the
 * technology ids one may pick (src/portal/tech.js); others are left out.
 */
export async function updateLobby(env, domain, body, known, now = Date.now()) {
  const sets = [];
  const args = [];
  if (body.company !== undefined) {
    sets.push('company = ?');
    args.push(clean(body.company, MAX_NAME) || null);
  }
  if (body.tech !== undefined) {
    const ids = new Set(known);
    const picked = [...new Set((Array.isArray(body.tech) ? body.tech : []).map(String))]
      .filter((t) => ids.has(t)).slice(0, MAX_TECH);
    sets.push('tech = ?');
    args.push(JSON.stringify(picked));
  }
  if (body.note !== undefined) {
    sets.push('note = ?');
    args.push(String(body.note ?? '').trim().slice(0, MAX_NOTE) || null);
  }
  if (!sets.length) {
    return { error: 'nothing to change', status: 400 };
  }
  await env.DB.prepare(`UPDATE lobbies SET ${sets.join(', ')}, updated_at = ? WHERE domain = ?`)
    .bind(...args, iso(now), domain).run();
  await tellLobby(env, domain, now);
  return { ok: true, lobby: await lobbyOf(env, domain) };
}

/**
 * POST /api/lobby/request: the lobby asks for a channel, as `user`. From `draft`, or again
 * after it was declined; one that asked already, or has a channel, stays as it is.
 */
export async function requestChannel(env, domain, user, now = Date.now()) {
  const at = iso(now);
  const { meta } = await env.DB.prepare(`UPDATE lobbies SET status = 'requested',
      requested_by = ?, requested_at = ?, decided_at = NULL, reason = NULL, updated_at = ?
    WHERE domain = ? AND status IN ('draft', 'declined')`).bind(user.id, at, at, domain).run();
  if (meta.changes) {
    await tellLobby(env, domain, now);
  }
  return { ok: true, changed: Boolean(meta.changes), lobby: await lobbyOf(env, domain) };
}

/**
 * POST /api/invite `{ email, name? }`: a member invites a colleague of the same domain. They
 * are in the lobby from then on, and join when they first sign in. Nothing is mailed: the
 * member tells them where the portal is.
 */
export async function invite(env, domain, user, body, now = Date.now()) {
  const mail = mailOf(body.email);
  if (domainOf(mail) !== domain) {
    return { error: `invite colleagues with an @${domain} address`, status: 400 };
  }
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE lobby = ?')
    .bind(domain).first('n');
  if (count >= MAX_MEMBERS) {
    return { error: `a lobby has at most ${MAX_MEMBERS} people`, status: 400 };
  }
  const invited = await ensureUser(env, { email: mail, name: body.name }, now);
  const { meta } = await env.DB.prepare(`INSERT INTO members (lobby, user, invited_by,
    invited_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(domain, invited.id, user.id, iso(now)).run();
  if (meta.changes) {
    await tellLobby(env, domain, now);
  }
  return { ok: true, added: Boolean(meta.changes), members: await membersOf(env, domain) };
}

/** DELETE /api/invite `{ user }`: takes back an invitation nobody has used yet. */
export async function uninvite(env, domain, body, now = Date.now()) {
  const { meta } = await env.DB.prepare(`DELETE FROM members WHERE lobby = ? AND user = ?
    AND joined_at IS NULL AND invited_by IS NOT NULL`).bind(domain, String(body.user || '')).run();
  if (!meta.changes) {
    return { error: 'no such invitation (someone who has signed in stays)', status: 404 };
  }
  await tellLobby(env, domain, now);
  return { ok: true, members: await membersOf(env, domain) };
}

/** A lobby's channels, oldest first. */
export async function channelsOf(env, domain) {
  const { results } = await env.DB.prepare(`SELECT id, name, topic, created_at FROM channels
    WHERE lobby = ? ORDER BY created_at, id`).bind(domain).all();
  return (results || []).map((c) => ({
    id: c.id, name: c.name, topic: c.topic || null, createdAt: c.created_at,
  }));
}

/** A channel of lobby `domain`, or null: nobody reads another lobby's. */
export async function channelOf(env, domain, id) {
  return env.DB.prepare('SELECT * FROM channels WHERE id = ? AND lobby = ?')
    .bind(String(id || ''), domain).first();
}

/** The first line of a message, as a thread's title. */
export function titleOf(body) {
  const line = String(body || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const plain = line.replace(/^#+\s*/, '').replace(/[*_`~]/g, '');
  return plain.length > 120 ? `${plain.slice(0, 117)}…` : plain;
}

/**
 * A channel's threads for `user`, latest activity first: each with its title, who started
 * it, its replies, how many messages of others the user has not read, and whether Adobe
 * marked it resolved.
 */
export async function threadsOf(env, channel, user) {
  const { results } = await env.DB.prepare(`SELECT r.id, r.body, r.at, r.deleted_at,
      u.id AS author_id, u.name AS author_name, u.kind AS author_kind,
      (SELECT COUNT(*) FROM messages m WHERE m.channel = r.channel AND m.root = r.id
        AND m.id != r.id AND m.deleted_at IS NULL) AS replies,
      (SELECT MAX(m.at) FROM messages m WHERE m.channel = r.channel AND m.root = r.id
        AND m.deleted_at IS NULL) AS latest,
      (SELECT COUNT(*) FROM messages m WHERE m.channel = r.channel AND m.root = r.id
        AND m.deleted_at IS NULL AND m.author != ?2
        AND m.at > COALESCE((SELECT at FROM reads x WHERE x.user = ?2 AND x.root = r.id), ''))
        AS unread,
      EXISTS (SELECT 1 FROM reactions x JOIN users s ON s.id = x.user WHERE x.message = r.id
        AND s.kind = 'staff' AND x.emoji IN (SELECT value FROM json_each(?3))) AS resolved
    FROM messages r JOIN users u ON u.id = r.author
    WHERE r.channel = ?1 AND r.root = r.id
    ORDER BY COALESCE(latest, r.at) DESC LIMIT ?4`)
    .bind(channel.id, user.id, JSON.stringify(RESOLVED), THREADS).all();
  return (results || [])
    // A thread whose every message is gone is gone.
    .filter((r) => !r.deleted_at || r.replies > 0)
    .map((r) => ({
      id: r.id,
      title: r.deleted_at ? '(deleted)' : titleOf(r.body),
      at: r.at,
      latest: r.latest || r.at,
      replies: r.replies,
      unread: r.unread,
      resolved: Boolean(r.resolved),
      author: { id: r.author_id, name: r.author_name, kind: r.author_kind },
    }));
}

/**
 * One thread for `user`: its messages, oldest first, each with its author and reactions (who
 * reacted, by name), or null when the channel has no such thread. Reading it marks it read.
 */
export async function threadOf(env, channel, root, user, now = Date.now()) {
  const { results } = await env.DB.prepare(`SELECT m.id, m.body, m.at, m.edited_at, m.deleted_at,
      u.id AS author_id, u.name AS author_name, u.kind AS author_kind
    FROM messages m JOIN users u ON u.id = m.author
    WHERE m.channel = ? AND m.root = ? ORDER BY m.at, m.rowid LIMIT ?`)
    .bind(channel.id, String(root || ''), MESSAGES).all();
  const rows = results || [];
  if (!rows.length) {
    return null;
  }
  const { results: reacted } = await env.DB.prepare(`SELECT x.message, x.emoji, x.user, x.at,
      u.name, u.kind FROM reactions x JOIN users u ON u.id = x.user
    WHERE x.message IN (SELECT id FROM messages WHERE channel = ? AND root = ?)
    ORDER BY x.at`).bind(channel.id, String(root)).all();
  const by = new Map();
  for (const r of reacted || []) {
    const list = by.get(r.message) || by.set(r.message, new Map()).get(r.message);
    const chip = list.get(r.emoji) || list.set(r.emoji, {
      emoji: r.emoji, count: 0, mine: false, names: [], staff: false,
    }).get(r.emoji);
    chip.count += 1;
    chip.mine = chip.mine || r.user === user.id;
    chip.staff = chip.staff || r.kind === 'staff';
    chip.names.push(r.name);
  }
  const latest = rows.reduce((a, r) => (r.at > a ? r.at : a), '');
  await env.DB.prepare(`INSERT INTO reads (user, root, at) VALUES (?, ?, ?)
    ON CONFLICT (user, root) DO UPDATE SET at = MAX(reads.at, excluded.at)`)
    .bind(user.id, String(root), latest || iso(now)).run();
  const first = rows[0];
  return {
    id: first.id,
    title: first.deleted_at ? '(deleted)' : titleOf(first.body),
    resolved: [...(by.get(first.id) || new Map()).values()]
      .some((c) => c.staff && RESOLVED.includes(c.emoji)),
    messages: rows.map((r) => ({
      id: r.id,
      at: r.at,
      editedAt: r.edited_at || null,
      deleted: Boolean(r.deleted_at),
      body: r.deleted_at ? '' : r.body,
      mine: r.author_id === user.id,
      author: { id: r.author_id, name: r.author_name, kind: r.author_kind },
      reactions: [...(by.get(r.id) || new Map()).values()].map((c) => ({
        emoji: c.emoji, count: c.count, mine: c.mine, names: c.names,
      })),
    })),
  };
}

const channelInfo = async (env, channel) => ({
  id: channel.id,
  name: channel.name,
  topic: channel.topic || null,
  company: (await lobbyOf(env, channel.lobby) || {}).company || null,
});

const authorInfo = (u) => ({
  id: u.id,
  name: u.name || (u.email ? nameFromMail(u.email) : null),
  email: u.email || null,
  kind: u.kind,
});

/** Where a message is, in the portal: `<origin>/?c=<channel>&t=<thread>#<message>`. */
export function permalink(env, channel, root, id) {
  const origin = String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  return origin
    ? `${origin}/?c=${encodeURIComponent(channel)}&t=${encodeURIComponent(root)}${id && id !== root ? `#${id}` : ''}`
    : undefined;
}

/** The event of a message as it is now: posted, edited or deleted. */
async function messageEvent(env, channel, author, m) {
  return {
    type: 'message',
    domain: channel.lobby,
    channel: await channelInfo(env, channel),
    author: authorInfo(author),
    message: {
      id: m.id,
      root: m.root,
      rev: m.rev || 0,
      at: m.at,
      editedAt: m.edited_at || undefined,
      deletedAt: m.deleted_at || undefined,
      text: m.deleted_at ? '' : m.body,
      permalink: permalink(env, channel.id, m.root, m.id),
    },
  };
}

/**
 * Writes a message of `author` (an account row) in `channel`: a reply in thread `root`, or
 * without one the first message of a new thread. A reply to a reply goes to its thread.
 * `{ ok, id, root }`, or `{ error, status }`.
 */
export async function writeMessage(env, channel, author, { root, text }, now = Date.now()) {
  const body = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!body || body.length > MAX_TEXT) {
    return { error: `write something (up to ${MAX_TEXT} characters)`, status: 400 };
  }
  let thread = null;
  if (root) {
    const parent = await env.DB.prepare(`SELECT root, deleted_at FROM messages
      WHERE id = ? AND channel = ?`).bind(String(root), channel.id).first();
    if (!parent) {
      return { error: 'no such thread in this channel', status: 404 };
    }
    thread = parent.root;
  }
  const id = messageId(now);
  const m = {
    id, root: thread || id, body, at: iso(now),
  };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO messages (id, channel, root, author, body, at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(m.id, channel.id, m.root, author.id, m.body, m.at),
    // Its author has read their own message.
    env.DB.prepare(`INSERT INTO reads (user, root, at) VALUES (?, ?, ?)
      ON CONFLICT (user, root) DO UPDATE SET at = MAX(reads.at, excluded.at)`)
      .bind(author.id, m.root, m.at),
    eventStatement(env, await messageEvent(env, channel, author, m), new Date(now)),
  ]);
  return { ok: true, id: m.id, root: m.root };
}

/** A message of `channel` with its author's account, or null. */
async function messageOf(env, channel, id) {
  const m = await env.DB.prepare('SELECT * FROM messages WHERE id = ? AND channel = ?')
    .bind(String(id || ''), channel.id).first();
  const author = m && await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(m.author).first();
  return m && author ? { m, author } : null;
}

/** Changes the text of one's own message. */
export async function editMessage(env, channel, user, { id, text }, now = Date.now()) {
  const body = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!body || body.length > MAX_TEXT) {
    return { error: `write something (up to ${MAX_TEXT} characters)`, status: 400 };
  }
  const found = await messageOf(env, channel, id);
  if (!found || found.m.deleted_at) {
    return { error: 'no such message', status: 404 };
  }
  if (found.m.author !== user.id) {
    return { error: 'only its author changes a message', status: 403 };
  }
  const m = {
    ...found.m, body, edited_at: iso(now), rev: found.m.rev + 1,
  };
  await env.DB.batch([
    env.DB.prepare('UPDATE messages SET body = ?, edited_at = ?, rev = ? WHERE id = ?')
      .bind(m.body, m.edited_at, m.rev, m.id),
    eventStatement(env, await messageEvent(env, channel, found.author, m), new Date(now)),
  ]);
  return { ok: true, id: m.id, root: m.root };
}

/** Deletes one's own message: it stays as a tombstone, without its text. */
export async function deleteMessage(env, channel, user, { id }, now = Date.now()) {
  const found = await messageOf(env, channel, id);
  if (!found || found.m.deleted_at) {
    return { error: 'no such message', status: 404 };
  }
  if (found.m.author !== user.id) {
    return { error: 'only its author deletes a message', status: 403 };
  }
  const m = {
    ...found.m, body: '', deleted_at: iso(now), rev: found.m.rev + 1,
  };
  await env.DB.batch([
    env.DB.prepare("UPDATE messages SET body = '', deleted_at = ?, rev = ? WHERE id = ?")
      .bind(m.deleted_at, m.rev, m.id),
    env.DB.prepare('DELETE FROM reactions WHERE message = ?').bind(m.id),
    eventStatement(env, await messageEvent(env, channel, found.author, m), new Date(now)),
  ]);
  return { ok: true, id: m.id, root: m.root };
}

/** A reaction as the portal keeps it: the emoji itself, up to a few characters. */
export function reactionOf(emoji) {
  const e = String(emoji || '').trim();
  return e.length <= 16 && /^[\p{Extended_Pictographic}\p{Emoji_Component}]+$/u.test(e)
    && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(e) ? e : null;
}

/**
 * Adds a reaction of `user` (an account row) to a message, or with `removed` takes it off.
 * Doing either twice changes nothing, and tells the inbox nothing.
 */
export async function reactTo(env, channel, user, { id, emoji, removed }, now = Date.now()) {
  const e = reactionOf(emoji);
  if (!e) {
    return { error: 'not a reaction', status: 400 };
  }
  const found = await messageOf(env, channel, id);
  if (!found || found.m.deleted_at) {
    return { error: 'no such message', status: 404 };
  }
  const at = iso(now);
  const change = removed
    ? env.DB.prepare('DELETE FROM reactions WHERE message = ? AND user = ? AND emoji = ?')
      .bind(found.m.id, user.id, e)
    : env.DB.prepare(`INSERT INTO reactions (message, user, emoji, at) VALUES (?, ?, ?, ?)
      ON CONFLICT DO NOTHING`).bind(found.m.id, user.id, e, at);
  const { meta } = await change.run();
  if (meta.changes) {
    await emit(env, {
      type: 'reaction',
      domain: channel.lobby,
      channel: await channelInfo(env, channel),
      author: authorInfo(user),
      reaction: {
        message: found.m.id, root: found.m.root, emoji: e, removed: Boolean(removed), at,
      },
    }, new Date(now));
  }
  return {
    ok: true, id: found.m.id, root: found.m.root, emoji: e, changed: Boolean(meta.changes),
  };
}

/**
 * Opens a channel for lobby `domain`, as the inbox asks (src/portal/platform.js): the lobby
 * is `open` from then on, and every member of it is in the channel. `{ ok, channel }`.
 */
export async function openChannel(env, domain, { name, topic, by }, now = Date.now()) {
  const lobby = await lobbyOf(env, domain);
  if (!lobby) {
    return { error: 'no such lobby', status: 404 };
  }
  const called = clean(name, 80) || 'support';
  const id = newChannelId();
  const at = iso(now);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO channels (id, lobby, name, topic, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, domain, called, clean(topic, 300) || null, mailOf(by && by.email) || null, at),
    env.DB.prepare(`UPDATE lobbies SET status = 'open', decided_at = ?, reason = NULL,
      updated_at = ? WHERE domain = ?`).bind(at, at, domain),
  ]);
  const channel = await channelOf(env, domain, id);
  await emit(env, {
    type: 'channel', domain, channel: await channelInfo(env, channel),
  }, new Date(now));
  await tellLobby(env, domain, now);
  return { ok: true, channel: { id, name: called } };
}

/** Declines what lobby `domain` asked for, with a reason its people read. */
export async function declineLobby(env, domain, { reason }, now = Date.now()) {
  const at = iso(now);
  const { meta } = await env.DB.prepare(`UPDATE lobbies SET status = 'declined', decided_at = ?,
      reason = ?, updated_at = ? WHERE domain = ? AND status = 'requested'`)
    .bind(at, String(reason ?? '').trim().slice(0, 500) || null, at, domain).run();
  if (!meta.changes) {
    return { error: 'this lobby is not waiting for a channel', status: 409 };
  }
  await tellLobby(env, domain, now);
  return { ok: true };
}

/**
 * Tells the inbox of a thread's messages again (`root`), or of all of a channel's: the inbox
 * asks when it has a reply without its thread.
 */
export async function resend(env, channel, root = null, now = Date.now()) {
  const { results } = await env.DB.prepare(`SELECT * FROM messages WHERE channel = ?1
    AND (?2 IS NULL OR root = ?2) ORDER BY at, rowid LIMIT ?3`)
    .bind(channel.id, root ? String(root) : null, MESSAGES).all();
  const rows = results || [];
  const authors = new Map();
  const statements = [];
  for (const m of rows) {
    if (!authors.has(m.author)) {
      // eslint-disable-next-line no-await-in-loop
      authors.set(m.author, await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(m.author).first());
    }
    // eslint-disable-next-line no-await-in-loop
    const event = await messageEvent(env, channel, authors.get(m.author), m);
    statements.push(eventStatement(env, { ...event, via: 'resend' }, new Date(now)));
  }
  if (statements.length) {
    await env.DB.batch(statements);
  }
  return { ok: true, messages: rows.length };
}
