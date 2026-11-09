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
 * servers and tools, in the editor (`/inbox/kb`):
 *
 * - a team's (`kind: 'team'`): its members look, its managers change it;
 * - a customer's (`kind: 'org'`): the members of the teams that own the customer look (a
 *   channel of the customer's is filed under or shared with the team, src/shares.js), and the
 *   managers of those teams change it;
 * - the admin team looks at and changes all of them.
 */

import {
  inTeam, isAdmin, managedTeams, managesTeam,
} from './review.js';
import { ownedCustomers, ownsCustomer } from './shares.js';

const teamsOf = (me) => ((me && me.teams) || []).map((t) => t.slug);

/** Whether `me` may change the knowledge base (or the servers) of `kind`/`slug`. */
export async function mayEdit(env, me, { kind, slug }) {
  if (isAdmin(me)) {
    return true;
  }
  return kind === 'team' ? managesTeam(me, slug) : ownsCustomer(env, managedTeams(me), slug);
}

/** Whether `me` may look at the knowledge base (or the servers) of `kind`/`slug`. */
export async function mayRead(env, me, { kind, slug }) {
  if (isAdmin(me)) {
    return true;
  }
  return kind === 'team' ? inTeam(me, slug) : ownsCustomer(env, teamsOf(me), slug);
}

/**
 * Both, for many knowledge bases at once: `{ read(base), edit(base) }`, answered without a
 * query each (the customers `me`'s teams own are read once).
 */
export async function access(env, me) {
  if (isAdmin(me)) {
    return { read: () => true, edit: () => true };
  }
  const managed = managedTeams(me);
  const [owned, ownedManaged] = await Promise.all([
    ownedCustomers(env, teamsOf(me)),
    ownedCustomers(env, managed),
  ]);
  return {
    read: (b) => (b.kind === 'team' ? inTeam(me, b.slug) : owned.has(b.slug)),
    edit: (b) => (b.kind === 'team' ? managesTeam(me, b.slug) : ownedManaged.has(b.slug)),
  };
}
