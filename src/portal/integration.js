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

import { MESSAGE_ID } from './ids.js';
import {
  authorize, BASE, fail, IntegrationError,
} from './integration-auth.js';
import { markRead, readChanges, readThreads } from './integration-read.js';
import { deliver } from './events.js';
import { theirs, writeMessage } from './store.js';

const respond = (body, status = 200, headers = {}) => Response.json(body, {
  status, headers: { 'cache-control': 'private, no-store', ...headers },
});
const invalid = () => fail(400, 'invalid_input');
const notFound = () => fail(404, 'not_found');
const text = (s, n) => typeof s === 'string' && s.length <= n && s.trim().length > 0;

async function input(request, fields) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) {
    invalid();
  }
  const reader = request.body?.getReader();
  if (!reader) {
    invalid();
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > 16384) {
      reader.cancel().catch(() => {});
      invalid();
    }
    chunks.push(value);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    invalid();
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((k) => !fields.includes(k))) {
    invalid();
  }
  return body;
}

/** The ID was reserved for routing during enrollment. Racing inserts reuse that exact channel;
 * the channel-created trigger tells the inbox once, as part of the winning transaction. */
function provision(db, m, lobby, at) {
  return [
    db.prepare(`INSERT INTO lobbies(domain, company, created_by, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, 'open') ON CONFLICT(domain) DO NOTHING`)
      .bind(lobby, m.channelName, m.actor, at, at),
    db.prepare(`INSERT INTO channels(id, lobby, name, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).bind(m.channel, lobby, m.channelName, at),
  ];
}

async function post(request, env, m, root, now, waitUntil) {
  const key = request.headers.get('idempotency-key') || '';
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(key)) {
    invalid();
  }
  const { title, body, topic } = await input(request, root ? ['body'] : ['title', 'body', 'topic']);
  if (!text(body, 2000) || (!root && (!text(title, 120) || /[\r\n]/.test(title)))
    || (topic !== undefined && !text(topic, 80))) {
    invalid();
  }
  const db = env.DB;
  // A reply goes to a thread of the channel, and in an individual one to one of the member's.
  if (root && !await db.prepare(`SELECT 1 FROM messages WHERE channel = ?1 AND id = ?2
    AND id = root AND ${theirs('?2', 3)}`)
    .bind(m.channel, root, m.audience === 'individual' ? JSON.stringify(m.people) : null).first()) {
    notFound();
  }
  const operation = root ? 'reply' : 'create';
  const scope = [m.channel, m.actor, operation, key];
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder()
    .encode(JSON.stringify([root, title, topic, body])))).toString('hex');
  const lookup = () => db.prepare(`SELECT message, digest, channel_name FROM integration_receipts
    WHERE channel = ? AND actor = ? AND operation = ? AND key = ?`).bind(...scope).first();
  const result = (id, channelName) => (root ? { id, threadId: root } : {
    threadId: id, channelId: m.channel, channelName, requestId: key,
  });
  const replay = (saved) => {
    if (saved.digest !== digest) {
      fail(409, 'key_conflict');
    }
    return respond(result(saved.message, saved.channel_name));
  };
  const prior = await lookup();
  if (prior) {
    return replay(prior);
  }
  if (topic !== undefined && !m.topics.includes(topic)) {
    invalid();
  }
  const lobby = `${m.channel}.embed.invalid`;
  const channel = {
    id: m.channel, name: m.channelName, company: m.channelName, lobby, audience: m.audience,
  };
  let wrote;
  try {
    // A one-line request is its title: a body that only repeats it is not said twice.
    const rest = body.trim() === title?.trim() ? null : body.trim();
    const content = root ? body : [title.trim(), topic, rest].filter(Boolean).join('\n\n');
    wrote = await writeMessage(env, channel, {
      id: m.actor, kind: 'customer', name: m.name,
    }, {
      root,
      text: content,
      people: m.people,
      beforeWrite: (id) => [
        db.prepare(`INSERT INTO integration_receipts(channel, actor, operation, key, digest,
          message, channel_name) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(...scope, digest, id, m.channelName),
        ...(root ? [] : provision(db, m, lobby, new Date(now).toISOString())),
      ],
    }, now);
  } catch (e) {
    // A concurrent retry (or an uncertain commit): the unique receipt is in the message batch.
    const saved = await lookup();
    if (saved) {
      return replay(saved);
    }
    throw e;
  }
  if (!wrote.ok) {
    fail(wrote.status || 400, 'invalid_input');
  }
  waitUntil(deliver(env).catch(() => console.warn('portal integration: outbox delivery deferred')));
  return respond(result(wrote.id, m.channelName), 201, { location: `${BASE}/threads/${wrote.root}` });
}

/** Backend-only HTTP boundary, separate from the portal's Access email API. */
export async function integration(request, env, options = {}) {
  try {
    const { pathname, searchParams } = new URL(request.url);
    const route = pathname.slice(BASE.length);
    const { method } = request;
    let scope;
    let root = null;
    if (method === 'GET' && route === '/changes') {
      scope = 'changes:read';
    } else if (method === 'POST' && route === '/threads') {
      scope = 'threads:create';
    } else if (method === 'GET' && route === '/threads') {
      scope = 'threads:read';
    } else {
      const match = /^\/threads\/([^/]+)(?:\/(replies|read))?$/.exec(route);
      if (!match || !MESSAGE_ID.test(match[1])) {
        notFound();
      }
      [, root] = match;
      if (method === 'POST' && match[2] === 'replies') {
        scope = 'threads:reply';
      } else if ((method === 'GET' && !match[2]) || (method === 'PUT' && match[2] === 'read')) {
        scope = 'threads:read';
      } else {
        notFound();
      }
    }
    const m = await authorize(request, env, scope, options);
    const now = options.now ?? Date.now();
    if (method === 'POST') {
      return await post(request, env, m, root, now, options.waitUntil || (() => {}));
    }
    if (method === 'PUT') {
      const { through } = await input(request, ['through']);
      if (typeof through !== 'string' || !MESSAGE_ID.test(through)) {
        invalid();
      }
      return respond(await markRead(env.DB, m, root, through));
    }
    return respond(scope === 'changes:read' ? await readChanges(env.DB, m, searchParams, now)
      : await readThreads(env.DB, m, root, searchParams, now));
  } catch (e) {
    if (e instanceof IntegrationError) {
      return respond(
        { error: { code: e.message, ...e.detail } },
        e.status,
        e.status === 429 ? { 'retry-after': '60' } : {},
      );
    }
    // Do not log tokens, queries, bind values or content.
    console.warn('portal integration: request failed');
    return respond({ error: { code: 'unavailable' } }, 503);
  }
}
