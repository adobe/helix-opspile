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
import { gravatar } from './raw.js';
import { mergeRule } from './rules.js';

/** The Slack Connect teams of a channel (a conversation object): every team but its own. */
export const connectedTeams = (c) => [...new Set([
  ...(c.connected_team_ids || []), ...(c.shared_team_ids || []),
])].filter((t) => t !== c.context_team_id);

/**
 * Channel and author lookups, cached in D1 (`channels`, `identities`). These are the
 * only platform calls the normalizer makes; everything else comes from pile 1.
 */

const domainOf = (email) => (email && email.includes('@') ? email.split('@').pop().toLowerCase() : null);

/** The mail domains of a comma-separated var, lower case. */
export const domainList = (value) => String(value || '').toLowerCase().split(',')
  .map((d) => d.trim())
  .filter(Boolean);

/** Whether a mail domain is one of STAFF_DOMAINS. */
export function isStaffDomain(env, email) {
  const domain = domainOf(email);
  return domain !== null && domainList(env.STAFF_DOMAINS).includes(domain);
}

/**
 * Whether a mail domain is one of SIGNIN_DOMAINS: anyone with an email there may sign in to
 * the inbox without being on an ops team (no-team mode), and has the personal view.
 */
export function isSignInDomain(env, email) {
  const domain = domainOf(email);
  return domain !== null && domainList(env.SIGNIN_DOMAINS).includes(domain);
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
    throw Object.assign(new Error(`slack ${method}: ${data.error}`), { code: data.error });
  }
  return data;
}

/**
 * What Slack answers `conversations.info` for a channel the app can no longer read at all: one
 * deleted, one it was removed from, the other org's side of a Slack Connect channel that was
 * disconnected (Adobe's side lives on under a new id), and one in a workspace the app is no
 * longer granted. No message comes from such a channel, so it is recorded as archived.
 */
const SLACK_GONE = new Set(['channel_not_found', 'team_access_not_granted']);

async function graphJson(env, path) {
  const graph = await cachedGraph(env);
  const res = await graph(path);
  if (!res.ok) {
    throw new Error(`graph ${res.status} ${path.split('?')[0].split('/')[1]}`);
  }
  return res.json();
}

/**
 * Slack workspace domains by team id (team.info), per isolate, for as long as a channel row
 * stays fresh. A failed lookup is not kept: the channel row records '' and asks again once it
 * is looked up again (MAX_AGE_MS later), when the API may answer.
 */
const slackDomains = new Map();

async function slackDomain(env, team, now) {
  const hit = slackDomains.get(team);
  if (hit && hit.at > now - MAX_AGE_MS) {
    return hit.domain;
  }
  try {
    const { team: t } = await slackApi(env, 'team.info', { team });
    const domain = (t && t.domain) || '';
    if (domain) {
      slackDomains.set(team, { domain, at: now });
    }
    return domain;
  } catch (e) {
    console.warn(JSON.stringify({ route: 'normalize', lookup: 'team', error: e.message }));
    slackDomains.delete(team);
    return '';
  }
}

/** The workspace most of a tenant's Slack channels live in, per isolate, kept like a domain. */
const homeTeams = new Map();

async function homeTeam(env, tenant, now) {
  const hit = homeTeams.get(tenant);
  if (hit && hit.at > now - MAX_AGE_MS) {
    return hit.team;
  }
  const row = await env.DB.prepare(`SELECT group_id FROM channels
    WHERE source = 'slack' AND tenant = ? AND group_id LIKE 'T%'
    GROUP BY group_id ORDER BY count(*) DESC, group_id LIMIT 1`).bind(tenant).first();
  const team = row ? row.group_id : null;
  if (team) {
    homeTeams.set(tenant, { team, at: now });
  }
  return team;
}

/**
 * The workspace a Slack channel's links open in. A channel of the whole Enterprise org (its
 * `context_team_id` is the org's) or one shared between its workspaces is in several; of
 * those, the one most channels live in, where the people reading the inbox are.
 */
async function linkTeam(env, tenant, c, now) {
  const teams = [...new Set([c.context_team_id, ...(c.shared_team_ids || [])])]
    .filter((t) => /^T/.test(t || ''));
  if (teams.length < 2) {
    return teams[0] || null;
  }
  const home = await homeTeam(env, tenant, now);
  return teams.includes(home) ? home : teams[0];
}

export function resetSlackDomains() {
  slackDomains.clear();
  homeTeams.clear();
}

async function fetchSlackChannel(env, tenant, channelId, now) {
  const { channel: c } = await slackApi(env, 'conversations.info', { channel: channelId });
  const connected = connectedTeams(c);
  const team = await linkTeam(env, tenant, c, now);
  return {
    name: c.name,
    group_id: c.context_team_id || null,
    group_name: null,
    shared: c.is_ext_shared || c.is_shared ? 1 : 0,
    connected: JSON.stringify(connected),
    topic: (c.purpose && c.purpose.value) || (c.topic && c.topic.value) || null,
    domain: team ? await slackDomain(env, team, now) : '',
    archived: Boolean(c.is_archived),
  };
}

async function fetchTeamsChannel(env, teamId, channelId) {
  const t = encodeURIComponent(teamId);
  const [team, channel] = await Promise.all([
    graphJson(env, `/teams/${t}?$select=displayName,description,isArchived`),
    graphJson(env, `/teams/${t}/channels/${encodeURIComponent(channelId)}?$select=displayName,description,membershipType,isArchived`),
  ]);
  return {
    name: channel.displayName,
    group_id: teamId,
    group_name: team.displayName,
    shared: channel.membershipType === 'shared' ? 1 : 0,
    connected: '[]',
    topic: channel.description || team.description || null,
    // An archived team's channels are archived too.
    archived: Boolean(channel.isArchived || team.isArchived),
    teamArchived: Boolean(team.isArchived),
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

/**
 * A customer portal channel, from what its event says of it (`channelHint`, src/normalize.js):
 * the portal is not asked. Its lobby (the customer's mail domain) is its group, named as the
 * customer calls itself, and customers are in it by definition, so it is shared.
 */
function portalChannel(tenant, hint) {
  return {
    name: hint.name,
    group_id: tenant,
    group_name: hint.company || null,
    shared: 1,
    connected: '[]',
    topic: hint.topic || null,
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
    domain: (row && row.domain) || null,
  };
}

/**
 * Points the stored links of a Slack channel's messages at its workspace, once the channel's
 * domain is first known (or changed), so threads filed before that open in the right place.
 */
async function relinkSlackChannel(env, tenant, channelId, domain) {
  const prefix = `https://${domain}.slack.com/archives/`;
  await env.DB.prepare(`UPDATE messages
    SET permalink = ? || substr(permalink, instr(permalink, '/archives/') + length('/archives/'))
    WHERE source = 'slack' AND tenant = ? AND channel_id = ?
      AND instr(permalink, '/archives/') > 0 AND substr(permalink, 1, length(?)) != ?`)
    .bind(prefix, tenant, channelId, prefix, prefix)
    .run();
}

/**
 * What the rules read of a channel (src/rules.js, besides its id): when one of these changes, a
 * channel may be filed elsewhere (src/refile.js `followChange`).
 */
const CLASSIFIED = ['name', 'group_name', 'connected'];

const classifiedChanged = (row, next) => CLASSIFIED
  .some((f) => (row[f] ?? null) !== (next[f] ?? null));

/**
 * The channel's metadata, from D1 or the platform. A failed lookup is not fatal: the
 * message is filed with what is known, and the next message retries the lookup.
 *
 * `refresh` asks the platform even when the row is fresh (a notice of a rename or an archive), and
 * `at` (when the message it is looked up for was sent) does when the row has the channel archived
 * before then. A lookup records whether the channel is archived (`archived_at`), or gone from
 * Slack (`SLACK_GONE`), which counts as archived. When
 * the lookup changed what the rules read, `onChange(before, after)` (the channel as `toChannel`
 * gives it) runs before the row is written: `followChange` (src/refile.js) queues its threads'
 * moves there. The row is the guard, so it comes last; when `onChange` fails, so does this, with
 * the row as it was, and a retry finds the change again.
 */
export async function getChannel(env, {
  source, tenant, channelId, groupId, refresh, channelHint, at,
}, now = Date.now(), { onChange } = {}) {
  const row = await env.DB.prepare(
    'SELECT * FROM channels WHERE source = ? AND tenant = ? AND channel_id = ?',
  ).bind(source, tenant, channelId).first();
  if (source === 'portal') {
    // The event is the lookup: the row follows it when it says something else (or is a day
    // old), and without a hint the row stands.
    const hinted = channelHint && channelHint.name ? portalChannel(tenant, channelHint) : null;
    if (!hinted || (fresh(row, now) && !['name', 'group_name', 'topic']
      .some((k) => (row[k] ?? null) !== (hinted[k] ?? null)))) {
      return toChannel(row, source, channelId);
    }
  } else if (!refresh && fresh(row, now) && row.name && (source !== 'slack' || row.domain != null)
    && !(row.archived_at && at && at > row.archived_at)) {
    // Slack channels looked up before links named their workspace are looked up again, and so
    // are archived ones that get a message from after they were archived: they were restored.
    return toChannel(row, source, channelId);
  }
  let f;
  try {
    if (source === 'portal') {
      f = portalChannel(tenant, channelHint);
    } else if (source === 'slack') {
      f = await fetchSlackChannel(env, tenant, channelId, now);
    } else if (source === 'discord') {
      f = await fetchDiscordChannel(env, tenant, channelId);
    } else {
      f = await fetchTeamsChannel(env, groupId || (row && row.group_id), channelId);
    }
  } catch (e) {
    console.warn(JSON.stringify({
      route: 'normalize', lookup: 'channel', source, channel: channelId, error: e.message,
    }));
    // Gone, as the platform says: archived from now, as a lookup records an archive, and restored
    // by the first lookup that finds it again. Not for a message's lookup, though: a channel the
    // inbox gets messages from is there, whatever the lookup says.
    if (row && !at && source === 'slack' && SLACK_GONE.has(e.code)) {
      await env.DB.prepare(`UPDATE channels SET archived_at = COALESCE(archived_at, ?)
        WHERE source = ? AND tenant = ? AND channel_id = ?`)
        .bind(new Date(now).toISOString(), source, tenant, channelId).run();
    }
    return toChannel(row, source, channelId);
  }
  if (onChange && row && classifiedChanged(row, f)) {
    await onChange(toChannel(row, source, channelId), toChannel(f, source, channelId));
  }
  try {
    // Before the row, so that a failed update is tried again with the next lookup.
    if (f.domain && f.domain !== (row && row.domain)) {
      await relinkSlackChannel(env, tenant, channelId, f.domain);
    }
    if (f.teamArchived && f.group_id) {
      // An archived Teams team's channels are all archived: the rest of them get no message to
      // say so. A restored one's are left to their own lookups, since a channel can be archived
      // on its own too.
      await env.DB.prepare(`UPDATE channels SET archived_at = ?
        WHERE source = 'teams' AND tenant = ? AND group_id = ? AND archived_at IS NULL`)
        .bind(new Date(now).toISOString(), tenant, f.group_id).run();
    }
    await env.DB.prepare(`INSERT INTO channels
      (source, tenant, channel_id, name, group_id, group_name, shared, connected, topic, domain,
        fetched_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source, tenant, channel_id) DO UPDATE SET name = excluded.name,
        group_id = excluded.group_id, group_name = excluded.group_name,
        shared = excluded.shared, connected = excluded.connected,
        topic = excluded.topic, domain = excluded.domain, fetched_at = excluded.fetched_at,
        archived_at = CASE WHEN excluded.archived_at IS NULL THEN NULL
          ELSE COALESCE(channels.archived_at, excluded.archived_at) END`)
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
        f.domain ?? null,
        new Date(now).toISOString(),
        // Archived since the first lookup that saw it so (the platforms do not say when).
        f.archived ? new Date(now).toISOString() : null,
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

/**
 * Records a rename or creation that arrived as an event, without a lookup, as of when it
 * happened (`at`): one older than the row (out of order, or a replay of pile 1) is left out,
 * since the row knows a later name. A rename of a channel D1 knew runs `onChange(before,
 * after)` first, as `getChannel` does. Returns whether it renamed one.
 */
export async function updateChannelName(env, {
  source, tenant, channelId, name, at,
}, now = Date.now(), { onChange } = {}) {
  const row = await env.DB.prepare(
    'SELECT * FROM channels WHERE source = ? AND tenant = ? AND channel_id = ?',
  ).bind(source, tenant, channelId).first();
  if (row && at && row.fetched_at && Date.parse(row.fetched_at) > Date.parse(at)) {
    return false;
  }
  const renamed = Boolean(row) && (row.name ?? null) !== (name ?? null);
  if (renamed && onChange) {
    const after = toChannel({ ...row, name }, source, channelId);
    await onChange(toChannel(row, source, channelId), after);
  }
  // The check above, again in the write: of two events handled at once, the later one wins.
  // Moves queued for the one that lost do no harm, since a job files by the row as it is then.
  const written = await env.DB.prepare(`INSERT INTO channels
      (source, tenant, channel_id, name, fetched_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (source, tenant, channel_id) DO UPDATE SET name = excluded.name,
      fetched_at = excluded.fetched_at
    WHERE ?6 IS NULL OR channels.fetched_at IS NULL OR channels.fetched_at <= excluded.fetched_at`)
    .bind(source, tenant, channelId, name, at || new Date(now).toISOString(), at || null)
    .run();
  return renamed && Boolean(written.meta && written.meta.changes);
}

export { gravatar };

/**
 * A person's picture, for the header (and for what they write in the customer portal,
 * src/portalsource.js): an account of theirs with one (Slack's first, a platform's own picture
 * before Gravatar's), else Gravatar's for their email, which answers 404 where there is none
 * (the header keeps the initials then).
 */
export async function personAvatar(env, me) {
  const row = await env.DB.prepare(`SELECT avatar FROM identities
    WHERE (person = ? OR email = ?) AND kind = 'person' AND avatar IS NOT NULL AND avatar != ''
    ORDER BY avatar LIKE 'https://gravatar.com/%',
      CASE source WHEN 'slack' THEN 0 WHEN 'teams' THEN 1 ELSE 2 END, fetched_at DESC
    LIMIT 1`).bind(me.id ?? null, me.email || null).first();
  return row?.avatar || await gravatar(me.email) || null;
}

/** Other names of an account, without blanks or repeats (`identities.aliases`). */
function aliasesOf(...names) {
  const out = [...new Set(names.map((n) => String(n || '').trim()).filter(Boolean))];
  return out.length ? out : null;
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
    // A multi- or single-channel guest: of one person's accounts, the full member is mentioned.
    guest: Boolean(u.is_restricted || u.is_ultra_restricted),
    // The login and the display name: what people type after @ in Slack.
    aliases: aliasesOf(u.name, p.display_name, p.display_name_normalized),
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

/**
 * What the user name of one of the host tenant's own admin accounts begins with: `owner_` and
 * the initials of the Adobe person who uses it (`owner_ab@<tenant>.onmicrosoft.com`).
 */
export const HOST_ADMIN_PREFIX = 'owner_';

/**
 * Whether a Graph user (of the tenant the app reads, `MS_TENANT_ID`: the one that hosts the
 * teams) is one of its own admin accounts: a member, not a guest, whose user principal name or
 * mail nickname begins with `HOST_ADMIN_PREFIX`. Those are Adobe's, so they count as staff,
 * though their mail domain is the tenant's own and in no STAFF_DOMAINS. Everyone else there is
 * a guest, staff and customers alike (docs/ARCHITECTURE.md, "People"), and a guest is never one.
 */
export function isHostAdmin(u) {
  if (!u || u.userType !== 'Member') {
    return false;
  }
  const local = (v) => String(v || '').split('@')[0].toLowerCase();
  return [u.userPrincipalName, u.mailNickname].some((v) => local(v).startsWith(HOST_ADMIN_PREFIX));
}

/**
 * A Graph user's name: their `displayName`, unless that is only initials (`RW`, as the host
 * tenant's admin accounts have) and Graph has their given name and surname, which say more.
 */
export function graphName(u, fallbackName) {
  const full = [u.givenName, u.surname].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
  const shown = String(u.displayName || '').trim();
  if (shown && !(/^\p{Lu}{1,3}$/u.test(shown) && full.length > shown.length)) {
    return shown;
  }
  return full || shown || fallbackName || null;
}

async function fetchTeamsUser(env, userId, fallbackName) {
  try {
    const u = await graphJson(
      env,
      `/users/${encodeURIComponent(userId)}?$select=displayName,givenName,surname,mail,mailNickname,userPrincipalName,jobTitle,companyName,userType`,
    );
    const upn = /#EXT#/i.test(u.userPrincipalName || '') ? null : u.userPrincipalName;
    const email = u.mail || upn || null;
    return {
      kind: 'person',
      name: graphName(u, fallbackName),
      email,
      home: null,
      avatar: await slackAvatarByEmail(env, email) || await gravatar(email),
      title: u.jobTitle || null,
      company: u.companyName || null,
      guest: u.userType ? u.userType === 'Guest' : null,
      staff: isHostAdmin(u),
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
 * account is linked to a person only when they connect it in the inbox (src/post.js), or, for
 * one with a staff role, when the admin team says whose it is (src/accountlinks.js).
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
    aliases: aliasesOf(user.username, user.global_name),
  };
}

/**
 * `{ kind, name, org, staff }` for the frontmatter. Staff are people marked as staff in
 * D1, or whose mail domain is one of STAFF_DOMAINS, the accounts that are staff by themselves
 * (`identities.staff`: a Discord staff role, a host tenant's admin account on Teams), and the
 * bots an admin said are Adobe's
 * (`ours`: a bot has no mail address); the org of everyone else is their mail domain (on
 * Teams everyone is a guest, so the tenant says nothing). A bot's name is the one an admin gave
 * it (`display_name`, the admin page's Bots), else its platform's.
 */
export function toAuthor(env, identity) {
  const domain = domainOf(identity.email);
  const staff = Boolean(identity.person_staff) || Boolean(identity.staff)
    || Boolean(identity.ours) || isStaffDomain(env, identity.email);
  const shown = identity.kind === 'bot' ? identity.display_name : null;
  return {
    kind: identity.kind || 'person',
    name: shown || identity.person_name || identity.name || null,
    org: domain,
    staff,
  };
}

/**
 * The messages account `key` (an identity key, as `messages.author_key`) wrote, as the account
 * says now: their person and side (`staff`), and with `name`, their author's name; and the
 * threads it posted last in, whose `last_staff` and `last_author` follow. Their frontmatter in
 * pile 2 keeps what was so when they were written, which the thread view reads the account for
 * (`accountAuthor` in src/api.js), until a replay writes them again.
 */
export async function relabelAccount(env, key, { person, staff, name }) {
  const { meta } = await env.DB.prepare(`UPDATE messages SET person = ?2, staff = ?3,
      author = COALESCE(?4, author)
    WHERE author_key = ?1 AND (person IS NOT ?2 OR staff != ?3 OR author IS NOT COALESCE(?4, author))`)
    .bind(key, person ?? null, staff ? 1 : 0, name ?? null).run();
  if (!meta || !meta.changes) {
    return 0;
  }
  await env.DB.prepare(`UPDATE threads SET
      last_staff = (SELECT staff FROM messages WHERE thread = threads.thread AND counted = 1
        AND deleted = 0 ORDER BY at DESC LIMIT 1),
      last_author = (SELECT author FROM messages WHERE thread = threads.thread AND counted = 1
        AND deleted = 0 ORDER BY at DESC LIMIT 1)
    WHERE thread IN (SELECT DISTINCT thread FROM messages WHERE author_key = ?)`).bind(key).run();
  return meta.changes;
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
  if (ref.source === 'portal') {
    // A portal account is what its events say of it (their author's name and mail address):
    // the portal is not asked. A reference without them (a reaction's, a mention's) is the row.
    if (!ref.name && !ref.email) {
      return row || {
        kind: 'person', name: ref.userId, email: null, home: null,
      };
    }
    // A reference that says nothing of a picture (a mention's, a lobby member's) keeps the row's.
    const same = row && row.name === (ref.name || null)
      && (row.email || null) === (ref.email || null)
      && (ref.mergeEmail === undefined || (row.merge_email || null) === ref.mergeEmail)
      && (ref.mergeAt === undefined || (row.merge_at || null) === ref.mergeAt)
      && (ref.avatar === undefined || (ref.avatar ? row.avatar === ref.avatar
        : !String(row.avatar || '').startsWith('/api/portal/avatar/')));
    if (same && fresh(row, now)) {
      return row;
    }
  } else if (fresh(row, now) && row.avatar !== null && row.avatar !== undefined) {
    // Rows cached before avatars existed have avatar NULL; '' means "looked, none".
    return row;
  }
  let f;
  try {
    if (ref.source === 'portal') {
      f = {
        kind: 'person',
        name: ref.name || ref.email,
        email: ref.email || null,
        home: null,
        // The picture the event names (one uploaded in the portal, or the inbox's own of its
        // people); without one, the row's when the reference says nothing, else their Gravatar.
        avatar: ref.avatar || (ref.avatar === undefined && row && row.avatar)
          || await gravatar(ref.email),
        title: null,
        company: null,
        // An embedded account's merge key: kept apart from `email`, so that it links nobody to a
        // person of D1 and makes nobody staff, whatever its domain. A reference that says nothing
        // of it keeps the row's.
        merge_email: ref.mergeEmail || (row && row.merge_email) || null,
        merge_at: (ref.mergeEmail && ref.mergeAt) || (row && row.merge_at) || null,
      };
    } else if (ref.source === 'slack') {
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
  if (f.error && row) {
    // A lookup that failed (Graph cannot always read a user) keeps what was known of them.
    f = {
      kind: row.kind,
      name: row.name || f.name,
      email: row.email || null,
      home: row.home || null,
      avatar: row.avatar || '',
      title: row.title || null,
      company: row.company || null,
      staff: Boolean(row.staff),
      guest: row.guest === null || row.guest === undefined ? null : Boolean(row.guest),
    };
  }
  // Staff become people the first time they show up, so their reads count towards
  // "somebody at Adobe has seen it" even when they are in no ops team.
  if (f.email && f.kind === 'person' && isStaffDomain(env, f.email)) {
    await env.DB.prepare(`INSERT INTO people (email, name, staff) VALUES (?, ?, 1)
      ON CONFLICT (email) DO UPDATE SET staff = 1`).bind(f.email, f.name).run();
  }
  // An account the admin team said whose it is (src/accountlinks.js) stays that person's: its
  // mail address, the host tenant's own, says nobody, and a Discord account has none.
  const linked = Boolean(row && row.linked_at && row.person);
  let person = !linked && f.email
    ? await env.DB.prepare('SELECT id, staff, name FROM people WHERE email = ?').bind(f.email).first()
    : null;
  if (!person && (linked || ref.source === 'discord') && row && row.person) {
    // Linked by an admin, or (Discord) when the person connected the account: neither platform
    // says who it is.
    person = await env.DB.prepare('SELECT id, staff, name FROM people WHERE id = ?').bind(row.person).first();
  }
  if (linked && person && !f.avatar) {
    // Their own picture, of another account of theirs: the admin account has none.
    f.avatar = await personAvatar(env, { id: person.id }) || '';
  }
  const home = f.home || ref.home || null;
  const aliases = f.aliases ? JSON.stringify(f.aliases) : null;
  await env.DB.prepare(`INSERT INTO identities
    (source, tenant, user_id, kind, name, email, home, person, fetched_at, avatar, title, company,
     staff, aliases, guest, merge_email, merge_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, tenant, user_id) DO UPDATE SET kind = excluded.kind,
      name = excluded.name, email = excluded.email, home = excluded.home,
      person = excluded.person, fetched_at = excluded.fetched_at, avatar = excluded.avatar,
      title = excluded.title, company = excluded.company, staff = excluded.staff,
      aliases = COALESCE(excluded.aliases, identities.aliases), guest = excluded.guest,
      merge_email = COALESCE(excluded.merge_email, identities.merge_email),
      merge_at = COALESCE(excluded.merge_at, identities.merge_at)`)
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
      aliases,
      typeof f.guest === 'boolean' ? Number(f.guest) : null,
      ref.source === 'portal' ? f.merge_email || null : null,
      ref.source === 'portal' ? f.merge_at || null : null,
    )
    .run();
  const identity = {
    ...f,
    staff: f.staff ? 1 : null,
    avatar: f.avatar || '',
    home,
    person: person ? person.id : null,
    person_staff: person ? person.staff : null,
    person_name: person ? person.name : null,
    // An admin's say (the admin page's Bots), which looking the account up again leaves alone.
    ours: (row && row.ours) ?? null,
    display_name: (row && row.display_name) ?? null,
    display_avatar: (row && row.display_avatar) ?? null,
    linked_at: (row && row.linked_at) ?? null,
  };
  // Its side or its person changed (a host tenant's admin account seen as one, a Discord role
  // given): the messages it wrote before follow, as they do when an admin says a bot is Adobe's.
  if (row && f.kind === 'person' && ref.source !== 'portal') {
    const was = toAuthor(env, row);
    const is = toAuthor(env, identity);
    if (was.staff !== is.staff || (row.person ?? null) !== identity.person) {
      await relabelAccount(env, `${ref.source}:${ref.tenant}:${ref.userId}`, {
        person: identity.person, staff: is.staff,
      });
    }
  }
  return identity;
}

/**
 * A bot that posts without a user account (a Slack bot's bot id, a Teams app's), as
 * `identities` keeps it: `{ kind, name, email, staff, ours, display_name, avatar }`. Its row
 * is written the first time it posts, if nothing wrote it before (`recordBots`, a Slack
 * `bots.info`), so the admin page lists it and an admin can say it is Adobe's, and name it. The
 * platform is not asked: the picture is the one the message came with (a Slack `bot_profile`'s
 * icon), kept when the row has none.
 */
export async function botIdentity(env, {
  source, tenant, botId, name, avatar,
}, now = Date.now()) {
  const row = await env.DB.prepare(`SELECT kind, name, email, staff, ours, display_name, avatar
    FROM identities WHERE source = ? AND tenant = ? AND user_id = ?`)
    .bind(source, tenant, botId).first();
  if (row) {
    if (avatar && !row.avatar) {
      await env.DB.prepare(`UPDATE identities SET avatar = ?
        WHERE source = ? AND tenant = ? AND user_id = ? AND (avatar IS NULL OR avatar = '')`)
        .bind(avatar, source, tenant, botId).run();
    }
    return row;
  }
  await env.DB.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, fetched_at,
      avatar) VALUES (?, ?, ?, 'bot', ?, ?, ?) ON CONFLICT (source, tenant, user_id) DO NOTHING`)
    .bind(source, tenant, botId, name || null, new Date(now).toISOString(), avatar || null).run();
  return {
    kind: 'bot',
    name: name || null,
    email: null,
    staff: null,
    ours: null,
    display_name: null,
    avatar: avatar || null,
  };
}

/**
 * The rules (`rules`), and the merged orgs as rules of target `merge` (`org_merges`, see
 * src/rules.js `mergeRule`), which file what the others give a merged org under its new one.
 */
export async function loadRules(env) {
  const [{ results }, merges] = await Promise.all([
    env.DB.prepare('SELECT * FROM rules').all(),
    env.DB.prepare('SELECT slug, into_slug FROM org_merges').all(),
  ]);
  return [...(results || []), ...((merges && merges.results) || []).map(mergeRule)];
}
