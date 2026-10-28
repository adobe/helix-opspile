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

/**
 * Pile 1 → operations on pile 2. Pure: no I/O. Each raw object becomes one operation:
 *
 * - `{ op: 'upsert', message }`: a message to write (new, or a newer version)
 * - `{ op: 'delete', message }`: a tombstone (`deletedAt`, no body)
 * - `{ op: 'channel', channel }`: channel metadata changed (rename, creation)
 * - `{ op: 'reaction', reaction }`: someone reacted to a message (read state only)
 * - `{ op: 'skip', reason }`: nothing for pile 2
 *
 * A message carries an `authorRef` that the caller resolves to an author, and its body
 * in the platform's format (`text` + `format`), converted later once mentions are known.
 */

import { snowflakeMs } from './discord.js';
import { mdLink, sizeTitle } from './markdown.js';

/** Slack subtypes that are ordinary messages from a person or a bot. */
const SLACK_CONTENT = new Set([
  undefined, 'thread_broadcast', 'bot_message', 'file_share', 'me_message',
]);

/** Slack subtypes that never produce a pile-2 message. */
const SLACK_SKIP = new Set(['message_replied', 'ekm_access_denied']);

const iso = (seconds) => new Date(Number(seconds) * 1000).toISOString();

/** Slack `ts` values sort as fixed-width strings once the seconds are padded. */
export const slackVersion = (ts) => {
  const [s, us = '0'] = String(ts).split('.');
  return `${s.padStart(12, '0')}.${us.padEnd(6, '0')}`;
};

export function slackPermalink(channel, ts, rootId) {
  const base = `https://slack.com/archives/${channel}/p${String(ts).replace('.', '')}`;
  return rootId && rootId !== ts ? `${base}?thread_ts=${rootId}&cid=${channel}` : base;
}

function slackFiles(files) {
  const ok = (files || []).filter((f) => f && (f.permalink || f.name));
  // A Slack Connect file the app could not look up (files.info): only its kind is known.
  const unseen = (files || []).filter((f) => f && !(f.permalink || f.name)
    && f.file_access === 'check_file_info')
    .map((f) => `- ${f.filetype ? `${String(f.filetype).toUpperCase()} file` : 'A file'} (shared from another workspace; opspile cannot see it)`);
  // Images are shown inline (through the inbox's media proxy); other files are links.
  const images = ok.filter((f) => /^image\//.test(f.mimetype || '') && f.url_private)
    .map((f) => mdLink(
      f.title || f.name || 'image',
      f.url_private,
      true,
      sizeTitle(f.original_w, f.original_h),
    ));
  const links = ok.filter((f) => !(/^image\//.test(f.mimetype || '') && f.url_private))
    .map((f) => `- ${mdLink(f.title || f.name || 'file', f.permalink)}`);
  return [images.join('\n'), [...links, ...unseen].join('\n')].filter(Boolean).join('\n\n');
}

const blockText = (t) => (t && typeof t.text === 'string' ? t.text : '');

/**
 * Block Kit to mrkdwn, for messages whose blocks say more than their `text` (bots and
 * apps). `rich_text` blocks are what Slack's own composer sends; for those, `text` already
 * holds the same content, so they are not rendered.
 */
export function slackBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.every((b) => b.type === 'rich_text')) {
    return null;
  }
  const out = [];
  for (const b of blocks) {
    if (b.type === 'header') {
      out.push(`*${blockText(b.text)}*`);
    } else if (b.type === 'section') {
      if (b.text) {
        out.push(blockText(b.text));
      }
      if (Array.isArray(b.fields) && b.fields.length) {
        // "*Label:*\nvalue" fields become one "*Label:* value" line each.
        out.push(b.fields.map((f) => blockText(f).replace(/^(\*[^*\n]+\*)\n/, '$1 ')).join('\n'));
      }
    } else if (b.type === 'context') {
      out.push((b.elements || []).map(blockText).filter(Boolean).join(' · '));
    } else if (b.type === 'divider') {
      out.push('---');
    } else if (b.type === 'image' && b.image_url) {
      out.push(`<${b.image_url}|${b.alt_text || 'image'}>`);
    }
  }
  const text = out.filter(Boolean).join('\n\n');
  return text || null;
}

/** Slack's reactions on a message (present on backfilled messages), one row per user. */
function slackReactions(msg) {
  if (!Array.isArray(msg.reactions)) {
    return undefined; // live message events carry no reactions; they arrive as events
  }
  return msg.reactions.flatMap((r) => (r.users || []).map((userId) => ({ emoji: r.name, userId })));
}

function slackMessage(payload, key, msg, channel, extra = {}) {
  const tenant = payload.enterprise_id || payload.team_id;
  const rootId = msg.thread_ts || msg.ts;
  let authorRef;
  if (msg.subtype && !SLACK_CONTENT.has(msg.subtype)) {
    authorRef = { kind: 'system', name: 'Slack' };
  } else if (msg.bot_id && !msg.user) {
    authorRef = {
      kind: 'bot',
      name: (msg.bot_profile && msg.bot_profile.name) || msg.username || null,
      botId: msg.bot_id,
      tenant,
      // Org-wide tokens need the workspace for bots.info.
      teamId: msg.team || payload.team_id || undefined,
    };
  } else {
    authorRef = {
      source: 'slack', tenant, userId: msg.user, home: msg.user_team, bot: Boolean(msg.bot_id),
    };
  }
  const files = slackFiles(msg.files);
  return {
    source: 'slack',
    tenant,
    channelId: channel,
    rootId,
    id: msg.ts,
    thread: `slack:${tenant}:${channel}:${rootId}`,
    at: iso(msg.ts),
    editedAt: msg.edited ? iso(msg.edited.ts) : undefined,
    version: slackVersion((msg.edited && msg.edited.ts) || msg.ts),
    authorRef,
    subtype: msg.subtype,
    format: 'mrkdwn',
    text: [slackBlocks(msg.blocks) || msg.text || '', files && `\n\nAttachments:\n${files}`]
      .filter(Boolean).join(''),
    reactions: slackReactions(msg),
    mentionIds: [...new Set([...String(msg.text || '').matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)]
      .map((m) => m[1]))],
    permalink: slackPermalink(channel, msg.ts, rootId),
    raw: key,
    ...extra,
  };
}

export function normalizeSlack(key, delivered) {
  // A backfilled message (conversations.replies) is a message event without the event.
  const payload = delivered.type === 'backfill'
    ? {
      enterprise_id: delivered.tenant,
      event: { ...delivered.message, type: 'message', channel: delivered.channel },
    }
    : delivered;
  const event = payload.event || {};
  const tenant = payload.enterprise_id || payload.team_id;

  if (event.type === 'channel_rename' || event.type === 'channel_created') {
    const ch = event.channel || {};
    return {
      op: 'channel',
      channel: {
        source: 'slack', tenant, channelId: ch.id, name: ch.name,
      },
    };
  }
  if ((event.type === 'reaction_added' || event.type === 'reaction_removed')
    && event.item && event.item.type === 'message') {
    return {
      op: 'reaction',
      reaction: {
        removed: event.type === 'reaction_removed',
        emoji: event.reaction,
        source: 'slack',
        tenant,
        channelId: event.item.channel,
        id: event.item.ts,
        userId: event.user,
        at: iso(event.event_ts || payload.event_time),
      },
    };
  }
  if (event.type !== 'message') {
    return { op: 'skip', reason: event.type || payload.type };
  }
  if (SLACK_SKIP.has(event.subtype)) {
    return { op: 'skip', reason: event.subtype };
  }
  if (event.subtype === 'message_changed') {
    const msg = event.message || {};
    const message = slackMessage(payload, key, msg, event.channel);
    // Unfurls and bot updates arrive as changes without `edited`; they still replace
    // the content, so they get the version of the change itself. A bot's update that changes
    // the text (chat.update, as the opspile app edits) is an edit all the same.
    if (!msg.edited) {
      message.version = slackVersion(event.event_ts || event.ts);
      const before = event.previous_message;
      if (before && typeof before.text === 'string' && before.text !== (msg.text || '')) {
        message.editedAt = iso(event.event_ts || event.ts);
      }
    }
    return { op: 'upsert', message };
  }
  if (event.subtype === 'message_deleted') {
    const prev = event.previous_message || { ts: event.deleted_ts };
    const message = slackMessage(payload, key, { ...prev, ts: event.deleted_ts }, event.channel, {
      deletedAt: iso(event.event_ts || event.ts),
      version: slackVersion(event.event_ts || event.ts),
    });
    return { op: 'delete', message };
  }
  return { op: 'upsert', message: slackMessage(payload, key, event, event.channel) };
}

/** Teams `lastModifiedDateTime` as a sortable version string. */
export const teamsVersion = (date) => String(Date.parse(date) || 0).padStart(15, '0');

/** Discord message types that are conversation: default, reply, slash and context commands. */
const DISCORD_CONTENT = new Set([0, 19, 20, 23]);

/** A Discord message's version: its edit (or creation) time, sortable like Teams'. */
export const discordVersion = (d) => teamsVersion(d.edited_timestamp || d.timestamp);

const discordImage = (a) => /^image\//.test(a.content_type || '')
  || (!a.content_type && /\.(png|jpe?g|gif|webp)$/i.test(a.filename || ''));

function discordAttachments(attachments) {
  const ok = (attachments || []).filter((a) => a && a.url);
  const images = ok.filter(discordImage)
    .map((a) => mdLink(a.description || a.filename || 'image', a.url, true, sizeTitle(a.width, a.height)));
  const links = ok.filter((a) => !discordImage(a))
    .map((a) => `- ${mdLink(a.filename || 'file', a.url)}`);
  return [images.join('\n'), links.join('\n')].filter(Boolean).join('\n\n');
}

/**
 * Rich embeds (what bots and webhooks post) as markdown: title, text, fields, footer. Link
 * previews Discord adds to people's messages are left out; the link is in the text.
 */
export function discordEmbeds(embeds) {
  const out = [];
  for (const e of (embeds || []).filter((x) => x && (x.type || 'rich') === 'rich')) {
    const parts = [];
    if (e.author && e.author.name) {
      parts.push(`*${e.author.name}*`);
    }
    if (e.title) {
      parts.push(`**${e.url ? mdLink(e.title, e.url) : e.title}**`);
    }
    if (e.description) {
      parts.push(e.description);
    }
    if (Array.isArray(e.fields) && e.fields.length) {
      parts.push(e.fields.map((f) => `**${f.name}:** ${f.value}`).join('\n'));
    }
    if (e.image && e.image.url) {
      parts.push(mdLink('image', e.image.url, true, sizeTitle(e.image.width, e.image.height)));
    }
    if (e.footer && e.footer.text) {
      parts.push(`*${e.footer.text}*`);
    }
    out.push(parts.join('\n\n'));
  }
  return out.filter(Boolean).join('\n\n---\n\n');
}

/** The display name of a Discord author: server nickname, global name, user name. */
export const discordName = (d) => (d.member && d.member.nick)
  || (d.author && (d.author.global_name || d.author.username)) || null;

/**
 * A Discord envelope (src/discord.js) to a pile-2 operation. Messages in a thread belong to
 * the thread's parent channel, under the thread's id (which is the id of the message the
 * thread was started from, or of a forum post's first message); an inline reply belongs to
 * the conversation of the message it replies to (`root`, set when it was stored).
 */
export function normalizeDiscord(key, envelope) {
  const { t, d = {}, guild } = envelope;
  const thread = envelope.thread || null;
  const channelId = thread ? thread.parent_id : d.channel_id;

  const rootId = envelope.root || (thread && thread.id) || d.id;
  const base = {
    source: 'discord',
    tenant: guild,
    channelId,
    rootId,
    id: d.id,
    thread: `discord:${guild}:${channelId}:${rootId}`,
    permalink: d.channel_id && d.id ? `https://discord.com/channels/${guild}/${d.channel_id}/${d.id}` : undefined,
    raw: key,
  };
  if (t === 'MESSAGE_DELETE') {
    return {
      op: 'delete',
      message: {
        ...base,
        at: d.id ? new Date(snowflakeMs(d.id)).toISOString() : undefined,
        // A deletion carries no time; it is newer than any version of the message.
        version: '9'.repeat(15),
        deletedAt: envelope.at || new Date(0).toISOString(),
        authorRef: { kind: 'system', name: 'Discord' },
        format: 'discord',
        text: '',
      },
    };
  }
  if (t !== 'MESSAGE_CREATE' && t !== 'MESSAGE_UPDATE') {
    return { op: 'skip', reason: t || 'unknown' };
  }
  if (!DISCORD_CONTENT.has(Number(d.type || 0))) {
    // Joins, pins, boosts, "started a thread" and a thread's copy of its starter message.
    return { op: 'skip', reason: `type ${d.type}` };
  }
  const author = d.author || {};
  let authorRef;
  if (d.webhook_id) {
    authorRef = { kind: 'bot', name: author.username || 'webhook' };
  } else {
    authorRef = {
      source: 'discord',
      tenant: guild,
      userId: author.id,
      name: discordName(d),
      bot: Boolean(author.bot),
    };
  }
  const files = discordAttachments(d.attachments);
  const embeds = discordEmbeds(d.embeds);
  // A forum post's title is its thread's name; a thread started from a message names it too.
  const subject = (thread && thread.id === d.id && thread.name) || (d.thread && d.thread.name);
  const reactions = Array.isArray(envelope.reactions)
    ? envelope.reactions.flatMap((r) => (r.users || [])
      .map((userId) => ({ emoji: r.emoji, userId, at: (r.at && r.at[userId]) || undefined })))
    : undefined;
  return {
    op: 'upsert',
    message: {
      ...base,
      at: d.timestamp ? new Date(d.timestamp).toISOString() : undefined,
      editedAt: d.edited_timestamp ? new Date(d.edited_timestamp).toISOString() : undefined,
      version: discordVersion(d),
      authorRef,
      subject: subject || undefined,
      format: 'discord',
      text: [d.content || '', embeds, files && `Attachments:\n\n${files}`].filter(Boolean).join('\n\n'),
      reactions,
      // Whoever reacted has read the thread up to here.
      reactors: reactions ? [...new Set(reactions.map((r) => r.userId))] : undefined,
      mentionIds: [...new Set((d.mentions || []).map((u) => u && u.id).filter(Boolean))],
    },
  };
}

export function normalizeTeams(key, msg) {
  const [, tenant] = key.split('/');
  if (key.split('/').pop().startsWith('notification-')) {
    return { op: 'skip', reason: 'notification' };
  }
  const identity = msg.channelIdentity || {};
  const rootId = msg.replyToId || msg.id;
  let authorRef;
  if (msg.messageType && msg.messageType !== 'message') {
    authorRef = { kind: 'system', name: 'Microsoft Teams' };
  } else if (msg.from && msg.from.user) {
    authorRef = {
      source: 'teams',
      tenant,
      userId: msg.from.user.id,
      name: msg.from.user.displayName,
      home: msg.from.user.tenantId,
    };
  } else {
    // Bots carry their bot id (the `28:` id without the prefix): with it they get an identity,
    // and a reply can mention them. Connectors and webhooks stay anonymous.
    const app = (msg.from && msg.from.application) || {};
    authorRef = { kind: 'bot', name: app.displayName || 'bot' };
    if (app.id && (app.applicationIdentityType || 'bot') === 'bot') {
      Object.assign(authorRef, { source: 'teams', tenant, botId: app.id });
    }
  }
  const attachments = (msg.attachments || [])
    .filter((a) => a && a.contentType === 'reference')
    .map((a) => `- ${mdLink(a.name || 'file', a.contentUrl)}`)
    .join('\n');
  const html = (msg.body && msg.body.contentType) === 'html';
  const message = {
    source: 'teams',
    tenant,
    channelId: identity.channelId,
    groupId: identity.teamId,
    rootId,
    id: msg.id,
    thread: `teams:${tenant}:${identity.teamId}:${identity.channelId}:${rootId}`,
    at: msg.createdDateTime,
    editedAt: msg.lastEditedDateTime || undefined,
    version: teamsVersion(msg.lastModifiedDateTime || msg.createdDateTime),
    authorRef,
    subject: msg.subject || undefined,
    format: html ? 'html' : 'text',
    // The same list as for Slack files; a plain-text body gets no HTML around it.
    text: [(msg.body && msg.body.content) || '', attachments
      && (html ? `<p>Attachments:</p>\n${attachments}` : `\nAttachments:\n\n${attachments}`)]
      .filter(Boolean).join('\n'),
    permalink: msg.webUrl,
    raw: key,
    reactions: (msg.reactions || [])
      .filter((r) => r && r.user && r.user.user && r.user.user.id)
      .map((r) => ({
        emoji: r.reactionType || r.displayName, userId: r.user.user.id, at: r.createdDateTime,
      })),
    mentionIds: [...new Set((msg.mentions || [])
      .map((x) => x && x.mentioned && x.mentioned.user && x.mentioned.user.id)
      .filter(Boolean))],
    // Bots people mentioned, by the name they used (the mention text), for mentions in replies.
    botMentions: [...new Map((msg.mentions || [])
      .filter((x) => x && x.mentioned && x.mentioned.application && x.mentioned.application.id
        && x.mentioned.application.applicationIdentityType === 'bot')
      .map(({ mentionText, mentioned: { application: a } }) => [a.id, {
        id: a.id, name: mentionText || a.displayName || null,
      }])).values()],
    // Teams reports reactions on the message itself; each reactor has read up to here.
    reactors: [...new Set((msg.reactions || [])
      .map((r) => r && r.user && r.user.user && r.user.user.id)
      .filter(Boolean))],
  };
  if (msg.deletedDateTime) {
    return { op: 'delete', message: { ...message, deletedAt: msg.deletedDateTime } };
  }
  return { op: 'upsert', message };
}

/** Dispatches on the pile-1 key's source. */
export function normalize(key, json) {
  const source = key.split('/')[0];
  if (source === 'slack' && json && json.type === 'file_info') {
    // A kept files.info answer (src/slackfiles.js), not an event.
    return { op: 'skip', reason: 'file info' };
  }
  if (source === 'slack') {
    return normalizeSlack(key, json);
  }
  if (source === 'teams') {
    return normalizeTeams(key, json);
  }
  if (source === 'discord') {
    return normalizeDiscord(key, json);
  }
  return { op: 'skip', reason: `unknown source ${source}` };
}
