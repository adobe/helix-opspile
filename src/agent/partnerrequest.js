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

import { createPartnerRequest } from '../partnerrequests.js';

/**
 * `request_partner_link` (src/agent/tools.js): an agent asks the admin team to decide whether a
 * partner works for a customer, or no longer does (src/partnerrequests.js), from what a thread
 * says ("we have moved to another agency", "they no longer support our site") or what the person
 * it talks to tells it. Unlike moving a channel or adding someone to a team, a thread's agent may
 * file one on its own: nothing changes until the admin team decides, in its inbox, where the
 * request says who asked, links the thread, and shows what the inbox knows of the two. For the
 * person in its sidebar, or in a knowledge base's conversation, it files it as theirs.
 */

/** How an agent is named where it asks on its own. */
export function agentName(t) {
  if (t.channelName) {
    return `The agent of a thread in #${t.channelName}`;
  }
  return t.org ? `The agent of ${t.orgName || t.org}'s knowledge base` : 'An agent';
}

/**
 * Files the request: `t` is the agent's target (its thread, customer, channel), `asker` the person
 * it asks for (`{ email, name }`, from its sidebar or conversation) or null (its own), `args` the
 * tool's. The customer and the partner default to the thread's org, by its type. `{ request }`,
 * or `{ error, request? }` (the open one that asks the same).
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
  const by = asker && asker.email ? { email: asker.email, name: asker.name || null }
    : { agent: true, name: agentName(t) };
  const res = await createPartnerRequest(env, by, {
    customer, partner, action: args.action, since: args.since, until: args.until, note,
  }, { thread: t.key || null });
  return res.error ? { error: res.error, request: res.request || null } : { request: res.request };
}
