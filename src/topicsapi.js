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
 * The Topics page's API, for every internal user: the members of the ops teams, and Adobe's
 * people on none (docs/ARCHITECTURE.md, "Topic maps"):
 *
 * - `GET /api/topics`: the newest topic map, every team's areas (src/areas.js), what the viewer
 *   follows, every team's name, and what they may change: the areas of which teams
 *   (`may.areas`), and a rebuild.
 * - `POST /api/topics`: builds a map now, for the admin team and team managers, and the topics of
 *   the first of the threads it does not have (the cron finds the rest).
 * - `GET /api/topics/trends`: what the page's trends count (src/trends.js `trendsData`), kept a
 *   few minutes; `GET /api/topics/trends/match?term=` the threads a word or a phrase (`~…`) is in
 *   or about; `GET /api/topics/trends/threads?ids=` some of the threads, to list them.
 * - `POST /api/areas { team, id, title, what }`, `PUT /api/areas { team, id, title?, what?,
 *   enabled? }`, `DELETE /api/areas { team, id }`: an area of `team`'s knowledge base, as a file
 *   at `areas/<id>.md` written as the viewer (the admin team any team's, a manager their teams').
 *   A rename is a new title: the id, and the labels that have it, stay.
 */

import { readText } from './agent/repos.js';
import { writeKnowledge } from './agent/kbwrite.js';
import { areaFile, AREAS } from './areas.js';
import { scalar, splitFrontmatter } from './agent/okf.js';
import { json } from './http.js';
import { underlying } from './d1batch.js';
import { ADMIN_TEAM, isAdmin, managedTeams } from './roles.js';
import { buildTopicMap, latestTopicMap } from './topicmap.js';
import {
  assignPending, matchTerm, trendsData, trendThreads,
} from './trends.js';

const ID = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * How long GET /api/topics/trends is kept, per database (the binding, not the wrappers each
 * request puts it in, src/d1batch.js `underlying`): it reads every thread of a year.
 */
export const TRENDS_TTL_MS = 5 * 60000;
const trendsCache = new WeakMap();

/** The teams whose areas `me` may change: every team for the admin team, else those they manage. */
async function areaTeams(env, me) {
  if (isAdmin(me)) {
    const { results } = await env.DB.prepare('SELECT slug FROM teams ORDER BY slug = ? DESC, slug')
      .bind(ADMIN_TEAM).all();
    return (results || []).map((r) => r.slug);
  }
  return managedTeams(me);
}

/** Every team's areas, as the page lists them. */
async function allAreas(env) {
  const { results } = await env.DB.prepare(`SELECT team, id, name, what, enabled, path, changed_by,
      changed_at FROM areas ORDER BY id, team = ? DESC, team`).bind(ADMIN_TEAM).all();
  return (results || []).map((r) => ({
    team: r.team,
    id: r.id,
    name: r.name,
    what: r.what,
    enabled: Boolean(r.enabled),
    path: r.path,
    by: r.changed_by || null,
    at: r.changed_at || null,
  }));
}

/** GET /api/topics. `follows` is the viewer's, as GET /api/follows answers it. */
export async function topicsPage(env, me, follows) {
  const [latest, areas, teams, names, memberships] = await Promise.all([
    latestTopicMap(env), allAreas(env), areaTeams(env, me),
    env.DB.prepare('SELECT slug, name FROM teams ORDER BY slug').all(),
    env.DB.prepare('SELECT person, team FROM team_members ORDER BY person, team').all(),
  ]);
  const members = {};
  for (const m of memberships.results || []) {
    (members[m.person] ||= []).push(m.team);
  }
  return json({
    latest,
    available: Boolean(env.CONTENT && env.AI),
    areas,
    // Every team's name: the map's people are grouped by theirs (ui/topicgraph.js).
    teams: Object.fromEntries((names.results || []).map((t) => [t.slug, t.name || t.slug])),
    // The teams each Adobe person is on now, so a person is in a team bubble only when on it.
    members,
    follows,
    may: { areas: teams, rebuild: teams.length > 0 },
  });
}

/** POST /api/topics: a map now, for whoever may change areas. */
export async function rebuildTopics(env, me) {
  if (!(await areaTeams(env, me)).length) {
    return json({ error: 'the admin team and team managers build the topic map' }, 403);
  }
  const built = await buildTopicMap(env, { by: (me && me.name) || 'someone' });
  if (built.error) {
    return json({ error: built.error }, env.CONTENT && env.AI ? 400 : 503);
  }
  await assignPending(env);
  trendsCache.delete(underlying(env.DB));
  return json({ latest: await latestTopicMap(env), available: true });
}

/** /api/topics/trends…, for every internal user (src/api.js checks). */
export async function trendsApi(env, me, request, url) {
  const { pathname } = url;
  if (pathname === '/api/topics/trends' && request.method === 'GET') {
    const hit = trendsCache.get(underlying(env.DB));
    if (hit && Date.now() - hit.at < TRENDS_TTL_MS && url.searchParams.get('fresh') !== '1') {
      return json(hit.body);
    }
    const body = await trendsData(env);
    trendsCache.set(underlying(env.DB), { at: Date.now(), body });
    return json(body);
  }
  if (request.method !== 'GET') {
    return json({ error: 'GET' }, 405);
  }
  if (pathname === '/api/topics/trends/match') {
    const found = await matchTerm(env, url.searchParams.get('term'));
    return found.error ? json({ error: found.error }, found.status || 400) : json(found);
  }
  if (pathname === '/api/topics/trends/threads') {
    return json({ threads: await trendThreads(env, (url.searchParams.get('ids') || '').split(',')) });
  }
  return json({ error: 'not found' }, 404);
}

const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** POST, PUT or DELETE /api/areas: an area of a team's knowledge base, written as `me`. */
export async function changeArea(env, me, method, body) {
  const team = clean(body.team, 64);
  const id = clean(body.id, 40).toLowerCase();
  if (!(await areaTeams(env, me)).includes(team)) {
    return json({ error: 'the admin team changes every team\'s areas, a team\'s managers their team\'s' }, 403);
  }
  if (!ID.test(id)) {
    return json({ error: 'an area\'s id is lower case letters, digits and -, at most 40' }, 400);
  }
  if (!env.ARTIFACTS) {
    return json({ error: 'knowledge bases are not configured' }, 503);
  }
  const repo = `kb-team-${team}`;
  const path = `${AREAS}/${id}.md`;
  const file = await readText(env, repo, path, { full: true }).catch(() => ({ error: 'unreadable' }));
  const exists = !file.error;
  let change;
  let what;
  if (method === 'POST') {
    if (exists) {
      return json({ error: `${team} has an area ${id} already: change it` }, 409);
    }
    const title = clean(body.title, 80);
    const question = clean(body.what, 500);
    if (!title || !question) {
      return json({ error: 'an area has a title and what Clef is asked ("Is this thread about …?")' }, 400);
    }
    change = { path, content: areaFile({ title, what: question }), create: true };
    what = `Add the area ${title}`;
  } else if (method === 'PUT' || method === 'DELETE') {
    if (!exists) {
      return json({ error: `${team} has no area ${id}` }, 404);
    }
    if (method === 'DELETE') {
      change = { path, delete: true, base: file.hash };
      what = `Delete the area ${id}`;
    } else {
      const fm = splitFrontmatter(file.text);
      const old = fm ? fm.yaml : '';
      const title = body.title === undefined ? scalar(old, 'title') : clean(body.title, 80);
      const question = body.what === undefined ? scalar(old, 'description') : clean(body.what, 500);
      const enabled = body.enabled === undefined ? !/^(false|no|off)$/i.test(scalar(old, 'enabled') || '')
        : Boolean(body.enabled);
      if (!title || !question) {
        return json({ error: 'an area has a title and what Clef is asked' }, 400);
      }
      change = {
        path, content: areaFile({ title, what: question, enabled }, fm ? fm.body.trim() : ''), base: file.hash,
      };
      what = `Change the area ${id}`;
    }
  } else {
    return json({ error: 'POST, PUT or DELETE' }, 405);
  }
  const res = await writeKnowledge(env, repo, [change], {
    message: `${what}\n\nOpspile-Editor: ${me.name || me.email}`,
    by: `human:${me.email}`,
    author: { name: me.name || me.email, email: me.email },
    logEntry: `**Update**: ${what} (${me.name || me.email})`,
    staff: true,
  });
  if (res.error || res.conflict) {
    return json({ error: res.error || res.conflict }, res.conflict ? 409 : 400);
  }
  return json({ ok: true, commit: res.commit || null, areas: await allAreas(env) });
}
