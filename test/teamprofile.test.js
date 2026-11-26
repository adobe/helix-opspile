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
  distinctive, resetTeamProfiles, teamNumbers, teamProfile, WEEKS,
} from '../src/teamprofile.js';
import { d1 } from './d1.js';

// Made-up people, teams, customers and channels only.
const NOW = new Date('2026-11-25T12:00:00Z');
const ADA = {
  id: 1, email: 'ada@staff.example', name: 'Ada Ops', staff: 1, teams: ['edge'],
};
const BO = {
  id: 2, email: 'bo@staff.example', name: 'Bo', staff: 1, teams: ['edge'],
};
const CY = {
  id: 3, email: 'cy@staff.example', name: 'Cy Quiet', staff: 1, teams: ['edge'],
};
const DEE = {
  id: 4, email: 'dee@staff.example', name: 'Dee Helper', staff: 1, teams: ['forms'],
};
const SAM = {
  id: 5, email: 'sam@acme.example', name: 'Sam Customer', staff: 0,
};
const as = (p, role = 'member') => ({ ...p, teams: p.teams.map((slug) => ({ slug, role })) });

const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

function seed() {
  const DB = d1({
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'edge', name: 'Edge ops' }, { slug: 'forms', name: 'Forms ops' }],
    people: [ADA, BO, CY, DEE, SAM],
  });
  const db = DB.sqlite;
  db.exec(`UPDATE team_members SET role = 'manager' WHERE person = ${ADA.id}`);
  const identity = db.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, person,
    fetched_at, avatar, title) VALUES ('slack', 'T', ?, ?, ?, ?, ?, ?, ?)`);
  identity.run('U1', 'person', 'Ada Ops', 1, day(0), 'https://img.example/ada.png', 'Engineer');
  // Bo's name in D1 is a handle; his account has his full name.
  db.exec('UPDATE people SET name = \'bo\' WHERE id = 2');
  identity.run('U2', 'person', 'Bo Builder', 2, day(0), null, null);
  identity.run('U3', 'person', 'Cy Quiet', 3, day(0), null, null);
  identity.run('U4', 'person', 'Dee Helper', 4, day(0), 'https://img.example/dee.png', 'Forms lead');
  identity.run('U5', 'person', 'Sam Customer', 5, day(0), null, null);
  // A workflow posting as staff, which is nobody's: no collaborator.
  identity.run('W1', 'bot', 'Requests workflow', null, day(0), null, null);
  db.exec(`DELETE FROM orgs; INSERT INTO orgs (slug, name, type, icon, updated_at) VALUES
    ('acme', 'ACME Corp', 'customer', 'acme.example', '${day(0)}'),
    ('globex', 'Globex', 'customer', NULL, '${day(0)}'),
    ('adobe', 'Adobe', 'internal', NULL, '${day(0)}')`);
  const thread = db.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org,
    team, kind, path, root_at, last_at, any_at, messages, updated_at)
    VALUES (?, 'slack', 'T', ?, ?, ?, ?, 'channel', 'p/', ?, ?, ?, 1, ?)`);
  // Edge ops' own threads (ACME and Globex), an internal one, one of Forms ops' that shows a
  // technology Edge ops follows, and one of Forms ops' that does not.
  const threads = [
    ['t:acme1', 'C1', 'acme', 'edge', 10],
    ['t:acme2', 'C1', 'acme', 'edge', 3],
    ['t:globex', 'C2', 'globex', 'edge', 20],
    ['t:adobe', 'C3', 'adobe', 'edge', 5],
    ['t:followed', 'C4', 'globex', 'forms', 2],
    ['t:other', 'C5', 'acme', 'forms', 2],
    // Too old for the window.
    ['t:old', 'C1', 'acme', 'edge', 400],
  ];
  for (const [key, ch, org, team, ago] of threads) {
    thread.run(key, ch, key, org, team, day(ago + 1), day(ago), day(ago), day(ago));
  }
  const msg = db.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, person,
    staff, counted, deleted, author_key) VALUES ('slack', 'T', ?, ?, ?, ?, ?, ?, 1, 0, ?)`);
  let n = 0;
  const post = (key, who, ago, staff = 1, times = 1, user = `U${who}`) => {
    const ch = threads.find((t) => t[0] === key)[1];
    for (let i = 0; i < times; i += 1) {
      n += 1;
      msg.run(ch, `m${n}`, key, day(ago), who, staff, `slack:T:${user}`);
    }
  };
  post('t:acme1', 1, 10, 1, 4);
  post('t:acme1', 5, 10, 0, 3);
  post('t:acme2', 1, 3, 1, 2);
  post('t:acme2', 2, 3, 1, 1);
  post('t:globex', 2, 20, 1, 5);
  post('t:adobe', 1, 5, 1, 2);
  post('t:followed', 4, 2, 1, 3);
  post('t:followed', 1, 2, 1, 1);
  post('t:other', 4, 2, 1, 6);
  post('t:acme1', null, 9, 1, 2, 'W1');
  post('t:old', 1, 400, 1, 9);
  // Clef: Ada's threads are about the CDN, Bo's about authoring; Globex's thread shows the
  // technology Edge ops follows.
  db.exec(`INSERT INTO thread_areas (thread, area, p) VALUES ('t:acme1', 'cdn', 0.9),
      ('t:acme2', 'cdn', 0.8), ('t:globex', 'authoring', 0.9), ('t:acme2', 'authoring', 0.7);
    INSERT INTO thread_tech (thread, tech, p) VALUES ('t:acme1', 'fastly', 0.9), ('t:acme2', 'fastly', 0.9),
      ('t:globex', 'da', 0.9), ('t:followed', 'forms', 0.9), ('t:acme1', 'github', 0.9);
    DELETE FROM tech_stack; DELETE FROM areas;
    INSERT INTO areas (team, id, name, what, path) VALUES ('admin', 'cdn', 'Caching and delivery', 'x', 'areas/cdn.md'),
      ('admin', 'authoring', 'Authoring and content', 'x', 'areas/authoring.md');
    INSERT INTO tech_stack (team, tech, name, description, layer, vendor, kind, path) VALUES
      ('admin', 'fastly', 'Fastly', 'x', 'edge', 'Fastly', 'Product', 'products/fastly.md'),
      ('admin', 'da', 'Document Authoring', 'x', 'content', 'Adobe', 'Feature', 'products/adobe/da.md'),
      ('admin', 'forms', 'Forms', 'x', 'site', 'Adobe', 'Product', 'products/adobe/forms.md'),
      ('admin', 'github', 'GitHub', 'x', 'code', 'GitHub', 'Product', 'products/github.md'),
      ('edge', 'fastly', 'Fastly CDN', 'y', 'edge', 'Fastly', 'Product', 'products/fastly/cdn.md');
    INSERT INTO team_follows (team, tech, added_by, added_at) VALUES ('edge', 'forms', 'ada', '${day(30)}');
    INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at, entries)
      VALUES ('kb-team-edge', 'team', 'edge', 'r', '${day(90)}', 4);
    INSERT INTO kb_concepts (repo, path, hash, type, title, description) VALUES
      ('kb-team-edge', 'issues/purge.md', 'h1', 'Known Issue', 'Purge is slow', 'Two CDNs'),
      ('kb-team-edge', 'issues/loop.md', 'h2', 'Known Issue', 'Sign-in loop', NULL),
      ('kb-team-edge', 'playbooks/live.md', 'h3', 'Playbook', 'Go-live', NULL),
      ('kb-team-edge', 'products/fastly/cdn.md', 'h4', 'Product', 'Fastly CDN', NULL),
      ('kb-team-edge', 'stack.md', 'h5', 'Stack Drawing', 'What we run', NULL),
      ('kb-team-edge', 'contacts/ada-ops.md', 'h6', 'Contact', 'Ada Ops', 'Runs the CDN setups.')`);
  return { DB, STAFF_DOMAINS: 'staff.example' };
}

async function call(e, me, path) {
  const url = new URL(`https://opspile.example${path}`);
  const res = await api(new Request(url), e, url, { viewer: me });
  return { status: res.status, body: await res.json() };
}

describe('a team\'s overview', () => {
  beforeEach(() => resetTeamProfiles());

  it('has its members, their weeks and what sets them apart', async () => {
    const p = await teamNumbers(seed(), 'edge', { now: NOW });
    assert.equal(p.weeks.length, WEEKS);
    assert.deepEqual(p.team, {
      slug: 'edge', name: 'Edge ops', self_managed: false, channels: 3, shared: 0,
    });
    // The busiest first; the one who did not post last, with nothing.
    assert.deepEqual(p.members.map((m) => [m.id, m.name, m.role, m.messages, m.threads]), [
      [1, 'Ada Ops', 'manager', 9, 4],
      [2, 'Bo Builder', 'member', 6, 2],
      [3, 'Cy Quiet', 'member', 0, 0],
    ]);
    const [ada, bo, cy] = p.members;
    assert.equal(ada.avatar, 'https://img.example/ada.png');
    assert.equal(ada.title, 'Engineer');
    assert.equal(ada.weekly.reduce((s, v) => s + v, 0), 9);
    assert.equal(ada.weekly.length, WEEKS);
    // This week's (from Monday) is the last; three and five days ago, the week before.
    assert.equal(ada.weekly[WEEKS - 1], 1);
    assert.equal(ada.weekly[WEEKS - 2], 4);
    assert.deepEqual(ada.areas.map((a) => a.name), ['Caching and delivery']);
    // Bo's one thread about the CDN does not count: he has more of authoring.
    assert.deepEqual(bo.areas.map((a) => a.name), ['Authoring and content']);
    // By the team's own name for it; her threads of one each do not count.
    assert.deepEqual(ada.tech.map((t) => t.name), ['Fastly CDN']);
    assert.deepEqual(bo.tech.map((t) => t.name), ['Document Authoring', 'Fastly CDN']);
    // Key customers: no internal org.
    assert.deepEqual(ada.customers.map((c) => [c.slug, c.n]), [['acme', 6], ['globex', 1]]);
    assert.deepEqual(cy, {
      ...cy, messages: 0, threads: 0, last: null, areas: [], tech: [], customers: [],
    });
  });

  it('ranks its customers, collaborators and technologies by what was said in its threads', async () => {
    const p = await teamNumbers(seed(), 'edge', { now: NOW });
    // Its threads: its own, and the one of what it follows; not Forms ops' other one.
    assert.equal(p.threadCount, 5);
    // ACME's first (4 + 2 by the workflow, 3 by Sam), its second (3), Globex's (5), the internal
    // one (2) and the followed one (4): all of them by Adobe but Sam's.
    const sum = (list) => list.reduce((a, v) => a + v, 0);
    assert.equal(sum(p.activity.messages), 23);
    assert.equal(sum(p.activity.staff), 20);
    // Customers, the internal one left out; ACME's who of the team works it most.
    assert.deepEqual(p.customers.map((c) => [c.slug, c.name, c.messages, c.staff, c.threads]), [
      ['acme', 'ACME Corp', 12, 9, 2],
      ['globex', 'Globex', 9, 9, 2],
    ]);
    assert.deepEqual(p.customers[0].members, [1, 2]);
    assert.equal(p.customers[0].icon, 'acme.example');
    // Collaborators: Dee, of Forms ops, in the followed thread; not the members, nor the workflow.
    const teams = (c) => c.teams.map((t) => t.slug);
    assert.deepEqual(p.collaborators.map((c) => [c.id, c.name, c.messages, teams(c)]), [
      [4, 'Dee Helper', 3, ['forms']],
    ]);
    assert.equal(p.collaborators[0].avatar, 'https://img.example/dee.png');
    assert.equal(p.collaboratorCount, 1);
    // Technologies: followed, of its catalog (its own name and file), and seen in its threads.
    const tech = Object.fromEntries(p.tech.map((t) => [t.tech, t]));
    assert.deepEqual(Object.keys(tech).sort(), ['da', 'fastly', 'forms', 'github']);
    const { forms, fastly } = tech;
    assert.deepEqual([forms.followed, forms.catalog, forms.threads], [true, false, 1]);
    assert.deepEqual(
      [fastly.name, fastly.catalog, fastly.path, fastly.threads],
      ['Fastly CDN', true, 'products/fastly/cdn.md', 2],
    );
    assert.deepEqual([tech.da.followed, tech.da.catalog, tech.da.layer], [false, false, 'content']);
    assert.equal(tech.fastly.weekly.reduce((s, v) => s + v, 0), 7 + 2 + 3);
    // The knowledge base: its entries by type, not its catalog, and whether it has a drawing.
    assert.deepEqual(p.kb.types.map((t) => [t.type, t.n]), [['Known Issue', 2], ['Contact', 1], ['Playbook', 1]]);
    // Ada's profile on the team is her Contact in its knowledge base; Bo has none yet.
    assert.deepEqual(p.members.map((m) => m.profile), [
      { path: 'contacts/ada-ops.md', description: 'Runs the CDN setups.' }, null, null,
    ]);
    assert.equal(p.kb.stack, true);
  });

  it('is everyone\'s at Adobe, its knowledge base\'s entries too', async () => {
    const e = seed();
    const outsider = {
      id: 9, email: 'x@partner.example', name: 'X', teams: [],
    };
    assert.equal((await call(e, outsider, '/api/teams/profile?team=edge')).status, 403);
    assert.equal((await call(e, outsider, '/api/teams')).status, 403);
    const staff = { ...outsider, email: 'x@staff.example' };
    let r = await call(e, staff, '/api/teams');
    assert.deepEqual(r.body.teams.map((t) => [t.slug, t.members]), [['admin', 0], ['edge', 3], ['forms', 1]]);
    r = await call(e, staff, '/api/teams/profile?team=edge');
    assert.equal(r.status, 200);
    assert.equal(r.body.members.length, 3);
    // Adobe's, on no team, read its entries and its members' profiles, as the ops teams do.
    assert.deepEqual(r.body.kb.types[0].entries.map((x) => x.title), ['Purge is slow', 'Sign-in loop']);
    assert.equal(r.body.members[0].profile.description, 'Runs the CDN setups.');
    assert.equal(r.body.kb.readable, true);
    assert.deepEqual(r.body.may, { manage: false });
    // A member of another team reads the entries; the team's manager manages it.
    r = await call(e, as(DEE), '/api/teams/profile?team=edge');
    assert.deepEqual(r.body.kb.types[0].entries.map((x) => x.title), ['Purge is slow', 'Sign-in loop']);
    assert.equal(r.body.kb.readable, true);
    assert.equal(r.body.members[0].profile.description, 'Runs the CDN setups.');
    assert.equal(r.body.may.manage, false);
    r = await call(e, as(ADA, 'manager'), '/api/teams/profile?team=edge');
    assert.equal(r.body.may.manage, true);
    assert.equal((await call(e, staff, '/api/teams/profile?team=nope')).status, 404);
    assert.equal((await call(e, staff, '/api/teams/profile?team=_unassigned')).status, 404);
  });

  it('keeps a team\'s numbers a while', async () => {
    const e = seed();
    const first = await teamProfile(e, as(ADA), 'edge', { now: NOW });
    e.DB.sqlite.exec('DELETE FROM messages');
    const kept = await teamProfile(e, as(ADA), 'edge', { now: new Date(NOW.getTime() + 60000) });
    assert.equal(kept.members[0].messages, first.members[0].messages);
    const later = await teamProfile(e, as(ADA), 'edge', { now: new Date(NOW.getTime() + 3600000) });
    assert.equal(later.members[0].messages, 0);
  });
});

describe('what sets a member apart', () => {
  it('is what they have more of than the team, from a few threads on', () => {
    const totals = new Map([[1, 100], [2, 100]]);
    const rows = [
      // Everyone's: as much of both members' messages.
      {
        person: 1, what: 'common', n: 50, threads: 10,
      },
      {
        person: 2, what: 'common', n: 50, threads: 10,
      },
      // Only member 1's, in three threads.
      {
        person: 1, what: 'theirs', n: 20, threads: 3,
      },
      // Member 2's of one thread, which counts only where there is nothing more.
      {
        person: 2, what: 'once', n: 30, threads: 1,
      },
    ];
    const out = distinctive(rows, totals);
    assert.deepEqual(out.get(1).map((t) => t.id), ['theirs', 'common']);
    assert.deepEqual(out.get(2).map((t) => t.id), ['common']);
    assert.deepEqual(distinctive([{
      person: 3, what: 'once', n: 2, threads: 1,
    }], new Map([[3, 2]])).get(3).map((t) => t.id), ['once']);
  });
});
