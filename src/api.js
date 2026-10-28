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
import { admin } from './admin.js';
import { kbAdmin } from './kbadmin.js';
import { agentStatus, seedAgent, tellDiscarded } from './agent/stub.js';
import {
  discardDraft, draftOf, draftsFor, draftSummary, getDraft, saveDraft,
} from './drafts.js';
import { refreshAttachment } from './discord.js';
import { edit } from './edit.js';
import { cachedGraph } from './graph.js';
import {
  connections, disconnect, editable, finishAuth, mentionable, post, reactable, startAuth,
} from './post.js';
import { appPostCheck, postApp } from './postapp.js';
import { isStaffDomain } from './lookup.js';
import { react, resolve } from './react.js';
import {
  mergeFacts, resolution, resolutionFacts, signalFacts,
} from './resolve.js';
import { folderFiles } from './filecache.js';
import { mentionKinds, profiles, relationOf } from './profiles.js';
import { json, text } from './http.js';
import {
  ANSWERS, effectiveLabel, isAdmin, isManager, reviewQueue, reviewsFor, reviewStats, submitReview,
} from './review.js';
import {
  memberOf, sharedWith, teamsOf, viewTeam,
} from './shares.js';
import { DEFAULTS, readSettings, saveSettings } from './settings.js';
import { ATTENTION, readState, waitingOn } from './threads.js';
import { find, MAX_RESULTS, withSnippets } from './search.js';
import { Timing, withTiming } from './timing.js';

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
      by.set(r.thread, { people: [], domains: new Map() });
    }
    const t = by.get(r.thread);
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
    customerDomain: [...t.domains].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
  }]));
}

/**
 * A person with their teams, by `id` or `email`, in one round trip (every API call asks this
 * first), or null.
 */
async function personWhere(env, column, value) {
  const { results } = await env.DB.prepare(`SELECT p.id, p.name, p.email, t.slug, t.name AS team,
      m.role
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
    teams,
    admin: teams.some((t) => t.slug === 'admin'),
    // Teams whose members and knowledge base this person manages (see migration 0018).
    manages: teams.filter((t) => t.role === 'manager').map((t) => t.slug),
  };
}

/**
 * The signed-in person, from the verified Access email. An admin may look at the inbox as
 * someone else (`x-opspile-as: <person id>`): reads only, never their read state or a reply.
 */
/** A person by id, with their teams (an MCP client's token names the person). */
export async function personById(env, id) {
  return personWhere(env, 'id', id);
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
const orgFields = (orgs, slug) => {
  const o = orgs.get(slug);
  return { org_name: (o && o.name) || null, org_icon: (o && o.icon) || null, org_type: (o && o.type) || 'customer' };
};

/** A person by email, with their teams, or null. */
export async function personByEmail(env, email) {
  return personWhere(env, 'email', email);
}

export async function viewer(request, env, options) {
  const email = await accessEmail(request, env, options);
  if (!email) {
    return null;
  }
  const me = await personWhere(env, 'email', email);
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

/** Whether the viewer is in a team, or in one of a list of them (a shared channel's). */
const inTeam = (me, teams) => memberOf(me)(teams);

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
 * team's inbox has its own channels and the channels shared with it. The personal view has
 * the conversations of all the viewer's teams in the channels they posted or were mentioned
 * in (`me`: the parameter bound to their id); alerts are not in it.
 */
function inInbox(alias, personal, me) {
  if (!personal) {
    return `(${alias}.team = ?1 OR ${sharedWith(alias, '?1')})`;
  }
  const teams = '(SELECT value FROM json_each(?1))';
  return `(${alias}.team IN ${teams} OR (${alias}.source, ${alias}.channel_id) IN (
      SELECT source, channel_id FROM channel_teams WHERE team IN ${teams}))
    AND ${alias}.kind != 'alert'
    AND (${alias}.source, ${alias}.channel_id) IN (
      SELECT source, channel_id FROM messages WHERE person = ${me}
      UNION SELECT c.source, c.channel_id FROM mentions n JOIN threads c ON c.thread = n.thread
        WHERE n.person = ${me})`;
}

const rank = (a) => (a ? ATTENTION.indexOf(a) : ATTENTION.length);
const max = (xs) => xs.filter(Boolean).sort().pop() || null;

/**
 * Folds re-threaded threads into one entry per group (keyed by the group's first
 * thread). The entry keeps the first thread's title and link, the latest activity and
 * label of any member, the most pressing attention, and the list of members.
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
    const latest = [...ms].sort((a, b) => String(b.any_at).localeCompare(String(a.any_at)))[0];
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
      last_at: max(ms.map((m) => m.last_at)),
      any_at: max(ms.map((m) => m.any_at)),
      last_author: latest.last_author,
      last_staff: latest.last_staff,
      messages: ms.reduce((n, m) => n + (m.messages || 0), 0),
      participants: people,
      label: latest.label || anchor.label || null,
      attention: [...ms].sort((a, b) => rank(a.attention) - rank(b.attention))[0].attention,
      unread: ms.some((m) => m.unread),
      unseen: ms.every((m) => m.unseen),
      unseenByAdobe: ms.some((m) => m.unseenByAdobe),
      seenByOthers: ms.some((m) => m.seenByOthers),
      mentionedMe: ms.some((m) => m.mentionedMe),
      unreadMentions: ms.reduce((n, m) => n + (m.unreadMentions || 0), 0),
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
  // Settled either way, so a failure elsewhere does not leave these rejections unhandled.
  teamRowsP.catch(() => {});
  membersP.catch(() => {});
  // The latest groups (a re-threaded group counts once), then for each group its first
  // thread (title, link) and its five most recent members (activity, read state).
  const { results: groups } = await env.DB.prepare(`SELECT COALESCE(logical_thread, thread) AS g,
      COUNT(*) AS n, SUM(messages) AS total, MAX(COALESCE(last_at, any_at)) AS latest
    -- The team's own channels, and the channels shared with it (migration 0024).
    FROM threads WHERE ${inInbox('threads', personal, '?5')} AND kind != 'ignore'
      -- Threads of nothing but system events ("has joined the channel", a member was added)
      -- are not shown: no person posted, and no message has an author account (bots do).
      AND NOT (kind = 'channel' AND last_at IS NULL AND NOT EXISTS (SELECT 1 FROM messages m
        WHERE m.thread = threads.thread AND m.author_key IS NOT NULL AND m.deleted = 0))
      ${only ? 'AND COALESCE(logical_thread, thread) IN (SELECT value FROM json_each(?6))' : ''}
    GROUP BY g
    HAVING ?2 IS NULL OR latest < ?2 OR (latest = ?2 AND g < ?3)
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
  const { results: threads } = await env.DB.prepare(`SELECT thread, source, org, team, kind,
      channel_name, title, root_at, last_at, last_author, last_staff, any_at, messages,
      root_at IS NOT NULL AS root_known, logical_thread,
      (SELECT m.permalink FROM messages m WHERE m.thread = r.thread AND m.deleted = 0
        AND m.permalink IS NOT NULL ORDER BY (m.id = r.root_id) DESC, m.at LIMIT 1)
        AS permalink
    FROM (SELECT t.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(t.logical_thread, t.thread)
          ORDER BY COALESCE(t.last_at, t.any_at) DESC) AS rn
        FROM threads t
        WHERE ${inInbox('t', personal, '?3')} AND t.kind != 'ignore'
          AND COALESCE(t.logical_thread, t.thread) IN (SELECT value FROM json_each(?2))) r
    WHERE r.rn <= 5 OR r.thread IN (SELECT value FROM json_each(?2))`)
    .bind(...[scope.value, groupKeys, personal ? me.id : []].flat()).all();
  const sizes = new Map((groups || []).map((g) => [g.g, g]));
  if (!threads.length) {
    return {
      team: personal ? null : team, personal, members: await membersP, threads: [], page,
    };
  }
  const threadKeys = threads.map((t) => t.thread);
  const keys = JSON.stringify(threadKeys);
  const [
    { results: marks }, { results: mentions }, { results: labels }, people, { results: rx },
    { results: posted }, { results: named }, resolved, signals, reviews, { results: names },
    drafts, { results: teamRows }, teamMembers, orgs, { results: partnerRows },
  ] = await Promise.all([
    // Watermarks of every staff member (for "nobody at Adobe has seen it") and of the team
    // (the personal view: of the viewer's teams).
    env.DB.prepare(`SELECT w.person, w.thread, w.read_at, p.staff, EXISTS (
          SELECT 1 FROM team_members m WHERE m.person = w.person AND ${scope.in('m.team')})
          AS in_team
      FROM watermarks w JOIN people p ON p.id = w.person
      WHERE w.thread IN (SELECT value FROM json_each(?))
        AND (p.staff = 1 OR EXISTS (
          SELECT 1 FROM team_members m WHERE m.person = w.person AND ${scope.in('m.team')}))`)
      .bind(scope.value, keys, scope.value).all(),
    env.DB.prepare(`SELECT DISTINCT n.thread, n.message, n.person, n.at
      FROM mentions n JOIN team_members m ON m.person = n.person AND ${scope.in('m.team')}
      -- A mention's message is in the mention's thread: the thread narrows the search.
      JOIN messages x ON x.thread = n.thread
        AND x.source || ':' || x.tenant || ':' || x.channel_id || ':' || x.id = +n.message
      WHERE n.thread IN (SELECT value FROM json_each(?)) AND x.deleted = 0`)
      .bind(scope.value, keys).all(),
    env.DB.prepare(`SELECT thread, next_actor, next_actor_p,
        kind AS label_kind, kind_p, urgency, resolved_p, labeled_through, title FROM labels
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
    // Reviews of any of the threads; only those of labelled ones are used.
    reviewsFor(env.DB, threadKeys),
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
    env.DB.prepare('SELECT domain, name FROM partner_domains').all(),
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
  const postersBy = by(posted, (r) => r.person);
  const namedBy = by(named, (r) => ({ person: r.person, staff: Boolean(r.staff) }));
  const labelBy = new Map((labels || []).map((l) => [
    l.thread, effectiveLabel(l, reviews.filter((r) => r.thread === l.thread)),
  ]));
  // The viewer's teams.
  // Adobe, partner or customer (the UI tells vendors by their org); emails stay here.
  const partners = new Map((partnerRows || [])
    .map((r) => [String(r.domain).toLowerCase(), r.name]));
  const myTeams = {};
  for (const r of teamRows || []) {
    myTeams[r.team] = myTeams[r.team] || { name: r.name, members: [] };
    myTeams[r.team].members.push(r.person);
  }
  // Profile cards of everyone in the avatar stacks, once per person.
  const cards = await profiles(env, [...people.values()]
    .flatMap((t) => t.participants.map((p) => p.key)));
  return {
    team: personal ? null : team,
    personal,
    page,
    me: { id: me.id, name: me.name, readonly: Boolean(me.readonly) },
    profiles: cards,
    people: Object.fromEntries((names || [])
      .map((p) => [p.id, {
        name: p.name, staff: Boolean(p.staff), relation: relationOf(env, p, partners),
      }])),
    teams: myTeams,
    members: teamMembers,
    threads: fold(readState(threads, marks || [], mentions || [], me.id)
      .map((t) => {
        const label = labelBy.get(t.thread) || null;
        return {
          ...t,
          ...orgFields(orgs, t.org),
          title: (label && label.title) || t.title,
          label,
          ...(people.get(t.thread) || { participants: [], customerDomain: null }),
          reactions: rxBy.get(t.thread) || [],
          posters: postersBy.get(t.thread) || [],
          mentioned: namedBy.get(t.thread) || [],
          resolutionFacts: resolved.get(t.thread),
          signals: signals.get(t.thread) || [],
        };
      })).map(({ resolutionFacts: facts, ...t }) => {
      const g = sizes.get(t.thread);
      // A staff ✅ on the root overrides Clef's `resolved_p` (see resolve.js).
      const entry = { ...t, resolution: resolution(facts, t.label, me.id) };
      // Totals over the whole group, not just the members loaded here.
      const sized = g && g.n > 1 ? { ...entry, occurrences: g.n, messages: g.total } : entry;
      const draft = draftSummary(draftOf(drafts, [t.thread, ...t.members.map((m) => m.thread)]));
      return { ...sized, waiting_on: waitingOn(sized), draft };
    }),
  };
}

/**
 * Search over team `team`'s inbox, or with `personal` (and no team) the viewer's personal view
 * (src/search.js): the entries about `q` the viewer sees, as the inbox shapes them, and `hits`,
 * best first, saying why each matched and which message did.
 */
export async function searchInbox(env, me, team, q, { limit, personal = false } = {}) {
  const n = Math.max(1, Math.min(MAX_RESULTS, Number(limit) || 30));
  const teams = personal ? (me.teams || []).map((t) => t.slug) : [team];
  const found = await find(env, teams, q, { limit: n });
  if (!found.hits.length) {
    return {
      team: personal ? null : team,
      personal,
      q: found.q,
      words: found.words,
      hits: [],
      threads: [],
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
 * One inbox entry: the thread, or the group of re-threaded threads it stands for, with
 * every member's messages in order. Each message carries its platform `thread`. A member's
 * key opens its group (a root that is folded later was opened, linked or kept in a tab under
 * its own key): `thread.thread` is the entry's key.
 */
export async function thread(env, me, asked, wanted = null) {
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
  if (!row || !(inTeam(me, teams) || isAdmin(me))) {
    return null;
  }
  const readers = viewTeam(me, teams, wanted);
  const group = anchor ? rows : [own];
  const keys = JSON.stringify(group.map((m) => m.thread));
  // The latest member's label speaks for the group.
  const labelKey = [...group]
    .sort((a, b) => String(b.any_at).localeCompare(String(a.any_at)))[0].thread;
  const entryKeys = [key, ...group.map((m) => m.thread)];
  // Everything below depends only on the group: ask D1 and R2 at once, not one by one
  // (opening a thread waited for some fifteen round trips in a row).
  const [
    link, files, { results: idx }, { results: rx }, { results: marks }, model, reviews,
    reviewed, facts, anchorLabel, { results: tech }, { results: found }, drafts, rowOrgs,
    { results: appPosts },
  ] = await Promise.all([
    env.DB.prepare(`SELECT permalink FROM messages WHERE thread = ? AND deleted = 0
      AND permalink IS NOT NULL ORDER BY (id = ?) DESC, at LIMIT 1`).bind(key, row.root_id).first(),
    Promise.all(group.map((m) => folderFiles(env.CHANNELS, m.path))).then((lists) => lists.flat()),
    env.DB.prepare(`SELECT m.thread, m.id, m.source || ':' || m.tenant
        || ':' || m.channel_id || ':' || m.id AS mkey, i.avatar, m.author_key, m.person = ? AS mine
      FROM messages m ${identityJoin} WHERE m.thread IN (SELECT value FROM json_each(?))`)
      .bind(me.id, keys).all(),
    env.DB.prepare(`SELECT r.message, r.emoji, r.user_key,
        COALESCE(p.name, i.name) AS name, i.person = ? AS mine
      FROM reactions r
      LEFT JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +r.user_key
      LEFT JOIN people p ON p.id = i.person
      WHERE r.thread IN (SELECT value FROM json_each(?)) ORDER BY r.at`).bind(me.id, keys).all(),
    env.DB.prepare(`SELECT w.person, w.thread, w.read_at, w.via
      FROM watermarks w JOIN team_members m ON m.person = w.person AND m.team = ?
      WHERE w.thread IN (SELECT value FROM json_each(?))`).bind(readers, keys).all(),
    env.DB.prepare('SELECT * FROM labels WHERE thread = ?').bind(labelKey).first(),
    isAdmin(me) ? env.DB.prepare(`SELECT r.question, r.model_value, r.value,
        r.agrees, r.labeled_through, r.note, r.created_at, p.name AS reviewer
      FROM label_reviews r JOIN people p ON p.id = r.reviewer
      WHERE r.thread = ? ORDER BY r.created_at DESC`).bind(labelKey).all()
      .then((r) => r.results || []) : [],
    reviewsFor(env.DB, [labelKey]),
    resolutionFacts(env, group.map((m) => m.thread)),
    env.DB.prepare('SELECT title FROM labels WHERE thread = ?').bind(key).first(),
    env.DB.prepare(`SELECT tech, p FROM channel_tech
      WHERE source = ? AND tenant = ? AND channel_id = ? ORDER BY p DESC`)
      .bind(row.source, row.tenant, row.channel_id).all(),
    env.DB.prepare(`SELECT DISTINCT source, field, value, confidence
      FROM facts WHERE thread IN (SELECT value FROM json_each(?)) ORDER BY field, value`)
      .bind(keys).all(),
    draftsFor(env, entryKeys),
    orgsOf(env, [row.org]),
    // What the viewer posted as the opspile app: theirs to edit, as the app.
    env.DB.prepare(`SELECT thread, id FROM app_posts
      WHERE thread IN (SELECT value FROM json_each(?)) AND person = ?`).bind(keys, me.id).all(),
  ]);
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
  const label = effectiveLabel(model, model ? reviewed : []);
  const [cards, mentioned] = await Promise.all([
    profiles(env, messages.map((m) => m.authorKey)),
    // Who the people the messages mention are: Adobe, a partner or the customer.
    mentionKinds(env, {
      source: row.source, tenant: row.tenant, threads: group.map((m) => m.thread),
    }, messages.filter((m) => !m.deletedAt).map((m) => m.body)),
  ]);
  return {
    thread: {
      ...row,
      teams,
      ...orgFields(rowOrgs, row.org),
      title: (anchorLabel && anchorLabel.title) || (label && label.title) || row.title,
      label_thread: labelKey,
    },
    tech: tech || [],
    members: group.map((m) => ({
      thread: m.thread,
      root_at: m.root_at,
      last_at: m.last_at,
      any_at: m.any_at,
      logical_via: m.logical_via,
    })),
    messages,
    profiles: cards,
    mentioned,
    watermarks: marks || [],
    label,
    model,
    reviews,
    facts: found || [],
    resolution: resolution(mergeFacts([...facts.values()]), label, me.id),
    draft: draftOf(drafts, entryKeys),
  };
}

const MEDIA_MAX = 10 * 1024 * 1024;
const DISCORD_MEDIA = /^(cdn\.discordapp\.com|media\.discordapp\.net)$/;

/**
 * Images from messages, fetched with the platform's credentials: Slack files need the bot
 * token, Teams inline images (hostedContents) a Graph token, and Discord attachment links
 * expire (the bot token refreshes them). Only those kinds of URL are fetched, and only
 * images are passed on.
 */
export async function media(env, target) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return json({ error: 'bad url' }, 400);
  }
  let res;
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
  return new Response(res.body, {
    headers: {
      'content-type': type,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
}

function room(env, team) {
  return env.ROOMS.get(env.ROOMS.idFromName(team));
}

/** `/api/*` with the viewer known; see `api`. */
async function route(request, env, url, { viewer: injected, waitUntil } = {}, timing = null) {
  // `viewer` can be injected by tests; in the Worker it always comes from Access.
  const me = injected || await viewer(request, env);
  timing?.mark('auth');
  if (!me) {
    return json({ error: 'not signed in, or not a member of any team' }, 403);
  }
  const team = url.searchParams.get('team');

  if (url.pathname === '/api/me') {
    return json({
      ...me,
      connected: me.readonly ? {} : await connections(env, me.id),
      react: me.readonly ? {} : await reactable(env, me.id),
      // Whose tokens may edit their own messages (src/edit.js).
      edit: me.readonly ? {} : await editable(env, me.id),
      // Accounts that can be connected besides Slack and Microsoft (Discord needs its app).
      connectable: { discord: Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) },
      // Notifications (src/settings.js); someone else's are not shown to whoever views as them.
      settings: me.readonly ? DEFAULTS : await readSettings(env, me),
    });
  }
  // Looking as someone else is read-only: no reads, replies, reviews or connections.
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
      return startAuth(env, me, platform);
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
    const body = await request.json().catch(() => ({}));
    const inMine = (t) => inTeam(me, t);
    // As the person, or as the opspile app (where it may post in the channel).
    const res = url.pathname === '/api/post'
      ? await post(env, me, body, inMine) : await postApp(env, me, body, inMine);
    // A reply sent from the shared draft uses it up (unless a colleague changed it since).
    if (res.ok && typeof body.draft === 'string') {
      await discardDraft(env, me, { thread: body.thread, base: body.draft }, inMine);
    }
    return res;
  }
  if (url.pathname === '/api/draft') {
    if (request.method === 'GET') {
      return getDraft(env, url.searchParams.get('thread'), (t) => inTeam(me, t) || isAdmin(me));
    }
    const body = await request.json().catch(() => ({}));
    if (request.method === 'PUT') {
      return saveDraft(env, me, body, (t) => inTeam(me, t));
    }
    if (request.method === 'DELETE') {
      const res = await discardDraft(env, me, body, (t) => inTeam(me, t));
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
    return agentStatus(env, url.searchParams.get('thread'), (t) => inTeam(me, t) || isAdmin(me));
  }
  if (url.pathname === '/api/agent/seed' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return seedAgent(env, me, body, (t) => inTeam(me, t));
  }
  if (url.pathname === '/api/edit' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return edit(env, me, body, (t) => inTeam(me, t));
  }
  if (url.pathname === '/api/react' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return react(env, me, body, (t) => inTeam(me, t));
  }
  if (url.pathname === '/api/resolve' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return resolve(env, me, body, (t) => inTeam(me, t));
  }
  if (url.pathname === '/api/mentionable') {
    return mentionable(env, url.searchParams.get('thread'), url.searchParams.get('q'), (t) => inTeam(me, t), {
      waitUntil,
    });
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
      personal: true, limit: url.searchParams.get('limit'),
    }));
  }
  if (url.pathname === '/api/search') {
    if (!inTeam(me, team)) {
      return json({ error: 'not a member of this team' }, 403);
    }
    return json(await searchInbox(env, me, team, url.searchParams.get('q'), {
      limit: url.searchParams.get('limit'),
    }));
  }
  if (url.pathname === '/api/thread') {
    const key = url.searchParams.get('thread');
    // Whether the viewer may send as the opspile app here (POST /api/post/app): asked
    // alongside the thread, not after it.
    const [result, app] = await Promise.all([
      thread(env, me, key, team),
      me.readonly || !isStaffDomain(env, me.email) ? null : appPostCheck(env, key),
    ]);
    if (!result) {
      return json({ error: 'not found' }, 404);
    }
    result.can_post_as_bot = Boolean(app && !app.problem && inTeam(me, result.thread.teams));
    return json(result);
  }
  if (url.pathname === '/api/media') {
    return media(env, url.searchParams.get('u'));
  }
  // The admin pages and the editor: the admin team, and team managers for their teams (the
  // routes check which).
  if (url.pathname.startsWith('/api/admin/')) {
    if (!isManager(me)) {
      return json({ error: 'for the admin team and team managers' }, 403);
    }
    return (await admin(request, env, url, me)) || json({ error: 'not found' }, 404);
  }
  if (url.pathname === '/api/kb' || url.pathname.startsWith('/api/kb/')) {
    if (!isManager(me)) {
      return json({ error: 'the knowledge-base editor is for the admin team and team managers' }, 403);
    }
    return (await kbAdmin(request, env, url, me)) || json({ error: 'not found' }, 404);
  }
  if (url.pathname.startsWith('/api/review')) {
    if (!isAdmin(me)) {
      return json({ error: 'label review is for the admin team' }, 403);
    }
    if (url.pathname === '/api/review/queue') {
      return json({ answers: ANSWERS, queue: await reviewQueue(env.DB) });
    }
    if (url.pathname === '/api/review/stats') {
      return json({ stats: await reviewStats(env.DB) });
    }
    if (url.pathname === '/api/review' && request.method === 'POST') {
      const result = await submitReview(env.DB, me, await request.json().catch(() => ({})));
      return json(result, result.error ? 400 : 200);
    }
    return json({ error: 'not found' }, 404);
  }
  if (url.pathname === '/api/read' && request.method === 'POST') {
    const { thread: key, at, team: from } = await request.json().catch(() => ({}));
    const row = key && await env.DB.prepare('SELECT team, source, channel_id FROM threads WHERE thread = ?')
      .bind(key).first();
    const teams = await teamsOf(env, row);
    if (!row || !inTeam(me, teams) || typeof at !== 'string') {
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
    if (!inTeam(me, team) || request.headers.get('upgrade') !== 'websocket') {
      return text('expected a websocket for one of your teams\n', 400);
    }
    const headers = new Headers(request.headers);
    headers.set('x-opspile-person', String(me.id));
    headers.set('x-opspile-readonly', me.readonly ? '1' : '0');
    return room(env, team).fetch(new Request('https://room/connect', { headers }));
  }
  return json({ error: 'not found' }, 404);
}

/**
 * Routes `/api/*`. Returns null for paths it does not own. Every answer says where its time
 * went (`Server-Timing`: who is asking, D1, R2, total; durations and counts only).
 */
export async function api(request, env, url, options = {}) {
  if (!url.pathname.startsWith('/api/')) {
    return null;
  }
  const timing = new Timing();
  return withTiming(await route(request, timing.wrap(env), url, options, timing), timing);
}
