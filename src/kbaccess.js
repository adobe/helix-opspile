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
 * Who may look at and who may change a knowledge base (`{ kind, slug }`), its agents' MCP
 * servers and tools, on its team's or customer's page (ui/agent.js):
 *
 * - a team's (`kind: 'team'`): the members of every ops team look (as every thread agent
 *   reads it, src/agent/repos.js), its managers change it;
 * - a customer's (`kind: 'org'`): the members of every ops team look too, as they see the
 *   customer's page (ui/admin.js), and the managers of the teams that own the customer (a
 *   channel of the customer's is filed under or shared with the team, src/shares.js) change it;
 * - the admin team looks at and changes all of them.
 *
 * Its files, but `systemprompt.md` (the agents' instructions, `mayEdit`'s), are written by more
 * (`mayWrite`): everyone on the team, a team's for its own, the owning teams' for a customer's,
 * in the editor and through its agent's sidebar (src/kbchat.js), where whoever looks may talk;
 * for anyone else who looks, the agent there answers but changes nothing.
 */

import { isAdmin, managedTeams, managesTeam } from './roles.js';
import { ownedCustomers, ownsCustomer } from './shares.js';

const teamsOf = (me) => ((me && me.teams) || []).map((t) => t.slug);

/** Whether `me` is in an ops team at all (or the admin team): who looks at every one. */
const inAnyTeam = (me) => isAdmin(me) || teamsOf(me).length > 0;

/** Whether `me` may change the knowledge base (or the servers) of `kind`/`slug`. */
export async function mayEdit(env, me, { kind, slug }) {
  if (isAdmin(me)) {
    return true;
  }
  return kind === 'team' ? managesTeam(me, slug) : ownsCustomer(env, managedTeams(me), slug);
}

/**
 * Whether `me` may write the files of the knowledge base of `kind`/`slug` (not its
 * `systemprompt.md`, see `mayEdit`): the admin team, a team's members and managers, and the
 * members of the teams that own a customer.
 */
export async function mayWrite(env, me, { kind, slug }) {
  if (isAdmin(me)) {
    return true;
  }
  return kind === 'team' ? teamsOf(me).includes(slug) || managesTeam(me, slug)
    : ownsCustomer(env, teamsOf(me), slug);
}

/**
 * Whether `me` may look at a knowledge base (or its servers), a team's or a customer's alike:
 * every ops team's members and the admin team. It takes the base (`{ kind, slug }`) as the others.
 */
export async function mayRead(env, me) {
  return inAnyTeam(me);
}

/**
 * All three, for many knowledge bases at once: `{ read(base), edit(base), write(base) }`,
 * answered without a query each (the customers `me`'s teams own are read once).
 */
export async function access(env, me) {
  if (isAdmin(me)) {
    return { read: () => true, edit: () => true, write: () => true };
  }
  const managed = managedTeams(me);
  const [owned, ownedManaged] = await Promise.all([
    ownedCustomers(env, teamsOf(me)),
    ownedCustomers(env, managed),
  ]);
  const looks = inAnyTeam(me);
  return {
    read: () => looks,
    edit: (b) => (b.kind === 'team' ? managesTeam(me, b.slug) : ownedManaged.has(b.slug)),
    write: (b) => (b.kind === 'team' ? teamsOf(me).includes(b.slug) || managesTeam(me, b.slug)
      : owned.has(b.slug)),
  };
}
