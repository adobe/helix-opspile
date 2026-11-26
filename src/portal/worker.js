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
 * The customer portal: a Worker of its own (portal/cloudflare.config.ts), for customers who
 * can use neither Slack nor Teams with Adobe. They sign in with their work mail address
 * (Cloudflare Access, a one-time code), say what they use of Adobe's and ask for a channel;
 * once the inbox's admins have opened one, they write there and Adobe answers from the inbox.
 *
 * To the inbox the portal is a platform, as Slack is: what happens here reaches it as events
 * (`OPSPILE`, the inbox's `PortalSource` entrypoint; src/portal/events.js), and it posts,
 * reacts and opens channels here through `PortalPlatform` below (src/portal/platform.js).
 * Neither Worker reads the other's database. Docs: docs/ARCHITECTURE.md, "Customer portal".
 *
 * Keep everything that Node can test out of this file: it imports `cloudflare:workers`.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { accessEmail } from '../access.js';
import { json, text } from '../http.js';
import { ICONS } from '../icons.js';
import { PORTAL_PAGE as PAGE } from './pages.js';
import { api } from './api.js';
import { integration } from './integration.js';
import { BASE, pruneIntegration } from './integration-auth.js';
import { deliver, pruneEvents } from './events.js';
import { pruneFiles } from './files.js';
import {
  accessRequests, again, avatar, decline, declineRequest, edit, enroll, file, logo, open, post,
  react, reserve, typing, upload,
} from './platform.js';
import { refreshTech, techStale } from './tech.js';

const iconBytes = new Map();
function icon(pathname) {
  const entry = ICONS[pathname];
  if (!entry) {
    return null;
  }
  if (!iconBytes.has(pathname)) {
    iconBytes.set(pathname, Uint8Array.from(atob(entry.base64), (c) => c.charCodeAt(0)));
  }
  return new Response(iconBytes.get(pathname), {
    headers: { 'content-type': entry.type, 'cache-control': 'public, max-age=86400' },
  });
}

const logged = (what) => (r) => console.log(JSON.stringify({ route: 'portal', [what]: r }));
const failed = (what) => (e) => console.error(JSON.stringify({
  route: 'portal', [what]: 'error', error: e.message,
}));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === 'GET' || request.method === 'HEAD') {
      const iconResponse = icon(pathname);
      if (iconResponse) {
        return iconResponse;
      }
    }
    if (pathname.startsWith(`${BASE}/`)) {
      return integration(request, env, { waitUntil: (p) => ctx.waitUntil(p) });
    }
    if (pathname.startsWith('/api/')) {
      // Access signs people in; the Worker checks its token itself, so a request that got
      // around Access is nobody's.
      const email = await accessEmail(request, env).catch(() => null);
      try {
        return await api(request, env, url, { email, waitUntil: (p) => ctx.waitUntil(p) });
      } catch (e) {
        failed('api')(e);
        return json({ error: 'the portal failed; try again' }, 500);
      }
    }
    if (pathname === '/') {
      return new Response(PAGE, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          'referrer-policy': 'same-origin',
          'x-frame-options': 'DENY',
        },
      });
    }
    return text('not found\n', 404);
  },

  /**
   * Cron: what the inbox has not heard of yet, its list of technologies when the portal's is an
   * hour old, and old events.
   */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(deliver(env).then(logged('deliver')).catch(failed('deliver')));
    ctx.waitUntil(techStale(env).then((stale) => (stale ? refreshTech(env) : { result: 'fresh' }))
      .then(logged('tech')).catch(failed('tech')));
    ctx.waitUntil(pruneEvents(env).then(logged('prune')).catch(failed('prune')));
    ctx.waitUntil(pruneIntegration(env).catch(() => console.warn('portal integration: prune deferred')));
    ctx.waitUntil(pruneFiles(env).then(logged('files')).catch(failed('files')));
  },
};

/**
 * What the inbox does here (its `PORTAL` binding): src/portal/platform.js. What these write
 * goes back to the inbox as events, behind the answer.
 */
export class PortalPlatform extends WorkerEntrypoint {
  async #told(result) {
    const r = await result;
    this.ctx.waitUntil(deliver(this.env).catch(failed('deliver')));
    return r;
  }

  /** `{ domain, channel, root?, text, author }`: posts a message. */
  post(args) {
    return this.#told(post(this.env, args));
  }

  /** `{ domain, channel, root, author }`: someone at Adobe is writing a reply in a thread. */
  typing(args) {
    return typing(this.env, args);
  }

  /** `{ domain, channel, name, type, bytes, author }`: keeps a file for a message. */
  upload(args) {
    return upload(this.env, args);
  }

  /** `{ domain, channel, id, range? }`: a file of that channel, as a response. */
  file(args) {
    return file(this.env, args);
  }

  /** `{ user }`: the picture someone uploaded, as a response. */
  avatar(args) {
    return avatar(this.env, args);
  }

  /** `{ domain }`: a customer's logo, as a response. */
  logo(args) {
    return logo(this.env, args);
  }

  /** `{ domain, channel, id, text, author }`: changes a message its author wrote. */
  edit(args) {
    return this.#told(edit(this.env, args));
  }

  /** `{ domain, channel, id, emoji, removed?, author }`: reacts to a message. */
  react(args) {
    return this.#told(react(this.env, args));
  }

  /** `{ domain, name, topic?, by }`: opens a channel for a lobby. */
  open(args) {
    return this.#told(open(this.env, args));
  }

  /** `{ domain, reason? }`: declines what a lobby asked for. */
  decline(args) {
    return this.#told(decline(this.env, args));
  }

  /** `{ domain, channel, root? }`: a thread's messages again, as events. */
  resend(args) {
    return this.#told(again(this.env, args));
  }

  /** `{ id?, count? }`: the integration's access requests (docs/PORTAL-INTEGRATION.md). */
  accessRequests(args) {
    return accessRequests(this.env, args);
  }

  /** `{ id, customer, name, by }`: reserves the channel of a request's new tenant. */
  reserveAccess(args) {
    return reserve(this.env, args);
  }

  /** `{ id, name, by, enable? }`: enrolls a request's person, and enables what was reserved. */
  enrollAccess(args) {
    return enroll(this.env, args);
  }

  /** `{ id, reason?, by }`: declines an access request. */
  declineAccess(args) {
    return declineRequest(this.env, args);
  }
}
