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

import { diagTeams } from './diag.js';
import { json, text } from './http.js';
import { slackEvents } from './slack.js';
import { teamsNotify } from './teams.js';

function authorizedDiag(request, env) {
  return Boolean(env.DIAG_TOKEN) && request.headers.get('x-opspile-diag') === env.DIAG_TOKEN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'POST' && pathname === '/slack/events') {
      return slackEvents(request);
    }
    if (request.method === 'POST' && (pathname === '/teams/notify' || pathname === '/teams/lifecycle')) {
      return teamsNotify(url);
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
    if (pathname === '/') {
      return text('opspile ingest (stub)\n');
    }
    return text('not found\n', 404);
  },
};
