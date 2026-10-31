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
  FILES_SCOPE, checkFiles, hasScope, personRule, slackUpload, teamsAttachments,
} from './attach.js';
import { json } from './http.js';
import { getIdentity, isStaffDomain } from './lookup.js';
import { threadExperts } from './expertise.js';
import { rankMentions } from './mention-match.js';
import { markdownToMrkdwn } from './markdown.js';
import { mentionCandidates } from './profiles.js';
import { teamsOf } from './shares.js';
import { refreshMembers } from './suggest.js';
import { resolveShortcodes } from './shortcodes.js';
import { messageHtml } from './ui-markdown.js';

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
// Editing one's own Teams messages needs `ChannelMessage.ReadWrite`, which takes the tenant's
// admin consent; it is asked for once TEAMS_EDITS says the tenant has given it.
export const TEAMS_EDIT_SCOPE = 'ChannelMessage.ReadWrite';
// Attaching files asks for more, once, when the person first wants to (`?files=1`): Slack's
// `files:write`, and on Microsoft access to the channels' SharePoint files (images go inline
// without it). Tokens keep what was granted; a Microsoft token is refreshed with it.
const slackScope = (files) => (files ? `${SLACK_SCOPE},${FILES_SCOPE.slack}` : SLACK_SCOPE);
const teamsScope = (env, files = false) => [
  TEAMS_SCOPE,
  ...(env.TEAMS_EDITS ? [`https://graph.microsoft.com/${TEAMS_EDIT_SCOPE}`] : []),
  ...(files ? [`https://graph.microsoft.com/${FILES_SCOPE.teams}`] : []),
].join(' ');
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

/**
 * OAuth state: who started the sign-in, for which platform, until when (and `f`: with file
 * access). Signed.
 */
export async function makeState(env, person, platform, now = Date.now(), extra = {}) {
  const claims = {
    p: person, pl: platform, exp: now + STATE_TTL_MS, ...extra,
  };
  const body = b64u(enc.encode(JSON.stringify(claims)));
  return `${body}.${await hmac(env, body)}`;
}

/** The claims of a state that is signed, the person's, for `platform` and fresh; else null. */
export async function stateClaims(env, state, person, platform, now = Date.now()) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig || sig !== await hmac(env, body)) {
    return null;
  }
  const s = JSON.parse(new TextDecoder().decode(unb64u(body)));
  return s.p === person && s.pl === platform && s.exp > now ? s : null;
}

export async function checkState(env, state, person, platform, now = Date.now()) {
  return Boolean(await stateClaims(env, state, person, platform, now));
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

const scopes = (scope) => String(scope || '').split(/[\s,]+/);

/**
 * Whether the person's tokens may edit their own messages: `true`, `'reconnect'` (the
 * deployment asks for the scope now, their token is from before), or false. Slack's
 * `chat:write` already may (`chat.update`); Teams needs `ChannelMessage.ReadWrite`
 * (TEAMS_EDITS); Discord lets only bots edit through its API.
 */
export async function editable(env, person) {
  const { results } = await env.DB.prepare('SELECT platform, scope FROM user_tokens WHERE person = ?')
    .bind(person).all();
  const by = new Map((results || []).map((r) => [r.platform, r.scope]));
  let teams = false;
  if (by.has('teams')) {
    if (scopes(by.get('teams')).some((s) => s.endsWith(TEAMS_EDIT_SCOPE))) {
      teams = true;
    } else if (env.TEAMS_EDITS) {
      teams = 'reconnect';
    }
  }
  return { slack: by.has('slack'), teams, discord: false };
}

/**
 * What the person's replies may carry on each platform they connected (src/attach.js): the
 * rule for their token's scopes, e.g. none on Slack until they connect again with
 * `files:write`.
 */
export async function attachable(env, person) {
  const { results } = await env.DB.prepare('SELECT platform, scope FROM user_tokens WHERE person = ?')
    .bind(person).all();
  return Object.fromEntries((results || []).filter((r) => r.platform !== 'discord')
    .map((r) => [r.platform, personRule(r.platform, r.scope)]));
}

export async function connections(env, person) {
  const { results } = await env.DB.prepare('SELECT platform FROM user_tokens WHERE person = ?')
    .bind(person).all();
  const set = new Set((results || []).map((r) => r.platform));
  return { slack: set.has('slack'), teams: set.has('teams'), discord: set.has('discord') };
}

/**
 * GET /api/auth/<platform>/start: off to the platform's consent screen; `files` asks for file
 * uploads as well.
 */
export async function startAuth(env, me, platform, { files = false } = {}) {
  const state = await makeState(env, me.id, platform, Date.now(), files ? { f: 1 } : {});
  let url;
  if (platform === 'slack') {
    url = new URL('https://slack.com/oauth/v2/authorize');
    url.search = new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      user_scope: slackScope(files),
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
      scope: teamsScope(env, files),
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

async function msToken(env, params, scope = teamsScope(env)) {
  const res = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      scope,
      ...params,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`microsoft: ${data.error || res.status}`);
  }
  return data;
}

async function teamsCallback(env, me, code, claims) {
  const data = await msToken(env, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri(env, 'teams'),
  }, teamsScope(env, Boolean(claims && claims.f)));
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
    const claims = await stateClaims(env, url.searchParams.get('state'), me.id, platform);
    if (!claims) {
      throw new Error('sign-in expired, please try again');
    }
    const code = url.searchParams.get('code');
    await CALLBACK[platform](env, me, code, claims);
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
  const refresh = { grant_type: 'refresh_token', refresh_token: await unseal(env, row.refresh_token) };
  // Asking for the edit scope on refresh upgrades a token from before it; a token with access
  // to the channel files keeps it. Where the tenant (or the person) has not consented to
  // either after all, the token is refreshed without it, so replies keep working.
  const files = hasScope(row.scope, FILES_SCOPE.teams);
  const tries = [...new Set([
    teamsScope(env, files), teamsScope({}, files), teamsScope(env), TEAMS_SCOPE,
  ])];
  let data;
  for (const [i, scope] of tries.entries()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      data = await msToken(env, refresh, scope);
      break;
    } catch (e) {
      if (i === tries.length - 1) {
        throw e;
      }
    }
  }
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

/** `body` with each `@Name` of a mentioned account as `mark(account)` writes it. */
const markMentions = (body, mentions, mark) => splitMentions(body, mentions)
  .map((p) => (typeof p === 'string' ? p : mark(p))).join('');

/**
 * The Markdown of a Slack `markdown` block (posts as the opspile app): mentions as `<@U…>`,
 * which the block keeps as mentions.
 */
export const slackMarkdown = (body, mentions = []) => markMentions(body, mentions, (p) => `<@${p.id}>`);

/**
 * A Discord message's `content` and `allowed_mentions` (the opspile bot's posts): mentions as
 * `<@id>`, and the mentioned people are the only ones it pings (not `@everyone`, nor a role).
 */
export function discordMessage(body, mentions = []) {
  const users = new Set();
  const content = markMentions(body, mentions.filter((m) => m.kind !== 'bot'), (p) => {
    users.add(p.id);
    return `<@${p.id}>`;
  });
  return { content, allowed_mentions: { parse: [], ...(users.size ? { users: [...users] } : {}) } };
}

/**
 * The opspile Teams bot's message `text` (Markdown) and `entities`: each mention an
 * `<at>Name</at>` with its `mention` entity, by the person's Entra object id, which the Bot
 * Framework takes. A bot stays its `@Name`: Teams gives no bot what another bot writes.
 */
export function teamsBotMessage(body, mentions = []) {
  const entities = new Map();
  const text = markMentions(body, mentions.filter((m) => m.kind !== 'bot'), (p) => {
    const at = `<at>${p.name}</at>`;
    entities.set(p.id, { type: 'mention', text: at, mentioned: { id: p.id, name: p.name } });
    return at;
  });
  return { text, ...(entities.size ? { entities: [...entities.values()] } : {}) };
}

/**
 * Teams message `body` (Markdown, as HTML: the Graph API takes no Markdown) and `mentions`:
 * each mention an `<at id>` with its entry, a person as `user`, a bot as `application` (which
 * the bot receives like a mention typed in Teams).
 */
export function teamsMessage(body, mentions = []) {
  const entries = [];
  const marked = splitMentions(body, mentions).map((p) => {
    if (typeof p === 'string') {
      return p.replace(/\uE003/g, '');
    }
    const id = entries.length;
    entries.push({
      id,
      mentionText: p.name,
      mentioned: p.kind === 'bot'
        ? { application: { id: p.id, displayName: p.name, applicationIdentityType: 'bot' } }
        : { user: { id: p.id, displayName: p.name, userIdentityType: 'aadUser' } },
    });
    return `\uE003${id}\uE003`;
  }).join('');
  const content = messageHtml(marked).replace(/\uE003(\d+)\uE003/g, (_, id) => (
    `<at id="${id}">${htmlEscape(entries[id].mentionText)}</at>`
  ));
  return { body: { contentType: 'html', content }, ...(entries.length ? { mentions: entries } : {}) };
}

export const NAME = 'COALESCE(p.name, i.name)';
export const ACCOUNTS = `FROM identities i LEFT JOIN people p ON p.id = i.person
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
export async function knownMentions(env, t, ids) {
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

// Channel members are listed again when that is a week old (as for the channel suggestions),
// and up to this many members opspile has never seen are looked up each time.
const MEMBERS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MEMBER_LOOKUPS = 60;
const MEMBER_LOOKUPS_AT_ONCE = 4;
// Accounts of one workspace or tenant considered for a suggestion; far more than there are.
const MAX_ACCOUNTS = 5000;

/** The channels whose members count as the thread's: on Teams, every channel of its team. */
async function channelsOf(env, t) {
  if (t.source !== 'teams' || !t.group_id) {
    return [t.channel_id];
  }
  const { results } = await env.DB.prepare(`SELECT channel_id FROM channels
    WHERE source = 'teams' AND tenant = ? AND group_id = ?`).bind(t.tenant, t.group_id).all();
  return [...new Set([t.channel_id, ...(results || []).map((r) => r.channel_id)])];
}

/**
 * Lists the members of the thread's channel when that is a week old or was never done, and
 * looks up the members opspile has never seen (Slack lists ids only), so people who are in
 * the channel but never posted can be mentioned too. One request claims the listing (it
 * moves `members_at` first), so typing does not list the channel once per letter.
 */
export async function learnMembers(env, t, { now = Date.now(), ...deps } = {}) {
  if (t.source !== 'slack' && t.source !== 'teams') {
    return { skipped: 'members are not listed here' };
  }
  const at = new Date(now).toISOString();
  const claim = await env.DB.prepare(`UPDATE channels SET members_at = ?
    WHERE source = ? AND tenant = ? AND channel_id = ? AND (members_at IS NULL OR members_at < ?)`)
    .bind(at, t.source, t.tenant, t.channel_id, new Date(now - MEMBERS_MAX_AGE_MS).toISOString())
    .run();
  if (!claim.meta || !claim.meta.changes) {
    return { skipped: 'listed recently' };
  }
  const ch = await env.DB.prepare('SELECT * FROM channels WHERE source = ? AND tenant = ? AND channel_id = ?')
    .bind(t.source, t.tenant, t.channel_id).first();
  const listed = await refreshMembers(env, ch, deps, now);
  if (listed.error) {
    return listed;
  }
  const { results: unknown } = await env.DB.prepare(`SELECT cm.user_id FROM channel_members cm
    LEFT JOIN identities i ON i.source = cm.source AND i.tenant = cm.tenant AND i.user_id = cm.user_id
    WHERE cm.source = ? AND cm.tenant = ? AND cm.channel_id = ? AND i.user_id IS NULL LIMIT ?`)
    .bind(t.source, t.tenant, t.channel_id, MAX_MEMBER_LOOKUPS).all();
  const ids = (unknown || []).map((r) => r.user_id);
  const lookup = deps.getIdentity || getIdentity;
  for (let i = 0; i < ids.length; i += MEMBER_LOOKUPS_AT_ONCE) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(ids.slice(i, i + MEMBER_LOOKUPS_AT_ONCE).map((userId) => lookup(env, {
      source: t.source, tenant: t.tenant, userId,
    }, now).catch(() => null)));
  }
  return { members: listed.members, looked_up: ids.length };
}

const parseAliases = (s) => {
  try {
    const a = JSON.parse(s || '[]');
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
};

/**
 * Accounts by the names an earlier version of a message mentioned them by (`@Name` in its
 * markdown), so that editing it keeps them mentioned: a name that stands for exactly one
 * account of the thread's workspace or tenant (or one bot of its Teams team), else none.
 */
export async function mentionsByName(env, t, names) {
  const wanted = [...new Set(names.filter(Boolean))].slice(0, 200);
  if (!wanted.length) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT i.user_id AS id, ${NAME} AS name ${ACCOUNTS}
    AND ${NAME} IN (SELECT value FROM json_each(?))`)
    .bind(t.source, t.tenant, JSON.stringify(wanted)).all();
  const { results: bots } = t.source === 'teams' && t.group_id
    ? await env.DB.prepare(`SELECT i.user_id AS id, ${BOT_NAME} AS name ${BOTS}
      AND ${BOT_NAME} IN (SELECT value FROM json_each(?))`)
      .bind(t.tenant, t.group_id, JSON.stringify(wanted)).all()
    : { results: [] };
  const found = [
    ...(results || []).map((r) => ({ ...r, kind: 'person' })),
    ...(bots || []).map((r) => ({ ...r, kind: 'bot' })),
  ];
  const count = new Map();
  for (const a of found) {
    count.set(a.name, new Set([...(count.get(a.name) || []), a.id]));
  }
  const seen = new Set();
  return found.filter((a) => count.get(a.name).size === 1 && !seen.has(a.name) && seen.add(a.name));
}

/**
 * The accounts the `@Name`s of a text written for entry `key` stand for: agents write names and
 * pick nobody from a list, so this is what makes their `@Name`s mentions (see `mentionsByName`).
 */
export async function writtenMentions(env, key, text) {
  const names = mentionCandidates([text]);
  const t = names.length && await target(env, key);
  return t ? mentionsByName(env, t, names) : [];
}

/**
 * GET /api/mentionable?thread=…&q=…: people to mention in a reply, from the accounts in D1
 * for the thread's platform and workspace. People outside Adobe who posted in the thread come
 * first, then, with `me` given, the Adobe people who know what the thread is about (`expert`:
 * their messages anywhere are close to it, src/expertise.js), then anyone else who posted in
 * it, the members of its channel (on Teams: of its team, or who posted there), and everyone
 * else; among them by that affinity, then by how well `q` matches (src/mention-match.js: the
 * start of any word of the name, the Slack login or display name, or the mail address, in any
 * case), staff first, by name. On Teams, the bots seen in the thread's Teams team are offered
 * as well.
 *
 * `waitUntil`, where given, lists the channel's members in the background (`learnMembers`)
 * when the suggestions open (an empty `q`: the @ was just typed), so they show up from then on.
 * `me`, the viewer, is never anyone's expert: their own messages do not count.
 */
export async function mentionable(env, key, q, inTeam, { waitUntil, me } = {}) {
  const t = key && await target(env, key);
  if (!t || !await inTeam(await teamsOf(env, t), t)) {
    return json({ error: 'not found' }, 404);
  }
  const typed = String(q || '').trim().slice(0, 60);
  if (waitUntil && !typed) {
    waitUntil(learnMembers(env, t).catch((e) => console.warn(JSON.stringify({
      route: 'mentionable', members: t.source, error: e.message,
    }))));
  }
  const { results: botRows } = t.source === 'teams' && t.group_id
    ? await env.DB.prepare(`SELECT i.user_id AS id, ${BOT_NAME} AS name, i.name AS posts_as,
        i.avatar ${BOTS} ORDER BY b.at DESC`).bind(t.tenant, t.group_id).all()
    : { results: [] };
  const bots = rankMentions((botRows || []).map((r) => ({ ...r, aliases: [r.posts_as] })), typed)
    .slice(0, MAX_BOTS).map((r) => ({
      id: r.id, name: r.name, avatar: r.avatar || null, here: false, staff: false, kind: 'bot',
    }));
  const channels = JSON.stringify(await channelsOf(env, t));
  const [
    { results: accounts }, { results: posters }, { results: members }, experts,
  ] = await Promise.all([
    env.DB.prepare(`SELECT i.user_id AS id, i.person, ${NAME} AS name, i.name AS account_name, i.aliases,
        COALESCE(i.email, p.email) AS email, i.avatar,
        MAX(COALESCE(p.staff, 0), COALESCE(i.staff, 0)) AS staff
      ${ACCOUNTS} LIMIT ${MAX_ACCOUNTS}`).bind(t.source, t.tenant).all(),
    env.DB.prepare(`SELECT DISTINCT author_key FROM messages
      WHERE thread IN (SELECT thread FROM threads WHERE thread = ? OR logical_thread = ?)`)
      .bind(key, key).all(),
    env.DB.prepare(`SELECT user_id FROM channel_members
        WHERE source = ? AND tenant = ? AND channel_id IN (SELECT value FROM json_each(?))
      UNION SELECT DISTINCT SUBSTR(author_key, LENGTH(source || ':' || tenant || ':') + 1) FROM messages
        WHERE source = ? AND tenant = ? AND channel_id IN (SELECT value FROM json_each(?))
          AND author_key IS NOT NULL`)
      .bind(t.source, t.tenant, channels, t.source, t.tenant, channels).all(),
    me ? threadExperts(env, key, { me: me.id }) : null,
  ]);
  const prefix = `${t.source}:${t.tenant}:`;
  const affinity = (r) => (!experts || !r.staff || (me && r.person === me.id) ? 0 : Math.max(
    experts.authors.get(`${prefix}${r.id}`) || 0,
    (r.person !== null && experts.people.get(r.person)) || 0,
  ));
  const here = new Set((posters || []).map((r) => String(r.author_key || ''))
    .filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
  const inChannel = new Set((members || []).map((r) => r.user_id));
  const people = rankMentions((accounts || []).map((r) => ({
    ...r,
    aliases: [r.account_name, ...parseAliases(r.aliases), r.email],
    here: here.has(r.id),
    member: inChannel.has(r.id),
    affinity: affinity(r),
  })), typed, MAX_SUGGESTIONS - bots.length).map((r) => ({
    id: r.id,
    name: r.name,
    avatar: r.avatar || null,
    here: r.here,
    member: r.member,
    staff: Boolean(r.staff),
    ...(r.affinity > 0 ? { expert: true } : {}),
    kind: 'person',
  }));
  return json({ platform: t.source, people: [...people, ...bots] });
}

/** Slack errors that a new connection (with file access: `files`) would fix. */
const SLACK_RECONNECT = ['invalid_auth', 'token_revoked', 'not_authed', 'missing_scope'];

/**
 * POST /api/post `{ thread, text, mentions? }`, and `files` (src/attach.js): replies in the
 * thread as the signed-in person. `mentions` are account ids from /api/mentionable; each
 * `@Name` of one of them in the text becomes a real platform mention, so the person is
 * notified. Emoji `:names:` go as the platform knows them (src/shortcodes.js); `text` in the
 * answer is the reply as sent. Files go with the text, in the same message. The reply then
 * arrives like any other message, through the platform's events.
 */
export async function post(env, me, request, inTeam, files = []) {
  const { thread: key, text, mentions: ids } = request || {};
  const body = String(text || '').trim();
  if ((!body && !files.length) || body.length > MAX_TEXT) {
    return json({ error: 'write something (up to 8000 characters)' }, 400);
  }
  const t = key && await target(env, key);
  if (!t || !await inTeam(await teamsOf(env, t), t)) {
    return json({ error: 'not found' }, 404);
  }
  if (!isStaffDomain(env, me.email)) {
    return json({ error: 'only staff can reply' }, 403);
  }
  if (t.source === 'discord') {
    return json({ error: 'reply in Discord: the inbox cannot post there as you' }, 409);
  }
  const { token, scope } = await personalToken(env, me.id, t.source) || {};
  if (!token) {
    const name = t.source === 'slack' ? 'Slack' : 'Microsoft';
    return json({ error: `connect your ${name} account first`, connect: t.source }, 409);
  }
  const rule = personRule(t.source, scope);
  const refused = checkFiles(rule, files);
  if (refused) {
    // Connecting again with file access would let it through: say so.
    const again = Boolean(rule.reconnect)
      && !checkFiles(personRule(t.source, FILES_SCOPE[t.source]), files);
    return json({
      error: refused, ...(again ? { reconnect: t.source, files: true } : {}),
    }, again ? 409 : 400);
  }
  const mentions = await knownMentions(env, t, ids);
  // Emoji names as the platform knows them (`:facepalm:` is Slack's `:face_palm:`).
  const { text: sent } = await resolveShortcodes(env, body, { source: t.source, tenant: t.tenant });
  if (t.source === 'slack') {
    if (files.length) {
      const up = await slackUpload(token, {
        channel: t.channel_id, threadTs: t.root_id, comment: sent && slackText(sent, mentions),
      }, files);
      if (up.error === 'missing_scope') {
        // A token from before files:write, or one it was taken from.
        return json({
          error: 'Slack: the inbox needs your permission to upload files: connect your Slack account again',
          reconnect: 'slack',
          files: true,
        }, 409);
      }
      if (up.error) {
        const connect = SLACK_RECONNECT.includes(up.error) ? 'slack' : undefined;
        return json({ error: `Slack: ${up.error}`, connect }, 502);
      }
      // Slack names the files, not the message, which arrives through the events.
      return json({
        ok: true, platform: 'slack', id: null, files: up.files, text: sent,
      });
    }
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        channel: t.channel_id, thread_ts: t.root_id, text: slackText(sent, mentions),
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      const reconnect = SLACK_RECONNECT.includes(data.error);
      return json({ error: `Slack: ${data.error}`, connect: reconnect ? 'slack' : undefined }, 502);
    }
    return json({
      ok: true, platform: 'slack', id: data.ts, text: sent,
    });
  }
  if (!t.group_id) {
    return json({ error: 'the Teams team of this channel is not known yet' }, 409);
  }
  const message = teamsMessage(sent, mentions);
  if (files.length) {
    const att = await teamsAttachments(token, t, files, rule);
    if (att.error) {
      return json({
        error: att.error, ...(att.status === 409 ? { reconnect: 'teams', files: true } : {}),
      }, att.status || 502);
    }
    message.body.content = [message.body.content, att.html].filter(Boolean).join('<br>');
    if (att.hostedContents.length) {
      message.hostedContents = att.hostedContents;
    }
    if (att.attachments.length) {
      message.attachments = att.attachments;
    }
  }
  const path = `/teams/${encodeURIComponent(t.group_id)}/channels/${encodeURIComponent(t.channel_id)}`
    + `/messages/${encodeURIComponent(t.root_id)}/replies`;
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({
      error: `Teams: ${(data.error && data.error.code) || res.status}`,
      connect: res.status === 401 ? 'teams' : undefined,
    }, res.status === 413 ? 413 : 502);
  }
  return json({
    ok: true, platform: 'teams', id: data.id, text: sent,
  });
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
