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

import { cachedGraph } from './graph.js';

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

async function slackApi(env, method, params) {
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
  const connected = [...new Set([
    ...(c.connected_team_ids || []), ...(c.shared_team_ids || []),
  ])].filter((t) => t !== c.context_team_id);
  return {
    name: c.name,
    group_id: c.context_team_id || null,
    group_name: null,
    shared: c.is_ext_shared || c.is_shared ? 1 : 0,
    connected: JSON.stringify(connected),
  };
}

async function fetchTeamsChannel(env, teamId, channelId) {
  const t = encodeURIComponent(teamId);
  const [team, channel] = await Promise.all([
    graphJson(env, `/teams/${t}?$select=displayName`),
    graphJson(env, `/teams/${t}/channels/${encodeURIComponent(channelId)}?$select=displayName,membershipType`),
  ]);
  return {
    name: channel.displayName,
    group_id: teamId,
    group_name: team.displayName,
    shared: channel.membershipType === 'shared' ? 1 : 0,
    connected: '[]',
  };
}

function toChannel(row, source, channelId) {
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
    const f = source === 'slack'
      ? await fetchSlackChannel(env, channelId)
      : await fetchTeamsChannel(env, groupId || (row && row.group_id), channelId);
    await env.DB.prepare(`INSERT INTO channels
      (source, tenant, channel_id, name, group_id, group_name, shared, connected, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source, tenant, channel_id) DO UPDATE SET name = excluded.name,
        group_id = excluded.group_id, group_name = excluded.group_name,
        shared = excluded.shared, connected = excluded.connected,
        fetched_at = excluded.fetched_at`)
      .bind(
        source,
        tenant,
        channelId,
        f.name,
        f.group_id,
        f.group_name,
        f.shared,
        f.connected,
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

async function fetchSlackUser(env, userId) {
  const { user: u } = await slackApi(env, 'users.info', { user: userId });
  return {
    kind: u.is_bot || u.id === 'USLACKBOT' ? 'bot' : 'person',
    name: u.real_name || (u.profile && u.profile.real_name) || u.name,
    email: (u.profile && u.profile.email) || null,
    home: u.team_id || null,
  };
}

async function fetchTeamsUser(env, userId, fallbackName) {
  try {
    const u = await graphJson(
      env,
      `/users/${encodeURIComponent(userId)}?$select=displayName,mail,userPrincipalName`,
    );
    const upn = /#EXT#/i.test(u.userPrincipalName || '') ? null : u.userPrincipalName;
    return {
      kind: 'person', name: u.displayName || fallbackName, email: u.mail || upn || null, home: null,
    };
  } catch (e) {
    // Users from other tenants cannot always be read; keep what the message says.
    return {
      kind: 'person', name: fallbackName || null, email: null, home: null, error: e.message,
    };
  }
}

/**
 * The identity behind an authorRef, from D1 or the platform, linked to a person by
 * email when one is known.
 */
export async function getIdentity(env, ref, now = Date.now()) {
  const row = await env.DB.prepare(`SELECT i.*, p.staff AS person_staff, p.name AS person_name
    FROM identities i LEFT JOIN people p ON p.id = i.person
    WHERE i.source = ? AND i.tenant = ? AND i.user_id = ?`)
    .bind(ref.source, ref.tenant, ref.userId).first();
  if (fresh(row, now)) {
    return row;
  }
  let f;
  try {
    f = ref.source === 'slack'
      ? await fetchSlackUser(env, ref.userId)
      : await fetchTeamsUser(env, ref.userId, ref.name);
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
  const person = f.email
    ? await env.DB.prepare('SELECT id, staff, name FROM people WHERE email = ?').bind(f.email).first()
    : null;
  const home = f.home || ref.home || null;
  await env.DB.prepare(`INSERT INTO identities
    (source, tenant, user_id, kind, name, email, home, person, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, tenant, user_id) DO UPDATE SET kind = excluded.kind,
      name = excluded.name, email = excluded.email, home = excluded.home,
      person = excluded.person, fetched_at = excluded.fetched_at`)
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
    )
    .run();
  return {
    ...f,
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
  const staff = Boolean(identity.person_staff) || isStaffDomain(env, identity.email);
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
