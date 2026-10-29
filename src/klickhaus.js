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

/*
 * Stats: klickhaus' view (opspile.html) over the messages opspile exports to ClickHouse, linked
 * from the header. Only some teams have klickhaus users, so the link is theirs alone.
 */

/** The ops teams (slugs) whose members get the link: KLICKHAUS_TEAMS, comma-separated. */
const statsTeams = (env) => String(env.KLICKHAUS_TEAMS || '').split(',')
  .map((t) => t.trim()).filter(Boolean);

/** klickhaus' opspile page, from KLICKHAUS_URL (its origin, or a path under it), or null. */
function statsPage(env) {
  const base = String(env.KLICKHAUS_URL || '').trim();
  if (!base) {
    return null;
  }
  try {
    const u = new URL('opspile.html', base.endsWith('/') ? base : `${base}/`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The Stats link for `me` (as /api/me says it: `{ url }`), or null: only with KLICKHAUS_URL
 * and KLICKHAUS_TEAMS set, and only for a member of one of those teams. The admin team is not
 * exempt, since only those teams have klickhaus users; viewing as someone, it is theirs.
 */
export function statsFor(env, me) {
  const url = statsPage(env);
  const teams = statsTeams(env);
  if (!url || !teams.length || !(me?.teams || []).some((t) => teams.includes(t.slug))) {
    return null;
  }
  return { url };
}
