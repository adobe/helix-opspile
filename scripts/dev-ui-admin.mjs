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
import { BROWSER_MCP_URL, GITHUB_MCP_URL } from '../src/agent/globals.js';
import { kbAdmin } from '../src/kbadmin.js';
import { pkcs8Pem } from '../src/github.js';
import { consume } from '../src/normalizer.js';
import { seal } from '../src/post.js';
import { d1 } from '../test/d1.js';
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
 */

const PREVIEW_TOKEN = 'preview-token';

// The preview's favicons: a letter on a colour, per domain; none for the ones Google would not
// know (the Worker answers 404 then, and the page shows the org without an icon).
const NO_FAVICON = /(^|\.)(globex|initech|parked)\.example$/;
const HUES = ['#c2410c', '#0f766e', '#7c3aed', '#be185d', '#1d4ed8', '#4d7c0f'];
function devFavicon(domain) {
  const d = String(domain || '').replace(/^www\./, '');
  if (!/\.example$/.test(d) || NO_FAVICON.test(d)) {
    return new Response('no favicon', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  const hue = HUES[[...d].reduce((h, c) => h + c.charCodeAt(0), 0) % HUES.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="${hue}"/>`
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
    url: BROWSER_MCP_URL,
    name: 'cloudflare-browser-mcp-server',
    token: PREVIEW_TOKEN,
    tools: tools([
      ['get_url_markdown', 'Fetches the webpage content and converts it into Markdown format', true],
      ['get_url_html_content', 'Retrieves the HTML content of the specified URL', true],
      ['get_url_screenshot', 'Captures a screenshot of the webpage', true],
      ['get_url_pdf', 'Renders the webpage to a PDF document', true],
      ['get_url_links', 'Returns the list of links on the page', true],
      ['scrape_url_elements', 'Scrapes elements from the page by CSS selector', true],
      ['get_url_json', 'Extracts structured JSON from the page using AI', true],
      ['start_crawl', 'Starts an asynchronous crawl of a website', false],
      ['get_crawl_result', 'Returns the status and records of a crawl job', true],
      ['list_browser_sessions', 'Lists active Browser Run sessions for the account', true],
      ['kill_browser_session', 'Closes a Browser Run session by its session ID', false],
    ], 'url'),
  },
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
  {
    id: 'C0SANDBOX3',
    source: 'slack',
    name: 'test-sandbox-3',
    org: '_unassigned',
    titles: ['test'],
    clef: { none: 0.84, platform: 0.1, edge: 0.06 },
    kind: ['ignore', 0.9],
  },
];

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
    const [team, p] = Object.entries(c.clef).sort((a, b) => b[1] - a[1])[0];
    db.prepare(`INSERT INTO channel_labels (source, tenant, channel_id, team, team_p, teams, kind, kind_p,
        labeled_through, options, model, labeled_at) VALUES (?, 'T-FAKE', ?, ?, ?, ?, ?, ?, '', 'edge,platform', 'clef', ?)`)
      .run(c.source, c.id, team, p, JSON.stringify(c.clef), c.kind[0], c.kind[1], at(0));
  });
}

export function createAdmin(store, { manager = false, member = false, bases = [] } = {}) {
  const DB = d1({
    teams: [{ slug: 'admin', name: 'Admin' }, ...store.teams.map(({ slug, name }) => ({ slug, name }))],
    people: [...store.people.values()].map((p) => ({
      id: p.id,
      email: p.email,
      name: p.name,
      staff: p.staff ? 1 : 0,
      teams: [...store.teams.filter((t) => t.members.includes(p.id)).map((t) => t.slug), ...(p.id === 1 ? ['admin'] : [])],
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
    ('soylent', 'Soylent Corporation', 'customer', NULL, '2026-10-20T09:00:00Z')`);
  // Channels Lena (a member of Edge ops) asked the admin team for: one the admin team holds
  // (confirming moves it), one Platform ops holds (confirming shares it), and one declined.
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
    AGENT_MODEL: 'dev',
    AGENT_CHANNELS: 'C0ACMEAEM',
    // Seals the MCP servers' headers; made up for the preview.
    TOKEN_KEY: Buffer.alloc(32, 9).toString('base64url'),
    PUBLIC_ORIGIN: PREVIEW_ORIGIN,
    // The global browser server's API token, made up.
    BROWSER_RUN_TOKEN: PREVIEW_TOKEN,
    // The agent tools (src/agent/agenttools.js) can run: a bot to post as, a Worker Loader,
    // which runs extraction scripts (src/extract.js) in this process, with network access: the
    // preview's scripts are your own.
    SLACK_BOT_TOKEN: 'xoxb-made-up-preview-token',
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
  // The computer is on for the platform team already, and posting in one of its channels: the
  // per-channel lists put the channels switched on their own first.
  DB.sqlite.exec(`INSERT INTO agent_tool_switches (tool, scope, target, enabled, changed_by, changed_at) VALUES
    ('computer', 'team', 'platform', 1, 'Dana', '2026-10-24T09:00:00Z'),
    ('post_message', 'channel', 'C0INITECH1', 1, 'Dana', '2026-10-25T09:00:00Z');
    INSERT INTO mcp_global_switches (server, scope, target, enabled, changed_by, changed_at)
      VALUES ('browser', 'channel', 'C0GLOBEX01', 1, 'Dana', '2026-10-25T09:00:00Z')`);
  // Platform ops' own extraction rules, one saved by its agent, and its own tech stack: one
  // technology of its own, and one of the admin team's turned off for its channels.
  DB.sqlite.exec(`INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value,
      position, changed_by, changed_at) VALUES
    ('platform', 'Order ids in checkout errors', 'regex', 'fact', 'order', '\\bORD-\\d{6}\\b', '', '', 10,
      'Dana Ops', '2026-10-26T09:00:00Z'),
    ('platform', 'Release numbers', 'regex', 'fact', 'release', '\\bRelease (\\d+)\\b', 'i', '$1', 20,
      'opspile-agent/dev', '2026-10-27T15:00:00Z');
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
  let me = { ...store.me, admin: true, teams: [...store.me.teams, { slug: 'admin', name: 'Admin' }] };
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
  const seeded = SEED_MCP.reduce((done, body) => done.then(() => kbAdmin(
    toRequest({ method: 'POST' }, mcpUrl, body),
    env,
    mcpUrl,
    admins,
  )), githubApp).then(() => Promise.all(['browser', 'github'].map((server) => kbAdmin(
    toRequest({ method: 'POST' }, checkUrl, { server }),
    env,
    checkUrl,
    admins,
  ))));
  /** `/api/kb`, its channels, agents and MCP servers, by the real src/kbadmin.js. */
  const kb = async (req, url, body) => {
    await seeded;
    return kbAdmin(toRequest(req, url, body), env, url, me);
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
    const res = await admin(toRequest(req, url, body), env, url, me);
    // Re-filing runs right away here.
    while (queued.length) {
      const messages = queued.splice(0).map((b) => ({ body: b, ack() {}, retry() {} }));
      // eslint-disable-next-line no-await-in-loop
      await consume({ messages }, env);
    }
    return res;
  }, { kb, env });
}
