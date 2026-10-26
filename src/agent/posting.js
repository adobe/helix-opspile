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

import { discordApi, discordEnabled } from '../discord.js';
import { slackText, target as replyTarget } from '../post.js';

/**
 * Posting by a thread agent (its `post_message` tool, when it is on): a reply in the latest
 * platform thread of its inbox entry, as the opspile app, never as a person. People reply as
 * themselves (src/post.js); the agent's replies say by their author that they are the app's.
 *
 * - Slack: `chat.postMessage` with the bot token (bot scope `chat:write`), in the thread.
 * - Discord: the bot (Send Messages, Send Messages in Threads), in the Discord thread when the
 *   conversation is one, else as an inline reply to its first message. No pings.
 * - Teams: not possible; Microsoft Graph lets no app post to a channel.
 *
 * The reply then arrives like any other message, through the platform's events.
 */

export const MAX_POST = { slack: 8000, discord: 2000 };

/**
 * Posts `text` in the thread of inbox entry `key`: `{ ok, platform, id }`, or `{ error }`.
 */
export async function postAsApp(env, key, text) {
  const body = String(text || '').trim();
  const t = key && await replyTarget(env, key);
  if (!t) {
    return { error: 'the thread is not known' };
  }
  if (!body) {
    return { error: 'write something' };
  }
  if (MAX_POST[t.source] && body.length > MAX_POST[t.source]) {
    return { error: `too long: ${t.source} takes up to ${MAX_POST[t.source]} characters` };
  }
  if (t.source === 'slack') {
    if (!env.SLACK_BOT_TOKEN) {
      return { error: 'the opspile Slack app is not set up here' };
    }
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: t.channel_id, thread_ts: t.root_id, text: slackText(body) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      return { error: `Slack: ${data.error || res.status}` };
    }
    return { ok: true, platform: 'slack', id: data.ts };
  }
  if (t.source === 'discord') {
    if (!discordEnabled(env)) {
      return { error: 'the opspile Discord bot is not set up here' };
    }
    const message = { content: body, allowed_mentions: { parse: [] } };
    try {
      // A Discord thread's id is that of the message it was started from, the conversation's
      // root; without such a thread, the root is a message of the channel.
      let sent = await discordApi(env, `/channels/${t.root_id}/messages`, {
        method: 'POST', body: message, allow: [404],
      });
      if (!sent) {
        sent = await discordApi(env, `/channels/${t.channel_id}/messages`, {
          method: 'POST',
          body: {
            ...message,
            message_reference: { message_id: t.root_id, fail_if_not_exists: false },
          },
        });
      }
      return { ok: true, platform: 'discord', id: sent.id };
    } catch (e) {
      return { error: `Discord: ${e.message}` };
    }
  }
  return { error: 'opspile cannot post to Teams as an app: save a draft for the team instead' };
}
