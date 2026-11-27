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

import { loadRules, toChannel } from '../lookup.js';
import { platformName } from '../platforms.js';
import { createRequest, listRequests } from '../requests.js';
import { ADMIN_TEAM } from '../roles.js';
import { matching } from '../rules.js';
import { sharesOf } from '../shares.js';
import { entryFollows } from '../follows.js';

/**
 * Where the agent's channel is filed and why, the ops teams there are, and a request to file it
 * elsewhere: the thread agent's `channel_assignment`, `list_teams` and
 * `request_channel_reassignment` (src/agent/tools.js). The request is the admin pages' channel
 * request (src/requests.js, migration 0028), asking for a move (migration 0071): the admin team
 * confirms or declines it in its inbox, where it is a thread, as one a team manager sends. The
 * agent files one only while it answers a sidebar message, for the person who wrote it: the sidebar
 * is trusted, and the thread's messages, which customers write, cannot get a channel moved.
 */

const MAX_MEMBERS = 12;
const FIELD = {
  name: 'channel name',
  group_name: 'Teams team or Discord server name',
  connected: 'Slack Connect team',
  channel_id: 'channel id',
};

const prefixOf = (pattern) => {
  const m = /^\^((?:\\.|[^\\.*+?()[\]{}|$^])*)(\$?)$/.exec(pattern || '');
  return m ? { text: m[1].replace(/\\(.)/g, '$1'), whole: Boolean(m[2]) } : null;
};

/** A rule in words: "channel name starts with aem-", "channel id is C123 (Slack only)". */
export function ruleWords(r) {
  const p = prefixOf(r.pattern);
  let what = `matches /${r.pattern}/`;
  if (r.pattern === '.') {
    what = 'is anything (every channel)';
  } else if (p) {
    what = p.whole ? `is ${p.text}` : `starts with ${p.text}`;
  }
  return `${FIELD[r.field] || r.field} ${what}${r.source ? ` (${platformName(r.source)} only)` : ''}`;
}

/** One matching rule, for the agent: its id, what it says, its priority, value and note. */
function ruleLine({ rule: r, value }, names = {}) {
  const label = names[value] ? `${value} (${names[value]})` : value;
  const changed = r.updated_by ? `, last changed by ${r.updated_by} on ${String(r.updated_at || '').slice(0, 10)}` : '';
  return `rule ${r.id}: ${ruleWords(r)}, priority ${r.priority} → ${label}${r.note ? `; note: "${r.note}"` : ''}${changed}`;
}

/** The teams by slug: `{ slug: name }`. */
async function teamNames(env) {
  const { results } = await env.DB.prepare('SELECT slug, name FROM teams').all();
  return Object.fromEntries((results || []).map((t) => [t.slug, t.name]));
}

/**
 * Where channel `t` (the agent's target: `source`, `tenant`, `channelId`, `team`, `org`, `kind`,
 * and the thread's `key`) is filed and why: for team, org and kind, every rule that matches it in
 * the order they are tried (the first decides), the teams it is shared with, the teams that follow
 * a technology the thread shows (src/follows.js), Clef's pick and the open requests.
 */
export async function channelAssignment(env, t) {
  const row = await env.DB.prepare(`SELECT * FROM channels WHERE source = ? AND channel_id = ?
    ORDER BY tenant = ? DESC LIMIT 1`).bind(t.source, t.channelId, t.tenant || '').first();
  const rules = await loadRules(env);
  const channel = toChannel(row, t.source, t.channelId);
  const [names, shares, label, requests, follows] = await Promise.all([
    teamNames(env),
    sharesOf(env, t.source, t.channelId),
    env.DB.prepare(`SELECT team, team_p, kind, kind_p, labeled_at FROM channel_labels
      WHERE source = ? AND channel_id = ? ORDER BY labeled_at DESC LIMIT 1`)
      .bind(t.source, t.channelId).first(),
    listRequests(env, { channel: { source: t.source, channelId: t.channelId }, limit: 10 }),
    t.key ? entryFollows(env, t.key) : [],
  ]);
  return {
    channel: {
      name: (row && row.name) || t.channelName || null,
      groupName: (row && row.group_name) || null,
      shared: Boolean(row && row.shared),
      connected: channel.connected,
    },
    filed: { team: t.team, org: t.org, kind: t.kind },
    team: matching(rules, channel, 'team'),
    org: matching(rules, channel, 'org'),
    kind: matching(rules, channel, 'kind'),
    shares,
    follows,
    clef: label || null,
    requests,
    names,
  };
}

/** `channelAssignment`'s answer as the agent reads it. */
export function assignmentText(a, t) {
  const { names } = a;
  const team = (slug) => (names[slug] ? `${slug} (${names[slug]})` : slug);
  const c = a.channel;
  const where = c.groupName ? `${c.groupName} › ${c.name || t.channelId}` : `#${c.name || t.channelId}`;
  const lines = [
    `Channel ${where} on ${platformName(t.source)}${c.shared ? ' (Slack Connect)' : ''}, id ${t.channelId}: filed under ${team(a.filed.team || 'nobody')}, customer ${a.filed.org || 'unknown'}, kind ${a.filed.kind || 'unknown'}.`,
    '',
    'Rules are tried lowest priority first; the first that matches decides. A manual assignment from the admin pages is a channel-id rule with priority 10 and the note "manual assignment". The admin team is where channels go that no ops team follows.',
  ];
  for (const target of ['team', 'org', 'kind']) {
    const [first, ...rest] = a[target];
    lines.push('', `${target[0].toUpperCase()}${target.slice(1)}:`);
    if (!first) {
      lines.push('- no rule matches: the default applies');
    } else {
      lines.push(`- decided by ${ruleLine(first, target === 'team' ? names : {})}`);
      if (rest.length) {
        lines.push(`- without it: ${rest.slice(0, 4).map((m) => ruleLine(m, target === 'team' ? names : {})).join('; then ')}`);
      }
    }
  }
  const first = a.team[0];
  if (first && first.value !== a.filed.team) {
    lines.push('', `The rules say ${team(first.value)} now; the threads are still filed under ${team(a.filed.team)}, and move when the channel is re-filed.`);
  }
  lines.push('', a.shares.length
    ? `Shared with (in their inboxes too, filed where it is): ${a.shares.map(team).join(', ')}`
    : 'Shared with no other team.');
  const following = [...new Set((a.follows || []).map((f) => f.team))];
  if (following.length) {
    const what = (slug) => a.follows.filter((f) => f.team === slug)
      .map((f) => (f.tech || (f.area ? `the area ${f.area}` : `the customer ${f.org}, whose people posted in this public thread`))).join(', ');
    lines.push(`This thread is in the inboxes of ${following.map((s) => `${team(s)} (follows ${what(s)})`).join(', ')} too: they follow a technology Clef tagged the thread with, an area Clef put it in, or a customer whose people posted in this public thread. That is the thread's, not the channel's, and files nothing.`);
  }
  if (a.clef) {
    const p = a.clef.team_p == null ? '' : ` (${Math.round(a.clef.team_p * 100)}%)`;
    lines.push(`Clef's pick of a team, on ${String(a.clef.labeled_at).slice(0, 10)}: ${a.clef.team === 'none' ? 'none of them' : team(a.clef.team)}${p}. Clef is asked only about the admin team's channels.`);
  }
  const open = a.requests.filter((r) => r.status === 'open');
  const decided = a.requests.filter((r) => r.status !== 'open').slice(0, 3);
  lines.push(open.length
    ? `Open requests for this channel: ${open.map((r) => `request ${r.id}, ${r.move ? 'move to' : 'add to'} ${team(r.team)}, by ${r.requestedBy.name || r.requestedBy.email} on ${r.requestedAt.slice(0, 10)}`).join('; ')}`
    : 'No open request for this channel.');
  if (decided.length) {
    lines.push(`Decided requests: ${decided.map((r) => `request ${r.id} for ${team(r.team)}: ${r.status}${r.reason ? ` ("${r.reason}")` : ''}`).join('; ')}`);
  }
  return lines.join('\n');
}

/**
 * The ops teams, for finding the one a channel belongs to: each one's slug and name, the rules
 * that file channels under it (manual assignments only counted), how many channels it holds and
 * follows through shares, and its members, managers first. With `query`, the teams whose slug,
 * name, rules or members have it. The admin team is listed, as where no ops team's channels go.
 */
export async function teamList(env, query = '') {
  const { results: teams } = await env.DB.prepare(`SELECT t.slug, t.name,
      (SELECT COUNT(DISTINCT th.channel_id) FROM threads th WHERE th.team = t.slug) AS channels,
      (SELECT COUNT(*) FROM channel_teams s WHERE s.team = t.slug) AS shared,
      (SELECT COUNT(*) FROM team_members m WHERE m.team = t.slug) AS members
    FROM teams t ORDER BY t.slug = ? DESC, t.name`).bind(ADMIN_TEAM).all();
  const { results: people } = await env.DB.prepare(`SELECT m.team, p.name, m.role FROM team_members m
    JOIN people p ON p.id = m.person WHERE p.name IS NOT NULL
    ORDER BY m.role = 'manager' DESC, p.name`).all();
  const rules = (await loadRules(env)).filter((r) => r.target === 'team');
  const q = String(query || '').trim().toLowerCase();
  return (teams || []).map((t) => {
    const own = rules.filter((r) => r.value === t.slug);
    const manual = own.filter((r) => r.field === 'channel_id');
    const who = (people || []).filter((p) => p.team === t.slug);
    return {
      ...t,
      rules: own.filter((r) => r.field !== 'channel_id').map(ruleWords),
      assigned: manual.length,
      people: who.map((p) => `${p.name}${p.role === 'manager' ? ' (manager)' : ''}`),
    };
  }).filter((t) => !q || [t.slug, t.name, ...t.rules, ...t.people]
    .some((v) => String(v).toLowerCase().includes(q)));
}

/** `teamList`'s answer as the agent reads it. */
export function teamsText(teams) {
  if (!teams.length) {
    return 'No team matches.';
  }
  return teams.map((t) => {
    const parts = [`- ${t.slug} | ${t.name}${t.slug === ADMIN_TEAM ? ' | holds the channels no ops team follows' : ''}`];
    if (t.rules.length) {
      parts.push(`files channels whose ${t.rules.join(', or whose ')}`);
    }
    if (t.assigned) {
      parts.push(`${t.assigned} channel${t.assigned === 1 ? '' : 's'} assigned by channel id`);
    }
    parts.push(`holds ${t.channels} channel${t.channels === 1 ? '' : 's'}${t.shared ? `, follows ${t.shared} more shared with it` : ''}`);
    if (t.people.length) {
      const more = t.members > MAX_MEMBERS ? ` and ${t.members - Math.min(MAX_MEMBERS, t.people.length)} more` : '';
      parts.push(`members: ${t.people.slice(0, MAX_MEMBERS).join(', ')}${more}`);
    }
    return parts.join(' | ');
  }).join('\n');
}

/**
 * The person who wrote sidebar message `id` of entry `key`: `{ id, email, name }`, or null.
 */
export async function sidebarAuthor(env, key, id) {
  if (!id) {
    return null;
  }
  const row = await env.DB.prepare(`SELECT p.id, p.email, p.name FROM sidebar_messages s
    JOIN people p ON p.id = s.person WHERE s.id = ? AND s.thread = ? AND s.role = 'person'`)
    .bind(id, key).first();
  return row && row.email ? row : null;
}

/**
 * Files a request to put channel `t` under `team` (or, with `share`, in its inbox too), for
 * `asker` (`sidebarAuthor`), with `note`: `{ request }`, or `{ error, request? }` (the open one
 * that asks the same).
 */
export async function requestReassignment(env, t, asker, { team, note, share = false }) {
  const slug = String(team || '').trim().toLowerCase();
  if (!share && slug === t.team) {
    return { error: `the channel is filed under ${slug} already` };
  }
  const res = await createRequest(env, asker, {
    team: slug, source: t.source, channelId: t.channelId, note,
  }, { move: !share, thread: t.key });
  const body = await res.json();
  return res.ok ? { request: body.request } : { error: body.error, request: body.request || null };
}
