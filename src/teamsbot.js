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
 * The opspile bot on Microsoft Teams: how the thread agents post there (`post_message`).
 * Microsoft Graph lets no app post to a channel; a Bot Framework bot can, in the teams it is
 * installed in. The bot is the opspile Entra app itself (MS_CLIENT_ID, single tenant), registered
 * with the Bot Framework (an Azure Bot, Teams channel), and packaged as a Teams app
 * (scripts/teams-app.mjs) that the tenant's admins approve into the org catalog; TEAMS_APP_ID is
 * its id there.
 *
 * - Posting: the Bot Connector API, a reply in the channel thread
 *   (`<channel id>;messageid=<root id>`), with a token for the Bot Framework from the tenant.
 *   Editing a message it posted is the Bot Connector's update activity in the same thread.
 * - Installing: the bot can post only in teams it is installed in. On the first post to a team
 *   without it, opspile installs its app there through Graph (`TeamsAppInstallation.
 *   ReadWriteSelfForTeam.All`: the app may install only itself) and tries again.
 * - Receiving: the Bot Framework needs a messaging endpoint (`/teams/bot`). The bot is
 *   notification-only and opspile reads Teams through Graph, so the endpoint answers every
 *   activity with 200 and keeps nothing.
 */

// The Bot Connector of the public cloud, for messages the bot starts itself.
const SERVICE_URL = 'https://smba.trafficmanager.net/teams/';
const GRAPH = 'https://graph.microsoft.com/v1.0';
// How long Teams takes, after an install, before the bot can post in the team.
const INSTALL_SETTLE_MS = 4000;

export const teamsBotEnabled = (env) => Boolean(env.TEAMS_APP_ID && env.MS_CLIENT_ID
  && env.MS_CLIENT_SECRET && env.MS_TENANT_ID);

let cached = null;

/** A Bot Framework token of the opspile app, reused until five minutes before it expires. */
async function botToken(env) {
  if (cached && cached.app === env.MS_CLIENT_ID && cached.until > Date.now()) {
    return cached.token;
  }
  const res = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      scope: 'https://api.botframework.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    throw new Error(`bot token ${res.status} ${data.error || ''}`.trim());
  }
  cached = {
    app: env.MS_CLIENT_ID,
    token: data.access_token,
    until: Date.now() + (Number(data.expires_in || 3600) - 300) * 1000,
  };
  return cached.token;
}

/** Installs the opspile Teams app in a team; true when it is there now (or was). */
export async function installInTeam(env, groupId, { graph } = {}) {
  const g = graph || await cachedGraph(env);
  const res = await g(`/teams/${encodeURIComponent(groupId)}/installedApps`, {
    method: 'POST',
    body: JSON.stringify({ 'teamsApp@odata.bind': `${GRAPH}/appCatalogs/teamsApps/${env.TEAMS_APP_ID}` }),
  });
  if (res.ok || res.status === 409) {
    return true;
  }
  const data = await res.json().catch(() => ({}));
  throw new Error(`install ${res.status} ${(data.error && data.error.code) || ''}`.trim());
}

async function send(env, conversation, text, attachments = []) {
  const base = String(env.TEAMS_BOT_SERVICE_URL || SERVICE_URL).replace(/\/*$/, '/');
  return fetch(`${base}v3/conversations/${encodeURIComponent(conversation)}/activities`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await botToken(env)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'message', text, textFormat: 'markdown', ...(attachments.length ? { attachments } : {}),
    }),
  });
}

/** Whether a Bot Connector answer says the bot is not in the team (yet). */
async function notInTeam(res) {
  if (res.status !== 403 && res.status !== 404) {
    return false;
  }
  const data = await res.clone().json().catch(() => ({}));
  return /NotInConversationRoster|ConversationNotFound|BotNotInConversation/i
    .test(String((data.error && data.error.code) || data.code || ''));
}

const wait = (ms) => new Promise((r) => {
  setTimeout(r, ms);
});

/**
 * Replies in a Teams channel thread as the opspile bot: `{ ok, platform, id }` (the id is the
 * Teams message id), or `{ error }`. `t` is the thread row, with its team's `group_id`;
 * `attachments` are Bot Framework attachments (inline images, src/attach.js).
 */
export async function postToTeams(env, t, text, { sleep = wait, attachments = [] } = {}) {
  if (!teamsBotEnabled(env)) {
    return { error: 'the opspile Teams bot is not set up here' };
  }
  const conversation = `${t.channel_id};messageid=${t.root_id}`;
  try {
    let res = await send(env, conversation, text, attachments);
    if (await notInTeam(res)) {
      if (!t.group_id) {
        return { error: 'the Teams team of this channel is not known yet' };
      }
      await installInTeam(env, t.group_id);
      await sleep(INSTALL_SETTLE_MS);
      res = await send(env, conversation, text, attachments);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { error: `Teams: ${res.status} ${(data.error && data.error.code) || ''}`.trim() };
    }
    return { ok: true, platform: 'teams', id: data.id };
  } catch (e) {
    return { error: `Teams: ${e.message}` };
  }
}

/**
 * Replaces the text of a message the opspile bot posted in a Teams channel thread (the Bot
 * Connector's update activity): `{ ok, platform, id }`, or `{ error }`.
 */
export async function editInTeams(env, t, id, text) {
  if (!teamsBotEnabled(env)) {
    return { error: 'the opspile Teams bot is not set up here' };
  }
  const base = String(env.TEAMS_BOT_SERVICE_URL || SERVICE_URL).replace(/\/*$/, '/');
  const conversation = `${t.channel_id};messageid=${t.root_id}`;
  try {
    const res = await fetch(`${base}v3/conversations/${encodeURIComponent(conversation)}`
      + `/activities/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${await botToken(env)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'message', id, text, textFormat: 'markdown',
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { error: `Teams: ${res.status} ${(data.error && data.error.code) || ''}`.trim() };
    }
    return { ok: true, platform: 'teams', id };
  } catch (e) {
    return { error: `Teams: ${e.message}` };
  }
}

/** POST /teams/bot: the bot's messaging endpoint. Notification-only: every activity, 200. */
export function teamsBot() {
  return new Response(null, { status: 200 });
}
