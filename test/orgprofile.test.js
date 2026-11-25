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

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { api } from '../src/api.js';
import {
  contactOf, median, orgNumbers, orgProfile, resetOrgProfiles, stacked, WEEKS,
} from '../src/orgprofile.js';
import { d1 } from './d1.js';

// Made-up people, teams, customers and channels only.
const NOW = new Date('2026-11-25T12:00:00Z');
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada Ops', staff: 1, teams: ['edge'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo Builder', staff: 1, teams: ['edge', 'forms'],
};
const DEE = {
  id: 4, email: 'dee@staff.example', name: 'Dee Helper', staff: 1, teams: ['forms'],
};
const SAM = {
  id: 5, email: 'sam@acme.example', name: 'Sam Reyes', staff: 0,
};
const KIM = {
  id: 6, email: 'kim@acme.example', name: 'Kim Lee', staff: 0,
};
const PAT = {
  id: 7, email: 'pat@agency.example', name: 'Pat Partner', staff: 0,
};
const as = (p, role = 'member') => ({ ...p, teams: p.teams.map((slug) => ({ slug, role })) });

const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const hour = (n) => new Date(NOW.getTime() - n * 3600000).toISOString();

function seed() {
  const DB = d1({
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'edge', name: 'Edge ops' }, { slug: 'forms', name: 'Forms ops' }],
    people: [ADA, BO, DEE, SAM, KIM, PAT],
  });
  const db = DB.sqlite;
  const identity = db.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, person,
    fetched_at, avatar, title, email) VALUES ('slack', 'T', ?, ?, ?, ?, ?, ?, ?, ?)`);
  identity.run('U1', 'person', 'Ada Ops', 1, day(0), 'https://img.example/ada.png', 'Engineer', null);
  identity.run('U2', 'person', 'Bo Builder', 2, day(0), null, null, null);
  identity.run('U4', 'person', 'Dee Helper', 4, day(0), null, 'Forms lead', null);
  identity.run('U5', 'person', 'Sam Reyes', 5, day(0), 'https://img.example/sam.png', 'Web lead', null);
  // Kim posts from two accounts: one person.
  identity.run('U6', 'person', 'Kim Lee', 6, day(0), null, null, null);
  identity.run('U6b', 'person', 'Kim', 6, day(0), null, null, null);
  identity.run('U7', 'person', 'Pat Partner', 7, day(0), null, null, null);
  identity.run('W1', 'bot', 'Requests workflow', null, day(0), null, null, null);
  db.exec(`DELETE FROM orgs; INSERT INTO orgs (slug, name, type, icon, updated_at) VALUES
    ('acme', 'ACME Corp', 'customer', 'acme.example', '${day(0)}'),
    ('globex', 'Globex', 'customer', NULL, '${day(0)}');
    INSERT INTO org_merges (slug, into_slug, merged_at) VALUES ('acme-co', 'acme', '${day(5)}');
    INSERT INTO partner_domains (domain, name) VALUES ('agency.example', 'The Agency');
    INSERT INTO channels (source, tenant, channel_id, name, fetched_at) VALUES
      ('slack', 'T', 'C1', 'aem-acme', '${day(0)}'), ('slack', 'T', 'C2', 'forms-acme', '${day(0)}');
    INSERT INTO channel_teams (source, channel_id, team, added_at) VALUES ('slack', 'C1', 'forms', '${day(9)}');
    INSERT INTO rules (target, priority, field, pattern, value) VALUES ('follow', 100, 'org', '^acme$', 'forms')`);
  const thread = db.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org,
    team, kind, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, 'slack', 'T', ?, ?, ?, ?, 'channel', 'p/', ?, ?, ?, 1, ?)`);
  const threads = [
    ['t:a1', 'C1', 'acme', 'edge', 10],
    ['t:a2', 'C1', 'acme', 'edge', 3],
    ['t:a3', 'C2', 'acme', 'forms', 2],
    ['t:g1', 'C9', 'globex', 'edge', 2],
    ['t:old', 'C1', 'acme', 'edge', 400],
  ];
  for (const [key, ch, org, team, ago] of threads) {
    thread.run(key, ch, key, org, team, day(ago), day(ago), day(ago), day(ago));
  }
  const msg = db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person,
    staff, counted, deleted, author_key) VALUES ('slack', 'T', ?, ?, ?, ?, ?, ?, 1, 0, ?)`);
  let n = 0;
  const post = (key, who, at, staff, user = `U${who}`) => {
    const ch = threads.find((t) => t[0] === key)[1];
    n += 1;
    msg.run(ch, `m${n}`, key, at, who, staff, `slack:T:${user}`);
  };
  // Sam starts a1; Ada answers two hours later. Kim starts a2; Bo answers in half an hour.
  // Ada starts a3, Pat (a partner) answers. Nobody of Adobe yet answers a thread Sam started
  // too long ago to count.
  post('t:a1', 5, hour(240), 0);
  post('t:a1', 5, hour(239), 0);
  post('t:a1', 1, hour(238), 1);
  post('t:a1', 1, hour(237), 1);
  post('t:a1', 6, hour(236), 0);
  post('t:a2', 6, hour(72), 0, 'U6b');
  post('t:a2', 2, hour(71.5), 1);
  post('t:a2', 5, hour(71), 0);
  post('t:a3', 1, hour(48), 1);
  post('t:a3', 7, hour(47), 0);
  post('t:a3', 4, hour(46), 1);
  post('t:a3', null, hour(45), 1, 'W1');
  post('t:g1', 1, hour(40), 1);
  post('t:old', 5, day(400), 0);
  db.exec(`INSERT INTO thread_areas (thread, area, p) VALUES ('t:a1', 'cdn', 0.9), ('t:a2', 'cdn', 0.8),
      ('t:a3', 'authoring', 0.9);
    INSERT INTO thread_tech (thread, tech, p) VALUES ('t:a1', 'fastly', 0.9), ('t:a2', 'fastly', 0.9),
      ('t:a3', 'forms', 0.9);
    DELETE FROM tech_stack; DELETE FROM areas;
    INSERT INTO areas (team, id, name, what, path) VALUES ('admin', 'cdn', 'Caching and delivery', 'x', 'areas/cdn.md'),
      ('admin', 'authoring', 'Authoring and content', 'x', 'areas/authoring.md');
    INSERT INTO tech_stack (team, tech, name, description, layer, vendor, kind, path) VALUES
      ('admin', 'fastly', 'Fastly', 'x', 'edge', 'Fastly', 'Product', 'products/fastly.md'),
      ('admin', 'forms', 'Forms', 'x', 'site', 'Adobe', 'Product', 'products/adobe/forms.md'),
      ('admin', 'commerce', 'Commerce', 'x', 'commerce', 'Adobe', 'Product', 'products/adobe/commerce.md');
    INSERT INTO org_stacks (org, parts, updated_at) VALUES ('acme',
      '[{"name":"Commerce","tech":"commerce","layer":"commerce"},{"name":"Their ERP","tech":null,"layer":"commerce"}]', '${day(1)}');
    INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at, entries)
      VALUES ('kb-org-acme', 'org', 'acme', 'r', '${day(90)}', 4);
    INSERT INTO kb_concepts (repo, path, hash, type, title, description, aliases) VALUES
      ('kb-org-acme', 'sites/www.md', 'h1', 'Site', 'www', 'The main website', NULL),
      ('kb-org-acme', 'contacts/sam-reyes.md', 'h2', 'Contact', 'Sam Reyes', 'Web lead', 'sreyes'),
      ('kb-org-acme', 'contacts/kimberly-lee.md', 'h3', 'Contact', 'Kimberly Lee', NULL, 'Kim Lee'),
      ('kb-org-acme', 'stack.md', 'h4', 'Stack Drawing', 'What they run', NULL, NULL)`);
  return { DB, STAFF_DOMAINS: 'staff.example' };
}

async function call(e, me, path) {
  const url = new URL(`https://opspile.example${path}`);
  const res = await api(new Request(url), e, url, { viewer: me });
  return { status: res.status, body: await res.json() };
}

const sum = (list) => list.reduce((a, v) => a + v, 0);

describe('a customer\'s overview', () => {
  beforeEach(() => resetOrgProfiles());

  it('has its threads week by week, and how soon Adobe answers them', async () => {
    const p = await orgNumbers(seed(), 'acme', { now: NOW });
    assert.equal(p.weeks.length, WEEKS);
    assert.deepEqual(p.org, {
      slug: 'acme', name: 'ACME Corp', type: 'customer', icon: 'acme.example', domain: null, channels: 2,
    });
    // Its three threads of the window: not Globex's, nor the old one.
    assert.equal(p.threadCount, 3);
    assert.equal(sum(p.activity.messages), 12);
    assert.equal(sum(p.activity.staff), 6);
    // a1 and a2 were started by its people, answered in 2 h and in 30 min; a3 by Adobe.
    assert.deepEqual(p.answers, {
      by: 'adobe', asked: 2, answered: 2, median: 75,
    });
  });

  it('has its people, Adobe\'s and the teams that work it', async () => {
    const p = await orgNumbers(seed(), 'acme', { now: NOW });
    // Its people, the busiest first: Kim's two accounts as one; the partner's marked.
    assert.deepEqual(p.people.map((x) => [x.id, x.name, x.messages, x.threads, x.partner]), [
      [5, 'Sam Reyes', 3, 2, null],
      [6, 'Kim Lee', 2, 2, null],
      [7, 'Pat Partner', 1, 1, 'The Agency'],
    ]);
    assert.equal(p.peopleCount, 3);
    assert.equal(p.partnerCount, 1);
    const [sam, kim] = p.people;
    assert.equal(sam.avatar, 'https://img.example/sam.png');
    assert.equal(sam.title, 'Web lead');
    assert.deepEqual(sam.areas.map((a) => a.name), ['Caching and delivery']);
    assert.deepEqual(sam.tech.map((t) => t.name), ['Fastly']);
    // Their Contacts: by file name, and by an alias.
    assert.deepEqual(sam.profile, { path: 'contacts/sam-reyes.md', description: 'Web lead' });
    assert.deepEqual(kim.profile, { path: 'contacts/kimberly-lee.md', description: null });
    // Adobe's people, no workflow, with their teams.
    const teams = (x) => x.teams.map((t) => t.slug);
    assert.deepEqual(p.staff.map((x) => [x.id, x.name, x.messages, teams(x)]), [
      [1, 'Ada Ops', 3, ['edge']],
      [2, 'Bo Builder', 1, ['edge', 'forms']],
      [4, 'Dee Helper', 1, ['forms']],
    ]);
    assert.equal(p.staffCount, 3);
    // The teams: Edge ops' people posted the most, and has a channel; Forms ops has one, has
    // the other shared, and follows the customer.
    const team = (t) => [t.slug, t.messages, t.people, t.filed, t.shared, t.follows];
    assert.deepEqual(p.teams.map(team), [
      ['edge', 4, 2, 1, 0, false],
      ['forms', 2, 2, 1, 1, true],
    ]);
  });

  it('counts a customer\'s accounts of one mail address as one of them', async () => {
    const e = seed();
    const db = e.DB.sqlite;
    db.exec(`INSERT INTO identities (source, tenant, user_id, kind, name, person, fetched_at, email,
        guest) VALUES
      ('slack', 'T', 'G9', 'person', 'Lu Wen', NULL, '${day(0)}', 'Lu.Wen@acme.example', 1),
      ('slack', 'T', 'H9', 'person', 'Lu', NULL, '${day(0)}', 'lu.wen@acme.example', 0),
      ('slack', 'T', 'J9', 'person', 'Jo Other', NULL, '${day(0)}', NULL, 0)`);
    const msg = db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at,
      person, staff, counted, deleted, author_key) VALUES ('slack', 'T', 'C1', ?, ?, ?, NULL, 0,
      1, 0, ?)`);
    msg.run('lu1', 't:a1', hour(230), 'slack:T:H9');
    msg.run('lu2', 't:a2', hour(70), 'slack:T:G9');
    msg.run('lu3', 't:a2', hour(69), 'slack:T:G9');
    msg.run('lu4', 't:a2', hour(68), 'slack:T:H9');
    msg.run('jo1', 't:a1', hour(229), 'slack:T:J9');
    const p = await orgNumbers(e, 'acme', { now: NOW });
    assert.deepEqual(p.people.map((x) => [x.id, x.name, x.messages, x.threads]), [
      [null, 'Lu Wen', 4, 2],
      [5, 'Sam Reyes', 3, 2],
      [6, 'Kim Lee', 2, 2],
      [null, 'Jo Other', 1, 1],
      [7, 'Pat Partner', 1, 1],
    ]);
    assert.equal(p.peopleCount, 5);
    assert.deepEqual(p.people[0].areas.map((a) => a.name), ['Caching and delivery']);
    const lu = p.breakdowns.people.find((x) => x.name === 'Lu Wen');
    assert.deepEqual([lu.id, lu.n], ['a:slack:T:G9', 4]);
    assert.ok(!JSON.stringify(p).toLowerCase().includes('lu.wen@'));
  });

  it('has what its threads are about, its channels and its technologies', async () => {
    const p = await orgNumbers(seed(), 'acme', { now: NOW });
    assert.deepEqual(p.areas.map((a) => [a.id, a.name, a.threads, sum(a.weekly)]), [
      ['cdn', 'Caching and delivery', 2, 8],
      ['authoring', 'Authoring and content', 1, 4],
    ]);
    assert.deepEqual(p.channels.map((c) => [c.name, c.team, c.shared, c.threads, c.messages]), [
      ['aem-acme', 'edge', ['forms'], 2, 8],
      ['forms-acme', 'forms', [], 1, 4],
    ]);
    // Clef's, and its drawing's: one Clef has a technology for, one by its name.
    assert.deepEqual(p.tech.map((t) => [t.tech, t.name, t.layer, t.stack, t.threads]), [
      ['fastly', 'Fastly', 'edge', false, 2],
      ['forms', 'Forms', 'site', false, 1],
      ['commerce', 'Commerce', 'commerce', true, 0],
      [null, 'Their ERP', 'commerce', true, 0],
    ]);
    assert.deepEqual(p.kb.types.map((t) => [t.type, t.n]), [['Contact', 2], ['Site', 1]]);
    assert.equal(p.kb.drawing, true);
  });

  it('is everyone\'s at Adobe; its knowledge base is for the teams that work it', async () => {
    const e = seed();
    const outsider = {
      id: 9, email: 'x@partner.example', name: 'X', teams: [],
    };
    assert.equal((await call(e, outsider, '/api/customers/profile?org=acme')).status, 403);
    assert.equal((await call(e, outsider, '/api/customers')).status, 403);
    const staff = { ...outsider, email: 'x@staff.example' };
    let r = await call(e, staff, '/api/customers');
    assert.deepEqual(r.body.orgs.map((o) => [o.slug, o.channels]), [['acme', 2], ['globex', 1]]);
    r = await call(e, staff, '/api/customers/profile?org=acme');
    assert.equal(r.status, 200);
    assert.equal(r.body.people.length, 3);
    assert.equal(r.body.people[0].profile, null);
    assert.deepEqual(r.body.kb.types, [{ type: 'Contact', n: 2, entries: [] }, { type: 'Site', n: 1, entries: [] }]);
    assert.equal(r.body.kb.readable, false);
    assert.equal(r.body.kb.drawing, false);
    // Without the drawing's parts: what Clef sees only.
    assert.deepEqual(r.body.tech.map((t) => t.tech), ['fastly', 'forms']);
    assert.deepEqual(r.body.may, { read: false });
    // A member of a team it has a channel of reads it all.
    r = await call(e, as(DEE), '/api/customers/profile?org=acme');
    assert.equal(r.body.kb.readable, true);
    assert.equal(r.body.people[0].profile.path, 'contacts/sam-reyes.md');
    assert.equal(r.body.tech.length, 4);
    // A merged one says where it went.
    r = await call(e, staff, '/api/customers/profile?org=acme-co');
    assert.deepEqual([r.status, r.body.mergedInto], [404, 'acme']);
    assert.equal((await call(e, staff, '/api/customers/profile?org=nope')).status, 404);
    assert.equal((await call(e, staff, '/api/customers/profile?org=_unassigned')).status, 404);
  });

  it('keeps a customer\'s numbers a while', async () => {
    const e = seed();
    const first = await orgProfile(e, as(ADA), 'acme', { now: NOW });
    e.DB.sqlite.exec('DELETE FROM messages');
    const kept = await orgProfile(e, as(ADA), 'acme', { now: new Date(NOW.getTime() + 60000) });
    assert.equal(kept.people[0].messages, first.people[0].messages);
    const later = await orgProfile(e, as(ADA), 'acme', { now: new Date(NOW.getTime() + 3600000) });
    assert.equal(later.people.length, 0);
  });
});

describe('the helpers of a customer\'s overview', () => {
  it('finds the middle, and a person\'s Contact', () => {
    assert.equal(median([]), null);
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    const contacts = [{ path: 'contacts/sam-reyes.md', title: 'Sam Reyes', aliases: 'sreyes, Sammy' }];
    const sam = { path: 'contacts/sam-reyes.md', description: null };
    assert.deepEqual(contactOf(contacts, 'Sam Reyes'), sam);
    assert.deepEqual(contactOf(contacts, 'Sammy'), sam);
    assert.deepEqual(contactOf(contacts, 'Reyes, Sam'), sam);
    assert.equal(contactOf(contacts, 'Someone Else'), null);
  });
});

describe('the chart of a customer\'s overview', () => {
  it('breaks its weeks down, a thread in one part of each breakdown', async () => {
    const p = await orgNumbers(seed(), 'acme', { now: NOW });
    const of = (id) => p.breakdowns[id].map((x) => [x.id, x.name, x.n]);
    // Who said it: their people (Sam, Kim), the partner's, Adobe's; no workflow.
    assert.deepEqual(of('who'), [['theirs', 'Their people', 5], ['partners', 'Partners', 1],
      ['adobe', 'Adobe', 5]]);
    assert.deepEqual(of('people'), [['p:5', 'Sam Reyes', 3], ['p:6', 'Kim Lee', 2],
      ['p:7', 'Pat Partner', 1]]);
    assert.deepEqual(of('teams'), [['edge', 'Edge ops', 8], ['forms', 'Forms ops', 4]]);
    assert.deepEqual(of('areas'), [['cdn', 'Caching and delivery', 8],
      ['authoring', 'Authoring and content', 4]]);
    assert.deepEqual(of('tech').map(([id, , n]) => [id, n]), [['fastly', 8], ['forms', 4]]);
    assert.deepEqual(of('channels').map(([, name, n]) => [name, n]), [['#aem-acme', 8],
      ['#forms-acme', 4]]);
    const total = (id) => p.breakdowns[id].reduce((s, x) => s + x.n, 0);
    assert.equal(total('teams'), 12);
    assert.equal(p.breakdowns.teams[0].weekly.length, WEEKS);
  });

  it('keeps the biggest parts, and the rest as one', () => {
    const weeks = ['2026-11-16', '2026-11-23'];
    const rows = ['a', 'b', 'c', 'd', null].map((part, i) => ({ week: weeks[i % 2], n: 10 - i, part }));
    const out = stacked(rows, weeks, (k) => k.toUpperCase(), { most: 2, rest: 'Others' });
    assert.deepEqual(out.map((x) => [x.id, x.name, x.n, x.weekly]), [
      ['a', 'A', 10, [10, 0]], ['b', 'B', 9, [0, 9]], [null, 'Others', 21, [14, 7]],
    ]);
    // One more part than it keeps is shown as it is; fixed parts in their order.
    assert.equal(stacked(rows.slice(0, 3), weeks, (k) => k, { most: 2 }).length, 3);
    assert.deepEqual(stacked(rows.slice(0, 2), weeks, (k) => k, { fixed: ['b', 'a', 'z'] })
      .map((x) => x.id), ['b', 'a']);
  });
});
