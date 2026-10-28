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
import { postAsApp } from './agent/posting.js';
import { entryOf } from './drafts.js';
import { json } from './http.js';
import { isStaffDomain } from './lookup.js';
import { platformName } from './platforms.js';
import { target as replyTarget } from './post.js';

/**
 * A person posting as the opspile app (the Slack app, the Teams bot, the Discord bot) instead
 * of as themselves: the same post as a thread agent's `post_message` (src/agent/posting.js),
 * and allowed where that is: in channels whose team or channel switch **Post messages** is on
 * (src/agent/agenttools.js), on a platform whose bot is set up. The switch says whether the
 * opspile app speaks in a channel at all, whoever writes the text.
 */

/**
 * Why the app may not post in inbox entry `key` (a thread key), or null when it may.
 * `{ entry, target }` come along so the caller need not look them up again.
 */
export async function appPostCheck(env, key) {
  const entry = key && await entryOf(env, key);
  const t = entry && await replyTarget(env, entry.key);
  if (!t) {
    return { problem: 'not found', status: 404 };
  }
  const name = platformName(t.source);
  if (toolProblem(env, 'post_message') || !onPlatform(env, 'post_message', t.source)) {
    return {
      entry, target: t, problem: `the opspile ${name} bot is not set up here`, status: 409,
    };
  }
  const switches = await toolSwitches(env, { team: entry.team, channelId: t.channel_id });
  if (!switchedOn(switches.get('post_message'))) {
    return {
      entry,
      target: t,
      problem: 'the opspile app does not post in this channel: turn on "Post messages" for it'
        + ' or its team in the knowledge-base editor first',
      status: 409,
    };
  }
  return { entry, target: t, problem: null };
}

/**
 * Records a message the person posted as the opspile app (`app_posts`), so that they may edit
 * it later. `t` is the platform thread it went to.
 */
export async function recordAppPost(env, me, t, id) {
  if (!t || !id) {
    return;
  }
  await env.DB.prepare(`INSERT INTO app_posts (source, tenant, channel_id, id, thread, person, at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, tenant, channel_id, id) DO NOTHING`)
    .bind(t.source, t.tenant, t.channel_id, String(id), t.thread, me.id, new Date().toISOString())
    .run();
}

/**
 * POST /api/post/app `{ thread, text }`: posts `text` in the thread as the opspile app, for a
 * staff member of one of the thread's teams. The reply arrives like any other message, through
 * the platform's events, by the app.
 */
export async function postApp(env, me, request, inTeam) {
  const { thread: key, text } = request || {};
  const body = String(text || '').trim();
  if (!body) {
    return json({ error: 'write something' }, 400);
  }
  const check = await appPostCheck(env, key);
  if (!check.entry || !inTeam(check.entry.teams)) {
    return json({ error: 'not found' }, 404);
  }
  if (!isStaffDomain(env, me.email)) {
    return json({ error: 'only staff can reply' }, 403);
  }
  if (check.problem) {
    return json({ error: check.problem }, check.status);
  }
  const res = await postAsApp(env, check.entry.key, body);
  if (res.error) {
    return json({ error: res.error }, /^too long/.test(res.error) ? 400 : 502);
  }
  // Theirs to edit later (src/edit.js).
  await recordAppPost(env, me, check.target, res.id);
  console.log(JSON.stringify({
    route: 'post', action: 'app', platform: res.platform, team: check.entry.team,
  }));
  return json({ ok: true, platform: res.platform, id: res.id });
}
