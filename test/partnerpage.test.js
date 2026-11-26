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
import { orgProfile, resetOrgProfiles } from '../src/orgprofile.js';
import { forgetPartnerDomains, partnerForViewer, partnerNumbers } from '../src/partners.js';
import { customersOf } from '../src/orgpartners.js';
import { weeksTo } from '../src/trends.js';
import { d1 } from './d1.js';

// Made-up people, teams, partners, customers and channels only.
const NOW = new Date('2026-11-25T12:00:00Z');
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada Ops', staff: 1, teams: ['edge'],
};
const DEE = {
  id: 4, email: 'dee@staff.example', name: 'Dee Helper', staff: 1, teams: ['forms'],
};
const PIA = {
  id: 7, email: 'pia@agency.example', name: 'Pia Builder', staff: 0,
};
const SAM = {
  id: 6, email: 'sam@acme.example', name: 'Sam Reyes', staff: 0,
};
const HAL = {
  id: 9, email: 'hal@hooli.example', name: 'Hal Hooli', staff: 0,
};
const as = (p, role = 'member') => ({ ...p, teams: p.teams.map((slug) => ({ slug, role })) });
const hour = (n) => new Date(NOW.getTime() - n * 3600000).toISOString();

/**
 * Agency Co, a partner, and its channel CA (Edge ops'). Pia (a person) and Pat (an account of
 * the agency's domain, no person) are its people. Pia asked in a1, which Ada answered in an hour;
 * Pat asked in a2, where Sam of ACME posted too, and nobody of Adobe answered. In ACME's threads,
 * Pia started c1 (Edge ops'; Ada answered in two hours) and c2 (Forms ops'; no answer yet); in
 * Hooli's h1, Hal asked and Pat answered before Ada. Clef says Agency Co works for ACME, and the
 * admin team confirmed it for Hooli.
 */
function seed() {
  const DB = d1({
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'edge', name: 'Edge ops' }, { slug: 'forms', name: 'Forms ops' }],
    people: [ADA, DEE, PIA, SAM, HAL],
  });
  const db = DB.sqlite;
  db.exec(`DELETE FROM orgs; INSERT INTO orgs (slug, name, type, icon, updated_at) VALUES
      ('agency', 'Agency Co', 'partner', NULL, '${hour(0)}'),
      ('acme', 'ACME Corp', 'customer', NULL, '${hour(0)}'),
      ('hooli', 'Hooli', 'customer', NULL, '${hour(0)}');
    INSERT INTO org_partners (customer, partner, score, signals, p, checked_at) VALUES
      ('acme', 'agency', 4, '[{"kind":"posters","n":2,"weight":2},{"kind":"owners","n":1,"weight":2.5}]', 0.9, '${hour(1)}');
    INSERT INTO org_partners (customer, partner, score, signals, confirmed_by, confirmed_at) VALUES
      ('hooli', 'agency', 2, '[{"kind":"posters","n":1,"weight":1}]', 'ada@staff.example', '${hour(1)}')`);
  const identity = db.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, email,
    person, fetched_at) VALUES ('slack', 'T', ?, 'person', ?, ?, ?, ?)`);
  for (const p of [ADA, DEE, PIA, SAM, HAL]) {
    identity.run(`U${p.id}`, p.name, p.email, p.id, hour(0));
  }
  identity.run('U8', 'Pat', 'pat@agency.example', null, hour(0));
  const thread = db.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org,
    team, kind, channel_name, title, path, root_at, last_at, any_at, last_staff, messages, updated_at)
    VALUES (?, 'slack', 'T', ?, ?, ?, ?, 'channel', ?, ?, 'p/', ?, ?, ?, ?, 2, ?)`);
  const threads = [
    // key, channel, org, team, title, root, last, last_staff
    ['t:a1', 'CA', 'agency', 'edge', 'Preview access', hour(50), hour(49), 1],
    ['t:a2', 'CA', 'agency', 'edge', 'Stale code after a move', hour(20), hour(19), 0],
    ['t:c1', 'C2', 'acme', 'edge', 'Launch checklist', hour(30), hour(28), 1],
    ['t:c2', 'C3', 'acme', 'forms', 'Forms post twice', hour(10), hour(10), 0],
    ['t:h1', 'C4', 'hooli', 'edge', 'Slow header', hour(40), hour(38), 1],
  ];
  for (const [key, ch, org, team, title, root, last, staff] of threads) {
    thread.run(key, ch, key, org, team, `${org}-${ch}`, title, root, last, last, staff, last);
  }
  const msg = db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person,
    staff, counted, deleted, author_key) VALUES ('slack', 'T', ?, ?, ?, ?, ?, ?, 1, 0, ?)`);
  let n = 0;
  const post = (key, who, at, staff = 0) => {
    n += 1;
    msg.run(threads.find((t) => t[0] === key)[1], `m${n}`, key, at, who === 8 ? null : who, staff, `slack:T:U${who}`);
  };
  post('t:a1', 7, hour(50));
  post('t:a1', 1, hour(49), 1);
  post('t:a2', 8, hour(20));
  post('t:a2', 6, hour(19));
  post('t:c1', 7, hour(30));
  post('t:c1', 6, hour(29));
  post('t:c1', 1, hour(28), 1);
  post('t:c2', 7, hour(10));
  post('t:h1', 9, hour(40));
  post('t:h1', 8, hour(39));
  post('t:h1', 1, hour(38), 1);
  db.exec(`INSERT INTO labels (thread, next_actor, kind, urgency, resolved_p, labeled_through, model, labeled_at, title) VALUES
      ('t:a1', 'customer', 'question', 1, 0.2, '${hour(49)}', 'clef', '${hour(49)}', NULL),
      ('t:a2', 'us', 'question', 2, 0.1, '${hour(19)}', 'clef', '${hour(19)}', 'Stale code after the move'),
      ('t:c1', 'customer', 'question', 1, 0.2, '${hour(28)}', 'clef', '${hour(28)}', NULL),
      ('t:c2', 'us', 'incident', 2, 0.1, '${hour(10)}', 'clef', '${hour(10)}', NULL)`);
  return { DB, STAFF_DOMAINS: 'staff.example' };
}

async function call(e, me, path, init) {
  const url = new URL(`https://opspile.example${path}`);
  const res = await api(new Request(url, init), e, url, { viewer: me });
  return { status: res.status, body: await res.json() };
}

describe('a partner\'s page', () => {
  beforeEach(() => {
    resetOrgProfiles();
    forgetPartnerDomains();
  });

  it('has its customers, with what links them and the threads each side has of the other', async () => {
    const env = seed();
    const v = await partnerNumbers(env, 'agency', weeksTo(NOW, 26), {
      customers: await customersOf(env, 'agency'),
    });
    assert.equal(v.domains, 1);
    const { count, linked, confirmed } = v.customers;
    assert.deepEqual({ count, linked, confirmed }, { count: 2, linked: 2, confirmed: 1 });
    // Hooli's confirmed, first; ACME is likely (Clef's 0.9). Pia is in ACME's c1 and c2, Pat in
    // Hooli's h1; Sam of ACME posted in the agency's a2.
    const row = (c) => [c.slug, c.confirmed, c.p, c.theirs, c.people, c.ours, c.waiting];
    assert.deepEqual(v.customers.list.map(row), [
      ['hooli', true, null, 1, 1, 0, 0],
      ['acme', false, 0.9, 2, 1, 1, 1],
    ]);
    assert.deepEqual(v.customers.list[1].signals, { posters: 2, owners: 1 });
  });

  it('has its people wherever they post, a person\'s accounts as one', async () => {
    const env = seed();
    const v = await partnerNumbers(env, 'agency', weeksTo(NOW, 26));
    assert.equal(v.people.count, 2);
    assert.equal(v.people.inCustomers, 2);
    const row = (p) => [p.name, p.id, p.messages, p.own, p.customers, p.orgs.map((o) => o.slug)];
    assert.deepEqual(v.people.list.map(row), [
      ['Pia Builder', 7, 3, 1, 2, ['acme']],
      ['Pat', null, 2, 1, 1, ['hooli']],
    ]);
    assert.equal(v.people.list[1].account, 'slack:T:U8');
    const { posts } = v;
    assert.deepEqual(
      [posts.own, posts.customers, posts.ownThreads, posts.customerThreads],
      [2, 3, 2, 3],
    );
    // Without customersOf, the customers its people post for, none linked: ACME, two threads
    // with Pia; not Hooli, Pat's one post in one thread.
    assert.deepEqual(v.customers.list.map((c) => [c.slug, c.linked]), [['acme', false]]);
    assert.equal(v.customers.count, 1);
  });

  it('has what waits on Adobe, and how soon Adobe answers, in its channels and customers\'', async () => {
    const v = await partnerNumbers(seed(), 'agency', weeksTo(NOW, 26));
    assert.deepEqual([v.waiting.count, v.waiting.own, v.waiting.customers], [2, 1, 1]);
    assert.deepEqual(v.waiting.list.map((w) => [w.thread, w.waiting]), [['t:c2', 'us'], ['t:a2', 'us']]);
    // Its threads: a1 (an hour) and a2 (none). Customers': c1 (two hours) and c2 (none) are
    // Pia's; Hal started h1.
    assert.deepEqual(v.answers, {
      own: { asked: 2, answered: 1, median: 60 },
      customers: { asked: 2, answered: 1, median: 120 },
    });
  });

  it('lists titles and links only to those who work the threads', async () => {
    const v = await partnerNumbers(seed(), 'agency', weeksTo(NOW, 26));
    const ada = partnerForViewer(as(ADA), v);
    assert.deepEqual(ada.waiting.list.map((w) => [w.thread, w.inbox]), [['t:a2', '/inbox?team=edge&t=t%3Aa2']]);
    assert.equal(ada.waiting.hidden, 1);
    assert.equal(ada.waiting.count, 2);
    const dee = partnerForViewer(as(DEE), v);
    assert.deepEqual(dee.waiting.list.map((w) => w.thread), ['t:c2']);
  });

  it('is its overview\'s, its own people theirs, not a partner\'s', async () => {
    const p = await orgProfile(seed(), as(ADA), 'agency', { now: NOW });
    assert.equal(p.org.type, 'partner');
    assert.deepEqual(p.partner.customers.list.map((c) => c.slug), ['hooli', 'acme']);
    assert.equal(p.partner.waiting.list.length, 1);
    assert.equal(p.partners, undefined);
    assert.deepEqual(p.people.map((x) => [x.name, x.partner]).sort(), [['Pat', null], ['Pia Builder', null], ['Sam Reyes', null]]);
    assert.equal(p.partnerCount, 0);
    assert.deepEqual(p.breakdowns.who.map((x) => x.id), ['theirs', 'adobe']);
  });
});

describe('a customer\'s partners', () => {
  beforeEach(() => {
    resetOrgProfiles();
    forgetPartnerDomains();
  });

  it('are on its page, with what links them and its threads with their people', async () => {
    const p = await orgProfile(seed(), as(ADA), 'acme', { now: NOW });
    assert.deepEqual(p.partners, [{
      slug: 'agency',
      name: 'Agency Co',
      type: 'partner',
      icon: null,
      linked: true,
      confirmed: false,
      p: 0.9,
      signals: { posters: 2, owners: 1 },
      threads: 2,
      people: 1,
    }]);
    assert.equal(p.partner, undefined);
    assert.deepEqual(p.people.map((x) => [x.name, x.partner]), [['Pia Builder', 'Agency Co'], ['Sam Reyes', null]]);
  });

  it('lists a partner whose people post in its threads, though nothing links them yet', async () => {
    const env = seed();
    env.DB.sqlite.exec('DELETE FROM org_partners');
    const p = await orgProfile(env, as(ADA), 'acme', { now: NOW });
    assert.deepEqual(p.partners.map((x) => [x.slug, x.linked, x.threads, x.signals]), [['agency', false, 2, {}]]);
  });

  it('lists none from one stray post, and tells the admin team which have a pair to review', async () => {
    const env = seed();
    const admin = as({ ...ADA, teams: ['admin', 'edge'] });
    // Hooli: only Pat's one post in h1, nothing linking them.
    env.DB.sqlite.exec('DELETE FROM org_partners WHERE customer = \'hooli\'');
    assert.deepEqual((await orgProfile(env, admin, 'hooli', { now: NOW })).partners, []);
    // ACME: Clef's verdict under LIKELY, so not linked, but a row to review.
    env.DB.sqlite.exec('UPDATE org_partners SET p = 0.2 WHERE customer = \'acme\'');
    resetOrgProfiles();
    const mine = await orgProfile(env, admin, 'acme', { now: NOW });
    assert.deepEqual(mine.partners.map((x) => [x.slug, x.linked, x.pair]), [['agency', false, true]]);
    const theirs = await orgProfile(env, admin, 'agency', { now: NOW });
    assert.deepEqual(theirs.partner.customers.list.map((c) => [c.slug, c.linked, c.pair]), [['acme', false, true]]);
    // Without a row, a pair to find in the list; and for anyone else, not said.
    env.DB.sqlite.exec('DELETE FROM org_partners');
    resetOrgProfiles();
    const none = await orgProfile(env, admin, 'acme', { now: NOW });
    assert.deepEqual(none.partners.map((x) => [x.slug, x.pair]), [['agency', false]]);
    const ada = await orgProfile(env, as(ADA), 'acme', { now: NOW });
    assert.equal('pair' in ada.partners[0], false);
    const page = await orgProfile(env, as(ADA), 'agency', { now: NOW });
    assert.equal('pair' in page.partner.customers.list[0], false);
  });

  it('says at once that the admin team dismissed one, on both pages, though they are kept', async () => {
    const env = seed();
    const admin = as({ ...ADA, teams: ['admin', 'edge'] });
    const before = await call(env, admin, '/api/customers/profile?org=acme');
    assert.deepEqual(before.body.partners.map((x) => [x.slug, x.linked]), [['agency', true]]);
    const partner = await call(env, admin, '/api/customers/profile?org=agency');
    assert.deepEqual(partner.body.partner.customers.list.map((c) => [c.slug, c.linked]), [['hooli', true], ['acme', true]]);
    const res = await call(env, admin, '/api/admin/org-partners/dismiss', {
      method: 'POST', body: JSON.stringify({ customer: 'acme', partner: 'agency' }), headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 200);
    const after = await call(env, admin, '/api/customers/profile?org=acme');
    assert.deepEqual(after.body.partners.map((x) => [x.slug, x.linked]), [['agency', false]]);
    const again = await call(env, admin, '/api/customers/profile?org=agency');
    assert.deepEqual(again.body.partner.customers.list.map((c) => [c.slug, c.linked]), [['hooli', true], ['acme', false]]);
  });

  it('are none of a vendor\'s', async () => {
    const env = seed();
    env.DB.sqlite.exec('UPDATE orgs SET type = \'vendor\' WHERE slug = \'hooli\'');
    const p = await orgProfile(env, as(ADA), 'hooli', { now: NOW });
    assert.equal(p.partners, undefined);
  });
});
