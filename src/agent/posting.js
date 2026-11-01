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

import { botImages, discordForm, slackUpload } from '../attach.js';
import { discordApi, discordEnabled } from '../discord.js';
import {
  discordMessage, slackMarkdown, slackText, target as replyTarget, teamsBotMessage,
} from '../post.js';
import { editInTeams, postToTeams } from '../teamsbot.js';

/**
 * Posting by a thread agent (its `post_message` tool, when it is on): a reply in the latest
 * platform thread of its inbox entry, as the opspile app, never as a person. People reply as
 * themselves (src/post.js); the agent's replies say by their author that they are the app's.
 *
 * - Slack: `chat.postMessage` with the bot token (bot scope `chat:write`), in the thread, the
 *   Markdown in a `markdown` block.
 * - Discord: the bot (Send Messages, Send Messages in Threads), in the Discord thread when the
 *   conversation is one, else as an inline reply to its first message. No pings but the
 *   people a person posting as the app mentions.
 * - Teams: the opspile bot (src/teamsbot.js), a Bot Framework bot, in the channel thread;
 *   Microsoft Graph lets no app post to a channel.
 *
 * A person posting as the app (src/postapp.js) can attach files: Slack `files:write` uploads
 * with the bot token, Discord multipart, and on Teams inline images (src/attach.js). The
 * people they picked (`mentions`, src/post.js `knownMentions`) are mentioned as each platform
 * has it: `<@U…>` on Slack, `<@id>` on Discord (who alone are pinged there), and `<at>` with a
 * mention entity on Teams.
 *
 * The reply then arrives like any other message, through the platform's events.
 */

export const MAX_POST = { slack: 8000, discord: 2000, teams: 8000 };

/**
 * Posts `text` in the thread of inbox entry `key`: `{ ok, platform, id }`, or `{ error }`.
 * `options.files` (src/attach.js, checked against `appRule` already) go in the same message;
 * `options.mentions` are the accounts each `@Name` of which is a mention (src/post.js
 * `knownMentions`).
 */
export async function postAsApp(env, key, text, options = {}) {
  const { files = [], mentions = [], ...rest } = options;
  const body = String(text || '').trim();
  const t = key && await replyTarget(env, key);
  if (!t) {
    return { error: 'the thread is not known' };
  }
  if (!body && !files.length) {
    return { error: 'write something' };
  }
  if (MAX_POST[t.source] && body.length > MAX_POST[t.source]) {
    return { error: `too long: ${t.source} takes up to ${MAX_POST[t.source]} characters` };
  }
  if (t.source === 'slack') {
    if (!env.SLACK_BOT_TOKEN) {
      return { error: 'the opspile Slack app is not set up here' };
    }
    if (files.length) {
      // The text as the files' message, in mrkdwn: files.completeUploadExternal takes no blocks.
      const up = await slackUpload(env.SLACK_BOT_TOKEN, {
        channel: t.channel_id, threadTs: t.root_id, comment: body && slackText(body, mentions),
      }, files);
      if (up.error) {
        return {
          error: up.error === 'missing_scope'
            ? 'Slack: the opspile Slack app cannot upload files yet (it needs the bot scope files:write)'
            : `Slack: ${up.error}`,
        };
      }
      return { ok: true, platform: 'slack', id: null };
    }
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'content-type': 'application/json; charset=utf-8',
      },
      // The Markdown as a `markdown` block, which Slack renders itself (lists, headings, tables);
      // `text` in mrkdwn for notifications, and for opspile, which files messages by their text.
      body: JSON.stringify({
        channel: t.channel_id,
        thread_ts: t.root_id,
        text: slackText(body, mentions),
        blocks: [{ type: 'markdown', text: slackMarkdown(body, mentions) }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      // No answer from Slack itself: nobody can say whether it took the post.
      return { error: `Slack: ${data.error || res.status}`, unknown: !data.error && res.status >= 500 };
    }
    return { ok: true, platform: 'slack', id: data.ts };
  }
  if (t.source === 'discord') {
    if (!discordEnabled(env)) {
      return { error: 'the opspile Discord bot is not set up here' };
    }
    // No pings but the people mentioned.
    const message = discordMessage(body, mentions);
    if (message.content.length > MAX_POST.discord) {
      return { error: `too long: discord takes up to ${MAX_POST.discord} characters` };
    }
    // With files, the message goes as multipart: `payload_json` and `files[n]`.
    const request = (m) => (files.length ? { form: discordForm(m, files) } : { body: m });
    try {
      // A Discord thread's id is that of the message it was started from, the conversation's
      // root; without such a thread, the root is a message of the channel.
      let sent = await discordApi(env, `/channels/${t.root_id}/messages`, {
        method: 'POST', ...request(message), allow: [404],
      });
      if (!sent) {
        sent = await discordApi(env, `/channels/${t.channel_id}/messages`, {
          method: 'POST',
          ...request({
            ...message,
            message_reference: { message_id: t.root_id, fail_if_not_exists: false },
          }),
        });
      }
      return { ok: true, platform: 'discord', id: sent.id };
    } catch (e) {
      // `discord <status>` is Discord refusing; anything else lost the answer.
      return { error: `Discord: ${e.message}`, unknown: !/^discord [1-4]\d\d\b/.test(e.message) };
    }
  }
  if (t.source === 'teams') {
    const { text: marked, entities } = teamsBotMessage(body, mentions);
    return postToTeams(env, t, marked, { ...rest, attachments: botImages(files), entities });
  }
  return { error: `opspile cannot post to ${t.source}` };
}

/** The Discord channel a message is in, from its link (`/channels/<guild>/<channel>/<id>`). */
const discordChannelOf = (permalink) => {
  const m = /\/channels\/\d+\/(\d+)\/\d+$/.exec(String(permalink || ''));
  return m ? m[1] : null;
};

/**
 * Replaces the text of a message the opspile app posted, as the app: `{ ok, platform, id }`, or
 * `{ error }`. `t` is the message's platform thread row (with its Teams team's `group_id`),
 * `message` its `{ id, permalink }`, `mentions` the accounts it mentions, as for `postAsApp`.
 * The edit then arrives like any other, through the platform's events.
 */
export async function editAsApp(env, t, message, text, mentions = []) {
  const body = String(text || '').trim();
  const { id } = message;
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
    const res = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'content-type': 'application/json; charset=utf-8',
      },
      // As it was posted: the Markdown as a `markdown` block, `text` in mrkdwn.
      body: JSON.stringify({
        channel: t.channel_id,
        ts: id,
        text: slackText(body, mentions),
        blocks: [{ type: 'markdown', text: slackMarkdown(body, mentions) }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      return { error: `Slack: ${data.error || res.status}` };
    }
    return { ok: true, platform: 'slack', id };
  }
  if (t.source === 'discord') {
    if (!discordEnabled(env)) {
      return { error: 'the opspile Discord bot is not set up here' };
    }
    const patch = discordMessage(body, mentions);
    if (patch.content.length > MAX_POST.discord) {
      return { error: `too long: discord takes up to ${MAX_POST.discord} characters` };
    }
    // In the Discord thread of the conversation, or (an inline reply, the first message) in
    // the channel; the message's link says which.
    const channels = [...new Set([discordChannelOf(message.permalink),
      ...(id === t.root_id ? [] : [t.root_id]), t.channel_id].filter(Boolean))];
    try {
      for (const channel of channels) {
        // eslint-disable-next-line no-await-in-loop
        const done = await discordApi(env, `/channels/${channel}/messages/${id}`, {
          method: 'PATCH', body: patch, allow: [404],
        });
        if (done) {
          return { ok: true, platform: 'discord', id };
        }
      }
      return { error: 'Discord: the message is not there any more' };
    } catch (e) {
      return { error: `Discord: ${e.message}` };
    }
  }
  if (t.source === 'teams') {
    const { text: marked, entities } = teamsBotMessage(body, mentions);
    return editInTeams(env, t, id, marked, entities);
  }
  return { error: `opspile cannot edit on ${t.source}` };
}
