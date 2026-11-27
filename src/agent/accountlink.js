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

import { proposeAccountLink } from '../accountlinks.js';
import { agentName } from './partnerrequest.js';

/**
 * `request_account_link` (src/agent/tools.js): a thread agent proposes to the admin team that an
 * account of its thread that is Adobe's by itself and that nobody linked (a Discord account with a
 * staff role, the Teams tenant's admin accounts; src/accountlinks.js) is a colleague's, from what
 * the thread or its sidebar says, or a knowledge-base Contact whose `aliases` name it. As
 * `request_partner_link`, it may do so on its own, since it changes nothing: the proposal waits in
 * the account's thread of the admin team's inbox, which confirms or declines it. For the person in
 * its sidebar, it files it as theirs.
 */

/**
 * Files the proposal: `t` is the agent's target, `asker` the person in its sidebar
 * (`{ email, name }`) or null (its own), `args` the tool's (`account`, `email`, `note`).
 * `{ proposal, account }`, or `{ error }`.
 */
export async function requestAccountLink(env, t, asker, args = {}) {
  const by = asker && asker.email ? { email: asker.email, name: asker.name || null }
    : { agent: true, name: agentName(t) };
  return proposeAccountLink(env, t, by, {
    account: args.account, email: args.email, note: args.note,
  });
}
