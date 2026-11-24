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

import { CONTACTS, personSlug } from './okf.js';

/**
 * The members of an agent's ops team, for its prompt (src/agent/tools.js, `team-members`): each
 * has a Contact in kb-team, their profile on the team (docs/ARCHITECTURE.md, "Layout"), which the
 * agents keep, and the inbox's people cards show. Listed with the path of theirs, and whether it
 * is there yet (`kb_concepts`), the busiest first, so that the agent knows whose to start or
 * update when a thread shows what a member does. No addresses: names only.
 */

/** Members listed, at most. */
export const MAX_LISTED = 40;
/** Their messages of this many days put them in order. */
const DAYS = 90;

/** `[{ name, role, path, has, messages }]` of team `team`, the busiest first; [] for none. */
export async function teamMembers(env, team, { now = new Date() } = {}) {
  if (!team) {
    return [];
  }
  const since = new Date(now.getTime() - DAYS * 86400000).toISOString();
  const [{ results: people }, { results: concepts }] = await Promise.all([
    env.DB.prepare(`SELECT p.id, COALESCE(CASE WHEN p.name LIKE '% %' THEN p.name END,
        (SELECT COALESCE(i.display_name, i.name) FROM identities i WHERE i.person = p.id
          AND COALESCE(i.display_name, i.name) LIKE '% %' ORDER BY i.source = 'slack' DESC LIMIT 1),
        p.name) AS name, m.role,
        (SELECT COUNT(*) FROM messages g WHERE g.person = p.id AND g.at >= ? AND g.deleted = 0
          AND g.counted = 1) AS messages
      FROM team_members m JOIN people p ON p.id = m.person WHERE m.team = ?`).bind(since, team).all(),
    env.DB.prepare('SELECT path FROM kb_concepts WHERE repo = ? AND type = \'Contact\'')
      .bind(`kb-team-${team}`).all(),
  ]);
  const have = new Set((concepts || []).map((c) => c.path));
  return (people || []).filter((p) => personSlug(p.name))
    .map((p) => {
      const path = `${CONTACTS}/${personSlug(p.name)}.md`;
      return {
        name: p.name, role: p.role, path, has: have.has(path), messages: p.messages || 0,
      };
    })
    .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));
}

/** The prompt's section of them (the first MAX_LISTED), or '' for a team without members. */
export function teamMembersText(all) {
  const members = all.slice(0, MAX_LISTED);
  const total = all.length;
  if (!members.length) {
    return '';
  }
  const missing = members.filter((m) => !m.has).length;
  const lines = members.map((m) => `- ${m.name}${m.role === 'manager' ? ' (manager)' : ''}: kb-team ${m.path}${m.has ? '' : ', not written yet'}`);
  return [
    `Your ops team's members, the busiest first${total > members.length ? ` (${members.length} of ${total})` : ''}. Each has a Contact in kb-team, their profile on the team; ${missing ? `${missing} of these have none yet` : 'every one of these has one'}.`,
    ...lines,
  ].join('\n');
}
