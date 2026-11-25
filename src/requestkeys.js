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

import { notifyRoom } from './notify.js';

/**
 * The keys of the admin team's requests as threads of its inbox (src/requestthreads.js):
 * `request:<kind>:<id>`, where the id is the request's row id, a bot's or an account's identity
 * key, or a conflict's key (which have colons of their own). Kept apart from that module, so the
 * modules that file requests announce them without importing it.
 */
export const PREFIX = 'request:';

/**
 * The kinds: channel (src/requests.js), member (src/memberrequests.js), portal
 * (src/portalrequests.js), merge (src/orgmerge.js), bot (src/ourbots.js), account
 * (src/accountlinks.js), tech (src/techconflicts.js) and rule (src/ruleconflicts.js); and
 * question (src/questions.js), a thread agent's question to one person, which is theirs, in
 * whichever inbox they are, not the admin team's.
 */
export const KINDS = ['channel', 'member', 'portal', 'merge', 'bot', 'account', 'tech', 'rule', 'question'];

/** The team whose inbox has them (src/roles.js ADMIN_TEAM). */
const ADMIN_TEAM = 'admin';

export const isRequestKey = (key) => typeof key === 'string' && key.startsWith(PREFIX);

export const requestKey = (kind, id) => `${PREFIX}${kind}:${id}`;

/** `{ kind, id }` of a request's key, or null. */
export function parseRequestKey(key) {
  if (!isRequestKey(key)) {
    return null;
  }
  const rest = key.slice(PREFIX.length);
  const at = rest.indexOf(':');
  const kind = at > 0 ? rest.slice(0, at) : '';
  const id = at > 0 ? rest.slice(at + 1) : '';
  return KINDS.includes(kind) && id ? { kind, id } : null;
}

/**
 * Tells the admin team's room that request `kind` `id` is new or changed (without a kind, that
 * some may be): its inboxes load the requests again (`{ type: 'request', thread? }`). `teams`,
 * a question's: the rooms of its thread's teams too, where the person it asks listens. Best
 * effort, as every room's.
 */
export async function announceRequest(env, kind = null, id = null, { teams = [] } = {}) {
  const known = kind && id !== null && id !== undefined;
  await notifyRoom(env, [ADMIN_TEAM, ...teams], { type: 'request', ...(known ? { thread: requestKey(kind, id) } : {}) });
}
