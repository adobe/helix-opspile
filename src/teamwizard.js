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

import { isStaffDomain } from './lookup.js';
import { ADMIN_TEAM } from './review.js';
import { slug as toSlug, UNASSIGNED } from './rules.js';

/**
 * The team wizard of the admin pages: the channels the admin team holds (no rule files them
 * under an ops team), grouped by the prefix of their names, each group a team it might make.
 * Channels are named by convention (`<product>-<customer>`), so a prefix that a few of them
 * share is often a product whose team has no rule yet; and the Adobe people who are in most of
 * its channels are the team.
 *
 * - A channel's name is its Slack or Discord channel's name; on Teams, its Teams team's, which
 *   is what is named by convention there (the channels are `Main`, `General`). The rules read
 *   the same fields: `name`, and `group_name` for Teams.
 * - Its prefixes are its name up to the first and the second `-` or `_` (`workfront-` and
 *   `workfront-frame-` of `workfront-frame-acme`). A prefix is a group once MIN_CHANNELS of
 *   the admin team's channels have it; a prefix all of whose channels share a longer one is
 *   that one (the narrower rule files the same channels).
 * - Someone is present in a channel when they are a member (`channel_members`), post in it or
 *   react there, and are staff (STAFF_DOMAINS) with a mail address, since a team member is one.
 *   The wizard checks the people present in at least SUGGEST_SHARE of a group's channels, and
 *   in them at least SUGGEST_LIFT times as often as in the admin team's channels at large (or
 *   in no others, where the group is too large a part of them for that): an admin who is in
 *   every channel is in every group too, and is not what makes this one a team.
 * - A group whose checked people are mostly on one ops team already is that team's, likely:
 *   the wizard offers to give the team the rule instead of making a new one.
 *
 * A group the admin team does not want is dismissed (`team_prefix_dismissals`, migration 0088),
 * with its channel count, and offered again once it has more channels. Creating the team files
 * the group's channels under it with a rule, so the group is gone from the admin team's.
 */

export const MIN_CHANNELS = 3;
export const MAX_SEGMENTS = 2;
export const SUGGEST_SHARE = 0.5;
export const SUGGEST_LIFT = 2;
const MAX_PEOPLE = 30;
const MAX_CHANNELS_LISTED = 200;
export const RULE_PRIORITY = 100;

// The channels of the admin team, and those no rule files at all (no fallback rule).
const HOLDERS = [ADMIN_TEAM, UNASSIGNED];

async function rows(env, sql, ...args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

const keyOf = (c) => `${c.source}:${c.tenant}:${c.channel_id}`;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The name a channel's prefix is read from, and the rule field that reads it. */
export function nameField(c) {
  return c.source === 'teams' && c.group_name
    ? { field: 'group_name', text: c.group_name } : { field: 'name', text: c.name };
}

/**
 * A name's prefixes, lower case: up to and with each of its first MAX_SEGMENTS separators
 * (`-`, `_`), each of at least two characters and with something after it.
 * `workfront-frame-acme` → `workfront-`, `workfront-frame-`.
 */
export function prefixesOf(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  const re = /[-_]+/g;
  for (let m = re.exec(s); m && out.length < MAX_SEGMENTS; m = re.exec(s)) {
    const end = m.index + m[0].length;
    if (m.index >= 2 && end < s.length) {
      out.push(s.slice(0, end));
    }
  }
  return out;
}

/**
 * The channels in groups by prefix: `[{ prefix, parent, channels }]`, the most channels first.
 * `parent` is the group of a shorter prefix this one is in (`workfront-` of `workfront-frame-`).
 */
export function prefixGroups(channels, min = MIN_CHANNELS) {
  const by = new Map();
  for (const c of channels) {
    for (const p of prefixesOf(nameField(c).text)) {
      by.set(p, [...(by.get(p) || []), c]);
    }
  }
  const groups = [...by].filter(([, cs]) => cs.length >= min)
    .map(([prefix, cs]) => ({ prefix, channels: cs }));
  // A longer prefix's channels are some of the shorter one's: as many are all of them.
  const within = (a, b) => a.prefix.length > b.prefix.length && a.prefix.startsWith(b.prefix);
  const kept = groups.filter((g) => !groups.some((o) => within(o, g)
    && o.channels.length === g.channels.length));
  for (const g of kept) {
    const parents = kept.filter((o) => within(g, o))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    g.parent = parents.length ? parents[0].prefix : null;
  }
  return kept.sort((a, b) => (b.channels.length - a.channels.length)
    || a.prefix.localeCompare(b.prefix));
}

/**
 * What the rules that would file a group's channels match, `[{ field, source, pattern }]`: the
 * channel name starts with the prefix, and for its Teams channels, the Teams team's name.
 */
export function groupRules(group) {
  const fields = new Set(group.channels.map((c) => nameField(c).field));
  const pattern = `^${escapeRe(group.prefix)}`;
  return [
    ...(fields.has('name') ? [{ field: 'name', source: null, pattern }] : []),
    ...(fields.has('group_name') ? [{ field: 'group_name', source: 'teams', pattern }] : []),
  ];
}

/** The rules that file a group of `teamGroups` under `team`, as rows of `rules`. */
export function wizardRules(group, team) {
  return group.rules.map((r) => ({
    target: 'team', priority: RULE_PRIORITY, ...r, value: team, note: `team wizard: ${group.prefix}`,
  }));
}

/** A new team's slug and name from a prefix: `wf-frame-` → `wf-frame`, Wf Frame. */
export function teamFor(prefix) {
  const slug = toSlug(prefix);
  const name = slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { slug, name };
}

/**
 * Who of `presence` (`Map<channel key, Map<email, person>>`) is in the group's channels, the
 * most channels first: `channels` of them, `everywhere` of the admin team's `total`, and
 * whether the wizard checks them (see the top).
 */
export function rankPeople(keys, presence, everywhere, total) {
  const people = new Map();
  for (const k of keys) {
    for (const p of (presence.get(k) || new Map()).values()) {
      const x = people.get(p.email) || {
        email: p.email, name: p.name, channels: 0, posted: 0, reacted: 0,
      };
      x.name = x.name || p.name;
      x.channels += 1;
      x.posted += p.posted || 0;
      x.reacted += p.reacted || 0;
      people.set(p.email, x);
    }
  }
  const n = keys.length;
  return [...people.values()].map((x) => {
    const all = everywhere.get(x.email) || x.channels;
    const lift = total && all ? (x.channels / n) / (all / total) : 0;
    return {
      ...x,
      everywhere: all,
      // Someone in none of the admin team's channels but these has the most lift there is.
      suggested: x.channels >= 2 && x.channels / n >= SUGGEST_SHARE
        && lift >= Math.min(SUGGEST_LIFT, total / n) - 1e-9,
    };
  }).sort((a, b) => (b.suggested - a.suggested) || (b.channels - a.channels)
    || (a.everywhere - b.everywhere) || (b.posted - a.posted)
    || String(a.name || a.email).localeCompare(String(b.name || b.email)));
}

/** Who is present in each of the admin team's channels: `Map<channel key, Map<email, person>>`. */
async function presenceOf(env) {
  const presence = new Map();
  const touch = (r, how, n = 1) => {
    const email = String(r.email || '').toLowerCase();
    if (!email || !(r.staff || isStaffDomain(env, email))) {
      return;
    }
    const k = keyOf(r);
    const here = presence.get(k) || new Map();
    const p = here.get(email) || {
      email, name: r.name || null, member: false, posted: 0, reacted: 0,
    };
    p.name = p.name || r.name || null;
    if (how === 'member') {
      p.member = true;
    } else {
      p[how] += n;
    }
    here.set(email, p);
    presence.set(k, here);
  };
  const held = `EXISTS (SELECT 1 FROM threads t WHERE t.source = x.source AND t.tenant = x.tenant
    AND t.channel_id = x.channel_id AND t.team IN (?1, ?2))`;
  const [members, posts, reactions] = await Promise.all([
    rows(env, `SELECT x.source, x.tenant, x.channel_id, COALESCE(x.email, i.email) AS email,
        COALESCE(i.name, x.name) AS name, 0 AS staff
      FROM channel_members x LEFT JOIN identities i ON i.source = x.source AND i.tenant = x.tenant
        AND i.user_id = x.user_id
      WHERE ${held} AND COALESCE(x.email, i.email) IS NOT NULL`, ...HOLDERS),
    rows(env, `SELECT t.source, t.tenant, t.channel_id, p.email, p.name, p.staff, COUNT(*) AS n
      FROM threads t JOIN messages m ON m.thread = t.thread JOIN people p ON p.id = m.person
      WHERE t.team IN (?1, ?2) AND m.deleted = 0 AND p.email IS NOT NULL
      GROUP BY t.source, t.tenant, t.channel_id, p.id`, ...HOLDERS),
    rows(env, `SELECT t.source, t.tenant, t.channel_id, i.email, i.name, 0 AS staff, COUNT(*) AS n
      FROM threads t JOIN reactions r ON r.thread = t.thread
      JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +r.user_key
      WHERE t.team IN (?1, ?2) AND i.email IS NOT NULL
      GROUP BY t.source, t.tenant, t.channel_id, LOWER(i.email)`, ...HOLDERS),
  ]);
  members.forEach((r) => touch(r, 'member'));
  posts.forEach((r) => touch(r, 'posted', r.n));
  reactions.forEach((r) => touch(r, 'reacted', r.n));
  return presence;
}

/**
 * The team wizard's groups (see the top): `{ groups, dismissed, coverage }`, each group with
 * its channels, the rules that would file them, its people (checked or not), the team they are
 * on already if most are, and a new team's slug and name.
 */
export async function teamGroups(env) {
  const [channels, presence, dismissals, onTeams, teams] = await Promise.all([
    rows(env, `SELECT t.source, t.tenant, t.channel_id, COUNT(*) AS threads,
        MAX(COALESCE(t.last_at, t.any_at)) AS latest, c.name, c.group_name, c.members_at, c.members_error
      FROM threads t JOIN channels c ON c.source = t.source AND c.tenant = t.tenant
        AND c.channel_id = t.channel_id
      WHERE t.team IN (?, ?) AND c.archived_at IS NULL
      GROUP BY t.source, t.tenant, t.channel_id`, ...HOLDERS),
    presenceOf(env),
    rows(env, 'SELECT prefix, channels, dismissed_by, dismissed_at FROM team_prefix_dismissals'),
    rows(env, `SELECT LOWER(p.email) AS email, p.id, m.team FROM team_members m
      JOIN people p ON p.id = m.person WHERE m.team <> ? AND p.email IS NOT NULL`, ADMIN_TEAM),
    rows(env, 'SELECT slug, name FROM teams'),
  ]);
  const live = new Set(channels.map(keyOf));
  // In how many of the admin team's channels each person is.
  const everywhere = new Map();
  for (const [k, here] of presence) {
    if (live.has(k)) {
      for (const email of here.keys()) {
        everywhere.set(email, (everywhere.get(email) || 0) + 1);
      }
    }
  }
  const teamsOf = new Map();
  const ids = new Map();
  for (const r of onTeams) {
    teamsOf.set(r.email, [...(teamsOf.get(r.email) || []), r.team]);
    ids.set(r.email, r.id);
  }
  const slugs = new Set(teams.map((t) => t.slug));
  const gone = new Map(dismissals.map((d) => [d.prefix, d]));
  const all = prefixGroups(channels).map((g) => {
    const keys = g.channels.map(keyOf);
    const people = rankPeople(keys, presence, everywhere, channels.length).slice(0, MAX_PEOPLE)
      .map((p) => ({ ...p, id: ids.get(p.email) || null, teams: teamsOf.get(p.email) || [] }));
    const checked = people.filter((p) => p.suggested);
    // The ops team most of the checked people are on, if one is.
    const count = new Map();
    checked.forEach((p) => p.teams.forEach((t) => count.set(t, (count.get(t) || 0) + 1)));
    const [top] = [...count].sort((a, b) => b[1] - a[1]);
    const team = top && top[1] * 2 >= checked.length ? { slug: top[0], people: top[1] } : null;
    const fresh = teamFor(g.prefix);
    const d = gone.get(g.prefix);
    return {
      prefix: g.prefix,
      parent: g.parent,
      slug: fresh.slug,
      name: fresh.name,
      slugTaken: slugs.has(fresh.slug),
      team,
      rules: groupRules(g),
      channels: g.channels.slice(0, MAX_CHANNELS_LISTED).map((c) => ({
        source: c.source,
        tenant: c.tenant,
        channelId: c.channel_id,
        name: c.name,
        groupName: c.group_name,
        threads: c.threads,
        latest: c.latest,
        membersListed: Boolean(c.members_at && !c.members_error),
      })),
      size: g.channels.length,
      membersListed: g.channels.filter((c) => c.members_at && !c.members_error).length,
      latest: g.channels.reduce((m, c) => (String(c.latest || '') > m ? String(c.latest) : m), ''),
      people,
      // Dismissed, and not grown since.
      dismissed: d && g.channels.length <= d.channels
        ? { by: d.dismissed_by, at: d.dismissed_at, channels: d.channels } : null,
    };
  });
  return {
    groups: all.filter((g) => !g.dismissed),
    dismissed: all.filter((g) => g.dismissed),
    coverage: {
      channels: channels.length,
      membersListed: channels.filter((c) => c.members_at && !c.members_error).length,
    },
  };
}

/** The group of `prefix` among the admin team's channels now, dismissed or not; null if none. */
export async function teamGroup(env, prefix) {
  const { groups, dismissed } = await teamGroups(env);
  return [...groups, ...dismissed].find((g) => g.prefix === prefix) || null;
}

/**
 * Dismisses a group (`dismiss: true`), with how many channels it has now, or offers it again.
 * Answers false when there is no such group.
 */
export async function dismissGroup(env, prefix, by, dismiss = true) {
  if (!dismiss) {
    await env.DB.prepare('DELETE FROM team_prefix_dismissals WHERE prefix = ?').bind(prefix).run();
    return true;
  }
  const g = await teamGroup(env, prefix);
  if (!g) {
    return false;
  }
  await env.DB.prepare(`INSERT INTO team_prefix_dismissals (prefix, channels, dismissed_by, dismissed_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (prefix) DO UPDATE SET channels = excluded.channels,
      dismissed_by = excluded.dismissed_by, dismissed_at = excluded.dismissed_at`)
    .bind(prefix, g.size, by, new Date().toISOString()).run();
  return true;
}
