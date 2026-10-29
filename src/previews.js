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

import { parse } from './channels.js';
import { segment } from './raw.js';
import { previewOf } from './threads.js';

/**
 * The latest message's text of the threads indexed before messages had a preview (migration
 * 0035). The normalizer writes each message's preview as it files it; this fills in the threads
 * whose latest message came before that, the most recently active first, from that message's
 * file in pile 2. A thread is done once `last_text` is set ('' when the message has no text or
 * its file is gone), so the sweep stops finding any.
 */

/** Threads per cron run, and R2 reads at a time (a Worker may wait on six). */
export const PREVIEW_SWEEP = 300;
const AT_ONCE = 6;

/** The preview of the message `id` in folder `path`, '' when it has none; null on an error. */
async function previewFrom(env, path, id) {
  try {
    const obj = await env.CHANNELS.get(`${path}${segment(id)}.md`);
    const file = obj ? parse(await obj.text()) : null;
    return file && !file.meta.deletedAt ? previewOf(file.body) : '';
  } catch (e) {
    console.warn(JSON.stringify({ route: 'previews', path, error: String(e) }));
    return null;
  }
}

export async function sweepPreviews(env, { limit = PREVIEW_SWEEP } = {}) {
  if (!env.CHANNELS) {
    return { skipped: 'no CHANNELS bucket' };
  }
  const { results } = await env.DB.prepare(`SELECT thread, path, last_id FROM threads
    WHERE last_id IS NOT NULL AND last_text IS NULL
    ORDER BY COALESCE(last_at, any_at) DESC LIMIT ?`).bind(limit).all();
  const rows = results || [];
  const found = [];
  for (let i = 0; i < rows.length; i += AT_ONCE) {
    const part = rows.slice(i, i + AT_ONCE);
    // eslint-disable-next-line no-await-in-loop
    const texts = await Promise.all(part.map((r) => (r.path ? previewFrom(env, r.path, r.last_id) : '')));
    part.forEach((r, j) => {
      if (texts[j] != null) {
        found.push({ ...r, text: texts[j] });
      }
    });
  }
  if (found.length) {
    // Only where it is still missing, and only the message that is still the latest: one the
    // normalizer filed meanwhile has its own.
    await env.DB.batch(found.flatMap((r) => [
      env.DB.prepare(`UPDATE messages SET preview = ?
        WHERE thread = ? AND id = ? AND preview IS NULL`).bind(r.text, r.thread, r.last_id),
      env.DB.prepare(`UPDATE threads SET last_text = ?
        WHERE thread = ? AND last_id = ? AND last_text IS NULL`).bind(r.text, r.thread, r.last_id),
    ]));
  }
  return { filled: found.length, failed: rows.length - found.length };
}
