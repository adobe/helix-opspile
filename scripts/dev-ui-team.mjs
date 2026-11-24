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
 * A team's overview (src/teamprofile.js) for `npm run ui:dev`: half a year of made-up posts in
 * Platform ops' threads, by its members (each with their own customers, areas and technologies),
 * by the customers' people, and by Adobe's people on other teams or none, its collaborators;
 * their pictures and titles, Clef's areas and technologies of the threads, and what Platform ops
 * follows. Two people join Platform ops: one who posts, and one who has not yet. Made up.
 */

const WEEKS = 26;
const DAY = 86400000;

/** A made-up face (scripts/dev-ui.mjs FACE), its shirt in `shirt`. */
const face = (shirt, skin = '#f1d3b8', back = '#8fb8de') => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${back}"/><circle cx="32" cy="25" r="12" fill="${skin}"/><path d="M10 64c2-14 11-21 22-21s20 7 22 21z" fill="${shirt}"/></svg>`)}`;

/**
 * Adobe's people of the overview: Platform ops' members (1 to 4, from the fixtures, and two who
 * join), and the collaborators. `weekly` is how many messages a week, `shape(w)` how that changes
 * over the weeks; `orgs`, `areas` and `tech` what their threads are about, most first.
 */
const STAFF = [
  {
    id: 1,
    avatar: face('#35577d'),
    title: 'Site reliability engineer',
    weekly: 14,
    shape: (w) => 0.6 + w / WEEKS,
    orgs: ['acme', 'globex', 'umbrella'],
    areas: ['cdn', 'domains', 'performance'],
    tech: ['fastly', 'akamai', 'eds'],
  },
  {
    id: 2,
    avatar: null,
    title: 'Support engineer',
    weekly: 9,
    shape: () => 1,
    orgs: ['globex', 'initech'],
    areas: ['auth', 'authoring', 'publishing', 'security'],
    tech: ['sso', 'da', 'sharepoint'],
  },
  {
    id: 3,
    avatar: face('#357d4f', '#c99a76'),
    title: 'Solutions consultant',
    weekly: 6,
    shape: (w) => (w > 16 ? 1.8 : 0.5),
    orgs: ['initech', 'acme'],
    areas: ['project', 'code', 'frontend'],
    tech: ['github', 'eds', 'ue'],
  },
  {
    id: 4,
    avatar: face('#7d6a35', '#8d5524'),
    title: 'Commerce architect',
    weekly: 4,
    shape: (w) => (w < 20 ? 1.3 : 0.2),
    orgs: ['umbrella', 'globex'],
    areas: ['urls', 'errors', 'limits'],
    tech: ['commerce', 'erp', 'feeds'],
  },
  {
    id: 31,
    name: 'Aiko Tanaka',
    email: 'aiko@example.com',
    avatar: face('#7d3557', '#e8c4a0', '#d7b8de'),
    title: 'Frontend engineer',
    weekly: 7,
    shape: (w) => (w > 8 ? 1.2 : 0),
    member: 'platform',
    orgs: ['acme', 'initech'],
    areas: ['frontend', 'performance', 'seo'],
    tech: ['eds', 'rum', 'cloudflare'],
  },
  {
    id: 32,
    name: 'Marcus Bell',
    email: 'marcus@example.com',
    avatar: null,
    title: 'Technical account manager',
    weekly: 0,
    shape: () => 0,
    member: 'platform',
    role: 'manager',
    orgs: [],
    areas: [],
    tech: [],
  },
  // The collaborators: on Edge ops, on Forms ops, and on no team.
  {
    id: 41,
    name: 'Noah Fischer',
    email: 'noah@example.com',
    avatar: face('#4f357d', '#f1d3b8', '#b8dec6'),
    title: 'CDN engineer',
    weekly: 5,
    shape: (w) => 0.5 + w / WEEKS,
    team: 'edge',
    orgs: ['acme', 'umbrella'],
    areas: ['cdn'],
    tech: ['fastly'],
  },
  {
    id: 42,
    name: 'Ines Duarte',
    email: 'ines@example.com',
    avatar: null,
    title: 'Forms specialist',
    weekly: 3,
    shape: (w) => (w > 12 ? 1.5 : 0.3),
    team: 'forms',
    orgs: ['globex'],
    areas: ['authoring'],
    tech: ['forms'],
  },
  {
    id: 43,
    name: 'Omar Haddad',
    email: 'omar@example.com',
    avatar: face('#35577d', '#a56b46', '#dec6b8'),
    title: 'Product manager, Edge Delivery',
    weekly: 2,
    shape: () => 1,
    orgs: ['initech', 'acme'],
    areas: ['roadmap'],
    tech: ['eds'],
  },
  {
    id: 44,
    name: 'Grace Liu',
    email: 'grace@example.com',
    avatar: null,
    title: 'Engineering manager',
    weekly: 1,
    shape: (w) => (w % 4 === 0 ? 3 : 0),
    team: 'edge',
    orgs: ['umbrella'],
    areas: ['performance'],
    tech: ['akamai'],
  },
];

/** The customers' people who post in Platform ops' threads (the fixtures'), by org. */
const CUSTOMERS = {
  acme: [5, 8], globex: [6], initech: [7], umbrella: [9],
};

/** A random number of the seed, the same on every start (the preview's screenshots stay put). */
function random(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % (2 ** 32);
    return s / 2 ** 32;
  };
}

/** Platform ops' overview's half year, into the admin pages' in-memory D1 (`DB.sqlite`). */
export function seedTeamProfile(DB, now = Date.now()) {
  const db = DB.sqlite;
  const rnd = random(7);
  const pick = (list) => list[Math.min(list.length - 1, Math.floor(rnd() ** 1.6 * list.length))];
  const at = (ms) => new Date(ms).toISOString();
  const threads = db.prepare(`SELECT thread, source, tenant, channel_id, org FROM threads
    WHERE team = 'platform' AND kind = 'channel' ORDER BY thread`).all();
  const byOrg = new Map();
  for (const t of threads) {
    byOrg.set(t.org, [...(byOrg.get(t.org) || []), t]);
  }
  const identity = db.prepare(`INSERT OR IGNORE INTO identities (source, tenant, user_id, kind, name,
      email, person, fetched_at, avatar, title) VALUES ('slack', 'T-FAKE', ?, 'person', ?, ?, ?, ?, ?, ?)`);
  const message = db.prepare(`INSERT OR IGNORE INTO messages (source, tenant, channel_id, id, thread,
      at, person, staff, counted, deleted, author_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`);
  const area = db.prepare('INSERT OR IGNORE INTO thread_areas (thread, area, p) VALUES (?, ?, ?)');
  const tech = db.prepare('INSERT OR IGNORE INTO thread_tech (thread, tech, p) VALUES (?, ?, ?)');
  let n = 0;
  for (const p of STAFF) {
    if (p.name) {
      db.prepare('INSERT OR IGNORE INTO people (id, email, name, staff) VALUES (?, ?, ?, 1)').run(p.id, p.email, p.name);
    }
    if (p.member) {
      db.prepare('INSERT OR IGNORE INTO team_members (team, person, role) VALUES (?, ?, ?)').run(p.member, p.id, p.role || 'member');
    }
    if (p.team) {
      db.prepare('INSERT OR IGNORE INTO team_members (team, person, role) VALUES (?, ?, \'member\')').run(p.team, p.id);
    }
    const who = db.prepare('SELECT name, email FROM people WHERE id = ?').get(p.id);
    identity.run(`TP-${p.id}`, who.name, who.email, p.id, at(now), p.avatar, p.title);
    const key = `slack:T-FAKE:TP-${p.id}`;
    for (let w = 0; w < WEEKS; w += 1) {
      const count = Math.round(p.weekly * p.shape(w) * (0.4 + rnd() * 1.2));
      for (let k = 0; k < count; k += 1) {
        const list = byOrg.get(pick(p.orgs)) || [];
        if (list.length) {
          const t = list[Math.floor(rnd() * list.length)];
          const when = now - (WEEKS - 1 - w) * 7 * DAY - Math.floor(rnd() * 7 * DAY);
          n += 1;
          message.run(t.source, t.tenant, t.channel_id, `tp-${n}`, t.thread, at(Math.min(when, now - 3600000)), p.id, 1, key);
          // What the thread is about: this person's areas and technologies, most of the time.
          if (rnd() < 0.5) {
            area.run(t.thread, pick(p.areas), 0.8);
          }
          if (rnd() < 0.5) {
            tech.run(t.thread, pick(p.tech), 0.9);
          }
          // And the customer answers, about as often as Adobe writes.
          const theirs = CUSTOMERS[t.org] || [];
          if (theirs.length && rnd() < 0.9) {
            const c = theirs[Math.floor(rnd() * theirs.length)];
            n += 1;
            message.run(t.source, t.tenant, t.channel_id, `tp-${n}`, t.thread, at(Math.min(when + 3600000, now - 60000)), c, 0, `slack:T-FAKE:TP-${c}`);
          }
        }
      }
    }
  }
  for (const ids of Object.values(CUSTOMERS)) {
    for (const id of ids) {
      const who = db.prepare('SELECT name, email FROM people WHERE id = ?').get(id);
      if (who) {
        identity.run(`TP-${id}`, who.name, who.email, id, at(now), null, null);
      }
    }
  }
  // A thread started with its first message.
  db.prepare(`UPDATE threads SET root_at = (SELECT MIN(m.at) FROM messages m WHERE m.thread = threads.thread)
    WHERE team = 'platform' AND (SELECT MIN(m.at) FROM messages m WHERE m.thread = threads.thread) < root_at`).run();
  // Platform ops follows Edge Delivery and Fastly (src/follows.js).
  db.prepare(`INSERT OR IGNORE INTO team_follows (team, tech, added_by, added_at) VALUES
    ('platform', 'eds', 'dana@example.com', ?), ('platform', 'fastly', 'dana@example.com', ?)`).run(at(now - 40 * DAY), at(now - 12 * DAY));
}
