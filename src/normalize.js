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
 * - `{ op: 'lobby', lobby }`: how a lobby of the customer portal is now (src/portalrequests.js)
 * - `{ op: 'skip', reason }`: nothing for pile 2
 *
 * A message carries an `authorRef` that the caller resolves to an author, and its body
 * in the platform's format (`text` + `format`), converted later once mentions are known.
 */

import { snowflakeMs } from './discord.js';
import { mdLink, sizeTitle } from './markdown.js';
import { parseResource } from './raw.js';
import { canonicalUrl } from './teamsfiles.js';

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

/**
 * A Slack link opened in the workspace `domain` (`<domain>.slack.com`). A bare `slack.com`
 * link opens in whichever workspace the browser used last, which may not be one with the
 * channel. Without a domain the link stays as it is.
 */
export function slackLinkIn(domain, url) {
  return domain && url
    ? String(url).replace(/^https:\/\/([a-z0-9-]+\.)?slack\.com\/archives\//, `https://${domain}.slack.com/archives/`)
    : url;
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

/**
 * The messages a Slack message quotes: one forwarded with it (`is_share`), or the preview Slack
 * adds under a link to a message (`is_msg_unfurl`). Each is `{ authorId, author, at, url, text }`,
 * the text in mrkdwn; src/normalizer.js puts them below the message's text (quoteMarkdown).
 * Other attachments (link previews, bots' legacy attachments) are not quotes.
 */
export function slackQuotes(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter((a) => a && (a.is_share || a.is_msg_unfurl) && a.from_url)
    .map((a) => ({
      authorId: a.author_id || undefined,
      // A message posted through an app names the app, and the person as the sub-name.
      author: a.author_subname || a.author_name || undefined,
      at: a.ts ? iso(a.ts) : undefined,
      url: a.from_url,
      text: typeof a.text === 'string' ? a.text : '',
    }));
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
    const icons = (msg.bot_profile && msg.bot_profile.icons) || {};
    authorRef = {
      kind: 'bot',
      name: (msg.bot_profile && msg.bot_profile.name) || msg.username || null,
      // The bot's picture, for its identity when it has none (src/lookup.js, botIdentity).
      ...(icons.image_72 || icons.image_48 ? { avatar: icons.image_72 || icons.image_48 } : {}),
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
  const quotes = slackQuotes(msg.attachments);
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
    // The text, the messages it quotes, then its files (markdown already): src/normalizer.js.
    // The blocks are read before the text (src/slackmd.js), which is mrkdwn.
    text: msg.text || '',
    blocks: Array.isArray(msg.blocks) && msg.blocks.length ? msg.blocks : undefined,
    quotes: quotes.length ? quotes : undefined,
    files: files ? `Attachments:\n${files}` : undefined,
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
    const when = event.event_ts || payload.event_time;
    return {
      op: 'channel',
      channel: {
        source: 'slack',
        tenant,
        channelId: ch.id,
        name: ch.name,
        // When it was renamed: a replayed rename names the channel as it was then.
        ...(when ? { at: iso(when) } : {}),
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
      // What was written (Discord's markdown), then its embeds and files, markdown already.
      text: d.content || '',
      after: [embeds, files && `Attachments:\n\n${files}`].filter(Boolean).join('\n\n') || undefined,
      reactions,
      // Whoever reacted has read the thread up to here.
      reactors: reactions ? [...new Set(reactions.map((r) => r.userId))] : undefined,
      mentionIds: [...new Set((d.mentions || []).map((u) => u && u.id).filter(Boolean))],
    },
  };
}

/**
 * Graph's ISO 8601 duration (`PT1H2M5.3S`) in words (`1 h 2 min 5 s`), or null.
 */
export function durationText(duration) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(String(duration || ''));
  if (!m) {
    return null;
  }
  const [d, h, min, s] = m.slice(1).map((x) => Number(x) || 0);
  const parts = [
    [d, 'd'], [h, 'h'], [min, 'min'], [Math.round(s), 's'],
  ].filter(([n]) => n > 0).map(([n, u]) => `${n} ${u}`);
  return parts.length ? parts.join(' ') : '0 s';
}

/** The user of a Teams identity set (`initiator`, a participant), or the user itself. */
const teamsUser = (x) => (x && x.user) || (x && x.id ? x : null);

/**
 * The users a Teams event names (`eventDetail`: who started it, took part, was added), as
 * `{ id, displayName, tenantId }`, so their names can be looked up: Graph often leaves
 * `displayName` empty.
 */
export function teamsEventUsers(detail) {
  const d = detail || {};
  const all = [
    d.initiator, d.meetingOrganizer, d.conversationMemberUser,
    ...(d.callParticipants || []).map((p) => p && p.participant),
    ...(d.members || []),
  ].map(teamsUser).filter((u) => u && u.id);
  return [...new Map(all.map((u) => [u.id, u])).values()];
}

const escName = (s) => String(s).replace(/[\\`*_[\]<>]/g, '\\$&');

/** `a`, `a and b`, `a, b and c`; past ten names, how many more. */
function names(list) {
  const shown = list.length > 10 ? [...list.slice(0, 9), `${list.length - 9} more`] : list;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] || '';
}

const CALL_KIND = { meeting: 'Meeting', call: 'Call', screenShare: 'Screen sharing' };

/**
 * What a Teams system notice (`eventDetail`) says, as a line of markdown: "Meeting ended after
 * 50 s. Only Ada joined." `name(user)` names a user (`{ id, displayName }`), by default by
 * the name Graph sent; an app is named by its display name.
 */
export function teamsEventText(detail, name = (u) => u.displayName) {
  const d = detail || {};
  const who = (x) => {
    const u = teamsUser(x);
    const n = (u && name(u)) || (x && x.application && x.application.displayName);
    return n ? escName(n) : null;
  };
  const by = who(d.initiator);
  const subject = by || 'Someone';
  const quoted = (s) => (s ? ` “${escName(s)}”` : '');
  const people = (list) => names((list || []).map((u) => who(u) || 'someone'));
  const type = String(d['@odata.type'] || '').replace(/^#?microsoft\.graph\./, '')
    .replace(/EventMessageDetail$/, '');
  const call = CALL_KIND[d.callEventType] || 'Call';
  switch (type) {
    case 'callStarted':
      return by ? `${call} started by ${by}.` : `${call} started.`;
    case 'callEnded': {
      const after = durationText(d.callDuration);
      const joined = (d.callParticipants || []).map((p) => p && p.participant);
      let line = after ? `${call} ended after ${after}.` : `${call} ended.`;
      if (joined.length === 1) {
        line += ` Only ${people(joined)} joined.`;
      } else if (joined.length) {
        line += ` Joined: ${people(joined)}.`;
      }
      return line;
    }
    case 'callRecording': {
      const length = durationText(d.callRecordingDuration);
      const label = d.callRecordingDisplayName || 'Recording';
      const what = d.callRecordingUrl ? mdLink(label, d.callRecordingUrl) : escName(label);
      if (d.callRecordingStatus === 'failure') {
        return `Recording failed: ${what}.`;
      }
      return `Recording: ${what}${length ? ` (${length})` : ''}.`;
    }
    case 'callTranscript':
      return `Transcript of the ${call.toLowerCase()} is available.`;
    case 'membersAdded':
      return `${subject} added ${people(d.members)}.`;
    case 'membersDeleted':
      return `${subject} removed ${people(d.members)}.`;
    case 'membersJoined':
      return `${people(d.members)} joined.`;
    case 'membersLeft':
      return `${people(d.members)} left.`;
    case 'conversationMemberRoleUpdated': {
      const roles = (d.conversationMemberRoles || []).join(', ') || 'member';
      return `${subject} made ${who(d.conversationMemberUser) || 'someone'} ${roles}.`;
    }
    case 'channelAdded':
      return `${subject} created the channel${quoted(d.channelDisplayName)}.`;
    case 'channelRenamed':
      return `${subject} renamed the channel to${quoted(d.channelDisplayName)}.`;
    case 'channelDeleted':
      return `${subject} deleted the channel${quoted(d.channelDisplayName)}.`;
    case 'channelDescriptionUpdated':
      return `${subject} changed the channel's description.`;
    case 'teamRenamed':
      return `${subject} renamed the team to${quoted(d.teamDisplayName)}.`;
    case 'teamDescriptionUpdated':
      return `${subject} changed the team's description.`;
    case 'teamCreated':
      return `${subject} created the team${quoted(d.teamDisplayName)}.`;
    case 'teamArchived':
      return `${subject} archived the team.`;
    case 'teamUnarchived':
      return `${subject} restored the team.`;
    case 'messagePinned':
      return `${subject} pinned a message.`;
    case 'messageUnpinned':
      return `${subject} unpinned a message.`;
    case 'tabUpdated':
      return `${subject} changed a tab.`;
    case 'teamsAppInstalled':
      return `${subject} added the app${quoted(d.teamsAppDisplayName)}.`;
    case 'teamsAppRemoved':
      return `${subject} removed the app${quoted(d.teamsAppDisplayName)}.`;
    case 'teamsAppUpgraded':
      return `${subject} updated the app${quoted(d.teamsAppDisplayName)}.`;
    default: {
      // One Graph adds later: its type in words (`fooBarUpdated`: "Foo bar updated").
      const words = type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      if (!words) {
        return '';
      }
      return `${words[0].toUpperCase()}${words.slice(1)}${by ? ` (${by})` : ''}.`;
    }
  }
}

/** Slack's notices that a channel was archived or restored (message subtypes). */
const SLACK_ARCHIVE_NOTICES = new Set([
  'channel_archive', 'channel_unarchive', 'group_archive', 'group_unarchive',
]);

/**
 * Whether a message is a system notice that its channel changed in a way its row keeps: on
 * Teams, that the channel or its Teams team got a new name (the rules read both names), or was
 * archived or restored; on Slack, that the channel was archived or restored. The normalizer
 * looks the channel up again then.
 */
export const isChannelNotice = (message) => /^#?microsoft\.graph\.(channel|team)(Renamed|Archived|Unarchived)EventMessageDetail$/
  .test(String((message && message.event && message.event['@odata.type']) || ''))
  || Boolean(message && message.source === 'slack' && SLACK_ARCHIVE_NOTICES.has(message.subtype));

/** Text as an HTML attribute value (or element text). */
const attr = (s) => String(s).replace(/[&"<>]/g, (c) => ({
  '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;',
})[c]);

/**
 * A Teams change notification (src/teams.js). A new or edited message is filed from the copy
 * fetched next to it; a deleted one only from the notification, since Graph answers 404 for a
 * deleted channel message. The notification names the message (its `resource`) and nothing
 * else: the tombstone's time is when it was received (`receivedAt`, the object's metadata, or
 * else the day in its key), and its creation time is its id, the milliseconds Teams gives it.
 */
function teamsNotification(key, item, { receivedAt } = {}) {
  if (!item || item.changeType !== 'deleted') {
    return { op: 'skip', reason: 'notification' };
  }
  const res = parseResource(item.resource);
  if (!res) {
    return { op: 'skip', reason: 'notification' };
  }
  const parts = key.split('/');
  const [, tenant] = parts;
  const [y, m, d] = parts.slice(-4, -1);
  const deletedAt = (receivedAt && !Number.isNaN(Date.parse(receivedAt))
    ? new Date(receivedAt).toISOString() : null)
    || (/^\d{4}$/.test(y) ? `${y}-${m}-${d}T00:00:00.000Z` : new Date(0).toISOString());
  const created = /^\d{10,15}$/.test(res.messageId) ? Number(res.messageId) : NaN;
  return {
    op: 'delete',
    message: {
      source: 'teams',
      tenant,
      channelId: res.channelId,
      groupId: res.teamId,
      rootId: res.rootId,
      id: res.messageId,
      thread: `teams:${tenant}:${res.teamId}:${res.channelId}:${res.rootId}`,
      at: Number.isNaN(created) ? deletedAt : new Date(created).toISOString(),
      // A deletion carries no version; it is newer than any version of the message.
      version: '9'.repeat(15),
      deletedAt,
      authorRef: { kind: 'system', name: 'Microsoft Teams' },
      format: 'text',
      text: '',
      raw: key,
    },
  };
}

export function normalizeTeams(key, msg, meta = {}) {
  const [, tenant] = key.split('/');
  if (key.split('/').pop().startsWith('notification-')) {
    return teamsNotification(key, msg, meta);
  }
  const identity = msg.channelIdentity || {};
  const rootId = msg.replyToId || msg.id;
  // A system notice says what happened in `eventDetail` only: its body is `<systemEventMessage/>`.
  const event = msg.messageType && msg.messageType !== 'message' && msg.eventDetail
    && typeof msg.eventDetail === 'object' ? msg.eventDetail : null;
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
  const refs = (msg.attachments || []).filter((a) => a && a.contentType === 'reference');
  const html = (msg.body && msg.body.contentType) === 'html';
  // Images opspile copied into pile 1 (src/teamsfiles.js) are shown where Teams shows them,
  // in place of their `<attachment>` tag, through the inbox's media proxy; other files are
  // links, listed below the text.
  const inline = new Set(refs.filter((a) => a.opspile && /^image\//.test(a.opspile.type || '')
    && canonicalUrl(a.contentUrl)));
  let body = (msg.body && msg.body.content) || '';
  const after = [];
  for (const a of inline) {
    const url = canonicalUrl(a.contentUrl);
    const { width: w, height: h } = a.opspile;
    if (html) {
      const img = `<img src="${attr(url)}" alt="${attr(a.name || 'image')}"${sizeTitle(w, h) ? ` width="${Math.round(w)}" height="${Math.round(h)}"` : ''}>`;
      const id = String(a.id || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const tag = new RegExp(`<attachment\\s+id="${id}"\\s*>\\s*</attachment>`, 'i');
      if (a.id && tag.test(body)) {
        body = body.replace(tag, `<p>${img}</p>`);
      } else {
        after.push(`<p>${img}</p>`);
      }
    } else {
      after.push(mdLink(a.name || 'image', url, true, sizeTitle(w, h)));
    }
  }
  const files = refs.filter((a) => !inline.has(a));
  const attachments = files.map((a) => `- ${mdLink(a.name || 'file', a.contentUrl)}`).join('\n');
  // In an HTML body, the list is HTML too: htmlToMarkdown keeps markdown in HTML as text.
  const htmlList = `<ul>${files.map((a) => `<li><a href="${attr(a.contentUrl || '')}">${attr(a.name || 'file')}</a></li>`).join('')}</ul>`;
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
    ...(event ? {
      // Names resolved by the normalizer (src/normalizer.js); this text is the fallback.
      format: 'teams-event',
      event,
      text: teamsEventText(event),
    } : {
      format: html ? 'html' : 'text',
      // The same list as for Slack files; a plain-text body gets no HTML around it.
      text: [body, ...after, attachments
        && (html ? `<p>Attachments:</p>${htmlList}` : `\nAttachments:\n\n${attachments}`)]
        .filter(Boolean).join('\n'),
    }),
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

/**
 * A customer portal event (src/portal/events.js, stored by src/portalsource.js) to a pile-2
 * operation. The portal is this repository's own, so its events say what the normalizer needs
 * in the normalizer's terms: a message as it is now (posted, edited or deleted; `rev` counts
 * its changes, and is its version), with its channel's name and its author's name and mail address,
 * which the lookups take from here (`channelHint`, `authorRef`) instead of asking the portal;
 * its files as links to the portal, which the inbox opens through it, and whom it mentions.
 * The tenant is the lobby, the customer's mail domain.
 */
/** A portal message's files as the list every platform's files are (see `slackFiles`). */
function portalFiles(files) {
  const ok = (Array.isArray(files) ? files : []).filter((f) => f && f.url && f.name);
  const shown = (f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type || '');
  const images = ok.filter(shown)
    .map((f) => mdLink(f.name, f.url, true, sizeTitle(f.width, f.height)));
  const links = ok.filter((f) => !shown(f)).map((f) => `- ${mdLink(f.name, f.url)}`);
  return [images.join('\n'), links.join('\n')].filter(Boolean).join('\n\n');
}

/**
 * Where the inbox shows the picture of a portal account: one the person uploaded there comes
 * through the inbox (`GET /api/portal/avatar/…`, src/portalsource.js), one the inbox gave for
 * its own people is where it was; '' when the event names neither.
 */
const portalAvatar = (a) => (a.picture
  ? `/api/portal/avatar/${encodeURIComponent(a.id)}?v=${encodeURIComponent(a.picture)}`
  : (/^https:\/\//.test(a.avatar || '') && a.avatar) || '');

export function normalizePortal(key, event) {
  const e = event || {};
  const tenant = e.domain;
  if (e.type === 'lobby') {
    return {
      op: 'lobby',
      lobby: {
        ...(e.lobby || {}), domain: tenant, portal: e.portal || 'portal', seq: e.seq, at: e.at,
      },
    };
  }
  const ch = e.channel || {};
  const channelHint = { name: ch.name, topic: ch.topic || null, company: ch.company || null };
  // Who sees the channel's threads (portal migration 0008), by the event's number in the portal's
  // outbox: a channel event either way (but the one a channel is made with, which says nothing),
  // a message only of an individual channel. A shared channel's messages say nothing, so they
  // write nothing: the channel event that made it shared again did (src/individual.js).
  const audience = (e.type === 'channel' || ch.audience === 'individual') ? ch.audience || null : null;
  const heard = audience ? { audience: { audience, seq: Number(e.seq) || 0 } } : {};
  if (e.type === 'channel') {
    return {
      op: 'channel',
      channel: {
        source: 'portal', tenant, channelId: ch.id, name: ch.name, at: e.at, ...heard,
      },
    };
  }
  const a = e.author || {};
  const authorRef = a.kind === 'bot'
    ? {
      kind: 'bot', name: a.name || 'Enterprise Support', source: 'portal', tenant, botId: a.id,
    }
    : {
      source: 'portal',
      tenant,
      userId: a.id,
      name: a.name || null,
      email: a.email || null,
      avatar: portalAvatar(a),
      // An embedded account's verified address: one person's accounts are one by it, and only
      // that (src/lookup.js keeps it apart from `email`).
      ...(!a.email && a.verifiedEmail ? {
        mergeEmail: String(a.verifiedEmail).toLowerCase(),
        ...(a.verifiedAt ? { mergeAt: String(a.verifiedAt) } : {}),
      } : {}),
    };
  if (e.type === 'reaction') {
    const r = e.reaction || {};
    return {
      op: 'reaction',
      reaction: {
        removed: Boolean(r.removed),
        emoji: r.emoji,
        source: 'portal',
        tenant,
        channelId: ch.id,
        id: r.message,
        userId: a.id,
        at: r.at || e.at,
        // Who reacted, for the lookup: the event names them.
        userRef: a.kind === 'bot' ? undefined : authorRef,
      },
    };
  }
  if (e.type !== 'message' || !e.message) {
    return { op: 'skip', reason: e.type || 'unknown' };
  }
  const m = e.message;
  const files = m.deletedAt ? '' : portalFiles(m.files);
  // Who it mentions: the portal names them, so their accounts are known before they are asked for.
  const mentioned = (Array.isArray(m.mentions) ? m.mentions : []).filter((x) => x && x.id);
  const message = {
    source: 'portal',
    tenant,
    channelId: ch.id,
    channelHint,
    rootId: m.root || m.id,
    id: m.id,
    thread: `portal:${tenant}:${ch.id}:${m.root || m.id}`,
    at: m.at,
    editedAt: m.editedAt || undefined,
    // The message as it is now: the portal counts its changes (an edit, its deletion).
    version: String(Number(m.rev) || 0).padStart(9, '0'),
    authorRef,
    format: 'portal',
    ...heard,
    text: m.text || '',
    files: files ? `Attachments:\n${files}` : undefined,
    // No link to it: the portal is its customers', and nobody of the inbox can open it there.
    raw: key,
    mentionIds: mentioned.map((x) => x.id),
    mentionRefs: mentioned.filter((x) => x.kind !== 'bot' && (x.name || x.email)).map((x) => ({
      source: 'portal', tenant, userId: x.id, name: x.name || null, email: x.email || null,
    })),
  };
  if (m.deletedAt) {
    return { op: 'delete', message: { ...message, deletedAt: m.deletedAt, text: '' } };
  }
  return { op: 'upsert', message };
}

/**
 * Dispatches on the pile-1 key's source. `meta` is the object's custom metadata (`receivedAt`),
 * for what the event does not say itself.
 */
export function normalize(key, json, meta = {}) {
  const source = key.split('/')[0];
  if (source === 'slack' && json && json.type === 'file_info') {
    // A kept files.info answer (src/slackfiles.js), not an event.
    return { op: 'skip', reason: 'file info' };
  }
  if (source === 'slack') {
    return normalizeSlack(key, json);
  }
  if (source === 'teams') {
    return normalizeTeams(key, json, meta);
  }
  if (source === 'discord') {
    return normalizeDiscord(key, json);
  }
  if (source === 'portal') {
    return normalizePortal(key, json);
  }
  return { op: 'skip', reason: `unknown source ${source}` };
}
