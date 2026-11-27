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

/**
 * Fake data for the local UI preview (scripts/dev-ui.mjs). Nothing here is real: people,
 * orgs, channels and ids are invented.
 *
 * The store stands in for what the Worker keeps in D1 (teams, people, threads, watermarks)
 * and R2 (pile-2 message files). Pile-2 files are written with the real `render` from
 * src/channels.js, so the preview parses them with the same code the Worker uses.
 */

import { channelPath, render } from '../src/channels.js';
import { quoteMarkdown } from '../src/markdown.js';
import { previewOf, titleOf } from '../src/threads.js';

const MIN = 60 * 1000;
const TENANT = 'T-FAKE';

const PEOPLE = [
  {
    key: 'dana', id: 1, name: 'Dana Ops', email: 'dana@example.com', staff: true, title: 'Site reliability engineer',
  },
  {
    key: 'priya', id: 2, name: 'Priya Nair', email: 'priya@example.com', staff: true, title: 'Support engineer',
  },
  {
    // The mention model gives her odds of an answer under one half (src/reminders.js): a
    // mention of her says to send a personal reminder.
    key: 'lena', id: 3, name: 'Lena Berg', email: 'lena@example.com', staff: true, answers: 0.3,
  },
  {
    // Away: no post for 23 days, and a mention of him says so.
    key: 'tom', id: 4, name: 'Tom Okafor', email: 'tom@example.com', staff: true, quiet: 23,
  },
  {
    key: 'sam', id: 5, name: 'Sam Reyes', email: 'sam@acme.example', org: 'acme', staff: false, title: 'Web lead',
  },
  {
    key: 'mei', id: 6, name: 'Mei Lin', email: 'mei@globex.example', org: 'globex', staff: false,
  },
  {
    key: 'jonas', id: 7, name: 'Jonas Weber', email: 'jonas@initech.example', org: 'initech', staff: false,
  },
  {
    // From a partner domain (see PARTNERS), working in a customer's channel.
    key: 'ravi',
    id: 8,
    name: 'Ravi Kumar',
    email: 'ravi@agency.example',
    org: 'acme',
    staff: false,
    title: 'Solution architect',
    company: 'Agency Co',
  },
  {
    key: 'ola', id: 9, name: 'Ola Hansen', email: 'ola@umbrella.example', org: 'umbrella', staff: false,
  },
  {
    // Of no known org (free mail): in a public channel, the card says Community.
    key: 'kai', id: 11, name: 'Kai Moreno', email: 'kai.moreno@freemail.example', org: null, staff: false,
  },
  {
    // A customer who can use neither Slack nor Teams with Adobe: in the customer portal.
    key: 'lucius', id: 10, name: 'Lucius Fox', email: 'lucius.fox@wayne.example', org: 'wayne', staff: false, title: 'Head of digital',
  },
];

/**
 * Accounts known only as members of a channel (Slack's conversations.members, see
 * `CHANNELS[…].members`): they never posted, and the login is not the name, so "@K", "@sel"
 * and "@kse" must all find Kira in ACME's channel (src/mention-match.js).
 */
const MEMBERS = [
  {
    key: 'kira', name: 'Kira Selby', login: 'kselby', email: 'kselby@example.com', staff: true,
  },
  // In no channel yet: a Slack reply that mentions her adds her to its channel first
  // (src/invite.js), and the inbox says so.
  {
    key: 'noor', name: 'Noor Haddad', login: 'nhaddad', email: 'nhaddad@example.com', staff: true,
  },
  // In the Enterprise org but not in the channels' workspace: Slack will not let the bot add
  // him (`org_user_not_in_team`), and the note says so until it is dismissed.
  {
    key: 'mateo', name: 'Mateo Ruiz', login: 'mruiz', email: 'mruiz@example.com', staff: true, elsewhere: true,
  },
];

/** The `partner_domains` table: mail domain -> partner name. */
const PARTNERS = new Map([['agency.example', 'Agency Co']]);

const TEAMS = [
  { slug: 'platform', name: 'Platform ops', members: [1, 2, 3, 4] },
  { slug: 'edge', name: 'Edge ops', members: [1, 3] },
  // Not Dana's: a channel she asked the agent to move here is no longer hers to work.
  { slug: 'forms', name: 'Forms ops', members: [2] },
];

/**
 * Stats on klickhaus (src/klickhaus.js), as the Worker's KLICKHAUS_URL and KLICKHAUS_TEAMS
 * would say: for Edge ops alone. Dana, a member who manages no team, sees Inbox · Agents · Stats
 * in the header; viewing as Priya (Platform ops only) shows no switch. Its rows link back to
 * `/inbox?view=personal&t=<thread>`, which opens a thread of Dana's teams she never posted in
 * too (the checkout outage at umbrella, or an alert).
 */
const KLICKHAUS = { KLICKHAUS_URL: 'https://klickhaus.example', KLICKHAUS_TEAMS: 'edge' };

const BOT = {
  kind: 'bot', name: 'Alertmanager', org: null, staff: false,
};
/**
 * A bot of Adobe's own (made up), which an admin said is Adobe's on the admin page's Bots
 * (src/ourbots.js): staff, so the thread shows it on Adobe's side.
 */
const OURBOT = {
  kind: 'bot', name: 'Provisioning Agent', org: null, staff: true,
};
/** The opspile app, which posts what someone sends as it (POST /api/post/app). */
const APP = {
  kind: 'bot', name: 'opspile', org: null, staff: false,
};

/** Teams' system notices: a meeting started or ended, someone was added. */
const SYSTEM = {
  kind: 'system', name: 'Microsoft Teams', org: null, staff: false,
};

/** The thread agent, which saves shared drafts as this person (src/agent/tools.js). */
export const AGENT = { id: 900, name: 'opspile agent' };

/**
 * The knowledge base's sidebar (ui/kbchat.js) of kb-team-platform, as GET /api/kb/chat answers:
 * a conversation of yours, the agent's answer with what it changed, and an earlier one.
 */
export function kbChats(now = Date.now()) {
  const at = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  const ask = 'sb_00000000-0000-4000-8000-000000000001';
  return {
    'kb-team-platform': [
      {
        chat: 'kc_00000000-0000-4000-8000-000000000001',
        // What the agent asked to have run, a token of yours in it (request_bash).
        bash: [{
          id: 'b0000000cdn1',
          chat: 'kc_00000000-0000-4000-8000-000000000001',
          command: 'curl -s -H "Fastly-Key: $FASTLY_TOKEN" "https://api.fastly.com/service/$SERVICE/version/active" | jq \'{number, updated_at}\'',
          reason: 'To see when the shared service\'s configuration last changed: two threads say the purge delay was fixed in October, a later one that it is back.',
          env: [{ name: 'FASTLY_TOKEN', description: 'A read-only Fastly API token of yours' }, { name: 'SERVICE', description: 'The shared service\'s id' }],
          timeout: 60,
          deadline: at(-60 * 24),
          status: 'pending',
          created_at: at(8),
          by: null,
        }],
        messages: [
          {
            id: ask,
            role: 'person',
            state: 'done',
            reply_to: null,
            at: at(12),
            body: 'We keep answering questions about CDN purges taking long. Is that in the knowledge base? If not, add it.',
          },
          {
            id: `${ask}:answer`,
            role: 'agent',
            state: 'done',
            reply_to: ask,
            at: at(9),
            body: 'It was not: `issues/` had nothing on purges, and `playbooks/cdn-purge.md` only covers purging by URL.\n\nI read the **6 threads** of the last two months that ask about it ([the latest](https://example.slack.com/archives/C1/p1)), and wrote:\n\n- `issues/cdn-purge-delay.md` (new): purges by surrogate key take up to 10 minutes on the shared CDN; what to tell the customer, and when to escalate. Sources: 4 threads.\n- `playbooks/cdn-purge.md`: a section on purging by key, linked to the issue.\n\nTwo threads said the delay was fixed in October, and a later one says it is back, so I kept it as a known issue rather than *resolved*.',
          },
        ],
      },
      {
        chat: 'kc_00000000-0000-4000-8000-000000000002',
        messages: [
          {
            id: 'sb_00000000-0000-4000-8000-000000000002',
            role: 'person',
            state: 'done',
            reply_to: null,
            at: at(60 * 26),
            body: 'Who on the team knows the most about forms?',
          },
          {
            id: 'sb_00000000-0000-4000-8000-000000000002:answer',
            role: 'agent',
            state: 'done',
            reply_to: 'sb_00000000-0000-4000-8000-000000000002',
            at: at(60 * 26 - 2),
            body: 'Lena Berg: her profile (`contacts/lena-berg.md`) lists forms, and she answered 9 of the 12 forms threads this quarter.',
          },
        ],
      },
    ],
  };
}

/**
 * The made-up model of the preview's translations (GET /api/translate, scripts/dev-ui.mjs): the
 * Japanese thread's messages in English. Anything else in Japanese is marked, not translated.
 */
export const TRANSLATIONS = {
  'お世話になっております。プレビューの `/products` ページが今朝から **404** になっています。ご確認いただけますか？':
    'Thank you for your support. The preview `/products` page has been returning **404** since this morning. Could you take a look?',
  'ご連絡ありがとうございます。確認いたします。': 'Thank you for letting us know. We will look into it.',
  'リダイレクトの設定を修正しました。もう一度お試しください。': 'We fixed the redirect configuration. Please try again.',
  '直りました。ありがとうございます！ :pray:': 'It works now. Thank you! :pray:',
};

/**
 * Channels: where a thread lives. `org` and `team` are what the rules would file it under.
 * `appPosting`: "Post messages" is on, so a person may send as the opspile app there.
 */
const CHANNELS = {
  aemAcme: {
    source: 'slack',
    channelId: 'C0ACMEAEM',
    name: 'aem-acme',
    org: 'acme',
    team: 'platform',
    members: ['kira'],
    appPosting: true,
    // What the fake channel's threads show, for the Tech stack filter (the key parts beside
    // ACME's heading come from its stack.md, scripts/dev-ui-kb.mjs).
    tech: ['eds', 'akamai', 'sharepoint', 'github', 'commerce', 'appbuilder', 'analytics', 'consent', 'opspile'],
  },
  aemGlobex: {
    source: 'slack', channelId: 'C0GLOBEX01', name: 'aem-globex', org: 'globex', team: 'platform', tech: ['eds', 'da', 'fastly'],
  },
  initech: {
    source: 'slack', channelId: 'C0INITECH1', name: 'initech-support', org: 'initech', team: 'platform', tech: ['commerce', 'cloudflare'],
  },
  aemUmbrella: {
    source: 'slack', channelId: 'C0UMBRELLA', name: 'aem-umbrella', org: 'umbrella', team: 'platform', tech: ['eds', 'ue', 'aemcs'],
  },
  // A partner's own channel (an agency that works for ACME, src/threadlinks.js).
  agencyProjects: {
    source: 'slack', channelId: 'C0AGENCY01', name: 'agency-projects', org: 'agency', team: 'platform', tech: ['eds', 'github'],
  },
  alerts: {
    source: 'slack',
    channelId: 'C0ALERTS01',
    name: 'alerts-platform',
    org: 'opspile',
    team: 'platform',
    kind: 'alert',
  },
  release: {
    source: 'teams',
    channelId: 'CH-RELEASE',
    name: 'Release train',
    org: 'opspile',
    team: 'platform',
    teamId: 'TEAM-PLATFORM',
  },
  random: {
    source: 'teams',
    channelId: 'CH-RANDOM',
    name: 'Random',
    org: 'opspile',
    team: 'platform',
    teamId: 'TEAM-PLATFORM',
    kind: 'ignore',
  },
  cdn: {
    source: 'teams',
    channelId: 'CH-CDN',
    // A Teams team's default channel: the thread header names the team alone.
    name: 'Main',
    groupName: 'Globex CDN',
    org: 'globex',
    team: 'edge',
    teamId: 'TEAM-EDGE',
    // Its Teams team's members are listed (Noor since the Provisioning Agent added her): whoever
    // else is mentioned (Mateo, say) is "not in team", and a reply that mentions them says so,
    // with what to ask admin-bot.
    members: ['kira', 'noor'],
  },
  edgeQ: {
    source: 'slack', channelId: 'C0EDGEQ01', name: 'edge-questions', org: 'opspile', team: 'edge',
  },
  // Moved to Forms ops, which Dana is not on, at her asking: she sees it and talks to its agent
  // (`agent`: it has one), and may not work it (src/shares.js, `maySee`).
  formsAcme: {
    source: 'slack', channelId: 'C0FORMSAC1', name: 'aem-forms-acme', org: 'acme', team: 'forms', agent: true,
  },
  // Archived on Slack's side: a reply sent here fails (`rejects` is Slack's error), and shows
  // as not sent, with Retry.
  archived: {
    source: 'slack',
    channelId: 'C0INITOLD1',
    name: 'initech-legacy',
    org: 'initech',
    team: 'platform',
    rejects: 'is_archived',
  },
  // A channel of the customer portal (src/portalsource.js), opened for a customer's lobby: the
  // inbox posts there as the person, with no account to connect.
  portal: {
    source: 'portal', channelId: 'c0wayne0000001', name: 'wayne-enterprises', org: 'wayne', team: 'edge', tech: ['eds', 'ue', 'da'],
  },
  // Customers of Dana's personal view she has nothing unread from, for the sections of its
  // customer column (src/standing.js): Hooli she posts to most (a regular), Stark now and then;
  // Wonka, Tyrell and Cyberdyne have been quiet for her for more than two weeks (inactive).
  hooli: {
    source: 'slack', channelId: 'C0HOOLI001', name: 'hooli-aem', org: 'hooli', team: 'edge',
  },
  stark: {
    source: 'slack', channelId: 'C0STARK001', name: 'stark-edge', org: 'stark', team: 'edge',
  },
  wonka: {
    source: 'slack', channelId: 'C0WONKA001', name: 'wonka-sites', org: 'wonka', team: 'platform',
  },
  tyrell: {
    source: 'slack', channelId: 'C0TYREL001', name: 'tyrell-ops', org: 'tyrell', team: 'platform',
  },
  cyberdyne: {
    source: 'slack', channelId: 'C0CYBER001', name: 'cyberdyne-cdn', org: 'cyberdyne', team: 'edge',
  },
  // A customer only Forms ops works, which Dana is not on: she sees its page in Customers, reads
  // its knowledge base and talks to its agent there, which changes nothing for her.
  massive: {
    source: 'slack', channelId: 'C0MASSIVE1', name: 'massive-forms', org: 'massive', team: 'forms',
  },
  // An event's channel, public (an org of type `public`, docs/ARCHITECTURE.md "Public
  // channels"): people of ACME, of the agency and of no known org ask there.
  workshop: {
    source: 'slack', channelId: 'C0WORKSHOP1', name: 'aem-workshop-attendees', org: 'public', team: 'edge', tech: ['eds'],
  },
  // A community server: a forum where every post is a thread.
  forum: {
    source: 'discord', channelId: '1100000000000000001', name: 'community-forum', org: 'opspile', team: 'edge', appPosting: true,
  },
};

/**
 * A made-up screenshot: a chart with a title, as an SVG, for the messages with attachments.
 */
/**
 * A markdown table wider than any bubble: it scrolls sideways inside it.
 */
const WIDE_TABLE = [
  '| path | status | requests | p50 | p95 | p99 | first seen | last seen | cache | note |',
  '|---|---|---|---|---|---|---|---|---|---|',
  '| /content/acme/en/products/overview | 503 | 1204 | 41ms | 1203ms | 2.4s | 10:02:11 | 10:58:40 | MISS | content host timed out |',
  '| /content/acme/de/start/willkommen | 200 | 860 | 38ms | 310ms | 998ms | 10:02:12 | 10:59:02 | HIT | retried once, then served |',
  '| /content/dam/acme/hero-banner-wide.png | 404 | 77 | 12ms | 40ms | 88ms | 10:04:30 | 10:41:19 | PASS | renamed in the last push |',
].join('\n');
/** A file name longer than any bubble is wide, as a pasted URL makes one. */
const LONG_NAME = 'preview-requests-content-acme-en-products-overview-and-de-start-willkommen-and-dam-hero-banner-wide-since-the-config-push-2026-10-21';

/**
 * A made-up CSV of publish requests (paths, statuses, timings), long enough that its preview
 * scrolls, with a quoted field holding a comma and one holding a quote.
 */
function publishCsv() {
  const paths = ['/content/acme/en/home', '/content/acme/en/products', '/content/acme/de/start', '/content/dam/acme/hero.png', '/content/acme/en/support/contact'];
  const statuses = [200, 200, 200, 202, 503, 200, 404];
  const rows = ['path,status,requests,p95 ms,last seen,note'];
  for (let i = 0; i < 240; i += 1) {
    const note = { 3: '"queued, then retried"', 7: '"agent said ""busy"""' }[i] || '';
    rows.push([`${paths[i % paths.length]}${i >= paths.length ? `/page-${i}` : ''}`, statuses[(i * 3) % statuses.length],
      ((i * 7919) % 4000) + 12, ((i * 104729) % 900) + 40, `2026-10-21T${String(9 + (i % 3)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`, note].join(','));
  }
  return `${rows.join('\n')}\n`;
}

/**
 * A browser's recording of a page failing, as the Network panel saves it (the preview shows it
 * by its name: Slack calls a .har `application/octet-stream`). The host and token are made up.
 */
function recordingHar() {
  const at = (ms) => new Date(Date.UTC(2026, 9, 30, 16, 20, 0, ms)).toISOString();
  const headers = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
  const token = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from('{"sub":"made-up"}').toString('base64url')}.c2lnbmF0dXJl`;
  const request = (method, url, ms, status, wait, more = {}) => ({
    startedDateTime: at(ms),
    time: wait + 14,
    request: {
      method,
      url,
      headers: headers({ accept: 'application/json', authorization: `Bearer ${token}`, cookie: 'session=made-up' }),
      queryString: [...new URL(url).searchParams].map(([name, value]) => ({ name, value })),
    },
    response: {
      status,
      statusText: status === 200 ? 'OK' : '',
      headers: headers({ 'content-type': 'application/json', 'x-request-id': `req-${ms}`, 'set-cookie': 'session=made-up' }),
      content: {
        size: 1840, mimeType: 'application/json', text: JSON.stringify({ items: [], status }),
      },
      ...more.response,
    },
    timings: {
      blocked: 2, dns: 0, connect: 0, ssl: 0, send: 1, wait, receive: 11,
    },
    serverIPAddress: '192.0.2.10',
    _resourceType: more.type || 'fetch',
  });
  const entries = [
    request('GET', 'https://assets.example/app/index.html', 0, 200, 40, { type: 'document' }),
    request('GET', 'https://assets.example/app/main.js', 120, 200, 31, { type: 'script' }),
    request('POST', 'https://ims.example/ims/check/v6/token?client_id=picker&access_token=made-up', 410, 200, 188),
    request('GET', 'https://author.example/adobe/repositories/discovery', 640, 200, 8214),
    request('GET', 'https://author.example/adobe/folders/search?limit=50', 8900, 504, 12003),
    request('GET', 'https://author.example/adobe/assets/search?limit=50', 21000, 0, 0, {
      response: { _error: 'net::ERR_CONNECTION_RESET', statusText: '' },
    }),
  ];
  return JSON.stringify({ log: { version: '1.2', creator: { name: 'WebInspector', version: '537.36' }, entries } });
}

function screenshot(title, color, bars, w = 640, h = 360) {
  const bar = (v, i) => `<rect x="${60 + i * 52}" y="${h - 60 - v * 2}" width="36" height="${v * 2}" rx="4" fill="${color}"/>`;
  return new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#f6f7f9"/><rect width="${w}" height="44" fill="#1f2937"/>
  <circle cx="22" cy="22" r="6" fill="#ef4444"/><circle cx="42" cy="22" r="6" fill="#f59e0b"/><circle cx="62" cy="22" r="6" fill="#10b981"/>
  <text x="90" y="28" font-family="sans-serif" font-size="15" fill="#e5e7eb">${title}</text>
  <line x1="50" y1="${h - 60}" x2="${w - 30}" y2="${h - 60}" stroke="#9ca3af"/>${bars.map(bar).join('')}
</svg>`);
}

// ---- a prod-sized inbox (`--big`), for performance work --------------------------------

const SYLLABLES = ['ar', 'bel', 'cor', 'dan', 'el', 'fi', 'gor', 'hal', 'is', 'jo', 'kar', 'lum',
  'mor', 'nex', 'or', 'pra', 'qui', 'ros', 'sol', 'tan', 'ul', 'vex', 'wen', 'yor', 'zan'];
const FIRST = ['Alex', 'Billie', 'Casey', 'Devon', 'Emery', 'Finley', 'Gray', 'Harper', 'Indy',
  'Jules', 'Kai', 'Logan', 'Morgan', 'Noel', 'Oakley', 'Parker', 'Quinn', 'Riley', 'Sage', 'Taylor'];
const LAST = ['Abara', 'Brandt', 'Castillo', 'Dubois', 'Eriksen', 'Fontaine', 'Gallo', 'Haddad',
  'Ivanova', 'Jensen', 'Kowalski', 'Lindqvist', 'Moreau', 'Nakamura', 'Okoro', 'Petrov'];
const PHRASES = [
  'The preview build for `/en/products` has been failing since the last config push.',
  'We see **intermittent 503s** on the live site, roughly one in fifty requests :warning:',
  'Could you check whether the cache purge went through? Headers still show the old `etag`.',
  'Thanks, that fixed it on our side :pray:',
  'Here are the logs from the last hour:\n\n```\nGET /index.plain.html 503 1203ms\nGET /nav.plain.html 200 41ms\nGET /footer.plain.html 503 998ms\n```',
  'Steps to reproduce:\n\n1. Open the page in a private window\n2. Publish any change\n3. Reload twice\n\nThe second reload shows the stale version.',
  'Is there an ETA? Our launch is *tomorrow morning* and marketing is asking :eyes:',
  'I opened a ticket and linked the trace: https://example.com/trace/1234 and the dashboard https://example.com/d/abcd',
  'Rolled back the redirect rules; error rate is back to normal :white_check_mark:',
  '> the sitemap is missing half the pages\n\nYes, the index only covers `/blog/**` at the moment.',
  '> Is the old domain still redirecting after the cutover?\nYes, and it stays that way until the certificate expires.',
  '| region | p50 | p99 |\n|---|---|---|\n| eu | 40ms | 310ms |\n| us | 38ms | 2.4s |',
  'Can we schedule a quick call? ~~Today~~ Tomorrow works better for us.',
  'Looping in the CDN team, they own the origin shield config.',
  '- [x] DNS updated\n- [x] certificate issued\n- [ ] traffic switched',
  'One more question: does the bulk publish API respect the folder permissions?',
  'Deployed the fix to stage, please verify before we go live :rocket:',
];
const QUICK_RX = ['white_check_mark', 'eyes', 'pray', '+1', 'rocket', 'joy', 'tada'];
const KINDS = ['incident', 'question', 'request', 'security', 'access', 'other'];

/** A small deterministic PRNG, so every start shows the same big inbox. */
function prng(seedValue) {
  let a = seedValue;
  /* eslint-disable no-bitwise */
  return () => {
    a = (a + 0x6d2b79f5) | 0; // eslint-disable-line operator-assignment
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /* eslint-enable no-bitwise */
}

/**
 * Forty invented customers with two people each, a channel per customer (some on Teams), and
 * some 250 threads in the platform team plus alerts, sized like production: most threads are
 * short, a quarter run to 50–150 messages, with markdown, reactions, labels and read marks.
 */
function addBigInbox({
  people, byKey, seed, threads,
}) {
  const rnd = prng(42);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const staff = ['dana', 'priya', 'lena', 'tom'];
  const orgs = [];
  let id = 100;
  for (let i = 0; i < 40; i += 1) {
    const org = `${pick(SYLLABLES)}${pick(SYLLABLES)}${i}`;
    const folks = [];
    for (const n of [id + 1, id + 2]) {
      const p = {
        key: `c${n}`,
        id: n,
        name: `${pick(FIRST)} ${pick(LAST)}`,
        email: `p${n}@${org}.example`,
        org,
        staff: false,
      };
      people.set(p.id, p);
      byKey.set(p.key, p);
      folks.push(p.key);
    }
    id += 2;
    const teams = i % 5 === 4;
    orgs.push({
      folks,
      ch: teams ? {
        source: 'teams', channelId: `CH-${org}`, name: `${org} support`, org, team: 'platform', teamId: 'TEAM-PLATFORM',
      } : {
        source: 'slack', channelId: `C0${org.toUpperCase()}`, name: `aem-${org}`, org, team: 'platform',
      },
    });
  }
  const bot = {
    source: 'slack', channelId: 'C0BIGALERTS', name: 'alerts-big', org: 'opspile', team: 'platform', kind: 'alert',
  };
  for (let n = 0; n < 250; n += 1) {
    const { ch, folks } = pick(orgs);
    const long = rnd() < 0.25;
    const count = long ? 50 + Math.floor(rnd() * 100) : 1 + Math.floor(rnd() * 12);
    // Started up to three weeks ago; the latest message somewhere in that span.
    const start = 30 + Math.floor(rnd() * 30000);
    const step = start / (count + 1);
    const messages = [];
    for (let k = 0; k < count; k += 1) {
      const who = k % 2 === 0 || rnd() < 0.3 ? pick(folks) : pick(staff);
      const body = rnd() < 0.3 ? `${pick(PHRASES)}\n\n${pick(PHRASES)}` : pick(PHRASES);
      messages.push([who, Math.max(1, Math.round(start - k * step)), body]);
    }
    const reads = {};
    for (const s of staff) {
      if (rnd() < 0.5) {
        reads[s] = rnd() < 0.6 ? 'latest' : Math.round(start / 2);
      }
    }
    const key = seed({
      ch,
      messages,
      reads,
      label: rnd() < 0.85 ? {
        kind: pick(KINDS),
        next_actor: pick(['us', 'customer', 'nobody']),
        urgency: rnd() * 3,
        resolved_p: rnd(),
      } : undefined,
      facts: rnd() < 0.3 ? [['ticket', `OPS-${2000 + n}`]] : [],
      mentioned: rnd() < 0.15 ? [pick(staff)] : [],
    });
    const entry = threads.get(key);
    entry.reactionSeeds = entry.messages
      .filter(() => rnd() < 0.15)
      .map((m) => ({ id: m.id, emoji: pick(QUICK_RX), by: pick(staff) }));
  }
  for (let n = 0; n < 40; n += 1) {
    seed({
      ch: bot,
      messages: [['bot', 5 + Math.floor(rnd() * 20000), `[FIRING] ${pick(['Disk', 'Queue depth', 'Error rate', 'Latency'])} above threshold on node-${n}`]],
      reads: rnd() < 0.5 ? { dana: 'latest' } : {},
    });
  }
}

/**
 * Builds the fake store. Times are relative to `now`, so the inbox always looks fresh.
 *
 * @param {number} now epoch ms
 * @param {object} [options]
 * @param {boolean} [options.big] adds prod-sized traffic (see `addBigInbox`): some 250 threads
 *   in the platform team, many of them 50 to 150 messages long, from forty invented customers
 * @param {boolean} [options.admin] puts Dana in the admin team, the smallest one, with one
 *   unread thread that is not in her personal view
 */
export function createStore(now = Date.now(), { big = false, admin = false } = {}) {
  const people = new Map(PEOPLE.map((p) => [p.id, p]));
  const byKey = new Map(PEOPLE.map((p) => [p.key, p]));
  const threads = new Map(); // key -> { row, team, rootId, path, messages: [...] }
  const files = new Map(); // pile-2 path -> markdown text
  const watermarks = new Map(); // `${person}|${thread}` -> { person, thread, read_at, via }
  const labels = new Map(); // thread -> Clef label, as the labels table holds it
  const facts = new Map(); // thread -> [{ field, value, ... }]
  const mentions = []; // { thread, person, at }
  // Messages the viewer posted as the opspile app (`app_posts`): `${thread}|${id}`.
  const appPosts = new Set();
  const drafts = new Map(); // thread -> its shared draft, as src/drafts.js reads it from D1
  // thread -> the commands its agent asked a person to run, as src/bashrequests.js shapes them
  const bashRequests = new Map();
  // thread -> the tools its agent asked for in the sidebar (src/toolrequests.js)
  const toolRequests = new Map();
  // thread -> what the team said to its agent in the sidebar, and its answers (src/sidebar.js)
  const sidebars = new Map();
  // How src/sources.js would show the fixtures' sources: a frame, Markdown; any other, not at all.
  const sourceViews = new Map([
    ['https://docs.example.com/purge', { view: 'frame', url: '/__dev/source-page' }],
    ['https://docs.example.com/surrogate-keys.md', {
      view: 'markdown',
      url: 'https://docs.example.com/surrogate-keys.md',
      text: '# Surrogate keys\n\nA surrogate key groups objects, so that one purge reaches them all.\n\n'
        + '- `/en/*` and `/de/*` share the key `site-pages`\n- a key holds up to 2,000 objects\n\n'
        + '## Purging by key\n\nPurge a key with `POST /purge`; it takes effect within a minute.',
    }],
  ]);
  const sourcePage = `<!doctype html><title>Purging the CDN</title>
    <body style="font: 15px/1.5 system-ui; margin: 24px; color: #222">
    <h1>Purging the CDN</h1><p>Use a purge when content changed and cannot wait for its lifetime.</p>
    <h2>By path</h2><p>Purged objects are <b>refetched on the next request</b>; errors are cached
    for up to 5 minutes.</p><h2>By key</h2><p>A surrogate key purges a group of objects at once.</p>`;
  // Files attached to messages, served by the preview at /__dev/files/<id>/<name>.
  const uploads = new Map(); // id -> { name, type, bytes }
  const upload = (name, type, bytes) => {
    const id = `f${uploads.size + 1}`;
    uploads.set(id, { name, type, bytes });
    return `/__dev/files/${id}/${encodeURIComponent(name)}`;
  };
  let seq = 100000;

  const author = (key) => {
    if (key === 'bot') {
      return BOT;
    }
    if (key === 'app') {
      return APP;
    }
    if (key === 'ourbot') {
      return OURBOT;
    }
    if (key === 'system') {
      return SYSTEM;
    }
    const p = byKey.get(key);
    // A customer's org is their mail domain, as src/lookup.js `toAuthor` has it: the badge on
    // their picture, which shows their customer's card.
    return {
      kind: 'person', name: p.name, org: p.staff ? null : (p.email || '').split('@')[1] || null, staff: p.staff,
    };
  };

  function advance(person, thread, at, via) {
    const k = `${person}|${thread}`;
    const w = watermarks.get(k);
    if (!w || at > w.read_at) {
      watermarks.set(k, {
        person, thread, read_at: at, via,
      });
    }
  }

  function newId(source, ms) {
    seq += 1;
    if (source === 'discord') {
      // A snowflake: ms since Discord's epoch, shifted by 22 bits.
      return String((BigInt(ms) - 1420070400000n) * 4194304n + BigInt(seq));
    }
    if (source === 'portal') {
      // The portal's message ids (src/portal/ids.js): the time in base 36, then six digits.
      return `m${Math.floor(ms).toString(36).padStart(9, '0')}${String(seq).padStart(6, '0')}`;
    }
    return source === 'slack'
      ? `${Math.floor(ms / 1000)}.${String(seq).padStart(6, '0')}`
      : String(ms + seq);
  }

  function threadKey(ch, rootId) {
    if (ch.source === 'discord' || ch.source === 'portal') {
      return `${ch.source}:${TENANT}:${ch.channelId}:${rootId}`;
    }
    return ch.source === 'slack'
      ? `slack:${TENANT}:${ch.channelId}:${rootId}`
      : `teams:${TENANT}:${ch.teamId}:${ch.channelId}:${rootId}`;
  }

  function permalink(ch, id) {
    if (ch.source === 'portal') {
      // The portal is its customers': the inbox keeps no link to it.
      return null;
    }
    if (ch.source === 'discord') {
      return `https://discord.example.com/channels/${TENANT}/${ch.channelId}/${id}`;
    }
    return ch.source === 'slack'
      ? `https://slack.example.com/archives/${ch.channelId}/p${id.replace('.', '')}`
      : `https://teams.example.com/l/message/${ch.channelId}/${id}`;
  }

  /** The D1 `threads` row, derived from the messages the way indexMessage does. */
  function deriveRow(entry) {
    const { ch, rootId, messages } = entry;
    const live = messages.filter((m) => !m.deletedAt);
    const root = messages.find((m) => m.id === rootId);
    const titled = (m) => titleOf(m.subject, m.body);
    // What was said titles a thread; a system notice only one without.
    const said = (m) => m.author.kind !== 'system';
    const titleSource = [
      root && !root.deletedAt && said(root) && titled(root) ? root : null,
      live.find((m) => said(m) && titled(m)),
      root && !root.deletedAt && titled(root) ? root : null,
      live.find((m) => titled(m)),
    ].find(Boolean);
    const counted = live.filter((m) => m.author.kind === 'person')
      .sort((a, b) => a.at.localeCompare(b.at));
    const last = counted[counted.length - 1];
    const ats = live.map((m) => m.at).sort();
    return {
      permalink: root ? permalink(ch, root.id) : null,
      thread: entry.key,
      source: ch.source,
      tenant: TENANT,
      channel_id: ch.channelId,
      root_id: rootId,
      org: ch.org,
      team: ch.team,
      kind: ch.kind || 'channel',
      channel_name: ch.name,
      title: titleSource ? titled(titleSource) : '',
      path: entry.path,
      root_at: root ? root.at : null,
      last_at: last ? last.at : null,
      last_id: last ? last.id : null,
      last_author: last ? last.author.name : null,
      last_staff: last ? Number(last.author.staff) : null,
      last_text: last ? previewOf(last.body) : null,
      any_at: ats.length ? ats[ats.length - 1] : null,
      messages: live.filter((m) => m.author.kind !== 'system').length,
      // Re-threaded into another thread's group (src/rethread.js): that group's first thread.
      logical_thread: entry.logical || null,
      // From the history import (src/history.js): read by everyone, waiting on nobody.
      imported: entry.imported ? 1 : 0,
      updated_at: new Date(now).toISOString(),
    };
  }

  function writeFile(entry, m) {
    const path = channelPath({
      org: entry.ch.org,
      team: entry.ch.team,
      source: entry.ch.source,
      channelId: entry.ch.channelId,
      rootId: entry.rootId,
      id: m.id,
    });
    const meta = {
      source: entry.ch.source,
      thread: entry.key,
      id: m.id,
      at: m.at,
      author: m.author,
      editedAt: m.editedAt,
      deletedAt: m.deletedAt,
      raw: [`${entry.ch.source}/${TENANT}/${entry.ch.channelId}/fake-${m.id}.json`],
      permalink: permalink(entry.ch, m.id),
      subject: m.subject,
    };
    files.set(path, render(meta, m.deletedAt ? '' : m.body));
  }

  /** Adds (or re-renders) one message and refreshes the thread row. */
  function put(entry, m) {
    const i = entry.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) {
      entry.messages.splice(i, 1, m);
    } else {
      entry.messages.push(m);
    }
    writeFile(entry, m);
    Object.assign(entry, { row: deriveRow(entry) });
    if (m.author.kind === 'person') {
      const person = [...byKey.values()].find((p) => p.name === m.author.name);
      advance(person.id, entry.key, m.at, 'post');
    }
  }

  /**
   * Seeds a thread. `messages` are `[who, minutesAgo, body, extra?]` in chronological order;
   * `who` is a person key, 'bot' or 'app'. `body` may be a function of
   * `{ ids, ch, rootId, i }`, so a message can name one seeded before it.
   * `extra`: `{ subject, editedAgo, deleted, predates, appBy }`.
   * `appBy: 'dana'` says the viewer posted an 'app' message as the opspile app.
   * `predates` drops the root from the store, like a thread that started before ingestion.
   * `reads` maps a person key to `'latest'` or minutes ago, when they opened the thread.
   * `mentioned` lists person keys, mentioned in the last message, or `[key, minutesAgo]`.
   * `draft`: the thread's shared draft, `{ by, ago, body, sources? }`; `by` is a person key or
   * 'agent'.
   * `bash`: the commands the thread's agent asked a person to run, `[{ ago, command, reason,
   * env?, timeout?, open?, status?, by?, exit?, ended? }]`: asked `ago` minutes ago, open for
   * `open` more minutes; `status` (and `by`, a person key) for one that was decided `ended`
   * minutes ago (2, unless it says). `kind: 'codemode'` and `tools` make one a script to run as
   * the person (src/agent/scriptrequest.js), `command` its code. `asked`: the index in `sidebar`
   * of the message the agent answered when it asked, which shows it in that conversation.
   * `sidebar`: what someone on the team said to the thread's agent in the inbox's sidebar, and
   * its answers, `[who, minutesAgo, body]`, `who` a person key or 'agent' (src/sidebar.js); an
   * answer `[..., { unseen: true }]` its asker has not seen yet (the purple badge).
   * `tools`: what the agent asked for there (src/toolrequests.js), `[{ asked, ago, kind, name,
   * title, about, reason, status?, by? }]`: `asked` the index in `sidebar` of the message it
   * answered, `ago` minutes ago; `status` (and `by`, a person key) for one that was decided.
   * `imported`: the thread came in through the history import (src/history.js).
   */
  function seed({
    ch, messages, reads = {}, label, facts: threadFacts = [], mentioned = [], draft, bash = [],
    sidebar = [], tools = [], imported = false,
  }) {
    const ids = messages.map(([, ago]) => newId(ch.source, now - ago * MIN));
    const rootId = ids[0];
    const key = threadKey(ch, rootId);
    const entry = {
      key,
      ch,
      rootId,
      path: channelPath({
        org: ch.org, team: ch.team, source: ch.source, channelId: ch.channelId, rootId, id: rootId,
      }).replace(/\/[^/]+\.md$/, '/'),
      messages: [],
      row: null,
      imported,
    };
    threads.set(key, entry);
    messages.forEach(([who, ago, body, extra = {}], i) => {
      if (i === 0 && extra.predates) {
        return;
      }
      const text = typeof body === 'function' ? body({
        ids, ch, rootId, i,
      }) : body;
      const at = new Date(now - ago * MIN).toISOString();
      put(entry, {
        id: ids[i],
        at,
        author: author(who),
        body: text,
        subject: extra.subject,
        editedAt: extra.editedAgo ? new Date(now - extra.editedAgo * MIN).toISOString() : undefined,
        deletedAt: extra.deleted ? at : undefined,
      });
      if (extra.appBy) {
        appPosts.add(`${key}|${ids[i]}`);
      }
    });
    Object.assign(entry, { row: deriveRow(entry) });
    for (const [who, when] of Object.entries(reads)) {
      const p = byKey.get(who);
      const at = when === 'latest' ? entry.row.any_at : new Date(now - when * MIN).toISOString();
      advance(p.id, key, at, 'open');
    }
    if (label) {
      labels.set(key, {
        thread: key,
        next_actor: label.next_actor,
        next_actor_p: 0.9,
        kind: label.kind,
        label_kind: label.kind,
        kind_p: 0.8,
        urgency: label.urgency,
        resolved_p: label.resolved_p,
        topics: label.topics || [],
        // The technologies the thread shows (labels.tech), as JSON; null: labeled before that.
        tech: label.tech ? JSON.stringify(label.tech) : null,
        // The language Clef read (src/translate.js): the inbox translates it where it is not
        // the browser's.
        language: label.language || 'en',
        language_p: label.language_p ?? 0.97,
        labeled_through: entry.row.any_at,
      });
    }
    // Clairic's affected page; the rest as the rules found them.
    facts.set(key, threadFacts.map(([field, value]) => ({
      source: field === 'affected_url' ? 'clairic' : 'rule', field, value, confidence: null,
    })));
    for (const m of mentioned) {
      const [who, ago] = [].concat(m);
      const at = ago === undefined ? entry.row.any_at : new Date(now - ago * MIN).toISOString();
      mentions.push({ thread: key, person: byKey.get(who).id, at });
    }
    if (draft) {
      const p = draft.by === 'agent' ? AGENT : byKey.get(draft.by);
      const at = new Date(now - draft.ago * MIN).toISOString();
      // Its pictures (src/draftfiles.js), served at /api/draft/file as the uploads are. The
      // fixtures' are SVG, which a real draft never has (only PNG, JPEG, GIF and WebP).
      const pictures = (draft.files || []).map(([name, bytes]) => {
        const id = `df_${String(uploads.size + 1).padStart(8, '0')}-0000-4000-8000-000000000000`;
        uploads.set(id, { name, type: 'image/svg+xml', bytes });
        return {
          id, name, type: 'image/svg+xml', size: bytes.length,
        };
      });
      drafts.set(key, {
        thread: key,
        body: draft.body,
        mentions: draft.mentions || [],
        sources: draft.sources || [],
        files: pictures,
        by: { id: p.id, name: p.name },
        created_at: at,
        updated_at: at,
      });
    }
    if (sidebar.length) {
      let asked = null;
      let asker = null;
      let followups = 0;
      sidebars.set(key, sidebar.map(([who, ago, body, opts = {}], i) => {
        const { unseen = false, followup = false } = opts;
        const p = who !== 'agent' && byKey.get(who);
        const id = `sb_${String(threads.size).padStart(8, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`;
        if (p) {
          followups = 0;
        }
        if (followup) {
          followups += 1;
        }
        const m = {
          id: p ? id : `${asked}:${followup ? `followup:${followups}` : 'answer'}`,
          role: p ? 'person' : 'agent',
          by: p ? { id: p.id, name: p.name } : null,
          body,
          state: 'done',
          reply_to: p ? null : asked,
          at: new Date(now - ago * MIN).toISOString(),
          ...(p ? {} : { to: asker, unseen }),
        };
        if (p) {
          asked = id;
          asker = p.id;
        }
        return m;
      }));
    }
    if (tools.length) {
      const said = sidebars.get(key) || [];
      toolRequests.set(key, tools.map((r, i) => {
        const who = r.by && byKey.get(r.by);
        const at = now - r.ago * MIN;
        const decided = r.status ? new Date(at + MIN).toISOString() : null;
        return {
          // Twelve hex digits, as src/agent/toolrequest.js makes them.
          id: (0x4a1c0de51ab0 + threads.size * 0x10000 + i * 0x9e3779b1).toString(16).slice(-12),
          thread: key,
          sidebar: said[r.asked].id,
          kind: r.kind,
          name: r.name,
          title: r.title,
          about: r.about,
          reason: r.reason,
          status: r.status || 'pending',
          created_at: new Date(at).toISOString(),
          deadline: new Date(at + 24 * 60 * MIN).toISOString(),
          by: who ? { id: who.id, name: who.name } : null,
          decided_at: decided,
          expires_at: r.status === 'granted' ? new Date(at + MIN + 24 * 60 * MIN).toISOString() : null,
          revoked_by: null,
          revoked_at: null,
        };
      }));
    }
    if (bash.length) {
      bashRequests.set(key, bash.map((b, i) => {
        const who = b.by && byKey.get(b.by);
        const decided = b.status ? new Date(now - (b.ended ?? 2) * MIN).toISOString() : null;
        return {
          // Twelve hex digits, as src/agent/bashrequest.js makes them: the agent names them.
          id: (0x375f59640760 + threads.size * 0x10000 + i * 0x9e3779b1).toString(16).slice(-12),
          thread: key,
          kind: b.kind || 'bash',
          command: b.command,
          reason: b.reason,
          env: b.env || [],
          tools: b.tools || [],
          sidebar: b.asked === undefined ? null : (sidebars.get(key) || [])[b.asked].id,
          timeout: b.timeout || 60,
          deadline: new Date(now + (b.open ?? 23 * 60) * MIN).toISOString(),
          status: b.status || 'pending',
          created_at: new Date(now - b.ago * MIN).toISOString(),
          by: who ? { id: who.id, name: who.name } : null,
          decided_at: decided,
          finished_at: decided,
          exit_code: b.status === 'done' ? b.exit ?? 0 : null,
          error: null,
        };
      }));
    }
    return key;
  }

  const preview503 = seed({
    ch: CHANNELS.aemAcme,
    messages: [
      ['sam', 340, 'Our preview site is returning 503s since this morning\'s deploy.'],
      ['priya', 332, 'Thanks for flagging. @Sam Reyes, which paths are affected?'],
      ['sam', 330, '/en/* and /de/*. Same deploy as the 14:00 cache flush.', { editedAgo: 329 }],
      ['priya', 300, '@Lena Berg can you check the flush job? cc @Tom Okafor'],
      ['ravi', 20, 'We implement this site for them; happy to share the deploy logs with @Priya Nair.'],
      ['sam', 12, 'Can someone take a look? We are blocked on it. cc @Ravi Kumar'],
      // A pasted permalink, an inline one, a quote card, and both kinds of code.
      ['lena', 6, ({ ids, ch, rootId }) => {
        const link = (id) => {
          const base = `https://acme.slack.com/archives/${ch.channelId}/p${String(id).replace('.', '')}`;
          return id === rootId ? base : `${base}?thread_ts=${rootId}&cid=${ch.channelId}`;
        };
        return `${link(ids[0])}\n\nSee ${link(ids[3])} too.\n\n${quoteMarkdown({
          author: 'Priya Nair',
          url: link(ids[1]),
          at: '2026-10-21T11:43:20.000Z',
          text: 'Thanks for flagging. Which paths are affected?',
        })}\n\nThe header is \`x-request-id\`.\n\n\`\`\`\nGET /en/index.html\n\`\`\``;
      }],
      // A Slack quote: its `>` is one line, the reply under it is not quoted.
      ['priya', 4, '> Can someone take a look? We are blocked on it.\nOn it: the flush job failed at 14:02, I am running it again.'],
    ],
    reads: { priya: 332 },
    label: {
      kind: 'incident',
      next_actor: 'us',
      urgency: 2.4,
      resolved_p: 0.1,
      topics: ['cdn', 'publishing'],
      tech: { akamai: 0.93, eds: 1 },
    },
    // The header's links: the page the customer named first, then the site, then the ids. The
    // pill names the first one's host; the list has long addresses (cut in the middle), one
    // written twice and one Clairic cut off (each shown once).
    facts: [
      ['ticket', 'OPS-1042'], ['site', 'acme/acme-preview'], ['cve', 'CVE-2026-1234'],
      ['url', 'https://main--acme-preview--acme.aem.page/en/index.html'],
      ['url', 'https://www.aem.live/docs/cdn-guide'],
      ['affected_url', 'https://main--acme-preview--acme.aem.page/en/index.html'],
      ['url', 'https://acme.sharepoint.example/sites/acme-web/Shared%20Documents/Launch%20Plan%202026/CDN%20cutover%20runbook.pdf'],
      ['url', 'https://acme.sharepoint.example/sites/acme-web/Shared%20Documents/Launch%20Plan%202026/Cache%20keys.xlsx'],
      ['url', 'http://ACME.sharepoint.example/sites/acme-web/Shared%20Documents/Launch%20Plan%202026/Cache%20keys.xlsx/'],
      ['url', 'https://main--acme-preview--acme.aem.page/en/ind…'],
    ],
    // Written by the thread agent, long enough to fold: the draft line shows its first line.
    draft: {
      by: 'agent',
      ago: 8,
      body: 'Thanks @Sam Reyes, we can reproduce the 503s on /en/* and /de/*; preview is fine, so it '
        + 'looks like the CDN config from the 14:00 flush.\n\nCould you send us the `x-request-id` '
        + 'of one failing request? Meanwhile, purging by path is described here: '
        + 'https://docs.example.com/purge\n\n**What we know so far:**\n'
        + '- the 503s started with the 14:00 cache flush\n'
        + '- only `/en/*` and `/de/*` are affected, because those paths share one surrogate key\n'
        + '- the origin itself answers normally when it is asked directly\n\n'
        + '**What happens next:** we are comparing the CDN configuration before and after the '
        + 'flush. Purged objects are refetched on the next request, so the pages should recover '
        + 'by themselves once the configuration is back.\n\n'
        + 'Your CDN keeps errors for up to 5 minutes, so please purge `/en/*` and `/de/*` there '
        + 'as well once we tell you the origin is healthy again. We will post here as soon as '
        + 'we know more.',
      mentions: [{ id: 'slack-sam', name: 'Sam Reyes' }],
      sources: [
        {
          url: 'https://docs.example.com/purge',
          title: 'Purging the CDN',
          quote: 'Purged objects are **refetched on the next request**; errors are cached for up to 5 minutes.',
        },
        { url: 'https://docs.example.com/surrogate-keys.md', title: 'Surrogate keys' },
        { url: 'https://status.example.com/incidents/42', title: 'Status page' },
      ],
    },
    // The agent tried three times, as the viewer ran each, and asks for a fourth: one long line,
    // with one variable whose description says where to find the value.
    bash: [
      {
        ago: 9,
        command: 'curl -sf -H "Authorization: Bearer $CDN_API_TOKEN" -H "Accept: application/json" '
          + 'https://api.cdn.example.com/v1/services/acme-preview/versions/41',
        reason: 'Reads version 41 of the CDN service, the one from before the 14:00 flush.',
        env: [{ name: 'CDN_API_TOKEN', description: 'Your CDN API token (read-only is enough)' }],
        status: 'done',
        exit: 22,
        by: 'dana',
        ended: 7,
      },
      {
        ago: 6,
        command: 'curl -s -D headers.txt -o body.json -w "HTTP %{http_code}\\n" '
          + '-H "Authorization: Bearer $CDN_API_TOKEN" -H "Accept: application/json" '
          + 'https://api.cdn.example.com/v1/services/acme-preview/versions/41',
        reason: 'The same call, printing the status and keeping the headers, to see why it failed.',
        env: [{ name: 'CDN_API_TOKEN', description: 'Your CDN API token (read-only is enough)' }],
        status: 'done',
        exit: 2,
        by: 'dana',
        ended: 5,
      },
      {
        ago: 4,
        command: 'curl -s -i -A "opspile-agent" -w "\\nHTTP %{http_code}\\n" '
          + '-H "Authorization: Bearer $CDN_API_TOKEN" -H "Accept: application/json" '
          + 'https://api.cdn.example.com/v1/services/acme-preview/versions/41',
        reason: 'The same call with a User-Agent, which the API wants.',
        env: [{ name: 'CDN_API_TOKEN', description: 'Your CDN API token (read-only is enough)' }],
        status: 'done',
        by: 'dana',
        ended: 3,
      },
      {
        ago: 1,
        command: 'curl -sf -A "opspile-agent" -H "Authorization: Bearer $CDN_API_TOKEN" -H "Accept: application/json" '
          + 'https://api.cdn.example.com/v1/services/acme-preview/versions/41 -o version-41.json && '
          + 'curl -sf -A "opspile-agent" -H "Authorization: Bearer $CDN_API_TOKEN" -H "Accept: application/json" '
          + '"https://api.cdn.example.com/v1/services/acme-preview/versions/42?include=backends" -o version-42.json && '
          + 'jq \'{number, active, updated_at, comment, backends: [.backends[].name]}\' version-41.json && '
          + 'jq \'{number, active, updated_at, comment, backends: [.backends[].name]}\' version-42.json',
        reason: 'Reads versions 41 and 42 of the CDN service with your token, saves them to my '
          + 'workspace, and prints what changed with the 14:00 flush. Nothing gets written to '
          + 'the CDN.',
        env: [{
          name: 'CDN_API_TOKEN',
          description: 'A CDN API token with read access to the acme-preview service (a '
            + 'read-only token is enough). cdn.example.com → Account → API tokens.',
        }],
        timeout: 60,
      },
    ],
  });
  {
    // A message of this thread cited too, once its id is known: the source shows its card, not
    // Slack's page (src/messagelinks.js).
    const { ch, rootId, messages } = threads.get(preview503);
    const reply = String(messages[2].id).replace('.', '');
    drafts.get(preview503).sources.push({
      url: `https://acme.slack.com/archives/${ch.channelId}/p${reply}?thread_ts=${rootId}&cid=${ch.channelId}`,
      title: 'Sam: the paths affected',
    });
  }
  {
    // Reactions on the bubbles' edge: two of a kind (one yours) show a count, a single one not.
    const entry = threads.get(preview503);
    const [, , , , ravi, blocked] = entry.messages;
    entry.reactionSeeds = [
      { id: blocked.id, emoji: 'eyes', by: 'dana' },
      { id: blocked.id, emoji: 'eyes', by: 'lena' },
      { id: blocked.id, emoji: 'pray', by: 'priya' },
      { id: ravi.id, emoji: 'raised_hands', by: 'priya' },
    ];
  }

  seed({
    ch: CHANNELS.aemGlobex,
    messages: [
      ['mei', 600, 'Could the nightly index job skip the archive folder?'],
      ['dana', 590, 'On it. Will check the job config today.'],
      ['priya', 40, 'Done: archive is excluded from the job now.'],
      ['priya', 39, 'The next run is tonight at 02:00.'],
      ['priya', 38, 'Please confirm once you have seen it.'],
    ],
    reads: { lena: 'latest', priya: 'latest' },
    label: {
      kind: 'question', next_actor: 'customer', urgency: 0.6, resolved_p: 0.4, topics: ['seo'],
    },
  });

  // A thread about the Sidekick in a channel whose tech stack has Document Authoring: what it
  // shows is not known yet, so the header names its topic, not the channel's likeliest.
  seed({
    ch: CHANNELS.aemGlobex,
    messages: [
      ['mei', 300, 'Is there an issue with the Sidekick right now? We are running into errors.'],
    ],
    label: {
      kind: 'incident', next_actor: 'us', urgency: 1, resolved_p: 0.1, topics: ['auth'],
    },
  });

  // The kinds about people and meetings, not work: a farewell and handover, a call moved.
  // Before it, a thread with a fact of the admin team's Figma rule (scripts/dev-ui-admin.mjs),
  // named as the rule labels it: searching for the file's key shows "Figma file" and the key.
  seed({
    ch: CHANNELS.aemGlobex,
    messages: [
      ['mei', 420, 'Our designers shared the Figma file for the new hero block. Can the block match it on mobile too?'],
      ['priya', 400, 'I will build it from the file and send a preview link.'],
    ],
    reads: { dana: 'latest' },
    label: {
      kind: 'request', next_actor: 'us', urgency: 0.6, resolved_p: 0.2, topics: ['frontend'],
    },
    facts: [['figma_file', 'Hx7DemoKey2026Blocks'], ['order', 'ORD-204816']],
  });
  seed({
    ch: CHANNELS.aemGlobex,
    messages: [
      ['mei', 900, 'Friday is my last day on the project; Jonas takes over the authoring side.'],
      ['lena', 880, 'Thanks for everything, Mei! Welcome aboard, Jonas.'],
    ],
    reads: { dana: 'latest' },
    label: {
      kind: 'people', next_actor: 'nobody', urgency: 0.1, resolved_p: 0.7,
    },
  });
  seed({
    ch: CHANNELS.aemUmbrella,
    messages: [
      ['sam', 400, 'Can we move Thursday\'s go-live check-in to 15:00 CET?'],
      ['priya', 390, 'Works for us, I updated the invite.'],
    ],
    label: {
      kind: 'meeting', next_actor: 'nobody', urgency: 0.4, resolved_p: 0.8, topics: ['project'],
    },
  });

  // A bot of Adobe's (an admin said so on the admin page's Bots) answers the customer: on
  // Adobe's side, as a colleague would, not on the customer's.
  seed({
    ch: CHANNELS.cdn,
    messages: [
      ['mei', 130, 'Could someone add our new developer to this team? Their address is in the ticket.'],
      ['ourbot', 128, 'Added 1 guest to Globex CDN. They get an invitation by mail within a few minutes.'],
      ['mei', 110, 'Thanks, they are in.'],
    ],
    label: {
      kind: 'access', next_actor: 'nobody', urgency: 0.2, resolved_p: 0.8, topics: ['auth'],
    },
  });

  // Dana raised a limit by hand; Priya asked the agent in the sidebar whether the team has a
  // runbook for it, and the agent asked Dana for the steps it could not find
  // (src/questions.js): the question is a thread of Dana's inbox (scripts/dev-ui-admin.mjs).
  seed({
    ch: CHANNELS.cdn,
    messages: [
      ['mei', 300, 'Preview fails on our product pages since they have more than 200 images. Can the limit go up for globex/www?', { subject: 'Preview fails over 200 images' }],
      ['dana', 240, 'Raised it to 400 images for globex/www. Please try again.'],
      ['mei', 200, 'Works now, thanks!'],
    ],
    sidebar: [
      ['priya', 150, 'Do we have a runbook for raising the image limit?'],
      ['agent', 149, 'Partly: kb-team says it is `limits.maxImages` in the site config, under `limits`, not `features`. It does not say how Dana set it, whether it is per site or per org, or how to undo it. I asked Dana for those three, and will write the runbook once she answers.'],
    ],
    label: {
      kind: 'request', next_actor: 'nobody', urgency: 0.3, resolved_p: 0.9, topics: ['cdn'],
    },
  });

  // Dana mentioned Noor, whose name Teams filled in: she was not in the Teams team. The agent
  // said so in the sidebar, and once the bot had added her, followed up there ("Thread Agent
  // followed up with you"), unseen: the row has the purple badge.
  seed({
    ch: CHANNELS.cdn,
    messages: [
      ['mei', 45, 'Purge API calls answer 403 since we rotated the key. Who can look at it?', { subject: 'Purge API 403 after key rotation' }],
      ['dana', 40, '@Noor Haddad can you take this?'],
      ['dana', 20, '@Provisioning Agent add nhaddad@example.com'],
      ['ourbot', 19.5, 'Added nhaddad@example.com to Globex CDN.'],
    ],
    sidebar: [
      ['dana', 30, 'Her name filled in when I mentioned her, so she is in the team, right?'],
      ['agent', 29.5, 'No: Teams completes a mention from the whole directory, not from the team. Noor is not a member of Globex CDN, so the mention did not reach her.\n\nAsk the Provisioning Agent to add her, with her address: `add nhaddad@example.com`.'],
      ['agent', 19, 'Noor is in Globex CDN now: the Provisioning Agent added her a moment ago. Mention her again so she sees Mei\'s question; your first mention did not reach her.', { followup: true, unseen: true }],
    ],
    label: {
      kind: 'incident', next_actor: 'us', urgency: 0.9, resolved_p: 0.05, topics: ['cdn'],
    },
  });

  // A case Adobe opened with Initech, a vendor: Initech asked for headers, Dana sent them a day
  // and a half ago, and it has said nothing since. It waits on the vendor, too long: chase them.
  seed({
    ch: CHANNELS.initech,
    messages: [
      ['dana', 60 * 40, 'Our purge of `/products` did not clear the Frankfurt edge. Can you check what happened there?'],
      ['jonas', 60 * 38, 'Looking into it. Can you send the response headers of a stale hit?'],
      ['dana', 60 * 36, 'Here they are: `x-cache: HIT`, `age: 5402`, served by the FRA edge after the purge returned 200.'],
    ],
    reads: { dana: 'latest' },
    label: {
      kind: 'incident', next_actor: 'vendor', urgency: 1.2, resolved_p: 0.1, topics: ['cdn'],
    },
  });

  seed({
    ch: CHANNELS.initech,
    messages: [
      ['jonas', 200, 'Earlier thread, root predates ingestion.', { predates: true }],
      ['tom', 190, 'Found the stale DNS record. Replacing it now.'],
      ['jonas', 185, 'Thanks, the staging host resolves again.'],
    ],
    mentioned: ['dana'],
  });

  // From the history import: over before the inbox began, so read and quiet, though the customer
  // spoke last and mentioned Dana.
  seed({
    ch: CHANNELS.initech,
    messages: [
      ['jonas', 60 * 24 * 40, 'Do we need to rotate the CDN keys before the migration?'],
      ['tom', 60 * 24 * 40 - 30, 'Not before, the new keys come with it.'],
      ['jonas', 60 * 24 * 40 - 45, 'Great, Dana, can you confirm the date?'],
    ],
    mentioned: ['dana'],
    imported: true,
  });

  seed({
    ch: CHANNELS.alerts,
    messages: [['bot', 25, '[FIRING] Disk usage above 90% on build-7']],
    reads: { dana: 'latest' },
  });
  seed({
    ch: CHANNELS.alerts,
    messages: [['bot', 6, '[FIRING] Queue depth above 5000 on normalize']],
  });

  // An alert that fires again and again, every post folded into the first: in production a
  // group of thousands, of which the thread shows the latest posts' messages and says how many
  // it leaves out (src/api.js's MAX_READ_MEMBERS; the preview's is smaller, scripts/dev-ui.mjs).
  const storm = seed({
    ch: CHANNELS.alerts,
    messages: [['bot', 14 * 60, '[FIRING] Origin errors above 1% on www']],
  });
  for (let i = 1; i <= 11; i += 1) {
    const again = seed({
      ch: CHANNELS.alerts,
      messages: [['bot', 14 * 60 - i * 70, `[FIRING] Origin errors above 1% on www (${i + 1})`]],
    });
    threads.get(again).logical = storm;
    Object.assign(threads.get(again), { row: deriveRow(threads.get(again)) });
  }

  // Only a bot posted, yesterday: in the personal view (Dana posted in the channel) it sorts
  // by that post, not above everything else. Slack sent the channel it names as an id only
  // (`<#C…>`): the thread shows the channel's name, linked to its customer in the inbox.
  seed({
    ch: CHANNELS.initech,
    messages: [['bot', 18 * 60, 'New channel created: #C0UMBRELLA, ask in #edge-questions']],
  });

  // Links to a Teams channel in a Slack message, one bare and one with words of its own: the
  // bare one shows the channel's name, and both open its threads in the inbox.
  seed({
    ch: CHANNELS.initech,
    messages: [['priya', 17 * 60, 'Purges are tracked in https://teams.microsoft.com/l/channel/CH-CDN/CDN%20tickets?groupId=TEAM-EDGE&tenantId=T-FAKE, the release dates in [the release channel](https://teams.microsoft.com/l/channel/CH-RELEASE/Release%20train?groupId=TEAM-PLATFORM&tenantId=T-FAKE).']],
  });

  // A thread in Japanese (Clef reads its language): the inbox shows it translated into the
  // browser's language (GET /api/translate, scripts/dev-ui.mjs), with the bar above it.
  seed({
    ch: CHANNELS.aemGlobex,
    messages: [
      ['mei', 240, 'お世話になっております。プレビューの `/products` ページが今朝から **404** になっています。ご確認いただけますか？'],
      ['priya', 230, 'ご連絡ありがとうございます。確認いたします。'],
      ['mei', 225, 'Thanks, the URL is https://main--site--globex.aem.page/products'],
      ['priya', 200, 'リダイレクトの設定を修正しました。もう一度お試しください。'],
      ['mei', 190, '直りました。ありがとうございます！ :pray:'],
    ],
    reads: { dana: 230 },
    label: {
      kind: 'incident', next_actor: 'nobody', urgency: 0.8, resolved_p: 0.9, topics: ['urls'], language: 'ja',
    },
  });

  // Emoji in other platforms' names and spellings (Discord's `facepalm`, `thumbs-up`, a
  // `_toneN`): shown as emoji all the same (src/emojinames.js).
  seed({
    ch: CHANNELS.initech,
    messages: [
      ['jonas', 160, 'The redirect for /old-pricing loops on stage again.'],
      ['dana', 150, 'Wrong rule order, my bad :facepalm: Fixed on stage, please check :thumbs-up:'],
      ['jonas', 145, 'Works now :white_check_mark: thanks :thumbsup_tone3:'],
    ],
    reads: { dana: 'latest' },
    label: {
      kind: 'incident', next_actor: 'nobody', urgency: 0.6, resolved_p: 0.8, topics: ['seo'],
    },
  });

  // The workspace's own emoji: an image, in a message and a reaction; a name Slack has no
  // emoji for, the closest Clef finds, marked as such; another in an address, left alone.
  {
    const key = seed({
      ch: CHANNELS.aemAcme,
      messages: [
        ['sam', 130, 'Could someone approve the redirect change? urn:aem:sites stays as it is.'],
        ['dana', 125, 'LGTM :approved: and :completed:'],
      ],
      reads: { dana: 'latest' },
      label: {
        kind: 'question', next_actor: 'nobody', urgency: 0.2, resolved_p: 0.8, topics: ['seo'],
      },
    });
    const entry = threads.get(key);
    // One on your own (blue) bubble too.
    entry.reactionSeeds = [
      { id: entry.rootId, emoji: 'approved', by: 'dana' },
      { id: entry.messages[1].id, emoji: 'pray', by: 'sam' },
    ];
  }

  // Two messages mention the viewer since she last read it, one before: the red badge counts 2
  // of this thread on ACME, and the personal view has ACME's channel.
  seed({
    ch: CHANNELS.aemAcme,
    messages: [
      ['sam', 180, '@Dana Ops the CDN still serves the old robots.txt.'],
      ['dana', 170, 'Purging it now.'],
      ['sam', 50, '@Dana Ops it is back after the next deploy.'],
      ['ravi', 15, '@Dana Ops same on the staging host, logs attached.'],
    ],
    reads: { dana: 170 },
    // Many tags: the header's tech stack dropdown names the first and counts the rest.
    label: {
      kind: 'incident',
      next_actor: 'us',
      urgency: 1.6,
      resolved_p: 0.2,
      topics: ['cdn', 'seo', 'publishing', 'performance', 'project', 'authoring', 'urls', 'auth'],
    },
    mentioned: [['dana', 180], ['dana', 50], ['dana', 15]],
  });

  // Asked in the sidebar whether another thread answered this already: the agent sees only its
  // own channel, so it asks to run a script as Dana, which reads the inbox as she may.
  seed({
    ch: CHANNELS.aemGlobex,
    messages: [
      ['mei', 95, 'A new article does not show up on any of the blog cards, on the homepage or on /research/, though it is published.'],
      ['tom', 80, 'cc @Dana Whitfield, I think the ops channel had this last week.'],
    ],
    reads: { dana: 'latest' },
    sidebar: [
      ['dana', 20, 'Is this already answered in another recent thread?'],
      ['agent', 19, 'Not in this channel: none of its threads has it. Tom points at the ops channel, which I cannot read, so I asked to run a script as you that searches your inbox for it: here it is, for you to read and run.'],
    ],
    bash: [{
      ago: 19,
      asked: 0,
      kind: 'codemode',
      tools: ['search_threads', 'get_thread'],
      command: `const { threads } = await tools.search_threads({ query: 'article missing from blog cards', limit: 5 });
for (const t of threads.filter((x) => x.customer === 'globex')) {
  const { messages } = await tools.get_thread({ thread: t.thread, limit: 5 });
  text(\`\${t.title} (\${t.channel}, \${t.link})\`);
  for (const m of messages) text(\`  \${m.from}: \${m.text.slice(0, 300)}\`);
}`,
      reason: 'Looks for a thread of Globex\'s about blog cards that miss an article, in the channels you can see, and prints the latest messages of each it finds.',
    }],
    label: {
      kind: 'incident', next_actor: 'us', urgency: 1, resolved_p: 0.1,
    },
  });

  // Labeled "us", but Adobe asked last: not waiting on us, whatever the label says.
  seed({
    ch: CHANNELS.aemAcme,
    messages: [
      ['sam', 520, 'Can we get a second preview environment for the campaign?'],
      ['priya', 500, 'Sure. Which branch should it build from?'],
    ],
    reads: { priya: 500, dana: 'latest' },
    // Dana asked the agent in the sidebar and went on to another thread before it answered: read,
    // but its answer to her waits, so the row has the purple badge until she opens it.
    sidebar: [
      ['dana', 498, 'Do we have a quota for preview environments on their plan?'],
      ['agent', 497, 'Yes: their plan has **two** preview environments, and they use one (`main`). A second one for the campaign fits, no change to the contract needed.\n\nI left the draft as it is. Nothing went to the channel.', { unseen: true }],
    ],
    label: {
      kind: 'request', next_actor: 'us', urgency: 0.8, resolved_p: 0.1,
    },
  });

  // Moved to Forms ops at Dana's asking, in the sidebar: not in her inbox any more, and she still
  // sees it (from a link, ?t=…) and talks to its agent, though she may not work it. The sidebar
  // says who sees it; the reply box is not hers.
  seed({
    ch: CHANNELS.formsAcme,
    messages: [
      ['sam', 140, 'The contact form stopped sending submissions to our CRM since this morning.'],
    ],
    sidebar: [
      ['dana', 130, 'Does this channel belong to us or to Forms?'],
      ['agent', 129.5, 'It is filed under Platform ops: the `aem-` prefix rule puts it there. It is about AEM Forms, so Forms ops may be the better owner. Should I ask the admin team to move it?'],
      ['dana', 129, 'move.'],
      ['agent', 128.5, 'I filed a request to move the channel to Forms ops. The admin team confirms or declines it in its inbox.'],
    ],
    label: {
      kind: 'incident', next_actor: 'us', urgency: 1.2, resolved_p: 0.1,
    },
  });

  // Waiting on the customer for more than a day: "Customer silent".
  seed({
    ch: CHANNELS.aemGlobex,
    messages: [
      ['mei', 2100, 'Search results show unpublished pages.'],
      ['tom', 2000, 'Can you share one URL where this happens?'],
    ],
    reads: { tom: 2000, dana: 'latest' },
    // A colleague's draft, in a channel where the opspile app does not post: a line break and a
    // numbered list, which the closed line shows rendered, on one line ("… now? 1. Which URL …").
    draft: {
      by: 'tom',
      ago: 20,
      body: 'Thanks for the details.\nWe rolled back the config change; can you confirm it works now?\n'
        + '1. **Which URL** still shows an unpublished page, if any\n'
        + '2. **When** you last saw it',
    },
    label: {
      kind: 'question', next_actor: 'customer', urgency: 0.9, resolved_p: 0.1, topics: ['publishing'],
    },
  });

  seed({
    ch: CHANNELS.release,
    messages: [
      ['lena', 1500, 'Release 42 cut is scheduled for Thursday.', { subject: 'Release 42 cut' }],
      ['tom', 1490, 'Freeze starts Wednesday 18:00. Anything else to land?'],
      ['lena', 95, 'Only the cache header fix. PR is up.'],
      // A Slack channel's link in a Teams post: it opens the channel's threads in the inbox.
      ['tom', 90, 'Globex asked about it too: https://acme.slack.com/archives/C0GLOBEX01'],
    ],
    label: {
      kind: 'request', next_actor: 'nobody', urgency: 0.2, resolved_p: 0.9,
    },
    mentioned: ['tom'],
  });

  seed({
    ch: CHANNELS.random,
    messages: [['mei', 60, 'Anyone else hungry?']],
  });

  // An Adobe person who knows the preview deploys (the ACME 503 thread is about one): offered
  // first of those outside the thread and the channel when someone types @ there, as
  // "Adobe · related" (src/expertise.js).
  seed({
    ch: CHANNELS.release,
    messages: [
      ['lena', 3000, 'Heads-up: the cache flush job restarts the preview workers after every deploy, so preview can answer 503 for a minute.', { subject: 'Preview restarts after the cache flush' }],
      ['tom', 2990, 'Noted, thanks.'],
    ],
  });

  // A customer started a meeting in the channel and wrote in its chat, and nobody joined: Teams'
  // notices say so (src/normalize.js), and are not counted as replies.
  seed({
    ch: CHANNELS.cdn,
    messages: [
      ['system', 50, 'Meeting started by Mei Lin.'],
      ['mei', 50, 'Hi,'],
      ['mei', 49, 'We cannot get any further with the purge. Can we have a quick call?'],
      ['system', 49, 'Meeting ended after 50 s. Only Mei Lin joined.'],
      ['mei', 48, 'Please let us know a time.'],
    ],
    label: {
      kind: 'meeting', next_actor: 'us', urgency: 0.7, resolved_p: 0.05,
    },
  });

  seed({
    ch: CHANNELS.cdn,
    messages: [
      ['mei', 70, 'Purge requests for /assets/* return 202 but the cache keeps serving old files.', { subject: 'Purge not working' }],
      ['mei', 65, `Reproduced on two regions, attaching the headers.\n\nAttachments:\n![headers.png](${upload('headers.png', 'image/svg+xml', screenshot('Response headers, two regions', '#6366f1', [40, 90, 60, 120, 30]))} "640x360")`],
      ['mei', 64, `The recording of the page failing.\n\nAttachments:\n- [picker failing.har](${upload('picker failing.har', 'application/octet-stream', Buffer.from(recordingHar()))})`],
      // A screenshot attached in Teams (a SharePoint file), copied into pile 1 and shown
      // inline; the other file stays a link.
      ['mei', 64, '![Screenshot 2026-10-21 at 10.02.11 AM.png](https://contoso.sharepoint.com/sites/cdn-tickets/Shared%20Documents/General/Screenshot%202026-10-21%20at%2010.02.11%E2%80%AFAM.png "1280x720")\n\nAttachments:\n\n- [headers.har](https://contoso.sharepoint.com/sites/cdn-tickets/Shared%20Documents/General/headers.har)'],
    ],
    // Puts a Teams channel in the personal view, so its platform card has more than Slack.
    mentioned: ['dana'],
  });

  // Files sent with replies: a customer's screenshot, and a reply from the inbox with a
  // screenshot and a log file (as the message lists them once it arrives).
  seed({
    ch: CHANNELS.aemAcme,
    messages: [
      ['sam', 140, `The publish queue looks stuck, see the dashboard.\n\nAttachments:\n![dashboard.png](${upload('dashboard.png', 'image/svg+xml', screenshot('Publish queue', '#ef4444', [20, 35, 60, 95, 120, 130, 135]))} "640x360")`],
      ['dana', 128, `It drained after the restart. Before and after, and the worker log:\n\nAttachments:\n![after-restart.png](${upload('after-restart.png', 'image/svg+xml', screenshot('Publish queue after the restart', '#10b981', [130, 90, 50, 20, 8, 4, 2]))} "640x360")\n\n- [publish-worker.log](${upload('publish-worker.log', 'text/plain', new TextEncoder().encode('12:00:01 restart\n12:00:04 queue draining\n'))})`],
      // Files that are not images: cards, a table and a text to preview, a video to open.
      ['dana', 126, `The publish requests of the last hour, and the replication agent's config:\n\nAttachments:\n- [publish-requests (2).csv](${upload('publish-requests (2).csv', 'text/csv', new TextEncoder().encode(publishCsv()))})\n- [replication-agent.json](${upload('replication-agent.json', 'application/json', new TextEncoder().encode('{"agent":"publish","retries":3,"queue":{"max":500,"paused":false},"targets":["/content/acme","/content/dam/acme"]}'))})\n- [Screen Recording 2026-10-21 at 10.12.03.mov](https://example.slack.com/files/U00000000/F00000001/screen_recording_2026-10-21_at_10.12.03.mov)`],
      ['sam', 122, 'Here is our side of it.\n\nAttachments:\n- CSV file (shared from another workspace; opspile cannot see it)'],
      ['sam', 120, 'Confirmed, publishing works again. Thanks!'],
      // Images one after the other, as Teams attaches them: a gallery (and a lightbox that
      // pages through them).
      ['sam', 110, `One more thing, the author console shows these after every publish:\n\n${[
        ['console-1.png', 'Author console, errors', '#f59e0b', [60, 80, 40, 100], 640, 360],
        ['console-2.png', 'Network tab, failed requests', '#6366f1', [30, 90, 120, 70, 50, 20, 10, 90, 40], 1280, 500],
        ['console-3.png', 'Queue', '#ef4444', [90, 60, 30], 360, 640],
        ['console-4.png', 'Replication agent', '#10b981', [20, 40, 60, 80, 100], 800, 600],
      ].map(([name, title, color, bars, w, h]) => `![${name}](${upload(name, 'image/svg+xml', screenshot(title, color, bars, w, h))} "${w}x${h}")`).join('\n\n')}`],
    ],
    reads: { dana: 'latest' },
    label: {
      kind: 'incident', next_actor: 'nobody', urgency: 0.8, resolved_p: 0.7,
    },
  });

  // Code blocks, highlighted (src/ui-highlight.js): Slack's, which name no language (the
  // highlighter guesses JSON, the log and the command), and one that names it.
  seed({
    ch: CHANNELS.aemAcme,
    messages: [
      ['sam', 90, 'The site config we push, and what preview logs right after:\n\n```\n{\n  "source": {\n    "type": "markup",\n    "url": "https://content.example.com/acme",\n    "retries": 3,\n    "paused": false\n  },\n  "owner": "acme",\n  "repo": "acme-web"\n}\n```\n\n```\n2026-10-21 10:02:11.204 *ERROR* [preview-7] content.Source Failed to fetch /en/index: 503\n2026-10-21 10:02:12.380 *WARN* [preview-7] content.Source Retrying (1 of 3)\n```', { subject: 'Preview fails after the config push' }],
      ['dana', 85, 'Thanks. Can you run this and send what it prints?\n\n```\ncurl -sS -H "Authorization: Bearer $TOKEN" https://admin.example.com/status/acme/acme-web/main/en/index | jq .preview\n```'],
      ['sam', 80, 'Our rewrite does this, in case it matters:\n\n```js\n// Maps legacy paths before the CDN asks the origin.\nexport function rewrite(url) {\n  const path = url.pathname.replace(/^\\/content\\/acme/, \'\');\n  return path.endsWith(\'.html\') ? path.slice(0, -5) : path;\n}\n```'],
      // A table and a file whose name is longer than the bubble is wide, a customer's and a
      // staff member's: the bubble stays in its column (the name is cut, the table wraps), on
      // the right as on the left; a narrow window shows it.
      ['sam', 79, `What preview answered per path since the push:\n\n${WIDE_TABLE}\n\nAttachments:\n- [${LONG_NAME}.csv](${upload(`${LONG_NAME}.csv`, 'text/csv', new TextEncoder().encode(publishCsv()))})`],
      ['dana', 78, `And what the content host answered for the same requests:\n\n${WIDE_TABLE}\n\nAttachments:\n- [${LONG_NAME}.log](${upload(`${LONG_NAME}.log`, 'text/plain', new TextEncoder().encode('10:02:11 503 /en/index\n'))})`],
    ],
    reads: { dana: 85 },
    label: {
      kind: 'incident', next_actor: 'us', urgency: 1.1, resolved_p: 0.2, topics: ['publishing'],
    },
    // Lena asked the thread's agent in the sidebar, before Sam's rewrite came in; Dana joined the
    // conversation after it: one line, Lena's and hers, under the thread, where it was last
    // talked in. A wide screen shows it in the panel beside the thread.
    sidebar: [
      ['lena', 84, 'Have we seen `content.Source` 503s after a config push before?'],
      ['lena', 83.8, `These are the paths that failed:\n\n${WIDE_TABLE}\n\nAttachments:\n- [${LONG_NAME}.log](${upload(`${LONG_NAME}.log`, 'text/plain', new TextEncoder().encode('10:02:11 503 /en/index\n'))})`],
      ['agent', 83.5, 'Yes, twice for ACME this year (*preview-503-after-config-push* in their knowledge base). Both times the content source was set to `paused` by the push, and preview answered 503 until it was resumed.\n\nHere it says `"paused": false`, so it is not that. The retries in the log point at the content host itself.'],
      ['lena', 82, 'So it could be their rewrite?'],
      ['agent', 81.5, 'Possibly: if it strips `/content/acme` before preview asks the content host, the paths would not resolve. I asked Sam for the rewrite in the draft. Nothing went to the channel.'],
      ['dana', 64, 'Does the rewrite Sam sent explain it?'],
      ['agent', 63.5, 'It does: `rewrite` drops `/content/acme`, and the content source\'s `url` ends in `/acme`, so preview asks the content host for `/en/index` under the wrong root.\n\nI put that in the draft, with the one-line fix. Nothing went to the channel.'],
      ['dana', 62, 'Can you check what preview answers for `/en/index` right now?'],
      ['agent', 61.5, 'Not from here: this channel gives me no browser. I asked for one, below. Once someone grants it, I load the preview page and tell you what it answers.'],
    ],
    // The agent asked for a tool its channel does not have, in answer to Dana: it waits for
    // someone on the team to grant or deny it.
    tools: [{
      asked: 6,
      ago: 61.5,
      kind: 'server',
      name: 'global:fluffyjaws',
      title: 'MCP server FluffyJaws',
      about: 'FluffyJaws\' MCP server, Adobe\'s internal support assistant: searches its knowledge (FluffyPack), product documentation, Slack, the wiki, Jira, GitHub code and support tickets, and answers questions about them',
      reason: 'Dana asked whether the content host has had 503s for other customers this week. FluffyJaws has the support tickets, so I can tell her, instead of asking around.',
    }],
  });

  // The customer portal: the welcome that opened the channel, and the customer's first question.
  seed({
    ch: CHANNELS.portal,
    messages: [
      ['lena', 300, 'Welcome to Adobe Enterprise Support, Wayne Enterprises! This is your channel with the Edge ops team. Start a new thread for each question, and we answer you here.'],
      ['lucius', 280, 'Thank you. We are glad to have a line to you at last.'],
    ],
    reads: { dana: 'latest' },
    label: {
      kind: 'other', next_actor: 'nobody', urgency: 0.1, resolved_p: 0.9,
    },
  });
  seed({
    ch: CHANNELS.portal,
    messages: [
      // With what he attached in the portal: an image and a log, by their addresses there.
      ['lucius', 42, 'Universal Editor shows a blank canvas for our press releases\nPages under `/press` open in Universal Editor with nothing on the canvas. Everything else is fine, and the pages are live.\n\n'
        + 'Attachments:\n![canvas.png](https://portal.example.com/api/file/f0wayne000000001a/canvas.png "1280x720")\n\n'
        + '- [editor.log](https://portal.example.com/api/file/f0wayne000000002b/editor.log)'],
      ['lena', 35, 'Is `/press` a folder of its own in Document Authoring, with its own component filter?'],
      ['lucius', 20, 'Yes: it has a `component-filters.json` of its own, added last week.'],
    ],
    label: {
      kind: 'question', next_actor: 'us', urgency: 0.6, resolved_p: 0.1,
    },
  });

  // The customers Dana has read everything of (CHANNELS.hooli and after): one she posts to
  // most, one now and then, and three she has neither posted to nor been mentioned in for weeks.
  const DAY = 24 * 60;
  const quiet = (ch, ago, title, reply, more = []) => seed({
    ch,
    messages: [['lena', ago + 30, title], ['dana', ago, reply], ...more],
    reads: { dana: 'latest' },
    label: {
      kind: 'question', next_actor: 'nobody', urgency: 0.2, resolved_p: 0.9,
    },
  });
  quiet(CHANNELS.hooli, 2 * DAY, 'Hooli asks whether the new redirects can go live with Friday\'s release.', 'They can: the redirects are in the release branch.', [
    ['lena', 2 * DAY - 20, 'Thanks, I will tell them.'],
    ['dana', 2 * DAY - 25, 'Tell them to purge `/promo` after it.'],
  ]);
  quiet(CHANNELS.hooli, 4 * DAY, 'Hooli\'s preview builds take twice as long since Monday.', 'The code bus was slow for everyone on Monday; it is back to normal.', [
    ['dana', 4 * DAY - 10, 'Their builds are back under a minute.'],
    ['dana', 4 * DAY - 12, 'Closing this one.'],
  ]);
  quiet(CHANNELS.hooli, 6 * DAY, 'Can Hooli get a second CDN property for the campaign?', 'Yes, I set it up this morning.', [
    ['dana', 6 * DAY - 5, 'It is `campaign.hooli.example`.'],
  ]);
  quiet(CHANNELS.stark, 5 * DAY, 'Stark\'s sitemap lists pages that are gone.', 'It is rebuilt every night: tomorrow\'s will not have them.');
  quiet(CHANNELS.wonka, 18 * DAY, 'Wonka\'s forms post to an endpoint that answers 404.', 'Their forms service moved: the form config needs the new URL.');
  quiet(CHANNELS.tyrell, 26 * DAY, 'Tyrell wants to know when the old author host goes away.', 'At the end of the quarter; they have a reminder.');
  seed({
    ch: CHANNELS.massive,
    messages: [
      ['priya', 3 * DAY + 30, 'Massive Dynamic\'s survey form drops the file upload field on submit.'],
      ['priya', 3 * DAY, 'The upload limit was 2 MB; raised to 10 MB, and their test submission went through.'],
    ],
    label: {
      kind: 'question', next_actor: 'nobody', urgency: 0.2, resolved_p: 0.9,
    },
  });
  quiet(CHANNELS.cyberdyne, 40 * DAY, 'Cyberdyne sees mixed content warnings on the product pages.', 'Two images still had http URLs; fixed in the content.');

  seed({
    ch: CHANNELS.forum,
    messages: [
      ['jonas', 95, 'Preview fails with "no such site" when the content source has another org name.', { subject: 'Can a content source map to a site with a different org?' }],
      ['lena', 80, 'It can: the site config names the content source. Which org do you have?'],
      ['jonas', 30, 'Ours is `initech`, the site is in `initech-web`.'],
    ],
    // Discord takes no replies as yourself: the draft can still go out as the opspile app. Its
    // code block keeps to the closed line's one line.
    draft: {
      by: 'lena',
      ago: 12,
      body: 'Then map `initech` in the site config of `initech-web`:\n\n```yaml\ncontent:\n'
        + '  source: initech\n  site: initech-web\n```\n\nThe content source names its own org.',
    },
    label: {
      kind: 'question', next_actor: 'us', urgency: 0.8, resolved_p: 0.2,
    },
  });

  // Messages that quote another (forwarded in Slack, or a link to it): a card of the quoted
  // message under the text, in a customer's bubble and in the viewer's own.
  seed({
    ch: CHANNELS.aemGlobex,
    messages: [
      ['mei', 75, `Following up on this one, it happened again this morning.\n\n${quoteMarkdown({
        author: 'Mei Lin',
        url: 'https://slack.example.com/archives/C0GLOBEX01/p1792000000000100',
        at: new Date(now - 2 * 86400000).toISOString(),
        text: 'Search results show unpublished pages, for example `/en/drafts/q3-launch`.\nIt started after the last index rebuild.',
      })}`],
      ['dana', 70, `First step in that direction: the rebuild now skips unpublished pages.\n\n${quoteMarkdown({
        author: 'Tom Okafor',
        url: 'https://slack.example.com/archives/C0GLOBEX01/p1792000000000200',
        at: new Date(now - 26 * 60 * MIN).toISOString(),
        text: 'We should keep drafts out of the index entirely, not just hide them in the results.',
      })}`],
    ],
    reads: { dana: 'latest' },
    label: {
      kind: 'question', next_actor: 'customer', urgency: 0.4, resolved_p: 0.3,
    },
  });

  // Your own messages can be edited in place (✎ on hover): one already edited, one with a
  // typo, and one the viewer posted as the opspile app, which she may edit as the app.
  seed({
    ch: CHANNELS.aemGlobex,
    messages: [
      ['mei', 90, 'The sitemap still lists the old /archive pages.'],
      ['dana', 85, 'Thanks, I will regenerate it after the next publish.', { editedAgo: 84 }],
      ['app', 60, 'The sitemap was regenerated: 1,204 pages, none under `/archive`.', { appBy: 'dana' }],
      ['dana', 58, 'Can you check it on your side? Teh crawler may cache it for an hour.'],
    ],
    reads: { dana: 'latest', mei: 'latest' },
    label: {
      kind: 'request', next_actor: 'customer', urgency: 0.5, resolved_p: 0.5,
    },
  });

  // Replying here fails: the channel is archived (CHANNELS.archived).
  seed({
    ch: CHANNELS.archived,
    messages: [
      ['jonas', 50, 'Is the old staging host still needed? We would like to shut it down.'],
      ['dana', 45, 'Checking with the team.'],
    ],
    reads: { dana: 45 },
    label: {
      kind: 'question', next_actor: 'us', urgency: 0.7, resolved_p: 0.2,
    },
  });

  seed({
    ch: CHANNELS.edgeQ,
    messages: [
      ['lena', 4000, 'Is the new WAF rule set staged anywhere we can test?'],
      ['dana', 3990, 'Staging only, ask Tom for access.'],
    ],
    reads: { dana: 3990 },
    // The agent's draft, in a channel where it does not post itself: sending it (with --manager
    // or --admin) asks whether it may (src/postoffer.js; scripts/dev-ui.mjs counts the rest).
    draft: {
      by: 'agent',
      ago: 30,
      body: 'Tom gave you access to staging: the new rule set is there, on `waf-staging`.',
    },
  });

  // The agent's draft with a screenshot it took on its computer (the browser image): it shows on
  // the draft's line, and goes with the reply when it is sent.
  seed({
    ch: CHANNELS.edgeQ,
    messages: [
      ['lena', 70, 'On phones the sticky banner\'s background stops at the container: is that our CSS or yours?'],
    ],
    reads: { dana: 'latest' },
    label: {
      kind: 'question', next_actor: 'us', urgency: 0.5, resolved_p: 0.1,
    },
    draft: {
      by: 'agent',
      ago: 20,
      body: 'It is the banner block\'s CSS: its background is set on the inner wrapper, which is capped at '
        + 'the container width. Moving it to `.banner` itself fixes it; the screenshot shows the page at '
        + '390 pixels with that change.',
      files: [
        ['banner-390.png', screenshot('Banner at 390 px, with the fix', '#0ea5e9', [110, 110, 110, 110, 110], 390, 640)],
        ['banner-1280.png', screenshot('Banner at 1280 px', '#0ea5e9', [80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80], 1280, 720)],
      ],
    },
  });

  // Three unread mentions of the viewer: the red badge in the personal view's customer column,
  // where the customers with the most for her come first, whatever their names.
  seed({
    ch: CHANNELS.edgeQ,
    messages: [
      ['dana', 300, 'Who owns the rate limits on the edge workers?'],
      ['lena', 240, '@Dana Ops Tom does, but he is out until Monday.'],
      ['tom', 120, '@Dana Ops back early: what do you need?'],
      ['lena', 30, '@Dana Ops Tom raised them, can you check?'],
    ],
    reads: { dana: 300 },
    mentioned: [['dana', 240], ['dana', 120], ['dana', 30]],
  });

  // No mention, but Dana asked: the two replies since she read it are hers to read, and the red
  // badge counts them, as Slack's does (src/threads.js unreadInYours).
  seed({
    ch: CHANNELS.aemUmbrella,
    messages: [
      ['dana', 95, 'Can you send the request ids of the failed uploads?'],
      ['ola', 60, 'Here are three of them, all from this morning.'],
      ['ola', 20, 'More came in since, same error each time.'],
    ],
    reads: { dana: 95 },
    label: {
      kind: 'question', next_actor: 'us', urgency: 1.1, resolved_p: 0.1,
    },
  });

  // Dana asked in her own thread and the opspile app answered: a thread agent's post_message,
  // after she last read it. A bot's reply moves no `last_at`, but it is hers to read: the badge
  // counts it as it counts a person's reply (src/threads.js unreadInYours), and Inbox in the
  // header does too (src/waiting.js).
  seed({
    ch: CHANNELS.initech,
    messages: [
      ['dana', 70, 'Is the checkout cache purged on every deploy, or only on a full release?'],
      ['app', 12, 'Only on a full release: a deploy purges the HTML, the checkout fragments keep their '
        + 'surrogate keys. `POST /purge` with the key `checkout` clears them now.'],
    ],
    reads: { dana: 70 },
    label: {
      kind: 'question', next_actor: 'us', urgency: 0.8, resolved_p: 0.3,
    },
  });

  // Read and unread side by side, for the thread list: critical and
  // unseen, read and resolved with a staff ✅, read and waiting on the customer, read and old.
  seed({
    ch: CHANNELS.aemUmbrella,
    messages: [
      ['ola', 9, 'Checkout returns 500 for every visitor in the EU since 09:10. Orders are down to zero.'],
      ['ola', 4, 'Status page says all green, but our synthetic checks fail on every region.'],
    ],
    label: {
      kind: 'incident', next_actor: 'us', urgency: 3, resolved_p: 0,
    },
  });
  {
    const key = seed({
      ch: CHANNELS.aemGlobex,
      messages: [
        ['mei', 900, 'The docs host shows a certificate warning since this morning.'],
        ['lena', 860, 'The certificate had expired; it is renewed now. Can you check again?'],
        ['mei', 845, 'Works again, thanks!'],
        // Short replies on both sides: the quick reactions on hovering one stay in the pane.
        ['lena', 840, 'Closing. :white_check_mark:'],
      ],
      reads: { dana: 'latest', priya: 'latest' },
      label: {
        kind: 'incident', next_actor: 'nobody', urgency: 1.2, resolved_p: 0.95,
      },
    });
    const entry = threads.get(key);
    entry.reactionSeeds = [{ id: entry.rootId, emoji: 'white_check_mark', by: 'lena' }];
  }
  seed({
    ch: CHANNELS.initech,
    messages: [
      ['jonas', 400, 'Can the retired /blog paths redirect to the new magazine section?'],
      ['dana', 380, 'Yes: add them to redirects.xlsx and publish it. Want me to draft the first rows?'],
    ],
    reads: { dana: 'latest' },
    label: {
      kind: 'question', next_actor: 'customer', urgency: 0.6, resolved_p: 0.3,
    },
  });
  seed({
    ch: CHANNELS.aemUmbrella,
    messages: [
      ['ola', 4400, 'Image renditions look blurry on high-density screens.'],
      ['priya', 4300, 'Add a 2x width to the picture breakpoints; here is the snippet we use.'],
      ['ola', 4200, 'That did it.'],
    ],
    reads: { dana: 'latest', priya: 'latest' },
    label: {
      kind: 'question', next_actor: 'nobody', urgency: 0.4, resolved_p: 0.8,
    },
  });

  // A thread that went on for more than a year and was last heard of yesterday: its latest
  // message says its day with its time ("Yesterday at 12:02 PM"), the others the time alone,
  // as the day is in the divider, which stays on top while its messages scroll by (and says
  // the year of another year). Pointing at any time shows the whole date. A short reply under
  // a long header, and Dana's own, which have the pen beside their quick reactions.
  const noonBefore = (n) => {
    const d = new Date(now);
    const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, 12);
    return Math.round((now - noon.getTime()) / MIN);
  };
  seed({
    ch: CHANNELS.aemUmbrella,
    messages: [
      ['ola', noonBefore(430), 'Could the image CDN keep the original file names in its URLs? Our analytics group by them.'],
      ['priya', noonBefore(430) - 25, 'Yes.'],
      ['ola', noonBefore(6), 'It is back to hashed names since last week\'s release. Was that intended?'],
      ['dana', noonBefore(6) - 40, 'It was not: the release dropped the setting. I am putting it back.'],
      ['ola', noonBefore(1), 'Thanks. The names are right on preview, live still has the hashed ones.'],
      ['dana', noonBefore(1) - 2, 'Live follows with tonight\'s publish.'],
      ['dana', noonBefore(1) - 3, 'I will check it in the morning.'],
    ],
    reads: { dana: 'latest', priya: 'latest' },
    label: {
      kind: 'question', next_actor: 'nobody', urgency: 0.4, resolved_p: 0.7, topics: ['publishing'],
    },
  });

  // A follow-up posted as a new root, folded into the thread it continues (re-threading): one
  // inbox entry, "2 posts folded into one thread". The live case, a root folded after it was
  // in the list, is `POST /__dev/rethread` (scripts/dev-ui.mjs).
  const asked = seed({
    ch: CHANNELS.aemUmbrella,
    messages: [
      ['ola', 300, 'Our sitemap.xml still lists the retired /promo pages.'],
      ['tom', 280, 'They come from the query index. I will drop them from it.'],
    ],
    reads: { dana: 'latest' },
    // Labeled before labels had their technologies: the channel's are all the header has.
    label: {
      kind: 'request', next_actor: 'us', urgency: 0.5, resolved_p: 0.2, topics: ['seo'],
    },
    // No page named: the site's production URL comes first.
    facts: [['site', 'umbrella/www'], ['url', 'https://github.com/umbrella/www']],
  });
  const followUp = seed({
    ch: CHANNELS.aemUmbrella,
    messages: [['ola', 25, 'Any news on the sitemap? Search Console keeps flagging /promo.']],
  });
  threads.get(followUp).logical = asked;
  Object.assign(threads.get(followUp), { row: deriveRow(threads.get(followUp)) });

  // With `--admin`: one unread thread filed under Admin, in a channel Dana never posted in,
  // so the end of her personal unread list can name Admin last (it is her smallest team).
  if (admin) {
    seed({
      ch: {
        source: 'slack', channelId: 'C0ADMIN01', name: 'admin-desk', org: 'opspile', team: 'admin',
      },
      messages: [['lena', 12, 'This channel is still with Admin. Who should take it?']],
      label: {
        kind: 'request', next_actor: 'us', urgency: 0.6, resolved_p: 0.1,
      },
    });
  }

  if (big) {
    addBigInbox({
      people, byKey, seed, threads,
    });
  }

  const teams = admin
    ? [...TEAMS, { slug: 'admin', name: 'Admin', members: [1] }]
    : TEAMS;

  // Linked across a partner and its customers (src/threadlinks.js): the agency's own thread about
  // ACME's preview after a repository move, possibly the 503s ACME reported in its channel, where
  // Ravi of the agency posts too.
  const agencyMove = seed({
    ch: CHANNELS.agencyProjects,
    messages: [
      ['ravi', 95, 'After we moved the preview repository to the new GitHub org, the preview still serves the old code.'],
      ['priya', 80, 'Which org does the code sync point at now? It may still be the old one.'],
      ['ravi', 30, 'The new one, as far as we can tell. The 503s started after the move as well.'],
    ],
    label: {
      kind: 'incident', next_actor: 'us', urgency: 1.6, resolved_p: 0.1, topics: ['publishing'], tech: { eds: 1, github: 0.9 },
    },
    facts: [['site', 'acme/acme-preview']],
  });
  // A public channel's thread: Sam of ACME, Ravi of the agency and Kai of no known org.
  const workshop = seed({
    ch: CHANNELS.workshop,
    messages: [
      ['kai', 70, 'In the workshop exercise, my preview shows a 404 after I add the block. What did I miss?'],
      ['sam', 55, 'Same for me. The block folder name and the class name have to match, I think?'],
      ['ravi', 40, 'They do, and the block needs both a `.js` and a `.css` file of that name.'],
    ],
    label: {
      kind: 'question', next_actor: 'us', urgency: 0.6, resolved_p: 0.2, tech: { eds: 1 },
    },
  });
  const threadOrgs = [
    {
      thread: workshop, org: 'acme', name: 'ACME', icon: 'acme.example', role: 'customer', p: 1, via: ['posters'],
    },
    {
      thread: workshop, org: 'agency', name: 'Agency Co', icon: 'agency.example', role: 'partner', p: 1, via: ['posters'],
    },
    {
      thread: agencyMove, org: 'acme', name: 'ACME', icon: 'acme.example', role: 'about', p: 0.92, via: ['facts', 'clef'],
    },
    {
      thread: preview503, org: 'agency', name: 'Agency Co', icon: 'agency.example', role: 'partner', p: 1, via: ['posters'],
    },
  ];
  const threadLinks = [{
    a: agencyMove, b: preview503, score: 0.87, p: 0.81, via: ['owner', 'clef'],
  }];

  return {
    now,
    me: {
      ...people.get(1),
      teams: teams.filter((t) => t.members.includes(1)).map(({ slug, name }) => ({ slug, name })),
      admin: false,
    },
    teams,
    klickhaus: KLICKHAUS,
    partners: PARTNERS,
    threadOrgs,
    threadLinks,
    people,
    members: MEMBERS,
    threads,
    files,
    watermarks,
    labels,
    facts,
    mentions,
    appPosts,
    drafts,
    bashRequests,
    toolRequests,
    sidebars,
    sourceViews,
    sourcePage,
    uploads,
    upload,

    /** Adds a live message to a thread, as the normalizer would. Returns the thread key. */
    post(key, who, body, at = new Date().toISOString(), given = null) {
      const entry = threads.get(key);
      const id = given || newId(entry.ch.source, Date.parse(at));
      put(entry, {
        id, at, author: author(who), body,
      });
      if (who === 'app') {
        appPosts.add(`${key}|${id}`);
      }
      return key;
    },

    /** The id and thread key of a thread about to start in `ch`, as a platform gives them. */
    startId(ch, at) {
      const id = newId(ch.source, at);
      return { id, key: threadKey(ch, id) };
    },

    /** The key of the thread message `rootId` starts in `ch`, and an id for a reply in it. */
    replyIn(ch, rootId, at) {
      return { key: threadKey(ch, rootId), id: newId(ch.source, at) };
    },

    /** Starts thread `key` with message `id`, as its first message arriving would. */
    start(ch, { id, key }, who, body, at = new Date().toISOString()) {
      const entry = {
        key,
        ch,
        rootId: id,
        path: channelPath({
          org: ch.org, team: ch.team, source: ch.source, channelId: ch.channelId, rootId: id, id,
        }).replace(/\/[^/]+\.md$/, '/'),
        messages: [],
        row: null,
      };
      threads.set(key, entry);
      put(entry, {
        id, at, author: author(who), body,
      });
      return key;
    },

    /** Replaces a message's text, as an edit arriving from the platform would. */
    edit(key, id, body, at = new Date().toISOString()) {
      const entry = threads.get(key);
      const m = entry && entry.messages.find((x) => x.id === id);
      if (m) {
        put(entry, { ...m, body, editedAt: at });
      }
      return Boolean(m);
    },

    /** A platform message id for a new message, as Slack or Teams would assign it. */
    newId: (key, at = Date.now()) => newId(threads.get(key).ch.source, at),

    /** Re-threads `key` into the group of `into`, as src/rethread.js decides a match. */
    rethread(key, into) {
      const entry = threads.get(key);
      const group = threads.get(into);
      if (!entry || !group || key === into) {
        return null;
      }
      const first = group.logical || into;
      entry.logical = first;
      Object.assign(entry, { row: deriveRow(entry) });
      return first;
    },

    /** Moves a watermark forward only, like TeamRoom.read. */
    read(person, key, at) {
      advance(person, key, at, 'open');
    },
  };
}
