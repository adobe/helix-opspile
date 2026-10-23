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
import adminHtml from '../ui/admin.html';
import kbHtml from '../ui/kb.html';
import { accessEmail } from './access.js';
import { refreshMirrors } from './agent/repos.js';
import { agentStub } from './agent/stub.js';
import { api, personByEmail } from './api.js';
import { diagTeams } from './diag.js';
import { json, text } from './http.js';
import { ICONS } from './icons.js';
import { ensureTeamKnowledgeBases } from './kb.js';
import { mcp } from './mcp.js';
import { oauth } from './oauth.js';
import { consume } from './normalizer.js';
import { inboxPage } from './page.js';
import { slackEvents } from './slack.js';
import { ensureSubscription } from './subscription.js';
import { teamsNotify } from './teams.js';

const INBOX_PAGE = inboxPage(inboxHtml);

function authorizedDiag(request, env) {
  return Boolean(env.DIAG_TOKEN) && request.headers.get('x-opspile-diag') === env.DIAG_TOKEN;
}

/** The favicon and touch icon, decoded once per isolate. */
const iconBytes = new Map();
function icon(pathname) {
  const entry = ICONS[pathname];
  if (!entry) {
    return null;
  }
  if (!iconBytes.has(pathname)) {
    iconBytes.set(pathname, Uint8Array.from(atob(entry.base64), (c) => c.charCodeAt(0)));
  }
  return new Response(iconBytes.get(pathname), {
    headers: { 'content-type': entry.type, 'cache-control': 'public, max-age=86400' },
  });
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
    if (pathname === '/diag/agent') {
      // One agent, by its name (an inbox entry key, or kb:<team>:<org>): GET says what it is
      // doing; POST `deliver` tells it about new messages, POST `{ text }` seeds it.
      if (!authorizedDiag(request, env) || !env.AGENTS || !url.searchParams.get('name')) {
        return text('forbidden\n', 403);
      }
      try {
        const agent = await agentStub(env, url.searchParams.get('name'));
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          return json(body.text ? await agent.seed({ by: 'diag', text: String(body.text) })
            : await agent.deliver());
        }
        return json(await agent.status());
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    if (pathname === '/mcp') {
      return mcp(request, env);
    }
    // OAuth for MCP clients: discovery, registration and tokens are public; the consent page
    // is under /api, behind Access.
    const oauthResponse = await oauth(request, env, url, {
      who: async (r) => {
        const email = await accessEmail(r, env);
        return email ? personByEmail(env, email) : null;
      },
    });
    if (oauthResponse) {
      return oauthResponse;
    }
    if (pathname === '/inbox/admin') {
      // Teams and orgs (admin team; the API checks), under /inbox like the editor.
      return new Response(adminHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    if (pathname === '/inbox/kb') {
      // The knowledge-base editor (admin team; the API checks). Under /inbox, so the same
      // Access application covers it.
      return new Response(kbHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    if (pathname === '/inbox') {
      return new Response(INBOX_PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const iconResponse = icon(pathname);
      if (iconResponse) {
        return iconResponse;
      }
    }
    const apiResponse = await api(request, env, url);
    if (apiResponse) {
      return apiResponse;
    }
    if (pathname === '/') {
      // People open the bare address; the inbox is what they are after.
      return new Response(null, { status: 302, headers: { location: '/inbox' } });
    }
    return text('not found\n', 404);
  },

  /** NORMALIZE queue: pile 1 → pile 2 (#6). */
  async queue(batch, env) {
    await consume(batch, env);
  },

  /**
 * Cron: keep the Graph subscription alive (#5), give every team a knowledge base, and keep the
 * agents' GitHub mirrors fresh.
 */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(ensureSubscription(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', cron: controller.cron, ...r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', error: e.message }))));
    ctx.waitUntil(ensureTeamKnowledgeBases(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', kb: 'teams', ...r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', kb: 'teams', error: e.message }))));
    ctx.waitUntil(refreshMirrors(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', mirrors: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', mirrors: 'error', error: e.message }))));
  },
};

export { TeamRoom } from './room.js';
export { ThreadAgent } from './agent/agent.js';
