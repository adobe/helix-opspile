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

import { accessEmail } from './access.js';
import { admin, followOrg, STAFF_ROUTES } from './admin.js';
import { changeFollow, followState } from './following.js';
import { isInternal } from './kbaccess.js';
import { kbAdmin } from './kbadmin.js';
import { personInKb } from './kbpeople.js';
import {
  agentStatus, decideBash, decideTool, sawSidebar, seedAgent, talkToAgent, tellDiscarded,
} from './agent/stub.js';
import { agentEnabled } from './agent/enabled.js';
import { keptTurn } from './agent/kept.js';
import { sidebarFor, unseenAnswers } from './sidebar.js';
import { toolRequestsFor } from './toolrequests.js';
import {
  discardDraft, draftOf, draftsFor, draftSource, draftSummary, entryOf, getDraft, getDraftFile,
  saveDraft,
} from './drafts.js';
import { requestsFor } from './bashrequests.js';
import { teamsBotIcon } from './bots.js';
import { faviconProxy } from './favicons.js';
import { refreshAttachment } from './discord.js';
import { edit } from './edit.js';
import { expertEvents, recordExpertEvent } from './expertevents.js';
import { experts } from './experts.js';
import { cachedGraph } from './graph.js';
import {
  attachable, connections, disconnect, editable, finishAuth, mentionable, post,
  postableChannels, reactable, startAuth, typing,
} from './post.js';
import { appPostCheck, postApp } from './postapp.js';
import { closestEmoji, rankEmoji, workspaceEmoji } from './shortcodes.js';
import { rankEvents, recordPick } from './rankevents.js';
import { mentionReminders } from './reminders.js';
import {
  isSignInDomain, isStaffDomain, personAvatar, toAuthor,
} from './lookup.js';
import { appRule, readPost } from './attach.js';
import { openPortalFile, portalFetch, portalFileOf } from './portalsource.js';
import { agentLabelsFor, applyAgentLabels } from './agentlabels.js';
import { react, resolve } from './react.js';
import {
  mergeFacts, resolution, resolutionFacts, signalFacts,
} from './resolve.js';
import { folderFiles } from './filecache.js';
import {
  filePoster, openThreadFile, streamFile, threadFile,
} from './fileview.js';
import { isSharePointUrl, keptTeamsFile } from './teamsfiles.js';
import { mentionedPeople, profiles, relationOf } from './profiles.js';
import { partnerDomains } from './partners.js';
import { channelLinks, channelRefs, nameChannelIds } from './channelrefs.js';
import { slackMessageLinks } from './slacklinks.js';
import { json, text } from './http.js';
import { isAdmin, isManager } from './roles.js';
import {
  inPersonalInbox, mayPost, mayReply, maySee, mayWork, memberOf, roomsOf, sharedWith, teamsOf,
  viewTeam,
} from './shares.js';
import { followable, followedByTeam } from './follows.js';
import { suggestFollows } from './followsuggest.js';
import { DEFAULTS, readSettings, saveSettings } from './settings.js';
import { claimPost, logPost, settlePost } from './postkeys.js';
import { postingOffer } from './postoffer.js';
import {
  ATTENTION, botReplies, latestMember, readState, unreadInYours, waitingOn,
} from './threads.js';
import {
  cleanQuery, find, MAX_RESULTS, queryVector, terms, withSnippets,
} from './search.js';
import { findKnowledge } from './kbsearch.js';
import { Timing, withTiming } from './timing.js';
import {
  bookmarkOf, constraintFor, sessionDatabase, withBookmark,
} from './d1session.js';
import { batchedDatabase, overloaded } from './d1batch.js';
import { statsFor } from './klickhaus.js';
import { TECH_MIN, topicList, vocab } from './label.js';
import { orgStacksOf } from './orgstacks.js';
import { customerStanding, setMark } from './standing.js';
import {
  changeArea, rebuildTopics, topicsPage, trendsApi,
} from './topicsapi.js';
import { techInfo } from './techinfo.js';
import { teamDirectory, teamProfile } from './teamprofile.js';
import { teamVendors } from './vendors.js';
import { orgDirectory, orgProfile } from './orgprofile.js';
import { orgPartnerLinks } from './orgpartners.js';
import { notifyRoom } from './notify.js';
import {
  aboutThreads, dismissAbout, dismissLink, entryLinks, linkedOrgsOf,
} from './threadlinks.js';
import { drawDiagram } from './diagrams.js';
import { isRequestKey } from './requestkeys.js';
import { openQuestions } from './questions.js';
import { waitingFor } from './waiting.js';
import {
  addNote, readRoom, requestEntries, requestThread, resolveRequest,
} from './requestthreads.js';
import { targetOf, translateMessages } from './translate.js';

/**
 * The inbox API behind Cloudflare Access. Every request is tied to a person in D1 by the
 * verified Access email, and sees only the threads of the teams that person is in.
 */

// One page of the inbox, in groups (a re-threaded group counts once): the first page comes
// with the page, older pages are fetched behind it with `before`.
export const INBOX_PAGE = 100;
const MAX_PAGE = 300;
const MAX_PARTICIPANTS = 5;

const identityJoin = "LEFT JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +m.author_key";
const domainOf = (email) => (email && email.includes('@') ? email.split('@').pop().toLowerCase() : null);

/**
 * A message's author as its account says now (`account`: the message's row, with its
 * identity's `account_kind`, `ours`, `account_staff`, `account_email`, `account_name`,
 * `display_name` and `linked_at`, and its person's `account_person_staff` and
 * `account_person_name`), since the frontmatter says what was so when it was written:
 *
 * - a bot an admin says is Adobe's, or takes it back (in its thread of the admin team's inbox),
 *   moves to that side, and the name an admin gives it goes on its messages too. A bot nobody
 *   decided on (`ours` NULL) keeps its frontmatter's side.
 * - a person's account that is staff now and was not then (one of the host tenant's admin
 *   accounts, src/lookup.js `isHostAdmin`) is Adobe's.
 * - an account whose person no mail address says (staff by itself: a host tenant's admin account,
 *   a Discord account with a staff role; or one the admin team linked, src/accountlinks.js) goes
 *   by the name `toAuthor` gives it now: its person's while it has one (linked to the Adobe
 *   person who uses it, or connected by them on Discord), else its own, so taking the link back
 *   gives its messages their account's name again. Everyone else's name is the frontmatter's.
 */
export function accountAuthor(env, author, account) {
  if (!author || !account) {
    return author;
  }
  if (author.kind === 'person' && account.account_kind === 'person') {
    const now = toAuthor(env, {
      kind: 'person',
      name: account.account_name,
      staff: account.account_staff,
      person_staff: account.account_person_staff,
      person_name: account.account_person_name,
      email: account.account_email,
    });
    const name = (account.account_staff || account.linked_at) && now.name;
    if (!(now.staff && !author.staff) && !(name && name !== author.name)) {
      return author;
    }
    return { ...author, ...(now.staff ? { staff: true } : {}), ...(name ? { name } : {}) };
  }
  if (author.kind !== 'bot' || account.account_kind !== 'bot') {
    return author;
  }
  const named = account.display_name && account.display_name !== author.name
    ? { ...author, name: account.display_name } : author;
  if (account.ours === null || account.ours === undefined) {
    return named;
  }
  const { staff } = toAuthor(env, {
    kind: 'bot', staff: account.account_staff, email: account.account_email, ours: account.ours,
  });
  return staff === Boolean(named.staff) ? named : { ...named, staff };
}

/**
 * People in each thread, in order of first post (up to five), and the customer's mail
 * domain (the most common domain among non-staff authors). Emails stay on the server.
 */
async function participants(env, keys) {
  const { results } = await env.DB.prepare(`SELECT m.thread, m.author, MAX(m.staff) AS staff,
      MIN(m.at) AS first_at, MAX(i.avatar) AS avatar, MAX(i.email) AS email,
      MAX(m.author_key) AS author_key
    FROM messages m ${identityJoin}
    WHERE m.thread IN (SELECT value FROM json_each(?)) AND m.deleted = 0 AND m.counted = 1
    GROUP BY m.thread, COALESCE(m.author_key, m.author)
    ORDER BY m.thread, first_at`).bind(keys).all();
  const by = new Map();
  for (const r of results || []) {
    if (!by.has(r.thread)) {
      by.set(r.thread, { people: [], domains: new Map(), staff: false });
    }
    const t = by.get(r.thread);
    // Whether anyone at Adobe has posted at all, beyond the few faces shown.
    t.staff = t.staff || Boolean(r.staff);
    if (t.people.length < MAX_PARTICIPANTS) {
      t.people.push({
        name: r.author,
        staff: Boolean(r.staff),
        avatar: r.avatar || null,
        key: r.author_key || null,
      });
    }
    const domain = domainOf(r.email);
    if (domain && !r.staff) {
      t.domains.set(domain, (t.domains.get(domain) || 0) + 1);
    }
  }
  return new Map([...by].map(([key, t]) => [key, {
    participants: t.people,
    staffPosted: t.staff,
    customerDomain: [...t.domains].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
  }]));
}

/**
 * A person with their teams, by `id` or `email`, in one round trip (every API call asks this
 * first), or null.
 */
async function personWhere(env, column, value) {
  const { results } = await env.DB.prepare(`SELECT p.id, p.name, p.email, p.staff, t.slug,
      t.name AS team, m.role
    FROM people p LEFT JOIN team_members m ON m.person = p.id LEFT JOIN teams t ON t.slug = m.team
    WHERE p.${column === 'id' ? 'id' : 'email'} = ? ORDER BY t.slug`).bind(value).all();
  if (!results || !results.length) {
    return null;
  }
  const { id, name, email } = results[0];
  const teams = results.filter((r) => r.slug)
    .map((r) => ({ slug: r.slug, name: r.team, role: r.role }));
  return {
    id,
    name,
    email,
    // Adobe's (marked staff in D1, or a mail domain of STAFF_DOMAINS), on a team or not.
    staff: Boolean(results[0].staff) || isStaffDomain(env, email),
    teams,
    admin: teams.some((t) => t.slug === 'admin'),
    // Teams whose members and knowledge base this person manages (see migration 0018).
    manages: teams.filter((t) => t.role === 'manager').map((t) => t.slug),
  };
}

/**
 * Whether a person may use the inbox: a member of an ops team, or (no-team mode) someone
 * whose email is in one of SIGNIN_DOMAINS.
 */
const admitted = (env, p) => Boolean(p) && (p.teams.length > 0 || isSignInDomain(env, p.email));

/** A person by id, with their teams (an MCP client's token names the person), or null. */
export async function personById(env, id) {
  const p = await personWhere(env, 'id', id);
  return admitted(env, p) ? p : null;
}

/**
 * What the admin team says about orgs (display name, icon, type), by slug, for the threads
 * the UI shows: `org_name`, `org_icon`, `org_type` on each.
 */
async function orgsOf(env, slugs) {
  const list = [...new Set(slugs.filter(Boolean))];
  if (!list.length) {
    return new Map();
  }
  const { results } = await env.DB.prepare(`SELECT slug, name, type, icon FROM orgs
    WHERE slug IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(list)).all();
  return new Map((results || []).map((o) => [o.slug, o]));
}
/**
 * An inbox entry's linked orgs (src/threadlinks.js `linkedOrgsOf`), of any of its threads `keys`:
 * `{ about, with }`, or null where it has none.
 */
function linkedOf(linkedBy, keys) {
  const about = [];
  const withs = [];
  for (const k of new Set(keys)) {
    const l = linkedBy.get(k);
    if (l) {
      about.push(...l.about.filter((o) => !about.some((x) => x.slug === o.slug)));
      withs.push(...l.with.filter((o) => !withs.some((x) => x.slug === o.slug)));
    }
  }
  return about.length || withs.length ? { about, with: withs } : null;
}

const orgFields = (orgs, slug) => {
  const o = orgs.get(slug);
  return { org_name: (o && o.name) || null, org_icon: (o && o.icon) || null, org_type: (o && o.type) || 'customer' };
};

/**
 * The person signed in with `email`, with their teams, or null. Without a team, only from one
 * of SIGNIN_DOMAINS (no-team mode); someone from there signing in for the first time, who never
 * posted in a channel opspile follows, becomes a person in D1 now (staff if the domain is one of
 * STAFF_DOMAINS), named as their platform accounts are.
 */
export async function personByEmail(env, email) {
  const found = await personWhere(env, 'email', email);
  if (found || !isSignInDomain(env, email)) {
    return admitted(env, found) ? found : null;
  }
  const known = await env.DB.prepare(`SELECT name FROM identities
    WHERE email = ? AND kind = 'person' AND name IS NOT NULL LIMIT 1`).bind(email).first();
  await env.DB.prepare(`INSERT INTO people (email, name, staff) VALUES (?, ?, ?)
    ON CONFLICT (email) DO NOTHING`)
    .bind(email, (known && known.name) || null, isStaffDomain(env, email) ? 1 : 0).run();
  return personWhere(env, 'email', email);
}

/**
 * The signed-in person, from the verified Access email. An admin may look at the inbox as
 * someone else (`x-opspile-as: <person id>`): reads only, never their read state or a reply.
 */
export async function viewer(request, env, options) {
  const email = await accessEmail(request, env, options);
  if (!email) {
    return null;
  }
  const me = await personByEmail(env, email);
  if (!me) {
    return null;
  }
  const as = Number(request.headers.get('x-opspile-as') || new URL(request.url).searchParams.get('as'));
  if (me.admin && as && as !== me.id) {
    const them = await personWhere(env, 'id', as);
    if (them) {
      return { ...them, viewer: { id: me.id, name: me.name }, readonly: true };
    }
  }
  return me;
}

/** What `me` follows and mutes, and what their teams follow (src/following.js). */
const followsOf = (env, me) => followState(env, me);

/** Whether the viewer is internal (src/kbaccess.js `isInternal`): who sees every page. */
const internal = isInternal;

/** Whether the viewer is in a team, or in one of a list of them (a shared channel's). */
const inTeam = (me, teams) => memberOf(me)(teams);

/**
 * Whether the viewer may see thread `key`, as `/api/thread` decides: a team whose inbox has it,
 * or for someone on no team a channel of their personal view.
 */
async function canSee(env, me, key) {
  const row = await env.DB.prepare('SELECT thread, team, source, channel_id FROM threads WHERE thread = ?')
    .bind(key).first();
  return Boolean(row) && maySee(env, me)(await teamsOf(env, row), row);
}

/**
 * Whose inbox it is, as SQL: `team_members.team` (or any column of team slugs) is in it with
 * `in(column)`, bound to `value`: the team, or for the personal view the viewer's teams.
 */
function inboxTeams(me, team, personal) {
  if (!personal) {
    return { in: (column) => `${column} = ?`, value: team };
  }
  return {
    in: (column) => `${column} IN (SELECT value FROM json_each(?))`,
    value: JSON.stringify((me.teams || []).map((t) => t.slug)),
  };
}

async function members(env, teams) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT p.id, p.name FROM team_members m
    JOIN people p ON p.id = m.person WHERE ${teams.in('m.team')} ORDER BY p.name`)
    .bind(teams.value).all();
  return results || [];
}

/**
 * SQL: the thread row `alias` is in the inbox, with `?1` bound to `inboxTeams(…).value`. A
 * team's inbox has its own channels, the channels shared with it and the threads that show a
 * technology it follows (src/follows.js). The personal view has the conversations in the
 * channels the viewer posted or was mentioned in (`me`: the parameter bound to their id), and
 * those that show a technology they follow, whichever team they are filed under, on a team or
 * not; alerts are not in it.
 */
function inInbox(alias, personal, me) {
  if (!personal) {
    return `(${alias}.team = ?1 OR ${sharedWith(alias, '?1')} OR ${followedByTeam(alias, '?1')})`;
  }
  // ?1 (the viewer's teams) is not needed here, but is bound: say so, so it stays numbered.
  return `?1 IS NOT NULL AND ${alias}.kind != 'alert'
    AND ${inPersonalInbox(alias, me)}`;
}

const rank = (a) => (a ? ATTENTION.indexOf(a) : ATTENTION.length);
const max = (xs) => xs.filter(Boolean).sort().pop() || null;

/**
 * Folds re-threaded threads into one entry per group (keyed by the group's first
 * thread). The entry keeps the first thread's title and link, the latest activity and
 * label of any member, the most pressing attention, and the list of members. A first thread
 * whose messages are all deleted has neither title nor link: the next member's stand in.
 */
export function fold(threads) {
  const groups = new Map();
  for (const t of threads) {
    const k = t.logical_thread || t.thread;
    if (!groups.has(k)) {
      groups.set(k, []);
    }
    groups.get(k).push(t);
  }
  return [...groups].map(([k, ms]) => {
    if (ms.length === 1 && ms[0].thread === k) {
      return { ...ms[0], members: [{ thread: k, last_at: ms[0].last_at, any_at: ms[0].any_at }] };
    }
    const byRoot = [...ms].sort((a, b) => String(a.root_at).localeCompare(String(b.root_at)));
    const anchor = ms.find((m) => m.thread === k) || byRoot[0];
    const latest = latestMember(ms);
    const first = (f) => [anchor, ...byRoot].map((m) => m[f]).find(Boolean) ?? anchor[f];
    const people = [];
    for (const m of byRoot) {
      for (const p of m.participants || []) {
        if (people.length < 5 && !people.some((x) => x.name === p.name)) {
          people.push(p);
        }
      }
    }
    return {
      ...anchor,
      thread: k,
      title: first('title'),
      permalink: first('permalink'),
      last_at: max(ms.map((m) => m.last_at)),
      any_at: max(ms.map((m) => m.any_at)),
      last_author: latest.last_author,
      last_staff: latest.last_staff,
      last_text: latest.last_text,
      messages: ms.reduce((n, m) => n + (m.messages || 0), 0),
      imported: ms.every((m) => Number(m.imported)) ? 1 : 0,
      participants: people,
      staffPosted: ms.some((m) => m.staffPosted),
      label: latest.label || anchor.label || null,
      attention: [...ms].sort((a, b) => rank(a.attention) - rank(b.attention))[0].attention,
      unread: ms.some((m) => m.unread),
      unseen: ms.every((m) => m.unseen),
      unseenByAdobe: ms.some((m) => m.unseenByAdobe),
      seenByOthers: ms.some((m) => m.seenByOthers),
      mentionedMe: ms.some((m) => m.mentionedMe),
      unreadMentions: ms.reduce((n, m) => n + (m.unreadMentions || 0), 0),
      unreadForYou: ms.reduce((n, m) => n + (m.unreadForYou || 0), 0),
      mentionedTeam: [...new Set(ms.flatMap((m) => m.mentionedTeam || []))],
      readers: latest.readers,
      reactions: Object.values(ms.flatMap((m) => m.reactions || []).reduce((acc, r) => {
        acc[r.emoji] = { emoji: r.emoji, count: (acc[r.emoji]?.count || 0) + r.count };
        return acc;
      }, {})),
      posters: [...new Set(ms.flatMap((m) => m.posters || []))],
      mentioned: ms.flatMap((m) => m.mentioned || []),
      resolutionFacts: mergeFacts(ms.map((m) => m.resolutionFacts)),
      signals: ms.flatMap((m) => m.signals || []),
      members: byRoot.map((m) => ({ thread: m.thread, last_at: m.last_at, any_at: m.any_at })),
    };
  }).sort((a, b) => String(b.last_at || b.any_at).localeCompare(String(a.last_at || a.any_at)));
}

/**
 * Unread threads in the viewer's team inboxes that the personal view does not already show
 * (a channel they posted or were mentioned in; alerts are never in it). One count per team,
 * of inbox entries: a re-threaded group counts once, and a shared channel counts for every
 * team whose inbox has it. `members` is the size of the team, for ordering the smallest first.
 * Teams with nothing left are left out. The admin team is not special here; the page lists it
 * last.
 */
async function unreadElsewhere(env, me) {
  const outside = `NOT (t.kind != 'alert' AND ${inPersonalInbox('t', '?1')})`;
  const { results } = await env.DB.prepare(`WITH mine AS (
      SELECT m.team, t.name,
        (SELECT COUNT(*) FROM team_members c WHERE c.team = m.team) AS members
      FROM team_members m JOIN teams t ON t.slug = m.team WHERE m.person = ?1
    ), unread AS (
      SELECT COALESCE(t.logical_thread, t.thread) AS g, t.team AS filed, t.source, t.channel_id,
        t.thread, t.logical_thread
      FROM threads t LEFT JOIN watermarks w ON w.thread = t.thread AND w.person = ?1
      WHERE t.kind != 'ignore' AND t.imported = 0
        AND CASE WHEN t.kind = 'alert' THEN t.any_at ELSE t.last_at END IS NOT NULL
        AND (w.read_at IS NULL OR w.read_at < CASE WHEN t.kind = 'alert' THEN t.any_at
          ELSE t.last_at END)
        AND ${outside}
    )
    SELECT m.team AS slug, m.name, m.members, (
      SELECT COUNT(DISTINCT u.g) FROM unread u
      WHERE u.filed = m.team OR (u.source, u.channel_id) IN (
        SELECT c.source, c.channel_id FROM channel_teams c WHERE c.team = m.team)
        OR ${followedByTeam('u', 'm.team')}
    ) AS unread
    FROM mine m`).bind(me.id).all();
  return (results || []).filter((r) => r.unread > 0).map((r) => ({
    slug: r.slug, name: r.name, members: r.members, unread: r.unread,
  }));
}

/**
 * A page of a team's inbox, or with `personal` (and no team) of the viewer's personal view.
 * `before` is the `next` cursor of the previous page (`<latest>|<group>`): the groups whose
 * latest activity comes after it in the newest-first order. With `groups` (inbox entry keys,
 * as search finds them), those entries of the inbox instead, and no page: a key that is not
 * in it is left out.
 */
export async function inbox(env, me, team, {
  before = null, limit = INBOX_PAGE, personal = false, groups: only = null,
} = {}) {
  const scope = inboxTeams(me, team, personal);
  const size = Math.max(1, Math.min(MAX_PAGE, Number(limit) || INBOX_PAGE));
  const cursor = before ? String(before).split('|') : null;
  const [beforeAt, beforeG] = cursor && cursor.length === 2 ? cursor : [null, null];
  // Who is on the viewer's teams and on this one does not depend on the threads: asked for
  // at once with the groups. Everything after the thread rows is asked for at once too
  // (loading the inbox used to wait for some twenty round trips in a row).
  const teamRowsP = env.DB.prepare(`SELECT m.team, m.person, t.name FROM team_members m
    JOIN teams t ON t.slug = m.team
    WHERE m.team IN (SELECT team FROM team_members WHERE person = ?)`).bind(me.id).all();
  const membersP = members(env, scope);
  // The personal view's rooms (as /api/me's): they grow when the viewer is first in a channel
  // of another team, and the inbox listens there from then on.
  const roomsP = personal ? roomsOf(env, me) : Promise.resolve(null);
  // Settled either way, so a failure elsewhere does not leave these rejections unhandled.
  teamRowsP.catch(() => {});
  membersP.catch(() => {});
  roomsP.catch(() => {});
  // The latest groups (a re-threaded group counts once), then for each group its first
  // thread (title, link) and its five most recent members (activity, read state).
  const shown = (t) => `${t}.kind != 'ignore'
      -- Threads of nothing but system events ("has joined the channel", a member was added)
      -- are not shown: no person posted, and no message has an author account (bots do).
      AND NOT (${t}.kind = 'channel' AND ${t}.last_at IS NULL AND NOT EXISTS (SELECT 1 FROM messages m
        WHERE m.thread = ${t}.thread AND m.author_key IS NOT NULL AND m.deleted = 0))
      ${only ? `AND COALESCE(${t}.logical_thread, ${t}.thread) IN (SELECT value FROM json_each(?6))` : ''}`;
  const sums = `COALESCE(t.logical_thread, t.thread) AS g, COUNT(*) AS n, SUM(t.messages) AS total,
      MAX(COALESCE(t.last_at, t.any_at)) AS latest`;
  // A team's inbox: the team's own channels' threads group by group from `threads_inbox`
  // (migration 0069), which has all this needs, then those of the channels shared with it
  // (migration 0024), then the other threads that show a technology it follows (migration
  // 0072). An alert channel files tens of thousands of threads under its team: as one
  // `team = ? OR <shared channel>`, every one of them was read from the table and sorted.
  const grouped = personal
    ? `SELECT ${sums} FROM threads t WHERE ${inInbox('t', personal, '?5')} AND ${shown('t')}
      GROUP BY g`
    : `SELECT g, SUM(n) AS n, SUM(total) AS total, MAX(latest) AS latest FROM (
        SELECT ${sums} FROM threads t WHERE t.team = ?1 AND ${shown('t')}
          GROUP BY COALESCE(t.logical_thread, t.thread)
        UNION ALL SELECT ${sums} FROM threads t
          WHERE t.team != ?1 AND ${sharedWith('t', '?1')} AND ${shown('t')} GROUP BY 1
        UNION ALL SELECT ${sums} FROM threads t
          WHERE t.team != ?1 AND NOT ${sharedWith('t', '?1')} AND ${followedByTeam('t', '?1')}
            AND ${shown('t')} GROUP BY 1)
      GROUP BY g`;
  const { results: groups } = await env.DB.prepare(`SELECT g, n, total, latest FROM (${grouped})
    WHERE ?2 IS NULL OR latest < ?2 OR (latest = ?2 AND g < ?3)
    ORDER BY latest DESC, g DESC LIMIT ?4`)
    .bind(...[scope.value, only ? null : beforeAt, beforeG, only ? only.length + 1 : size + 1]
      .concat(personal || only ? [personal ? me.id : null] : [])
      .concat(only ? [JSON.stringify(only)] : [])).all();
  // One more than the page says whether there is another.
  const more = !only && (groups || []).length > size;
  if (more) {
    groups.pop();
  }
  const last = (groups || [])[groups.length - 1];
  const page = { next: more && last ? `${last.latest}|${last.g}` : null, before: before || null };
  const groupKeys = JSON.stringify((groups || []).map((g) => g.g));
  // Each group's first thread and its five latest members, these by index (migration 0068): an
  // alert channel folds thousands of posts into one entry, and ranking every thread of the
  // inbox to find them was the query D1 spent the most time on.
  const { results: threads } = await env.DB.prepare(`WITH g(k) AS (SELECT value FROM json_each(?2)),
      c(thread) AS (SELECT k FROM g
        UNION SELECT x.thread FROM g JOIN threads x ON x.thread IN (SELECT y.thread FROM threads y
          WHERE y.logical_thread = g.k AND ${inInbox('y', personal, '?3')} AND y.kind != 'ignore'
          ORDER BY COALESCE(y.last_at, y.any_at) DESC LIMIT 5))
    SELECT thread, source, org, team, kind,
      channel_name, title, root_at, last_at, last_author, last_staff, last_text, any_at,
      messages, imported,
      root_at IS NOT NULL AS root_known, logical_thread,
      (SELECT m.permalink FROM messages m WHERE m.thread = r.thread AND m.deleted = 0
        AND m.permalink IS NOT NULL ORDER BY (m.id = r.root_id) DESC, m.at LIMIT 1)
        AS permalink
    FROM (SELECT t.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(t.logical_thread, t.thread)
          ORDER BY COALESCE(t.last_at, t.any_at) DESC) AS rn
        FROM c JOIN threads t ON t.thread = c.thread
        WHERE ${inInbox('t', personal, '?3')} AND t.kind != 'ignore'
          AND COALESCE(t.logical_thread, t.thread) IN g) r
    WHERE r.rn <= 5 OR r.thread IN g`)
    .bind(...[scope.value, groupKeys, personal ? me.id : []].flat()).all();
  const sizes = new Map((groups || []).map((g) => [g.g, g]));
  if (!threads.length) {
    return {
      team: personal ? null : team,
      personal,
      members: await membersP,
      threads: [],
      page,
      ...(personal ? { rooms: await roomsP } : {}),
      // The last page of the personal view says what other teams still have unread.
      ...(personal && !only && !more ? { elsewhere: await unreadElsewhere(env, me) } : {}),
    };
  }
  const threadKeys = threads.map((t) => t.thread);
  const keys = JSON.stringify(threadKeys);
  // The customers a partner's thread is about, the partners in a customer's (src/threadlinks.js).
  const linkedP = linkedOrgsOf(env, [...new Set([...threadKeys,
    ...threads.map((t) => t.logical_thread).filter(Boolean)])]);
  // A bot's reply after the last person's message (an agent's post_message): the row's preview.
  const botRepliesP = botReplies(env.DB, threadKeys);
  const [
    { results: marks }, { results: mentions }, { results: labels }, people, { results: rx },
    { results: posted }, { results: named }, resolved, signals, { results: names },
    drafts, { results: teamRows }, teamMembers, orgs, partners,
    { results: techRows }, stacks, techVocab, elsewhere, yours, unseen, agentLabels, standing,
  ] = await Promise.all([
    // Watermarks of every staff member (for "nobody at Adobe has seen it") and of the team
    // (the personal view: of the viewer's teams), the viewer's among them (someone on no team
    // is on none of them).
    env.DB.prepare(`SELECT w.person, w.thread, w.read_at, p.staff, (w.person = ? OR EXISTS (
          SELECT 1 FROM team_members m WHERE m.person = w.person AND ${scope.in('m.team')}))
          AS in_team
      FROM watermarks w JOIN people p ON p.id = w.person
      WHERE w.thread IN (SELECT value FROM json_each(?))
        AND (p.staff = 1 OR w.person = ? OR EXISTS (
          SELECT 1 FROM team_members m WHERE m.person = w.person AND ${scope.in('m.team')}))`)
      .bind(me.id, scope.value, keys, me.id, scope.value).all(),
    // Mentions of the team (the personal view: of the viewer's teams) and of the viewer.
    env.DB.prepare(`SELECT DISTINCT n.thread, n.message, n.person, n.at
      FROM mentions n
      -- A mention's message is in the mention's thread: the thread narrows the search.
      JOIN messages x ON x.thread = n.thread
        AND x.source || ':' || x.tenant || ':' || x.channel_id || ':' || x.id = +n.message
      WHERE n.thread IN (SELECT value FROM json_each(?)) AND x.deleted = 0
        AND (n.person = ? OR n.person IN (
          SELECT m.person FROM team_members m WHERE ${scope.in('m.team')}))`)
      .bind(keys, me.id, scope.value).all(),
    env.DB.prepare(`SELECT thread, next_actor, next_actor_p,
        kind AS label_kind, kind_p, urgency, resolved_p, labeled_through, title, topics FROM labels
      WHERE thread IN (SELECT value FROM json_each(?))`).bind(keys).all(),
    participants(env, keys),
    env.DB.prepare(`SELECT thread, emoji, COUNT(*) AS n FROM reactions
      WHERE thread IN (SELECT value FROM json_each(?)) GROUP BY thread, emoji`).bind(keys).all(),
    env.DB.prepare(`SELECT DISTINCT thread, person FROM messages
      WHERE thread IN (SELECT value FROM json_each(?)) AND person IS NOT NULL AND deleted = 0`)
      .bind(keys).all(),
    env.DB.prepare(`SELECT DISTINCT n.thread, n.person, p.staff
      FROM mentions n JOIN people p ON p.id = n.person
      WHERE n.thread IN (SELECT value FROM json_each(?))`).bind(keys).all(),
    resolutionFacts(env, threadKeys),
    signalFacts(env, threadKeys),
    // Names of everyone posting or mentioned (for "involves"): the people of the two queries
    // above, asked for in the same round.
    env.DB.prepare(`SELECT id, name, staff, email FROM people WHERE id IN (
        SELECT person FROM messages WHERE thread IN (SELECT value FROM json_each(?))
          AND person IS NOT NULL AND deleted = 0
        UNION SELECT person FROM mentions WHERE thread IN (SELECT value FROM json_each(?)))`)
      .bind(keys, keys).all(),
    // Shared drafts, on any member of an entry (an entry has at most one).
    draftsFor(env, [...threadKeys, ...threads.map((t) => t.logical_thread).filter(Boolean)]),
    teamRowsP,
    membersP,
    orgsOf(env, threads.map((t) => t.org)),
    partnerDomains(env),
    // What each thread shows (thread_tech, its own label), for the tech facet.
    env.DB.prepare(`SELECT thread, tech, p FROM thread_tech
      WHERE thread IN (SELECT value FROM json_each(?)) AND p >= ? ORDER BY p DESC`)
      .bind(keys, TECH_MIN).all(),
    // Each customer's stack, as its stack drawing has it (src/orgstacks.js), for the list by
    // customer: the customer-level record; Clef's answers are the threads'.
    orgStacksOf(env, threads.map((t) => t.org)),
    // The team's names for its technologies (the personal view, across teams: the admin team's).
    vocab(env, personal ? null : team),
    // Only once the personal view has been loaded to the end: the list says so then.
    personal && !only && !more ? unreadElsewhere(env, me) : null,
    // What the red badge counts: unread mentions, and what is new in the viewer's threads.
    unreadInYours(env.DB, threadKeys, me.id),
    // The agent's answers to the viewer in a sidebar they have not seen: the purple badge.
    unseenAnswers(env, [...threadKeys, ...threads.map((t) => t.logical_thread)], me.id),
    // What the threads' agents said of them (src/agentlabels.js), in place of Clef's answers.
    agentLabelsFor(env.DB, threadKeys),
    // The personal view's first page: the viewer's regulars and the customers they have been
    // active with lately, for the order of its customer column (src/standing.js).
    personal && !only && !before ? customerStanding(env.DB, me.id) : null,
  ]);
  const by = (rows, f) => {
    const m = new Map();
    for (const r of rows || []) {
      if (!m.has(r.thread)) {
        m.set(r.thread, []);
      }
      m.get(r.thread).push(f(r));
    }
    return m;
  };
  const rxBy = by(rx, (r) => ({ emoji: r.emoji, count: r.n }));
  const techBy = by(techRows, (r) => r.tech);
  const postersBy = by(posted, (r) => r.person);
  const namedBy = by(named, (r) => ({ person: r.person, staff: Boolean(r.staff) }));
  const labelBy = new Map((labels || []).map(({ topics, ...l }) => [
    l.thread, {
      ...applyAgentLabels(l, agentLabels.filter((r) => r.thread === l.thread)),
      topics: topicList(topics),
    },
  ]));
  // The viewer's teams.
  // Adobe, partner or customer (the UI tells vendors by their org); emails stay here.
  const myTeams = {};
  for (const r of teamRows || []) {
    myTeams[r.team] = myTeams[r.team] || { name: r.name, members: [] };
    myTeams[r.team].members.push(r.person);
  }
  // Profile cards of everyone in the avatar stacks, once per person.
  const cards = await profiles(env, [...people.values()]
    .flatMap((t) => t.participants.map((p) => p.key)));
  const states = readState(threads, marks || [], mentions || [], me.id, yours);
  const linkedBy = await linkedP;
  const botBy = await botRepliesP;
  return {
    team: personal ? null : team,
    personal,
    page,
    ...(personal ? { rooms: await roomsP } : {}),
    me: { id: me.id, name: me.name, readonly: Boolean(me.readonly) },
    profiles: cards,
    people: Object.fromEntries((names || [])
      .map((p) => [p.id, {
        name: p.name, staff: Boolean(p.staff), relation: relationOf(env, p, partners),
      }])),
    teams: myTeams,
    members: teamMembers,
    vocab: techVocab,
    stacks,
    ...(elsewhere ? { elsewhere } : {}),
    ...(standing ? { standing } : {}),
    // Channel ids Slack sent without the name, in titles and last texts, as the names.
    threads: await nameChannelIds(env, fold(states
      .map((t) => {
        const label = labelBy.get(t.thread) || null;
        return {
          ...t,
          ...orgFields(orgs, t.org),
          title: (label && label.title) || t.title,
          label,
          ...(people.get(t.thread)
            || { participants: [], staffPosted: false, customerDomain: null }),
          reactions: rxBy.get(t.thread) || [],
          tech: techBy.get(t.thread) || [],
          posters: postersBy.get(t.thread) || [],
          mentioned: namedBy.get(t.thread) || [],
          resolutionFacts: resolved.get(t.thread),
          signals: signals.get(t.thread) || [],
          ...(botBy.get(t.thread) ? { bot_reply: botBy.get(t.thread) } : {}),
        };
      })).map(({ resolutionFacts: facts, ...t }) => {
      const g = sizes.get(t.thread);
      // A staff ✅ on the root overrides Clef's `resolved_p` (see resolve.js).
      const entry = { ...t, resolution: resolution(facts, t.label, me.id) };
      // Totals over the whole group, not just the members loaded here.
      const sized = g && g.n > 1 ? { ...entry, occurrences: g.n, messages: g.total } : entry;
      const draft = draftSummary(draftOf(drafts, [t.thread, ...t.members.map((m) => m.thread)]));
      // A sidebar is kept under the entry's key when it was talked in: a member's, before a fold.
      const sideNew = [...new Set([t.thread, ...t.members.map((m) => m.thread)])]
        .flatMap((k) => unseen.get(k) || []);
      const linked = linkedOf(linkedBy, [t.thread, ...t.members.map((m) => m.thread)]);
      return {
        ...sized,
        waiting_on: waitingOn(sized),
        draft,
        ...(sideNew.length ? { sideNew } : {}),
        ...(linked ? { linked } : {}),
      };
    })),
  };
}

/**
 * Search over team `team`'s inbox, or with `personal` (and no team) the viewer's personal view
 * (src/search.js): the entries about `q` the viewer sees, as the inbox shapes them, and `hits`,
 * best first, saying why each matched and which message did; and `kb`, the concepts about it
 * in the knowledge bases of the team (the personal view: of the viewer's teams) and of the
 * customers it owns, that the viewer may read (src/kbsearch.js). Nobody on a team sees none.
 */
export async function searchInbox(env, me, team, q, { limit, personal = false, org = null } = {}) {
  const n = Math.max(1, Math.min(MAX_RESULTS, Number(limit) || 30));
  // One customer's (`org`): its own threads and its partners' threads about it
  // (src/threadlinks.js `aboutThreads`); more are asked for, as the filter leaves some out.
  const customer = org ? String(org).trim().toLowerCase() : null;
  // One vector of the query for the threads and the knowledge bases.
  const query = cleanQuery(q);
  const vector = terms(query).length ? queryVector(env, query) : Promise.resolve(null);
  // The personal view's channels are filed under the teams of its rooms; its knowledge bases
  // are those of the viewer's own teams.
  const kbTeams = personal ? (me.teams || []).map((t) => t.slug) : [team];
  const kbP = findKnowledge(env, me, kbTeams, query, { vector }).catch((e) => {
    console.log(JSON.stringify({ route: 'search', error: `knowledge search failed: ${e.message}` }));
    return [];
  });
  const teams = personal ? await roomsOf(env, me) : [team];
  const [found, kb] = await Promise.all([
    teams.length ? find(env, teams, query, { limit: customer ? MAX_RESULTS : n, vector })
      : { q: query, words: [], hits: [] },
    kbP,
  ]);
  if (customer && found.hits.length) {
    const theirs = await aboutThreads(env, customer, found.hits.map((h) => h.thread));
    found.hits = found.hits.filter((h) => theirs.has(h.thread));
  }
  if (!found.hits.length) {
    return {
      team: personal ? null : team,
      personal,
      q: found.q,
      words: terms(query),
      hits: [],
      threads: [],
      kb,
      page: { next: null },
    };
  }
  const data = await inbox(env, me, team, {
    personal, groups: found.hits.map((h) => h.thread),
  });
  const shown = new Set(data.threads.map((t) => t.thread));
  const hits = found.hits.filter((h) => shown.has(h.thread)).slice(0, n);
  const kept = new Set(hits.map((h) => h.thread));
  return {
    ...data,
    q: found.q,
    words: found.words,
    threads: data.threads.filter((t) => kept.has(t.thread)),
    hits: await withSnippets(env, hits, found.words),
    kb,
  };
}

/**
 * How the viewer may edit a message: `'app'` (they posted it as the opspile app), `'user'`
 * (they posted it, on a platform that lets people edit through its API), or null.
 */
export function editableAs(meta, mine, asApp) {
  if (meta.deletedAt || !meta.author || meta.author.kind === 'system') {
    return null;
  }
  if (asApp.has(`${meta.thread}|${meta.id}`)) {
    return 'app';
  }
  return mine && meta.author.kind === 'person' && meta.source !== 'discord' ? 'user' : null;
}

/**
 * How many members of a group a thread view reads the messages of: the latest by activity,
 * with the group's first and the asked one. Every member is a folder, a listing and a read at
 * least, and an invocation may make 10,000 calls; an alert channel folds thousands of posts
 * into one entry, which then answered 500. The others are counted in `earlier_posts`.
 */
export const MAX_READ_MEMBERS = 500;

/** The members of `group` (in `root_at` order) whose messages are read, in the same order. */
export function readMembers(group, keep = [], most = MAX_READ_MEMBERS) {
  if (group.length <= most) {
    return group;
  }
  const kept = new Set(keep.filter(Boolean).slice(0, most));
  const latest = [...group]
    .sort((a, b) => String(b.any_at || b.root_at).localeCompare(String(a.any_at || a.root_at)));
  for (const m of latest) {
    if (kept.size >= most) {
      break;
    }
    kept.add(m.thread);
  }
  return group.filter((m) => kept.has(m.thread));
}

/**
 * The technologies an inbox entry shows, likeliest first, as `[{ tech, p }]`: each member's
 * (`labels.tech`, the highest of any member).
 */
export function threadTech(labels) {
  const best = new Map();
  const add = (id, p) => {
    if (!(best.get(id) >= p)) {
      best.set(id, p);
    }
  };
  for (const l of (labels || []).filter((x) => x.tech != null)) {
    let parsed = null;
    try {
      parsed = JSON.parse(l.tech);
    } catch {
      parsed = null;
    }
    for (const [id, p] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) {
      if (typeof p === 'number') {
        add(id, p);
      }
    }
  }
  return [...best].map(([tech, p]) => ({ tech, p })).sort((a, b) => b.p - a.p);
}

/**
 * One inbox entry: the thread, or the group of re-threaded threads it stands for, with
 * every member's messages in order. Each message carries its platform `thread`. A member's
 * key opens its group (a root that is folded later was opened, linked or kept in a tab under
 * its own key): `thread.thread` is the entry's key.
 */
export async function thread(env, me, asked, wanted = null, { waitUntil = null } = {}) {
  // The thread's group: the thread itself, or the group it was re-threaded into, with every
  // member, in one round trip.
  const { results: memberRows } = await env.DB.prepare(`SELECT * FROM threads
    WHERE thread = (SELECT COALESCE(logical_thread, thread) FROM threads WHERE thread = ?1)
      OR logical_thread = (SELECT COALESCE(logical_thread, thread) FROM threads WHERE thread = ?1)
    ORDER BY root_at`).bind(asked).all();
  const rows = memberRows || [];
  const own = rows.find((m) => m.thread === asked);
  // A group whose first thread is gone (not expected) shows the asked thread on its own.
  const anchor = own && rows.find((m) => m.thread === (own.logical_thread || asked));
  const key = anchor ? anchor.thread : asked;
  const row = anchor || own;
  // Every team whose inbox has it: the one it is filed under, and those its channel is shared
  // with. Read state is the team's the viewer looks at it from (`wanted`, if it is one).
  const teams = row ? await teamsOf(env, row) : [];
  // Who may work it may see it, and so may admins and whoever talked in its sidebar (maySee),
  // who only read it and talk to its agent.
  const work = Boolean(row) && await mayWork(env, me)(teams, row);
  if (!row || !(work || await maySee(env, me)(teams, row))) {
    return null;
  }
  // In the customer portal, a person's own follow lets them see and work it, not post in it.
  const posts = work && (row.source !== 'portal' || await mayPost(env, me)(teams, row));
  const readers = viewTeam(me, teams, wanted);
  const group = anchor ? rows : [own];
  const keys = JSON.stringify(group.map((m) => m.thread));
  // The members whose messages are shown: all of them, but for a very large group.
  const read = readMembers(group, [key, asked]);
  const readSet = new Set(read.map((m) => m.thread));
  const readKeys = read.length === group.length ? keys : JSON.stringify(read.map((m) => m.thread));
  // The latest member's label speaks for the group.
  const labelKey = latestMember(group).thread;
  const entryKeys = [key, ...group.map((m) => m.thread)];
  // Everything below depends only on the group: ask D1 and R2 at once, not one by one
  // (opening a thread waited for some fifteen round trips in a row).
  const [
    link, files, { results: idx }, { results: rx }, { results: marks }, model, facts,
    anchorLabel, { results: found }, drafts, rowOrgs, { results: appPosts }, agentOn,
    { results: memberTech }, { results: rootLinks }, place, bashRequests, sidebar, toolRequests,
    agentLabels,
  ] = await Promise.all([
    // The first thread's root, else its first message, else (all of it deleted) the group's.
    env.DB.prepare(`SELECT permalink FROM messages
      WHERE thread IN (SELECT value FROM json_each(?1)) AND deleted = 0 AND permalink IS NOT NULL
      ORDER BY (thread = ?2 AND id = ?3) DESC, (thread = ?2) DESC, at LIMIT 1`)
      .bind(keys, key, row.root_id).first(),
    Promise.all(read.map((m) => folderFiles(env.CHANNELS, m.path, { waitUntil })))
      .then((lists) => lists.flat()),
    env.DB.prepare(`SELECT m.thread, m.id, m.source || ':' || m.tenant
        || ':' || m.channel_id || ':' || m.id AS mkey, COALESCE(i.display_avatar, i.avatar) AS avatar,
        m.author_key, m.person = ? AS mine, i.kind AS account_kind, i.ours, i.display_name,
        i.staff AS account_staff, i.email AS account_email, i.name AS account_name, i.linked_at,
        ap.staff AS account_person_staff, ap.name AS account_person_name
      FROM messages m ${identityJoin} LEFT JOIN people ap ON ap.id = i.person
      WHERE m.thread IN (SELECT value FROM json_each(?))`)
      .bind(me.id, readKeys).all(),
    env.DB.prepare(`SELECT r.message, r.emoji, r.user_key,
        COALESCE(p.name, i.name) AS name, i.person = ? AS mine
      FROM reactions r
      LEFT JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +r.user_key
      LEFT JOIN people p ON p.id = i.person
      WHERE r.thread IN (SELECT value FROM json_each(?)) ORDER BY r.at`).bind(me.id, readKeys).all(),
    env.DB.prepare(`SELECT w.person, w.thread, w.read_at, w.via
      FROM watermarks w JOIN team_members m ON m.person = w.person AND m.team = ?
      WHERE w.thread IN (SELECT value FROM json_each(?))`).bind(readers, keys).all(),
    env.DB.prepare('SELECT * FROM labels WHERE thread = ?').bind(labelKey).first(),
    resolutionFacts(env, group.map((m) => m.thread)),
    env.DB.prepare('SELECT title FROM labels WHERE thread = ?').bind(key).first(),
    env.DB.prepare(`SELECT DISTINCT source, field, value, confidence
      FROM facts WHERE thread IN (SELECT value FROM json_each(?)) ORDER BY field, value`)
      .bind(keys).all(),
    draftsFor(env, entryKeys),
    orgsOf(env, [row.org]),
    // What the viewer posted as the opspile app: theirs to edit, as the app.
    env.DB.prepare(`SELECT thread, id FROM app_posts
      WHERE thread IN (SELECT value FROM json_each(?)) AND person = ?`).bind(keys, me.id).all(),
    // The agent's latest finished turn (src/agent/kept.js), where the channel has an agent, as
    // GET /api/agent decides: the inbox shows it with the messages.
    row.kind === 'channel' ? Promise.all([keptTurn(env, key), agentEnabled(env, row.channel_id, row.team)])
      .then(([turn, on]) => ({ on, turn: on ? turn : null })) : null,
    // The technologies each member shows (labels.tech), for the header's tech stack.
    env.DB.prepare(`SELECT thread, tech FROM labels
      WHERE thread IN (SELECT value FROM json_each(?))`).bind(keys).all(),
    // Each folded post's link on the platform, its root's: the header lists them.
    group.length > 1 ? env.DB.prepare(`SELECT t.thread, m.permalink FROM threads t
      JOIN messages m ON m.source = t.source AND m.tenant = t.tenant
        AND m.channel_id = t.channel_id AND m.id = t.root_id
      WHERE t.thread IN (SELECT value FROM json_each(?)) AND m.deleted = 0
        AND m.permalink IS NOT NULL`).bind(readKeys).all() : { results: [] },
    // The Teams team (or Discord server) the channel is in: a Teams team's channels are
    // mostly called Main or General, so the header names the team too.
    env.DB.prepare(`SELECT group_name FROM channels
      WHERE source = ? AND tenant = ? AND channel_id = ?`)
      .bind(row.source, row.tenant, row.channel_id).first(),
    // The commands the agent asked a person to run (src/bashrequests.js): waiting, running,
    // or ended within the hour.
    requestsFor(env, entryKeys),
    // What the team said to the agent in the inbox's sidebar, and its answers (src/sidebar.js):
    // shown between the messages, folded; never on the platform.
    sidebarFor(env, entryKeys),
    // The tools the agent asked for in the sidebar, and how each stands (src/toolrequests.js).
    toolRequestsFor(env, entryKeys),
    // What the agent said of the thread (src/agentlabels.js), in place of Clef's answers.
    agentLabelsFor(env.DB, [labelKey]),
  ]);
  const rootLink = new Map((rootLinks || []).map((r) => [r.thread, r.permalink]));
  const asApp = new Set((appPosts || []).map((p) => `${p.thread}|${p.id}`));
  row.permalink = link ? link.permalink : null;
  const byId = new Map((idx || []).map((m) => [`${m.thread}|${m.id}`, m]));
  const reactionsBy = new Map();
  for (const r of rx || []) {
    const list = reactionsBy.get(r.message) || [];
    let e = list.find((x) => x.emoji === r.emoji);
    if (!e) {
      e = {
        emoji: r.emoji, count: 0, names: [], mine: false,
      };
      list.push(e);
    }
    e.count += 1;
    e.mine = e.mine || Boolean(r.mine);
    if (r.name) {
      e.names.push(r.name);
    }
    reactionsBy.set(r.message, list);
  }
  const messages = files.filter(Boolean)
    .map(({ meta, body }) => {
      const m = byId.get(`${meta.thread}|${meta.id}`) || {};
      return {
        ...meta,
        author: accountAuthor(env, meta.author, m),
        body,
        avatar: m.avatar || null,
        authorKey: m.author_key || null,
        // Posted by the viewer: the UI shows their own messages apart from colleagues'.
        mine: Boolean(m.mine),
        // Whether, and as whom, the viewer may edit it (src/edit.js).
        editable: editableAs(meta, Boolean(m.mine), asApp),
        reactions: reactionsBy.get(m.mkey) || [],
      };
    })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const label = applyAgentLabels(model, agentLabels);
  const bodies = messages.filter((m) => !m.deletedAt).map((m) => m.body);
  // Slack permalinks the messages name, in this thread's workspace. Profiles wait for the
  // authors those links add; the mention and channel lookups run alongside the link lookup.
  const linksP = slackMessageLinks(env, me, bodies, row.tenant);
  // Who the people the messages mention are: Adobe, a partner or the customer, and their
  // accounts, whose cards the mentions show.
  const mentionedP = mentionedPeople(env, {
    source: row.source, tenant: row.tenant, threads: group.map((m) => m.thread),
  }, bodies);
  const [cards, named, channels, links, channelLinked, stacks, joined] = await Promise.all([
    Promise.all([linksP, mentionedP]).then(([linked, { keys: mentionKeys }]) => profiles(env, [
      ...messages.map((m) => m.authorKey),
      ...linked.map((l) => l.authorKey),
      ...Object.values(mentionKeys),
    ])),
    mentionedP,
    // The channels the messages name (`#name`, `#C…`): their names, and where they are.
    channelRefs(env, row, [...bodies, row.title, anchorLabel && anchorLabel.title,
      label && label.title], me),
    linksP,
    // Links to channels, on any platform (a Teams channel's in a Slack message).
    channelLinks(env, row, bodies, me),
    // The customer's stack drawing's parts (src/orgstacks.js): the header's button to the
    // drawing shows where there is one.
    orgStacksOf(env, [row.org]),
    // The customers it is about, the partners in it, and the threads possibly about the same
    // issue in theirs (src/threadlinks.js): those the viewer may not see without their words.
    entryLinks(env, [...new Set(entryKeys)], (k) => canSee(env, me, k)),
  ]);
  return {
    thread: {
      ...row,
      teams,
      ...orgFields(rowOrgs, row.org),
      title: (anchorLabel && anchorLabel.title) || (label && label.title) || row.title,
      channel_group: (place && place.group_name) || null,
      label_thread: labelKey,
    },
    // The channel's, from before the customer's stack came from its drawing: none now.
    tech: [],
    thread_tech: threadTech(memberTech),
    stack: stacks[row.org] || [],
    topics: topicList(model && model.topics),
    vocab: await vocab(env, row.team),
    members: group.map((m) => ({
      thread: m.thread,
      root_at: m.root_at,
      last_at: m.last_at,
      any_at: m.any_at,
      logical_via: m.logical_via,
      ...(group.length > 1
        ? { title: m.title || null, permalink: rootLink.get(m.thread) || null } : {}),
      // Its messages are not read (MAX_READ_MEMBERS): the page says where posts are missing.
      ...(readSet.has(m.thread) ? {} : { left_out: true }),
    })),
    messages,
    // How many members are `left_out`: the least recent posts.
    earlier_posts: group.length - read.length,
    profiles: cards,
    mentioned: named.kinds,
    mention_keys: named.keys,
    channels,
    channel_links: channelLinked,
    links,
    linked: { about: joined.about, with: joined.with },
    related: joined.related,
    watermarks: marks || [],
    label,
    model,
    facts: found || [],
    resolution: resolution(mergeFacts([...facts.values()]), label, me.id),
    draft: draftOf(drafts, entryKeys),
    agent_turn: (agentOn && agentOn.turn) || null,
    // Whether the thread has an agent, which the sidebar talks to.
    agent: Boolean(agentOn && agentOn.on),
    // Whether the viewer may work it (`mayWork`): reply, draft, and decide on the commands and
    // tools its agent asks for. Not so, they only see it, and talk to its agent (`maySee`).
    can_work: work,
    // Whether they may reply in it as themselves (`mayReply`): not in the portal by a follow.
    can_post: posts,
    sidebar,
    tool_requests: toolRequests,
    bash_requests: bashRequests,
  };
}

/**
 * GET /api/translate: the messages of thread `asked`'s inbox entry (every member's that the
 * thread view reads, not deleted, not the platform's notices) in language `to`
 * (src/translate.js), each by `<thread>|<id>` as `{ text, for }`: `text` null where it is in that
 * language already, `for` the version it is of (its edit, else its time), so the page shows no
 * translation of a text that changed since. The viewer may see the thread (the caller checks).
 */
export async function translation(env, asked, to, { waitUntil = null } = {}) {
  const target = targetOf(to);
  if (!target) {
    return json({ error: '`to` is a language, as en or de-CH' }, 400);
  }
  const { results } = await env.DB.prepare(`SELECT thread, logical_thread, path, root_at, any_at
    FROM threads
    WHERE thread = (SELECT COALESCE(logical_thread, thread) FROM threads WHERE thread = ?1)
      OR logical_thread = (SELECT COALESCE(logical_thread, thread) FROM threads WHERE thread = ?1)
    ORDER BY root_at`).bind(asked).all();
  const group = results || [];
  const own = group.find((m) => m.thread === asked);
  if (!own) {
    return json({ error: 'not found' }, 404);
  }
  const read = readMembers(group, [own.logical_thread || asked, asked]);
  const files = (await Promise.all(read.map((m) => folderFiles(env.CHANNELS, m.path, {
    waitUntil,
  })))).flat().filter((f) => f && f.meta && !f.meta.deletedAt && f.meta.author?.kind !== 'system')
    .sort((a, b) => String(a.meta.at).localeCompare(String(b.meta.at)));
  const version = new Map(files.map(({ meta }) => [`${meta.thread}|${meta.id}`,
    meta.editedAt || meta.at || null]));
  const done = await translateMessages(env, files.map(({ meta, body }) => ({
    key: `${meta.thread}|${meta.id}`, body, from: meta.author?.name || null,
  })), target);
  return json({
    ...done,
    messages: Object.fromEntries(Object.entries(done.messages)
      .map(([k, said]) => [k, { text: said, for: version.get(k) }])),
  });
}

const MEDIA_MAX = 10 * 1024 * 1024;
const mediaHeaders = (type) => ({
  'content-type': type,
  'cache-control': 'private, max-age=86400',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'",
});
const DISCORD_MEDIA = /^(cdn\.discordapp\.com|media\.discordapp\.net)$/;

/**
 * Images from messages, fetched with the platform's credentials: Slack files need the bot
 * token, Teams inline images (hostedContents) a Graph token, and Discord attachment links
 * expire (the bot token refreshes them). Only those kinds of URL are fetched, and only
 * images are passed on. With the message's thread (`t`), Teams images come from the copies
 * in pile 1 when there are some.
 */
export async function media(env, target, threadKey = null) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return json({ error: 'bad url' }, 400);
  }
  // A file of the customer portal, of the thread's channel: through the portal's Worker.
  if (threadKey && portalFileOf(threadKey, u.href)) {
    const got = await openPortalFile(env, threadKey, u.href, { max: MEDIA_MAX });
    if (got.error || !/^image\/(png|jpeg|gif|webp)$/.test(got.type)) {
      await got.body?.cancel();
      return json({ error: got.error || 'cannot show this attachment (not an image)' }, 502);
    }
    return new Response(got.body, { headers: mediaHeaders(got.type) });
  }
  // Teams files opspile copied into pile 1 (src/teamsfiles.js) come from there. SharePoint
  // files only ever do: the app could read any of them, the inbox shows those of messages.
  const kept = threadKey && await keptTeamsFile(env, threadKey, u.href);
  if (kept) {
    const type = (kept.httpMetadata && kept.httpMetadata.contentType) || '';
    if (!type.startsWith('image/')) {
      return json({ error: 'cannot show this attachment (not an image)' }, 502);
    }
    return new Response(kept.body, { headers: mediaHeaders(type) });
  }
  let res;
  if (isSharePointUrl(u.href)) {
    return json({ error: 'the inbox has no copy of this file' }, 404);
  }
  if (u.protocol === 'https:' && u.hostname === 'files.slack.com') {
    res = await fetch(u, { headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
  } else if (u.protocol === 'https:' && DISCORD_MEDIA.test(u.hostname)
    && u.pathname.startsWith('/attachments/') && env.DISCORD_BOT_TOKEN) {
    // Discord signs attachment links for a day (`ex` is when, in hex seconds): an older
    // link is refreshed with the bot token first.
    const expires = parseInt(u.searchParams.get('ex') || '0', 16) * 1000;
    res = await fetch(expires > Date.now() + 60000 ? u.toString()
      : await refreshAttachment(env, u.toString()));
  } else if (u.protocol === 'https:' && u.hostname === 'graph.microsoft.com'
    && /^\/v1\.0\/(teams|chats)\/.+\/hostedContents\/[^/]+\/\$value$/.test(u.pathname)) {
    const graph = await cachedGraph(env);
    res = await graph(u.toString());
  } else {
    return json({ error: 'not a message attachment' }, 400);
  }
  const type = res.headers.get('content-type') || '';
  const length = Number(res.headers.get('content-length') || 0);
  if (!res.ok || !type.startsWith('image/') || length > MEDIA_MAX) {
    return json({ error: `cannot show this attachment (${res.status})` }, 502);
  }
  return new Response(res.body, { headers: mediaHeaders(type) });
}

function room(env, team) {
  return env.ROOMS.get(env.ROOMS.idFromName(team));
}

/** `/api/*` with the viewer known; see `api`. */
async function route(request, env, url, {
  viewer: injected, waitUntil, inboxTools = null,
} = {}, timing = null) {
  // A customer's favicon (src/favicons.js), which the inbox shows on many rows at once. It is
  // Google's, no one's secret: someone Access signed in is enough, without looking them up.
  if (url.pathname === '/api/favicon' && (request.method === 'GET' || request.method === 'HEAD')) {
    if (!injected && !await accessEmail(request, env)) {
      return json({ error: 'not signed in' }, 403);
    }
    return faviconProxy(url.searchParams.get('domain'), { request, waitUntil });
  }
  // `viewer` can be injected by tests; in the Worker it always comes from Access.
  const me = injected || await viewer(request, env);
  timing?.mark('auth');
  if (!me) {
    return json({ error: 'not signed in, or not a member of any team' }, 403);
  }
  const team = url.searchParams.get('team');
  // Who may work a thread (src/shares.js): reply, react, resolve, draft; and who may see it and
  // talk to its agent in its sidebar: admins too, and whoever talked in its sidebar before.
  const working = mayWork(env, me);
  const seeing = maySee(env, me);

  if (url.pathname === '/api/me') {
    // The header's Stats link (src/klickhaus.js), only where it is theirs.
    const stats = statsFor(env, me);
    return json({
      ...me,
      ...(stats ? { stats } : {}),
      // Their face in the header.
      avatar: await personAvatar(env, me),
      connected: me.readonly ? {} : await connections(env, me.id),
      react: me.readonly ? {} : await reactable(env, me.id),
      // Whose tokens may edit their own messages (src/edit.js).
      edit: me.readonly ? {} : await editable(env, me.id),
      // What a reply may carry (src/attach.js): as the person, by connected platform, and as
      // the opspile app, by platform.
      attach: me.readonly ? {} : {
        ...await attachable(env, me.id),
        app: Object.fromEntries(['slack', 'teams', 'discord', 'portal'].map((p) => [p, appRule(p)])),
      },
      // Accounts that can be connected besides Slack and Microsoft (Discord needs its app).
      connectable: { discord: Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) },
      // Notifications (src/settings.js); someone else's are not shown to whoever views as them.
      settings: me.readonly ? DEFAULTS : await readSettings(env, me),
      // The rooms the inbox listens to (GET /api/live): the person's teams, and the teams of
      // the threads in their personal view.
      rooms: await roomsOf(env, me),
      // What they follow and mute, and what their teams follow (src/following.js).
      follows: await followsOf(env, me),
      // The questions thread agents asked them that wait (src/questions.js): on Inbox.
      questions: await openQuestions(env, me.email),
    });
  }
  // What waits for them, on Inbox in every page's header (src/waiting.js).
  if (url.pathname === '/api/waiting' && request.method === 'GET') {
    return json(await waitingFor(env, me));
  }
  // Looking as someone else is read-only: no reads, replies or connections.
  const writes = request.method !== 'GET' || /^\/api\/auth\//.test(url.pathname);
  if (me.readonly && writes) {
    return json({ error: 'read-only while viewing as someone else' }, 403);
  }
  if (url.pathname === '/api/settings') {
    if (request.method === 'GET') {
      return json(me.readonly ? DEFAULTS : await readSettings(env, me));
    }
    if (request.method === 'PUT') {
      return saveSettings(env, me, await request.json().catch(() => null));
    }
    return json({ error: 'GET or PUT' }, 405);
  }
  // The Topics page's trends (src/trends.js), for every internal user, as the map.
  if (url.pathname.startsWith('/api/topics/trends')) {
    if (!internal(env, me)) {
      return json({ error: 'trends are for Adobe\'s people' }, 403);
    }
    return trendsApi(env, me, request, url);
  }
  // What the Topics page's panel says of a technology or a product (src/techinfo.js): its
  // catalog entries, knowledge, extraction rules, followers and customers, read as the viewer may.
  if (url.pathname === '/api/topics/tech') {
    if (!internal(env, me)) {
      return json({ error: 'the topic map is for Adobe\'s people' }, 403);
    }
    if (request.method !== 'GET') {
      return json({ error: 'GET' }, 405);
    }
    return json(await techInfo(env, me, {
      tech: url.searchParams.getAll('tech'), name: url.searchParams.get('name'),
    }));
  }
  // The Topics page, for every internal user (src/topicsapi.js).
  if (url.pathname === '/api/topics') {
    // Every team's topics, customers and people: for every internal user, on an ops team or
    // not, to find what to follow; not for someone signed in from SIGNIN_DOMAINS who is not
    // Adobe's. Changing areas and rebuilding the map stay the admin team's and managers'.
    if (!internal(env, me)) {
      return json({ error: 'the topic map is for Adobe\'s people' }, 403);
    }
    if (request.method === 'GET') {
      return topicsPage(env, me, await followsOf(env, me));
    }
    if (request.method === 'POST') {
      return me.readonly ? json({ error: 'read-only while viewing as someone else' }, 403)
        : rebuildTopics(env, me);
    }
    return json({ error: 'GET or POST' }, 405);
  }
  // Every team's overview, its first section in Teams (src/teamprofile.js): for every internal
  // user, as the Topics page; what changes a team stays its managers' and the admin team's.
  if (['/api/teams', '/api/teams/profile', '/api/teams/vendors'].includes(url.pathname)) {
    if (!internal(env, me)) {
      return json({ error: 'the teams are for Adobe\'s people' }, 403);
    }
    if (request.method !== 'GET') {
      return json({ error: 'GET' }, 405);
    }
    if (url.pathname === '/api/teams') {
      return json({ teams: await teamDirectory(env) });
    }
    // A team's vendors, its Vendors section (src/vendors.js).
    const profile = url.pathname === '/api/teams/vendors'
      ? await teamVendors(env, me, url.searchParams.get('team'))
      : await teamProfile(env, me, url.searchParams.get('team'));
    return profile.error ? json({ error: profile.error }, profile.status || 400) : json(profile);
  }
  // Every customer's overview, its first section in Customers (src/orgprofile.js): for every
  // internal user, as a team's; what changes a customer stays the ops teams' and the admin team's.
  if (url.pathname === '/api/customers' || url.pathname === '/api/customers/profile'
    || url.pathname === '/api/customers/partners') {
    if (!internal(env, me)) {
      return json({ error: 'the customers are for Adobe\'s people' }, 403);
    }
    if (request.method !== 'GET') {
      return json({ error: 'GET' }, 405);
    }
    if (url.pathname === '/api/customers') {
      return json({ orgs: await orgDirectory(env) });
    }
    // Its partners, or the customers it works for (src/orgpartners.js).
    const profile = url.pathname === '/api/customers/partners'
      ? await orgPartnerLinks(env, url.searchParams.get('org'))
      : await orgProfile(env, me, url.searchParams.get('org'));
    if (profile.error) {
      const { status, ...rest } = profile;
      return json(rest, status || 400);
    }
    return json(profile);
  }
  if (url.pathname === '/api/areas') {
    if (me.readonly) {
      return json({ error: 'read-only while viewing as someone else' }, 403);
    }
    return changeArea(env, me, request.method, await request.json().catch(() => ({})));
  }
  if (url.pathname === '/api/standing') {
    // The star and the mute of the personal view's customer column (src/standing.js): `{ org,
    // mark: unstar | mute }` sets it now, with `at` (null or the `was` it answered) undoes it.
    if (request.method !== 'POST') {
      return json({ error: 'POST' }, 405);
    }
    const res = await setMark(env.DB, me.id, await request.json().catch(() => ({})));
    if (res.error) {
      return json({ error: res.error }, res.status);
    }
    return json({ was: res.was, standing: await customerStanding(env.DB, me.id) });
  }
  if (url.pathname === '/api/follows/suggest') {
    // What to follow (src/followsuggest.js): for anyone signed in, on a team or not; names and
    // counts only. `q` searches every product, topic and customer by name.
    return request.method === 'GET' ? json(await suggestFollows(env, me, { q: url.searchParams.get('q') || '' }))
      : json({ error: 'GET' }, 405);
  }
  if (url.pathname === '/api/follows') {
    // What the person follows and mutes, and their teams (src/following.js); and every
    // technology one may follow.
    if (request.method === 'GET') {
      return json({ ...await followsOf(env, me), tech: await followable(env) });
    }
    if (request.method === 'PUT') {
      // `{ kind, target, follow, team? }` or `{ kind: 'org', target, mute }` (src/following.js).
      const body = await request.json().catch(() => ({}));
      // A thread, where they may work it (its entry, as its page has it).
      const mayFollowThread = async (key) => {
        const entry = await entryOf(env, key);
        return Boolean(entry) && working(entry.teams, entry);
      };
      const res = await changeFollow(env, me, body, { followOrg, mayFollowThread });
      if (res.error) {
        return json({ error: res.error }, res.status || 400);
      }
      return json({ ...await followsOf(env, me), changed: res.changed });
    }
    return json({ error: 'GET or PUT' }, 405);
  }
  if (url.pathname === '/api/people') {
    if (!(me.admin || (me.viewer))) {
      return json({ error: 'for the admin team' }, 403);
    }
    const { results } = await env.DB.prepare(`SELECT DISTINCT p.id, p.name FROM people p
      JOIN team_members m ON m.person = p.id ORDER BY p.name`).all();
    return json({ people: results || [] });
  }
  const auth = /^\/api\/auth\/(slack|teams|discord)(\/start|\/callback)?$/.exec(url.pathname);
  if (auth) {
    const [, platform, step] = auth;
    if (step === '/start') {
      return startAuth(env, me, platform, { files: url.searchParams.get('files') === '1' });
    }
    if (step === '/callback') {
      return finishAuth(env, me, platform, url);
    }
    if (request.method === 'DELETE') {
      return disconnect(env, me, platform);
    }
  }
  if ((url.pathname === '/api/post' || url.pathname === '/api/post/app')
    && request.method === 'POST') {
    // JSON, or multipart with files (src/attach.js).
    const read = await readPost(request);
    if (read.error) {
      return json({ error: read.error }, read.status);
    }
    const { body, files } = read;
    // A person's follow lets them reply where the platform decides who posts (Slack, Teams),
    // not in the customer portal or as the app (src/shares.js `mayPost`).
    const inMine = mayReply(env, me);
    const asApp = mayPost(env, me);
    // A retry of a reply that may have gone out does not post it again (src/postkeys.js).
    const how = url.pathname === '/api/post' ? 'me' : 'app';
    const started = Date.now();
    const again = await claimPost(env, me, body.key);
    if (again && !again.ok) {
      await logPost(me, body, files, again, { how, ms: Date.now() - started, again: true });
      return again;
    }
    // As the person, or as the opspile app (where it may post in the channel).
    let res = again;
    if (!res) {
      res = how === 'me'
        ? await post(env, me, body, inMine, files, { waitUntil })
        : await postApp(env, me, body, asApp, files);
      await settlePost(env, me, body.key, res);
    }
    await logPost(me, body, files, res, { how, ms: Date.now() - started, again: Boolean(again) });
    // Whom it mentions who may never see it: the page suggests a personal reminder, with the
    // post's links (src/reminders.js). The post went out: a failure here says nothing.
    if (res.ok && Array.isArray(body.mentions) && body.mentions.length) {
      const sent = await res.clone().json();
      const said = await mentionReminders(env, me, body, sent).catch((e) => {
        console.log(JSON.stringify({ route: 'post', action: 'reminders', error: e.message }));
        return { reminders: [] };
      });
      if (said.reminders.length) {
        res = json({ ...sent, ...said }, res.status);
      }
    }
    // A reply sent from the shared draft uses it up (unless a colleague changed it since).
    // The post went out: whatever happens here, the answer says so.
    if (res.ok && typeof body.draft === 'string') {
      const sent = { how, text: body.text };
      const used = { thread: body.thread, base: body.draft };
      const done = await discardDraft(env, me, used, inMine, { sent })
        .then((r) => r.json())
        .catch((e) => {
          console.log(JSON.stringify({ route: 'post', action: 'draft', error: e.message }));
          return null;
        });
      // The third of the agent's drafts sent in a channel: ask to let it post there itself.
      const offer = done && done.discarded
        && await postingOffer(env, me, body.thread, done.draft);
      if (offer) {
        return json({ ...await res.json(), postingOffer: offer }, res.status);
      }
    }
    return res;
  }
  if (url.pathname === '/api/draft/file' && request.method === 'GET') {
    return getDraftFile(env, url.searchParams.get('thread'), url.searchParams.get('id'), seeing);
  }
  if (url.pathname === '/api/draft/source' && request.method === 'GET') {
    return draftSource(env, url.searchParams.get('thread'), url.searchParams.get('url'), seeing, {
      own: url.hostname,
    });
  }
  if (url.pathname === '/api/draft') {
    if (request.method === 'GET') {
      return getDraft(env, url.searchParams.get('thread'), seeing);
    }
    const body = await request.json().catch(() => ({}));
    if (request.method === 'PUT') {
      return saveDraft(env, me, body, working);
    }
    if (request.method === 'DELETE') {
      const res = await discardDraft(env, me, body, working);
      if (res.ok) {
        // The agent hears who threw its draft away; the discard never fails because of it.
        const told = res.clone().json().then((r) => tellDiscarded(env, me, body.thread, r))
          .catch((e) => console.log(JSON.stringify({ route: 'draft', action: 'tell-agent', error: String(e) })));
        if (waitUntil) {
          waitUntil(told);
        } else {
          await told;
        }
      }
      return res;
    }
  }
  if (url.pathname === '/api/agent' && request.method === 'GET') {
    return agentStatus(env, url.searchParams.get('thread'), seeing);
  }
  if (url.pathname === '/api/agent/seed' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return seedAgent(env, me, body, working);
  }
  // The sidebar: a person talks to the thread's agent, never to the channel (src/sidebar.js).
  if (url.pathname === '/api/agent/sidebar' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return talkToAgent(env, me, body, seeing);
  }
  if (url.pathname === '/api/agent/sidebar/seen' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return sawSidebar(env, me, body, seeing);
  }
  // A tool the thread's agent asked for in its sidebar (src/agent/toolrequest.js).
  const tool = /^\/api\/agent\/tools\/(grant|deny|revoke)$/.exec(url.pathname);
  if (tool && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return decideTool(env, me, body, working, tool[1], { seeing });
  }
  // A command the thread's agent asked a person to run (src/agent/bashrequest.js), or a script
  // to run as themselves (src/agent/scriptrequest.js), with the inbox's tools `inboxTools` gives
  // (src/mcp.js, `inboxCall`; the Worker passes it, so that this file does not import them).
  const bash = /^\/api\/bash\/(run|deny)$/.exec(url.pathname);
  if (bash && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return decideBash(env, me, body, working, { run: bash[1] === 'run', seeing, inboxTools });
  }
  // Someone is writing a reply: the customer portal shows its customers (src/post.js).
  if (url.pathname === '/api/typing' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return typing(env, me, body, working);
  }
  if (url.pathname === '/api/edit' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return edit(env, me, body, working);
  }
  if (url.pathname === '/api/react' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return react(env, me, body, working);
  }
  // Not about that customer, not that partner's; not the same issue (src/threadlinks.js).
  const unlink = /^\/api\/thread\/(about|related)\/dismiss$/.exec(url.pathname);
  if (unlink && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const t = body.thread && await env.DB.prepare('SELECT thread, team, source, channel_id FROM threads WHERE thread = ?')
      .bind(String(body.thread)).first();
    if (!t || !await working(await teamsOf(env, t), t)) {
      return json({ error: 'not found' }, 404);
    }
    const res = unlink[1] === 'about' ? await dismissAbout(env, me, body) : await dismissLink(env, me, body);
    if (res.error) {
      return json({ error: res.error }, res.status || 400);
    }
    await notifyRoom(env, await teamsOf(env, t), { type: 'thread', thread: res.thread });
    return json(res);
  }
  if (url.pathname === '/api/resolve' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return resolve(env, me, body, working);
  }
  if (url.pathname === '/api/mentionable') {
    return mentionable(env, url.searchParams.get('thread'), url.searchParams.get('q'), working, {
      waitUntil, me, channel: url.searchParams.get('channel'), pool: url.searchParams.has('pool'),
    });
  }
  if (url.pathname === '/api/channels') {
    return postableChannels(env, me);
  }
  // Who someone on the thread is in its knowledge bases, for their profile card.
  if (url.pathname === '/api/person') {
    return personInKb(env, me, {
      thread: url.searchParams.get('thread'),
      key: url.searchParams.get('p'),
      name: url.searchParams.get('name'),
    }, seeing);
  }
  if (url.pathname === '/api/experts') {
    return experts(env, url.searchParams.get('thread'), seeing, {
      me, waitUntil, suggestedOnly: url.searchParams.has('suggested'),
    });
  }
  if (url.pathname === '/api/emoji') {
    const emoji = await rankEmoji(env, url.searchParams.get('q'), undefined, { waitUntil });
    const res = json({ emoji });
    // The same for everyone, for a while: the browser keeps a ranking (none: Clef failed).
    if (emoji.length) {
      res.headers.set('cache-control', 'private, max-age=86400');
    }
    return res;
  }
  if (url.pathname === '/api/emoji/custom') {
    const own = await workspaceEmoji(env);
    const res = json(own);
    if (own.complete) {
      res.headers.set('cache-control', 'private, max-age=600');
    }
    return res;
  }
  // A diagram drawn on the server (src/diagrams.js), for whoever reads the knowledge bases its
  // `.dot` files are in: every internal user (src/kbaccess.js `mayRead`).
  if (url.pathname === '/api/diagram' && request.method === 'POST') {
    if (!internal(env, me)) {
      return json({ error: 'for Adobe\'s people' }, 403);
    }
    return drawDiagram(env, await request.json().catch(() => ({})));
  }
  if (url.pathname === '/api/emoji/closest') {
    const names = (url.searchParams.get('names') || '').split(',');
    return json({ emoji: await closestEmoji(env, names) });
  }
  if (url.pathname === '/api/inbox' && url.searchParams.get('view') === 'personal') {
    return json(await inbox(env, me, null, {
      personal: true, before: url.searchParams.get('before'), limit: url.searchParams.get('limit'),
    }));
  }
  if (url.pathname === '/api/inbox') {
    if (!inTeam(me, team)) {
      return json({ error: 'not a member of this team' }, 403);
    }
    return json(await inbox(env, me, team, {
      before: url.searchParams.get('before'), limit: url.searchParams.get('limit'),
    }));
  }
  if (url.pathname === '/api/search' && url.searchParams.get('view') === 'personal') {
    return json(await searchInbox(env, me, null, url.searchParams.get('q'), {
      personal: true, limit: url.searchParams.get('limit'), org: url.searchParams.get('org'),
    }));
  }
  if (url.pathname === '/api/search') {
    if (!inTeam(me, team)) {
      return json({ error: 'not a member of this team' }, 403);
    }
    return json(await searchInbox(env, me, team, url.searchParams.get('q'), {
      limit: url.searchParams.get('limit'), org: url.searchParams.get('org'),
    }));
  }
  // The admin team's requests, threads of its inbox (src/requestthreads.js), and the questions
  // thread agents ask the viewer, threads of every inbox of theirs (`mine`: only those).
  if (url.pathname === '/api/requests' || url.pathname.startsWith('/api/requests/')) {
    if (url.pathname === '/api/requests' && request.method === 'GET') {
      return json(await requestEntries(env, me, { mine: url.searchParams.get('mine') === '1' }));
    }
    const body = await request.json().catch(() => ({}));
    if (url.pathname === '/api/requests/note' && request.method === 'POST') {
      return addNote(env, me, body);
    }
    if (url.pathname === '/api/requests/resolve' && request.method === 'POST') {
      return resolveRequest(env, me, body);
    }
    return json({ error: 'not found' }, 404);
  }
  if (url.pathname === '/api/thread' && isRequestKey(url.searchParams.get('thread'))) {
    // The admin team's, or a question to the viewer (findRequest decides).
    const result = await requestThread(env, me, url.searchParams.get('thread'));
    return result ? json(result) : json({ error: 'not found' }, 404);
  }
  if (url.pathname === '/api/thread') {
    const key = url.searchParams.get('thread');
    // Whether the viewer may send as the opspile app here (POST /api/post/app): asked
    // alongside the thread, not after it.
    const [result, app] = await Promise.all([
      thread(env, me, key, team, { waitUntil }),
      me.readonly || !isStaffDomain(env, me.email) ? null : appPostCheck(env, key),
    ]);
    if (!result) {
      return json({ error: 'not found' }, 404);
    }
    result.can_post_as_bot = Boolean(app && !app.problem
      && await mayPost(env, me)(result.thread.teams, result.thread));
    return json(result);
  }
  // The open thread in the reader's language, where Clef read another (src/translate.js). A GET,
  // as reading the thread: also while viewing as someone else.
  if (url.pathname === '/api/translate' && request.method === 'GET') {
    const key = url.searchParams.get('thread');
    if (!key || !await canSee(env, me, key)) {
      return json({ error: 'not found' }, 404);
    }
    return translation(env, key, url.searchParams.get('to'), { waitUntil });
  }
  if (url.pathname === '/api/media') {
    // A thread's files (the copies of Teams files) only for those who may see the thread.
    const t = url.searchParams.get('t');
    if (t && !await canSee(env, me, t)) {
      return json({ error: 'not found' }, 404);
    }
    return media(env, url.searchParams.get('u'), t);
  }
  // A Teams app's icon, its bot's picture (src/bots.js): for anyone signed in to the inbox.
  if (url.pathname === '/api/bots/icon' && request.method === 'GET') {
    return teamsBotIcon(env, url).catch((e) => {
      console.warn(JSON.stringify({ route: 'bots', icon: 'failed', error: e.message }));
      return json({ error: 'no icon' }, 404);
    });
  }
  // What the customer portal keeps and the inbox shows: a picture someone uploaded there, a
  // customer's logo (src/portalsource.js). For anyone signed in to the inbox.
  const kept = /^\/api\/portal\/(avatar|logo)\/([a-z0-9.-]{1,120})$/.exec(url.pathname);
  if (kept && request.method === 'GET') {
    const res = await portalFetch(env, kept[1], kept[1] === 'avatar' ? { user: kept[2] } : { domain: kept[2] });
    const type = res && res.ok ? (res.headers.get('content-type') || '') : '';
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) {
      await res?.body?.cancel();
      return json({ error: 'no picture' }, 404);
    }
    return new Response(res.body, { headers: mediaHeaders(type) });
  }
  if (['/api/file', '/api/file/stream', '/api/file/poster', '/api/file/open'].includes(url.pathname)) {
    // A file of a message (the inbox's CSV and text previews, its video and audio player):
    // for those who may see its thread, and only a file a message of the thread links to
    // (src/fileview.js).
    const t = url.searchParams.get('t');
    if (!t || !await canSee(env, me, t)) {
      return json({ error: 'not found' }, 404);
    }
    const u = url.searchParams.get('u');
    if (url.pathname === '/api/file/stream') {
      return streamFile(env, t, u, request);
    }
    if (url.pathname === '/api/file/open') {
      return openThreadFile(env, t, u);
    }
    return url.pathname === '/api/file/poster' ? filePoster(env, t, u) : threadFile(env, t, u);
  }
  // The admin pages: the admin team, and team managers for their teams (the
  // routes check which); a few routes for every member of an ops team (STAFF_ROUTES).
  if (url.pathname.startsWith('/api/admin/')) {
    const adminRoute = `${request.method} ${url.pathname.slice('/api/admin/'.length)}`;
    if (!isManager(me) && !(STAFF_ROUTES.includes(adminRoute) && (me.teams || []).length)) {
      return json({ error: 'for the admin team and team managers' }, 403);
    }
    return (await admin(request, env, url, me)) || json({ error: 'not found' }, 404);
  }
  if (url.pathname === '/api/kb' || url.pathname.startsWith('/api/kb/')) {
    // The members of a team look at its knowledge base and agents; changing them is for the
    // admin team and team managers (and src/kbadmin.js checks whose). Its files are everyone's
    // on the team, and its agent's sidebar whoever's who looks (src/kbaccess.js `mayWrite`).
    const open = ['/api/kb/file', '/api/kb/chat', '/api/kb/chat/bash'].includes(url.pathname);
    if (request.method !== 'GET' && !open && !isManager(me)) {
      return json({ error: 'changing the agents is for the admin team and team managers' }, 403);
    }
    return (await kbAdmin(request, env, url, me)) || json({ error: 'not found' }, 404);
  }
  if (url.pathname === '/api/rank/pick' && request.method === 'POST') {
    const res = await recordPick(env, me, await request.json().catch(() => null));
    return res.error ? json(res, 400) : new Response(null, { status: 204 });
  }
  if (url.pathname === '/api/experts/event' && request.method === 'POST') {
    const res = await recordExpertEvent(env, me, await request.json().catch(() => null));
    return res.error ? json(res, 400) : new Response(null, { status: 204 });
  }
  if (url.pathname === '/api/experts/events') {
    if (!isAdmin(me)) {
      return json({ error: 'for the admin team' }, 403);
    }
    return json(await expertEvents(env, url.searchParams.get('since'), url.searchParams.get('limit')));
  }
  if (url.pathname === '/api/rank/events') {
    if (!isAdmin(me)) {
      return json({ error: 'for the admin team' }, 403);
    }
    return json(await rankEvents(env, url.searchParams.get('since'), url.searchParams.get('limit')));
  }
  if (url.pathname === '/api/read' && request.method === 'POST') {
    const { thread: key, at, team: from } = await request.json().catch(() => ({}));
    // A request's thread is read in the admin team's inbox, and its room has it; a question's,
    // in the room of its thread's team.
    if (isRequestKey(key)) {
      const where = typeof at === 'string' ? await readRoom(env, me, key) : null;
      if (!where) {
        return json({ error: 'not found' }, 404);
      }
      await room(env, where).fetch('https://room/read', {
        method: 'POST',
        body: JSON.stringify({ person: me.id, thread: key, at }),
      });
      return new Response(null, { status: 204 });
    }
    const row = key && await env.DB.prepare('SELECT thread, team, source, channel_id FROM threads WHERE thread = ?')
      .bind(key).first();
    const teams = await teamsOf(env, row);
    if (!row || typeof at !== 'string' || !await working(teams, row)) {
      return json({ error: 'not found' }, 404);
    }
    // The room of the inbox it was read in, which fans it out there.
    await room(env, viewTeam(me, teams, from)).fetch('https://room/read', {
      method: 'POST',
      body: JSON.stringify({ person: me.id, thread: key, at }),
    });
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/api/live') {
    // A team's room, or the room of a team whose channels are in the personal view, which
    // tells only about those (`scoped`, src/room.js).
    const member = inTeam(me, team);
    const scoped = !member && Boolean(team) && (await roomsOf(env, me)).includes(team);
    if (!(member || scoped) || request.headers.get('upgrade') !== 'websocket') {
      return text('expected a websocket for one of your teams\n', 400);
    }
    const headers = new Headers(request.headers);
    headers.set('x-opspile-person', String(me.id));
    headers.set('x-opspile-readonly', me.readonly ? '1' : '0');
    headers.set('x-opspile-scoped', scoped ? '1' : '0');
    return room(env, team).fetch(new Request('https://room/connect', { headers }));
  }
  return json({ error: 'not found' }, 404);
}

/** The seconds a 503 for an overloaded D1 asks a client to wait (`Retry-After`). */
export const BUSY_RETRY_AFTER = 2;

/**
 * Routes `/api/*`. Returns null for paths it does not own. Every answer says where its time
 * went (`Server-Timing`: who is asking, D1, R2, total; durations and counts only). The reads it
 * asks D1 for at once go as one batch (src/d1batch.js), each batch one D1 call there.
 *
 * When D1 turns a request's queries away because the database is overloaded (a few seconds at a
 * time, src/d1batch.js), the answer is 503 with `Retry-After`, not the Worker's 500: nothing is
 * wrong with the request, and the pages ask a read again once (ui/app.js).
 */
export async function api(request, env, url, options = {}) {
  if (!url.pathname.startsWith('/api/')) {
    return null;
  }
  const timing = new Timing();
  // One D1 session for the request: a read runs at the nearest copy of the database, as new as
  // the bookmark the page sent; what writes starts at the primary (src/d1session.js).
  const session = env && sessionDatabase(env.DB, constraintFor(request));
  const timed = timing.wrap(session ? { ...env, DB: session } : env);
  const batched = timed && timed.DB ? { ...timed, DB: batchedDatabase(timed.DB) } : timed;
  let response;
  try {
    response = await route(request, batched, url, options, timing);
  } catch (e) {
    if (!overloaded(e)) {
      throw e;
    }
    console.log(JSON.stringify({
      level: 'warn', route: 'api', path: url.pathname, overloaded: true,
    }));
    response = json({ error: 'The inbox is busy: try again in a moment.', busy: true }, 503);
    response.headers.set('retry-after', String(BUSY_RETRY_AFTER));
  }
  return withTiming(withBookmark(response, bookmarkOf(session)), timing);
}
