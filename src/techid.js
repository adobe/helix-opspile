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
 * The ids of technologies. A technology of a team's catalog (src/catalog.js) is the path of its
 * concept under `products/`, without `.md`: `adobe/aem-sites/edge-delivery`, `fastly/cdn`,
 * `categories/consent-manager`. Those written in D1 before the catalog have a short id (`eds`),
 * which the catalog's `moved_from` maps to the path. Both are stored where a technology is
 * named: labels, follows, extraction rules, `stack.md`, the portal's lobbies.
 */

/** An id from before the catalog, or of a technology saved in D1. */
export const SHORT_ID = /^[a-z][a-z0-9_]{0,31}$/;
/** A catalog path: two to four segments, as checkConcept allows a path's segments. */
export const PATH_ID = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*){1,3}$/;
export const MAX_TECH_ID = 160;

/** Whether `id` names a technology: a short id or a catalog path. */
export const isTechId = (id) => typeof id === 'string' && id.length <= MAX_TECH_ID
  && (SHORT_ID.test(id) || PATH_ID.test(id));

/* eslint-disable no-bitwise -- a hash */
/** FNV-1a, 32 bits, of `s` from `seed`, as 8 hex digits. */
function fnv(s, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
/* eslint-enable no-bitwise */

/**
 * The key of each technology's question in one Clef call, `{ [id]: key }`: a hash of its id, so
 * that a path (slashes, dashes, sixty characters) never is a key. The key lives for one call,
 * where it is mapped back: nothing stores it. Eight hex digits, sixteen for all when two of
 * `ids` would share eight.
 */
export function questionKeys(ids) {
  const list = [...new Set(ids)];
  const short = list.map((id) => fnv(id));
  const long = new Set(short).size < short.length;
  return Object.fromEntries(list.map((id, i) => [id, long ? `${short[i]}${fnv(id, 0x9e3779b9)}` : short[i]]));
}
