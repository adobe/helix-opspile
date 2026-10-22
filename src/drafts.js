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
import { notifyRoom } from './notify.js';

/**
 * Shared drafts: an inbox entry carries at most one unsent reply, which everyone in the team
 * that owns the channel sees and can change, send or discard. A draft is keyed by the entry
 * (a re-threaded group's first thread), and its `updated_at` is its version: a save or a
 * discard names the version it starts from, so nobody overwrites a colleague's newer draft
 * without seeing it first.
 */

const MAX_TEXT = 8000;
const MAX_MENTIONS = 20;
const PREVIEW = 140;

/** The entry a thread key belongs to: its key, team, and every member thread. */
export async function entryOf(env, key) {
  const row = key && await env.DB.prepare('SELECT thread, team, logical_thread FROM threads WHERE thread = ?')
    .bind(String(key)).first();
  if (!row) {
    return null;
  }
  const k = row.logical_thread || row.thread;
  const { results } = await env.DB.prepare('SELECT thread FROM threads WHERE thread = ? OR logical_thread = ?')
    .bind(k, k).all();
  return {
    key: k,
    team: row.team,
    keys: [...new Set([k, row.thread, ...(results || []).map((r) => r.thread)])],
  };
}

const mentionsOf = (raw) => {
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
};

const shape = (r) => ({
  thread: r.thread,
  body: r.body,
  mentions: mentionsOf(r.mentions),
  by: { id: r.person, name: r.name || null },
  created_at: r.created_at,
  updated_at: r.updated_at,
});

/** The drafts on any of these threads, keyed by thread. */
export async function draftsFor(env, keys) {
  const list = [...new Set(keys || [])];
  if (!list.length) {
    return new Map();
  }
  const { results } = await env.DB.prepare(`SELECT d.*, p.name FROM drafts d
    LEFT JOIN people p ON p.id = d.person
    WHERE d.thread IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(list)).all();
  return new Map((results || []).map((r) => [r.thread, shape(r)]));
}

/** The newest draft on any of these threads (an entry has one, unless groups changed). */
export function draftOf(drafts, keys) {
  return keys.map((k) => drafts.get(k)).filter(Boolean)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
}

/** What the inbox list needs: who, when, and the start of the text. */
export const draftSummary = (d) => d && ({
  by: d.by,
  updated_at: d.updated_at,
  preview: d.body.length > PREVIEW ? `${d.body.slice(0, PREVIEW - 1)}…` : d.body,
});

const conflict = (current) => json({
  error: `${current.by.name || 'Someone'} changed this draft meanwhile`,
  conflict: true,
  draft: current,
}, 409);

/** Picked @-mentions as the composer sends them to /api/post: `{ id, name }`. */
const cleanMentions = (list) => (Array.isArray(list) ? list : [])
  .filter((m) => m && m.id && m.name)
  .slice(0, MAX_MENTIONS)
  .map((m) => ({ id: String(m.id).slice(0, 100), name: String(m.name).slice(0, 200) }));

/** A version that sorts after the one it replaces, even within the same millisecond. */
function nextVersion(previous) {
  const now = new Date();
  if (previous && now.toISOString() <= previous) {
    return new Date(Date.parse(previous) + 1).toISOString();
  }
  return now.toISOString();
}

/**
 * GET /api/draft?thread=…: the entry's draft, or null.
 */
export async function getDraft(env, key, canSee) {
  const e = await entryOf(env, key);
  if (!e || !canSee(e.team)) {
    return json({ error: 'not found' }, 404);
  }
  return json({ draft: draftOf(await draftsFor(env, e.keys), e.keys) });
}

/**
 * PUT /api/draft `{ thread, text, mentions?, base }`: saves the entry's draft as the
 * signed-in person. `base` is the `updated_at` of the draft the text was written from (null
 * if there was none); if the draft is no longer that version, nothing is saved and the
 * answer is 409 with the current draft.
 */
export async function saveDraft(env, me, request, inTeam) {
  const {
    thread: key, text, mentions, base = null,
  } = request || {};
  const body = String(text || '');
  if (!body.trim() || body.length > MAX_TEXT) {
    return json({ error: 'write something to save (up to 8000 characters)' }, 400);
  }
  const e = await entryOf(env, key);
  if (!e || !inTeam(e.team)) {
    return json({ error: 'not found' }, 404);
  }
  const current = draftOf(await draftsFor(env, e.keys), e.keys);
  if (current && current.updated_at !== base) {
    return conflict(current);
  }
  const version = nextVersion(current && current.updated_at);
  const picked = JSON.stringify(cleanMentions(mentions));
  let changes;
  if (current && current.thread === e.key) {
    ({ meta: { changes } } = await env.DB.prepare(`UPDATE drafts SET body = ?, mentions = ?,
        person = ?, updated_at = ? WHERE thread = ? AND updated_at = ?`)
      .bind(body, picked, me.id, version, e.key, current.updated_at).run());
  } else {
    // A draft saved under a thread that has since been folded into a group moves to the
    // group's key.
    if (current) {
      await env.DB.prepare('DELETE FROM drafts WHERE thread = ? AND updated_at = ?')
        .bind(current.thread, current.updated_at).run();
    }
    ({ meta: { changes } } = await env.DB.prepare(`INSERT INTO drafts (thread, body, mentions,
        person, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (thread) DO NOTHING`)
      .bind(e.key, body, picked, me.id, (current && current.created_at) || version, version).run());
  }
  if (!changes) {
    // Somebody else saved in between.
    return conflict(draftOf(await draftsFor(env, e.keys), e.keys) || current);
  }
  // At most one draft per entry.
  await env.DB.prepare(`DELETE FROM drafts WHERE thread IN (SELECT value FROM json_each(?))
    AND thread != ?`).bind(JSON.stringify(e.keys), e.key).run();
  await notifyRoom(env, e.team, { type: 'draft', thread: e.key });
  const draft = draftOf(await draftsFor(env, [e.key]), [e.key]);
  return json({ ok: true, draft });
}

/**
 * DELETE /api/draft `{ thread, base? }`: discards the entry's draft. With `base`, only that
 * version: a colleague's newer draft is kept (409). Sending a reply uses this too.
 */
export async function discardDraft(env, me, request, inTeam) {
  const { thread: key, base = null } = request || {};
  const e = await entryOf(env, key);
  if (!e || !inTeam(e.team)) {
    return json({ error: 'not found' }, 404);
  }
  const current = draftOf(await draftsFor(env, e.keys), e.keys);
  if (!current) {
    return json({ ok: true, discarded: false });
  }
  if (base && current.updated_at !== base) {
    return conflict(current);
  }
  const { meta: { changes } } = await env.DB.prepare(`DELETE FROM drafts
    WHERE thread IN (SELECT value FROM json_each(?)) AND (? IS NULL OR updated_at = ?)`)
    .bind(JSON.stringify(e.keys), base, base).run();
  if (changes) {
    await notifyRoom(env, e.team, { type: 'draft', thread: e.key });
  }
  return json({ ok: true, discarded: Boolean(changes), draft: current });
}
