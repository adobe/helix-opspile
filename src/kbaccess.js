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
 * - every one is looked at by whoever sees its team's or customer's page (ui/admin.js): every
 *   internal user (`isInternal`), on an ops team or not, as every thread agent reads them
 *   (src/agent/repos.js); not someone signed in from SIGNIN_DOMAINS who is not Adobe's;
 * - a team's (`kind: 'team'`) is changed by its managers;
 * - a customer's (`kind: 'org'`) by the managers of the teams that own the customer (a channel
 *   of the customer's is filed under or shared with the team, src/shares.js);
 * - the admin team changes all of them.
 *
 * Its files, but `systemprompt.md` (the agents' instructions, `mayEdit`'s), are written by more
 * (`mayWrite`): everyone on the team, a team's for its own, the owning teams' for a customer's,
 * in the editor and through its agent's sidebar (src/kbchat.js), where whoever looks may talk;
 * for anyone else who looks, the agent there answers but changes nothing. What that agent reads
 * (every thread of the inbox, src/agent/tools.js `kbChatExtension`) it reads for whoever looks, on
 * purpose, also for Adobe's people on no team, whose own inbox is their personal view
 * (docs/ARCHITECTURE.md, "Who reads through it").
 */

import { isStaffDomain } from './lookup.js';
import { isAdmin, managedTeams, managesTeam } from './roles.js';
import { ownedCustomers, ownsCustomer } from './shares.js';

const teamsOf = (me) => ((me && me.teams) || []).map((t) => t.slug);

/**
 * Whether `me` is internal: a member of an ops team, or Adobe's staff signed in on none (from
 * SIGNIN_DOMAINS). Not someone signed in from a SIGNIN_DOMAINS domain that is not Adobe's. Who
 * sees every team's and every customer's page, and looks at every knowledge base.
 */
export const isInternal = (env, me) => Boolean(me) && (teamsOf(me).length > 0
  || Boolean(me.staff) || isStaffDomain(env, me.email));

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
 * every internal user, on an ops team or not (`isInternal`). It takes the base (`{ kind, slug }`)
 * as the others.
 */
export async function mayRead(env, me) {
  return isInternal(env, me);
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
  const looks = isInternal(env, me);
  return {
    read: () => looks,
    edit: (b) => (b.kind === 'team' ? managesTeam(me, b.slug) : ownedManaged.has(b.slug)),
    write: (b) => (b.kind === 'team' ? teamsOf(me).includes(b.slug) || managesTeam(me, b.slug)
      : owned.has(b.slug)),
  };
}
