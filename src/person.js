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
 * An Adobe person, as their profile card in the inbox shows them besides what their account on
 * the thread's platform says (`GET /api/person`'s `person`, src/kbpeople.js): the same person
 * as on their team's overview (src/teamprofile.js), from the same numbers, so that the two cards
 * say the same (ui/person.js draws both):
 *
 * - who they are: the best name, picture and title of any of their accounts (src/personsql.js),
 *   and their ops teams, with their role on each;
 * - their profile on each of their teams: the description of their Contact in the team's
 *   knowledge base (`kb_concepts`, `contacts/<first-last>.md`), for whoever may read it;
 * - their work: how often they post, and what sets them apart, Clef's areas and technologies of
 *   their threads and the customers they post for the most, as their busiest team's overview
 *   counts them (kept a while there, `teamProfile`).
 *
 * Names, numbers, pictures and titles only: no message text and no mail address.
 */

import { access } from './kbaccess.js';
import { ADMIN_TEAM } from './roles.js';
import { CONTACTS, personSlug } from './agent/okf.js';
import { AVATAR, NAME, TITLE } from './personsql.js';
import { teamProfile } from './teamprofile.js';

/** The person `id`'s card, as `me` may see it, or null for someone who is not Adobe's. */
export async function personCard(env, me, id, { now = new Date() } = {}) {
  if (!id) {
    return null;
  }
  const db = env.DB;
  const [row, teams] = await Promise.all([
    db.prepare(`SELECT p.id, ${NAME('p.id')} AS name, ${AVATAR('p.id')} AS avatar,
        ${TITLE('p.id')} AS title, p.staff FROM people p WHERE p.id = ?`).bind(id).first(),
    db.prepare(`SELECT m.team AS slug, t.name, m.role,
        (SELECT COUNT(*) FROM threads h WHERE h.team = m.team) AS threads
      FROM team_members m JOIN teams t ON t.slug = m.team WHERE m.person = ?
      ORDER BY t.name`).bind(id).all().then((r) => r.results || []),
  ]);
  if (!row || (!row.staff && !teams.length)) {
    return null;
  }
  const slug = personSlug(row.name);
  const may = await access(env, me);
  const readable = teams.filter((t) => may.read({ kind: 'team', slug: t.slug }));
  const contacts = slug && readable.length ? await db.prepare(`SELECT repo, path, description
      FROM kb_concepts WHERE type = 'Contact' AND path = ?
        AND repo IN (SELECT value FROM json_each(?))`)
    .bind(`${CONTACTS}/${slug}.md`, JSON.stringify(readable.map((t) => `kb-team-${t.slug}`))).all()
    .then((r) => r.results || []) : [];
  const byRepo = new Map(contacts.map((c) => [c.repo, c]));
  const profiles = readable.flatMap((t) => {
    const c = byRepo.get(`kb-team-${t.slug}`);
    return c && c.description ? [{
      team: t.slug, teamName: t.name, repo: c.repo, path: c.path, description: c.description,
    }] : [];
  });
  // Their work as the overview of their busiest team counts it (the admin team's last).
  const busiest = [...teams].sort((a, b) => (a.slug === ADMIN_TEAM) - (b.slug === ADMIN_TEAM)
    || b.threads - a.threads)[0];
  let work = null;
  if (busiest) {
    const p = await teamProfile(env, me, busiest.slug, { now });
    const m = !p.error && p.members.find((x) => x.id === row.id);
    if (m) {
      work = {
        team: busiest.slug,
        weeks: p.weeks.length,
        messages: m.messages,
        threads: m.threads,
        weekly: m.weekly,
        last: m.last,
        areas: m.areas,
        tech: m.tech,
        customers: m.customers,
      };
    }
  }
  return {
    id: row.id,
    name: row.name || null,
    avatar: row.avatar || null,
    title: row.title || null,
    teams: teams.map((t) => ({ slug: t.slug, name: t.name, role: t.role })),
    profiles,
    work,
  };
}
