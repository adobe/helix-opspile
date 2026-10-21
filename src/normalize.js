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
  // Images are shown inline (through the inbox's media proxy); other files are links.
  const images = ok.filter((f) => /^image\//.test(f.mimetype || '') && f.url_private)
    .map((f) => `![${f.title || f.name || 'image'}](${f.url_private})`);
  const links = ok.filter((f) => !(/^image\//.test(f.mimetype || '') && f.url_private))
    .map((f) => `- [${f.title || f.name || 'file'}](${f.permalink || ''})`);
  return [images.join('\n'), links.join('\n')].filter(Boolean).join('\n\n');
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
      kind: 'bot', name: (msg.bot_profile && msg.bot_profile.name) || msg.username || msg.bot_id,
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
    text: [msg.text || '', files && `\n\nAttachments:\n${files}`].filter(Boolean).join(''),
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
    // the content, so they get the version of the change itself.
    if (!msg.edited) {
      message.version = slackVersion(event.event_ts || event.ts);
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
    const app = (msg.from && msg.from.application) || {};
    authorRef = { kind: 'bot', name: app.displayName || 'bot' };
  }
  const attachments = (msg.attachments || [])
    .filter((a) => a && a.contentType === 'reference')
    .map((a) => `- [${a.name || 'file'}](${a.contentUrl || ''})`)
    .join('\n');
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
    format: (msg.body && msg.body.contentType) === 'html' ? 'html' : 'text',
    text: [(msg.body && msg.body.content) || '', attachments && `<p>Attachments:</p>\n${attachments}`]
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
  if (source === 'slack') {
    return normalizeSlack(key, json);
  }
  if (source === 'teams') {
    return normalizeTeams(key, json);
  }
  return { op: 'skip', reason: `unknown source ${source}` };
}
