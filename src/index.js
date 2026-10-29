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
// The pages' scripts, as text (src/page.js inlines them).
import inboxJs from '../ui/inbox.js' with { type: 'text' };
import adminJs from '../ui/admin.js' with { type: 'text' };
import kbJs from '../ui/kb.js' with { type: 'text' };
import appJs from '../ui/app.js' with { type: 'text' };
import headerJs from '../ui/header.js' with { type: 'text' };
import headerCss from '../ui/header.css' with { type: 'text' };
import { accessEmail } from './access.js';
import { syncAccessQuietly } from './accesssync.js';
import { keepOAuthAlive } from './agent/mcpoauth.js';
import { refreshMirrors } from './agent/repos.js';
import { agentStub } from './agent/stub.js';
import { api, personByEmail } from './api.js';
import { syncInstalledBots } from './bots.js';
import { diagTeams } from './diag.js';
import { discordEnabled } from './discord.js';
import { json, text } from './http.js';
import { ICONS } from './icons.js';
import { pwa } from './pwa.js';
import { ensureTeamKnowledgeBases } from './kb.js';
import { mcp } from './mcp.js';
import { refreshGlobalTools } from './mcpadmin.js';
import { oauth } from './oauth.js';
import { consume } from './normalizer.js';
import { inboxPage, page } from './page.js';
import { slackEvents } from './slack.js';
import { joinPublicChannels } from './autojoin.js';
import { ensureSubscription } from './subscription.js';
import { moved } from './moved.js';
import { classifyChannels } from './suggest.js';
import { teamsNotify } from './teams.js';
import { teamsBot } from './teamsbot.js';
import { sweepVectors } from './vectors.js';
import { sweepPreviews } from './previews.js';

const SCRIPTS = {
  'inbox.js': inboxJs,
  'admin.js': adminJs,
  'kb.js': kbJs,
  'app.js': appJs,
  'header.js': headerJs,
  'header.css': headerCss,
};
const INBOX_PAGE = inboxPage(inboxHtml, SCRIPTS);
const ADMIN_PAGE = page(adminHtml, SCRIPTS);
const KB_PAGE = page(kbHtml, SCRIPTS);

/** The one Discord poller object (src/poller.js). */
const poller = (env) => env.DISCORD.get(env.DISCORD.idFromName('poller'));

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
    const redirect = moved(request, env, url);
    if (redirect) {
      return redirect;
    }

    if (request.method === 'POST' && pathname === '/slack/events') {
      return slackEvents(request, env, ctx);
    }
    if (request.method === 'POST' && (pathname === '/teams/notify' || pathname === '/teams/lifecycle')) {
      return teamsNotify(request, url, env, ctx);
    }
    if (request.method === 'POST' && pathname === '/teams/bot') {
      // The opspile bot's messaging endpoint (src/teamsbot.js): notification-only.
      return teamsBot();
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
    if (pathname === '/diag/discord') {
      // The Discord poller: GET says how the last poll went; POST polls now (and reads the
      // last day again for edits, deletions and reactions).
      if (!authorizedDiag(request, env) || !env.DISCORD) {
        return text('forbidden\n', 403);
      }
      return poller(env).fetch(`https://poller/${request.method === 'POST' ? 'poll' : 'status'}`);
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
      return new Response(ADMIN_PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    if (pathname === '/inbox/kb') {
      // The knowledge-base editor (admin team; the API checks). Under /inbox, so the same
      // Access application covers it.
      return new Response(KB_PAGE, {
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
      const appResponse = pwa(request, pathname);
      if (appResponse) {
        return appResponse;
      }
    }
    const apiResponse = await api(request, env, url, {
      waitUntil: ctx && ((p) => ctx.waitUntil(p)),
    });
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
 * Cron: keep the Graph subscription alive (#5), give every team a knowledge base, keep the
 * agents' GitHub mirrors fresh, learn the bots installed in each Teams team, check the global
 * MCP servers' tools once a day, keep the agents' MCP OAuth grants alive, classify a batch of
 * the admin team's channels for the channel suggestions, join the public Slack channels the app
 * is not in (SLACK_JOIN_TEAMS), enqueue the threads whose message and thread vectors are
 * behind, and fill in the latest message's text of threads indexed before it was kept.
 */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(ensureSubscription(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', cron: controller.cron, ...r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', error: e.message }))));
    ctx.waitUntil(ensureTeamKnowledgeBases(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', kb: 'teams', ...r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', kb: 'teams', error: e.message }))));
    // The sign-in allow list follows the teams, in case a change in D1 bypassed the admin pages.
    ctx.waitUntil(syncAccessQuietly(env, 'cron'));
    ctx.waitUntil(refreshMirrors(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', mirrors: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', mirrors: 'error', error: e.message }))));
    ctx.waitUntil(syncInstalledBots(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', bots: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', bots: 'error', error: e.message }))));
    if (env.DISCORD && discordEnabled(env)) {
      // The poller's own alarm keeps it polling; this starts it, and restarts a stopped one.
      ctx.waitUntil(poller(env).fetch('https://poller/ensure').then((r) => r.json())
        .then((r) => console.log(JSON.stringify({ route: 'cron', discord: r.state })))
        .catch((e) => console.error(JSON.stringify({ route: 'cron', discord: 'error', error: e.message }))));
    }
    // OAuth grants of the agents' MCP servers that nobody used for a week: refreshed, so that
    // refresh tokens that expire unused stay alive.
    ctx.waitUntil(keepOAuthAlive(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', mcpOauth: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', mcpOauth: 'error', error: e.message }))));
    ctx.waitUntil(refreshGlobalTools(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', mcpGlobals: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', mcpGlobals: 'error', error: e.message }))));
    ctx.waitUntil(classifyChannels(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', suggest: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', suggest: 'error', error: e.message }))));
    ctx.waitUntil(joinPublicChannels(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', slackJoin: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', slackJoin: 'error', error: e.message }))));
    ctx.waitUntil(sweepVectors(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', vectors: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', vectors: 'error', error: e.message }))));
    ctx.waitUntil(sweepPreviews(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', previews: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', previews: 'error', error: e.message }))));
  },
};

export { TeamRoom } from './room.js';
export { ThreadAgent } from './agent/agent.js';
export { DiscordPoller } from './poller.js';
// The way back from an agent's shell (a Dynamic Worker) to its files (src/agent/computer.js).
export { WorkspaceServiceProxy } from '@cloudflare/computer';
