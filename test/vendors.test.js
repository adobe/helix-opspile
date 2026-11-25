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
import {
  forViewer, resetTeamVendors, teamVendorNumbers, vendorNumbers,
} from '../src/vendors.js';
import { weeksTo } from '../src/trends.js';
import { d1 } from './d1.js';

// Made-up people, teams, vendors, customers and channels only.
const NOW = new Date('2026-11-25T12:00:00Z');
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada Ops', staff: 1, teams: ['edge'],
};
const DEE = {
  id: 4, email: 'dee@staff.example', name: 'Dee Helper', staff: 1, teams: ['forms'],
};
const VIC = {
  id: 5, email: 'vic@cdnco.example', name: 'Vic Vendor', staff: 0,
};
const SAM = {
  id: 6, email: 'sam@acme.example', name: 'Sam Reyes', staff: 0,
};
const as = (p, role = 'member') => ({ ...p, teams: p.teams.map((slug) => ({ slug, role })) });
const hour = (n) => new Date(NOW.getTime() - n * 3600000).toISOString();
const day = (n) => hour(24 * n);

/**
 * CDN Co, a vendor: its channel C1 is Edge ops'. Ada opened three cases there: v1 waits on CDN Co
 * (labeled before Clef was asked the vendor's way: `customer`), Vic answered it in an hour; Vic
 * asked back in v2, which waits on Adobe; v3 is resolved. Its status bot posted two alerts. ACME's
 * thread c1 (Edge ops') shows CDN Co's CDN and waits on a third party; c2 (Forms ops') shows it
 * too. Forms ops follows CDN Co.
 */
function seed() {
  const DB = d1({
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'edge', name: 'Edge ops' }, { slug: 'forms', name: 'Forms ops' }],
    people: [ADA, DEE, VIC, SAM],
  });
  const db = DB.sqlite;
  db.exec(`DELETE FROM orgs; INSERT INTO orgs (slug, name, type, icon, updated_at) VALUES
      ('cdnco', 'CDN Co', 'vendor', 'cdnco.example', '${day(0)}'),
      ('acme', 'ACME Corp', 'customer', NULL, '${day(0)}');
    INSERT INTO rules (target, priority, field, pattern, value) VALUES ('follow', 100, 'org', '^cdnco$', 'forms');
    INSERT INTO channel_teams (source, channel_id, team, added_at) VALUES ('slack', 'C1', 'forms', '${day(9)}')`);
  const thread = db.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org,
    team, kind, channel_name, title, path, root_at, last_at, any_at, last_staff, messages, updated_at)
    VALUES (?, 'slack', 'T', ?, ?, ?, ?, ?, ?, ?, 'p/', ?, ?, ?, ?, 2, ?)`);
  const threads = [
    // key, channel, org, team, kind, title, root, last, last_staff
    ['t:v1', 'C1', 'cdnco', 'edge', 'channel', 'Purge leaves stale objects', hour(50), hour(49), 0],
    ['t:v2', 'C1', 'cdnco', 'edge', 'channel', 'Logs for the 503s', hour(30), hour(29), 0],
    ['t:v3', 'C1', 'cdnco', 'edge', 'channel', 'Certificate renewal', hour(80), hour(70), 1],
    ['t:s1', 'C1', 'cdnco', 'edge', 'alert', 'Maintenance in IAD', hour(20), null, null],
    ['t:s2', 'C1', 'cdnco', 'edge', 'alert', 'Degraded in FRA', hour(10), null, null],
    ['t:c1', 'C2', 'acme', 'edge', 'channel', 'Stale pages after publish', hour(12), hour(11), 1],
    ['t:c2', 'C3', 'acme', 'forms', 'channel', 'Form posts blocked', hour(8), hour(7), 0],
  ];
  for (const [key, ch, org, team, kind, title, root, last, staff] of threads) {
    thread.run(key, ch, key, org, team, kind, `${org}-${ch}`, title, root, last, last || root, staff, last || root);
  }
  const msg = db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person,
    staff, counted, deleted, author_key) VALUES ('slack', 'T', ?, ?, ?, ?, ?, ?, 1, 0, ?)`);
  let n = 0;
  const post = (key, who, at, staff) => {
    n += 1;
    msg.run(threads.find((t) => t[0] === key)[1], `m${n}`, key, at, who, staff, `slack:T:U${who}`);
  };
  post('t:v1', 1, hour(50), 1);
  post('t:v1', 5, hour(49), 0);
  post('t:v2', 1, hour(30), 1);
  post('t:v2', 5, hour(29), 0);
  post('t:v3', 1, hour(80), 1);
  post('t:v3', 5, hour(75), 0);
  post('t:v3', 1, hour(70), 1);
  post('t:c1', 6, hour(12), 0);
  post('t:c1', 1, hour(11), 1);
  post('t:c2', 6, hour(8), 0);
  db.exec(`INSERT INTO labels (thread, next_actor, kind, urgency, resolved_p, labeled_through, model, labeled_at, title) VALUES
      ('t:v1', 'customer', 'incident', 2, 0.1, '${hour(49)}', 'clef', '${hour(49)}', NULL),
      ('t:v2', 'us', 'question', 1, 0.1, '${hour(29)}', 'clef', '${hour(29)}', 'Send the 503 logs'),
      ('t:v3', 'nobody', 'request', 1, 0.9, '${hour(70)}', 'clef', '${hour(70)}', NULL),
      ('t:c1', 'vendor', 'incident', 2, 0.2, '${hour(11)}', 'clef', '${hour(11)}', NULL),
      ('t:c2', 'us', 'question', 1, 0.1, '${hour(7)}', 'clef', '${hour(7)}', NULL);
    INSERT INTO thread_tech (thread, tech, p) VALUES ('t:c1', 'cdnco/cdn', 0.9), ('t:c2', 'cdnco', 0.95),
      ('t:v1', 'cdnco/cdn', 0.9), ('t:c1', 'cdnco-other', 0.9);
    DELETE FROM tech_stack;
    INSERT INTO tech_stack (team, tech, name, description, layer, vendor, kind, path) VALUES
      ('admin', 'cdnco/cdn', 'CDN Co CDN', 'x', 'edge', 'CDN Co', 'Product', 'products/cdnco/cdn.md')`);
  return { DB, STAFF_DOMAINS: 'staff.example' };
}

async function call(e, me, path) {
  const url = new URL(`https://opspile.example${path}`);
  const res = await api(new Request(url), e, url, { viewer: me });
  return { status: res.status, body: await res.json() };
}

describe('a vendor\'s page', () => {
  beforeEach(() => resetOrgProfiles());

  it('has its open cases, its status posts and the customers\' threads of its products', async () => {
    const v = await vendorNumbers(seed(), 'cdnco', weeksTo(NOW, 26));
    // v1 waits on the vendor (an old label's `customer`), v2 on Adobe; v3 is resolved.
    const { open, them, us } = v.cases;
    assert.deepEqual({ open, them, us }, { open: 2, them: 1, us: 1 });
    assert.deepEqual(v.cases.list.map((c) => [c.thread, c.waiting, c.urgency]), [
      ['t:v2', 'us', 'normal'], ['t:v1', 'vendor', 'high'],
    ]);
    assert.equal(v.cases.list[0].title, 'Send the 503 logs');
    assert.deepEqual(v.cases.list[0].shared, ['forms']);
    // Two status posts, the latest first.
    assert.equal(v.status.total, 2);
    assert.deepEqual(v.status.list.map((s) => s.title), ['Degraded in FRA', 'Maintenance in IAD']);
    // ACME's two threads show its products (not `cdnco-other`, nor its own v1); c1 waits on a
    // third party.
    assert.equal(v.dependents.threads, 2);
    assert.deepEqual(v.dependents.customers.map((c) => [c.slug, c.threads, c.waiting]), [['acme', 2, 1]]);
    assert.deepEqual(v.dependents.products, [
      { tech: 'cdnco/cdn', name: 'CDN Co CDN', threads: 1 }, { tech: 'cdnco', name: 'cdnco', threads: 1 },
    ]);
    assert.deepEqual(v.dependents.list.map((t) => t.thread), ['t:c1']);
  });

  it('says how soon the vendor answers, and lists titles only to those who work them', async () => {
    const env = seed();
    const p = await orgProfile(env, as(ADA), 'cdnco', { now: NOW });
    // Adobe started v1, v2 and v3; CDN Co answered each in an hour, five hours, an hour.
    assert.deepEqual(p.answers, {
      by: 'them', asked: 3, answered: 3, median: 60,
    });
    assert.equal(p.vendor.cases.list.length, 2);
    assert.match(p.vendor.cases.list[0].inbox, /^\/inbox\?team=edge&t=t%3Av2$/);
    assert.equal(p.vendor.cases.hidden, 0);
    // Dee is on Forms ops, which C1 is shared with, but not ACME's c1 (Edge ops').
    const dee = await orgProfile(env, as(DEE), 'cdnco', { now: NOW });
    assert.equal(dee.vendor.cases.list[0].inbox, '/inbox?team=forms&t=t%3Av2');
    assert.deepEqual([dee.vendor.dependents.list.length, dee.vendor.dependents.hidden], [0, 1]);
    // Someone on no team sees the numbers alone.
    const none = await orgProfile(env, { ...ADA, teams: [] }, 'cdnco', { now: NOW });
    const c = none.vendor.cases;
    assert.deepEqual([c.open, c.list.length, c.hidden], [2, 0, 2]);
  });

  it('is not a customer\'s', async () => {
    const p = await orgProfile(seed(), as(ADA), 'acme', { now: NOW });
    assert.equal(p.vendor, undefined);
    assert.equal(p.answers.by, 'adobe');
  });
});

describe('a team\'s vendors', () => {
  beforeEach(() => resetTeamVendors());

  it('lists the vendors it works with, and what waits on them', async () => {
    const t = await teamVendorNumbers(seed(), 'edge', { now: NOW });
    const rows = t.vendors
      .map((v) => [v.slug, v.filed, v.shared, v.follows, v.inInbox, v.products]);
    assert.deepEqual(rows, [
      ['cdnco', 1, 0, false, true, 1],
    ]);
    const [v] = t.vendors;
    assert.deepEqual(v.cases, { open: 2, them: 1, us: 1 });
    assert.deepEqual(v.answers, { asked: 3, answered: 3, median: 60 });
    assert.equal(v.posted, 4);
    // Waiting on a vendor: its case v1, and ACME's c1; and CDN Co's v2 waits on Adobe.
    assert.deepEqual(t.waiting.map((w) => w.thread), ['t:c1', 't:v1']);
    assert.deepEqual(t.ours.map((w) => w.thread), ['t:v2']);
  });

  it('has the vendors a team follows, and leaves out a team that has none', async () => {
    const env = seed();
    const forms = await teamVendorNumbers(env, 'forms', { now: NOW });
    assert.deepEqual(forms.vendors.map((v) => [v.slug, v.shared, v.follows, v.products]), [['cdnco', 1, true, 1]]);
    // c2 waits on Adobe: nothing of Forms ops' waits on a vendor but the shared case v1.
    assert.deepEqual(forms.waiting.map((w) => w.thread), ['t:v1']);
    const admin = await teamVendorNumbers(env, 'admin', { now: NOW });
    assert.deepEqual(admin.vendors, []);
    assert.equal(await teamVendorNumbers(env, 'nope', { now: NOW }), null);
  });

  it('is GET /api/teams/vendors, with titles for those who work them', async () => {
    const env = seed();
    const ada = await call(env, as(ADA, 'manager'), '/api/teams/vendors?team=edge');
    assert.equal(ada.status, 200);
    assert.equal(ada.body.waiting.length, 2);
    assert.equal(ada.body.may.follow, true);
    const dee = await call(env, as(DEE), '/api/teams/vendors?team=edge');
    assert.equal(dee.status, 200);
    // v1 is in C1, which is shared with Forms ops: Dee works it; ACME's c1 is not hers.
    assert.deepEqual(dee.body.waiting.map((w) => w.thread), ['t:v1']);
    assert.equal(dee.body.waitingHidden, 1);
    assert.equal(dee.body.may.follow, false);
    assert.equal((await call(env, as(ADA), '/api/teams/vendors?team=nope')).status, 404);
  });

  it('keeps a list to what a viewer works', () => {
    const rows = [{ thread: 'a', team: 'edge', shared: [] }, { thread: 'b', team: 'x', shared: ['edge'] },
      { thread: 'c', team: 'x', shared: [] }];
    const out = forViewer(as(ADA), rows);
    assert.deepEqual(out.list.map((r) => [r.thread, r.inbox]), [
      ['a', '/inbox?team=edge&t=a'], ['b', '/inbox?team=edge&t=b'],
    ]);
    assert.equal(out.hidden, 1);
  });
});
