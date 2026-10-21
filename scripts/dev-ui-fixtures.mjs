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
    key: 'dana', id: 1, name: 'Dana Ops', email: 'dana@example.com', staff: true,
  },
  {
    key: 'priya', id: 2, name: 'Priya Nair', email: 'priya@example.com', staff: true,
  },
  {
    key: 'lena', id: 3, name: 'Lena Berg', email: 'lena@example.com', staff: true,
  },
  {
    key: 'tom', id: 4, name: 'Tom Okafor', email: 'tom@example.com', staff: true,
  },
  {
    key: 'sam', id: 5, name: 'Sam Reyes', email: 'sam@acme.example', org: 'acme', staff: false,
  },
  {
    key: 'mei', id: 6, name: 'Mei Lin', email: 'mei@globex.example', org: 'globex', staff: false,
  },
  {
    key: 'jonas', id: 7, name: 'Jonas Weber', email: 'jonas@initech.example', org: 'initech', staff: false,
  },
];

const TEAMS = [
  { slug: 'platform', name: 'Platform ops', members: [1, 2, 3, 4] },
  { slug: 'edge', name: 'Edge ops', members: [1, 3] },
];

const BOT = {
  kind: 'bot', name: 'Alertmanager', org: null, staff: false,
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
};

/**
 * Builds the fake store. Times are relative to `now`, so the inbox always looks fresh.
 *
 * @param {number} now epoch ms
 */
export function createStore(now = Date.now()) {
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
    return source === 'slack'
      ? `${Math.floor(ms / 1000)}.${String(seq).padStart(6, '0')}`
      : String(ms + seq);
  }

  function threadKey(ch, rootId) {
    return ch.source === 'slack'
      ? `slack:${TENANT}:${ch.channelId}:${rootId}`
      : `teams:${TENANT}:${ch.teamId}:${ch.channelId}:${rootId}`;
  }

  function permalink(ch, id) {
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
      const person = PEOPLE.find((p) => p.name === m.author.name);
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
      ['priya', 332, 'Thanks for flagging. Which paths are affected?'],
      ['sam', 330, '/en/* and /de/*. Same deploy as the 14:00 cache flush.', { editedAgo: 329 }],
      ['sam', 12, 'Can someone take a look? We are blocked on it.'],
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
      ['priya', 40, 'Done: archive is excluded from the job now. Please confirm.'],
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
    ch: CHANNELS.edgeQ,
    messages: [
      ['lena', 4000, 'Is the new WAF rule set staged anywhere we can test?'],
      ['dana', 3990, 'Staging only, ask Tom for access.'],
    ],
    reads: { dana: 3990 },
  });

  return {
    now,
    me: {
      ...people.get(1), teams: TEAMS.map(({ slug, name }) => ({ slug, name })), admin: false,
    },
    teams: TEAMS,
    people,
    threads,
    files,
    watermarks,
    labels,
    facts,
    mentions,

    /** Adds a live message to a thread, as the normalizer would. Returns the thread key. */
    post(key, who, body, at = new Date().toISOString()) {
      const entry = threads.get(key);
      const id = newId(entry.ch.source, Date.parse(at));
      put(entry, {
        id, at, author: author(who), body,
      });
      return key;
    },

    /** Moves a watermark forward only, like TeamRoom.read. */
    read(person, key, at) {
      advance(person, key, at, 'open');
    },
  };
}
