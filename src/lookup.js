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

import { discordApi, discordAvatar, staffRolesOf } from './discord.js';
import { cachedGraph } from './graph.js';
import { sha256 } from './raw.js';

/** The Slack Connect teams of a channel (a conversation object): every team but its own. */
export const connectedTeams = (c) => [...new Set([
  ...(c.connected_team_ids || []), ...(c.shared_team_ids || []),
])].filter((t) => t !== c.context_team_id);

/**
 * Channel and author lookups, cached in D1 (`channels`, `identities`). These are the
 * only platform calls the normalizer makes; everything else comes from pile 1.
 */

const domainOf = (email) => (email && email.includes('@') ? email.split('@').pop().toLowerCase() : null);

/** Whether a mail domain is one of STAFF_DOMAINS. */
export function isStaffDomain(env, email) {
  const domains = String(env.STAFF_DOMAINS || '').toLowerCase().split(',').map((d) => d.trim())
    .filter(Boolean);
  const domain = domainOf(email);
  return domain !== null && domains.includes(domain);
}

/** Cached rows older than this are fetched again. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const fresh = (row, now) => row && Date.parse(row.fetched_at) > now - MAX_AGE_MS;

export async function slackApi(env, method, params) {
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`slack ${method}: ${data.error}`);
  }
  return data;
}

async function graphJson(env, path) {
  const graph = await cachedGraph(env);
  const res = await graph(path);
  if (!res.ok) {
    throw new Error(`graph ${res.status} ${path.split('?')[0].split('/')[1]}`);
  }
  return res.json();
}

async function fetchSlackChannel(env, channelId) {
  const { channel: c } = await slackApi(env, 'conversations.info', { channel: channelId });
  const connected = connectedTeams(c);
  return {
    name: c.name,
    group_id: c.context_team_id || null,
    group_name: null,
    shared: c.is_ext_shared || c.is_shared ? 1 : 0,
    connected: JSON.stringify(connected),
    topic: (c.purpose && c.purpose.value) || (c.topic && c.topic.value) || null,
  };
}

async function fetchTeamsChannel(env, teamId, channelId) {
  const t = encodeURIComponent(teamId);
  const [team, channel] = await Promise.all([
    graphJson(env, `/teams/${t}?$select=displayName,description`),
    graphJson(env, `/teams/${t}/channels/${encodeURIComponent(channelId)}?$select=displayName,description,membershipType`),
  ]);
  return {
    name: channel.displayName,
    group_id: teamId,
    group_name: team.displayName,
    shared: channel.membershipType === 'shared' ? 1 : 0,
    connected: '[]',
    topic: channel.description || team.description || null,
  };
}

/** Guild names, per isolate: every Discord channel lookup names its guild. */
const guildNames = new Map();

async function fetchDiscordChannel(env, guild, channelId) {
  const ch = await discordApi(env, `/channels/${channelId}`);
  if (!guildNames.has(guild)) {
    const g = await discordApi(env, `/guilds/${guild}`, { allow: [403, 404] });
    guildNames.set(guild, (g && g.name) || null);
  }
  return {
    name: ch.name,
    group_id: guild,
    group_name: guildNames.get(guild),
    shared: 0,
    connected: '[]',
    topic: ch.topic || null,
  };
}

export function toChannel(row, source, channelId) {
  return {
    source,
    channelId,
    name: row ? row.name : null,
    groupId: row ? row.group_id : null,
    groupName: row ? row.group_name : null,
    shared: Boolean(row && row.shared),
    connected: row && row.connected ? JSON.parse(row.connected) : [],
  };
}

/**
 * The channel's metadata, from D1 or the platform. A failed lookup is not fatal: the
 * message is filed with what is known, and the next message retries the lookup.
 */
export async function getChannel(env, {
  source, tenant, channelId, groupId,
}, now = Date.now()) {
  const row = await env.DB.prepare(
    'SELECT * FROM channels WHERE source = ? AND tenant = ? AND channel_id = ?',
  ).bind(source, tenant, channelId).first();
  if (fresh(row, now) && row.name) {
    return toChannel(row, source, channelId);
  }
  try {
    let f;
    if (source === 'slack') {
      f = await fetchSlackChannel(env, channelId);
    } else if (source === 'discord') {
      f = await fetchDiscordChannel(env, tenant, channelId);
    } else {
      f = await fetchTeamsChannel(env, groupId || (row && row.group_id), channelId);
    }
    await env.DB.prepare(`INSERT INTO channels
      (source, tenant, channel_id, name, group_id, group_name, shared, connected, topic, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source, tenant, channel_id) DO UPDATE SET name = excluded.name,
        group_id = excluded.group_id, group_name = excluded.group_name,
        shared = excluded.shared, connected = excluded.connected,
        topic = excluded.topic, fetched_at = excluded.fetched_at`)
      .bind(
        source,
        tenant,
        channelId,
        f.name,
        f.group_id,
        f.group_name,
        f.shared,
        f.connected,
        f.topic ? String(f.topic).slice(0, 500) : null,
        new Date(now).toISOString(),
      )
      .run();
    return toChannel(f, source, channelId);
  } catch (e) {
    console.warn(JSON.stringify({
      route: 'normalize', lookup: 'channel', source, error: e.message,
    }));
    return toChannel(row, source, channelId);
  }
}

/** Records a rename or creation that arrived as an event, without a lookup. */
export async function updateChannelName(env, {
  source, tenant, channelId, name,
}, now = Date.now()) {
  await env.DB.prepare(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (source, tenant, channel_id) DO UPDATE SET name = excluded.name,
      fetched_at = excluded.fetched_at`)
    .bind(source, tenant, channelId, name, new Date(now).toISOString())
    .run();
}

/** Gravatar URL for an email; Gravatar answers 404 when there is no picture. */
export async function gravatar(email) {
  return email
    ? `https://gravatar.com/avatar/${await sha256(String(email).trim().toLowerCase())}?s=96&d=404`
    : '';
}

async function fetchSlackUser(env, userId) {
  const { user: u } = await slackApi(env, 'users.info', { user: userId });
  const p = u.profile || {};
  const image = p.is_custom_image === false ? null : (p.image_72 || p.image_48 || null);
  return {
    avatar: image || await gravatar(p.email),
    kind: u.is_bot || u.id === 'USLACKBOT' ? 'bot' : 'person',
    name: u.real_name || (u.profile && u.profile.real_name) || u.name,
    email: (u.profile && u.profile.email) || null,
    home: u.team_id || null,
    title: p.title || null,
    company: null,
  };
}

/**
 * A staff member's Slack profile picture by email, so Adobe people look the same on both
 * platforms. Null when Slack does not know them or has no custom picture.
 */
async function slackAvatarByEmail(env, email) {
  if (!email || !env.SLACK_BOT_TOKEN || !isStaffDomain(env, email)) {
    return null;
  }
  try {
    const { user } = await slackApi(env, 'users.lookupByEmail', { email });
    const p = (user && user.profile) || {};
    return p.is_custom_image === false ? null : (p.image_72 || p.image_48 || null);
  } catch {
    return null;
  }
}

async function fetchTeamsUser(env, userId, fallbackName) {
  try {
    const u = await graphJson(
      env,
      `/users/${encodeURIComponent(userId)}?$select=displayName,mail,userPrincipalName,jobTitle,companyName`,
    );
    const upn = /#EXT#/i.test(u.userPrincipalName || '') ? null : u.userPrincipalName;
    const email = u.mail || upn || null;
    return {
      kind: 'person',
      name: u.displayName || fallbackName,
      email,
      home: null,
      avatar: await slackAvatarByEmail(env, email) || await gravatar(email),
      title: u.jobTitle || null,
      company: u.companyName || null,
    };
  } catch (e) {
    // Users from other tenants cannot always be read; keep what the message says.
    return {
      kind: 'person', name: fallbackName || null, email: null, home: null, avatar: '', error: e.message,
    };
  }
}

/**
 * A Discord account as a member of the guild: their server nickname and avatar, and whether
 * one of their roles is in DISCORD_STAFF_ROLES. Discord shares no email with bots, so the
 * account is linked to a person only when they connect it in the inbox (src/post.js).
 */
async function fetchDiscordUser(env, guild, userId, fallbackName) {
  const member = await discordApi(env, `/guilds/${guild}/members/${userId}`, { allow: [404] });
  const user = (member && member.user)
    || await discordApi(env, `/users/${userId}`, { allow: [404] }) || { id: userId };
  const staffRoles = staffRolesOf(env);
  return {
    kind: user.bot ? 'bot' : 'person',
    name: (member && member.nick) || user.global_name || user.username || fallbackName || null,
    email: null,
    home: null,
    avatar: discordAvatar(user, guild, member),
    title: null,
    company: null,
    staff: Boolean(member && (member.roles || []).some((r) => staffRoles.has(r))),
  };
}

/**
 * The identity behind an authorRef, from D1 or the platform, linked to a person by
 * email when one is known (on Discord: by the person connecting the account).
 */
export async function getIdentity(env, ref, now = Date.now()) {
  const row = await env.DB.prepare(`SELECT i.*, p.staff AS person_staff, p.name AS person_name
    FROM identities i LEFT JOIN people p ON p.id = i.person
    WHERE i.source = ? AND i.tenant = ? AND i.user_id = ?`)
    .bind(ref.source, ref.tenant, ref.userId).first();
  // Rows cached before avatars existed have avatar NULL; '' means "looked, none".
  if (fresh(row, now) && row.avatar !== null && row.avatar !== undefined) {
    return row;
  }
  let f;
  try {
    if (ref.source === 'slack') {
      f = await fetchSlackUser(env, ref.userId);
    } else if (ref.source === 'discord') {
      f = await fetchDiscordUser(env, ref.tenant, ref.userId, ref.name);
    } else {
      f = await fetchTeamsUser(env, ref.userId, ref.name);
    }
  } catch (e) {
    console.warn(JSON.stringify({
      route: 'normalize', lookup: 'user', source: ref.source, error: e.message,
    }));
    return row || {
      kind: ref.bot ? 'bot' : 'person', name: ref.name || ref.userId, email: null, home: ref.home,
    };
  }
  // Staff become people the first time they show up, so their reads count towards
  // "somebody at Adobe has seen it" even when they are in no ops team.
  if (f.email && f.kind === 'person' && isStaffDomain(env, f.email)) {
    await env.DB.prepare(`INSERT INTO people (email, name, staff) VALUES (?, ?, 1)
      ON CONFLICT (email) DO UPDATE SET staff = 1`).bind(f.email, f.name).run();
  }
  let person = f.email
    ? await env.DB.prepare('SELECT id, staff, name FROM people WHERE email = ?').bind(f.email).first()
    : null;
  if (!person && ref.source === 'discord' && row && row.person) {
    // Linked when the person connected the account: Discord itself never says who it is.
    person = await env.DB.prepare('SELECT id, staff, name FROM people WHERE id = ?').bind(row.person).first();
  }
  const home = f.home || ref.home || null;
  await env.DB.prepare(`INSERT INTO identities
    (source, tenant, user_id, kind, name, email, home, person, fetched_at, avatar, title, company,
     staff)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, tenant, user_id) DO UPDATE SET kind = excluded.kind,
      name = excluded.name, email = excluded.email, home = excluded.home,
      person = excluded.person, fetched_at = excluded.fetched_at, avatar = excluded.avatar,
      title = excluded.title, company = excluded.company, staff = excluded.staff`)
    .bind(
      ref.source,
      ref.tenant,
      ref.userId,
      f.kind,
      f.name,
      f.email,
      home,
      person ? person.id : null,
      new Date(now).toISOString(),
      f.avatar || '',
      f.title || null,
      f.company || null,
      f.staff ? 1 : null,
    )
    .run();
  return {
    ...f,
    staff: f.staff ? 1 : null,
    avatar: f.avatar || '',
    home,
    person: person ? person.id : null,
    person_staff: person ? person.staff : null,
    person_name: person ? person.name : null,
  };
}

/**
 * `{ kind, name, org, staff }` for the frontmatter. Staff are people marked as staff in
 * D1, or whose mail domain is one of STAFF_DOMAINS; the org of everyone else is their
 * mail domain (on Teams everyone is a guest, so the tenant says nothing).
 */
export function toAuthor(env, identity) {
  const domain = domainOf(identity.email);
  const staff = Boolean(identity.person_staff) || Boolean(identity.staff)
    || isStaffDomain(env, identity.email);
  return {
    kind: identity.kind || 'person',
    name: identity.person_name || identity.name || null,
    org: domain,
    staff,
  };
}

export async function loadRules(env) {
  const { results } = await env.DB.prepare('SELECT * FROM rules').all();
  return results || [];
}
