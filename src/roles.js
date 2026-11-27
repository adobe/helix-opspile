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
 * Who may do what, by team: the admin team, a team's managers, its members.
 */

export const ADMIN_TEAM = 'admin';

export const isAdmin = (me) => Boolean(me && me.teams.some((t) => t.slug === ADMIN_TEAM));

/** The teams `me` manages as a team manager (the admin team manages every team besides). */
export const managedTeams = (me) => (me ? me.teams.filter((t) => t.role === 'manager').map((t) => t.slug) : []);

/** Whether `me` may manage `team`'s members and knowledge base: the admin team, or a manager. */
export const managesTeam = (me, team) => isAdmin(me) || managedTeams(me).includes(team);

/** Whether `me` may use the admin pages at all: the admin team, or any team's manager. */
export const isManager = (me) => isAdmin(me) || managedTeams(me).length > 0;

/** Whether `me` is in `team`, as a member or a manager (the admin team: in every team). */
export const inTeam = (me, team) => isAdmin(me)
  || Boolean(me && me.teams.some((t) => t.slug === team));
