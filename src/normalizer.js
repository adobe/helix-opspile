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

import { requestBackfill, runBackfill } from './backfill.js';
import { channelPath, writeMessage } from './channels.js';
import { LABEL_DELAY_SECONDS, labelThread } from './label.js';
import { rethread } from './rethread.js';
import {
  getChannel, getIdentity, loadRules, toAuthor, updateChannelName,
} from './lookup.js';
import { htmlToMarkdown, slackToMarkdown } from './markdown.js';
import { normalize } from './normalize.js';
import { classify } from './rules.js';
import {
  advanceWatermark, applyReaction, findMessage, indexMessage, mentionedByName, recordMentions,
  replaceReactions, titleOf,
} from './threads.js';

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
    const res = await fetch(`https://slack.com/api/bots.info?bot=${encodeURIComponent(ref.botId)}`, {
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const data = await res.json();
    const name = data.ok && data.bot ? data.bot.name : null;
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
    const name = ref.name || (ref.botId ? await botName(env, ref) : null);
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

/**
 * Tells the team's room (a Durable Object) about a change, so connected inboxes update.
 * Best effort: the index in D1 is the record, the room only fans out.
 */
export async function notifyRoom(env, team, event) {
  if (!env.ROOMS || !team) {
    return;
  }
  try {
    const room = env.ROOMS.get(env.ROOMS.idFromName(team));
    await room.fetch('https://room/notify', { method: 'POST', body: JSON.stringify(event) });
  } catch (e) {
    console.warn(JSON.stringify({ route: 'normalize', room: team, error: e.message }));
  }
}

async function personOf(env, source, tenant, userId) {
  if (!userId) {
    return null;
  }
  const identity = await getIdentity(env, { source, tenant, userId });
  return identity.person || null;
}

async function processReaction(env, key, r) {
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
  const row = await env.DB.prepare('SELECT team FROM threads WHERE thread = ?').bind(msg.thread).first();
  const person = r.removed ? null : await personOf(env, r.source, r.tenant, r.userId);
  if (person) {
    await advanceWatermark(env.DB, person, msg.thread, msg.at, 'react');
    await notifyRoom(env, row && row.team, {
      type: 'read', person, thread: msg.thread, at: msg.at,
    });
  }
  await notifyRoom(env, row && row.team, { type: 'thread', thread: msg.thread });
  return { key, result: r.removed ? 'reaction-removed' : 'reaction' };
}

async function toMarkdown(env, message) {
  if (message.format === 'html') {
    return htmlToMarkdown(message.text);
  }
  if (message.format !== 'mrkdwn') {
    return message.text;
  }
  const ids = [...new Set([...message.text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)]
    .map((m) => m[1]))].slice(0, MAX_MENTIONS);
  const names = new Map();
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const identity = await getIdentity(env, { source: 'slack', tenant: message.tenant, userId: id });
    names.set(id, identity.person_name || identity.name);
  }
  return slackToMarkdown(message.text, (id) => names.get(id));
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
  for (const p of mentionedByName(body, await teamPeople(env, cache))) {
    if (!found.has(p.id)) {
      found.set(p.id, 'name');
    }
  }
  found.delete(author);
  return [...found].map(([person, via]) => ({ person, via }));
}

/**
 * Turns one pile-1 object into its pile-2 file. Returns a short result for the log.
 *
 * @param {object} env bindings
 * @param {string} key pile-1 key
 * @param {{ rules?: object[] }} cache shared across one queue batch
 */
export async function processKey(env, key, cache = {}) {
  const obj = await env.RAW.get(key);
  if (!obj) {
    return { key, result: 'missing' };
  }
  const op = normalize(key, JSON.parse(await obj.text()));
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
  // eslint-disable-next-line no-param-reassign
  cache.rules = cache.rules || await loadRules(env);
  const cls = classify(cache.rules, channel);
  if (cls.kind === 'ignore') {
    return { key, result: 'ignored' };
  }

  const deleted = op.op === 'delete';
  const { author, person } = await resolveAuthor(env, message.authorRef);
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
    org: cls.org,
    team: cls.team,
    kind: cls.kind,
    channelName: channel.name,
    path: path.slice(0, path.lastIndexOf('/') + 1),
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
  await recordMentions(env.DB, {
    thread: message.thread,
    message: messageKeyOf(message),
    at: message.at,
  }, deleted ? [] : await mentionsOf(env, message, body, person, cache));

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
  // A new root may continue an earlier thread (a repeat alert, a follow-up).
  if (message.id === message.rootId && !deleted && env.VECTORS && env.AI) {
    await env.NORMALIZE.send({ rethread: message.thread }, { delaySeconds: 30 });
  }
  if (cls.kind === 'channel' && author.kind === 'person' && env.AI) {
    await env.NORMALIZE.send({ label: message.thread }, { delaySeconds: LABEL_DELAY_SECONDS });
  }
  await notifyRoom(env, cls.team, { type: 'thread', thread: message.thread });
  return {
    key, result: written ? op.op : 'unchanged', org: cls.org, team: cls.team, kind: cls.kind,
  };
}

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
      || (body.backfill && `backfill:${body.backfill.thread}`)
      || (body.rethread && `rethread:${body.rethread}`);
    try {
      let r;
      if (body.backfill) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await runBackfill(env, body.backfill) };
      } else if (body.rethread) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await rethread(env, body.rethread, { force: Boolean(body.force) }) };
      } else if (body.label) {
        // eslint-disable-next-line no-await-in-loop
        r = { key, ...await labelThread(env, body.label) };
      } else {
        // eslint-disable-next-line no-await-in-loop
        r = await processKey(env, key, cache);
      }
      console.log(JSON.stringify({ route: 'normalize', ...r }));
      msg.ack();
    } catch (e) {
      console.error(JSON.stringify({ route: 'normalize', key, error: e.message }));
      // Rate limits (Vectorize, Workers AI) back off longer and spread out.
      const limited = /Too Many Requests|429|rate limit/i.test(e.message);
      msg.retry({ delaySeconds: limited ? 60 + Math.floor(Math.random() * 240) : 30 });
    }
  }
}
