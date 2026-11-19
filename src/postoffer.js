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

import {
  onPlatform, switchedOn, toolProblem, toolSwitches,
} from './agent/agenttools.js';
import { AGENT_EMAIL } from './draftevents.js';
import { entryOf } from './drafts.js';
import { channelOwner } from './mcpadmin.js';
import { managesTeam } from './review.js';
import { readSettings } from './settings.js';

/**
 * After a person sent a draft of the thread agent's, the offer to let the agent post its replies
 * in the channel itself (the channel's **Post messages** switch, src/agent/agenttools.js), which
 * `POST /api/post` and `POST /api/post/app` answer with as `postingOffer`: once the person has
 * sent `OFFER_AFTER` of its drafts in the channel, and only to someone who may switch it (the
 * admin team, a manager of the channel's team: src/tooladmin.js), where it is off by the team's
 * switch and nobody switched the channel itself, its platform's bot is set up, and they did not
 * say no there before (`postingDeclined`, src/settings.js). The inbox asks; a yes switches the
 * channel on through `PUT /api/kb/tools`, a no is kept in the settings.
 */
export const OFFER_AFTER = 3;

/**
 * The offer after `me` sent `draft` (as src/drafts.js discardDraft answers it) in the thread
 * `key`: `{ channel, team, sent }`, or null. Never fails the post it follows: anything going
 * wrong is no offer.
 */
export async function postingOffer(env, me, key, draft) {
  try {
    if (!draft || draft.origin == null || !me || me.readonly || me.viewer) {
      return null;
    }
    const entry = await entryOf(env, key);
    const channel = entry && entry.channel_id;
    if (!channel) {
      return null;
    }
    if (toolProblem(env, 'post_message') || !onPlatform(env, 'post_message', entry.source)) {
      return null;
    }
    const owner = await channelOwner(env, channel);
    if (!owner || owner.kind === 'ignore' || !managesTeam(me, owner.team)) {
      return null;
    }
    const sw = (await toolSwitches(env, { team: owner.team, channelId: channel }))
      .get('post_message');
    // On already, or decided for this channel (a channel switched off on purpose stays so).
    if (sw.channel || switchedOn(sw)) {
      return null;
    }
    const row = await env.DB.prepare(`SELECT (SELECT email = ? FROM people WHERE id = ?) AS agent,
        (SELECT COUNT(*) FROM draft_events
          WHERE thread IN (SELECT thread FROM threads WHERE channel_id = ? AND source = ?)
            AND action = 'sent' AND person = ? AND by_agent = 0 AND origin_agent = 1) AS sent`)
      .bind(AGENT_EMAIL, draft.origin, channel, entry.source, me.id).first();
    if (!row || !row.agent || row.sent < OFFER_AFTER) {
      return null;
    }
    if ((await readSettings(env, me)).postingDeclined.includes(channel)) {
      return null;
    }
    return { channel, team: owner.team, sent: row.sent };
  } catch (e) {
    console.log(JSON.stringify({ route: 'post', action: 'posting-offer', error: e.message }));
    return null;
  }
}
