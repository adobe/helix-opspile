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

import { createMemberRequest } from '../memberrequests.js';

/**
 * A request to add someone to an ops team: the thread agent's `request_team_membership`
 * (src/agent/tools.js). The request is a membership request (src/memberrequests.js, migration
 * 0096): an admin or one of the team's managers confirms or declines it, under Requests or on the
 * team's page. As `request_channel_reassignment` (src/agent/channelrequest.js), the agent files
 * one only while it answers a sidebar message, for the person who wrote it: the sidebar is
 * trusted, and the thread's messages, which customers write, cannot get anyone onto a team.
 */

const MAX_NAMES = 5;

/**
 * Who is meant: `{ email, name }`, or `{ error }`. With an `email`, that address; without one,
 * the person who asked (`asker`) when `name` is left out or is theirs, else the one person the
 * inbox knows by exactly that name (several, or nobody: the agent asks for the address).
 */
export async function personOf(env, asker, { email, name }) {
  const mail = String(email || '').trim().toLowerCase();
  const asked = String(name || '').trim();
  if (mail) {
    return { email: mail, name: asked || null };
  }
  if (!asked || asked.toLowerCase() === String(asker.name || '').toLowerCase()) {
    return { email: asker.email.toLowerCase(), name: asker.name || null };
  }
  const { results } = await env.DB.prepare(`SELECT LOWER(email) AS email, MAX(name) AS name FROM (
      SELECT email, name FROM people WHERE email IS NOT NULL AND LOWER(name) = LOWER(?1)
      UNION SELECT email, name FROM identities WHERE kind = 'person' AND email IS NOT NULL
        AND LOWER(name) = LOWER(?1))
    GROUP BY LOWER(email) ORDER BY 1 LIMIT ?2`).bind(asked, MAX_NAMES + 1).all();
  const found = results || [];
  if (found.length === 1) {
    return found[0];
  }
  if (found.length) {
    return { error: `several people are called ${asked} (${found.slice(0, MAX_NAMES).map((p) => p.email).join(', ')}): give the email address of the one meant` };
  }
  return { error: `the inbox knows nobody called ${asked} with an email address: give theirs, as the person who asked writes it` };
}

/**
 * Files a request to add a person to `team`, for `asker` (`sidebarAuthor`), with `note`;
 * `t` is the agent's target (its `key`, the thread whose sidebar asked). `{ request }`, or
 * `{ error, request? }` (the open one that asks the same).
 */
export async function requestTeamMembership(env, t, asker, {
  team, email, name, note,
}) {
  const who = await personOf(env, asker, { email, name });
  if (who.error) {
    return who;
  }
  const res = await createMemberRequest(env, asker, {
    team, email: who.email, name: who.name, note, thread: t.key || null,
  });
  return res.error ? { error: res.error, request: res.request || null } : { request: res.request };
}
