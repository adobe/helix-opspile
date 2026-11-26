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
 * A partner's page (src/partners.js `partnerNumbers`) for `npm run ui:dev`: half a year of Pied
 * Piper Digital, the agency of dev-ui-admin.mjs `seedPartnerPairs`. Its three people ask in its own
 * channel and in the threads of ACME and Hooli, whose sites they build; Adobe's people answer,
 * and a few of their threads wait on Adobe. Pied Piper is likely ACME's partner (Clef says so) and
 * confirmed as Hooli's (src/orgpartners.js). Made up.
 */

const DAY = 86400000;
const MIN = 60000;

/** A made-up face (scripts/dev-ui.mjs FACE), its shirt in `shirt`. */
const face = (shirt, skin = '#f1d3b8', back = '#8fb8de') => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${back}"/><circle cx="32" cy="25" r="12" fill="${skin}"/><path d="M10 64c2-14 11-21 22-21s20 7 22 21z" fill="${shirt}"/></svg>`)}`;

/** Its people: the accounts of `seedPartnerPairs`, made people with a picture and a title. */
const PEOPLE = [
  {
    id: 71, user: 'U-PP1', avatar: face('#7d5a35', '#e8c4a0', '#e0d2b8'), title: 'Technical director',
  },
  {
    id: 72, user: 'U-PP2', avatar: face('#35617d', '#a56b46'), title: 'Frontend developer',
  },
  {
    id: 73, user: 'U-PP3', avatar: null, title: 'Project manager',
  },
];

/**
 * The threads its people start: `[org, title, days ago, Adobe's answer in minutes (null: none
 * yet), who of them]`. ACME's and Hooli's go into one of their channels.
 */
const THREADS = [
  ['piedpiper', 'Preview environments for the redesign', 170, 35, 0],
  ['piedpiper', 'Access for two new developers', 150, 240, 2],
  ['piedpiper', 'Block library for a new customer', 120, 18, 0],
  ['piedpiper', 'Sitemap for a multi-region site', 90, 600, 1],
  ['piedpiper', 'Redirects after a repository move', 40, 55, 0],
  ['piedpiper', 'Font loading on the new header', 12, 25, 1],
  ['piedpiper', 'Stale code after the repository move', 1, null, 0],
  ['acme', 'Launch checklist for the new storefront', 160, 20, 0],
  ['acme', 'Image renditions are cropped', 110, 75, 1],
  ['acme', 'Search index misses the product pages', 70, 300, 1],
  ['acme', 'Cache purge after a release', 30, 12, 0],
  ['acme', 'Forms submit twice on mobile', 2, null, 1],
  ['hooli', 'Content migration from the old CMS', 140, 45, 2],
  ['hooli', 'Header navigation is slow', 60, 160, 0],
  ['hooli', 'Preview shows the old fonts', 3, null, 2],
];

/** Adobe's people who answer (dev-ui-team.mjs has their accounts). */
const OURS = [1, 31, 41];

/** Pied Piper's half year, into the admin pages' in-memory D1, after `seedPartnerPairs`. */
export function seedPartnerProfile(DB, now = Date.now()) {
  const db = DB.sqlite;
  const at = (ms) => new Date(Math.min(ms, now - MIN)).toISOString();
  const own = db.prepare(`SELECT source, tenant, channel_id, team, channel_name AS name FROM threads
    WHERE org = 'piedpiper' AND kind = 'channel' LIMIT 1`).get();
  const channelOf = (org) => (org === 'piedpiper' ? own : db.prepare(`SELECT source, tenant, channel_id,
      team, MAX(channel_name) AS name FROM threads WHERE org = ? AND kind = 'channel'
    GROUP BY source, tenant, channel_id, team ORDER BY COUNT(*) DESC LIMIT 1`).get(org));
  if (!own) {
    return;
  }
  for (const p of PEOPLE) {
    const who = db.prepare('SELECT name, email FROM identities WHERE user_id = ?').get(p.user);
    db.prepare('INSERT OR IGNORE INTO people (id, email, name, staff) VALUES (?, ?, ?, 0)').run(p.id, who.email, who.name);
    db.prepare('UPDATE identities SET person = ?, avatar = ?, title = ? WHERE user_id = ?')
      .run(p.id, p.avatar, p.title, p.user);
  }
  const thread = db.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      kind, channel_name, title, path, root_at, last_at, any_at, last_staff, messages, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'channel', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const message = db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person,
      staff, counted, deleted, author_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`);
  const label = db.prepare(`INSERT OR REPLACE INTO labels (thread, next_actor, kind, urgency, resolved_p,
      labeled_through, model, labeled_at, title) VALUES (?, ?, 'question', ?, 0.1, ?, 'clef', ?, ?)`);
  THREADS.forEach(([org, title, daysAgo, answer, asker], i) => {
    const c = channelOf(org);
    if (!c) {
      return;
    }
    const root = `pp-h${i}`;
    const key = `${c.source}:${c.tenant}:${c.channel_id}:${root}`;
    const start = now - daysAgo * DAY - 3 * 3600000;
    const p = PEOPLE[asker];
    const posts = [[p, 0, start]];
    if (answer !== null) {
      posts.push([OURS[i % OURS.length], 1, start + answer * MIN]);
      posts.push([p, 0, start + (answer + 30) * MIN]);
      posts.push([OURS[i % OURS.length], 1, start + (answer + 90) * MIN]);
    }
    const last = posts[posts.length - 1];
    thread.run(
      key,
      c.source,
      c.tenant,
      c.channel_id,
      root,
      org,
      c.team,
      c.name,
      title,
      `channels/${org}/${c.team}/${c.source}-${c.channel_id}/${root}/`,
      at(start),
      at(last[2]),
      at(last[2]),
      last[1],
      posts.length,
      at(last[2]),
    );
    posts.forEach(([who, staff, when], n) => {
      const id = staff ? who : who.id;
      const author = staff ? `slack:T-FAKE:TP-${who}` : `slack:T-FAKE:${who.user}`;
      message.run(c.source, c.tenant, c.channel_id, `${root}-${n}`, key, at(when), id, staff, author);
    });
    label.run(
      key,
      answer === null ? 'us' : 'customer',
      answer === null && org !== 'piedpiper' ? 0.8 : 0.3,
      at(last[2]),
      at(last[2]),
      title,
    );
  });
  // Hooli's own people answer in its threads: its usual mail domain stays its own.
  db.prepare(`INSERT OR IGNORE INTO identities (source, tenant, user_id, kind, name, email, fetched_at)
    VALUES ('slack', 'T-FAKE', 'U-HOOLI1', 'person', 'Gavin B.', 'gavin@hooli.example', ?)`).run(at(now));
  for (const t of db.prepare('SELECT thread, source, tenant, channel_id, root_at FROM threads WHERE org = \'hooli\'').all()) {
    message.run(t.source, t.tenant, t.channel_id, `${t.thread}-hooli`, t.thread, at(Date.parse(t.root_at) + 5 * MIN), null, 0, 'slack:T-FAKE:U-HOOLI1');
  }
  // What links them (src/orgpartners.js): likely ACME's, as Clef says; Hooli's, confirmed.
  const signals = (posters, people, more) => JSON.stringify([{
    kind: 'posters', weight: 3, n: posters, people, text: '',
  }, {
    kind: more, weight: 2, n: 1, text: '',
  }]);
  db.prepare(`INSERT OR REPLACE INTO org_partners (customer, partner, score, signals, signals_at, p,
      checked_at) VALUES ('acme', 'piedpiper', 5.5, ?, ?, 0.92, ?)`).run(signals(9, 2, 'owners'), at(now), at(now));
  db.prepare(`INSERT OR REPLACE INTO org_partners (customer, partner, score, signals, signals_at, p,
      checked_at, confirmed_by, confirmed_at) VALUES ('hooli', 'piedpiper', 3, ?, ?, 0.81, ?,
      'priya@example.com', ?)`).run(signals(4, 2, 'members'), at(now), at(now), at(now - 20 * DAY));
}
