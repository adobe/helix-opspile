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
 * Following and muting, as one (docs/ARCHITECTURE.md, "Following"). Each is who, what and what
 * of: you, or a team you may act for (one you manage; any for the admin team); to follow, or to
 * mute (your own only); a product (`tech`), a topic (`area`), a customer (`org`) or a person
 * (`person`). A team follows products, topics and customers, never a person; only a customer is
 * muted. GET /api/follows answers `followState`, PUT /api/follows takes `changeFollow`, and every
 * page's Follow button (ui/follow.js) draws from the one and sends the other.
 *
 * Following a customer and muting it are one or the other: following it lifts your mute, and
 * muting it ends your follow. A mute lifts itself once you act on the customer: you post in one
 * of its threads (src/standing.js `mutedOrgs`).
 */

import {
  areasOfTeams, followsOfTeams, personFollows, personFollowsBy, setPersonFollow,
  setPersonFollowBy, setTeamFollow, setTeamFollowBy,
} from './follows.js';
import { loadRules } from './lookup.js';
import { NAME } from './personsql.js';
import { isAdmin, managedTeams, managesTeam } from './roles.js';
import { followedOrg } from './rules.js';
import { isHolding } from './shares.js';
import { mutedOf, setMark } from './standing.js';

/** What may be followed, by kind. */
export const KINDS = ['tech', 'area', 'org', 'person'];
/** What a team follows. */
export const TEAM_KINDS = ['tech', 'area', 'org'];
/** What a person mutes. */
export const MUTE_KINDS = ['org'];

const NOUN = {
  tech: 'product', area: 'topic', org: 'customer', person: 'person',
};

/** The rows of `sql` (`?1` a JSON list of ids) as a Map of `id` to `name`, or none for no ids. */
async function namesOf(env, sql, ids) {
  if (!ids.length) {
    return new Map();
  }
  const { results } = await env.DB.prepare(sql).bind(JSON.stringify(ids)).all();
  const out = new Map();
  for (const r of results || []) {
    if (!out.has(String(r.id)) && r.name) {
      out.set(String(r.id), r.name);
    }
  }
  return out;
}

/** The teams `me` may follow for: those they manage, every team for the admin team; none holds. */
async function teamsFor(env, me) {
  if (isAdmin(me)) {
    const { results } = await env.DB.prepare('SELECT slug FROM teams ORDER BY name').all();
    return (results || []).map((r) => r.slug).filter((t) => !isHolding(t));
  }
  return managedTeams(me).filter((t) => !isHolding(t));
}

/**
 * What `me` follows and mutes, and what the teams they are on or follow for follow:
 * `{ me: { tech, area, org, person }, teams: { [slug]: { tech, area, org } }, muted: { org },
 * may: [slug], names: { 'kind:id': name }, teamNames: { [slug]: name } }`. `may` are the teams
 * `me` may follow for (ui/follow.js offers them in its dropdown), `names` what each followed or
 * muted thing is called, a person's too, so that a list of them needs nothing else.
 */
export async function followState(env, me) {
  const may = await teamsFor(env, me);
  const list = [...new Set([...(me.teams || []).map((t) => t.slug), ...may])];
  const [tech, by, teamTech, teamAreas, rules, muted] = await Promise.all([
    personFollows(env, me.id),
    personFollowsBy(env, me.id),
    followsOfTeams(env, list),
    areasOfTeams(env, list),
    list.length ? loadRules(env) : [],
    mutedOf(env.DB, me.id),
  ]);
  const teams = Object.fromEntries(list.map((t) => [t, {
    tech: teamTech[t] || [], area: teamAreas[t] || [], org: [],
  }]));
  for (const r of rules) {
    const org = followedOrg(r);
    if (org && teams[r.value] && !teams[r.value].org.includes(org)) {
      teams[r.value].org.push(org);
    }
  }
  Object.values(teams).forEach((t) => t.org.sort());
  const mine = {
    tech, area: by.area, org: by.org, person: by.person,
  };
  const all = (kind) => [...new Set([...mine[kind],
    ...Object.values(teams).flatMap((t) => t[kind] || []),
    ...(kind === 'org' ? muted : [])].map(String))];
  const [techNames, areaNames, orgNames, personNames, teamRows] = await Promise.all([
    namesOf(env, `SELECT tech AS id, name FROM tech_stack WHERE tech IN (SELECT value FROM json_each(?1))
      ORDER BY team = 'admin' DESC, enabled DESC`, all('tech')),
    namesOf(env, `SELECT id, name FROM areas WHERE id IN (SELECT value FROM json_each(?1))
      ORDER BY team = 'admin' DESC, enabled DESC`, all('area')),
    namesOf(env, 'SELECT slug AS id, name FROM orgs WHERE slug IN (SELECT value FROM json_each(?1))', all('org')),
    namesOf(env, `SELECT p.id, ${NAME('p.id')} AS name FROM people p
      WHERE p.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?1))`, all('person')),
    namesOf(env, 'SELECT slug AS id, name FROM teams WHERE slug IN (SELECT value FROM json_each(?1))', list),
  ]);
  const names = {};
  for (const [kind, map] of [['tech', techNames], ['area', areaNames], ['org', orgNames], ['person', personNames]]) {
    for (const [id, name] of map) {
      names[`${kind}:${id}`] = name;
    }
  }
  return {
    me: mine,
    teams,
    muted: { org: muted },
    may,
    names,
    teamNames: Object.fromEntries(list.map((t) => [t, teamRows.get(t) || t])),
  };
}

/** A failed change: `{ error, status }`. */
const no = (error, status = 400) => ({ error, status });

/**
 * A change of what `me` or one of their teams follows or mutes, PUT /api/follows:
 * `{ kind, target, follow }` follows (`follow` false: no more) as `me`, with `team` as that team
 * (the admin team, or its managers); `{ kind: 'org', target, mute }` mutes a customer as `me`, or
 * (`mute` false) no more. `{ tech }` is `{ kind: 'tech', target: tech }`, as before. A team's
 * customer is a follow rule (`followOrg`, src/admin.js, which is given here as `followOrg`, so
 * that this module needs none of the admin routes). `{ ok, changed }` or `{ error, status }`.
 */
export async function changeFollow(env, me, body, { followOrg } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const kind = b.kind || 'tech';
  const target = b.target ?? b.tech;
  if (!KINDS.includes(kind)) {
    return no(`kind is ${KINDS.join(', ')}`);
  }
  if (target === undefined || target === null || String(target).trim() === '') {
    return no(`target: the ${NOUN[kind]}`);
  }
  if (b.mute !== undefined) {
    if (b.team) {
      return no('a mute is your own: leave out `team`');
    }
    if (!MUTE_KINDS.includes(kind)) {
      return no(`only a ${MUTE_KINDS.map((k) => NOUN[k]).join(' or a ')} is muted`);
    }
    const org = String(target).trim();
    if (b.mute === false) {
      const res = await setMark(env.DB, me.id, { org, mark: 'mute', at: null });
      return res.error ? no(res.error, res.status) : { ok: true, changed: res.was !== null };
    }
    // One or the other: muting a customer ends your follow of it.
    const res = await setMark(env.DB, me.id, { org, mark: 'mute' });
    if (res.error) {
      return no(res.error, res.status);
    }
    await setPersonFollowBy(env, {
      person: me.id, kind: 'org', target: org, follow: false,
    });
    return { ok: true, changed: true };
  }
  const follow = b.follow !== false;
  if (b.team) {
    const team = String(b.team).trim();
    if (!managesTeam(me, team)) {
      return no('you do not manage this team', 403);
    }
    if (!await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(team).first()) {
      return no('no such team', 404);
    }
    const by = me.email || String(me.id);
    console.log(JSON.stringify({
      route: 'follows', team, kind, target: String(target), follow, by: me.id,
    }));
    if (kind === 'tech') {
      const res = await setTeamFollow(env, {
        team, tech: String(target).trim(), follow, by,
      });
      return res.error ? no(res.error, res.status) : res;
    }
    if (kind === 'area') {
      return setTeamFollowBy(env, {
        team, kind, target, follow, by,
      });
    }
    if (kind === 'org') {
      const res = await followOrg(env, me, { team, org: String(target), follow });
      const out = await res.json().catch(() => ({}));
      return res.ok ? { ok: true, changed: true } : no(out.error || 'could not change it', res.status);
    }
    return no('a team follows no person: a person is your own follow');
  }
  const res = kind === 'tech'
    ? await setPersonFollow(env, { person: me.id, tech: String(target).trim(), follow })
    : await setPersonFollowBy(env, {
      person: me.id, kind, target, follow,
    });
  if (res.error) {
    return no(res.error, res.status);
  }
  // One or the other: following a customer is acting on it, which lifts your mute.
  if (follow && kind === 'org') {
    await setMark(env.DB, me.id, { org: String(target).trim(), mark: 'mute', at: null });
  }
  return res;
}
