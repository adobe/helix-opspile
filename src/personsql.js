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
 * A person of D1 (`people`, alias `p`) as both their cards show them (src/person.js,
 * src/teamprofile.js): the best of what their platform accounts (`identities`) say, whichever
 * account is on screen. Each is SQL for a column, `person` the SQL of their id.
 */

/** SQL: a person's picture: their own account's, Slack's before Teams', Gravatar's last. */
export const AVATAR = (person) => `(SELECT COALESCE(i.display_avatar, i.avatar) FROM identities i
    WHERE i.person = ${person} AND i.kind = 'person' AND COALESCE(i.display_avatar, i.avatar) != ''
    ORDER BY COALESCE(i.display_avatar, i.avatar) LIKE '%gravatar.com/%',
      CASE i.source WHEN 'slack' THEN 0 WHEN 'teams' THEN 1 ELSE 2 END, i.fetched_at DESC LIMIT 1)`;

/** SQL: a person's job title, as a platform has it, Slack's first. */
export const TITLE = (person) => `(SELECT i.title FROM identities i WHERE i.person = ${person}
    AND i.title IS NOT NULL AND i.title != '' ORDER BY i.source = 'slack' DESC LIMIT 1)`;

/**
 * SQL: a person's name: a full one (with a space) first, theirs in D1 else an account's, then
 * a handle; else the start of their mail address (someone added who never posted).
 */
export const NAME = (person) => {
  const account = (full) => `(SELECT COALESCE(i.display_name, i.name) FROM identities i
    WHERE i.person = ${person} AND COALESCE(i.display_name, i.name) ${full ? "LIKE '% %'" : "!= ''"}
    ORDER BY i.source = 'slack' DESC LIMIT 1)`;
  return `COALESCE(CASE WHEN p.name LIKE '% %' THEN p.name END, ${account(true)}, NULLIF(p.name, ''),
    ${account(false)}, SUBSTR(p.email, 1, INSTR(p.email, '@') - 1))`;
};
