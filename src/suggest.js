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

import { cachedGraph } from './graph.js';
import { CLEF, TECH } from './label.js';
import {
  getChannel, isStaffDomain, loadRules, slackApi,
} from './lookup.js';
import { ADMIN_TEAM } from './review.js';

/**
 * Channel suggestions for the admin pages. The admin team holds every channel no rule files
 * under an ops team (the fallback rule), and most of them belong with one. Two signals say
 * which:
 *
 * - activity: a team's members post or react in the channel, or are in it (the channel's
 *   members are listed from Slack, or the Teams team's from Graph, and kept in
 *   `channel_members`);
 * - Clef: one classification per channel (`channel_labels`), from its name, its Teams team,
 *   its topic, its customer, the Adobe people in it and what they post, and its recent
 *   threads: which ops team should follow it, and whether it is a conversation, an alert
 *   feed or not worth following.
 *
 * The cron classifies a batch of the admin team's channels on every run: the ones never
 * classified, then the ones with new activity, new ops teams, or a label older than a week.
 */

export const NONE = 'none';
const DAY_MS = 24 * 60 * 60 * 1000;
const MEMBERS_MAX_AGE_MS = 7 * DAY_MS;
const RELABEL_AFTER_MS = 7 * DAY_MS;
export const BATCH = 20;
const RECENT_THREADS = 10;
const MAX_PEOPLE = 25;
const MAX_MEMBERS_LISTED = 2000;
const SAMPLE_CHANNELS = 12;
const SAMPLE_MEMBERS = 20;
// Clef's probability for a team at which a channel is suggested to it without any activity.
export const SUGGEST_P = 0.8;

async function rows(env, sql, ...args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

const key = (r) => `${r.source}:${r.tenant}:${r.channel_id}`;
const day = (at) => (at ? String(at).slice(0, 10) : '');
const prefixOf = (pattern) => {
  const m = /^\^((?:\\.|[^\\.*+?()[\]{}|$^])*)$/.exec(pattern || '');
  return m ? m[1].replace(/\\(.)/g, '$1') : null;
};
const FIELD = {
  name: 'channel name', group_name: 'Teams team name', connected: 'Slack Connect team',
};

/** A rule in words, for Clef: "channel name starts with aem-". */
function ruleText(r) {
  const prefix = prefixOf(r.pattern);
  const what = prefix !== null ? `starts with ${prefix}` : `matches /${r.pattern}/`;
  return `${FIELD[r.field] || r.field} ${what}${r.source ? ` (${r.source === 'slack' ? 'Slack' : 'Teams'} only)` : ''}`;
}

// ---- who is in a channel ------------------------------------------------------------------

async function slackMembers(env, channelId, slack) {
  const ids = [];
  let cursor = '';
  do {
    // eslint-disable-next-line no-await-in-loop
    const data = await slack('conversations.members', {
      channel: channelId, limit: '1000', ...(cursor ? { cursor } : {}),
    });
    ids.push(...(data.members || []));
    cursor = (data.response_metadata && data.response_metadata.next_cursor) || '';
  } while (cursor && ids.length < MAX_MEMBERS_LISTED);
  return ids.map((id) => ({ userId: id, email: null, name: null }));
}

async function teamsMembers(graph, groupId) {
  const out = [];
  let next = `/teams/${encodeURIComponent(groupId)}/members`;
  while (next && out.length < MAX_MEMBERS_LISTED) {
    // eslint-disable-next-line no-await-in-loop
    const res = await graph(next);
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`graph members ${res.status}${data.error ? ` ${data.error.code}` : ''}`);
      err.status = res.status;
      throw err;
    }
    for (const m of data.value || []) {
      out.push({ userId: m.userId || m.id, email: m.email || null, name: m.displayName || null });
    }
    next = data['@odata.nextLink'] || null;
  }
  return out;
}

/**
 * Lists a channel's members on its platform and replaces `channel_members`. Slack lists user
 * ids; the ones opspile knows get their name and email from `identities`. Teams lists the
 * members of the channel's team, with their email (Graph `TeamMember.Read.All`).
 */
export async function refreshMembers(env, ch, deps = {}, now = Date.now()) {
  const at = new Date(now).toISOString();
  let list;
  try {
    if (ch.source === 'slack') {
      if (!deps.slack && !env.SLACK_BOT_TOKEN) {
        throw new Error('no Slack token');
      }
      list = await slackMembers(env, ch.channel_id, deps.slack || ((m, p) => slackApi(env, m, p)));
      const known = new Map((await rows(env, `SELECT user_id, name, email FROM identities
        WHERE source = 'slack' AND tenant = ?`, ch.tenant)).map((i) => [i.user_id, i]));
      list = list.map((m) => {
        const i = known.get(m.userId);
        return i ? { ...m, name: i.name, email: i.email } : m;
      });
    } else {
      if (!ch.group_id) {
        throw new Error('no Teams team id');
      }
      const graph = deps.graph || await cachedGraph(env);
      list = await teamsMembers(graph, ch.group_id);
    }
  } catch (e) {
    await env.DB.prepare(`UPDATE channels SET members_at = ?, members_error = ?
      WHERE source = ? AND tenant = ? AND channel_id = ?`)
      .bind(at, String(e.message).slice(0, 200), ch.source, ch.tenant, ch.channel_id).run();
    return { error: e.message, status: e.status };
  }
  const stmts = [env.DB.prepare('DELETE FROM channel_members WHERE source = ? AND tenant = ? AND channel_id = ?')
    .bind(ch.source, ch.tenant, ch.channel_id)];
  for (const m of list.filter((x) => x.userId)) {
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO channel_members
        (source, tenant, channel_id, user_id, email, name) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(ch.source, ch.tenant, ch.channel_id, m.userId, m.email, m.name));
  }
  stmts.push(env.DB.prepare(`UPDATE channels SET members_at = ?, members_error = NULL
    WHERE source = ? AND tenant = ? AND channel_id = ?`).bind(at, ch.source, ch.tenant, ch.channel_id));
  await env.DB.batch(stmts);
  return { members: list.length };
}

// ---- what Clef is told --------------------------------------------------------------------

/** Each person's ops teams, by lower-case email. */
async function teamsByEmail(env) {
  const by = new Map();
  for (const r of await rows(env, `SELECT LOWER(p.email) AS email, tm.team FROM team_members tm
    JOIN people p ON p.id = tm.person WHERE p.email IS NOT NULL`)) {
    by.set(r.email, [...(by.get(r.email) || []), r.team]);
  }
  return by;
}

/** Everything opspile knows about one channel that helps to say whose it is. */
export async function channelFacts(env, ch, ctx = {}) {
  const k = [ch.source, ch.tenant, ch.channel_id];
  const teamsOf = ctx.teamsOf || await teamsByEmail(env);
  const teamName = ctx.teamName || new Map();
  const [summary] = await rows(env, `SELECT COUNT(*) AS threads, MAX(COALESCE(last_at, any_at)) AS latest,
      MAX(any_at) AS through, SUM(messages) AS messages, MAX(org) AS org
    FROM threads WHERE source = ? AND tenant = ? AND channel_id = ?`, ...k);
  const org = summary && summary.org
    ? await env.DB.prepare('SELECT slug, name, type FROM orgs WHERE slug = ?').bind(summary.org).first()
      || { slug: summary.org, name: null, type: null }
    : null;
  const recent = await rows(env, `SELECT t.root_at, t.last_at, t.any_at, t.messages, t.kind,
      COALESCE(l.title, t.title) AS title, l.kind AS label_kind
    FROM threads t LEFT JOIN labels l ON l.thread = t.thread
    WHERE t.source = ? AND t.tenant = ? AND t.channel_id = ?
    ORDER BY COALESCE(t.last_at, t.any_at) DESC LIMIT ?`, ...k, RECENT_THREADS);
  const posters = await rows(env, `SELECT COALESCE(p.name, i.name) AS name, LOWER(COALESCE(p.email, i.email)) AS email,
      MAX(m.staff) AS staff, COUNT(*) AS n, MAX(m.at) AS last
    FROM messages m
    LEFT JOIN people p ON p.id = m.person
    LEFT JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = m.author_key
    WHERE m.source = ? AND m.tenant = ? AND m.channel_id = ? AND m.counted = 1 AND m.deleted = 0
    GROUP BY COALESCE(CAST(m.person AS TEXT), m.author_key, m.author) ORDER BY n DESC`, ...k);
  const members = await rows(env, `SELECT COALESCE(p.name, cm.name) AS name, LOWER(COALESCE(p.email, cm.email)) AS email,
      COALESCE(p.staff, 0) AS staff
    FROM channel_members cm LEFT JOIN people p ON p.email = cm.email
    WHERE cm.source = ? AND cm.tenant = ? AND cm.channel_id = ?`, ...k);
  const tech = (await rows(env, `SELECT tech FROM channel_tech WHERE source = ? AND tenant = ? AND channel_id = ?
    ORDER BY p DESC`, ...k)).map((r) => r.tech);
  const staff = (p) => Boolean(p.staff) || isStaffDomain(env, p.email);
  const teamsFor = (p) => (p.email ? teamsOf.get(p.email) || [] : [])
    .filter((t) => t !== ADMIN_TEAM).map((t) => teamName.get(t) || t);
  return {
    source: ch.source,
    name: ch.name,
    groupName: ch.group_name,
    topic: ch.topic,
    shared: Boolean(ch.shared),
    connected: ch.connected ? JSON.parse(ch.connected).length : 0,
    org,
    threads: (summary && summary.threads) || 0,
    latest: summary ? summary.latest : null,
    through: summary ? summary.through : null,
    recent: recent.map((t) => ({
      at: t.last_at || t.any_at || t.root_at,
      title: t.title,
      messages: t.messages,
      kind: t.label_kind || t.kind,
    })),
    posters: posters.map((p) => ({
      name: p.name, email: p.email, staff: staff(p), n: p.n, last: p.last, teams: teamsFor(p),
    })),
    members: members.map((p) => ({
      name: p.name, email: p.email, staff: staff(p), teams: teamsFor(p),
    })),
    membersListed: Boolean(ch.members_at && !ch.members_error),
    tech: tech.map((t) => TECH[t] || t),
  };
}

const person = (p) => `${p.name || p.email || 'someone'}${p.teams.length ? ` (${p.teams.join(', ')})` : ' (no ops team)'}`;

/** The channel as text for Clef. */
export function channelState(f) {
  const lines = [];
  const platform = f.source === 'slack' ? 'Slack' : 'Microsoft Teams';
  lines.push(f.source === 'slack' ? `Channel: #${f.name || '?'} on Slack` : `Channel: "${f.name || '?'}" in the Microsoft Teams team "${f.groupName || '?'}"`);
  if (f.shared) {
    lines.push(f.source === 'slack' ? `Slack Connect: shared with ${f.connected || 'an'} other organization${f.connected === 1 ? '' : 's'}` : 'Shared channel');
  }
  if (f.topic) {
    lines.push(`Topic: ${String(f.topic).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  if (f.org && !f.org.slug.startsWith('_')) {
    lines.push(`Customer, from the channel's name: ${f.org.name || f.org.slug}${f.org.type && f.org.type !== 'customer' ? ` (a ${f.org.type})` : ''}`);
  }
  const staffPosts = f.posters.filter((p) => p.staff).reduce((n, p) => n + p.n, 0);
  const otherPosts = f.posters.filter((p) => !p.staff).reduce((n, p) => n + p.n, 0);
  lines.push(`Activity in opspile: ${f.threads} thread${f.threads === 1 ? '' : 's'}${f.latest ? `, the latest on ${day(f.latest)}` : ''}; ${staffPosts} message${staffPosts === 1 ? '' : 's'} by Adobe staff and ${otherPosts} by others`);
  if (f.tech.length) {
    lines.push(`Technologies seen: ${f.tech.slice(0, 6).join('; ')}`);
  }
  const posted = f.posters.filter((p) => p.staff);
  if (posted.length) {
    lines.push(`Adobe people who posted: ${posted.slice(0, MAX_PEOPLE).map((p) => `${person(p)}, ${p.n} message${p.n === 1 ? '' : 's'}`).join('; ')}`);
  }
  const others = f.posters.filter((p) => !p.staff && p.name);
  if (others.length) {
    lines.push(`Others who posted: ${others.slice(0, 10).map((p) => p.name).join(', ')}`);
  }
  if (f.membersListed) {
    const adobe = f.members.filter((p) => p.staff);
    // Team members first: they are what the question is about.
    adobe.sort((a, b) => (b.teams.length - a.teams.length)
      || String(a.name).localeCompare(String(b.name)));
    const unknown = f.members.length - adobe.length;
    lines.push(`Members on ${platform}: ${f.members.length} (${adobe.length} Adobe staff, ${unknown} others or not known to opspile)`);
    if (adobe.length) {
      const shown = adobe.slice(0, MAX_PEOPLE);
      lines.push(`Adobe staff in the channel: ${shown.map(person).join('; ')}${adobe.length > shown.length ? `; and ${adobe.length - shown.length} more` : ''}`);
    }
  }
  if (f.recent.length) {
    lines.push('', 'Recent threads:');
    for (const t of f.recent) {
      lines.push(`- [${day(t.at)}] ${String(t.title || '(no title)').replace(/\s+/g, ' ').slice(0, 160)} (${t.messages} message${t.messages === 1 ? '' : 's'}${t.kind && t.kind !== 'channel' ? `, ${t.kind}` : ''})`);
    }
  }
  return lines.join('\n');
}

/**
 * What each ops team is, for the `team` question: its name, its rules, some of its channels
 * and its members. Every team but the admin team, and `none`.
 */
export async function teamOptions(env) {
  const teams = (await rows(env, 'SELECT slug, name FROM teams ORDER BY slug')).filter((t) => t.slug !== ADMIN_TEAM);
  const rules = (await loadRules(env)).filter((r) => r.target === 'team' && r.field !== 'channel_id');
  const criteria = {};
  for (const t of teams) {
    // eslint-disable-next-line no-await-in-loop
    const channels = await rows(env, `SELECT COALESCE(c.group_name || ' / ' || c.name, c.name, t.channel_name) AS name,
        COUNT(*) AS n
      FROM threads t LEFT JOIN channels c ON c.source = t.source AND c.tenant = t.tenant AND c.channel_id = t.channel_id
      WHERE t.team = ? GROUP BY t.source, t.tenant, t.channel_id ORDER BY n DESC LIMIT ?`, t.slug, SAMPLE_CHANNELS);
    // eslint-disable-next-line no-await-in-loop
    const members = await rows(env, `SELECT p.name FROM team_members tm JOIN people p ON p.id = tm.person
      WHERE tm.team = ? AND p.name IS NOT NULL ORDER BY p.name LIMIT ?`, t.slug, SAMPLE_MEMBERS);
    const own = rules.filter((r) => r.value === t.slug);
    criteria[t.slug] = [
      `The ops team "${t.name}".`,
      own.length ? `Its rules file channels whose ${own.map(ruleText).join(', or whose ')}.` : '',
      channels.length ? `Channels it follows include: ${channels.map((c) => c.name).filter(Boolean).join(', ')}.` : '',
      members.length ? `Its members: ${members.map((m) => m.name).join(', ')}.` : '',
    ].filter(Boolean).join(' ');
  }
  criteria[NONE] = 'None of these teams: an internal, test, social or abandoned channel, or one about work that no ops team above does.';
  return { teams, criteria, options: teams.map((t) => t.slug).join(',') };
}

export function channelQuestions(criteria) {
  return {
    team: {
      type: 'choice',
      instructions: 'Which Adobe ops team should follow this channel and answer in it? Teams follow the'
        + ' channels of their customers and products. The strongest signs are the team\'s members who are'
        + ' in the channel or post there, and a channel name like the names of the team\'s channels.',
      criteria,
    },
    kind: {
      type: 'choice',
      instructions: 'What kind of channel is this?',
      criteria: {
        channel: 'Conversations with a customer, partner or vendor, or about their project, that somebody at Adobe should follow and answer',
        alert: 'Mostly automated posts: monitoring alerts, build or deploy notifications, bot feeds',
        ignore: 'Not worth following: a test channel, social chatter, or an empty or abandoned channel',
      },
    },
  };
}

// ---- classifying ----------------------------------------------------------------------------

/** Clef's answer for one channel, stored in `channel_labels`. */
export async function classifyChannel(env, ch, ctx, now = Date.now()) {
  const f = await channelFacts(env, ch, ctx);
  const state = channelState(f);
  const res = await env.AI.run(CLEF, { model: 'clef', state, questions: channelQuestions(ctx.criteria) });
  const a = (res && res.answers) || {};
  const pick = (q) => (a[q]
    ? [a[q].choice, a[q].probabilities?.[a[q].choice] ?? a[q].confidence ?? null]
    : [null, null]);
  const [team, teamP] = pick('team');
  const [kind, kindP] = pick('kind');
  await env.DB.prepare(`INSERT INTO channel_labels (source, tenant, channel_id, team, team_p, teams, kind,
      kind_p, labeled_through, options, model, labeled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, tenant, channel_id) DO UPDATE SET team = excluded.team, team_p = excluded.team_p,
      teams = excluded.teams, kind = excluded.kind, kind_p = excluded.kind_p,
      labeled_through = excluded.labeled_through, options = excluded.options, model = excluded.model,
      labeled_at = excluded.labeled_at`)
    .bind(
      ch.source,
      ch.tenant,
      ch.channel_id,
      team,
      teamP,
      JSON.stringify((a.team && a.team.probabilities) || {}),
      kind,
      kindP,
      f.through || '',
      ctx.options,
      (res && res.model) || 'clef',
      new Date(now).toISOString(),
    )
    .run();
  return {
    team, teamP, kind, kindP, state,
  };
}

/**
 * Classifies up to `limit` of the admin team's channels: first the ones Clef has not seen,
 * then the ones that changed since (new activity, other ops teams to choose from) or whose
 * label is a week old. Their members are listed again when that is a week old too.
 *
 * `deps.slack` and `deps.graph` replace the platform calls (tests).
 */
export async function classifyChannels(env, { limit = BATCH, now = Date.now(), ...deps } = {}) {
  const out = {
    classified: 0, members: 0, failed: 0, pending: 0,
  };
  const options = await teamOptions(env);
  if (!options.teams.length) {
    return { ...out, skipped: 'no ops teams but the admin team' };
  }
  const stale = new Date(now - RELABEL_AFTER_MS).toISOString();
  const due = await rows(env, `SELECT c.*, a.through, l.labeled_at
    FROM (SELECT source, tenant, channel_id, MAX(any_at) AS through FROM threads WHERE team = ?
      GROUP BY source, tenant, channel_id) a
    JOIN channels c ON c.source = a.source AND c.tenant = a.tenant AND c.channel_id = a.channel_id
    LEFT JOIN channel_labels l ON l.source = a.source AND l.tenant = a.tenant AND l.channel_id = a.channel_id
    WHERE l.labeled_at IS NULL OR l.options IS NOT ? OR l.labeled_through IS NOT COALESCE(a.through, '')
      OR l.labeled_at < ?
    ORDER BY l.labeled_at IS NOT NULL, a.through DESC`, ADMIN_TEAM, options.options, stale);
  out.pending = Math.max(0, due.length - limit);
  const ctx = {
    ...options,
    teamsOf: await teamsByEmail(env),
    teamName: new Map(options.teams.map((t) => [t.slug, t.name])),
  };
  const membersBefore = new Date(now - MEMBERS_MAX_AGE_MS).toISOString();
  let teamsDenied = false;
  for (const ch of due.slice(0, limit)) {
    try {
      let row = ch;
      if (!ch.members_at || ch.members_at < membersBefore) {
        if (ch.source === 'teams' && teamsDenied) {
          // The app may not list Teams members; every team would answer the same.
        } else {
          // eslint-disable-next-line no-await-in-loop
          const m = await refreshMembers(env, ch, deps, now);
          teamsDenied = teamsDenied || (ch.source === 'teams' && (m.status === 401 || m.status === 403));
          out.members += m.error ? 0 : 1;
          // A week-old topic is fetched again too, through the usual lookup.
          if (!deps.slack && !deps.graph) {
            // eslint-disable-next-line no-await-in-loop
            await getChannel(env, {
              source: ch.source, tenant: ch.tenant, channelId: ch.channel_id, groupId: ch.group_id,
            }, now).catch(() => null);
          }
          // eslint-disable-next-line no-await-in-loop
          row = await env.DB.prepare('SELECT * FROM channels WHERE source = ? AND tenant = ? AND channel_id = ?')
            .bind(ch.source, ch.tenant, ch.channel_id).first() || ch;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await classifyChannel(env, row, ctx, now);
      out.classified += 1;
    } catch (e) {
      out.failed += 1;
      console.warn(JSON.stringify({ route: 'suggest', channel: ch.source, error: e.message }));
    }
  }
  return out;
}

// ---- suggestions ----------------------------------------------------------------------------

const parseTeams = (s) => {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
};

/** Clef's label of a channel as the admin pages show it. */
export function clefOf(l) {
  return l && l.model ? {
    team: l.team,
    p: l.team_p,
    kind: l.kind,
    kindP: l.kind_p,
    teams: parseTeams(l.teams),
    at: l.labeled_at,
  } : null;
}

/**
 * How much one person's activity in a channel says about it, tf-idf style: the channels are
 * the documents and the team's members the terms. The term frequency grows with the log of
 * their posts and reactions (being a member only is half a post); the inverse document
 * frequency, `ln((1 + N) / (1 + df))` over the admin team's N channels, is zero for someone
 * active in all of them. An admin who is in every channel then hardly moves the ranking, and a
 * member active in a handful of channels counts the most there.
 *
 * The corpus is the admin team's channels, not every channel: a member busy in their own
 * team's channels is no less telling about the few of the admin team's they are in.
 */
export function tfidf({ posted = 0, reacted = 0, member = false }, df, n) {
  const acts = posted + reacted;
  let tf = 0;
  if (acts > 0) {
    tf = 1 + Math.log(acts);
  } else if (member) {
    tf = 0.5;
  }
  return tf * Math.log((1 + n) / (1 + df));
}

/**
 * The admin team's channels that `team` might want: the ones its members post in, react in
 * or are in, and the ones Clef gives it at least SUGGEST_P. Ranked by the sum of the members'
 * tf-idf (see `tfidf`), then by how many are active, Clef's confidence and the latest activity.
 */
export async function suggestionsFor(env, team) {
  const people = new Map((await rows(env, `SELECT p.id, p.name, p.email FROM team_members tm
    JOIN people p ON p.id = tm.person WHERE tm.team = ?`, team)).map((p) => [p.id, p]));
  const admin = await rows(env, `SELECT t.source, t.tenant, t.channel_id, COUNT(*) AS threads,
      MAX(COALESCE(t.last_at, t.any_at)) AS latest, MAX(t.org) AS org,
      c.name, c.group_name, c.topic, c.members_at, c.members_error,
      l.team AS l_team, l.team_p, l.teams AS l_teams, l.kind AS l_kind, l.kind_p, l.model, l.labeled_at
    FROM threads t
    LEFT JOIN channels c ON c.source = t.source AND c.tenant = t.tenant AND c.channel_id = t.channel_id
    LEFT JOIN channel_labels l ON l.source = t.source AND l.tenant = t.tenant AND l.channel_id = t.channel_id
    WHERE t.team = ? GROUP BY t.source, t.tenant, t.channel_id`, ADMIN_TEAM);
  // A channel shared with the team already is in its inbox (migration 0024): not suggested,
  // though it still counts in the corpus below.
  const shared = new Set((await rows(env, 'SELECT source, channel_id FROM channel_teams WHERE team = ?', team))
    .map((r) => `${r.source}:${r.channel_id}`));
  const activity = new Map();
  const touch = (r, how, n = 1) => {
    const p = people.get(r.person);
    if (!p) {
      return;
    }
    const k = key(r);
    const byPerson = activity.get(k) || new Map();
    const a = byPerson.get(p.id) || {
      id: p.id, name: p.name || p.email, posted: 0, reacted: 0, member: false,
    };
    if (how === 'member') {
      a.member = true;
    } else {
      a[how] += n;
    }
    byPerson.set(p.id, a);
    activity.set(k, byPerson);
  };
  if (people.size) {
    for (const r of await rows(env, `SELECT m.source, m.tenant, m.channel_id, m.person, COUNT(*) AS n
      FROM threads t JOIN messages m ON m.thread = t.thread
      JOIN team_members tm ON tm.person = m.person AND tm.team = ?2
      WHERE t.team = ?1 AND m.counted = 1 AND m.deleted = 0
      GROUP BY m.source, m.tenant, m.channel_id, m.person`, ADMIN_TEAM, team)) {
      touch(r, 'posted', r.n);
    }
    for (const r of await rows(env, `SELECT t.source, t.tenant, t.channel_id, p.id AS person, COUNT(*) AS n
      FROM threads t JOIN reactions r ON r.thread = t.thread
      JOIN identities i ON i.source || ':' || i.tenant || ':' || i.user_id = +r.user_key
      JOIN people p ON p.id = i.person OR (i.person IS NULL AND p.email = i.email)
      JOIN team_members tm ON tm.person = p.id AND tm.team = ?2
      WHERE t.team = ?1 GROUP BY t.source, t.tenant, t.channel_id, p.id`, ADMIN_TEAM, team)) {
      touch(r, 'reacted', r.n);
    }
    for (const r of await rows(env, `SELECT DISTINCT cm.source, cm.tenant, cm.channel_id, p.id AS person
      FROM channel_members cm JOIN people p ON p.email = cm.email
      JOIN team_members tm ON tm.person = p.id AND tm.team = ?2
      WHERE EXISTS (SELECT 1 FROM threads t WHERE t.source = cm.source AND t.tenant = cm.tenant
        AND t.channel_id = cm.channel_id AND t.team = ?1)`, ADMIN_TEAM, team)) {
      touch(r, 'member');
    }
  }
  const orgs = new Map((await rows(env, 'SELECT slug, name, type FROM orgs')).map((o) => [o.slug, o]));
  // In how many of the admin team's channels each member is active.
  const df = new Map();
  for (const byPerson of activity.values()) {
    for (const id of byPerson.keys()) {
      df.set(id, (df.get(id) || 0) + 1);
    }
  }
  const round = (x) => Math.round(x * 1000) / 1000;
  const out = [];
  for (const c of admin) {
    const active = [...(activity.get(key(c))?.values() || [])]
      .map((a) => ({
        ...a, channels: df.get(a.id), weight: round(tfidf(a, df.get(a.id), admin.length)),
      }))
      .sort((a, b) => (b.weight - a.weight) || (b.posted - a.posted) || (b.reacted - a.reacted)
        || String(a.name).localeCompare(String(b.name)));
    const clef = clefOf({
      ...c, team: c.l_team, teams: c.l_teams, kind: c.l_kind,
    });
    const p = clef ? clef.teams[team] ?? (clef.team === team ? clef.p : 0) : null;
    if (!shared.has(`${c.source}:${c.channel_id}`)
      && (active.length || (p !== null && p >= SUGGEST_P))) {
      const o = orgs.get(c.org);
      out.push({
        source: c.source,
        tenant: c.tenant,
        channelId: c.channel_id,
        name: c.name,
        groupName: c.group_name,
        topic: c.topic,
        org: c.org,
        orgName: (o && o.name) || null,
        threads: c.threads,
        latest: c.latest,
        people: active,
        score: round(active.reduce((s, a) => s + a.weight, 0)),
        membersListed: Boolean(c.members_at && !c.members_error),
        clef: clef && { ...clef, here: p },
      });
    }
  }
  out.sort((a, b) => (b.score - a.score) || (b.people.length - a.people.length)
    || ((b.clef?.here ?? 0) - (a.clef?.here ?? 0)) || String(b.latest || '').localeCompare(String(a.latest || '')));
  return {
    suggestions: out.slice(0, 100),
    // How much of the admin team's channels the suggestions could look at.
    coverage: {
      channels: admin.length,
      classified: admin.filter((c) => c.model).length,
      membersListed: admin.filter((c) => c.members_at && !c.members_error).length,
    },
  };
}
