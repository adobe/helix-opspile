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

import { cogsReport } from './cogs/report.js';
import { rollupCogs } from './cogs/rollup.js';
import { buildTopicMap, latestTopicMap } from './topicmap.js';
import { queueRelabel } from './label.js';
import { PLATFORMS } from './platforms.js';
import { json } from './http.js';
import { likePattern } from './like.js';
import { ensureKnowledgeBase } from './kb.js';
import { setTeamDefault } from './agent/enabled.js';
import { AGENT_TOOLS, setToolSwitch } from './agent/agenttools.js';
import { GLOBAL_SERVERS, setGlobalSwitch } from './agent/globals.js';
import { isStaffDomain, loadRules, toChannel } from './lookup.js';
import { enqueueMoves, plan } from './refile.js';
import {
  ADMIN_TEAM, isAdmin, managedTeams, managesTeam,
} from './review.js';
import { classify, slug as toSlug, UNASSIGNED } from './rules.js';
import {
  isHolding, share, sharesByChannel, sharesOf, unshare,
} from './shares.js';
import { syncAccessQuietly } from './accesssync.js';
import { faviconProxy, findIcons, orgDomain } from './favicons.js';
import {
  claimRequest, closeRequest, createRequest, getRequest, listRequests, openCount, outcomeOf,
  recordOutcome,
  reopenRequest, settleMoved, settleRequests,
} from './requests.js';
import { classifyChannels, clefOf, suggestionsFor } from './suggest.js';
import { getBot, listBots, setBot } from './ourbots.js';
import { followable, setTeamFollow, teamFollows } from './follows.js';
import { portalAuthor, portalBound, portalCall } from './portalsource.js';
import { openConflictCount, resolveConflict, techConflicts } from './techconflicts.js';
import { ruleConflicts, settlement } from './ruleconflicts.js';
import {
  isRuleShare, knownChannels, syncFollowRules, wantedFollows,
} from './followrules.js';
import {
  getPortalRequest, listPortalRequests, portalOpenCount, recordDeclined, recordOpened,
  reopenDeclined,
} from './portalrequests.js';

/**
 * The admin team's API for teams (#17) and orgs (#18), behind `/api/admin/*`:
 *
 * - teams: create, rename, delete, self-managed or not; members: add (found by name or
 *   email), remove, promote to team manager or demote;
 * - rules: the regular-expression rules that file channels under a team, an org or a kind
 *   (`^aem-` style prefixes, Teams team names, Slack Connect teams), and manual assignments
 *   of one channel (a `channel_id` rule with priority 10); follow rules, which share the
 *   channels they match with a team (src/followrules.js); and the conflicts between team
 *   rules, which the admin team settles under Requests (src/ruleconflicts.js);
 * - orgs: display name, icon and type (customer, partner, vendor), and manual assignments;
 * - bots: which of the bots the inbox knows are Adobe's, and so count as staff, each with its
 *   latest messages (src/ourbots.js);
 * - shared channels (migration 0024): a channel is filed under one team, its first, and can be
 *   shared with more. Adding a team to a channel moves it only when the admin team (or nobody)
 *   holds it; a channel another team holds is shared with the new one instead.
 *
 * Team managers (migration 0018) use the same API for the teams they manage, and only for
 * their members: they see those teams, add and remove people, and promote or demote them.
 * They also search every channel, and ask the admin team to assign one to their team (a
 * request, migration 0028, src/requests.js); the admin team confirms the request, which runs
 * the same assignment it makes by hand, or declines it. Everything else is for the admin team.
 *
 * Customers ask too, from the customer portal (src/portalrequests.js): a lobby there asks for
 * a channel. The admin team opens one (`portal/open`: the portal makes the channel, and it is
 * filed under a team and a customer by hand, shared with more teams, and gets its welcome
 * message) or declines (`portal/decline`); a team's managers open one for their team when it
 * follows a technology the lobby picked.
 *
 * Every rule change can be tried first (`dryRun`): the answer lists the channels that would
 * move. Applied, the moves go to the NORMALIZE queue as `refile` jobs (src/refile.js).
 *
 * A team's page also suggests channels the admin team holds that the team might want: where
 * its members are active, or where Clef says they belong (src/suggest.js).
 */

export const MANUAL_PRIORITY = 10;
const MANUAL_NOTE = 'manual assignment';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FIELDS = ['name', 'group_name', 'connected', 'channel_id'];
const TARGETS = ['team', 'org', 'kind', 'follow'];
const KINDS = ['channel', 'alert', 'ignore'];
const TYPES = ['customer', 'partner', 'vendor', 'internal'];
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

const CHANNEL_FIELDS = [['name', 'name'], ['groupName', 'group_name'], ['orgName', 'org_name'], ['org', 'org'], ['channelId', 'channel_id']];

/** A channel's platform as the admin pages name it. */
const platformLabel = (c) => ({ teams: 'Teams', discord: 'Discord', portal: 'Portal' }[c.source] || `Slack${c.shared ? ' Connect' : ''}`);

/**
 * A channel's name as the admin pages show it: on Teams with its team (`acme-support › Main`),
 * on Slack and Discord as `#name`.
 */
export function channelLabel(c) {
  const name = c.name || c.channel_name || c.channel_id || '';
  return c.source === 'teams' && c.group_name ? `${c.group_name} › ${name}` : `#${name}`;
}

/** Letters and digits only, so `aem-acme › Main`, `aem acme main` and `acme/main` meet. */
const compact = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The words of a search, without the ones that are only separators (`›`, `>`, `/`, `#`). */
export function searchWords(q) {
  return String(q || '').toLowerCase().split(/\s+/).filter((w) => compact(w));
}

/**
 * What a search can find a channel by: everything the picker shows of it. Its name, Teams team
 * or Discord server, the two together as shown, its platform, its customer (slug or display
 * name), the team it is filed under and the teams it is shared with, and its id.
 */
function searchFields(c, teamNames = new Map(), sharedWith = []) {
  const teams = [c.team, ...sharedWith].filter(Boolean);
  return [
    ...CHANNEL_FIELDS.map(([field, col]) => [field, c[col]]),
    ['name', c.channel_name],
    ['label', channelLabel(c)],
    ['platform', platformLabel(c)],
    ...teams.flatMap((t) => [['team', t], ['team', teamNames.get(t)]]),
  ].filter(([, v]) => v);
}

/**
 * Which fields of a channel the words of a search are found in, or null when one of the words
 * is in none of them. A channel matches when every word is in one of its fields (see
 * `searchFields`), ignoring case, and spaces and punctuation when the word has them: a search
 * for `acme main` or `aem-acme › Main` finds the Teams channel `aem acme › Main`.
 */
export function channelMatch(c, words, teamNames, sharedWith) {
  const fields = searchFields(c, teamNames, sharedWith)
    .map(([field, v]) => [field, String(v).toLowerCase(), compact(v)]);
  const found = new Set();
  for (const w of words) {
    const cw = compact(w);
    const hit = fields.filter(([, v, cv]) => v.includes(w) || (cw && cv.includes(cw)));
    if (!hit.length) {
      return null;
    }
    // The name as shown only when the word is in it and not in its parts (`acme main`).
    const own = hit.filter(([field]) => field !== 'label');
    (own.length ? own : hit).forEach(([field]) => found.add(field));
  }
  return [...found];
}

/**
 * How well a channel matches a search, for ordering: the search as a whole in its name as shown
 * first, then its name or Teams team starting with it, then containing it.
 */
function matchScore(c, needle) {
  const whole = compact(needle);
  if (whole && compact(channelLabel(c)).includes(whole)) {
    return 3;
  }
  const names = [c.name, c.group_name].map((v) => String(v || '').toLowerCase());
  if (names.some((v) => v.startsWith(needle))) {
    return 2;
  }
  return names.some((v) => v.includes(needle)) ? 1 : 0;
}

/**
 * Every channel opspile has seen but the archived ones, with where its threads are filed, its
 * manual rules and Clef's suggestion. With `q`, only the channels every word of it matches
 * (`channelMatch`), the ones whose name or Teams team matches first.
 */
async function channelList(env, rules, { q = '', team: inTeam, org: inOrg } = {}) {
  const filed = await rows(env, `SELECT c.source, c.tenant, c.channel_id, c.name, c.group_name, c.shared,
      t.team, t.org, o.name AS org_name, t.kind, COUNT(t.thread) AS threads,
      MAX(t.channel_name) AS channel_name, MAX(COALESCE(t.last_at, t.any_at)) AS latest
    FROM channels c LEFT JOIN threads t ON t.source = c.source AND t.tenant = c.tenant
      AND t.channel_id = c.channel_id
    LEFT JOIN orgs o ON o.slug = t.org
    WHERE c.archived_at IS NULL
    GROUP BY c.source, c.tenant, c.channel_id, t.team, t.org, t.kind
    ORDER BY latest DESC`);
  const labels = new Map((await rows(env, 'SELECT * FROM channel_labels'))
    .map((l) => [`${l.source}:${l.tenant}:${l.channel_id}`, l]));
  const shares = await sharesByChannel(env);
  // The shares a follow rule made (src/followrules.js): the rule's, not taken away by hand.
  const byRule = new Map();
  for (const r of await rows(env, `SELECT source, channel_id, team FROM channel_teams
    WHERE added_by LIKE 'rule:%'`)) {
    const k = `${r.source}:${r.channel_id}`;
    byRule.set(k, [...(byRule.get(k) || []), r.team]);
  }
  const needle = q.toLowerCase().trim();
  const words = searchWords(needle);
  const teamNames = words.length
    ? new Map((await rows(env, 'SELECT slug, name FROM teams')).map((t) => [t.slug, t.name]))
    : new Map();
  const manual = (target, channelId) => rules.find((r) => r.target === target && isManual(r)
    && r.pattern === manualPattern(channelId)) || null;
  const out = [];
  for (const c of filed) {
    // The other teams that follow it; a channel shared with a team is on that team's page too.
    const sharedWith = (shares.get(`${c.source}:${c.channel_id}`) || []).filter((t) => t !== c.team);
    const match = words.length ? channelMatch(c, words, teamNames, sharedWith) : [];
    if (match && (!inTeam || c.team === inTeam || sharedWith.includes(inTeam))
      && (!inOrg || c.org === inOrg)) {
      const mt = manual('team', c.channel_id);
      const mo = manual('org', c.channel_id);
      out.push({
        source: c.source,
        tenant: c.tenant,
        channelId: c.channel_id,
        name: c.name || c.channel_name || null,
        groupName: c.group_name,
        shared: Boolean(c.shared),
        team: c.team,
        sharedWith,
        followedByRule: (byRule.get(`${c.source}:${c.channel_id}`) || []).filter((t) => t !== c.team),
        org: c.org,
        orgName: c.org_name || null,
        kind: c.kind,
        threads: c.threads,
        latest: c.latest,
        manual: {
          team: mt && { id: mt.id, value: mt.value },
          org: mo && { id: mo.id, value: mo.value },
        },
        clef: clefOf(labels.get(`${c.source}:${c.tenant}:${c.channel_id}`)),
        ...(words.length ? { match, score: matchScore(c, needle) } : {}),
      });
    }
  }
  if (words.length) {
    out.sort((a, b) => b.score - a.score);
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
  if (source && !PLATFORMS.includes(source)) {
    return { error: `source is ${PLATFORMS.join(', ')} or empty (all)` };
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
  if (target === 'follow' && template) {
    return { error: 'a follow rule names its team' };
  }
  if ((target === 'team' || target === 'follow') && !template) {
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

/**
 * Saves a rule change, or with `dryRun` only says what it would move. `extra` goes with the
 * answer, either way. The follow rules' shares follow the change (src/followrules.js): a failure
 * there is left to the cron, since the rules are saved.
 */
async function applyRules(env, me, {
  next, dryRun, write, extra = {},
}) {
  const moves = await plan(env, next);
  if (dryRun) {
    return json({ dryRun: true, moves, ...extra });
  }
  const saved = await write();
  const jobs = await enqueueMoves(env, moves);
  const follows = await syncFollowRules(env).catch((e) => {
    console.error(JSON.stringify({ route: 'admin', rules: 'follows not synced', error: e.message }));
    return { error: e.message };
  });
  // In the team's inbox now: nothing left to ask for. The rule is saved and its moves are queued,
  // so a failure here must not answer as if it were not; the request stays open, and says so.
  await settleMoved(env, me, moves).catch((e) => {
    console.error(JSON.stringify({ route: 'admin', rules: 'requests not settled', error: e.message }));
  });
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
    ok: true, ...saved, moves, jobs, follows, ...extra,
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
 * The team a channel is filed under by `rules`: what its next message gets. A channel that
 * is not in `channels` (yet) is where its threads are, or nowhere.
 */
async function homeOf(env, rules, source, channelId) {
  const c = await env.DB.prepare(`SELECT * FROM channels WHERE channel_id = ?
    AND (? IS NULL OR source = ?) LIMIT 1`).bind(channelId, source, source).first();
  if (c) {
    return { source: c.source, team: classify(rules, toChannel(c, c.source, c.channel_id)).team };
  }
  const t = await env.DB.prepare(`SELECT source, team FROM threads WHERE channel_id = ?
    AND (? IS NULL OR source = ?) ORDER BY any_at DESC LIMIT 1`).bind(channelId, source, source).first();
  return t || { source, team: UNASSIGNED };
}

/**
 * Adds a team to a channel another team holds: shares it, so the channel stays filed under
 * its team and is in the new team's inbox too. Nothing moves.
 */
async function shareChannel(env, me, { source, channelId, team: slug }, from, dryRun) {
  if (!await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(slug).first()) {
    return bad(`there is no team ${slug}; create it first`);
  }
  const shared = {
    source, channelId, team: slug, from,
  };
  if (dryRun) {
    return json({ dryRun: true, moves: [], shared });
  }
  const added = await share(env, {
    source, channelId, team: slug, by: me.email || String(me.id),
  });
  console.log(JSON.stringify({
    route: 'admin', share: 'added', by: me.id, team: slug, added,
  }));
  return json({
    ok: true, moves: [], jobs: 0, shared: { ...shared, added },
  });
}

/**
 * DELETE /api/admin/share `{ source, channelId, team }`: the team stops following a channel
 * that is shared with it. The channel stays filed where it is.
 */
async function unshareChannel(env, me, body) {
  const channelId = clean(body.channelId);
  const slug = clean(body.team);
  const source = clean(body.source);
  if (!channelId || !slug || !source) {
    return bad('give a source, a channelId and a team');
  }
  const row = await env.DB.prepare(`SELECT added_by FROM channel_teams WHERE source = ?
    AND channel_id = ? AND team = ?`).bind(source, channelId, slug).first();
  if (row && isRuleShare(row.added_by)) {
    return json({
      error: `a follow rule shares this channel with this team (${row.added_by}): change the rule on the team's page`,
    }, 409);
  }
  const removed = await unshare(env, { source, channelId, team: slug });
  if (!removed) {
    return json({ error: 'this channel is not shared with this team' }, 404);
  }
  console.log(JSON.stringify({
    route: 'admin', share: 'removed', by: me.id, team: slug,
  }));
  return json({ ok: true, unshared: { source, channelId, team: slug } });
}

/**
 * POST /api/admin/assign `{ target: team|org, source, channelId, value, move? }`: files one
 * channel under a team or an org, whatever the other rules say (a `channel_id` rule with
 * priority 10). DELETE takes the assignment away again.
 *
 * A channel has one org, but can be in several teams' inboxes: adding a team moves the
 * channel only when the admin team (or nobody) holds it, so it moves for its first team. A
 * channel another team holds is shared with the new team instead, and stays where it is.
 * Handing it to the admin team, or `move`, moves it all the same.
 */
async function assign(env, me, body, remove) {
  const target = clean(body.target);
  const channelId = clean(body.channelId);
  if (!['team', 'org'].includes(target) || !channelId) {
    return bad('give a target (team or org) and a channelId');
  }
  const current = await loadRules(env);
  const source = body.source ? clean(body.source) : null;
  const value = toSlug(clean(body.value));
  let home = null;
  if (target === 'team' && !remove) {
    home = await homeOf(env, current, source, channelId);
    // Handing a channel to the admin team is always a move: it holds what no team has.
    if (!body.move && !isHolding(home.team) && !isHolding(value) && home.team !== value) {
      const shared = await shareChannel(env, me, {
        source: source || home.source, channelId, team: value,
      }, home.team, body.dryRun);
      if (shared.ok && !body.dryRun) {
        await settleRequests(env, me, { channelId, team: value, outcome: 'shared' });
      }
      return shared;
    }
  }
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
    source,
    note: MANUAL_NOTE,
    dryRun: body.dryRun,
  };
  const res = await (existing
    ? updateRule(env, me, { ...payload, id: existing.id })
    : createRule(env, me, payload));
  // The team the channel is filed under now does not need it shared with it as well.
  if (target === 'team' && res.ok && !body.dryRun && (source || home.source)) {
    await unshare(env, { source: source || home.source, channelId, team: value });
  }
  // The open requests for it, if any, are answered with it.
  if (target === 'team' && res.ok && !body.dryRun) {
    const outcome = outcomeOf(await res.clone().json());
    await settleRequests(env, me, { channelId, team: value, outcome });
  }
  return res;
}

/**
 * POST /api/admin/swap `{ source, channelId, team }`: a channel shared with `team` is filed
 * under it instead (a manual assignment, as `assign` with `move` makes, so its folders,
 * knowledge base and agents move), and the team it was filed under keeps it in its inbox,
 * shared. For the admin team, and for whoever manages both teams. A channel the admin team
 * (or nobody) held is moved only: those teams hold, they do not share.
 */
async function swapChannel(env, me, body) {
  const channelId = clean(body.channelId);
  const slug = clean(body.team);
  const source = clean(body.source);
  if (!channelId || !slug || !source) {
    return bad('give a source, a channelId and a team');
  }
  if (!(await sharesOf(env, source, channelId)).includes(slug)) {
    return json({ error: 'this channel is not shared with this team' }, 404);
  }
  const home = await homeOf(env, await loadRules(env), source, channelId);
  const from = home.team;
  if (from === slug) {
    return json({ error: 'this channel is filed under this team already' }, 409);
  }
  if (!isAdmin(me) && !(managesTeam(me, slug) && managesTeam(me, from))) {
    return json({ error: 'only the admin team, or a manager of both teams, may swap them' }, 403);
  }
  const res = await assign(env, me, {
    target: 'team', source, channelId, value: slug, move: true,
  }, false);
  if (!res.ok) {
    return res;
  }
  const done = await res.json();
  const shared = !isHolding(from) && await share(env, {
    source, channelId, team: from, by: me.email || String(me.id),
  });
  console.log(JSON.stringify({
    route: 'admin', share: 'swapped', by: me.id, team: slug, from, moves: done.moves.length,
  }));
  return json({
    ...done,
    swapped: {
      source, channelId, team: slug, from, shared: Boolean(shared),
    },
  });
}

// ---- assignment requests ----------------------------------------------------------------

/**
 * GET /api/admin/requests?status=open|decided&count=1: the channel assignment requests, the
 * open ones first. The admin team sees every team's; a manager those of the teams they manage.
 * `open` counts the open ones; with `count`, that is all the answer says.
 */
async function requestList(env, me, { status, count }) {
  const teams = isAdmin(me) ? null : managedTeams(me);
  // The customers waiting in the portal count too: they are the admin team's to answer; and so do
  // the conflicts between the teams' technologies (src/techconflicts.js), the admin team's only.
  const conflicts = isAdmin(me) ? await techConflicts(env) : [];
  // And the conflicts between team rules (src/ruleconflicts.js), the admin team's too.
  const rules = isAdmin(me) ? await ruleConflicts(env) : [];
  const open = await openCount(env, teams) + await portalOpenCount(env, teams)
    + conflicts.filter((c) => !c.kept).length + rules.filter((c) => !c.kept).length;
  if (count) {
    return json({ open });
  }
  return json({
    requests: await listRequests(env, { teams, status: ['open', 'decided'].includes(status) ? status : null }),
    portal: await listPortalRequests(env, { teams }),
    portalBound: portalBound(env),
    conflicts,
    ruleConflicts: rules,
    open,
  });
}

/**
 * POST /api/admin/rule-conflicts `{ key, action, fingerprint?, note?, dryRun? }`: the admin team
 * settles a conflict between team rules (src/ruleconflicts.js). `follow`: side a files the
 * channels, and b's rule becomes a follow rule (a manual assignment of one channel, a share of
 * it); `exclude`: b's, and a's rule leaves b's out (or a's manual assignments of them go);
 * `keep`: as it is. `fingerprint` is the conflict's as it was shown: a conflict that changed
 * since is not settled (409). `dryRun` answers with the channels it would move (`moves`) and the
 * ones b would follow (`follows`); applied, with the conflicts as they are after it.
 */
async function settleRuleConflict(env, me, body) {
  const key = clean(body.key, 500);
  const action = clean(body.action);
  const rules = await loadRules(env);
  const c = (await ruleConflicts(env, { rules })).find((x) => x.key === key);
  if (!c) {
    return json({ error: 'no such conflict: it may be settled already', ruleConflicts: await ruleConflicts(env) }, 404);
  }
  if (body.fingerprint && body.fingerprint !== c.fingerprint) {
    return json({ error: 'the conflict changed since it was shown: look at it again', conflict: c }, 409);
  }
  if (action === 'keep') {
    if (body.dryRun) {
      return json({ dryRun: true, moves: [], follows: [] });
    }
    await env.DB.prepare(`INSERT INTO rule_conflict_keeps (key, fingerprint, kept_by, kept_at, note)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET fingerprint = excluded.fingerprint,
        kept_by = excluded.kept_by, kept_at = excluded.kept_at, note = excluded.note`)
      .bind(key, c.fingerprint, ...stamp(me), clean(body.note, 300) || null).run();
    console.log(JSON.stringify({ route: 'admin', ruleConflict: 'kept', by: me.id }));
    return json({ ok: true, done: 'kept', ruleConflicts: await ruleConflicts(env) });
  }
  const channels = await knownChannels(env);
  const s = settlement(c, action, rules, channels);
  if (s.error) {
    return bad(s.error);
  }
  // The channels b follows after it: its follow rules', and its manual assignments' shares.
  const live = channels.filter((x) => !x.archived);
  const byKey = new Map(live.map((x) => [`${x.source}:${x.channelId}`, x]));
  const followed = action !== 'follow' ? [] : [
    ...[...wantedFollows(s.next, live).values()]
      .filter((w) => w.team === c.b.team && c.follow.rules.includes(w.rule)),
    ...s.shares,
  ].map((w) => byKey.get(`${w.source}:${w.channelId}`)).filter(Boolean)
    .map((x) => ({
      source: x.source, channelId: x.channelId, name: x.name, groupName: x.groupName,
    }));
  const res = await applyRules(env, me, {
    next: s.next,
    dryRun: body.dryRun,
    extra: { follows: followed },
    write: async () => {
      const [by, at] = stamp(me);
      await env.DB.batch([
        ...s.updates.map((u) => (u.target
          ? env.DB.prepare('UPDATE rules SET target = ?, updated_by = ?, updated_at = ? WHERE id = ?')
            .bind(u.target, by, at, u.id)
          : env.DB.prepare('UPDATE rules SET pattern = ?, updated_by = ?, updated_at = ? WHERE id = ?')
            .bind(u.pattern, by, at, u.id))),
        ...s.deletes.map((id) => env.DB.prepare('DELETE FROM rules WHERE id = ?').bind(id)),
        ...s.shares.map((x) => env.DB.prepare(`INSERT INTO channel_teams (source, channel_id, team,
            added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
          .bind(x.source, String(x.channelId), x.team, by, at)),
      ]);
      console.log(JSON.stringify({
        route: 'admin', ruleConflict: action, by: me.id, updates: s.updates.length, deletes: s.deletes.length,
      }));
      return { done: action };
    },
  });
  if (body.dryRun || !res.ok) {
    return res;
  }
  return json({ ...(await res.json()), ruleConflicts: await ruleConflicts(env) });
}

/**
 * POST /api/admin/conflicts `{ key, action, … }`: the admin team settles a conflict between the
 * teams' technologies (src/techconflicts.js `resolveConflict`); the answer has the conflicts as
 * they are after it.
 */
async function settleConflict(env, me, body) {
  const r = await resolveConflict(env, me, body);
  if (r.error) {
    return json({ error: r.error, changes: r.changes || [] }, r.status || 400);
  }
  return json({ ...r, conflicts: await techConflicts(env) });
}

/** An open request, or the answer that says why it cannot be decided. */
async function openRequest(env, id) {
  const r = await getRequest(env, id);
  if (!r) {
    return { error: json({ error: 'no such request' }, 404) };
  }
  if (r.status !== 'open') {
    return { error: json({ error: `this request is ${r.status} already`, request: r }, 409) };
  }
  return { request: r };
}

/** Whether a channel is assigned to or shared with a team, by hand. */
async function assigned(env, { source, channelId }, slug) {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM rules WHERE target = 'team'
      AND field = 'channel_id' AND pattern = ?1 AND value = ?2
    UNION SELECT 1 FROM channel_teams WHERE source = ?3 AND channel_id = ?4 AND team = ?2 LIMIT 1`)
    .bind(manualPattern(channelId), slug, source, channelId).first());
}

/**
 * POST /api/admin/requests/confirm `{ id, dryRun?, move? }`: the admin team grants a request.
 * It is the manual assignment of `assign`, as if made on the team's page (with `move` when the
 * request asks for a move, src/requests.js): `dryRun` says what
 * it would move (or that it would share the channel), and applied, the channel is re-filed or
 * shared and the request is confirmed, with who confirmed it and what came of it.
 */
async function confirmRequest(env, me, body) {
  const { request, error } = await openRequest(env, body.id);
  if (error) {
    return error;
  }
  const { channel } = request;
  const assignment = () => assign(env, me, {
    target: 'team',
    source: channel.source,
    channelId: channel.channelId,
    value: request.team,
    // A move request moves, whoever holds the channel; the admin team may move any request.
    move: body.move || request.move,
    dryRun: body.dryRun,
  }, false);
  if (body.dryRun) {
    const res = await assignment();
    return json({ ...await res.json(), request }, res.status);
  }
  // Claimed first: whoever closes it decides, and a request declined or withdrawn meanwhile moves
  // nothing. A failed assignment opens it again.
  if (!await claimRequest(env, me, request.id)) {
    return json({
      error: 'decided meanwhile', closed: false, request: await getRequest(env, request.id),
    }, 409);
  }
  let res;
  try {
    res = await assignment();
  } catch (e) {
    // The rule may be saved and the channel on its way, whatever failed after that.
    if (await assigned(env, channel, request.team)) {
      await recordOutcome(env, request.id, 'assigned');
    } else {
      await reopenRequest(env, request.id);
    }
    throw e;
  }
  const answer = await res.json();
  if (!res.ok) {
    return json({ ...answer, request: await reopenRequest(env, request.id) }, res.status);
  }
  const outcome = outcomeOf(answer);
  console.log(JSON.stringify({
    route: 'admin', request: 'confirmed', by: me.id, id: request.id, outcome, closed: true,
  }));
  return json({
    ...answer, closed: true, request: await recordOutcome(env, request.id, outcome),
  });
}

/** POST /api/admin/requests/decline `{ id, reason? }`: the admin team turns a request down. */
async function declineRequest(env, me, body) {
  const { request, error } = await openRequest(env, body.id);
  if (error) {
    return error;
  }
  const closed = await closeRequest(env, me, request.id, {
    status: 'declined', reason: clean(body.reason, 500) || null,
  });
  return closed.closed ? json({ ok: true, ...closed }) : json({ error: 'decided meanwhile', ...closed }, 409);
}

/** DELETE /api/admin/requests `{ id, team }`: a manager takes their team's open request back. */
async function withdrawRequest(env, me, body) {
  const { request, error } = await openRequest(env, body.id);
  if (error) {
    return error;
  }
  if (request.team !== clean(body.team)) {
    return json({ error: 'this request is for another team' }, 403);
  }
  const closed = await closeRequest(env, me, request.id, { status: 'withdrawn' });
  return closed.closed ? json({ ok: true, ...closed }) : json({ error: 'decided meanwhile', ...closed }, 409);
}

// ---- customer portal requests -----------------------------------------------------------

const DEFAULT_CHANNEL = 'support';

/**
 * POST /api/admin/portal/open `{ id, team, name?, org?, share?, topic?, welcome? }`: opens a
 * channel in the customer portal for the lobby of request `id`, and puts it in the inbox. The
 * portal makes the channel (every member of the lobby is in it); here it is filed under `team`
 * and the customer `org` by hand, as a manual assignment does, shared with the teams of
 * `share`, and `welcome` is posted in it as the person who opens it, which starts its first
 * thread. The admin team picks any team and customer; a manager opens it for a team they
 * manage that follows a technology the lobby picked, under the customer the inbox suggests.
 * A lobby that has a channel can get another the same way.
 */
async function openPortal(env, me, body) {
  const r = await getPortalRequest(env, body.id);
  if (!r) {
    return json({ error: 'no such request' }, 404);
  }
  if (r.status === 'declined') {
    return json({ error: 'this request was declined: the customer asks again first', request: r }, 409);
  }
  const everything = isAdmin(me);
  const slug = toSlug(clean(body.team));
  if (!await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(slug).first()) {
    return bad('give the team the channel is for');
  }
  if (!everything && !r.teams.some((t) => t.team === slug)) {
    return json({ error: 'your team follows none of the technologies this customer picked' }, 403);
  }
  if (!portalBound(env)) {
    return json({ error: 'the customer portal is not connected to this inbox' }, 409);
  }
  const name = toSlug(clean(body.name, 80) || r.suggest.name);
  const customer = everything && clean(body.org) ? toSlug(clean(body.org)) : r.suggest.org;
  if (!SLUG.test(customer)) {
    return bad('a customer is lowercase letters, digits and -, like acme');
  }
  const topic = clean(body.topic, 300) || null;
  const opened = await portalCall(env, 'open', {
    domain: r.domain,
    name: name === UNASSIGNED ? DEFAULT_CHANNEL : name,
    topic,
    by: await portalAuthor(env, me),
  });
  if (opened.error || !opened.channel) {
    return json({ error: opened.error || 'the portal opened no channel' }, opened.status === 404 ? 404 : 502);
  }
  const channelId = opened.channel.id;
  const now = new Date().toISOString();
  // The channel as the inbox knows it, before its first message says the same.
  await env.DB.prepare(`INSERT INTO channels (source, tenant, channel_id, name, group_id,
      group_name, shared, connected, topic, fetched_at)
    VALUES ('portal', ?, ?, ?, ?, ?, 1, '[]', ?, ?) ON CONFLICT DO NOTHING`)
    .bind(r.domain, channelId, opened.channel.name, r.domain, r.company, topic, now).run();
  // A customer the inbox has not met is named as it calls itself, with the logo it uploaded
  // in the portal (served by this Worker, so an address under its origin), else its domain's.
  const origin = String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  const icon = r.logo && origin ? `${origin}/api/portal/logo/${r.domain}` : r.domain;
  await env.DB.prepare(`INSERT INTO orgs (slug, name, type, icon, updated_at)
    VALUES (?, ?, 'customer', ?, ?) ON CONFLICT (slug) DO NOTHING`)
    .bind(customer, r.company || null, icon, now).run();
  await ensureKnowledgeBase(env, 'org', customer).catch(() => null);
  for (const [target, value] of [['team', slug], ['org', customer]]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await assign(env, me, {
      target, source: 'portal', channelId, value, move: true,
    }, false);
    if (!res.ok) {
      // eslint-disable-next-line no-await-in-loop
      const { error } = await res.json().catch(() => ({}));
      return json({
        error: `the channel is open in the portal, but could not be filed under ${value}: ${error || res.status}. Assign it on the team's page.`,
        channel: { source: 'portal', channelId },
      }, 502);
    }
  }
  const shared = [];
  const others = everything && Array.isArray(body.share)
    ? body.share.map((x) => toSlug(clean(x))) : [];
  for (const other of others.filter((x) => x !== slug)) {
    // eslint-disable-next-line no-await-in-loop
    if (await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(other).first()) {
      // eslint-disable-next-line no-await-in-loop
      await share(env, {
        source: 'portal', channelId, team: other, by: me.email || String(me.id),
      });
      shared.push(other);
    }
  }
  const request = await recordOpened(env, me, r.id, { channelId, team: slug, org: customer });
  // The welcome message, as the person: it comes back through the portal's events, and is the
  // channel's first thread.
  const text = String(body.welcome ?? '').trim().slice(0, 8000);
  const welcome = text ? await portalCall(env, 'post', {
    domain: r.domain, channel: channelId, text, author: await portalAuthor(env, me),
  }) : null;
  console.log(JSON.stringify({
    route: 'admin',
    portal: 'opened',
    by: me.id,
    id: r.id,
    team: slug,
    shared: shared.length,
    welcome: Boolean(welcome && welcome.ok),
  }));
  return json({
    ok: true,
    request,
    channel: {
      source: 'portal',
      tenant: r.domain,
      channelId,
      name: opened.channel.name,
      team: slug,
      org: customer,
    },
    shared,
    ...(welcome ? {
      welcome: welcome.ok ? { id: welcome.id } : { error: welcome.error },
      ...(welcome.ok ? { thread: `portal:${r.domain}:${channelId}:${welcome.id}` } : {}),
    } : {}),
  });
}

/**
 * POST /api/admin/portal/decline `{ id, reason? }`: the admin team turns a lobby's request
 * down, with a reason the customer reads in the portal. They may ask again.
 */
async function declinePortal(env, me, body) {
  const r = await getPortalRequest(env, body.id);
  if (!r) {
    return json({ error: 'no such request' }, 404);
  }
  const reason = clean(body.reason, 500) || null;
  if (r.status !== 'open' || !await recordDeclined(env, me, r.id, reason)) {
    return json({
      error: `this request is ${r.status} already`, request: await getPortalRequest(env, r.id),
    }, 409);
  }
  const res = await portalCall(env, 'decline', { domain: r.domain, reason });
  // A lobby that is not waiting any more (it has a channel, or was declined) is as it is.
  if (res.error && res.status !== 409) {
    await reopenDeclined(env, r.id);
    return json({ error: res.error, request: await getPortalRequest(env, r.id) }, 502);
  }
  console.log(JSON.stringify({
    route: 'admin', portal: 'declined', by: me.id, id: r.id,
  }));
  return json({ ok: true, request: await getPortalRequest(env, r.id) });
}

// ---- teams and members ------------------------------------------------------------------

/** SQL: the channel of the threads row `t` is not archived (the lists count no archived ones). */
const LIVE = (t) => `NOT EXISTS (SELECT 1 FROM channels ac WHERE ac.source = ${t}.source
  AND ac.tenant = ${t}.tenant AND ac.channel_id = ${t}.channel_id AND ac.archived_at IS NOT NULL)`;

async function listTeams(env, me) {
  const all = await rows(env, `SELECT t.slug, t.name, t.self_managed,
      (SELECT COUNT(*) FROM team_members m WHERE m.team = t.slug) AS members,
      (SELECT COUNT(*) FROM team_members m WHERE m.team = t.slug AND m.role = 'manager') AS managers,
      (SELECT COUNT(*) FROM rules r WHERE r.target IN ('team', 'follow') AND r.value = t.slug) AS rules,
      (SELECT COUNT(DISTINCT th.channel_id) FROM threads th WHERE th.team = t.slug
        AND ${LIVE('th')}) AS channels,
      (SELECT COUNT(*) FROM threads th WHERE th.team = t.slug) AS threads,
      (SELECT COUNT(*) FROM channel_teams s WHERE s.team = t.slug) AS shared
    FROM teams t ORDER BY t.name`);
  const everything = isAdmin(me);
  const teams = all.filter((t) => everything || managedTeams(me).includes(t.slug))
    .map((t) => ({ ...t, self_managed: Boolean(t.self_managed) }));
  const unassigned = everything ? await env.DB.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN ${LIVE('t')} THEN t.channel_id END) AS channels,
      COUNT(*) AS threads FROM threads t WHERE t.team = ?`).bind(UNASSIGNED).first() : null;
  // The open assignment requests: the admin team's to decide, the managers' to wait for; and
  // the customers waiting in the portal, theirs to open a channel for.
  const scope = everything ? null : managedTeams(me);
  const requests = await openCount(env, scope) + await portalOpenCount(env, scope)
    + (everything ? await openConflictCount(env)
      + (await ruleConflicts(env, { kept: false })).length : 0);
  // Every team's name, for a manager's page to say where a channel is now.
  const names = Object.fromEntries(all.map((t) => [t.slug, t.name]));
  return json({
    teams, unassigned, admin: everything, requests, names,
  });
}

async function team(env, slug, me) {
  const t = await env.DB.prepare('SELECT slug, name, self_managed FROM teams WHERE slug = ?').bind(slug).first();
  if (!t && slug !== UNASSIGNED) {
    return json({ error: 'no such team' }, 404);
  }
  const rules = await loadRules(env);
  return json({
    team: t ? { ...t, self_managed: Boolean(t.self_managed) } : { slug, name: 'Unassigned', self_managed: false },
    members: await rows(env, `SELECT p.id, p.name, p.email, p.staff, m.role FROM team_members m
      JOIN people p ON p.id = m.person WHERE m.team = ? ORDER BY p.name`, slug),
    rules: rules.filter((r) => (r.target === 'team' && (r.value === slug || /\$\d/.test(r.value)))
      || (r.target === 'follow' && r.value === slug))
      .sort((a, b) => a.priority - b.priority || a.id - b.id),
    channels: await channelList(env, rules, { team: slug }),
    // What the team's managers asked the admin team for, and what came of it.
    requests: t ? await listRequests(env, { teams: [slug], limit: 50 }) : [],
    // The customers in the portal who picked a technology the team follows.
    portal: t ? await listPortalRequests(env, { teams: [slug], limit: 50 }) : [],
    portalBound: portalBound(env),
    // The technologies it follows (src/follows.js), and what it may follow.
    ...(t ? {
      follows: await teamFollows(env, slug), followable: await followable(env, slug),
    } : {}),
    // The admin team decides which channels a team gets: what it might want of the admin
    // team's channels.
    ...(isAdmin(me) && t && slug !== ADMIN_TEAM ? await suggestionsFor(env, slug) : {}),
  });
}

/**
 * PUT /api/admin/follows `{ team, tech, follow }`: team `team` follows technology `tech` (or, with
 * `follow: false`, no more), so that the threads that show it are in its inbox (src/follows.js).
 * The team's managers and the admin team. Answers with what the team follows now.
 */
async function followTech(env, me, body) {
  const slug = clean(body.team);
  const t = slug && await env.DB.prepare('SELECT slug FROM teams WHERE slug = ?').bind(slug).first();
  if (!t) {
    return json({ error: 'no such team' }, 404);
  }
  const res = await setTeamFollow(env, {
    team: slug,
    tech: clean(body.tech),
    follow: body.follow !== false,
    by: me.email || String(me.id),
  });
  if (res.error) {
    return bad(res.error);
  }
  console.log(JSON.stringify({
    route: 'admin', follows: slug, tech: clean(body.tech), follow: body.follow !== false, by: me.id,
  }));
  return json({ ok: true, changed: res.changed, follows: await teamFollows(env, slug) });
}

/**
 * What a new team starts with, as `by` (a name): thread agents on by default in its channels
 * (`agent_teams`), and the agent tools and global MCP servers marked `newTeams` on for the
 * team. Its managers switch any of them off in the knowledge-base editor.
 */
async function newTeamDefaults(env, slug, by) {
  await setTeamDefault(env, slug, true, by);
  for (const t of AGENT_TOOLS.filter((x) => x.newTeams && !x.internal)) {
    // eslint-disable-next-line no-await-in-loop
    await setToolSwitch(env, {
      tool: t.tool, scope: 'team', target: slug, enabled: true, by,
    });
  }
  for (const g of GLOBAL_SERVERS.filter((x) => x.newTeams)) {
    // eslint-disable-next-line no-await-in-loop
    await setGlobalSwitch(env, {
      server: g.server, scope: 'team', target: slug, enabled: true, by,
    });
  }
}

/** POST /api/admin/teams `{ slug, name }`: a new team, with what new teams start with. */
async function createTeam(env, me, body) {
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
  await newTeamDefaults(env, slug, me.name || me.email);
  await ensureKnowledgeBase(env, 'team', slug).catch(() => null);
  return json({ ok: true, team: { slug, name } });
}

/**
 * PUT /api/admin/teams `{ slug, name?, selfManaged? }`: renames a team, or makes it
 * self-managed (every member a team manager, now and when they join) or not (roles stay as
 * they are; new members join as members).
 */
async function updateTeam(env, body) {
  const slug = clean(body.slug);
  if (!await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(slug).first()) {
    return json({ error: 'no such team' }, 404);
  }
  if (body.name !== undefined) {
    const name = clean(body.name);
    if (!name) {
      return bad('give the team a name');
    }
    await env.DB.prepare('UPDATE teams SET name = ? WHERE slug = ?').bind(name, slug).run();
  }
  if (body.selfManaged !== undefined) {
    const on = Boolean(body.selfManaged);
    await env.DB.prepare('UPDATE teams SET self_managed = ? WHERE slug = ?').bind(on ? 1 : 0, slug).run();
    if (on) {
      await env.DB.prepare("UPDATE team_members SET role = 'manager' WHERE team = ?").bind(slug).run();
    }
  }
  const t = await env.DB.prepare('SELECT slug, name, self_managed FROM teams WHERE slug = ?').bind(slug).first();
  return json({ ok: true, team: { ...t, self_managed: Boolean(t.self_managed) } });
}

async function deleteTeam(env, body) {
  const slug = clean(body.slug);
  if (slug === ADMIN_TEAM) {
    return bad('the admin team cannot be deleted');
  }
  const used = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM rules WHERE target IN ('team', 'follow') AND value = ?) AS rules,
      (SELECT COUNT(*) FROM threads WHERE team = ?) AS threads`).bind(slug, slug).first();
  if (used.rules || used.threads) {
    return json({
      error: `the team still has ${used.rules} rule(s) and ${used.threads} thread(s); move its channels to another team first`,
    }, 409);
  }
  // The channels shared with it stay filed where they are (migration 0024 cascades too).
  await env.DB.prepare('DELETE FROM channel_teams WHERE team = ?').bind(slug).run();
  // So is what it had switched on: a team made later with its slug starts afresh.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM agent_teams WHERE team = ?').bind(slug),
    env.DB.prepare('DELETE FROM agent_tool_switches WHERE scope = \'team\' AND target = ?').bind(slug),
    env.DB.prepare('DELETE FROM agent_tool_options WHERE team = ?').bind(slug),
    env.DB.prepare('DELETE FROM mcp_global_switches WHERE scope = \'team\' AND target = ?').bind(slug),
  ]);
  const { meta } = await env.DB.prepare('DELETE FROM teams WHERE slug = ?').bind(slug).run();
  return meta.changes ? json({ ok: true }) : json({ error: 'no such team' }, 404);
}

async function addMember(env, body) {
  const teamSlug = clean(body.team);
  const email = clean(body.email).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return bad('give the person\'s email address');
  }
  const t = await env.DB.prepare('SELECT self_managed FROM teams WHERE slug = ?').bind(teamSlug).first();
  if (!t) {
    return json({ error: 'no such team' }, 404);
  }
  // The name comes from the person's platform account, if opspile has seen one.
  const account = await env.DB.prepare(`SELECT name FROM identities WHERE LOWER(email) = ?
    AND kind = 'person' AND name IS NOT NULL LIMIT 1`).bind(email).first();
  const name = (account && account.name) || clean(body.name) || null;
  // Team members are staff; a person who posted before has a row already.
  await env.DB.prepare(`INSERT INTO people (email, name, staff) VALUES (?, ?, 1)
    ON CONFLICT (email) DO UPDATE SET staff = 1, name = COALESCE(people.name, excluded.name)`)
    .bind(email, name).run();
  const person = await env.DB.prepare('SELECT id, name, email, staff FROM people WHERE email = ?').bind(email).first();
  // In a self-managed team everyone is a manager, newcomers too.
  const role = t.self_managed ? 'manager' : 'member';
  await env.DB.prepare(`INSERT INTO team_members (team, person, role) VALUES (?, ?, ?)
    ON CONFLICT (team, person) DO UPDATE SET role = CASE WHEN ? THEN 'manager' ELSE team_members.role END`)
    .bind(teamSlug, person.id, role, t.self_managed ? 1 : 0).run();
  const member = await env.DB.prepare('SELECT role FROM team_members WHERE team = ? AND person = ?')
    .bind(teamSlug, person.id).first();
  // Identities with this email belong to the person from now on.
  await env.DB.prepare('UPDATE identities SET person = ? WHERE email = ? AND person IS NULL')
    .bind(person.id, email).run();
  return json({ ok: true, person: { ...person, role: member.role } });
}

/**
 * PUT /api/admin/members `{ team, person, role }`: promotes a member to team manager, or
 * demotes them. A self-managed team has only managers.
 */
async function setRole(env, body) {
  const teamSlug = clean(body.team);
  const role = clean(body.role);
  if (!['member', 'manager'].includes(role)) {
    return bad('the role is member or manager');
  }
  const t = await env.DB.prepare('SELECT self_managed FROM teams WHERE slug = ?').bind(teamSlug).first();
  if (!t) {
    return json({ error: 'no such team' }, 404);
  }
  if (t.self_managed && role === 'member') {
    return json({ error: 'in a self-managed team every member is a manager; turn that off first' }, 409);
  }
  const { meta } = await env.DB.prepare('UPDATE team_members SET role = ? WHERE team = ? AND person = ?')
    .bind(role, teamSlug, Number(body.person)).run();
  return meta.changes ? json({ ok: true, role }) : json({ error: 'not a member' }, 404);
}

/**
 * GET /api/admin/people?q=&team=: people to add to a team, for the autocomplete. Everyone
 * opspile knows by name or email: people in D1, and platform accounts with an email that
 * are not linked to one yet (somebody who posted but was never added). Staff first; the
 * team's members are left out.
 */
async function people(env, q, teamSlug) {
  const asked = String(q || '').trim().toLowerCase();
  if (asked.length < 2) {
    return json({ people: [] });
  }
  // Cut to what D1 takes: a pasted list of addresses finds nobody, instead of failing.
  const needle = likePattern(asked);
  const known = await rows(env, `SELECT p.id, p.name, p.email, p.staff,
      (SELECT GROUP_CONCAT(team, ',') FROM team_members m WHERE m.person = p.id) AS teams
    FROM people p
    WHERE p.email IS NOT NULL
      AND (LOWER(p.name) LIKE ?1 ESCAPE '\\' OR LOWER(p.email) LIKE ?1 ESCAPE '\\')
      AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.person = p.id AND m.team = ?2)
    LIMIT 40`, needle, teamSlug || '');
  const accounts = await rows(env, `SELECT MAX(i.name) AS name, LOWER(i.email) AS email
    FROM identities i
    WHERE i.person IS NULL AND i.kind = 'person' AND i.email IS NOT NULL
      AND (LOWER(i.name) LIKE ?1 ESCAPE '\\' OR LOWER(i.email) LIKE ?1 ESCAPE '\\')
      AND NOT EXISTS (SELECT 1 FROM people p WHERE p.email = i.email)
    GROUP BY LOWER(i.email) LIMIT 40`, needle);
  const list = [
    ...known.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      staff: Boolean(p.staff) || isStaffDomain(env, p.email),
      teams: p.teams ? p.teams.split(',') : [],
    })),
    ...accounts.map((a) => ({
      id: null, name: a.name, email: a.email, staff: isStaffDomain(env, a.email), teams: [],
    })),
  ];
  const label = (x) => String(x.name || x.email);
  list.sort((a, b) => (b.staff - a.staff) || label(a).localeCompare(label(b)));
  return json({ people: list.slice(0, 20) });
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

/**
 * The mail domains of the people outside Adobe who post in an org's threads (all orgs', or
 * `slug`'s), most people first: `Map<org, [domain]>`. Free mail and tenant domains are left
 * out; the first is the org's usual mail domain, whose favicon it has without an icon.
 */
async function mailDomains(env, slug = null) {
  const list = await rows(env, `SELECT t.org, LOWER(SUBSTR(i.email, INSTR(i.email, '@') + 1)) AS domain,
      COUNT(DISTINCT m.thread || ' ' || m.author_key) AS n
    FROM messages m JOIN threads t ON t.thread = m.thread
    JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +m.author_key
    WHERE m.staff = 0 AND m.deleted = 0 AND m.counted = 1 AND i.email LIKE '%_@_%'
      AND (?1 IS NULL OR t.org = ?1)
    GROUP BY t.org, domain ORDER BY t.org, n DESC, domain`, slug);
  const by = new Map();
  for (const r of list) {
    if (orgDomain(env, r.domain)) {
      if (!by.has(r.org)) {
        by.set(r.org, []);
      }
      by.get(r.org).push(r.domain);
    }
  }
  return by;
}

/**
 * Every org: the ones with a row, and every slug the rules filed threads or a base under.
 * `domain` is its usual mail domain, whose favicon it is shown with when it has no icon.
 */
async function listOrgs(env) {
  const list = await rows(env, `SELECT s.slug, o.name, COALESCE(o.type, 'customer') AS type, o.icon,
      (SELECT COUNT(DISTINCT channel_id) FROM threads t WHERE t.org = s.slug AND ${LIVE('t')})
        AS channels,
      (SELECT COUNT(*) FROM threads t WHERE t.org = s.slug) AS threads,
      (SELECT MAX(COALESCE(last_at, any_at)) FROM threads t WHERE t.org = s.slug) AS latest
    FROM (SELECT slug FROM orgs UNION SELECT DISTINCT org FROM threads
      UNION SELECT slug FROM knowledge_bases WHERE kind = 'org') s
    LEFT JOIN orgs o ON o.slug = s.slug
    WHERE s.slug != ?
    ORDER BY COALESCE(o.name, s.slug)`, UNASSIGNED);
  const domains = await mailDomains(env);
  for (const o of list) {
    o.domain = (domains.get(o.slug) || [])[0] || null;
  }
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
    domains: ((await mailDomains(env, slug)).get(slug) || []).slice(0, 3),
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

/**
 * GET /api/admin/org-icons?slug=[&fresh=1]: icons for an org, found on the websites its name
 * and its people's mail domains suggest and ranked by Clef (src/favicons.js), likeliest first.
 */
async function orgIcons(env, slug, fresh) {
  if (!SLUG.test(slug)) {
    return bad('give an org slug');
  }
  const row = await env.DB.prepare('SELECT name, type FROM orgs WHERE slug = ?').bind(slug).first();
  const domains = ((await mailDomains(env, slug)).get(slug) || []).slice(0, 3);
  const icons = await findIcons(env, {
    slug, name: row && row.name, type: (row && row.type) || 'customer', domains,
  }, { fresh });
  return json({ icons });
}

/**
 * POST /api/admin/topics: builds a topic map now (src/topicmap.js), which takes a while (half a
 * minute for a few hundred threads), and answers with it as GET /api/admin/topics does.
 */
async function buildTopics(env, me) {
  const built = await buildTopicMap(env, { by: (me && me.name) || 'admin' });
  if (built.error) {
    return json({ error: built.error }, env.CONTENT && env.AI ? 400 : 503);
  }
  return json({ latest: await latestTopicMap(env), available: true });
}

// ---- routes -----------------------------------------------------------------------------

/** Routes `/api/admin/*` for a member of the admin team. Returns null for other paths. */
/**
 * After a membership change succeeded, the sign-in allow list follows (Cloudflare Access):
 * the answer then says `access: { added, removed }` (counts), or `access: { error }`.
 */
async function withAccessSync(env, why, pending) {
  const res = await pending;
  if (!res.ok) {
    return res;
  }
  const access = await syncAccessQuietly(env, why);
  const body = await res.json();
  return json({ ...body, access }, res.status);
}

export async function admin(request, env, url, me) {
  const p = url.pathname;
  if (!p.startsWith('/api/admin/')) {
    return null;
  }
  const m = request.method;
  const body = m === 'GET' ? {} : await request.json().catch(() => ({}));
  const q = (k) => clean(url.searchParams.get(k));
  const route = `${m} ${p.slice('/api/admin/'.length)}`;
  // Team managers: their teams' members, the channel search, and requests for their teams.
  const teamOf = m === 'GET' ? q('team') || q('slug') : clean(body.team);
  const forManagers = ['GET teams', 'GET team', 'GET people', 'POST members', 'DELETE members', 'PUT members',
    'GET channels', 'GET requests', 'POST requests', 'DELETE requests', 'PUT follows',
    'POST portal/open', 'POST swap'];
  // Every manager may search channels; the requests they see are their teams' (`requests`).
  const anyTeam = ['GET teams', 'GET channels', 'GET requests'];
  if (!isAdmin(me)) {
    if (!forManagers.includes(route)) {
      return json({ error: 'for the admin team' }, 403);
    }
    if (!anyTeam.includes(route) && !managesTeam(me, teamOf)) {
      return json({ error: 'you do not manage this team' }, 403);
    }
  }
  switch (route) {
    case 'GET teams': return listTeams(env, me);
    case 'POST teams': return createTeam(env, me, body);
    case 'PUT teams': return updateTeam(env, body);
    case 'DELETE teams': return withAccessSync(env, 'team deleted', deleteTeam(env, body));
    case 'GET team': return team(env, q('slug'), me);
    case 'POST members': return withAccessSync(env, 'member added', addMember(env, body));
    case 'PUT members': return setRole(env, body);
    case 'GET people': return people(env, clean(url.searchParams.get('q')), q('team'));
    case 'DELETE members': return withAccessSync(env, 'member removed', removeMember(env, me, body));
    case 'GET rules': return json({ rules: await loadRules(env), fields: FIELDS, kinds: KINDS });
    case 'POST rules': return createRule(env, me, body);
    case 'PUT rules': return updateRule(env, me, body);
    case 'DELETE rules': return deleteRule(env, me, body);
    case 'POST assign': return assign(env, me, body, false);
    case 'DELETE assign': return assign(env, me, body, true);
    case 'DELETE share': return unshareChannel(env, me, body);
    case 'POST swap': return swapChannel(env, me, body);
    case 'PUT follows': return followTech(env, me, body);
    case 'GET channels': return json({ channels: (await channelList(env, await loadRules(env), { q: q('q') })).slice(0, 100) });
    case 'GET requests': return requestList(env, me, { status: q('status'), count: q('count') });
    case 'POST requests': return createRequest(env, me, body);
    case 'DELETE requests': return withdrawRequest(env, me, body);
    case 'POST requests/confirm': return confirmRequest(env, me, body);
    case 'POST requests/decline': return declineRequest(env, me, body);
    case 'POST portal/open': return openPortal(env, me, body);
    case 'POST portal/decline': return declinePortal(env, me, body);
    case 'POST conflicts': return settleConflict(env, me, body);
    case 'POST rule-conflicts': return settleRuleConflict(env, me, body);
    // Channel threads labeled again though they did not change (src/label.js queueRelabel).
    case 'POST relabel': return env.NORMALIZE ? json(await queueRelabel(env, body))
      : json({ error: 'no queue' }, 503);
    case 'POST classify': return json(await classifyChannels(env, {
      limit: Math.min(Math.max(Number(body.limit) || 10, 1), 25),
    }));
    case 'GET orgs': return listOrgs(env);
    case 'POST orgs': return saveOrg(env, body, true);
    case 'PUT orgs': return saveOrg(env, body, false);
    case 'DELETE orgs': return deleteOrg(env, body);
    case 'GET org': return org(env, q('slug'));
    case 'GET org-icons': return orgIcons(env, q('slug'), Boolean(q('fresh')));
    case 'GET favicon': return faviconProxy(q('domain'), { request });
    case 'GET bots': return listBots(env);
    case 'GET bot': return getBot(env, url.searchParams.get('key'));
    case 'PUT bots': return setBot(env, me, body);
    case 'GET cogs': return json(await cogsReport(env, url));
    case 'POST cogs/rollup': return json(await rollupCogs(env));
    case 'GET topics': return json({
      latest: await latestTopicMap(env), available: Boolean(env.CONTENT && env.AI),
    });
    case 'POST topics': return buildTopics(env, me);
    default: return json({ error: 'not found' }, 404);
  }
}
