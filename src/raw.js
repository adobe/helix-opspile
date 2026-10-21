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
 * Pile 1: raw events, append-only in the RAW bucket. Every object written here is also
 * announced on the NORMALIZE queue, which builds pile 2 (#6).
 *
 * Keys are derived from the platform's ids, never from the time of receipt alone, so a
 * redelivered event overwrites its own object instead of creating a second one.
 */

/**
 * One key segment. Platform ids are kept as they are (Teams channel ids contain `:` and
 * `@`); only characters that would break the key structure are replaced. Missing values
 * become `_`.
 */
export function segment(value) {
  if (value === undefined || value === null || value === '') {
    return '_';
  }
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[/\\\u0000-\u001f\u007f]/g, '_');
}

/** `yyyy/mm/dd` in UTC. */
export function dayPath(date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

/** Lower-case hex SHA-256 of a string. */
export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function stringMetadata(meta) {
  return Object.fromEntries(
    Object.entries(meta)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]),
  );
}

/**
 * Writes one raw object and enqueues its key for normalization. Throws if either step
 * fails, so the caller can let the platform retry; a retry rewrites the same key.
 */
export async function putRaw(env, key, body, meta = {}) {
  await env.RAW.put(key, body, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: stringMetadata({ receivedAt: new Date().toISOString(), ...meta }),
  });
  await env.NORMALIZE.send({ key });
  return key;
}
