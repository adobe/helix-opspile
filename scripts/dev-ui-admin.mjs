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

import { generateKeyPairSync } from 'node:crypto';
import { admin } from '../src/admin.js';
import { GITHUB_MCP_URL } from '../src/agent/globals.js';
import { FLUFFYJAWS_MCP_URL } from '../src/agent/fluffyjaws.js';
import { SLACK_MCP_URL } from '../src/agent/slackmcp.js';
import { kbAdmin } from '../src/kbadmin.js';
import { pkcs8Pem } from '../src/github.js';
import { consume } from '../src/normalizer.js';
import { syncFollowRules } from '../src/followrules.js';
import { advanceWatermark, previewOf } from '../src/threads.js';
import { seal } from '../src/post.js';
import {
  addNote, requestEntries, requestThread, resolveRequest,
} from '../src/requestthreads.js';
import { isRequestKey } from '../src/requestkeys.js';
import { d1 } from '../test/d1.js';
import { IMAGES, layerNames } from './computer-images.mjs';
import { seedCogs } from './dev-ui-cogs.mjs';
import { seedTopicMap } from './dev-ui-topics.mjs';
import { seedTeamProfile } from './dev-ui-team.mjs';
import { seedCustomerProfile } from './dev-ui-customer.mjs';
import { seedVendorProfile } from './dev-ui-vendor.mjs';
import { fakeBucket } from '../test/fakes.js';
import { fakeMcpServers } from '../test/mcp-server.js';

/**
 * The admin pages (`/inbox/admin`) for `npm run ui:dev`: the real src/admin.js over an
 * in-memory D1 with the production migrations (test/d1.js), seeded from the fake inbox's
 * teams, people and threads. Re-filing jobs run at once on a fake pile 2. Made-up data only.
 *
 * The agents' MCP servers (the editor's "MCP servers"): a few made-up ones answer in memory at
 * `https://*.mcp.example` and `https://status.acme.example` (test/mcp-server.js), so adding and
 * checking a server works in the preview; any other `.example` URL fails the check, as an
 * unreachable server would. `https://wiki.mcp.example/mcp` signs in with OAuth: its made-up
 * authorization server registers any client and grants at once (its sign-in page is the
 * preview's `/__dev/oauth/authorize`, which sends the browser straight back), so Connect works.
 *
 * The global servers: Cloudflare's Browser Run MCP server answers in memory (made up), and so
 * do GitHub's API and its MCP server for a made-up GitHub App, installed on one made-up
 * account, so the editor shows both set up. Start with `--no-github` to see the app missing.
 * FluffyJaws' MCP server answers in memory too, connected as a made-up person; its Okta is the
 * preview's `/__dev/okta` (its sign-in sends the browser straight back), so Connect again and
 * Disconnect work. Start with `--no-fluffyjaws` to see it before anyone connected it.
 */

const PREVIEW_TOKEN = 'preview-token';

/** Clef on two orgs, made up: one when their names are (src/orgmerge.js). */
const DEV_CLEF = {
  run: async (model, { state }) => ({
    answers: { one: { type: 'noul', noul: /same name|called|starts with|spelled alike/.test(state) ? 0.93 : 0.18 } },
  }),
};

// The preview's favicons: a letter on a colour, per domain; none for the ones Google would not
// know (the Worker answers 404 then, and the page shows the org without an icon).
const NO_FAVICON = /(^|\.)(globex|initech|parked)\.example$/;
const HUES = ['#c2410c', '#0f766e', '#7c3aed', '#be185d', '#1d4ed8', '#4d7c0f'];
export function devFavicon(domain) {
  const d = String(domain || '').replace(/^www\./, '');
  if (!/\.example$/.test(d) || NO_FAVICON.test(d)) {
    return new Response('no favicon', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  const hue = HUES[[...d].reduce((h, c) => h + c.charCodeAt(0), 0) % HUES.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="${hue}"/>`
    + `<text x="32" y="44" font-family="sans-serif" font-size="36" font-weight="700" fill="#fff" text-anchor="middle">${d[0].toUpperCase()}</text></svg>`;
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
}
const DEV_SVG = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#0f766e"/><path d="M20 34l8 8 16-18" stroke="#fff" stroke-width="6" fill="none"/></svg>')}`;
/** Suggestions for an org: its website's favicon fits, a look-alike's and a partner's do not. */
function devIcons(slug) {
  const s = String(slug || 'org');
  return [
    {
      icon: `${s}corp.example`, src: `${s}corp.example`, host: `${s}corp.example`, via: 'favicon', p: 0.94,
    },
    {
      icon: `${s}-group.example`, src: `${s}-group.example`, host: `${s}-group.example`, via: 'favicon', p: 0.38,
    },
    {
      icon: 'agency.example', src: 'agency.example', host: 'agency.example', via: 'favicon', p: 0.07,
    },
    // An SVG the site names: offered, but Clef does not read SVGs.
    {
      icon: `https://www.${s}corp.example/logo.svg`, src: DEV_SVG, host: `www.${s}corp.example`, via: 'site', p: null, svg: true,
    },
  ];
}
const tools = (list, property) => list.map(([name, description, readOnly]) => ({
  name,
  description,
  readOnly,
  inputSchema: { type: 'object', properties: { [property]: { type: 'string' } } },
  run: () => 'ok',
}));
const MCP = fakeMcpServers([
  {
    url: 'https://docs.mcp.example/mcp',
    name: 'docs',
    token: PREVIEW_TOKEN,
    tools: tools([
      ['search_docs', 'Search the product documentation', true],
      ['read_page', 'Read one documentation page as markdown', true],
      ['list_releases', 'Release notes of the last 90 days', true],
    ], 'query'),
  },
  {
    url: 'https://cdn.mcp.example/mcp',
    name: 'cdn',
    token: PREVIEW_TOKEN,
    tools: tools([
      ['purge_status', 'Status of recent purges for a host', true],
      ['cache_headers', 'The cache headers a URL is served with', true],
      ['purge', 'Purge a path from the CDN', false],
    ], 'host'),
  },
  {
    url: 'https://status.acme.example/mcp',
    name: 'acme-status',
    tools: tools([
      ['site_status', 'Uptime and error rate of an ACME site', true],
      ['open_incidents', 'Incidents ACME has open on their side', true],
    ], 'site'),
  },
]);
const PREVIEW_OAUTH_TOKEN = 'preview-oauth-token';
const PREVIEW_ORIGIN = `http://localhost:${Number(process.env.PORT) || 8787}`;
const WIKI = 'https://wiki.mcp.example';
const WIKI_MCP = fakeMcpServers([{
  url: `${WIKI}/mcp`,
  name: 'wiki',
  token: PREVIEW_OAUTH_TOKEN,
  tools: tools([
    ['search_wiki', 'Search the team wiki', true],
    ['read_wiki_page', 'Read one wiki page', true],
  ], 'query'),
}]);
/** The wiki's authorization server, made up: any client, any code, one token. */
async function wikiOauth(request) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return Response.json({ resource: `${WIKI}/mcp`, authorization_servers: [WIKI] });
  }
  if (pathname === '/.well-known/oauth-authorization-server') {
    return Response.json({
      issuer: WIKI,
      authorization_endpoint: `${PREVIEW_ORIGIN}/__dev/oauth/authorize`,
      token_endpoint: `${WIKI}/token`,
      registration_endpoint: `${WIKI}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }
  if (pathname === '/register') {
    const body = await request.json();
    return Response.json({ ...body, client_id: 'preview-client' }, { status: 201 });
  }
  if (pathname === '/token') {
    return Response.json({
      access_token: PREVIEW_OAUTH_TOKEN, token_type: 'Bearer', expires_in: 3600, refresh_token: 'preview-refresh',
    });
  }
  return WIKI_MCP.fetch(request);
}
const PREVIEW_INSTALL_TOKEN = 'ghs_preview';
const GLOBAL_MCP = fakeMcpServers([
  {
    url: GITHUB_MCP_URL,
    name: 'github',
    token: PREVIEW_INSTALL_TOKEN,
    tools: tools([
      ['get_file_contents', 'Get the contents of a file or directory', true],
      ['search_code', 'Search code across repositories', true],
      ['list_issues', 'List issues in a repository', true],
      ['pull_request_read', 'Get information on a pull request', true],
      ['list_workflow_runs', 'List workflow runs of a repository', true],
    ], 'repo'),
  },
]);
const NO_GITHUB = process.argv.includes('--no-github');
const NO_FLUFFYJAWS = process.argv.includes('--no-fluffyjaws');
const PREVIEW_FLUFFY_TOKEN = 'preview-fluffyjaws-token';
const FLUFFY_OKTA = `${PREVIEW_ORIGIN}/__dev/okta`;
const FLUFFY_MCP = fakeMcpServers([{
  url: FLUFFYJAWS_MCP_URL,
  name: 'FluffyJaws 3.0',
  token: PREVIEW_FLUFFY_TOKEN,
  tools: tools([
    ['fluffyjaws_chat', 'Ask FluffyJaws a question', true],
    ['search_fluffypack', 'Search the FluffyPack knowledge', true],
    ['full_documentation_search', 'Search the product documentation', true],
    ['slack_search', 'Search Slack', true],
    ['wiki_documentation_search', 'Search the wiki', true],
    ['jira_search', 'Search Jira', true],
    ['github_code_search', 'Search code on GitHub', true],
    ['dynamics_ticket_search', 'Search support tickets', true],
    ['content_compass_recommend', 'Recommend content, and save the conversation', false],
  ], 'query'),
}]);
// The slack-automation relay's SlackMcp entrypoint, made up: a service binding in the preview
// too (SLACK_MCP). Only the admin team switches it; a team manager sees its switches disabled.
const SLACK_MCP = fakeMcpServers([{
  url: SLACK_MCP_URL,
  name: 'slack-automation-relay',
  tools: tools([
    ['channel_profile', 'Who is in a channel and how: members, guests, Slack Connect organisations', true],
    ['person_status', 'One person by email or Slack user id: their account here', true],
    ['invite_guest', 'Sends a guest invitation by email to one channel', false],
    ['add_to_channel', 'Adds a member or guest of this workspace to a channel', false],
    ['remove_from_channel', 'Removes a person from a public channel', false],
    ['invite_slack_connect', 'Sends a Slack Connect invitation by email to a public channel', false],
    ['disconnect_org', 'Disconnects a Slack Connect organisation from a channel', false],
    ['archive_channel', 'Archives a channel. Never #general', false],
  ], 'channel'),
}]);
/** FluffyJaws' Okta, made up: any code, one token; revoking does nothing. */
async function fluffyOkta(request) {
  if (new URL(request.url).pathname.endsWith('/v1/token')) {
    return Response.json({
      access_token: PREVIEW_FLUFFY_TOKEN,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'preview-fluffyjaws-refresh',
      id_token: `e30.${Buffer.from(JSON.stringify({ email: 'dana.ops@example.com', name: 'Dana Ops' })).toString('base64url')}.x`,
    });
  }
  return new Response(null, { status: 200 });
}
const { privateKey: PREVIEW_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
/** GitHub's API as far as the app needs it, for the preview: any JWT will do. */
function githubApi(request) {
  const { pathname } = new URL(request.url);
  if (pathname === '/app/installations') {
    return Response.json([{
      id: 4242, account: { login: 'acme-labs', type: 'Organization' }, repository_selection: 'selected', html_url: 'https://github.com/organizations/acme-labs/settings/installations/4242',
    }, {
      id: 4343, account: { login: 'someone-else', type: 'User' }, repository_selection: 'all',
    }]);
  }
  if (/\/access_tokens$/.test(pathname)) {
    const expires = new Date(Date.now() + 3600_000).toISOString();
    return Response.json({ token: PREVIEW_INSTALL_TOKEN, expires_at: expires }, { status: 201 });
  }
  return Response.json({ message: 'Not Found' }, { status: 404 });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const { url } = new Request(input);
  if (MCP.handles(url)) {
    return MCP.fetch(input, init);
  }
  if (url.startsWith(`${WIKI}/`)) {
    return wikiOauth(new Request(input, init));
  }
  if (GLOBAL_MCP.handles(url)) {
    return GLOBAL_MCP.fetch(input, init);
  }
  if (FLUFFY_MCP.handles(url)) {
    return FLUFFY_MCP.fetch(input, init);
  }
  if (url.startsWith(`${FLUFFY_OKTA}/`)) {
    return fluffyOkta(new Request(input, init));
  }
  if (url.startsWith('https://api.github.com/')) {
    return githubApi(new Request(input, init));
  }
  if (/^https:\/\/[^/]*\.example\//.test(url)) {
    return Promise.reject(new Error(`getaddrinfo ENOTFOUND ${new URL(url).hostname}`));
  }
  return realFetch(input, init);
};

const auth = [{ name: 'Authorization', value: `Bearer ${PREVIEW_TOKEN}` }];
const SEED_MCP = [
  {
    repo: 'kb-team-platform', name: 'docs', url: 'https://docs.mcp.example/mcp', description: 'Product documentation search', headers: auth,
  },
  {
    repo: 'kb-team-platform',
    name: 'cdn',
    url: 'https://cdn.mcp.example/mcp',
    description: 'Purge status and cache headers of the CDN',
    headers: auth,
    allow: 'purge_status, cache_headers',
  },
  {
    repo: 'kb-team-platform',
    name: 'tickets',
    url: 'https://tickets.internal.example/mcp',
    description: 'The ticket tracker',
    headers: [{ name: 'X-Api-Key', value: 'preview' }],
  },
  {
    repo: 'kb-team-platform',
    name: 'wiki',
    url: `${WIKI}/mcp`,
    description: 'The team wiki, as the person who connects it',
    auth: 'oauth',
  },
  {
    repo: 'kb-org-acme', name: 'acme-status', url: 'https://status.acme.example/mcp', description: 'ACME\'s own status service: uptime and their open incidents',
  },
];

// The computer's secrets (src/agent/secrets.js): platform ops' own two, and one of ACME's.
const SEED_SECRETS = [
  {
    repo: 'kb-team-platform', name: 'TICKETS_API_KEY', value: 'made-up-preview-key', hosts: 'tickets.internal.example', description: 'The ticket tracker\'s REST API, as a bearer token',
  },
  {
    repo: 'kb-team-platform', name: 'CDN_TOKEN', value: 'made-up-preview-token', hosts: 'api.cdn.example, *.cdn.example', description: 'Purge and cache status',
  },
  {
    repo: 'kb-org-acme', name: 'ACME_STATUS_KEY', value: 'made-up-preview-status', hosts: 'status.acme.example',
  },
];

/**
 * Channels the admin team holds (the fallback rule files them there), for the suggestions on
 * a team's page: who of the fake teams posts, reacts or is a member in them, and what Clef
 * said about each. Made-up customers and labels.
 */
const ADMIN_CHANNELS = [
  {
    id: 'CH-HOOLI',
    source: 'teams',
    group: 'xyz-hooli',
    name: 'Main',
    org: 'hooli',
    topic: 'Hooli site launch with the agency',
    titles: ['Preview links show the old header', 'Go-live checklist for the .com'],
    posts: { 3: 4, 6: 3 },
    reacts: { 1: 2 },
    members: [1, 3, 6],
    clef: { edge: 0.88, platform: 0.08, none: 0.04 },
    kind: ['channel', 0.93],
  },
  {
    id: 'CH-UMBRELLA',
    source: 'teams',
    group: 'xyz-umbrella',
    name: 'Main',
    org: 'umbrella',
    titles: ['Welcome to the team'],
    clef: { edge: 0.86, platform: 0.1, none: 0.04 },
    kind: ['channel', 0.71],
  },
  {
    id: 'CH-WONKA',
    source: 'teams',
    group: 'xyz-wonka',
    name: 'Main',
    org: 'wonka',
    titles: ['Kick-off notes', 'CDN purge after deploy'],
    posts: { 6: 2 },
    members: [1, 6],
    clef: { edge: 0.62, platform: 0.31, none: 0.07 },
    kind: ['channel', 0.88],
  },
  {
    id: 'CH-WONKA-DEV',
    source: 'teams',
    group: 'xyz-wonka',
    name: 'Developers',
    org: 'wonka',
    titles: ['Block library questions'],
    members: [1],
    clef: { edge: 0.58, platform: 0.36, none: 0.06 },
    kind: ['channel', 0.8],
  },
  {
    id: 'CH-INITECH',
    source: 'teams',
    group: 'xyz-initech',
    name: 'Main',
    org: 'initech',
    titles: ['Access for two more authors'],
    clef: { edge: 0.83, platform: 0.12, none: 0.05 },
    kind: ['channel', 0.66],
  },
  // Duplicate customers (src/orgmerge.js): ACME again, under acme-co, by its Workfront channel;
  // Wonka again, under wonkaindustries, by a Teams team of its own (a merge of it is asked for).
  {
    id: 'C0ACMECO',
    source: 'slack',
    name: 'workfront-acme-co',
    org: 'acme-co',
    topic: 'Workfront proofing for the ACME marketing team',
    titles: ['Proofing links expire after a day'],
    members: [1],
    clef: { platform: 0.7, edge: 0.2, none: 0.1 },
    kind: ['channel', 0.9],
  },
  {
    id: 'CH-WONKAIND',
    source: 'teams',
    group: 'xyz-wonkaindustries',
    name: 'Main',
    org: 'wonkaindustries',
    titles: ['SSO for the new authors'],
    members: [1, 6],
    clef: { edge: 0.6, platform: 0.3, none: 0.1 },
    kind: ['channel', 0.85],
  },
  {
    id: 'C0SOYLENT1',
    source: 'slack',
    name: 'cust-soylent',
    org: 'soylent',
    shared: 1,
    topic: 'Soylent x opspile: questions about the new site',
    titles: ['Robots.txt blocks the staging host', 'Forms submit twice', 'Redirects for the old blog'],
    posts: { 4: 6, 5: 2 },
    reacts: { 2: 2 },
    members: [2, 4, 5],
    clef: { platform: 0.81, edge: 0.15, none: 0.04 },
    kind: ['channel', 0.97],
  },
  // Channels no rule files under an org (Customers' Unassigned, src/orgassign.js): one in Wonka's
  // Teams team, one with Hooli in its name, one whose people write from a domain no org has (a
  // new org), and one that says nothing.
  {
    id: 'CH-WONKAPLAN',
    source: 'teams',
    group: 'xyz-wonka',
    name: 'Planning',
    org: '_unassigned',
    titles: ['Q3 roadmap review'],
    clef: { edge: 0.5, platform: 0.4, none: 0.1 },
    kind: ['channel', 0.8],
  },
  {
    id: 'C0HOOLISYNC',
    source: 'slack',
    name: 'hooli-adobe-sync',
    org: '_unassigned',
    titles: ['Weekly sync notes'],
    clef: { edge: 0.5, platform: 0.4, none: 0.1 },
    kind: ['channel', 0.8],
  },
  {
    id: 'C0ZORGCO',
    source: 'slack',
    name: 'zorg-and-adobe',
    org: '_unassigned',
    shared: 1,
    titles: ['Kick-off', 'SSO setup'],
    accounts: [['U-ZORG1', 'Jean-Baptiste Zorg', 'jbz@zorg.example'], ['U-ZORG2', 'Right Arm', 'arm@zorg.example']],
    clef: { platform: 0.6, edge: 0.3, none: 0.1 },
    kind: ['channel', 0.9],
  },
  {
    id: 'C0DDAUTOM',
    source: 'slack',
    name: 'dd-autom-t1',
    org: '_unassigned',
    titles: ['ping'],
    clef: { none: 0.5, platform: 0.3, edge: 0.2 },
    kind: ['channel', 0.6],
  },
  {
    id: 'C0SANDBOX3',
    source: 'slack',
    name: 'test-sandbox-3',
    org: '_unassigned',
    titles: ['test'],
    clef: { none: 0.84, platform: 0.1, edge: 0.06 },
    kind: ['ignore', 0.9],
  },
  // The team wizard's case (src/teamwizard.js): channels named for a product no team has a
  // rule for, with the same two people in most of them, known only as members, and on no team.
  ...['acme', 'globex', 'hooli', 'wonka'].map((org, n) => ({
    id: `C0LOOM${org.toUpperCase()}`,
    source: 'slack',
    name: `loom-${org}`,
    org,
    titles: ['Recording does not start'],
    accounts: [['U-KIRA', 'Kira Selby', 'kselby@example.com'], ...(n < 3 ? [['U-NOOR', 'Noor Haddad', 'nhaddad@example.com']] : [])],
    clef: { none: 0.6, platform: 0.3, edge: 0.1 },
    kind: ['channel', 0.9],
  })),
  // A customer with many channels: its tools' per-channel lists are long.
  ...Array.from({ length: 40 }, (_, n) => ({
    id: `C0INISITE${n}`,
    source: 'slack',
    name: `initech-site-${String(n + 1).padStart(2, '0')}`,
    org: 'initech',
    titles: ['Weekly check-in'],
    clef: { platform: 0.8, edge: 0.15, none: 0.05 },
    kind: ['channel', 0.9],
  })),
];

/**
 * Conflicts between team rules, threads of the admin team's inbox (src/ruleconflicts.js): Edge ops'
 * narrower `^aem-edge-` inside Platform ops' `^aem-` (either may win), and Edge ops' rule for a
 * Teams team name against Platform ops' `^aem-` (one of the other conflicts: only a keep settles
 * it). Edge ops' manual assignment of an `aem-` channel is none: it decides that channel. And a
 * follow rule of Edge ops', which its page lists. The channels have no threads, so settling moves
 * nothing.
 */
function seedRuleConflicts(DB) {
  const db = DB.sqlite;
  const at = new Date(Date.now() - 86400000).toISOString();
  for (const [id, name] of [['C0EDGEACME', 'aem-edge-acme'], ['C0EDGEHOOL', 'aem-edge-hooli'], ['C0WONKAAEM', 'aem-wonka']]) {
    db.prepare(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
      VALUES ('slack', 'T-FAKE', ?, ?, ?)`).run(id, name, at);
  }
  db.prepare(`INSERT INTO channels (source, tenant, channel_id, name, group_id, group_name, fetched_at)
    VALUES ('teams', 'T-FAKE', 'CH-STARKAEM', 'aem-stark', 'TEAM-xyz-stark', 'xyz-stark', ?)`).run(at);
  db.prepare(`INSERT INTO rules (target, priority, source, field, pattern, value, note, updated_by, updated_at)
    VALUES ('team', 60, 'teams', 'group_name', '^xyz-stark$', 'edge', 'Stark runs it with us', 'priya@example.com', ?)`).run(at);
  db.prepare(`INSERT INTO rules (target, priority, source, field, pattern, value, note, updated_by, updated_at)
    VALUES ('team', 50, NULL, 'name', '^aem-edge-', 'edge', 'Edge Delivery customers', 'priya@example.com', ?)`).run(at);
  db.prepare(`INSERT INTO rules (target, priority, source, field, pattern, value, note, updated_by, updated_at)
    VALUES ('team', 10, 'slack', 'channel_id', '^C0WONKAAEM$', 'edge', 'manual assignment', 'priya@example.com', ?)`).run(at);
  const follow = db.prepare(`INSERT INTO rules (target, priority, source, field, pattern, value, note, updated_by, updated_at)
    VALUES ('follow', 100, NULL, 'name', '^initech-', 'edge', 'their CDN questions', 'priya@example.com', ?)`).run(at);
  // Its shares, as src/followrules.js writes them.
  db.prepare(`INSERT INTO channel_teams (source, channel_id, team, added_by, added_at)
    SELECT source, channel_id, 'edge', ?, ? FROM channels WHERE name LIKE 'initech-%'`)
    .run(`rule:${follow.lastInsertRowid}`, at);
}

function seedAdminChannels(DB) {
  const at = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const db = DB.sqlite;
  db.prepare(`INSERT INTO rules (target, priority, field, pattern, value, note)
    VALUES ('team', 1000, 'channel_id', '.', 'admin', 'fallback: anything unassigned goes to admin')`).run();
  const person = db.prepare('SELECT id, name, email FROM people WHERE id = ?');
  const identity = db.prepare(`INSERT OR IGNORE INTO identities (source, tenant, user_id, kind, name, email, person, fetched_at)
    VALUES (?, 'T-FAKE', ?, 'person', ?, ?, ?, ?)`);
  ADMIN_CHANNELS.forEach((c, n) => {
    db.prepare(`INSERT INTO channels (source, tenant, channel_id, name, group_id, group_name, shared, topic, members_at, fetched_at)
      VALUES (?, 'T-FAKE', ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.source, c.id, c.name, c.group ? `TEAM-${c.group}` : null, c.group || null, c.shared || 0, c.topic || null, at(1), at(1));
    if (c.org !== '_unassigned') {
      db.prepare(`INSERT INTO rules (target, priority, source, field, pattern, value, note)
        VALUES ('org', 10, ?, 'channel_id', ?, ?, 'manual assignment')`).run(c.source, `^${c.id}$`, c.org);
    }
    c.titles.forEach((title, i) => {
      const root = `${c.id}-${i}`;
      const thread = `${c.source}:T-FAKE:${c.id}:${root}`;
      const when = at(n * 3 + i * 5 + 1);
      db.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind, channel_name, title,
          path, root_at, last_at, any_at, messages, updated_at)
        VALUES (?, ?, 'T-FAKE', ?, ?, ?, 'admin', 'channel', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(thread, c.source, c.id, root, c.org, c.name, title, `channels/${c.org}/admin/${c.source}-${c.id}/${root}/`, when, when, when, 1, when);
      if (i === 0) {
        Object.entries(c.posts || {}).forEach(([id, count]) => {
          for (let k = 0; k < count; k += 1) {
            db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person, staff, counted, author_key)
              VALUES (?, 'T-FAKE', ?, ?, ?, ?, ?, ?, 1, ?)`).run(c.source, c.id, `${root}-${id}-${k}`, thread, when, Number(id), Number(id) <= 4 ? 1 : 0, `${c.source}:T-FAKE:U-${id}`);
          }
        });
        Object.entries(c.reacts || {}).forEach(([id, count]) => {
          const p = person.get(Number(id));
          identity.run(c.source, `U-${id}`, p.name, p.email, p.id, at(0));
          for (let k = 0; k < count; k += 1) {
            db.prepare(`INSERT INTO reactions (message, thread, emoji, user_key, at)
              VALUES (?, ?, ?, ?, ?)`).run(`${c.source}:T-FAKE:${c.id}:${root}`, thread, ['+1', 'eyes'][k % 2], `${c.source}:T-FAKE:U-${id}`, when);
          }
        });
      }
    });
    (c.members || []).forEach((id) => {
      const p = person.get(id);
      db.prepare(`INSERT INTO channel_members (source, tenant, channel_id, user_id, email, name)
        VALUES (?, 'T-FAKE', ?, ?, ?, ?)`).run(c.source, c.id, `U-${id}`, p.email, p.name);
    });
    (c.accounts || []).forEach(([user, name, email]) => {
      db.prepare(`INSERT INTO channel_members (source, tenant, channel_id, user_id, email, name)
        VALUES (?, 'T-FAKE', ?, ?, ?, ?)`).run(c.source, c.id, user, email, name);
    });
    const [team, p] = Object.entries(c.clef).sort((a, b) => b[1] - a[1])[0];
    db.prepare(`INSERT INTO channel_labels (source, tenant, channel_id, team, team_p, teams, kind, kind_p,
        labeled_through, options, model, labeled_at) VALUES (?, 'T-FAKE', ?, ?, ?, ?, ?, ?, '', 'edge,platform', 'clef', ?)`)
      .run(c.source, c.id, team, p, JSON.stringify(c.clef), c.kind[0], c.kind[1], at(0));
  });
}

/**
 * Edge ops' suggested members (src/membersuggest.js): Priya works its threads, Tom reacts in one,
 * Kira and Noor are only members of its channels (Kira of more), and the topic map's people of a
 * topic that is mostly Edge ops' threads work it elsewhere, two of them known by mail address.
 * Made up.
 */
function seedMemberSuggestions(DB) {
  const db = DB.sqlite;
  const at = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const threads = db.prepare(`SELECT thread, source, tenant, channel_id FROM threads
    WHERE team = 'edge' AND source IN ('slack', 'teams') ORDER BY last_at DESC LIMIT 6`).all();
  threads.slice(0, 4).forEach((t, i) => {
    db.prepare(`INSERT OR IGNORE INTO messages (source, tenant, channel_id, id, thread, at, person, staff, counted, author_key)
      VALUES (?, ?, ?, ?, ?, ?, 2, 1, 1, ?)`).run(t.source, t.tenant, t.channel_id, `msug-${i}`, t.thread, at(i + 1), `${t.source}:${t.tenant}:U-2`);
  });
  if (threads[0]) {
    const t = threads[0];
    db.prepare(`INSERT OR IGNORE INTO identities (source, tenant, user_id, kind, name, email, person, fetched_at)
      VALUES (?, ?, 'U-4', 'person', 'Tom Okafor', 'tom@example.com', 4, ?)`).run(t.source, t.tenant, at(0));
    db.prepare('INSERT OR IGNORE INTO reactions (message, thread, emoji, user_key, at) VALUES (?, ?, \'eyes\', ?, ?)')
      .run(`${t.thread}:msug`, t.thread, `${t.source}:${t.tenant}:U-4`, at(3));
  }
  const channels = [...new Map(threads.map((t) => [`${t.source}:${t.channel_id}`, t])).values()];
  channels.forEach((c, i) => {
    const member = db.prepare(`INSERT OR IGNORE INTO channel_members (source, tenant, channel_id, user_id, email, name)
      VALUES (?, ?, ?, ?, ?, ?)`);
    member.run(c.source, c.tenant, c.channel_id, 'U-KIRA', 'kselby@example.com', 'Kira Selby');
    if (i === 0) {
      member.run(c.source, c.tenant, c.channel_id, 'U-NOOR', 'nhaddad@example.com', 'Noor Haddad');
    }
    db.prepare(`UPDATE channels SET members_at = ?, members_error = NULL
      WHERE source = ? AND tenant = ? AND channel_id = ?`).run(at(1), c.source, c.tenant, c.channel_id);
  });
  // The topic map's smallest topic gets Edge ops' threads, and its people are known here.
  const row = db.prepare('SELECT id, map FROM topic_maps ORDER BY built_at DESC, id DESC LIMIT 1').get();
  if (!row || !threads.length) {
    return;
  }
  const map = JSON.parse(row.map);
  const [topic] = [...map.topics].sort((a, b) => a.size - b.size);
  const crew = new Set(map.threads.filter((t) => t.topic === topic.id)
    .flatMap((t) => Object.keys(t.staff).map(Number)));
  const known = new Set(db.prepare('SELECT name FROM people').all().map((p) => p.name));
  const newcomers = [...crew].filter((id) => map.people[id] && !known.has(map.people[id]));
  newcomers.slice(0, 2).forEach((id) => {
    const name = map.people[id];
    db.prepare('INSERT OR IGNORE INTO people (id, email, name, staff) VALUES (?, ?, ?, 1)')
      .run(id, `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`, name);
  });
  for (const t of threads) {
    map.threads.push({
      key: t.thread,
      title: '',
      team: 'edge',
      org: 'opspile',
      at: at(5),
      last: at(4),
      messages: 3,
      kind: 'question',
      tags: [],
      products: [],
      topic: topic.id,
      sim: 0.5,
      staff: {},
      customers: {},
    });
  }
  topic.size += threads.length;
  db.prepare('UPDATE topic_maps SET map = ? WHERE id = ?').run(JSON.stringify(map), row.id);
}

/**
 * The bots under the admin page's Requests (src/ourbots.js): the fake inbox's bots with their
 * messages, Alertmanager and opspile waiting for an admin to say whose they are, one an admin said
 * is Adobe's (Provisioning Agent, on Adobe's side in its thread, which an admin also
 * named and gave a picture: on Teams it posts as its registration, `provisioning-agent`, with
 * none), and one external that only posts alerts, only mentioned. Made up.
 */
function seedBots(DB, store) {
  const db = DB.sqlite;
  const saidBy = [...store.people.values()].find((p) => p.staff) || {};
  const BOTS = [
    {
      name: 'Provisioning Agent',
      source: 'teams',
      id: 'BOT-PROVISIONING',
      ours: 1,
      at: 3,
      posts: 'provisioning-agent',
      picture: '/icon-192.png',
    },
    { name: 'Alertmanager', source: 'slack', id: 'B0ALERTMANAGER' },
    { name: 'opspile', source: 'slack', id: 'B0OPSPILE' },
    {
      name: 'Deploy Notifier', handle: 'deploy', source: 'teams', id: 'BOT-DEPLOY', ours: 0, at: 9, alerts: 1,
    },
  ];
  for (const b of BOTS) {
    const tenants = new Set();
    for (const entry of store.threads.values()) {
      for (const m of entry.messages.filter((x) => x.author.kind === 'bot' && x.author.name === b.name
        && entry.row.source === b.source)) {
        tenants.add(entry.row.tenant);
        db.prepare(`INSERT OR IGNORE INTO messages (source, tenant, channel_id, id, thread, at, staff,
            counted, deleted, author_key, author_kind, preview)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'bot', ?)`)
          .run(
            entry.row.source,
            entry.row.tenant,
            entry.row.channel_id,
            m.id,
            entry.key,
            m.at,
            b.ours ? 1 : 0,
            `${entry.row.source}:${entry.row.tenant}:${b.id}`,
            previewOf(m.body || ''),
          );
      }
    }
    const said = b.ours === undefined ? null : new Date(Date.now() - b.at * 86400000).toISOString();
    for (const tenant of tenants.size ? tenants : ['T-FAKE']) {
      db.prepare(`INSERT OR IGNORE INTO identities (source, tenant, user_id, kind, name, handle,
          fetched_at, ours, ours_by, ours_at, display_name, display_avatar, alerts)
          VALUES (?, ?, ?, 'bot', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          b.source,
          tenant,
          b.id,
          b.posts || b.name,
          b.handle || null,
          new Date().toISOString(),
          b.ours ?? null,
          said && saidBy.email,
          said,
          b.posts ? b.name : null,
          b.picture || null,
          b.alerts || null,
        );
    }
  }
}

/**
 * The Teams tenant's own admin accounts under the admin page's Requests (src/accountlinks.js):
 * two that nobody said whose they are yet, one with messages in a Teams thread, and one an admin
 * linked to a colleague. Made up, as their tenant's domain.
 */
/**
 * Partners: Agency Co, a partner org whose threads Ravi and a colleague post in, so the inbox
 * finds agency.example to be its domain (src/partners.js), and one of ACME's people in one of
 * them, whose domain is left out as ACME's own; and the admin team's rows over what is found:
 * agency.co.uk added by hand, and a freelancer's domain said not to be a partner's.
 */
function seedPartners(DB) {
  const db = DB.sqlite;
  const at = new Date(Date.now() - 3 * 86400000).toISOString();
  db.exec(`INSERT OR IGNORE INTO orgs (slug, name, type, icon, updated_at) VALUES
    ('agency', 'Agency Co', 'partner', NULL, '2026-10-20T09:00:00Z');
    INSERT OR IGNORE INTO people (id, email, name, staff) VALUES (61, 'lee@agency.example', 'Lee Ward', 0);
    INSERT OR IGNORE INTO identities (source, tenant, user_id, kind, name, email, person, fetched_at) VALUES
      ('slack', 'T-FAKE', 'TP-61', 'person', 'Lee Ward', 'lee@agency.example', 61, '${at}'),
      ('slack', 'T-FAKE', 'TP-AG-8', 'person', 'Ravi Kumar', 'ravi@agency.example', 8, '${at}'),
      ('slack', 'T-FAKE', 'TP-AG-52', 'person', 'Elena Marsh', 'elena@acme.example', 52, '${at}');
    INSERT INTO partner_domains (domain, name, org, excluded, updated_by, updated_at) VALUES
      ('agency.co.uk', NULL, 'agency', 0, 'priya@example.com', '${at}'),
      ('freelance.example', NULL, NULL, 1, 'priya@example.com', '${at}')`);
  const thread = db.prepare(`INSERT OR IGNORE INTO threads (thread, source, tenant, channel_id, root_id,
      org, team, kind, channel_name, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, 'slack', 'T-FAKE', 'C0AGENCY1', ?, 'agency', 'platform', 'channel', 'ext-agency', 'p/',
      ?, ?, ?, 2, ?)`);
  const message = db.prepare(`INSERT OR IGNORE INTO messages (source, tenant, channel_id, id, thread, at,
      person, staff, counted, deleted, author_key) VALUES ('slack', 'T-FAKE', 'C0AGENCY1', ?, ?, ?, ?, 0, 1, 0, ?)`);
  const posts = [['1', [8, 61]], ['2', [61, 8]], ['3', [8, 52]]];
  for (const [root, who] of posts) {
    const key = `slack:T-FAKE:C0AGENCY1:ag-${root}`;
    thread.run(key, `ag-${root}`, at, at, at, at);
    for (const id of who) {
      message.run(`ag-${root}-${id}`, key, at, id, `slack:T-FAKE:${id === 61 ? 'TP-61' : `TP-AG-${id}`}`);
    }
  }
}

function seedAccounts(DB, store) {
  const db = DB.sqlite;
  const staff = [...store.people.values()].filter((p) => p.staff);
  const teams = [...store.threads.values()].find(({ row }) => row.source === 'teams');
  const tenant = teams ? teams.row.tenant : 'T-FAKE';
  const ACCOUNTS = [
    { id: 'U-OWNER-AB', name: 'AB', posts: 2 },
    { id: 'U-OWNER-CD', name: 'CD' },
    {
      id: 'U-OWNER-EF', name: 'EF', person: staff[1] || staff[0], posts: 1,
    },
  ];
  for (const a of ACCOUNTS) {
    const linked = a.person ? new Date(Date.now() - 2 * 86400000).toISOString() : null;
    db.prepare(`INSERT OR IGNORE INTO identities (source, tenant, user_id, kind, name, email,
        fetched_at, company, staff, guest, person, linked_by, linked_at)
        VALUES ('teams', ?, ?, 'person', ?, ?, ?, 'Adobe', 1, 0, ?, ?, ?)`)
      .run(
        tenant,
        a.id,
        a.name,
        `owner_${a.name.toLowerCase()}@support-tenant.example`,
        new Date().toISOString(),
        a.person ? a.person.id : null,
        linked && staff[0].email,
        linked,
      );
    for (let i = 0; teams && i < (a.posts || 0); i += 1) {
      db.prepare(`INSERT OR IGNORE INTO messages (source, tenant, channel_id, id, thread, at, staff,
          counted, deleted, author_key, author_kind, author, person)
        VALUES ('teams', ?, ?, ?, ?, ?, 1, 1, 0, ?, 'person', ?, ?)`)
        .run(
          tenant,
          teams.row.channel_id,
          `${a.id}-${i}`,
          teams.key,
          new Date(Date.now() - (i + 1) * 3600000).toISOString(),
          `teams:${tenant}:${a.id}`,
          a.person ? a.person.name : a.name,
          a.person ? a.person.id : null,
        );
    }
  }
}

/** The thread agents the answers to their questions go to: they take them, and do nothing. */
const DEV_AGENTS = {
  idFromName: (name) => name,
  get: () => ({ __unsafe_ensureInitialized: async () => {}, answered: async () => ({ ok: true }) }),
};

export function createAdmin(store, { manager = false, member = false, bases = [] } = {}) {
  const teamRows = store.teams.some((t) => t.slug === 'admin')
    ? store.teams.map(({ slug, name }) => ({ slug, name }))
    : [{ slug: 'admin', name: 'Admin' }, ...store.teams.map(({ slug, name }) => ({ slug, name }))];
  // A long name, self-managed: its row in the list is as high as the others, the name first.
  teamRows.push({ slug: 'experience-workspace', name: 'Experience Modernization Workspace', self_managed: 1 });
  const DB = d1({
    teams: teamRows,
    people: [...store.people.values()].map((p) => ({
      id: p.id,
      email: p.email,
      name: p.name,
      staff: p.staff ? 1 : 0,
      teams: [...new Set([
        ...store.teams.filter((t) => t.members.includes(p.id)).map((t) => t.slug),
        ...(p.id === 1 ? ['admin'] : []),
      ])],
    })),
    rules: [
      {
        id: 1, target: 'org', priority: 100, source: null, field: 'name', pattern: '^aem-(.+)$', value: '$1',
      },
      {
        id: 2, target: 'team', priority: 100, source: null, field: 'name', pattern: '^aem-', value: 'platform',
      },
    ],
  });
  const CHANNELS = fakeBucket();
  const seen = new Set();
  for (const { row } of store.threads.values()) {
    const ch = `${row.source}:${row.tenant}:${row.channel_id}`;
    if (!seen.has(ch)) {
      seen.add(ch);
      DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
        VALUES (?, ?, ?, ?, ?)`).run(row.source, row.tenant, row.channel_id, row.channel_name, row.updated_at || row.any_at);
    }
    const path = `channels/${row.org}/${row.team}/${row.source}-${row.channel_id}/${row.root_id}/`;
    DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        kind, channel_name, path, root_at, last_at, any_at, messages, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...[
      row.thread, row.source, row.tenant, row.channel_id, row.root_id, row.org, row.team,
      row.kind || 'channel', row.channel_name, path, row.root_at, row.last_at, row.any_at,
      row.messages || 1, row.any_at,
    ]);
    CHANNELS.objects.set(`${path}${row.root_id}.md`, { body: '---\n---\n', options: {} });
  }
  // The fake channels are filed by hand, not by the rules: make the rules say the same, so a
  // change tried in the preview only moves what it should.
  const rule = DB.sqlite.prepare(`INSERT INTO rules (target, priority, source, field, pattern, value, note)
    VALUES (?, ?, ?, 'channel_id', ?, ?, ?)`);
  const kinds = new Map();
  for (const { row } of store.threads.values()) {
    kinds.set(row.channel_id, row);
  }
  for (const [id, row] of kinds) {
    const pattern = `^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    if (!/^aem-/.test(row.channel_name)) {
      rule.run('team', 10, row.source, pattern, row.team, 'manual assignment');
      rule.run('org', 10, row.source, pattern, row.org, 'manual assignment');
    } else if (row.team !== 'platform') {
      rule.run('team', 10, row.source, pattern, row.team, 'manual assignment');
    }
    if (row.kind && row.kind !== 'channel') {
      rule.run('kind', 10, row.source, pattern, row.kind, null);
    }
  }
  seedAdminChannels(DB);
  seedRuleConflicts(DB);
  seedBots(DB, store);
  seedAccounts(DB, store);
  // What the preview costs: the COGS dashboard's made-up usage (dev-ui-cogs.mjs).
  seedCogs(DB);
  // The Topics page's map (dev-ui-topics.mjs).
  seedTopicMap(DB);
  seedMemberSuggestions(DB);
  // Platform ops' half year, for its overview (dev-ui-team.mjs).
  seedTeamProfile(DB);
  // And ACME's, for its overview (dev-ui-customer.mjs).
  seedCustomerProfile(DB);
  // And Initech's, a vendor's: its cases, status posts and the customers on its products
  // (dev-ui-vendor.mjs).
  seedVendorProfile(DB);
  seedPartners(DB);
  // The people outside Adobe post in their org's threads, so each org has a usual mail
  // domain: the org list shows its favicon when the org has no icon (src/admin.js).
  for (const p of store.people.values()) {
    const t = !p.staff && p.org && [...store.threads.values()].find(({ row }) => row.org === p.org);
    if (t) {
      const key = `${t.row.source}:${t.row.tenant}:U-MAIL-${p.id}`;
      DB.sqlite.prepare(`INSERT OR IGNORE INTO identities (source, tenant, user_id, kind, name, email, person, fetched_at)
        VALUES (?, ?, ?, 'person', ?, ?, ?, ?)`).run(t.row.source, t.row.tenant, `U-MAIL-${p.id}`, p.name, p.email, p.id, t.row.last_at);
      DB.sqlite.prepare(`INSERT OR IGNORE INTO messages (source, tenant, channel_id, id, thread, at, person, staff, counted, deleted, author_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?)`).run(t.row.source, t.row.tenant, t.row.channel_id, `mail-${p.id}`, t.row.thread, t.row.last_at, p.id, key);
    }
  }
  DB.sqlite.exec(`INSERT INTO orgs (slug, name, type, icon, updated_at) VALUES
    ('acme', 'ACME Corporation', 'customer', 'acme.example', '2026-10-20T09:00:00Z'),
    ('initech', 'Initech', 'vendor', NULL, '2026-10-20T09:00:00Z'),
    ('hooli', 'Hooli Inc.', 'customer', NULL, '2026-10-20T09:00:00Z'),
    ('wonka', 'Wonka Industries', 'customer', NULL, '2026-10-20T09:00:00Z'),
    ('soylent', 'Soylent Corporation', 'customer', NULL, '2026-10-20T09:00:00Z'),
    ('opspile', 'opspile', 'internal', NULL, '2026-10-20T09:00:00Z'),
    ('acme-co', 'ACME Corporation', 'customer', 'acme.example', '2026-10-20T09:00:00Z'),
    ('wonkaindustries', 'Wonka Industries Ltd', 'customer', NULL, '2026-10-20T09:00:00Z')`);
  // Channels Lena (a member of Edge ops) asked the admin team for: one the admin team holds
  // (confirming moves it), one Platform ops holds (confirming shares it), and one declined; and
  // one her thread's agent asked to move for her.
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  DB.sqlite.prepare(`INSERT INTO channel_requests (source, channel_id, team, note, status, requested_by,
      requested_name, requested_at, decided_by, decided_name, decided_at, reason) VALUES
    ('teams', 'CH-HOOLI', 'edge', 'We run the Hooli launch with their agency; Clef agrees.', 'open',
      'lena@example.com', 'Lena Berg', ?, NULL, NULL, NULL, NULL),
    ('slack', 'C0INITECH1', 'edge', 'Their CDN questions end up with us anyway.', 'open',
      'lena@example.com', 'Lena Berg', ?, NULL, NULL, NULL, NULL),
    ('slack', 'C0SANDBOX3', 'edge', NULL, 'declined', 'lena@example.com', 'Lena Berg', ?,
      'priya@example.com', 'Priya Nair', ?, 'A test channel: nothing to follow there.')`)
    .run(ago(2), ago(0.2), ago(6), ago(5));
  // One the agent of an Umbrella thread filed for Lena from its sidebar: a move, out of
  // Platform ops.
  const umbrella = [...store.threads.values()].find(({ row }) => row.channel_id === 'C0UMBRELLA');
  DB.sqlite.prepare(`INSERT INTO channel_requests (source, channel_id, team, note, status, requested_by,
      requested_name, requested_at, move, thread) VALUES ('slack', 'C0UMBRELLA', 'edge', ?, 'open',
      'lena@example.com', 'Lena Berg', ?, 1, ?)`)
    .run('Lena says Umbrella is an Edge ops customer: the channel is filed by the aem- rule, which every EDS channel matches.', ago(0.05), umbrella ? umbrella.row.thread : null);
  // The admin team's decision log of the Hooli request, a thread of its inbox
  // (src/requestthreads.js): what Priya found out, and what Dana asked.
  DB.sqlite.prepare(`INSERT INTO request_log (request, type, body, person, author_name, author_email, at)
    VALUES ('request:channel:1', 'note', ?, 2, 'Priya Nair', 'priya@example.com', ?),
      ('request:channel:1', 'note', ?, 1, 'Dana Ops', 'dana@example.com', ?)`)
    .run(
      'Checked with Platform ops: they keep the channel and are fine with Edge ops following it. Sharing is enough, no move.',
      ago(1.2),
      'Agreed. Lena, ping us here if you need it filed under Edge ops after the launch.',
      ago(1.1),
    );

  // People thread agents asked to be added to Edge ops, for whoever asked them in a sidebar
  // (src/memberrequests.js): Tom for himself, Lena for a colleague the inbox has not met, and
  // one declined.
  DB.sqlite.prepare(`INSERT INTO member_requests (team, email, name, note, status, requested_by,
      requested_name, requested_at, thread, decided_by, decided_name, decided_at, reason) VALUES
    ('edge', 'tom@example.com', 'Tom Okafor', ?, 'open', 'tom@example.com', 'Tom Okafor', ?, ?,
      NULL, NULL, NULL, NULL),
    ('edge', 'sam.ortiz@example.com', 'Sam Ortiz', ?, 'open', 'lena@example.com', 'Lena Berg', ?, ?,
      NULL, NULL, NULL, NULL),
    ('edge', 'kselby@example.com', 'Kira Selby', 'Covers for Lena in August.', 'declined',
      'lena@example.com', 'Lena Berg', ?, NULL, 'priya@example.com', 'Priya Nair', ?,
      'Kira is on Platform ops: share the channels instead.')`)
    .run(
      'Tom works the Umbrella launch with Edge ops and wants its inbox.',
      ago(0.1),
      umbrella ? umbrella.row.thread : null,
      'Lena says Sam joins Edge ops next week, for the CDN questions.',
      ago(0.6),
      umbrella ? umbrella.row.thread : null,
      ago(8),
      ago(7),
    );

  // A thread agent's question to Dana (src/questions.js): how she raised Globex's image limit, for
  // the runbook Priya asked about in the sidebar. A thread of Dana's inbox, Edge ops' and her
  // personal view; and one she answered last week.
  const images = [...store.threads.values()].find(({ row }) => row.title === 'Preview fails over 200 images');
  if (images) {
    DB.sqlite.prepare(`INSERT OR IGNORE INTO sidebar_messages (id, thread, role, person, body, at)
      VALUES ('sb_dev_images', ?, 'person', 2, 'Do we have a runbook for raising the image limit?', ?)`)
      .run(images.row.thread, ago(0.11));
    const asked = { id: 'sb_dev_images' };
    DB.sqlite.prepare(`INSERT INTO questions (id, thread, team, title, email, name, purpose, why,
        items, sidebar, status, asked_at, deadline, answers, decided_at) VALUES
      ('a1b2c3d4e5f6', ?1, 'edge', ?2, 'dana@example.com', 'Dana Ops', 'runbook', ?3, ?4, ?5, 'open', ?6, ?7, NULL, NULL),
      ('0f1e2d3c4b5a', ?1, 'edge', ?2, 'dana@example.com', 'Dana Ops', 'fact', ?8, ?9, NULL, 'answered', ?10, ?11, ?12, ?13)`)
      .run(
        images.row.thread,
        images.row.title,
        'You raised the image limit for globex/www in this thread. kb-team knows the key (limits.maxImages) but not how it is set, its scope or how to undo it: I am writing the runbook Priya asked for.',
        JSON.stringify([
          { text: 'How did you set it?', guess: 'POST the whole site config with limits.maxImages', choices: ['POST the whole site config with limits.maxImages', 'The org config, for every site', 'The staff config tool'] },
          { text: 'Does it apply to globex/www only, or to every site of the org?', guess: 'globex/www only', choices: ['globex/www only', 'Every site of globex'] },
          { text: 'How is it set back to the default?' },
        ]),
        asked ? asked.id : null,
        ago(0.1),
        new Date(Date.now() + 2.9 * 86400000).toISOString(),
        'Mei said the 200 image limit came with a release last month; I could not confirm it.',
        JSON.stringify([{ text: 'Is the image limit 200 by default for every site?', guess: 'yes' }]),
        ago(8),
        ago(5),
        JSON.stringify([{ pick: 'yes', text: 'Since early 2025; it was only enforced later.' }]),
        ago(7.8),
      );
  }

  // Lena asks for Wonka's two orgs to be one (src/orgmerge.js): it waits in the admin team's inbox.
  DB.sqlite.prepare(`INSERT INTO org_merge_requests (slug, into_slug, note, requested_by, requested_name,
      requested_at) VALUES ('wonkaindustries', 'wonka', ?, 'lena@example.com', 'Lena Berg', ?)`)
    .run('Their second Teams team: the same company, the same people.', ago(0.3));

  // Edge ops follows Universal Editor and Experience Workspace (src/follows.js): its page lists
  // them, and the inbox's tech stack dropdown says so.
  DB.sqlite.prepare(`INSERT INTO team_follows (team, tech, added_by, added_at) VALUES
    ('edge', 'ue', 'lena@example.com', ?), ('edge', 'xw', 'lena@example.com', ?)`).run(ago(3), ago(1));

  // A Platform ops channel shared with Edge ops: Edge ops' page says "shared by Platform ops",
  // and the admin team (or whoever manages both teams) can make Edge ops its team instead.
  DB.sqlite.prepare(`INSERT INTO channel_teams (source, channel_id, team, added_by, added_at)
    SELECT source, channel_id, 'edge', 'priya@example.com', ? FROM threads
    WHERE team = 'platform' AND channel_id NOT IN ('C0UMBRELLA', 'C0INITECH1')
    ORDER BY channel_id LIMIT 1`).run(ago(4));

  // Edge ops follows ACME (a follow rule of field `org`, src/rules.js): ACME's channels are shared
  // with it, which `syncFollowRules` writes (below). One of Platform ops' ACME threads is still
  // filed under Forms ops, a re-filing not done: ACME's page shows the channel once, and says so.
  DB.sqlite.prepare(`INSERT INTO rules (target, priority, source, field, pattern, value, note, updated_by,
      updated_at) VALUES ('follow', 100, NULL, 'org', '^acme$', 'edge', 'follows the customer',
      'lena@example.com', ?)`).run(ago(2));
  DB.sqlite.exec(`UPDATE threads SET team = 'forms', path = replace(path, '/platform/', '/forms/')
    WHERE thread = (SELECT thread FROM threads WHERE channel_id = 'C0ACMEAEM' ORDER BY any_at LIMIT 1)`);

  // Customers waiting in the customer portal (src/portalrequests.js): one who picked what Edge
  // ops follows (its managers may open a channel too), one nobody follows, and one declined.
  const lobby = (domain, company, tech, note, members, at, status = 'open', decided = []) => DB.sqlite
    .prepare(`INSERT INTO portal_requests (portal, domain, company, tech, note, members, requested_by,
      requested_name, requested_at, seq, status, decided_by, decided_name, decided_at, reason)
      VALUES ('dev', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
    .run(
      domain,
      company,
      JSON.stringify(tech),
      note,
      JSON.stringify(members),
      members[0].email,
      members[0].name,
      at,
      status,
      ...[0, 1, 2, 3].map((i) => decided[i] ?? null),
    );
  lobby('wayne.example', 'Wayne Enterprises', ['eds', 'ue', 'da'], 'We cannot use Slack or Teams with vendors. We go live with Edge Delivery in March and need a line to the people who run it.', [
    {
      id: 'u1', name: 'Lucius Fox', email: 'lucius.fox@wayne.example', joined: true,
    },
    {
      id: 'u2', name: 'Selina Kyle', email: 'selina.kyle@wayne.example', joined: true,
    },
    {
      id: 'u3', name: 'Harvey Dent', email: 'harvey.dent@wayne.example', joined: false,
    },
  ], ago(0.4));
  lobby('stark.example', 'Stark Industries', ['commerce', 'aco'], null, [{
    id: 'u4', name: 'Pepper Potts', email: 'pepper.potts@stark.example', joined: true,
  }], ago(1.5));
  lobby('duff.example', 'Duff Brewing', ['analytics'], 'Dashboards.', [{
    id: 'u5', name: 'Duffman', email: 'duffman@duff.example', joined: true,
  }], ago(9), 'declined', ['priya@example.com', 'Priya Nair', ago(8), 'You have a Slack channel with us: ask there.']);

  // The knowledge bases of the fake editor (dev-ui-kb.mjs), so its channel and agent routes
  // (src/kbadmin.js) find them; agents are "configured", and on in one channel by default.
  for (const b of bases) {
    DB.sqlite.prepare(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at, entries)
      VALUES (?, ?, ?, 'dev', ?, ?)`).run(b.repo, b.kind, b.slug, b.created_at, b.entries ?? null);
  }
  const queued = [];
  const env = {
    DB,
    CHANNELS,
    NORMALIZE: { send: async (body) => queued.push(body) },
    AGENTS: {},
    // The customer portal's Worker, made up: it opens a channel, takes the welcome message and
    // a decline, and tells nothing back.
    PORTAL: {
      open: async ({ name }) => ({
        ok: true, channel: { id: `c${Date.now().toString(36).padStart(12, '0')}`, name },
      }),
      post: async () => ({ ok: true, id: `m${Date.now().toString(36).padStart(15, '0')}` }),
      decline: async () => ({ ok: true }),
    },
    AGENT_MODEL: 'dev',
    AGENT_CHANNELS: 'C0ACMEAEM',
    // The fake inbox's staff (the team wizard counts only them).
    STAFF_DOMAINS: 'example.com',
    // Seals the MCP servers' headers; made up for the preview.
    TOKEN_KEY: Buffer.alloc(32, 9).toString('base64url'),
    PUBLIC_ORIGIN: PREVIEW_ORIGIN,
    // The relay's channel-management MCP server, as a service binding.
    SLACK_MCP: { fetch: (request) => SLACK_MCP.fetch(request) },
    // FluffyJaws' Okta and opspile's client there, made up.
    FLUFFYJAWS_ISSUER: FLUFFY_OKTA,
    FLUFFYJAWS_CLIENT_ID: 'made-up-okta-client',
    // The agent tools (src/agent/agenttools.js) can run: a bot to post as, a Worker Loader,
    // which runs extraction scripts (src/extract.js) in this process, with network access: the
    // preview's scripts are your own.
    SLACK_BOT_TOKEN: 'xoxb-made-up-preview-token',
    // The images of the computers on the SLICC kernel, as the bucket lists them
    // (scripts/computer-images.mjs): the real ones' names and layers, with made-up sizes, and
    // not the renderer Worker's, which the index leaves out.
    IMAGES: fakeBucket({
      'images/index.json': JSON.stringify({
        v: 2,
        images: IMAGES.filter((image) => !image.internal).map((image, i) => ({
          name: image.name,
          title: image.title,
          description: image.description,
          digest: `dev-${image.name}`,
          bytes: (10 + 6 * i) * 1024 * 1024,
          layers: layerNames(image),
        })),
      }),
    }),
    LOADER: {
      get: (id, make) => ({
        getEntrypoint: () => ({
          fetch: async (url, init) => {
            const code = make().modules['rule.js'];
            try {
              const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
              const out = await mod.default(JSON.parse(init.body));
              return Response.json({ results: Array.isArray(out) ? out : [] });
            } catch (e) {
              return Response.json({ error: String(e.message || e) });
            }
          },
        }),
      }),
    },
    TEAMS_APP_ID: 'made-up-catalog-id',
    MS_CLIENT_ID: 'made-up-app-id',
    MS_CLIENT_SECRET: 'made-up-secret',
    MS_TENANT_ID: 'made-up-tenant',
  };
  const githubApp = NO_GITHUB ? Promise.resolve() : seal(env, pkcs8Pem(PREVIEW_KEY)).then((key) => {
    DB.sqlite.prepare(`INSERT INTO github_apps (id, slug, name, owner, html_url, client_id, private_key,
        created_by, created_at) VALUES (1, 'opspile-preview', 'opspile preview', 'acme-labs',
        'https://github.com/apps/opspile-preview', 'Iv1.preview', ?, 'dev', '2026-10-20T09:00:00Z')`).run(key);
    // Allowed on acme-labs; someone-else installed it too, and waits to be allowed.
    DB.sqlite.exec(`INSERT INTO github_installations (id, app_id, account, approved_by, approved_at)
      VALUES (4242, 1, 'acme-labs', 'dana@example.com', '2026-10-21T09:00:00Z')`);
    // Turned on for the platform team already.
    DB.sqlite.exec(`INSERT INTO mcp_global_switches (server, scope, target, enabled, changed_by, changed_at)
      VALUES ('github', 'team', 'platform', 1, 'Dana', '2026-10-24T09:00:00Z')`);
  });
  // FluffyJaws, connected by Dana as her Okta self, and on in one of platform's channels.
  const fluffyGrant = NO_FLUFFYJAWS ? Promise.resolve() : seal(env, JSON.stringify({
    access_token: PREVIEW_FLUFFY_TOKEN, refresh_token: 'preview-fluffyjaws-refresh', token_type: 'Bearer',
  })).then((tokens) => {
    DB.sqlite.prepare(`INSERT INTO mcp_global_grants (server, tokens, acts_as, acts_as_name,
        connected_by, connected_at, expires_at, refreshed_at) VALUES ('fluffyjaws', ?,
        'dana.ops@example.com', 'Dana Ops', 'dana@example.com', '2026-10-26T09:00:00Z', ?,
        '2026-10-26T09:00:00Z')`).run(tokens, new Date(Date.now() + 365 * 86400_000).toISOString());
    DB.sqlite.exec(`INSERT INTO mcp_global_switches (server, scope, target, enabled, changed_by, changed_at)
      VALUES ('fluffyjaws', 'channel', 'C0INITECH1', 1, 'Dana', '2026-10-26T09:05:00Z')`);
  });
  // The computer is on for the platform team already, and posting in one of its channels: the
  // per-channel lists put the channels switched on their own first. Web search is on for the
  // team as migration 0077 turned it on (without Workers AI here, the page says it cannot run),
  // and reading the customer's channels as migration 0102 did, with one channel opted out.
  DB.sqlite.exec(`INSERT INTO agent_tool_switches (tool, scope, target, enabled, changed_by, changed_at) VALUES
    ('computer', 'team', 'platform', 1, 'Dana', '2026-10-24T09:00:00Z'),
    ('post_message', 'channel', 'C0INITECH1', 1, 'Dana', '2026-10-25T09:00:00Z'),
    ('any_thread', 'channel', 'C0EDGEQ01', 1, 'Dana', '2026-10-25T09:00:00Z'),
    ('web_search', 'team', 'platform', 1, 'migration 0077', '2026-11-18T00:00:00Z'),
    ('org_threads', 'team', 'platform', 1, 'migration 0102', '2026-11-25T00:00:00Z'),
    ('org_threads', 'channel', 'C0INITECH1', 0, 'Dana', '2026-11-25T09:00:00Z');
    INSERT INTO mcp_global_switches (server, scope, target, enabled, changed_by, changed_at)
      VALUES ('github', 'channel', 'C0GLOBEX01', 1, 'Dana', '2026-10-25T09:00:00Z')`);
  // The admin team gave platform ops' computers the image for working on data.
  DB.sqlite.exec(`INSERT INTO agent_tool_options (tool, team, name, value, changed_by, changed_at)
    VALUES ('computer', 'platform', 'image', 'data', 'Dana', '2026-10-27T09:00:00Z')`);
  // Platform ops' own extraction rules, one saved by its agent (without a label: the inbox shows
  // its field as it is), and its own tech stack: one technology of its own, and one of the admin
  // team's turned off for its channels. The admin team's rule for Figma files, added after
  // migration 0043, with the label the inbox shows for its facts.
  DB.sqlite.exec(`INSERT INTO extraction_rules (team, name, kind, target, field, label, pattern, flags,
      value, position, changed_by, changed_at) VALUES
    ('platform', 'Order ids in checkout errors', 'regex', 'fact', 'order', 'Order id', '\\bORD-\\d{6}\\b', '',
      '', 10, 'Dana Ops', '2026-10-26T09:00:00Z'),
    ('platform', 'Release numbers', 'regex', 'fact', 'release', NULL, '\\bRelease (\\d+)\\b', 'i', '$1', 20,
      'opspile-agent/dev', '2026-10-27T15:00:00Z'),
    ('admin', 'Figma file', 'regex', 'fact', 'figma_file', 'Figma file',
      '\\bfigma\\.com/(?:file|design|proto|board)/([A-Za-z0-9]{10,})', '', '$1', 300, 'Dana',
      '2026-11-20T09:00:00Z');
    INSERT INTO tech_stack (team, tech, name, description, enabled, changed_by, changed_at) VALUES
      ('platform', 'sitecore', 'Sitecore', 'Sitecore as the CMS before the migration', 1, 'Dana Ops', '2026-10-26T09:00:00Z'),
      ('platform', 'gdrive', 'Google Drive', 'Google Drive or Google Docs as the content source', 0, 'Dana Ops',
        '2026-10-26T09:05:00Z')`);
  DB.sqlite.prepare(`INSERT INTO extraction_rules (team, name, kind, script, position, enabled, changed_by,
      changed_at) VALUES ('platform', 'Customers who say it is blocking', 'script', ?, 30, 0, 'Dana Ops',
      '2026-10-27T16:00:00Z')`).run([
    'export default (thread) => thread.messages',
    '  .filter((m) => !m.staff && /block/i.test(m.text))',
    "  .map((m) => ({ field: 'blocker', value: m.author }));",
    '',
  ].join('\n'));
  // Edge ops has thread agents by default: its channels nobody switched have them.
  DB.sqlite.exec(`INSERT INTO agent_teams (team, enabled, changed_by, changed_at)
    VALUES ('edge', 1, 'Dana', '2026-10-25T09:00:00Z')`);
  // Dana is in the admin team here, or (`--manager`) only the manager of Edge ops, or
  // (`--member`) only a member of her teams.
  if (manager || member) {
    DB.sqlite.exec("DELETE FROM team_members WHERE team = 'admin' AND person = 1");
  }
  if (manager) {
    DB.sqlite.exec("UPDATE team_members SET role = 'manager' WHERE team = 'edge' AND person = 1");
  }
  const withAdmin = store.me.teams.some((t) => t.slug === 'admin')
    ? store.me.teams
    : [...store.me.teams, { slug: 'admin', name: 'Admin' }];
  let me = { ...store.me, admin: true, teams: withAdmin };
  if (manager || member) {
    me = {
      ...store.me,
      admin: false,
      teams: store.me.teams.map((t) => ({ ...t, role: manager && t.slug === 'edge' ? 'manager' : 'member' })),
      manages: manager ? ['edge'] : [],
    };
  }

  const toRequest = (req, url, body) => new Request(url, {
    method: req.method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  // The preview's MCP servers, added once as the admin team would.
  const admins = { ...store.me, admin: true, teams: [{ slug: 'admin', name: 'Admin' }] };
  const mcpUrl = new URL('http://localhost/api/kb/mcp');
  const checkUrl = new URL('http://localhost/api/kb/mcp/global/check');
  const secretsUrl = new URL('http://localhost/api/kb/tools/secrets');
  const seeded = SEED_MCP.reduce((done, body) => done.then(() => kbAdmin(
    toRequest({ method: 'POST' }, mcpUrl, body),
    env,
    mcpUrl,
    admins,
  )), Promise.all([githubApp, fluffyGrant])).then(() => {
    // The ticket tracker is off in one of platform's channels, on its own.
    DB.sqlite.exec(`INSERT INTO mcp_server_switches (server_id, channel, enabled, changed_by, changed_at)
      SELECT id, 'C0INITECH1', 0, 'Dana', '2026-10-26T09:00:00Z' FROM mcp_servers
      WHERE scope = 'team' AND slug = 'platform' AND name = 'tickets'`);
  }).then(() => SEED_SECRETS.reduce((done, body) => done.then(() => kbAdmin(
    toRequest({ method: 'POST' }, secretsUrl, body),
    env,
    secretsUrl,
    admins,
  )), Promise.resolve()))
    .then(() => Promise.all(['github', 'fluffyjaws', 'slack_channels'].map((server) => kbAdmin(
      toRequest({ method: 'POST' }, checkUrl, { server }),
      env,
      checkUrl,
      admins,
    ))));
  // The follow rules' shares, as the Worker writes them after a rule change and on the cron.
  const followed = syncFollowRules(env);
  /** `/api/kb`, its channels, agents and MCP servers, by the real src/kbadmin.js. */
  const kb = async (req, url, body) => {
    await seeded;
    return kbAdmin(toRequest(req, url, body), env, url, me);
  };

  /**
   * The admin team's requests as threads of its inbox (src/requestthreads.js), by the real
   * module over this D1: `/api/requests`, `/api/requests/note`, `/api/requests/resolve`, a
   * request's `/api/thread` and its reads. Null for anything else.
   */
  const requests = async (req, url, body) => {
    const key = url.pathname === '/api/thread' ? url.searchParams.get('thread') : body?.thread;
    const ours = url.pathname === '/api/requests' || url.pathname.startsWith('/api/requests/')
      || (['/api/thread', '/api/read'].includes(url.pathname) && isRequestKey(key));
    if (!ours) {
      return null;
    }
    await seeded;
    await followed;
    // The inbox's viewer: an admin in the admin team's inbox only (the questions asked of them
    // everywhere, `mine`), as src/api.js.
    if (url.pathname === '/api/requests') {
      return Response.json(await requestEntries(env, me, { mine: url.searchParams.get('mine') === '1' }));
    }
    if (url.pathname === '/api/thread') {
      const t = await requestThread(env, me, key);
      return t ? Response.json(t) : Response.json({ error: 'not found' }, { status: 404 });
    }
    if (url.pathname === '/api/read') {
      await advanceWatermark(env.DB, me.id, key, body.at, 'open');
      return new Response(null, { status: 204 });
    }
    const run = { '/api/requests/note': addNote, '/api/requests/resolve': resolveRequest }[url.pathname];
    // A question's answer goes to its thread's agent (src/agent/question.js): here, nowhere.
    const told = { ...env, AGENTS: DEV_AGENTS };
    const res = run ? await run(told, me, body || {}) : Response.json({ error: 'not found' }, { status: 404 });
    // Re-filing runs right away here.
    while (queued.length) {
      const messages = queued.splice(0).map((b) => ({ body: b, ack() {}, retry() {} }));
      // eslint-disable-next-line no-await-in-loop
      await consume({ messages }, env);
    }
    return res;
  };

  return Object.assign(async (req, url, body) => {
    // Org icons without the internet: the fake orgs' favicons, and suggestions as Clef ranks
    // them (src/favicons.js). `globex.example`, a mail domain, has no favicon.
    if (url.pathname === '/api/admin/favicon') {
      return devFavicon(url.searchParams.get('domain'));
    }
    if (url.pathname === '/api/admin/org-icons') {
      return Response.json({ icons: devIcons(url.searchParams.get('slug')) });
    }
    // Clef, made up, for the duplicate customers (src/orgmerge.js): two orgs of one name are one.
    const asked = url.pathname === '/api/admin/org-duplicates' ? { ...env, AI: DEV_CLEF } : env;
    await followed;
    const res = await admin(toRequest(req, url, body), asked, url, me);
    // Re-filing runs right away here.
    while (queued.length) {
      const messages = queued.splice(0).map((b) => ({ body: b, ack() {}, retry() {} }));
      // eslint-disable-next-line no-await-in-loop
      await consume({ messages }, env);
    }
    return res;
  }, { kb, env, requests });
}
