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

import { json } from '../http.js';
import { deliver } from './events.js';
import {
  allowed, channelOf, channelsOf, deleteMessage, editMessage, invite, lobbyOf, membersOf,
  reactTo, rename, requestChannel, signIn, threadOf, threadsOf, uninvite, updateLobby,
  writeMessage,
} from './store.js';
import { listTech, refreshTech, techStale } from './tech.js';

/**
 * The portal's API, for its page (ui/portal.js), behind Cloudflare Access: whoever calls is
 * signed in with their work mail address (`email`, verified by the Worker), and that address
 * decides everything. Their mail domain is their lobby; they read and write its channels
 * once they are in it (its founder, or invited by a member), and nothing of any other.
 *
 * | Route | |
 * | --- | --- |
 * | `GET /api/me` | who you are, your lobby, its people, its channels, what one may pick |
 * | `PUT /api/profile` | `{ name }` |
 * | `PUT /api/lobby` | `{ company?, tech?, note? }` |
 * | `POST /api/lobby/request` | ask for a channel |
 * | `POST /api/invite` | `{ email, name? }` invites a colleague of the same domain |
 * | `DELETE /api/invite` | `{ user }` takes an invitation back |
 * | `GET /api/threads?channel=` | a channel's threads |
 * | `GET /api/thread?channel=&thread=` | one thread's messages; marks it read |
 * | `POST /api/post` | `{ channel, thread?, text }` |
 * | `POST /api/edit`, `/api/delete` | `{ channel, id, text? }`, one's own message |
 * | `POST /api/react` | `{ channel, id, emoji, remove? }` |
 */

/** A store answer as a response: `{ error, status }` is the error, with that status. */
function answer(r) {
  if (!r.error) {
    return json(r);
  }
  const { status = 400, ...rest } = r;
  return json(rest, status);
}

/** A write's body, which must be JSON: a form posted from another site is not. */
async function bodyOf(request) {
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) {
    return null;
  }
  const body = await request.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

/** Whether a write comes from the portal's own page: browsers name where a request is from. */
function sameOrigin(request, url) {
  const origin = request.headers.get('origin');
  return !origin || origin === url.origin;
}

async function me(env, who, after) {
  const { user, domain, member } = who;
  const [lobby, members, tech] = await Promise.all([
    lobbyOf(env, domain), membersOf(env, domain), listTech(env),
  ]);
  // The inbox's list, when it is an hour old: asked behind the answer.
  if (env.OPSPILE && await techStale(env)) {
    after(refreshTech(env).catch((e) => console.warn(JSON.stringify({
      route: 'portal', tech: 'error', error: e.message,
    }))));
  }
  if (!member) {
    // Not in the lobby yet: who to ask, and nothing of what it says.
    return json({
      me: user,
      domain,
      member: false,
      company: lobby ? lobby.company : null,
      colleagues: members.filter((m) => m.joined).map((m) => ({ name: m.name, email: m.email })),
    });
  }
  return json({
    me: user,
    domain,
    member: true,
    lobby,
    members,
    channels: lobby.status === 'open' ? await channelsOf(env, domain) : [],
    tech,
  });
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {URL} url
 * @param {{ email: string|null, waitUntil?: (p: Promise<unknown>) => void }} options `email`:
 *   the signed-in person's verified mail address
 * @returns {Promise<Response|null>} null for a path that is not the API's
 */
export async function api(request, env, url, { email, waitUntil = () => {} } = {}) {
  const { pathname } = url;
  if (!pathname.startsWith('/api/')) {
    return null;
  }
  if (!email) {
    return json({ error: 'sign in first' }, 401);
  }
  if (!allowed(env, email)) {
    return json({
      error: 'the portal is not open to your company yet', email, closed: true,
    }, 403);
  }
  const { method } = request;
  const route = `${method} ${pathname.slice('/api/'.length)}`;
  const body = method === 'GET' ? {} : await bodyOf(request);
  if (method !== 'GET' && (!body || !sameOrigin(request, url))) {
    return json({ error: 'send JSON from the portal\'s page' }, 400);
  }
  const who = await signIn(env, email);
  // What a write tells the inbox goes out behind its answer; the cron takes what that leaves.
  const told = (r) => {
    waitUntil(deliver(env).catch((e) => console.warn(JSON.stringify({
      route: 'portal', deliver: 'error', error: e.message,
    }))));
    return answer(r);
  };
  if (route === 'GET me') {
    return me(env, who, waitUntil);
  }
  if (route === 'PUT profile') {
    return answer(await rename(env, who.user, body.name));
  }
  if (!who.member) {
    return json({ error: 'ask a colleague who is here to invite you' }, 403);
  }
  const { user, domain } = who;
  switch (route) {
    case 'PUT lobby': {
      const known = (await listTech(env)).map((t) => t.tech);
      return told(await updateLobby(env, domain, body, known));
    }
    case 'POST lobby/request': return told(await requestChannel(env, domain, user));
    case 'POST invite': return told(await invite(env, domain, user, body));
    case 'DELETE invite': return told(await uninvite(env, domain, body));
    default:
  }
  // The rest is a channel's: one of the caller's lobby.
  const channel = await channelOf(
    env,
    domain,
    method === 'GET' ? url.searchParams.get('channel') : body.channel,
  );
  if (!channel) {
    return json({ error: 'no such channel' }, 404);
  }
  switch (route) {
    case 'GET threads': return json({ threads: await threadsOf(env, channel, user) });
    case 'GET thread': {
      const thread = await threadOf(env, channel, url.searchParams.get('thread'), user);
      return thread ? json({ thread }) : json({ error: 'no such thread' }, 404);
    }
    case 'POST post': return told(await writeMessage(env, channel, user, {
      root: body.thread, text: body.text,
    }));
    case 'POST edit': return told(await editMessage(env, channel, user, body));
    case 'POST delete': return told(await deleteMessage(env, channel, user, body));
    case 'POST react': return told(await reactTo(env, channel, user, {
      id: body.id, emoji: body.emoji, removed: Boolean(body.remove),
    }));
    default: return json({ error: 'not found' }, 404);
  }
}
