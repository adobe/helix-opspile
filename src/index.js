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

import inboxHtml from '../ui/inbox.html';
import { api } from './api.js';
import { diagTeams } from './diag.js';
import { json, text } from './http.js';
import { consume } from './normalizer.js';
import { slackEvents } from './slack.js';
import { ensureSubscription } from './subscription.js';
import { teamsNotify } from './teams.js';

function authorizedDiag(request, env) {
  return Boolean(env.DIAG_TOKEN) && request.headers.get('x-opspile-diag') === env.DIAG_TOKEN;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'POST' && pathname === '/slack/events') {
      return slackEvents(request, env);
    }
    if (request.method === 'POST' && (pathname === '/teams/notify' || pathname === '/teams/lifecycle')) {
      return teamsNotify(request, url, env, ctx);
    }
    if (pathname === '/diag/teams') {
      if (!authorizedDiag(request, env)) {
        return text('forbidden\n', 403);
      }
      try {
        return json(await diagTeams(url, env));
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    if (pathname === '/inbox') {
      return new Response(inboxHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    const apiResponse = await api(request, env, url);
    if (apiResponse) {
      return apiResponse;
    }
    if (pathname === '/') {
      return text('opspile ingest (stub)\n');
    }
    return text('not found\n', 404);
  },

  /** NORMALIZE queue: pile 1 → pile 2 (#6). */
  async queue(batch, env) {
    await consume(batch, env);
  },

  /** Cron: keep the Graph subscription alive (#5). */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(ensureSubscription(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', cron: controller.cron, ...r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', error: e.message }))));
  },
};

export { TeamRoom } from './room.js';
