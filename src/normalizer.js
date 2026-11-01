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
import { rethread, RETHREAD_DELAY_SECONDS } from './rethread.js';
import {
  getChannel, getIdentity, loadRules, toAuthor, updateChannelName,
} from './lookup.js';
import { discordApi } from './discord.js';
import {
  discordToMarkdown, htmlToMarkdown, quoteMarkdown, slackToMarkdown, withoutQuotes,
} from './markdown.js';
import { normalize, slackLinkIn } from './normalize.js';
import { withSlackFiles } from './slackfiles.js';
import { copyThreadFiles } from './threadfiles.js';
import { isTeamsFileKey, withTeamsFiles } from './teamsfiles.js';
import { refile } from './refile.js';
import { runCatchUp } from './catchup.js';
import { notifyRoom } from './notify.js';
import { signalFacts } from './resolve.js';
import { teamsOf } from './shares.js';
import { classify } from './rules.js';
import {
  advanceWatermark, applyReaction, findMessage, indexMessage, mentionedByName, recordMentions,
  previewOf, replaceReactions, titleOf,
} from './threads.js';

export { notifyRoom };

const messageKeyOf = (m) => `${m.source}:${m.tenant}:${m.channelId}:${m.id}`;

const MAX_MENTIONS = 20;

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

/** `{ author, person }`: the frontmatter author and the D1 person id, if known. */
async function resolveAuthor(env, ref) {
  if (!ref.userId) {
    const slackBot = ref.botId && ref.source !== 'teams';
    const name = ref.name || (slackBot ? await botName(env, ref) : null);
    return {
      author: {
        kind: ref.kind || 'bot', name: name || ref.botId || null, org: null, staff: false,
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
  const row = await env.DB.prepare('SELECT team, kind, source, channel_id FROM threads WHERE thread = ?')
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
  const text = message.text || '';
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
  return discordToMarkdown(text, {
    user: (id) => users.get(id),
    role: (id) => (discordRoles.get(message.tenant) || new Map()).get(id),
    channel: (id) => channels.get(id),
  });
}

async function toMarkdown(env, message) {
  if (message.format === 'html') {
    return htmlToMarkdown(message.text);
  }
  if (message.format === 'discord') {
    return discordMarkdown(env, message);
  }
  if (message.format !== 'mrkdwn') {
    return message.text;
  }
  const quotes = message.quotes || [];
  const mentioned = [message.text, ...quotes.map((q) => q.text)].join('\n');
  const ids = [...new Set([
    ...[...mentioned.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]),
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
    slackToMarkdown(message.text, name),
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
  // Slack Connect files arrive as stubs: what files.info says about them, kept in pile 1.
  // Teams files are copied into pile 1, and the images among them shown inline.
  const payload = await withSlackFiles(env, key, JSON.parse(await obj.text()));
  const op = normalize(key, await withTeamsFiles(env, key, payload));
  if (op.op === 'skip') {
    return { key, result: 'skip', reason: op.reason };
  }
  if (op.op === 'reaction') {
    return processReaction(env, key, op.reaction);
  }
  if (op.op === 'channel') {
    await updateChannelName(env, op.channel);
    return { key, result: 'channel' };
  }

  const { message } = op;
  if (!message.channelId || !message.id) {
    return { key, result: 'skip', reason: 'no channel or id' };
  }
  const channel = await getChannel(env, message);
  if (message.source === 'slack') {
    // The link opens in the channel's workspace, not the one the browser used last.
    message.permalink = slackLinkIn(channel.domain, message.permalink);
  }
  // eslint-disable-next-line no-param-reassign
  cache.rules = cache.rules || await loadRules(env);
  const cls = classify(cache.rules, channel);
  if (cls.kind === 'ignore') {
    return { key, result: 'ignored' };
  }
  // A channel's org and team each get a knowledge base when they are first seen (pile 3).
  await ensureChannelKnowledgeBases(env, cls, cache);

  const deleted = op.op === 'delete';
  const { author, person } = await resolveAuthor(env, message.authorRef);
  // Before it is indexed: an edit, an unfurl or a Teams reaction rewrites a message D1 already has.
  // Only people's messages: a bot's does not make a thread unread either (`counted`).
  const posted = Boolean(env.ROOMS) && !deleted && author.kind === 'person' && fresh(message)
    && !await findMessage(env.DB, message);
  if (!deleted) {
    await recordBots(env, message);
  }
  const meta = {
    source: message.source,
    thread: message.thread,
    id: message.id,
    at: message.at,
    author,
    subject: message.subject,
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    raw: [key],
    permalink: message.permalink,
  };
  const body = deleted ? '' : await toMarkdown(env, message);
  const path = channelPath({ ...message, org: cls.org, team: cls.team });
  const written = await writeMessage(env.CHANNELS, path, {
    meta, body, version: message.version, deleted,
  });

  await indexMessage(env.DB, {
    ...message,
    authorKey: (message.authorRef.userId || message.authorRef.botId)
      ? `${message.source}:${message.tenant}:${message.authorRef.userId || message.authorRef.botId}` : null,
    author: author.name,
    person,
    staff: author.staff,
    counted: author.kind === 'person',
    deleted,
    title: deleted ? null : titleOf(message.subject, body),
    preview: deleted ? null : previewOf(body),
    org: cls.org,
    team: cls.team,
    kind: cls.kind,
    channelName: channel.name,
    path: path.slice(0, path.lastIndexOf('/') + 1),
    // For the klickhaus export (src/clickhouse.js), which reads D1 only.
    authorKind: author.kind,
    edited: Boolean(message.editedAt),
    attachments: deleted ? 0 : attachmentsOf(body),
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
  if (written && !deleted && env.FILES && attachmentsOf(body)) {
    await env.NORMALIZE.send({ files: message.thread });
  }
  // A reply whose root we have never seen: fetch the thread's history once.
  if (message.id !== message.rootId && !deleted) {
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
  // A thread agent reads every new message of its thread (only in channels where it is on).
  const poke = written && !deleted && cls.kind === 'channel' && await agentEnabled(env, message.channelId, cls.team);
  // A new root may continue an earlier thread (a repeat alert, a follow-up). Its agent is
  // poked once that is decided, so it is the group's agent, not one of the root's own.
  if (message.id === message.rootId && !deleted && env.VECTORS && env.AI) {
    await env.NORMALIZE.send({ rethread: message.thread, ...(poke ? { poke: true } : {}) }, {
      delaySeconds: RETHREAD_DELAY_SECONDS,
    });
  } else if (poke) {
    await env.NORMALIZE.send({ agent: message.thread }, { delaySeconds: AGENT_DELAY_SECONDS });
  }
  if (cls.kind === 'channel' && author.kind === 'person' && env.AI) {
    await env.NORMALIZE.send({ label: message.thread }, { delaySeconds: LABEL_DELAY_SECONDS });
  }
  // Its vector, and the thread's; a deletion (whoever's) takes the message's vector away. The
  // full-text index (SEARCH) has the bots' messages too.
  const vectors = (author.kind === 'person' || deleted) && env.CONTENT && env.AI;
  if (cls.kind === 'channel' && (vectors || env.SEARCH)) {
    await env.NORMALIZE.send({ vectorize: message.thread }, {
      delaySeconds: VECTORIZE_DELAY_SECONDS,
    });
  }
  // Its row in klickhaus (src/clickhouse.js), after the label job; a burst exports once.
  if (written) {
    await queueExport(env, message.thread);
  }
  const rooms = env.ROOMS ? await teamsOf(env, {
    team: cls.team, source: message.source, channel_id: message.channelId,
  }) : [];
  // Who to notify (ui/inbox.js): the people a message just posted (not a backfill, a replay or a
  // catch-up long after) newly mentions, the people whose thread it is, and who wrote it.
  const mentions = written && fresh(message) ? mentioned : [];
  const involved = written && posted ? await involvedIn(env, message.thread) : [];
  await notifyRoom(env, rooms, {
    type: 'thread',
    thread: message.thread,
    ...(mentions.length || involved.length ? {
      mentions, involved, by: person, author: author.name, at: message.at,
    } : {}),
  });
  return {
    key, result: written ? op.op : 'unchanged', org: cls.org, team: cls.team, kind: cls.kind,
  };
}

/** An export job's key for the log: its thread, or the first of the sweep's and how many more. */
const exportKey = (keys) => {
  const all = [].concat(keys);
  return `export:${all[0]}${all.length > 1 ? ` +${all.length - 1}` : ''}`;
};

/** A job's last delivery: the queue retries it five times (`maxRetries`, cloudflare.config.ts). */
const LAST_ATTEMPT = 6;

/**
 * Queue consumer for NORMALIZE. Each message is acknowledged on its own; a failure is
 * retried by the queue, and after the last retry it goes to the dead-letter queue.
 */
export async function consume(batch, env) {
  const cache = {};
  for (const msg of batch.messages) {
    const body = msg.body || {};
    const key = body.key
      || (body.label && `label:${body.label}`)
      || (body.vectorize && `vectorize:${body.vectorize}`)
      || (body.export && exportKey(body.export))
      || (body.backfill && `backfill:${body.backfill.thread}`)
      || (body.rethread && `rethread:${body.rethread}`)
      || (body.agent && `agent:${body.agent}`)
      || (body.files && `files:${body.files}`)
      || (body.refile && `refile:${body.refile.source}:${body.refile.channelId}`)
      || (body.catchup && `catchup:${body.catchup.channelId}`);
    try {
      let r;
      if (body.backfill) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await runBackfill(env, body.backfill) };
      } else if (body.rethread) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await rethread(env, body.rethread, { force: Boolean(body.force) }) };
        // The group it joined (or pulled in) is exported again.
        // eslint-disable-next-line no-await-in-loop
        await queueExport(env, body.rethread);
        if (body.poke) {
          // eslint-disable-next-line no-await-in-loop
          await env.NORMALIZE.send({ agent: body.rethread });
        }
      } else if (body.catchup) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await runCatchUp(env, body.catchup) };
      } else if (body.refile) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await refile(env, body.refile) };
      } else if (body.files) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await copyThreadFiles(env, body.files) };
      } else if (body.agent) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await pokeAgent(env, body.agent) };
      } else if (body.label) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await labelThread(env, body.label) };
        if (r.result === 'labeled' || r.result === 'titled') {
          // eslint-disable-next-line no-await-in-loop
          await queueExport(env, body.label, { delaySeconds: 0 });
        }
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
      if (msg.attempts >= LAST_ATTEMPT) {
        // A root that cannot be re-threaded still gets its agent, before the job is given up.
        if (body.rethread && body.poke) {
          // eslint-disable-next-line no-await-in-loop
          await env.NORMALIZE.send({ agent: body.rethread }).catch(() => {});
        }
        // eslint-disable-next-line no-await-in-loop
        await recordDead(env, key, body, e.message);
      }
      msg.retry({ delaySeconds: limited ? 60 + Math.floor(Math.random() * 240) : 30 });
    }
  }
}
