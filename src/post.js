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

import { json } from './http.js';
import { getIdentity, isStaffDomain } from './lookup.js';
import { markdownToMrkdwn } from './markdown.js';
import { teamsOf } from './shares.js';

/**
 * Replying from the inbox, as the person who writes, never as a bot. Each person connects
 * their own Slack and Microsoft accounts once (OAuth); the tokens are stored encrypted with
 * TOKEN_KEY and are only used to post the replies and reactions the person makes in the inbox.
 *
 * Slack: user scopes `chat:write` and `reactions:write`. Teams: delegated
 * `ChannelMessage.Send`, which covers replies and setReaction/unsetReaction on channel
 * messages (+ offline_access for a refresh token), redeemed server-side with the Entra app's
 * secret. Discord: `identify` only, to link the account to the person (see DISCORD_SCOPE).
 */

export const SLACK_SCOPE = 'chat:write,reactions:write';
// Discord: only who the person is (their user id), so their posts and reactions count as
// theirs. Discord lets only bots post through its API, so opspile does not reply there.
const DISCORD_SCOPE = 'identify';
const TEAMS_SCOPE = 'offline_access https://graph.microsoft.com/ChannelMessage.Send https://graph.microsoft.com/User.Read';
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_TEXT = 8000;

const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function aesKey(env) {
  if (!env.TOKEN_KEY) {
    throw new Error('TOKEN_KEY is not set');
  }
  return crypto.subtle.importKey('raw', unb64u(env.TOKEN_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(text));
  return b64u([...iv, ...new Uint8Array(ct)]);
}

export async function unseal(env, sealed) {
  const bytes = unb64u(sealed);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    await aesKey(env),
    bytes.slice(12),
  );
  return new TextDecoder().decode(pt);
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    unb64u(env.TOKEN_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

/** OAuth state: who started the sign-in, for which platform, until when. Signed. */
export async function makeState(env, person, platform, now = Date.now()) {
  const claims = { p: person, pl: platform, exp: now + STATE_TTL_MS };
  const body = b64u(enc.encode(JSON.stringify(claims)));
  return `${body}.${await hmac(env, body)}`;
}

export async function checkState(env, state, person, platform, now = Date.now()) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig || sig !== await hmac(env, body)) {
    return false;
  }
  const s = JSON.parse(new TextDecoder().decode(unb64u(body)));
  return s.p === person && s.pl === platform && s.exp > now;
}

const origin = (env) => String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
const redirectUri = (env, platform) => `${origin(env)}/api/auth/${platform}/callback`;

async function saveToken(env, person, platform, t) {
  await env.DB.prepare(`INSERT INTO user_tokens (person, platform, user_id, access_token,
      refresh_token, expires_at, scope, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (person, platform) DO UPDATE SET user_id = excluded.user_id,
      access_token = excluded.access_token, refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at, scope = excluded.scope, updated_at = excluded.updated_at`)
    .bind(
      person,
      platform,
      t.userId,
      await seal(env, t.access),
      t.refresh ? await seal(env, t.refresh) : null,
      t.expiresIn ? new Date(Date.now() + (t.expiresIn - 60) * 1000).toISOString() : null,
      t.scope || null,
      new Date().toISOString(),
    )
    .run();
}

/**
 * Whether the person's tokens may react: Slack tokens from before `reactions:write` was
 * asked for may not (they need to connect again); `ChannelMessage.Send` already may.
 */
export async function reactable(env, person) {
  const { results } = await env.DB.prepare('SELECT platform, scope FROM user_tokens WHERE person = ?')
    .bind(person).all();
  const by = new Map((results || []).map((r) => [r.platform, String(r.scope || '')]));
  return {
    slack: by.has('slack') && by.get('slack').split(/[\s,]+/).includes('reactions:write'),
    teams: by.has('teams'),
    discord: false,
  };
}

export async function connections(env, person) {
  const { results } = await env.DB.prepare('SELECT platform FROM user_tokens WHERE person = ?')
    .bind(person).all();
  const set = new Set((results || []).map((r) => r.platform));
  return { slack: set.has('slack'), teams: set.has('teams'), discord: set.has('discord') };
}

/** GET /api/auth/<platform>/start: off to the platform's consent screen. */
export async function startAuth(env, me, platform) {
  const state = await makeState(env, me.id, platform);
  let url;
  if (platform === 'slack') {
    url = new URL('https://slack.com/oauth/v2/authorize');
    url.search = new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      user_scope: SLACK_SCOPE,
      redirect_uri: redirectUri(env, 'slack'),
      state,
    });
  } else if (platform === 'discord') {
    url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri(env, 'discord'),
      scope: DISCORD_SCOPE,
      prompt: 'none',
      state,
    });
  } else {
    url = new URL(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/authorize`);
    url.search = new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: redirectUri(env, 'teams'),
      scope: TEAMS_SCOPE,
      login_hint: me.email,
      state,
    });
  }
  return Response.redirect(url.toString(), 302);
}

const sameEmail = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

async function slackCallback(env, me, code) {
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(env, 'slack'),
    }),
  });
  const data = await res.json();
  const user = data.authed_user || {};
  if (!data.ok || !user.access_token) {
    throw new Error(`slack: ${data.error || 'no user token'}`);
  }
  const tenant = (data.enterprise && data.enterprise.id) || (data.team && data.team.id);
  const identity = await getIdentity(env, { source: 'slack', tenant, userId: user.id });
  // The account must be the signed-in person's: the same D1 person, or the same email.
  if (identity.person !== me.id && !sameEmail(identity.email, me.email)) {
    throw new Error('that Slack account belongs to someone else');
  }
  await saveToken(env, me.id, 'slack', {
    userId: user.id,
    access: user.access_token,
    refresh: user.refresh_token,
    expiresIn: user.expires_in,
    scope: user.scope,
  });
}

async function msToken(env, params) {
  const res = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      scope: TEAMS_SCOPE,
      ...params,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`microsoft: ${data.error || res.status}`);
  }
  return data;
}

async function teamsCallback(env, me, code) {
  const data = await msToken(env, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri(env, 'teams'),
  });
  const select = 'id,mail,userPrincipalName,otherMails';
  const meRes = await fetch(`https://graph.microsoft.com/v1.0/me?$select=${select}`, {
    headers: { authorization: `Bearer ${data.access_token}` },
  });
  const who = await meRes.json();
  const emails = [who.mail, ...(who.otherMails || [])].filter(Boolean);
  const identity = await getIdentity(env, { source: 'teams', tenant: env.MS_TENANT_ID, userId: who.id });
  if (identity.person !== me.id && !emails.some((e) => sameEmail(e, me.email))) {
    throw new Error('that Microsoft account belongs to someone else');
  }
  await saveToken(env, me.id, 'teams', {
    userId: who.id,
    access: data.access_token,
    refresh: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope,
  });
}

/**
 * Links a Discord account to the person: its identity in every guild opspile reads, and the
 * messages it already posted (their author is now known to be this person).
 */
export async function linkDiscord(env, me, userId) {
  const guilds = String(env.DISCORD_GUILDS || '').split(',').map((g) => g.trim()).filter(Boolean);
  const taken = await env.DB.prepare(`SELECT person FROM identities WHERE source = 'discord'
    AND user_id = ? AND person IS NOT NULL AND person != ? LIMIT 1`).bind(userId, me.id).first();
  if (taken) {
    throw new Error('that Discord account belongs to someone else');
  }
  const person = await env.DB.prepare('SELECT staff FROM people WHERE id = ?').bind(me.id).first();
  for (const guild of guilds) {
    // A new row is stale at once, so the next lookup fills in the name and avatar.
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare(`INSERT INTO identities (source, tenant, user_id, kind, person, fetched_at)
        VALUES ('discord', ?, ?, 'person', ?, ?)
      ON CONFLICT (source, tenant, user_id) DO UPDATE SET person = excluded.person`)
      .bind(guild, userId, me.id, new Date(0).toISOString()).run();
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare(`UPDATE messages SET person = ?, staff = MAX(staff, ?)
      WHERE author_key = ?`).bind(me.id, person && person.staff ? 1 : 0, `discord:${guild}:${userId}`).run();
  }
}

async function discordCallback(env, me, code) {
  const res = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(env, 'discord'),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    throw new Error(`discord: ${data.error || res.status}`);
  }
  const who = await (await fetch('https://discord.com/api/v10/users/@me', {
    headers: { authorization: `Bearer ${data.access_token}` },
  })).json();
  if (!who || !who.id) {
    throw new Error('discord: no account');
  }
  await linkDiscord(env, me, who.id);
  await saveToken(env, me.id, 'discord', {
    userId: who.id,
    access: data.access_token,
    expiresIn: data.expires_in,
    scope: data.scope,
  });
}

const CALLBACK = { slack: slackCallback, teams: teamsCallback, discord: discordCallback };

/** GET /api/auth/<platform>/callback: store the token, back to the inbox. */
export async function finishAuth(env, me, platform, url) {
  const back = new URL(`${origin(env)}/inbox`);
  try {
    if (url.searchParams.get('error')) {
      throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error'));
    }
    if (!await checkState(env, url.searchParams.get('state'), me.id, platform)) {
      throw new Error('sign-in expired, please try again');
    }
    const code = url.searchParams.get('code');
    await CALLBACK[platform](env, me, code);
    back.searchParams.set('connected', platform);
  } catch (e) {
    back.searchParams.set('connect_error', e.message.slice(0, 200));
  }
  return Response.redirect(back.toString(), 302);
}

/**
 * The person's token for a platform, refreshed if it has expired: `{ token, userId, scope }`,
 * or null when they have not connected (or a Slack token expired).
 */
export async function personalToken(env, person, platform) {
  const row = await env.DB.prepare('SELECT * FROM user_tokens WHERE person = ? AND platform = ?')
    .bind(person, platform).first();
  if (!row) {
    return null;
  }
  if (!row.expires_at || Date.parse(row.expires_at) > Date.now()) {
    return { token: await unseal(env, row.access_token), userId: row.user_id, scope: row.scope || '' };
  }
  if (!row.refresh_token || platform !== 'teams') {
    return null;
  }
  const data = await msToken(env, {
    grant_type: 'refresh_token', refresh_token: await unseal(env, row.refresh_token),
  });
  await saveToken(env, person, platform, {
    userId: row.user_id,
    access: data.access_token,
    refresh: data.refresh_token || await unseal(env, row.refresh_token),
    expiresIn: data.expires_in,
    scope: data.scope,
  });
  return { token: data.access_token, userId: row.user_id, scope: data.scope || row.scope || '' };
}

const htmlEscape = (s) => s.replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MAX_MENTIONS = 20;
const MAX_SUGGESTIONS = 8;

/**
 * The reply split into text and mentions: every `@Name` of a mentioned account becomes a
 * mention part, longest names first so that "@Ada Lovelace" wins over "@Ada".
 *
 * @param {string} body
 * @param {{ id: string, name: string }[]} mentions
 * @returns {(string|{ id: string, name: string })[]}
 */
export function splitMentions(body, mentions) {
  const named = mentions.filter((m) => m.name).sort((a, b) => b.name.length - a.name.length);
  if (!named.length) {
    return [body];
  }
  const re = new RegExp(`@(${named.map((m) => reEscape(m.name)).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  const parts = [];
  let last = 0;
  for (const match of body.matchAll(re)) {
    parts.push(body.slice(last, match.index));
    parts.push(named.find((m) => m.name === match[1]));
    last = match.index + match[0].length;
  }
  parts.push(body.slice(last));
  return parts.filter((p) => p !== '');
}

/**
 * Slack `text` from a Markdown reply: in mrkdwn (src/markdown.js), mentions as `<@U…>`, so
 * the person is notified.
 */
export function slackText(body, mentions = []) {
  const ids = [];
  const marked = splitMentions(body, mentions)
    .map((p) => (typeof p === 'string' ? p.replace(/\uE003/g, '') : `\uE003${ids.push(p.id) - 1}\uE003`))
    .join('');
  return markdownToMrkdwn(marked).replace(/\uE003(\d+)\uE003/g, (_, i) => `<@${ids[Number(i)]}>`);
}

/**
 * Teams message `body` and `mentions`: each mention an `<at id>` with its entry, a person
 * as `user`, a bot as `application` (which the bot receives like a mention typed in Teams).
 */
export function teamsMessage(body, mentions = []) {
  const entries = [];
  const content = splitMentions(body, mentions).map((p) => {
    if (typeof p === 'string') {
      return htmlEscape(p).replace(/\n/g, '<br>');
    }
    const id = entries.length;
    entries.push({
      id,
      mentionText: p.name,
      mentioned: p.kind === 'bot'
        ? { application: { id: p.id, displayName: p.name, applicationIdentityType: 'bot' } }
        : { user: { id: p.id, displayName: p.name, userIdentityType: 'aadUser' } },
    });
    return `<at id="${id}">${htmlEscape(p.name)}</at>`;
  }).join('');
  return { body: { contentType: 'html', content }, ...(entries.length ? { mentions: entries } : {}) };
}

const NAME = 'COALESCE(p.name, i.name)';
const ACCOUNTS = `FROM identities i LEFT JOIN people p ON p.id = i.person
  WHERE i.source = ? AND i.tenant = ? AND i.kind = 'person' AND ${NAME} IS NOT NULL`;
// Teams bots seen in the thread's Teams team, by the name people mention them by.
const BOT_NAME = 'COALESCE(i.handle, i.name)';
const BOTS = `FROM identities i JOIN bot_teams b ON b.source = i.source AND b.tenant = i.tenant
    AND b.bot_id = i.user_id
  WHERE i.source = 'teams' AND i.tenant = ? AND b.group_id = ? AND i.kind = 'bot'
    AND ${BOT_NAME} IS NOT NULL`;
const MAX_BOTS = 3;

/** The latest platform thread of an inbox entry: replies go there. */
export async function target(env, key) {
  const { results } = await env.DB.prepare(`SELECT t.*, c.group_id FROM threads t
    LEFT JOIN channels c ON c.source = t.source AND c.tenant = t.tenant AND c.channel_id = t.channel_id
    WHERE t.thread = ? OR t.logical_thread = ? ORDER BY t.any_at DESC LIMIT 1`).bind(key, key).all();
  return results && results[0];
}

/**
 * The accounts a reply mentions, as opspile knows them: only platform accounts already in
 * D1, in the thread's workspace or tenant, can be mentioned, and on Teams the bots seen in
 * the thread's Teams team. The name is D1's, so the text of a mention is the same `@Name`
 * the message shows when it comes back.
 */
async function knownMentions(env, t, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : [])
    .map((m) => String((m && m.id) || m || '')).filter(Boolean))].slice(0, MAX_MENTIONS);
  if (!wanted.length) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT i.user_id AS id, ${NAME} AS name ${ACCOUNTS}
    AND i.user_id IN (SELECT value FROM json_each(?))`)
    .bind(t.source, t.tenant, JSON.stringify(wanted)).all();
  const people = (results || []).map((r) => ({ ...r, kind: 'person' }));
  if (t.source !== 'teams' || !t.group_id) {
    return people;
  }
  const { results: bots } = await env.DB.prepare(`SELECT i.user_id AS id, ${BOT_NAME} AS name
    ${BOTS} AND i.user_id IN (SELECT value FROM json_each(?))`)
    .bind(t.tenant, t.group_id, JSON.stringify(wanted)).all();
  return [...people, ...(bots || []).map((r) => ({ ...r, kind: 'bot' }))];
}

/**
 * GET /api/mentionable?thread=…&q=…: people to mention in a reply, from the accounts in D1
 * for the thread's platform and workspace. Whoever posted in the thread comes first, then
 * staff, then everyone else, by name. `q` matches the start of any word of the name. On
 * Teams, the bots seen in the thread's Teams team are offered as well.
 */
export async function mentionable(env, key, q, inTeam) {
  const t = key && await target(env, key);
  if (!t || !inTeam(await teamsOf(env, t))) {
    return json({ error: 'not found' }, 404);
  }
  const like = String(q || '').trim().slice(0, 60).replace(/[\\%_]/g, '\\$&');
  const { results: botRows } = t.source === 'teams' && t.group_id
    ? await env.DB.prepare(`SELECT i.user_id AS id, ${BOT_NAME} AS name, i.avatar ${BOTS}
      AND (? = '' OR ${BOT_NAME} LIKE ? || '%' ESCAPE '\\'
        OR ${BOT_NAME} LIKE '% ' || ? || '%' ESCAPE '\\'
        OR ${BOT_NAME} LIKE '%-' || ? || '%' ESCAPE '\\')
      ORDER BY b.at DESC LIMIT ${MAX_BOTS}`)
      .bind(t.tenant, t.group_id, like, like, like, like).all()
    : { results: [] };
  const bots = (botRows || []).map((r) => ({
    id: r.id, name: r.name, avatar: r.avatar || null, here: false, staff: false, kind: 'bot',
  }));
  const { results } = await env.DB.prepare(`SELECT i.user_id AS id, ${NAME} AS name, i.avatar,
      MAX(COALESCE(p.staff, 0), COALESCE(i.staff, 0)) AS staff, EXISTS (SELECT 1 FROM messages m
        WHERE m.thread IN (SELECT thread FROM threads WHERE thread = ? OR logical_thread = ?)
        AND m.author_key = i.source || ':' || i.tenant || ':' || i.user_id) AS here
    ${ACCOUNTS} AND (? = '' OR ${NAME} LIKE ? || '%' ESCAPE '\\'
      OR ${NAME} LIKE '% ' || ? || '%' ESCAPE '\\')
    ORDER BY here DESC, staff DESC, ${NAME} COLLATE NOCASE LIMIT ${MAX_SUGGESTIONS * 2}`)
    .bind(key, key, t.source, t.tenant, like, like, like).all();
  const seen = new Set();
  const people = (results || []).filter((r) => !seen.has(r.id) && seen.add(r.id))
    .slice(0, MAX_SUGGESTIONS - bots.length).map((r) => ({
      id: r.id,
      name: r.name,
      avatar: r.avatar || null,
      here: Boolean(r.here),
      staff: Boolean(r.staff),
      kind: 'person',
    }));
  return json({ platform: t.source, people: [...people, ...bots] });
}

/**
 * POST /api/post `{ thread, text, mentions? }`: replies in the thread as the signed-in
 * person. `mentions` are account ids from /api/mentionable; each `@Name` of one of them in
 * the text becomes a real platform mention, so the person is notified. The reply then
 * arrives like any other message, through the platform's events.
 */
export async function post(env, me, request, inTeam) {
  const { thread: key, text, mentions: ids } = request || {};
  const body = String(text || '').trim();
  if (!body || body.length > MAX_TEXT) {
    return json({ error: 'write something (up to 8000 characters)' }, 400);
  }
  const t = key && await target(env, key);
  if (!t || !inTeam(await teamsOf(env, t))) {
    return json({ error: 'not found' }, 404);
  }
  if (!isStaffDomain(env, me.email)) {
    return json({ error: 'only staff can reply' }, 403);
  }
  if (t.source === 'discord') {
    return json({ error: 'reply in Discord: opspile cannot post there as you' }, 409);
  }
  const { token } = await personalToken(env, me.id, t.source) || {};
  if (!token) {
    const name = t.source === 'slack' ? 'Slack' : 'Microsoft';
    return json({ error: `connect your ${name} account first`, connect: t.source }, 409);
  }
  const mentions = await knownMentions(env, t, ids);
  if (t.source === 'slack') {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        channel: t.channel_id, thread_ts: t.root_id, text: slackText(body, mentions),
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      const reconnect = ['invalid_auth', 'token_revoked', 'not_authed', 'missing_scope'].includes(data.error);
      return json({ error: `Slack: ${data.error}`, connect: reconnect ? 'slack' : undefined }, 502);
    }
    return json({ ok: true, platform: 'slack', id: data.ts });
  }
  if (!t.group_id) {
    return json({ error: 'the Teams team of this channel is not known yet' }, 409);
  }
  const path = `/teams/${encodeURIComponent(t.group_id)}/channels/${encodeURIComponent(t.channel_id)}`
    + `/messages/${encodeURIComponent(t.root_id)}/replies`;
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(teamsMessage(body, mentions)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({
      error: `Teams: ${(data.error && data.error.code) || res.status}`,
      connect: res.status === 401 ? 'teams' : undefined,
    }, 502);
  }
  return json({ ok: true, platform: 'teams', id: data.id });
}

export async function disconnect(env, me, platform) {
  if (platform === 'discord') {
    // The link was the point of connecting; it goes with the token.
    await env.DB.prepare(`UPDATE identities SET person = NULL WHERE source = 'discord'
      AND person = ? AND user_id IN (SELECT user_id FROM user_tokens
        WHERE person = ? AND platform = 'discord')`).bind(me.id, me.id).run();
  }
  await env.DB.prepare('DELETE FROM user_tokens WHERE person = ? AND platform = ?')
    .bind(me.id, platform).run();
  return json({ ok: true });
}
