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

import { accessEmail } from './access.js';
import { parse } from './channels.js';
import { json, text } from './http.js';
import {
  ANSWERS, effectiveLabel, isAdmin, reviewQueue, reviewsFor, reviewStats, submitReview,
} from './review.js';
import { readState } from './threads.js';

/**
 * The inbox API behind Cloudflare Access. Every request is tied to a person in D1 by the
 * verified Access email, and sees only the threads of the teams that person is in.
 */

const INBOX_LIMIT = 200;

export async function viewer(request, env, options) {
  const email = await accessEmail(request, env, options);
  if (!email) {
    return null;
  }
  const person = await env.DB.prepare('SELECT id, name, email FROM people WHERE email = ?')
    .bind(email).first();
  if (!person) {
    return null;
  }
  const { results } = await env.DB.prepare(`SELECT t.slug, t.name FROM team_members m
    JOIN teams t ON t.slug = m.team WHERE m.person = ? ORDER BY t.slug`).bind(person.id).all();
  const teams = results || [];
  return { ...person, teams, admin: teams.some((t) => t.slug === 'admin') };
}

const inTeam = (me, team) => me.teams.some((t) => t.slug === team);

async function members(env, team) {
  const { results } = await env.DB.prepare(`SELECT p.id, p.name FROM team_members m
    JOIN people p ON p.id = m.person WHERE m.team = ? ORDER BY p.name`).bind(team).all();
  return results || [];
}

export async function inbox(env, me, team) {
  const { results: threads } = await env.DB.prepare(`SELECT thread, source, org, team, kind,
      channel_name, title, root_at, last_at, last_author, last_staff, any_at, messages,
      root_at IS NOT NULL AS root_known
    FROM threads WHERE team = ? AND kind != 'ignore'
    ORDER BY COALESCE(last_at, any_at) DESC LIMIT ?`).bind(team, INBOX_LIMIT).all();
  if (!threads.length) {
    return { team, members: await members(env, team), threads: [] };
  }
  const keys = JSON.stringify(threads.map((t) => t.thread));
  // Watermarks of every staff member (for "nobody at Adobe has seen it") and of the team.
  const { results: marks } = await env.DB.prepare(`SELECT w.person, w.thread, w.read_at,
      p.staff, EXISTS (SELECT 1 FROM team_members m WHERE m.person = w.person AND m.team = ?)
        AS in_team
    FROM watermarks w JOIN people p ON p.id = w.person
    WHERE w.thread IN (SELECT value FROM json_each(?))
      AND (p.staff = 1 OR EXISTS (
        SELECT 1 FROM team_members m WHERE m.person = w.person AND m.team = ?))`)
    .bind(team, keys, team).all();
  const { results: mentions } = await env.DB.prepare(`SELECT n.thread, n.person, n.at
    FROM mentions n JOIN team_members m ON m.person = n.person AND m.team = ?
    JOIN messages x ON x.source || ':' || x.tenant || ':' || x.channel_id || ':' || x.id = n.message
    WHERE n.thread IN (SELECT value FROM json_each(?)) AND x.deleted = 0`)
    .bind(team, keys).all();
  const { results: labels } = await env.DB.prepare(`SELECT thread, next_actor, next_actor_p,
      kind AS label_kind, kind_p, urgency, resolved_p, labeled_through FROM labels
    WHERE thread IN (SELECT value FROM json_each(?))`).bind(keys).all();
  const reviews = await reviewsFor(env.DB, (labels || []).map((l) => l.thread));
  const labelBy = new Map((labels || []).map((l) => [
    l.thread, effectiveLabel(l, reviews.filter((r) => r.thread === l.thread)),
  ]));
  return {
    team,
    members: await members(env, team),
    threads: readState(threads, marks || [], mentions || [], me.id)
      .map((t) => ({ ...t, label: labelBy.get(t.thread) || null })),
  };
}

export async function thread(env, me, key) {
  const row = await env.DB.prepare('SELECT * FROM threads WHERE thread = ?').bind(key).first();
  if (!row || !(inTeam(me, row.team) || isAdmin(me))) {
    return null;
  }
  const listed = await env.CHANNELS.list({ prefix: row.path });
  const files = await Promise.all(listed.objects.map(async (o) => {
    const obj = await env.CHANNELS.get(o.key);
    return obj ? parse(await obj.text()) : null;
  }));
  const messages = files.filter(Boolean)
    .map(({ meta, body }) => ({ ...meta, body }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const { results: marks } = await env.DB.prepare(`SELECT w.person, w.read_at, w.via
    FROM watermarks w JOIN team_members m ON m.person = w.person AND m.team = ?
    WHERE w.thread = ?`).bind(row.team, key).all();
  const model = await env.DB.prepare('SELECT * FROM labels WHERE thread = ?').bind(key).first();
  const reviews = isAdmin(me) ? (await env.DB.prepare(`SELECT r.question, r.model_value, r.value,
      r.agrees, r.labeled_through, r.note, r.created_at, p.name AS reviewer
    FROM label_reviews r JOIN people p ON p.id = r.reviewer
    WHERE r.thread = ? ORDER BY r.created_at DESC`).bind(key).all()).results || [] : [];
  const label = effectiveLabel(model, model ? await reviewsFor(env.DB, [key]) : []);
  const { results: facts } = await env.DB.prepare(`SELECT source, field, value, confidence
    FROM facts WHERE thread = ? ORDER BY field, value`).bind(key).all();
  return {
    thread: row, messages, watermarks: marks || [], label, model, reviews, facts: facts || [],
  };
}

function room(env, team) {
  return env.ROOMS.get(env.ROOMS.idFromName(team));
}

/** Routes `/api/*`. Returns null for paths it does not own. */
export async function api(request, env, url, { viewer: injected } = {}) {
  if (!url.pathname.startsWith('/api/')) {
    return null;
  }
  // `viewer` can be injected by tests; in the Worker it always comes from Access.
  const me = injected || await viewer(request, env);
  if (!me) {
    return json({ error: 'not signed in, or not a member of any team' }, 403);
  }
  const team = url.searchParams.get('team');

  if (url.pathname === '/api/me') {
    return json(me);
  }
  if (url.pathname === '/api/inbox') {
    if (!inTeam(me, team)) {
      return json({ error: 'not a member of this team' }, 403);
    }
    return json(await inbox(env, me, team));
  }
  if (url.pathname === '/api/thread') {
    const result = await thread(env, me, url.searchParams.get('thread'));
    return result ? json(result) : json({ error: 'not found' }, 404);
  }
  if (url.pathname.startsWith('/api/review')) {
    if (!isAdmin(me)) {
      return json({ error: 'label review is for the admin team' }, 403);
    }
    if (url.pathname === '/api/review/queue') {
      return json({ answers: ANSWERS, queue: await reviewQueue(env.DB) });
    }
    if (url.pathname === '/api/review/stats') {
      return json({ stats: await reviewStats(env.DB) });
    }
    if (url.pathname === '/api/review' && request.method === 'POST') {
      const result = await submitReview(env.DB, me, await request.json().catch(() => ({})));
      return json(result, result.error ? 400 : 200);
    }
    return json({ error: 'not found' }, 404);
  }
  if (url.pathname === '/api/read' && request.method === 'POST') {
    const { thread: key, at } = await request.json().catch(() => ({}));
    const row = key && await env.DB.prepare('SELECT team FROM threads WHERE thread = ?')
      .bind(key).first();
    if (!row || !inTeam(me, row.team) || typeof at !== 'string') {
      return json({ error: 'not found' }, 404);
    }
    await room(env, row.team).fetch('https://room/read', {
      method: 'POST',
      body: JSON.stringify({ person: me.id, thread: key, at }),
    });
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/api/live') {
    if (!inTeam(me, team) || request.headers.get('upgrade') !== 'websocket') {
      return text('expected a websocket for one of your teams\n', 400);
    }
    const headers = new Headers(request.headers);
    headers.set('x-opspile-person', String(me.id));
    return room(env, team).fetch(new Request('https://room/connect', { headers }));
  }
  return json({ error: 'not found' }, 404);
}
