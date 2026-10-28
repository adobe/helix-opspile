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

import { appPostCheck } from './postapp.js';
import { editAsApp } from './agent/posting.js';
import { parse } from './channels.js';
import { json } from './http.js';
import { isStaffDomain } from './lookup.js';
import {
  knownMentions, mentionsByName, personalToken, slackText, TEAMS_EDIT_SCOPE, teamsMessage,
} from './post.js';
import { mentionCandidates } from './profiles.js';
import { segment } from './raw.js';
import { teamsOf } from './shares.js';

/**
 * Editing a sent message from the inbox, the way it was sent (src/post.js, src/postapp.js):
 *
 * - **as the person**, a message they posted, with their own token: Slack `chat.update`
 *   (user scope `chat:write`, which covers their own messages), Teams `PATCH` on the channel
 *   message or reply (delegated `ChannelMessage.ReadWrite`, see TEAMS_EDITS). Discord lets only
 *   bots edit through its API: people edit there.
 * - **as the opspile app**, a message the person posted as the app (`app_posts`): Slack
 *   `chat.update` with the bot token, Teams the Bot Connector's update activity, Discord
 *   `PATCH` with the bot. Allowed where the app may post (the "Post messages" switch).
 *
 * Nothing is written here: the edited message comes back through the platform's events, like
 * every other edit, and the inbox shows the new text meanwhile.
 */

const MAX_TEXT = 8000;
const SLACK_RECONNECT = ['invalid_auth', 'token_revoked', 'not_authed', 'account_inactive', 'missing_scope'];
const SLACK_SAYS = {
  cant_update_message: 'Slack does not let you edit this message',
  edit_window_closed: 'the workspace no longer lets you edit this message',
  message_not_found: 'Slack no longer has this message',
};

const THREAD = `SELECT t.*, c.group_id FROM threads t LEFT JOIN channels c
  ON c.source = t.source AND c.tenant = t.tenant AND c.channel_id = t.channel_id`;

/** The message's markdown in pile 2, for the mentions it had; '' when it cannot be read. */
async function bodyOf(env, t, id) {
  const obj = env.CHANNELS && t.path ? await env.CHANNELS.get(`${t.path}${segment(id)}.md`) : null;
  const file = obj ? parse(await obj.text()) : null;
  return (file && file.body) || '';
}

/**
 * Whom the edited text mentions: the accounts picked in the inbox (`ids`, as for a reply), and
 * those the message mentioned before, by the `@Name` it showed them as.
 */
async function mentionsFor(env, t, id, ids) {
  const [picked, before] = await Promise.all([
    knownMentions(env, t, ids),
    bodyOf(env, t, id).then((body) => mentionsByName(env, t, mentionCandidates([body]))),
  ]);
  const seen = new Set(picked.map((m) => m.id));
  return [...picked, ...before.filter((m) => !seen.has(m.id))];
}

/** The edit as the person, with their token. `{ ok }` or `{ error, status, connect? }`. */
async function editAsUser(env, me, t, msg, body, ids) {
  if (t.source === 'discord') {
    return { error: 'edit it in Discord: opspile cannot edit there as you', status: 409 };
  }
  const tok = await personalToken(env, me.id, t.source);
  const name = t.source === 'slack' ? 'Slack' : 'Microsoft';
  if (!tok) {
    return { error: `connect your ${name} account first`, status: 409, connect: t.source };
  }
  // Posted from the account connected now (a person may have connected another one since).
  if (msg.author_key !== `${t.source}:${t.tenant}:${tok.userId}`) {
    return { error: `this message was posted from another ${name} account`, status: 403 };
  }
  const mentions = await mentionsFor(env, t, msg.id, ids);
  if (t.source === 'slack') {
    const res = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: t.channel_id, ts: msg.id, text: slackText(body, mentions) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      return {
        error: SLACK_SAYS[data.error] || `Slack: ${data.error || res.status}`,
        status: SLACK_SAYS[data.error] ? 409 : 502,
        connect: SLACK_RECONNECT.includes(data.error) ? 'slack' : undefined,
      };
    }
    return { ok: true };
  }
  if (!tok.scope.split(/[\s,]+/).some((s) => s.endsWith(TEAMS_EDIT_SCOPE))) {
    return env.TEAMS_EDITS
      ? {
        error: 'connect Microsoft again to edit (opspile now asks for ChannelMessage.ReadWrite)',
        status: 409,
        reconnect: 'teams',
      }
      : { error: 'editing Teams messages is not set up here', status: 409 };
  }
  if (!t.group_id) {
    return { error: 'the Teams team of this channel is not known yet', status: 409 };
  }
  const reply = msg.id === t.root_id ? '' : `/replies/${encodeURIComponent(msg.id)}`;
  const path = `/teams/${encodeURIComponent(t.group_id)}/channels/${encodeURIComponent(t.channel_id)}`
    + `/messages/${encodeURIComponent(t.root_id)}${reply}`;
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(teamsMessage(body, mentions)),
  });
  if (res.ok) {
    return { ok: true };
  }
  const data = await res.json().catch(() => ({}));
  return {
    error: `Teams: ${(data.error && data.error.code) || res.status}`,
    status: 502,
    connect: res.status === 401 ? 'teams' : undefined,
    reconnect: res.status === 403 ? 'teams' : undefined,
  };
}

/**
 * POST /api/edit `{ thread, id, text, mentions? }`: replaces the text of message `id` in
 * platform thread `thread` (as /api/react names a message), as it was sent: as the signed-in
 * person if they posted it, as the opspile app if they posted it as the app. `mentions` are
 * account ids from /api/mentionable, as for /api/post.
 */
export async function edit(env, me, request, inTeam) {
  const {
    thread: key, id, text, mentions: ids,
  } = request || {};
  const t = key && await env.DB.prepare(`${THREAD} WHERE t.thread = ?`).bind(String(key)).first();
  if (!t || !inTeam(await teamsOf(env, t))) {
    return json({ error: 'not found' }, 404);
  }
  const msg = await env.DB.prepare(`SELECT id, person, author_key, permalink FROM messages
    WHERE thread = ? AND id = ? AND deleted = 0`).bind(t.thread, String(id || '')).first();
  if (!msg) {
    return json({ error: 'not found' }, 404);
  }
  if (!isStaffDomain(env, me.email)) {
    return json({ error: 'only staff can edit' }, 403);
  }
  const body = String(text || '').trim();
  if (!body || body.length > MAX_TEXT) {
    return json({ error: 'write something (up to 8000 characters)' }, 400);
  }
  const app = await env.DB.prepare(`SELECT person FROM app_posts
    WHERE source = ? AND tenant = ? AND channel_id = ? AND id = ?`)
    .bind(t.source, t.tenant, t.channel_id, msg.id).first();
  let done;
  if (app && app.person === me.id) {
    // The app speaks in a channel only where it may post, also to correct itself.
    const check = await appPostCheck(env, t.thread);
    done = check.problem ? { error: check.problem, status: check.status }
      : await editAsApp(env, t, msg, body);
    if (done.error && !done.status) {
      done.status = /^too long/.test(done.error) ? 400 : 502;
    }
  } else if (msg.person === me.id) {
    done = await editAsUser(env, me, t, msg, body, ids);
  } else {
    return json({ error: 'you can only edit messages you sent' }, 403);
  }
  if (done.error) {
    return json({
      error: done.error, connect: done.connect, reconnect: done.reconnect,
    }, done.status || 502);
  }
  const as = app && app.person === me.id ? 'app' : 'user';
  console.log(JSON.stringify({
    route: 'edit', as, platform: t.source, team: t.team,
  }));
  return json({
    ok: true, platform: t.source, id: msg.id, as,
  });
}
