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
import { agentStatus, seedAgent } from './agent/stub.js';
import {
  discardDraft, draftOf, draftsFor, draftSummary, getDraft, saveDraft,
} from './drafts.js';
import { cachedGraph } from './graph.js';
import {
  connections, disconnect, finishAuth, mentionable, post, reactable, startAuth,
} from './post.js';
import { react, resolve } from './react.js';
import {
  mergeFacts, resolution, resolutionFacts, signalFacts,
} from './resolve.js';
import { parse } from './channels.js';
import { profiles } from './profiles.js';
import { json, text } from './http.js';
import {
  ANSWERS, effectiveLabel, isAdmin, isManager, reviewQueue, reviewsFor, reviewStats, submitReview,
} from './review.js';
import { ATTENTION, readState, waitingOn } from './threads.js';

/**
 * The inbox API behind Cloudflare Access. Every request is tied to a person in D1 by the
 * verified Access email, and sees only the threads of the teams that person is in.
 */

const INBOX_LIMIT = 200;
const MAX_PARTICIPANTS = 5;

const identityJoin = "LEFT JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = m.author_key";
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

async function personWithTeams(env, person) {
  const { results } = await env.DB.prepare(`SELECT t.slug, t.name, m.role FROM team_members m
    JOIN teams t ON t.slug = m.team WHERE m.person = ? ORDER BY t.slug`).bind(person.id).all();
  const teams = results || [];
  return {
    ...person,
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
  const person = await env.DB.prepare('SELECT id, name, email FROM people WHERE id = ?')
    .bind(id).first();
  return person ? personWithTeams(env, person) : null;
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
  const person = await env.DB.prepare('SELECT id, name, email FROM people WHERE email = ?')
    .bind(email).first();
  return person ? personWithTeams(env, person) : null;
}

export async function viewer(request, env, options) {
  const email = await accessEmail(request, env, options);
  if (!email) {
    return null;
  }
  const person = await env.DB.prepare('SELECT id, name, email FROM people WHERE email = ?')
    .bind(email).first();
  if (!person) {
    return null;
  }
  const me = await personWithTeams(env, person);
  const as = Number(request.headers.get('x-opspile-as') || new URL(request.url).searchParams.get('as'));
  if (me.admin && as && as !== me.id) {
    const other = await env.DB.prepare('SELECT id, name, email FROM people WHERE id = ?').bind(as).first();
    if (other) {
      const them = await personWithTeams(env, other);
      return { ...them, viewer: { id: me.id, name: me.name }, readonly: true };
    }
  }
  return me;
}

const inTeam = (me, team) => me.teams.some((t) => t.slug === team);

async function members(env, team) {
  const { results } = await env.DB.prepare(`SELECT p.id, p.name FROM team_members m
    JOIN people p ON p.id = m.person WHERE m.team = ? ORDER BY p.name`).bind(team).all();
  return results || [];
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

export async function inbox(env, me, team) {
  // The latest groups (a re-threaded group counts once), then for each group its first
  // thread (title, link) and its five most recent members (activity, read state).
  const { results: groups } = await env.DB.prepare(`SELECT COALESCE(logical_thread, thread) AS g,
      COUNT(*) AS n, SUM(messages) AS total, MAX(COALESCE(last_at, any_at)) AS latest
    FROM threads WHERE team = ? AND kind != 'ignore'
      -- Threads of nothing but system events ("has joined the channel", a member was added)
      -- are not shown: no person posted, and no message has an author account (bots do).
      AND NOT (kind = 'channel' AND last_at IS NULL AND NOT EXISTS (SELECT 1 FROM messages m
        WHERE m.thread = threads.thread AND m.author_key IS NOT NULL AND m.deleted = 0))
    GROUP BY g ORDER BY latest DESC LIMIT ?`).bind(team, INBOX_LIMIT).all();
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
        WHERE t.team = ? AND t.kind != 'ignore'
          AND COALESCE(t.logical_thread, t.thread) IN (SELECT value FROM json_each(?))) r
    WHERE r.rn <= 5 OR r.thread IN (SELECT value FROM json_each(?))`)
    .bind(team, groupKeys, groupKeys).all();
  const sizes = new Map((groups || []).map((g) => [g.g, g]));
  if (!threads.length) {
    return { team, members: await members(env, team), threads: [] };
  }
  const orgs = await orgsOf(env, threads.map((t) => t.org));
  const keys = JSON.stringify(threads.map((t) => t.thread));
  // Watermarks of every staff member (for "nobody at Adobe has seen it") and of the team.
  const { results: marks } = await env.DB.prepare(`SELECT w.person, w.thread, w.read_at,
      p.staff, EXISTS (SELECT 1 FROM team_members m WHERE m.person = w.person AND m.team = ?)
        AS in_team
    FROM watermarks w JOIN people p ON p.id = w.person
    WHERE w.thread IN (SELECT value FROM json_each(?))
      AND (p.staff = 1 OR EXISTS (
        SELECT 1 FROM team_members m WHERE m.person = w.person AND m.team = ?))`)
    .bind(team, keys, team).all();
  const { results: mentions } = await env.DB.prepare(`SELECT n.thread, n.person, n.at
    FROM mentions n JOIN team_members m ON m.person = n.person AND m.team = ?
    JOIN messages x ON x.source || ':' || x.tenant || ':' || x.channel_id || ':' || x.id = n.message
    WHERE n.thread IN (SELECT value FROM json_each(?)) AND x.deleted = 0`)
    .bind(team, keys).all();
  const { results: labels } = await env.DB.prepare(`SELECT thread, next_actor, next_actor_p,
      kind AS label_kind, kind_p, urgency, resolved_p, labeled_through, title FROM labels
    WHERE thread IN (SELECT value FROM json_each(?))`).bind(keys).all();
  const people = await participants(env, keys);
  const { results: rx } = await env.DB.prepare(`SELECT thread, emoji, COUNT(*) AS n FROM reactions
    WHERE thread IN (SELECT value FROM json_each(?)) GROUP BY thread, emoji`).bind(keys).all();
  const { results: posted } = await env.DB.prepare(`SELECT DISTINCT thread, person FROM messages
    WHERE thread IN (SELECT value FROM json_each(?)) AND person IS NOT NULL AND deleted = 0`)
    .bind(keys).all();
  const { results: named } = await env.DB.prepare(`SELECT DISTINCT n.thread, n.person, p.staff
    FROM mentions n JOIN people p ON p.id = n.person
    WHERE n.thread IN (SELECT value FROM json_each(?))`).bind(keys).all();
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
  const resolved = await resolutionFacts(env, threads.map((t) => t.thread));
  const signals = await signalFacts(env, threads.map((t) => t.thread));
  const reviews = await reviewsFor(env.DB, (labels || []).map((l) => l.thread));
  const labelBy = new Map((labels || []).map((l) => [
    l.thread, effectiveLabel(l, reviews.filter((r) => r.thread === l.thread)),
  ]));
  // Names of everyone posting or mentioned (for "involves"), and the viewer's teams.
  const ids = [...new Set([...(posted || []), ...(named || [])].map((r) => r.person))];
  const { results: names } = await env.DB.prepare(`SELECT id, name, staff FROM people
    WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all();
  const { results: teamRows } = await env.DB.prepare(`SELECT m.team, m.person, t.name FROM team_members m
    JOIN teams t ON t.slug = m.team
    WHERE m.team IN (SELECT team FROM team_members WHERE person = ?)`).bind(me.id).all();
  const myTeams = {};
  for (const r of teamRows || []) {
    myTeams[r.team] = myTeams[r.team] || { name: r.name, members: [] };
    myTeams[r.team].members.push(r.person);
  }
  // Shared drafts, on any member of an entry (an entry has at most one).
  const drafts = await draftsFor(env, [...threads.map((t) => t.thread),
    ...threads.map((t) => t.logical_thread).filter(Boolean)]);
  // Profile cards of everyone in the avatar stacks, once per person.
  const cards = await profiles(env, [...people.values()]
    .flatMap((t) => t.participants.map((p) => p.key)));
  return {
    team,
    me: { id: me.id, name: me.name, readonly: Boolean(me.readonly) },
    profiles: cards,
    people: Object.fromEntries((names || [])
      .map((p) => [p.id, { name: p.name, staff: Boolean(p.staff) }])),
    teams: myTeams,
    members: await members(env, team),
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
 * One inbox entry: the thread, or the group of re-threaded threads it stands for, with
 * every member's messages in order. Each message carries its platform `thread`.
 */
export async function thread(env, me, key) {
  const row = await env.DB.prepare('SELECT * FROM threads WHERE thread = ?').bind(key).first();
  if (!row || !(inTeam(me, row.team) || isAdmin(me))) {
    return null;
  }
  const { results: memberRows } = await env.DB.prepare(`SELECT * FROM threads
    WHERE thread = ? OR logical_thread = ? ORDER BY root_at`).bind(key, key).all();
  const group = memberRows && memberRows.length ? memberRows : [row];
  const keys = JSON.stringify(group.map((m) => m.thread));
  // The latest member's label speaks for the group.
  const labelKey = [...group]
    .sort((a, b) => String(b.any_at).localeCompare(String(a.any_at)))[0].thread;
  const entryKeys = [key, ...group.map((m) => m.thread)];
  // Everything below depends only on the group: ask D1 and R2 at once, not one by one
  // (opening a thread waited for some fifteen round trips in a row).
  const [
    link, files, { results: idx }, { results: rx }, { results: marks }, model, reviews,
    reviewed, facts, anchorLabel, { results: tech }, { results: found }, drafts,
  ] = await Promise.all([
    env.DB.prepare(`SELECT permalink FROM messages WHERE thread = ? AND deleted = 0
      AND permalink IS NOT NULL ORDER BY (id = ?) DESC, at LIMIT 1`).bind(key, row.root_id).first(),
    Promise.all(group.map(async (m) => {
      const listed = await env.CHANNELS.list({ prefix: m.path });
      return Promise.all(listed.objects.map(async (o) => {
        const obj = await env.CHANNELS.get(o.key);
        return obj ? parse(await obj.text()) : null;
      }));
    })).then((lists) => lists.flat()),
    env.DB.prepare(`SELECT m.thread, m.id, m.source || ':' || m.tenant
        || ':' || m.channel_id || ':' || m.id AS mkey, i.avatar, m.author_key
      FROM messages m ${identityJoin} WHERE m.thread IN (SELECT value FROM json_each(?))`)
      .bind(keys).all(),
    env.DB.prepare(`SELECT r.message, r.emoji, r.user_key,
        COALESCE(p.name, i.name) AS name, i.person = ? AS mine
      FROM reactions r
      LEFT JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = r.user_key
      LEFT JOIN people p ON p.id = i.person
      WHERE r.thread IN (SELECT value FROM json_each(?)) ORDER BY r.at`).bind(me.id, keys).all(),
    env.DB.prepare(`SELECT w.person, w.thread, w.read_at, w.via
      FROM watermarks w JOIN team_members m ON m.person = w.person AND m.team = ?
      WHERE w.thread IN (SELECT value FROM json_each(?))`).bind(row.team, keys).all(),
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
  ]);
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
        reactions: reactionsBy.get(m.mkey) || [],
      };
    })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const label = effectiveLabel(model, model ? reviewed : []);
  return {
    thread: {
      ...row,
      ...orgFields(await orgsOf(env, [row.org]), row.org),
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
    profiles: await profiles(env, messages.map((m) => m.authorKey)),
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

/**
 * Images from messages, fetched with the platform's credentials: Slack files need the bot
 * token, Teams inline images (hostedContents) a Graph token. Only those two kinds of URL
 * are fetched, and only images are passed on.
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

/** Routes `/api/*`. Returns null for paths it does not own. */
export async function api(request, env, url, { viewer: injected } = {}) {
  if (!url.pathname.startsWith('/api/')) {
    return null;
  }
  // `viewer` can be injected by tests; in the Worker it always comes from Access.
  const me = injected || await viewer(request, env);
  if (!me) {
    return json({ error: 'not signed in, or not a member of any team' }, 403);
  }
  const team = url.searchParams.get('team');

  if (url.pathname === '/api/me') {
    return json({
      ...me,
      connected: me.readonly ? {} : await connections(env, me.id),
      react: me.readonly ? {} : await reactable(env, me.id),
    });
  }
  // Looking as someone else is read-only: no reads, replies, reviews or connections.
  const writes = request.method !== 'GET' || /^\/api\/auth\//.test(url.pathname);
  if (me.readonly && writes) {
    return json({ error: 'read-only while viewing as someone else' }, 403);
  }
  if (url.pathname === '/api/people') {
    if (!(me.admin || (me.viewer))) {
      return json({ error: 'for the admin team' }, 403);
    }
    const { results } = await env.DB.prepare(`SELECT DISTINCT p.id, p.name FROM people p
      JOIN team_members m ON m.person = p.id ORDER BY p.name`).all();
    return json({ people: results || [] });
  }
  const auth = /^\/api\/auth\/(slack|teams)(\/start|\/callback)?$/.exec(url.pathname);
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
  if (url.pathname === '/api/post' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const res = await post(env, me, body, (t) => inTeam(me, t));
    // A reply sent from the shared draft uses it up (unless a colleague changed it since).
    if (res.ok && typeof body.draft === 'string') {
      await discardDraft(env, me, { thread: body.thread, base: body.draft }, (t) => inTeam(me, t));
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
      return discardDraft(env, me, body, (t) => inTeam(me, t));
    }
  }
  if (url.pathname === '/api/agent' && request.method === 'GET') {
    return agentStatus(env, url.searchParams.get('thread'), (t) => inTeam(me, t) || isAdmin(me));
  }
  if (url.pathname === '/api/agent/seed' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return seedAgent(env, me, body, (t) => inTeam(me, t));
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
    return mentionable(env, url.searchParams.get('thread'), url.searchParams.get('q'), (t) => inTeam(me, t));
  }
  if (url.pathname === '/api/inbox') {
    if (!inTeam(me, team)) {
      return json({ error: 'not a member of this team' }, 403);
    }
    return json(await inbox(env, me, team));
  }
  if (url.pathname === '/api/thread') {
    const result = await thread(env, me, url.searchParams.get('thread'));
    return result ? json(result) : json({ error: 'not found' }, 404);
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
    const { thread: key, at } = await request.json().catch(() => ({}));
    const row = key && await env.DB.prepare('SELECT team FROM threads WHERE thread = ?')
      .bind(key).first();
    if (!row || !inTeam(me, row.team) || typeof at !== 'string') {
      return json({ error: 'not found' }, 404);
    }
    await room(env, row.team).fetch('https://room/read', {
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
