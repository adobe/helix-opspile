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

import { json } from './http.js';

/**
 * A post is not idempotent on the platforms, and a page that lost the answer cannot know whether
 * the post went out. So a reply carries a `key`, the same on every retry:
 *
 *   no row → claimed (the platform is being asked) → answered, or the row goes when refused
 *
 * A retry that finds the answer gets it, without posting. One that finds the row claimed cannot
 * know: the first request may still be running, or may have died after the platform took the
 * post. It is told so (`unknown`), and only the person can decide to send it again. A post
 * without a key (the MCP tools) is as it was.
 */

const MAX_KEY = 100;
export const POST_KEY_HOURS = 24;

const usable = (key) => typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY;

/**
 * Claims `key` for `me`. Resolves to null when the post may go ahead, else to the response of a
 * retry: the first answer, or that nobody knows.
 */
export async function claimPost(env, me, key) {
  if (!usable(key)) {
    return null;
  }
  const claimed = await env.DB.prepare(`INSERT INTO post_keys (person, key, at) VALUES (?, ?, ?)
    ON CONFLICT (person, key) DO NOTHING RETURNING key`)
    .bind(me.id, key, new Date().toISOString()).first();
  if (claimed) {
    return null;
  }
  const row = await env.DB.prepare('SELECT answer FROM post_keys WHERE person = ? AND key = ?')
    .bind(me.id, key).first();
  if (row && row.answer) {
    return json({ ...JSON.parse(row.answer), again: true });
  }
  return json({
    error: 'this reply may have gone out: the first try did not finish',
    unknown: true,
  }, 409);
}

/**
 * Records how the post of `key` ended: its ids, or nothing when it was refused, so that a retry
 * posts. An answer that says nobody knows (`unknown`: the connection to the platform dropped) is
 * not a refusal, and keeps the claim. Quietly: the post is done, and a retry then finds that
 * nobody knows.
 */
export async function settlePost(env, me, key, res) {
  if (!usable(key)) {
    return;
  }
  try {
    const {
      ok, platform, id, thread, files, unknown,
    } = await res.clone().json();
    if (unknown) {
      return;
    }
    if (!res.ok) {
      await env.DB.prepare('DELETE FROM post_keys WHERE person = ? AND key = ?')
        .bind(me.id, key).run();
      return;
    }
    await env.DB.prepare('UPDATE post_keys SET answer = ? WHERE person = ? AND key = ?')
      .bind(JSON.stringify({
        ok, platform, id, thread, files,
      }), me.id, key).run();
  } catch (e) {
    console.log(JSON.stringify({ route: 'post', action: 'key', error: e.message }));
  }
}

/** Cron: a retry comes within minutes, and these are of no use after a day. */
export async function prunePostKeys(env, now = new Date()) {
  const before = new Date(now.getTime() - POST_KEY_HOURS * 3600 * 1000).toISOString();
  const res = await env.DB.prepare('DELETE FROM post_keys WHERE at < ?').bind(before).run();
  return { deleted: res.meta.changes };
}
