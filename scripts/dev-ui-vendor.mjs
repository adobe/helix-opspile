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
 * A vendor's half year for `npm run ui:dev` (src/vendors.js): Initech, a vendor whose edge
 * network Platform ops uses. Adobe's people open cases in its channel (#initech-support) and
 * Jonas of Initech answers, some at once, some days later; a few wait on Initech, one on Adobe.
 * Its status bot posts maintenance notices there, as alerts. ACME's threads show Initech's edge
 * network, and two of them wait on a third party. And Vandelay, a vendor of translations that
 * Platform ops' customers' threads show, whose channel is not in its inbox: it can follow it.
 * Made up.
 */

const DAY = 86400000;
const HOUR = 3600000;

/** A case: its title, days ago, hours to its answer, who is next, resolved, urgency. */
const CASES = [
  ['Purge leaves stale objects in one region', 1.5, 3, 'vendor', 0.1, 2.2],
  ['Origin timeouts from the Frankfurt edge', 3, 20, 'vendor', 0.15, 1.6],
  ['Logs for the 503s on the preview hosts', 5, 1, 'us', 0.1, 1.2],
  ['TLS certificate for the new apex domain', 9, 30, 'vendor', 0.2, 0.8],
  ['Raise the API rate limit for purges', 16, 52, 'nobody', 0.9, 0.6],
  ['Header size limit on the edge', 24, 6, 'nobody', 0.85, 0.7],
  ['Invoice for the extra bandwidth', 38, 70, 'nobody', 0.8, 0.2],
  ['WAF rule blocks form posts', 47, 2, 'nobody', 0.9, 1.4],
  ['Contract renewal terms', 61, 96, 'nobody', 0.7, 0.3],
  ['Edge config API returns 500', 75, 4, 'nobody', 0.95, 1.8],
  ['New point of presence in Sydney', 102, 12, 'nobody', 0.9, 0.3],
  ['Log streaming to our bucket', 133, 26, 'nobody', 0.9, 0.9],
];

/** The status bot's posts, days ago. */
const STATUS = [
  ['Scheduled maintenance in FRA', 2], ['Degraded performance in IAD', 6], ['Scheduled maintenance in SYD', 13],
  ['Elevated purge latency', 20], ['Scheduled maintenance in LHR', 27], ['Config API degraded', 41],
  ['Scheduled maintenance in NRT', 55], ['Scheduled maintenance in GRU', 69], ['Elevated error rates in ORD', 90],
  ['Scheduled maintenance in AMS', 118], ['Scheduled maintenance in SIN', 150], ['Dashboard login issues', 170],
];

/** Initech's half year, into the admin pages' in-memory D1 (`DB.sqlite`), after the customers'. */
export function seedVendorProfile(DB, now = Date.now()) {
  const db = DB.sqlite;
  const channel = db.prepare(`SELECT source, tenant, channel_id, team, MAX(channel_name) AS name
    FROM threads WHERE org = 'initech' AND kind = 'channel' GROUP BY 1, 2, 3, 4 ORDER BY COUNT(*) DESC`).get();
  if (!channel) {
    return;
  }
  const at = (ms) => new Date(Math.min(ms, now - 60000)).toISOString();
  // Its status bot, which only posts alerts (src/alertbots.js): its threads stay alerts when the
  // channel is filed again.
  db.prepare(`INSERT OR IGNORE INTO identities (source, tenant, user_id, kind, name, fetched_at, ours, alerts)
    VALUES (?, ?, 'B-INITECH-STATUS', 'bot', 'Initech Status', ?, 0, 1)`).run(channel.source, channel.tenant, at(now));
  // Jonas of Initech (the fixtures'), who answers.
  const jonas = db.prepare('SELECT name, email FROM people WHERE id = 7').get();
  if (jonas) {
    db.prepare(`INSERT OR IGNORE INTO identities (source, tenant, user_id, kind, name, email, person,
      fetched_at, title) VALUES ('slack', 'T-FAKE', 'TP-7', 'person', ?, ?, 7, ?, 'Support engineer')`)
      .run(jonas.name, jonas.email, at(now));
  }
  const thread = db.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
      kind, channel_name, title, path, root_at, last_at, any_at, last_staff, messages, updated_at)
    VALUES (?, ?, ?, ?, ?, 'initech', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const message = db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person,
      staff, counted, deleted, author_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`);
  const label = db.prepare(`INSERT OR REPLACE INTO labels (thread, next_actor, kind, urgency, resolved_p,
      labeled_through, model, labeled_at, title) VALUES (?, ?, ?, ?, ?, ?, 'clef', ?, ?)`);
  const path = (root) => `channels/initech/${channel.team}/${channel.source}-${channel.channel_id}/${root}/`;
  // Adobe's people who open them (the fixtures' Dana and Tom, Platform ops' Kai), and Jonas.
  const ours = [1, 4, 31];
  CASES.forEach(([title, daysAgo, answerH, next, resolved, urgency], i) => {
    const root = `vc-${i}`;
    const key = `${channel.source}:${channel.tenant}:${channel.channel_id}:${root}`;
    const start = now - daysAgo * DAY;
    const who = ours[i % ours.length];
    const posts = [[who, 1, start]];
    if (answerH !== null) {
      posts.push([7, 0, start + answerH * HOUR]);
    }
    // Adobe sent what Initech asked for (waits on the vendor again), or Initech asked back.
    if (next === 'vendor' && answerH !== null && answerH < 24) {
      posts.push([who, 1, start + (answerH + 1) * HOUR]);
    }
    const shown = posts.filter((p) => p[2] < now);
    const last = shown[shown.length - 1];
    thread.run(
      key,
      channel.source,
      channel.tenant,
      channel.channel_id,
      root,
      channel.team,
      'channel',
      channel.name,
      title,
      path(root),
      at(start),
      at(last[2]),
      at(last[2]),
      last[1],
      shown.length,
      at(last[2]),
    );
    shown.forEach(([id, staff, when], n) => {
      message.run(channel.source, channel.tenant, channel.channel_id, `${root}-${n}`, key, at(when), id, staff, 1, `slack:T-FAKE:TP-${id}`);
    });
    label.run(key, next, i % 3 ? 'question' : 'incident', urgency, resolved, at(last[2]), at(last[2]), title);
  });
  STATUS.forEach(([title, daysAgo], i) => {
    const root = `vs-${i}`;
    const key = `${channel.source}:${channel.tenant}:${channel.channel_id}:${root}`;
    const when = at(now - daysAgo * DAY);
    thread.run(
      key,
      channel.source,
      channel.tenant,
      channel.channel_id,
      root,
      channel.team,
      'alert',
      channel.name,
      title,
      path(root),
      when,
      null,
      when,
      null,
      1,
      when,
    );
    message.run(channel.source, channel.tenant, channel.channel_id, `${root}-0`, key, when, null, 0, 0, `${channel.source}:${channel.tenant}:B-INITECH-STATUS`);
    label.run(key, null, 'alert', null, null, when, when, title);
  });
  // ACME's threads that show Initech's edge network (Platform ops' catalog has it,
  // dev-ui-kb.mjs): every fifth, two of them waiting on a third party.
  const acme = db.prepare(`SELECT thread, last_at FROM threads WHERE org = 'acme' AND kind = 'channel'
    AND last_at IS NOT NULL ORDER BY last_at DESC`).all();
  const tech = db.prepare('INSERT OR IGNORE INTO thread_tech (thread, tech, p) VALUES (?, \'initech/edge\', 0.9)');
  const third = db.prepare(`INSERT INTO labels (thread, next_actor, kind, urgency, resolved_p, labeled_through,
      model, labeled_at, title) VALUES (?, 'vendor', 'incident', 1.4, 0.1, ?, 'clef', ?, ?)
    ON CONFLICT (thread) DO UPDATE SET next_actor = 'vendor', resolved_p = 0.1,
      title = COALESCE(labels.title, excluded.title)`);
  const titles = ['Images served stale after a deploy', 'Checkout slow from Australia'];
  // Vandelay: no channel of Platform ops', but its customers' threads show its translations.
  db.prepare(`INSERT OR IGNORE INTO orgs (slug, name, type, icon, updated_at)
    VALUES ('vandelay', 'Vandelay Industries', 'vendor', NULL, ?)`).run(at(now));
  // Its channel is Edge ops': a case Edge ops opened there.
  const vKey = 'slack:T-FAKE:C0VANDELAY:vv-0';
  const vAt = at(now - 4 * DAY);
  thread.run(
    vKey,
    'slack',
    'T-FAKE',
    'C0VANDELAY',
    'vv-0',
    'edge',
    'channel',
    'vandelay-adobe',
    'Glossary import drops accents',
    'channels/vandelay/edge/slack-C0VANDELAY/vv-0/',
    vAt,
    vAt,
    vAt,
    1,
    1,
    vAt,
  );
  db.prepare('UPDATE threads SET org = \'vandelay\' WHERE thread = ?').run(vKey);
  message.run('slack', 'T-FAKE', 'C0VANDELAY', 'vv-0-0', vKey, vAt, 41, 1, 1, 'slack:T-FAKE:TP-41');
  label.run(vKey, 'vendor', 'incident', 1, 0.1, vAt, vAt, 'Glossary import drops accents');
  const translated = db.prepare('INSERT OR IGNORE INTO thread_tech (thread, tech, p) VALUES (?, \'vandelay/translate\', 0.9)');
  acme.filter((t, i) => i % 7 === 3).forEach((t) => translated.run(t.thread));
  acme.filter((t, i) => i % 5 === 0).forEach((t, i) => {
    tech.run(t.thread);
    if (i < titles.length) {
      third.run(t.thread, t.last_at, t.last_at, titles[i]);
      db.prepare('UPDATE threads SET last_staff = 1 WHERE thread = ?').run(t.thread);
    }
  });
}
