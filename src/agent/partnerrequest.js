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

import { LIKELY } from '../orgpartners.js';
import { askOrAdd, markActive } from '../partnerrequests.js';
import { linkedMessage } from './history.js';
import { readable } from './watches.js';

/**
 * `request_partner_link` (src/agent/tools.js): an agent asks the admin team to decide whether a
 * partner works for a customer (`link`), no longer does (`end`), or to look at a pair that seems
 * wrong or uncertain (`review`), from what a thread says ("we have moved to another agency", "they
 * no longer support our site") or what the person it talks to tells it; or records that a pair
 * still works together (`active`), which decides nothing. Every action takes evidence: threads and
 * messages it may read, each with why. Unlike moving a channel or adding someone to a team, a
 * thread's agent may file one on its own: nothing changes until the admin team decides, in its
 * inbox, where the request says who asked, links the thread and its evidence, and shows what the
 * inbox knows of the two. For the person in its sidebar, or in a knowledge base's conversation, it
 * files it as theirs. A request of the pair that waits takes the evidence instead of a second one
 * (src/partnerrequests.js `askOrAdd`).
 */

const MAX_ITEMS = 10;

/** How an agent is named where it asks on its own. */
export function agentName(t) {
  if (t.channelName) {
    return `The agent of a thread in #${t.channelName}`;
  }
  return t.org ? `The agent of ${t.orgName || t.org}'s knowledge base` : 'An agent';
}

/**
 * An item of evidence (`{ ref?, why }`) as the request keeps it, `{ thread, message, link, why }`,
 * or `{ error }`: `ref` is a thread key, a thread key and a message id (`<thread>|<id>`, as
 * get_thread and read_thread name messages), or a link to a message; none is the agent's own
 * thread. Only what the agent may read (`readable`, its own thread always) is evidence.
 */
export async function evidenceItem(env, t, item) {
  const why = String((item && item.why) || '').trim();
  if (!why) {
    return { error: 'say `why` of every item of evidence' };
  }
  const ref = String((item && item.ref) || '').trim();
  let thread = null;
  let message = null;
  if (!ref) {
    thread = t.key || null;
  } else if (ref.includes('|') && !/^https?:/.test(ref)) {
    [thread, message] = [ref.slice(0, ref.indexOf('|')), ref.slice(ref.indexOf('|') + 1)];
  } else if (/^https?:/.test(ref)) {
    // By its channel and ids, as resolveAnyThread reads a link (by index: no scan of permalinks).
    const m = await linkedMessage(env, ref);
    [thread, message] = m ? [m.thread, m.message] : [null, null];
  } else {
    thread = ref;
  }
  const row = thread && await env.DB.prepare(`SELECT thread, COALESCE(logical_thread, thread) AS entry
    FROM threads WHERE thread = ?`).bind(thread).first();
  if (!row) {
    return { error: `no thread has the key or link ${ref || '(your thread)'}` };
  }
  const own = t.key && (row.thread === t.key || row.entry === t.key);
  if (!own && !await readable(env, t, row.entry).catch(() => null)) {
    return { error: `you may not read ${ref}: cite only threads you may read` };
  }
  const link = message
    ? await env.DB.prepare('SELECT permalink FROM messages WHERE thread = ? AND id = ?').bind(row.thread, message).first()
    : await env.DB.prepare(`SELECT permalink FROM messages WHERE thread = ? AND permalink IS NOT NULL
      ORDER BY at LIMIT 1`).bind(row.thread).first();
  if (message && !link) {
    return { error: `no message ${message} in thread ${row.thread}` };
  }
  return {
    thread: row.entry, message: message || null, link: (link && link.permalink) || null, why,
  };
}

/**
 * Files the request, or adds its evidence to one that waits: `t` is the agent's target (its
 * thread, customer, channel), `asker` the person it asks for (`{ email, name }`, from its sidebar
 * or conversation) or null (its own), `args` the tool's. The customer and the partner default to
 * the thread's org, by its type. `{ request, added? }`, `{ active }` for `active`, or `{ error,
 * request? }` (the open one that asks the same).
 */
export async function requestPartnerLink(env, t, asker, args) {
  const own = String(t.org || '').startsWith('_') ? '' : String(t.org || '');
  const theirs = t.orgType === 'partner';
  const customer = String(args.customer || (theirs ? '' : own)).trim().toLowerCase();
  const partner = String(args.partner || (theirs ? own : '')).trim().toLowerCase();
  if (!customer || !partner) {
    return { error: `give the ${customer ? 'partner' : 'customer'} (its slug, as find_channels or the thread shows it)` };
  }
  const note = String(args.note || '').trim();
  if (!note) {
    return { error: 'say why in `note`: what the thread or the person said, and where' };
  }
  const items = [].concat(args.evidence || []).slice(0, MAX_ITEMS);
  if (!items.length) {
    return { error: 'give `evidence`: the thread or messages that show it, each with why (`ref` left out is your thread)' };
  }
  const evidence = [];
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    const e = await evidenceItem(env, t, item);
    if (e.error) {
      return { error: e.error };
    }
    evidence.push(e);
  }
  const by = asker && asker.email ? { email: asker.email, name: asker.name || null }
    : { agent: true, name: agentName(t) };
  if (args.action === 'active') {
    const res = await markActive(env, by, { customer, partner }, evidence, { likely: LIKELY });
    return res.error ? { error: res.error } : {
      active: {
        customer, partner, withdrawn: res.withdrawn, quiet: res.quiet, evidence: evidence.length,
      },
    };
  }
  const res = await askOrAdd(env, by, {
    customer, partner, action: args.action, since: args.since, until: args.until, note,
  }, { thread: t.key || null, evidence });
  if (res.error) {
    return { error: res.error, request: res.request || null };
  }
  return { request: res.request, added: Boolean(res.added), evidence: evidence.length };
}
