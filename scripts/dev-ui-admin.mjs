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

import { admin } from '../src/admin.js';
import { kbAdmin } from '../src/kbadmin.js';
import { consume } from '../src/normalizer.js';
import { d1 } from '../test/d1.js';
import { fakeBucket } from '../test/fakes.js';

/**
 * The admin pages (`/inbox/admin`) for `npm run ui:dev`: the real src/admin.js over an
 * in-memory D1 with the production migrations (test/d1.js), seeded from the fake inbox's
 * teams, people and threads. Re-filing jobs run at once on a fake pile 2. Made-up data only.
 */

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

export function createAdmin(store, { manager = false, bases = [] } = {}) {
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
  DB.sqlite.exec(`INSERT INTO orgs (slug, name, type, icon, updated_at) VALUES
    ('acme', 'ACME Corporation', 'customer', 'acme.example', '2026-10-20T09:00:00Z'),
    ('initech', 'Initech', 'vendor', NULL, '2026-10-20T09:00:00Z'),
    ('hooli', 'Hooli Inc.', 'customer', NULL, '2026-10-20T09:00:00Z'),
    ('wonka', 'Wonka Industries', 'customer', NULL, '2026-10-20T09:00:00Z'),
    ('soylent', 'Soylent Corporation', 'customer', NULL, '2026-10-20T09:00:00Z')`);

  // The knowledge bases of the fake editor (dev-ui-kb.mjs), so its channel and agent routes
  // (src/kbadmin.js) find them; agents are "configured", and on in one channel by default.
  for (const b of bases) {
    DB.sqlite.prepare(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
      VALUES (?, ?, ?, 'dev', ?)`).run(b.repo, b.kind, b.slug, b.created_at);
  }
  const queued = [];
  const env = {
    DB,
    CHANNELS,
    NORMALIZE: { send: async (body) => queued.push(body) },
    AGENTS: {},
    AGENT_MODEL: 'dev',
    AGENT_CHANNELS: 'C0ACMEAEM',
  };
  // Dana is in the admin team here, or (`--manager`) only the manager of Edge ops.
  if (manager) {
    DB.sqlite.exec("DELETE FROM team_members WHERE team = 'admin' AND person = 1; UPDATE team_members SET role = 'manager' WHERE team = 'edge' AND person = 1");
  }
  const me = manager
    ? {
      ...store.me, admin: false, teams: store.me.teams.map((t) => ({ ...t, role: t.slug === 'edge' ? 'manager' : 'member' })), manages: ['edge'],
    }
    : { ...store.me, admin: true, teams: [...store.me.teams, { slug: 'admin', name: 'Admin' }] };

  const toRequest = (req, url, body) => new Request(url, {
    method: req.method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  /** `/api/kb`, `/api/kb/channels` and `/api/kb/agent`, by the real src/kbadmin.js. */
  const kb = (req, url, body) => kbAdmin(toRequest(req, url, body), env, url, me);

  return Object.assign(async (req, url, body) => {
    const res = await admin(toRequest(req, url, body), env, url, me);
    // Re-filing runs right away here.
    while (queued.length) {
      const messages = queued.splice(0).map((b) => ({ body: b, ack() {}, retry() {} }));
      // eslint-disable-next-line no-await-in-loop
      await consume({ messages }, env);
    }
    return res;
  }, { kb });
}
