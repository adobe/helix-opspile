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

import { agentEnabled } from './agent/enabled.js';
import { AGENT_DELAY_SECONDS, pokeAgent } from './agent/stub.js';
import { recordDead } from './deadjobs.js';
import { requestBackfill, runBackfill } from './backfill.js';
import { channelPath, writeMessage } from './channels.js';
import { attachmentsOf, exportThreads, queueExport } from './clickhouse.js';
import { ensureChannelKnowledgeBases } from './kb.js';
import { LABEL_DELAY_SECONDS, labelThread } from './label.js';
import { VECTORIZE_DELAY_SECONDS, vectorizeThread } from './vectors.js';
import { linkThread } from './threadlinks.js';
import { dethread, rethread, RETHREAD_DELAY_SECONDS } from './rethread.js';
import {
  botIdentity, getChannel, getIdentity, loadRules, toAuthor, updateChannelName,
} from './lookup.js';
import { discordApi } from './discord.js';
import { quoteMarkdown, withoutQuotes } from './markdown.js';
import { discordToMarkdown, discordTokens } from './discordmd.js';
import {
  blockUsers, slackBlocksToMarkdown, slackLabels, slackToMarkdown,
} from './slackmd.js';
import { htmlDropped, htmlToMarkdown } from './html.js';
import {
  isChannelNotice, normalize, slackLinkIn, teamsEventText, teamsEventUsers,
} from './normalize.js';
import { withSlackFiles } from './slackfiles.js';
import { copyThreadFiles } from './threadfiles.js';
import { isTeamsFileKey, withTeamsFiles } from './teamsfiles.js';
import { followChange, refile } from './refile.js';
import { runCatchUp } from './catchup.js';
import { IMPORT_VIA, runImport } from './history.js';
import { notifyRoom } from './notify.js';
import { signalFacts } from './resolve.js';
import { teamsOf } from './shares.js';
import { portalMarkdown } from './portalsource.js';
import { recordLobby } from './portalrequests.js';
import { teamsFollowing } from './follows.js';
import { classify } from './rules.js';
import { threadKind } from './alertbots.js';
import { isWatched, WATCH_DELAY_SECONDS } from './agent/watches.js';
import { notifyWatched } from './watches.js';
import {
  advanceWatermark, applyReaction, findMessage, indexMessage, mentionedByName, recordMentions,
  previewOf, replaceReactions, titleOf,
} from './threads.js';

export { notifyRoom };

/**
 * A thread whose label gained or lost technologies (`tech`, src/label.js) or areas: the open
 * inboxes of the teams that follow one of them, and of the people who do (in the rooms of its
 * teams), list it again, so a thread that now shows a technology they follow comes in, and one
 * that no longer does goes. Best effort, as every room's.
 */
async function announceFollowed(env, key, tech, areas) {
  if (!env.ROOMS) {
    return;
  }
  const changed = tech ? [...tech.gained, ...tech.lost] : [];
  const moved = areas ? [...areas.gained, ...areas.lost] : [];
  const row = await env.DB.prepare('SELECT thread, team, source, channel_id FROM threads WHERE thread = ?')
    .bind(key).first();
  const [teams, following] = await Promise.all([
    row ? teamsOf(env, row) : [],
    teamsFollowing(env, changed, moved),
  ]);
  const rooms = [...new Set([...teams, ...following])];
  if (rooms.length) {
    await notifyRoom(env, rooms, {
      type: 'thread', thread: key, tech: changed, ...(moved.length ? { areas: moved } : {}),
    });
  }
}

const messageKeyOf = (m) => `${m.source}:${m.tenant}:${m.channelId}:${m.id}`;

const MAX_MENTIONS = 20;
/** The people of a customer portal lobby who get an account with each of its events. */
const MAX_LOBBY_ACCOUNTS = 50;

/** A Slack bot's name (bots.info), cached in `identities` like a user. */
async function botName(env, ref) {
  const cached = await env.DB.prepare(`SELECT name FROM identities
    WHERE source = 'slack' AND tenant = ? AND user_id = ?`).bind(ref.tenant, ref.botId).first();
  if (cached && cached.name) {
    return cached.name;
  }
  try {
    const params = new URLSearchParams({
      bot: ref.botId, ...(ref.teamId ? { team_id: ref.teamId } : {}),
    });
    const res = await fetch(`https://slack.com/api/bots.info?${params}`, {
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const data = await res.json();
    const name = data.ok && data.bot ? data.bot.name : null;
    if (!data.ok) {
      console.warn(JSON.stringify({ route: 'normalize', lookup: 'bot', error: data.error }));
    }
    if (name) {
      const icon = (data.bot.icons && (data.bot.icons.image_72 || data.bot.icons.image_48)) || '';
      await env.DB.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, fetched_at, avatar)
        VALUES ('slack', ?, ?, 'bot', ?, ?, ?) ON CONFLICT (source, tenant, user_id) DO UPDATE SET
        name = excluded.name, avatar = excluded.avatar, fetched_at = excluded.fetched_at`)
        .bind(ref.tenant, ref.botId, name, new Date().toISOString(), icon).run();
    }
    return name;
  } catch {
    return null;
  }
}

/**
 * `{ author, person }`: the frontmatter author and the D1 person id, if known. A bot with a bot
 * id (`message`'s platform and tenant, as its author key) is staff when an admin said it is
 * Adobe's (`ours`, src/lookup.js botIdentity), and goes by the name an admin gave it.
 */
async function resolveAuthor(env, ref, message = {}) {
  if (!ref.userId) {
    const slackBot = ref.botId && ref.source !== 'teams';
    const name = ref.name || (slackBot ? await botName(env, ref) : null);
    const kind = ref.kind || 'bot';
    const bot = ref.botId && kind === 'bot' && message.source && message.tenant
      ? await botIdentity(env, {
        source: message.source, tenant: message.tenant, botId: ref.botId, name, avatar: ref.avatar,
      })
      : null;
    return {
      author: {
        kind,
        name: (bot && bot.display_name) || name || ref.botId || null,
        org: null,
        staff: Boolean(bot) && toAuthor(env, bot).staff,
      },
      person: null,
    };
  }
  const identity = await getIdentity(env, ref);
  return { author: toAuthor(env, identity), person: identity.person || null };
}

async function personOf(env, source, tenant, userId) {
  if (!userId) {
    return null;
  }
  const identity = await getIdentity(env, { source, tenant, userId });
  return identity.person || null;
}

/**
 * Records one reaction (a Slack reaction event, or a reaction made in the inbox): the
 * reaction itself, the reactor's watermark, and a live update for the team.
 */
export async function processReaction(env, key, r) {
  const msg = await findMessage(env.DB, r);
  if (!msg) {
    return { key, result: 'skip', reason: 'reaction to an unknown message' };
  }
  await applyReaction(env.DB, {
    thread: msg.thread,
    message: messageKeyOf(r),
    emoji: r.emoji,
    userKey: `${r.source}:${r.tenant}:${r.userId}`,
    at: r.at,
    removed: r.removed,
  });
  const row = await env.DB.prepare('SELECT thread, team, kind, source, channel_id FROM threads WHERE thread = ?')
    .bind(msg.thread).first();
  // Every team whose inbox has the thread: a shared channel's too.
  const rooms = env.ROOMS ? await teamsOf(env, row) : [];
  const person = r.removed ? null : await personOf(env, r.source, r.tenant, r.userId);
  if (person) {
    await advanceWatermark(env.DB, person, msg.thread, msg.at, 'react');
    await notifyRoom(env, rooms, {
      type: 'read', person, thread: msg.thread, at: msg.at,
    });
  }
  await notifyRoom(env, rooms, { type: 'thread', thread: msg.thread });
  // The models see reactions (a customer's ✅ confirms a fix): label the thread again.
  if (row && row.kind === 'channel' && env.AI && env.NORMALIZE) {
    await env.NORMALIZE.send({ label: msg.thread }, { delaySeconds: LABEL_DELAY_SECONDS });
  }
  // The export carries reaction counts and the ✅ (src/clickhouse.js).
  await queueExport(env, msg.thread);
  return { key, result: r.removed ? 'reaction-removed' : 'reaction' };
}

/** Role names per guild, per isolate, for `<@&id>` mentions. */
const discordRoles = new Map();

async function discordMarkdown(env, message) {
  const text = [message.text, message.after].filter(Boolean).join('\n\n');
  const users = new Map();
  for (const id of [...new Set([...text.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]))].slice(0, MAX_MENTIONS)) {
    // eslint-disable-next-line no-await-in-loop
    const identity = await getIdentity(env, { source: 'discord', tenant: message.tenant, userId: id });
    users.set(id, identity.person_name || identity.name);
  }
  if (/<@&\d+>/.test(text) && !discordRoles.has(message.tenant)) {
    try {
      const roles = await discordApi(env, `/guilds/${message.tenant}/roles`);
      discordRoles.set(message.tenant, new Map(roles.map((r) => [r.id, r.name])));
    } catch {
      discordRoles.set(message.tenant, new Map());
    }
  }
  const channels = new Map();
  for (const id of [...new Set([...text.matchAll(/<#(\d+)>/g)].map((m) => m[1]))].slice(0, MAX_MENTIONS)) {
    // eslint-disable-next-line no-await-in-loop
    const row = await env.DB.prepare(`SELECT name FROM channels
      WHERE source = 'discord' AND tenant = ? AND channel_id = ?`).bind(message.tenant, id).first();
    channels.set(id, row && row.name);
  }
  const names = {
    user: (id) => users.get(id),
    role: (id) => (discordRoles.get(message.tenant) || new Map()).get(id),
    channel: (id) => channels.get(id),
  };
  // The embeds and files after the text are markdown already, with Discord's tokens.
  return [discordToMarkdown(message.text, names), discordTokens(message.after, names)]
    .filter(Boolean).join('\n\n');
}

/**
 * A Teams system notice in words, with the names of the people it names: Graph sends their ids,
 * often without names.
 */
export async function teamsEventMarkdown(env, message) {
  const found = new Map();
  for (const u of teamsEventUsers(message.event).slice(0, MAX_MENTIONS)) {
    // Someone who posted is known already: a replay asks Graph nothing, and a stale identity
    // is not looked up again here, where a failed lookup would forget its name.
    // eslint-disable-next-line no-await-in-loop
    const cached = await env.DB.prepare(`SELECT COALESCE(p.name, i.name) AS name FROM identities i
      LEFT JOIN people p ON p.id = i.person
      WHERE i.source = 'teams' AND i.tenant = ? AND i.user_id = ?`).bind(message.tenant, u.id).first();
    // eslint-disable-next-line no-await-in-loop
    const identity = cached && cached.name ? { name: cached.name } : await getIdentity(env, {
      source: 'teams', tenant: message.tenant, userId: u.id, name: u.displayName, home: u.tenantId,
    });
    const known = identity.person_name || identity.name;
    // A failed lookup names the user by their id.
    found.set(u.id, known && known !== u.id ? known : u.displayName);
  }
  return teamsEventText(message.event, (u) => found.get(u.id) || u.displayName);
}

async function toMarkdown(env, message) {
  if (message.format === 'teams-event') {
    return teamsEventMarkdown(env, message);
  }
  if (message.format === 'html') {
    return htmlToMarkdown(message.text);
  }
  if (message.format === 'discord') {
    return discordMarkdown(env, message);
  }
  if (message.format === 'portal') {
    return [portalMarkdown(message.text), message.files].filter(Boolean).join('\n\n');
  }
  if (message.format !== 'mrkdwn') {
    return message.text;
  }
  const quotes = message.quotes || [];
  const mentioned = [message.text, ...quotes.map((q) => q.text)].join('\n');
  const ids = [...new Set([
    ...[...mentioned.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]),
    ...blockUsers(message.blocks),
    ...quotes.map((q) => q.authorId).filter(Boolean),
  ])].slice(0, MAX_MENTIONS);
  const names = new Map();
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const identity = await getIdentity(env, { source: 'slack', tenant: message.tenant, userId: id });
    names.set(id, identity.person_name || identity.name);
  }
  const name = (id) => names.get(id);
  // A quoted message goes below the text, as Slack shows it, and above the files.
  return [
    slackBlocksToMarkdown(message.blocks, { user: name, ...slackLabels(message.text) })
      || slackToMarkdown(message.text, name),
    ...quotes.map((q) => quoteMarkdown({
      author: (q.authorId && name(q.authorId)) || q.author,
      url: q.url,
      at: q.at,
      text: slackToMarkdown(q.text, name),
    })),
    message.files,
  ].filter(Boolean).join('\n\n');
}

/** Team members of any team, for mentions by name (loaded once per batch). */
async function teamPeople(env, cache) {
  if (!cache.people) {
    const { results } = await env.DB.prepare(`SELECT DISTINCT p.id, p.name FROM people p
      JOIN team_members m ON m.person = p.id`).all();
    // eslint-disable-next-line no-param-reassign
    cache.people = results || [];
  }
  return cache.people;
}

/** Who a message mentions: platform mentions first, then full names in the text. */
async function mentionsOf(env, message, body, author, cache) {
  const found = new Map();
  for (const userId of (message.mentionIds || []).slice(0, MAX_MENTIONS)) {
    // eslint-disable-next-line no-await-in-loop
    const person = await personOf(env, message.source, message.tenant, userId);
    if (person) {
      found.set(person, 'id');
    }
  }
  for (const p of mentionedByName(withoutQuotes(body), await teamPeople(env, cache))) {
    if (!found.has(p.id)) {
      found.set(p.id, 'name');
    }
  }
  found.delete(author);
  return [...found].map(([person, via]) => ({ person, via }));
}

/**
 * The Teams bots a message shows (its bot author, the bots it mentions): each gets an
 * identity (`kind: bot`; the name it posts under, and the `handle` people mention it by)
 * and a row in `bot_teams` for the message's Teams team, so replies there can mention it.
 */
export async function recordBots(env, message) {
  if (message.source !== 'teams' || !message.groupId) {
    return;
  }
  const ref = message.authorRef || {};
  const bots = [
    ...(ref.botId ? [{ id: ref.botId, name: ref.name || null, handle: null }] : []),
    ...(message.botMentions || []).slice(0, MAX_MENTIONS)
      .map((b) => ({ id: b.id, name: null, handle: b.name || null })),
  ];
  const now = new Date().toISOString();
  for (const b of bots) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, handle,
        fetched_at) VALUES ('teams', ?, ?, 'bot', ?, ?, ?)
      ON CONFLICT (source, tenant, user_id) DO UPDATE SET
        name = COALESCE(excluded.name, identities.name),
        handle = COALESCE(excluded.handle, identities.handle)`)
      .bind(message.tenant, b.id, b.name, b.handle, now).run();
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare(`INSERT INTO bot_teams (source, tenant, bot_id, group_id, at)
        VALUES ('teams', ?, ?, ?, ?)
      ON CONFLICT (source, tenant, bot_id, group_id) DO UPDATE SET
        at = MAX(bot_teams.at, excluded.at)`)
      .bind(message.tenant, b.id, message.groupId, message.at).run();
  }
}

/** Mentions in a message older than this are not announced to whoever they mention. */
export const NOTIFY_WITHIN_MS = 60 * 60 * 1000;
const fresh = (message, now = Date.now()) => {
  const at = Date.parse(message.editedAt || message.at);
  return Number.isFinite(at) && now - at < NOTIFY_WITHIN_MS;
};

/**
 * The people whose thread this is, as the inbox sees it (`mine` in ui/inbox.js): who posted in
 * it, was mentioned in it or put 👀 on it, in any thread of its group.
 */
async function involvedIn(env, thread) {
  const { results } = await env.DB.prepare(`WITH g AS (
      SELECT COALESCE(logical_thread, thread) AS k FROM threads WHERE thread = ?)
    SELECT t.thread FROM threads t, g WHERE t.thread = g.k OR t.logical_thread = g.k`)
    .bind(thread).all();
  const keys = (results || []).map((r) => r.thread);
  const list = JSON.stringify(keys);
  const [{ results: people }, signals] = await Promise.all([
    env.DB.prepare(`SELECT person FROM messages WHERE thread IN (SELECT value FROM json_each(?))
        AND person IS NOT NULL AND deleted = 0 AND counted = 1
      UNION SELECT person FROM mentions WHERE thread IN (SELECT value FROM json_each(?))`)
      .bind(list, list).all(),
    signalFacts(env, keys),
  ]);
  const seen = [...signals.values()].flat()
    .filter((s) => s.signal === 'seen' && s.staff && s.person).map((s) => s.person);
  return [...new Set([...(people || []).map((r) => r.person), ...seen])];
}

/**
 * Turns one pile-1 object into its pile-2 file. Returns a short result for the log.
 *
 * @param {object} env bindings
 * @param {string} key pile-1 key
 * @param {{ rules?: object[] }} cache shared across one queue batch
 */
export async function processKey(env, key, cache = {}) {
  if (isTeamsFileKey(key)) {
    // A Teams file's bytes kept in pile 1 (src/teamsfiles.js), not an event.
    return { key, result: 'skip', reason: 'file' };
  }
  const obj = await env.RAW.get(key);
  if (!obj) {
    return { key, result: 'missing' };
  }
  // The history import's (src/history.js): a thread that was over before the inbox began. It is
  // filed and indexed like any, but wakes nobody: no agent, label, vectors, full-text items,
  // file copies, export job (the cron's sweep exports it) or announcement.
  const imported = Boolean(obj.customMetadata && obj.customMetadata.via === IMPORT_VIA);
  // Slack Connect files arrive as stubs: what files.info says about them, kept in pile 1.
  // Teams files are copied into pile 1, and the images among them shown inline.
  const payload = await withSlackFiles(env, key, JSON.parse(await obj.text()));
  const op = normalize(key, await withTeamsFiles(env, key, payload), obj.customMetadata || {});
  if (op.op === 'skip') {
    return { key, result: 'skip', reason: op.reason };
  }
  if (op.op === 'lobby') {
    // A customer portal lobby as it is now: the request the admin pages show. Its people are
    // accounts from then on, so a reply from the inbox can mention one who has not written yet.
    const recorded = await recordLobby(env, op.lobby);
    if (recorded.result === 'lobby') {
      for (const m of (op.lobby.members || []).slice(0, MAX_LOBBY_ACCOUNTS)) {
        if (m && m.id && m.joined && (m.name || m.email)) {
          // eslint-disable-next-line no-await-in-loop
          await getIdentity(env, {
            source: 'portal', tenant: op.lobby.domain, userId: m.id, name: m.name, email: m.email,
          });
        }
      }
    }
    return { key, ...recorded };
  }
  if (op.op === 'reaction') {
    if (op.reaction.userRef) {
      // The portal's event names who reacted: their account is known before it is looked up.
      await getIdentity(env, op.reaction.userRef);
    }
    return processReaction(env, key, op.reaction);
  }
  if (op.op === 'channel') {
    let jobs = 0;
    await updateChannelName(env, op.channel, undefined, {
      onChange: async (before, after) => {
        // eslint-disable-next-line no-param-reassign
        cache.rules = cache.rules || await loadRules(env);
        jobs = await followChange(env, op.channel, { before, after }, cache.rules);
      },
    });
    return { key, result: 'channel', ...(jobs ? { refile: jobs } : {}) };
  }

  const { message } = op;
  if (!message.channelId || !message.id) {
    return { key, result: 'skip', reason: 'no channel or id' };
  }
  // eslint-disable-next-line no-param-reassign
  cache.rules = cache.rules || await loadRules(env);
  const lookup = { ...message, refresh: isChannelNotice(message) };
  const channel = await getChannel(env, lookup, undefined, {
    // The lookup found the channel renamed: its threads follow, from where they are now, before
    // this message is filed where the rules say now.
    onChange: (before, after) => followChange(env, message, { before, after }, cache.rules),
  });
  if (message.source === 'slack') {
    // The link opens in the channel's workspace, not the one the browser used last.
    message.permalink = slackLinkIn(channel.domain, message.permalink);
  }
  const cls = classify(cache.rules, channel);
  env.meter?.attribute({ org: cls.org, team: cls.team });
  if (cls.kind === 'ignore') {
    return { key, result: 'ignored' };
  }
  // A channel's org and team each get a knowledge base when they are first seen (pile 3).
  await ensureChannelKnowledgeBases(env, cls, cache);

  const deleted = op.op === 'delete';
  const { author, person } = await resolveAuthor(env, message.authorRef, message);
  // The portal names whom a message mentions: their accounts, before they are looked up.
  for (const ref of (message.mentionRefs || []).slice(0, MAX_MENTIONS)) {
    // eslint-disable-next-line no-await-in-loop
    await getIdentity(env, ref);
  }
  // Before it is indexed: an edit, an unfurl or a Teams reaction rewrites a message D1 already has.
  // Only people's messages: a bot's does not make a thread unread either (`counted`).
  const posted = Boolean(env.ROOMS) && !deleted && author.kind === 'person' && fresh(message)
    && !await findMessage(env.DB, message);
  if (!deleted) {
    await recordBots(env, message);
  }
  // What the platform showed that the markdown cannot (src/html.js): the agent's raw_message
  // shows the message as it was sent.
  const dropped = !deleted && message.format === 'html' ? htmlDropped(message.text) : [];
  const meta = {
    source: message.source,
    thread: message.thread,
    id: message.id,
    at: message.at,
    author,
    subject: message.subject,
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    dropped: dropped.length ? dropped : undefined,
    raw: [key],
    permalink: message.permalink,
  };
  const authorKey = (message.authorRef.userId || message.authorRef.botId)
    ? `${message.source}:${message.tenant}:${message.authorRef.userId || message.authorRef.botId}` : null;
  // The thread's kind: the channel's, but an alert where a bot that only posts alerts started it
  // (src/alertbots.js). Everything below goes by it, not by the channel's.
  const kind = await threadKind(env, cls.kind, message, authorKey, cache);
  const body = deleted ? '' : await toMarkdown(env, message);
  const path = channelPath({ ...message, org: cls.org, team: cls.team });
  const written = await writeMessage(env.CHANNELS, path, {
    meta, body, version: message.version, deleted,
  });

  await indexMessage(env.DB, {
    ...message,
    authorKey,
    author: author.name,
    person,
    staff: author.staff,
    counted: author.kind === 'person',
    deleted,
    title: deleted ? null : titleOf(message.subject, body),
    preview: deleted ? null : previewOf(body),
    org: cls.org,
    team: cls.team,
    kind,
    channelName: channel.name,
    path: path.slice(0, path.lastIndexOf('/') + 1),
    // For the klickhaus export (src/clickhouse.js), which reads D1 only.
    authorKind: author.kind,
    edited: Boolean(message.editedAt),
    attachments: deleted ? 0 : attachmentsOf(body),
    imported,
  });
  if (message.reactions) {
    await replaceReactions(
      env.DB,
      { thread: message.thread, message: messageKeyOf(message) },
      message.reactions.map((r) => ({
        emoji: r.emoji, userKey: `${message.source}:${message.tenant}:${r.userId}`, at: r.at,
      })),
    );
  }
  for (const userId of message.reactors || []) {
    // eslint-disable-next-line no-await-in-loop
    const reactor = await personOf(env, message.source, message.tenant, userId);
    // eslint-disable-next-line no-await-in-loop
    await advanceWatermark(env.DB, reactor, message.thread, message.at, 'react');
  }
  const mentioned = await recordMentions(env.DB, {
    thread: message.thread,
    message: messageKeyOf(message),
    at: message.at,
  }, deleted ? [] : await mentionsOf(env, message, body, person, cache));

  // The message's files, copied for the agents (src/threadfiles.js), in a job of their own.
  if (written && !deleted && !imported && env.FILES && attachmentsOf(body)) {
    await env.NORMALIZE.send({ files: message.thread });
  }
  // A reply whose root we have never seen: fetch the thread's history once. The import has the
  // whole thread already, its root perhaps a moment behind.
  if (message.id !== message.rootId && !deleted && !imported) {
    const root = await findMessage(env.DB, { ...message, id: message.rootId });
    if (!root) {
      await requestBackfill(env, {
        source: message.source,
        tenant: message.tenant,
        channelId: message.channelId,
        groupId: message.groupId,
        rootId: message.rootId,
        thread: message.thread,
      });
    }
  }
  // A person's reply in the platform thread of a root that was folded into another conversation:
  // it is a conversation of its own now (src/rethread.js dethread), before its agent is poked and
  // the inboxes hear of the message. The group it left is exported again; this one is below.
  if (message.id !== message.rootId && !deleted && !imported && kind === 'channel'
    && author.kind === 'person') {
    const split = await dethread(env, message.thread);
    if (split.group) {
      await queueExport(env, [split.group, ...split.split]);
    }
  }
  // A thread agent reads every new message of its thread (only in channels where it is on).
  const poke = written && !deleted && !imported && kind === 'channel'
    && await agentEnabled(env, message.channelId, cls.team);
  // A new root may continue an earlier thread (a repeat alert, a follow-up). Its agent is
  // poked once that is decided, so it is the group's agent, not one of the root's own.
  if (message.id === message.rootId && !deleted && !imported && env.VECTORS && env.AI) {
    await env.NORMALIZE.send({ rethread: message.thread, ...(poke ? { poke: true } : {}) }, {
      delaySeconds: RETHREAD_DELAY_SECONDS,
    });
  } else if (poke) {
    await env.NORMALIZE.send({ agent: message.thread }, { delaySeconds: AGENT_DELAY_SECONDS });
  }
  if (kind === 'channel' && author.kind === 'person' && !imported && env.AI) {
    await env.NORMALIZE.send({ label: message.thread }, { delaySeconds: LABEL_DELAY_SECONDS });
  }
  // A thread agent watches this thread (src/agent/watches.js): it hears of a burst of new
  // messages once, a minute after the first.
  if (written && !deleted && !imported && !message.editedAt && kind !== 'ignore'
    && await isWatched(env, message.thread, author)) {
    await env.NORMALIZE.send({ watched: message.thread }, { delaySeconds: WATCH_DELAY_SECONDS });
  }
  // Its vector, and the thread's; a deletion (whoever's) takes the message's vector away. The
  // full-text index (SEARCH) has the bots' messages too.
  const vectors = (author.kind === 'person' || deleted) && env.CONTENT && env.AI;
  if (kind === 'channel' && !imported && (vectors || env.SEARCH)) {
    await env.NORMALIZE.send({ vectorize: message.thread }, {
      delaySeconds: VECTORIZE_DELAY_SECONDS,
    });
  }
  // Its row in klickhaus (src/clickhouse.js), after the label job; a burst exports once.
  if (written && !imported) {
    await queueExport(env, message.thread);
  }
  // An import is tens of thousands of messages: announced, every open inbox would reload with each.
  const rooms = env.ROOMS && !imported ? await teamsOf(env, {
    team: cls.team, source: message.source, channel_id: message.channelId, thread: message.thread,
  }) : [];
  // Who to notify (ui/inbox.js): the people a message just posted (not a backfill, a replay or a
  // catch-up long after) newly mentions, the people whose thread it is, and who wrote it.
  const mentions = written && fresh(message) ? mentioned : [];
  const involved = written && posted ? await involvedIn(env, message.thread) : [];
  await notifyRoom(env, rooms, {
    type: 'thread',
    thread: message.thread,
    // An alert's (a bot's post in an alert channel): an inbox that does not list alerts need not
    // reload at once for it (ui/inbox.js `reloadSoon`). Most of what is announced is alerts.
    ...(kind === 'alert' ? { alert: true } : {}),
    ...(mentions.length || involved.length ? {
      mentions, involved, by: person, author: author.name, at: message.at,
    } : {}),
  });
  return {
    key, result: written ? op.op : 'unchanged', org: cls.org, team: cls.team, kind,
  };
}

/** Whom a queue job works for: its thread, where it names one (src/cogs/meter.js). */
export function jobSubject(body) {
  const thread = body.label || body.vectorize || body.rethread || body.agent || body.files
    || body.watched || body.link
    || (body.backfill && body.backfill.thread)
    || (body.export && [].concat(body.export).length === 1 && [].concat(body.export)[0]);
  return typeof thread === 'string' ? { thread } : {};
}

/** An export job's key for the log: its thread, or the first of the sweep's and how many more. */
const exportKey = (keys) => {
  const all = [].concat(keys);
  return `export:${all[0]}${all.length > 1 ? ` +${all.length - 1}` : ''}`;
};

/** A job's last delivery: the queue retries it five times (`maxRetries`, cloudflare.config.ts). */
const LAST_ATTEMPT = 6;
/**
 * A thread's link job after its label: by then its vector is written too (both wait
 * LABEL_DELAY_SECONDS and VECTORIZE_DELAY_SECONDS after its latest message).
 */
export const LINK_DELAY_SECONDS = 60;

/**
 * Queue consumer for NORMALIZE. Each message is acknowledged on its own; a failure is
 * retried by the queue, and after the last retry it goes to the dead-letter queue.
 */
export async function consume(batch, baseEnv, meter = null) {
  const cache = {};
  const share = 1 / Math.max(1, batch.messages.length);
  for (const msg of batch.messages) {
    const body = msg.body || {};
    // Counted for the job's thread (src/cogs/meter.js); a raw event names its customer once it
    // is filed (processKey). One invocation is one Workers request, shared by its messages.
    const env = meter ? meter.env(jobSubject(body)) : baseEnv;
    env.meter?.add('workers', 'requests', '', share);
    const key = body.key
      || (body.label && `label:${body.label}`)
      || (body.vectorize && `vectorize:${body.vectorize}`)
      || (body.export && exportKey(body.export))
      || (body.backfill && `backfill:${body.backfill.thread}`)
      || (body.rethread && `rethread:${body.rethread}`)
      || (body.agent && `agent:${body.agent}`)
      || (body.watched && `watched:${body.watched}`)
      || (body.link && `link:${body.link}`)
      || (body.files && `files:${body.files}`)
      || (body.refile && `refile:${body.refile.source}:${body.refile.channelId}`)
      || (body.catchup && `catchup:${body.catchup.channelId}`)
      || (body.import && `import:${body.import.source}:${body.import.channelId}`);
    try {
      let r;
      if (body.backfill) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await runBackfill(env, body.backfill) };
      } else if (body.rethread) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await rethread(env, body.rethread, { force: Boolean(body.force) }) };
        // The group it joined (or pulled in) is exported again, or the one a split it finished
        // left, with the roots it took.
        // eslint-disable-next-line no-await-in-loop
        await queueExport(env, r.split ? [r.group, ...r.split] : body.rethread);
        if (body.poke) {
          // eslint-disable-next-line no-await-in-loop
          await env.NORMALIZE.send({ agent: body.rethread });
        }
      } else if (body.catchup) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await runCatchUp(env, body.catchup) };
      } else if (body.import) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await runImport(env, body.import) };
      } else if (body.refile) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await refile(env, body.refile) };
      } else if (body.files) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await copyThreadFiles(env, body.files) };
      } else if (body.watched) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await notifyWatched(env, body.watched) };
      } else if (body.agent) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await pokeAgent(env, body.agent, { retry: msg.attempts < LAST_ATTEMPT }) };
      } else if (body.label) {
        const force = Boolean(body.force);
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await labelThread(env, body.label, new Date(), { force }) };
        if (r.result === 'labeled' || r.result === 'titled') {
          // eslint-disable-next-line no-await-in-loop
          await queueExport(env, body.label, { delaySeconds: 0 });
        }
        // Its links to a partner's or customers' threads (src/threadlinks.js), once its vector is
        // written too; not an imported thread's (nobody works those).
        if (r.result === 'labeled' && !r.imported) {
          // eslint-disable-next-line no-await-in-loop
          await env.NORMALIZE.send({ link: body.label }, { delaySeconds: LINK_DELAY_SECONDS });
        }
        // An imported thread's first label is no news: thousands of them, labeled when asked
        // for (scripts/replay.mjs --imported), would reload every inbox that follows what they
        // show with each.
        if ((r.tech || r.areas) && !r.imported) {
          // eslint-disable-next-line no-await-in-loop
          await announceFollowed(env, body.label, r.tech, r.areas);
        }
      } else if (body.link) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await linkThread(env, body.link) };
      } else if (body.export) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await exportThreads(env, body.export, { at: body.at || null }) };
      } else if (body.vectorize) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await vectorizeThread(env, body.vectorize) };
      } else {
        // eslint-disable-next-line no-await-in-loop
        r = await processKey(env, key, cache);
      }
      console.log(JSON.stringify({ route: 'normalize', ...r }));
      msg.ack();
    } catch (e) {
      console.error(JSON.stringify({ route: 'normalize', key, error: e.message }));
      // Rate limits (Vectorize, Workers AI) back off longer and spread out.
      const limited = /Too Many Requests|429|rate.?limit/i.test(e.message);
      // A root that cannot be re-threaded still gets its agent, before the job is given up.
      if (body.rethread && body.poke && msg.attempts >= LAST_ATTEMPT) {
        // eslint-disable-next-line no-await-in-loop
        await env.NORMALIZE.send({ agent: body.rethread }).catch(() => {});
      }
      msg.retry({ delaySeconds: limited ? 60 + Math.floor(Math.random() * 240) : 30 });

      if (msg.attempts >= LAST_ATTEMPT) {
        // eslint-disable-next-line no-await-in-loop
        await recordDead(env, key, body, e.message);
      }
    }
  }
}
