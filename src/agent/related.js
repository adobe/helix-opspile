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

import { entryRows, vectorOf } from '../expertise.js';
import { platformName } from '../platforms.js';
import { queryVector } from '../search.js';
import {
  entryLinks, linkedOrgs, RELATED_DAYS, similarIn,
} from '../threadlinks.js';
import { agentEnabled } from './enabled.js';
import { modelProblem } from './model.js';
import { readable } from './watches.js';

/**
 * What a thread agent is told of its thread's links across a partner and its customers
 * (src/threadlinks.js): the customers a partner's thread is about, the partners in a customer's,
 * and the threads possibly about the same issue in their channels. In its first input
 * (src/agent/delivery.js), in an input of its own when one is found (`relatedUpdate`), and on
 * asking (`related_threads`, src/agent/tools.js). A linked thread is named, with its title, only
 * where the agent may read it with its tools (`readable`: its channel, `org_threads` within its
 * customer, `any_thread`); of the others it hears how many there are, and nothing more.
 */

/** Similarity a thread needs for `related_threads`: to this thread's vector, to a query's. */
export const TOOL_MIN = 0.7;
export const QUERY_MIN = 0.6;
const MAX_TOOL = 10;
const MAX_DAYS = 90;

export const LINKED_GUIDE = 'A linked organization\'s thread is for the team: never post what it says in'
  + ' this channel, or that it exists, unless someone asks you to in the sidebar; say in your note'
  + ' when it matters for this thread.';

const pct = (p) => `${Math.round(p * 100)}%`;
const names = (list) => list.map((o) => (o.name ? `${o.name} (${o.slug})` : o.slug)).join(', ');
const one = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);

/** The keys of the agent's entry. */
const keysOf = (t) => (t.threads && t.threads.length ? t.threads : [t.key]).filter(Boolean);

/** A linked thread the agent may read, in a line. */
function line(r) {
  const where = `${r.org_name || r.org}'s ${platformName(r.source)} channel #${r.channel_name || 'unknown'}`;
  const sure = `${(r.via || []).includes('owner') ? ', both name the same repository owner' : ''}${r.p != null ? `, Clef ${pct(r.p)}` : ''}`;
  return `- ${r.thread} | ${one(r.title) || '(untitled)'} | ${where} | last ${r.last_at || 'unknown'}`
    + ` | similarity ${r.score}${sure}${r.permalink ? ` | ${r.permalink}` : ''}`;
}

/**
 * The note of the agent's thread's links (target `t`), or '' where it has none: who it is about
 * or with, and the threads possibly about the same issue.
 */
export async function relatedNote(env, t) {
  if (!t || !t.key) {
    return '';
  }
  const links = await entryLinks(env, keysOf(t), async (k) => Boolean(await readable(env, t, k)));
  const lines = [];
  if (links.about.length) {
    lines.push(`This partner's thread is about the customer ${names(links.about)}`
      + ` (${links.about.map((o) => `${o.via.join(', ') || 'clef'}, ${pct(o.p)}`).join('; ')}).`);
  }
  if (links.with.length) {
    lines.push(`People of the partner ${names(links.with)} (an agency or system integrator) post in this thread.`);
  }
  if (links.related.length) {
    const may = links.related.filter((r) => r.can_see);
    const not = links.related.length - may.length;
    lines.push(`Possibly the same issue, in the channels of linked organizations (found by meaning; read them with read_any_thread before you rely on them):${may.length ? `\n${may.map(line).join('\n')}` : ''}`);
    if (not) {
      lines.push(`${not} more in channels you may not read: the team sees ${not === 1 ? 'it' : 'them'} in the inbox.`);
    }
  }
  if (!lines.length) {
    return '';
  }
  return `${lines.join('\n')}\n${LINKED_GUIDE}`;
}

/**
 * ThreadAgent.relatedUpdate (src/threadlinks.js): its thread got a customer it is about
 * (`{ kind: 'about', orgs }`) or a thread possibly about the same issue (`{ kind: 'related',
 * other }`); the agent is told, with all of its links as they are, unless it is off.
 */
export async function relatedUpdate(agent, change) {
  const { env } = agent;
  const t = await agent.target();
  if (!t.key || t.kind !== 'channel' || modelProblem(env) || !await agentEnabled(env, t.channelId, t.team)) {
    return { result: 'skip', reason: 'no agent' };
  }
  const note = await relatedNote(env, t);
  if (!note) {
    return { result: 'skip', reason: 'nothing shown' };
  }
  const lead = change.kind === 'about'
    ? 'The inbox found which customer this thread is about.'
    : 'The inbox found a thread possibly about the same issue in a linked organization\'s channel.';
  await agent.syncTools();
  await agent.syncMcp();
  await agent.harness.submit(`${lead} Look at it only if it changes what the team should do here; otherwise change nothing.\n\n${note}`, {
    operationId: `related:${change.kind}:${change.other || [].concat(change.orgs || []).join(',')}`,
    whenBusy: 'followUp',
  });
  console.log(JSON.stringify({
    route: 'agent', related: 'told', kind: change.kind, team: t.team,
  }));
  return { result: 'told' };
}

/**
 * related_threads: the threads of the linked orgs' channels like the agent's thread (or
 * `query`), of the last `days`, with those the inbox kept as possibly the same issue; named
 * where the agent may read them, counted otherwise.
 */
export async function relatedThreads(env, t, { query = '', days = RELATED_DAYS } = {}) {
  const keys = keysOf(t);
  const orgs = await linkedOrgs(env, { keys, org: t.org, type: t.orgType });
  if (!orgs.length) {
    return t.orgType === 'partner' || t.orgType === 'customer'
      ? `No linked organization: the inbox knows no ${t.orgType === 'partner' ? 'customer this partner works for' : 'partner of this customer'} yet.`
      : 'Only a partner\'s and a customer\'s threads are linked: this channel is neither\'s.';
  }
  const span = Math.max(1, Math.min(MAX_DAYS, Math.floor(Number(days) || RELATED_DAYS)));
  const q = String(query || '').trim();
  let vector = null;
  if (env.CONTENT) {
    vector = q ? await queryVector(env, q) : await vectorOf(env, await entryRows(env, t.key));
  }
  const [found, kept] = await Promise.all([
    similarIn(env, vector, orgs, {
      skip: keys, days: span, min: q ? QUERY_MIN : TOOL_MIN, customer: t.orgType === 'customer' ? t.org : null,
    }),
    entryLinks(env, keys, async (k) => Boolean(await readable(env, t, k))),
  ]);
  const keptKeys = new Set(kept.related.map((r) => r.thread));
  const fresh = found.filter((f) => !keptKeys.has(f.key)).slice(0, MAX_TOOL);
  const rows = fresh.length ? (await env.DB.prepare(`SELECT t.thread, t.org, t.source, t.channel_name,
      t.last_at, COALESCE(l.title, t.title) AS title, o.name AS org_name,
      (SELECT m.permalink FROM messages m WHERE m.thread = t.thread AND m.permalink IS NOT NULL
        ORDER BY m.at LIMIT 1) AS permalink
    FROM threads t LEFT JOIN labels l ON l.thread = t.thread LEFT JOIN orgs o ON o.slug = t.org
    WHERE t.thread IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(fresh.map((f) => f.key))).all()).results || [] : [];
  const byKey = new Map(rows.map((r) => [r.thread, r]));
  const may = [];
  let not = kept.related.filter((r) => !r.can_see).length;
  for (const f of fresh) {
    const r = byKey.get(f.key);
    // eslint-disable-next-line no-await-in-loop
    if (r && await readable(env, t, f.key)) {
      may.push({ ...r, score: f.score, p: null });
    } else if (r) {
      not += 1;
    }
  }
  const out = [`Linked organizations: ${orgs.length}. Threads of their channels active in the last ${span} days${q ? ` about "${q}"` : ' like this one'}, most alike first.`];
  const shown = kept.related.filter((r) => r.can_see);
  if (shown.length) {
    out.push(`Kept as possibly the same issue:\n${shown.map(line).join('\n')}`);
  }
  if (may.length) {
    out.push(`Alike by meaning:\n${may.map(line).join('\n')}`);
  }
  if (not) {
    out.push(`${not} more in channels you may not read: the team sees what the inbox kept of them.`);
  }
  if (!shown.length && !may.length && !not) {
    out.push('None found.');
  }
  return `${out.join('\n')}\n${LINKED_GUIDE}`;
}
