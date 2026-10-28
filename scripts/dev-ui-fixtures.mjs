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
import { titleOf } from '../src/threads.js';

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

/** Channels: where a thread lives. `org` and `team` are what the rules would file it under. */
const CHANNELS = {
  aemAcme: {
    source: 'slack', channelId: 'C0ACMEAEM', name: 'aem-acme', org: 'acme', team: 'platform',
  },
  aemGlobex: {
    source: 'slack', channelId: 'C0GLOBEX01', name: 'aem-globex', org: 'globex', team: 'platform',
  },
  initech: {
    source: 'slack', channelId: 'C0INITECH1', name: 'initech-support', org: 'initech', team: 'platform',
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
  // A community server: a forum where every post is a thread.
  forum: {
    source: 'discord', channelId: '1100000000000000001', name: 'community-forum', org: 'opspile', team: 'edge',
  },
};

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
   * `who` is a person key or 'bot'. `extra`: `{ subject, editedAgo, deleted, predates }`.
   * `predates` drops the root from the store, like a thread that started before ingestion.
   * `reads` maps a person key to `'latest'` or minutes ago, when they opened the thread.
   */
  function seed({
    ch, messages, reads = {}, label, facts: threadFacts = [], mentioned = [],
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
    for (const who of mentioned) {
      mentions.push({ thread: key, person: byKey.get(who).id, at: entry.row.any_at });
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

  // Labeled "us", but Adobe asked last: not waiting on us, whatever the label says.
  seed({
    ch: CHANNELS.aemAcme,
    messages: [
      ['sam', 520, 'Can we get a second preview environment for the campaign?'],
      ['priya', 500, 'Sure. Which branch should it build from?'],
    ],
    reads: { priya: 500 },
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
    reads: { tom: 2000 },
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

  seed({
    ch: CHANNELS.cdn,
    messages: [
      ['mei', 70, 'Purge requests for /assets/* return 202 but the cache keeps serving old files.', { subject: 'Purge not working' }],
      ['mei', 65, 'Reproduced on two regions, attaching the headers.'],
    ],
  });

  seed({
    ch: CHANNELS.forum,
    messages: [
      ['jonas', 95, 'Preview fails with "no such site" when the content source has another org name.', { subject: 'Can a content source map to a site with a different org?' }],
      ['lena', 80, 'It can: the site config names the content source. Which org do you have?'],
      ['jonas', 30, 'Ours is `initech`, the site is in `initech-web`.'],
    ],
    label: {
      kind: 'question', next_actor: 'us', urgency: 0.8, resolved_p: 0.2,
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
    threads,
    files,
    watermarks,
    labels,
    facts,
    mentions,

    /** Adds a live message to a thread, as the normalizer would. Returns the thread key. */
    post(key, who, body, at = new Date().toISOString(), given = null) {
      const entry = threads.get(key);
      const id = given || newId(entry.ch.source, Date.parse(at));
      put(entry, {
        id, at, author: author(who), body,
      });
      return key;
    },

    /** A platform message id for a new message, as Slack or Teams would assign it. */
    newId: (key, at = Date.now()) => newId(threads.get(key).ch.source, at),

    /** Moves a watermark forward only, like TeamRoom.read. */
    read(person, key, at) {
      advance(person, key, at, 'open');
    },
  };
}
