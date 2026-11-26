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

import { underlying, UNDERLYING } from './d1batch.js';

/*
 * D1 read replication (docs/STATE-MACHINES.md, "D1 session"). With it on, D1 keeps read-only
 * copies of the database in every region, and a query reaches one only through a session
 * (`withSession`); everything else goes to the primary, as without it. So the inbox's reads
 * (`GET /api/*`) each run in a session, which starts at the copy nearest to them unless the page
 * says how new what it reads must be: the bookmark (`x-d1-bookmark`) of the newest state it has
 * seen, which every answer of /api says and every room event carries (`notifyRoom`). A session
 * started from a bookmark reads a copy at least that new, so what a person did, and what the
 * page was told changed, is there when the page asks again. Everything that writes (any other
 * method) starts at the primary (`first-primary`), so what it reads before it writes is the
 * latest. Without read replication a session is the primary's, and nothing changes.
 */

export const BOOKMARK_HEADER = 'x-d1-bookmark';

/** A D1 bookmark (hex fields joined by dashes), or not one: never passed to D1. */
const BOOKMARK = /^[0-9a-f]{8}(?:-[0-9a-f]{8,64}){1,6}$/i;
export const isBookmark = (b) => typeof b === 'string' && b.length <= 256 && BOOKMARK.test(b);

/**
 * Where a request's session starts: at the primary for what may write, else from the bookmark
 * the page sent, else anywhere.
 */
export function constraintFor(request) {
  const method = String(request.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return 'first-primary';
  }
  const said = request.headers.get(BOOKMARK_HEADER);
  return isBookmark(said) ? said : 'first-unconstrained';
}

/**
 * `db` as one session starting at `constraint`, or null where the binding has none (tests, a
 * fake). Asked for the binding under it (`UNDERLYING`), it says the binding's, so what is kept
 * across requests by the database is kept as before; what a session cannot do is the binding's.
 */
export function sessionDatabase(db, constraint) {
  if (!db || typeof db.withSession !== 'function') {
    return null;
  }
  const session = db.withSession(constraint);
  if (!session || typeof session.prepare !== 'function') {
    return null;
  }
  return new Proxy(session, {
    get(target, prop) {
      if (prop === UNDERLYING) {
        return underlying(db);
      }
      const own = Reflect.get(target, prop);
      const v = own === undefined ? Reflect.get(db, prop) : own;
      if (typeof v !== 'function') {
        return v;
      }
      return v.bind(own === undefined ? db : target);
    },
  });
}

/** The session's bookmark now (the newest state it read or wrote), or null. */
export function bookmarkOf(db) {
  try {
    const b = db && typeof db.getBookmark === 'function' ? db.getBookmark() : null;
    return isBookmark(b) ? b : null;
  } catch {
    return null;
  }
}

/** `response` saying `bookmark`, copied if its headers cannot change; a WebSocket's as it is. */
export function withBookmark(response, bookmark) {
  if (!response || !bookmark || response.status === 101 || response.webSocket) {
    return response;
  }
  try {
    response.headers.set(BOOKMARK_HEADER, bookmark);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(BOOKMARK_HEADER, bookmark);
    return copy;
  }
}

/**
 * The primary's bookmark now, for a room event (src/notify.js): at least as new as every write
 * made before it, so the page's next read sees what the event is about. One query of nothing at
 * the primary; null without sessions, or when it fails (the event goes without).
 */
export async function primaryBookmark(env) {
  const db = env && env.DB;
  if (!db || typeof db.withSession !== 'function') {
    return null;
  }
  try {
    const session = db.withSession('first-primary');
    await session.prepare('SELECT 1').first();
    return bookmarkOf(session);
  } catch {
    return null;
  }
}
