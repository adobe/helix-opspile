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
    key: 'lena', id: 3, name: 'Lena Berg', email: 'lena@example.com', staff: true,
  },
  {
    key: 'tom', id: 4, name: 'Tom Okafor', email: 'tom@example.com', staff: true,
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
];

/** The `partner_domains` table: mail domain -> partner name. */
const PARTNERS = new Map([['agency.example', 'Agency Co']]);

const TEAMS = [
  { slug: 'platform', name: 'Platform ops', members: [1, 2, 3, 4] },
  { slug: 'edge', name: 'Edge ops', members: [1, 3] },
];

const BOT = {
  kind: 'bot', name: 'Alertmanager', org: null, staff: false,
};
/** The opspile app, which posts what someone sends as it (POST /api/post/app). */
const APP = {
  kind: 'bot', name: 'opspile', org: null, staff: false,
};

/** The thread agent, which saves shared drafts as this person (src/agent/tools.js). */
const AGENT = { id: 900, name: 'opspile agent' };

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
  },
  aemGlobex: {
    source: 'slack', channelId: 'C0GLOBEX01', name: 'aem-globex', org: 'globex', team: 'platform',
  },
  initech: {
    source: 'slack', channelId: 'C0INITECH1', name: 'initech-support', org: 'initech', team: 'platform',
  },
  aemUmbrella: {
    source: 'slack', channelId: 'C0UMBRELLA', name: 'aem-umbrella', org: 'umbrella', team: 'platform',
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
    name: 'CDN tickets',
    org: 'globex',
    team: 'edge',
    teamId: 'TEAM-EDGE',
  },
  edgeQ: {
    source: 'slack', channelId: 'C0EDGEQ01', name: 'edge-questions', org: 'opspile', team: 'edge',
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
  // A community server: a forum where every post is a thread.
  forum: {
    source: 'discord', channelId: '1100000000000000001', name: 'community-forum', org: 'opspile', team: 'edge', appPosting: true,
  },
};

/**
 * A made-up screenshot: a chart with a title, as an SVG, for the messages with attachments.
 */
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
 */
export function createStore(now = Date.now(), { big = false } = {}) {
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
    const p = byKey.get(key);
    return {
      kind: 'person', name: p.name, org: p.org || null, staff: p.staff,
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
    return source === 'slack'
      ? `${Math.floor(ms / 1000)}.${String(seq).padStart(6, '0')}`
      : String(ms + seq);
  }

  function threadKey(ch, rootId) {
    if (ch.source === 'discord') {
      return `discord:${TENANT}:${ch.channelId}:${rootId}`;
    }
    return ch.source === 'slack'
      ? `slack:${TENANT}:${ch.channelId}:${rootId}`
      : `teams:${TENANT}:${ch.teamId}:${ch.channelId}:${rootId}`;
  }

  function permalink(ch, id) {
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
    const titleSource = root && !root.deletedAt && titled(root)
      ? root
      : live.find((m) => titled(m));
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
      messages: live.length,
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
   * `who` is a person key, 'bot' or 'app'. `extra`: `{ subject, editedAgo, deleted, predates,
 * appBy }`; `appBy: 'dana'` says the viewer posted an 'app' message as the opspile app.
   * `predates` drops the root from the store, like a thread that started before ingestion.
   * `reads` maps a person key to `'latest'` or minutes ago, when they opened the thread.
   * `mentioned` lists person keys, mentioned in the last message, or `[key, minutesAgo]`.
   * `draft`: the thread's shared draft, `{ by, ago, body }`; `by` is a person key or 'agent'.
   */
  function seed({
    ch, messages, reads = {}, label, facts: threadFacts = [], mentioned = [], draft,
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
    };
    threads.set(key, entry);
    messages.forEach(([who, ago, body, extra = {}], i) => {
      if (i === 0 && extra.predates) {
        return;
      }
      const at = new Date(now - ago * MIN).toISOString();
      put(entry, {
        id: ids[i],
        at,
        author: author(who),
        body,
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
        labeled_through: entry.row.any_at,
        reviewed: [],
      });
    }
    facts.set(key, threadFacts.map(([field, value]) => ({
      source: 'rule', field, value, confidence: null,
    })));
    for (const m of mentioned) {
      const [who, ago] = [].concat(m);
      const at = ago === undefined ? entry.row.any_at : new Date(now - ago * MIN).toISOString();
      mentions.push({ thread: key, person: byKey.get(who).id, at });
    }
    if (draft) {
      const p = draft.by === 'agent' ? AGENT : byKey.get(draft.by);
      const at = new Date(now - draft.ago * MIN).toISOString();
      drafts.set(key, {
        thread: key,
        body: draft.body,
        mentions: draft.mentions || [],
        by: { id: p.id, name: p.name },
        created_at: at,
        updated_at: at,
      });
    }
    return key;
  }

  seed({
    ch: CHANNELS.aemAcme,
    messages: [
      ['sam', 340, 'Our preview site is returning 503s since this morning\'s deploy.'],
      ['priya', 332, 'Thanks for flagging. @Sam Reyes, which paths are affected?'],
      ['sam', 330, '/en/* and /de/*. Same deploy as the 14:00 cache flush.', { editedAgo: 329 }],
      ['priya', 300, '@Lena Berg can you check the flush job? cc @Tom Okafor'],
      ['ravi', 20, 'We implement this site for them; happy to share the deploy logs with @Priya Nair.'],
      ['sam', 12, 'Can someone take a look? We are blocked on it. cc @Ravi Kumar'],
    ],
    reads: { priya: 332 },
    label: {
      kind: 'incident', next_actor: 'us', urgency: 2.4, resolved_p: 0.1,
    },
    facts: [['ticket', 'OPS-1042'], ['site', 'acme-preview']],
    // Written by the thread agent, long enough to fold: the draft line shows its first line.
    draft: {
      by: 'agent',
      ago: 8,
      body: 'Thanks @Sam Reyes, we can reproduce the 503s on /en/* and /de/*; preview is fine, so it '
        + 'looks like the CDN config from the 14:00 flush.\n\nCould you send us the `x-request-id` '
        + 'of one failing request? Meanwhile, purging by path is described here: '
        + 'https://docs.example.com/purge',
      mentions: [{ id: 'slack-sam', name: 'Sam Reyes' }],
    },
  });

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
      kind: 'question', next_actor: 'customer', urgency: 0.6, resolved_p: 0.4,
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

  seed({
    ch: CHANNELS.alerts,
    messages: [['bot', 25, '[FIRING] Disk usage above 90% on build-7']],
    reads: { dana: 'latest' },
  });
  seed({
    ch: CHANNELS.alerts,
    messages: [['bot', 6, '[FIRING] Queue depth above 5000 on normalize']],
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
      kind: 'incident', next_actor: 'nobody', urgency: 0.6, resolved_p: 0.8,
    },
  });

  // Two messages mention the viewer since she last read it, one before: the customer card
  // shows 2 unread mentions on ACME, and the personal view has ACME's channel.
  seed({
    ch: CHANNELS.aemAcme,
    messages: [
      ['sam', 180, '@Dana Ops the CDN still serves the old robots.txt.'],
      ['dana', 170, 'Purging it now.'],
      ['sam', 50, '@Dana Ops it is back after the next deploy.'],
      ['ravi', 15, '@Dana Ops same on the staging host, logs attached.'],
    ],
    reads: { dana: 170 },
    label: {
      kind: 'incident', next_actor: 'us', urgency: 1.6, resolved_p: 0.2,
    },
    mentioned: [['dana', 180], ['dana', 50], ['dana', 15]],
  });

  // Labeled "us", but Adobe asked last: not waiting on us, whatever the label says.
  seed({
    ch: CHANNELS.aemAcme,
    messages: [
      ['sam', 520, 'Can we get a second preview environment for the campaign?'],
      ['priya', 500, 'Sure. Which branch should it build from?'],
    ],
    reads: { priya: 500, dana: 'latest' },
    label: {
      kind: 'request', next_actor: 'us', urgency: 0.8, resolved_p: 0.1,
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
    // A colleague's draft, in a channel where the opspile app does not post.
    draft: {
      by: 'tom', ago: 20, body: 'Thanks for the details. We rolled back the config change; can you confirm it works now?',
    },
    label: {
      kind: 'question', next_actor: 'customer', urgency: 0.9, resolved_p: 0.1,
    },
  });

  seed({
    ch: CHANNELS.release,
    messages: [
      ['lena', 1500, 'Release 42 cut is scheduled for Thursday.', { subject: 'Release 42 cut' }],
      ['tom', 1490, 'Freeze starts Wednesday 18:00. Anything else to land?'],
      ['lena', 95, 'Only the cache header fix. PR is up.'],
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
  // first among staff when someone types @ there, as "Adobe · related" (src/expertise.js).
  seed({
    ch: CHANNELS.release,
    messages: [
      ['lena', 3000, 'Heads-up: the cache flush job restarts the preview workers after every deploy, so preview can answer 503 for a minute.', { subject: 'Preview restarts after the cache flush' }],
      ['tom', 2990, 'Noted, thanks.'],
    ],
  });

  seed({
    ch: CHANNELS.cdn,
    messages: [
      ['mei', 70, 'Purge requests for /assets/* return 202 but the cache keeps serving old files.', { subject: 'Purge not working' }],
      ['mei', 65, `Reproduced on two regions, attaching the headers.\n\nAttachments:\n![headers.png](${upload('headers.png', 'image/svg+xml', screenshot('Response headers, two regions', '#6366f1', [40, 90, 60, 120, 30]))} "640x360")`],
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

  seed({
    ch: CHANNELS.forum,
    messages: [
      ['jonas', 95, 'Preview fails with "no such site" when the content source has another org name.', { subject: 'Can a content source map to a site with a different org?' }],
      ['lena', 80, 'It can: the site config names the content source. Which org do you have?'],
      ['jonas', 30, 'Ours is `initech`, the site is in `initech-web`.'],
    ],
    // Discord takes no replies as yourself: the draft can still go out as the opspile app.
    draft: {
      by: 'lena', ago: 12, body: 'Then map `initech` in the site config of `initech-web`: the content source names its own org.',
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
  });

  // Read and unread side by side, for the thread list's designs (?design=a|b|c): critical and
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
        ['lena', 840, 'Great, closing this one. :white_check_mark:'],
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

  if (big) {
    addBigInbox({
      people, byKey, seed, threads,
    });
  }

  return {
    now,
    me: {
      ...people.get(1), teams: TEAMS.map(({ slug, name }) => ({ slug, name })), admin: false,
    },
    teams: TEAMS,
    partners: PARTNERS,
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

    /** Moves a watermark forward only, like TeamRoom.read. */
    read(person, key, at) {
      advance(person, key, at, 'open');
    },
  };
}
