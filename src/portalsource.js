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

import { portalFileRef, portalUserId } from './portal/ids.js';
import { personAvatar } from './lookup.js';
import { readMarkdown, writeMarkdown } from './mdast.js';
import {
  dayPath, putRaw, segment,
} from './raw.js';

/**
 * The customer portal as a source (`portal`), beside Slack, Teams and Discord. The portal is a
 * Worker of its own with its own record (src/portal/); the inbox reads it as it reads a
 * platform:
 *
 * - **in**: the portal delivers what happens in it as events to the inbox's `PortalSource`
 *   entrypoint (src/index.js), which stores each in pile 1 (`receive`), as `/slack/events`
 *   does Slack's. An event carries the channel's name and its author's name and mail address,
 *   so the normalizer files it without asking the portal anything (src/normalize.js
 *   `normalizePortal`, src/lookup.js).
 * - **out**: the inbox posts, reacts, uploads files and opens channels through the `PORTAL`
 *   binding, the portal's `PortalPlatform` entrypoint (`portalCall`), and reads the files and
 *   pictures the portal keeps the same way (`portalFetch`). It says who acts, by their mail
 *   address: nobody connects an account for the portal. What it wrote comes back as events.
 *
 * A channel's tenant is its lobby, the customer's mail domain: accounts and mentions stay
 * within one customer. Thread keys are `portal:<domain>:<channel>:<root message>`.
 *
 * Pile-1 keys:
 * `portal/<domain>/<channel, or _lobby>/<yyyy>/<mm>/<dd>/<event ms>-<portal>-<seq>.json`.
 * `seq` is the event's number in the portal's outbox, so one delivered twice is one object.
 */

const TYPES = new Set(['message', 'reaction', 'channel', 'lobby']);
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MAX_EVENTS = 200;

/** Whether this deployment can act in the portal: its Worker is bound (`PORTAL_WORKER`). */
export const portalBound = (env) => Boolean(env.PORTAL);

/** The pile-1 key of a portal event, or null for one that is not an event. */
export function portalKey(event) {
  const e = event || {};
  const at = Date.parse(e.at);
  if (!TYPES.has(e.type) || !DOMAIN.test(String(e.domain || '')) || !Number.isInteger(e.seq)
    || !Number.isFinite(at)) {
    return null;
  }
  const channel = e.type === 'lobby' ? '_lobby' : e.channel && e.channel.id;
  if (!channel) {
    return null;
  }
  const portal = String(e.portal || 'portal').replace(/[^a-z0-9-]/gi, '') || 'portal';
  return ['portal', segment(e.domain), segment(channel), dayPath(new Date(at)),
    `${at}-${portal}-${e.seq}.json`].join('/');
}

/**
 * Stores the portal's events in pile 1, in order, and queues them for normalization.
 * `{ ok, stored, skipped }`. It throws when one cannot be stored, so that the portal sends
 * the batch again; what was stored before is the same object then.
 */
export async function receive(env, events) {
  const list = Array.isArray(events) ? events.slice(0, MAX_EVENTS) : [];
  let stored = 0;
  let skipped = 0;
  for (const event of list) {
    const key = portalKey(event);
    if (!key) {
      skipped += 1;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await putRaw(env, key, JSON.stringify(event), {
        source: 'portal', via: event.via || 'events', eventType: event.type,
      });
      stored += 1;
    }
  }
  console.log(JSON.stringify({ route: 'portal', stored, skipped }));
  return { ok: true, stored, skipped };
}

/**
 * The technologies a lobby picks from, for the portal: the admin team's entries of the tech
 * stack that are marked for it (`tech_stack.portal`) and on, by product and name.
 */
export async function portalTechnologies(env) {
  const { results } = await env.DB.prepare(`SELECT tech, name, product FROM tech_stack
    WHERE team = 'admin' AND enabled = 1 AND portal = 1 ORDER BY product, name`).all();
  return (results || []).map((r) => ({ tech: r.tech, name: r.name, product: r.product || null }));
}

/**
 * One call of the portal's platform API (src/portal/platform.js): `post`, `edit`, `react`,
 * `open`, `decline` or `resend`. `{ ok, … }`, or `{ error, status?, unknown? }`: `unknown` when the
 * call itself failed, and nobody can say whether the portal did it.
 */
export async function portalCall(env, method, args) {
  if (!portalBound(env)) {
    return { error: 'the customer portal is not connected here', status: 409 };
  }
  try {
    const res = await env.PORTAL[method](args);
    return res && typeof res === 'object' ? res : { error: 'the portal did not answer' };
  } catch (e) {
    console.warn(JSON.stringify({ route: 'portal', call: method, error: e.message }));
    return { error: `the portal failed: ${e.message}`, unknown: true };
  }
}

/**
 * Who acts in the portal for a person of the inbox: `{ email, name, avatar }`, with the picture
 * the inbox knows of them (their Slack one first, as their header's), which the portal shows
 * its customers beside what they write.
 */
export async function portalAuthor(env, me) {
  const avatar = env.DB ? await personAvatar(env, me).catch(() => null) : null;
  return {
    email: me.email,
    name: me.name || undefined,
    avatar: /^https:\/\//.test(avatar || '') ? avatar : undefined,
  };
}

/**
 * Something the portal keeps, as a response: a file of a thread's channel (`file`), a picture
 * someone uploaded (`avatar`), a customer's logo (`logo`). Null where the portal is not bound,
 * or failed; the portal's own 404 is a response.
 */
export async function portalFetch(env, what, args) {
  if (!portalBound(env)) {
    return null;
  }
  try {
    const res = await env.PORTAL[what](args);
    return res instanceof Response ? res : null;
  } catch (e) {
    console.warn(JSON.stringify({ route: 'portal', call: what, error: e.message }));
    return null;
  }
}

/**
 * The file of the customer portal a link is to, when it is one of thread `thread`'s: `{ id,
 * name, domain, channel }`, or null. A portal thread's key names its lobby and its channel,
 * and the portal opens a file only for the channel it is in.
 */
export function portalFileOf(thread, link) {
  const [source, domain, channel] = String(thread || '').split(':');
  const ref = source === 'portal' && domain && channel ? portalFileRef(link) : null;
  return ref ? { ...ref, domain, channel } : null;
}

/** A portal file opened: `{ body, size, type, name, status, range }`, or `{ error }`. */
export async function openPortalFile(env, thread, link, { range = null, max = Infinity } = {}) {
  const f = portalFileOf(thread, link);
  if (!f) {
    return { error: 'not a file of this thread' };
  }
  const res = await portalFetch(env, 'file', {
    domain: f.domain, channel: f.channel, id: f.id, range,
  });
  if (!res || !res.ok) {
    await res?.body?.cancel();
    return { error: res ? 'the portal does not have this file any more' : 'the customer portal is not connected here' };
  }
  const size = Number(res.headers.get('content-length') || 0);
  if (size > max) {
    await res.body?.cancel();
    return { error: `too large (${Math.round(size / 1024 / 1024)} MB; up to ${Math.round(max / 1024 / 1024)} MB)` };
  }
  let { name } = f;
  try {
    name = decodeURIComponent(res.headers.get('x-file-name') || '') || f.name;
  } catch {
    // The link's name stands.
  }
  return {
    body: res.body,
    size: size || undefined,
    type: res.headers.get('x-file-type') || 'application/octet-stream',
    name,
    status: res.status,
    range: res.headers.get('content-range'),
  };
}

/**
 * Uploads `files` (src/attach.js: `{ name, type, bytes }`) to a portal channel for a message
 * `author` is about to post there: `{ ids }`, what `post` takes as `files`, or `{ error }`.
 */
export async function portalUpload(env, t, files, author) {
  const ids = [];
  for (const f of files) {
    // eslint-disable-next-line no-await-in-loop
    const res = await portalCall(env, 'upload', {
      domain: t.tenant, channel: t.channel_id, name: f.name, type: f.type, bytes: f.bytes, author,
    });
    if (!res.ok || !res.file) {
      return { error: res.error || 'the portal did not take the file', unknown: res.unknown };
    }
    ids.push(res.file.id);
  }
  return { ids };
}

/** Who acts in the portal for the inbox's app: the bot, under the product's name. */
export const PORTAL_BOT = { bot: true, name: 'Enterprise Support' };

/** A person's account id in the portal (the `user_id` of their identity there), by mail. */
export const portalAccount = (email) => portalUserId(email);

/**
 * A portal message's text as pile 2 keeps it. It is markdown as its author typed it, which
 * stays as it is, but for images: the inbox shows a message's images from the platforms'
 * files only, so an image becomes a link to it, through the syntax tree.
 */
export function portalMarkdown(text) {
  const src = String(text || '');
  if (!src.includes('![')) {
    return src;
  }
  const tree = readMarkdown(src);
  let changed = false;
  const walk = (node) => {
    for (let i = 0; i < (node.children || []).length; i += 1) {
      const child = node.children[i];
      if (child.type === 'image') {
        // eslint-disable-next-line no-param-reassign
        node.children[i] = {
          type: 'link',
          url: child.url,
          title: null,
          children: [{ type: 'text', value: child.alt || child.url }],
        };
        changed = true;
      } else {
        walk(child);
      }
    }
  };
  walk(tree);
  return changed ? writeMarkdown(tree) : src;
}
