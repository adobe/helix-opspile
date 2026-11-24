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
 * A customer's overview (src/orgprofile.js) for `npm run ui:dev`: half a year of made-up threads
 * of ACME, after Platform ops' (dev-ui-team.mjs). Its people (Sam, four more, and Ravi of a
 * partner) start most of them, each about their own areas and technologies, and Adobe's people
 * of three teams answer, some at once and some a day later; a few threads Adobe starts. Their
 * pictures and titles too, and the partner's domain. Made up.
 */

const WEEKS = 26;
const DAY = 86400000;
const MIN = 60000;

/** A made-up face (scripts/dev-ui.mjs FACE), its shirt in `shirt`. */
const face = (shirt, skin = '#f1d3b8', back = '#8fb8de') => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${back}"/><circle cx="32" cy="25" r="12" fill="${skin}"/><path d="M10 64c2-14 11-21 22-21s20 7 22 21z" fill="${shirt}"/></svg>`)}`;

/**
 * ACME's people: Sam and Ravi (the fixtures'), and four who post here only. `weight` is how
 * many of the threads they start, `areas` and `tech` what about, most first.
 */
const THEIRS = [
  {
    id: 5, avatar: face('#7d3535', '#e8c4a0', '#dec6b8'), title: 'Web lead', weight: 5, areas: ['project', 'domains', 'cdn'], tech: ['fastly', 'eds'],
  },
  {
    id: 51, name: 'Jordan Pike', email: 'jordan@acme.example', avatar: face('#35577d', '#c99a76'), title: 'Head of e-commerce', weight: 3, areas: ['urls', 'errors'], tech: ['commerce', 'erp'],
  },
  {
    id: 52, name: 'Elena Marsh', email: 'elena@acme.example', avatar: null, title: 'Content lead', weight: 3, areas: ['authoring', 'publishing'], tech: ['da', 'sharepoint', 'ue'],
  },
  {
    id: 53, name: 'Victor Hale', email: 'victor@acme.example', avatar: face('#357d4f', '#8d5524', '#b8dec6'), title: 'DevOps engineer', weight: 2, areas: ['code', 'cdn', 'performance'], tech: ['github', 'akamai'],
  },
  {
    id: 54, name: 'Amara Osei', email: 'amara@acme.example', avatar: face('#4f357d', '#a56b46', '#d7b8de'), title: 'Marketing technologist', weight: 1, areas: ['seo', 'performance'], tech: ['rum', 'analytics'],
  },
  {
    id: 8, avatar: null, title: 'Solution architect', weight: 2, areas: ['frontend', 'code'], tech: ['eds', 'github'],
  },
];

/** Adobe's people who answer ACME (dev-ui-team.mjs has their accounts), `weight` how often. */
const OURS = [
  { id: 1, weight: 5 },
  { id: 31, weight: 3 },
  { id: 41, weight: 3 },
  { id: 2, weight: 2 },
  { id: 42, weight: 1 },
];

/** A random number of the seed, the same on every start (the preview's screenshots stay put). */
function random(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % (2 ** 32);
    return s / 2 ** 32;
  };
}

/** ACME's half year, into the admin pages' in-memory D1 (`DB.sqlite`), after `seedTeamProfile`. */
export function seedCustomerProfile(DB, now = Date.now()) {
  const db = DB.sqlite;
  const rnd = random(11);
  const at = (ms) => new Date(Math.min(ms, now - MIN)).toISOString();
  const weighted = (list) => {
    const all = list.reduce((s, x) => s + x.weight, 0);
    let r = rnd() * all;
    return list.find((x) => {
      r -= x.weight;
      return r < 0;
    }) || list[0];
  };
  const pick = (list) => list[Math.min(list.length - 1, Math.floor(rnd() ** 1.4 * list.length))];
  // Its channels, and the team each is filed under.
  const channels = db.prepare(`SELECT source, tenant, channel_id, team, MAX(channel_name) AS name
    FROM threads WHERE org = 'acme' AND kind = 'channel'
    GROUP BY source, tenant, channel_id, team`).all();
  if (!channels.length) {
    return;
  }
  db.prepare('INSERT OR IGNORE INTO partner_domains (domain, name) VALUES (\'agency.example\', \'Agency Co\')').run();
  const identity = db.prepare(`INSERT OR REPLACE INTO identities (source, tenant, user_id, kind, name,
      email, person, fetched_at, avatar, title) VALUES ('slack', 'T-FAKE', ?, 'person', ?, ?, ?, ?, ?, ?)`);
  for (const p of THEIRS) {
    if (p.name) {
      db.prepare('INSERT OR IGNORE INTO people (id, email, name, staff) VALUES (?, ?, ?, 0)').run(p.id, p.email, p.name);
    }
    const who = db.prepare('SELECT name, email FROM people WHERE id = ?').get(p.id);
    identity.run(`TP-${p.id}`, who.name, who.email, p.id, at(now), p.avatar, p.title);
  }
  const thread = db.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      kind, channel_name, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, ?, ?, ?, ?, 'acme', ?, 'channel', ?, ?, ?, ?, ?, ?, ?)`);
  const message = db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person,
      staff, counted, deleted, author_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`);
  const area = db.prepare('INSERT OR IGNORE INTO thread_areas (thread, area, p) VALUES (?, ?, 0.8)');
  const tech = db.prepare('INSERT OR IGNORE INTO thread_tech (thread, tech, p) VALUES (?, ?, 0.9)');
  // More of them lately: the launch is coming.
  const COUNT = 90;
  for (let k = 0; k < COUNT; k += 1) {
    const w = Math.floor(WEEKS * Math.sqrt(rnd()));
    const weeksAgo = WEEKS - 1 - Math.min(w, WEEKS - 1);
    const start = now - weeksAgo * 7 * DAY - Math.floor(rnd() * 7 * DAY);
    const c = channels[Math.floor(rnd() ** 2 * channels.length)];
    const root = `cp-${k}`;
    const key = `${c.source}:${c.tenant}:${c.channel_id}:${root}`;
    const asker = weighted(THEIRS);
    const ours = weighted(OURS);
    const byUs = rnd() < 0.15;
    // Adobe's first answer: minutes in a live hour, else hours, now and then the next day.
    const r = rnd();
    let answer = (900 + rnd() * 1500) * MIN;
    if (r < 0.4) {
      answer = (5 + rnd() * 40) * MIN;
    } else if (r < 0.85) {
      answer = (60 + rnd() * 300) * MIN;
    }
    const posts = [[byUs ? ours.id : asker.id, byUs ? 1 : 0, 0]];
    let t = byUs ? 0 : answer;
    if (byUs) {
      posts.push([asker.id, 0, (30 + rnd() * 200) * MIN]);
    } else {
      posts.push([ours.id, 1, t]);
    }
    for (let n = Math.floor(rnd() * 6); n > 0; n -= 1) {
      t += (10 + rnd() * 240) * MIN;
      const staff = rnd() < 0.5;
      const theirs = rnd() < 0.7 ? asker.id : weighted(THEIRS).id;
      posts.push([staff ? weighted(OURS).id : theirs, staff ? 1 : 0, t]);
    }
    const last = start + Math.max(...posts.map((p) => p[2]));
    if (start < now - MIN) {
      const path = `channels/acme/${c.team}/${c.source}-${c.channel_id}/${root}/`;
      const was = at(last);
      thread.run(
        key,
        c.source,
        c.tenant,
        c.channel_id,
        root,
        c.team,
        c.name,
        path,
        at(start),
        was,
        was,
        posts.length,
        was,
      );
      posts.forEach(([id, staff, after], i) => {
        message.run(c.source, c.tenant, c.channel_id, `${root}-${i}`, key, at(start + after), id, staff, `slack:T-FAKE:TP-${id}`);
      });
      area.run(key, pick(asker.areas));
      if (rnd() < 0.4) {
        area.run(key, pick(THEIRS[Math.floor(rnd() * THEIRS.length)].areas));
      }
      tech.run(key, pick(asker.tech));
    }
  }
}
