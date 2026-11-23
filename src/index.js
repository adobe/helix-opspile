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

import { accessEmail } from './access.js';
import { followed, Meter } from './cogs/meter.js';
import { rollupCogs } from './cogs/rollup.js';
import { syncAccessQuietly } from './accesssync.js';
import { clientDocumentResponse, keepOAuthAlive } from './agent/mcpoauth.js';
import { refreshMirrors } from './agent/repos.js';
import { agentStub } from './agent/stub.js';
import { api, personByEmail } from './api.js';
import { syncInstalledBots } from './bots.js';
import { listDead, pruneDead, redrive } from './deadjobs.js';
import { sweepLabels } from './label.js';
import { sweepRethreads } from './rethread.js';
import { diagTeams } from './diag.js';
import { discordEnabled } from './discord.js';
import { runDreams } from './dreams.js';
import { json, text } from './http.js';
import { ICONS } from './icons.js';
import { SOUNDS } from './sound.js';
import { pwa } from './pwa.js';
import { ensureTeamKnowledgeBases } from './kb.js';
import { countEntries } from './kbadmin.js';
import { syncConcepts } from './kbindex.js';
import { syncCatalogs } from './catalogsync.js';
import { syncOrgStacks } from './orgstacks.js';
import { mcp } from './mcp.js';
import { refreshGlobalTools } from './mcpadmin.js';
import { oauth, pruneOauth } from './oauth.js';
import { consume } from './normalizer.js';
import {
  fmcScript, fromPreview, highlightScript, threeScript,
} from './page.js';
import {
  ADMIN_PAGE, COGS_PAGE, INBOX_PAGE, TOPICS_PAGE,
} from './pages.js';
import { slackEvents } from './slack.js';
import { joinPublicChannels } from './autojoin.js';
import { sweepChannels } from './channelsweep.js';
import { syncFollowRules } from './followrules.js';
import { ensureSubscription } from './subscription.js';
import { moved } from './moved.js';
import { classifyChannels } from './suggest.js';
import { teamsNotify } from './teams.js';
import { teamsBot } from './teamsbot.js';
import { sweepVectors } from './vectors.js';
import { sweepMentionModel } from './mentionmodels.js';
import { sweepTopicMap } from './topicmap.js';
import { sweepTrends } from './trends.js';
import { sweepPreviews } from './previews.js';
import { sweepExports } from './clickhouse.js';
import { pruneRankEvents } from './rankevents.js';
import { pruneDraftUndo } from './draftevents.js';
import { sweepBackfills } from './backfill.js';
import { pruneExpertEvents } from './expertevents.js';
import { prunePostKeys } from './postkeys.js';

/** The one Discord poller object (src/poller.js). */
const poller = (env) => env.DISCORD.get(env.DISCORD.idFromName('poller'));

function authorizedDiag(request, env) {
  return Boolean(env.DIAG_TOKEN) && request.headers.get('x-opspile-diag') === env.DIAG_TOKEN;
}

/** The favicon, the touch icon and the notifications' sound, decoded once per isolate. */
const ASSETS = { ...ICONS, ...SOUNDS };
const iconBytes = new Map();
function icon(pathname) {
  const entry = ASSETS[pathname];
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

/** The Worker's handlers, with `env` counted for COGS (the default export, below). */
const handlers = {
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
    if (pathname === '/diag/dead') {
      // The queue jobs that used up their retries: GET lists them; POST `{ ids? }` sends them
      // out again, those of `ids` or the oldest.
      if (!authorizedDiag(request, env)) {
        return text('forbidden\n', 403);
      }
      if (request.method === 'POST') {
        const { ids = null } = await request.json().catch(() => ({}));
        return json(await redrive(env, { ids }));
      }
      return json(await listDead(env));
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
    // opspile's client ID metadata document, for the authorization servers of the agents' MCP
    // servers: public, they fetch it.
    const clientDocument = clientDocumentResponse(request, env, url);
    if (clientDocument) {
      return clientDocument;
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
      // Teams and customers, with their agents (the API checks who sees what). Under /inbox,
      // so the same Access application covers it.
      return new Response(ADMIN_PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    if (pathname === '/inbox/kb') {
      // The knowledge-base editor that was: its links (a knowledge base, a file, a view) open
      // the same on the team's or the customer's page, which reads them (ui/admin.js `wanted`).
      return new Response(null, {
        status: 302,
        headers: { location: `/inbox/admin${url.search}`, 'cache-control': 'no-store' },
      });
    }
    if (pathname === '/inbox/cogs') {
      // What the inbox costs (admin team; the API checks), under /inbox like the others.
      return new Response(COGS_PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    if (pathname === '/inbox/topics') {
      // The topic map (admin team; the API checks), under /inbox like the others.
      return new Response(TOPICS_PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    // The Spectrum 2 preview's addresses, from before it was every page's look.
    const preview = fromPreview(pathname, url.search);
    if (preview) {
      return Response.redirect(new URL(preview, url.origin).href, 301);
    }
    if (pathname === '/inbox') {
      return new Response(INBOX_PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    // The inbox's code highlighter, which it imports with the first code block it shows.
    const highlighter = highlightScript(request, pathname);
    if (highlighter) {
      return highlighter;
    }
    // The stack drawing's renderer, which it imports with the first stack it shows.
    const fmc = fmcScript(request, pathname);
    if (fmc) {
      return fmc;
    }
    // three.js, which the Topics page imports when it first draws its map.
    const three = threeScript(request, pathname);
    if (three) {
      return three;
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

  /**
 * Cron: keep the Graph subscription alive (#5), give every team a knowledge base, count the
 * entries of the knowledge bases not counted yet, read the concepts the search has not read yet
 * (src/kbindex.js), keep the agents' GitHub mirrors fresh, learn the
 * bots installed in each Teams team, check the global MCP servers' tools once a day, keep the
 * agents' MCP OAuth grants alive, classify a batch of the admin team's channels for the channel
 * suggestions, write the follow rules' shares (src/followrules.js), join the public Slack channels
 * the app is not in (SLACK_JOIN_TEAMS), look up again the channels not looked up for a week (to
 * learn which are archived), enqueue the threads whose message and thread vectors are behind, fill
 * in the latest message's text of threads indexed before it was kept, delete the thread list's
 * picks older than RANK_EVENTS_DAYS (src/rankevents.js) and the proposals kept for an Undo of a
 * discarded draft past its time (src/draftevents.js), and enqueue the threads whose klickhaus rows
 * are behind; fit the expert finder's mention model once a day and build the Topics page's map
 * once a week; and roll up what the days used, for COGS.
 */
  async scheduled(controller, env, ctx) {
    // What the days cost so far, for the COGS dashboard (src/cogs/rollup.js).
    ctx.waitUntil(rollupCogs(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', cogs: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', cogs: 'error', error: e.message }))));
    ctx.waitUntil(ensureSubscription(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', cron: controller.cron, ...r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', error: e.message }))));
    ctx.waitUntil(ensureTeamKnowledgeBases(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', kb: 'teams', ...r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', kb: 'teams', error: e.message }))));
    ctx.waitUntil(countEntries(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', kb: 'entries', ...r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', kb: 'entries', error: e.message }))));
    // The knowledge bases' concepts the inbox's search has not read yet, and their vectors.
    ctx.waitUntil(syncConcepts(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', kb: 'search', ...r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', kb: 'search', error: e.message }))));
    // The customers' stack drawings the inbox's list by customer has not read yet.
    ctx.waitUntil(syncOrgStacks(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', kb: 'stacks', ...r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', kb: 'stacks', error: e.message }))));
    // The teams' catalogs of products whose knowledge base moved on without a compile.
    ctx.waitUntil(syncCatalogs(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', kb: 'catalog', ...r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', kb: 'catalog', error: e.message }))));
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
    // Customers quiet for eight hours consolidate their knowledge base, in the dream experiment.
    ctx.waitUntil(runDreams(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', dreams: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', dreams: 'error', error: e.message }))));
    ctx.waitUntil(refreshGlobalTools(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', mcpGlobals: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', mcpGlobals: 'error', error: e.message }))));
    ctx.waitUntil(classifyChannels(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', suggest: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', suggest: 'error', error: e.message }))));
    ctx.waitUntil(pruneOauth(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', oauth: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', oauth: 'error', error: e.message }))));
    ctx.waitUntil(joinPublicChannels(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', slackJoin: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', slackJoin: 'error', error: e.message }))));
    // The follow rules' shares (src/followrules.js), for the channels seen or renamed since.
    ctx.waitUntil(syncFollowRules(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', followRules: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', followRules: 'error', error: e.message }))));
    // Channels looked up a week ago, again: archived ones get no messages to say so.
    ctx.waitUntil(sweepChannels(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', channels: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', channels: 'error', error: e.message }))));
    ctx.waitUntil(sweepRethreads(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', rethreads: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', rethreads: 'error', error: e.message }))));
    ctx.waitUntil(sweepLabels(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', labels: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', labels: 'error', error: e.message }))));
    ctx.waitUntil(pruneDead(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', deadJobs: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', deadJobs: 'error', error: e.message }))));
    ctx.waitUntil(sweepVectors(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', vectors: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', vectors: 'error', error: e.message }))));
    // The expert finder's mention model (src/mentionmodels.js), once it is a day old.
    ctx.waitUntil(sweepMentionModel(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', mentionModel: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', mentionModel: 'error', error: e.message }))));
    // The Topics page's map (src/topicmap.js), once it is a week old.
    ctx.waitUntil(sweepTopicMap(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', topicMap: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', topicMap: 'error', error: e.message }))));
    // The Topics page's trends (src/trends.js): the topics of the threads the newest topic map
    // does not have.
    ctx.waitUntil(sweepTrends(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', trends: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', trends: 'error', error: e.message }))));
    ctx.waitUntil(sweepPreviews(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', previews: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', previews: 'error', error: e.message }))));
    ctx.waitUntil(sweepBackfills(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', backfills: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', backfills: 'error', error: e.message }))));
    ctx.waitUntil(pruneDraftUndo(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', draftUndo: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', draftUndo: 'error', error: e.message }))));
    ctx.waitUntil(pruneRankEvents(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', rankEvents: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', rankEvents: 'error', error: e.message }))));
    ctx.waitUntil(prunePostKeys(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', postKeys: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', postKeys: 'error', error: e.message }))));
    ctx.waitUntil(pruneExpertEvents(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', expertEvents: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', expertEvents: 'error', error: e.message }))));
    // The klickhaus export (CLICKHOUSE_*): the threads that changed since, and the backfill.
    ctx.waitUntil(sweepExports(env)
      .then((r) => console.log(JSON.stringify({ route: 'cron', exports: r })))
      .catch((e) => console.error(JSON.stringify({ route: 'cron', exports: 'error', error: e.message }))));
  },
};

/**
 * COGS (src/cogs/meter.js): every request, its work after the answer (`waitUntil`) included, is
 * counted for the thread it names, if it names one; every queue job for its thread; a cron run as
 * shared work. Each is one Workers request.
 */
export default {
  async fetch(request, rawEnv, rawCtx) {
    const meter = new Meter(rawEnv, { via: 'fetch' });
    const env = meter.env({ thread: new URL(request.url).searchParams.get('thread') || null });
    env.meter?.add('workers', 'requests', '', 1);
    const ctx = followed(rawCtx);
    try {
      return await handlers.fetch(request, env, ctx);
    } finally {
      rawCtx?.waitUntil(ctx.settled().then(() => meter.flush()).catch(() => {}));
    }
  },

  /** NORMALIZE queue: pile 1 → pile 2 (#6). */
  async queue(batch, env) {
    const meter = new Meter(env, { via: 'queue' });
    try {
      await consume(batch, env, meter);
    } finally {
      await meter.flush();
    }
  },

  async scheduled(controller, rawEnv, rawCtx) {
    const meter = new Meter(rawEnv, { via: 'cron' });
    const env = meter.env({});
    env.meter?.add('workers', 'requests', '', 1);
    const ctx = followed(rawCtx);
    await handlers.scheduled(controller, env, ctx);
    rawCtx?.waitUntil(ctx.settled().then(() => meter.flush()).catch(() => {}));
  },
};

export { TeamRoom } from './room.js';
export { ThreadAgent } from './agent/agent.js';
export { DiscordPoller } from './poller.js';
// Where the customer portal's events arrive (src/portalsource.js).
export { PortalSource } from './portalentry.js';
