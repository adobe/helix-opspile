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

import { json } from './http.js';
import { ensureKnowledgeBase } from './kb.js';
import { loadRules } from './lookup.js';
import { enqueueMoves, plan } from './refile.js';
import { ADMIN_TEAM } from './review.js';
import { slug as toSlug, UNASSIGNED } from './rules.js';

/**
 * The admin team's API for teams (#17) and orgs (#18), behind `/api/admin/*`:
 *
 * - teams: create, rename, delete; members: add by email, rename, remove;
 * - rules: the regular-expression rules that file channels under a team, an org or a kind
 *   (`^aem-` style prefixes, Teams team names, Slack Connect teams), and manual assignments
 *   of one channel (a `channel_id` rule with priority 10);
 * - orgs: display name, icon and type (customer, partner, vendor), and manual assignments.
 *
 * Every rule change can be tried first (`dryRun`): the answer lists the channels that would
 * move. Applied, the moves go to the NORMALIZE queue as `refile` jobs (src/refile.js).
 */

export const MANUAL_PRIORITY = 10;
const MANUAL_NOTE = 'manual assignment';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FIELDS = ['name', 'group_name', 'connected', 'channel_id'];
const TARGETS = ['team', 'org', 'kind'];
const KINDS = ['channel', 'alert', 'ignore'];
const TYPES = ['customer', 'partner', 'vendor'];
const ICON = /^(https:\/\/\S{1,500}|[a-z0-9.-]+\.[a-z]{2,})$/i;
const MAX_TEXT = 200;

const clean = (v, n = MAX_TEXT) => String(v ?? '').trim().slice(0, n);
const bad = (error) => json({ error }, 400);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const manualPattern = (channelId) => `^${escapeRe(channelId)}$`;
const isManual = (r) => r.field === 'channel_id' && r.priority === MANUAL_PRIORITY && r.note === MANUAL_NOTE;

async function rows(env, sql, ...args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

// ---- channels ---------------------------------------------------------------------------

/** Every channel opspile has seen, with where its threads are filed and its manual rules. */
async function channelList(env, rules, { q = '', team: inTeam, org: inOrg } = {}) {
  const filed = await rows(env, `SELECT c.source, c.tenant, c.channel_id, c.name, c.group_name,
      t.team, t.org, t.kind, COUNT(t.thread) AS threads, MAX(COALESCE(t.last_at, t.any_at)) AS latest
    FROM channels c LEFT JOIN threads t ON t.source = c.source AND t.tenant = c.tenant
      AND t.channel_id = c.channel_id
    GROUP BY c.source, c.tenant, c.channel_id, t.team, t.org, t.kind
    ORDER BY latest DESC`);
  const needle = q.toLowerCase();
  const manual = (target, channelId) => rules.find((r) => r.target === target && isManual(r)
    && r.pattern === manualPattern(channelId)) || null;
  const out = [];
  for (const c of filed) {
    const hit = !needle || `${c.name || ''} ${c.group_name || ''} ${c.channel_id}`.toLowerCase().includes(needle);
    if (hit && (!inTeam || c.team === inTeam) && (!inOrg || c.org === inOrg)) {
      const mt = manual('team', c.channel_id);
      const mo = manual('org', c.channel_id);
      out.push({
        source: c.source,
        tenant: c.tenant,
        channelId: c.channel_id,
        name: c.name,
        groupName: c.group_name,
        team: c.team,
        org: c.org,
        kind: c.kind,
        threads: c.threads,
        latest: c.latest,
        manual: {
          team: mt && { id: mt.id, value: mt.value },
          org: mo && { id: mo.id, value: mo.value },
        },
      });
    }
  }
  return out;
}

// ---- rules ------------------------------------------------------------------------------

/** A rule from the request, checked; `{ error }` when it is not acceptable. */
async function ruleFrom(env, body) {
  const target = clean(body.target);
  const field = clean(body.field);
  const pattern = clean(body.pattern, 500);
  let value = clean(body.value);
  const priority = Number(body.priority ?? 100);
  const source = body.source ? clean(body.source) : null;
  if (!TARGETS.includes(target)) {
    return { error: `target is one of ${TARGETS.join(', ')}` };
  }
  if (!FIELDS.includes(field)) {
    return { error: `field is one of ${FIELDS.join(', ')}` };
  }
  if (source && !['slack', 'teams'].includes(source)) {
    return { error: 'source is slack, teams or empty (both)' };
  }
  if (!pattern) {
    return { error: 'give a pattern (a regular expression, e.g. ^aem-)' };
  }
  try {
    RegExp(pattern, 'i');
  } catch (e) {
    return { error: `the pattern is not a regular expression: ${e.message}` };
  }
  if (!Number.isInteger(priority) || priority < 0 || priority > 10000) {
    return { error: 'priority is a whole number from 0 to 10000; the lowest matching rule wins' };
  }
  if (!value) {
    return { error: 'give a value' };
  }
  const template = /\$\d/.test(value);
  if (target === 'kind' && !KINDS.includes(value)) {
    return { error: `a kind is one of ${KINDS.join(', ')}` };
  }
  if (target === 'team' && !template) {
    value = toSlug(value);
    if (!await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(value).first()) {
      return { error: `there is no team ${value}; create it first` };
    }
  }
  if (target === 'org' && !template) {
    value = toSlug(value);
  }
  return {
    rule: {
      target, field, pattern, value, priority, source, note: clean(body.note) || null,
    },
  };
}

/** Saves a rule change, or with `dryRun` only says what it would move. */
async function applyRules(env, me, { next, dryRun, write }) {
  const moves = await plan(env, next);
  if (dryRun) {
    return json({ dryRun: true, moves });
  }
  const saved = await write();
  const jobs = await enqueueMoves(env, moves);
  for (const m of moves) {
    // A channel filed under a new org or team gets their knowledge bases on its next move;
    // make sure a new org has one right away.
    if (m.to.org !== UNASSIGNED) {
      // eslint-disable-next-line no-await-in-loop
      await ensureKnowledgeBase(env, 'org', m.to.org).catch(() => null);
    }
  }
  console.log(JSON.stringify({
    route: 'admin', rules: 'changed', by: me.id, moves: moves.length, jobs,
  }));
  return json({
    ok: true, ...saved, moves, jobs,
  });
}

const stamp = (me) => [me.email || String(me.id), new Date().toISOString()];
const ruleValues = (rule) => [
  rule.target, rule.priority, rule.source, rule.field, rule.pattern, rule.value, rule.note,
];

async function createRule(env, me, body) {
  const { rule, error } = await ruleFrom(env, body);
  if (error) {
    return bad(error);
  }
  const current = await loadRules(env);
  return applyRules(env, me, {
    next: [...current, { ...rule, id: Number.MAX_SAFE_INTEGER }],
    dryRun: body.dryRun,
    write: async () => {
      const r = await env.DB.prepare(`INSERT INTO rules (target, priority, source, field, pattern, value,
          note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
        .bind(...ruleValues(rule), ...stamp(me))
        .first();
      return { rule: r };
    },
  });
}

async function updateRule(env, me, body) {
  const id = Number(body.id);
  const current = await loadRules(env);
  if (!current.some((r) => r.id === id)) {
    return json({ error: 'no such rule' }, 404);
  }
  const { rule, error } = await ruleFrom(env, body);
  if (error) {
    return bad(error);
  }
  return applyRules(env, me, {
    next: current.map((r) => (r.id === id ? { ...r, ...rule } : r)),
    dryRun: body.dryRun,
    write: async () => {
      const r = await env.DB.prepare(`UPDATE rules SET target = ?, priority = ?, source = ?, field = ?,
          pattern = ?, value = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ? RETURNING *`)
        .bind(...ruleValues(rule), ...stamp(me), id)
        .first();
      return { rule: r };
    },
  });
}

async function deleteRule(env, me, body) {
  const id = Number(body.id);
  const current = await loadRules(env);
  if (!current.some((r) => r.id === id)) {
    return json({ error: 'no such rule' }, 404);
  }
  return applyRules(env, me, {
    next: current.filter((r) => r.id !== id),
    dryRun: body.dryRun,
    write: async () => {
      await env.DB.prepare('DELETE FROM rules WHERE id = ?').bind(id).run();
      return { deleted: id };
    },
  });
}

/**
 * POST /api/admin/assign `{ target: team|org, source, channelId, value }`: files one channel
 * under a team or an org, whatever the other rules say (a `channel_id` rule with priority
 * 10). DELETE takes the assignment away again.
 */
async function assign(env, me, body, remove) {
  const target = clean(body.target);
  const channelId = clean(body.channelId);
  if (!['team', 'org'].includes(target) || !channelId) {
    return bad('give a target (team or org) and a channelId');
  }
  const current = await loadRules(env);
  const existing = current.find((r) => r.target === target && isManual(r)
    && r.pattern === manualPattern(channelId));
  if (remove) {
    if (!existing) {
      return json({ error: 'this channel has no manual assignment' }, 404);
    }
    return deleteRule(env, me, { id: existing.id, dryRun: body.dryRun });
  }
  const payload = {
    target,
    field: 'channel_id',
    pattern: manualPattern(channelId),
    value: body.value,
    priority: MANUAL_PRIORITY,
    source: body.source || null,
    note: MANUAL_NOTE,
    dryRun: body.dryRun,
  };
  return existing
    ? updateRule(env, me, { ...payload, id: existing.id })
    : createRule(env, me, payload);
}

// ---- teams and members ------------------------------------------------------------------

async function listTeams(env) {
  const teams = await rows(env, `SELECT t.slug, t.name,
      (SELECT COUNT(*) FROM team_members m WHERE m.team = t.slug) AS members,
      (SELECT COUNT(*) FROM rules r WHERE r.target = 'team' AND r.value = t.slug) AS rules,
      (SELECT COUNT(DISTINCT th.channel_id) FROM threads th WHERE th.team = t.slug) AS channels,
      (SELECT COUNT(*) FROM threads th WHERE th.team = t.slug) AS threads
    FROM teams t ORDER BY t.name`);
  const unassigned = await env.DB.prepare(`SELECT COUNT(DISTINCT channel_id) AS channels,
      COUNT(*) AS threads FROM threads WHERE team = ?`).bind(UNASSIGNED).first();
  return json({ teams, unassigned });
}

async function team(env, slug) {
  const t = await env.DB.prepare('SELECT slug, name FROM teams WHERE slug = ?').bind(slug).first();
  if (!t && slug !== UNASSIGNED) {
    return json({ error: 'no such team' }, 404);
  }
  const rules = await loadRules(env);
  return json({
    team: t || { slug, name: 'Unassigned' },
    members: await rows(env, `SELECT p.id, p.name, p.email, p.staff FROM team_members m
      JOIN people p ON p.id = m.person WHERE m.team = ? ORDER BY p.name`, slug),
    rules: rules.filter((r) => r.target === 'team' && (r.value === slug || /\$\d/.test(r.value)))
      .sort((a, b) => a.priority - b.priority || a.id - b.id),
    channels: await channelList(env, rules, { team: slug }),
  });
}

async function createTeam(env, body) {
  const slug = clean(body.slug).toLowerCase();
  const name = clean(body.name);
  if (!SLUG.test(slug)) {
    return bad('a team slug is lowercase letters, digits and -, like edge-ops');
  }
  if (!name) {
    return bad('give the team a name');
  }
  const { meta } = await env.DB.prepare('INSERT INTO teams (slug, name) VALUES (?, ?) ON CONFLICT (slug) DO NOTHING')
    .bind(slug, name).run();
  if (!meta.changes) {
    return json({ error: `there is a team ${slug} already` }, 409);
  }
  await ensureKnowledgeBase(env, 'team', slug).catch(() => null);
  return json({ ok: true, team: { slug, name } });
}

async function renameTeam(env, body) {
  const name = clean(body.name);
  if (!name) {
    return bad('give the team a name');
  }
  const { meta } = await env.DB.prepare('UPDATE teams SET name = ? WHERE slug = ?').bind(name, clean(body.slug)).run();
  return meta.changes ? json({ ok: true }) : json({ error: 'no such team' }, 404);
}

async function deleteTeam(env, body) {
  const slug = clean(body.slug);
  if (slug === ADMIN_TEAM) {
    return bad('the admin team cannot be deleted');
  }
  const used = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM rules WHERE target = 'team' AND value = ?) AS rules,
      (SELECT COUNT(*) FROM threads WHERE team = ?) AS threads`).bind(slug, slug).first();
  if (used.rules || used.threads) {
    return json({
      error: `the team still has ${used.rules} rule(s) and ${used.threads} thread(s); move its channels to another team first`,
    }, 409);
  }
  const { meta } = await env.DB.prepare('DELETE FROM teams WHERE slug = ?').bind(slug).run();
  return meta.changes ? json({ ok: true }) : json({ error: 'no such team' }, 404);
}

async function addMember(env, body) {
  const teamSlug = clean(body.team);
  const email = clean(body.email).toLowerCase();
  const name = clean(body.name) || null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return bad('give the person\'s email address');
  }
  if (!await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(teamSlug).first()) {
    return json({ error: 'no such team' }, 404);
  }
  // Team members are staff; a person who posted before has a row already.
  await env.DB.prepare(`INSERT INTO people (email, name, staff) VALUES (?, ?, 1)
    ON CONFLICT (email) DO UPDATE SET staff = 1, name = COALESCE(people.name, excluded.name)`)
    .bind(email, name).run();
  const person = await env.DB.prepare('SELECT id, name, email, staff FROM people WHERE email = ?').bind(email).first();
  await env.DB.prepare('INSERT OR IGNORE INTO team_members (team, person) VALUES (?, ?)').bind(teamSlug, person.id).run();
  // Identities with this email belong to the person from now on.
  await env.DB.prepare('UPDATE identities SET person = ? WHERE email = ? AND person IS NULL')
    .bind(person.id, email).run();
  return json({ ok: true, person });
}

async function updateMember(env, body) {
  const name = clean(body.name);
  if (!name) {
    return bad('give a name');
  }
  const { meta } = await env.DB.prepare('UPDATE people SET name = ? WHERE id = ?').bind(name, Number(body.person)).run();
  return meta.changes ? json({ ok: true }) : json({ error: 'no such person' }, 404);
}

async function removeMember(env, me, body) {
  const teamSlug = clean(body.team);
  const person = Number(body.person);
  if (teamSlug === ADMIN_TEAM) {
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team = ?').bind(ADMIN_TEAM).first();
    if (n <= 1) {
      return bad('the admin team keeps at least one member');
    }
  }
  const { meta } = await env.DB.prepare('DELETE FROM team_members WHERE team = ? AND person = ?')
    .bind(teamSlug, person).run();
  return meta.changes ? json({ ok: true, self: person === me.id }) : json({ error: 'not a member' }, 404);
}

// ---- orgs -------------------------------------------------------------------------------

/** Every org: the ones with a row, and every slug the rules filed threads or a base under. */
async function listOrgs(env) {
  const list = await rows(env, `SELECT s.slug, o.name, COALESCE(o.type, 'customer') AS type, o.icon,
      (SELECT COUNT(DISTINCT channel_id) FROM threads t WHERE t.org = s.slug) AS channels,
      (SELECT COUNT(*) FROM threads t WHERE t.org = s.slug) AS threads,
      (SELECT MAX(COALESCE(last_at, any_at)) FROM threads t WHERE t.org = s.slug) AS latest
    FROM (SELECT slug FROM orgs UNION SELECT DISTINCT org FROM threads
      UNION SELECT slug FROM knowledge_bases WHERE kind = 'org') s
    LEFT JOIN orgs o ON o.slug = s.slug
    WHERE s.slug != ?
    ORDER BY COALESCE(o.name, s.slug)`, UNASSIGNED);
  return json({ orgs: list, types: TYPES });
}

async function org(env, slug) {
  const row = await env.DB.prepare('SELECT slug, name, type, icon, updated_at FROM orgs WHERE slug = ?').bind(slug).first();
  const rules = await loadRules(env);
  const channels = await channelList(env, rules, { org: slug });
  const orgRules = rules.filter((r) => r.target === 'org' && (r.value === slug || /\$\d/.test(r.value)))
    .sort((a, b) => a.priority - b.priority || a.id - b.id);
  if (!row && !channels.length && !orgRules.some((r) => r.value === slug)) {
    const kb = await env.DB.prepare("SELECT 1 FROM knowledge_bases WHERE kind = 'org' AND slug = ?").bind(slug).first();
    if (!kb) {
      return json({ error: 'no such org' }, 404);
    }
  }
  return json({
    org: row || {
      slug, name: null, type: 'customer', icon: null,
    },
    rules: orgRules,
    channels,
    types: TYPES,
  });
}

function orgFields(body) {
  const name = clean(body.name) || null;
  const type = clean(body.type) || 'customer';
  const icon = clean(body.icon, 500).replace(/^https?:\/\/(?=[^/]+\/?$)/i, '').replace(/\/$/, '') || null;
  if (!TYPES.includes(type)) {
    return { error: `the type is one of ${TYPES.join(', ')}` };
  }
  if (icon && !ICON.test(icon)) {
    return { error: 'the icon is a domain (its favicon is shown) or an https:// image URL' };
  }
  return { name, type, icon };
}

async function saveOrg(env, body, create) {
  const slug = create ? toSlug(body.slug || body.name) : clean(body.slug);
  if (!SLUG.test(slug)) {
    return bad('an org slug is lowercase letters, digits and -, like acme');
  }
  const f = orgFields(body);
  if (f.error) {
    return bad(f.error);
  }
  const now = new Date().toISOString();
  if (create) {
    const { meta } = await env.DB.prepare(`INSERT INTO orgs (slug, name, type, icon, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (slug) DO NOTHING`).bind(slug, f.name, f.type, f.icon, now).run();
    if (!meta.changes) {
      return json({ error: `there is an org ${slug} already` }, 409);
    }
    await ensureKnowledgeBase(env, 'org', slug).catch(() => null);
  } else {
    // An org known only from the rules gets its row on the first edit.
    await env.DB.prepare(`INSERT INTO orgs (slug, name, type, icon, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (slug) DO UPDATE SET name = excluded.name, type = excluded.type,
        icon = excluded.icon, updated_at = excluded.updated_at`).bind(slug, f.name, f.type, f.icon, now).run();
  }
  return json({ ok: true, org: { slug, ...f, updated_at: now } });
}

async function deleteOrg(env, body) {
  const { meta } = await env.DB.prepare('DELETE FROM orgs WHERE slug = ?').bind(clean(body.slug)).run();
  return meta.changes ? json({ ok: true }) : json({ error: 'this org has no name, icon or type to delete' }, 404);
}

// ---- routes -----------------------------------------------------------------------------

/** Routes `/api/admin/*` for a member of the admin team. Returns null for other paths. */
export async function admin(request, env, url, me) {
  const p = url.pathname;
  if (!p.startsWith('/api/admin/')) {
    return null;
  }
  const m = request.method;
  const body = m === 'GET' ? {} : await request.json().catch(() => ({}));
  const q = (k) => clean(url.searchParams.get(k));
  const route = `${m} ${p.slice('/api/admin/'.length)}`;
  switch (route) {
    case 'GET teams': return listTeams(env);
    case 'POST teams': return createTeam(env, body);
    case 'PUT teams': return renameTeam(env, body);
    case 'DELETE teams': return deleteTeam(env, body);
    case 'GET team': return team(env, q('slug'));
    case 'POST members': return addMember(env, body);
    case 'PUT members': return updateMember(env, body);
    case 'DELETE members': return removeMember(env, me, body);
    case 'GET rules': return json({ rules: await loadRules(env), fields: FIELDS, kinds: KINDS });
    case 'POST rules': return createRule(env, me, body);
    case 'PUT rules': return updateRule(env, me, body);
    case 'DELETE rules': return deleteRule(env, me, body);
    case 'POST assign': return assign(env, me, body, false);
    case 'DELETE assign': return assign(env, me, body, true);
    case 'GET channels': return json({ channels: (await channelList(env, await loadRules(env), { q: q('q') })).slice(0, 100) });
    case 'GET orgs': return listOrgs(env);
    case 'POST orgs': return saveOrg(env, body, true);
    case 'PUT orgs': return saveOrg(env, body, false);
    case 'DELETE orgs': return deleteOrg(env, body);
    case 'GET org': return org(env, q('slug'));
    default: return json({ error: 'not found' }, 404);
  }
}
