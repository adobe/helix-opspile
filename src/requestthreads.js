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

import { admin, channelLabel } from './admin.js';
import { json } from './http.js';
import { listAccounts } from './accountlinks.js';
import { listAccountPairs } from './accountpairs.js';
import { isStaffDomain } from './lookup.js';
import { getMemberRequest, listMemberRequests } from './memberrequests.js';
import { getMergeRequest, listMergeRequests } from './orgmerge.js';
import { LIKELY } from './orgpartners.js';
import { getPartnerRequest, listPartnerRequests, otherPartners } from './partnerrequests.js';
import { getBot, listBots } from './ourbots.js';
import { getPortalRequest, listPortalRequests } from './portalrequests.js';
import {
  getIntegrationChannel, getIntegrationRequest, listIntegrationChannels, listIntegrationRequests,
} from './integrationrequests.js';
import { portalBound } from './portalsource.js';
import { announceRequest, parseRequestKey, requestKey } from './requestkeys.js';
import { getRequest, listRequests } from './requests.js';
import {
  closeQuestion, getQuestion, listQuestions, markTold,
} from './questions.js';
import { answerNote } from './agent/question.js';
import { agentStub } from './agent/stub.js';
import { ADMIN_TEAM, isAdmin } from './roles.js';
import { ruleConflicts } from './ruleconflicts.js';
import { techConflicts } from './techconflicts.js';
import { advanceWatermark, readState } from './threads.js';

/**
 * The admin team's requests as threads of its inbox. What waits for the admin team (a channel a
 * team asked for, a person to add to a team, a customer in the portal, a merge of customers, a
 * bot nobody said whose it is, an admin account nobody linked, two accounts of a customer's that
 * may be one person, a conflict between technologies or between team rules) is an inbox entry
 * there, keyed `request:<kind>:<id>` (src/requestkeys.js), and decided ones stay as resolved
 * entries. Its thread is the request,
 * as whoever asked said it, then what the admin team writes about it (`note`s, its decision
 * log, `request_log`, migration 0100), and what was decided; the thread view offers what can be
 * decided (`actions`), and deciding runs the same `/api/admin/*` route the admin pages did, as
 * the person deciding, so the checks and the outcome are those of src/admin.js.
 *
 * Nothing here is a platform's: the threads are in no channel, nobody posts anywhere, and no
 * agent, label or draft is theirs. Their read state is the watermarks of their keys, as a
 * thread's.
 *
 * A request keeps its own row (`channel_requests`, …): its time and its decision are that row's.
 * The kinds without a row that says when they were asked or what was decided (bots, accounts,
 * conflicts) are kept in `request_threads` from when they are first seen waiting, and what is
 * decided from the thread is in the log; a conflict that is gone (settled, or its rules changed)
 * stays as a resolved thread with its title then.
 *
 * A thread agent's question to one person (kind `question`, src/questions.js) is a request too,
 * but theirs, not the admin team's: it is a thread of their inbox, in the personal view and in
 * the inbox of the team its thread is filed under (`personal`), and only they see and answer it.
 * Answering does not take an admin route: the question is closed and the agent is told (`act`).
 */

/** What the inbox names each kind, in the entry's place of a customer. */
export const KIND_NAMES = {
  channel: 'Channel requests',
  member: 'Membership requests',
  portal: 'Portal customers',
  integration: 'Integration access',
  embed: 'Integration channels',
  merge: 'Customer merges',
  partner: 'Partners of customers',
  bot: 'Bots',
  account: 'Admin accounts',
  person: 'Two accounts, one person?',
  tech: 'Technology conflicts',
  rule: 'Rule conflicts',
  question: 'Questions for you',
};
/** The kinds that are one person's, not the admin team's: every inbox of theirs has them. */
export const PERSONAL = new Set(['question']);
/** The kinds without a row that says when they waited from: `request_threads` does. */
const TRACKED = new Set(['bot', 'account', 'person', 'tech', 'rule']);
/** The kinds that are worked out each time, and gone once settled. */
const COMPUTED = new Set(['tech', 'rule']);
/** The kinds whose decisions are only in the log: a bot's, an account's, a conflict's, and a
 * channel's. */
const LOGGED = new Set([...TRACKED, 'embed']);
const MAX_NOTE = 4000;
const MAX_FIELD = 8000;
/** How many of each kind's decided requests the inbox lists (the open ones are all there). */
const LIMIT = 100;
/** How many channels of a rule conflict its thread names. */
const SHOWN_CHANNELS = 10;

const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const now = () => new Date().toISOString();
const latest = (...xs) => xs.flat().filter(Boolean).sort().pop() || null;

/** `s` as text in markdown: what would be markup is escaped. */
const md = (s) => String(s ?? '').replace(/[\\`*_[\]<>~|]/g, '\\$&');
/** `s` as code in markdown: inside, nothing is markup, and a backtick needs a longer fence. */
const code = (s) => {
  const t = String(s ?? '').replace(/\n/g, ' ');
  const fence = '`'.repeat(Math.max(0, ...(t.match(/`+/g) || []).map((x) => x.length)) + 1);
  return /^`|`$/.test(t) ? `${fence} ${t} ${fence}` : `${fence}${t}${fence}`;
};
/** A quote of `s` (a note, a reason), line by line. */
const quote = (s) => String(s || '').split('\n').map((l) => `> ${md(l)}`).join('\n');
const who = (p) => (p && (p.name || p.email)) || 'someone';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const PLATFORM = {
  slack: 'Slack', teams: 'Teams', discord: 'Discord', portal: 'Portal',
};
const platformOf = (c) => PLATFORM[c.source] || c.source;
const chan = (c) => channelLabel({
  source: c.source, name: c.name, group_name: c.groupName, channel_id: c.channelId,
});
/** A team's possessive: "Edge ops'", "Forms team's". */
const poss = (name) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/** The names the threads show: teams' and orgs', by slug. */
async function names(env) {
  const [teams, orgs] = await Promise.all([
    env.DB.prepare('SELECT slug, name FROM teams').all(),
    env.DB.prepare('SELECT slug, name FROM orgs').all(),
  ]);
  const t = new Map((teams.results || []).map((r) => [r.slug, r.name || r.slug]));
  const o = new Map((orgs.results || []).map((r) => [r.slug, r.name || r.slug]));
  return {
    teams: [...t].map(([slug, name]) => ({ slug, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    team: (slug) => t.get(slug) || slug || 'no team',
    org: (slug) => (!slug || slug.startsWith('_') ? 'no customer' : o.get(slug) || slug),
  };
}

/** What a dry run of re-filing says, as a list: each channel, its threads, from where to where. */
function movesText(moves, n) {
  return moves.slice(0, 20).map((m) => {
    const threads = (m.from || []).reduce((k, f) => k + (f.threads || 0), 0);
    const from = [...new Set((m.from || []).map((f) => n.team(f.team)))].join(', ');
    return `- ${md(chan(m.channel))}: ${plural(threads, 'thread')} from ${md(from)} to ${md(n.team(m.to.team))} / ${md(n.org(m.to.org))}`;
  }).join('\n') + (moves.length > 20 ? `\n- and ${moves.length - 20} more` : '');
}

// ---- the kinds -------------------------------------------------------------------------------
//
// Each kind says of one of its requests (`r`, as its module lists it, `n` the names):
// `title`, `open` (whether it waits), `status` (a word for where it stands), `askedAt` and
// `askedBy`, `body` (the request, as its first message says it, markdown), `decidedAt`,
// `decidedBy` and `decision` (what was decided, markdown, when its row says so), and `actions`
// (what can be decided now). An action is `{ id, label, tone?, hint?, ask?, preview?, fields?,
// off? }` for the thread view, with `run(values, dryRun)` (the admin route it takes: `{ method,
// path, body }`), `done(answer, values)` (what came of it, markdown) and `previewed(answer)`
// (what a dry run says, markdown) here.

const reasonField = (label) => ({
  name: 'reason', label, type: 'text', max: 500,
});
const noteField = {
  name: 'note', label: 'Why it is meant (optional)', type: 'text', max: 300,
};

const CHANNEL_DONE = {
  moved: (r, n) => `filed under ${md(n.team(r.team))}; its threads are re-filed`,
  shared: (r, n) => `shared with ${md(n.team(r.team))}; it stays filed under ${md(n.team(r.channel.team))}`,
  assigned: (r, n) => `assigned to ${md(n.team(r.team))}; nothing to move yet`,
};

/** What a decided request's row says of it: by whom, and what came of it. */
function rowDecision(r, did = '') {
  const word = {
    confirmed: 'Confirmed', declined: 'Declined', withdrawn: 'Withdrawn', opened: 'Opened', merged: 'Merged', approved: 'Approved', ended: 'Ended', dismissed: 'Not partners',
  }[r.status] || r.status;
  const reason = r.reason ? `: ${md(r.reason)}` : '';
  return `**${word}** by ${md(who(r.decidedBy))}${did ? `: ${did}` : reason}`;
}

const channelKind = {
  list: (env) => listRequests(env, { limit: LIMIT }),
  get: (env, id) => getRequest(env, id),
  id: (r) => r.id,
  describe(r, n) {
    const c = r.channel;
    const name = chan(c);
    const team = n.team(r.team);
    const org = c.org && !c.org.startsWith('_') ? (c.orgName || n.org(c.org)) : '';
    const asks = r.move
      ? `move **${md(name)}** to **${md(team)}**: filed under it${c.team && c.team !== r.team ? ` instead of ${md(n.team(c.team))}` : ''}`
      : `add **${md(name)}** to **${md(team)}**'s inbox`;
    const facts = [
      `- ${platformOf(c)}, ${code(c.channelId)}`,
      `- Now ${c.team ? `filed under **${md(n.team(c.team))}**` : 'no threads yet'}${org ? `, customer **${md(org)}**` : ''}, ${plural(c.threads, 'thread')}`,
      `- For [${md(team)}](/inbox/admin?tab=teams&team=${encodeURIComponent(r.team)}&view=manage)`,
      r.thread ? `- Asked in [the sidebar of a thread](/inbox?team=${encodeURIComponent(c.team || r.team)}&t=${encodeURIComponent(r.thread)}) of this channel, through its agent` : '',
    ].filter(Boolean).join('\n');
    const open = r.status === 'open';
    return {
      title: `${r.move ? 'Move' : 'Add'} ${name} ${r.move ? 'to' : '→'} ${team}`,
      open,
      status: open ? 'waiting' : r.status,
      askedAt: r.requestedAt,
      askedBy: r.requestedBy,
      body: `Asks to ${asks}.${r.note ? `\n\n${quote(r.note)}` : ''}\n\n${facts}`,
      decidedAt: open ? null : r.decidedAt,
      decidedBy: r.decidedBy,
      decision: open ? null : rowDecision(r, r.status === 'confirmed' && CHANNEL_DONE[r.outcome] ? CHANNEL_DONE[r.outcome](r, n) : ''),
      actions: open ? [
        {
          id: 'confirm',
          label: 'Confirm',
          tone: 'accent',
          preview: true,
          hint: 'Assigns the channel to the team, as adding it on the team\'s page does.',
          run: (v, dryRun) => ({ method: 'POST', path: 'requests/confirm', body: { id: r.id, dryRun } }),
          previewed(a) {
            if (a.shared) {
              return `Shares ${md(name)} with ${md(team)}: it stays filed under ${md(n.team(a.shared.from))} (its folders, knowledge base and agents) and is in ${md(poss(team))} inbox too. Nothing moves.`;
            }
            if (!(a.moves || []).length) {
              return `Files ${md(name)} under ${md(team)} by hand (a channel-id rule with priority 10). It has no threads here yet, so nothing moves now.`;
            }
            return `Files ${md(name)} under ${md(team)} by hand (a channel-id rule with priority 10), and re-files:\n\n${movesText(a.moves, n)}`;
          },
          done: (a) => (a.shared
            ? `${md(name)} is in ${md(poss(team))} inbox too, and stays filed under ${md(n.team(a.shared.from))}.`
            : `${md(name)} is filed under ${md(team)}${(a.moves || []).length ? '; its threads are re-filed' : ''}.`),
        },
        {
          id: 'decline',
          label: 'Decline',
          tone: 'negative',
          fields: [reasonField('Reason, for whoever asked (optional)')],
          run: (v) => ({ method: 'POST', path: 'requests/decline', body: { id: r.id, reason: v.reason || undefined } }),
          done: () => `Declined ${md(name)} for ${md(team)}.`,
        },
      ] : [],
    };
  },
};

const memberKind = {
  list: (env) => listMemberRequests(env, { limit: LIMIT }),
  get: (env, id) => getMemberRequest(env, id),
  id: (r) => r.id,
  describe(r, n) {
    const p = r.person;
    const name = p.name || p.email;
    const team = n.team(r.team);
    const open = r.status === 'open';
    const facts = [
      `- ${md(p.email)}${p.id ? '' : ', new to the inbox'}`,
      `- Now ${p.teams.length ? `on ${md(p.teams.map(n.team).join(', '))}` : 'on no team'}`,
      `- For [${md(team)}](/inbox/admin?tab=teams&team=${encodeURIComponent(r.team)}&view=manage)`,
      r.thread ? `- Asked in [the sidebar of a thread](/inbox?t=${encodeURIComponent(r.thread)}), through its agent` : '',
    ].filter(Boolean).join('\n');
    const did = { added: `added to ${md(team)}`, member: `on ${md(team)} already` }[r.outcome] || '';
    return {
      title: `${name} → ${team}`,
      open,
      status: open ? 'waiting' : r.status,
      askedAt: r.requestedAt,
      askedBy: r.requestedBy,
      body: `Asks to add **${md(name)}** to **${md(team)}**.${r.note ? `\n\n${quote(r.note)}` : ''}\n\n${facts}`,
      decidedAt: open ? null : r.decidedAt,
      decidedBy: r.decidedBy,
      decision: open ? null : rowDecision(r, r.status === 'confirmed' ? did : ''),
      actions: open ? [
        {
          id: 'confirm',
          label: 'Confirm',
          tone: 'accent',
          hint: `Adds ${md(name)} to ${md(team)} as a member (a manager, when the team is self-managed), as adding them on the team's page does: they see its inbox.`,
          run: () => ({ method: 'POST', path: 'member-requests/confirm', body: { id: r.id } }),
          done: (a) => `${md(name)} is on ${md(team)}${a.request?.outcome === 'member' ? ' (already was)' : ''}.`,
        },
        {
          id: 'decline',
          label: 'Decline',
          tone: 'negative',
          fields: [reasonField('Reason, for whoever asked (optional)')],
          run: (v) => ({ method: 'POST', path: 'member-requests/decline', body: { id: r.id, reason: v.reason || undefined } }),
          done: () => `Declined ${md(name)} for ${md(team)}.`,
        },
      ] : [],
    };
  },
};

/** The message a new portal channel starts with, until whoever opens it writes their own. */
const welcomeText = (r, team) => `Welcome to Adobe Enterprise Support, ${r.company || r.domain}! This is your channel with the ${team} team. Start a new thread for each question, and we answer you here.`;

const portalKind = {
  list: (env) => listPortalRequests(env, { limit: LIMIT }),
  get: (env, id) => getPortalRequest(env, id),
  id: (r) => r.id,
  describe(r, n, { portalBound: bound = false } = {}) {
    const company = r.company || r.domain;
    const open = r.status === 'open';
    const techName = new Map(r.tech.map((t) => [t.tech, t.name]));
    const follows = new Map(r.teams.map((t) => [t.team, t]));
    const c = r.channel;
    const facts = [
      `- ${md(r.domain)}, ${md(r.requestedBy.email || '')}`,
      `- Uses ${r.tech.length ? r.tech.map((t) => `**${md(t.name)}**`).join(', ') : 'nothing they picked'}`,
      `- Followed by ${r.teams.length ? r.teams.map((t) => `${md(t.name)} (${md(t.tech.map((id) => techName.get(id) || id).join(', '))})`).join(', ') : 'no team: none follows these'}`,
      `- People: ${r.members.map((m) => `${md(m.name || m.email)}${m.joined ? '' : ' (invited)'}`).join(', ') || 'none yet'}`,
      c ? `- Channel filed under **${md(n.team(c.team))}**, customer **${md(n.org(c.org))}**` : '',
    ].filter(Boolean).join('\n');
    // The teams it may go to, those that follow what the customer picked first.
    const teams = [...n.teams].filter((t) => t.slug !== ADMIN_TEAM || follows.has(t.slug))
      .sort((a, b) => Number(follows.has(b.slug)) - Number(follows.has(a.slug)));
    const first = teams[0]?.slug || '';
    let openOff = teams.length ? null : 'There is no team to file it under.';
    if (!bound) {
      openOff = 'The customer portal is not connected to this inbox yet (PORTAL_WORKER): no channel can be opened from here.';
    }
    const why = (slug) => (follows.has(slug) ? ` (follows ${follows.get(slug).tech.map((id) => techName.get(id) || id).join(', ')})` : '');
    const actions = [];
    if (r.status !== 'declined') {
      actions.push({
        id: 'open',
        label: c ? 'Open another channel' : 'Open a channel',
        tone: 'accent',
        off: openOff,
        hint: 'The portal makes the channel, with everyone of the customer\'s lobby in it. It is filed under the team and the customer by hand (a channel-id rule with priority 10 each), and is in the other teams\' inboxes too. The welcome message is posted as you: the channel\'s first thread.',
        fields: [
          {
            name: 'name', label: 'Channel name', type: 'text', max: 80, required: true, value: c ? '' : r.suggest.name,
          },
          {
            name: 'org', label: `Customer${r.suggest.known ? `: ${r.suggest.orgName || r.suggest.org}` : ' (new)'}`, type: 'text', max: 63, required: true, value: c ? c.org : r.suggest.org,
          },
          {
            name: 'team',
            label: 'Team',
            type: 'select',
            value: first,
            options: teams.map((t) => ({ value: t.slug, label: `${t.name}${why(t.slug)}` })),
          },
          {
            name: 'share',
            label: 'Also in the inbox of',
            type: 'checks',
            value: [],
            options: teams.map((t) => ({ value: t.slug, label: t.name })),
          },
          {
            name: 'welcome',
            label: 'Welcome message, posted as you',
            type: 'textarea',
            max: MAX_FIELD,
            value: first ? welcomeText(r, n.team(first)) : '',
            // It names the team, until it is written by hand.
            by: { field: 'team', values: Object.fromEntries(teams.map((t) => [t.slug, welcomeText(r, t.name)])) },
          },
        ],
        run: (v) => ({
          method: 'POST',
          path: 'portal/open',
          body: {
            id: r.id,
            team: v.team,
            name: v.name,
            org: v.org,
            share: (v.share || []).filter((t) => t !== v.team),
            welcome: v.welcome,
          },
        }),
        done(a) {
          const also = (a.shared || []).length ? `, and in the inbox of ${md(a.shared.map(n.team).join(', '))}` : '';
          const said = a.welcome && a.welcome.error ? `; the welcome message was not posted (${md(a.welcome.error)})` : '';
          return `Opened #${md(a.channel?.name || '')} for ${md(company)}, filed under ${md(n.team(a.channel?.team))}${also}${said}.`;
        },
      });
    }
    if (open) {
      actions.push({
        id: 'decline',
        label: 'Decline',
        tone: 'negative',
        fields: [reasonField('Reason, for the customer (optional)')],
        run: (v) => ({ method: 'POST', path: 'portal/decline', body: { id: r.id, reason: v.reason || undefined } }),
        done: () => `Declined ${md(company)}.`,
      });
    }
    return {
      title: `${company} asks for a channel`,
      open,
      status: open ? 'waiting' : r.status,
      askedAt: r.requestedAt,
      askedBy: { ...r.requestedBy, customer: true },
      body: `Asks for a channel in the customer portal.${r.note ? `\n\n${quote(r.note)}` : ''}\n\n${facts}`,
      decidedAt: open ? null : r.decidedAt,
      decidedBy: r.decidedBy,
      decision: open ? null : rowDecision(r, r.status === 'opened' && c ? `filed under ${md(n.team(c.team))}` : ''),
      actions,
    };
  },
};

/** Where an integration request comes from: its host, and the product it calls its channels. */
const hostOf = (r) => (r.product ? `${r.host} (${r.product})` : r.host);

const integrationKind = {
  list: (env) => listIntegrationRequests(env, { limit: LIMIT }),
  get: (env, id) => getIntegrationRequest(env, id),
  id: (r) => r.id,
  describe(r, n, { portalBound: bound = false } = {}) {
    const person = r.name || r.email || 'Someone';
    const org = r.orgName || r.tenant || (r.email ? r.email.split('@')[1] : 'no organization');
    const open = r.status === 'pending';
    const m = r.mapping;
    const into = m && m.enabled;
    const caught = m && m.via ? ` (it lists ${m.via.startsWith('domain:') ? 'their mail domain' : 'their organization ID'} ${code(m.via.slice(m.via.indexOf(':') + 1))})` : '';
    const where = m
      ? `#${md(m.name)} ${code(m.channel)}${m.route && (m.route.team || m.route.org) ? `, filed under **${md(n.team(m.route.team))}**, customer **${md(n.org(m.route.org))}**` : ''}${m.enabled ? '' : ' (not enabled)'}${caught}`
      : '';
    const facts = [
      `- Host ${code(r.host)}${r.product ? `, product ${code(r.product)}` : ''}`,
      r.tenant ? `- Organization **${md(org)}** ${code(r.tenant)}${r.orgName ? '' : ' (its name was not readable)'}` : '- Signed in without an organization (a personal profile)',
      `- ${md(person)}, ${r.email ? `${md(r.email)} (verified)` : 'no verified mail address'}, user ${code(r.subject)}`,
      `- First asked ${md(String(r.requestedAt || '').slice(0, 16).replace('T', ' '))}${r.attempts > 1 ? `, ${plural(r.attempts, 'call')} since` : ''}`,
      into || m ? `- ${into ? 'Joins' : 'Its channel:'} ${where}` : '- New organization for this host: approving makes its channel',
    ].join('\n');
    const teams = n.teams.filter((t) => t.slug !== ADMIN_TEAM);
    const first = r.suggest.team || teams[0]?.slug || '';
    let off = null;
    if (!bound) {
      off = 'The customer portal is not connected to this inbox yet (PORTAL_WORKER): nobody can be enrolled from here.';
    } else if (m && !m.enabled && !m.resumable) {
      off = 'This organization\'s channel on the host is suspended, or was set up by hand and is not enabled: an operator enables it first.';
    } else if (!into && !teams.length) {
      off = 'There is no team to file its channel under.';
    }
    const personField = {
      name: 'person', label: 'Their name, as the channel shows it', type: 'text', max: 120, required: true, value: r.suggest.person,
    };
    const autoField = m && m.autoApprove ? [] : [{
      name: 'auto', label: 'Auto-approve future members of this organization', type: 'check', value: false,
    }];
    const fields = into ? [personField, ...autoField] : [
      {
        name: 'name', label: 'Channel name', type: 'text', max: 80, required: true, value: m ? m.name : r.suggest.name,
      },
      {
        name: 'org', label: `Customer${r.suggest.known ? `: ${r.suggest.orgName || r.suggest.org}` : ' (new)'}`, type: 'text', max: 63, required: true, value: (m && m.route && m.route.org) || r.suggest.org,
      },
      {
        name: 'team',
        label: 'Team',
        type: 'select',
        value: (m && m.route && m.route.team) || first,
        options: teams.map((t) => ({ value: t.slug, label: t.name })),
      },
      personField,
      ...autoField,
    ];
    const actions = open ? [
      {
        id: 'approve',
        label: into ? `Add to #${m.name}` : 'Approve',
        tone: 'accent',
        off,
        hint: into
          ? `Enrolls ${md(person)} in the channel ${md(org)} has on ${md(r.host)}: they see its threads and write there. Recorded as approved by you.`
          : 'Makes the organization\'s channel in the portal, files it under the team and the customer by hand (a channel-id rule with priority 10 each), then enrolls the person and enables the channel, in that order. Recorded as approved by you.',
        fields,
        run: (v) => ({
          method: 'POST',
          path: 'portal/integration/approve',
          body: {
            id: r.id,
            person: v.person,
            auto: Boolean(v.auto),
            ...(into ? {} : { name: v.name, org: v.org, team: v.team }),
          },
        }),
        done: (a) => `${md(person)} is enrolled in #${md(a.channel?.name || '')}${a.channel && !a.channel.existing ? `, filed under ${md(n.team(a.channel.team))}` : ''}${a.channel?.autoApprove ? '; its organization\'s next members are auto-approved' : ''}${a.autoError ? `; auto-approval was not turned on (${md(a.autoError)})` : ''}.`,
      },
      {
        id: 'decline',
        label: 'Decline',
        tone: 'negative',
        fields: [reasonField('Reason, which the person is shown (optional)')],
        run: (v) => ({ method: 'POST', path: 'portal/integration/decline', body: { id: r.id, reason: v.reason || undefined } }),
        done: () => `Declined ${md(person)}.`,
      },
    ] : [];
    const status = { pending: 'waiting', approved: 'approved', declined: 'declined' }[r.status] || r.status;
    return {
      title: `${person} (${org.length > 40 ? `${org.slice(0, 39).trim()}…` : org}) asks for ${r.product || r.host}`,
      open,
      status,
      askedAt: r.requestedAt,
      askedBy: { name: r.name, email: r.email, customer: true },
      body: `Asks to use Enterprise Support in ${md(hostOf(r))}, signed in with the host's identity provider, which verified who they are. Nobody has enrolled them yet.\n\n${facts}`,
      decidedAt: open ? null : r.decidedAt,
      decidedBy: r.decidedBy,
      decision: open ? null : rowDecision(r, r.status === 'approved' ? `enrolled${r.channel ? ` in ${code(r.channel)}` : ''}` : ''),
      actions,
    };
  },
};

/** How an auto-approved member was matched, in words. */
const viaText = (via) => {
  if (!via || via === 'tenant') {
    return 'the channel\'s organization';
  }
  const at = via.indexOf(':');
  const value = code(via.slice(at + 1));
  return via.startsWith('domain:') ? `the mail domain ${value}` : `the organization ID ${value}`;
};

const embedKind = {
  list: (env) => listIntegrationChannels(env),
  get: (env, id) => getIntegrationChannel(env, id),
  id: (c) => c.channel,
  describe(c, n, { portalBound: bound = false } = {}) {
    const route = c.route || {};
    const list = (xs) => (xs.length ? xs.map((x) => code(x.value)).join(', ') : 'none');
    const auto = c.autoApprove
      ? `**on**, set by ${md(c.autoBy || 'an admin')}${c.autoAt ? ` ${md(c.autoAt.slice(0, 10))}` : ''}`
      : `off${c.autoBy ? `, said ${md(c.autoBy)}` : ''}`;
    const facts = [
      `- Host ${code(c.host)}${c.product ? `, product ${code(c.product)}` : ''}, organization ${code(c.tenant)}`,
      `- Filed under **${md(n.team(route.team))}**, customer **${md(n.org(route.org))}**`,
      `- ${c.enabled ? 'Enabled' : '**Not enabled**: nobody is admitted or auto-approved'}${c.approvedBy ? `, approved by ${md(c.approvedBy)}` : ', set up by hand'}`,
      `- ${plural(c.members, 'member')}, ${c.autoMembers} of them auto-approved (${c.autoLastHour} in the last hour, of at most ${c.autoHourly})`,
      `- Auto-approval ${auto}`,
      `- Also catches organization IDs ${list(c.tenants)}; mail domains ${list(c.domains)}`,
    ].join('\n');
    const events = (c.autoApproved || []).filter((x) => x.at).map((x, i) => ({
      id: `auto-${x.at}-${i}`,
      at: x.at,
      body: `**Auto-approved** ${md(x.name || 'someone')}${x.email ? ` (${md(x.email)})` : ''} by ${viaText(x.via)}, a rule of ${md(x.by || 'an admin')}${x.active ? '' : '; revoked since'}`,
    }));
    return {
      title: `#${c.name} on ${c.host}`,
      open: false,
      status: (!c.enabled && 'disabled') || (c.autoApprove ? 'auto-approving' : 'by request'),
      // From the earliest it says: approved, enabled, auto-approving, or its first auto-approval.
      askedAt: [c.approvedAt, c.enabledAt, c.autoAt, ...events.map((e) => e.at)]
        .filter(Boolean).sort()[0] || null,
      askedBy: null,
      body: `A channel of the portal's integration, for an organization signed in through ${md(c.host)}. Its people get in by request, which the admin team approves, or, with auto-approval on, on their first call: whoever the host's identity provider says is of the channel's organization, of one of the organization IDs below, or has a verified address at one of the mail domains below, exactly (a subdomain only when listed).\n\n${facts}`,
      events,
      decidedAt: null,
      decidedBy: null,
      decision: null,
      actions: [{
        id: 'auto',
        label: 'Set auto-approval',
        tone: c.autoApprove ? undefined : 'accent',
        off: bound ? null : 'The customer portal is not connected to this inbox yet (PORTAL_WORKER).',
        hint: `On: a verified caller of ${md(c.host)} who lands here is enrolled on their first call (at most ${c.autoHourly} an hour; beyond, they wait as a request), recorded as auto-approved with the rule that matched. Off stops new ones; the members stay until revoked. An organization ID or domain belongs to one channel of the host; everyone's mail (gmail.com, outlook.com, …) catches nobody.`,
        fields: [
          {
            name: 'on', label: 'Auto-approve its members', type: 'check', value: c.autoApprove,
          },
          {
            name: 'tenants', label: 'Also these organization IDs (one a line)', type: 'textarea', rows: 2, max: 4000, value: c.tenants.map((x) => x.value).join('\n'),
          },
          {
            name: 'domains', label: 'And whoever has a verified address at these mail domains (one a line)', type: 'textarea', rows: 2, max: 4000, value: c.domains.map((x) => x.value).join('\n'),
          },
        ],
        run: (v) => ({
          method: 'PUT',
          path: 'portal/integration/auto',
          body: {
            channel: c.channel, on: Boolean(v.on), tenants: v.tenants, domains: v.domains,
          },
        }),
        done: (a) => {
          const x = a.channel || c;
          return `Auto-approval of #${md(x.name)} is ${x.autoApprove ? 'on' : 'off'}; it also catches ${list(x.tenants || [])} and ${list(x.domains || [])}.`;
        },
      }],
    };
  },
};

const pair = (a, b) => `pair:${a < b ? `${a}:${b}` : `${b}:${a}`}`;

const mergeKind = {
  list: (env, me) => listMergeRequests(env, me, { limit: LIMIT }),
  get: (env, id) => getMergeRequest(env, id),
  id: (r) => r.id,
  describe(r, n) {
    const from = n.org(r.from);
    const into = n.org(r.into);
    const open = r.status === 'open';
    return {
      title: `Merge ${from} into ${into}`,
      open,
      status: open ? 'waiting' : r.status,
      askedAt: r.requestedAt,
      askedBy: r.requestedBy,
      body: `Asks to merge **${md(from)}** ${code(r.from)} into **${md(into)}** ${code(r.into)}: one company, filed under the one from then on.${r.note ? `\n\n${quote(r.note)}` : ''}\n\n- [The two side by side](/inbox/admin?tab=orgs&org=${encodeURIComponent(pair(r.from, r.into))})`,
      decidedAt: open ? null : r.decidedAt,
      decidedBy: r.decidedBy,
      decision: open ? null : rowDecision(r),
      actions: open ? [
        {
          id: 'merge',
          label: `Merge ${from} into ${into}`,
          tone: 'accent',
          preview: true,
          ask: `Merge ${from} into ${into}?`,
          hint: `${md(from)} is filed under ${md(into)} from then on: its channels, its knowledge base's entries and its agents' set-up too. Undo on ${md(poss(into))} page moves its channels back.`,
          run: (v, dryRun) => ({ method: 'POST', path: 'org-merge', body: { from: r.from, into: r.into, dryRun } }),
          previewed: (a) => ((a.moves || []).length
            ? `Moves ${plural(a.moves.length, 'channel')}:\n\n${movesText(a.moves, n)}`
            : 'No channel moves.') + (a.kb && a.kb.entries ? `\n\nCopies what of the ${plural(a.kb.entries, 'entry', 'entries')} of its knowledge base ${md(poss(into))} has not.` : ''),
          done: (a) => `Merged ${md(from)} into ${md(into)}${(a.moves || []).length ? `; ${plural(a.moves.length, 'channel')} re-filed` : ''}.`,
        },
        {
          id: 'decline',
          label: 'Decline',
          tone: 'negative',
          fields: [reasonField('Reason, for whoever asked (optional)')],
          run: (v) => ({ method: 'POST', path: 'org-merge-requests/decline', body: { id: r.id, reason: v.reason || undefined } }),
          done: () => `Declined the merge of ${md(from)} into ${md(into)}.`,
        },
      ] : [],
    };
  },
};

/** A date as the threads say it: `2026-10-24`, `2026-10`, the day of an ISO time. */
const dayOf = (s) => String(s || '').slice(0, 10);
/** A date field's value: a month is its first day, as a date input takes it. */
const dateValue = (s) => (s && s.length === 7 ? `${s}-01` : s || '');

/** A customer's other partner, as a partner request's thread lists it. */
function otherLine(o, n) {
  let what = 'likely, says Clef';
  if (o.until) {
    what = `a former partner, until ${o.until}`;
  } else if (o.confirmed) {
    what = 'confirmed';
  } else if (o.p !== null) {
    what = `${Math.round(o.p * 100)}% likely, says Clef`;
  }
  const seen = o.last ? `, its people last posted ${dayOf(o.last)}` : '';
  return `  - **${md(o.name || n.org(o.slug))}** ${code(o.slug)}: ${what}${seen}`;
}

/** The pair as it is now, for a partner request's thread. */
function pairNow(r) {
  const x = r.pair;
  if (!x) {
    return 'nothing links them in the inbox yet';
  }
  if (x.dismissed) {
    return `not partners, dismissed by ${md(x.dismissed.by)}`;
  }
  if (x.until) {
    return `a former partner, until ${x.until}`;
  }
  if (x.confirmed) {
    return `confirmed by ${md(x.confirmed.by)}${x.since ? `, since ${x.since}` : ''}`;
  }
  return x.p === null ? 'not decided, and Clef has not said yet' : `not decided; Clef says ${Math.round(x.p * 100)}%`;
}

/**
 * A partner request (src/partnerrequests.js): that a partner works for a customer, or no longer
 * does, with the pair as it is now, the customer's other partners and what Clef found; decided
 * through the routes of the Customers page (src/orgpartners.js), which close it.
 */
const partnerKind = {
  async list(env, me) {
    const list = await listPartnerRequests(env, me, { limit: LIMIT });
    const others = await otherPartners(env, [...new Set(list.map((r) => r.customer))], LIKELY);
    return list.map((r) => ({
      ...r, others: (others.get(r.customer) || []).filter((o) => o.slug !== r.partner),
    }));
  },
  async get(env, id) {
    const r = await getPartnerRequest(env, id);
    if (!r) {
      return null;
    }
    const others = await otherPartners(env, [r.customer], LIKELY);
    return { ...r, others: (others.get(r.customer) || []).filter((o) => o.slug !== r.partner) };
  },
  id: (r) => r.id,
  describe(r, n) {
    const P = n.org(r.partner);
    const C = n.org(r.customer);
    const open = r.status === 'open';
    const again = r.action === 'link' && r.pair && r.pair.until;
    let title = `${P} works for ${C}?`;
    if (r.action === 'end') {
      title = `${P} no longer works for ${C}?`;
    } else if (again) {
      title = `${P} works for ${C} again?`;
    }
    const asks = r.action === 'end'
      ? `Asks to record that **${md(P)}** ${code(r.partner)} no longer works for **${md(C)}** ${code(r.customer)}: a former partner of theirs${r.until ? `, until ${r.until}` : ''}.`
      : `Asks to confirm that **${md(P)}** ${code(r.partner)} works for **${md(C)}** ${code(r.customer)}${r.since ? `, since ${r.since}` : ''}: a partner of theirs, for everyone at Adobe.`;
    const thread = r.thread ? `/inbox?team=${encodeURIComponent(r.threadTeam || ADMIN_TEAM)}&t=${encodeURIComponent(r.thread)}` : null;
    let source = '';
    if (r.requestedBy.kind === 'agent' && thread) {
      source = `\n\nThe agent read it in [a thread](${thread}).`;
    } else if (r.viaAgent && thread) {
      source = `\n\nAsked in [the sidebar of a thread](${thread}), through its agent.`;
    }
    const x = r.pair;
    const facts = [
      `- Now: ${pairNow(r)}`,
      x && x.first ? `- ${md(poss(P))} people in ${md(poss(C))} threads: first ${dayOf(x.first)}, last ${dayOf(x.last)}, as far back as the inbox reads` : '',
      r.others.length ? `- ${md(poss(C))} other partners:\n${r.others.map((o) => otherLine(o, n)).join('\n')}` : `- No other partner of ${md(C)} is known.`,
      `- [What links them](/inbox/admin?tab=orgs&org=${encodeURIComponent(`partner:${r.customer}:${r.partner}`)})`,
    ].filter(Boolean).join('\n');
    const both = { customer: r.customer, partner: r.partner };
    const decline = (label, hint) => ({
      id: 'decline',
      label,
      tone: r.action === 'end' ? undefined : 'negative',
      hint,
      fields: [reasonField('Reason, for whoever asked (optional)')],
      run: (v) => ({ method: 'POST', path: 'org-partner-requests/decline', body: { id: r.id, reason: v.reason || undefined } }),
      done: () => 'Declined; the pair stays as it is.',
    });
    const link = [
      {
        id: 'confirm',
        label: again ? 'A partner again' : 'Confirm',
        tone: 'accent',
        hint: `Everyone at Adobe sees ${md(P)} as a partner of ${md(C)}, whatever Clef says.`,
        fields: [{
          name: 'since', label: 'Since (optional)', type: 'date', value: dateValue(r.since),
        }],
        run: (v) => ({ method: 'POST', path: 'org-partners/confirm', body: { ...both, since: v.since || undefined } }),
        done: (a, v) => `Confirmed ${md(P)} as a partner of ${md(C)}${v.since ? `, since ${v.since}` : ''}.`,
      },
      {
        id: 'dismiss',
        label: 'Not partners',
        tone: 'negative',
        hint: `Nobody at Adobe sees ${md(P)} as a partner of ${md(C)}, whatever Clef says.`,
        run: () => ({ method: 'POST', path: 'org-partners/dismiss', body: both }),
        done: () => `${md(P)} is no partner of ${md(C)}.`,
      },
      decline('Decline', 'Leaves the pair as it is.'),
    ];
    const end = [
      {
        id: 'end',
        label: 'End',
        tone: 'accent',
        hint: `${md(P)} is listed as a former partner of ${md(C)}, until then.`,
        fields: [{
          name: 'until', label: 'Until', type: 'date', value: dateValue(r.until), required: true,
        }],
        run: (v) => ({ method: 'POST', path: 'org-partners/end', body: { ...both, until: v.until } }),
        done: (a, v) => `${md(P)} is a former partner of ${md(C)}, until ${v.until}.`,
      },
      {
        id: 'dismiss',
        label: 'Not partners',
        tone: 'negative',
        hint: `It never was: nobody at Adobe sees ${md(P)} as a partner of ${md(C)}, now or before.`,
        run: () => ({ method: 'POST', path: 'org-partners/dismiss', body: both }),
        done: () => `${md(P)} is no partner of ${md(C)}.`,
      },
      decline('Still a partner', `Leaves ${md(P)} a partner of ${md(C)}.`),
    ];
    const person = r.requestedBy.kind === 'person' ? r.requestedBy : null;
    let actions = [];
    if (open) {
      actions = r.action === 'end' ? end : link;
    }
    return {
      title,
      open,
      status: open ? 'waiting' : r.status,
      askedAt: r.requestedAt,
      askedBy: person,
      ...(person ? {} : { author: { name: r.requestedBy.name, kind: 'app', staff: true } }),
      body: `${asks}${r.note ? `\n\n${quote(r.note)}` : ''}${source}\n\n${facts}`,
      decidedAt: open ? null : r.decidedAt,
      decidedBy: r.decidedBy,
      decision: open ? null : rowDecision(r),
      actions,
    };
  },
};

const botName = (b) => b.displayName || b.name || b.handle || b.id;

const botKind = {
  async list(env) {
    const { bots } = await (await listBots(env)).json();
    // A bot only mentioned changes nothing in the inbox: listed once somebody said whose it is.
    return bots.filter((b) => b.messages > 0 || b.ours !== null);
  },
  async get(env, key) {
    const res = await getBot(env, key);
    if (!res.ok) {
      return null;
    }
    const { bot, recent } = await res.json();
    return { ...bot, recent };
  },
  id: (b) => b.key,
  describe(b, n) {
    const name = botName(b);
    const open = b.ours === null && b.messages > 0;
    const where = b.channel && (b.source === 'teams' ? [b.group, b.channel].filter(Boolean).join(' › ') : `#${b.channel}`);
    const recent = (b.recent || []).map((m) => {
      const ch = m.channel && (b.source === 'teams' ? [m.group, m.channel].filter(Boolean).join(' › ') : `#${m.channel}`);
      return `${quote(m.preview || '(no text)')}\n>\n> — ${ch ? `${md(ch)}, ` : ''}[open the thread](/inbox?team=${encodeURIComponent(m.team)}&t=${encodeURIComponent(m.thread)})`;
    }).join('\n\n');
    const facts = [
      `- ${b.messages ? `${plural(b.messages, 'message')} in ${plural(b.threads, 'thread')}` : 'Mentioned only'}${where ? `, the latest in ${md(where)}${b.org ? ` (${md(n.org(b.org))})` : ''}` : ''}`,
      b.handle && b.handle !== b.name ? `- Mentioned as @${md(b.handle)}` : '',
      `- ${code(b.id)}`,
      b.alerts ? '- Only posts alerts: the threads it starts are alerts' : '',
    ].filter(Boolean).join('\n');
    const said = b.ours === null ? null
      : `**${b.ours ? 'Adobe\'s' : 'External'}**, said ${md(b.oursBy || 'an admin')}`;
    const ours = (value) => ({
      id: value ? 'ours' : 'external',
      label: value ? 'Adobe\'s' : 'External',
      tone: value ? 'accent' : undefined,
      pressed: b.ours === value,
      hint: value ? 'Its messages show on Adobe\'s side, as your colleagues\' do, the ones it wrote before too. They stay a bot\'s: not an answer to the customer, and the agents read them as every bot\'s.'
        : 'Its messages show on the customer\'s side.',
      run: () => ({ method: 'PUT', path: 'bots', body: { key: b.key, ours: value } }),
      done: () => (value ? `${md(name)} is Adobe's.` : `${md(name)} is external.`),
    });
    return {
      title: name,
      open,
      status: open ? 'waiting' : ({ true: 'adobe', false: 'external' })[b.ours] || 'mentioned',
      askedAt: null,
      askedBy: null,
      body: `A ${PLATFORM[b.source] || b.source} bot. Whose is it, Adobe's or external? Bots have no mail address, which is how the inbox tells Adobe people from customers, so the admin team says it.\n\n${facts}${recent ? `\n\nIts latest messages:\n\n${recent}` : ''}`,
      decidedAt: b.oursAt,
      decidedBy: b.oursBy ? { email: b.oursBy } : null,
      decision: said,
      actions: [
        ours(true),
        ours(false),
        {
          id: 'alerts',
          label: b.alerts ? 'Posts more than alerts' : 'Only posts alerts',
          hint: b.alerts ? 'The threads it starts are conversations again, where their channel is one.'
            : 'The threads it starts are alerts, also in a channel of conversations: counted, not unread, and no agent works them.',
          run: () => ({ method: 'PUT', path: 'bots', body: { key: b.key, alerts: !b.alerts } }),
          done: (a) => `${md(name)} ${b.alerts ? 'posts more than alerts' : 'only posts alerts'} now${a.refile ? ': re-filing the threads it started' : ''}.`,
        },
        {
          id: 'look',
          label: 'Name and picture',
          hint: `The inbox shows these instead of the ones from ${PLATFORM[b.source] || b.source}, on the messages it wrote before too; left empty, the platform's. The picture is the https URL of an image.`,
          fields: [
            {
              name: 'name', label: 'Name', type: 'text', max: 80, value: b.displayName || '',
            },
            {
              name: 'avatar', label: 'Picture', type: 'text', max: 500, value: b.displayAvatar || '',
            },
          ],
          run: (v) => ({
            method: 'PUT', path: 'bots', body: { key: b.key, name: v.name || null, avatar: v.avatar || null },
          }),
          done: (a) => `${md(name)} shows as ${md(botName(a.bot || b))}${a.bot?.displayAvatar ? ', with its picture' : ''}.`,
        },
      ],
    };
  },
};

const accountKind = {
  async list(env) {
    return (await (await listAccounts(env)).json()).accounts;
  },
  async get(env, key) {
    return (await this.list(env)).find((a) => a.key === key) || null;
  },
  id: (a) => a.key,
  describe(a) {
    const name = a.name || a.email || a.id;
    const open = !a.person;
    const person = a.person && (a.person.name || a.person.email);
    return {
      title: `${name}, admin account`,
      open,
      status: open ? 'waiting' : 'linked',
      askedAt: null,
      askedBy: null,
      body: `An admin account of the Teams tenant that hosts the teams: Adobe's, so its messages show on Adobe's side, but it is named by initials, and nothing in Teams says whose it is. Whose is it?\n\n- ${code(a.email || a.id)}\n- ${a.messages ? plural(a.messages, 'message') : 'No messages yet'}`,
      decidedAt: a.linkedAt,
      decidedBy: a.linkedBy ? { email: a.linkedBy } : null,
      decision: person ? `**Linked to ${md(person)}**, said ${md(a.linkedBy || 'an admin')}` : null,
      actions: [
        {
          id: 'link',
          label: person ? 'Someone else\'s' : 'Link',
          tone: person ? undefined : 'accent',
          hint: 'The inbox then shows it as them, with their name and picture, the messages it wrote before too.',
          fields: [{
            name: 'email', label: 'The mail address of the colleague who uses it', type: 'email', max: 200, required: true,
          }],
          run: (v) => ({ method: 'PUT', path: 'accounts', body: { key: a.key, email: v.email } }),
          done: (r) => `${md(name)} is ${md(r.account?.person?.name || r.account?.person?.email || 'theirs')}'s.`,
        },
        ...(person ? [{
          id: 'unlink',
          label: 'Nobody\'s',
          run: () => ({ method: 'PUT', path: 'accounts', body: { key: a.key, email: null } }),
          done: () => `${md(name)} is nobody's.`,
        }] : []),
      ],
    };
  },
};

/** One side of a pair of accounts, as its thread lists it. */
function sideText(s, n) {
  const where = s.orgs.slice(0, 4).map((o) => `${md(n.org(o.org))} (${o.n})`).join(', ');
  return `- **${md(s.name)}**, ${PLATFORM[s.source] || md(s.source)}, ${s.mails.length ? s.mails.map(code).join(', ') : 'no mail address'}${s.keys.length > 1 ? `, ${plural(s.keys.length, 'account')}` : ''}\n  ${s.messages ? `${plural(s.messages, 'message')}${where ? `, for ${where}` : ''}${s.orgs.length > 4 ? ' and more' : ''}, the latest ${md(String(s.last).slice(0, 10))}` : 'No messages'}`;
}

const personKind = {
  list: (env) => listAccountPairs(env),
  async get(env, id) {
    return (await listAccountPairs(env)).find((p) => p.id === id) || null;
  },
  id: (p) => p.id,
  describe(p, n) {
    // As the busier of the two writes it.
    const { name } = p.b.messages > p.a.messages ? p.b : p.a;
    const open = p.same === null;
    const shared = p.orgs.length
      ? `Both posted for ${md(p.orgs.map(n.org).join(', '))}.`
      : 'They posted for different customers.';
    const say = (same) => ({
      id: same ? 'same' : 'apart',
      label: same ? 'One person' : 'Two people',
      tone: same ? 'accent' : undefined,
      pressed: p.same === same,
      hint: same ? 'The customers\' overviews and the topic map count the two as one person, with the name of the first.'
        : 'They stay two people, and this is not asked again.',
      run: () => ({ method: 'PUT', path: 'account-pairs', body: { a: p.a.key, b: p.b.key, same } }),
      done: () => (same ? `${md(name)}: one person.` : `${md(name)}: two people.`),
    });
    return {
      title: `${name}: one person?`,
      open,
      status: open ? 'waiting' : ({ true: 'one person', false: 'two people' })[p.same],
      askedAt: null,
      askedBy: null,
      body: `Two accounts outside Adobe are named **${md(name)}**, with different mail addresses: one person (a new job, the agency's address and the customer's, a second address), or two? Accounts of one mail address are one already; a name alone merges nobody. ${shared}\n\n${sideText(p.a, n)}\n${sideText(p.b, n)}`,
      decidedAt: p.decidedAt,
      decidedBy: p.decidedBy ? { email: p.decidedBy } : null,
      decision: open ? null : `**${p.same ? 'One person' : 'Two people'}**, said ${md(p.decidedBy || 'an admin')}`,
      actions: [
        say(true),
        say(false),
        ...(open ? [] : [{
          id: 'undo',
          label: 'Ask again',
          hint: 'Takes back what was said: they count as two until someone says otherwise.',
          run: () => ({ method: 'PUT', path: 'account-pairs', body: { a: p.a.key, b: p.b.key, same: null } }),
          done: () => `${md(name)}: asked again.`,
        }]),
      ],
    };
  },
};

const FIELD_NAMES = {
  name: 'name', description: 'what Clef is asked', layer: 'layer', product: 'product', enabled: 'on or off',
};
const techTitle = (c) => (c.kind === 'diverging' ? `${c.tech}: ${c.fields.map((x) => FIELD_NAMES[x] || x).join(', ')}`
  : `"${c.name}": ${c.techs.join(', ')}`);
const keptDecision = (c) => (c.kept ? `**Kept as it is**, said ${md(c.kept.by)}${c.kept.note ? `: ${md(c.kept.note)}` : ''}` : null);

const techKind = {
  list: (env) => techConflicts(env),
  async get(env, key) {
    return (await techConflicts(env)).find((c) => c.key === key) || null;
  },
  id: (c) => c.key,
  describe(c, n) {
    const what = c.kind === 'diverging'
      ? `${plural(c.definitions.length, 'team')} define ${code(c.tech)} otherwise (${md(c.fields.map((x) => FIELD_NAMES[x] || x).join(', '))}). Each team's is what Clef asks in its channels. Keep it if that is meant, or use one of them everywhere.`
      : `"${md(c.name)}" is a name or alias of ${c.techs.map((t) => `${code(t)}`).join(' and ')}: a thread that names it matches either. Take it off the aliases of one, merge them into one technology, or keep it.`;
    const defs = c.definitions.map((d) => `- **${md(d.name)}** ${code(d.tech)}, ${md(poss(n.team(d.team)))}${d.enabled ? '' : ' (turned off)'}: ${md(d.description)}${d.product ? `, product ${md(d.product)}` : ''}${d.layer ? `, layer ${md(d.layer)}` : ''}${d.aliases.length ? `, also called ${md(d.aliases.join(', '))}` : ''}${d.path ? `, [${md(d.path)}](/inbox/admin?tab=teams&team=${encodeURIComponent(d.team)}&view=kb&path=${encodeURIComponent(d.path)})` : ''}`).join('\n');
    const settle = (id, label, body, done, extra = {}) => ({
      id,
      label,
      run: (v) => ({ method: 'POST', path: 'conflicts', body: { key: c.key, ...body, ...v } }),
      done: () => done,
      ...extra,
    });
    const k = c.kind === 'name' ? c.key.slice('name:'.length) : null;
    const norm = (a) => a.toLowerCase().replace(/[^a-z0-9.+#@]+/g, ' ').trim();
    const actions = [];
    if (!c.kept) {
      actions.push(settle('keep', 'Keep as it is', { action: 'keep' }, 'Kept as it is.', { fields: [noteField] }));
    }
    for (const d of c.definitions) {
      const team = n.team(d.team);
      if (c.kind === 'diverging') {
        actions.push(settle(`use:${d.team}`, `Use ${poss(team)} everywhere`, { action: 'use', team: d.team }, `${md(c.tech)} is ${md(poss(team))} everywhere.`, {
          tone: 'accent', ask: `Use ${poss(team)} ${c.tech} everywhere?`, hint: 'The other teams\' files and rows of it are deleted.',
        }));
      }
      if (k && d.aliases.some((a) => norm(a) === k)) {
        actions.push(settle(`unalias:${d.team}:${d.tech}`, `Take "${c.name}" off ${poss(team)} ${d.tech}`, { action: 'unalias', team: d.team, tech: d.tech }, `"${md(c.name)}" is not an alias of ${md(d.tech)} any more.`));
      }
      if (c.kind === 'name' && d.path) {
        for (const t of c.techs.filter((x) => x !== d.tech)) {
          actions.push(settle(`merge:${t}:${d.tech}`, `Merge ${t} into ${d.tech}`, { action: 'merge', from: t, into: d.tech }, `Merged ${md(t)} into ${md(d.tech)}.`, {
            ask: `Merge ${t} into ${d.tech}?`, hint: `Every file of ${md(t)} goes, and what was labeled, followed or detected as ${md(t)} becomes ${md(d.tech)}, for good.`,
          }));
        }
      }
      actions.push(settle(`delete:${d.team}:${d.tech}`, `Delete ${poss(team)} ${d.tech}`, { action: 'delete', team: d.team, tech: d.tech }, `Deleted ${md(poss(team))} ${md(d.tech)}.`, {
        tone: 'negative', ask: `Delete ${poss(team)} ${d.tech}?`, hint: 'Its file (or row) goes; Clef asks the others\' where they are.',
      }));
    }
    // Two actions of one id (a team defines a name twice) would be one: the first stays.
    const seen = new Set();
    return {
      title: techTitle(c),
      open: !c.kept,
      status: c.kept ? 'kept' : 'waiting',
      askedAt: null,
      askedBy: null,
      body: `${what}\n\n${defs}\n\nSettling it writes the teams' catalog files as you (or the rows saved in D1). A merge also rewrites the labels, follows, rules and lobbies that name the technology that goes: that cannot be undone by reverting the file.`,
      decidedAt: c.kept ? c.kept.at : null,
      decidedBy: c.kept ? { email: c.kept.by } : null,
      decision: keptDecision(c),
      actions: actions.filter((a) => !seen.has(a.id) && seen.add(a.id)),
    };
  },
};

const FIELD_LABELS = {
  name: 'channel name', group_name: 'Teams team', channel_id: 'channel id', shared_team: 'Slack Connect team', org: 'customer',
};
const ruleText = (x, n) => {
  const r = x.rules[0];
  return `${md(poss(n.team(x.team)))} rule (${md(FIELD_LABELS[r.field] || r.field)} ${code(r.pattern)}${r.source ? `, ${md(r.source)} only` : ''}, priority ${r.priority})`;
};

const ruleKind = {
  list: (env) => ruleConflicts(env),
  async get(env, key) {
    return (await ruleConflicts(env)).find((c) => c.key === key) || null;
  },
  id: (c) => c.key,
  describe(c, n) {
    const count = plural(c.channels.length, 'channel');
    const wins = [[c.b, c.b.wins], [c.a, c.a.wins]].filter(([, k]) => k)
      .map(([x, k]) => `${n.team(x.team)} ${k === c.channels.length ? 'files them' : `files ${k}`}`).join(', ') || 'another rule files them';
    const channels = c.channels.slice(0, SHOWN_CHANNELS).map((ch) => `- ${md(chan(ch))} (${platformOf(ch)}), filed under ${md(n.team(ch.winner))}`).join('\n')
      + (c.channels.length > SHOWN_CHANNELS ? `\n- and ${c.channels.length - SHOWN_CHANNELS} more` : '');
    const neither = !c.win.a.ok && !c.win.b.ok;
    const win = (side) => {
      const w = c.win[side];
      const winner = c[side];
      const loser = c[side === 'a' ? 'b' : 'a'];
      const wn = n.team(winner.team);
      const ln = n.team(loser.team);
      const rule = w.empty
        ? `${md(poss(ln))} rule matches no other channel: it goes${w.follow ? ', or becomes the follow rule' : ''}.`
        : `${md(poss(ln))} rule leaves ${md(poss(wn))} out: its pattern becomes ${code(w.pattern)}.`;
      return {
        id: `win:${side}`,
        label: `${wn} wins`,
        tone: 'accent',
        preview: true,
        ask: `${wn} wins?`,
        hint: `${md(wn)} files the channels both match. ${rule}`,
        fields: w.follow ? [{
          name: 'follow', label: `${ln} follows them: they are in ${poss(ln)} inbox too`, type: 'check', value: true,
        }] : [],
        run: (v, dryRun) => ({
          method: 'POST',
          path: 'rule-conflicts',
          body: {
            key: c.key, fingerprint: c.fingerprint, action: 'win', side, follow: Boolean(w.follow && v.follow), dryRun,
          },
        }),
        previewed(a) {
          const moves = a.moves || [];
          const list = a.follows || [];
          return `${moves.length ? `Moves ${plural(moves.length, 'channel')}:\n\n${movesText(moves, n)}` : 'No channel moves.'}${list.length ? `\n\n${md(ln)} follows ${plural(list.length, 'channel')}.` : ''}`;
        },
        done: (a, v) => `${md(wn)} files them${w.follow && v.follow ? `, ${md(ln)} follows them` : ''}.${(a.moves || []).length ? ` Re-filing ${plural(a.moves.length, 'channel')}.` : ''}`,
      };
    };
    const actions = [];
    if (!c.kept) {
      actions.push({
        id: 'keep',
        label: 'Keep as it is',
        fields: [noteField],
        run: (v) => ({
          method: 'POST',
          path: 'rule-conflicts',
          body: {
            key: c.key, fingerprint: c.fingerprint, action: 'keep', note: v.note || undefined,
          },
        }),
        done: () => 'Kept as it is.',
      });
    }
    actions.push(...['a', 'b'].filter((s) => c.win[s].ok).map(win));
    return {
      title: `${n.team(c.a.team)} and ${n.team(c.b.team)}: rules overlap`,
      open: !c.kept,
      status: c.kept ? 'kept' : 'waiting',
      askedAt: null,
      askedBy: null,
      body: `${ruleText(c.a, n)} and ${ruleText(c.b, n)} both match ${count}. The lowest priority decides: now ${md(wins)}.${neither ? `\n\nNeither can win by a change of its pattern: ${md(c.win.a.why)}. Change the rules on the teams' pages, or keep it as it is.` : ''}\n\n${channels}\n\nSettling it changes the rules as you, and re-files the channels it moves, as a change on a team's page does. Channels assigned by hand are in no conflict: the assignment decides them.`,
      decidedAt: c.kept ? c.kept.at : null,
      decidedBy: c.kept ? { email: c.kept.by } : null,
      decision: keptDecision(c),
      actions,
    };
  },
};

const PURPOSE = {
  runbook: 'a runbook it is writing', reply: 'a reply to the customer', fact: 'a fact for the knowledge base',
};
const QUESTION_DONE = {
  answered: 'Answered', passed: 'Passed on', unknown: 'Did not know', expired: 'Expired',
};
/** The value of a choice's option that says none of them: the answer is in the text below it. */
const OTHER = '';

/** What was answered to question `q`, as its thread says it: a line for each question. */
function answersText(q) {
  return q.items.map((item, i) => {
    const a = q.answers[i] || {};
    const said = [a.pick ? `**${md(a.pick)}**` : '', a.text ? md(a.text.replace(/\s+/g, ' ')) : ''].filter(Boolean).join(': ');
    return `${i + 1}. ${md(item.text)} ${said || '_no answer_'}`;
  }).join('\n');
}

/** What the person answered, from the answer form's values: one per question. */
const answersOf = (q, v) => q.items.map((item, i) => ({
  ...(v[`pick${i}`] ? { pick: v[`pick${i}`] } : {}),
  ...(v[`text${i}`] ? { text: v[`text${i}`] } : {}),
}));

/**
 * Tells the agent of question `q`'s thread how it ended (`answerNote`), and notes that it was
 * told. Best effort: a question the agent was not told about stays closed, and says so.
 */
async function tellAgent(env, q, by) {
  if (!env.AGENTS) {
    return { error: 'agents are not configured' };
  }
  try {
    const agent = await agentStub(env, q.thread);
    const res = await agent.answered({ id: q.id, text: answerNote(q, by) });
    if (res && res.error) {
      return { error: res.error };
    }
    await markTold(env, q.id);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

const questionKind = {
  list: (env, me) => listQuestions(env, { email: me.email, limit: LIMIT }),
  async get(env, id, me) {
    const q = await getQuestion(env, id);
    return q && me && q.person.email === String(me.email || '').toLowerCase() ? q : null;
  },
  id: (q) => q.id,
  describe(q) {
    const open = q.status === 'open';
    const link = `/inbox?team=${encodeURIComponent(q.team)}&t=${encodeURIComponent(q.thread)}`;
    const items = q.items.map((item, i) => `${i + 1}. **${md(item.text)}**${item.guess ? `\n   My guess: ${md(item.guess)}` : ''}`).join('\n');
    const facts = [
      `- From [${md(q.title || 'a thread')}](${link})`,
      q.sidebar ? `- Asked while it answered ${md(q.askedFor || 'someone')} in the thread's sidebar` : '',
      open ? `- Waits for you until ${q.deadline.slice(0, 10)}; the answer goes to the agent only, never to the customer` : '',
    ].filter(Boolean).join('\n');
    const fields = q.items.flatMap((item, i) => [
      ...(item.choices ? [{
        name: `pick${i}`,
        label: item.text,
        type: 'select',
        value: item.guess || item.choices[0],
        options: [...item.choices.map((c) => ({ value: c, label: c === item.guess ? `${c} (the agent's guess)` : c })), { value: OTHER, label: 'Something else: say it below' }],
      }] : []),
      {
        name: `text${i}`,
        label: item.choices ? 'In your words (optional)' : item.text,
        type: 'textarea',
        rows: item.choices ? 1 : 3,
        max: 2000,
      },
    ]);
    const close = (status, values = {}) => ({
      status,
      answers: status === 'answered' ? answersOf(q, values) : [],
      note: values.note || '',
      passedTo: values.who || '',
    });
    const act = (status) => async (env, me, values) => {
      const shut = close(status, values);
      if (status === 'answered' && !shut.answers.some((a) => a.pick || a.text)) {
        return { error: 'answer at least one of the questions', status: 400 };
      }
      if (!await closeQuestion(env, q.id, shut)) {
        return { error: 'it is not waiting any more: answered meanwhile, or expired', status: 409 };
      }
      const told = await tellAgent(env, await getQuestion(env, q.id), me.name || me.email);
      return { ok: true, told };
    };
    const told = (a) => (a.told && a.told.error ? ` The agent was not told (${md(a.told.error)}): tell it in the thread's sidebar.` : ' The agent goes on with it.');
    let decision = null;
    if (!open) {
      const then = QUESTION_DONE[q.status] || q.status;
      const how = {
        answered: `\n\n${answersText(q)}`,
        passed: q.passedTo ? `: ask ${md(q.passedTo)}` : '',
        expired: ': nobody answered it in time',
      }[q.status] || '';
      decision = `**${then}**${how}${q.note ? `\n\n${quote(q.note)}` : ''}`;
    }
    return {
      title: q.title ? `Question on ${q.title}` : 'A question from a thread agent',
      team: q.team,
      author: { name: 'Thread agent', kind: 'app', staff: true },
      open,
      status: open ? 'asked' : q.status,
      askedAt: q.askedAt,
      askedBy: null,
      body: `The thread's agent asks you, for ${PURPOSE[q.purpose]}:\n\n${quote(q.why)}\n\n${items}\n\n${facts}`,
      decidedAt: q.decidedAt || (q.status === 'expired' ? q.deadline : null),
      decidedBy: null,
      // What they answered is theirs to say, as a reply in the thread; an expiry is the inbox's.
      answeredBy: q.status === 'expired' ? null : q.person,
      decision,
      actions: open ? [
        {
          id: 'answer',
          label: 'Answer',
          tone: 'accent',
          hint: 'Pick or correct each guess. The agent gets your answer as yours, trusted, and finishes what it asked for with it.',
          fields: [...fields, {
            name: 'note', label: 'Anything else it should know (optional)', type: 'textarea', rows: 2, max: 1000,
          }],
          act: act('answered'),
          done: (a) => `Sent to the agent.${told(a)}`,
        },
        {
          id: 'pass',
          label: 'Ask someone else',
          hint: 'The agent asks whom you name, when they are on the team.',
          fields: [
            {
              name: 'who', label: 'Who knows (a name or an address)', type: 'text', max: 200, required: true,
            },
            {
              name: 'note', label: 'Anything else (optional)', type: 'text', max: 500,
            },
          ],
          act: act('passed'),
          done: (a) => `Passed on.${told(a)}`,
        },
        {
          id: 'unknown',
          label: 'I don\'t know',
          tone: 'negative',
          hint: 'The agent does not ask you about it again, and leaves the gap open.',
          fields: [{
            name: 'note', label: 'Who might know, or why nobody does (optional)', type: 'text', max: 500,
          }],
          act: act('unknown'),
          done: (a) => `Told the agent.${told(a)}`,
        },
      ] : [],
    };
  },
};

const KIND = {
  channel: channelKind,
  member: memberKind,
  portal: portalKind,
  integration: integrationKind,
  embed: embedKind,
  merge: mergeKind,
  partner: partnerKind,
  bot: botKind,
  account: accountKind,
  person: personKind,
  tech: techKind,
  rule: ruleKind,
  question: questionKind,
};

// ---- the log and the times ---------------------------------------------------------------------

/** The log of `keys` (null: of every request), oldest first, by key. */
async function logOf(env, keys = null) {
  const { results } = await env.DB.prepare(`SELECT id, request, type, body, person, author_name,
      author_email, at FROM request_log
    WHERE ${keys ? 'request IN (SELECT value FROM json_each(?1))' : "request >= 'request:' AND request < 'request;'"}
    ORDER BY at, id`).bind(...(keys ? [JSON.stringify(keys)] : [])).all();
  const by = new Map();
  for (const r of results || []) {
    by.set(r.request, [...(by.get(r.request) || []), r]);
  }
  return by;
}

/**
 * The kinds without a time of their own, as `request_threads` has them, after noting what the
 * listing found (`found`: `{ key, kind, d }`, every tracked kind's): when each was first seen
 * waiting, and the conflicts that are gone since (`closed_at`), unless the listing is not
 * `complete` (a kind's list failed). A conflict waiting again is open again, from then on.
 * Writes only what changed.
 */
async function track(env, found, { complete = true } = {}) {
  const { results } = await env.DB.prepare('SELECT * FROM request_threads').all();
  const rows = new Map((results || []).map((r) => [r.request, r]));
  const at = now();
  const writes = [];
  const seen = new Set();
  for (const { key, d } of found) {
    seen.add(key);
    const row = rows.get(key);
    if (!row && d.open) {
      writes.push(env.DB.prepare(`INSERT OR IGNORE INTO request_threads (request, title, opened_at)
        VALUES (?, ?, ?)`).bind(key, d.title, at));
      rows.set(key, {
        request: key, title: d.title, opened_at: at, closed_at: null,
      });
    } else if (row && (row.closed_at || row.title !== d.title)) {
      writes.push(env.DB.prepare(`UPDATE request_threads SET title = ?, closed_at = NULL,
          opened_at = CASE WHEN closed_at IS NULL THEN opened_at ELSE ? END WHERE request = ?`)
        .bind(d.title, at, key));
      rows.set(key, {
        ...row, title: d.title, closed_at: null, opened_at: row.closed_at ? at : row.opened_at,
      });
    }
  }
  for (const row of complete ? rows.values() : []) {
    const parsed = parseRequestKey(row.request);
    if (parsed && COMPUTED.has(parsed.kind) && !seen.has(row.request) && !row.closed_at) {
      writes.push(env.DB.prepare(`UPDATE request_threads SET closed_at = ?
        WHERE request = ? AND closed_at IS NULL`).bind(at, row.request));
      row.closed_at = at;
    }
  }
  if (writes.length) {
    await env.DB.batch(writes);
  }
  return rows;
}

// ---- threads -----------------------------------------------------------------------------------

/** A request's messages: the request, its decision as its row says it, and the log. */
function messagesOf(key, d, log, {
  staff, me, tracked, gone = false,
}) {
  const author = (p, extra = {}) => ({
    name: who(p), kind: 'person', staff: !p?.customer && staff(p?.email), ...extra,
  });
  const out = [];
  const asked = d.askedAt || tracked?.opened_at || d.decidedAt || (log[0] && log[0].at) || now();
  out.push({
    thread: key,
    id: 'request',
    at: asked,
    source: 'request',
    author: d.author || (d.askedBy ? author(d.askedBy) : { name: 'Enterprise Support', kind: 'app', staff: true }),
    // The inbox's own, with its icon (src/icons.js).
    avatar: d.askedBy ? null : '/icon.svg',
    body: d.body,
    reactions: [],
  });
  // The row's decision, unless the log has the decisions (a bot's, an account's, a conflict's,
  // decided here since the log began).
  const logged = log.some((x) => x.type === 'decision');
  if (d.decision && d.decidedAt && !logged) {
    const by = d.answeredBy;
    out.push({
      thread: key,
      id: 'decision',
      at: d.decidedAt,
      source: 'request',
      author: by ? author(by) : { kind: 'system', name: '' },
      body: d.decision,
      ...(by ? { mine: by.email === String(me.email || '').toLowerCase() } : {}),
      reactions: [],
    });
  }
  // What happened to it that nobody decided here (a channel's auto-approvals).
  for (const e of d.events || []) {
    out.push({
      thread: key, id: e.id, at: e.at, source: 'request', author: { kind: 'system', name: '' }, body: e.body, reactions: [],
    });
  }
  for (const x of log) {
    const decision = x.type === 'decision';
    out.push({
      thread: key,
      id: `log-${x.id}`,
      at: x.at,
      source: 'request',
      author: decision ? { kind: 'system', name: '' } : {
        name: x.author_name || x.author_email || 'someone', kind: 'person', staff: true,
      },
      body: decision ? `**${md(x.author_name || x.author_email || 'Someone')}**: ${x.body}` : x.body,
      mine: !decision && x.person === me.id,
      person: x.person,
      reactions: [],
    });
  }
  if (gone) {
    out.push({
      thread: key, id: 'gone', at: tracked.closed_at, source: 'request', author: { kind: 'system', name: '' }, body: 'No longer a conflict: settled, or its rules or definitions changed.', reactions: [],
    });
  }
  // The request first, whatever the times say (a decision recorded before it was asked).
  const [first, ...rest] = out;
  return [first, ...rest.sort((a, b) => String(a.at).localeCompare(String(b.at)))];
}

/** Whether a mail address is Adobe's. */
const staffOf = (env) => (email) => Boolean(email) && isStaffDomain(env, email);

/**
 * An inbox entry of request `key`, as src/api.js `inbox` shapes a thread's. A question that waits
 * has the agent's purple badge (`sideNew`, as an answer of the agent's in a sidebar has), until
 * it is answered.
 */
function entryOf(key, kind, d, messages) {
  const asks = PERSONAL.has(kind) && d.open;
  const shown = messages.filter((m) => m.author.kind !== 'system');
  const last = messages[messages.length - 1];
  const lastSaid = shown[shown.length - 1];
  const at = latest(messages.map((m) => m.at));
  const people = [];
  for (const m of shown) {
    if (!people.some((p) => p.name === m.author.name) && people.length < 5) {
      people.push({
        name: m.author.name, staff: Boolean(m.author.staff), avatar: m.avatar || null, key: null,
      });
    }
  }
  return {
    thread: key,
    source: 'request',
    org: `_request-${kind}`,
    org_name: KIND_NAMES[kind],
    org_type: null,
    org_icon: null,
    team: d.team || ADMIN_TEAM,
    kind: 'channel',
    channel_name: KIND_NAMES[kind],
    title: d.title,
    root_at: messages[0].at,
    last_at: at,
    any_at: at,
    last_author: last.author.kind === 'system' ? '' : last.author.name,
    last_staff: 1,
    // As plain as the platforms' previews are: without the escapes of `md`.
    last_text: (last.author.kind === 'system' ? last : lastSaid || last).body
      .replace(/\\([\\`*_[\]<>~|])/g, '$1').slice(0, 300),
    messages: messages.length,
    imported: 0,
    root_known: 1,
    logical_thread: null,
    permalink: null,
    label: {
      label_kind: 'request', urgency: 1, next_actor: d.open ? 'us' : null, resolved_p: d.open ? 0 : 1, topics: [],
    },
    participants: people,
    staffPosted: true,
    customerDomain: null,
    reactions: [],
    tech: [],
    posters: [...new Set(messages.map((m) => m.person).filter(Boolean))],
    mentioned: [],
    signals: [],
    resolution: { verdict: d.open ? 'open' : 'resolved', state: d.open ? 'open' : 'resolved' },
    waiting_on: d.open ? 'us' : 'nobody',
    draft: null,
    members: [{ thread: key, last_at: at, any_at: at }],
    request: { kind, status: d.status, open: d.open },
    ...(asks ? { sideNew: [key] } : {}),
  };
}

/**
 * The watermarks of the requests' threads: everyone's who is staff or on the admin team, whose
 * reads count (`in_team`); a question's, whoever it asks, whose inbox has it.
 */
async function marksOf(env, keys) {
  if (!keys.length) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT w.person, w.thread, w.read_at, p.staff,
      (EXISTS (SELECT 1 FROM team_members m WHERE m.person = w.person AND m.team = ?1)
        OR (w.thread >= 'request:question:' AND w.thread < 'request:question;')) AS in_team
    FROM watermarks w JOIN people p ON p.id = w.person
    WHERE w.thread >= 'request:' AND w.thread < 'request;'
      AND w.thread IN (SELECT value FROM json_each(?2))`).bind(ADMIN_TEAM, JSON.stringify(keys)).all();
  return results || [];
}

/** A gone conflict's `d`, from what `request_threads` kept of it. */
const goneOf = (row) => ({
  title: row.title,
  open: false,
  status: 'gone',
  askedAt: row.opened_at,
  askedBy: null,
  body: `**${md(row.title)}**`,
  decidedAt: row.closed_at,
  decision: null,
  actions: [],
});

/**
 * GET /api/requests: the admin team's requests as entries of its inbox (`threads`, shaped as
 * src/api.js `inbox` shapes a thread's, with `request: { kind, status, open }`), every one that
 * waits and the latest decided of each kind, with the viewer's read state.
 */
export async function requestEntries(env, me, { mine = false } = {}) {
  const n = await names(env);
  const bound = portalBound(env);
  // The admin team's kinds only for one of its members, in its inbox; what `request_threads`
  // tracks of them is read and written only then (a personal listing has none of them, so it
  // would take every tracked conflict for gone).
  const admins = !mine && isAdmin(me);
  const kinds = Object.entries(KIND).filter(([kind]) => PERSONAL.has(kind) || admins);
  const lists = await Promise.all(kinds.map(async ([kind, k]) => {
    try {
      return (await k.list(env, me)).map((r) => ({ kind, id: k.id(r), r }));
    } catch (e) {
      console.error(JSON.stringify({ route: 'requests', kind, error: e.message }));
      return null;
    }
  }));
  const items = lists.flat().filter(Boolean).map((x) => ({
    ...x, key: requestKey(x.kind, x.id), d: KIND[x.kind].describe(x.r, n, { portalBound: bound }),
  }));
  // A list that failed leaves its conflicts where they were: not gone.
  const complete = lists.every(Boolean);
  const tracked = admins
    ? await track(env, items.filter((x) => TRACKED.has(x.kind)), { complete }) : new Map();
  const shown = new Set(items.map((x) => x.key));
  const gone = [...tracked.values()].filter((row) => row.closed_at && !shown.has(row.request))
    .map((row) => ({
      ...parseRequestKey(row.request), key: row.request, d: goneOf(row), gone: true,
    }))
    .filter((x) => x.kind);
  const all = [...items, ...gone];
  const log = await logOf(env);
  const staff = staffOf(env);
  const entries = all.map((x) => entryOf(x.key, x.kind, x.d, messagesOf(
    x.key,
    x.d,
    log.get(x.key) || [],
    {
      staff, me, tracked: tracked.get(x.key), gone: x.gone,
    },
  )));
  const marks = await marksOf(env, entries.map((e) => e.thread));
  return { threads: readState(entries, marks, [], me.id) };
}

/** `{ kind, id, key, r, d }` of request `key` as it is now, or null. */
async function findRequest(env, me, key) {
  const parsed = parseRequestKey(key);
  if (!parsed || (!PERSONAL.has(parsed.kind) && !isAdmin(me))) {
    return null;
  }
  const k = KIND[parsed.kind];
  const r = await k.get(env, parsed.id, me);
  const n = await names(env);
  if (r) {
    return {
      ...parsed, key, r, n, d: k.describe(r, n, { portalBound: portalBound(env) }),
    };
  }
  const row = await env.DB.prepare('SELECT * FROM request_threads WHERE request = ?').bind(key).first();
  if (row && COMPUTED.has(parsed.kind)) {
    return {
      ...parsed,
      key,
      r: null,
      n,
      d: goneOf({ ...row, closed_at: row.closed_at || now() }),
      gone: true,
      tracked: row,
    };
  }
  return null;
}

/** An action as the thread view gets it: what it shows, not how it runs. */
const shownAction = (a) => Object.fromEntries(Object.entries(a)
  .filter(([, v]) => typeof v !== 'function'));

/**
 * GET /api/thread?thread=request:…: request `key` as a thread (`thread`, `messages`, the
 * watermarks, `request` with its `actions`), for the admin team; null when there is none.
 */
export async function requestThread(env, me, key) {
  const x = await findRequest(env, me, key);
  if (!x) {
    return null;
  }
  const [logs, tracked] = await Promise.all([
    logOf(env, [key]),
    x.tracked ? x.tracked : env.DB.prepare('SELECT * FROM request_threads WHERE request = ?').bind(key).first(),
  ]);
  const messages = messagesOf(key, x.d, logs.get(key) || [], {
    staff: staffOf(env), me, tracked, gone: x.gone,
  });
  const entry = entryOf(key, x.kind, x.d, messages);
  const { results: marks } = await env.DB.prepare(`SELECT w.person, w.read_at FROM watermarks w
    WHERE w.thread = ?`).bind(key).all();
  return {
    thread: entry,
    members: [],
    messages,
    watermarks: (marks || []).map((w) => ({ ...w, thread: key })),
    request: {
      kind: x.kind,
      kindName: KIND_NAMES[x.kind],
      status: x.d.status,
      open: x.d.open,
      actions: x.d.actions.map(shownAction),
    },
    can_work: true,
    can_post: true,
  };
}

/** The values of `fields` from `given`, as each field takes them. */
function valuesOf(fields = [], given = {}) {
  const out = {};
  for (const f of fields) {
    const v = given ? given[f.name] : undefined;
    const options = new Set((f.options || []).map((o) => o.value));
    if (f.type === 'check') {
      out[f.name] = v === undefined ? Boolean(f.value) : Boolean(v);
    } else if (f.type === 'checks') {
      out[f.name] = (Array.isArray(v) ? v : []).map(String).filter((x) => options.has(x));
    } else if (f.type === 'select') {
      out[f.name] = options.has(String(v)) ? String(v) : f.value;
    } else {
      out[f.name] = clean(v, f.max || 200);
    }
  }
  return out;
}

/** Writes `body` to request `key`'s log, as `me`. */
async function logEntry(env, me, key, type, body) {
  const at = now();
  await env.DB.prepare(`INSERT INTO request_log (request, type, body, person, author_name,
      author_email, at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(key, type, body, me.id || null, me.name || null, me.email || null, at).run();
  return at;
}

/**
 * Request `key`'s thread as it is now that `me` decided it, read by them up to its end: what they
 * decided is the thread's latest message, and theirs, so it is not unread for them once the room
 * says it changed (as a note of theirs is not).
 */
async function decidedThread(env, me, key) {
  const thread = await requestThread(env, me, key);
  const at = thread && thread.thread.last_at;
  if (!at || !me.id || me.readonly) {
    return thread;
  }
  await advanceWatermark(env.DB, me.id, key, at, 'post');
  const others = thread.watermarks.filter((w) => w.person !== me.id);
  const mine = thread.watermarks.find((w) => w.person === me.id);
  const readAt = mine && mine.read_at > at ? mine.read_at : at;
  return {
    ...thread,
    watermarks: [...others, {
      ...mine, person: me.id, read_at: readAt, thread: key,
    }],
  };
}

const announce = (env, key, x = null) => {
  const parsed = parseRequestKey(key);
  const teams = x && x.d && x.d.team ? [x.d.team] : [];
  return parsed ? announceRequest(env, parsed.kind, parsed.id, { teams }) : null;
};

/**
 * POST /api/requests/note `{ key, text }`: what `me` writes in request `key`'s thread, its
 * decision log; it is read by them up to it. Answers with the thread as it is now.
 */
export async function addNote(env, me, body) {
  const key = clean(body && body.key, 600);
  const text = clean(body && body.text, MAX_NOTE);
  if (!text) {
    return json({ error: 'write something' }, 400);
  }
  const x = await findRequest(env, me, key);
  if (!x) {
    return json({ error: 'no such request' }, 404);
  }
  const at = await logEntry(env, me, key, 'note', text);
  await advanceWatermark(env.DB, me.id, key, at, 'post');
  console.log(JSON.stringify({ route: 'requests', note: x.kind, by: me.id }));
  await announce(env, key, x);
  return json({ ok: true, thread: await requestThread(env, me, key) });
}

/**
 * POST /api/requests/resolve `{ key, action, values?, dryRun? }`: decides request `key` as `me`,
 * by one of the actions its thread offers now (`action`, its id), with the values of its fields:
 * the admin route the action takes runs as `me` (src/admin.js). `dryRun` asks what it would do,
 * where the action can be tried (`preview`): `{ ok, preview }`, markdown. Decided, `{ ok, done,
 * thread }`; refused, `{ error, thread }` with the route's status.
 */
export async function resolveRequest(env, me, body) {
  const key = clean(body && body.key, 600);
  const x = await findRequest(env, me, key);
  if (!x) {
    return json({ error: 'no such request: it may be settled already' }, 404);
  }
  const action = x.d.actions.find((a) => a.id === clean(body.action, 600));
  if (!action) {
    return json({ error: 'that cannot be decided now: look at the request again', thread: await requestThread(env, me, key) }, 409);
  }
  if (action.off) {
    return json({ error: action.off }, 409);
  }
  const dryRun = Boolean(body.dryRun);
  if (dryRun && !action.preview) {
    return json({ error: 'this cannot be tried first' }, 400);
  }
  const values = valuesOf(action.fields, body.values || {});
  const missing = (action.fields || []).find((f) => f.required && !values[f.name]);
  if (missing) {
    return json({ error: `give the ${missing.label.toLowerCase()}` }, 400);
  }
  if (action.act) {
    if (me.readonly) {
      return json({ error: 'read-only while viewing as someone else' }, 403);
    }
    const done = await action.act(env, me, values);
    if (done.error) {
      await announce(env, key, x);
      const thread = await requestThread(env, me, key);
      return json({ error: done.error, thread }, done.status || 409);
    }
    // Read up to the decision before the room says the thread changed.
    const thread = await decidedThread(env, me, key);
    await announce(env, key, x);
    console.log(JSON.stringify({
      route: 'requests', resolved: x.kind, action: action.id, by: me.id,
    }));
    return json({ ok: true, done: action.done(done, values), thread });
  }
  const call = action.run(values, dryRun || undefined);
  const url = new URL(`https://opspile.internal/api/admin/${call.path}`);
  const res = await admin(new Request(url, {
    method: call.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(call.body),
  }), env, url, me);
  const answer = await res.json().catch(() => ({}));
  if (dryRun) {
    return res.ok ? json({ ok: true, preview: action.previewed(answer) })
      : json({ error: answer.error || `could not try it (${res.status})` }, res.status);
  }
  if (!res.ok) {
    await announce(env, key);
    return json({
      error: answer.error || `failed (${res.status})`, thread: await requestThread(env, me, key),
    }, res.status);
  }
  const done = action.done(answer, values);
  if (LOGGED.has(x.kind)) {
    await logEntry(env, me, key, 'decision', done);
  }
  console.log(JSON.stringify({
    route: 'requests', resolved: x.kind, action: action.id.split(':')[0], by: me.id,
  }));
  // Read up to the decision before the room says the thread changed.
  const thread = await decidedThread(env, me, key);
  await announce(env, key);
  return json({ ok: true, done, thread });
}

/** Whether `me` may see the requests' threads and decide them: the admin team. */
export const mayDecide = (me) => isAdmin(me);

/** The team whose room has request `key`'s reads: a question's thread's team, else the admin's. */
export async function readRoom(env, me, key) {
  const x = await findRequest(env, me, key);
  if (!x) {
    return null;
  }
  return x.d.team || ADMIN_TEAM;
}
