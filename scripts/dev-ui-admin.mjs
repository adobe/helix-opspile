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
import { consume } from '../src/normalizer.js';
import { d1 } from '../test/d1.js';
import { fakeBucket } from '../test/fakes.js';

/**
 * The admin pages (`/inbox/admin`) for `npm run ui:dev`: the real src/admin.js over an
 * in-memory D1 with the production migrations (test/d1.js), seeded from the fake inbox's
 * teams, people and threads. Re-filing jobs run at once on a fake pile 2. Made-up data only.
 */

export function createAdmin(store, { manager = false } = {}) {
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
  DB.sqlite.exec(`INSERT INTO orgs (slug, name, type, icon, updated_at) VALUES
    ('acme', 'ACME Corporation', 'customer', 'acme.example', '2026-10-20T09:00:00Z'),
    ('initech', 'Initech', 'vendor', NULL, '2026-10-20T09:00:00Z')`);

  const queued = [];
  const env = {
    DB, CHANNELS, NORMALIZE: { send: async (body) => queued.push(body) },
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

  return async function handle(req, url, body) {
    const request = new Request(url, {
      method: req.method,
      ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    });
    const res = await admin(request, env, url, me);
    // Re-filing runs right away here.
    while (queued.length) {
      const messages = queued.splice(0).map((b) => ({ body: b, ack() {}, retry() {} }));
      // eslint-disable-next-line no-await-in-loop
      await consume({ messages }, env);
    }
    return res;
  };
}
