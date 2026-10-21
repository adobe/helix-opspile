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

import { channelPath, writeMessage } from './channels.js';
import {
  getChannel, getIdentity, loadRules, toAuthor, updateChannelName,
} from './lookup.js';
import { htmlToMarkdown, slackToMarkdown } from './markdown.js';
import { normalize } from './normalize.js';
import { classify } from './rules.js';

const MAX_MENTIONS = 20;

async function resolveAuthor(env, ref) {
  if (!ref.userId) {
    return {
      kind: ref.kind || 'bot', name: ref.name || null, org: null, staff: false,
    };
  }
  return toAuthor(env, await getIdentity(env, ref));
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
  const meta = {
    source: message.source,
    thread: message.thread,
    id: message.id,
    at: message.at,
    author: await resolveAuthor(env, message.authorRef),
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
    const key = msg.body && msg.body.key;
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await processKey(env, key, cache);
      console.log(JSON.stringify({ route: 'normalize', ...r }));
      msg.ack();
    } catch (e) {
      console.error(JSON.stringify({ route: 'normalize', key, error: e.message }));
      msg.retry({ delaySeconds: 30 });
    }
  }
}
