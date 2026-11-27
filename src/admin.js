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

import { activeSince } from './listactivity.js';
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
} from './roles.js';
import {
  classify, followedOrg, orgPattern, slug as toSlug, UNASSIGNED,
} from './rules.js';
import {
  isHolding, share, sharesByChannel, sharesOf, unshare,
} from './shares.js';
import { syncAccessQuietly } from './accesssync.js';
import { faviconProxy, findIcons } from './favicons.js';
import {
  closeMergeRequest, dismissPair, forgetFacts, likelyPairCount, listMergeRequests, mailDomains,
  mergeOrgs, openMergeCount, orgDuplicates, requestMerge, unmergeOrg,
} from './orgmerge.js';
import { decidePartner, endPartner, orgPartners } from './orgpartners.js';
import { closePartnerRequest, openPartnerCount, requestPartner } from './partnerrequests.js';
import { forgetOrgProfiles } from './orgprofile.js';
import {
  claimRequest, closeRequest, createRequest, getRequest, listRequests, openCount, outcomeOf,
  recordOutcome,
  reopenRequest, settleMoved, settleRequests,
} from './requests.js';
import { announceRequest } from './requestkeys.js';
import {
  claimMemberRequest, closeMemberRequest, getMemberRequest, listMemberRequests, memberOpenCount,
  recordMemberOutcome, reopenMemberRequest, settleMemberRequests,
} from './memberrequests.js';
import { classifyChannels, clefOf, suggestionsFor } from './suggest.js';
import { dismissMember, memberSuggestions, suggestsMembers } from './membersuggest.js';
import { unassignedSuggestions } from './orgassign.js';
import {
  dismissGroup, teamGroup, teamGroups, wizardRules,
} from './teamwizard.js';
import {
  getBot, listBots, setBot, unreviewedCount,
} from './ourbots.js';
import {
  declineProposal, linkAccount, listAccounts, unlinkedCount,
} from './accountlinks.js';
import { decideAccountPair, undecidedPairCount } from './accountpairs.js';
import {
  followable, setTeamFollow, teamFollows, teamFollowsBy,
} from './follows.js';
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
import { resetTeamVendors } from './vendors.js';
import {
  getIntegrationChannel, getIntegrationRequest, integrationOpenCount, listIntegrationChannels,
  listIntegrationRequests, mailCompany,
} from './integrationrequests.js';
import {
  deletePartnerDomain, forgetPartnerDomains, listPartnerDomains, savePartnerDomain,
} from './partners.js';

/**
 * The admin team's API for teams (#17) and orgs (#18), behind `/api/admin/*`:
 *
 * - teams: create, rename, delete, self-managed or not; members: add (found by name or
 *   email), remove, promote to team manager or demote;
 * - rules: the regular-expression rules that file channels under a team, an org or a kind
 *   (`^aem-` style prefixes, Teams team names, Slack Connect teams), and manual assignments
 *   of one channel (a `channel_id` rule with priority 10); follow rules, which share the
 *   channels they match with a team (src/followrules.js); and the conflicts between team
 *   rules, which the admin team settles in its inbox (src/ruleconflicts.js, src/requestthreads.js);
 * - orgs: display name, icon and type (customer, partner, vendor), and manual assignments;
 * - partner domains: the mail domains found to be partners' (src/partners.js), and the admin
 *   team's own over them: one added, renamed, given to another partner, or said not to be one;
 * - bots: which of the bots the inbox knows are Adobe's, and so count as staff, and which only
 *   post alerts, each with its latest messages (src/ourbots.js); a bot nobody said either of is
 *   a request, a thread of the admin team's inbox;
 * - shared channels (migration 0024): a channel is filed under one team, its first, and can be
 *   shared with more. Adding a team to a channel moves it only when the admin team (or nobody)
 *   holds it; a channel another team holds is shared with the new one instead.
 *
 * Team managers (migration 0018) use the same API for the teams they manage, and only for
 * their members: they see those teams, add and remove people, and promote or demote them, and
 * see who is likely on the team and is not yet (`member-suggestions`, src/membersuggest.js), to
 * add or dismiss.
 * They also search every channel, and ask the admin team to assign one to their team (a
 * request, migration 0028, src/requests.js); the admin team confirms the request, which runs
 * the same assignment it makes by hand, or declines it. Everything else is for the admin team.
 *
 * Thread agents ask for people to be added to a team (a membership request, migration 0096,
 * src/memberrequests.js), for whoever asked them in a sidebar: an admin or one of the team's
 * managers confirms one, which adds the person as the team's page does, or declines it.
 *
 * Customers ask too, from the customer portal (src/portalrequests.js): a lobby there asks for
 * a channel. The admin team opens one (`portal/open`: the portal makes the channel, and it is
 * filed under a team and a customer by hand, shared with more teams, and gets its welcome
 * message) or declines (`portal/decline`); a team's managers open one for their team when it
 * follows a technology the lobby picked.
 *
 * And people a host of the portal's integration signed in (src/integrationrequests.js): the admin
 * team approves one (`portal/integration/approve`: a new organization gets its channel, filed
 * by hand as `portal/open` files a lobby's, and the person is enrolled; one with a channel on that
 * host has the person enrolled in it) or declines it (`portal/integration/decline`).
 *
 * Every rule change can be tried first (`dryRun`): the answer lists the channels that would
 * move. Applied, the moves go to the NORMALIZE queue as `refile` jobs (src/refile.js).
 *
 * A team's page also suggests channels the admin team holds that the team might want: where
 * its members are active, or where Clef says they belong (src/suggest.js). And the team wizard
 * suggests teams: the admin team's channels grouped by the prefix of their names, with the
 * people in most of them (src/teamwizard.js); `team-wizard` makes one a team, its members and
 * its rules in one go, or gives a team that exists the rules.
 */

export const MANUAL_PRIORITY = 10;
// Above every rule id D1 gives: the ids of rules planned but not saved yet.
const MAX_RULE_ID = Number.MAX_SAFE_INTEGER - 1000;
const MANUAL_NOTE = 'manual assignment';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FIELDS = ['name', 'group_name', 'connected', 'channel_id'];
// A follow rule may also follow a customer: the org the other rules file a channel under.
const FOLLOW_FIELDS = [...FIELDS, 'org'];
const ORG_FOLLOW_NOTE = 'follows the customer';
const TARGETS = ['team', 'org', 'kind', 'follow'];
const KINDS = ['channel', 'alert', 'ignore'];
const TYPES = ['customer', 'partner', 'vendor', 'internal', 'public'];
const ICON = /^(https:\/\/\S{1,500}|[a-z0-9.-]+\.[a-z]{2,})$/i;
const MAX_TEXT = 200;

const clean = (v, n = MAX_TEXT) => String(v ?? '').trim().slice(0, n);
const bad = (error) => json({ error }, 400);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const manualPattern = (channelId) => `^${escapeRe(channelId)}$`;
const isManual = (r) => r.field === 'channel_id' && r.priority === MANUAL_PRIORITY && r.note === MANUAL_NOTE;

/** The teams that follow customer `slug` (follow rules of field `org`): `[{ team, rule }]`. */
const orgFollowers = (rules, slug) => rules.filter((r) => followedOrg(r) === slug)
  .map((r) => ({ team: r.value, rule: r.id }));

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
  const needle = q.toLowerCase().trim();
  const words = searchWords(needle);
  // Asked together: /api/* sends the reads of one tick to D1 as one batch (src/d1batch.js).
  const [filed, labelRows, shares, ruleShares, teamRows] = await Promise.all([
    rows(env, `SELECT c.source, c.tenant, c.channel_id, c.name, c.group_name, c.shared,
        t.team, t.org, o.name AS org_name, t.kind, COUNT(t.thread) AS threads,
        MAX(t.channel_name) AS channel_name, MAX(COALESCE(t.last_at, t.any_at)) AS latest
      FROM channels c LEFT JOIN threads t ON t.source = c.source AND t.tenant = c.tenant
        AND t.channel_id = c.channel_id
      LEFT JOIN orgs o ON o.slug = t.org
      WHERE c.archived_at IS NULL
      GROUP BY c.source, c.tenant, c.channel_id, t.team, t.org, t.kind
      ORDER BY latest DESC`),
    rows(env, 'SELECT * FROM channel_labels'),
    sharesByChannel(env),
    rows(env, "SELECT source, channel_id, team FROM channel_teams WHERE added_by LIKE 'rule:%'"),
    words.length ? rows(env, 'SELECT slug, name FROM teams') : [],
  ]);
  const labels = new Map(labelRows.map((l) => [`${l.source}:${l.tenant}:${l.channel_id}`, l]));
  // The shares a follow rule made (src/followrules.js): the rule's, not taken away by hand.
  const byRule = new Map();
  for (const r of ruleShares) {
    const k = `${r.source}:${r.channel_id}`;
    byRule.set(k, [...(byRule.get(k) || []), r.team]);
  }
  const teamNames = new Map(teamRows.map((t) => [t.slug, t.name]));
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
  const fields = target === 'follow' ? FOLLOW_FIELDS : FIELDS;
  if (!fields.includes(field)) {
    return { error: `field is one of ${fields.join(', ')}` };
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
 * there is left to the cron, since the rules are saved. `only` keeps the moves a change is about
 * (a merge: the merged org's channels), and leaves the channels filed otherwise than the rules
 * say for some other reason where they are.
 */
async function applyRules(env, me, {
  next, dryRun, write, extra = {}, only = null,
}) {
  const moves = (await plan(env, next)).filter(only || (() => true));
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

/**
 * POST /api/admin/release `{ team, source, channelId }`: a channel filed under `team` goes back
 * to the admin team (a manual assignment there, a move, as **→ admin** on a team's page). For the
 * admin team, and for the team's managers, who give a channel up this way but take one only by
 * asking (`POST requests` with `move`).
 */
async function releaseChannel(env, me, body) {
  const channelId = clean(body.channelId);
  const slug = clean(body.team);
  const source = clean(body.source);
  if (!channelId || !slug || !source) {
    return bad('give a source, a channelId and a team');
  }
  if (isHolding(slug)) {
    return json({ error: 'the admin team holds what no team has: give it to a team instead' }, 409);
  }
  const home = await homeOf(env, await loadRules(env), source, channelId);
  if (home.team !== slug) {
    return json({ error: `this channel is filed under ${home.team}, not ${slug}` }, 409);
  }
  return assign(env, me, {
    target: 'team', source, channelId, value: ADMIN_TEAM, move: true, dryRun: body.dryRun,
  }, false);
}

/**
 * PUT /api/admin/org-follows `{ team, org, follow }`: `team` follows customer `org`, or (`follow`
 * false) no more: a follow rule of field `org` (src/rules.js), which shares every channel the
 * rules file under the org with the team, now and later (src/followrules.js); the channels stay
 * filed under their teams. For the admin team and the team's managers. The answer has the teams
 * that follow it after the change (`followers`).
 */
async function followOrgRule(env, me, body) {
  const slug = clean(body.team);
  const target = toSlug(clean(body.org));
  const follow = body.follow !== false;
  if (!slug || !clean(body.org) || target === UNASSIGNED) {
    return bad('give a team and a customer');
  }
  if (!await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(slug).first()) {
    return json({ error: 'no such team' }, 404);
  }
  const merged = await env.DB.prepare('SELECT into_slug FROM org_merges WHERE slug = ?').bind(target).first();
  if (merged) {
    return json({ error: `${target} was merged into ${merged.into_slug}: follow that one` }, 409);
  }
  const current = await loadRules(env);
  const mine = current.filter((r) => followedOrg(r) === target && r.value === slug);
  const answer = async (res) => {
    if (!res.ok) {
      return res;
    }
    const done = await res.json();
    return json({
      ok: true, follows: done.follows, followers: orgFollowers(await loadRules(env), target),
    });
  };
  if (!follow) {
    if (!mine.length) {
      return json({ ok: true, followers: orgFollowers(current, target) });
    }
    const gone = new Set(mine.map((r) => r.id));
    return answer(await applyRules(env, me, {
      next: current.filter((r) => !gone.has(r.id)),
      write: async () => {
        await env.DB.batch(mine.map((r) => env.DB.prepare('DELETE FROM rules WHERE id = ?').bind(r.id)));
        return { deleted: [...gone] };
      },
    }));
  }
  if (mine.length) {
    return json({ ok: true, followers: orgFollowers(current, target) });
  }
  const known = await env.DB.prepare(`SELECT 1 FROM orgs WHERE slug = ?1
    UNION ALL SELECT 1 FROM threads WHERE org = ?1 LIMIT 1`).bind(target).first();
  if (!known) {
    return json({ error: 'no such customer' }, 404);
  }
  return answer(await createRule(env, me, {
    target: 'follow',
    field: 'org',
    pattern: orgPattern(target),
    value: slug,
    priority: 100,
    note: ORG_FOLLOW_NOTE,
  }));
}

/** `followOrgRule`, and a team's Vendors section says so at once (src/vendors.js). */
export async function followOrg(env, me, body) {
  const res = await followOrgRule(env, me, body);
  // Here, so that PUT /api/follows with a team (src/following.js) says so too.
  resetTeamVendors();
  return res;
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
  // And the merges of customers asked for (src/orgmerge.js), the admin team's too, and the pairs
  // of a customer and a partner to decide (src/partnerrequests.js).
  const merges = isAdmin(me) ? await openMergeCount(env) + await openPartnerCount(env) : 0;
  // And the bots nobody said whose they are (src/ourbots.js), the admin team's too.
  const bots = isAdmin(me) ? await unreviewedCount(env) : 0;
  // And the accounts staff by themselves nobody said whose they are (src/accountlinks.js: the host
  // tenant's admin accounts, Discord accounts with a staff role), the admin team's too.
  const accounts = isAdmin(me) ? await unlinkedCount(env) : 0;
  // And a customer's two accounts that may be one person (src/accountpairs.js), the admin team's.
  const pairs = isAdmin(me) ? await undecidedPairCount(env) : 0;
  // And the people waiting for access through a host of the portal's integration, the admin
  // team's too; best effort, as the portal may not answer.
  const integration = isAdmin(me) && !count
    ? await listIntegrationRequests(env).catch((e) => {
      console.warn(JSON.stringify({ route: 'admin', integration: 'not listed', error: e.message }));
      return [];
    }) : [];
  let integrationOpen = 0;
  if (isAdmin(me)) {
    integrationOpen = count ? await integrationOpenCount(env)
      : integration.filter((r) => r.status === 'pending').length;
  }
  const open = await openCount(env, teams) + await portalOpenCount(env, teams) + integrationOpen
    + await memberOpenCount(env, teams)
    + conflicts.filter((c) => !c.kept).length + rules.filter((c) => !c.kept).length + merges + bots
    + accounts + pairs;
  if (count) {
    return json({ open });
  }
  return json({
    requests: await listRequests(env, { teams, status: ['open', 'decided'].includes(status) ? status : null }),
    memberRequests: await listMemberRequests(env, { teams, limit: 50 }),
    portal: await listPortalRequests(env, { teams }),
    integration,
    portalBound: portalBound(env),
    conflicts,
    ruleConflicts: rules,
    orgMerges: isAdmin(me) ? await listMergeRequests(env, me, { limit: 30 }) : [],
    open,
  });
}

/**
 * POST /api/admin/rule-conflicts `{ key, action, side?, follow?, fingerprint?, note?, dryRun? }`:
 * the admin team settles a conflict between team rules (src/ruleconflicts.js). `win`: side
 * `side` (`a` or `b`) files the channels both rules match, the other rule leaves them out, and
 * with `follow` the other team follows them (a follow rule); `keep`: as it is. `fingerprint` is
 * the conflict's as it was shown: a conflict that changed since is not settled (409). `dryRun`
 * answers with the channels it would move (`moves`) and the ones the other team would follow
 * (`follows`); applied, with the conflicts as they are after it.
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
  if (action !== 'win') {
    return bad('action is win or keep');
  }
  const side = clean(body.side);
  const s = settlement(c, side, rules, { follow: Boolean(body.follow) });
  if (s.error) {
    return bad(s.error);
  }
  const loser = side === 'a' ? c.b : c.a;
  // The channels the other team follows after it.
  const live = (await knownChannels(env)).filter((x) => !x.archived);
  const followed = [...wantedFollows(s.next, live).values()]
    .filter((w) => w.team === loser.team && (w.rule > MAX_RULE_ID || w.rule === loser.rules[0].id))
    .map((w) => live.find((x) => x.source === w.source && x.channelId === w.channelId))
    .filter(Boolean)
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
        ...s.inserts.map((r) => env.DB.prepare(`INSERT INTO rules (target, priority, source, field,
            pattern, value, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(...ruleValues(r), by, at)),
      ]);
      console.log(JSON.stringify({
        route: 'admin', ruleConflict: 'win', side, follow: Boolean(body.follow), by: me.id,
      }));
      return { done: 'win' };
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
  // A new customer, and its icon: neither is a partner's domain (src/partners.js).
  forgetPartnerDomains();
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

// ---- integration access requests ----------------------------------------------------------

/** A pending integration request, or the answer that says why it cannot be decided. */
async function pendingIntegration(env, id) {
  if (!portalBound(env)) {
    return { error: json({ error: 'the customer portal is not connected to this inbox' }, 409) };
  }
  const r = await getIntegrationRequest(env, id);
  if (!r) {
    return { error: json({ error: 'no such request' }, 404) };
  }
  if (r.status !== 'pending') {
    return { error: json({ error: `this request is ${r.status} already`, request: r }, 409) };
  }
  return { request: r };
}

/** A portal call's refusal as an answer: its status where it said one, else 502. */
const portalRefused = (res, extra = {}) => json(
  { error: res.error || 'the portal did not answer', ...extra },
  res.status && res.status < 500 ? res.status : 502,
);

/**
 * POST /api/admin/portal/integration/approve `{ id, team?, name?, org?, person? }`: the admin team
 * approves access request `id` of a host of the portal's integration. The person is enrolled as
 * `person` (the name the provider gave, by default), a new actor without an email, and who approved
 * it is recorded. An organization with an enabled channel on that host has them enrolled in it,
 * nothing else. One without gets its channel first: the portal reserves it (named `name`, by
 * default `<product>-<customer>`), it is filed under `team` and the customer `org` by hand (the
 * manual rules of `portal/open`: source `portal`, field `channel_id`, `^<id>$`), and only then is
 * the person enrolled and the channel enabled, so no message arrives before its route. A channel
 * suspended, or set up by hand and never enabled, is for an operator. With `auto`, the channel
 * auto-approves the organization's next members from then on (`portal/integration/auto`). With
 * `audience: 'individual'`, a new organization's channel is an individual one from the start
 * (`portal/integration/audience`): each member sees only their own threads.
 */
async function approveIntegration(env, me, body) {
  const { request: r, error } = await pendingIntegration(env, body.id);
  if (error) {
    return error;
  }
  const person = clean(body.person, 120) || r.suggest.person;
  const by = { email: me.email || String(me.id), name: me.name || null };
  const m = r.mapping;
  if (m && !m.enabled && !m.resumable) {
    return json({ error: 'this organization\'s channel on the host is suspended, or set up by hand: an operator enables it first', request: r }, 409);
  }
  let channel = m && m.enabled ? { id: m.channel, name: m.name, existing: true } : null;
  let route = m && m.enabled ? m.route : null;
  if (!channel) {
    const slug = toSlug(clean(body.team) || r.suggest.team || '');
    if (!await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(slug).first()) {
      return bad('give the team the channel is for');
    }
    const customer = toSlug(clean(body.org) || r.suggest.org);
    if (!SLUG.test(customer)) {
      return bad('a customer is lowercase letters, digits and -, like acme');
    }
    const name = toSlug(clean(body.name, 80) || r.suggest.name).slice(0, 80);
    if (!SLUG.test(name)) {
      return bad('a channel name is lowercase letters, digits and -, like agents-acme');
    }
    // An individual channel is one from before its first message (portal migration 0008).
    const reserved = await portalCall(env, 'reserveAccess', {
      id: r.id,
      customer: name,
      name,
      by,
      audience: ['individual', 'shared'].includes(body.audience) ? body.audience : undefined,
    });
    if (reserved.error || !reserved.channel) {
      return portalRefused(reserved);
    }
    channel = { ...reserved.channel, existing: Boolean(reserved.existing) };
    if (!reserved.existing) {
      // The channel as the inbox knows it, its customer and its route, before anyone can post.
      const tenant = `${channel.id}.embed.invalid`;
      const now = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO channels (source, tenant, channel_id, name, group_id,
          group_name, shared, connected, topic, fetched_at)
        VALUES ('portal', ?, ?, ?, ?, ?, 1, '[]', NULL, ?) ON CONFLICT DO NOTHING`)
        .bind(tenant, channel.id, channel.name, tenant, r.orgName, now).run();
      const domain = r.email && mailCompany(r.email) ? r.email.split('@')[1] : null;
      await env.DB.prepare(`INSERT INTO orgs (slug, name, type, icon, updated_at)
        VALUES (?, ?, 'customer', ?, ?) ON CONFLICT (slug) DO NOTHING`)
        .bind(customer, r.orgName || null, domain, now).run();
      // A new customer, and its icon: neither is a partner's domain (src/partners.js).
      forgetPartnerDomains();
      await ensureKnowledgeBase(env, 'org', customer).catch(() => null);
      for (const [target, value] of [['team', slug], ['org', customer]]) {
        // eslint-disable-next-line no-await-in-loop
        const res = await assign(env, me, {
          target, source: 'portal', channelId: channel.id, value, move: true,
        }, false);
        if (!res.ok) {
          // eslint-disable-next-line no-await-in-loop
          const { error: why } = await res.json().catch(() => ({}));
          return json({
            error: `the channel is reserved in the portal, but could not be filed under ${value}: ${why || res.status}. Nobody is enrolled yet: approve again.`,
            channel: { source: 'portal', channelId: channel.id },
          }, 502);
        }
      }
      route = { team: slug, org: customer };
    } else {
      route = (await getIntegrationRequest(env, r.id))?.mapping?.route || null;
    }
  }
  const enrolled = await portalCall(env, 'enrollAccess', {
    id: r.id, name: person, by, enable: !channel.existing,
  });
  if (enrolled.error) {
    return portalRefused(enrolled, { channel: { source: 'portal', channelId: channel.id } });
  }
  // Auto-approve the organization's next members: best effort, the person is in either way.
  const auto = body.auto ? await portalCall(env, 'setAutoApprove', {
    channel: channel.id, on: true, by,
  }) : null;
  console.log(JSON.stringify({
    route: 'admin', integration: 'approved', by: me.id, id: r.id, existing: channel.existing,
  }));
  return json({
    ok: true,
    request: await getIntegrationRequest(env, r.id),
    channel: {
      source: 'portal',
      tenant: `${channel.id}.embed.invalid`,
      channelId: channel.id,
      name: channel.name,
      existing: channel.existing,
      team: route && route.team,
      org: route && route.org,
      audience: channel.audience || (m && m.audience) || 'shared',
      ...(auto ? { autoApprove: Boolean(auto.ok && auto.channel?.autoApprove) } : {}),
    },
    ...(auto && auto.error ? { autoError: auto.error } : {}),
  });
}

/** A list in a request body: an array, or text separated by spaces, commas or lines. */
const listOf = (v) => {
  if (v === undefined || v === null) {
    return undefined;
  }
  return (Array.isArray(v) ? v : String(v).split(/[\s,]+/)).map((x) => clean(x, 253)).filter(Boolean);
};

/**
 * PUT /api/admin/portal/integration/auto `{ channel, on?, tenants?, domains? }`: the admin team
 * turns a user-token host's channel's auto-approval on or off, and sets the extra organization IDs
 * and the mail domains it catches (each list replaces the channel's; one left out stays). A
 * verified caller of that host who lands in it is then enrolled on their first call, within a cap
 * an hour. Off stops new auto-enrollments; the members stay. An org ID or domain another channel
 * of the host holds is refused (409, naming it), and so is everyone's mail (gmail.com, …).
 */
async function setIntegrationAuto(env, me, body) {
  if (!portalBound(env)) {
    return json({ error: 'the customer portal is not connected to this inbox' }, 409);
  }
  const res = await portalCall(env, 'setAutoApprove', {
    channel: clean(body.channel, 20),
    on: body.on === undefined ? undefined : Boolean(body.on),
    tenants: listOf(body.tenants),
    domains: listOf(body.domains),
    by: { email: me.email || String(me.id), name: me.name || null },
  });
  if (res.error) {
    return portalRefused(res, res.conflict ? { conflict: res.conflict } : {});
  }
  console.log(JSON.stringify({
    route: 'admin', integration: 'auto', by: me.id, on: res.channel && res.channel.autoApprove,
  }));
  return json({ ok: true, channel: await getIntegrationChannel(env, res.channel.channel) });
}

/**
 * PUT /api/admin/portal/integration/audience `{ channel, audience }`: the admin team says who sees
 * the threads of a channel of the portal (an integration mapping's, or a lobby's by its id):
 * `shared`, every customer of it, or `individual`, each customer only the threads they started,
 * wrote in or were added to (portal migration 0008). Adobe's people see every thread either way.
 * Switching moves no thread: each stays its people's.
 */
async function setIntegrationAudience(env, me, body) {
  if (!portalBound(env)) {
    return json({ error: 'the customer portal is not connected to this inbox' }, 409);
  }
  const audience = clean(body.audience, 20);
  if (!['shared', 'individual'].includes(audience)) {
    return bad('an audience is shared or individual');
  }
  const res = await portalCall(env, 'setAudience', {
    channel: clean(body.channel, 20),
    audience,
    by: { email: me.email || String(me.id), name: me.name || null },
  });
  if (res.error) {
    return portalRefused(res);
  }
  console.log(JSON.stringify({
    route: 'admin', integration: 'audience', by: me.id, audience,
  }));
  return json({
    ok: true,
    audience: res.channel.audience,
    channel: await getIntegrationChannel(env, res.channel.id) || res.channel,
  });
}

/**
 * POST /api/admin/portal/integration/decline `{ id, reason? }`: the admin team declines access
 * request `id`, with a reason the person is told (the error body's `reason`). After 30 days their
 * next call asks again.
 */
async function declineIntegration(env, me, body) {
  const { request: r, error } = await pendingIntegration(env, body.id);
  if (error) {
    return error;
  }
  const res = await portalCall(env, 'declineAccess', {
    id: r.id,
    reason: clean(body.reason, 500) || null,
    by: { email: me.email || String(me.id), name: me.name || null },
  });
  if (res.error) {
    return portalRefused(res, { request: await getIntegrationRequest(env, r.id) });
  }
  console.log(JSON.stringify({
    route: 'admin', integration: 'declined', by: me.id, id: r.id,
  }));
  return json({ ok: true, request: await getIntegrationRequest(env, r.id) });
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
      (SELECT COUNT(*) FROM threads th WHERE th.team = t.slug AND th.last_at >= ?1) AS recent,
      (SELECT MAX(th.last_at) FROM threads th WHERE th.team = t.slug) AS latest,
      (SELECT COUNT(*) FROM channel_teams s WHERE s.team = t.slug) AS shared
    FROM teams t ORDER BY t.name`, activeSince());
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
    + await memberOpenCount(env, scope)
    + (everything ? await openConflictCount(env)
      + (await ruleConflicts(env, { kept: false })).length + await openMergeCount(env)
      + await openPartnerCount(env) + await unreviewedCount(env) + await unlinkedCount(env) : 0);
  // Every team's name, for a manager's page to say where a channel is now.
  const names = Object.fromEntries(all.map((t) => [t.slug, t.name]));
  return json({
    teams, unassigned, admin: everything, requests, names,
  });
}

async function team(env, slug, me) {
  // Asked together: /api/* sends the reads of one tick to D1 as one batch (src/d1batch.js).
  const [t, rules] = await Promise.all([
    env.DB.prepare('SELECT slug, name, self_managed FROM teams WHERE slug = ?').bind(slug).first(),
    loadRules(env),
  ]);
  if (!t && slug !== UNASSIGNED) {
    return json({ error: 'no such team' }, 404);
  }
  const none = Promise.resolve([]);
  const [
    members, channels, requests, memberRequests, portal, follows, followsBy, techs, topics,
    suggestions,
  ] = await Promise.all([
    rows(env, `SELECT p.id, p.name, p.email, p.staff, m.role FROM team_members m
      JOIN people p ON p.id = m.person WHERE m.team = ? ORDER BY p.name`, slug),
    channelList(env, rules, { team: slug }),
    t ? listRequests(env, { teams: [slug], limit: 50 }) : none,
    t ? listMemberRequests(env, { teams: [slug], limit: 50 }) : none,
    t ? listPortalRequests(env, { teams: [slug], limit: 50 }) : none,
    t ? teamFollows(env, slug) : none,
    t ? teamFollowsBy(env, slug) : none,
    t ? followable(env, slug) : none,
    // The areas a team may follow: those on somewhere, by the admin team's name first.
    t ? rows(env, `SELECT id, name FROM (SELECT id, name, ROW_NUMBER() OVER (PARTITION BY id
        ORDER BY team = 'admin' DESC, team) AS n FROM areas WHERE enabled = 1) WHERE n = 1
      ORDER BY name`) : none,
    isAdmin(me) && t && slug !== ADMIN_TEAM ? suggestionsFor(env, slug) : Promise.resolve({}),
  ]);
  return json({
    team: t ? { ...t, self_managed: Boolean(t.self_managed) } : { slug, name: 'Unassigned', self_managed: false },
    members,
    rules: rules.filter((r) => (r.target === 'team' && (r.value === slug || /\$\d/.test(r.value)))
      || (r.target === 'follow' && r.value === slug))
      .sort((a, b) => a.priority - b.priority || a.id - b.id),
    channels,
    // What the team's managers asked the admin team for, and what came of it.
    requests,
    // The people asked for on the team (thread agents, for whoever asked them), and the answers.
    memberRequests,
    // The customers in the portal who picked a technology the team follows.
    portal,
    portalBound: portalBound(env),
    // The technologies and areas it follows (src/follows.js), and what it may follow.
    ...(t ? {
      follows, followsBy, followable: techs, areas: topics,
    } : {}),
    // The admin team decides which channels a team gets: what it might want of the admin
    // team's channels.
    ...suggestions,
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
 * team. Its managers switch any of them off on the team's page (ui/agent.js).
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
  // On the team now: no dismissal of them from its suggestions stays behind.
  await dismissMember(env, teamSlug, email, { dismiss: false });
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
 * POST /api/admin/team-wizard `{ prefix, slug, name } | { prefix, team }, people, dryRun`: the
 * team wizard's group of `prefix` (src/teamwizard.js) made a team: a new one (`slug`, `name`)
 * or one that exists (`team`), with `people` (`[{ email, name }]`) as its members and the rules
 * that file the group's channels under it. With `dryRun`, only what the rules would move.
 */
async function teamWizard(env, me, body) {
  const prefix = clean(body.prefix).toLowerCase();
  const group = prefix && await teamGroup(env, prefix);
  if (!group) {
    return json({ error: `no channel of the admin team starts with ${prefix || 'that'} now` }, 404);
  }
  const existing = clean(body.team);
  const slug = existing || clean(body.slug).toLowerCase();
  if (existing) {
    if (existing === ADMIN_TEAM) {
      return bad('the admin team has these channels already');
    }
    if (!await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(existing).first()) {
      return json({ error: 'no such team' }, 404);
    }
  } else if (!SLUG.test(slug)) {
    return bad('a team slug is lowercase letters, digits and -, like edge-ops');
  } else if (!clean(body.name)) {
    return bad('give the team a name');
  }
  const rules = wizardRules(group, slug);
  const current = await loadRules(env);
  const next = [...current, ...rules.map((r, i) => ({ ...r, id: Number.MAX_SAFE_INTEGER - i }))];
  if (body.dryRun) {
    return json({ dryRun: true, moves: await plan(env, next), rules });
  }
  if (!existing) {
    const made = await createTeam(env, me, { slug, name: body.name });
    if (!made.ok) {
      return made;
    }
  }
  const members = [];
  const refused = [];
  const asked = (Array.isArray(body.people) ? body.people : []).slice(0, 100);
  for (const p of asked) {
    // One after the other: each reads what the one before wrote (the person, the identities).
    // eslint-disable-next-line no-await-in-loop
    const res = await addMember(env, { team: slug, email: p && p.email, name: p && p.name });
    // eslint-disable-next-line no-await-in-loop
    const answer = await res.json();
    if (res.ok) {
      members.push(answer.person);
    } else {
      refused.push({ email: clean(p && p.email), error: answer.error });
    }
  }
  const done = await applyRules(env, me, {
    next,
    write: async () => {
      const saved = [];
      for (const rule of rules) {
        // eslint-disable-next-line no-await-in-loop
        saved.push(await env.DB.prepare(`INSERT INTO rules (target, priority, source, field, pattern,
            value, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
          .bind(...ruleValues(rule), ...stamp(me)).first());
      }
      return { rules: saved };
    },
    extra: { team: { slug, existing: Boolean(existing) }, members, refused },
  });
  // Done with it, whatever it had been. The rules are saved and their moves queued by now: a
  // failure here must not answer as if they were not (the page would offer the group again).
  await dismissGroup(env, prefix, null, false).catch((e) => {
    console.error(JSON.stringify({
      route: 'admin', teamWizard: prefix, dismissal: 'not cleared', error: e.message,
    }));
  });
  console.log(JSON.stringify({
    route: 'admin', teamWizard: prefix, team: slug, existing: Boolean(existing), members: members.length, by: me.id,
  }));
  if (!members.length || !done.ok) {
    return done;
  }
  // The sign-in allow list follows the new members, as for one added on the team's page.
  const access = await syncAccessQuietly(env, 'team wizard');
  return json({ ...await done.json(), access }, done.status);
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
  const who = await env.DB.prepare(`SELECT p.email FROM team_members m JOIN people p ON p.id = m.person
    WHERE m.team = ? AND m.person = ?`).bind(teamSlug, person).first();
  const { meta } = await env.DB.prepare('DELETE FROM team_members WHERE team = ? AND person = ?')
    .bind(teamSlug, person).run();
  if (!meta.changes) {
    return json({ error: 'not a member' }, 404);
  }
  // Taken off the team: not suggested to it again (src/membersuggest.js) until someone says so.
  if (who && who.email && suggestsMembers(teamSlug)) {
    await dismissMember(env, teamSlug, who.email, { by: me.email || String(me.id), why: 'removed' })
      .catch((e) => console.error(JSON.stringify({ route: 'admin', dismissal: 'not recorded', error: e.message })));
  }
  return json({ ok: true, self: person === me.id });
}

/**
 * GET /api/admin/member-suggestions?team=: the people likely on the team who are not yet, for its
 * managers and the admin team to add (src/membersuggest.js). Not for the admin team, which holds
 * every channel no rule files.
 */
async function suggestedMembers(env, slug) {
  if (!suggestsMembers(slug)) {
    return bad('the admin team holds every channel no rule files: nobody is suggested for it');
  }
  if (!await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(slug).first()) {
    return json({ error: 'no such team' }, 404);
  }
  return json(await memberSuggestions(env, slug));
}

/**
 * POST /api/admin/member-suggestions/dismiss `{ team, email }`: not suggested to the team again;
 * DELETE suggests them again.
 */
async function dismissSuggestedMember(env, me, body, dismiss) {
  const slug = clean(body.team);
  const email = clean(body.email).toLowerCase();
  if (!suggestsMembers(slug) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return bad('give the team and the person\'s email address');
  }
  if (!await env.DB.prepare('SELECT 1 FROM teams WHERE slug = ?').bind(slug).first()) {
    return json({ error: 'no such team' }, 404);
  }
  const changed = await dismissMember(env, slug, email, { by: me.email || String(me.id), dismiss });
  console.log(JSON.stringify({
    route: 'admin', memberSuggestion: dismiss ? 'dismissed' : 'restored', team: slug, by: me.id,
  }));
  return json({ ok: true, changed });
}

// ---- orgs -------------------------------------------------------------------------------

/**
 * Every org: the ones with a row, and every slug the rules filed threads or a base under.
 * `domain` is its usual mail domain, whose favicon it is shown with when it has no icon. `review`
 * is what waits for `me` in the sidebar's Review entry, as far as it is known without asking Clef
 * (`duplicates`, `likelyPairCount`): whether there is one from the first paint (ui/review.js).
 */
async function listOrgs(env, me) {
  const list = await rows(env, `SELECT s.slug, o.name, COALESCE(o.type, 'customer') AS type, o.icon,
      (SELECT COUNT(DISTINCT channel_id) FROM threads t WHERE t.org = s.slug AND ${LIVE('t')})
        AS channels,
      (SELECT COUNT(*) FROM threads t WHERE t.org = s.slug) AS threads,
      (SELECT COUNT(*) FROM threads t WHERE t.org = s.slug AND t.last_at >= ?2) AS recent,
      (SELECT MAX(COALESCE(last_at, any_at)) FROM threads t WHERE t.org = s.slug) AS latest
    FROM (SELECT slug FROM orgs UNION SELECT DISTINCT org FROM threads
      UNION SELECT slug FROM knowledge_bases WHERE kind = 'org') s
    LEFT JOIN orgs o ON o.slug = s.slug
    WHERE s.slug != ?1 AND s.slug NOT IN (SELECT slug FROM org_merges)
    ORDER BY COALESCE(o.name, s.slug)`, UNASSIGNED, activeSince());
  const domains = await mailDomains(env);
  for (const o of list) {
    o.domain = (domains.get(o.slug) || [])[0] || null;
  }
  // The channels no rule files under an org, which Unassigned lists to be given one.
  const [unassigned, duplicates] = await Promise.all([env.DB.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN ${LIVE('t')} THEN t.channel_id END) AS channels,
      COUNT(*) AS threads FROM threads t WHERE t.org = ? AND t.kind != 'ignore'`).bind(UNASSIGNED).first(),
  likelyPairCount(env, me)]);
  const review = { duplicates };
  return json({
    orgs: list, types: TYPES, unassigned, review,
  });
}

/**
 * GET /api/admin/org?slug=_unassigned: the channels no rule files under an org (not the ignored
 * ones), each with the orgs it may belong to, or a new org it may be (`suggestions` by channel
 * id, src/orgassign.js). The admin team gives each one an org by hand (`assign`).
 */
async function unassignedOrg(env) {
  const rules = await loadRules(env);
  const channels = (await channelList(env, rules, { org: UNASSIGNED }))
    .filter((c) => c.kind !== 'ignore');
  return json({
    org: {
      slug: UNASSIGNED, name: null, type: 'customer', icon: null,
    },
    unassigned: true,
    channels,
    suggestions: await unassignedSuggestions(env, channels, rules),
    types: TYPES,
  });
}

/**
 * The channels of an org, one row each: a channel whose threads are filed under more than one
 * team (a re-filing not done yet) is under the team the rules file it under now, with the
 * threads still elsewhere in `split` (`[{ team, threads }]`), and every thread counted.
 */
async function oneRowEach(env, rules, channels) {
  const by = new Map();
  for (const c of channels) {
    const k = `${c.source}:${c.tenant}:${c.channelId}`;
    by.set(k, [...(by.get(k) || []), c]);
  }
  const out = await Promise.all([...by.values()].map(async (list) => {
    if (list.length === 1) {
      return { ...list[0], split: [] };
    }
    const { team: home } = await homeOf(env, rules, list[0].source, list[0].channelId);
    const row = list.find((c) => c.team === home) || list[0];
    const latest = list.map((c) => c.latest).filter(Boolean).sort().pop() || null;
    return {
      ...row,
      team: home,
      sharedWith: row.sharedWith.filter((t) => t !== home),
      followedByRule: row.followedByRule.filter((t) => t !== home),
      threads: list.reduce((n, c) => n + c.threads, 0),
      latest,
      split: list.filter((c) => c.team !== home)
        .map((c) => ({ team: c.team, threads: c.threads })),
    };
  }));
  return out.sort((a, b) => String(b.latest || '').localeCompare(String(a.latest || '')));
}

/**
 * GET /api/admin/org?slug=: an org, its channels (one row each), the teams that follow it, and
 * the open requests for its channels you see (the admin team every team's, a manager their
 * teams'). For everyone on an ops team; its rules and Unassigned for the admin team only.
 */
async function org(env, slug, me) {
  if (slug === UNASSIGNED) {
    return isAdmin(me) ? unassignedOrg(env) : json({ error: 'for the admin team' }, 403);
  }
  // Asked together: /api/* sends the reads of one tick to D1 as one batch (src/d1batch.js).
  const [merged, row, rules, domains, teamRows, mergedHere, kb] = await Promise.all([
    env.DB.prepare('SELECT into_slug FROM org_merges WHERE slug = ?').bind(slug).first(),
    env.DB.prepare('SELECT slug, name, type, icon, updated_at FROM orgs WHERE slug = ?').bind(slug).first(),
    loadRules(env),
    mailDomains(env, slug),
    rows(env, 'SELECT slug, name FROM teams'),
    // The orgs merged into this one, which an admin may take out again.
    rows(env, `SELECT slug, name, merged_by, merged_at FROM org_merges
      WHERE into_slug = ? ORDER BY merged_at DESC`, slug),
    env.DB.prepare("SELECT 1 FROM knowledge_bases WHERE kind = 'org' AND slug = ?").bind(slug).first(),
  ]);
  // A merged org is the one it was merged into now (src/orgmerge.js).
  if (merged) {
    return json({ error: `${slug} was merged into ${merged.into_slug}`, mergedInto: merged.into_slug }, 404);
  }
  const listed = await channelList(env, rules, { org: slug });
  const [channels, requests] = await Promise.all([
    oneRowEach(env, rules, listed),
    listed.length ? listRequests(env, {
      teams: isAdmin(me) ? null : managedTeams(me), status: 'open',
    }) : [],
  ]);
  const orgRules = rules.filter((r) => r.target === 'org' && (r.value === slug || /\$\d/.test(r.value)))
    .sort((a, b) => a.priority - b.priority || a.id - b.id);
  if (!row && !channels.length && !orgRules.some((r) => r.value === slug) && !kb) {
    return json({ error: 'no such org' }, 404);
  }
  return json({
    org: row || {
      slug, name: null, type: 'customer', icon: null,
    },
    domains: (domains.get(slug) || []).slice(0, 3),
    rules: isAdmin(me) ? orgRules : [],
    channels,
    types: TYPES,
    follows: orgFollowers(rules, slug),
    // Every team's name, for a page that lists only some teams (a manager's, a member's).
    names: Object.fromEntries(teamRows.map((t) => [t.slug, t.name])),
    requests: requests.filter((r) => channels.some((c) => c.source === r.channel.source
      && c.channelId === r.channel.channelId)),
    merged: mergedHere,
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
  const merged = await env.DB.prepare('SELECT into_slug FROM org_merges WHERE slug = ?').bind(slug).first();
  if (merged) {
    return json({ error: `${slug} was merged into ${merged.into_slug}; undo that on ${merged.into_slug}'s page first` }, 409);
  }
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
  // Its name, type and icon are what the duplicate search compares, and what tells a partner's
  // domains (src/partners.js).
  forgetFacts();
  forgetPartnerDomains();
  return json({ ok: true, org: { slug, ...f, updated_at: now } });
}

async function deleteOrg(env, body) {
  const { meta } = await env.DB.prepare('DELETE FROM orgs WHERE slug = ?').bind(clean(body.slug)).run();
  forgetFacts();
  forgetPartnerDomains();
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

// ---- membership requests ----------------------------------------------------------------

/**
 * An open membership request that `me` may decide (an admin, or a manager of its team), or the
 * answer that says why not.
 */
async function openMemberRequest(env, me, id) {
  const r = await getMemberRequest(env, id);
  if (!r) {
    return { error: json({ error: 'no such request' }, 404) };
  }
  if (!managesTeam(me, r.team)) {
    return { error: json({ error: 'you do not manage this team' }, 403) };
  }
  if (r.status !== 'open') {
    return { error: json({ error: `this request is ${r.status} already`, request: r }, 409) };
  }
  return { request: r };
}

/** Whether the person of a request is on its team. */
async function onTeam(env, { team: slug, person }) {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM team_members m JOIN people p ON p.id = m.person
    WHERE m.team = ? AND p.email = ?`).bind(slug, person.email).first());
}

/**
 * POST /api/admin/member-requests/confirm `{ id }`: an admin or one of the team's managers grants
 * a membership request (src/memberrequests.js). The person is added as on the team's page (a
 * member, a manager in a self-managed team), and the sign-in allow list follows; the request is
 * confirmed with who confirmed it, `added`, or `member` when they were on the team already.
 */
async function confirmMemberRequest(env, me, body) {
  const { request, error } = await openMemberRequest(env, me, body.id);
  if (error) {
    return error;
  }
  // Claimed first: whoever closes it decides. A failed addition opens it again.
  if (!await claimMemberRequest(env, me, request.id)) {
    return json({
      error: 'decided meanwhile', closed: false, request: await getMemberRequest(env, request.id),
    }, 409);
  }
  const was = request.person.member;
  let res;
  try {
    res = await withAccessSync(env, 'member added', addMember(env, {
      team: request.team, email: request.person.email, name: request.person.name,
    }));
  } catch (e) {
    if (await onTeam(env, request)) {
      await recordMemberOutcome(env, request.id, 'added');
    } else {
      await reopenMemberRequest(env, request.id);
    }
    throw e;
  }
  const answer = await res.json();
  if (!res.ok) {
    return json({ ...answer, request: await reopenMemberRequest(env, request.id) }, res.status);
  }
  console.log(JSON.stringify({
    route: 'admin', memberRequest: 'confirmed', by: me.id, id: request.id, team: request.team,
  }));
  return json({
    ...answer,
    closed: true,
    request: await recordMemberOutcome(env, request.id, was ? 'member' : 'added'),
  });
}

/**
 * POST /api/admin/member-requests/decline `{ id, reason? }`: an admin or one of the team's
 * managers turns a membership request down.
 */
async function declineMemberRequest(env, me, body) {
  const { request, error } = await openMemberRequest(env, me, body.id);
  if (error) {
    return error;
  }
  const closed = await closeMemberRequest(env, me, request.id, {
    status: 'declined', reason: clean(body.reason, 500) || null,
  });
  return closed.closed ? json({ ok: true, ...closed }) : json({ error: 'decided meanwhile', ...closed }, 409);
}

/** POST /api/admin/members, answering the open membership requests for the person with it. */
async function addMemberSettling(env, me, body) {
  const res = await addMember(env, body);
  if (res.ok) {
    await settleMemberRequests(env, me, { team: body.team, email: body.email });
  }
  return res;
}

/**
 * The routes of `/api/admin/*` for every member of an ops team, not only the admin team and
 * team managers: the duplicate customers they see, asking for a merge (src/orgmerge.js), asking the
 * admin team to decide a partner of a customer (src/partnerrequests.js), and the customers' pages
 * (whose channels, and who follows them).
 */
export const STAFF_ROUTES = ['GET org-duplicates', 'POST org-merge-requests', 'DELETE org-merge-requests',
  'POST org-partner-requests', 'DELETE org-partner-requests', 'GET orgs', 'GET org'];

async function adminRoute(request, env, url, me) {
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
    'POST portal/open', 'POST swap', 'PUT org-follows', 'POST release', 'DELETE share',
    'GET member-suggestions', 'POST member-suggestions/dismiss', 'DELETE member-suggestions/dismiss',
    'POST member-requests/confirm', 'POST member-requests/decline'];
  // Every manager may search channels; the requests they see are their teams' (`requests`), and
  // a membership request is decided by its own team's managers (`openMemberRequest`).
  const anyTeam = ['GET teams', 'GET channels', 'GET requests', 'POST member-requests/confirm',
    'POST member-requests/decline'];
  // Duplicate customers: anyone on a team sees those of the customers it owns, and asks for a
  // merge (src/orgmerge.js checks which).
  if (!isAdmin(me) && !STAFF_ROUTES.includes(route)) {
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
    case 'POST members': return withAccessSync(env, 'member added', addMemberSettling(env, me, body));
    case 'PUT members': return setRole(env, body);
    case 'GET people': return people(env, clean(url.searchParams.get('q')), q('team'));
    case 'GET member-suggestions': return suggestedMembers(env, q('team'));
    case 'POST member-suggestions/dismiss': return dismissSuggestedMember(env, me, body, true);
    case 'DELETE member-suggestions/dismiss': return dismissSuggestedMember(env, me, body, false);
    case 'GET team-groups': return json(await teamGroups(env));
    case 'POST team-wizard': return teamWizard(env, me, body);
    case 'POST team-wizard/dismiss': return await dismissGroup(env, clean(body.prefix).toLowerCase(), me.email || String(me.id))
      ? json({ ok: true }) : json({ error: 'no such group of channels now' }, 404);
    case 'DELETE team-wizard/dismiss': return json({ ok: await dismissGroup(env, clean(body.prefix).toLowerCase(), null, false) });
    case 'DELETE members': return withAccessSync(env, 'member removed', removeMember(env, me, body));
    case 'GET rules': return json({
      // The merges are the orgs' (GET org-duplicates), not rules anyone edits.
      rules: (await loadRules(env)).filter((r) => r.target !== 'merge'), fields: FIELDS, kinds: KINDS,
    });
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
    case 'POST requests': return createRequest(env, me, body, { move: Boolean(body.move) });
    case 'DELETE requests': return withdrawRequest(env, me, body);
    case 'POST requests/confirm': return confirmRequest(env, me, body);
    case 'POST requests/decline': return declineRequest(env, me, body);
    case 'POST member-requests/confirm': return confirmMemberRequest(env, me, body);
    case 'POST member-requests/decline': return declineMemberRequest(env, me, body);
    case 'POST portal/open': return openPortal(env, me, body);
    case 'POST portal/decline': return declinePortal(env, me, body);
    case 'POST portal/integration/approve': return approveIntegration(env, me, body);
    case 'POST portal/integration/decline': return declineIntegration(env, me, body);
    case 'GET portal/integration/channels': return json({
      channels: await listIntegrationChannels(env), portalBound: portalBound(env),
    });
    case 'PUT portal/integration/auto': return setIntegrationAuto(env, me, body);
    case 'PUT portal/integration/audience': return setIntegrationAudience(env, me, body);
    case 'POST conflicts': return settleConflict(env, me, body);
    case 'POST rule-conflicts': return settleRuleConflict(env, me, body);
    // Channel threads labeled again though they did not change (src/label.js queueRelabel).
    case 'POST relabel': return env.NORMALIZE ? json(await queueRelabel(env, body))
      : json({ error: 'no queue' }, 503);
    case 'POST classify': return json(await classifyChannels(env, {
      limit: Math.min(Math.max(Number(body.limit) || 10, 1), 25),
    }));
    case 'GET orgs': return listOrgs(env, me);
    case 'POST orgs': return saveOrg(env, body, true);
    case 'PUT orgs': return saveOrg(env, body, false);
    case 'DELETE orgs': return deleteOrg(env, body);
    case 'GET org': return org(env, q('slug'), me);
    case 'PUT org-follows': return followOrg(env, me, body);
    case 'POST release': return releaseChannel(env, me, body);
    case 'GET org-duplicates': return orgDuplicates(env, me, { pair: q('pair'), fresh: Boolean(q('fresh')) });
    case 'POST org-duplicates/dismiss': return dismissPair(env, me, body);
    // Which customers each partner works for (src/orgpartners.js).
    case 'GET org-partners': return orgPartners(env, me, { pair: q('pair'), fresh: Boolean(q('fresh')) });
    // Both orgs' pages say so at once, in this isolate (src/orgprofile.js).
    case 'POST org-partners/confirm':
    case 'POST org-partners/dismiss': {
      const res = await decidePartner(env, me, body, route.endsWith('confirm') ? 'confirm' : 'dismiss');
      forgetOrgProfiles(String(body.customer || ''), String(body.partner || ''));
      return res;
    }
    case 'POST org-partners/end': {
      const res = await endPartner(env, me, body);
      forgetOrgProfiles(String(body.customer || ''), String(body.partner || ''));
      return res;
    }
    // Asking the admin team to decide a pair, in its inbox (src/partnerrequests.js).
    case 'POST org-partner-requests': return requestPartner(env, me, body);
    case 'DELETE org-partner-requests': return closePartnerRequest(env, me, body, 'withdrawn');
    case 'POST org-partner-requests/decline': return closePartnerRequest(env, me, body, 'declined');
    case 'POST org-merge': return mergeOrgs(env, me, body, { applyRules });
    case 'DELETE org-merge': return unmergeOrg(env, me, body, { applyRules });
    case 'POST org-merge-requests': return requestMerge(env, me, body);
    case 'DELETE org-merge-requests': return closeMergeRequest(env, me, body, 'withdrawn');
    case 'POST org-merge-requests/decline': return closeMergeRequest(env, me, body, 'declined');
    case 'GET partner-domains': return listPartnerDomains(env, { fresh: Boolean(q('fresh')) });
    case 'PUT partner-domains': return savePartnerDomain(env, me, body);
    case 'DELETE partner-domains': return deletePartnerDomain(env, body);
    case 'GET org-icons': return orgIcons(env, q('slug'), Boolean(q('fresh')));
    case 'GET favicon': return faviconProxy(q('domain'), { request });
    case 'GET bots': return listBots(env);
    case 'GET bot': return getBot(env, url.searchParams.get('key'));
    case 'PUT bots': return setBot(env, me, body);
    case 'GET accounts': return listAccounts(env);
    case 'PUT accounts': return linkAccount(env, me, body);
    case 'POST accounts/decline': return declineProposal(env, me, body);
    case 'PUT account-pairs': return decideAccountPair(env, me, body);
    case 'GET cogs': return json(await cogsReport(env, url));
    case 'POST cogs/rollup': return json(await rollupCogs(env));
    case 'GET topics': return json({
      latest: await latestTopicMap(env), available: Boolean(env.CONTENT && env.AI),
    });
    case 'POST topics': return buildTopics(env, me);
    default: return json({ error: 'not found' }, 404);
  }
}

/**
 * The routes that may decide one of the admin team's requests, or settle or open a conflict: its
 * inboxes load the requests again (src/requestthreads.js), unless it was a dry run.
 */
const DECIDING = new Set(['DELETE requests', 'POST member-requests/confirm',
  'POST member-requests/decline', 'POST portal/open', 'POST portal/decline',
  'POST portal/integration/approve', 'POST portal/integration/decline',
  'PUT portal/integration/auto', 'PUT portal/integration/audience', 'DELETE org-merge-requests', 'POST org-merge-requests/decline', 'POST org-merge',
  'DELETE org-merge', 'POST members', 'POST assign', 'DELETE assign', 'POST rules', 'PUT rules',
  'DELETE rules', 'PUT bots', 'PUT accounts', 'POST accounts/decline', 'PUT account-pairs', 'POST conflicts',
  'POST rule-conflicts']);

export async function admin(request, env, url, me) {
  const route = `${request.method} ${url.pathname.slice('/api/admin/'.length)}`;
  const deciding = url.pathname.startsWith('/api/admin/') && DECIDING.has(route);
  const asked = deciding ? await request.clone().json().catch(() => ({})) : null;
  const res = await adminRoute(request, env, url, me);
  if (deciding && res && res.ok && !asked.dryRun) {
    await announceRequest(env);
  }
  return res;
}
