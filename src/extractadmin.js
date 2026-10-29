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

import {
  config, deleteRule, deleteTech, saveRule, saveTech, testRule,
} from './extract.js';
import { json } from './http.js';
import { ownerOf } from './mcpadmin.js';

/**
 * The Agents page's API for a team's extraction rules and tech stack (src/extract.js), behind
 * `/api/kb/extraction`, for a team's knowledge base:
 *
 * - `GET ?repo=` the team's rules and technologies, and the admin team's, which apply too.
 * - `POST /rule { repo, id?, … }` adds a rule, or changes rule `id`; `DELETE /rule { repo, id }`.
 * - `POST /tech { repo, tech, name, description, enabled }` adds or changes a technology;
 *   `DELETE /tech { repo, tech }`.
 * - `POST /test { repo, rule, text }` what a rule, saved or not, finds in `text`.
 *
 * The members of a team see them; the admin team and the team's managers change them. A
 * change applies from the next labeling of a thread (src/label.js).
 */

const PATH = '/api/kb/extraction';
const by = (me) => me.name || me.email || String(me.id);
const out = (r) => (r.error ? json({ error: r.error }, r.status || 400) : json({ ok: true, ...r }));

/** Routes `/api/kb/extraction*`; null for other paths. */
export async function extractionAdmin(request, env, url, me) {
  if (url.pathname !== PATH && !url.pathname.startsWith(`${PATH}/`)) {
    return null;
  }
  const body = request.method === 'GET' ? {} : await request.json().catch(() => ({}));
  const repo = request.method === 'GET' ? url.searchParams.get('repo') : body.repo;
  const reader = await ownerOf(env, me, repo, { read: true });
  if (!reader || reader.scope !== 'team') {
    return json({ error: 'no such team knowledge base' }, 404);
  }
  const team = reader.slug;
  if (url.pathname === PATH && request.method === 'GET') {
    const editor = await ownerOf(env, me, repo);
    return json({ repo, ...await config(env, team), may: Boolean(editor) });
  }
  // Testing changes nothing, but runs scripts: for those who may change the rules, too.
  if (!await ownerOf(env, me, repo)) {
    return json({ error: 'the admin team and the team\'s managers change its rules' }, 403);
  }
  const action = `${request.method} ${url.pathname.slice(PATH.length)}`;
  let res;
  if (action === 'POST /rule') {
    res = await saveRule(env, team, body, by(me));
  } else if (action === 'DELETE /rule') {
    res = await deleteRule(env, team, body.id);
  } else if (action === 'POST /tech') {
    res = await saveTech(env, team, body, by(me));
  } else if (action === 'DELETE /tech') {
    res = await deleteTech(env, team, body.tech);
  } else if (action === 'POST /test') {
    return out(await testRule(env, body.rule || {}, { text: String(body.text || '').slice(0, 100000) }));
  } else {
    return json({ error: 'not found' }, 404);
  }
  if (!res.error) {
    console.log(JSON.stringify({
      route: 'kb', action: `extraction ${action}`, team, by: me.id,
    }));
  }
  return out(res);
}
