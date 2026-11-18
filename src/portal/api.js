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
  avatarResponse, fileResponse, fileRow, MAX_FILE_BYTES, MAX_PICTURE_BYTES, pictureResponse,
  uploadFile,
} from './files.js';
import { richMarkdown } from './richtext.js';
import {
  allowed, channelOf, channelsOf, clearAvatar, clearLogo, deleteMessage, editMessage, invite,
  lobbyOf, membersOf, peopleOf, reactTo, rename, requestChannel, setAvatar, setLogo, signIn,
  threadOf, threadPulse, threadsOf, uninvite, updateLobby, writeMessage,
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
 * | `GET /api/people?channel=` | who can be mentioned there |
 * | `POST /api/upload?channel=&name=&w=&h=` | a file for a message, as the request's body |
 * | `GET /api/file/<id>/<name>` | a file of one's lobby |
 * | `GET /api/status?channel=&thread=` | Adobe's side of a thread, and what is new in it |
 * | `POST /api/post` | `{ channel, thread?, html \| text, files? }` (`files`: ids of uploads) |
 * | `POST /api/edit`, `/api/delete` | `{ channel, id, html \| text }`, one's own message |
 * | `POST /api/react` | `{ channel, id, emoji, remove? }` |
 * | `PUT`, `DELETE /api/avatar` | one's picture, an image as the request's body |
 * | `GET /api/avatar/<account>` | the picture of a colleague or of someone at Adobe |
 * | `PUT`, `DELETE /api/logo`, `GET /api/logo` | the customer's logo |
 */

/**
 * A message's text from a request: the rich text of the page's text box (`html`,
 * src/portal/richtext.js) as markdown, else `text`, markdown as it is. Null for rich text too
 * long to read.
 */
const textOf = (body) => (body.html !== undefined ? richMarkdown(body.html) : body.text);
const TOO_LONG = { error: 'this message is too long', status: 400 };

/** Adobe's side of a thread is asked of the inbox this often at most, per isolate. */
const STATUS_MS = 10 * 1000;
const statuses = new Map();

/** Forgets what the inbox said (tests). */
export function clearStatuses() {
  statuses.clear();
}

/**
 * What the inbox says of Adobe's side of a thread, or of a channel (`OPSPILE.status`,
 * src/portalstatus.js): how many listen, the typical wait, whether the agent works on it and
 * whether a draft waits. Kept for ten seconds, since every open page asks every few; nothing
 * where the inbox is not bound or does not answer.
 */
async function adobeSide(env, domain, channel, root, now = Date.now()) {
  if (!env.OPSPILE) {
    return {};
  }
  const key = `${domain}:${channel}:${root || ''}`;
  const kept = statuses.get(key);
  if (kept && now - kept.at < STATUS_MS) {
    return kept.value;
  }
  let value = {};
  try {
    const said = await env.OPSPILE.status({ domain, channel, root: root || undefined });
    value = {
      listening: Number(said && said.listening) || 0,
      estimate: said && said.estimate && Number.isFinite(said.estimate.minutes) ? {
        minutes: said.estimate.minutes, asked: said.estimate.asked || null,
      } : null,
      working: Boolean(said && said.working),
      draft: Boolean(said && said.draft),
    };
  } catch (e) {
    console.warn(JSON.stringify({ route: 'portal', status: 'error', error: e.message }));
  }
  if (statuses.size > 500) {
    statuses.clear();
  }
  statuses.set(key, { at: now, value });
  return value;
}

/** The writes whose body is a file's bytes, not JSON. */
const UPLOADS = ['POST upload', 'PUT avatar', 'PUT logo'];

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

/**
 * Whether a write comes from the portal's own page: browsers name where a request is from.
 * `strict`: it must say so (an upload's body is no JSON, which other sites cannot send).
 */
function sameOrigin(request, url, strict = false) {
  const origin = request.headers.get('origin');
  return origin ? origin === url.origin : !strict;
}

/**
 * An upload's body: its bytes and its content type, or `{ error, status }` for one that says it
 * is larger than `max`, which is not read.
 */
async function upload(request, max) {
  if (Number(request.headers.get('content-length') || 0) > max) {
    await request.body?.cancel();
    const mb = Math.round(max / 104857.6) / 10;
    return { error: `too large: up to ${mb} MB`, status: 413 };
  }
  return {
    type: request.headers.get('content-type') || '',
    bytes: new Uint8Array(await request.arrayBuffer()),
  };
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
      logo: lobby ? lobby.logo : null,
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
  const raw = UPLOADS.includes(route);
  const body = method === 'GET' || raw ? {} : await bodyOf(request);
  if (method !== 'GET' && (!body || !sameOrigin(request, url, raw))) {
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
    return answer(await rename(env, who.row, body.name));
  }
  if (route === 'PUT avatar') {
    const picture = await upload(request, MAX_PICTURE_BYTES);
    return answer(picture.error ? picture : await setAvatar(env, who.row, picture));
  }
  if (route === 'DELETE avatar') {
    return answer(await clearAvatar(env, who.row));
  }
  // A picture: one's colleagues' (their mail domain is one's own), and Adobe's people's.
  const pictured = /^GET avatar\/([ub][0-9a-f]{20})$/.exec(route);
  if (pictured) {
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(pictured[1]).first();
    return u && (u.kind !== 'customer' || u.domain === who.domain)
      ? avatarResponse(env, u) : json({ error: 'not found' }, 404);
  }
  if (route === 'GET logo') {
    const row = await env.DB.prepare('SELECT logo_key FROM lobbies WHERE domain = ?')
      .bind(who.domain).first();
    return pictureResponse(env, row && row.logo_key);
  }
  if (!who.member) {
    return json({ error: 'ask a colleague who is here to invite you' }, 403);
  }
  // The account as the database has it: what a message's event says of its author.
  const { row: user, domain } = who;
  switch (route) {
    case 'PUT lobby': {
      const known = (await listTech(env)).map((t) => t.tech);
      return told(await updateLobby(env, domain, body, known));
    }
    case 'POST lobby/request': return told(await requestChannel(env, domain, user));
    case 'POST invite': return told(await invite(env, domain, user, body));
    case 'DELETE invite': return told(await uninvite(env, domain, body));
    case 'PUT logo': {
      const picture = await upload(request, MAX_PICTURE_BYTES);
      return picture.error ? answer(picture) : told(await setLogo(env, domain, picture));
    }
    case 'DELETE logo': return told(await clearLogo(env, domain));
    default:
  }
  // A file of the lobby's channels: the part of it the browser asks for.
  const wanted = /^GET file\/(f[0-9a-z]{16})\/[^/]+$/.exec(route);
  if (wanted) {
    const file = await fileRow(env, domain, wanted[1]);
    return file ? fileResponse(env, file, request.headers.get('range'))
      : json({ error: 'not found' }, 404);
  }
  // The rest is a channel's: one of the caller's lobby.
  const channel = await channelOf(
    env,
    domain,
    method === 'GET' || raw ? url.searchParams.get('channel') : body.channel,
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
    case 'GET people': return json({ people: await peopleOf(env, channel) });
    case 'GET status': {
      // Adobe's side from the inbox, and from here who is writing and whether anything is new.
      const root = url.searchParams.get('thread') || null;
      const [adobe, pulse] = await Promise.all([
        adobeSide(env, domain, channel.id, root),
        root ? threadPulse(env, channel, root, user) : { typing: [], stamp: null },
      ]);
      return json({ ...adobe, ...pulse });
    }
    case 'POST upload': {
      const file = await upload(request, MAX_FILE_BYTES);
      return answer(file.error ? file : await uploadFile(env, channel, user, {
        ...file,
        name: url.searchParams.get('name'),
        width: url.searchParams.get('w'),
        height: url.searchParams.get('h'),
      }));
    }
    case 'POST post': {
      const text = textOf(body);
      return text === null ? answer(TOO_LONG) : told(await writeMessage(env, channel, user, {
        root: body.thread, text, files: body.files,
      }));
    }
    case 'POST edit': {
      const text = textOf(body);
      return text === null ? answer(TOO_LONG)
        : told(await editMessage(env, channel, user, { id: body.id, text }));
    }
    case 'POST delete': return told(await deleteMessage(env, channel, user, body));
    case 'POST react': return told(await reactTo(env, channel, user, {
      id: body.id, emoji: body.emoji, removed: Boolean(body.remove),
    }));
    default: return json({ error: 'not found' }, 404);
  }
}
